/* 과제 상태기계 검증 — 오입력 취소 / 확정 유예 / 무응답 상한 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ---------------- 최소 DOM 스텁 ---------------- */
function makeEl(tag) {
  const el = {
    tagName: tag, children: [], parent: null,
    className: '', innerHTML: '', textContent: '',
    style: {}, _classes: new Set(),
    classList: {
      add: (...c) => c.forEach(x => el._classes.add(x)),
      remove: (...c) => c.forEach(x => el._classes.delete(x)),
      contains: c => el._classes.has(c),
      toggle: (c, on) => on ? el._classes.add(c) : el._classes.delete(c)
    },
    setAttribute() {}, addEventListener() {},
    appendChild(child) { child.parent = el; el.children.push(child); return child; },
    querySelector(sel) {
      const cls = sel.replace('.', '');
      return el.children.find(c => c.className.split(' ').includes(cls)) || null;
    },
    remove() {
      if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el);
      el.parent = null;
    }
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html || '',
    set: v => { el._html = v; if (v === '') el.children = []; }
  });
  return el;
}

global.window = global;
global.document = { addEventListener() {}, createElement: makeEl };
global.navigator = { userAgent: 'node', language: 'ko', hardwareConcurrency: 8, platform: 'Win32' };
global.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 };
global.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 };
window.matchMedia = () => ({ matches: false });
window.addEventListener = () => {};
window.innerWidth = 1600; window.innerHeight = 900; window.devicePixelRatio = 1;

function load(f) { eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); }
load('js/core.js');
load('js/tasks.js');
load('js/scoring.js');
load('js/task-spatial-span.js');

/* ---------------- 절차를 테스트용으로 가속 ---------------- */
const C = SpatialSpanTask.CONFIG;
C.litMs = 4; C.gapMs = 2; C.preTrialMs = 2; C.postTrialMs = 2;
C.undo.live.windowMs = 120;      // 실제 2000ms → 테스트 120ms
C.undo.practice.windowMs = Infinity;
/* 취소 창(120ms)과 겹치지 않게 응답 상한은 충분히 크게 */
C.responseTimeoutBaseMs = 600;
C.responseTimeoutPerItemMs = 10;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 시행을 돌리면서 입력이 열리는 순간 script를 실행.
   시행과 스크립트를 모두 기다려야 한다 — 시행이 먼저 끝나면
   스크립트 안의 check()가 실행되기 전에 단정이 지나가 버린다. */
function drive(task, level, script) {
  let scriptDone;
  const scriptPromise = new Promise(r => { scriptDone = r; });
  let opened = false;
  const base = task.onStatus;
  task.onStatus = function (s) {
    base(s);
    if (s.kind === 'input' && !opened) {
      opened = true;
      setTimeout(function () {
        Promise.resolve(script(task)).then(scriptDone, function (e) {
          console.log('  (script error) ' + e.message);
          scriptDone();
        });
      }, 0);
    }
  };
  /* 시행이 먼저 끝나면 스크립트 대기도 해제한다.
     입력이 열리기 전에 중단되는 경우 scriptPromise가 영구 대기하고,
     노드는 이벤트 루프가 비어 조용히 종료해 이후 테스트가 통째로 누락된다. */
  const trialPromise = task._runTrial(level).then(function (t) { scriptDone(); return t; });
  return Promise.all([trialPromise, scriptPromise]).then(function (r) { return r[0]; });
}

function newTask(phase) {
  return new SpatialSpanTask({
    board: makeEl('div'),
    rng: new Core.Rng(777),
    phase: phase,
    onTrial() {}, onStatus() {}
  });
}

(async function () {

  /* ---------- 1. 기본 취소 ---------- */
  console.log('\n[1] 오입력 취소 — 마지막 입력 되돌리기');
  {
    const task = newTask('live');
    const t = await drive(task, 3, async (tk) => {
      const seq = tk._response; // 아직 비어있음
      tk._onTap(0, tk.blocks[0]);
      tk._onTap(1, tk.blocks[1]);
      check('2개 입력됨', tk._response.length === 2, JSON.stringify(tk._response));
      check('취소 가능', tk.undoAvailable().ok === true);
      const ok = tk.undo();
      check('undo() 성공 반환', ok === true);
      check('입력 1개로 줄어듦', tk._response.length === 1, JSON.stringify(tk._response));
      check('취소된 도형의 tapped 표시 제거', tk.blocks[1].classList.contains('tapped') === false);
      check('순서 태그 제거', tk.blocks[1].querySelector('.order-tag') === null);
      /* 다시 눌러 완성 */
      tk._onTap(2, tk.blocks[2]);
      tk._onTap(3, tk.blocks[3]);
      tk.submit();
    });
    check('시행 로그에 취소 1회 기록', t.undoCount === 1, 'got ' + t.undoCount);
    check('취소 내역에 경과시간 포함', typeof t.undos[0].sinceTapMs === 'number');
    check('취소 내역에 지운 위치 기록', t.undos[0].position === 2, 'got ' + t.undos[0].position);
    check('최종 응답은 취소 반영됨', JSON.stringify(t.response) === '[0,2,3]', JSON.stringify(t.response));
  }

  /* ---------- 2. 본 검사 취소 횟수 제한 ---------- */
  console.log('\n[2] 본 검사 — 시행당 1회 제한');
  {
    const task = newTask('live');
    let secondUndo = null, reason = null;
    const t = await drive(task, 3, async (tk) => {
      tk._onTap(0, tk.blocks[0]);
      tk._onTap(1, tk.blocks[1]);
      tk.undo();
      tk._onTap(2, tk.blocks[2]);
      secondUndo = tk.undo();                 // 두 번째 취소 시도
      reason = tk.undoAvailable().reason;
      tk._onTap(3, tk.blocks[3]);
      tk._onTap(4, tk.blocks[4]);
      tk.submit();
    });
    check('두 번째 취소 거부', secondUndo === false);
    check('거부 사유 안내됨', /수정 기회/.test(reason || ''), reason);
    check('로그의 취소 횟수는 1회', t.undoCount === 1, 'got ' + t.undoCount);
  }

  /* ---------- 3. 연습은 무제한 ---------- */
  console.log('\n[3] 연습 — 무제한 취소 (기능 학습 목적)');
  {
    const task = newTask('practice');
    const t = await drive(task, 2, async (tk) => {
      tk._onTap(0, tk.blocks[0]);
      const u1 = tk.undo();
      tk._onTap(1, tk.blocks[1]);
      const u2 = tk.undo();
      tk._onTap(2, tk.blocks[2]);
      const u3 = tk.undo();
      check('연습에서 3회 연속 취소 허용', u1 && u2 && u3);
      tk._onTap(3, tk.blocks[3]);
      tk._onTap(4, tk.blocks[4]);
      tk.submit();
    });
    check('연습 취소 3회 기록', t.undoCount === 3, 'got ' + t.undoCount);
  }

  /* ---------- 4. 취소 창 만료 ---------- */
  console.log('\n[4] 취소 창 만료 — 망설임은 복구 불가');
  {
    const task = newTask('live');
    let lateUndo = null, lateReason = null;
    const t = await drive(task, 3, async (tk) => {
      tk._onTap(0, tk.blocks[0]);
      await sleep(C.undo.live.windowMs + 60);   // 창 초과 대기
      lateUndo = tk.undo();
      lateReason = tk.undoAvailable().reason;
      tk._onTap(1, tk.blocks[1]);
      tk._onTap(2, tk.blocks[2]);
      tk.submit();
    });
    check('창 만료 후 취소 거부', lateUndo === false);
    check('만료 사유 안내됨', /시간/.test(lateReason || ''), lateReason);
    check('취소 기록 없음', t.undoCount === 0);
  }

  /* ---------- 5. 확정 유예 — 마지막 입력도 되돌릴 수 있는가 ---------- */
  console.log('\n[5] 확정 유예 — 마지막 클릭 오타 복구 (핵심 사례)');
  {
    const task = newTask('live');
    let sawConfirm = false;
    const statuses = [];
    const task2 = new SpatialSpanTask({
      board: makeEl('div'), rng: new Core.Rng(5), phase: 'live',
      onTrial() {},
      onStatus(s) { statuses.push(s.kind); if (s.kind === 'confirm') sawConfirm = true; }
    });

    const t = await drive(task2, 2, async (tk) => {
      tk._onTap(0, tk.blocks[0]);
      tk._onTap(1, tk.blocks[1]);          // 입력 완료 → 확정 유예 진입
      await sleep(10);
      check('입력 완료 시 확정 유예 상태 진입', sawConfirm === true);
      check('아직 시행이 끝나지 않음', tk._inputOpen === true);
      check('유예 중에도 취소 가능', tk.undoAvailable().ok === true);
      const ok = tk.undo();                 // 마지막 클릭을 되돌린다
      check('마지막 입력 취소 성공', ok === true);
      check('취소 후 입력 상태로 복귀', tk._confirming === false && tk._inputOpen === true);
      tk._onTap(2, tk.blocks[2]);           // 올바른 것을 다시 누름
      await sleep(C.undo.live.windowMs + 60);  // 자동 확정 대기
    });
    check('유예 만료 후 자동 확정', t !== null);
    check('최종 응답에 수정 반영', JSON.stringify(t.response) === '[0,2]', JSON.stringify(t.response));
    check('유예 중 취소가 duringConfirm으로 기록', t.undos[0].duringConfirm === true);
  }

  /* ---------- 6. 직접 확정 ---------- */
  console.log('\n[6] 직접 확정 — 유예를 기다리지 않고 제출');
  {
    const task = newTask('live');
    const started = Date.now();
    const t = await drive(task, 2, async (tk) => {
      tk._onTap(0, tk.blocks[0]);
      tk._onTap(1, tk.blocks[1]);
      await sleep(5);
      const ok = tk.submit();
      check('submit() 성공', ok === true);
    });
    const elapsed = Date.now() - started;
    check('유예 전체를 기다리지 않음', elapsed < C.undo.live.windowMs + 50, elapsed + 'ms');
    check('불완전 입력 상태에서는 submit 거부', (function () {
      const tk = newTask('live');
      tk._inputOpen = true; tk._response = [0]; tk._expectedLength = 3;
      return tk.submit() === false;
    })());
  }

  /* ---------- 7. 무응답 상한 ---------- */
  console.log('\n[7] 무응답 상한 — 이탈해도 시행이 종료되는가');
  {
    const task = newTask('live');
    const started = Date.now();
    const t = await task._runTrial(3);        // 아무것도 누르지 않음
    const elapsed = Date.now() - started;

    check('무응답이어도 시행이 종료됨 (무한 대기 없음)', t !== null);
    check('timedOut 표시', t.timedOut === true);
    check('abandoned 표시', t.abandoned === true);
    check('오답으로 채점', t.correct === false);
    check('응답 배열 비어있음', t.response.length === 0);
    check('상한 시간 내에 종료', elapsed < 800, elapsed + 'ms');
  }

  /* ---------- 8. 부분 응답 후 이탈 ---------- */
  console.log('\n[8] 부분 응답 후 이탈');
  {
    const task = newTask('live');
    const t = await drive(task, 4, async (tk) => {
      tk._onTap(0, tk.blocks[0]);
      tk._onTap(1, tk.blocks[1]);           // 4개 중 2개만 입력하고 방치
    });
    check('부분 응답도 시행 종료됨', t !== null);
    check('timedOut 표시', t.timedOut === true);
    check('입력한 2개는 보존', t.response.length === 2, JSON.stringify(t.response));
    check('오답 처리', t.correct === false);
  }

  /* ---------- 9. 타이머 누수 ---------- */
  console.log('\n[9] 타이머 정리');
  {
    const task = newTask('live');
    await drive(task, 2, async (tk) => {
      tk._onTap(0, tk.blocks[0]);
      tk._onTap(1, tk.blocks[1]);
      tk.submit();
    });
    check('종료 후 응답 타이머 해제', task._timeoutId === null, String(task._timeoutId));
    check('종료 후 유예 타이머 해제', task._graceId === null, String(task._graceId));
    check('종료 후 취소창 타이머 해제', task._undoExpiryId === null, String(task._undoExpiryId));
    check('종료 후 입력 닫힘', task._inputOpen === false);

    /* abort()도 타이머를 정리해야 함 */
    const t2 = newTask('live');
    const p = drive(t2, 3, async () => {});
    await sleep(30);
    t2.abort();
    await p;
    check('abort() 후 입력 닫힘', t2._inputOpen === false);
    check('abort() 후 확정 상태 해제', t2._confirming === false);
  }

  /* ---------- 10. 취소 집계가 리포트로 흐르는지 ---------- */
  console.log('\n[10] 취소 집계 — 실수/망설임 분류');
  {
    const trials = [
      { timedOut: false, undos: [{ sinceTapMs: 200 }] },                        // 실수
      { timedOut: false, undos: [{ sinceTapMs: 1500 }] },                       // 망설임
      { timedOut: false, undos: [{ sinceTapMs: 100 }, { sinceTapMs: 2000 }] },  // 실수+망설임
      { timedOut: true,  undos: [] }
    ];
    const c = Scoring.inputCorrections(trials);
    check('수정 발생 시행 3건', c.trialsWithUndo === 3, JSON.stringify(c));
    check('총 취소 4회', c.totalUndos === 4);
    check('손 실수 2회', c.slips === 2);
    check('망설임 2회', c.deliberations === 2);
    check('시간초과 1시행', c.timedOutTrials === 1);
  }

  console.log('\n' + '='.repeat(52));
  console.log(`통과 ${pass} / 실패 ${fail}`);
  console.log('='.repeat(52));
  process.exitCode = fail ? 1 : 0;
})();

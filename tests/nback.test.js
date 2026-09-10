/* 도형 N-back 검증 — 자극열 생성 / 신호탐지 채점 / 응답 상태기계 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ---------------- DOM 스텁 ----------------
   과제는 stage.innerHTML에 마크업을 넣고 querySelector로 꺼내 쓴다.
   실제 파싱은 필요 없다 — 셀렉터마다 스텁 요소를 돌려주면 충분하다. */
function makeEl(tag) {
  const el = {
    tagName: tag || 'div', offsetWidth: 1, hidden: false,
    innerHTML: '', textContent: '', style: {}, _classes: new Set(),
    classList: {
      add: (...c) => c.forEach(x => el._classes.add(x)),
      remove: (...c) => c.forEach(x => el._classes.delete(x)),
      contains: c => el._classes.has(c),
      toggle: (c, on) => on ? el._classes.add(c) : el._classes.delete(c)
    },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, appendChild(c) { return c; },
    querySelector() { return makeEl(); }
  };
  return el;
}

function makeStage() {
  const cache = {};
  const stage = {
    innerHTML: '',
    querySelector(sel) {
      if (!cache[sel]) cache[sel] = makeEl();
      return cache[sel];
    },
    _cache: cache
  };
  return stage;
}

const docListeners = [];
global.window = global;
global.document = {
  addEventListener: (t, f) => docListeners.push({ t, f }),
  removeEventListener: (t, f) => {
    const i = docListeners.findIndex(l => l.t === t && l.f === f);
    if (i >= 0) docListeners.splice(i, 1);
  },
  createElement: makeEl
};
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
load('js/task-shape-nback.js');

const C = ShapeNbackTask.CONFIG;
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function () {

/* ============================================================
   1. 자극열 생성 — 중복 정답 배제가 핵심
   ============================================================ */
console.log('\n[1] 자극열 생성 — 2&3-back 중복 정답 배제');
{
  const spec = { round: 2, nLevels: [2, 3], count: 28, targetRates: { two: 0.20, three: 0.20 } };
  let ambiguous = 0, labelMismatch = 0, runs = 0;

  for (let r = 0; r < 300; r++) {
    const rng = new Core.Rng(1000 + r);
    const b = ShapeNbackTask.buildSequence(spec, rng);
    runs++;

    for (let i = 3; i < b.seq.length; i++) {
      const cur = b.seq[i], b2 = b.seq[i - 2], b3 = b.seq[i - 3];

      /* 정답이 두 개가 되는 자리는 존재해서는 안 된다 */
      if (cur === b2 && cur === b3) ambiguous++;

      /* 기록된 라벨이 실제 자극열과 일치해야 한다 */
      const lbl = b.labels[i];
      if (lbl === 'two'   && !(cur === b2 && cur !== b3)) labelMismatch++;
      if (lbl === 'three' && !(cur === b3 && cur !== b2)) labelMismatch++;
      if (lbl === 'none'  && !(cur !== b2 && cur !== b3)) labelMismatch++;
    }
  }

  check('중복 정답 자리가 하나도 없음 (300회 생성)', ambiguous === 0, ambiguous + '건 발견');
  check('기록된 라벨이 자극열과 100% 일치', labelMismatch === 0, labelMismatch + '건 불일치');
  check('생성이 항상 완료됨', runs === 300);
}

console.log('\n[2] 자극열 생성 — 라운드 1 (2-back 단독)');
{
  const spec = C.practice;
  let mismatch = 0;
  for (let r = 0; r < 200; r++) {
    const b = ShapeNbackTask.buildSequence(spec, new Core.Rng(7000 + r));
    for (let i = 2; i < b.seq.length; i++) {
      const cur = b.seq[i], b2 = b.seq[i - 2], lbl = b.labels[i];
      if (lbl === 'two' && cur !== b2) mismatch++;
      if (lbl === 'none' && cur === b2) mismatch++;
    }
    check.silent = true;
  }
  check('2-back 라벨이 자극열과 일치', mismatch === 0, mismatch + '건');

  const b0 = ShapeNbackTask.buildSequence(spec, new Core.Rng(42));
  check('도입 자극은 판단 대상 아님 (라벨 null)',
    b0.labels[0] === null && b0.labels[1] === null && b0.labels[2] !== null);
  check('자극 수가 명세와 일치', b0.seq.length === spec.count, b0.seq.length + ' vs ' + spec.count);
  check('도형은 3종만 사용', b0.seq.every(s => s >= 0 && s <= 2));
}

console.log('\n[3] 표적 비율과 재현성');
{
  const spec = C.rounds[1];
  const nMax = 3, judged = spec.count - nMax;
  let twoSum = 0, threeSum = 0, reps = 200;

  for (let r = 0; r < reps; r++) {
    const b = ShapeNbackTask.buildSequence(spec, new Core.Rng(500 + r));
    twoSum += b.labels.filter(l => l === 'two').length;
    threeSum += b.labels.filter(l => l === 'three').length;
  }
  const twoRate = twoSum / reps / judged;
  const threeRate = threeSum / reps / judged;

  check('2-back 표적 비율이 목표 20% 근방 (±6%p)', Math.abs(twoRate - 0.20) < 0.06,
    (twoRate * 100).toFixed(1) + '%');
  check('3-back 표적 비율이 목표 20% 근방 (±6%p)', Math.abs(threeRate - 0.20) < 0.06,
    (threeRate * 100).toFixed(1) + '%');
  check('표적이 과반을 넘지 않음', twoRate + threeRate < 0.5,
    ((twoRate + threeRate) * 100).toFixed(1) + '%');

  const a = ShapeNbackTask.buildSequence(spec, new Core.Rng(999));
  const b = ShapeNbackTask.buildSequence(spec, new Core.Rng(999));
  check('같은 시드 → 동일 자극열 (재현 가능)',
    JSON.stringify(a.seq) === JSON.stringify(b.seq) &&
    JSON.stringify(a.labels) === JSON.stringify(b.labels));
}

/* ============================================================
   4. 신호탐지 수학
   ============================================================ */
console.log('\n[4] probit / d′ / 반응편향');
{
  check('probit(0.5) = 0', Math.abs(Scoring.probit(0.5)) < 1e-6);
  check('probit(0.975) ≈ 1.96', Math.abs(Scoring.probit(0.975) - 1.959964) < 1e-3,
    Scoring.probit(0.975).toFixed(6));
  check('probit(0.025) ≈ -1.96', Math.abs(Scoring.probit(0.025) + 1.959964) < 1e-3);
  check('probit 단조증가', Scoring.probit(0.2) < Scoring.probit(0.5) && Scoring.probit(0.5) < Scoring.probit(0.8));

  /* 완벽 수행 — log-linear 보정이 없으면 여기서 Infinity가 난다 */
  const perfect = Scoring.sdt(10, 10, 0, 20);
  check('적중 100% · 오경보 0%에서도 d′가 유한', isFinite(perfect.dPrime), String(perfect.dPrime));
  check('완벽 수행의 d′가 충분히 큼 (> 2.5)', perfect.dPrime > 2.5, String(perfect.dPrime));

  /* 무작위 반응 — d′ ≈ 0 */
  const chance = Scoring.sdt(5, 10, 10, 20);
  check('무작위 반응의 d′ ≈ 0 (±0.3)', Math.abs(chance.dPrime) < 0.3, String(chance.dPrime));

  /* 아무 때나 "같다"를 누르는 전략 — 정답률은 높아도 d′는 낮아야 한다 */
  const spammer = Scoring.sdt(10, 10, 18, 20);
  check('화살표 남발 전략은 d′가 낮게 나온다', spammer.dPrime < 1.0, String(spammer.dPrime));
  check('남발 전략은 반응편향 c가 음수', spammer.criterion < 0, String(spammer.criterion));

  const conservative = Scoring.sdt(3, 10, 0, 20);
  check('보수적 반응은 c가 양수', conservative.criterion > 0, String(conservative.criterion));

  const empty = Scoring.sdt(0, 0, 0, 0);
  check('표적이 없으면 d′ null (0으로 나눔 없음)', empty.dPrime === null);
}

/* ============================================================
   5. 채점 — 조건별 버킷 배정
   ============================================================ */
console.log('\n[5] 채점 — 조건 분리와 판정');
{
  function T(round, condition, responseKey, correct, rt) {
    return {
      taskId: 'shape-nback', phase: 'live', correct: correct, rtFirstMs: rt,
      taskFields: { round, judged: true, condition, responseKey }
    };
  }

  const trials = [
    /* 라운드 1: 2-back */
    T(1, 'two', 'two', true, 800),
    T(1, 'two', 'none', false, 900),
    T(1, 'none', 'none', true, 700),
    T(1, 'none', 'two', false, 650),
    /* 라운드 2 */
    T(2, 'two', 'two', true, 1000),
    T(2, 'three', 'three', true, 1200),
    T(2, 'three', 'two', false, 1100),
    T(2, 'none', 'none', true, 900),
    T(2, 'none', null, false, null),
    /* 도입 자극 — 채점 제외되어야 함 */
    { taskId: 'shape-nback', phase: 'live', correct: null, rtFirstMs: null,
      taskFields: { round: 1, judged: false, condition: null, responseKey: null } }
  ];

  const s = Scoring.shapeNback(trials);

  check('판단 시행만 집계 (도입 자극 제외)', s.judgedTrials === 9, 'got ' + s.judgedTrials);
  check('전체 자극 수는 그대로', s.totalTrials === 10, 'got ' + s.totalTrials);
  check('정답 5건', s.correctTrials === 5, 'got ' + s.correctTrials);
  check('무응답 1건', s.noResponseTrials === 1, 'got ' + s.noResponseTrials);

  const byKey = {};
  s.conditions.forEach(c => { byKey[c.key] = c; });

  check('조건이 3개로 분리됨', s.conditions.length === 3,
    s.conditions.map(c => c.key).join(','));

  check('R1 2-back: 표적 2 · 적중 1', byKey['r1-2back'].targets === 2 && byKey['r1-2back'].hits === 1,
    JSON.stringify(byKey['r1-2back']));
  check('R1 2-back: 비표적 2 · 오경보 1', byKey['r1-2back'].nonTargets === 2 && byKey['r1-2back'].falseAlarms === 1);

  check('R2 2-back: 표적 1 · 적중 1', byKey['r2-2back'].targets === 1 && byKey['r2-2back'].hits === 1);
  check('R2 3-back: 표적 2 · 적중 1 · 누락 1',
    byKey['r2-3back'].targets === 2 && byKey['r2-3back'].hits === 1 && byKey['r2-3back'].misses === 1,
    JSON.stringify(byKey['r2-3back']));

  /* 라운드 2의 비표적은 두 조건 모두의 오경보 기회다 */
  check('R2 비표적이 2-back·3-back 양쪽에 계산됨',
    byKey['r2-2back'].nonTargets === 2 && byKey['r2-3back'].nonTargets === 2,
    byKey['r2-2back'].nonTargets + ' / ' + byKey['r2-3back'].nonTargets);

  check('비표적 무응답은 오경보가 아니라 정확기각',
    byKey['r2-2back'].falseAlarms === 0, String(byKey['r2-2back'].falseAlarms));

  check('종합 d′가 산출됨', typeof s.overallDPrime === 'number' && isFinite(s.overallDPrime),
    String(s.overallDPrime));
  check('빈 배열도 안전', (function () {
    const e = Scoring.shapeNback([]);
    return e.judgedTrials === 0 && e.overallDPrime === null && e.conditions.length === 0;
  })());
}

/* ============================================================
   6. 응답 상태기계
   ============================================================ */
console.log('\n[6] 응답 상태기계');

/* 절차 가속 */
C.stimulusMs = 40; C.isiMs = 4; C.preRoundMs = 4; C.postTrialFeedbackMs = 4;

function newTask(phase, onTrial) {
  return new ShapeNbackTask({
    stage: makeStage(),
    rng: new Core.Rng(31337),
    phase: phase,
    onTrial: onTrial || function () {},
    onStatus: function () {}
  });
}

/* 판단 시행이 열릴 때마다 키를 자동 입력 */
function autoRespond(task, chooser) {
  const base = task.onStatus;
  task.onStatus = function (s) {
    base(s);
    if (s.kind === 'respond') {
      const k = chooser();
      if (k) setTimeout(() => task._respond(k, 'keyboard'), 0);
    }
  };
}

{
  const logged = [];
  const task = newTask('live', t => logged.push(t));
  autoRespond(task, () => 'none');            // 전부 Space
  await task._runRound({ round: 1, nLevels: [2], count: 8, targetRates: { two: 0.33 } });
  task.destroy();

  check('판단 시행만 로그에 남음 (8자극 → 6건)', logged.length === 6, 'got ' + logged.length);
  check('모든 로그가 judged', logged.every(t => t.taskFields.judged === true));
  check('누른 키가 기록됨', logged.every(t => t.taskFields.responseKey === 'none'));
  check('반응시간이 기록됨', logged.every(t => typeof t.rtFirstMs === 'number' && t.rtFirstMs >= 0));
  check('비표적은 정확기각으로 판정',
    logged.filter(t => t.taskFields.condition === 'none').every(t => t.taskFields.outcome === 'cr'));
  check('표적에 Space를 누르면 누락으로 판정',
    logged.filter(t => t.taskFields.condition === 'two').every(t => t.taskFields.outcome === 'miss'));
  check('difficulty에 n 수준 기록', logged.every(t => t.difficulty === 2));
}

{
  const logged = [];
  const task = newTask('live', t => logged.push(t));
  /* 아무 키도 누르지 않음 */
  await task._runRound({ round: 1, nLevels: [2], count: 6, targetRates: { two: 0.25 } });
  task.destroy();

  check('무응답이어도 시행이 진행·종료됨', logged.length === 4, 'got ' + logged.length);
  check('무응답은 timedOut 표시', logged.every(t => t.timedOut === true));
  check('무응답은 omission으로 판정', logged.every(t => t.taskFields.outcome === 'omission'));
  check('무응답은 오답 처리', logged.every(t => t.correct === false));
  check('무응답의 responseKey는 null', logged.every(t => t.taskFields.responseKey === null));
}

{
  const logged = [];
  const task = newTask('live', t => logged.push(t));
  let first = true;
  const base = task.onStatus;
  task.onStatus = function (s) {
    base(s);
    if (s.kind === 'respond' && first) {
      first = false;
      setTimeout(() => {
        task._respond('two', 'keyboard');
        task._respond('none', 'keyboard');    // 두 번째 입력은 무시되어야 함
        task._respond('three', 'pointer');
      }, 0);
    }
  };
  await task._runRound({ round: 1, nLevels: [2], count: 4, targetRates: { two: 0 } });
  task.destroy();

  check('첫 응답만 채택 (연타 무시)', logged[0].taskFields.responseKey === 'two',
    logged[0].taskFields.responseKey);
  check('입력 경로가 기록됨', logged[0].taskFields.responseVia === 'keyboard');
}

{
  /* 2&3-back 라운드에서 back2/back3가 함께 기록되는지 */
  const logged = [];
  const task = newTask('live', t => logged.push(t));
  autoRespond(task, () => 'none');
  await task._runRound({ round: 2, nLevels: [2, 3], count: 10, targetRates: { two: 0.2, three: 0.2 } });
  task.destroy();

  check('2라운드 로그에 back2·back3 모두 기록',
    logged.every(t => t.taskFields.back2 != null && t.taskFields.back3 != null));
  check('2라운드 difficulty = 3', logged.every(t => t.difficulty === 3));
  check('로그의 조건이 back2/back3와 정합',
    logged.every(t => {
      const f = t.taskFields;
      if (f.condition === 'two') return f.shapeId === f.back2 && f.shapeId !== f.back3;
      if (f.condition === 'three') return f.shapeId === f.back3 && f.shapeId !== f.back2;
      return f.shapeId !== f.back2 && f.shapeId !== f.back3;
    }));
}

{
  /* 키 핸들러 누수 */
  const before = docListeners.length;
  const task = newTask('live');
  const during = docListeners.length;
  task.destroy();
  const after = docListeners.length;

  check('과제가 keydown 핸들러를 등록', during === before + 1, before + ' → ' + during);
  check('destroy()가 핸들러를 해제 (누수 없음)', after === before, during + ' → ' + after);

  const t2 = newTask('live');
  t2.abort();
  check('abort()도 핸들러를 해제', docListeners.length === before);
}

/* ============================================================
   7. 레지스트리 계약
   ============================================================ */
console.log('\n[7] 레지스트리 계약');
{
  const d = Tasks.get('shape-nback');
  check('과제가 등록됨', !!d);
  check('필수 메서드 모두 존재',
    ['create', 'score', 'normKey', 'tiles', 'logTable', 'explain', 'sections']
      .every(k => typeof d[k] === 'function'));
  check('사전고지 3항목 존재',
    !!(d.consent.measures && d.consent.scoring && d.consent.collects));
  check('과제 설명 단계가 4개', d.brief.length === 4, String(d.brief.length));

  const s = Scoring.shapeNback([
    { correct: true, rtFirstMs: 900, taskFields: { round: 1, judged: true, condition: 'two', responseKey: 'two' } },
    { correct: true, rtFirstMs: 800, taskFields: { round: 1, judged: true, condition: 'none', responseKey: 'none' } }
  ]);
  check('normKey가 종합 d′를 반환', d.normKey(s) === s.overallDPrime);
  check('tiles가 배열 반환', Array.isArray(d.tiles(s)) && d.tiles(s).length > 0);
  check('중복 id 등록은 거부', (function () {
    try { Tasks.register({ id: 'shape-nback' }); return false; }
    catch (e) { return /중복|필수/.test(e.message); }
  })());
}

console.log('\n' + '='.repeat(52));
console.log(`통과 ${pass} / 실패 ${fail}`);
console.log('='.repeat(52));
process.exitCode = fail ? 1 : 0;
})();

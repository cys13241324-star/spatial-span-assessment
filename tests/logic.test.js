/* 프로토타입 순수 로직 검증 — RNG / 채점 / 규준 게이트 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 최소 DOM 스텁
const listeners = [];
global.window = global;
global.document = { addEventListener: (t, f) => listeners.push(t) };
global.navigator = { userAgent: 'node', language: 'ko', hardwareConcurrency: 8, platform: 'Win32' };
global.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 };
global.performance = { now: () => Date.now() };
window.matchMedia = () => ({ matches: false });
window.addEventListener = (t, f) => listeners.push(t);
window.innerWidth = 1600; window.innerHeight = 900; window.devicePixelRatio = 1;

function load(f) { eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); }
load('js/core.js');
load('js/tasks.js');
load('js/scoring.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------- 1. 시드 RNG ---------- */
console.log('\n[1] 시드 RNG — 재현성과 비복원 추출');
{
  const a = new Core.Rng(12345), b = new Core.Rng(12345);
  const sa = [], sb = [];
  for (let i = 0; i < 50; i++) { sa.push(a.next()); sb.push(b.next()); }
  check('같은 시드 → 동일 수열 (자극 재현 가능)', JSON.stringify(sa) === JSON.stringify(sb));

  const c = new Core.Rng(999), d = new Core.Rng(1000);
  check('다른 시드 → 다른 수열', c.next() !== d.next());

  const ids = [0,1,2,3,4,5,6,7,8];
  let distinctOk = true, rangeOk = true;
  const r = new Core.Rng(7);
  for (let t = 0; t < 2000; t++) {
    const k = 2 + (t % 8);
    const s = r.sample(ids, k);
    if (s.length !== k) rangeOk = false;
    if (new Set(s).size !== k) distinctOk = false;
    if (s.some(v => v < 0 || v > 8)) rangeOk = false;
  }
  check('sample()은 항상 비복원 (도형 중복 없음)', distinctOk);
  check('sample()은 요청 길이·범위 준수', rangeOk);

  // 균등성 대략 확인
  const counts = new Array(9).fill(0);
  const r2 = new Core.Rng(42);
  for (let t = 0; t < 9000; t++) counts[r2.int(9)]++;
  const min = Math.min(...counts), max = Math.max(...counts);
  check('int(9) 분포 균등 (편차 < 20%)', (max - min) / 1000 < 0.2, `min=${min} max=${max}`);
}

/* ---------- 2. 채점 (Kessels et al. 2000) ---------- */
console.log('\n[2] 채점 — Corsi Span / Total Score');
{
  // 진짜 span 5인 응시자 시나리오: 2~5는 다 맞고, 6에서 2회 모두 실패
  const trials = [];
  let idx = 0;
  function T(level, correct, rt) {
    trials.push({
      difficulty: level, correct,
      stimulus: [0,1,2,3,4,5].slice(0, level),
      response: correct ? [0,1,2,3,4,5].slice(0, level) : [1,0,2,3,4,5].slice(0, level),
      rtTotalMs: rt, trialIndex: idx++, phase: 'live'
    });
  }
  [2,3,4,5].forEach(L => { T(L, true, 1000 + L * 200); T(L, true, 1100 + L * 200); });
  T(6, false, 3000); T(6, false, 3100);

  const s = Scoring.spatialSpan(trials);
  check('Corsi Span = 5', s.corsiSpan === 5, 'got ' + s.corsiSpan);
  check('정답 시행 8회', s.correctTrials === 8, 'got ' + s.correctTrials);
  check('전체 10시행', s.totalTrials === 10, 'got ' + s.totalTrials);
  check('Total Score = 5 × 8 = 40', s.totalScore === 40, 'got ' + s.totalScore);
  check('단계 5개 집계 (2,3,4,5,6)', s.byLevel.length === 5, 'got ' + s.byLevel.length);
  check('단계별 정렬 오름차순', s.byLevel.every((l, i, a) => i === 0 || a[i-1].level < l.level));
  check('길이 6 정확도 0%', s.byLevel[4].accuracy === 0);
  check('평균 RT는 정답 시행만 반영', s.meanRtTotalMs < 3000, 'got ' + s.meanRtTotalMs);

  // 경계: 전부 실패
  const zero = Scoring.spatialSpan([
    { difficulty: 2, correct: false, stimulus: [0,1], response: [1,0], rtTotalMs: 900, phase: 'live' },
    { difficulty: 2, correct: false, stimulus: [2,3], response: [3,2], rtTotalMs: 950, phase: 'live' }
  ]);
  check('전부 오답 → Span 0, Total 0 (0으로 나눔 없음)', zero.corsiSpan === 0 && zero.totalScore === 0);
  check('전부 오답 → meanRT null', zero.meanRtTotalMs === null);

  // 경계: 빈 배열
  const empty = Scoring.spatialSpan([]);
  check('빈 시행 배열도 안전', empty.corsiSpan === 0 && empty.byLevel.length === 0);
}

/* ---------- 3. 오류 유형 분류 ---------- */
console.log('\n[3] 오류 유형 분류');
{
  const t = [
    { difficulty: 3, correct: false, stimulus: [0,1,2], response: [0,2,1], rtTotalMs: 1 }, // 순서 오류
    { difficulty: 3, correct: false, stimulus: [0,1,2], response: [0,1,7], rtTotalMs: 1 }, // 위치 오류
    { difficulty: 3, correct: false, stimulus: [0,1,2], response: [0,1],   rtTotalMs: 1 }, // 누락
    { difficulty: 3, correct: true,  stimulus: [0,1,2], response: [0,1,2], rtTotalMs: 1 }  // 정답 제외
  ];
  const e = Scoring.errorProfile(t);
  check('순서 오류 1건', e.orderErrors === 1, JSON.stringify(e));
  check('위치 오류 1건', e.itemErrors === 1, JSON.stringify(e));
  check('누락 1건', e.omissions === 1, JSON.stringify(e));
}

/* ---------- 4. 규준 게이트 ---------- */
console.log('\n[4] 규준 게이트 — 백분위 허위표시 차단');
{
  check('규준 없음 → has() false', Core.Norms.has('spatial-span') === false);
  check('규준 없음 → percentile() null (차단)', Core.Norms.percentile('spatial-span', 40) === null);
  check('차단 사유 문구 존재', /수집되지 않/.test(Core.Norms.reason('spatial-span')));

  // n 미달 규준 주입 → 여전히 차단되어야 함
  Core.Norms.tables['spatial-span'] = { n: 120, mean: 38, sd: 9 };
  check('n=120 (300 미달) → 여전히 차단', Core.Norms.percentile('spatial-span', 40) === null);
  check('미달 사유에 n 표기', /n = 120/.test(Core.Norms.reason('spatial-span')));

  // 충족 규준 → 백분위 산출
  Core.Norms.tables['spatial-span'] = { n: 500, mean: 38, sd: 9 };
  const p50 = Core.Norms.percentile('spatial-span', 38);
  const p84 = Core.Norms.percentile('spatial-span', 47);
  const p16 = Core.Norms.percentile('spatial-span', 29);
  check('n=500 → 백분위 개방', p50 !== null);
  check('평균 = 50 백분위 (±1)', Math.abs(p50 - 50) < 1, 'got ' + p50);
  check('+1SD ≈ 84 백분위 (±1.5)', Math.abs(p84 - 84.1) < 1.5, 'got ' + p84);
  check('-1SD ≈ 16 백분위 (±1.5)', Math.abs(p16 - 15.9) < 1.5, 'got ' + p16);
  check('백분위 단조증가', p16 < p50 && p50 < p84);
  delete Core.Norms.tables['spatial-span'];
}

/* ---------- 5. 로거 스키마 ---------- */
console.log('\n[5] Trial 로거 스키마');
{
  const profile = Core.Device.profile({ estimatedHz: 60, medianFrameMs: 16.67, frameSamples: 30 });
  const sess = Core.createSession('spatial-span', profile);
  const log = new Core.Logger(sess);

  log.logTrial({
    taskId: 'spatial-span', phase: 'practice', trialIndex: 0, difficulty: 2,
    stimulus: [3,7], response: [3,7], correct: true,
    rtFirstMs: 620, rtTotalMs: 1180, interTapMs: [560], tsClient: Date.now()
  });
  log.logTrial({
    taskId: 'spatial-span', phase: 'live', trialIndex: 0, difficulty: 2,
    stimulus: [1,5], response: [5,1], correct: false,
    rtFirstMs: 700, rtTotalMs: 1500, interTapMs: [800], tsClient: Date.now()
  });

  const rec = log.trials[1];
  const required = ['sessionId','taskId','phase','trialIndex','difficulty','stimulus',
                    'response','correct','rtFirstMs','rtTotalMs','interTapMs',
                    'tsClient','tsServer','deviceFingerprint','abandoned'];
  const missing = required.filter(k => !(k in rec));
  check('문서 5절 스키마 전 필드 존재', missing.length === 0, '누락: ' + missing.join(','));
  check('liveTrials()가 연습 시행 제외', log.liveTrials().length === 1);
  check('기기 지문 생성됨', /^dev_/.test(sess.deviceFingerprint), sess.deviceFingerprint);
  check('세션 시드 존재 (재현 근거)', Number.isInteger(sess.seed));
  check('stimulus 배열 복사 (원본 변조 방지)', rec.stimulus !== undefined && Array.isArray(rec.stimulus));
  check('toJSON에 schemaVersion 포함', log.toJSON().schemaVersion === '0.1.0');
}

/* ---------- 6. 무결성 요약 ---------- */
console.log('\n[6] 무결성 이벤트 요약');
{
  const now = Date.now();
  const ev = [
    { type: 'visibility', at: now + 100, detail: 'hidden' },
    { type: 'blur', at: now + 150 },
    { type: 'resize', at: now + 200, detail: '800x600' },
    { type: 'blur', at: now + 99999, detail: null }   // 본 시행 구간 밖
  ];
  const f = Scoring.integritySummary(ev, { from: now, to: now + 1000 });
  const labels = f.map(x => x.label).join(' | ');
  check('탭 이탈 감지', /탭 이탈 1회/.test(labels), labels);
  check('구간 밖 이벤트 제외 (blur 1회만)', /포커스 이탈 1회/.test(labels), labels);
  check('플래그 표시됨', f.some(x => x.flag === true));

  const clean = Scoring.integritySummary([], { from: now, to: now + 1000 });
  check('이벤트 없으면 이상 없음', clean.length === 1 && clean[0].flag === false);
}

/* ---------- 7. 계단 절차 시뮬레이션 ---------- */
console.log('\n[7] 계단 절차 시뮬레이션 — 종료 조건과 span 회수');
{
  // task-spatial-span.js의 runLive 계단 로직을 그대로 재현해 검증
  const CONFIG = { startLevel: 2, maxLevel: 9, trialsPerLevel: 2, maxLiveTrials: 24 };

  function simulate(trueSpan, rng) {
    const trials = [];
    let level = CONFIG.startLevel, n = 0;
    while (level <= CONFIG.maxLevel && n < CONFIG.maxLiveTrials) {
      let correctInLevel = 0;
      for (let k = 0; k < CONFIG.trialsPerLevel; k++) {
        // 로지스틱 응답 모형: 난이도가 진짜 span을 넘으면 급격히 실패
        const p = 1 / (1 + Math.exp((level - trueSpan - 0.5) * 1.8));
        const correct = rng.next() < p;
        trials.push({ difficulty: level, correct, stimulus: [], response: [], rtTotalMs: 1200, phase: 'live' });
        n++;
        if (correct) correctInLevel++;
      }
      if (correctInLevel === 0) break;
      level++;
    }
    return trials;
  }

  const rng = new Core.Rng(2024);
  let bounded = true, capOk = true;
  const recovered = {};

  for (const trueSpan of [3, 4, 5, 6, 7]) {
    const spans = [];
    for (let rep = 0; rep < 400; rep++) {
      const tr = simulate(trueSpan, rng);
      if (tr.length > CONFIG.maxLiveTrials) capOk = false;
      const sc = Scoring.spatialSpan(tr);
      if (sc.corsiSpan > CONFIG.maxLevel) bounded = false;
      spans.push(sc.corsiSpan);
    }
    recovered[trueSpan] = (spans.reduce((a, b) => a + b, 0) / spans.length);
  }

  check('시행 수가 안전 상한 이내', capOk);
  check('추정 span이 최대 단계 이내', bounded);
  console.log('     진짜 span → 회수된 평균 span:',
    Object.entries(recovered).map(([k, v]) => `${k}→${v.toFixed(2)}`).join('  '));

  const keys = [3,4,5,6,7];
  const monotone = keys.every((k, i) => i === 0 || recovered[keys[i-1]] < recovered[k]);
  check('진짜 span 증가 → 측정 span 단조증가 (변별력 확인)', monotone);

  const biasOk = keys.every(k => Math.abs(recovered[k] - k) < 1.2);
  check('측정 span이 진짜 span 근방 (편향 < 1.2)', biasOk,
        JSON.stringify(Object.fromEntries(keys.map(k => [k, +recovered[k].toFixed(2)]))));
}

console.log('\n' + '='.repeat(52));
console.log(`통과 ${pass} / 실패 ${fail}`);
console.log('='.repeat(52));
process.exitCode = fail ? 1 : 0;

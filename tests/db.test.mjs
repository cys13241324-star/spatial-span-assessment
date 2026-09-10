/* 채점 DB — 스키마 적용 · 세션 적재 · 뷰 · 일치도 수학 · AI Hub 변환 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applySchema, loadSession, openDb } from '../db/load-session.mjs';
import { simpleAgreement, weightedKappa, kappaVerdict, byTrait, linearCalibration } from '../db/agreement.mjs';
import { buildReport } from '../db/report.mjs';
import { guessType, eligible, importFile } from '../db/import-aihub.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

/* 브라우저 모듈을 샌드박스로 로드 — 픽스처·문항·모의 채점기 재사용 */
function loadBrowser(files) {
  const sandbox = { location: { search: '' }, navigator: { userAgent: 'node', language: 'ko', hardwareConcurrency: 8 },
    screen: { width: 1, height: 1, availWidth: 1, availHeight: 1 }, performance: { now: () => Date.now() },
    document: { addEventListener() {}, createElement() { return {}; } }, matchMedia: () => ({ matches: false }),
    addEventListener() {}, innerWidth: 1, innerHeight: 1, devicePixelRatio: 1 };
  sandbox.window = sandbox; sandbox.global = sandbox;
  for (const f of files) new Function('window', 'global', fs.readFileSync(path.join(ROOT, f), 'utf8'))(sandbox, sandbox);
  return sandbox;
}
const B = loadBrowser(['js/core.js', 'js/interview/providers.js', 'js/interview/transcript.js', 'js/interview/questions.js',
  'js/interview/fixtures.js', 'js/interview/mockscorer.js']);

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('\n[1] 스키마');
const db = new DatabaseSync(':memory:');
applySchema(db);
{
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  for (const t of ['sessions', 'answers', 'transcripts', 'transcript_corrections', 'auto_score_runs', 'auto_scores', 'auto_score_traits', 'auto_citations', 'raters', 'human_scores', 'human_evidence', 'rating_queue', 'norms', 'audit'])
    check(`테이블 ${t}`, tables.includes(t));
  const views = db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().map(r => r.name);
  check('뷰 3개', ['v_eligible_answers', 'v_rater_pairs', 'v_auto_vs_human'].every(v => views.includes(v)));
  applySchema(db);
  check('스키마 재적용 멱등', true);
  let threw = false;
  try { db.prepare("INSERT INTO auto_score_traits(auto_score_id, trait_id, raw) VALUES (999, 'x', 7)").run(); } catch (e) { threw = true; }
  check('점수 범위 1~5 제약', threw);
}

console.log('\n[2] 세션 적재 — 픽스처 + 모의 채점 + 사람 채점');
const seeded = B.Fixtures.seedAnswers(B.Questions.SET, 1700000000000);
const session = {
  id: 'sess_dbtest', kind: 'video-interview', testMode: false, bypasses: [],
  names: B.Fixtures.names, jobId: 'placeholder',
  questionSetVersion: B.Questions.SET.version, rubricVersion: B.Questions.RUBRIC.version,
  contentFingerprint: B.Questions.fingerprint(), providers: [], startedAt: '2026-09-10T00:00:00.000Z', submittedAt: '2026-09-10T00:10:00.000Z',
  retention: { media: '2026-10-10T00:00:00.000Z', transcript: '2027-09-10T00:00:00.000Z', score: '2029-09-10T00:00:00.000Z' },
  answers: seeded.map(a => ({ ...a, media: { ...a.media, skipped: null, complete: true, chunks: 12, bytes: 120000 } }))
};
/* 정정 이력 하나 */
session.answers[0].transcript.corrections = [{ at: 1700000001000, attempt: 1, editDistance: 4, cap: 20, accepted: true, reason: 'ok' }];
session.answers[0].transcript.corrected = session.answers[0].transcript.raw.replace('졸업', '졸업을');
const score = await B.MockScorer.score({ session, rubric: B.Questions.RUBRIC, questions: B.Questions.SET });
session.score = score;
session.humanScore = {
  reviewerRef: 'r01', at: '2026-09-10T01:00:00.000Z', rubricVersion: B.Questions.RUBRIC.version,
  perQuestion: B.Questions.SET.items.map(q => ({ questionId: q.id, traits: q.traits.map(t => ({ traitId: t, score: 3 })),
    evidence: [{ traitId: q.traits[0], quotedText: '근거', startChar: 0, endChar: 2 }], note: '' }))
};
{
  const r = loadSession(db, session, { questions: B.Questions.SET });
  check('답변 6건 적재', r.answers === 6, JSON.stringify(r));
  check('자동 run 생성', typeof r.autoRunId === 'number');
  check('사람 점수 적재 수 = 문항별 특성 합', r.humanScores === B.Questions.SET.items.reduce((s, q) => s + q.traits.length, 0), String(r.humanScores));
  check('전사 6건', db.prepare('SELECT COUNT(*) c FROM transcripts').get().c === 6);
  check('정정 이력 1건 · correction_count 1', db.prepare('SELECT COUNT(*) c FROM transcript_corrections').get().c === 1 &&
    db.prepare('SELECT correction_count c FROM transcripts t JOIN answers a ON a.id=t.answer_id WHERE a.question_id=?').get('q1').c === 1);
  check('제외 문항(q6)은 auto_scores.excluded=1', db.prepare('SELECT s.excluded e, s.exclude_reason r FROM auto_scores s JOIN answers a ON a.id=s.answer_id WHERE a.question_id=?').get('q6').e === 1);
  check('근거 인용 적재', db.prepare('SELECT COUNT(*) c FROM auto_citations').get().c > 0);
  check('평가자 r01 등록', db.prepare('SELECT COUNT(*) c FROM raters WHERE id=?').get('r01').c === 1);
  check('사람 근거 적재', db.prepare('SELECT COUNT(*) c FROM human_evidence').get().c === 6);
  check('감사 로그 load 기록', db.prepare("SELECT COUNT(*) c FROM audit WHERE type='load'").get().c === 1);

  /* 재적재: 세션 갱신, run은 추가 */
  loadSession(db, session, { questions: B.Questions.SET });
  check('재적재 시 세션 1개 유지', db.prepare('SELECT COUNT(*) c FROM sessions').get().c === 1);
  check('재적재 시 자동 run은 2개 (덮어쓰지 않음)', db.prepare('SELECT COUNT(*) c FROM auto_score_runs').get().c === 2);
  check('재적재 시 사람 점수는 갱신 (중복 없음)', db.prepare('SELECT COUNT(*) c FROM human_scores').get().c === r.humanScores);
}

console.log('\n[3] 뷰 — 자격·일치도 원자료');
{
  check('정상 세션은 eligible', db.prepare('SELECT COUNT(*) c FROM v_eligible_answers').get().c === 6);
  const avh = db.prepare('SELECT * FROM v_auto_vs_human').all();
  check('자동-사람 쌍이 채점된 문항에서만', avh.length > 0 && !avh.some(r => r.answer_id === db.prepare('SELECT id FROM answers WHERE question_id=?').get('q6').id));
  check('자동-사람 쌍이 run마다 생김 (2 run)', new Set(avh.map(r => r.run_id)).size === 2);

  /* 테스트 모드 세션은 자격 없음 */
  loadSession(db, { ...session, id: 'sess_test_mode', testMode: true, bypasses: [{ gate: 'check', reason: 'x' }], score: null, humanScore: null }, { questions: B.Questions.SET });
  check('테스트 모드 세션의 답변은 eligible 아님', db.prepare('SELECT COUNT(*) c FROM v_eligible_answers').get().c === 6);

  /* 두 번째 평가자 → 평가자 쌍 뷰 */
  const hs2 = JSON.parse(JSON.stringify(session.humanScore)); hs2.reviewerRef = 'r02';
  hs2.perQuestion.forEach((p, i) => p.traits.forEach(t => { t.score = i % 2 ? 4 : 3; }));
  loadSession(db, { ...session, score: null, humanScore: hs2 }, { questions: B.Questions.SET });
  const pairs = db.prepare('SELECT * FROM v_rater_pairs').all();
  check('평가자 쌍 뷰 = 특성 수만큼', pairs.length === session.humanScore.perQuestion.reduce((s, p) => s + p.traits.length, 0), String(pairs.length));
  check('쌍은 rater_a < rater_b 한 방향만', pairs.every(p => p.rater_a === 'r01' && p.rater_b === 'r02'));
}

console.log('\n[4] 일치도 수학');
{
  const perfect = Array.from({ length: 40 }, (_, i) => [1 + (i % 5), 1 + (i % 5)]);
  check('완전 일치 κ = 1', weightedKappa(perfect).kappa === 1);
  const off1 = perfect.map(([a]) => [a, Math.min(5, a + 1)]);
  const k1 = weightedKappa(off1).kappa;
  check('항상 +1 차이면 κ < 1이지만 양수', k1 < 1 && k1 > 0, String(k1));
  const opposite = perfect.map(([a]) => [a, 6 - a]);
  check('정반대면 κ 음수', weightedKappa(opposite).kappa < 0);
  check('표본 0 → null', weightedKappa([]).kappa === null && kappaVerdict(null) === '표본 없음');
  check('범위 밖 값은 무시', weightedKappa([[1, 1], [9, 1], [2, 2]]).n === 2);
  check('가중 없음 < 이차 가중 (인접 오차에 관대)', weightedKappa(off1, 5, 'none').kappa < weightedKappa(off1, 5, 'quadratic').kappa);
  check('판정 문구 경계 0.7', kappaVerdict(0.7).includes('목표 충족') && kappaVerdict(0.69).includes('재훈련'));

  const s = simpleAgreement([[3, 3], [4, 2], [1, 2], [null, 3]]);
  check('simpleAgreement n=3 · 정확 1/3 · ±1 2/3', s.n === 3 && Math.abs(s.exact - 1 / 3) < 1e-9 && Math.abs(s.within1 - 2 / 3) < 1e-9, JSON.stringify(s));
  check('meanDiff 부호 = 첫째 − 둘째', Math.abs(s.meanDiff - (0 + 2 - 1) / 3) < 1e-9);

  const bt = byTrait([{ trait_id: 'a', score_a: 3, score_b: 3 }, { trait_id: 'a', score_a: 5, score_b: 4 }, { trait_id: 'b', score_a: 1, score_b: 5 }]);
  check('특성별 분리 계산', bt.a.n === 2 && bt.b.n === 1 && 'verdict' in bt.a);

  const few = linearCalibration([[3, 3], [4, 4]]);
  check('교정 계수는 표본 30 미만이면 미산출', few.ok === false);
  const many = Array.from({ length: 40 }, (_, i) => { const a = 1 + (i % 5); return [a, Math.min(5, Math.max(1, a * 0.5 + 1.5))]; });
  const cal = linearCalibration(many);
  check('교정 계수 산출 (기울기 0.5 근방)', cal.ok && Math.abs(cal.slope - 0.5) < 0.05, JSON.stringify(cal));
}

console.log('\n[5] 리포트');
{
  const r = buildReport(db);
  check('현황 카운트', r.counts.sessions === 2 && r.counts.eligible === 6 && r.counts.raters === 2);
  check('평가자 간 특성별 일치도 산출', Object.keys(r.interRater).length >= 3);
  check('전체 κ와 판정', r.interRaterAll && typeof r.interRaterAll.kappa === 'number' && r.interRaterAll.verdict);
  check('자동 vs 사람이 모델별로', 'mock-heuristic' in r.autoVsHuman);
}

console.log('\n[6] AI Hub 변환기 — 필드 추정·자격·대기열');
{
  check('질문 유형 추정', guessType('본인을 소개해 주세요') === 'intro' && guessType('갈등 경험을 말씀해 주세요') === 'behavioral' && guessType('동료가 지각한다면 어떻게 하시겠습니까') === 'situational');
  check('짧은 답변 제외', eligible('네').ok === false && eligible('네'.repeat(20)).ok === true);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-'));
  const sample = { id: 'S0001', metadata: { job_group: 'ICT' }, qa: [
    { question: '본인을 소개해 주세요', answer: '저는 데이터 분석을 3년간 해 온 지원자입니다. 주로 이탈 예측 모델을 만들었습니다.', label: { emotion: 'neutral', intent: '지식/기술' } },
    { question: '팀에서 갈등을 겪은 경험은?', answer: '네' },
    { question: '동료가 마감을 못 지킨다면?', answer: '먼저 이유를 묻고 우선순위를 다시 정한 뒤 팀장께 대안과 함께 보고하겠습니다.' }
  ] };
  fs.writeFileSync(path.join(tmp, 'S0001.json'), JSON.stringify(sample));
  const db2 = openDb(':memory:');
  const counters = { byType: {}, skipped: {} };
  const n = importFile(db2, path.join(tmp, 'S0001.json'), {
    id: ['id'], jobGroup: ['metadata.job_group'], qaList: ['qa'], question: ['question'], answer: ['answer'],
    intent: ['label.intent'], emotion: ['label.emotion'], summary: ['summary'], audioRef: ['audio'] }, counters, { perType: null, total: Infinity });
  check('자격 있는 답변 2건 대기열', n === 2 && db2.prepare('SELECT COUNT(*) c FROM rating_queue').get().c === 2, JSON.stringify(counters));
  check('짧은 답변은 skipped 집계', counters.skipped.too_short === 1);
  check('세션 kind=aihub-import', db2.prepare("SELECT kind FROM sessions").get().kind === 'aihub-import');
  check('감정 라벨은 채점 테이블이 아니라 감사 메타에만', db2.prepare("SELECT COUNT(*) c FROM audit WHERE type='aihub_meta'").get().c === 3 &&
    db2.prepare('SELECT COUNT(*) c FROM human_scores').get().c === 0);
  check('AI Hub 답변은 eligible 뷰에 포함 (media_skipped 예외)', db2.prepare('SELECT COUNT(*) c FROM v_eligible_answers').get().c === 3);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(52));
console.log(`통과 ${pass} / 실패 ${fail}`);
console.log('='.repeat(52));
process.exitCode = fail ? 1 : 0;

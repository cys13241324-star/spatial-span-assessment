/* 모의 채점기·픽스처·일치도 검증 — 화면과 데이터 모양이 실제 채점기와 같은지 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

global.window = global;
global.location = { search: '' };
global.navigator = { userAgent: 'node', language: 'ko', hardwareConcurrency: 8, platform: 'Win32' };
global.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 };
global.performance = { now: () => Date.now() };
global.document = { addEventListener() {}, createElement() { return {}; }, getElementById() { return null; } };
window.matchMedia = () => ({ matches: false });
window.addEventListener = () => {};
window.innerWidth = 1600; window.innerHeight = 900; window.devicePixelRatio = 1;

function load(f) { eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); }
load('js/core.js');
load('js/interview/providers.js');
load('js/interview/transcript.js');
load('js/interview/questions.js');
load('js/interview/fixtures.js');
load('js/interview/mockscorer.js');
load('js/interview/report.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

(async () => {
  console.log('\n[1] 픽스처');
  {
    const ids = Questions.SET.items.map(q => q.id);
    check('본 면접 6문항 전사 모두 존재', ids.every(id => Fixtures.transcripts[id]));
    check('연습 문항 전사 존재', !!Fixtures.transcripts.p1);
    check('저신뢰 문항이 하나 있음 (인적 검토 경로 검증용)', ids.filter(id => Fixtures.transcripts[id].meanConfidence < 0.6).length === 1);
    check('식별자가 섞여 있음 (마스킹 검증용)', /김민서|연세대학교|네이버/.test(Fixtures.transcripts.q1.text));
    check('단어 배열에 신뢰도·시각 존재', Fixtures.transcripts.q1.words.every(w => typeof w.confidence === 'number' && typeof w.startMs === 'number'));
    check('고정 STT 공급자가 등록됨', Providers.list('stt').some(p => p.id === 'fixture' && p.devOnly && p.external === false));
    check('수동 STT 공급자가 등록됨', Providers.list('stt').some(p => p.id === 'manual' && p.devOnly));
    check('모의 채점기가 등록됨 (devOnly)', Providers.list('scorer').some(p => p.id === 'mock' && p.devOnly && p.external === false));
  }

  console.log('\n[1b] 픽스처 세션 채우기 — 녹화 없이 뒤쪽 화면으로');
  {
    const seeded = Fixtures.seedAnswers(Questions.SET, 1700000000000);
    check('문항 수만큼 답변', seeded.length === Questions.SET.items.length);
    check('미디어 없음이 답변마다 표시', seeded.every(a => a.media.skipped === 'seeded' && a.media.chunks === 0 && a.mediaRef === null));
    check('전사가 픽스처에서 채워짐', seeded.every(a => a.transcript && a.transcript.provider === 'fixture'));
    check('정정 이력은 빈 배열로 시작', seeded.every(a => Array.isArray(a.transcript.corrections) && a.transcript.corrections.length === 0));
    check('행동 지표는 측정 없음(null)', seeded.every(a => a.behavioral.firstSpeechDelayMs === null && a.behavioral.spoke === null));
    check('결정적 (같은 now → 같은 출력)', JSON.stringify(seeded) === JSON.stringify(Fixtures.seedAnswers(Questions.SET, 1700000000000)));
    const sc = await MockScorer.score({ session: { names: Fixtures.names, answers: seeded }, rubric: Questions.RUBRIC, questions: Questions.SET });
    check('채워진 세션이 그대로 채점됨', sc.status === 'scored_uncalibrated' && sc.perQuestion.filter(p => !p.excluded).length === 5);
  }

  console.log('\n[2] 모의 채점기 — 결정성·범위·근거 오프셋');
  {
    const text = Transcript.mask(Fixtures.transcripts.q4.text, { names: Fixtures.names }).text;
    const traits = Questions.SET.items[3].traits;
    const a = MockScorer.scoreAnswer(text, traits);
    const b = MockScorer.scoreAnswer(text, traits);
    check('같은 입력 → 같은 출력', JSON.stringify(a) === JSON.stringify(b));
    check('특성 수 일치', a.traits.length === traits.length);
    check('점수 1~5 정수', a.traits.every(t => Number.isInteger(t.raw) && t.raw >= 1 && t.raw <= 5));
    check('확신 0~1', a.traits.every(t => t.confidence >= 0 && t.confidence <= 1));
    check('근거 오프셋이 원문과 정확히 일치', a.citations.every(c => text.slice(c.startChar, c.endChar) === c.quotedText),
      JSON.stringify(a.citations.map(c => [c.quotedText.slice(0, 20), text.slice(c.startChar, c.endChar).slice(0, 20)])));
    check('근거의 traitId가 채점 특성 안에 있음', a.citations.every(c => traits.includes(c.traitId)));

    const star = MockScorer.scoreAnswer(text, ['structure']).traits[0].raw;
    const vague = MockScorer.scoreAnswer('열심히 했고 잘 됐습니다. 좋은 경험이었습니다.', ['structure']).traits[0].raw;
    check('STAR 표지가 많은 답변이 구조 점수 높음', star > vague, `${star} vs ${vague}`);
    const short = MockScorer.scoreAnswer('네.', ['specificity']);
    check('너무 짧으면 too_short 플래그', short.flags.includes('too_short'));
  }

  console.log('\n[3] 세션 채점 — 실제 채점기와 같은 모양');
  {
    const session = {
      names: Fixtures.names,
      answers: Questions.SET.items.map(q => ({ questionId: q.id, transcript: { raw: Fixtures.transcripts[q.id].text, corrected: null, meanConfidence: Fixtures.transcripts[q.id].meanConfidence, corrections: [] } }))
    };
    const sc = await MockScorer.score({ session, rubric: Questions.RUBRIC, questions: Questions.SET });
    const required = ['status', 'rubricVersion', 'questionSetVersion', 'modelId', 'promptHash', 'scoredAt', 'perQuestion', 'calibrated', 'percentile', 'routedToHuman', 'routeReason'];
    check('Score 필드 전부 존재 (서버 채점기와 동일)', required.every(k => k in sc), required.filter(k => !(k in sc)).join(','));
    check('교정 전이므로 calibrated·percentile null', sc.calibrated === null && sc.percentile === null);
    check('항상 인적 검토', sc.routedToHuman === true);
    check('저신뢰 문항(q6)은 제외', sc.perQuestion.find(p => p.questionId === 'q6').excluded === true && sc.perQuestion.find(p => p.questionId === 'q6').excludeReason === 'low_confidence');
    check('제외가 있으면 routeReason=excluded_answers', sc.routeReason === 'excluded_answers');
    check('채점된 문항은 마스킹됨', sc.perQuestion.filter(p => !p.excluded).every(p => !/김민서|연세대학교|네이버/.test(p.maskedText)));
    check('q1 마스킹 3건 이상 (이름·학교·회사)', sc.perQuestion.find(p => p.questionId === 'q1').maskTotal >= 3);
    check('상태 scored_uncalibrated', sc.status === 'scored_uncalibrated');

    /* 정정본이 있으면 정정본으로 채점 */
    session.answers[0].transcript.corrected = session.answers[0].transcript.raw + ' 추가로 작년에 3건의 실험을 더 돌렸습니다.';
    const sc2 = await MockScorer.score({ session, rubric: Questions.RUBRIC, questions: Questions.SET });
    check('정정본이 있으면 정정본 기준', sc2.perQuestion[0].maskedText.includes('3건의 실험'));
  }

  console.log('\n[4] 일치도 계산');
  {
    const auto = { perQuestion: [
      { questionId: 'q1', excluded: false, traits: [{ traitId: 'specificity', raw: 4 }, { traitId: 'relevance', raw: 3 }] },
      { questionId: 'q2', excluded: true, traits: [] },
      { questionId: 'q3', excluded: false, traits: [{ traitId: 'specificity', raw: 2 }] }
    ] };
    const human = { perQuestion: [
      { questionId: 'q1', traits: [{ traitId: 'specificity', score: 4 }, { traitId: 'relevance', score: 5 }] },
      { questionId: 'q3', traits: [{ traitId: 'specificity', score: 3 }] }
    ] };
    const ag = InterviewReport.agreement(auto, human);
    check('비교 쌍 3개 (제외 문항 제외)', ag.n === 3, JSON.stringify(ag));
    check('정확 일치 1', ag.exact === 1);
    check('±1 이내 2', ag.within1 === 2);
    check('평균 차이 = (0 + (-2) + (-1))/3', Math.abs(ag.meanDiff - (-1)) < 1e-9, String(ag.meanDiff));
    check('사람 점수 없으면 n=0', InterviewReport.agreement(auto, { perQuestion: [] }).n === 0);
  }

  console.log('\n' + '='.repeat(52));
  console.log(`통과 ${pass} / 실패 ${fail}`);
  console.log('='.repeat(52));
  process.exitCode = fail ? 1 : 0;
})();

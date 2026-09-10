/* 영상면접 순수 로직 검증 — 공급자 계약 / 편집거리·정정 상한 / 마스킹 / 보관·파기 / 구간 조립 / 음량 지표 / 문항·루브릭 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ---------- 최소 스텁 (DOM·브라우저 API 없음) ---------- */
global.window = global;
global.location = { search: '' };
global.navigator = { userAgent: 'node', language: 'ko', hardwareConcurrency: 8, platform: 'Win32', mediaDevices: undefined };
global.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 };
global.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 };
global.document = { addEventListener() {}, createElement() { return {}; } };
window.matchMedia = () => ({ matches: false });
window.addEventListener = () => {};
window.innerWidth = 1600; window.innerHeight = 900; window.devicePixelRatio = 1;

function load(f) { eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); }
load('js/core.js');
load('js/interview/providers.js');
load('js/interview/transcript.js');
load('js/interview/questions.js');
load('js/interview/store.js');
load('js/interview/recorder.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

/* ============================================================ */
console.log('\n[1] 공급자 계약');
{
  check('4종 공급자 등록됨', ['tts', 'stt', 'scorer', 'store'].every(k => Providers.list(k).length >= 1));
  check('기본 STT는 외부 전송 없음', Providers.list('stt').find(p => p.id === 'null').external === false);
  check('개발용 STT는 외부 전송·devOnly 표시', (() => {
    const p = Providers.list('stt').find(p => p.id === 'webspeech-dev');
    return p && p.external === true && p.devOnly === true;
  })());
  check('external 미명시 구현은 거부', (() => {
    try { Providers.register('tts', { id: 'x', label: 'x', speak() {}, cancel() {}, available() {} }); return false; }
    catch (e) { return /external/.test(e.message); }
  })());
  check('계약 항목 누락 구현은 거부', (() => {
    try { Providers.register('scorer', { id: 'y', label: 'y', external: false }); return false; }
    catch (e) { return /계약 항목/.test(e.message); }
  })());
  check('id 중복은 거부', (() => {
    try { Providers.register('stt', { id: 'null', label: 'dup', external: false, start() {}, stop() {}, available() {} }); return false; }
    catch (e) { return /중복/.test(e.message); }
  })());

  const sum = Providers.fromQuery({ tts: 'webspeech', stt: 'null', scorer: 'pending', store: 'idb' });
  check('기본 선택 4종 활성', sum.every(p => p.id !== null));
  check('기본 구성은 외부 전송 없음', sum.every(p => p.external === false), JSON.stringify(sum));

  global.location = { search: '?stt=webspeech-dev' };
  const sum2 = Providers.fromQuery({ tts: 'webspeech', stt: 'null', scorer: 'pending', store: 'idb' });
  check('쿼리로 STT 교체', sum2.find(p => p.kind === 'stt').id === 'webspeech-dev');
  check('교체하면 외부 전송이 요약에 드러남', sum2.find(p => p.kind === 'stt').external === true);
  global.location = { search: '?stt=없는것' };
  const sum3 = Providers.fromQuery({ tts: 'webspeech', stt: 'null', scorer: 'pending', store: 'idb' });
  check('없는 id면 기본값으로', sum3.find(p => p.kind === 'stt').id === 'null');
  global.location = { search: '' };
  Providers.fromQuery({ tts: 'webspeech', stt: 'null', scorer: 'pending', store: 'idb' });
}

/* ============================================================ */
console.log('\n[2] 보류 채점기');
{
  let out = null;
  Providers.get('scorer').score({}).then(r => { out = r; });
  setTimeout(() => {}, 0);
}

/* ============================================================ */
console.log('\n[3] 편집거리');
{
  const d = Transcript.editDistance;
  check('동일 문자열 0', d('안녕', '안녕') === 0);
  check('빈 문자열', d('', '가나다') === 3 && d('가나다', '') === 3);
  check('치환 1', d('가나다', '가라다') === 1);
  check('삽입 1', d('가나다', '가나다라') === 1);
  check('삭제 1', d('가나다', '가다') === 1);
  check('kitten→sitting = 3', d('kitten', 'sitting') === 3);
  check('대칭', d('프로젝트를 이끌었습니다', '프로젝트를 이끌었어요') === d('프로젝트를 이끌었어요', '프로젝트를 이끌었습니다'));
}

/* ============================================================ */
console.log('\n[4] 정정 상한 — 오인식 정정은 허용, 답변 고쳐쓰기는 차단');
{
  const raw = '저는 지난해 팀 프로젝트에서 일정 관리를 맡아 세 번의 지연 위기를 조율했습니다. 특히 외주 업체와의 소통 창구를 일원화해 회신 시간을 이틀에서 반나절로 줄였습니다.';
  const cap = Transcript.editCap(raw);
  check('상한 = max(20, 15%)', cap === Math.max(20, Math.round(raw.length * 0.15)), String(cap));

  const small = raw.replace('외주 업체', '외주 없체');   // 오인식 흉내
  const r1 = Transcript.evaluateCorrection(small, raw, []);
  check('작은 오인식 정정은 승인', r1.accepted === true, r1.reason);
  check('승인 기록에 편집거리·상한', r1.record.editDistance > 0 && r1.record.cap === cap);

  const rewrite = '저는 리더십이 뛰어나고 소통을 잘하며 어떤 문제든 해결할 수 있는 사람입니다. 항상 최선을 다하고 팀을 위해 헌신하겠습니다.';
  const r2 = Transcript.evaluateCorrection(raw, rewrite, []);
  check('답변 전면 고쳐쓰기는 거부', r2.accepted === false && r2.record.reason === 'over_cap', r2.reason);
  check('거부되어도 기록은 남음', r2.record.attempt === 1 && r2.record.accepted === false);

  const r3 = Transcript.evaluateCorrection(raw, raw, []);
  check('변경 없음은 거부', r3.accepted === false && r3.record.reason === 'unchanged');
  const r4 = Transcript.evaluateCorrection(raw, '   ', []);
  check('빈 내용은 거부', r4.accepted === false && r4.record.reason === 'empty');

  const hist = [r1.record, r1.record, r1.record];
  const r5 = Transcript.evaluateCorrection(small, raw, hist);
  check('3회 초과 시 거부', r5.accepted === false && r5.record.reason === 'max_attempts', r5.reason);

  const shortRaw = '네 맞습니다';
  check('짧은 답변도 최소 20자 허용', Transcript.editCap(shortRaw) === 20);
}

/* ============================================================ */
console.log('\n[5] 식별자 마스킹');
{
  const t = '저는 홍길동이고 서울대학교를 졸업해 삼성전자에서 2년, (주)카카오에서 1년 일했습니다. 연락처는 010-1234-5678, 메일은 hong@example.com 입니다. 부산에서 자랐습니다.';
  const m = Transcript.mask(t, { names: ['홍길동'] });
  check('이름 마스킹', !m.text.includes('홍길동') && m.counts['[이름]'] === 1);
  check('학교 마스킹', !m.text.includes('서울대학교') && m.text.includes('[학교]'));
  check('회사 마스킹 (접미사·(주))', !m.text.includes('삼성전자') && !m.text.includes('카카오'), m.text);
  check('전화 마스킹', !m.text.includes('1234-5678'));
  check('이메일 마스킹', !m.text.includes('example.com'));
  check('지역 마스킹', !m.text.includes('부산'));
  check('마스킹 건수 집계', m.total >= 6, String(m.total));
  check('이름이 없으면 이름 마스킹 안 함', Transcript.mask('오늘 회의에서 발표했습니다').total === 0);
  check('원문은 그대로 (불변)', t.includes('홍길동'));
}

/* ============================================================ */
console.log('\n[6] 보관·파기');
{
  const s = { startedAt: '2026-09-10T00:00:00.000Z', hiringClosedAt: null };
  const plan = Retention.plan(s);
  check('채용 종료 전엔 임시 계산', plan.basis === 'session_start_provisional');
  check('영상 30일', plan.media.slice(0, 10) === '2026-10-10', plan.media);
  check('전사 1년', plan.transcript.slice(0, 10) === '2027-09-10', plan.transcript);
  check('점수 3년', plan.score.slice(0, 4) === '2029');

  const s2 = { startedAt: '2026-09-10T00:00:00.000Z', hiringClosedAt: '2026-12-01T00:00:00.000Z' };
  check('채용 종료 후엔 종료일 기준', Retention.plan(s2).basis === 'hiring_closed' && Retention.plan(s2).media.slice(0, 10) === '2026-12-31');

  const sess = { retention: plan };
  const d1 = Retention.due(sess, '2026-10-09T23:59:00Z');
  check('만료 전엔 파기 대상 아님', !d1.media && !d1.transcript && !d1.score);
  const d2 = Retention.due(sess, '2026-10-10T00:00:00Z');
  check('영상만 먼저 만료', d2.media && !d2.transcript && !d2.score);
  const d3 = Retention.due(sess, '2030-01-01T00:00:00Z');
  check('전부 만료', d3.media && d3.transcript && d3.score);
  check('retention 없으면 아무것도 파기하지 않음', !Retention.due({}, '2030-01-01').media);
}

/* ============================================================ */
console.log('\n[7] 구간 조립 — 순서 뒤섞임·누락');
{
  const o1 = Chunks.order([{ seq: 2 }, { seq: 0 }, { seq: 1 }]);
  check('seq로 정렬', o1.sorted.map(c => c.seq).join(',') === '0,1,2');
  check('빠짐 없으면 complete', o1.complete && o1.gaps.length === 0);
  const o2 = Chunks.order([{ seq: 0 }, { seq: 1 }, { seq: 3 }]);
  check('중간 누락 감지', !o2.complete && o2.gaps.join(',') === '2', JSON.stringify(o2.gaps));
  const o3 = Chunks.order([]);
  check('빈 입력 안전', o3.complete && o3.expected === 0);
  const o4 = Chunks.order([{ seq: 4 }]);
  check('앞부분 통째 누락 감지', !o4.complete && o4.gaps.join(',') === '0,1,2,3');
}

/* ============================================================ */
console.log('\n[8] 음량 지표 — 기록만, 점수 미반영');
{
  const M = Recorder.Meter;
  const silent = new Uint8Array(1024).fill(128);
  check('무음 RMS ≈ 0', M.rms(silent) < 0.001);
  const loud = new Uint8Array(1024); for (let i = 0; i < 1024; i++) loud[i] = i % 2 ? 200 : 56;
  check('큰 소리 RMS > 임계', M.rms(loud) > Recorder.CONFIG.speechThreshold);

  const frames = [];
  for (let t = 0; t < 100; t++) frames.push({ t: t * 50, rms: t >= 20 && t < 60 ? 0.2 : 0.01 });
  const m = M.speechMetrics(frames, 0.045, 50);
  check('첫 발화 지연 = 1000ms', m.firstSpeechDelayMs === 1000, String(m.firstSpeechDelayMs));
  check('발화 길이 = 2000ms', m.speechDurationMs === 2000, String(m.speechDurationMs));
  check('침묵 비율 0.6', m.silenceRatio === 0.6, String(m.silenceRatio));
  check('발화 감지', m.spoke === true);
  const none = M.speechMetrics(frames.map(f => ({ t: f.t, rms: 0.01 })));
  check('무발화면 first null·spoke false', none.firstSpeechDelayMs === null && none.spoke === false);
}

/* ============================================================ */
console.log('\n[9] 문항 세트 · 루브릭');
{
  const problems = Questions.validate();
  check('문항–루브릭 정합', problems.length === 0, problems.join('; '));
  check('문항 6개', Questions.SET.items.length === 6);
  check('유형 6종 모두 존재', ['intro', 'motivation', 'strength', 'behavioral', 'situational', 'probe']
    .every(t => Questions.SET.items.some(q => q.type === t)));
  check('꼬리질문이 행동 문항을 참조', Questions.SET.items.find(q => q.type === 'probe').probeOf === 'q4');
  check('루브릭에 열정·자신감·인상 없음', Object.values(Questions.RUBRIC.traits).every(t => !/열정|자신감|인상|문화/.test(t.label)));
  check('버전 문자열 존재', /^qs-/.test(Questions.SET.version) && /^rubric-/.test(Questions.RUBRIC.version));
  const fp1 = Questions.fingerprint();
  const saved = Questions.RUBRIC.traits.specificity.label;
  Questions.RUBRIC.traits.specificity.label = '구체성!';
  const fp2 = Questions.fingerprint();
  Questions.RUBRIC.traits.specificity.label = saved;
  check('내용이 바뀌면 지문이 바뀜', fp1 !== fp2);
  check('되돌리면 지문 복원', Questions.fingerprint() === fp1);
}

/* ============================================================ */
console.log('\n[10] 발화 지표 계산');
{
  const m = Transcript.speechMetrics([{}, {}, {}, {}, {}, {}, {}, {}, {}, {}], 30000);
  check('10단어/30초 = 20wpm', m.wordsPerMin === 20 && m.wordCount === 10, JSON.stringify(m));
  check('0ms면 wpm null', Transcript.speechMetrics([{}], 0).wordsPerMin === null);
}

setTimeout(() => {
  Providers.get('scorer').score({}).then(r => {
    check('보류 채점기는 pending + 인적검토 라우팅', r.status === 'pending' && r.routedToHuman === true);
    check('보류 채점기는 백분위 null', r.percentile === null);
    console.log('\n' + '='.repeat(52));
    console.log(`통과 ${pass} / 실패 ${fail}`);
    console.log('='.repeat(52));
    process.exitCode = fail ? 1 : 0;
  });
}, 10);

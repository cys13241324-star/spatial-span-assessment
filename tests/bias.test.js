/* 편향 회귀 — 이름·학교·회사·지역만 다른 답변 쌍 (설계도 R-03)
   불변 1: 마스킹 후 두 텍스트가 같아야 한다
   불변 2: 채점기(지금은 모의)는 같은 점수·같은 근거를 내야 한다
   실제 채점기가 붙으면 같은 쌍을 server/score-claude.mjs --dry-run 으로 돌려 요청 본문이 같은지 본다 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

global.window = global;
global.location = { search: '' };
global.navigator = { userAgent: 'node', language: 'ko', hardwareConcurrency: 8, platform: 'Win32' };
global.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 };
global.performance = { now: () => Date.now() };
global.document = { addEventListener() {}, createElement() { return {}; } };
window.matchMedia = () => ({ matches: false });
window.addEventListener = () => {};
window.innerWidth = 1600; window.innerHeight = 900; window.devicePixelRatio = 1;

function load(f) { eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); }
load('js/core.js');
load('js/interview/providers.js');
load('js/interview/transcript.js');
load('js/interview/questions.js');
load('js/interview/mockscorer.js');

const pairs = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/bias-pairs.json'), 'utf8')).pairs;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n[편향 회귀] 쌍 ' + pairs.length + '개');
const TRAITS = ['specificity', 'relevance', 'structure', 'problemSolving', 'judgment'];

for (const p of pairs) {
  const ma = Transcript.mask(p.a, { names: p.names });
  const mb = Transcript.mask(p.b, { names: p.names });
  check(`${p.id}: 마스킹 후 동일`, ma.text === mb.text, `\n     A: ${ma.text}\n     B: ${mb.text}`);
  check(`${p.id}: 마스킹이 실제로 일어남`, ma.total > 0 && mb.total > 0, `${ma.total}/${mb.total}`);

  const sa = MockScorer.scoreAnswer(ma.text, TRAITS);
  const sb = MockScorer.scoreAnswer(mb.text, TRAITS);
  const scoresEqual = JSON.stringify(sa.traits.map(t => t.raw)) === JSON.stringify(sb.traits.map(t => t.raw));
  check(`${p.id}: 점수 동일`, scoresEqual, JSON.stringify([sa.traits.map(t => t.raw), sb.traits.map(t => t.raw)]));
  const citeEqual = JSON.stringify(sa.citations) === JSON.stringify(sb.citations);
  check(`${p.id}: 근거 인용 동일`, citeEqual);
}

/* 마스킹 없이 채점하면 달라지는가 — 마스킹이 실제로 방어선인지 확인 */
{
  const p = pairs.find(x => x.id === 'combined');
  const ra = MockScorer.scoreAnswer(p.a, TRAITS);
  const rb = MockScorer.scoreAnswer(p.b, TRAITS);
  const rawDiffer = JSON.stringify(ra.citations) !== JSON.stringify(rb.citations);
  console.log('     (참고) 마스킹 없이 채점 시 근거 인용 ' + (rawDiffer ? '달라짐 — 마스킹이 방어선' : '동일'));
  check('마스킹은 점수와 무관한 정보만 지운다 (마스킹 전후 점수 동일)',
    JSON.stringify(ra.traits.map(t => t.raw)) === JSON.stringify(MockScorer.scoreAnswer(Transcript.mask(p.a, { names: p.names }).text, TRAITS).traits.map(t => t.raw)));
}

console.log('\n' + '='.repeat(52));
console.log(`통과 ${pass} / 실패 ${fail}`);
console.log('='.repeat(52));
process.exitCode = fail ? 1 : 0;

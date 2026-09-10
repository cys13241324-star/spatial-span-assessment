/* 영상면접 배선 대조 — app.js/report.js가 찾는 id, 로드 순서, CSS 클래스 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('interview.html');
const app = read('js/interview/app.js');
const rep = read('js/interview/report.js');
const css = read('css/app.css') + '\n' + read('css/interview.css');

let bad = 0;
const ok = m => console.log('  OK    ' + m);
const err = m => { console.log('  FAIL  ' + m); bad++; };

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
/* 게으른 매치가 파일 앞쪽의 다른 '['부터 삼키므로, 마커에서 거꾸로 여는 괄호를 찾는다 */
const marker = '].forEach(function (id) { els[id]';
const endIdx = app.indexOf(marker);
const startIdx = endIdx >= 0 ? app.lastIndexOf('[', endIdx) : -1;
const cached = endIdx >= 0 ? [...app.slice(startIdx, endIdx).matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
const direct = [...app.matchAll(/getElementById\('([^']+)'\)/g)].map(x => x[1])
  .concat([...rep.matchAll(/getElementById\('([^']+)'\)/g)].map(x => x[1]));
const want = [...new Set(cached.concat(direct))];
const missing = want.filter(id => !htmlIds.has(id));
console.log(`interview.html id ${htmlIds.size}개 / 코드가 찾는 id ${want.length}개`);
missing.length ? err('없는 id: ' + missing.join(', ')) : ok('모든 id 존재');

const screens = new Set([...htmlIds].filter(id => id.startsWith('screen-')));
const shows = [...new Set([...app.matchAll(/App\.show\('([^']+)'\)/g)].map(x => x[1])
  .concat([...rep.matchAll(/app\.show\('([^']+)'\)/g)].map(x => x[1])))];
const gotos = [...new Set([...html.matchAll(/data-goto="([^"]+)"/g)].map(x => x[1])
  .concat([...rep.matchAll(/data-goto="([^"]+)"/g)].map(x => x[1])))];
const badShow = shows.filter(s => !screens.has(s));
badShow.length ? err('show 대상 없음: ' + badShow.join(', ')) : ok(`show 대상 ${shows.length}개 존재`);
const badGoto = gotos.filter(g => !screens.has(g));
badGoto.length ? err('data-goto 대상 없음: ' + badGoto.join(', ')) : ok('data-goto 대상 존재');
const reach = new Set(shows.concat(gotos)); reach.add('screen-consent');
const orphan = [...screens].filter(s => !reach.has(s));
orphan.length ? err('도달 불가 화면: ' + orphan.join(', ')) : ok(`화면 ${screens.size}개 모두 도달 가능`);

const order = [...html.matchAll(/src="(js\/[^"]+)"/g)].map(x => x[1]);
const idx = n => order.indexOf(n);
(idx('js/core.js') === 0) ? ok('core.js 첫 로드') : err('core.js가 첫 로드가 아님');
(idx('js/scoring.js') >= 0 && idx('js/scoring.js') < idx('js/interview/app.js')) ? ok('scoring.js가 app.js보다 먼저') : err('scoring.js 누락/순서 오류 — integritySummary가 실패한다');
(idx('js/interview/providers.js') < idx('js/interview/store.js')) ? ok('providers.js가 store.js보다 먼저 (register 필요)') : err('providers/store 순서 오류');
(order[order.length - 1] === 'js/interview/app.js') ? ok('app.js 마지막') : err('app.js가 마지막이 아님');

/* 사용하는 전역이 실제로 로드되는지 */
const globals = { Core: 'js/core.js', Scoring: 'js/scoring.js', Providers: 'js/interview/providers.js',
  Transcript: 'js/interview/transcript.js', Questions: 'js/interview/questions.js', Retention: 'js/interview/store.js',
  Chunks: 'js/interview/store.js', Recorder: 'js/interview/recorder.js', InterviewReport: 'js/interview/report.js' };
for (const [g, f] of Object.entries(globals)) {
  const used = new RegExp('\b' + g + '\.').test(app + rep);
  if (used && idx(f) < 0) err(`${g} 사용하는데 ${f} 미로드`);
}
ok('전역 참조 모두 로드됨');

/* CSS 클래스 */
const used = new Set();
for (const src of [html, app, rep]) for (const mm of src.matchAll(/class="([A-Za-z0-9 _-]+)"/g)) mm[1].split(/\s+/).forEach(c => c && used.add(c));
['speaking', 'nb-run', 'prep', 'ok', 'err', 'wait', 'external', 'flag', 'active', 'live'].forEach(c => used.add(c));
const esc = c => c.replace(/-/g, '\\-');
const miss = [...used].filter(c => !new RegExp('\\.' + esc(c) + '[\\s,:.{>\\[]').test(css));
miss.length ? err('CSS에 없는 클래스: ' + miss.join(', ')) : ok(`클래스 ${used.size}개 모두 CSS에 존재`);

/* 정책 문구와 코드 일치 */
const pol = /maxEditRatio:\s*0\.15/.test(read('js/interview/transcript.js')) && /maxAttempts:\s*3/.test(read('js/interview/transcript.js'));
(pol && /3회/.test(html) && /15%/.test(html)) ? ok('정정 정책 문구가 코드와 일치 (3회·15%)') : err('정정 정책 문구와 코드 불일치');
/* 고지의 "분석하지 않는 것"이 실제 코드에도 없는지 */
(!/face|emotion|expression|FER/i.test(app + rep + read('js/interview/recorder.js'))) ? ok('표정·감정 분석 코드 없음') : err('표정/감정 분석 흔적 발견');

console.log('\n' + (bad ? `문제 ${bad}건` : '영상면접 배선 대조 통과'));
process.exitCode = bad ? 1 : 0;

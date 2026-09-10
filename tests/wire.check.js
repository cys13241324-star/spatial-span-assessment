/* 셸 배선 정적 대조 — DOM id / 화면 전환 / 로드 순서 / CSS 클래스 / 계약 */
const fs = require('fs');
const path = require('path');
const ROOT = require('path').join(__dirname, '..');

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('index.html');
const app  = read('js/app.js');
const rep  = read('js/report.js');
const nb   = read('js/task-shape-nback.js');
const span = read('js/task-spatial-span.js');
const css  = read('css/app.css');

let bad = 0;
const ok  = m => console.log('  OK    ' + m);
const err = m => { console.log('  FAIL  ' + m); bad++; };
const note = m => console.log('  참고  ' + m);

/* ---------- 1. 코드가 찾는 id가 index.html에 있는지 ---------- */
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const m = /\[\s*([\s\S]*?)\]\.forEach\(function \(id\)/.exec(app);
const cached = m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
const direct = [...app.matchAll(/getElementById\('([^']+)'\)/g)].map(x => x[1])
  .concat([...rep.matchAll(/getElementById\('([^']+)'\)/g)].map(x => x[1]));
const want = [...new Set(cached.concat(direct))];

console.log(`index.html id ${htmlIds.size}개 / 코드가 찾는 id ${want.length}개`);
const missing = want.filter(id => !htmlIds.has(id));
missing.length ? err('index.html에 없는 id: ' + missing.join(', '))
               : ok('모든 id가 index.html에 존재');

/* ---------- 2. 옛 id가 남아 있지 않은지 ---------- */
const retired = ['briefTitle', 'briefSteps'];
const stale = retired.filter(id => htmlIds.has(id) || want.includes(id));
stale.length ? err('제거했어야 할 옛 id가 남아 있음: ' + stale.join(', '))
             : ok('옛 설명 화면 id 정리됨');

/* ---------- 3. 화면 전환 대상 ---------- */
const screens = new Set([...htmlIds].filter(id => id.startsWith('screen-')));
const shows = [...new Set(
  [...app.matchAll(/App\.show\('([^']+)'\)/g)].map(x => x[1])
  .concat([...rep.matchAll(/App\.show\('([^']+)'\)/g)].map(x => x[1]))
)];
const gotos = [...new Set(
  [...html.matchAll(/data-goto="([^"]+)"/g)].map(x => x[1])
  .concat([...rep.matchAll(/data-goto="([^"]+)"/g)].map(x => x[1]))
)];

const badShow = shows.filter(s => !screens.has(s));
badShow.length ? err('App.show 대상 없음: ' + badShow.join(', '))
               : ok(`App.show 대상 ${shows.length}개 모두 존재`);

const badGoto = gotos.filter(g => !screens.has(g));
badGoto.length ? err('data-goto 대상 없음: ' + badGoto.join(', '))
               : ok('data-goto 대상 모두 존재: ' + gotos.join(', '));

/* 모든 화면에 도달 경로가 있는지 — 고아 화면은 죽은 코드다 */
const reachable = new Set(shows.concat(gotos));
reachable.add('screen-pick');                      // 초기 active
const orphan = [...screens].filter(s => !reachable.has(s));
orphan.length ? err('도달 경로가 없는 화면: ' + orphan.join(', '))
              : ok(`화면 ${screens.size}개 모두 도달 가능`);

/* ---------- 4. 스크립트 로드 순서 ---------- */
const order = [...html.matchAll(/src="(js\/[^"]+)"/g)].map(x => x[1]);
console.log('로드 순서: ' + order.join(' → '));
const iT = order.indexOf('js/tasks.js');
const iS = order.indexOf('js/scoring.js');
const iA = order.indexOf('js/task-spatial-span.js');
const iB = order.indexOf('js/task-shape-nback.js');

(iT >= 0 && iT < iA && iT < iB) ? ok('tasks.js가 과제 파일보다 먼저')
  : err('tasks.js 로드 순서 오류 — register()가 실패한다');
(iS < iA && iS < iB) ? ok('scoring.js가 과제 파일보다 먼저')
  : err('scoring.js 로드 순서 오류 — score()가 실패한다');
(order[order.length - 1] === 'js/app.js') ? ok('app.js가 마지막')
  : err('app.js가 마지막이 아님');

/* ---------- 5. 과제가 자기 무대에 만드는 id를 스스로 찾는지 ---------- */
for (const [name, src] of [['N-back', nb], ['Corsi', span]]) {
  const needs = [...new Set([...src.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)].map(x => x[1]))];
  const makes = new Set([...src.matchAll(/id="([^"]+)"/g)].map(x => x[1]));
  const miss = needs.filter(id => !makes.has(id));
  miss.length ? err(`${name}이 만들지 않는 id를 찾음: ` + miss.join(', '))
              : ok(`${name} 자체 id ${needs.length}개 정합`);
}

/* ---------- 6. 레지스트리 계약 ---------- */
const required = /var REQUIRED = \[([\s\S]*?)\]/.exec(read('js/tasks.js'));
const reqKeys = required ? [...required[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
for (const [name, src] of [['N-back', nb], ['Corsi', span]]) {
  const declared = reqKeys.filter(k => new RegExp('(^|[\\s{,])' + k + ':').test(src));
  const lack = reqKeys.filter(k => !declared.includes(k));
  lack.length ? err(`${name} 서술자에 없는 필수 항목: ` + lack.join(', '))
              : ok(`${name} 서술자가 필수 ${reqKeys.length}항목 모두 제공`);
  if (/(^|[\s{,])brief:/.test(src)) err(`${name}에 옛 brief가 남아 있음`);
}

/* ---------- 7. 마크업이 쓰는 클래스가 CSS에 있는지 ---------- */
const used = new Set();
for (const src of [html, nb, span, app, rep]) {
  for (const mm of src.matchAll(/class="([A-Za-z0-9 _-]+)"/g)) {
    mm[1].split(/\s+/).forEach(c => { if (c) used.add(c); });
  }
}
/* 코드가 classList로만 붙이는 것도 포함 */
['nb-run', 'nb-timer-idle', 'nb-timer-locked', 'nb-flip', 'nb-hit',
 'lit', 'tapped', 'input-open', 'filled', 'on', 'live', 'flag', 'ok', 'err',
 'blocked', 'info', 'wide', 'primary', 'ghost', 'small', 'warn', 'active'].forEach(c => used.add(c));

const esc = c => c.replace(/-/g, '\\-');
const cssMissing = [...used].filter(c => !new RegExp('\\.' + esc(c) + '[\\s,:.{>\\[]').test(css));
cssMissing.length ? err('CSS에 없는 클래스: ' + cssMissing.join(', '))
                  : ok(`마크업 클래스 ${used.size}개 모두 CSS에 존재`);

/* ---------- 8. reduced-motion이 정보성 모션까지 끄지 않는지 ---------- */
const rmIdx = css.indexOf('@media (prefers-reduced-motion: reduce)');
if (rmIdx < 0) {
  err('prefers-reduced-motion 블록 없음');
} else {
  const body = css.slice(rmIdx);
  const killsLiveTimer = /\.nb-timer-fill\s*\{[^}]*animation:\s*none/.test(body);
  const onlyDemo = /\.wt-timerdemo \.nb-timer-fill\s*\{[^}]*animation:\s*none/.test(body);
  (killsLiveTimer && !onlyDemo)
    ? err('reduced-motion이 본 검사 타이머까지 정지 — 응시자가 마감을 알 수 없다')
    : ok('reduced-motion에서 본 검사 타이머는 유지 (시연만 정지)');
}

/* ---------- 9. 타이머 애니메이션 배선 ---------- */
(/@keyframes nbfill/.test(css)) ? ok('nbfill 키프레임 정의됨')
  : err('nbfill 키프레임 없음 — 막대가 채워지지 않는다');
(/animationDuration/.test(nb)) ? ok('타이머 길이를 코드가 주입')
  : err('타이머 길이 주입 없음');

console.log('\n' + (bad ? `문제 ${bad}건` : '배선 대조 통과'));
process.exitCode = bad ? 1 : 0;

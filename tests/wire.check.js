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

/* ---------- 10. 가이드 레이아웃 안정성 ---------- */
(/\.wt-demo\s*\{[^}]*height:\s*\d+px/.test(css))
  ? ok('설명 예시 영역 높이 고정 — 다음 버튼이 움직이지 않는다')
  : err('.wt-demo 높이가 고정되지 않음 — 스텝마다 버튼이 위아래로 튄다');
(/\.wt-body\s*\{[^}]*min-height/.test(css))
  ? ok('설명 본문 최소 높이 확보')
  : err('.wt-body min-height 없음 — 글 길이에 따라 버튼이 움직인다');
(/\.wt-slot\s*\{[^}]*min-height/.test(css))
  ? ok('마지막 안내문 자리 예약됨')
  : err('.wt-slot min-height 없음 — 마지막 스텝에서 버튼이 밀린다');
(!/els\.wtDemo\.hidden/.test(app))
  ? ok('예시 영역을 숨기지 않음 (자리 유지)')
  : err('예시 영역을 hidden 처리 — 버튼 위치가 흔들린다');

/* ---------- 11. 정오 노출 정책 ---------- */
for (const [name, src] of [['N-back', nb], ['Corsi', span]]) {
  (/kind: 'logged'/.test(src)) ? ok(name + '이 응답/무응답만 방출')
    : err(name + '에 logged 상태가 없음');
  (!/kind: 'feedback'/.test(src)) ? ok(name + '에 정오 피드백 방출 없음')
    : err(name + '이 아직 응시 중 정오를 방출한다');
}
(/case 'logged'/.test(app)) ? ok('셸이 logged 상태를 처리')
  : err('셸이 logged 상태를 처리하지 않음 — 화면에 아무것도 안 뜬다');
(/\.feedback\.muted/.test(css)) ? ok('무응답 표시 스타일 존재')
  : err('.feedback.muted 없음');
/* 리포트에서는 반대로 정오가 나와야 한다 */
(/<th>판정<\/th>/.test(nb)) ? ok('리포트 원시 로그에 판정 열 있음')
  : err('리포트에 판정 열이 없음 — 이의제기 근거가 남지 않는다');

/* ---------- 12. 과제 라벨 ---------- */
(/label: '[^']*\(현행\)'/.test(nb)) ? ok('N-back 라벨에 (현행)')
  : err('N-back 라벨에 (현행) 표시 없음');
(/label: '[^']*\(고전\)'/.test(span)) ? ok('Corsi 라벨에 (고전)')
  : err('Corsi 라벨에 (고전) 표시 없음');

/* ---------- 13. 도형 수 ---------- */
(/var SHAPE_COUNT = SHAPES\.length/.test(nb)) ? ok('도형 수가 상수로 일반화됨')
  : err('도형 수가 하드코딩되어 있음');
(!/rng\.int\(3\)/.test(nb)) ? ok('rng.int(3) 하드코딩 없음')
  : err('rng.int(3)이 남아 있음 — 도형 5종이 반영되지 않는다');

console.log('\n' + (bad ? `문제 ${bad}건` : '배선 대조 통과'));
process.exitCode = bad ? 1 : 0;

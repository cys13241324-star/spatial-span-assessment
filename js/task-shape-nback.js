/* ============================================================
   task-shape-nback.js — 도형 순서 기억하기 (N-back)

   실제 역검에서 쓰이는 형태. 앞서 구현한 Corsi span과 다른 과제다.
   Corsi는 용량(span)을, 이쪽은 작업기억 갱신·감시(updating/monitoring)를 잰다.

   절차 (공개 자료 2건 대조)
     · 중앙 카드 더미에 도형이 한 장씩 갱신. 도형 5종, 동일 색상
     · 1라운드 2-back — 3번째 도형부터 판단
         2번째 전과 일치 → ←        불일치 → Space
     · 2라운드 2&3-back — 4번째 도형부터 판단
         2번째 전 일치 → ←   3번째 전 일치 → →   둘 다 아님 → Space
     · 도형당 1.5초 노출 후 갱신, 판단은 공백까지 1.8초 허용

   채점: 조건별 d′ (신호탐지이론). 정답률 단독으로는 민감도와 반응편향이
   섞여, 아무 때나 화살표를 누르는 응시자를 걸러내지 못한다.
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 도형 5종 ----------
     참고 자료의 원 검사는 3종이었다. 5종으로 늘리면 한 장이 담는 정보량이
     늘어 기억 부하가 올라가고, 우연히 앞 카드와 겹칠 확률이 낮아져
     비표적 자극을 만들 여지도 넓어진다. 앞 3개의 인덱스는 그대로 두었다 —
     설명 화면의 예시가 이 인덱스를 참조하기 때문이다. */
  var SHAPES = [
    { id: 0, name: '별',    svg: '<svg viewBox="0 0 100 100"><polygon points="50,6 61,38 95,38 67,58 78,92 50,71 22,92 33,58 5,38 39,38"/></svg>' },
    { id: 1, name: '반원',  svg: '<svg viewBox="0 0 100 100"><path d="M8 72a42 42 0 0 1 84 0z"/></svg>' },
    { id: 2, name: '마름모', svg: '<svg viewBox="0 0 100 100"><polygon points="50,5 90,50 50,95 10,50"/></svg>' },
    { id: 3, name: '원',    svg: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="43"/></svg>' },
    { id: 4, name: '삼각형', svg: '<svg viewBox="0 0 100 100"><polygon points="50,8 92,86 8,86"/></svg>' }
  ];

  var SHAPE_COUNT = SHAPES.length;

  var KEY_LABEL = { two: '←', three: '→', none: 'Space' };

  var CONFIG = {
    taskId: 'shape-nback',

    /* ---- 타이밍 ----
       노출 시간과 응답 허용 창을 분리해 둔다. 도형은 stimulusMs에 넘어가지만
       판단은 그 뒤 공백 구간까지 받는다. 둘을 묶어 두면 노출을 줄이는 순간
       응답 시간도 같이 깎여, 작업기억이 아닌 손 속도를 재게 된다.
       실제 응답 허용 = stimulusMs + isiMs (= responseWindowMs) */
    stimulusMs: 1500,      // 도형 노출 — 이 시점에 다음 도형으로 넘어간다
    isiMs: 300,            // 갱신 사이 공백 (이 구간에도 응답 가능)
    preRoundMs: 1200,
    postTrialFeedbackMs: 700,   // 연습에서만 사용

    /* 노출이 1.5초로 짧아진 만큼 같은 응시 시간에 더 많은 자극을 넣는다.
       d′의 표준오차는 시행 수에 직접 좌우되므로, 조건별 표적 수를 늘리는 것이
       측정 정밀도에 그대로 반영된다. */
    rounds: [
      { round: 1, nLevels: [2], count: 36, targetRates: { two: 0.32 } },
      { round: 2, nLevels: [2, 3], count: 44, targetRates: { two: 0.20, three: 0.20 } }
    ],
    practice: { round: 1, nLevels: [2], count: 12, targetRates: { two: 0.33 } },

    maxGenAttempts: 40     // 표적 비율이 크게 어긋나면 재생성
  };

  CONFIG.responseWindowMs = CONFIG.stimulusMs + CONFIG.isiMs;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ============================================================
     자극열 생성

     2&3-back 라운드에서 현재 도형이 2번째 전과 3번째 전에 동시에 일치하면
     정답이 두 개가 되어 문항이 무효다. 생성 단계에서 이 경우를 배제한다.
     스케줄대로 표적을 놓을 수 없는 자리는 비표적으로 낮추고, 실제로 놓인
     라벨을 기록한다 — 채점은 스케줄이 아니라 이 기록을 따르므로 항상 정확하다.
     ============================================================ */
  function pickShape(want, back2, back3, dual, rng) {
    var all = [];
    for (var a0 = 0; a0 < SHAPE_COUNT; a0++) all.push(a0);

    if (!dual) {
      if (want === 'two') return { shape: back2, label: 'two' };
      var others = all.filter(function (s) { return s !== back2; });
      return { shape: others[rng.int(others.length)], label: 'none' };
    }

    /* 2&3-back: back2 === back3 이면 표적을 놓는 순간 중복 정답이 된다 */
    var ambiguous = (back2 === back3);

    if (want === 'two' && !ambiguous) return { shape: back2, label: 'two' };
    if (want === 'three' && !ambiguous) return { shape: back3, label: 'three' };

    var free = all.filter(function (s) { return s !== back2 && s !== back3; });
    return { shape: free[rng.int(free.length)], label: 'none' };
  }

  function buildOnce(spec, rng) {
    var nMax = Math.max.apply(null, spec.nLevels);
    var dual = spec.nLevels.length > 1;
    var seq = [], labels = [];

    for (var i = 0; i < nMax; i++) { seq.push(rng.int(SHAPE_COUNT)); labels.push(null); }

    var judged = spec.count - nMax;
    var schedule = [];
    Object.keys(spec.targetRates).forEach(function (k) {
      var n = Math.round(judged * spec.targetRates[k]);
      for (var j = 0; j < n; j++) schedule.push(k);
    });
    while (schedule.length < judged) schedule.push('none');
    schedule = rng.sample(schedule, schedule.length);   // 셔플

    for (var p = nMax; p < spec.count; p++) {
      var got = pickShape(schedule[p - nMax], seq[p - 2], dual ? seq[p - 3] : null, dual, rng);
      seq.push(got.shape);
      labels.push(got.label);
    }

    return { seq: seq, labels: labels, nMax: nMax, dual: dual };
  }

  function buildSequence(spec, rng) {
    var want = {};
    var nMax = Math.max.apply(null, spec.nLevels);
    var judged = spec.count - nMax;
    Object.keys(spec.targetRates).forEach(function (k) {
      want[k] = Math.round(judged * spec.targetRates[k]);
    });

    var best = null, bestGap = Infinity;

    for (var a = 0; a < CONFIG.maxGenAttempts; a++) {
      var cand = buildOnce(spec, rng);
      var gap = 0;
      Object.keys(want).forEach(function (k) {
        var got = cand.labels.filter(function (l) { return l === k; }).length;
        gap += Math.abs(got - want[k]);
      });
      if (gap < bestGap) { bestGap = gap; best = cand; }
      if (gap === 0) break;
    }

    best.targetGap = bestGap;
    return best;
  }

  /* ============================================================
     과제
     ============================================================ */
  function ShapeNbackTask(opts) {
    this.stage = opts.stage;
    this.rng = opts.rng;
    this.phase = opts.phase || 'live';
    this.onTrial = opts.onTrial || function () {};
    this.onStatus = opts.onStatus || function () {};
    this.trialIndex = opts.startIndex || 0;
    this._aborted = false;
    this._keyHandler = null;
    this._mount();
  }

  ShapeNbackTask.CONFIG = CONFIG;
  ShapeNbackTask.SHAPES = SHAPES;
  ShapeNbackTask.buildSequence = buildSequence;

  /* ---------- 화면 구성 ---------- */
  ShapeNbackTask.prototype._mount = function () {
    var self = this;
    this.stage.innerHTML =
      '<div class="nb">' +
        '<p class="nb-rule" id="nbRule"></p>' +
        '<div class="nb-stack">' +
          '<span class="nb-card nb-b2"></span>' +
          '<span class="nb-card nb-b1"></span>' +
          '<span class="nb-card nb-top" id="nbTop"></span>' +
        '</div>' +
        '<div class="nb-timer" id="nbTimer" role="timer" aria-label="남은 응답 시간">' +
          '<span class="nb-timer-fill" id="nbTimerFill"></span>' +
        '</div>' +
        '<div class="nb-keys" id="nbKeys">' +
          '<button type="button" class="nb-key" data-k="two" id="nbKeyTwo">' +
            '<b>←</b><span>2번째 전과 같음</span></button>' +
          '<button type="button" class="nb-key" data-k="three" id="nbKeyThree">' +
            '<b>→</b><span>3번째 전과 같음</span></button>' +
          '<button type="button" class="nb-key" data-k="none" id="nbKeyNone">' +
            '<b>Space</b><span id="nbKeyNoneLabel">2번째 전과 다름</span></button>' +
        '</div>' +
      '</div>';

    this.elTop = this.stage.querySelector('#nbTop');
    this.elRule = this.stage.querySelector('#nbRule');
    this.elKeys = this.stage.querySelector('#nbKeys');
    this.elTimer = this.stage.querySelector('#nbTimer');
    this.elTimerFill = this.stage.querySelector('#nbTimerFill');

    this.elKeys.addEventListener('click', function (e) {
      var b = e.target.closest('.nb-key');
      if (b) self._respond(b.getAttribute('data-k'), 'pointer');
    });

    this._keyHandler = function (e) {
      var k = e.key === 'ArrowLeft' ? 'two'
            : e.key === 'ArrowRight' ? 'three'
            : (e.key === ' ' || e.key === 'Spacebar') ? 'none' : null;
      if (!k) return;
      e.preventDefault();
      self._respond(k, 'keyboard');
    };
    document.addEventListener('keydown', this._keyHandler);

    /* 시작 전에는 받지 않는다 */
    this._setKeysEnabled(false);
  };

  ShapeNbackTask.prototype._setRoundUi = function (dual) {
    this.elRule.innerHTML = dual
      ? '<b>2번째 전</b>과 같으면 <kbd>←</kbd> · <b>3번째 전</b>과 같으면 <kbd>→</kbd> · 둘 다 아니면 <kbd>Space</kbd>'
      : '<b>2번째 전</b>과 같으면 <kbd>←</kbd> · 다르면 <kbd>Space</kbd>';

    this.stage.querySelector('#nbKeyThree').hidden = !dual;

    /* Space 키의 뜻이 라운드마다 다르다. 1라운드는 비교 대상이 하나뿐이라
       "둘 다 아님"이 틀린 문구가 된다. 무엇과 비교하는지 그대로 적는다. */
    var noneLabel = this.stage.querySelector('#nbKeyNoneLabel');
    if (noneLabel) {
      noneLabel.textContent = dual ? '둘 다 아님' : '2번째 전과 다름';
    }
  };

  /* ---------- 키 활성/비활성 ----------
     도입 자극(각 라운드 앞 2~3장)에서는 입력을 받지 않는다. 그런데 버튼이
     눌릴 것처럼 보이면 응시자가 눌러 보고 반응이 없어 혼란스럽다.
     받지 않는 구간에는 실제로 비활성화해 둔다. */
  ShapeNbackTask.prototype._setKeysEnabled = function (on) {
    var keys = this.stage.querySelectorAll
      ? this.stage.querySelectorAll('.nb-key') : null;
    if (!keys) return;
    Array.prototype.forEach.call(keys, function (b) {
      b.disabled = !on;
      if (b.classList) b.classList.toggle('nb-key-off', !on);
    });
  };

  ShapeNbackTask.prototype._showShape = function (shapeId) {
    this.elTop.innerHTML = SHAPES[shapeId].svg;
    this.elTop.classList.remove('nb-flip');
    void this.elTop.offsetWidth;          // 리플로우로 애니메이션 재시작
    this.elTop.classList.add('nb-flip');
  };

  ShapeNbackTask.prototype._clearShape = function () {
    this.elTop.innerHTML = '';
    this.elTop.classList.remove('nb-flip');
  };

  /* ---------- 응답 시간 막대 ----------
     남은 시간을 눈으로 볼 수 있어야 응시자가 "언제까지 눌러야 하는지"를 안다.
     rAF 루프 대신 CSS 애니메이션을 쓴다 — 자극마다 재점화만 하면 되고,
     prefers-reduced-motion에서는 스타일시트가 알아서 정지시킨다. */
  ShapeNbackTask.prototype._startTimer = function (ms) {
    var f = this.elTimerFill;
    if (!f || !f.style) return;
    this.elTimer.classList.remove('nb-timer-idle', 'nb-timer-locked');
    f.classList.remove('nb-run');
    f.style.animationDuration = ms + 'ms';
    void this.elTop.offsetWidth;          // 리플로우로 애니메이션 재시작
    f.classList.add('nb-run');
  };

  ShapeNbackTask.prototype._stopTimer = function (idle) {
    var f = this.elTimerFill;
    if (!f || !f.style) return;
    f.classList.remove('nb-run');
    if (idle) this.elTimer.classList.add('nb-timer-idle');
  };

  /* ---------- 응답 ---------- */
  ShapeNbackTask.prototype._respond = function (key, via) {
    if (!this._open) return;
    if (this._response !== null) return;      // 첫 응답만 채택
    this._response = key;
    this._responseVia = via;
    this._rt = Math.round(performance.now() - this._onsetAt);
    this._open = false;

    /* 입력이 확정됐음을 막대와 키에도 반영한다 — 더 받을 것이 없다 */
    if (this.elTimer && this.elTimer.classList) this.elTimer.classList.add('nb-timer-locked');
    this._setKeysEnabled(false);

    var btn = this.stage.querySelector('.nb-key[data-k="' + key + '"]');
    if (btn) {
      btn.classList.add('nb-hit');
      var b = btn;
      setTimeout(function () { b.classList.remove('nb-hit'); }, 220);
    }

    this.onStatus({ kind: 'responded', text: '응답' });
  };

  /* ---------- 단일 자극 ---------- */
  ShapeNbackTask.prototype._runStimulus = async function (ctx, pos) {
    var shapeId = ctx.seq[pos];
    var label = ctx.labels[pos];
    var judged = label !== null;

    this._response = null;
    this._responseVia = null;
    this._rt = null;
    this._open = judged;
    this._onsetAt = performance.now();

    var tsClient = Date.now();
    this._showShape(shapeId);

    if (judged) {
      this._startTimer(CONFIG.responseWindowMs);
      this._setKeysEnabled(true);
    } else {
      this._stopTimer(true);
      this._setKeysEnabled(false);
    }

    this.onStatus({
      kind: judged ? 'respond' : 'warmup',
      text: judged ? '판단하세요' : '아직 판단하지 않습니다',
      index: pos + 1,
      total: ctx.seq.length,
      round: ctx.round,
      windowMs: judged ? CONFIG.responseWindowMs : null
    });

    /* 노출 구간 — 이 시점에 다음 도형으로 넘어간다 */
    await sleep(CONFIG.stimulusMs);
    if (this._aborted) return null;
    this._clearShape();

    if (!judged) {
      await sleep(CONFIG.isiMs);
      return null;                            // 판단 대상 아님 — 로그 제외
    }

    /* 공백 구간 — 도형은 사라졌지만 판단은 계속 받는다 */
    await sleep(CONFIG.isiMs);
    if (this._aborted) return null;

    /* 입력 창이 닫히는 지점. 키도 여기서 잠근다 —
       "받는 동안만 열려 있다"가 유일한 규칙이어야 상태가 어긋나지 않는다. */
    this._open = false;
    this._stopTimer(false);
    this._setKeysEnabled(false);

    /* 채점 */
    var resp = this._response;
    var correct = (resp === label);

    var outcome;
    if (label === 'none') {
      outcome = resp === 'none' ? 'cr' : (resp === null ? 'omission' : 'fa');
    } else {
      outcome = resp === label ? 'hit' : (resp === null ? 'omission' : 'miss');
    }

    var trial = {
      taskId: CONFIG.taskId,
      phase: this.phase,
      trialIndex: this.trialIndex++,
      difficulty: ctx.nMax,                   // 2 또는 3
      stimulus: [shapeId],
      response: resp === null ? [] : [shapeId],
      correct: correct,
      rtFirstMs: this._rt,
      rtFirstRawMs: this._rt,
      rtTotalMs: this._rt,
      interTapMs: [],
      undos: [], undoCount: 0,
      timedOut: resp === null,
      tsClient: tsClient,
      abandoned: false,
      taskFields: {
        round: ctx.round,
        judged: true,
        position: pos + 1,
        shapeId: shapeId,
        shapeName: SHAPES[shapeId].name,
        back2: ctx.seq[pos - 2],
        back3: pos >= 3 ? ctx.seq[pos - 3] : null,
        condition: label,
        responseKey: resp,
        responseVia: this._responseVia,
        outcome: outcome
      }
    };

    this.onTrial(trial);

    /* 정오는 알려주지 않는다 — 연습에서도.
       맞았는지 알려주면 응시자가 그 정보로 다음 판단 기준을 바꾸고(학습 효과),
       시행 간 독립성이 깨져 d′가 능력이 아닌 적응 속도를 반영하게 된다.
       표시하는 것은 "입력이 접수되었는지" 뿐이다. */
    this.onStatus({
      kind: 'logged',
      text: resp === null ? '무응답' : '응답'
    });

    if (this.phase === 'practice') {
      await sleep(CONFIG.postTrialFeedbackMs);
    }

    return trial;
  };

  /* ---------- 라운드 ---------- */
  ShapeNbackTask.prototype._runRound = async function (spec) {
    var built = buildSequence(spec, this.rng);
    var ctx = {
      round: spec.round,
      seq: built.seq,
      labels: built.labels,
      nMax: built.nMax
    };

    this._setRoundUi(built.dual);
    this._setKeysEnabled(false);
    this.onStatus({
      kind: 'roundstart',
      text: spec.round === 1 ? '1라운드 — 2-back' : '2라운드 — 2&3-back',
      round: spec.round
    });
    await sleep(CONFIG.preRoundMs);
    if (this._aborted) return;

    for (var pos = 0; pos < ctx.seq.length; pos++) {
      if (this._aborted) return;
      await this._runStimulus(ctx, pos);
    }
  };

  ShapeNbackTask.prototype.runPractice = async function () {
    await this._runRound(CONFIG.practice);
    this._clearShape();
    this._setKeysEnabled(false);
    this._stopTimer(true);
    this.onStatus({ kind: 'done', text: '연습이 끝났습니다' });
  };

  ShapeNbackTask.prototype.runLive = async function () {
    for (var i = 0; i < CONFIG.rounds.length; i++) {
      if (this._aborted) return;
      await this._runRound(CONFIG.rounds[i]);
    }
    this._clearShape();
    this._setKeysEnabled(false);
    this._stopTimer(true);
    this.onStatus({ kind: 'done', text: '검사가 끝났습니다' });
  };

  ShapeNbackTask.prototype.abort = function () {
    this._aborted = true;
    this._open = false;
    this.destroy();
  };

  ShapeNbackTask.prototype.destroy = function () {
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
  };

  global.ShapeNbackTask = ShapeNbackTask;

  /* ============================================================
     레지스트리 등록
     ============================================================ */
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function ms(v) { return v == null ? '—' : v.toLocaleString() + ' ms'; }
  function pct(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }

  var OUTCOME_KO = {
    hit: '적중', miss: '누락', fa: '오경보', cr: '정확기각', omission: '무응답'
  };
  var COND_KO = { two: '2번째 전 일치', three: '3번째 전 일치', none: '불일치' };

  /* ============================================================
     설명용 예시 그림 — 실제 자극과 같은 도형을 쓴다.
     말로 "2번째 전"을 설명하는 것보다 카드 띠에 표시해 보이는 게 빠르다.
     ============================================================ */
  var CARD = 54, GAP = 10, PITCH = CARD + GAP;

  function cardHtml(shapeId, index, state) {
    return '<div class="wt-c" data-state="' + state + '">' +
             '<span class="wt-i">' + index + '</span>' +
             SHAPES[shapeId].svg +
           '</div>';
  }

  /**
   * 카드 띠 + 비교 관계 표시 + 정답 키.
   * link를 주면 두 카드를 잇는 괄호를 아래에 그린다.
   */
  function stripHtml(shapes, opts) {
    opts = opts || {};
    var focus = opts.focus;
    var link = opts.link;                 // { from, to, label }
    var html = '<div class="wt-strip">';

    html += '<div class="wt-cards">';
    shapes.forEach(function (s, i) {
      var state = 'plain';
      if (focus != null && i === focus) state = 'focus';
      else if (link && (i === link.from)) state = 'link';
      else if (focus != null && i > focus) state = 'ghost';
      html += cardHtml(s, i + 1, state);
    });
    html += '</div>';

    if (link) {
      var w = PITCH * (shapes.length - 1) + CARD;
      var x1 = CARD / 2 + link.from * PITCH;
      var x2 = CARD / 2 + link.to * PITCH;
      var mid = (x1 + x2) / 2;
      html +=
        '<svg class="wt-link" width="' + w + '" height="36" viewBox="0 0 ' + w + ' 36" aria-hidden="true">' +
          '<path d="M ' + x1 + ' 3 V 16 H ' + x2 + ' V 3" fill="none" stroke="currentColor" ' +
            'stroke-width="1.5" stroke-linejoin="round"></path>' +
          '<text x="' + mid + '" y="31" text-anchor="middle" fill="currentColor">' +
            esc(link.label) + '</text>' +
        '</svg>';
    }

    if (opts.verdict) {
      html += '<p class="wt-verdict">' + opts.verdict + '</p>';
    }

    html += '</div>';
    return html;
  }

  /** 도형 전체 나열 */
  function shapeLegendHtml() {
    return '<div class="wt-legend">' +
      SHAPES.map(function (s) {
        return '<div class="wt-l"><div class="wt-l-art">' + s.svg + '</div>' +
               '<span>' + s.name + '</span></div>';
      }).join('') +
    '</div>';
  }

  /** 응답 키 안내 */
  function keyLegendHtml(dual) {
    var rows = [
      ['←', '2번째 전과 같음'],
      ['→', '3번째 전과 같음'],
      ['Space', '둘 다 아님']
    ];
    if (!dual) rows = [rows[0], ['Space', '다름']];
    return '<div class="wt-keys">' +
      rows.map(function (r) {
        return '<div class="wt-k"><b>' + r[0] + '</b><span>' + r[1] + '</span></div>';
      }).join('') +
    '</div>';
  }

  /** 응답 시간 막대 시연 */
  function timerDemoHtml() {
    return '<div class="wt-timerdemo">' +
      '<div class="nb-timer"><span class="nb-timer-fill nb-run" ' +
        'style="animation-duration:' + CONFIG.responseWindowMs + 'ms;animation-iteration-count:infinite"></span></div>' +
      '<p class="wt-timernote">막대가 다 차면 기회가 끝납니다 · ' +
        (CONFIG.responseWindowMs / 1000).toFixed(1) + '초</p>' +
    '</div>';
  }

  global.Tasks.register({
    id: 'shape-nback',
    label: '도형 순서 기억하기 (현행)',
    subtitle: '도형 N-back · 작업기억 갱신·감시 · 현행 역검 대응',

    consent: {
      measures: '<strong>작업기억 갱신·감시 능력</strong>을 측정합니다. 도형이 한 장씩 갱신되는 동안 ' +
                '몇 단계 전의 도형을 계속 유지·갱신하며 현재 도형과 비교하는 과제입니다.',
      scoring: '적중률만으로는 아무 때나 "같다"를 누르는 응답을 걸러낼 수 없습니다. 따라서 ' +
               '적중과 오경보를 함께 쓰는 <strong>신호탐지 민감도(d′)</strong>로 채점하며, ' +
               '2-back과 3-back을 <strong>따로</strong> 산출합니다.',
      collects: '자극별 도형·조건·누른 키·반응시간, 그리고 반응시간 보정을 위한 기기/브라우저 정보를 ' +
                '수집합니다. <strong>영상·음성·생체정보는 수집하지 않습니다.</strong>'
    },

    walkthrough: [
      {
        title: '도형은 다섯 종류입니다',
        body: '색과 크기는 모두 같고, 생김새만 다릅니다. 도형을 알아보는 것 자체는 ' +
              '어렵지 않습니다 — 이 검사가 재는 것은 <strong>도형을 구별하는 능력이 아니라 ' +
              '순서를 유지하며 계속 갈아치우는 능력</strong>입니다.',
        html: shapeLegendHtml()
      },
      {
        title: '카드가 한 장씩 갱신됩니다',
        body: '가운데 더미의 맨 위 카드만 바뀝니다. 지나간 카드는 <strong>다시 볼 수 없습니다.</strong> ' +
              '그래서 눈으로 비교하는 과제가 아니라, 머릿속에 최근 몇 장을 담아 두는 과제입니다.',
        html: stripHtml([0, 1, 2, 1], {})
      },
      {
        title: '1라운드 — 2번째 전과 비교합니다',
        body: '현재 카드가 <strong>두 칸 전</strong> 카드와 같은 도형이면 <kbd>←</kbd>를 누릅니다. ' +
              '아래 예에서 3번 카드는 1번 카드와 같은 별입니다.',
        html: stripHtml([0, 1, 0], {
          focus: 2,
          link: { from: 0, to: 2, label: '2번째 전 — 같다' },
          verdict: '정답은 <kbd>←</kbd>'
        })
      },
      {
        title: '다르면 Space입니다',
        body: '3번 카드가 마름모, 두 칸 전인 1번 카드는 별입니다. 다르므로 <kbd>Space</kbd>를 누릅니다. ' +
              '<strong>다를 때도 반드시 눌러야 합니다</strong> — 가만히 두면 무응답으로 오류 처리됩니다.',
        html: stripHtml([0, 1, 2], {
          focus: 2,
          link: { from: 0, to: 2, label: '2번째 전 — 다르다' },
          verdict: '정답은 <kbd>Space</kbd>'
        })
      },
      {
        title: '앞의 두 장은 판단하지 않습니다',
        body: '비교할 대상이 아직 없기 때문입니다. 1·2번 카드는 그냥 보고 기억만 하고, ' +
              '<strong>3번 카드부터</strong> 누르기 시작합니다.',
        html: stripHtml([0, 1, 2, 1], { focus: 2 })
      },
      {
        title: '2라운드 — 3번째 전이 추가됩니다',
        body: '이제 <strong>두 칸 전과 세 칸 전</strong>을 함께 살펴야 합니다. ' +
              '세 칸 전과 같으면 <kbd>→</kbd>입니다. 아래 예에서 4번 카드는 1번 카드와 같은 별입니다.',
        html: stripHtml([0, 1, 2, 0], {
          focus: 3,
          link: { from: 0, to: 3, label: '3번째 전 — 같다' },
          verdict: '정답은 <kbd>→</kbd>'
        })
      },
      {
        title: '2라운드에서도 두 칸 전이면 ←입니다',
        body: '4번 카드가 반원이고 두 칸 전인 2번 카드도 반원입니다. 세 칸 전(1번, 별)과는 다릅니다. ' +
              '따라서 <kbd>←</kbd>. 2라운드는 <strong>4번 카드부터</strong> 판단합니다.',
        html: stripHtml([0, 1, 2, 1], {
          focus: 3,
          link: { from: 1, to: 3, label: '2번째 전 — 같다' },
          verdict: '정답은 <kbd>←</kbd>'
        })
      },
      {
        title: '누를 수 있는 키는 셋입니다',
        body: '키보드 방향키와 스페이스바를 쓰거나, 화면 아래 버튼을 눌러도 됩니다. ' +
              '한 카드에 <strong>한 번만</strong> 입력되고, 누른 뒤에는 바꿀 수 없습니다.',
        html: keyLegendHtml(true)
      },
      {
        title: '시간 막대가 다 차면 넘어갑니다',
        body: '카드는 <strong>' + (CONFIG.stimulusMs / 1000).toFixed(1) + '초</strong> 뒤 넘어가지만, ' +
              '판단은 그 뒤 잠깐의 공백까지 <strong>' + (CONFIG.responseWindowMs / 1000).toFixed(1) + '초</strong> 동안 받습니다. ' +
              '막대가 남은 시간을 보여줍니다.',
        html: timerDemoHtml()
      },
      {
        title: '찍으면 점수가 낮아집니다',
        body: '이 검사는 맞힌 개수만 세지 않습니다. <strong>맞게 누른 비율과 틀리게 누른 비율을 함께</strong> ' +
              '계산하기 때문에, 확신 없이 <kbd>←</kbd>를 남발하면 점수가 오히려 내려갑니다. ' +
              '모르겠으면 <kbd>Space</kbd>가 낫습니다.',
        html: null
      }
    ],

    readyNote: '본 검사는 <strong>2라운드</strong>로 진행됩니다. 1라운드는 2-back(자극 ' +
               CONFIG.rounds[0].count + '개), 2라운드는 2&amp;3-back(자극 ' + CONFIG.rounds[1].count + '개)입니다. ' +
               '<strong>정답 여부는 연습에서도 본 검사에서도 알려드리지 않습니다.</strong> ' +
               '화면에는 응답이 접수되었는지만 표시되며, 한 번 누른 응답은 취소할 수 없습니다.',

    create: function (o) { return new ShapeNbackTask(o); },
    score: function (liveTrials) { return Scoring.shapeNback(liveTrials); },
    normKey: function (s) { return s.overallDPrime; },

    tiles: function (s) {
      var t = [
        { label: '종합 d′', value: s.overallDPrime == null ? '—' : s.overallDPrime.toFixed(2),
          unit: '', hint: '조건별 민감도의 평균' },
        { label: '전체 정확도', value: pct(s.accuracy), unit: '',
          hint: s.correctTrials + ' / ' + s.judgedTrials + ' 판단 시행' }
      ];
      s.conditions.forEach(function (c) {
        t.push({
          label: c.label.replace('라운드 · ', 'R'),
          value: c.dPrime == null ? '—' : c.dPrime.toFixed(2),
          unit: 'd′',
          hint: '적중 ' + c.hits + '/' + c.targets + ' · 오경보 ' + c.falseAlarms + '/' + c.nonTargets
        });
      });
      if (s.noResponseTrials > 0) {
        t.push({ label: '무응답', value: s.noResponseTrials, unit: '회', hint: '허용 시간 내 미입력' });
      }
      return t;
    },

    sections: function (ctx) {
      var s = ctx.score;
      var html = '';

      html += '<h2>조건별 성적</h2>';
      html += '<p>2-back과 3-back을 합치지 않습니다. 둘은 부하가 다르고, ' +
              '<strong>3-back의 d′가 2-back보다 낮게 나오는지가 이 과제가 실제로 작업기억 부하를 ' +
              '재고 있는지 확인하는 근거</strong>입니다.</p>';

      html += '<div class="table-scroll"><table><thead><tr>' +
              '<th>조건</th><th>d′</th><th>적중률</th><th>오경보율</th>' +
              '<th>적중</th><th>누락</th><th>오경보</th><th>정확기각</th>' +
              '<th>반응편향 c</th><th>평균 반응</th>' +
              '</tr></thead><tbody>';

      s.conditions.forEach(function (c) {
        html += '<tr>' +
          '<td>' + esc(c.label) + '</td>' +
          '<td><strong>' + (c.dPrime == null ? '—' : c.dPrime.toFixed(2)) + '</strong></td>' +
          '<td>' + pct(c.hitRate) + '</td>' +
          '<td>' + pct(c.faRate) + '</td>' +
          '<td>' + c.hits + '</td>' +
          '<td>' + c.misses + '</td>' +
          '<td>' + c.falseAlarms + '</td>' +
          '<td>' + c.correctRejections + '</td>' +
          '<td>' + (c.criterion == null ? '—' : c.criterion.toFixed(2)) + '</td>' +
          '<td>' + ms(c.meanRtMs) + '</td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';

      /* 부하 효과 확인 */
      var r2 = s.conditions.filter(function (c) { return c.key === 'r2-2back'; })[0];
      var r3 = s.conditions.filter(function (c) { return c.key === 'r2-3back'; })[0];
      if (r2 && r3 && r2.dPrime != null && r3.dPrime != null) {
        var drop = Math.round((r2.dPrime - r3.dPrime) * 100) / 100;
        html += '<div class="callout' + (drop > 0 ? '' : ' warn') + '">' +
          '<strong>부하 효과</strong> — 같은 라운드 안에서 3-back의 d′가 2-back보다 ' +
          (drop > 0 ? '<strong>' + drop.toFixed(2) + '만큼 낮습니다.</strong> 예상된 방향입니다.'
                    : '<strong>낮지 않습니다(' + drop.toFixed(2) + ').</strong> 시행 수가 적어 우연일 수 있으나, ' +
                      '반복해서 이 패턴이 나오면 자극열 생성이나 지시문을 점검해야 합니다.') +
          '</div>';
      }

      html += '<div class="callout">' +
        '<strong>반응편향 c 읽는 법</strong> — 0이면 중립, 양수면 "다름"으로 기울고, 음수면 ' +
        '"같음"을 남발하는 쪽입니다. d′가 낮은데 c가 크게 음수라면 실력 부족이 아니라 ' +
        '<strong>전략 문제</strong>일 수 있어 리포트에서 구분해야 합니다.' +
        '</div>';

      html += '<div class="callout">' +
        '<strong>정오는 응시 중에 알려주지 않았습니다.</strong> 맞았는지 알려주면 응시자가 그 정보로 ' +
        '판단 기준을 바꿔(학습 효과) 시행 간 독립성이 깨지고, d′가 능력이 아닌 적응 속도를 ' +
        '반영하게 됩니다. 대신 <strong>이 리포트에서 자극별 정답과 판정을 전부 공개</strong>합니다 — ' +
        '이의제기와 인적 재검토에 쓸 근거가 남아야 하기 때문입니다.' +
        '</div>';

      return html;
    },

    logTable: function (ctx) {
      var html = '';
      html += '<h2>자극 원시 로그 (본 시행)</h2>';
      html += '<p>시드(<code>' + esc(ctx.session.seed) + '</code>)만으로 자극열 전체를 재현할 수 있습니다. ' +
              '판단 대상이 아닌 도입 자극(각 라운드의 앞 2~3개)은 기록에서 제외됩니다.</p>';

      html += '<div class="table-scroll"><table><thead><tr>' +
              '<th>R</th><th>#</th><th>도형</th><th>2전</th><th>3전</th>' +
              '<th>정답</th><th>누른 키</th><th>판정</th><th>반응</th>' +
              '</tr></thead><tbody>';

      ctx.liveTrials.forEach(function (t) {
        var f = t.taskFields || {};
        var sh = function (id) {
          return id == null ? '—' : esc(ShapeNbackTask.SHAPES[id].name);
        };
        var tagCls = (f.outcome === 'hit' || f.outcome === 'cr') ? 'ok' : 'err';

        html += '<tr>' +
          '<td>' + (f.round || '—') + '</td>' +
          '<td>' + (f.position || '—') + '</td>' +
          '<td>' + sh(f.shapeId) + '</td>' +
          '<td class="seq">' + sh(f.back2) + '</td>' +
          '<td class="seq">' + sh(f.back3) + '</td>' +
          '<td>' + esc(COND_KO[f.condition] || '—') + '</td>' +
          '<td class="seq">' + (f.responseKey ? esc(KEY_LABEL[f.responseKey]) : '—') + '</td>' +
          '<td><span class="tag ' + tagCls + '">' + esc(OUTCOME_KO[f.outcome] || '—') + '</span></td>' +
          '<td>' + ms(t.rtFirstMs) + '</td>' +
        '</tr>';
      });

      html += '</tbody></table></div>';
      return html;
    },

    explain: function (ctx) {
      var s = ctx.score;

      var formula = 'd′ = z(적중률) − z(오경보율)\n\n';
      s.conditions.forEach(function (c) {
        formula += c.label + '\n' +
          '  적중률   = (' + c.hits + ' + 0.5) / (' + c.targets + ' + 1)\n' +
          '  오경보율 = (' + c.falseAlarms + ' + 0.5) / (' + c.nonTargets + ' + 1)\n' +
          '  d′       = <b>' + (c.dPrime == null ? '—' : c.dPrime.toFixed(2)) + '</b>\n\n';
      });
      formula += '종합 d′ = 위 조건별 d′의 평균 = <b>' +
                 (s.overallDPrime == null ? '—' : s.overallDPrime.toFixed(2)) + '</b>';

      return {
        measures: '<strong>작업기억 갱신·감시</strong>를 측정했습니다. 사용한 절차는 도형 N-back이며, ' +
                  '채점은 신호탐지이론의 민감도 지표 d′를 따릅니다. 도형을 ' + SHAPE_COUNT + '종으로 한정하고 ' +
                  '색·크기를 같게 둔 것은 <strong>자극을 알아보는 난이도가 아니라 기억 갱신의 부하</strong>를 ' +
                  '재기 위한 것입니다.',
        procedure:
          '1라운드 <b>2-back</b> — 자극 ' + CONFIG.rounds[0].count + '개, 3번째부터 판단\n' +
          '  2번째 전과 일치 → <b>←</b>        불일치 → <b>Space</b>\n\n' +
          '2라운드 <b>2&3-back</b> — 자극 ' + CONFIG.rounds[1].count + '개, 4번째부터 판단\n' +
          '  2번째 전 일치 → <b>←</b>   3번째 전 일치 → <b>→</b>   둘 다 아님 → <b>Space</b>\n\n' +
          '노출 시간 <b>' + CONFIG.stimulusMs.toLocaleString() + 'ms</b> (= 응답 허용 창), 갱신 간격 <b>' + CONFIG.isiMs + 'ms</b>\n' +
          '표적 비율: 1라운드 약 <b>32%</b>, 2라운드 2-back <b>20%</b> + 3-back <b>20%</b>\n' +
          '정오 미고지 — 연습·본 시행 모두. 화면에는 응답/무응답만 표시\n\n' +
          '자극열은 현재 도형이 2번째 전과 3번째 전에 <b>동시에</b> 일치하지 않도록 생성됩니다.\n' +
          '정답이 두 개가 되는 문항을 원천적으로 배제하기 위한 것입니다.',
        formula: formula,
        rtNote: '반응시간(적중 시행 평균)은 <strong>점수에 반영되지 않았습니다.</strong> ' +
                '브라우저·기기별 반응시간 계통 오차가 확인되어, 보정 근거가 쌓이기 전까지 참고 지표로만 보고합니다. ' +
                '다만 무응답은 오류로 채점됩니다 — 허용 시간 안에 판단하지 못한 것 자체가 과제 수행의 일부입니다.',
        extraRows: [
          ['판단 시행', s.judgedTrials + '건 (전체 자극 ' + s.totalTrials + '건 중)', '채점 대상'],
          ['무응답', s.noResponseTrials + '건', '오류로 채점'],
          ['반응 방식', '키보드 / 화면 버튼', '입력 경로 기록']
        ]
      };
    }
  });
})(window);

/* ============================================================
   task-spatial-span.js — 도형 순서 기억 (Corsi Block-Tapping)

   표준 절차 (Corsi 1972 / Kessels et al. 2000):
     · 9개 도형을 불규칙 배치 (격자 배치는 언어적 부호화를 유발해 회피)
     · 순서 길이 2에서 시작, 각 단계 2시행
     · 단계에서 1회 이상 정답 → 다음 단계로 (길이 +1)
     · 단계에서 2회 모두 오답 → 종료
     · 자극 제시: 도형당 1,000ms 점등 + 500ms 간격

   태스크 표준 인터페이스 (나머지 8종도 이 형태를 따른다):
     new Task(opts).run() -> Promise<void>
     opts: { board, rng, phase, onTrial, onStatus, startIndex }
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 불규칙 배치 좌표 (%) — 고전 Corsi 보드 배열 ---------- */
  var LAYOUT = [
    { id: 0, x: 20, y: 15 },
    { id: 1, x: 66, y: 12 },
    { id: 2, x: 40, y: 31 },
    { id: 3, x: 85, y: 36 },
    { id: 4, x: 13, y: 46 },
    { id: 5, x: 58, y: 53 },
    { id: 6, x: 30, y: 69 },
    { id: 7, x: 78, y: 73 },
    { id: 8, x: 48, y: 87 }
  ];

  /* ---------- 도형 (위치 기억을 돕는 시각 표지) ---------- */
  var SHAPES = [
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
    '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="3"/></svg>',
    '<svg viewBox="0 0 24 24"><polygon points="12,2 23,21 1,21"/></svg>',
    '<svg viewBox="0 0 24 24"><polygon points="12,1 23,12 12,23 1,12"/></svg>',
    '<svg viewBox="0 0 24 24"><polygon points="12,2 23,9.5 18.8,22 5.2,22 1,9.5"/></svg>',
    '<svg viewBox="0 0 24 24"><polygon points="12,1.5 15,9 23,9 16.5,14 19,22 12,17.5 5,22 7.5,14 1,9 9,9"/></svg>',
    '<svg viewBox="0 0 24 24"><polygon points="7,2 17,2 23,12 17,22 7,22 1,12"/></svg>',
    '<svg viewBox="0 0 24 24"><polygon points="9,1 15,1 15,9 23,9 23,15 15,15 15,23 9,23 9,15 1,15 1,9 9,9"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M2 20a10 10 0 0 1 20 0z"/></svg>'
  ];

  /* ---------- 절차 상수 ---------- */
  var CONFIG = {
    taskId: 'spatial-span',
    litMs: 1000,          // 점등 지속
    gapMs: 500,           // 점등 간 간격
    preTrialMs: 900,      // 시행 시작 전 대기
    postTrialMs: 1100,    // 피드백 표시 시간
    startLevel: 2,
    maxLevel: 9,
    trialsPerLevel: 2,
    maxLiveTrials: 24,    // 안전 상한

    /* ---- 오입력 복구 정책 ----
       무제한 취소는 허용할 수 없다. 응시자가 "눌러보고 취소"를 반복하면
       사실상 자극 시연을 연장하는 효과가 생겨 작업기억이 아닌 것을 측정하게 된다.
       손 실수(직후 빠른 수정)만 복구 가능하게 창을 좁히고, 전 취소를 로그에 남긴다.
       ※ 이 정책은 규준 수집 착수 전에 확정해야 한다 (변경 시 기존 규준 폐기). */
    undo: {
      practice: { enabled: true, maxPerTrial: Infinity, windowMs: Infinity },
      live:     { enabled: true, maxPerTrial: 1,        windowMs: 2000 }
    },

    /* ---- 무응답 상한 ----
       없으면 응시자가 이탈했을 때 시행이 영구히 종료되지 않는다. */
    responseTimeoutBaseMs: 8000,
    responseTimeoutPerItemMs: 2500
  };

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* ============================================================
     Task
     ============================================================ */
  function SpatialSpanTask(opts) {
    this.board = opts.board;
    this.rng = opts.rng;
    this.phase = opts.phase || 'live';
    this.onTrial = opts.onTrial || function () {};
    this.onStatus = opts.onStatus || function () {};
    this.trialIndex = opts.startIndex || 0;
    this.blocks = [];
    this._aborted = false;
    this._buildBoard();
  }

  SpatialSpanTask.CONFIG = CONFIG;

  /* ---------- 보드 구성 ---------- */
  SpatialSpanTask.prototype._buildBoard = function () {
    var self = this;
    this.board.innerHTML = '';
    this.blocks = [];

    LAYOUT.forEach(function (pos, i) {
      var el = document.createElement('div');
      el.className = 'block';
      el.style.left = pos.x + '%';
      el.style.top = pos.y + '%';
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', '도형 ' + (i + 1));
      el.innerHTML = SHAPES[i];
      el.addEventListener('click', function () { self._onTap(i, el); });
      self.board.appendChild(el);
      self.blocks.push(el);
    });
  };

  SpatialSpanTask.prototype._clearMarks = function () {
    this.blocks.forEach(function (el) {
      el.classList.remove('lit', 'tapped');
      var tag = el.querySelector('.order-tag');
      if (tag) tag.remove();
    });
  };

  /* ---------- 자극 생성 ----------
     9개 위치에서 length개를 비복원 추출.
     시드 RNG를 쓰므로 session.seed 하나로 전 시행을 재현할 수 있다. */
  SpatialSpanTask.prototype._makeSequence = function (length) {
    var ids = LAYOUT.map(function (p) { return p.id; });
    return this.rng.sample(ids, length);
  };

  /* ---------- 자극 제시 ---------- */
  SpatialSpanTask.prototype._present = async function (seq) {
    this.onStatus({ kind: 'present', text: '순서를 기억하세요' });
    for (var i = 0; i < seq.length; i++) {
      if (this._aborted) return;
      var el = this.blocks[seq[i]];
      el.classList.add('lit');
      await sleep(CONFIG.litMs);
      el.classList.remove('lit');
      if (i < seq.length - 1) await sleep(CONFIG.gapMs);
    }
  };

  /* ---------- 응답 수집 ---------- */
  SpatialSpanTask.prototype._collect = function (expectedLength) {
    var self = this;
    this._response = [];
    this._tapTimes = [];
    this._undos = [];
    this._firstTapEverAt = null;
    this._openAt = performance.now();
    this._inputOpen = true;
    this._timedOut = false;
    this._confirming = false;
    this._graceId = null;
    this._expectedLength = expectedLength;
    this.board.classList.add('input-open');

    var deadline = CONFIG.responseTimeoutBaseMs +
                   CONFIG.responseTimeoutPerItemMs * expectedLength;

    return new Promise(function (resolve) {
      /* resolve를 감싸 타이머를 반드시 정리한다 */
      self._resolveInput = function () {
        clearTimeout(self._timeoutId);
        clearTimeout(self._undoExpiryId);
        clearTimeout(self._graceId);
        self._timeoutId = null;
        self._undoExpiryId = null;
        self._graceId = null;
        resolve();
      };

      /* 무응답 상한 — 초과 시 미완성 응답으로 시행 종료 */
      self._timeoutId = setTimeout(function () {
        if (!self._inputOpen) return;
        /* 이미 다 입력했고 확정 대기 중이라면 시간초과가 아니라 그대로 제출 */
        if (self._response.length >= self._expectedLength) { self.submit(); return; }
        self._timedOut = true;
        self._closeInput();
        self.onStatus({ kind: 'timeout', text: '응답 시간이 초과되었습니다' });
        self._resolveInput();
      }, deadline);

      self._emitInput();
    });
  };

  SpatialSpanTask.prototype._closeInput = function () {
    this._inputOpen = false;
    this.board.classList.remove('input-open');
  };

  /* ---------- 입력 상태 방출 (취소 가능 여부 포함) ---------- */
  SpatialSpanTask.prototype._emitInput = function () {
    this.onStatus({
      kind: 'input',
      text: '순서대로 클릭하세요',
      filled: this._response.length,
      total: this._expectedLength,
      undo: this.undoAvailable()
    });
  };

  SpatialSpanTask.prototype._undoPolicy = function () {
    return CONFIG.undo[this.phase === 'practice' ? 'practice' : 'live'];
  };

  /**
   * 취소 가능 여부와 그 사유.
   * 사유를 문자열로 돌려주는 이유: 버튼을 그냥 비활성화하면 응시자가
   * "왜 안 되는지" 몰라 불필요한 불안을 겪고, 이의제기 근거가 된다.
   */
  SpatialSpanTask.prototype.undoAvailable = function () {
    var p = this._undoPolicy();
    if (!p.enabled) return { ok: false, reason: null, shown: false };
    if (!this._inputOpen) return { ok: false, reason: null, shown: false };

    if (!this._response.length) {
      return { ok: false, reason: '취소할 입력이 없습니다', shown: true, remaining: p.maxPerTrial - this._undos.length };
    }
    if (this._undos.length >= p.maxPerTrial) {
      return { ok: false, reason: '이 시행의 수정 기회를 모두 사용했습니다', shown: true, remaining: 0 };
    }
    var since = performance.now() - this._tapTimes[this._tapTimes.length - 1];
    if (since > p.windowMs) {
      return { ok: false, reason: '수정 가능 시간(' + (p.windowMs / 1000) + '초)이 지났습니다', shown: true, remaining: p.maxPerTrial - this._undos.length };
    }
    return {
      ok: true,
      reason: null,
      shown: true,
      remaining: p.maxPerTrial - this._undos.length,
      msLeft: Math.max(0, Math.round(p.windowMs - since))
    };
  };

  /** 수정 창이 닫히는 시점에 버튼을 스스로 비활성화하도록 예약 */
  SpatialSpanTask.prototype._scheduleUndoExpiry = function () {
    var self = this;
    clearTimeout(this._undoExpiryId);
    var p = this._undoPolicy();
    if (!p.enabled || p.windowMs === Infinity) return;
    this._undoExpiryId = setTimeout(function () {
      if (self._inputOpen) self._emitInput();
    }, p.windowMs + 30);
  };

  /* ---------- 마지막 입력 취소 ---------- */
  SpatialSpanTask.prototype.undo = function () {
    var av = this.undoAvailable();
    if (!av.ok) return false;

    var id = this._response.pop();
    var tapAt = this._tapTimes.pop();
    var now = performance.now();

    this._undos.push({
      removedId: id,
      position: this._response.length + 1,   // 몇 번째 입력을 지웠는지
      atMs: Math.round(now - this._openAt),
      sinceTapMs: Math.round(now - tapAt),   // 이 값이 작으면 손 실수, 크면 망설임
      duringConfirm: !!this._confirming
    });

    var el = this.blocks[id];
    el.classList.remove('tapped');
    var tag = el.querySelector('.order-tag');
    if (tag) tag.remove();

    /* 확정 대기 중에 취소했다면 자동 확정을 취소하고 입력 상태로 되돌린다 */
    if (this._confirming) {
      clearTimeout(this._graceId);
      this._graceId = null;
      this._confirming = false;
    }

    this._emitInput();
    this._scheduleUndoExpiry();
    return true;
  };

  /* ---------- 확정 유예 ----------
     마지막 입력이 곧바로 제출되면 정작 가장 치명적인 실수(마지막 클릭 오타)를
     복구할 수 없다. 입력이 다 차면 짧은 유예를 두고, 그 사이 취소를 허용한다.
     유예 길이 = 취소 창 길이로 맞춰 "버튼이 살아있는 동안만 유예"가 되게 한다. */
  SpatialSpanTask.prototype._enterConfirm = function () {
    var self = this;
    var p = this._undoPolicy();
    var graceMs = isFinite(p.windowMs) ? p.windowMs : 3000;

    clearTimeout(this._undoExpiryId);
    clearTimeout(this._graceId);
    this._confirming = true;

    this.onStatus({
      kind: 'confirm',
      text: '입력 완료',
      filled: this._response.length,
      total: this._expectedLength,
      undo: this.undoAvailable(),
      graceMs: graceMs
    });

    this._graceId = setTimeout(function () {
      if (self._inputOpen) self.submit();
    }, graceMs);
  };

  /** 응답 확정 — 유예 종료 시 자동 호출되거나 응시자가 직접 누른다 */
  SpatialSpanTask.prototype.submit = function () {
    if (!this._inputOpen) return false;
    if (this._response.length < this._expectedLength) return false;
    this._confirming = false;
    this._closeInput();
    this._resolveInput();
    return true;
  };

  SpatialSpanTask.prototype._onTap = function (id, el) {
    if (!this._inputOpen) return;
    if (el.classList.contains('tapped')) return;   // 동일 도형 중복 입력 무시 (자극은 비복원 추출)

    var now = performance.now();
    if (this._firstTapEverAt === null) this._firstTapEverAt = now;

    this._response.push(id);
    this._tapTimes.push(now);

    el.classList.add('tapped');
    var tag = document.createElement('span');
    tag.className = 'order-tag';
    tag.textContent = String(this._response.length);
    el.appendChild(tag);

    if (this._response.length >= this._expectedLength) {
      this._enterConfirm();
      return;
    }

    this._emitInput();
    this._scheduleUndoExpiry();
  };

  /* ---------- 단일 시행 ---------- */
  SpatialSpanTask.prototype._runTrial = async function (level) {
    this._clearMarks();
    this.onStatus({ kind: 'wait', text: '잠시 후 시작합니다', level: level, index: this.trialIndex + 1 });
    await sleep(CONFIG.preTrialMs);
    if (this._aborted) return null;

    var seq = this._makeSequence(level);
    var tsClient = Date.now();

    await this._present(seq);
    if (this._aborted) return null;

    await this._collect(level);
    if (this._aborted) return null;

    /* 채점 */
    var resp = this._response;
    var correct = resp.length === seq.length && resp.every(function (v, i) { return v === seq[i]; });

    /* 반응시간 */
    var rtFirst = this._tapTimes.length ? Math.round(this._tapTimes[0] - this._openAt) : null;
    var rtTotal = this._tapTimes.length
      ? Math.round(this._tapTimes[this._tapTimes.length - 1] - this._openAt) : null;
    var inter = [];
    for (var i = 1; i < this._tapTimes.length; i++) {
      inter.push(Math.round(this._tapTimes[i] - this._tapTimes[i - 1]));
    }

    var trial = {
      taskId: CONFIG.taskId,
      phase: this.phase,
      trialIndex: this.trialIndex++,
      difficulty: level,
      stimulus: seq,
      response: resp.slice(),
      correct: correct,
      rtFirstMs: rtFirst,
      /* 취소된 입력을 포함한 "최초로 손이 움직인" 시각. 취소를 쓴 시행에서
         rtFirstMs와 갈라지므로, RT 분석 시 어느 쪽을 쓸지 선택할 수 있다. */
      rtFirstRawMs: this._firstTapEverAt === null
        ? null : Math.round(this._firstTapEverAt - this._openAt),
      rtTotalMs: rtTotal,
      interTapMs: inter,
      undos: this._undos.slice(),
      undoCount: this._undos.length,
      timedOut: this._timedOut,
      tsClient: tsClient,
      abandoned: this._timedOut
    };

    this.onTrial(trial);

    /* 피드백 — 연습에서만 정오를 알려준다 (본 시행 비피드백은 표준 절차) */
    if (this._timedOut) {
      this.onStatus({ kind: 'feedback', text: '시간 초과로 기록되었습니다', correct: null });
    } else if (this.phase === 'practice') {
      this.onStatus({
        kind: 'feedback',
        text: correct ? '정답입니다' : '오답입니다',
        correct: correct
      });
    } else {
      this.onStatus({ kind: 'feedback', text: '기록되었습니다', correct: null });
    }

    await sleep(CONFIG.postTrialMs);
    return trial;
  };

  /* ---------- 연습 블록: 길이 2 고정 2회 ---------- */
  SpatialSpanTask.prototype.runPractice = async function () {
    for (var i = 0; i < 2; i++) {
      var t = await this._runTrial(CONFIG.startLevel);
      if (!t) return;
    }
    this._clearMarks();
    this.onStatus({ kind: 'done', text: '연습이 끝났습니다' });
  };

  /* ---------- 본 블록: 표준 span 계단 절차 ---------- */
  SpatialSpanTask.prototype.runLive = async function () {
    var level = CONFIG.startLevel;
    var liveCount = 0;

    while (level <= CONFIG.maxLevel && liveCount < CONFIG.maxLiveTrials) {
      var correctInLevel = 0;

      for (var k = 0; k < CONFIG.trialsPerLevel; k++) {
        var t = await this._runTrial(level);
        if (!t) return;
        liveCount++;
        if (t.correct) correctInLevel++;
      }

      /* 해당 단계에서 한 번도 못 맞히면 종료 */
      if (correctInLevel === 0) break;
      level++;
    }

    this._clearMarks();
    this.onStatus({ kind: 'done', text: '검사가 끝났습니다' });
  };

  SpatialSpanTask.prototype.abort = function () {
    this._aborted = true;
    this._inputOpen = false;
    this._confirming = false;
    clearTimeout(this._timeoutId);
    clearTimeout(this._undoExpiryId);
    clearTimeout(this._graceId);
    if (this._resolveInput) this._resolveInput();
  };

  global.SpatialSpanTask = SpatialSpanTask;
})(window);

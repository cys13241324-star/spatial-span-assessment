/* ============================================================
   app.js — 화면 전환 / 세션 수명 관리 / 태스크 구동
   ============================================================ */
(function (global) {
  'use strict';

  var App = {};

  var state = {
    session: null,
    logger: null,
    rng: null,
    task: null,
    lastLevel: null,
    lastIndex: null,
    liveFrom: null,
    liveTo: null
  };

  /* ---------- 화면 전환 ---------- */
  App.show = function (id) {
    Array.prototype.forEach.call(document.querySelectorAll('.screen'), function (s) {
      s.classList.toggle('active', s.id === id);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /* ---------- 상태 표시 ---------- */
  var els = {};

  function cacheEls() {
    els.status = document.getElementById('taskStatus');
    els.spanLevel = document.getElementById('spanLevel');
    els.trialCounter = document.getElementById('trialCounter');
    els.pips = document.getElementById('pips');
    els.feedback = document.getElementById('feedback');
    els.phaseBadge = document.getElementById('phaseBadge');
    els.board = document.getElementById('board');
    els.sessionLabel = document.getElementById('sessionLabel');
    els.inputControls = document.getElementById('inputControls');
    els.btnUndo = document.getElementById('btnUndo');
    els.btnSubmit = document.getElementById('btnSubmit');
    els.undoNote = document.getElementById('undoNote');
  }

  /* ---------- 입력 제어 표시 ---------- */
  function renderControls(s) {
    var showing = s.kind === 'input' || s.kind === 'confirm';
    els.inputControls.hidden = !showing;
    if (!showing) return;

    var u = s.undo || { ok: false, shown: false };
    els.btnUndo.hidden = !u.shown;
    els.btnUndo.disabled = !u.ok;

    els.btnSubmit.hidden = s.kind !== 'confirm';

    if (s.kind === 'confirm') {
      /* 유예 진행바 — 남은 시간이 눈에 보여야 응시자가 당황하지 않는다 */
      els.undoNote.className = 'control-note live';
      els.undoNote.innerHTML =
        '<span class="grace"><span style="animation-duration:' + s.graceMs + 'ms"></span></span>';
    } else if (u.ok && isFinite(u.remaining)) {
      els.undoNote.className = 'control-note';
      els.undoNote.textContent = '수정 가능 ' + u.remaining + '회';
    } else if (u.reason) {
      els.undoNote.className = 'control-note';
      els.undoNote.textContent = u.reason;
    } else {
      els.undoNote.className = 'control-note';
      els.undoNote.textContent = '';
    }
  }

  function renderPips(filled, total) {
    if (!total) { els.pips.innerHTML = ''; return; }
    var h = '';
    for (var i = 0; i < total; i++) {
      h += '<span class="pip' + (i < filled ? ' filled' : '') + '"></span>';
    }
    els.pips.innerHTML = h;
  }

  function onStatus(s) {
    if (s.level != null) state.lastLevel = s.level;
    if (s.index != null) state.lastIndex = s.index;

    els.status.textContent = s.text;
    els.spanLevel.textContent = state.lastLevel ? '순서 길이 ' + state.lastLevel : '순서 길이 —';
    els.trialCounter.textContent = state.lastIndex ? '시행 ' + state.lastIndex : '시행 —';

    renderControls(s);

    if (s.kind === 'input') {
      renderPips(s.filled, s.total);
      els.feedback.className = 'feedback info';
      els.feedback.textContent = '';
    } else if (s.kind === 'confirm') {
      renderPips(s.filled, s.total);
      els.feedback.className = 'feedback info';
      els.feedback.textContent = '';
      els.status.textContent = '입력 완료 — 확정 대기';
    } else if (s.kind === 'timeout') {
      renderPips(0, 0);
      els.feedback.className = 'feedback err';
      els.feedback.textContent = s.text;
    } else if (s.kind === 'present') {
      renderPips(0, state.lastLevel || 0);
      els.feedback.className = 'feedback info';
      els.feedback.textContent = '';
    } else if (s.kind === 'feedback') {
      els.feedback.className = 'feedback ' + (s.correct === true ? 'ok' : s.correct === false ? 'err' : 'info');
      els.feedback.textContent = s.text;
      els.status.textContent = '채점 중';
    } else if (s.kind === 'wait') {
      renderPips(0, 0);
      els.feedback.className = 'feedback info';
      els.feedback.textContent = '';
    } else if (s.kind === 'done') {
      renderPips(0, 0);
      els.feedback.className = 'feedback info';
      els.feedback.textContent = '';
    }
  }

  /* ---------- 세션 시작 ---------- */
  function bootSession(timing) {
    var profile = Core.Device.profile(timing);
    state.session = Core.createSession('spatial-span', profile);
    state.logger = new Core.Logger(state.session);
    state.rng = new Core.Rng(state.session.seed);

    els.sessionLabel.textContent = state.session.id;
    console.log('[session] 시작', state.session);
    console.log('[session] 추정 리프레시 레이트', timing);
  }

  /* ---------- 연습 ---------- */
  async function runPractice() {
    App.show('screen-task');
    els.phaseBadge.textContent = '연습';
    els.phaseBadge.classList.remove('live');
    state.lastLevel = null;
    state.lastIndex = null;

    state.task = new SpatialSpanTask({
      board: els.board,
      rng: new Core.Rng(state.session.seed ^ 0x9E3779B9), // 연습은 별도 시드 스트림
      phase: 'practice',
      onTrial: function (t) { state.logger.logTrial(t); },
      onStatus: onStatus
    });

    await state.task.runPractice();
    App.show('screen-ready');
  }

  /* ---------- 본 검사 ---------- */
  async function runLive() {
    App.show('screen-task');
    els.phaseBadge.textContent = '본 검사';
    els.phaseBadge.classList.add('live');
    state.lastLevel = null;
    state.lastIndex = null;
    state.liveFrom = Date.now();

    state.task = new SpatialSpanTask({
      board: els.board,
      rng: state.rng,
      phase: 'live',
      onTrial: function (t) { state.logger.logTrial(t); },
      onStatus: onStatus
    });

    await state.task.runLive();

    state.liveTo = Date.now();
    finish();
  }

  /* ---------- 종료 및 리포트 ---------- */
  function finish() {
    state.session.finishedAt = new Date().toISOString();

    var liveTrials = state.logger.liveTrials();
    var raw = state.logger.toJSON();

    var ctx = {
      session: state.session,
      liveTrials: liveTrials,
      raw: raw,
      score: Scoring.spatialSpan(liveTrials),
      errorProfile: Scoring.errorProfile(liveTrials),
      corrections: Scoring.inputCorrections(liveTrials),
      integrity: Scoring.integritySummary(
        state.logger.integrityEvents,
        { from: state.liveFrom, to: state.liveTo }
      )
    };

    console.log('[result] 채점 결과', ctx.score);
    console.log('[result] 원시 로그', raw);

    Report.render(document.getElementById('reportBody'), ctx);
    App.show('screen-report');
  }

  /* ---------- 초기화 ---------- */
  function init() {
    cacheEls();

    /* 리프레시 레이트 실측 후 세션 생성 (RT 보정 근거) */
    Core.Device.measureRefreshRate(500, function (timing) {
      bootSession(timing);
    });

    /* 동의 체크박스 */
    var agree = document.getElementById('agree');
    var btnNext = document.getElementById('btnToTutorial');
    agree.addEventListener('change', function () {
      btnNext.disabled = !agree.checked;
    });

    btnNext.addEventListener('click', function () {
      App.show('screen-tutorial');
    });

    document.getElementById('btnToPractice').addEventListener('click', function () {
      if (!state.session) { alert('기기 프로파일 측정 중입니다. 잠시 후 다시 시도하세요.'); return; }
      runPractice();
    });

    document.getElementById('btnToLive').addEventListener('click', runLive);

    /* 오입력 취소 / 확정 */
    els.btnUndo.addEventListener('click', function () {
      if (state.task) state.task.undo();
    });

    els.btnSubmit.addEventListener('click', function () {
      if (state.task) state.task.submit();
    });

    /* 키보드: Backspace 취소, Enter 확정 */
    document.addEventListener('keydown', function (e) {
      if (!state.task) return;
      if (document.getElementById('screen-task').classList.contains('active') === false) return;

      if (e.key === 'Backspace') {
        e.preventDefault();
        state.task.undo();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        state.task.submit();
      }
    });

    /* data-goto 일반 핸들러 */
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-goto]');
      if (t) App.show(t.getAttribute('data-goto'));
    });
  }

  global.App = App;
  document.addEventListener('DOMContentLoaded', init);
})(window);

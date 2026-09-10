/* ============================================================
   app.js — 셸. 과제를 직접 알지 않고 서술자만 보고 화면을 구성한다.
   ============================================================ */
(function (global) {
  'use strict';

  var App = {};

  var state = {
    desc: null,          // 선택된 과제 서술자
    session: null,
    logger: null,
    rng: null,
    task: null,
    timing: null,
    progA: null,
    progB: null,
    liveFrom: null,
    liveTo: null
  };

  var els = {};

  /* ---------- 화면 전환 ---------- */
  App.show = function (id) {
    Array.prototype.forEach.call(document.querySelectorAll('.screen'), function (s) {
      s.classList.toggle('active', s.id === id);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  function cacheEls() {
    [
      'taskLabel', 'sessionLabel', 'pickList',
      'cMeasures', 'cScoring', 'cCollects', 'agree', 'btnToTutorial',
      'briefTitle', 'briefSteps', 'btnToPractice',
      'phaseBadge', 'taskStatus', 'progA', 'progB', 'taskStage',
      'pips', 'inputControls', 'btnUndo', 'btnSubmit', 'undoNote', 'feedback',
      'readyNote', 'btnToLive', 'reportBody', 'explainBody'
    ].forEach(function (id) { els[id] = document.getElementById(id); });
  }

  /* ---------- 과제 선택 화면 ---------- */
  function renderPicker() {
    var html = '';
    Tasks.list().forEach(function (d) {
      html +=
        '<button type="button" class="pick" data-task="' + d.id + '">' +
          '<span class="pick-label">' + d.label + '</span>' +
          '<span class="pick-sub">' + d.subtitle + '</span>' +
        '</button>';
    });
    els.pickList.innerHTML = html;

    els.pickList.addEventListener('click', function (e) {
      var b = e.target.closest('.pick');
      if (b) selectTask(Tasks.get(b.getAttribute('data-task')));
    });
  }

  /* ---------- 과제 선택 → 세션 생성 ---------- */
  function selectTask(desc) {
    if (!desc) return;
    state.desc = desc;

    els.taskLabel.textContent = desc.subtitle;

    els.cMeasures.innerHTML = desc.consent.measures;
    els.cScoring.innerHTML = desc.consent.scoring;
    els.cCollects.innerHTML = desc.consent.collects;

    els.briefTitle.textContent = desc.label;
    els.briefSteps.innerHTML = desc.brief.map(function (s, i) {
      return '<li><span class="num">' + (i + 1) + '</span>' +
             '<div><h3>' + s.h + '</h3><p>' + s.p + '</p></div></li>';
    }).join('');

    els.readyNote.innerHTML = desc.readyNote ||
      '본 시행에서는 정답 여부를 알려드리지 않습니다.';

    els.agree.checked = false;
    els.btnToTutorial.disabled = true;

    bootSession();
    App.show('screen-consent');
  }

  function bootSession() {
    var profile = Core.Device.profile(state.timing);
    state.session = Core.createSession(state.desc.id, profile);
    state.logger = new Core.Logger(state.session);
    state.rng = new Core.Rng(state.session.seed);
    els.sessionLabel.textContent = state.session.id;
    console.log('[session] 시작', state.session);
  }

  /* ---------- 상태 표시 ---------- */
  function renderPips(filled, total) {
    if (!total) { els.pips.innerHTML = ''; return; }
    var h = '';
    for (var i = 0; i < total; i++) {
      h += '<span class="pip' + (i < filled ? ' filled' : '') + '"></span>';
    }
    els.pips.innerHTML = h;
  }

  function renderControls(s) {
    var u = s.undo;
    var showing = !!(u && u.shown);
    els.inputControls.hidden = !showing;
    if (!showing) return;

    els.btnUndo.hidden = false;
    els.btnUndo.disabled = !u.ok;
    els.btnSubmit.hidden = s.kind !== 'confirm';

    if (s.kind === 'confirm') {
      els.undoNote.className = 'control-note live';
      els.undoNote.innerHTML =
        '<span class="grace"><span style="animation-duration:' + s.graceMs + 'ms"></span></span>';
    } else if (u.ok && isFinite(u.remaining)) {
      els.undoNote.className = 'control-note';
      els.undoNote.textContent = '수정 가능 ' + u.remaining + '회';
    } else {
      els.undoNote.className = 'control-note';
      els.undoNote.textContent = u.reason || '';
    }
  }

  /**
   * 과제가 방출하는 상태를 화면에 반영한다.
   * 과제마다 진행 표시의 의미가 달라 progA/progB로 추상화했다.
   *   Corsi  — 순서 길이 / 시행
   *   N-back — 라운드 / 자극 위치
   */
  function onStatus(s) {
    if (s.level != null) state.progA = '순서 길이 ' + s.level;
    if (s.index != null && s.total != null) state.progB = '자극 ' + s.index + ' / ' + s.total;
    else if (s.index != null) state.progB = '시행 ' + s.index;
    if (s.round != null) state.progA = s.round + '라운드';

    els.taskStatus.textContent = s.text;
    els.progA.textContent = state.progA || '—';
    els.progB.textContent = state.progB || '—';

    renderControls(s);

    var fb = els.feedback;

    switch (s.kind) {
      case 'input':
        renderPips(s.filled, s.total);
        fb.className = 'feedback info'; fb.textContent = '';
        break;
      case 'confirm':
        renderPips(s.filled, s.total);
        fb.className = 'feedback info'; fb.textContent = '';
        els.taskStatus.textContent = '입력 완료 — 확정 대기';
        break;
      case 'present':
        renderPips(0, 0);
        fb.className = 'feedback info'; fb.textContent = '';
        break;
      case 'respond':
      case 'warmup':
      case 'roundstart':
        renderPips(0, 0);
        fb.className = 'feedback info'; fb.textContent = '';
        break;
      case 'responded':
        fb.className = 'feedback info'; fb.textContent = s.text;
        break;
      case 'feedback':
        fb.className = 'feedback ' +
          (s.correct === true ? 'ok' : s.correct === false ? 'err' : 'info');
        fb.textContent = s.text;
        break;
      case 'timeout':
        renderPips(0, 0);
        fb.className = 'feedback err'; fb.textContent = s.text;
        break;
      case 'done':
        renderPips(0, 0);
        fb.className = 'feedback info'; fb.textContent = '';
        break;
      default:
        renderPips(0, 0);
        fb.className = 'feedback info'; fb.textContent = '';
    }
  }

  /* ---------- 과제 구동 ---------- */
  function makeTask(phase, seedShift) {
    return state.desc.create({
      stage: els.taskStage,
      rng: seedShift ? new Core.Rng(state.session.seed ^ seedShift) : state.rng,
      phase: phase,
      onTrial: function (t) { state.logger.logTrial(t); },
      onStatus: onStatus
    });
  }

  function destroyTask() {
    if (state.task && typeof state.task.destroy === 'function') state.task.destroy();
    state.task = null;
  }

  async function runPractice() {
    App.show('screen-task');
    els.phaseBadge.textContent = '연습';
    els.phaseBadge.classList.remove('live');
    state.progA = state.progB = null;

    destroyTask();
    state.task = makeTask('practice', 0x9E3779B9);   // 연습은 별도 시드 스트림
    await state.task.runPractice();
    destroyTask();

    App.show('screen-ready');
  }

  async function runLive() {
    App.show('screen-task');
    els.phaseBadge.textContent = '본 검사';
    els.phaseBadge.classList.add('live');
    state.progA = state.progB = null;
    state.liveFrom = Date.now();

    destroyTask();
    state.task = makeTask('live', 0);
    await state.task.runLive();
    destroyTask();

    state.liveTo = Date.now();
    finish();
  }

  /* ---------- 종료 ---------- */
  function finish() {
    state.session.finishedAt = new Date().toISOString();

    var liveTrials = state.logger.liveTrials();
    var raw = state.logger.toJSON();

    var ctx = {
      desc: state.desc,
      session: state.session,
      liveTrials: liveTrials,
      raw: raw,
      score: state.desc.score(liveTrials),
      errorProfile: Scoring.errorProfile(liveTrials),
      corrections: Scoring.inputCorrections(liveTrials),
      integrity: Scoring.integritySummary(
        state.logger.integrityEvents,
        { from: state.liveFrom, to: state.liveTo }
      )
    };

    console.log('[result] 채점 결과', ctx.score);
    console.log('[result] 원시 로그', raw);

    Report.render(els.reportBody, ctx);
    App.show('screen-report');
  }

  /* ---------- 초기화 ---------- */
  function init() {
    cacheEls();
    renderPicker();

    Core.Device.measureRefreshRate(500, function (timing) {
      state.timing = timing;
      console.log('[session] 추정 리프레시 레이트', timing);
    });

    /* ?task=<id> 로 바로 진입 가능 */
    var direct = Tasks.fromQuery();
    if (direct) selectTask(direct);

    els.agree.addEventListener('change', function () {
      els.btnToTutorial.disabled = !els.agree.checked;
    });

    els.btnToTutorial.addEventListener('click', function () {
      App.show('screen-tutorial');
    });

    els.btnToPractice.addEventListener('click', function () {
      if (!state.session) { alert('기기 프로파일 측정 중입니다. 잠시 후 다시 시도하세요.'); return; }
      runPractice();
    });

    els.btnToLive.addEventListener('click', runLive);

    /* 오입력 취소 / 확정 — 해당 기능이 있는 과제에서만 동작 */
    els.btnUndo.addEventListener('click', function () {
      if (state.task && state.task.undo) state.task.undo();
    });
    els.btnSubmit.addEventListener('click', function () {
      if (state.task && state.task.submit) state.task.submit();
    });

    document.addEventListener('keydown', function (e) {
      if (!state.task || !state.task.undo) return;
      if (!document.getElementById('screen-task').classList.contains('active')) return;
      if (e.key === 'Backspace') { e.preventDefault(); state.task.undo(); }
      else if (e.key === 'Enter') { e.preventDefault(); state.task.submit(); }
    });

    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-goto]');
      if (t) App.show(t.getAttribute('data-goto'));
    });
  }

  global.App = App;
  document.addEventListener('DOMContentLoaded', init);
})(window);

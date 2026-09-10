/* ============================================================
   app.js — 영상면접 응시 흐름
   고지 → 장비 점검 → 연습 → 본 면접(6문항) → 저장 확인 → 전사 정정 → 제출

   테스트 모드 (?test=1)
     지원되지 않는 단계를 건너뛰고 다음으로 갈 수 있다. 우회한 사실은
     session.bypasses에 남고 리포트에 빨간 띠가 뜬다 — 평가 자료로 오인되면 안 된다.
     ?fast=1 이면 준비 3초·답변 6초. ?test=1 만 주면 stt=fixture, scorer=mock 이 기본.
   ============================================================ */
(function (global) {
  'use strict';

  var App = {};
  var els = {};
  var state = {
    session: null, logger: null, store: null, recorder: null,
    testMode: false, fast: false, noMedia: false,
    liveFrom: null, liveTo: null, timer: null, step: 'consent'
  };

  var DEFAULT_PROVIDERS = { tts: 'webspeech', stt: 'null', scorer: 'pending', store: 'idb' };
  var TEST_PROVIDERS = { tts: 'null', stt: 'fixture', scorer: 'mock', store: 'idb' };
  var FAST = { prepMs: 3000, answerMs: 6000, practicePrepMs: 2000, practiceAnswerMs: 4000 };

  /* 단계 표시줄. key → 화면. 테스트 모드에서는 도달 가능한 단계로 바로 이동할 수 있다 */
  var STEPS = [
    { key: 'consent',    label: '1 고지',    screen: 'screen-consent' },
    { key: 'check',      label: '2 장비',    screen: 'screen-check' },
    { key: 'practice',   label: '3 연습',    screen: 'screen-question' },
    { key: 'live',       label: '4 본 면접', screen: 'screen-question' },
    { key: 'upload',     label: '5 저장',    screen: 'screen-upload' },
    { key: 'transcript', label: '6 전사',    screen: 'screen-transcript' },
    { key: 'done',       label: '7 제출',    screen: 'screen-done' },
    { key: 'report',     label: '8 기록',    screen: 'screen-report' }
  ];

  /* ---------- 유틸 ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function kb(n) { return n == null ? '—' : (n / 1024).toFixed(0) + ' KB'; }
  function query() {
    var q = {};
    (location.search || '').replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return; var p = kv.split('=');
      q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
    return q;
  }

  App.show = function (id) {
    Array.prototype.forEach.call(document.querySelectorAll('.screen'), function (s) {
      s.classList.toggle('active', s.id === id);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /* ---------- 단계 ---------- */
  function canJump(key) {
    if (!state.testMode) return false;
    var s = state.session;
    switch (key) {
      case 'consent': case 'check': return true;
      case 'practice': case 'live': return !!s;
      case 'upload': case 'transcript': return !!(s && s.answers.length);
      case 'done': case 'report': return !!(s && s.submittedAt);
      default: return false;
    }
  }

  function setStep(key) {
    state.step = key;
    var idx = STEPS.findIndex(function (s) { return s.key === key; });
    els.stepLabel.textContent = (STEPS[idx] || {}).label || key;
    els.stepper.innerHTML = STEPS.map(function (s, i) {
      var cls = i < idx ? 'done' : (i === idx ? 'on' : '');
      var by = state.session && (state.session.bypasses || []).some(function (b) { return b.gate === s.key; });
      if (by) cls += ' skipped';
      if (canJump(s.key) && i !== idx) cls += ' jump';
      return '<li class="' + cls + '" data-step="' + s.key + '">' + esc(s.label) + '</li>';
    }).join('');
  }

  function jumpTo(key) {
    if (!canJump(key)) return;
    if (key === 'practice') { runPractice(); return; }
    if (key === 'live') { runLive(); return; }
    if (key === 'upload') { renderUpload(); App.show('screen-upload'); return; }
    if (key === 'transcript') { renderTranscripts(); App.show('screen-transcript'); return; }
    if (key === 'report') { InterviewReport.render(els.reportBody, reportCtx()); setStep('report'); App.show('screen-report'); return; }
    var st = STEPS.find(function (s) { return s.key === key; });
    setStep(key); App.show(st.screen);
  }

  /** 우회 기록 — 테스트 모드의 모든 건너뛰기는 여기를 지난다 */
  function bypass(gate, reason) {
    if (!state.session) bootSession(null);
    state.session.bypasses = state.session.bypasses || [];
    state.session.bypasses.push({ gate: gate, reason: reason, at: new Date().toISOString() });
    persist();
  }

  /* ---------- 공급자 패널 ---------- */
  function renderProviders() {
    var kinds = { tts: '질문 음성', stt: '음성 → 텍스트', scorer: '채점', store: '저장' };
    els.providerPanel.innerHTML = Providers.summary().map(function (p) {
      var x = p.external ? '외부 전송됨' + (p.devOnly ? ' · 개발 확인용 — 운영 금지' : '')
                         : '외부 전송 없음' + (p.devOnly ? ' · 테스트용' : '');
      return '<div class="prov' + (p.external ? ' external' : '') + '">' +
               '<span class="k">' + esc(kinds[p.kind]) + '</span>' +
               '<span class="v">' + esc(p.label) + '</span>' +
               '<span class="x">' + esc(x) + '</span></div>';
    }).join('');
  }

  /* ---------- 세션 ---------- */
  function bootSession(timing) {
    if (state.session) return state.session;
    var profile = Core.Device.profile(timing);
    var base = Core.createSession('video-interview', profile);
    var s = Object.assign(base, {
      kind: 'video-interview',
      testMode: state.testMode,
      bypasses: [],
      candidateRef: null,
      names: (Providers.get('stt').id === 'fixture' && global.Fixtures) ? global.Fixtures.names.slice() : [],
      jobId: 'placeholder',
      questionSetVersion: Questions.SET.version,
      rubricVersion: Questions.RUBRIC.version,
      contentFingerprint: Questions.fingerprint(),
      providers: Providers.summary(),
      consent: { recording: true, autoScoring: true, retentionDays: Retention.POLICY, at: new Date().toISOString() },
      hiringClosedAt: null, retention: null, deviceCheck: null,
      answers: [], score: null, submittedAt: null
    });
    s.retention = Retention.plan(s);
    state.session = s;
    state.logger = new Core.Logger(s);
    els.sessionLabel.textContent = s.id + (state.testMode ? ' · TEST' : '');
    return s;
  }

  async function persist() {
    if (!state.session) return;
    try {
      var copy = JSON.parse(JSON.stringify(state.session));
      copy.integrityEvents = state.logger ? state.logger.integrityEvents : [];
      await state.store.putSession(copy);
    } catch (e) { console.warn('[store] 세션 저장 실패', e); }
  }

  /* ---------- 장비 점검 ---------- */
  var check = {
    perm:  { label: '카메라·마이크 권한', status: 'wait', detail: '' },
    video: { label: '영상 입력', status: 'wait', detail: '' },
    codec: { label: '녹화 코덱', status: 'wait', detail: '' },
    audio: { label: '음성 입력 (말해서 확인)', status: 'wait', detail: '' },
    net:   { label: '네트워크', status: 'wait', detail: '프로토타입 — 서버 없음, 측정 안 함' }
  };
  function checkItems() { return [check.perm, check.video, check.codec, check.audio, check.net]; }
  function renderCheck() {
    els.checkList.innerHTML = checkItems().map(function (i) {
      return '<div class="check-item"><span class="st ' + i.status + '">' +
        (i.status === 'ok' ? '통과' : i.status === 'err' ? '실패' : '대기') +
        '</span><span>' + esc(i.label) + '</span><span class="d">' + esc(i.detail || '') + '</span></div>';
    }).join('');
  }

  async function acquire() {
    if (!state.recorder.supported()) {
      check.perm.status = 'err'; check.perm.detail = '이 브라우저는 녹화를 지원하지 않습니다';
      renderCheck(); return;
    }
    try {
      var info = await state.recorder.acquire();
      check.perm.status = 'ok';
      check.video.status = info.video ? 'ok' : 'err';
      check.video.detail = info.video ? (info.video.width + '×' + info.video.height + ' @' + Math.round(info.video.frameRate || 0)) : '';
      check.codec.status = info.mime ? 'ok' : 'err';
      check.codec.detail = info.mime || '지원 코덱 없음';
      els.checkVideo.srcObject = state.recorder.stream;
      els.btnAudioTest.disabled = false;
      state.session.deviceCheck = { video: info.video, audio: info.audio, mime: info.mime };
    } catch (e) {
      check.perm.status = 'err'; check.perm.detail = e.name || String(e);
    }
    renderCheck();
  }

  async function audioTest() {
    els.btnAudioTest.disabled = true;
    check.audio.status = 'wait'; check.audio.detail = '5초간 말씀해 주세요'; renderCheck();
    state.recorder.onLevel = function (rms, sp) { meter(els.checkMeter, rms, sp); };
    var r = await state.recorder.checkAudio(5000);
    meter(els.checkMeter, 0, false);
    check.audio.status = r.ok ? 'ok' : 'err';
    check.audio.detail = r.ok ? ('peak ' + r.peak) : '소리가 감지되지 않음 (peak ' + r.peak + ')';
    state.session.deviceCheck = state.session.deviceCheck || {};
    state.session.deviceCheck.audioTest = r;
    renderCheck();
    els.btnAudioTest.disabled = false;
    els.btnToPractice.disabled = !(check.perm.status === 'ok' && check.audio.status === 'ok' && check.codec.status === 'ok');
  }

  function meter(el, rms, speaking) {
    el.style.transform = 'scaleX(' + Math.min(1, rms / 0.25).toFixed(3) + ')';
    el.classList.toggle('speaking', !!speaking);
  }

  /* ---------- 타이머 ---------- */
  function runTimer(ms, label, cls) {
    return new Promise(function (resolve) {
      var fill = els.timerFill;
      els.timerLabel.textContent = label;
      fill.className = 'nb-timer-fill ' + cls;
      fill.style.animationDuration = ms + 'ms';
      void fill.offsetWidth;
      fill.classList.add('nb-run');
      var t0 = performance.now();
      function tick() {
        var left = Math.max(0, ms - (performance.now() - t0));
        els.timerLeft.textContent = (left / 1000).toFixed(1) + 's';
        if (left <= 0) { stop(); resolve('elapsed'); }
      }
      var id = setInterval(tick, 100); tick();
      function stop() { clearInterval(id); fill.classList.remove('nb-run'); state.timer = null; }
      state.timer = { skip: function (why) { stop(); resolve(why || 'skipped'); } };
    });
  }

  /* ---------- 문항 1개 ----------
     녹화가 불가능하면(장비 없음·우회) 타이머와 전사 흐름만 돌리고 미디어는 비운다. */
  async function runQuestion(q, phase, index, total) {
    var isPractice = phase === 'practice';
    var prepMs = state.fast ? (isPractice ? FAST.practicePrepMs : FAST.prepMs) : (q.prepMs || Questions.SET.prepMs);
    var answerMs = state.fast ? (isPractice ? FAST.practiceAnswerMs : FAST.answerMs) : (q.answerMs || Questions.SET.answerMs);
    var canRecord = !state.noMedia && state.recorder && state.recorder.stream;

    App.show('screen-question');
    setStep(isPractice ? 'practice' : 'live');
    els.phaseBadge.textContent = isPractice ? '연습' : '본 면접';
    els.phaseBadge.classList.toggle('live', !isPractice);
    els.qProgress.textContent = isPractice ? '연습 문항' : ('문항 ' + index + ' / ' + total);
    els.qText.textContent = q.text;
    els.liveVideo.srcObject = canRecord ? state.recorder.stream : null;
    els.recBadge.hidden = true;
    els.btnStartAnswer.hidden = true; els.btnStopAnswer.hidden = true;
    els.btnSkipQuestion.hidden = !state.testMode;
    els.qFeedback.textContent = canRecord ? '' : '녹화 없음 — 타이머와 전사 흐름만 진행됩니다 (기록됨)';
    if (canRecord) state.recorder.onLevel = function (rms, sp) { meter(els.liveMeter, rms, sp); };

    var skipped = false;
    els.btnSkipQuestion.onclick = function () { skipped = true; if (state.timer) state.timer.skip('bypassed'); };

    els.qStatus.textContent = '질문을 읽어드립니다';
    var spoken = await Providers.get('tts').speak(q.text);

    els.qStatus.textContent = '준비 시간';
    els.btnStartAnswer.hidden = false;
    var prepStart = Date.now();
    var prepEnd = skipped ? 'bypassed' : await runTimer(prepMs, '준비 시간', 'prep');
    els.btnStartAnswer.hidden = true;
    var prepUsedMs = Date.now() - prepStart;

    var answerStart = Date.now();
    var rec = null, sttHandle = null, answerEnd = 'bypassed';
    if (!skipped) {
      els.qStatus.textContent = canRecord ? '답변 중 — 녹화됩니다' : '답변 중 — 녹화 없음';
      els.recBadge.hidden = !canRecord;
      els.btnStopAnswer.hidden = false;
      rec = canRecord ? state.recorder.startRecording(state.session.id, q.id) : null;
      var stt = Providers.get('stt');
      sttHandle = stt.available() ? stt.start({ lang: 'ko-KR', questionId: q.id, questionText: q.text }) : null;
      answerEnd = await runTimer(answerMs, '답변 시간', '');
    }
    els.btnStopAnswer.hidden = true; els.recBadge.hidden = true;
    els.qStatus.textContent = '저장 중…';

    var summary = rec ? await rec.stop() : {
      durationMs: Date.now() - answerStart, chunks: 0, bytes: 0, mime: null, complete: false, gaps: [], failed: [],
      speech: { firstSpeechDelayMs: null, speechDurationMs: null, silenceRatio: null, frames: 0, spoke: null }
    };
    var transcript = sttHandle ? await sttHandle.stop() : null;
    if (canRecord) meter(els.liveMeter, 0, false);

    var answer = {
      questionId: q.id, questionType: q.type, phase: phase,
      prepMs: prepUsedMs, prepEnded: prepEnd,
      answerMs: summary.durationMs, answerEnded: skipped ? 'bypassed' : answerEnd,
      questionSpoken: !!spoken.spoken,
      mediaRef: rec ? { store: state.store.id, sessionId: state.session.id, questionId: q.id } : null,
      media: { chunks: summary.chunks, bytes: summary.bytes, mime: summary.mime, complete: summary.complete,
               gaps: summary.gaps, failed: summary.failed, skipped: rec ? null : (skipped ? 'bypassed' : 'no_media') },
      transcript: transcript ? {
        raw: transcript.text, corrected: null, words: transcript.words,
        meanConfidence: transcript.meanConfidence, lowConfidenceRatio: transcript.lowConfidenceRatio,
        provider: transcript.provider, corrections: []
      } : null,
      behavioral: Object.assign({}, summary.speech,
        transcript ? Transcript.speechMetrics(transcript.words, summary.durationMs) : { wordCount: null, wordsPerMin: null }),
      tsClient: answerStart
    };
    if (skipped) bypass(isPractice ? 'practice' : 'live', 'question_skipped:' + q.id);

    if (isPractice) state.session.practice = answer; else state.session.answers.push(answer);
    await persist();

    els.qFeedback.textContent = skipped ? '건너뜀 (기록됨)' : rec ? (summary.complete ? '저장되었습니다' : '일부 구간 저장 실패 — 기록됨') : '녹화 없이 기록되었습니다';
    await sleep(state.fast ? 300 : 900);
    return answer;
  }

  /* ---------- 연습 ---------- */
  async function runPractice() {
    bootSession(null);
    var a = await runQuestion(Questions.SET.practice, 'practice');
    var asm = a.mediaRef ? await state.store.assemble(state.session.id, a.questionId) : null;
    els.practicePlayback.hidden = !(asm && asm.blob);
    if (asm && asm.blob) els.practicePlayback.src = URL.createObjectURL(asm.blob);
    els.practiceMeta.innerHTML =
      '<span class="chip">' + (a.mediaRef ? '구간 ' + a.media.chunks + '개 · ' + kb(a.media.bytes) : '녹화 없음 · ' + esc(a.media.skipped)) + '</span>' +
      '<span class="chip' + (a.behavioral.spoke === false ? ' flag' : '') + '">' +
        (a.behavioral.spoke ? '발화 감지됨 · 첫 발화 ' + a.behavioral.firstSpeechDelayMs + 'ms' : a.behavioral.spoke === false ? '발화 감지 안 됨' : '발화 측정 없음') + '</span>' +
      '<span class="chip">' + (a.transcript ? '전사 있음 (' + esc(a.transcript.provider) + ')' : '전사 없음') + '</span>';
    els.btnSkipLive.hidden = !state.testMode;
    App.show('screen-practice-done');
  }

  /* ---------- 본 면접 ---------- */
  async function runLive() {
    bootSession(null);
    state.liveFrom = Date.now();
    var items = Questions.SET.items;
    for (var i = 0; i < items.length; i++) await runQuestion(items[i], 'live', i + 1, items.length);
    state.liveTo = Date.now();
    renderUpload(); App.show('screen-upload');
  }

  /** 픽스처로 채우기 — 녹화 없이 뒤쪽 화면으로 */
  async function seedFromFixtures(gate) {
    bootSession(null);
    if (!global.Fixtures) { alert('fixtures.js가 없습니다'); return; }
    state.session.names = global.Fixtures.names.slice();
    state.session.answers = global.Fixtures.seedAnswers(Questions.SET);
    state.liveFrom = Date.now() - 6 * 60000; state.liveTo = Date.now();
    bypass(gate, 'seeded_from_fixtures');
    await persist();
    renderUpload(); App.show('screen-upload');
  }

  /* ---------- 저장 확인 ---------- */
  function renderUpload() {
    setStep('upload');
    var rows = state.session.answers.map(function (a, i) {
      var save = a.media.skipped
        ? '<span class="chip flag">녹화 없음 · ' + esc(a.media.skipped) + '</span>'
        : '<span class="tag ' + (a.media.complete ? 'ok">완전' : 'err">누락 ' + a.media.gaps.length) + '</span>';
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(a.questionType) + '</td>' +
        '<td>' + (a.answerMs / 1000).toFixed(1) + 's</td><td>' + a.media.chunks + '</td><td>' + kb(a.media.bytes) + '</td>' +
        '<td>' + save + '</td>' +
        '<td>' + (a.transcript ? (a.transcript.meanConfidence == null ? '있음' : '신뢰도 ' + a.transcript.meanConfidence) : '—') + '</td></tr>';
    }).join('');
    els.uploadTable.innerHTML = '<thead><tr><th>#</th><th>유형</th><th>길이</th><th>구간</th><th>용량</th><th>저장</th><th>전사</th></tr></thead><tbody>' + rows + '</tbody>';
    var bad = state.session.answers.filter(function (a) { return !a.media.complete && !a.media.skipped; });
    var none = state.session.answers.filter(function (a) { return a.media.skipped; });
    els.uploadWarn.hidden = !(bad.length || none.length);
    els.uploadWarn.innerHTML =
      (bad.length ? '<strong>' + bad.length + '개 답변의 일부 구간이 저장되지 않았습니다.</strong> 운영에서는 재응시 경로가 열립니다 (D-4). ' : '') +
      (none.length ? '<strong>' + none.length + '개 답변은 녹화 없이 기록되었습니다</strong> (테스트 우회). 평가 자료로 쓸 수 없습니다.' : '');
  }

  /* ---------- 전사 확인 · 정정 ---------- */
  function renderTranscripts() {
    setStep('transcript');
    els.transcriptList.innerHTML = state.session.answers.map(function (a, i) {
      var q = Questions.SET.items[i]; var t = a.transcript;
      var head = '<div class="tr-head"><span class="q">' + (i + 1) + '. ' + esc(q.text) + '</span>' +
        '<span class="m">' + (t && t.meanConfidence != null ? '신뢰도 ' + t.meanConfidence + (t.meanConfidence < 0.6 ? ' <span class="tr-low">낮음</span>' : '') : '') + '</span></div>';
      if (!t) return '<div class="tr-item">' + head + '<p class="tr-empty">전사가 없습니다 — STT가 연결되지 않았습니다. 자동채점 대상에서 제외됩니다.</p></div>';
      var left = Transcript.POLICY.maxAttempts - t.corrections.length;
      return '<div class="tr-item" data-i="' + i + '">' + head +
        '<div class="tr-raw">' + esc(t.raw || '(인식된 내용 없음)') + '</div>' +
        '<textarea class="tr-edit" id="tr-' + i + '"' + (left <= 0 ? ' disabled' : '') + '>' + esc(t.corrected != null ? t.corrected : t.raw) + '</textarea>' +
        '<div class="tr-foot"><button class="btn small" data-save="' + i + '"' + (left <= 0 ? ' disabled' : '') + '>정정 저장</button>' +
        '<span class="note" id="trn-' + i + '">허용 ' + Transcript.editCap(t.raw) + '자 · 남은 기회 ' + left + '회</span></div></div>';
    }).join('');

    els.transcriptList.onclick = function (e) {
      var b = e.target.closest('[data-save]'); if (!b) return;
      var i = parseInt(b.getAttribute('data-save'), 10);
      var t = state.session.answers[i].transcript;
      var r = Transcript.evaluateCorrection(t.raw, $('tr-' + i).value, t.corrections);
      t.corrections.push(r.record);
      var note = $('trn-' + i);
      if (r.accepted) { t.corrected = $('tr-' + i).value; note.className = 'note ok'; note.textContent = '저장됨 · 편집거리 ' + r.record.editDistance + '/' + r.record.cap; }
      else { note.className = 'note err'; note.textContent = r.reason; }
      if (Transcript.POLICY.maxAttempts - t.corrections.length <= 0) { $('tr-' + i).disabled = true; b.disabled = true; }
      persist();
    };
  }

  /* ---------- 제출 ---------- */
  async function submit() {
    setStep('done');
    state.session.submittedAt = new Date().toISOString();
    state.session.finishedAt = state.session.submittedAt;
    state.session.score = await Providers.get('scorer').score({ session: state.session, rubric: Questions.RUBRIC, questions: Questions.SET });
    await persist();
    var s = state.session;
    els.doneTable.innerHTML = '<tbody>' +
      row('접수번호', s.id + (s.testMode ? ' (테스트 모드)' : '')) +
      row('영상 보관', '~' + s.retention.media.slice(0, 10) + ' (' + (s.retention.basis === 'hiring_closed' ? '채용 종료 기준' : '임시 · 채용 종료 시 재계산') + ')') +
      row('전사 보관', '~' + s.retention.transcript.slice(0, 10)) +
      row('자동 채점', s.score.status === 'pending' ? '보류 — ' + s.score.reason : s.score.status + ' (' + s.score.modelId + ')') +
      row('우회 기록', (s.bypasses || []).length ? (s.bypasses.length + '건 — 평가 자료로 사용 불가') : '없음') +
      row('권리 행사', '설명 요구 · 인적 재검토 · 삭제 — 기록 보기 화면에서') + '</tbody>';
    setStep('done');
    App.show('screen-done');
    function row(k, v) { return '<tr><td>' + esc(k) + '</td><td class="seq">' + esc(v) + '</td></tr>'; }
  }

  function reportCtx() {
    return {
      session: state.session,
      raw: { integrityEvents: state.logger ? state.logger.integrityEvents : [] },
      integrity: Scoring.integritySummary(state.logger ? state.logger.integrityEvents : [], { from: state.liveFrom, to: state.liveTo }),
      store: state.store, app: App
    };
  }

  /* ---------- 초기화 ---------- */
  async function init() {
    ['stepLabel', 'sessionLabel', 'stepper', 'testBanner', 'testFlags', 'providerPanel', 'retMedia', 'retTranscript',
     'agreeRecord', 'agreeRetention', 'btnToCheck', 'btnSeedFixture', 'btnSkipConsent',
     'checkVideo', 'checkMeter', 'checkList', 'btnAcquire', 'btnAudioTest', 'btnSkipCheck', 'btnToPractice',
     'phaseBadge', 'qStatus', 'qProgress', 'qText', 'liveVideo', 'recBadge', 'liveMeter',
     'timerLabel', 'timerLeft', 'timerFill', 'btnStartAnswer', 'btnStopAnswer', 'btnSkipQuestion', 'qFeedback',
     'practicePlayback', 'practiceMeta', 'btnSkipLive', 'btnToLive',
     'uploadTable', 'uploadWarn', 'btnToTranscript', 'transcriptList', 'btnSubmit',
     'doneTable', 'btnErase', 'btnDownload', 'btnReport', 'reportBody', 'explainBody',
     'manualQ', 'manualText', 'btnManualSave', 'btnManualSkip'
    ].forEach(function (id) { els[id] = $(id); });

    var q = query();
    state.testMode = q.test === '1' || q.test === 'true';
    state.fast = q.fast === '1' || q.fast === 'true';

    Providers.fromQuery(state.testMode ? TEST_PROVIDERS : DEFAULT_PROVIDERS);
    state.store = Providers.get('store');
    renderProviders();

    if (state.testMode) {
      els.testBanner.hidden = false;
      els.testFlags.textContent = 'stt=' + Providers.get('stt').id + ' · scorer=' + Providers.get('scorer').id + (state.fast ? ' · fast' : '');
      Array.prototype.forEach.call(document.querySelectorAll('.test-only'), function (b) { b.hidden = false; });
    }
    setStep('consent');

    var problems = Questions.validate();
    if (problems.length) console.error('[questions] 문항/루브릭 불일치', problems);
    els.retMedia.textContent = Retention.POLICY.mediaDays;
    els.retTranscript.textContent = Retention.POLICY.transcriptDays;

    try { var purged = await state.store.purgeExpired(); if (purged.length) console.log('[store] 만료 파기', purged); }
    catch (e) { console.warn('[store] 파기 배치 실패', e); }

    var timing = null;
    Core.Device.measureRefreshRate(400, function (t) { timing = t; });

    function agree() { els.btnToCheck.disabled = !(els.agreeRecord.checked && els.agreeRetention.checked); }
    els.agreeRecord.addEventListener('change', agree);
    els.agreeRetention.addEventListener('change', agree);

    function toCheck() {
      bootSession(timing);
      state.recorder = new Recorder({ store: state.store });
      renderCheck(); setStep('check'); App.show('screen-check');
    }
    els.btnToCheck.addEventListener('click', toCheck);
    els.btnSkipConsent.addEventListener('click', function () { bypass('consent', 'consent_skipped'); toCheck(); });
    els.btnSeedFixture.addEventListener('click', function () { seedFromFixtures('live'); });

    els.btnAcquire.addEventListener('click', acquire);
    els.btnAudioTest.addEventListener('click', audioTest);
    els.btnSkipCheck.addEventListener('click', function () {
      state.noMedia = true;
      bypass('check', 'device_check_skipped:' + checkItems().filter(function (c) { return c.status !== 'ok'; }).map(function (c) { return c.label; }).join(','));
      runPractice();
    });
    els.btnToPractice.addEventListener('click', runPractice);
    els.btnToLive.addEventListener('click', runLive);
    els.btnSkipLive.addEventListener('click', function () { seedFromFixtures('live'); });
    els.btnStartAnswer.addEventListener('click', function () { if (state.timer) state.timer.skip('started_early'); });
    els.btnStopAnswer.addEventListener('click', function () { if (state.timer) state.timer.skip('stopped_early'); });
    els.btnToTranscript.addEventListener('click', function () { renderTranscripts(); App.show('screen-transcript'); });
    els.btnSubmit.addEventListener('click', submit);

    els.btnDownload.addEventListener('click', function () {
      var data = JSON.parse(JSON.stringify(state.session));
      data.integrityEvents = state.logger ? state.logger.integrityEvents : [];
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = state.session.id + '.json'; a.click();
      URL.revokeObjectURL(a.href);
    });
    els.btnErase.addEventListener('click', async function () {
      var n = await state.store.eraseSession(state.session.id);
      alert('삭제 요청이 처리되었습니다. 영상 구간 ' + n + '개와 세션 기록을 지웠습니다.');
    });
    els.btnReport.addEventListener('click', function () { jumpToReport(); });
    function jumpToReport() { InterviewReport.render(els.reportBody, reportCtx()); setStep('report'); App.show('screen-report'); }

    els.stepper.addEventListener('click', function (e) {
      var li = e.target.closest('[data-step]'); if (!li) return;
      jumpTo(li.getAttribute('data-step'));
    });

    Providers.ui.manualTranscript = function (questionText) {
      return new Promise(function (resolve) {
        els.manualQ.textContent = questionText || ''; els.manualText.value = '';
        App.show('screen-manual');
        function done(v) { els.btnManualSave.onclick = null; els.btnManualSkip.onclick = null; App.show('screen-question'); resolve(v); }
        els.btnManualSave.onclick = function () { done(els.manualText.value); };
        els.btnManualSkip.onclick = function () { done(null); };
      });
    };

    App.saveHumanScore = async function (hs) { state.session.humanScore = hs; await persist(); };

    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-goto]');
      if (t) App.show(t.getAttribute('data-goto'));
    });
    window.addEventListener('beforeunload', function () { if (state.recorder) state.recorder.release(); });
  }

  global.InterviewApp = App;
  document.addEventListener('DOMContentLoaded', init);
})(window);

/* ============================================================
   app.js — 영상면접 응시 흐름
   고지 → 장비 점검 → 연습 → 본 면접(6문항) → 저장 확인 → 전사 정정 → 제출
   ============================================================ */
(function (global) {
  'use strict';

  var App = {};
  var els = {};
  var state = {
    session: null,
    logger: null,
    store: null,
    recorder: null,
    liveFrom: null,
    liveTo: null,
    timer: null
  };

  var DEFAULT_PROVIDERS = { tts: 'webspeech', stt: 'null', scorer: 'pending', store: 'idb' };

  /* ---------- 유틸 ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function kb(n) { return n == null ? '—' : (n / 1024).toFixed(0) + ' KB'; }

  App.show = function (id) {
    Array.prototype.forEach.call(document.querySelectorAll('.screen'), function (s) {
      s.classList.toggle('active', s.id === id);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  function setStep(t) { els.stepLabel.textContent = t; }

  /* ---------- 공급자 패널 ----------
     무엇이 꽂혀 있고 외부로 나가는지 고지 화면에 그대로 보인다. */
  function renderProviders() {
    var kinds = { tts: '질문 음성', stt: '음성 → 텍스트', scorer: '채점', store: '저장' };
    els.providerPanel.innerHTML = Providers.summary().map(function (p) {
      var x = p.external
        ? '외부 전송됨' + (p.devOnly ? ' · 개발 확인용 — 운영 금지' : '')
        : '외부 전송 없음';
      return '<div class="prov' + (p.external ? ' external' : '') + '">' +
               '<span class="k">' + esc(kinds[p.kind]) + '</span>' +
               '<span class="v">' + esc(p.label) + '</span>' +
               '<span class="x">' + esc(x) + '</span>' +
             '</div>';
    }).join('');
  }

  /* ---------- 세션 ---------- */
  function bootSession(timing) {
    var profile = Core.Device.profile(timing);
    var base = Core.createSession('video-interview', profile);
    var s = Object.assign(base, {
      kind: 'video-interview',
      candidateRef: null,                    // 직접 식별자는 여기 두지 않는다
      /* 마스킹용 이름. 고정 전사로 테스트할 때는 픽스처의 이름을 써야 마스킹이 보인다 */
      names: (Providers.get('stt').id === 'fixture' && global.Fixtures) ? global.Fixtures.names.slice() : [],
      jobId: 'placeholder',
      questionSetVersion: Questions.SET.version,
      rubricVersion: Questions.RUBRIC.version,
      contentFingerprint: Questions.fingerprint(),
      providers: Providers.summary(),
      consent: {
        recording: true, autoScoring: true,
        retentionDays: Retention.POLICY, at: new Date().toISOString()
      },
      hiringClosedAt: null,
      retention: null,
      deviceCheck: null,
      answers: [],
      score: null,
      submittedAt: null
    });
    s.retention = Retention.plan(s);
    state.session = s;
    state.logger = new Core.Logger(s);
    els.sessionLabel.textContent = s.id;
    return s;
  }

  async function persist() {
    try {
      var copy = JSON.parse(JSON.stringify(state.session));
      copy.integrityEvents = state.logger.integrityEvents;
      await state.store.putSession(copy);
    } catch (e) { console.warn('[store] 세션 저장 실패', e); }
  }

  /* ---------- 장비 점검 ---------- */
  function checkRow(label, status, detail) {
    return '<div class="check-item"><span class="st ' + status + '">' +
           (status === 'ok' ? '통과' : status === 'err' ? '실패' : '대기') +
           '</span><span>' + esc(label) + '</span><span class="d">' + esc(detail || '') + '</span></div>';
  }

  function renderCheck(items) {
    els.checkList.innerHTML = items.map(function (i) { return checkRow(i.label, i.status, i.detail); }).join('');
  }

  var check = {
    perm: { label: '카메라·마이크 권한', status: 'wait', detail: '' },
    video: { label: '영상 입력', status: 'wait', detail: '' },
    codec: { label: '녹화 코덱', status: 'wait', detail: '' },
    audio: { label: '음성 입력 (말해서 확인)', status: 'wait', detail: '' },
    net: { label: '네트워크', status: 'wait', detail: '프로토타입 — 서버 없음, 측정 안 함' }
  };

  function checkItems() { return [check.perm, check.video, check.codec, check.audio, check.net]; }

  async function acquire() {
    if (!state.recorder.supported()) {
      check.perm.status = 'err'; check.perm.detail = '이 브라우저는 녹화를 지원하지 않습니다';
      renderCheck(checkItems()); return;
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
    renderCheck(checkItems());
  }

  async function audioTest() {
    els.btnAudioTest.disabled = true;
    check.audio.status = 'wait'; check.audio.detail = '5초간 말씀해 주세요';
    renderCheck(checkItems());
    state.recorder.onLevel = function (rms, speaking) { meter(els.checkMeter, rms, speaking); };
    var r = await state.recorder.checkAudio(5000);
    meter(els.checkMeter, 0, false);
    check.audio.status = r.ok ? 'ok' : 'err';
    check.audio.detail = r.ok ? ('peak ' + r.peak) : '소리가 감지되지 않음 (peak ' + r.peak + ')';
    state.session.deviceCheck.audioTest = r;
    renderCheck(checkItems());
    els.btnAudioTest.disabled = false;
    els.btnToPractice.disabled = !(check.perm.status === 'ok' && check.audio.status === 'ok' && check.codec.status === 'ok');
  }

  function meter(el, rms, speaking) {
    var v = Math.min(1, rms / 0.25);
    el.style.transform = 'scaleX(' + v.toFixed(3) + ')';
    el.classList.toggle('speaking', !!speaking);
  }

  /* ---------- 타이머 ---------- */
  function runTimer(ms, label, cls, onTick) {
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
        if (onTick) onTick(left);
        if (left <= 0) { stop(); resolve('elapsed'); }
      }
      var id = setInterval(tick, 100);
      tick();
      function stop() { clearInterval(id); fill.classList.remove('nb-run'); state.timer = null; }
      state.timer = { skip: function (why) { stop(); resolve(why || 'skipped'); } };
    });
  }

  /* ---------- 문항 1개 ---------- */
  async function runQuestion(q, phase, index, total) {
    var prepMs = q.prepMs || Questions.SET.prepMs;
    var answerMs = q.answerMs || Questions.SET.answerMs;

    App.show('screen-question');
    els.phaseBadge.textContent = phase === 'practice' ? '연습' : '본 면접';
    els.phaseBadge.classList.toggle('live', phase === 'live');
    els.qProgress.textContent = phase === 'practice' ? '연습 문항' : ('문항 ' + index + ' / ' + total);
    els.qText.textContent = q.text;
    els.liveVideo.srcObject = state.recorder.stream;
    els.recBadge.hidden = true;
    els.btnStartAnswer.hidden = true;
    els.btnStopAnswer.hidden = true;
    els.qFeedback.textContent = '';
    state.recorder.onLevel = function (rms, sp) { meter(els.liveMeter, rms, sp); };

    /* 질문 읽기 */
    els.qStatus.textContent = '질문을 읽어드립니다';
    var tts = Providers.get('tts');
    var spoken = await tts.speak(q.text);

    /* 준비 시간 */
    els.qStatus.textContent = '준비 시간';
    els.btnStartAnswer.hidden = false;
    var prepStart = Date.now();
    var prepEnd = await runTimer(prepMs, '준비 시간', 'prep');
    els.btnStartAnswer.hidden = true;
    var prepUsedMs = Date.now() - prepStart;

    /* 답변 · 녹화 */
    els.qStatus.textContent = '답변 중 — 녹화됩니다';
    els.recBadge.hidden = false;
    els.btnStopAnswer.hidden = false;

    var answerStart = Date.now();
    var rec = state.recorder.startRecording(state.session.id, q.id);
    var stt = Providers.get('stt');
    var sttHandle = stt.available() ? stt.start({ lang: 'ko-KR', questionId: q.id, questionText: q.text }) : null;

    var answerEnd = await runTimer(answerMs, '답변 시간', '');
    els.btnStopAnswer.hidden = true;
    els.recBadge.hidden = true;
    els.qStatus.textContent = '저장 중…';

    var summary = await rec.stop();
    var transcript = sttHandle ? await sttHandle.stop() : null;
    meter(els.liveMeter, 0, false);

    var answer = {
      questionId: q.id,
      questionType: q.type,
      phase: phase,
      prepMs: prepUsedMs,
      prepEnded: prepEnd,
      answerMs: summary.durationMs,
      answerEnded: answerEnd,
      questionSpoken: !!spoken.spoken,
      mediaRef: { store: state.store.id, sessionId: state.session.id, questionId: q.id },
      media: {
        chunks: summary.chunks, bytes: summary.bytes, mime: summary.mime,
        complete: summary.complete, gaps: summary.gaps, failed: summary.failed
      },
      transcript: transcript ? {
        raw: transcript.text,
        corrected: null,
        words: transcript.words,
        meanConfidence: transcript.meanConfidence,
        lowConfidenceRatio: transcript.lowConfidenceRatio,
        provider: transcript.provider,
        corrections: []
      } : null,
      behavioral: Object.assign({}, summary.speech, transcript
        ? Transcript.speechMetrics(transcript.words, summary.durationMs)
        : { wordCount: null, wordsPerMin: null }),
      tsClient: answerStart
    };

    if (phase === 'live') state.session.answers.push(answer);
    else state.session.practice = answer;
    await persist();

    els.qFeedback.textContent = summary.complete ? '저장되었습니다' : '일부 구간 저장 실패 — 기록됨';
    await sleep(900);
    return answer;
  }

  /* ---------- 연습 ---------- */
  async function runPractice() {
    setStep('연습');
    var a = await runQuestion(Questions.SET.practice, 'practice');
    var asm = await state.store.assemble(state.session.id, a.questionId);
    if (asm && asm.blob) {
      els.practicePlayback.src = URL.createObjectURL(asm.blob);
    }
    els.practiceMeta.innerHTML =
      '<span class="chip">구간 ' + a.media.chunks + '개 · ' + kb(a.media.bytes) + '</span>' +
      '<span class="chip">' + esc(a.media.mime || '') + '</span>' +
      '<span class="chip' + (a.behavioral.spoke ? '' : ' flag') + '">' +
        (a.behavioral.spoke ? '발화 감지됨 · 첫 발화 ' + a.behavioral.firstSpeechDelayMs + 'ms' : '발화 감지 안 됨') + '</span>' +
      '<span class="chip">' + (a.transcript ? '전사 있음' : '전사 없음 (STT 미연결)') + '</span>';
    App.show('screen-practice-done');
  }

  /* ---------- 본 면접 ---------- */
  async function runLive() {
    setStep('본 면접');
    state.liveFrom = Date.now();
    var items = Questions.SET.items;
    for (var i = 0; i < items.length; i++) {
      await runQuestion(items[i], 'live', i + 1, items.length);
    }
    state.liveTo = Date.now();
    renderUpload();
    App.show('screen-upload');
  }

  /* ---------- 저장 확인 ---------- */
  function renderUpload() {
    setStep('저장 확인');
    var rows = state.session.answers.map(function (a, i) {
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(a.questionType) + '</td>' +
        '<td>' + (a.answerMs / 1000).toFixed(1) + 's</td>' +
        '<td>' + a.media.chunks + '</td><td>' + kb(a.media.bytes) + '</td>' +
        '<td><span class="tag ' + (a.media.complete ? 'ok">완전' : 'err">누락 ' + a.media.gaps.length + '') + '</span></td>' +
        '<td>' + (a.transcript ? (a.transcript.meanConfidence == null ? '있음' : '신뢰도 ' + a.transcript.meanConfidence) : '—') + '</td></tr>';
    }).join('');
    els.uploadTable.innerHTML =
      '<thead><tr><th>#</th><th>유형</th><th>길이</th><th>구간</th><th>용량</th><th>저장</th><th>전사</th></tr></thead><tbody>' + rows + '</tbody>';
    var bad = state.session.answers.filter(function (a) { return !a.media.complete; });
    els.uploadWarn.hidden = bad.length === 0;
    if (bad.length) {
      els.uploadWarn.innerHTML = '<strong>' + bad.length + '개 답변의 일부 구간이 저장되지 않았습니다.</strong> ' +
        '기록에 남았으며, 운영에서는 이 경우 재응시 경로가 열립니다 (D-4).';
    }
  }

  /* ---------- 전사 확인 · 정정 ---------- */
  function renderTranscripts() {
    setStep('전사 확인');
    var html = state.session.answers.map(function (a, i) {
      var q = Questions.SET.items[i];
      var t = a.transcript;
      var head = '<div class="tr-head"><span class="q">' + (i + 1) + '. ' + esc(q.text) + '</span>' +
        '<span class="m">' + (t && t.meanConfidence != null ? '신뢰도 ' + t.meanConfidence + (t.meanConfidence < 0.6 ? ' <span class="tr-low">낮음</span>' : '') : '') + '</span></div>';
      if (!t) {
        return '<div class="tr-item">' + head +
          '<p class="tr-empty">전사가 없습니다 — STT가 연결되지 않았습니다. 영상·음성만 보관되며 자동채점 대상에서 제외됩니다.</p></div>';
      }
      var left = Transcript.POLICY.maxAttempts - t.corrections.length;
      return '<div class="tr-item" data-i="' + i + '">' + head +
        '<div class="tr-raw">' + esc(t.raw || '(인식된 내용 없음)') + '</div>' +
        '<textarea class="tr-edit" id="tr-' + i + '"' + (left <= 0 ? ' disabled' : '') + '>' + esc(t.corrected != null ? t.corrected : t.raw) + '</textarea>' +
        '<div class="tr-foot">' +
          '<button class="btn small" data-save="' + i + '"' + (left <= 0 ? ' disabled' : '') + '>정정 저장</button>' +
          '<span class="note" id="trn-' + i + '">허용 ' + Transcript.editCap(t.raw) + '자 · 남은 기회 ' + left + '회</span>' +
        '</div></div>';
    }).join('');
    els.transcriptList.innerHTML = html;

    els.transcriptList.onclick = function (e) {
      var b = e.target.closest('[data-save]');
      if (!b) return;
      var i = parseInt(b.getAttribute('data-save'), 10);
      var a = state.session.answers[i];
      var t = a.transcript;
      var proposed = $('tr-' + i).value;
      var r = Transcript.evaluateCorrection(t.raw, proposed, t.corrections);
      t.corrections.push(r.record);
      var note = $('trn-' + i);
      if (r.accepted) {
        t.corrected = proposed;
        note.className = 'note ok';
        note.textContent = '저장됨 · 편집거리 ' + r.record.editDistance + '/' + r.record.cap;
      } else {
        note.className = 'note err';
        note.textContent = r.reason;
      }
      var left = Transcript.POLICY.maxAttempts - t.corrections.length;
      if (left <= 0) { $('tr-' + i).disabled = true; b.disabled = true; }
      persist();
    };
  }

  /* ---------- 제출 ---------- */
  async function submit() {
    setStep('제출');
    state.session.submittedAt = new Date().toISOString();
    state.session.finishedAt = state.session.submittedAt;

    /* 채점 — 지금은 보류 공급자. 서버 채점기가 붙으면 여기서 호출된다 */
    var scorer = Providers.get('scorer');
    state.session.score = await scorer.score({
      session: state.session,
      rubric: Questions.RUBRIC,
      questions: Questions.SET
    });
    await persist();

    var s = state.session;
    els.doneTable.innerHTML =
      '<tbody>' +
      row('접수번호', s.id) +
      row('영상 보관', '~' + s.retention.media.slice(0, 10) + ' (' + (s.retention.basis === 'hiring_closed' ? '채용 종료 기준' : '임시 · 채용 종료 시 재계산') + ')') +
      row('전사 보관', '~' + s.retention.transcript.slice(0, 10)) +
      row('자동 채점', s.score.status === 'pending' ? '보류 — ' + s.score.reason : '완료') +
      row('권리 행사', '설명 요구 · 인적 재검토 · 삭제 — 기록 보기 화면에서') +
      '</tbody>';
    App.show('screen-done');

    function row(k, v) { return '<tr><td>' + esc(k) + '</td><td class="seq">' + esc(v) + '</td></tr>'; }
  }

  function reportCtx() {
    return {
      session: state.session,
      raw: { integrityEvents: state.logger.integrityEvents },
      integrity: Scoring ? Scoring.integritySummary(state.logger.integrityEvents, { from: state.liveFrom, to: state.liveTo }) : [],
      store: state.store,
      app: App
    };
  }

  /* ---------- 초기화 ---------- */
  async function init() {
    ['stepLabel', 'sessionLabel', 'providerPanel', 'retMedia', 'retTranscript', 'agreeRecord', 'agreeRetention', 'btnToCheck',
     'checkVideo', 'checkMeter', 'checkList', 'btnAcquire', 'btnAudioTest', 'btnToPractice',
     'phaseBadge', 'qStatus', 'qProgress', 'qText', 'liveVideo', 'recBadge', 'liveMeter',
     'timerLabel', 'timerLeft', 'timerFill', 'btnStartAnswer', 'btnStopAnswer', 'qFeedback',
     'practicePlayback', 'practiceMeta', 'btnToLive',
     'uploadTable', 'uploadWarn', 'btnToTranscript', 'transcriptList', 'btnSubmit',
     'doneTable', 'btnErase', 'btnDownload', 'btnReport', 'reportBody', 'explainBody',
     'manualQ', 'manualText', 'btnManualSave', 'btnManualSkip'
    ].forEach(function (id) { els[id] = $(id); });

    Providers.fromQuery(DEFAULT_PROVIDERS);
    state.store = Providers.get('store');
    renderProviders();

    var problems = Questions.validate();
    if (problems.length) console.error('[questions] 문항/루브릭 불일치', problems);

    els.retMedia.textContent = Retention.POLICY.mediaDays;
    els.retTranscript.textContent = Retention.POLICY.transcriptDays;

    /* 자동 파기 — 로드마다. 운영에서는 배치 */
    try {
      var purged = await state.store.purgeExpired();
      if (purged.length) console.log('[store] 만료 파기', purged);
    } catch (e) { console.warn('[store] 파기 배치 실패', e); }

    var timing = null;
    Core.Device.measureRefreshRate(400, function (t) { timing = t; });

    function agree() { els.btnToCheck.disabled = !(els.agreeRecord.checked && els.agreeRetention.checked); }
    els.agreeRecord.addEventListener('change', agree);
    els.agreeRetention.addEventListener('change', agree);

    els.btnToCheck.addEventListener('click', function () {
      bootSession(timing);
      state.recorder = new Recorder({ store: state.store });
      renderCheck(checkItems());
      setStep('장비 점검');
      App.show('screen-check');
    });

    els.btnAcquire.addEventListener('click', acquire);
    els.btnAudioTest.addEventListener('click', audioTest);
    els.btnToPractice.addEventListener('click', runPractice);
    els.btnToLive.addEventListener('click', runLive);
    els.btnStartAnswer.addEventListener('click', function () { if (state.timer) state.timer.skip('started_early'); });
    els.btnStopAnswer.addEventListener('click', function () { if (state.timer) state.timer.skip('stopped_early'); });
    els.btnToTranscript.addEventListener('click', function () { renderTranscripts(); App.show('screen-transcript'); });
    els.btnSubmit.addEventListener('click', submit);

    els.btnDownload.addEventListener('click', function () {
      var data = JSON.parse(JSON.stringify(state.session));
      data.integrityEvents = state.logger.integrityEvents;
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = state.session.id + '.json'; a.click();
      URL.revokeObjectURL(a.href);
    });

    els.btnErase.addEventListener('click', async function () {
      var n = await state.store.eraseSession(state.session.id);
      alert('삭제 요청이 처리되었습니다. 영상 구간 ' + n + '개와 세션 기록을 지웠습니다.');
    });

    els.btnReport.addEventListener('click', function () {
      InterviewReport.render(els.reportBody, reportCtx());
      App.show('screen-report');
    });

    /* 수동 전사 UI 훅 — stt=manual 공급자가 녹화 직후 호출한다 */
    Providers.ui.manualTranscript = function (questionText) {
      return new Promise(function (resolve) {
        els.manualQ.textContent = questionText || '';
        els.manualText.value = '';
        App.show('screen-manual');
        function done(v) {
          els.btnManualSave.onclick = null; els.btnManualSkip.onclick = null;
          App.show('screen-question');
          resolve(v);
        }
        els.btnManualSave.onclick = function () { done(els.manualText.value); };
        els.btnManualSkip.onclick = function () { done(null); };
      });
    };

    /* 검토자 채점 저장 — report.js가 호출 */
    App.saveHumanScore = async function (hs) {
      state.session.humanScore = hs;
      await persist();
    };

    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-goto]');
      if (t) App.show(t.getAttribute('data-goto'));
    });

    window.addEventListener('beforeunload', function () { if (state.recorder) state.recorder.release(); });
  }

  global.InterviewApp = App;
  document.addEventListener('DOMContentLoaded', init);
})(window);

/* ============================================================
   recorder.js — 카메라·마이크 · 음량 미터 · 구간 녹화

   설계도 §3-01. 구간(약 5초) 단위로 저장소에 넘긴다 — 중간에 끊겨도
   전부를 잃지 않기 위해서다. 화질은 사람이 확인할 최소 수준(수집 최소화).
   ============================================================ */
(function (global) {
  'use strict';

  var CONFIG = {
    video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 20 } },
    audio: { echoCancellation: true, noiseSuppression: true },
    timesliceMs: 5000,
    speechThreshold: 0.045,      // RMS. 이 이상이면 "말하고 있다"
    meterIntervalMs: 50
  };

  /* 브라우저마다 지원 코덱이 다르다. 지원 여부를 실측해 고른다 */
  var MIME_CANDIDATES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (var i = 0; i < MIME_CANDIDATES.length; i++) {
      if (MediaRecorder.isTypeSupported(MIME_CANDIDATES[i])) return MIME_CANDIDATES[i];
    }
    return '';
  }

  /* ---------- 음량 미터 (순수 계산부는 분리 — 테스트 대상) ---------- */
  var Meter = {
    rms: function (samples) {
      var sum = 0;
      for (var i = 0; i < samples.length; i++) { var v = (samples[i] - 128) / 128; sum += v * v; }
      return Math.sqrt(sum / samples.length);
    },

    /**
     * 음량 시계열에서 발화 지표를 낸다. 기록만 하고 점수에는 넣지 않는다 (R-06).
     * frames: [{ t: ms since answer start, rms }]
     */
    speechMetrics: function (frames, threshold, intervalMs) {
      threshold = threshold || CONFIG.speechThreshold;
      intervalMs = intervalMs || CONFIG.meterIntervalMs;
      var first = null, speaking = 0, total = frames.length;
      for (var i = 0; i < frames.length; i++) {
        if (frames[i].rms >= threshold) {
          if (first === null) first = frames[i].t;
          speaking++;
        }
      }
      return {
        firstSpeechDelayMs: first,
        speechDurationMs: speaking * intervalMs,
        silenceRatio: total ? Math.round(((total - speaking) / total) * 1000) / 1000 : null,
        frames: total,
        spoke: first !== null
      };
    }
  };

  /* ---------- 장치 ---------- */
  function Recorder(opts) {
    this.store = opts.store;
    this.onLevel = opts.onLevel || function () {};
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.buf = null;
    this.meterId = null;
    this.mime = pickMime();
    this.rec = null;
  }

  Recorder.CONFIG = CONFIG;
  Recorder.Meter = Meter;
  Recorder.pickMime = pickMime;

  Recorder.prototype.supported = function () {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
              typeof MediaRecorder !== 'undefined' && this.mime !== null);
  };

  Recorder.prototype.acquire = async function () {
    this.stream = await navigator.mediaDevices.getUserMedia({ video: CONFIG.video, audio: CONFIG.audio });
    var AC = global.AudioContext || global.webkitAudioContext;
    this.ctx = new AC();
    var src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.buf = new Uint8Array(this.analyser.fftSize);

    var v = this.stream.getVideoTracks()[0];
    var a = this.stream.getAudioTracks()[0];
    return {
      video: v ? v.getSettings() : null,
      audio: a ? a.getSettings() : null,
      mime: this.mime
    };
  };

  /** 미터 시작. 프레임을 배열에 쌓고 콜백으로도 알린다 */
  Recorder.prototype.startMeter = function () {
    var self = this;
    var t0 = performance.now();
    var frames = [];
    this.stopMeter();
    this.meterId = setInterval(function () {
      if (!self.analyser) return;
      self.analyser.getByteTimeDomainData(self.buf);
      var rms = Meter.rms(self.buf);
      var f = { t: Math.round(performance.now() - t0), rms: Math.round(rms * 1000) / 1000 };
      frames.push(f);
      self.onLevel(rms, rms >= CONFIG.speechThreshold);
    }, CONFIG.meterIntervalMs);
    return frames;
  };

  Recorder.prototype.stopMeter = function () {
    if (this.meterId) { clearInterval(this.meterId); this.meterId = null; }
  };

  /**
   * 장비 점검 — 권한이 있는 것과 실제로 소리가 들어오는 것은 다르다.
   * 몇 초 동안 말하게 하고 임계값을 넘는지 본다.
   */
  Recorder.prototype.checkAudio = function (ms) {
    var self = this;
    return new Promise(function (resolve) {
      var frames = self.startMeter();
      setTimeout(function () {
        self.stopMeter();
        var m = Meter.speechMetrics(frames);
        var peak = frames.reduce(function (p, f) { return Math.max(p, f.rms); }, 0);
        resolve({ ok: m.spoke, peak: Math.round(peak * 1000) / 1000, frames: frames.length });
      }, ms);
    });
  };

  /**
   * 녹화 시작. 구간마다 store.putChunk로 넘긴다.
   * 반환: { stop() -> Promise<summary> }
   */
  Recorder.prototype.startRecording = function (sessionId, questionId) {
    var self = this;
    var seq = 0;
    var uploaded = [];
    var failed = [];
    var pending = [];

    this.rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);

    this.rec.ondataavailable = function (e) {
      if (!e.data || !e.data.size) return;
      var mySeq = seq++;
      var p = self.store.putChunk(sessionId, questionId, mySeq, e.data, { mime: self.mime })
        .then(function (r) { uploaded.push({ seq: mySeq, size: r.size }); })
        .catch(function (err) { failed.push({ seq: mySeq, error: String(err) }); });
      pending.push(p);
    };

    var startedAt = Date.now();
    this.rec.start(CONFIG.timesliceMs);
    var frames = this.startMeter();

    return {
      stop: function () {
        return new Promise(function (resolve) {
          self.stopMeter();
          var r = self.rec;
          r.onstop = async function () {
            await Promise.all(pending);
            var o = global.Chunks ? global.Chunks.order(uploaded) : { gaps: [], complete: true };
            resolve({
              startedAt: startedAt,
              durationMs: Date.now() - startedAt,
              chunks: uploaded.length,
              bytes: uploaded.reduce(function (a, c) { return a + c.size; }, 0),
              failed: failed,
              gaps: o.gaps,
              complete: o.complete && failed.length === 0,
              mime: self.mime,
              speech: Meter.speechMetrics(frames)
            });
          };
          try { r.stop(); } catch (e) { r.onstop(); }
        });
      }
    };
  };

  Recorder.prototype.release = function () {
    this.stopMeter();
    if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
    if (this.ctx && this.ctx.close) { try { this.ctx.close(); } catch (e) {} }
    this.stream = null; this.ctx = null; this.analyser = null;
  };

  global.Recorder = Recorder;
})(typeof window !== 'undefined' ? window : global);

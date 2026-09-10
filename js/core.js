/* ============================================================
   core.js — 세션 / 시드 RNG / 기기 프로파일 / Trial 로거 / 규준 게이트
   재사용 대상: 9종 전 태스크 공통
   ============================================================ */
(function (global) {
  'use strict';

  var Core = {};

  /* ----------------------------------------------------------
     1. 시드 RNG (mulberry32)
     채용 평가에서는 "이 응시자가 본 자극이 정확히 무엇이었는지"를
     사후에 재현할 수 있어야 한다. 시드만 저장하면 전 시행을 복원 가능.
     ---------------------------------------------------------- */
  Core.Rng = function (seed) {
    this.seed = seed >>> 0;
    this._s = this.seed;
  };

  Core.Rng.prototype.next = function () {
    this._s = (this._s + 0x6D2B79F5) >>> 0;
    var t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** 0 이상 n 미만 정수 */
  Core.Rng.prototype.int = function (n) {
    return Math.floor(this.next() * n);
  };

  /** 배열에서 k개를 비복원 추출 (Fisher-Yates 부분 셔플) */
  Core.Rng.prototype.sample = function (arr, k) {
    var pool = arr.slice();
    var out = [];
    for (var i = 0; i < k && pool.length; i++) {
      out.push(pool.splice(this.int(pool.length), 1)[0]);
    }
    return out;
  };

  /* ----------------------------------------------------------
     2. 기기 / 브라우저 타이밍 프로파일
     브라우저·기기별 RT 오차는 실측으로 확인된 문제다.
     RT를 점수화하려면 보정 근거를 반드시 함께 저장해야 한다.
     ---------------------------------------------------------- */
  Core.Device = {
    /** rAF 간격을 샘플링해 실제 리프레시 레이트를 추정 */
    measureRefreshRate: function (ms, cb) {
      var deltas = [];
      var last = performance.now();
      var t0 = last;

      function tick(now) {
        deltas.push(now - last);
        last = now;
        if (now - t0 < ms) {
          requestAnimationFrame(tick);
        } else {
          deltas.sort(function (a, b) { return a - b; });
          var median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 16.67;
          cb({
            medianFrameMs: Math.round(median * 100) / 100,
            estimatedHz: Math.round(1000 / median),
            frameSamples: deltas.length
          });
        }
      }
      requestAnimationFrame(tick);
    },

    profile: function (timing) {
      return {
        ua: navigator.userAgent,
        platform: navigator.platform || null,
        language: navigator.language,
        hardwareConcurrency: navigator.hardwareConcurrency || null,
        deviceMemoryGb: navigator.deviceMemory || null,
        screen: {
          w: screen.width, h: screen.height,
          availW: screen.availWidth, availH: screen.availHeight,
          dpr: window.devicePixelRatio || 1
        },
        viewport: { w: window.innerWidth, h: window.innerHeight },
        pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
        timing: timing || null,
        tzOffsetMin: new Date().getTimezoneOffset()
      };
    },

    /** 기기 식별용 짧은 지문 (개인 식별 목적이 아닌 RT 보정용 그룹키) */
    fingerprint: function (p) {
      var basis = [
        p.platform, p.screen.w + 'x' + p.screen.h, p.screen.dpr,
        p.hardwareConcurrency, p.timing && p.timing.estimatedHz
      ].join('|');
      var h = 2166136261;
      for (var i = 0; i < basis.length; i++) {
        h ^= basis.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return 'dev_' + (h >>> 0).toString(36);
    }
  };

  /* ----------------------------------------------------------
     3. Trial 로거
     이 스키마가 제품의 핵심 자산이다. 타당도 검증·규준 수집·
     사후 재채점이 전부 이 로그에서 나온다.
     ---------------------------------------------------------- */
  Core.Logger = function (session) {
    this.session = session;
    this.trials = [];
    this.integrityEvents = [];
    this._watchIntegrity();
  };

  Core.Logger.prototype.logTrial = function (t) {
    var rec = {
      sessionId: this.session.id,
      taskId: t.taskId,
      phase: t.phase,                    // 'practice' | 'live'
      trialIndex: t.trialIndex,
      difficulty: t.difficulty,          // = 순서 길이(span level)
      stimulus: t.stimulus.slice(),
      response: t.response.slice(),
      correct: t.correct,
      rtFirstMs: t.rtFirstMs,            // 입력 개방 → 첫 클릭 (취소 후 남은 것 기준)
      rtFirstRawMs: t.rtFirstRawMs,      // 입력 개방 → 최초로 손이 움직인 시각
      rtTotalMs: t.rtTotalMs,            // 입력 개방 → 마지막 클릭
      interTapMs: t.interTapMs.slice(),  // 클릭 간 간격
      undos: (t.undos || []).slice(),    // 오입력 취소 내역 (sinceTapMs로 실수/망설임 구분)
      undoCount: t.undoCount || 0,
      timedOut: !!t.timedOut,            // 무응답 상한 초과
      tsClient: t.tsClient,
      tsServer: null,                    // 서버 수신 시각 (프로토타입은 미연동)
      deviceFingerprint: this.session.deviceFingerprint,
      abandoned: !!t.abandoned
    };
    this.trials.push(rec);
    return rec;
  };

  /** 탭 이탈·창 크기 변경 등 응시 무결성 관련 이벤트 기록 */
  Core.Logger.prototype._watchIntegrity = function () {
    var self = this;
    function push(type, detail) {
      self.integrityEvents.push({ type: type, at: Date.now(), detail: detail || null });
    }
    document.addEventListener('visibilitychange', function () {
      push('visibility', document.visibilityState);
    });
    window.addEventListener('blur', function () { push('blur'); });
    window.addEventListener('resize', function () {
      push('resize', window.innerWidth + 'x' + window.innerHeight);
    });
  };

  Core.Logger.prototype.liveTrials = function () {
    return this.trials.filter(function (t) { return t.phase === 'live'; });
  };

  Core.Logger.prototype.toJSON = function () {
    return {
      schemaVersion: '0.1.0',
      session: this.session,
      trials: this.trials,
      integrityEvents: this.integrityEvents
    };
  };

  /* ----------------------------------------------------------
     4. 세션
     ---------------------------------------------------------- */
  Core.createSession = function (taskId, deviceProfile) {
    var seed = (Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0;
    var id = 'sess_' + Date.now().toString(36) + '_' +
             Math.floor(Math.random() * 1e6).toString(36);
    return {
      id: id,
      taskId: taskId,
      seed: seed,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      device: deviceProfile,
      deviceFingerprint: Core.Device.fingerprint(deviceProfile),
      buildVersion: '0.1.0-prototype'
    };
  };

  /* ----------------------------------------------------------
     5. 규준 게이트
     규준 표본이 없으면 백분위·등급 산출을 코드 차원에서 차단한다.
     "상위 N%"는 규준 없이는 허위 표시다.
     ---------------------------------------------------------- */
  Core.Norms = {
    /* 규준표를 확보하면 아래에 { spatialSpan: { n, mean, sd, byAge: {...} } } 형태로 주입 */
    tables: {},

    has: function (taskId) {
      var t = this.tables[taskId];
      return !!(t && t.n >= 300);
    },

    /** 규준이 있을 때만 백분위 반환, 없으면 null */
    percentile: function (taskId, rawScore) {
      if (!this.has(taskId)) return null;
      var t = this.tables[taskId];
      var z = (rawScore - t.mean) / t.sd;
      // 표준정규 CDF 근사 (Abramowitz & Stegun 26.2.17)
      var p = 0.2316419, b = [0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
      var x = Math.abs(z), tt = 1 / (1 + p * x);
      var poly = b[0]*tt + b[1]*tt*tt + b[2]*Math.pow(tt,3) + b[3]*Math.pow(tt,4) + b[4]*Math.pow(tt,5);
      var cdf = 1 - (Math.exp(-x*x/2) / Math.sqrt(2*Math.PI)) * poly;
      if (z < 0) cdf = 1 - cdf;
      return Math.round(cdf * 1000) / 10;
    },

    reason: function (taskId) {
      var t = this.tables[taskId];
      if (!t) return '이 과제의 규준 표본이 아직 수집되지 않았습니다 (n = 0).';
      return '규준 표본이 최소 요건에 미달합니다 (n = ' + t.n + ', 필요 300).';
    }
  };

  global.Core = Core;
})(window);

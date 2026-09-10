/* ============================================================
   providers.js — 외부 의존 지점의 계약

   영상면접이 외부에 기대는 것은 넷이다. 전부 여기서 계약만 정하고,
   실제 구현은 갈아끼운다. 지금은 스텁이 꽂혀 있다.

     TTS     질문 읽어주기         기본: 브라우저 내장 음성합성 (API 불필요)
     STT     음성 → 텍스트         기본: 없음 (운영은 자체 호스팅 faster-whisper)
     Scorer  루브릭 채점           기본: 보류 (server/ 참조 구현이 Claude로 채점)
     Store   녹화 저장·파기        기본: 브라우저 IndexedDB (운영은 암호화 객체 저장소)

   계약을 어기는 구현은 register()에서 거부한다.
   ============================================================ */
(function (global) {
  'use strict';

  var CONTRACTS = {
    tts: {
      required: ['id', 'label', 'speak', 'cancel', 'available'],
      external: 'external'          // 외부 전송 여부를 반드시 밝혀야 한다
    },
    stt: {
      required: ['id', 'label', 'start', 'stop', 'available'],
      external: 'external'
    },
    scorer: {
      required: ['id', 'label', 'score', 'available'],
      external: 'external'
    },
    store: {
      required: ['id', 'label', 'open', 'putChunk', 'listChunks', 'assemble',
                 'putSession', 'getSession', 'listSessions', 'purgeExpired'],
      external: 'external'
    }
  };

  var registry = { tts: {}, stt: {}, scorer: {}, store: {} };
  var active = { tts: null, stt: null, scorer: null, store: null };

  var Providers = {
    register: function (kind, impl) {
      var c = CONTRACTS[kind];
      if (!c) throw new Error('알 수 없는 공급자 종류: ' + kind);
      var missing = c.required.filter(function (k) { return impl[k] == null; });
      if (missing.length) {
        throw new Error(kind + ' 공급자 "' + (impl.id || '?') + '"에 계약 항목이 없습니다: ' + missing.join(', '));
      }
      if (typeof impl.external !== 'boolean') {
        throw new Error(kind + ' 공급자 "' + impl.id + '"는 external(외부 전송 여부)을 boolean으로 밝혀야 합니다');
      }
      if (registry[kind][impl.id]) throw new Error(kind + ' 공급자 id 중복: ' + impl.id);
      registry[kind][impl.id] = impl;
      return impl;
    },

    use: function (kind, id) {
      var impl = registry[kind][id];
      if (!impl) throw new Error(kind + ' 공급자 없음: ' + id);
      active[kind] = impl;
      return impl;
    },

    get: function (kind) { return active[kind]; },

    list: function (kind) {
      return Object.keys(registry[kind]).map(function (id) { return registry[kind][id]; });
    },

    /** 현재 활성 공급자 요약 — 고지 화면과 설명 화면에 그대로 표시한다 */
    summary: function () {
      return Object.keys(active).map(function (kind) {
        var p = active[kind];
        return {
          kind: kind,
          id: p ? p.id : null,
          label: p ? p.label : '(미지정)',
          external: p ? p.external : null,
          devOnly: p ? !!p.devOnly : false
        };
      });
    },

    /** ?tts=&stt=&scorer=&store= 로 선택. 없으면 기본값 */
    fromQuery: function (defaults) {
      var q = {};
      (location.search || '').replace(/^\?/, '').split('&').forEach(function (kv) {
        if (!kv) return;
        var p = kv.split('=');
        q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
      Object.keys(defaults).forEach(function (kind) {
        var want = q[kind] || defaults[kind];
        if (registry[kind][want]) Providers.use(kind, want);
        else Providers.use(kind, defaults[kind]);
      });
      return Providers.summary();
    }
  };

  /* ============================================================
     TTS — 브라우저 내장 음성합성
     외부로 나가는 것이 없고 API 키도 필요 없다. 음질은 운영 수준이 아니지만
     "질문을 읽어준다"는 절차 자체를 지금 검증할 수 있다.
     ============================================================ */
  Providers.register('tts', {
    id: 'webspeech',
    label: '브라우저 내장 음성합성',
    external: false,
    available: function () {
      return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
    },
    speak: function (text, opts) {
      opts = opts || {};
      return new Promise(function (resolve) {
        if (!Providers.get('tts').available()) { resolve({ spoken: false }); return; }
        try { speechSynthesis.cancel(); } catch (e) {}
        var u = new SpeechSynthesisUtterance(text);
        u.lang = opts.lang || 'ko-KR';
        u.rate = opts.rate || 0.95;
        var done = false;
        function finish(spoken) { if (done) return; done = true; resolve({ spoken: spoken }); }
        u.onend = function () { finish(true); };
        u.onerror = function () { finish(false); };
        /* 일부 브라우저는 onend를 안 쏜다 — 길이 기반 안전 타이머 */
        setTimeout(function () { finish(true); }, Math.min(20000, 1500 + text.length * 120));
        speechSynthesis.speak(u);
      });
    },
    cancel: function () { try { speechSynthesis.cancel(); } catch (e) {} }
  });

  Providers.register('tts', {
    id: 'null',
    label: '없음 (텍스트만 표시)',
    external: false,
    available: function () { return true; },
    speak: function () { return Promise.resolve({ spoken: false }); },
    cancel: function () {}
  });

  /* ============================================================
     STT
     기본은 "없음"이다. 운영 STT는 자체 호스팅 faster-whisper로 붙인다 —
     응시자 음성이 외부로 나가면 안 되기 때문이다.

     webspeech-dev는 개발 확인용이다. 브라우저 음성인식은 음성을 브라우저
     제조사 서버로 보낸다. external:true, devOnly:true로 표시되어
     고지 화면에 경고가 뜬다. 운영에 쓰면 안 된다.
     ============================================================ */
  Providers.register('stt', {
    id: 'null',
    label: '없음 (전사 보류)',
    external: false,
    available: function () { return true; },
    start: function () { return { stop: function () { return Promise.resolve(null); } }; },
    stop: function () { return Promise.resolve(null); }
  });

  Providers.register('stt', {
    id: 'webspeech-dev',
    label: '브라우저 음성인식 — 개발 확인용',
    external: true,
    devOnly: true,
    available: function () {
      return typeof (global.SpeechRecognition || global.webkitSpeechRecognition) !== 'undefined';
    },
    /**
     * 녹화와 동시에 돌린다. 결과는 { text, words[{text, confidence}], meanConfidence }
     * 브라우저 인식은 단어별 타임스탬프를 주지 않으므로 startMs/endMs는 null이다.
     */
    start: function (opts) {
      var Rec = global.SpeechRecognition || global.webkitSpeechRecognition;
      var r = new Rec();
      r.lang = (opts && opts.lang) || 'ko-KR';
      r.continuous = true;
      r.interimResults = false;
      r.maxAlternatives = 1;

      var finals = [];
      var stopped = false;
      var resolveStop = null;

      r.onresult = function (e) {
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var res = e.results[i];
          if (!res.isFinal) continue;
          var alt = res[0];
          finals.push({ text: alt.transcript.trim(), confidence: alt.confidence });
        }
      };
      r.onerror = function () {};
      r.onend = function () {
        if (!stopped) { try { r.start(); } catch (e) {} return; }   // 자동 종료 시 재시작
        if (resolveStop) resolveStop(build());
      };

      function build() {
        var text = finals.map(function (f) { return f.text; }).join(' ');
        var words = [];
        finals.forEach(function (f) {
          f.text.split(/\s+/).forEach(function (w) {
            if (w) words.push({ text: w, startMs: null, endMs: null, confidence: f.confidence });
          });
        });
        var conf = words.length
          ? words.reduce(function (a, w) { return a + (w.confidence || 0); }, 0) / words.length
          : null;
        return {
          text: text,
          words: words,
          meanConfidence: conf == null ? null : Math.round(conf * 1000) / 1000,
          lowConfidenceRatio: words.length
            ? words.filter(function (w) { return (w.confidence || 0) < 0.6; }).length / words.length
            : null,
          provider: 'webspeech-dev'
        };
      }

      try { r.start(); } catch (e) {}

      return {
        stop: function () {
          return new Promise(function (resolve) {
            stopped = true;
            resolveStop = resolve;
            try { r.stop(); } catch (e) { resolve(build()); }
            setTimeout(function () { resolve(build()); }, 1500);
          });
        }
      };
    },
    stop: function () { return Promise.resolve(null); }
  });

  /* ---------- 테스트용 STT 둘 ----------
     fixture: 문항별 고정 전사 (fixtures.js). 전사 정정·마스킹·채점 화면을 API 없이 구동
     manual : 녹화 뒤 응시자(테스터)가 직접 타이핑. 실제 발화로 정정 화면을 시험할 때 */
  Providers.register('stt', {
    id: 'fixture',
    label: '고정 전사 — 테스트용',
    external: false,
    devOnly: true,
    available: function () { return !!global.Fixtures; },
    start: function (opts) {
      var qid = opts && opts.questionId;
      return { stop: function () {
        var t = global.Fixtures && global.Fixtures.transcripts[qid];
        return Promise.resolve(t ? JSON.parse(JSON.stringify(t)) : null);
      } };
    },
    stop: function () { return Promise.resolve(null); }
  });

  /* 화면이 필요한 공급자는 앱이 꽂아 주는 UI 훅을 쓴다 */
  Providers.ui = {};

  Providers.register('stt', {
    id: 'manual',
    label: '수동 입력 — 녹화 후 직접 타이핑',
    external: false,
    devOnly: true,
    available: function () { return true; },
    start: function (opts) {
      var qText = opts && opts.questionText;
      return { stop: function () {
        if (!Providers.ui.manualTranscript) return Promise.resolve(null);
        return Providers.ui.manualTranscript(qText).then(function (text) {
          if (!text || !text.trim()) return null;
          var ws = text.trim().split(/\s+/).map(function (w) {
            return { text: w, startMs: null, endMs: null, confidence: 1 };
          });
          return { text: text.trim(), words: ws, meanConfidence: 1, lowConfidenceRatio: 0, provider: 'manual' };
        });
      } };
    },
    stop: function () { return Promise.resolve(null); }
  });

  /* ============================================================
     Scorer — 루브릭 채점
     기본은 보류다. 실제 채점은 서버에서 한다 (server/score-claude.mjs).
     브라우저에서 API 키를 다루면 안 되고, 채점은 실시간이 아니다.
     ============================================================ */
  Providers.register('scorer', {
    id: 'pending',
    label: '보류 (채점기 미연결)',
    external: false,
    available: function () { return true; },
    score: function () {
      return Promise.resolve({
        status: 'pending',
        reason: '채점기가 연결되지 않았습니다. 전사와 행동 지표만 기록됩니다.',
        perQuestion: [],
        calibrated: null,
        percentile: null,
        routedToHuman: true,
        routeReason: 'scorer_not_configured'
      });
    }
  });

  global.Providers = Providers;
})(window);

/* ============================================================
   mockscorer.js — 모의 채점기

   실제 채점이 아니다. 리포트·근거 인용·검토자 화면·편향 테스트를 API 없이
   구동하기 위한 결정적(deterministic) 휴리스틱이다. 같은 입력이면 같은 출력.
   결과 객체의 모양은 server/score-claude.mjs와 동일하게 맞췄다 —
   화면은 둘을 구분하지 않아야 한다.

   휴리스틱 (루브릭 앵커를 흉내 낸 것일 뿐, 타당도 주장 없음)
     specificity     숫자·기간·고유 사건 표지 개수
     relevance       직무 어휘 개수
     structure       STAR 표지(상황·과제·행동·결과) 개수
     problemSolving  제약·대안·비교 표지
     judgment        우선순위·이해관계자 표지
   근거 인용은 표지가 들어 있는 문장을 그대로 잘라 오프셋을 붙인다.
   ============================================================ */
(function (global) {
  'use strict';

  var MARKERS = {
    specificity:    [/\d+\s*(퍼센트|%|년|개월|주|명|건|배)/g, /작년|지난해|하반기|상반기|올해/g, /예를 들어|예컨대/g],
    relevance:      [/데이터|분석|모델|실험|배포|제품|설계|예측|전환|지표/g],
    structure:      [/상황|맡은 일|제가 맡은|역할/g, /그래서|그다음|먼저/g, /결과적으로|결과는|결국/g],
    problemSolving: [/리스크|비용|손실|제약|일정/g, /대안|대신|나란히|비교|양쪽/g, /합의|제안/g],
    judgment:       [/우선순위|먼저|순서/g, /팀장|동료|개발팀|관계자|보고/g, /숨기지 않|투명/g]
  };

  function sentences(text) {
    var out = [];
    var re = /[^.!?。]+[.!?。]?/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var s = m[0];
      var start = m.index;
      var trimmedStart = start + (s.length - s.trimStart().length);
      var body = s.trim();
      if (body) out.push({ text: body, start: trimmedStart, end: trimmedStart + body.length });
    }
    return out;
  }

  function countMarkers(text, trait) {
    var n = 0;
    MARKERS[trait].forEach(function (re) {
      re.lastIndex = 0;
      var m; while ((m = re.exec(text)) !== null) { n++; if (m[0].length === 0) re.lastIndex++; }
    });
    return n;
  }

  /** 표지 개수 → 1~5. 0→1, 1→2, 2→3, 3~4→4, 5+→5 */
  function toScore(n) {
    if (n <= 0) return 1;
    if (n === 1) return 2;
    if (n === 2) return 3;
    if (n <= 4) return 4;
    return 5;
  }

  var MockScorer = {
    id: 'mock',
    label: '모의 채점기 — 휴리스틱 · 타당도 없음',
    external: false,
    devOnly: true,
    available: function () { return true; },

    /** 한 문항 채점. 순수 함수 — 테스트 대상 */
    scoreAnswer: function (text, traits) {
      var sents = sentences(text);
      var out = { traits: [], citations: [], flags: [] };
      if (!text || text.trim().length < 20) out.flags.push('too_short');

      traits.forEach(function (t) {
        var total = countMarkers(text, t);
        out.traits.push({
          traitId: t,
          raw: toScore(total),
          confidence: Math.min(1, 0.4 + total * 0.12),
          rationale: '표지 ' + total + '개 (모의 휴리스틱)'
        });
        /* 근거: 그 특성 표지를 가장 많이 담은 문장 하나 */
        var best = null, bestN = 0;
        sents.forEach(function (s) {
          var n = countMarkers(s.text, t);
          if (n > bestN) { bestN = n; best = s; }
        });
        if (best) out.citations.push({ traitId: t, quotedText: best.text, startChar: best.start, endChar: best.end });
      });
      return out;
    },

    score: function (input) {
      var session = input.session, qset = input.questions;
      var CONF_MIN = 0.6;
      var perQuestion = (session.answers || []).map(function (a, i) {
        var q = qset.items[i];
        var t = a.transcript;
        var text = t ? (t.corrected != null ? t.corrected : t.raw) : '';
        if (!t || !text.trim()) return { questionId: q.id, excluded: true, excludeReason: 'no_transcript', traits: [], citations: [] };
        if (t.meanConfidence != null && t.meanConfidence < CONF_MIN) return { questionId: q.id, excluded: true, excludeReason: 'low_confidence', traits: [], citations: [] };
        var masked = global.Transcript.mask(text, { names: session.names || [] });
        var r = MockScorer.scoreAnswer(masked.text, q.traits);
        return { questionId: q.id, excluded: false, maskTotal: masked.total, maskedText: masked.text,
                 traits: r.traits, citations: r.citations, flags: r.flags };
      });
      var excluded = perQuestion.filter(function (p) { return p.excluded; }).length;
      return Promise.resolve({
        status: perQuestion.length - excluded > 0 ? 'scored_uncalibrated' : 'no_scorable_answers',
        rubricVersion: input.rubric.version,
        questionSetVersion: qset.version,
        modelId: 'mock-heuristic',
        effort: null,
        promptHash: global.Questions ? global.Questions.fingerprint() : null,
        scoredAt: new Date().toISOString(),
        perQuestion: perQuestion,
        calibrated: null,
        percentile: null,
        routedToHuman: true,
        routeReason: excluded ? 'excluded_answers' : 'uncalibrated'
      });
    }
  };

  global.MockScorer = MockScorer;
  if (global.Providers) global.Providers.register('scorer', MockScorer);
})(typeof window !== 'undefined' ? window : global);

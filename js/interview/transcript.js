/* ============================================================
   transcript.js — 전사 정정 · 편집거리 상한 · 식별자 마스킹

   설계도 R-01/R-03 완화의 순수 로직. DOM 의존 없음 → 헤드리스 테스트 대상.
   ============================================================ */
(function (global) {
  'use strict';

  var Transcript = {};

  /* ---------- 정정 정책 ----------
     오인식 정정은 허용하되 답변을 사후에 고쳐 쓰는 통로가 되면 안 된다.
     게임에서 오입력 취소를 시행당 1회로 제한한 것과 같은 문제다.
     ※ 규준 수집 전 확정 (D-2) */
  Transcript.POLICY = {
    maxEditRatio: 0.15,     // 원문 길이 대비 허용 편집거리
    minEditChars: 20,       // 짧은 답변에도 최소 이만큼은 허용
    maxAttempts: 3          // 정정 시도 횟수 (이력은 전부 남긴다)
  };

  /* ---------- 편집거리 (Levenshtein, 문자 단위) ----------
     한국어는 공백 분절이 불규칙해 단어 단위보다 문자 단위가 안정적이다. */
  Transcript.editDistance = function (a, b) {
    a = a || ''; b = b || '';
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    var prev = new Array(b.length + 1);
    var cur = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;

    for (var i = 1; i <= a.length; i++) {
      cur[0] = i;
      var ca = a.charCodeAt(i - 1);
      for (j = 1; j <= b.length; j++) {
        var cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[b.length];
  };

  /** 이 원문에 허용되는 최대 편집거리 */
  Transcript.editCap = function (raw, policy) {
    policy = policy || Transcript.POLICY;
    var len = (raw || '').length;
    return Math.max(policy.minEditChars, Math.round(len * policy.maxEditRatio));
  };

  /**
   * 정정 시도를 평가한다. 저장 여부와 사유를 돌려주고 이력에 남길 기록을 만든다.
   * 거부되어도 기록은 남는다 — 무엇을 고치려 했는지가 분쟁 시 근거다.
   */
  Transcript.evaluateCorrection = function (raw, proposed, history, policy) {
    policy = policy || Transcript.POLICY;
    history = history || [];
    var attempts = history.length;
    var dist = Transcript.editDistance(raw, proposed);
    var cap = Transcript.editCap(raw, policy);

    var record = {
      at: Date.now(),
      attempt: attempts + 1,
      editDistance: dist,
      cap: cap,
      proposedLength: (proposed || '').length,
      accepted: false,
      reason: null
    };

    if (attempts >= policy.maxAttempts) {
      record.reason = 'max_attempts';
      return { accepted: false, reason: '정정 기회(' + policy.maxAttempts + '회)를 모두 사용했습니다', record: record };
    }
    if (!proposed || !proposed.trim()) {
      record.reason = 'empty';
      return { accepted: false, reason: '빈 내용으로 바꿀 수 없습니다', record: record };
    }
    if (dist === 0) {
      record.reason = 'unchanged';
      return { accepted: false, reason: '변경된 내용이 없습니다', record: record };
    }
    if (dist > cap) {
      record.reason = 'over_cap';
      return {
        accepted: false,
        reason: '수정 폭이 허용 범위(' + cap + '자)를 넘었습니다 (' + dist + '자). 오인식된 부분만 고쳐 주세요',
        record: record
      };
    }

    record.accepted = true;
    record.reason = 'ok';
    return { accepted: true, reason: null, record: record };
  };

  /* ---------- 식별자 마스킹 ----------
     채점기에 보내기 전에 학교·회사·이름·연락처를 지운다. 답변에 이런 단어가
     있으면 판정이 흔들릴 수 있다(R-03). 완전하지 않다 — 패턴 기반은 출발점이고,
     운영에서는 개체명 인식으로 보강해야 한다. 마스킹 건수를 기록해 사후 검토한다. */
  var MASK_RULES = [
    { tag: '[이메일]',  re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
    { tag: '[전화]',    re: /0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g },
    { tag: '[학교]',    re: /[가-힣A-Za-z]+(?:대학교|대학원|대학|고등학교|고교|여고|여자고등학교|중학교|초등학교)/g },
    { tag: '[회사]',    re: /(?:\(주\)\s?[가-힣A-Za-z0-9]+|주식회사\s?[가-힣A-Za-z0-9]+|[가-힣A-Za-z0-9]+\s?주식회사|[가-힣A-Za-z0-9]+(?:전자|물산|건설|은행|증권|카드|보험|제약|화학|중공업|텔레콤|그룹))/g },
    { tag: '[지역]',    re: /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|특별자치도|도|시)?/g }
  ];

  Transcript.mask = function (text, opts) {
    opts = opts || {};
    var out = text || '';
    var counts = {};

    /* 응시자 이름은 세션에서 받아 정확히 지운다 — 패턴으로는 못 잡는다 */
    if (opts.names && opts.names.length) {
      opts.names.forEach(function (n) {
        if (!n || n.length < 2) return;
        var re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        out = out.replace(re, function () { counts['[이름]'] = (counts['[이름]'] || 0) + 1; return '[이름]'; });
      });
    }

    MASK_RULES.forEach(function (r) {
      out = out.replace(r.re, function () { counts[r.tag] = (counts[r.tag] || 0) + 1; return r.tag; });
    });

    return { text: out, counts: counts, total: Object.keys(counts).reduce(function (a, k) { return a + counts[k]; }, 0) };
  };

  /* ---------- 발화 지표 (기록만, 점수 미반영) ---------- */
  Transcript.speechMetrics = function (words, answerMs) {
    var n = (words || []).length;
    var wpm = answerMs > 0 ? Math.round(n / (answerMs / 60000)) : null;
    return { wordCount: n, wordsPerMin: wpm };
  };

  global.Transcript = Transcript;
})(typeof window !== 'undefined' ? window : global);

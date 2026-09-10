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
  /* 접미사 규칙이 못 잡는 이름들 — 접미사 없이 쓰이는 회사·학교 약칭.
     테스트가 실제로 잡아낸 구멍이다 ("네이버에서 2년"이 그대로 채점기에 갔다).
     사전은 완전할 수 없다. 운영에서는 개체명 인식으로 보강하고, 이 목록은 회귀 방지용이다. */
  var COMPANY_NAMES = [
    '네이버', '카카오', '카카오뱅크', '카카오페이', '쿠팡', '배달의민족', '배민', '우아한형제들', '토스', '비바리퍼블리카',
    '당근마켓', '야놀자', '여기어때', '하이브', '엔씨소프트', '엔씨', '넥슨', '넷마블', '크래프톤', '두나무', '업비트',
    '삼성', '현대자동차', '현대차', '기아', '엘지', 'LG', 'SK', '에스케이', '롯데', '신세계', 'CJ', '씨제이', '한화', '포스코', 'KT', '케이티',
    '셀트리온', '케이뱅크', '카카오모빌리티', '무신사', '마켓컬리', '컬리', '직방', '다방', '리디', '왓챠', '티맵', '지마켓', '11번가',
    '구글', '아마존', '마이크로소프트', '애플', '테슬라', '오픈AI', '앤트로픽'
    /* '당근'·'메타'·'라인'은 일반 단어(당근을 썰다, 메타인지, 가이드라인)와 겹쳐 뺐다.
       당근마켓처럼 긴 형태만 잡는다. 사전 규칙은 이런 충돌이 본질이라 운영은 NER이 필요하다. */
  ];
  var SCHOOL_NAMES = [
    '서울대', '연대', '고대', '카이스트', 'KAIST', '포스텍', 'POSTECH', '성대', '한양대', '중앙대', '경희대', '외대', '시립대',
    '이대', '숙대', '건대', '동대', '홍대', '국민대', '숭실대', '세종대', '단국대', '아주대', '인하대', '부산대', '경북대', '전남대', '충남대', '충북대',
    '유니스트', 'UNIST', '디지스트', 'DGIST', '지스트', 'GIST'
  ];
  function nameRule(tag, names) {
    var alts = names.slice().sort(function (a, b) { return b.length - a.length; })   // 긴 이름 먼저
      .map(function (n) { return n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|');
    return { tag: tag, re: new RegExp('(?:' + alts + ')', 'g') };
  }

  var MASK_RULES = [
    { tag: '[이메일]',  re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
    { tag: '[전화]',    re: /0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g },
    { tag: '[학교]',    re: /[가-힣A-Za-z]+(?:대학교|대학원|대학|고등학교|고교|여고|여자고등학교|중학교|초등학교)/g },
    nameRule('[학교]', SCHOOL_NAMES),
    /* "(주)X에서" — 조사(에서·의·은/는…)가 붙어 오므로 이름 뒤 조사 앞에서 멈춘다.
       그러지 않으면 [회사]가 조사까지 삼켜 "이름만 다른 두 답변"이 마스킹 후에도 달라진다.
       편향 회귀 테스트가 실제로 잡아낸 결함이다. */
    { tag: '[회사]',    re: /(?:\(주\)\s?|주식회사\s?)[가-힣A-Za-z0-9]+?(?=(?:에서는|에서|으로|에게|부터|까지|에|의|은|는|이|가|을|를|과|와|로|도|만)?(?:[\s.,!?、]|$))/g },
    { tag: '[회사]',    re: /(?:[가-힣A-Za-z0-9]+\s?주식회사|[가-힣A-Za-z0-9]+(?:전자|물산|건설|은행|증권|카드|보험|제약|화학|중공업|텔레콤|그룹))/g },
    nameRule('[회사]', COMPANY_NAMES),
    { tag: '[지역]',    re: /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|특별자치도|도|시)?/g }
  ];

  Transcript.COMPANY_NAMES = COMPANY_NAMES;
  Transcript.SCHOOL_NAMES = SCHOOL_NAMES;

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

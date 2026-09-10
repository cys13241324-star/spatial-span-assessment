/* ============================================================
   questions.js — 문항 세트와 루브릭 (버전 고정)

   문항과 루브릭은 버전이 바뀌면 과거 점수와 비교할 수 없다.
   그래서 세션에 questionSetVersion / rubricVersion을 새긴다.

   ※ 이 세트는 자리표시자다. 실제 루브릭은 직무분석에서 나와야 한다 (설계도 §5, D-6).
   ============================================================ */
(function (global) {
  'use strict';

  var Questions = {};

  Questions.SET = {
    version: 'qs-0.1.0',
    prepMs: 30000,
    answerMs: 60000,
    practice: {
      id: 'p1', type: 'practice',
      text: '오늘 아침에 무엇을 하셨는지 30초 안에 말씀해 주세요.',
      prepMs: 15000, answerMs: 30000
    },
    items: [
      { id: 'q1', type: 'intro',       traits: ['specificity', 'relevance'],
        text: '1분 안에 본인을 소개해 주세요. 직무와 관련된 경험을 중심으로 말씀해 주시면 됩니다.' },
      { id: 'q2', type: 'motivation',  traits: ['relevance', 'specificity'],
        text: '이 직무에 지원한 이유를 말씀해 주세요.' },
      { id: 'q3', type: 'strength',    traits: ['specificity', 'relevance'],
        text: '본인의 강점 하나와, 그것이 실제로 드러났던 사례를 말씀해 주세요.' },
      { id: 'q4', type: 'behavioral',  traits: ['structure', 'specificity', 'problemSolving'],
        text: '팀에서 의견이 충돌했던 경험을 말씀해 주세요. 상황, 본인이 맡은 일, 실제로 한 행동, 결과 순서로 말씀해 주시면 좋습니다.' },
      { id: 'q5', type: 'situational', traits: ['judgment', 'problemSolving'],
        text: '동료가 마감을 지키지 못해 팀 전체 일정이 밀릴 상황입니다. 어떻게 하시겠습니까?' },
      { id: 'q6', type: 'probe',       traits: ['problemSolving', 'specificity'], probeOf: 'q4',
        text: '방금 말씀하신 의견 충돌 경험에서, 만약 본인의 선택이 틀렸다고 나중에 알게 됐다면 무엇을 다르게 하셨겠습니까?' }
    ]
  };

  /* 루브릭 — 설계도 §5 표를 그대로 옮겼다. "열정·자신감·인상"은 넣지 않는다. */
  Questions.RUBRIC = {
    version: 'rubric-0.1.0',
    scale: [1, 5],
    traits: {
      specificity: {
        label: '구체성',
        looks: '추상적 진술이 아니라 실제 사건·수치·역할이 있는가',
        anchors: { 1: '일반론만', 3: '사건은 있으나 본인 역할 불분명', 5: '사건·역할·결과가 특정됨' }
      },
      relevance: {
        label: '직무 관련성',
        looks: '직무분석에서 도출한 요구와 연결되는가',
        anchors: { 1: '무관', 3: '인접', 5: '직접 대응' }
      },
      structure: {
        label: '구조 (STAR)',
        looks: '상황·과제·행동·결과가 갖춰졌는가',
        anchors: { 1: '하나만', 3: '둘~셋', 5: '넷 모두' }
      },
      problemSolving: {
        label: '문제해결',
        looks: '제약 인식과 대안 비교가 드러나는가',
        anchors: { 1: '없음', 3: '제약만', 5: '제약 + 대안 + 선택 근거' }
      },
      judgment: {
        label: '상황판단',
        looks: '우선순위와 이해관계자를 다루는가',
        anchors: { 1: '단일 조치', 3: '우선순위', 5: '우선순위 + 관계자 고려' }
      }
    },
    excluded: ['열정', '자신감', '인상', '문화 적합성', '표정', '목소리']
  };

  /** 문항이 참조하는 특성이 루브릭에 전부 있는지 — 로드 시점에 검사한다 */
  Questions.validate = function () {
    var problems = [];
    var ids = {};
    Questions.SET.items.forEach(function (q) {
      if (ids[q.id]) problems.push('문항 id 중복: ' + q.id);
      ids[q.id] = true;
      (q.traits || []).forEach(function (t) {
        if (!Questions.RUBRIC.traits[t]) problems.push(q.id + '이 루브릭에 없는 특성을 참조: ' + t);
      });
      if (q.probeOf && !Questions.SET.items.some(function (o) { return o.id === q.probeOf; })) {
        problems.push(q.id + '의 probeOf 대상 없음: ' + q.probeOf);
      }
    });
    Questions.RUBRIC.excluded.forEach(function (x) {
      Object.keys(Questions.RUBRIC.traits).forEach(function (t) {
        if (Questions.RUBRIC.traits[t].label.indexOf(x) >= 0) problems.push('제외 대상 특성이 루브릭에 있음: ' + x);
      });
    });
    return problems;
  };

  /* 루브릭 내용의 지문 — promptHash의 재료. 내용이 바뀌면 값이 바뀐다 */
  Questions.fingerprint = function () {
    var s = JSON.stringify({ q: Questions.SET, r: Questions.RUBRIC });
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'fp_' + (h >>> 0).toString(36);
  };

  global.Questions = Questions;
})(typeof window !== 'undefined' ? window : global);

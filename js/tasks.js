/* ============================================================
   tasks.js — 과제 레지스트리

   셸(app/report)은 과제를 직접 알지 않는다. 아래 서술자(descriptor)만 보고
   화면을 구성하므로, 새 과제는 파일 하나를 추가해 register()만 호출하면 된다.

   서술자 계약
   ------------------------------------------------------------
   id          문자열 식별자 (Trial 로그의 taskId와 같아야 함)
   label       과제 이름
   subtitle    상단바에 표시되는 원본 과제명 · 측정 구인
   consent     { measures, scoring, collects }  사전고지 문구
   brief       [ { h, p } ]  과제 설명 단계 (순서가 의미를 가짐)
   readyNote   본 검사 시작 화면의 추가 경고 (HTML, 없으면 null)
   create(o)   과제 인스턴스 생성. o = { stage, rng, phase, onTrial, onStatus }
               인스턴스는 runPractice() / runLive() / abort() 를 가진다
   score(t)    본 시행 배열 → 점수 객체 (taskId 포함)
   normKey(s)  규준 조회에 쓸 원점수. 규준 게이트가 이 값으로 백분위를 찾는다
   tiles(s)    [ { label, value, unit, hint } ]  리포트 점수 타일
   sections(c) 리포트의 과제별 절 (HTML)
   logTable(c) 원시 로그 표 (HTML)
   explain(c)  { procedure, formula, rtNote, extraRows }  산출근거 설명 조각
   ============================================================ */
(function (global) {
  'use strict';

  var REQUIRED = ['id', 'label', 'subtitle', 'consent', 'brief',
                  'create', 'score', 'normKey', 'tiles', 'logTable', 'explain'];

  var registry = {};
  var order = [];

  var Tasks = {
    register: function (d) {
      var missing = REQUIRED.filter(function (k) { return d[k] == null; });
      if (missing.length) {
        throw new Error('과제 서술자에 필수 항목이 없습니다 (' + (d.id || '?') + '): ' + missing.join(', '));
      }
      if (registry[d.id]) {
        throw new Error('과제 id가 중복되었습니다: ' + d.id);
      }
      registry[d.id] = d;
      order.push(d.id);
      return d;
    },

    get: function (id) { return registry[id] || null; },

    list: function () {
      return order.map(function (id) { return registry[id]; });
    },

    /** ?task=<id> 로 직접 지정 가능. 없으면 null */
    fromQuery: function () {
      var m = /[?&]task=([^&]+)/.exec(location.search);
      if (!m) return null;
      return Tasks.get(decodeURIComponent(m[1]));
    }
  };

  global.Tasks = Tasks;
})(window);

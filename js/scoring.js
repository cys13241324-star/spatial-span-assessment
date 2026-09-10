/* ============================================================
   scoring.js — 도형 순서 기억(Corsi) 채점
   근거 절차: Corsi (1972), 채점 규칙: Kessels et al. (2000)
   ============================================================ */
(function (global) {
  'use strict';

  var Scoring = {};

  /**
   * Corsi 채점
   *  - Corsi Span   : 정답으로 재현한 가장 긴 순서 길이
   *  - Correct      : 정답 시행 수 (본 시행 기준)
   *  - Total Score  : Span x Correct   (Kessels et al., 2000)
   *  - meanRtTotal  : 정답 시행의 평균 총 반응시간
   *
   * RT는 단독 지표로 쓰지 않는다. 브라우저·기기별 오차가 있으므로
   * 정확도 기반 점수의 보조 지표로만 보고한다.
   */
  Scoring.spatialSpan = function (liveTrials) {
    var span = 0;
    var correct = 0;
    var rtSum = 0;
    var rtN = 0;
    var byLevel = {};

    liveTrials.forEach(function (t) {
      var lv = t.difficulty;
      if (!byLevel[lv]) byLevel[lv] = { level: lv, attempts: 0, correct: 0, rts: [] };
      byLevel[lv].attempts++;

      if (t.correct) {
        correct++;
        byLevel[lv].correct++;
        if (lv > span) span = lv;
        if (typeof t.rtTotalMs === 'number') {
          rtSum += t.rtTotalMs;
          rtN++;
          byLevel[lv].rts.push(t.rtTotalMs);
        }
      }
    });

    var levels = Object.keys(byLevel)
      .map(function (k) { return byLevel[k]; })
      .sort(function (a, b) { return a.level - b.level; })
      .map(function (l) {
        var mean = l.rts.length
          ? Math.round(l.rts.reduce(function (a, b) { return a + b; }, 0) / l.rts.length)
          : null;
        return {
          level: l.level,
          attempts: l.attempts,
          correct: l.correct,
          accuracy: l.attempts ? l.correct / l.attempts : 0,
          meanRtMs: mean
        };
      });

    return {
      taskId: 'spatial-span',
      corsiSpan: span,
      correctTrials: correct,
      totalTrials: liveTrials.length,
      totalScore: span * correct,
      meanRtTotalMs: rtN ? Math.round(rtSum / rtN) : null,
      byLevel: levels
    };
  };

  /**
   * 부분 점수 진단용: 응답이 자극과 어디서 갈라졌는지.
   * 오류 유형 분석(순서 오류 vs 위치 오류)은 타당도 연구에서 유용하다.
   */
  Scoring.errorProfile = function (liveTrials) {
    var orderErrors = 0;   // 위치는 맞으나 순서가 틀림
    var itemErrors = 0;    // 자극에 없던 위치를 누름
    var omissions = 0;     // 길이 미달

    liveTrials.forEach(function (t) {
      if (t.correct) return;
      var stim = t.stimulus, resp = t.response;
      if (resp.length < stim.length) omissions++;

      var stimSet = {};
      stim.forEach(function (s) { stimSet[s] = true; });

      var wrongItem = false;
      resp.forEach(function (r) { if (!stimSet[r]) wrongItem = true; });

      if (wrongItem) itemErrors++;
      else if (resp.length === stim.length) orderErrors++;
    });

    return { orderErrors: orderErrors, itemErrors: itemErrors, omissions: omissions };
  };

  /**
   * 오입력 수정 / 시간초과 요약.
   * sinceTapMs가 짧으면 손 실수, 길면 망설임(=기억 불확실)이다.
   * 후자가 잦으면 그 응시자의 점수는 취소 기능의 도움을 받은 것이므로
   * 타당도 분석 시 별도 취급해야 한다.
   */
  Scoring.inputCorrections = function (liveTrials) {
    var SLIP_MS = 800;   // 이 이하를 손 실수로 간주
    var trialsWithUndo = 0, totalUndos = 0, slips = 0, deliberations = 0, timedOut = 0;

    liveTrials.forEach(function (t) {
      if (t.timedOut) timedOut++;
      var us = t.undos || [];
      if (us.length) trialsWithUndo++;
      us.forEach(function (u) {
        totalUndos++;
        if (u.sinceTapMs <= SLIP_MS) slips++;
        else deliberations++;
      });
    });

    return {
      trialsWithUndo: trialsWithUndo,
      totalUndos: totalUndos,
      slips: slips,
      deliberations: deliberations,
      timedOutTrials: timedOut
    };
  };

  /** 무결성 이벤트 요약 — 본 시행 구간에 탭 이탈이 있었는지 */
  Scoring.integritySummary = function (events, liveWindow) {
    var flags = [];
    var blur = 0, hidden = 0, resize = 0;

    events.forEach(function (e) {
      if (liveWindow && (e.at < liveWindow.from || e.at > liveWindow.to)) return;
      if (e.type === 'blur') blur++;
      if (e.type === 'visibility' && e.detail === 'hidden') hidden++;
      if (e.type === 'resize') resize++;
    });

    if (hidden > 0) flags.push({ label: '탭 이탈 ' + hidden + '회', flag: true });
    if (blur > 0) flags.push({ label: '창 포커스 이탈 ' + blur + '회', flag: true });
    if (resize > 0) flags.push({ label: '창 크기 변경 ' + resize + '회', flag: resize > 2 });
    if (!flags.length) flags.push({ label: '이상 없음', flag: false });

    return flags;
  };

  global.Scoring = Scoring;
})(window);

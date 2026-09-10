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

  /* ============================================================
     신호탐지이론 (N-back 채점의 기초)

     N-back은 span 과제가 아니라 연속 판단 과제다. 따라서 "정답률"만으로는
     민감도와 반응 편향이 뒤섞인다. 아무 때나 "같다"를 누르는 응시자도
     적중률이 높게 나오기 때문이다. d′는 이 둘을 분리한다.
     ============================================================ */

  /** 표준정규 분위함수 (Acklam 근사). d′ 계산에 필요 */
  function probit(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;

    var a = [-3.969683028665376e+01,  2.209460984245205e+02, -2.759285104469687e+02,
              1.383577518672690e+02, -3.066479806614716e+01,  2.506628277459239e+00];
    var b = [-5.447609879822406e+01,  1.615858368580409e+02, -1.556989798598866e+02,
              6.680131188771972e+01, -1.328068155288572e+01];
    var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00,  4.374664141464968e+00,  2.938163982698783e+00];
    var d = [ 7.784695709041462e-03,  3.224671290700398e-01,  2.445134137142996e+00,
              3.754408661907416e+00];

    var plow = 0.02425, phigh = 1 - plow, q, r;

    if (p < plow) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
             ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    }
    if (p > phigh) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
              ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    }
    q = p - 0.5; r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }

  Scoring.probit = probit;

  /**
   * 적중/오경보에서 d′와 반응편향 c를 낸다.
   * log-linear 보정(Hautus 1995)을 적용해 적중률 0% 또는 100%에서
   * d′가 무한대로 발산하는 것을 막는다 — 짧은 검사에서 반드시 필요하다.
   */
  Scoring.sdt = function (hits, targets, falseAlarms, nonTargets) {
    if (targets <= 0 || nonTargets <= 0) {
      return { hitRate: null, faRate: null, dPrime: null, criterion: null,
               hits: hits, targets: targets, falseAlarms: falseAlarms, nonTargets: nonTargets };
    }
    var hr = (hits + 0.5) / (targets + 1);
    var far = (falseAlarms + 0.5) / (nonTargets + 1);
    var zh = probit(hr), zf = probit(far);

    return {
      hitRate: hits / targets,
      faRate: falseAlarms / nonTargets,
      dPrime: Math.round((zh - zf) * 100) / 100,
      criterion: Math.round((-(zh + zf) / 2) * 100) / 100,
      hits: hits, targets: targets,
      falseAlarms: falseAlarms, nonTargets: nonTargets
    };
  };

  /* ============================================================
     도형 N-back 채점

     조건별로 따로 집계한다. 2-back과 3-back을 합치면 안 된다 —
     둘은 난이도가 다르고, 3-back이 2-back보다 낮게 나오는지가
     이 과제가 실제로 작업기억 부하를 재고 있는지 확인하는 근거다.
     ============================================================ */
  Scoring.shapeNback = function (liveTrials) {
    var judged = liveTrials.filter(function (t) {
      return t.taskFields && t.taskFields.judged;
    });

    /* 조건 키: r1-2back / r2-2back / r2-3back */
    var buckets = {};
    function bucket(key) {
      if (!buckets[key]) {
        buckets[key] = { key: key, hits: 0, misses: 0, fa: 0, cr: 0,
                         targets: 0, nonTargets: 0, rts: [], noResponse: 0 };
      }
      return buckets[key];
    }

    var totalCorrect = 0, totalNoResponse = 0;

    judged.forEach(function (t) {
      var f = t.taskFields;
      var cond = f.condition;                       // 'two' | 'three' | 'none'
      var round = f.round;

      /* 표적 조건은 그 조건의 버킷에, 비표적은 그 라운드의 모든 조건에
         공통 오경보 기회로 들어간다. 라운드 1은 조건이 하나뿐이다. */
      var condKeys = round === 1 ? ['r1-2back']
                                 : (cond === 'three' ? ['r2-3back']
                                 :  cond === 'two'   ? ['r2-2back']
                                 :                     ['r2-2back', 'r2-3back']);

      if (t.correct) totalCorrect++;
      if (f.responseKey === null) totalNoResponse++;

      condKeys.forEach(function (k) {
        var b = bucket(k);

        if (cond === 'none') {
          b.nonTargets++;
          /* 비표적에서 화살표를 눌렀으면 오경보 */
          if (f.responseKey === 'two' || f.responseKey === 'three') b.fa++;
          else b.cr++;
        } else {
          b.targets++;
          if (f.responseKey === cond) {
            b.hits++;
            if (typeof t.rtFirstMs === 'number') b.rts.push(t.rtFirstMs);
          } else {
            b.misses++;
            if (f.responseKey === null) b.noResponse++;
          }
        }
      });
    });

    var conditions = ['r1-2back', 'r2-2back', 'r2-3back']
      .filter(function (k) { return buckets[k]; })
      .map(function (k) {
        var b = buckets[k];
        var s = Scoring.sdt(b.hits, b.targets, b.fa, b.nonTargets);
        var meanRt = b.rts.length
          ? Math.round(b.rts.reduce(function (a, c) { return a + c; }, 0) / b.rts.length)
          : null;
        return {
          key: k,
          label: k === 'r1-2back' ? '1라운드 · 2-back'
               : k === 'r2-2back' ? '2라운드 · 2-back'
               :                    '2라운드 · 3-back',
          hits: b.hits, misses: b.misses, falseAlarms: b.fa,
          correctRejections: b.cr, targets: b.targets, nonTargets: b.nonTargets,
          noResponse: b.noResponse,
          hitRate: s.hitRate, faRate: s.faRate,
          dPrime: s.dPrime, criterion: s.criterion,
          meanRtMs: meanRt
        };
      });

    /* 종합 d′ — 조건별 d′의 단순 평균. 규준 조회의 기준 원점수로 쓴다 */
    var dvals = conditions.map(function (c) { return c.dPrime; })
                          .filter(function (v) { return v != null && isFinite(v); });
    var overall = dvals.length
      ? Math.round((dvals.reduce(function (a, b) { return a + b; }, 0) / dvals.length) * 100) / 100
      : null;

    return {
      taskId: 'shape-nback',
      judgedTrials: judged.length,
      totalTrials: liveTrials.length,
      correctTrials: totalCorrect,
      accuracy: judged.length ? totalCorrect / judged.length : 0,
      noResponseTrials: totalNoResponse,
      overallDPrime: overall,
      conditions: conditions
    };
  };

  global.Scoring = Scoring;
})(window);

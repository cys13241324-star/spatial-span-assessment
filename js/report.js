/* ============================================================
   report.js — 결과 리포트 + 자동화 결정 설명 화면
   개인정보보호법 §37조의2 대응: 산출 근거 공개 / 거부권 / 인적 재검토
   ============================================================ */
(function (global) {
  'use strict';

  var Report = {};

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function seqStr(arr) {
    return arr.map(function (v) { return v + 1; }).join(' → ');
  }

  function ms(v) { return v == null ? '—' : v.toLocaleString() + ' ms'; }

  /* ============================================================
     결과 리포트
     ============================================================ */
  Report.render = function (mount, ctx) {
    var s = ctx.score;
    var pct = Core.Norms.percentile(s.taskId, s.totalScore);
    var hasNorms = Core.Norms.has(s.taskId);
    var err = ctx.errorProfile;
    var integrity = ctx.integrity;

    var html = '';

    html += '<p class="eyebrow">결과 리포트</p>';
    html += '<h1>도형 순서 기억 · 응시 결과</h1>';

    /* ---------- 점수 타일 ---------- */
    html += '<div class="score-row">';

    html += tile('Corsi Span', s.corsiSpan, '개', '정답 재현한 가장 긴 순서');
    html += tile('정답 시행', s.correctTrials + ' / ' + s.totalTrials, '', '본 시행 기준');
    html += tile('Total Score', s.totalScore, '', 'Span × 정답 시행 수');
    html += tile('평균 반응시간', s.meanRtTotalMs == null ? '—' : s.meanRtTotalMs.toLocaleString(), 'ms', '정답 시행 평균 · 보조 지표');

    /* 백분위 — 규준 게이트 */
    if (hasNorms) {
      html += tile('백분위', pct, '%', '규준 표본 n = ' + Core.Norms.tables[s.taskId].n);
    } else {
      html += '<div class="score-tile blocked">' +
                '<div class="label">백분위 / 등급</div>' +
                '<div class="value">산출 불가</div>' +
                '<div class="hint">' + esc(Core.Norms.reason(s.taskId)) + '</div>' +
              '</div>';
    }

    html += '</div>';

    if (!hasNorms) {
      html += '<div class="callout warn">' +
                '<strong>규준 미확보</strong> — 백분위·등급은 코드 차원에서 차단되어 있습니다. ' +
                '대표 표본(척도별 n ≥ 300)을 수집하기 전까지 원점수만 유효하며, ' +
                '이 점수를 선발·탈락 판단의 근거로 사용할 수 없습니다.' +
              '</div>';
    }

    /* ---------- 단계별 성적 ---------- */
    html += '<h2>단계별 성적</h2>';
    html += '<div class="table-scroll"><table>';
    html += '<thead><tr><th>순서 길이</th><th>시행</th><th>정답</th><th>정확도</th><th>평균 반응시간</th></tr></thead><tbody>';
    s.byLevel.forEach(function (l) {
      html += '<tr>' +
                '<td>' + l.level + '</td>' +
                '<td>' + l.attempts + '</td>' +
                '<td>' + l.correct + '</td>' +
                '<td>' + Math.round(l.accuracy * 100) + '%</td>' +
                '<td>' + ms(l.meanRtMs) + '</td>' +
              '</tr>';
    });
    html += '</tbody></table></div>';

    /* ---------- 오류 유형 ---------- */
    html += '<h2>오류 유형</h2>';
    html += '<p>타당도 연구에서 순서 오류와 위치 오류는 서로 다른 처리 과정을 반영합니다. 프로토타입 단계부터 분리 집계합니다.</p>';
    html += '<div class="integrity">';
    html += '<span class="chip">순서 오류 ' + err.orderErrors + '건</span>';
    html += '<span class="chip">위치 오류 ' + err.itemErrors + '건</span>';
    html += '<span class="chip">누락 ' + err.omissions + '건</span>';
    html += '</div>';

    /* ---------- 오입력 수정 ---------- */
    var corr = ctx.corrections;
    html += '<h2>오입력 수정</h2>';
    html += '<p>취소 직후 경과시간이 짧으면 손 실수, 길면 기억이 불확실해 망설인 것으로 봅니다. ' +
            '후자가 잦은 응시자는 취소 기능의 도움을 받은 점수이므로 타당도 분석에서 별도 취급합니다.</p>';
    html += '<div class="integrity">';
    html += '<span class="chip">수정 발생 시행 ' + corr.trialsWithUndo + '건</span>';
    html += '<span class="chip">총 취소 ' + corr.totalUndos + '회</span>';
    html += '<span class="chip">손 실수 추정 ' + corr.slips + '회</span>';
    html += '<span class="chip' + (corr.deliberations > 2 ? ' flag' : '') + '">망설임 추정 ' + corr.deliberations + '회</span>';
    if (corr.timedOutTrials > 0) {
      html += '<span class="chip flag">시간 초과 ' + corr.timedOutTrials + '시행</span>';
    }
    html += '</div>';

    /* ---------- 응시 무결성 ---------- */
    html += '<h2>응시 무결성</h2>';
    html += '<div class="integrity">';
    integrity.forEach(function (f) {
      html += '<span class="chip' + (f.flag ? ' flag' : '') + '">' + esc(f.label) + '</span>';
    });
    html += '</div>';

    /* ---------- 시행 원시 로그 ---------- */
    html += '<h2>시행 원시 로그 (본 시행)</h2>';
    html += '<p>이 로그가 타당도 검증·규준 수집·사후 재채점의 근거 자료입니다. 시드(<code>' +
            esc(ctx.session.seed) + '</code>)만으로 전 시행의 자극을 재현할 수 있습니다.</p>';
    html += '<div class="table-scroll"><table>';
    html += '<thead><tr><th>#</th><th>길이</th><th>자극</th><th>응답</th><th>정오</th>' +
            '<th>수정</th><th>첫 반응</th><th>총 반응</th></tr></thead><tbody>';
    ctx.liveTrials.forEach(function (t, i) {
      var verdict = t.timedOut
        ? '<span class="tag err">시간초과</span>'
        : '<span class="tag ' + (t.correct ? 'ok">정답' : 'err">오답') + '</span>';

      var undoCell = '—';
      if (t.undoCount) {
        var slip = (t.undos || []).every(function (u) { return u.sinceTapMs <= 800; });
        undoCell = t.undoCount + '회 <span class="tag ' + (slip ? 'ok' : 'err') + '">' +
                   (slip ? '실수' : '망설임') + '</span>';
      }

      html += '<tr>' +
                '<td>' + (i + 1) + '</td>' +
                '<td>' + t.difficulty + '</td>' +
                '<td class="seq">' + seqStr(t.stimulus) + '</td>' +
                '<td class="seq">' + (t.response.length ? seqStr(t.response) : '—') + '</td>' +
                '<td>' + verdict + '</td>' +
                '<td>' + undoCell + '</td>' +
                '<td>' + ms(t.rtFirstMs) + '</td>' +
                '<td>' + ms(t.rtTotalMs) + '</td>' +
              '</tr>';
    });
    html += '</tbody></table></div>';

    /* ---------- 액션 ---------- */
    html += '<div class="actions">' +
              '<button class="btn ghost" id="btnDownload">원시 로그 JSON 내려받기</button>' +
              '<button class="btn ghost" id="btnRestart">다시 응시</button>' +
              '<button class="btn primary" id="btnExplain">이 결과는 어떻게 산출되었나요?</button>' +
            '</div>';

    mount.innerHTML = html;

    /* ---------- 핸들러 ---------- */
    mount.querySelector('#btnDownload').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(ctx.raw, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = ctx.session.id + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });

    mount.querySelector('#btnRestart').addEventListener('click', function () {
      location.reload();
    });

    mount.querySelector('#btnExplain').addEventListener('click', function () {
      Report.renderExplain(document.getElementById('explainBody'), ctx);
      global.App.show('screen-explain');
    });

    function tile(label, value, unit, hint) {
      return '<div class="score-tile">' +
               '<div class="label">' + esc(label) + '</div>' +
               '<div class="value">' + esc(value) +
                 (unit ? '<span class="unit">' + esc(unit) + '</span>' : '') +
               '</div>' +
               (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') +
             '</div>';
    }
  };

  /* ============================================================
     자동화 결정 설명 화면 (§37조의2)
     ============================================================ */
  Report.renderExplain = function (mount, ctx) {
    var s = ctx.score;
    var html = '';

    html += '<p class="eyebrow">산출 근거 설명</p>';
    html += '<h1>이 점수는 이렇게 계산되었습니다</h1>';

    html += '<div class="callout">' +
              '개인정보보호법 §37조의2에 따라, 완전히 자동화된 시스템의 결정이 귀하의 권리·의무에 중대한 영향을 미치는 경우 ' +
              '귀하는 <strong>그 결정을 거부하고 설명을 요구</strong>할 수 있으며, <strong>사람에 의한 재검토</strong>를 요청할 수 있습니다. ' +
              '이 화면은 그 설명 의무를 이행하기 위한 것입니다.' +
            '</div>';

    /* 1. 측정 대상 */
    html += '<h2>1. 무엇을 측정했는가</h2>';
    html += '<p><strong>시공간 작업기억 용량</strong>을 측정했습니다. 사용한 절차는 Corsi Block-Tapping Test(Corsi, 1972)이며, ' +
            '채점 규칙은 Kessels et al.(2000)을 따릅니다. 9개 도형을 불규칙하게 배치한 것은 격자 배치가 위치를 ' +
            '언어적으로 부호화하게 만들어 측정 대상을 오염시키기 때문입니다.</p>';

    /* 2. 절차 */
    html += '<h2>2. 어떤 절차로 진행되었는가</h2>';
    html += '<div class="formula">' +
      '순서 길이 <b>2</b>에서 시작\n' +
      '각 길이에서 <b>2회</b> 시행\n' +
      '  ├ 1회 이상 정답 → 길이 +1 후 계속\n' +
      '  └ 2회 모두 오답 → 종료\n' +
      '자극 제시: 도형당 <b>1,000ms</b> 점등, 간격 <b>500ms</b>\n' +
      '본 시행에서는 정답 여부를 알려주지 않음 (표준 비피드백 절차)\n\n' +
      '오입력 수정: 시행당 <b>1회</b>, 마지막 입력 후 <b>2초</b> 이내\n' +
      '입력 완료 후 <b>2초</b>의 확정 유예 (그 사이 취소 가능, 이후 자동 확정)\n' +
      '무응답 상한: <b>8초 + 순서당 2.5초</b> (초과 시 미완성으로 기록)' +
    '</div>';

    html += '<p>수정 횟수를 시행당 1회로 제한한 이유를 밝힙니다. 무제한 취소를 허용하면 ' +
            '"눌러보고 취소"를 반복하며 사실상 자극 시연을 연장할 수 있어, ' +
            '작업기억이 아닌 다른 능력을 측정하게 됩니다. 반대로 취소를 전면 금지하면 ' +
            '마우스 조작 실수가 점수에 섞여 들어갑니다. 손 실수만 복구 가능한 폭으로 좁힌 것이며, ' +
            '<strong>모든 취소는 발생 시각과 함께 기록되어 결과에 표시됩니다.</strong></p>';

    /* 3. 계산 */
    html += '<h2>3. 점수는 어떻게 계산되었는가</h2>';
    html += '<div class="formula">' +
      'Corsi Span  = 정답으로 재현한 가장 긴 순서의 길이\n' +
      '            = <b>' + s.corsiSpan + '</b>\n\n' +
      '정답 시행 수 = <b>' + s.correctTrials + '</b>  (전체 ' + s.totalTrials + '시행 중)\n\n' +
      'Total Score = Corsi Span × 정답 시행 수\n' +
      '            = ' + s.corsiSpan + ' × ' + s.correctTrials + '\n' +
      '            = <b>' + s.totalScore + '</b>' +
    '</div>';

    html += '<p>반응시간(' + ms(s.meanRtTotalMs) + ')은 <strong>점수에 반영되지 않았습니다.</strong> ' +
            '브라우저·기기별로 반응시간 측정에 계통 오차가 존재한다는 것이 선행 연구에서 확인되었기 때문에, ' +
            '보정 근거가 확보되기 전까지 참고 지표로만 보고합니다.</p>';

    /* 4. 결정 */
    html += '<h2>4. 이 점수로 무엇이 결정되는가</h2>';
    html += '<div class="callout warn">' +
              '<strong>현재 빌드에서는 어떠한 결정도 이루어지지 않습니다.</strong> 규준 표본이 없어 백분위·등급이 산출되지 않으며, ' +
              '합격·불합격 판정에 사용될 수 없습니다. 규준과 준거관련 타당도가 확보된 이후에도 이 점수는 ' +
              '단독 판단 근거가 아니라 다중 자료 중 하나로만 사용되어야 합니다.' +
            '</div>';

    /* 5. 수집 데이터 */
    html += '<h2>5. 수집된 데이터</h2>';
    html += '<div class="table-scroll"><table>';
    html += '<thead><tr><th>항목</th><th>내용</th><th>목적</th></tr></thead><tbody>';
    html += row('세션 ID', ctx.session.id, '응답 식별');
    html += row('자극 시드', ctx.session.seed, '자극 재현 · 감사');
    html += row('시행 로그', ctx.liveTrials.length + '건 (자극·응답·정오·반응시간)', '채점 · 타당도 검증');
    html += row('오입력 수정 내역', ctx.corrections.totalUndos + '회 (발생 시각·직전 입력 경과시간)', '실수 / 망설임 구분');
    html += row('기기 지문', ctx.session.deviceFingerprint, '반응시간 계통 오차 보정');
    html += row('무결성 이벤트', ctx.raw.integrityEvents.length + '건 (탭 이탈 등)', '응시 환경 이상 감지');
    html += row('영상 · 음성 · 생체정보', '수집하지 않음', '—');
    html += '</tbody></table></div>';

    /* 6. 권리 행사 */
    html += '<h2>6. 권리 행사</h2>';
    html += '<p>아래 요청은 담당자에게 전달되며, 자동화 시스템이 아닌 <strong>사람이 검토</strong>합니다. ' +
            '(프로토타입에서는 요청 내용이 콘솔에 기록됩니다.)</p>';
    html += '<div class="actions" style="justify-content:flex-start">' +
              '<button class="btn ghost" data-req="reject">이 결정을 거부합니다</button>' +
              '<button class="btn ghost" data-req="review">사람의 재검토를 요청합니다</button>' +
              '<button class="btn ghost" data-req="delete">내 데이터 삭제를 요청합니다</button>' +
            '</div>';
    html += '<div id="reqResult"></div>';

    html += '<div class="actions">' +
              '<button class="btn primary" data-goto="screen-report">결과로 돌아가기</button>' +
            '</div>';

    mount.innerHTML = html;

    /* 권리 행사 핸들러 — 실제 제품에서는 재검토 큐에 적재 */
    var labels = {
      reject: '자동화 결정 거부',
      review: '인적 재검토 요청',
      delete: '데이터 삭제 요청'
    };

    Array.prototype.forEach.call(mount.querySelectorAll('[data-req]'), function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-req');
        var ticket = {
          type: kind,
          sessionId: ctx.session.id,
          requestedAt: new Date().toISOString(),
          status: 'queued_for_human_review'
        };
        console.log('[explain] 권리 행사 요청 접수', ticket);
        mount.querySelector('#reqResult').innerHTML =
          '<div class="callout"><strong>' + esc(labels[kind]) + '</strong>이 접수되었습니다. ' +
          '접수번호 <code>' + esc(ctx.session.id) + '</code> · 상태 <code>queued_for_human_review</code>. ' +
          '실제 제품에서는 이 요청이 담당자 큐로 적재되고 처리 기한이 관리됩니다.</div>';
      });
    });

    function row(k, v, purpose) {
      return '<tr><td>' + esc(k) + '</td><td class="seq">' + esc(v) + '</td><td>' + esc(purpose) + '</td></tr>';
    }
  };

  global.Report = Report;
})(window);

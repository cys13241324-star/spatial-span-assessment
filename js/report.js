/* ============================================================
   report.js — 결과 리포트 + 자동화 결정 설명 화면

   과제별 내용은 서술자(tiles / sections / logTable / explain)에서 받고,
   규준 게이트 · 무결성 · 권리 행사처럼 모든 과제에 공통인 부분만 여기서 만든다.
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

  function tileHtml(t) {
    return '<div class="score-tile">' +
             '<div class="label">' + esc(t.label) + '</div>' +
             '<div class="value">' + esc(t.value) +
               (t.unit ? '<span class="unit">' + esc(t.unit) + '</span>' : '') +
             '</div>' +
             (t.hint ? '<div class="hint">' + esc(t.hint) + '</div>' : '') +
           '</div>';
  }

  /* ============================================================
     결과 리포트
     ============================================================ */
  Report.render = function (mount, ctx) {
    var desc = ctx.desc;
    var s = ctx.score;
    var raw = desc.normKey(s);
    var hasNorms = Core.Norms.has(s.taskId);
    var pct = Core.Norms.percentile(s.taskId, raw);

    var html = '';

    html += '<p class="eyebrow">결과 리포트</p>';
    html += '<h1>' + esc(desc.label) + ' · 응시 결과</h1>';

    /* ---------- 점수 타일 + 규준 게이트 ---------- */
    html += '<div class="score-row">';
    desc.tiles(s).forEach(function (t) { html += tileHtml(t); });

    if (hasNorms) {
      html += tileHtml({
        label: '백분위', value: pct, unit: '%',
        hint: '규준 표본 n = ' + Core.Norms.tables[s.taskId].n
      });
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

    /* ---------- 과제별 절 ---------- */
    html += desc.sections(ctx);

    /* ---------- 응시 무결성 (공통) ---------- */
    html += '<h2>응시 무결성</h2>';
    html += '<div class="integrity">';
    ctx.integrity.forEach(function (f) {
      html += '<span class="chip' + (f.flag ? ' flag' : '') + '">' + esc(f.label) + '</span>';
    });
    html += '</div>';

    /* ---------- 원시 로그 (과제별) ---------- */
    html += desc.logTable(ctx);

    /* ---------- 액션 ---------- */
    html += '<div class="actions">' +
              '<button class="btn ghost" id="btnDownload">원시 로그 JSON 내려받기</button>' +
              '<button class="btn ghost" id="btnRestart">다른 과제 응시</button>' +
              '<button class="btn primary" id="btnExplain">이 결과는 어떻게 산출되었나요?</button>' +
            '</div>';

    mount.innerHTML = html;

    mount.querySelector('#btnDownload').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(ctx.raw, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = ctx.session.id + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });

    mount.querySelector('#btnRestart').addEventListener('click', function () {
      location.href = location.pathname;
    });

    mount.querySelector('#btnExplain').addEventListener('click', function () {
      Report.renderExplain(document.getElementById('explainBody'), ctx);
      global.App.show('screen-explain');
    });
  };

  /* ============================================================
     자동화 결정 설명 화면 (§37조의2)
     ============================================================ */
  Report.renderExplain = function (mount, ctx) {
    var desc = ctx.desc;
    var ex = desc.explain(ctx);
    var html = '';

    html += '<p class="eyebrow">산출 근거 설명</p>';
    html += '<h1>이 점수는 이렇게 계산되었습니다</h1>';

    html += '<div class="callout">' +
              '개인정보보호법 §37조의2에 따라, 완전히 자동화된 시스템의 결정이 귀하의 권리·의무에 ' +
              '중대한 영향을 미치는 경우 귀하는 <strong>그 결정을 거부하고 설명을 요구</strong>할 수 있으며, ' +
              '<strong>사람에 의한 재검토</strong>를 요청할 수 있습니다. 이 화면은 그 설명 의무를 ' +
              '이행하기 위한 것입니다.' +
            '</div>';

    html += '<h2>1. 무엇을 측정했는가</h2>';
    html += '<p>' + ex.measures + '</p>';

    html += '<h2>2. 어떤 절차로 진행되었는가</h2>';
    html += '<div class="formula">' + ex.procedure + '</div>';

    html += '<h2>3. 점수는 어떻게 계산되었는가</h2>';
    html += '<div class="formula">' + ex.formula + '</div>';
    html += '<p>' + ex.rtNote + '</p>';

    html += '<h2>4. 이 점수로 무엇이 결정되는가</h2>';
    html += '<div class="callout warn">' +
              '<strong>현재 빌드에서는 어떠한 결정도 이루어지지 않습니다.</strong> 규준 표본이 없어 ' +
              '백분위·등급이 산출되지 않으며, 합격·불합격 판정에 사용될 수 없습니다. 규준과 준거관련 ' +
              '타당도가 확보된 이후에도 이 점수는 단독 판단 근거가 아니라 다중 자료 중 하나로만 ' +
              '사용되어야 합니다.' +
            '</div>';

    html += '<h2>5. 수집된 데이터</h2>';
    html += '<div class="table-scroll"><table>';
    html += '<thead><tr><th>항목</th><th>내용</th><th>목적</th></tr></thead><tbody>';
    html += row('세션 ID', ctx.session.id, '응답 식별');
    html += row('자극 시드', ctx.session.seed, '자극 재현 · 감사');
    (ex.extraRows || []).forEach(function (r) { html += row(r[0], r[1], r[2]); });
    html += row('기기 지문', ctx.session.deviceFingerprint, '반응시간 계통 오차 보정');
    html += row('무결성 이벤트', ctx.raw.integrityEvents.length + '건 (탭 이탈 등)', '응시 환경 이상 감지');
    html += row('영상 · 음성 · 생체정보', '수집하지 않음', '—');
    html += '</tbody></table></div>';

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
          taskId: ctx.score.taskId,
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

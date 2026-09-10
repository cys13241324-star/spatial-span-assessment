/* ============================================================
   report.js — 검토자 화면 + 산출근거 설명 (§37조의2)

   자동 점수가 보류 상태여도 화면은 완전해야 한다. 검토자가 보는 것은
   전사·신뢰도·행동지표·정정 이력·저장 완전성·무결성 — 채점기가 붙으면
   여기에 특성별 점수와 근거 인용이 추가된다.
   ============================================================ */
(function (global) {
  'use strict';

  var R = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function ms(v) { return v == null ? '—' : v.toLocaleString() + ' ms'; }
  function tile(label, value, unit, hint) {
    return '<div class="score-tile"><div class="label">' + esc(label) + '</div>' +
           '<div class="value">' + esc(value) + (unit ? '<span class="unit">' + esc(unit) + '</span>' : '') + '</div>' +
           (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
  }

  R.render = function (mount, ctx) {
    var s = ctx.session;
    var sc = s.score || { status: 'pending' };
    var answers = s.answers || [];
    var withT = answers.filter(function (a) { return a.transcript; });
    var meanConf = withT.length
      ? withT.reduce(function (acc, a) { return acc + (a.transcript.meanConfidence || 0); }, 0) / withT.length : null;
    var corrections = answers.reduce(function (n, a) { return n + (a.transcript ? a.transcript.corrections.filter(function (c) { return c.accepted; }).length : 0); }, 0);
    var incomplete = answers.filter(function (a) { return !a.media.complete; }).length;

    var html = '';
    html += '<p class="eyebrow">검토자 화면</p>';
    html += '<h1>영상면접 · 기록</h1>';

    /* 테스트 모드·우회 기록은 맨 위에. 아래 어떤 숫자도 평가 자료가 아니다 */
    if (s.testMode || (s.bypasses && s.bypasses.length)) {
      html += '<div class="callout err"><strong>테스트 모드 기록 — 평가 자료로 사용할 수 없습니다.</strong> ' +
        (s.bypasses && s.bypasses.length
          ? '우회 ' + s.bypasses.length + '건: ' + s.bypasses.map(function (b) { return esc(b.gate) + ' (' + esc(b.reason) + ')'; }).join(', ')
          : '우회 없음') + '</div>';
    }

    html += '<div class="score-row">';
    if (sc.status === 'pending') {
      html += '<div class="score-tile blocked"><div class="label">자동 점수</div><div class="value">보류</div><div class="hint">' + esc(sc.reason || '채점기 미연결') + '</div></div>';
    } else {
      html += tile('종합 (교정 전)', sc.calibrated == null ? '—' : sc.calibrated, '', '루브릭 ' + s.rubricVersion);
    }
    html += tile('답변', answers.length + ' / ' + Questions.SET.items.length, '', '본 면접 문항');
    html += tile('전사 확보', withT.length, '건', withT.length ? '평균 신뢰도 ' + (meanConf == null ? '—' : meanConf.toFixed(2)) : 'STT 미연결');
    html += tile('응시자 정정', corrections, '회', '편집거리 상한 내 승인분');
    html += tile('저장 완전성', incomplete ? (answers.length - incomplete) + ' / ' + answers.length : '전부', '', incomplete ? '구간 누락 있음' : '구간 누락 없음');
    html += '<div class="score-tile blocked"><div class="label">백분위 / 등급</div><div class="value">산출 불가</div><div class="hint">규준·타당도 미확보</div></div>';
    html += '</div>';

    html += '<div class="callout warn"><strong>이 기록은 참고자료입니다.</strong> 자동 점수가 있더라도 규준과 준거관련 타당도가 확보되기 전에는 선발 근거로 쓸 수 없습니다 (설계도 D-1). 최종 판단은 사람이 합니다.</div>';

    /* ---------- 문항별 ---------- */
    html += '<h2>문항별 기록</h2>';
    html += '<p>행동 지표(첫 발화 지연·발화 길이·말속도)는 <strong>기록만 하고 점수에 반영하지 않습니다</strong> — 마이크·환경 차이에 오염됩니다.</p>';
    html += '<div class="table-scroll"><table><thead><tr>' +
      '<th>#</th><th>유형</th><th>답변</th><th>첫 발화</th><th>발화 비율</th><th>전사 신뢰도</th><th>정정</th><th>저장</th><th>영상</th>' +
      '</tr></thead><tbody>';
    answers.forEach(function (a, i) {
      var t = a.transcript;
      var b = a.behavioral || {};
      var conf = t ? (t.meanConfidence == null ? '있음' : t.meanConfidence.toFixed(2)) : '—';
      var confCls = t && t.meanConfidence != null && t.meanConfidence < 0.6 ? ' class="tag err"' : '';
      html += '<tr><td>' + (i + 1) + '</td><td>' + esc(a.questionType) + '</td>' +
        '<td>' + (a.answerMs / 1000).toFixed(1) + 's' + (a.answerEnded === 'stopped_early' ? ' <span class="chip">조기 종료</span>' : '') + '</td>' +
        '<td>' + ms(b.firstSpeechDelayMs) + '</td>' +
        '<td>' + (b.silenceRatio == null ? '—' : Math.round((1 - b.silenceRatio) * 100) + '%') + '</td>' +
        '<td><span' + confCls + '>' + conf + '</span></td>' +
        '<td>' + (t ? t.corrections.filter(function (c) { return c.accepted; }).length + '/' + t.corrections.length : '—') + '</td>' +
        '<td><span class="tag ' + (a.media.complete ? 'ok">완전' : 'err">누락') + '</span></td>' +
        '<td><button class="btn small" data-play="' + i + '">보기</button></td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<div id="playSlot"></div>';

    /* ---------- 자동 채점 결과 (모의·실제 공용 모양) ---------- */
    if (sc.status && sc.status !== 'pending') {
      html += '<h2>자동 채점 · 교정 전 원점수</h2>';
      html += '<p>채점기 <code>' + esc(sc.modelId) + '</code> · 루브릭 <code>' + esc(sc.rubricVersion) + '</code> · 프롬프트 지문 <code>' + esc(sc.promptHash) + '</code>. ' +
              (sc.modelId === 'mock-heuristic' ? '<strong>모의 채점기입니다 — 휴리스틱이며 타당도가 없습니다.</strong> 화면과 데이터 모양을 검증하는 용도입니다. ' : '') +
              '원점수는 사람 점수로 교정되기 전이므로 척도 의미가 없습니다. 근거 인용은 "이 판단이 어느 발언에서 나왔는지"를 보여줍니다.</p>';
      (sc.perQuestion || []).forEach(function (p, i) {
        var q = Questions.SET.items[i];
        html += '<div class="sc-q"><h4>' + (i + 1) + '. ' + esc(q ? q.text : p.questionId) + '</h4>';
        if (p.excluded) {
          var why = { no_transcript: '전사 없음', low_confidence: '전사 신뢰도 낮음', model_refusal: '모델 거부', parse_failed: '응답 해석 실패' }[p.excludeReason] || p.excludeReason;
          html += '<p class="sc-excl">자동채점 제외 — ' + esc(why) + ' → 인적 검토</p></div>';
          return;
        }
        html += '<div class="sc-traits">' + p.traits.map(function (t) {
          var tr = Questions.RUBRIC.traits[t.traitId];
          return '<span class="sc-trait">' + esc(tr ? tr.label : t.traitId) + ' <b>' + t.raw + '</b>/5 · 확신 ' + (t.confidence == null ? '—' : t.confidence.toFixed(2)) + '</span>';
        }).join('') + '</div>';
        (p.citations || []).forEach(function (c) {
          var tr = Questions.RUBRIC.traits[c.traitId];
          html += '<div class="cite"><b>' + esc(tr ? tr.label : (c.traitId || '근거')) + '</b> "' + esc(c.quotedText) + '" <span class="chip">' + c.startChar + '–' + c.endChar + '</span></div>';
        });
        if (p.flags && p.flags.length) html += '<div class="integrity">' + p.flags.map(function (f) { return '<span class="chip flag">' + esc(f) + '</span>'; }).join('') + '</div>';
        html += '</div>';
      });
    }

    /* ---------- 자동 vs 사람 일치도 (교정의 씨앗) ---------- */
    if (s.humanScore && sc.status && sc.status !== 'pending') {
      var ag = R.agreement(sc, s.humanScore);
      html += '<h2>자동 · 검토자 일치도</h2>';
      html += '<p>사람 점수 표본이 쌓이면 이 값으로 자동 점수를 교정합니다 (설계도 §3-06). 지금은 표본 1건이므로 <strong>수치 자체에 의미를 두지 마십시오.</strong></p>';
      html += '<div class="agree">' +
        tile('비교 쌍', ag.n, '개', '문항×특성') +
        tile('정확 일치', ag.n ? Math.round(ag.exact / ag.n * 100) : '—', '%', '') +
        tile('±1 이내', ag.n ? Math.round(ag.within1 / ag.n * 100) : '—', '%', '') +
        tile('평균 차이', ag.n ? ag.meanDiff.toFixed(2) : '—', '', '자동 − 사람') +
        '</div>';
    }

    /* ---------- 전사 ---------- */
    html += '<h2>전사</h2>';
    if (!withT.length) {
      html += '<div class="callout">전사가 없습니다. STT 공급자가 연결되면 여기에 원문·정정본·단어별 신뢰도가 표시됩니다. 자동채점은 전사가 있어야 가능합니다.</div>';
    }
    answers.forEach(function (a, i) {
      var t = a.transcript; if (!t) return;
      html += '<h3>' + (i + 1) + '. ' + esc(Questions.SET.items[i].text) + '</h3>';
      html += '<div class="cite"><b>원문</b> ' + esc(t.raw || '(없음)') + '</div>';
      if (t.corrected != null && t.corrected !== t.raw) {
        html += '<div class="cite"><b>정정본</b> ' + esc(t.corrected) + '</div>';
      }
      if (t.corrections.length) {
        html += '<div class="integrity">' + t.corrections.map(function (c) {
          return '<span class="chip' + (c.accepted ? '' : ' flag') + '">시도 ' + c.attempt + ' · 거리 ' + c.editDistance + '/' + c.cap + ' · ' + esc(c.reason) + '</span>';
        }).join('') + '</div>';
      }
    });

    /* ---------- 마스킹 미리보기 ---------- */
    if (withT.length) {
      html += '<h2>채점기에 보낼 텍스트 (마스킹 후)</h2>';
      html += '<p>학교·회사·지역·연락처·이름을 지운 뒤에만 채점기에 전달합니다 (R-03). 마스킹 건수를 기록합니다.</p>';
      answers.forEach(function (a, i) {
        var t = a.transcript; if (!t) return;
        var m = Transcript.mask(t.corrected != null ? t.corrected : t.raw, { names: s.names });
        html += '<div class="cite"><b>' + (i + 1) + '</b> ' + esc(m.text) +
          (m.total ? ' <span class="chip">마스킹 ' + m.total + '건</span>' : '') + '</div>';
      });
    }

    /* ---------- 무결성 · 공급자 ---------- */
    html += '<h2>응시 무결성</h2><div class="integrity">';
    (ctx.integrity || []).forEach(function (f) {
      html += '<span class="chip' + (f.flag ? ' flag' : '') + '">' + esc(f.label) + '</span>';
    });
    html += '</div>';

    html += '<h2>처리 경로</h2><div class="integrity">';
    (s.providers || []).forEach(function (p) {
      html += '<span class="chip' + (p.external ? ' flag' : '') + '">' + esc(p.kind) + ' · ' + esc(p.label) + (p.external ? ' · 외부 전송' : '') + '</span>';
    });
    html += '</div>';

    /* ---------- 검토자 채점 ----------
       사람이 특성별 점수와 근거 발언을 남긴다. 캘리브레이션과 타당도 연구의 원자료다.
       자동 점수를 먼저 보여주면 앵커링되므로, 입력란은 자동 점수와 떨어뜨려 놓는다. */
    html += '<h2>검토자 채점</h2>';
    html += '<p>전사에서 <strong>근거가 되는 문장을 드래그로 선택</strong>한 뒤 특성을 골라 "근거로 추가"를 누르세요. 점수는 루브릭 앵커(1·3·5)를 기준으로 매깁니다. 저장하면 세션에 <code>humanScore</code>로 남습니다.</p>';
    var hs = s.humanScore || { perQuestion: [] };
    answers.forEach(function (a, i) {
      var t = a.transcript; var q = Questions.SET.items[i];
      var text = t ? (t.corrected != null ? t.corrected : t.raw) : '';
      var prev = hs.perQuestion.find(function (p) { return p.questionId === q.id; }) || { traits: [], evidence: [], note: '' };
      html += '<div class="hs-q" data-q="' + i + '"><h4>' + (i + 1) + '. ' + esc(q.text) + '</h4>';
      if (!t) { html += '<p class="sc-excl">전사 없음 — 영상을 보고 채점하십시오.</p>'; }
      html += '<div class="hs-text" id="hsText-' + i + '">' + esc(text || '(전사 없음)') + '</div>';
      html += '<div class="hs-ctl" style="margin-top:8px"><select id="hsTrait-' + i + '">' +
        q.traits.map(function (tr) { return '<option value="' + tr + '">' + esc(Questions.RUBRIC.traits[tr].label) + '</option>'; }).join('') +
        '</select><button class="btn small" data-addev="' + i + '">선택 문장을 근거로 추가</button><span class="note" id="hsEvNote-' + i + '"></span></div>';
      html += '<div class="hs-ev" id="hsEv-' + i + '">' + prev.evidence.map(function (e, k) { return evHtml(i, k, e); }).join('') + '</div>';
      q.traits.forEach(function (tr) {
        var cur = (prev.traits.find(function (x) { return x.traitId === tr; }) || {}).score;
        var r = Questions.RUBRIC.traits[tr];
        html += '<div class="hs-row"><label>' + esc(r.label) + '</label><select id="hsScore-' + i + '-' + tr + '">' +
          '<option value="">— 미채점</option>' +
          [1, 2, 3, 4, 5].map(function (v) {
            var anchor = r.anchors[v] ? ' · ' + r.anchors[v] : '';
            return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + v + anchor + '</option>';
          }).join('') + '</select></div>';
      });
      html += '<textarea class="hs-note" id="hsNote-' + i + '" rows="2" placeholder="메모 (선택)">' + esc(prev.note || '') + '</textarea>';
      html += '</div>';
    });
    html += '<div class="actions" style="justify-content:flex-start"><button class="btn primary" id="btnSaveHuman">검토자 채점 저장</button><span class="note" id="hsSaved"></span></div>';

    html += '<div class="actions">' +
      '<button class="btn ghost" data-goto="screen-done">돌아가기</button>' +
      '<button class="btn primary" id="btnExplain">이 기록은 어떻게 평가되나요?</button></div>';

    mount.innerHTML = html;

    function evHtml(i, k, e) {
      var tr = Questions.RUBRIC.traits[e.traitId];
      return '<div class="cite" data-ev="' + k + '"><b>' + esc(tr ? tr.label : e.traitId) + '</b> "' + esc(e.quotedText) + '" <span class="chip">' + e.startChar + '–' + e.endChar + '</span>' +
             '<button class="rm" data-rmev="' + i + ':' + k + '" type="button">제거</button></div>';
    }

    /* 검토자 근거: 선택 영역의 오프셋을 전사 요소 기준으로 계산 */
    var evidence = {};
    answers.forEach(function (a, i) {
      var q = Questions.SET.items[i];
      var prev = hs.perQuestion.find(function (p) { return p.questionId === q.id; });
      evidence[i] = prev ? prev.evidence.slice() : [];
    });

    function selectionIn(el) {
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      var range = sel.getRangeAt(0);
      if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
      var pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(range.startContainer, range.startOffset);
      var start = pre.toString().length;
      var text = range.toString();
      return { quotedText: text, startChar: start, endChar: start + text.length };
    }

    mount.addEventListener('click', function (e) {
      var add = e.target.closest('[data-addev]');
      if (add) {
        var i = parseInt(add.getAttribute('data-addev'), 10);
        var el = mount.querySelector('#hsText-' + i);
        var note = mount.querySelector('#hsEvNote-' + i);
        var selr = selectionIn(el);
        if (!selr) { note.className = 'note err'; note.textContent = '전사 안에서 문장을 먼저 선택하세요'; return; }
        selr.traitId = mount.querySelector('#hsTrait-' + i).value;
        evidence[i].push(selr);
        mount.querySelector('#hsEv-' + i).innerHTML = evidence[i].map(function (ev, k) { return evHtml(i, k, ev); }).join('');
        note.className = 'note ok'; note.textContent = '추가됨 (' + selr.startChar + '–' + selr.endChar + ')';
        return;
      }
      var rm = e.target.closest('[data-rmev]');
      if (rm) {
        var parts = rm.getAttribute('data-rmev').split(':');
        var qi = parseInt(parts[0], 10), k = parseInt(parts[1], 10);
        evidence[qi].splice(k, 1);
        mount.querySelector('#hsEv-' + qi).innerHTML = evidence[qi].map(function (ev, kk) { return evHtml(qi, kk, ev); }).join('');
        return;
      }
      if (e.target.id === 'btnSaveHuman') {
        var out = { reviewerRef: 'local-reviewer', at: new Date().toISOString(), rubricVersion: Questions.RUBRIC.version, perQuestion: [] };
        answers.forEach(function (a, i) {
          var q = Questions.SET.items[i];
          var traits = q.traits.map(function (tr) {
            var v = mount.querySelector('#hsScore-' + i + '-' + tr).value;
            return v ? { traitId: tr, score: parseInt(v, 10) } : null;
          }).filter(Boolean);
          out.perQuestion.push({ questionId: q.id, traits: traits, evidence: evidence[i], note: mount.querySelector('#hsNote-' + i).value });
        });
        s.humanScore = out;
        var p = ctx.app.saveHumanScore ? ctx.app.saveHumanScore(out) : Promise.resolve();
        p.then(function () {
          var n = mount.querySelector('#hsSaved');
          n.className = 'note ok'; n.textContent = '저장됨 · ' + out.at.slice(11, 19);
          /* 일치도 블록이 새로 생기므로 다시 그린다 */
          R.render(mount, ctx);
        });
      }
    });

    mount.querySelector('#btnExplain').addEventListener('click', function () {
      R.renderExplain(document.getElementById('explainBody'), ctx);
      ctx.app.show('screen-explain');
    });

    mount.addEventListener('click', async function (e) {
      var b = e.target.closest('[data-play]');
      if (!b) return;
      var i = parseInt(b.getAttribute('data-play'), 10);
      var a = answers[i];
      var asm = await ctx.store.assemble(s.id, a.questionId);
      var slot = mount.querySelector('#playSlot');
      if (!asm || !asm.blob) { slot.innerHTML = '<div class="callout warn">영상이 없습니다 (파기되었거나 저장 실패).</div>'; return; }
      slot.innerHTML = '<p class="hint">조회 이력이 기록되었습니다.</p><video class="iv-video iv-playback" controls playsinline src="' + URL.createObjectURL(asm.blob) + '"></video>';
    });
  };

  /** 자동 점수와 사람 점수의 일치도 — 순수 함수 (테스트 대상) */
  R.agreement = function (auto, human) {
    var n = 0, exact = 0, within1 = 0, diffSum = 0;
    (auto.perQuestion || []).forEach(function (p) {
      if (p.excluded) return;
      var h = (human.perQuestion || []).find(function (x) { return x.questionId === p.questionId; });
      if (!h) return;
      p.traits.forEach(function (t) {
        var ht = h.traits.find(function (x) { return x.traitId === t.traitId; });
        if (!ht) return;
        n++;
        var d = t.raw - ht.score;
        if (d === 0) exact++;
        if (Math.abs(d) <= 1) within1++;
        diffSum += d;
      });
    });
    return { n: n, exact: exact, within1: within1, meanDiff: n ? diffSum / n : 0 };
  };

  /* ============================================================
     설명 화면
     ============================================================ */
  R.renderExplain = function (mount, ctx) {
    var s = ctx.session;
    var rb = Questions.RUBRIC;
    var html = '';

    html += '<p class="eyebrow">산출 근거 설명</p>';
    html += '<h1>이 면접은 이렇게 평가됩니다</h1>';
    html += '<div class="callout">개인정보보호법 §37조의2에 따라, 자동화된 결정이 귀하의 권리·의무에 중대한 영향을 미치는 경우 귀하는 <strong>그 결정을 거부하고 설명을 요구</strong>할 수 있으며 <strong>사람에 의한 재검토</strong>를 요청할 수 있습니다.</div>';

    html += '<h2>1. 무엇을 평가하는가</h2>';
    html += '<p><strong>말한 내용만</strong> 평가합니다. 아래 다섯 특성이며, 각 문항이 어느 특성에 대응하는지가 미리 정해져 있습니다 (루브릭 ' + esc(rb.version) + ').</p>';
    html += '<div class="table-scroll"><table><thead><tr><th>특성</th><th>보는 것</th><th>1점</th><th>3점</th><th>5점</th></tr></thead><tbody>';
    Object.keys(rb.traits).forEach(function (k) {
      var t = rb.traits[k];
      html += '<tr><td>' + esc(t.label) + '</td><td>' + esc(t.looks) + '</td><td>' + esc(t.anchors[1]) + '</td><td>' + esc(t.anchors[3]) + '</td><td>' + esc(t.anchors[5]) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<p><strong>평가하지 않는 것:</strong> ' + rb.excluded.map(esc).join(' · ') + '. 표정·시선·목소리로 감정이나 성격을 추론하지 않으며 얼굴 인식도 하지 않습니다.</p>';

    html += '<h2>2. 어떤 절차였는가</h2>';
    html += '<div class="formula">' +
      '문항 ' + Questions.SET.items.length + '개 (' + Questions.SET.version + ')\n' +
      '준비 <b>' + (Questions.SET.prepMs / 1000) + '초</b> → 답변 <b>' + (Questions.SET.answerMs / 1000) + '초</b> 녹화 · 다시 찍기 없음\n' +
      '음성 → 텍스트 (전사) → 응시자 확인·정정 (문항당 ' + Transcript.POLICY.maxAttempts + '회, 편집거리 상한 ' + Math.round(Transcript.POLICY.maxEditRatio * 100) + '%)\n' +
      '식별자 마스킹 → 특성별 채점 + <b>근거 문장 인용</b> → 사람 점수에 교정 → 사람이 최종 판단\n\n' +
      '행동 지표(첫 발화 지연·발화 길이·말속도)는 기록만 하고 <b>점수에 반영하지 않음</b>' +
    '</div>';

    html += '<h2>3. 점수는 어떻게 계산되는가</h2>';
    if (!s.score || s.score.status === 'pending') {
      html += '<div class="callout warn"><strong>이 빌드에서는 점수가 계산되지 않았습니다.</strong> 채점기가 연결되면 특성별 점수와 함께 "이 판단은 귀하의 이 발언에서 나왔습니다"라는 근거 문장이 여기에 표시됩니다. 지금 기록된 것은 영상·전사·행동지표·정정 이력뿐입니다.</div>';
    }

    html += '<h2>4. 이 결과로 무엇이 결정되는가</h2>';
    html += '<div class="callout warn"><strong>현재 빌드에서는 어떠한 결정도 이루어지지 않습니다.</strong> 규준과 준거관련 타당도가 확보된 이후에도 이 결과는 단독 판단 근거가 아니라 다중 자료 중 하나로만 사용되어야 합니다.</div>';

    html += '<h2>5. 수집된 데이터와 보관</h2>';
    html += '<div class="table-scroll"><table><thead><tr><th>항목</th><th>내용</th><th>목적</th><th>보관</th></tr></thead><tbody>';
    html += row('영상·음성', (s.answers || []).length + '개 답변', '사람이 확인할 근거. 자동 분석 대상 아님', s.retention ? s.retention.media.slice(0, 10) + '까지' : '—');
    html += row('전사', (s.answers || []).filter(function (a) { return a.transcript; }).length + '건 (원문·정정본·신뢰도)', '채점·재채점', s.retention ? s.retention.transcript.slice(0, 10) + '까지' : '—');
    html += row('행동 지표', '첫 발화 지연·발화 길이·말속도', '환경 이상 감지 (점수 미반영)', '전사와 동일');
    html += row('기기 정보', s.deviceCheck ? (s.deviceCheck.mime || '') : '—', '저장 실패·환경 편차 사후 보정', '전사와 동일');
    html += row('무결성 이벤트', (ctx.raw.integrityEvents || []).length + '건', '응시 환경 이상 감지 (탈락 근거 아님)', '전사와 동일');
    html += row('얼굴 특징정보 · 감정 추론', '생성하지 않음', '—', '—');
    html += '</tbody></table></div>';

    html += '<h2>6. 처리 경로</h2><div class="integrity">';
    (s.providers || []).forEach(function (p) {
      html += '<span class="chip' + (p.external ? ' flag' : '') + '">' + esc(p.kind) + ' · ' + esc(p.label) + (p.external ? ' · 외부 전송' : ' · 외부 전송 없음') + '</span>';
    });
    html += '</div>';

    html += '<h2>7. 권리 행사</h2>';
    html += '<p>아래 요청은 담당자에게 전달되며 <strong>사람이 검토</strong>합니다. (프로토타입에서는 콘솔에 기록됩니다.)</p>';
    html += '<div class="actions" style="justify-content:flex-start">' +
      '<button class="btn ghost" data-req="reject">이 결정을 거부합니다</button>' +
      '<button class="btn ghost" data-req="review">사람의 재검토를 요청합니다</button>' +
      '<button class="btn ghost" data-req="delete">내 데이터 삭제를 요청합니다</button></div>' +
      '<div id="reqResult"></div>';
    html += '<div class="actions"><button class="btn primary" data-goto="screen-report">기록으로 돌아가기</button></div>';

    mount.innerHTML = html;

    var labels = { reject: '자동화 결정 거부', review: '인적 재검토 요청', delete: '데이터 삭제 요청' };
    Array.prototype.forEach.call(mount.querySelectorAll('[data-req]'), function (btn) {
      btn.addEventListener('click', async function () {
        var kind = btn.getAttribute('data-req');
        var ticket = { type: kind, sessionId: s.id, requestedAt: new Date().toISOString(), status: 'queued_for_human_review' };
        console.log('[explain] 권리 행사 요청', ticket);
        if (kind === 'delete') {
          var n = await ctx.store.eraseSession(s.id);
          ticket.erasedChunks = n;
        }
        mount.querySelector('#reqResult').innerHTML = '<div class="callout"><strong>' + esc(labels[kind]) + '</strong>이 접수되었습니다. 접수번호 <code>' + esc(s.id) + '</code>' +
          (kind === 'delete' ? ' · 영상 구간 ' + ticket.erasedChunks + '개와 기록을 즉시 삭제했습니다.' : ' · 상태 <code>queued_for_human_review</code>') + '</div>';
      });
    });

    function row(k, v, p, keep) {
      return '<tr><td>' + esc(k) + '</td><td class="seq">' + esc(v) + '</td><td>' + esc(p) + '</td><td class="seq">' + esc(keep) + '</td></tr>';
    }
  };

  global.InterviewReport = R;
})(window);

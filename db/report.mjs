#!/usr/bin/env node
/* ============================================================
   report.mjs — 채점 DB 현황 · 평가자 일치도 · 자동-사람 교정
   사용: node db/report.mjs scores.sqlite
   ============================================================ */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './load-session.mjs';
import { byTrait, simpleAgreement, weightedKappa, kappaVerdict, linearCalibration } from './agreement.mjs';

export function buildReport(db) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  const counts = {
    sessions: one('SELECT COUNT(*) c FROM sessions').c,
    testSessions: one('SELECT COUNT(*) c FROM sessions WHERE test_mode = 1 OR bypass_count > 0').c,
    answers: one('SELECT COUNT(*) c FROM answers').c,
    eligible: one('SELECT COUNT(*) c FROM v_eligible_answers').c,
    transcripts: one('SELECT COUNT(*) c FROM transcripts').c,
    autoRuns: one('SELECT COUNT(*) c FROM auto_score_runs').c,
    humanScores: one('SELECT COUNT(*) c FROM human_scores').c,
    raters: one('SELECT COUNT(*) c FROM raters').c,
    queue: one('SELECT COUNT(*) c FROM rating_queue').c,
    queueDone2: one('SELECT COUNT(*) c FROM rating_queue WHERE done_r1 = 1 AND done_r2 = 1').c,
    norms: one('SELECT COUNT(*) c FROM norms').c
  };

  const raterPairs = all('SELECT trait_id, score_a, score_b FROM v_rater_pairs');
  const interRater = byTrait(raterPairs);
  const interRaterAll = raterPairs.length
    ? { ...simpleAgreement(raterPairs.map(r => [r.score_a, r.score_b])), ...weightedKappa(raterPairs.map(r => [r.score_a, r.score_b])) }
    : null;
  if (interRaterAll) interRaterAll.verdict = kappaVerdict(interRaterAll.kappa);

  const avh = all('SELECT model_id, trait_id, auto_raw, human_score FROM v_auto_vs_human');
  const autoVsHuman = {};
  for (const model of [...new Set(avh.map(r => r.model_id))]) {
    const rows = avh.filter(r => r.model_id === model);
    autoVsHuman[model] = {
      all: { ...simpleAgreement(rows.map(r => [r.auto_raw, r.human_score])), ...weightedKappa(rows.map(r => [r.auto_raw, r.human_score])) },
      byTrait: byTrait(rows.map(r => ({ trait_id: r.trait_id, score_a: r.auto_raw, score_b: r.human_score }))),
      calibration: Object.fromEntries([...new Set(rows.map(r => r.trait_id))].map(t =>
        [t, linearCalibration(rows.filter(r => r.trait_id === t).map(r => [r.auto_raw, r.human_score]))]))
    };
  }

  return { counts, interRater, interRaterAll, autoVsHuman };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbFile = process.argv[2];
  if (!dbFile) { console.error('사용법: node db/report.mjs <db.sqlite>'); process.exit(2); }
  const r = buildReport(openDb(dbFile));
  console.log('== 현황'); console.table(r.counts);
  console.log('== 평가자 간 일치도 (특성별)');
  if (Object.keys(r.interRater).length) console.table(r.interRater); else console.log('  (2인 이상 채점된 답변 없음)');
  if (r.interRaterAll) console.log('  전체 κ =', r.interRaterAll.kappa, '·', r.interRaterAll.verdict);
  console.log('== 자동 vs 사람');
  for (const [model, v] of Object.entries(r.autoVsHuman)) {
    console.log('  [' + model + '] n=' + v.all.n, 'κ=' + v.all.kappa, '정확=' + (v.all.exact == null ? '—' : Math.round(v.all.exact * 100) + '%'));
    console.table(v.byTrait);
    console.log('  교정 계수 (특성별, 표본 30 미만이면 미산출):'); console.table(v.calibration);
  }
  if (!Object.keys(r.autoVsHuman).length) console.log('  (자동·사람 점수가 같은 답변에 둘 다 있는 경우 없음)');
}

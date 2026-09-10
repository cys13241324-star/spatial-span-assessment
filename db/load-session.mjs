#!/usr/bin/env node
/* ============================================================
   load-session.mjs — 세션 JSON → 채점 DB

   브라우저 "기록 JSON 내려받기" 파일과 server/score-claude.mjs 출력(--score)을
   SQLite에 적재한다. 같은 세션을 다시 넣으면 세션·답변은 갱신되고
   자동 채점은 새 run으로 추가된다 (덮어쓰지 않는다).

   사용
     node db/load-session.mjs scores.sqlite session.json [--score score.json] [--rater r01]
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));

export function openDb(file) {
  const db = new DatabaseSync(file);
  applySchema(db);
  return db;
}

export function applySchema(db) {
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
}

function audit(db, type, sessionId, detail) {
  db.prepare('INSERT INTO audit(at, type, session_id, detail_json) VALUES (?,?,?,?)')
    .run(new Date().toISOString(), type, sessionId ?? null, detail ? JSON.stringify(detail) : null);
}

/**
 * 세션 적재. 반환: { sessionId, answers, autoRunId, humanScores }
 * questions: 문항 텍스트를 붙이기 위한 세트 (없으면 null 허용)
 */
export function loadSession(db, s, opts = {}) {
  const questions = opts.questions || null;
  const bypasses = s.bypasses || [];

  db.prepare(`INSERT INTO sessions(id, kind, candidate_ref, job_id, question_set_version, rubric_version, content_fingerprint,
      test_mode, bypass_count, started_at, submitted_at, hiring_closed_at,
      retention_media_until, retention_transcript_until, retention_score_until,
      purged_media_at, purged_transcript_at, device_json, providers_json, source_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      submitted_at = excluded.submitted_at, hiring_closed_at = excluded.hiring_closed_at,
      test_mode = excluded.test_mode, bypass_count = excluded.bypass_count,
      purged_media_at = excluded.purged_media_at, purged_transcript_at = excluded.purged_transcript_at,
      source_json = excluded.source_json`)
    .run(s.id, s.kind || 'video-interview', s.candidateRef ?? null, s.jobId ?? null,
      s.questionSetVersion, s.rubricVersion, s.contentFingerprint ?? null,
      s.testMode ? 1 : 0, bypasses.length,
      s.startedAt ?? null, s.submittedAt ?? null, s.hiringClosedAt ?? null,
      s.retention?.media ?? null, s.retention?.transcript ?? null, s.retention?.score ?? null,
      s.purged_media ?? null, s.purged_transcript ?? null,
      s.device ? JSON.stringify(s.device) : null,
      s.providers ? JSON.stringify(s.providers) : null,
      opts.keepSource === false ? null : JSON.stringify(s));

  const insAnswer = db.prepare(`INSERT INTO answers(session_id, question_id, question_type, question_text, ord,
      prep_ms, answer_ms, answer_ended, media_chunks, media_bytes, media_complete, media_skipped,
      first_speech_delay_ms, speech_duration_ms, silence_ratio, words_per_min)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id, question_id) DO UPDATE SET
      answer_ms = excluded.answer_ms, answer_ended = excluded.answer_ended,
      media_chunks = excluded.media_chunks, media_bytes = excluded.media_bytes,
      media_complete = excluded.media_complete, media_skipped = excluded.media_skipped
    RETURNING id`);
  const insTr = db.prepare(`INSERT INTO transcripts(answer_id, provider, raw, corrected, mean_confidence, low_confidence_ratio, correction_count, words_json)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(answer_id) DO UPDATE SET corrected = excluded.corrected, correction_count = excluded.correction_count`);
  const delCorr = db.prepare('DELETE FROM transcript_corrections WHERE answer_id = ?');
  const insCorr = db.prepare('INSERT INTO transcript_corrections(answer_id, attempt, edit_distance, cap, accepted, reason, at) VALUES (?,?,?,?,?,?,?)');

  const answerIds = {};
  (s.answers || []).forEach((a, i) => {
    const q = questions ? questions.items.find(x => x.id === a.questionId) : null;
    const b = a.behavioral || {};
    const row = insAnswer.get(s.id, a.questionId, a.questionType ?? null, q ? q.text : (a.questionText ?? null), i,
      a.prepMs ?? null, a.answerMs ?? null, a.answerEnded ?? null,
      a.media?.chunks ?? null, a.media?.bytes ?? null, a.media?.complete ? 1 : 0, a.media?.skipped ?? null,
      b.firstSpeechDelayMs ?? null, b.speechDurationMs ?? null, b.silenceRatio ?? null, b.wordsPerMin ?? null);
    answerIds[a.questionId] = row.id;

    if (a.transcript) {
      const t = a.transcript;
      insTr.run(row.id, t.provider ?? null, t.raw ?? null, t.corrected ?? null, t.meanConfidence ?? null, t.lowConfidenceRatio ?? null,
        (t.corrections || []).filter(c => c.accepted).length, t.words ? JSON.stringify(t.words) : null);
      delCorr.run(row.id);
      for (const c of t.corrections || []) {
        insCorr.run(row.id, c.attempt, c.editDistance, c.cap, c.accepted ? 1 : 0, c.reason ?? null, c.at ? new Date(c.at).toISOString() : null);
      }
    }
  });

  /* 자동 채점 — 새 run */
  let autoRunId = null;
  const score = opts.score || s.score;
  if (score && score.status && score.status !== 'pending') {
    autoRunId = db.prepare(`INSERT INTO auto_score_runs(session_id, status, model_id, effort, rubric_version, prompt_hash, scored_at, routed_to_human, route_reason, calibrated, percentile)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
      .get(s.id, score.status, score.modelId ?? 'unknown', score.effort ?? null, score.rubricVersion ?? s.rubricVersion,
        score.promptHash ?? null, score.scoredAt ?? null, score.routedToHuman ? 1 : 0, score.routeReason ?? null,
        score.calibrated ?? null, score.percentile ?? null).id;
    const insAS = db.prepare('INSERT INTO auto_scores(run_id, answer_id, excluded, exclude_reason, mask_total, flags_json) VALUES (?,?,?,?,?,?) RETURNING id');
    const insTrait = db.prepare('INSERT INTO auto_score_traits(auto_score_id, trait_id, raw, confidence, rationale) VALUES (?,?,?,?,?)');
    const insCite = db.prepare('INSERT INTO auto_citations(auto_score_id, trait_id, quoted_text, start_char, end_char) VALUES (?,?,?,?,?)');
    for (const p of score.perQuestion || []) {
      const aid = answerIds[p.questionId];
      if (!aid) continue;
      const asId = insAS.get(autoRunId, aid, p.excluded ? 1 : 0, p.excludeReason ?? null, p.maskTotal ?? null,
        p.flags ? JSON.stringify(p.flags) : null).id;
      for (const t of p.traits || []) insTrait.run(asId, t.traitId, t.raw, t.confidence ?? null, t.rationale ?? null);
      for (const c of p.citations || []) insCite.run(asId, c.traitId ?? null, c.quotedText, c.startChar ?? null, c.endChar ?? null);
    }
  }

  /* 사람 채점 — 평가자별 */
  let humanScores = 0;
  const hs = s.humanScore;
  if (hs) {
    const rater = opts.rater || hs.reviewerRef || 'local-reviewer';
    db.prepare('INSERT OR IGNORE INTO raters(id) VALUES (?)').run(rater);
    const insH = db.prepare(`INSERT INTO human_scores(answer_id, rater_id, rubric_version, trait_id, score, scored_at, note)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(answer_id, rater_id, rubric_version, trait_id) DO UPDATE SET score = excluded.score, scored_at = excluded.scored_at, note = excluded.note`);
    const delEv = db.prepare('DELETE FROM human_evidence WHERE answer_id = ? AND rater_id = ?');
    const insEv = db.prepare('INSERT INTO human_evidence(answer_id, rater_id, trait_id, quoted_text, start_char, end_char) VALUES (?,?,?,?,?,?)');
    for (const p of hs.perQuestion || []) {
      const aid = answerIds[p.questionId];
      if (!aid) continue;
      for (const t of p.traits || []) { insH.run(aid, rater, hs.rubricVersion ?? s.rubricVersion, t.traitId, t.score, hs.at ?? null, p.note ?? null); humanScores++; }
      delEv.run(aid, rater);
      for (const e of p.evidence || []) insEv.run(aid, rater, e.traitId ?? null, e.quotedText, e.startChar ?? null, e.endChar ?? null);
    }
  }

  audit(db, 'load', s.id, { answers: Object.keys(answerIds).length, autoRunId, humanScores, testMode: !!s.testMode, bypasses: bypasses.length });
  return { sessionId: s.id, answers: Object.keys(answerIds).length, autoRunId, humanScores };
}

/* ---------- CLI ---------- */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const [dbFile, sessFile] = args.filter(a => !a.startsWith('--'));
  const scoreIdx = args.indexOf('--score');
  const raterIdx = args.indexOf('--rater');
  if (!dbFile || !sessFile) {
    console.error('사용법: node db/load-session.mjs <db.sqlite> <session.json> [--score score.json] [--rater id]');
    process.exit(2);
  }
  const db = openDb(dbFile);
  const s = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  const score = scoreIdx >= 0 ? JSON.parse(fs.readFileSync(args[scoreIdx + 1], 'utf8')) : null;
  const r = loadSession(db, s, { score, rater: raterIdx >= 0 ? args[raterIdx + 1] : undefined });
  console.log(JSON.stringify(r));
  if (s.testMode || (s.bypasses || []).length) console.error('주의: 테스트 모드/우회 세션 — v_eligible_answers에서 제외됩니다');
}

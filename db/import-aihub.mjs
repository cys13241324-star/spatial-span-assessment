#!/usr/bin/env node
/* ============================================================
   import-aihub.mjs — AI Hub 채용면접 인터뷰 데이터 → 채점 대기열

   AI Hub 라벨 JSON을 읽어 세션(kind='aihub-import')과 답변으로 넣고,
   조건을 통과한 답변을 rating_queue에 올린다. 평가자가 우리 루브릭으로 채점하면
   그것이 채점 표본 DB가 된다 — 답변은 이미 있고, 우리가 만드는 것은 점수다.

   ※ AI Hub JSON의 정확한 필드명은 데이터를 받아 봐야 안다. 아래 FIELDS는
      공개 설명(메타정보·질문/답변 원문·감정/의도 라벨·요약)에서 추정한 기본값이고,
      --inspect 로 실제 키를 찍어 본 뒤 --map 으로 바꾼다.

   사용
     node db/import-aihub.mjs --inspect <dir|file.json>              # 키 구조만 출력
     node db/import-aihub.mjs <db.sqlite> <dir|file.json> [--map map.json] [--limit N] [--per-type N]

   재배포 금지: 이 스크립트는 원문을 DB에만 넣는다. 외부로 내보내는 경로는 만들지 않는다.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './load-session.mjs';

const DEFAULT_FIELDS = {
  /* 최상위 → 메타 */
  id:         ['id', 'data_id', 'dataSet.id', 'metadata.id'],
  jobGroup:   ['job_group', 'jobGroup', 'metadata.job_group', 'metadata.category', 'category'],
  /* 문답 목록 (배열) 또는 단일 */
  qaList:     ['qa', 'qa_list', 'dialog', 'utterances', 'data'],
  question:   ['question', 'q', 'question_text', 'text_question'],
  answer:     ['answer', 'a', 'answer_text', 'text', 'stt'],
  intent:     ['intent', 'intention', 'label.intent'],
  emotion:    ['emotion', 'label.emotion'],
  summary:    ['summary', 'label.summary'],
  audioRef:   ['audio', 'wav', 'audio_path', 'file']
};

function get(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function* jsonFiles(target) {
  const st = fs.statSync(target);
  if (st.isFile()) { yield target; return; }
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    const p = path.join(target, e.name);
    if (e.isDirectory()) yield* jsonFiles(p);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) yield p;
  }
}

function keysOf(obj, depth = 0, out = new Set(), prefix = '') {
  if (depth > 3 || obj == null || typeof obj !== 'object') return out;
  const o = Array.isArray(obj) ? obj[0] : obj;
  if (o == null || typeof o !== 'object') return out;
  for (const k of Object.keys(o)) {
    const key = prefix ? prefix + '.' + k : k;
    out.add(key + (Array.isArray(o[k]) ? '[]' : ''));
    keysOf(o[k], depth + 1, out, key);
  }
  return out;
}

/** 질문 텍스트 → 우리 문항 유형 (거친 매핑. 평가자가 확인한다) */
export function guessType(q) {
  const s = String(q || '');
  if (/소개/.test(s)) return 'intro';
  if (/지원|동기|이유/.test(s)) return 'motivation';
  if (/강점|장점|약점|단점/.test(s)) return 'strength';
  if (/경험|사례|있었|했던/.test(s)) return 'behavioral';
  if (/한다면|하시겠|어떻게 대처|상황/.test(s)) return 'situational';
  return 'other';
}

/** 채점 표본 자격 — 자동채점과 같은 기준 */
export function eligible(answerText) {
  const t = String(answerText || '').trim();
  if (t.length < 20) return { ok: false, reason: 'too_short' };
  if (t.length > 4000) return { ok: false, reason: 'too_long' };
  return { ok: true };
}

export function importFile(db, file, fields, counters, limits) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const docId = String(get(doc, fields.id) ?? path.basename(file, '.json'));
  const jobGroup = get(doc, fields.jobGroup) ?? null;
  let qa = get(doc, fields.qaList);
  if (!Array.isArray(qa)) qa = [doc];                       // 파일 하나가 문답 하나인 형태

  const sessionId = 'aihub_' + docId;
  db.prepare(`INSERT OR IGNORE INTO sessions(id, kind, job_id, question_set_version, rubric_version, test_mode, bypass_count, started_at, source_json)
    VALUES (?,?,?,?,?,0,0,?,?)`).run(sessionId, 'aihub-import', jobGroup, 'aihub', 'rubric-0.1.0', new Date().toISOString(), null);

  const insA = db.prepare(`INSERT OR IGNORE INTO answers(session_id, question_id, question_type, question_text, ord, media_skipped)
    VALUES (?,?,?,?,?,'aihub_audio') RETURNING id`);
  const insT = db.prepare(`INSERT OR IGNORE INTO transcripts(answer_id, provider, raw, corrected, mean_confidence, correction_count, words_json) VALUES (?,?,?,NULL,NULL,0,NULL)`);
  const insQ = db.prepare('INSERT OR IGNORE INTO rating_queue(answer_id, priority) VALUES (?, ?)');

  let n = 0;
  qa.forEach((item, i) => {
    const q = get(item, fields.question);
    const a = get(item, fields.answer);
    if (!a) return;
    const type = guessType(q);
    if (limits.perType && (counters.byType[type] || 0) >= limits.perType) return;
    const el = eligible(a);
    const row = insA.get(sessionId, 'q' + (i + 1), type, q ?? null, i);
    if (!row) return;
    const meta = { intent: get(item, fields.intent) ?? null, emotion: get(item, fields.emotion) ?? null, summary: get(item, fields.summary) ?? null, audio: get(item, fields.audioRef) ?? null };
    insT.run(row.id, 'aihub', String(a));
    /* 감정 라벨은 채점에 쓰지 않는다. 메타로만 남긴다 (감사·연구용) */
    db.prepare('INSERT INTO audit(at, type, session_id, detail_json) VALUES (?,?,?,?)')
      .run(new Date().toISOString(), 'aihub_meta', sessionId, JSON.stringify({ answerId: row.id, ...meta, eligible: el }));
    if (el.ok) { insQ.run(row.id, type === 'other' ? -1 : 0); counters.byType[type] = (counters.byType[type] || 0) + 1; n++; }
    else counters.skipped[el.reason] = (counters.skipped[el.reason] || 0) + 1;
  });
  return n;
}

/* ---------- CLI ---------- */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--inspect') {
    const target = args[1];
    let shown = 0;
    for (const f of jsonFiles(target)) {
      const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
      console.log('== ' + f);
      console.log([...keysOf(doc)].join('\n'));
      if (++shown >= 2) break;
    }
    process.exit(0);
  }
  const [dbFile, target] = args.filter(a => !a.startsWith('--'));
  if (!dbFile || !target) { console.error('사용법: node db/import-aihub.mjs <db.sqlite> <dir|file.json> [--map map.json] [--limit N] [--per-type N]'); process.exit(2); }
  const mapIdx = args.indexOf('--map');
  const fields = mapIdx >= 0 ? { ...DEFAULT_FIELDS, ...JSON.parse(fs.readFileSync(args[mapIdx + 1], 'utf8')) } : DEFAULT_FIELDS;
  const limitIdx = args.indexOf('--limit'), perIdx = args.indexOf('--per-type');
  const limits = { total: limitIdx >= 0 ? +args[limitIdx + 1] : Infinity, perType: perIdx >= 0 ? +args[perIdx + 1] : null };
  const db = openDb(dbFile);
  const counters = { byType: {}, skipped: {} };
  let total = 0, files = 0;
  db.exec('BEGIN');
  for (const f of jsonFiles(target)) {
    total += importFile(db, f, fields, counters, limits); files++;
    if (total >= limits.total) break;
  }
  db.exec('COMMIT');
  console.log(JSON.stringify({ files, queued: total, byType: counters.byType, skipped: counters.skipped }, null, 2));
}

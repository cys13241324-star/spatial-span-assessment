-- ============================================================
-- 채점 DB 스키마 (SQLite)
--
-- 두 가지 질문에 답할 수 있어야 한다.
--   1) 이 점수는 어디서 나왔나  — 어느 세션·전사·루브릭 버전·채점기·프롬프트에서
--   2) 사람과 얼마나 맞나        — 평가자별 특성 점수와 근거, 평가자 간 일치도
--
-- 원칙
--   · 자동 점수는 덮어쓰지 않는다. 채점기·루브릭·프롬프트가 바뀔 때마다 새 run
--   · 사람 점수는 평가자별로 남긴다. 평균만 저장하면 일치도를 계산할 수 없다
--   · 직접 식별자는 이 DB에 두지 않는다 (candidate_ref는 외부 키일 뿐)
--   · 삭제 요청은 행 삭제가 아니라 파기 기록 + 내용 NULL (감사 가능)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- 세션 ----------
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,                 -- 'video-interview' | 'aihub-import'
  candidate_ref       TEXT,                          -- 외부 참조. 직접 식별자 아님
  job_id              TEXT,
  question_set_version TEXT NOT NULL,
  rubric_version      TEXT NOT NULL,
  content_fingerprint TEXT,
  test_mode           INTEGER NOT NULL DEFAULT 0,    -- 1이면 평가 자료 아님
  bypass_count        INTEGER NOT NULL DEFAULT 0,
  started_at          TEXT,
  submitted_at        TEXT,
  hiring_closed_at    TEXT,
  retention_media_until      TEXT,
  retention_transcript_until TEXT,
  retention_score_until      TEXT,
  purged_media_at     TEXT,
  purged_transcript_at TEXT,
  device_json         TEXT,                          -- 기기·타이밍 프로파일 (RT 보정용)
  providers_json      TEXT,                          -- 어떤 공급자로 처리됐나 (외부 전송 여부 포함)
  source_json         TEXT                           -- 원본 JSON 전체 (감사·재적재)
);

-- ---------- 답변 ----------
CREATE TABLE IF NOT EXISTS answers (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  question_id     TEXT NOT NULL,
  question_type   TEXT,
  question_text   TEXT,
  ord             INTEGER NOT NULL,                  -- 세션 내 순서
  prep_ms         INTEGER,
  answer_ms       INTEGER,
  answer_ended    TEXT,                              -- elapsed | stopped_early | bypassed
  media_chunks    INTEGER,
  media_bytes     INTEGER,
  media_complete  INTEGER,
  media_skipped   TEXT,                              -- NULL | no_media | bypassed | seeded
  first_speech_delay_ms INTEGER,                     -- 행동 지표: 기록만, 점수 미반영
  speech_duration_ms    INTEGER,
  silence_ratio         REAL,
  words_per_min         REAL,
  UNIQUE(session_id, question_id)
);

-- ---------- 전사 ----------
CREATE TABLE IF NOT EXISTS transcripts (
  answer_id           INTEGER PRIMARY KEY REFERENCES answers(id),
  provider            TEXT,                          -- fixture | manual | faster-whisper | aihub
  raw                 TEXT,
  corrected           TEXT,
  mean_confidence     REAL,
  low_confidence_ratio REAL,
  correction_count    INTEGER NOT NULL DEFAULT 0,
  words_json          TEXT                           -- [{text,startMs,endMs,confidence}]
);

CREATE TABLE IF NOT EXISTS transcript_corrections (
  id            INTEGER PRIMARY KEY,
  answer_id     INTEGER NOT NULL REFERENCES answers(id),
  attempt       INTEGER NOT NULL,
  edit_distance INTEGER NOT NULL,
  cap           INTEGER NOT NULL,
  accepted      INTEGER NOT NULL,
  reason        TEXT,
  at            TEXT
);

-- ---------- 자동 채점 (run 단위, 덮어쓰지 않음) ----------
CREATE TABLE IF NOT EXISTS auto_score_runs (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  status          TEXT NOT NULL,                     -- scored_uncalibrated | no_scorable_answers | dry_run | pending
  model_id        TEXT NOT NULL,                     -- claude-opus-5 | mock-heuristic
  effort          TEXT,
  rubric_version  TEXT NOT NULL,
  prompt_hash     TEXT,
  scored_at       TEXT,
  routed_to_human INTEGER NOT NULL DEFAULT 1,
  route_reason    TEXT,
  calibrated      REAL,                              -- 교정 전에는 NULL
  percentile      REAL                               -- 규준 전에는 NULL
);

CREATE TABLE IF NOT EXISTS auto_scores (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER NOT NULL REFERENCES auto_score_runs(id),
  answer_id     INTEGER NOT NULL REFERENCES answers(id),
  excluded      INTEGER NOT NULL DEFAULT 0,
  exclude_reason TEXT,                               -- no_transcript | low_confidence | model_refusal | parse_failed
  mask_total    INTEGER,
  flags_json    TEXT
);

CREATE TABLE IF NOT EXISTS auto_score_traits (
  id            INTEGER PRIMARY KEY,
  auto_score_id INTEGER NOT NULL REFERENCES auto_scores(id),
  trait_id      TEXT NOT NULL,
  raw           INTEGER NOT NULL CHECK (raw BETWEEN 1 AND 5),
  confidence    REAL,
  rationale     TEXT,
  UNIQUE(auto_score_id, trait_id)
);

CREATE TABLE IF NOT EXISTS auto_citations (
  id            INTEGER PRIMARY KEY,
  auto_score_id INTEGER NOT NULL REFERENCES auto_scores(id),
  trait_id      TEXT,
  quoted_text   TEXT NOT NULL,
  start_char    INTEGER,
  end_char      INTEGER
);

-- ---------- 사람 채점 (평가자별) ----------
CREATE TABLE IF NOT EXISTS raters (
  id            TEXT PRIMARY KEY,                    -- 'local-reviewer', 'r01' …
  trained_at    TEXT,                                -- 앵커 훈련 완료 시각
  note          TEXT
);

CREATE TABLE IF NOT EXISTS human_scores (
  id              INTEGER PRIMARY KEY,
  answer_id       INTEGER NOT NULL REFERENCES answers(id),
  rater_id        TEXT NOT NULL REFERENCES raters(id),
  rubric_version  TEXT NOT NULL,
  trait_id        TEXT NOT NULL,
  score           INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  scored_at       TEXT,
  note            TEXT,
  UNIQUE(answer_id, rater_id, rubric_version, trait_id)
);

CREATE TABLE IF NOT EXISTS human_evidence (
  id            INTEGER PRIMARY KEY,
  answer_id     INTEGER NOT NULL REFERENCES answers(id),
  rater_id      TEXT NOT NULL REFERENCES raters(id),
  trait_id      TEXT,
  quoted_text   TEXT NOT NULL,
  start_char    INTEGER,
  end_char      INTEGER
);

-- ---------- 채점 대기열 (AI Hub 등 외부 답변을 사람이 채점하기 위한 큐) ----------
CREATE TABLE IF NOT EXISTS rating_queue (
  answer_id     INTEGER PRIMARY KEY REFERENCES answers(id),
  priority      INTEGER NOT NULL DEFAULT 0,
  assigned_r1   TEXT REFERENCES raters(id),
  assigned_r2   TEXT REFERENCES raters(id),
  done_r1       INTEGER NOT NULL DEFAULT 0,
  done_r2       INTEGER NOT NULL DEFAULT 0,
  adjudicated   INTEGER NOT NULL DEFAULT 0           -- 불일치 시 3자 조정 완료
);

-- ---------- 규준 (표본 n≥300 전에는 행이 없어야 한다) ----------
CREATE TABLE IF NOT EXISTS norms (
  id            INTEGER PRIMARY KEY,
  scale_id      TEXT NOT NULL,                       -- 'interview.total' | 'interview.structure' | 'spatial-span' …
  rubric_version TEXT,
  group_key     TEXT NOT NULL DEFAULT 'all',         -- 직군·연령대 등 세분화
  n             INTEGER NOT NULL,
  mean          REAL NOT NULL,
  sd            REAL NOT NULL,
  built_at      TEXT NOT NULL,
  UNIQUE(scale_id, rubric_version, group_key)
);

-- ---------- 감사 ----------
CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL,
  type      TEXT NOT NULL,                           -- load | purge | erase_request | media_read | rights_request
  session_id TEXT,
  detail_json TEXT
);

-- ---------- 뷰: 평가 자료로 쓸 수 있는 답변만 ----------
CREATE VIEW IF NOT EXISTS v_eligible_answers AS
SELECT a.*, t.raw, t.corrected, t.mean_confidence, s.rubric_version
FROM answers a
JOIN sessions s ON s.id = a.session_id
LEFT JOIN transcripts t ON t.answer_id = a.id
WHERE s.test_mode = 0 AND s.bypass_count = 0
  AND (a.media_skipped IS NULL OR s.kind = 'aihub-import');

-- ---------- 뷰: 평가자 2인 점수 나란히 (일치도 계산용) ----------
CREATE VIEW IF NOT EXISTS v_rater_pairs AS
SELECT h1.answer_id, h1.trait_id, h1.rubric_version,
       h1.rater_id AS rater_a, h1.score AS score_a,
       h2.rater_id AS rater_b, h2.score AS score_b
FROM human_scores h1
JOIN human_scores h2
  ON h1.answer_id = h2.answer_id AND h1.trait_id = h2.trait_id
 AND h1.rubric_version = h2.rubric_version AND h1.rater_id < h2.rater_id;

-- ---------- 뷰: 자동 vs 사람 (교정 회귀의 원자료) ----------
CREATE VIEW IF NOT EXISTS v_auto_vs_human AS
SELECT r.id AS run_id, r.model_id, r.prompt_hash, a.answer_id, t.trait_id,
       t.raw AS auto_raw, h.rater_id, h.score AS human_score
FROM auto_score_runs r
JOIN auto_scores a ON a.run_id = r.id AND a.excluded = 0
JOIN auto_score_traits t ON t.auto_score_id = a.id
JOIN human_scores h ON h.answer_id = a.answer_id AND h.trait_id = t.trait_id AND h.rubric_version = r.rubric_version;

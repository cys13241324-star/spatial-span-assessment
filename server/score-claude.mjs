#!/usr/bin/env node
/* ============================================================
   score-claude.mjs — 루브릭 채점 참조 구현 (서버 측)

   설계도 §3-05 / §5. 브라우저가 내려받은 세션 JSON을 받아
     1) 식별자 마스킹 → 2) 근거 인용 호출 (Citations) → 3) 점수 호출 (구조화 출력)
   순으로 처리하고 Score 객체를 만든다. 영상·음성은 절대 보내지 않는다 — 텍스트만.

   두 번 호출하는 이유: Citations는 output_config.format(구조화 출력)과 함께 쓰면 400이다.
   그래서 "어느 발언이 근거인가"는 Citations로, "몇 점인가"는 구조화 출력으로 받는다.

   사용
     node server/score-claude.mjs session.json --dry-run     # 키 없이 요청 본문만 출력
     node server/score-claude.mjs session.json               # 실제 호출 (ANTHROPIC_API_KEY 또는 ant auth login)
     node server/score-claude.mjs session.json --out score.json

   환경
     ANTHROPIC_MODEL      기본 claude-opus-5
     ANTHROPIC_EFFORT     low|medium|high|xhigh|max, 기본 high
     INFERENCE_GEO        추론 지역 고정 (선택). 값은 플랫폼 문서 참조
     SCORE_FALLBACKS      "1"이면 서버측 폴백 켬. 기본 꺼짐 — 아래 설명

   폴백을 기본으로 끄는 이유
     이 채점은 사람의 탈락에 영향을 준다. 모델이 거부(refusal)하면 다른 모델로 조용히
     넘기는 게 아니라 인적 검토로 보내야 한다 (설계도 R-03·§8). 켜고 싶으면 SCORE_FALLBACKS=1.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const here = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 브라우저 모듈 재사용 (마스킹·루브릭은 한 벌만 존재해야 한다) ---------- */
function loadBrowserModule(rel) {
  const src = fs.readFileSync(path.join(here, '..', rel), 'utf8');
  const sandbox = {};
  new Function('window', 'global', src)(sandbox, sandbox);
  return sandbox;
}
const { Transcript } = loadBrowserModule('js/interview/transcript.js');
const { Questions } = loadBrowserModule('js/interview/questions.js');

/* ---------- 인자 ---------- */
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
if (!file) {
  console.error('사용법: node server/score-claude.mjs <session.json> [--dry-run] [--out score.json]');
  process.exit(2);
}

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const EFFORT = process.env.ANTHROPIC_EFFORT || 'high';
const GEO = process.env.INFERENCE_GEO || null;
const FALLBACKS = process.env.SCORE_FALLBACKS === '1';

const session = JSON.parse(fs.readFileSync(file, 'utf8'));
const rubric = Questions.RUBRIC;
const qset = Questions.SET;

/* ---------- 버전 일치 — 다른 루브릭으로 채점하면 점수 비교가 무의미하다 ---------- */
if (session.rubricVersion !== rubric.version || session.questionSetVersion !== qset.version) {
  console.error(`버전 불일치: 세션(${session.rubricVersion}/${session.questionSetVersion}) vs 서버(${rubric.version}/${qset.version})`);
  process.exit(3);
}

/* ---------- 1. 마스킹 + 채점 대상 선별 ---------- */
const CONF_MIN = 0.6;          // 이 미만은 자동채점 제외 → 인적 검토 (R-01)

const answers = (session.answers || []).map((a, i) => {
  const q = qset.items[i];
  const t = a.transcript;
  if (!t || !(t.corrected ?? t.raw)?.trim()) {
    return { q, a, excluded: true, excludeReason: 'no_transcript' };
  }
  if (t.meanConfidence != null && t.meanConfidence < CONF_MIN) {
    return { q, a, excluded: true, excludeReason: 'low_confidence' };
  }
  const masked = Transcript.mask(t.corrected ?? t.raw, { names: session.names || [] });
  return { q, a, excluded: false, text: masked.text, maskCounts: masked.counts, maskTotal: masked.total };
});

/* ---------- 프롬프트 — 루브릭은 고정 프리픽스 (캐싱 대상) ---------- */
function rubricText() {
  const lines = [
    `당신은 구조화 면접의 채점 보조자다. 아래 루브릭(${rubric.version})만 사용한다.`,
    `평가 대상은 "말한 내용"뿐이다. 말투·자신감·열정·인상·문화 적합성은 평가하지 않는다.`,
    `[학교]·[회사]·[이름]·[지역] 같은 토큰은 마스킹된 식별자다. 그 자리에 무엇이 있었을지 추측하지 않는다.`,
    ``,
    `특성과 앵커 (${rubric.scale[0]}~${rubric.scale[1]}점):`
  ];
  for (const [k, t] of Object.entries(rubric.traits)) {
    lines.push(`- ${k} (${t.label}): ${t.looks}. 1=${t.anchors[1]} / 3=${t.anchors[3]} / 5=${t.anchors[5]}`);
  }
  lines.push(``, `문항별 대응 특성:`);
  for (const q of qset.items) lines.push(`- ${q.id} [${q.type}] → ${q.traits.join(', ')}`);
  return lines.join('\n');
}

const SYSTEM = [
  { type: 'text', text: rubricText(), cache_control: { type: 'ephemeral' } }
];

/* ---------- 2. 근거 인용 요청 (Citations) ----------
   답변마다 문서 하나. 특성별로 "근거가 되는 발언"을 인용하게 한다.
   출력은 구조화하지 않는다 — Citations와 병용 불가. 대신 특성 키를 줄머리에 쓰게 한다. */
function evidenceRequest(item) {
  return {
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    ...(GEO ? { inference_geo: GEO } : {}),
    output_config: { effort: EFFORT },
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: item.text },
          title: `${item.q.id} 답변 전사`,
          context: `문항: ${item.q.text}`,
          citations: { enabled: true }
        },
        {
          type: 'text',
          text: `이 답변을 특성 ${item.q.traits.join(', ')} 기준으로 볼 때, 각 특성의 판단 근거가 되는 발언을 인용하라. ` +
                `특성 키를 줄머리에 쓰고(예: "specificity:"), 근거가 없으면 "근거 없음"이라고 써라. 점수는 아직 매기지 않는다.`
        }
      ]
    }]
  };
}

/* ---------- 3. 점수 요청 (구조화 출력) ---------- */
const ScoreSchema = z.object({
  traits: z.array(z.object({
    traitId: z.string(),
    score: z.number().int().min(1).max(5),
    confidence: z.number().min(0).max(1),
    rationale: z.string()
  })),
  flags: z.array(z.string())
});

function scoreRequest(item, evidence) {
  const evText = evidence.length
    ? evidence.map(e => `- ${e.traitId}: "${e.quotedText}"`).join('\n')
    : '(인용된 근거 없음)';
  return {
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    ...(GEO ? { inference_geo: GEO } : {}),
    output_config: { effort: EFFORT, format: zodOutputFormat(ScoreSchema) },
    messages: [{
      role: 'user',
      content:
        `문항 ${item.q.id} [${item.q.type}]: ${item.q.text}\n\n` +
        `답변 전사(마스킹됨):\n${item.text}\n\n` +
        `앞 단계에서 인용된 근거:\n${evText}\n\n` +
        `특성 ${item.q.traits.join(', ')} 각각에 대해 루브릭 앵커에 따라 점수를 매기고, ` +
        `인용된 근거가 판단을 뒷받침하는 정도를 confidence로 표시하라. ` +
        `평가 불가 사유(무응답, 질문과 무관, 전사 훼손 등)가 있으면 flags에 적어라.`
    }]
  };
}

/* ---------- Citations 응답 → 근거 목록 ---------- */
function parseEvidence(message, traits) {
  const out = [];
  let currentTrait = null;
  for (const block of message.content) {
    if (block.type !== 'text') continue;
    const head = /^\s*([A-Za-z]+)\s*:/.exec(block.text);
    if (head && traits.includes(head[1])) currentTrait = head[1];
    for (const c of block.citations || []) {
      if (c.type !== 'char_location') continue;
      out.push({
        traitId: currentTrait,
        quotedText: c.cited_text,
        startChar: c.start_char_index,
        endChar: c.end_char_index
      });
    }
  }
  return out;
}

/* ---------- 실행 ---------- */
async function main() {
  const client = dryRun ? null : new Anthropic();
  const promptHash = Questions.fingerprint();
  const perQuestion = [];
  let anyRefusal = false;

  for (const item of answers) {
    if (item.excluded) {
      perQuestion.push({ questionId: item.q.id, excluded: true, excludeReason: item.excludeReason, traits: [], citations: [] });
      continue;
    }

    const evReq = evidenceRequest(item);
    if (dryRun) {
      perQuestion.push({ questionId: item.q.id, dryRun: true, maskTotal: item.maskTotal, evidenceRequest: evReq });
      continue;
    }

    /* 근거 */
    const evMsg = FALLBACKS
      ? await client.beta.messages.create({ ...evReq, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(evReq);

    if (evMsg.stop_reason === 'refusal') {
      anyRefusal = true;
      perQuestion.push({ questionId: item.q.id, excluded: true, excludeReason: 'model_refusal',
        refusal: evMsg.stop_details ?? null, traits: [], citations: [] });
      continue;
    }
    const citations = parseEvidence(evMsg, item.q.traits);

    /* 점수 */
    const scReq = scoreRequest(item, citations);
    const scMsg = await client.messages.parse(scReq);
    if (scMsg.stop_reason === 'refusal' || !scMsg.parsed_output) {
      anyRefusal = anyRefusal || scMsg.stop_reason === 'refusal';
      perQuestion.push({ questionId: item.q.id, excluded: true,
        excludeReason: scMsg.stop_reason === 'refusal' ? 'model_refusal' : 'parse_failed',
        refusal: scMsg.stop_details ?? null, traits: [], citations });
      continue;
    }

    perQuestion.push({
      questionId: item.q.id,
      excluded: false,
      maskTotal: item.maskTotal,
      traits: scMsg.parsed_output.traits.map(t => ({ traitId: t.traitId, raw: t.score, confidence: t.confidence, rationale: t.rationale })),
      flags: scMsg.parsed_output.flags,
      citations,
      usage: {
        evidence: { in: evMsg.usage.input_tokens, out: evMsg.usage.output_tokens, cacheRead: evMsg.usage.cache_read_input_tokens ?? 0 },
        score: { in: scMsg.usage.input_tokens, out: scMsg.usage.output_tokens, cacheRead: scMsg.usage.cache_read_input_tokens ?? 0 }
      }
    });
  }

  const scored = perQuestion.filter(p => !p.excluded && !p.dryRun);
  const excludedCount = perQuestion.filter(p => p.excluded).length;

  const score = {
    status: dryRun ? 'dry_run' : (scored.length ? 'scored_uncalibrated' : 'no_scorable_answers'),
    rubricVersion: rubric.version,
    questionSetVersion: qset.version,
    modelId: MODEL,
    effort: EFFORT,
    promptHash,
    scoredAt: new Date().toISOString(),
    perQuestion,
    /* 교정 전 — 사람 점수 표본으로 캘리브레이션하기 전에는 척도 의미가 없다 (§3-06) */
    calibrated: null,
    percentile: null,
    /* 하나라도 제외·거부가 있으면 사람이 본다. 지금은 캘리브레이션이 없어 전부 인적 검토다 */
    routedToHuman: true,
    routeReason: anyRefusal ? 'model_refusal' : (excludedCount ? 'excluded_answers' : 'uncalibrated')
  };

  const json = JSON.stringify(score, null, 2);
  if (outPath) fs.writeFileSync(outPath, json);
  else console.log(json);
}

main().catch(err => {
  /* 재시도 가능 여부를 구분해 남긴다 — 429/5xx는 재시도, 400/404는 수정 필요 */
  if (err instanceof Anthropic.RateLimitError) console.error('429 rate limit — 잠시 후 재시도');
  else if (err instanceof Anthropic.APIStatusError) console.error(`API ${err.status}:`, err.message);
  else if (err instanceof Anthropic.APIConnectionError) console.error('연결 실패 — 재시도');
  else console.error(err);
  process.exit(1);
});

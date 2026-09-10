# server — 채점 참조 구현

브라우저 프로토타입은 채점기를 `pending`(보류)으로 둔다. 실제 채점은 여기서 한다 — 브라우저에서 API 키를 다루면 안 되고, 면접 채점은 실시간이 아니기 때문이다.

## 무엇을 보내고 무엇을 보내지 않나

| 보냄 | 보내지 않음 |
|---|---|
| 마스킹된 전사 텍스트 (학교·회사·이름·지역·연락처 제거) | 영상, 음성 |
| 문항 텍스트, 루브릭 | 응시자 식별자, 기기 정보, 행동 지표 |

## 흐름

```
session.json ─► 버전 검사 ─► 마스킹 ─► 저신뢰 제외
                 │
                 ├─ 1) 근거 호출: document + citations:{enabled:true}
                 │      → 특성별 인용문 + 문자 오프셋 (char_location)
                 │
                 └─ 2) 점수 호출: 구조화 출력 (zod)
                        → 특성별 1~5점 + confidence + rationale + flags
```

두 번 호출하는 이유: Citations는 `output_config.format`과 함께 쓰면 400이다. 근거는 Citations로, 점수는 구조화 출력으로 받는다.

## 실행

```bash
cd prototype
npm install @anthropic-ai/sdk zod

# 키 없이 요청 본문만 확인 (마스킹 결과 검증용)
node server/score-claude.mjs session.json --dry-run

# 실제 호출 — ANTHROPIC_API_KEY 또는 `ant auth login`
node server/score-claude.mjs session.json --out score.json
```

`session.json`은 브라우저 제출 완료 화면의 "기록 JSON 내려받기"로 얻는다.

## 환경변수

| 변수 | 기본 | 뜻 |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-opus-5` | 사람의 탈락에 영향을 주는 판정이라 낮추지 않는다 |
| `ANTHROPIC_EFFORT` | `high` | `max`까지 올릴 수 있다 |
| `INFERENCE_GEO` | (없음) | 추론 지역 고정. 국외이전 논점 관리 (R-07) |
| `SCORE_FALLBACKS` | `0` | 모델 거부 시 다른 모델로 폴백. **기본 꺼짐** — 거부는 인적 검토로 보내야 한다 |

## 출력 (Score)

```json
{
  "status": "scored_uncalibrated",
  "rubricVersion": "rubric-0.1.0",
  "modelId": "claude-opus-5",
  "promptHash": "fp_…",
  "perQuestion": [{
    "questionId": "q4",
    "traits": [{ "traitId": "structure", "raw": 4, "confidence": 0.8, "rationale": "…" }],
    "citations": [{ "traitId": "structure", "quotedText": "…", "startChar": 12, "endChar": 58 }],
    "flags": []
  }],
  "calibrated": null,
  "percentile": null,
  "routedToHuman": true,
  "routeReason": "uncalibrated"
}
```

`calibrated`와 `percentile`은 항상 `null`이다. 사람 점수 표본으로 교정하기 전에는 원점수의 척도 의미가 없다 (설계도 §3-06). 그래서 `routedToHuman`도 항상 `true`다.

## 아직 없는 것

- **Batch API** — 비용 50%. 두 단계가 순차 의존이라 근거 배치 → 점수 배치로 나눠 돌린다. 단일 호출이 검증되면 옮긴다
- **캘리브레이션** — 사람 채점 표본이 있어야 한다
- **편향 회귀 테스트** — 이름·학교만 바꾼 쌍 답변으로 점수가 흔들리는지 CI에서 확인 (R-03). `--dry-run`으로 마스킹이 먼저 지워지는지부터 본다
- **재현성 측정** — 같은 답변 반복 채점

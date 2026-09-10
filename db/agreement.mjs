/* ============================================================
   agreement.mjs — 평가자 간 · 자동-사람 일치도 (순수 함수)

   왜 κ인가: 정확 일치율은 우연 일치를 보정하지 않는다. 5점 척도에서 둘 다 3점만
   찍어도 일치율이 높게 나온다. 가중 κ(quadratic)는 1점 차이와 4점 차이를 다르게 벌한다.
   목표: 평가자 간 가중 κ ≥ 0.70 (ASAP 사례 0.86이 상한 감각).
   ============================================================ */

/** 정확 일치·±1·평균 차이 — 빠른 점검용 */
export function simpleAgreement(pairs) {
  let n = 0, exact = 0, within1 = 0, diffSum = 0, absSum = 0;
  for (const [a, b] of pairs) {
    if (a == null || b == null) continue;
    n++;
    const d = a - b;
    if (d === 0) exact++;
    if (Math.abs(d) <= 1) within1++;
    diffSum += d; absSum += Math.abs(d);
  }
  return {
    n,
    exact: n ? exact / n : null,
    within1: n ? within1 / n : null,
    meanDiff: n ? diffSum / n : null,     // 부호 있음: 첫 번째 − 두 번째
    mae: n ? absSum / n : null
  };
}

/**
 * 가중 Cohen's κ. weights: 'quadratic' | 'linear' | 'none'
 * categories: 1..k (기본 5점 척도)
 */
export function weightedKappa(pairs, k = 5, weights = 'quadratic') {
  const valid = pairs.filter(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a >= 1 && a <= k && b >= 1 && b <= k);
  const n = valid.length;
  if (n === 0) return { n: 0, kappa: null };

  const O = Array.from({ length: k }, () => Array(k).fill(0));
  const ra = Array(k).fill(0), rb = Array(k).fill(0);
  for (const [a, b] of valid) { O[a - 1][b - 1]++; ra[a - 1]++; rb[b - 1]++; }

  const w = (i, j) => {
    if (weights === 'none') return i === j ? 0 : 1;
    const d = Math.abs(i - j) / (k - 1);
    return weights === 'linear' ? d : d * d;
  };

  let num = 0, den = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    const E = (ra[i] * rb[j]) / n;
    num += w(i, j) * O[i][j];
    den += w(i, j) * E;
  }
  const kappa = den === 0 ? (num === 0 ? 1 : 0) : 1 - num / den;
  return { n, kappa: Math.round(kappa * 1000) / 1000, weights };
}

/** 판정 문구 — 리포트에 그대로 쓴다 */
export function kappaVerdict(kappa) {
  if (kappa == null) return '표본 없음';
  if (kappa >= 0.8) return '거의 완전 일치';
  if (kappa >= 0.7) return '실질적 일치 — 목표 충족';
  if (kappa >= 0.6) return '중간 — 재훈련 권장';
  if (kappa >= 0.4) return '보통 — 앵커 재정의 필요';
  return '낮음 — 루브릭 자체를 의심';
}

/**
 * 특성별로 묶어 계산. rows: [{trait_id, score_a, score_b}]
 */
export function byTrait(rows, k = 5) {
  const groups = {};
  for (const r of rows) (groups[r.trait_id] ||= []).push([r.score_a, r.score_b]);
  const out = {};
  for (const [trait, pairs] of Object.entries(groups)) {
    const wk = weightedKappa(pairs, k);
    out[trait] = { ...simpleAgreement(pairs), kappa: wk.kappa, verdict: kappaVerdict(wk.kappa) };
  }
  return out;
}

/**
 * 자동→사람 선형 교정 계수 (최소제곱). 표본이 적으면 계수를 내지 않는다.
 * 실제 운영은 분위 매핑까지 필요하지만(Rulers), 첫 단계는 이걸로 충분히 방향이 보인다.
 */
export function linearCalibration(pairs, minN = 30) {
  const valid = pairs.filter(([a, h]) => a != null && h != null);
  const n = valid.length;
  if (n < minN) return { n, ok: false, reason: `표본 ${n} < ${minN}` };
  const mx = valid.reduce((s, [a]) => s + a, 0) / n;
  const my = valid.reduce((s, [, h]) => s + h, 0) / n;
  let sxy = 0, sxx = 0;
  for (const [a, h] of valid) { sxy += (a - mx) * (h - my); sxx += (a - mx) * (a - mx); }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  return { n, ok: true, slope: Math.round(slope * 1000) / 1000, intercept: Math.round(intercept * 1000) / 1000 };
}

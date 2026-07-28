// src/lib/ai/pricing.ts
//
// 토큰 사용량을 돈으로 환산한다.
//
// 모르는 모델을 0원으로 적지 않는다
// ──────────────────────────────────
// 단가표에 없는 모델을 0으로 두면 화면에 "오늘 $0.00"이 뜬다. 사용자는
// 그걸 '무료'로 읽지 '모른다'로 읽지 않는다. 실제로는 돈이 나가고 있는데
// 화면만 안전해 보이는 상태라, 이 파일에서 가장 조심하는 부분이다.
//
// 단가는 바뀐다
// ─────────────
// 공급자가 가격을 내리거나 모델을 새로 내면 이 표는 낡는다. 그래서
// 결과에 '추정'과 '단가 기준일'을 같이 들고 나간다. 화면이 그걸 그대로
// 보여줘야 사용자가 숫자를 얼마나 믿을지 정할 수 있다.

export interface Price {
  /** 100만 입력 토큰당 USD */
  inPerM: number;
  /** 100만 출력 토큰당 USD */
  outPerM: number;
}

/**
 * 단가표. 100만 토큰당 USD.
 *
 * 정확한 최신 값이 아닐 수 있다 — 그래서 추정이라고 표시한다.
 * 모델 ID는 접두사로 맞춘다(gpt-4o-mini-2024-07-18 → gpt-4o-mini).
 */
export const PRICING_AS_OF = '2026-07';

const TABLE: { prefix: string; price: Price }[] = [
  // OpenAI
  { prefix: 'gpt-4o-mini', price: { inPerM: 0.15, outPerM: 0.60 } },
  { prefix: 'gpt-4o',      price: { inPerM: 2.50, outPerM: 10.00 } },
  { prefix: 'gpt-4.1-mini',price: { inPerM: 0.40, outPerM: 1.60 } },
  { prefix: 'gpt-4.1',     price: { inPerM: 2.00, outPerM: 8.00 } },
  // Anthropic
  { prefix: 'claude-haiku',  price: { inPerM: 1.00, outPerM: 5.00 } },
  { prefix: 'claude-sonnet', price: { inPerM: 3.00, outPerM: 15.00 } },
  { prefix: 'claude-opus',   price: { inPerM: 15.00, outPerM: 75.00 } },
  // Google
  { prefix: 'gemini-2.0-flash', price: { inPerM: 0.10, outPerM: 0.40 } },
  { prefix: 'gemini-2.5-flash', price: { inPerM: 0.30, outPerM: 2.50 } },
  { prefix: 'gemini-2.5-pro',   price: { inPerM: 1.25, outPerM: 10.00 } },
];

/** 모델 ID로 단가를 찾는다. 없으면 null — 0이 아니다 */
export function priceOf(model: string | null | undefined): Price | null {
  const m = String(model ?? '').trim().toLowerCase();
  if (!m) return null;
  // 가장 긴 접두사가 이긴다. 'gpt-4o'가 'gpt-4o-mini'를 먼저 잡으면
  // 미니 요금이 16배로 계산된다.
  let best: { len: number; price: Price } | null = null;
  for (const row of TABLE) {
    if (m.startsWith(row.prefix) && (!best || row.prefix.length > best.len)) {
      best = { len: row.prefix.length, price: row.price };
    }
  }
  return best?.price ?? null;
}

export interface CostResult {
  /** USD. 단가를 모르면 null */
  usd: number | null;
  /** 단가표에 없는 모델인가 */
  unknownModel: boolean;
  /** 화면에 그대로 쓸 문구 */
  label: string;
}

/**
 * 한 번의 호출 비용.
 *
 * 토큰 수를 모르면 null이다. 0으로 두면 '공짜로 불렀다'가 되는데,
 * 실제로는 응답에 usage가 안 실려 온 것뿐이다.
 */
export function estimateCost(
  model: string | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): CostResult {
  const p = priceOf(model);
  // null/undefined를 먼저 걸러낸다. Number(null)은 0이라 그냥 두면
  // '토큰 수를 모른다'가 '0 토큰을 썼다'로 통과한다 — 이 파일이 막으려는
  // 바로 그 실패다.
  const missing = inputTokens == null || outputTokens == null;
  const i = Number(inputTokens);
  const o = Number(outputTokens);
  const haveTokens = !missing && Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0;

  if (!p) {
    return {
      usd: null, unknownModel: true,
      label: `단가 미등록 (${model || '모델 불명'})`,
    };
  }
  if (!haveTokens) {
    return { usd: null, unknownModel: false, label: '토큰 수 확인 불가' };
  }

  const usd = (i / 1_000_000) * p.inPerM + (o / 1_000_000) * p.outPerM;
  return { usd, unknownModel: false, label: fmtUsd(usd) };
}

/**
 * 아주 작은 금액을 $0.00으로 적지 않는다.
 * 0.0004달러를 $0.00으로 쓰면 '안 썼다'로 읽힌다.
 */
export function fmtUsd(usd: number | null): string {
  if (usd == null || !Number.isFinite(usd)) return '확인 불가';
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export interface UsageRow {
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface UsageTotal {
  /** 단가를 아는 호출만 더한 금액 */
  usd: number;
  /** 금액에 반영된 호출 수 */
  counted: number;
  /** 단가를 몰라 빠진 호출 수 — 감추면 총액이 실제보다 작아 보인다 */
  unpriced: number;
  /** 토큰 수를 몰라 빠진 호출 수 */
  untokened: number;
  label: string;
  /** 실제 비용이 이보다 클 수 있는가 */
  isPartial: boolean;
}

/** 여러 호출의 합계. 빠진 것을 숨기지 않는다 */
export function sumCost(rows: UsageRow[]): UsageTotal {
  let usd = 0, counted = 0, unpriced = 0, untokened = 0;
  for (const r of rows) {
    const c = estimateCost(r.model, r.inputTokens, r.outputTokens);
    if (c.usd != null) { usd += c.usd; counted++; }
    else if (c.unknownModel) unpriced++;
    else untokened++;
  }
  const isPartial = unpriced > 0 || untokened > 0;
  return {
    usd, counted, unpriced, untokened, isPartial,
    // 일부만 계산했으면 '이상'을 붙인다. 그냥 금액만 쓰면 그게 전부인 줄 안다.
    label: isPartial ? `${fmtUsd(usd)} 이상` : fmtUsd(usd),
  };
}

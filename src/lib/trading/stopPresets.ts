// src/lib/trading/stopPresets.ts
//
// **손절 프리셋은 사이징이 아니다.**
//
// 기존 주문폼에는 비슷해 보이는 퍼센트 줄이 셋 있었다:
//
//   25 / 50 / 75 / 100%   잔고의 몇 %를 증거금으로 — **사이징**
//   0.5 / 1 / 2%          이 거래에서 계좌의 몇 %를 잃어도 되는가 — 위험역산
//   1 / 2 / 3 / 5 / 10%   진입가에서 몇 % 떨어진 곳에서 자를까 — **손절 거리**
//
// 앞의 둘은 "얼마나 크게 들어갈까"이고 마지막 하나는 "어디서 나올까"다.
// 정본 화면은 사이징을 슬라이더 하나로 모으고, **손절 거리는 남긴다** —
// 같은 퍼센트처럼 보인다고 묶으면 서로 다른 결정을 한 칸에서 하게 된다.
//
// 가격을 화면이 정하지 않는다
// ───────────────────────────
// 프리셋을 고르면 주문에는 **퍼센트만** 실린다(`stopLossPct`). 손절가는
// 서버가 자기 마크가로 만든다(`/api/paper/order`). 화면이 가격을 계산해
// 보내면 그 값이 곧 체결 기준이 되고, 유리한 값을 넣을 자리가 생긴다.
//
// 아래 함수는 **미리보기 전용**이다. 주문 본문에 들어가지 않는다.

/** 자주 쓰는 손절 거리(%). 기존 주문폼에서 그대로 가져왔다. */
export const STOP_PCTS = [1, 2, 3, 5, 10];

/** `Number(null)`은 0이다. 못 읽은 것을 0으로 세지 않으려면 먼저 거른다. */
function num(v: any): number {
  return v == null || v === '' ? NaN : Number(v);
}

export function isValidStopPct(v: any): boolean {
  const n = num(v);
  // 0%는 손절이 아니라 진입가다. 100% 이상은 가격이 0 이하가 된다.
  return Number.isFinite(n) && n > 0 && n < 100;
}

/**
 * 미리보기용 손절가. **주문에 실리는 값이 아니다.**
 *
 * 롱은 아래, 숏은 위다. 방향을 모르면 `null`이다 — 반대쪽에 손절을 그리면
 * 진입하자마자 잘리는 그림이 된다.
 */
export function previewStopPrice(
  price: any, side: any, pct: any,
): number | null {
  const p = num(price);
  const q = num(pct);
  if (!Number.isFinite(p) || p <= 0) return null;
  if (!isValidStopPct(q)) return null;
  if (side === 'LONG') return p * (1 - q / 100);
  if (side === 'SHORT') return p * (1 + q / 100);
  return null;
}

export type StopChoice =
  /** 프리셋 — 주문에는 퍼센트가 실린다 */
  | { kind: 'PCT'; pct: number }
  /** 직접 입력 — 주문에는 가격이 실린다 */
  | { kind: 'PRICE'; price: number }
  /** 손절 없음 */
  | { kind: 'NONE' };

/**
 * 화면의 두 입력(프리셋·직접입력)에서 **하나**를 고른다.
 *
 * 직접 입력이 우선이다. 사람이 방금 친 값을 프리셋이 덮으면, 화면에 보이는
 * 숫자와 나가는 값이 달라진다.
 */
export function stopChoiceOf(rawPct: any, rawPrice: any): StopChoice {
  const price = num(rawPrice);
  if (Number.isFinite(price) && price > 0) return { kind: 'PRICE', price };
  const pct = num(rawPct);
  if (isValidStopPct(pct)) return { kind: 'PCT', pct };
  return { kind: 'NONE' };
}

/** 주문 본문에 실을 칸. 손절이 없으면 아무 칸도 만들지 않는다. */
export function stopRequestFields(c: StopChoice): { stopLossPct?: number; stopPrice?: number } {
  if (c.kind === 'PCT') return { stopLossPct: c.pct };
  if (c.kind === 'PRICE') return { stopPrice: c.price };
  return {};
}

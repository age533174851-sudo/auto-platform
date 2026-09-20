// src/lib/trading/sellPlan.ts
//
// **매도 화면의 판단 — 여기서만 한다.** 간편도 프로도 이 파일을 쓴다.
//
// 무엇을 하지 않는가
// ──────────────────
// **돈을 계산하지 않는다.** 매도 대금·수수료·실현손익은 전부
// `paper_sell_holding`(088)이 NUMERIC으로 만들고, 화면은 응답에 실려 온
// 값을 적는다. 여기서 한 번 더 계산하면 화면 숫자와 장부 숫자가 갈리고,
// 갈린 날 사용자는 화면을 믿는다.
//
// **평단도 만들지 않는다.** `/api/paper/holdings`의 `avgPrice`가 정본이고
// (`paper_holdings`의 `h_avg_price`), 그 함수 주석이 못박아 둔 대로
// 평가손익·수익률은 정본이 없어서 넣지 않는다.
//
// 비율과 수량을 동시에 보내지 않는다
// ──────────────────────────────────
// 서버의 `sellAmountOf`는 **하나만** 받는다. 둘 다 오면 `AMBIGUOUS`로
// 거부하고, 하나를 골라 주지 않는다 — 고르는 순간 사용자가 안 고른 쪽으로
// 돈이 움직인다. 그래서 이 파일도 **어느 칸을 쓰는 중인지**를 상태로 들고,
// 요청에는 그 하나만 싣는다. 같은 규칙을 두 번 적지 않도록, 최종 검증은
// 서버와 **같은 함수**(`sellAmountOf`)로 한다.

import { sellAmountOf, sellAmountFailed, type SellAmount } from '../engine/paperSellRequest';
import { unsupported, type Support } from './capability';

/** `/api/paper/holdings`가 주는 한 줄. **화면이 만들지 않는다** */
export interface SellHolding {
  symbol: string;
  market: string;
  quantity: number;
  totalNotional: number;
  entryFeeBasis: number;
  /** 수수료를 넣지 않은 체결평균가. 없으면 null — 0으로 적지 않는다 */
  avgPrice: number | null;
  lots: number;
}

/** 사용자가 지금 어느 칸으로 정하고 있는가. **둘 다는 없다** */
export type SellInputMode = 'PERCENT' | 'QUANTITY';

/**
 * 목록에서 이 종목의 보유를 찾는다.
 *
 * **시장까지 본다.** 같은 심볼이 두 시장에 있으면 심볼만으로는 엉뚱한 줄을
 * 집는다 — exit-monitor에서 이미 한 번 난 고장이고, 그때도 원인은 키에
 * 시장이 없던 것이었다.
 *
 * 못 찾으면 null이다. **수량 0짜리 가짜 줄을 만들지 않는다** — "보유가
 * 없다"와 "못 읽었다"를 화면이 구분해야 하기 때문이다.
 */
export function holdingFor(
  holdings: readonly SellHolding[] | null | undefined,
  symbol: string, market: string,
): SellHolding | null {
  if (!Array.isArray(holdings)) return null;
  const s = String(symbol || '').trim().toUpperCase();
  const m = String(market || '').trim().toUpperCase();
  if (!s || !m) return null;
  for (const h of holdings) {
    if (!h) continue;
    if (String(h.symbol).toUpperCase() === s && String(h.market).toUpperCase() === m) return h;
  }
  return null;
}

export interface SellRequestInput {
  mode: SellInputMode;
  /** 비율 칸의 값 */
  percent: number | null;
  /** 수량 칸의 값. **문자열이다** — 빈 칸과 0을 구분해야 한다 */
  quantityText: string;
}

/**
 * 화면 상태 → 요청 본문의 금액 칸.
 *
 * 결과를 **서버와 같은 함수로 검증해서** 돌려준다. 여기서 자체 규칙을 쓰면
 * 화면이 통과시킨 값을 서버가 거부하는 조합이 생긴다.
 */
export function sellRequestOf(i: SellRequestInput): SellAmount {
  // `sellAmountOf`는 "안 보낸 칸"을 `undefined`/빈 문자열로 읽는다.
  // 그래서 **쓰지 않는 칸은 아예 넣지 않는다** — null을 넣으면 값으로 읽힌다.
  if (i?.mode === 'QUANTITY') {
    return sellAmountOf({ quantity: i.quantityText });
  }
  return sellAmountOf({ percent: i?.percent });
}

export type SellBlock =
  | 'NONE'
  /** 이 시장/장부에서 나눠 팔 수 없다 */
  | 'UNSUPPORTED'
  /** 보유를 아직 못 읽었다. **0이라는 뜻이 아니다** */
  | 'HOLDING_UNKNOWN'
  /** 읽었고, 없다 */
  | 'NO_HOLDING'
  /** 얼마를 팔지 아직 안 정했다 */
  | 'NO_AMOUNT'
  /** 가진 것보다 많이 팔려고 한다 */
  | 'OVERSELL';

export interface SellGate {
  ready: boolean;
  block: SellBlock;
  /** 화면에 그대로 적는 한 줄 */
  reason: string | null;
}

export interface SellGateInput {
  supported: Support;
  /** 보유를 읽었는가. **못 읽었으면 false** */
  holdingRead: boolean;
  holding: SellHolding | null;
  request: SellAmount;
}

/**
 * 매도 버튼을 열어도 되는가.
 *
 * **못 읽은 것을 0으로 읽지 않는다.** 보유 조회가 실패했는데 "보유 없음"을
 * 적으면 사용자는 자기 자산이 사라진 줄 안다. 그 둘은 다른 사실이다.
 */
export function sellGate(i: SellGateInput): SellGate {
  if (unsupported(i.supported)) {
    return { ready: false, block: 'UNSUPPORTED', reason: i.supported.reason };
  }
  if (!i.holdingRead) {
    return {
      ready: false, block: 'HOLDING_UNKNOWN',
      reason: '보유를 읽지 못했습니다 — 보유가 없다는 뜻이 아닙니다',
    };
  }
  if (!i.holding || !(Number(i.holding.quantity) > 0)) {
    return { ready: false, block: 'NO_HOLDING', reason: '팔 수 있는 보유가 없습니다' };
  }
  if (sellAmountFailed(i.request)) {
    // ★ `AMBIGUOUS`는 화면에서 **"아직 안 골랐다"는 뜻이다.**
    //
    //   서버의 `sellAmountOf`는 "둘 다" 와 "둘 다 아님"을 같은 코드로 본다
    //   (`hasPct === hasQty`). API 입장에서는 맞는 묶음이다 — 어느 쪽이든
    //   무엇을 팔지 알 수 없다.
    //
    //   그런데 `sellRequestOf`는 고른 칸 하나만 싣는다. 그래서 화면에서
    //   "둘 다"는 만들어질 수 없고, 남는 것은 "아직 안 골랐다"뿐이다.
    //   그대로 서버 문구를 보여 주면 아무것도 안 고른 초보자에게
    //   "하나만 보내세요"라고 말하게 된다 — 실기에서 그렇게 떴다.
    const reason = i.request.code === 'AMBIGUOUS'
      ? '얼마나 팔지 정하세요 (비율 또는 수량)'
      : i.request.reason;
    return { ready: false, block: 'NO_AMOUNT', reason };
  }
  // 수량으로 파는 경우에만 미리 막을 수 있다. 비율은 언제나 보유 이하다.
  const q = i.request.quantity;
  if (q != null && q > Number(i.holding.quantity)) {
    return {
      ready: false, block: 'OVERSELL',
      reason: '보유한 수량보다 많이 팔 수 없습니다',
    };
  }
  return { ready: true, block: 'NONE', reason: null };
}

export function sellSubmitLabel(gate: SellGate, symbol: string): string {
  if (gate.ready) return `${symbol} 매도`;
  if (gate.block === 'NO_AMOUNT') return '얼마나 팔지 정하세요';
  if (gate.block === 'NO_HOLDING') return '보유 없음';
  if (gate.block === 'HOLDING_UNKNOWN') return '보유 확인 불가';
  if (gate.block === 'OVERSELL') return '보유보다 많습니다';
  return '매도할 수 없습니다';
}

/**
 * 비율을 눌렀을 때 **대략 몇 개인가** — 화면에 보여 주기 위한 값이다.
 *
 * ★ 이 값은 요청에 실리지 않는다. 비율로 파는 요청은 `percent`만 싣고,
 *   실제로 몇 개가 팔렸는지는 응답의 `soldQuantity`가 말한다. 서버는
 *   `paper_floor_at(보유 × 비율 / 100, 18)`로 자르고, 그 자리는 JS double이
 *   따라갈 수 없다. 그래서 **예상**이라고 부르고 장부로 쓰지 않는다.
 */
export function approxSellQuantity(
  holding: SellHolding | null, percent: number | null,
): number | null {
  if (!holding) return null;
  const held = Number(holding.quantity);
  const p = Number(percent);
  if (!Number.isFinite(held) || held <= 0) return null;
  if (!Number.isFinite(p) || p <= 0 || p > 100) return null;
  // 전량은 나눗셈을 하지 않는다 — 서버도 그렇게 한다(088).
  if (p === 100) return held;
  return (held * p) / 100;
}

/**
 * 매도 식별자. **재시도 때 그대로 보내야 한다** — 같은 id + 같은 내용이면
 * 088이 `REPLAYED`로 답하고 다시 팔지 않는다. 시도마다 새로 만들면 그
 * 보호가 없어진다.
 *
 * 계좌 id를 넣지 않는다. 유니크는 `(paper_account_id, client_sell_id)`이고
 * **계좌는 서버가 정한다** — 여기서 계좌를 아는 척하면 그 통로가 생긴다.
 */
export function newClientSellId(now: number, rand: number): string {
  const t = Math.floor(Number(now));
  const r = Math.floor(Math.abs(Number(rand)) * 1e9);
  if (!Number.isFinite(t) || !Number.isFinite(r)) return '';
  return `sell-${t.toString(36)}-${r.toString(36)}`;
}

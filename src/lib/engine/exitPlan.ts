// src/lib/engine/exitPlan.ts
//
// asymmetricExit(캔들 시뮬레이터)와 실제 거래소 주문 사이의 다리.
//
// asymmetricExit.processBar는 봉을 하나씩 받아 청산 이벤트를 만든다.
// 백테스트에는 맞지만 실주문에는 그대로 쓸 수 없다. 진입 시점에 무엇을
// 거래소에 걸어둘지, 무엇을 감시 루프에 맡길지 나눠야 한다.
//
//   진입 즉시 거래소에 건다 (사람이 없어도 동작)
//     - 고정 손절: STOP_MARKET, 전량 (closePosition)
//     - 분할 익절 사다리: TAKE_PROFIT_MARKET, 부분 수량 (reduceOnly)
//
//   감시 루프가 필요하다 (워커/스케줄러)
//     - 트레일링: 최고점 추적이 필요하므로 단일 주문으로 표현할 수 없다
//     - 본전 이동: 조건 충족 시 기존 손절을 취소하고 다시 걸어야 한다
//     - 시간 청산: 경과 시간 판단이 필요하다
//
// 이 모듈은 앞의 두 개를 주문 목록으로 만들고, 뒤의 셋은 파라미터로 넘겨
// 워커가 이어받을 수 있게 한다. 지금 워커가 없더라도 손절과 분할 익절은
// 거래소에 걸리므로, 서버가 죽어도 손실은 고정된다.
import { rToPrice, type AsymmetricConfig } from './asymmetricExit';

export interface ExitOrder {
  kind: 'STOP' | 'PARTIAL_TP';
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  price: number;
  /** undefined면 전량 청산(closePosition) */
  quantity?: number;
  atR?: number;
  label: string;
}

export interface ExitPlan {
  config: AsymmetricConfig;
  /** 진입 직후 거래소에 걸 주문들 */
  orders: ExitOrder[];
  /** 사다리로 확보하지 않고 트레일링에 남겨두는 수량 */
  trailingQty: number;
  /** 워커가 이어받을 파라미터 */
  trailStartR: number;
  trailDistanceR: number;
  breakEvenAtR?: number;
  maxHoldBars?: number;
  notes: string[];
}

/** 거래소 수량 단위에 맞춰 내림. stepSize가 없으면 그대로 둔다. */
function floorToStep(qty: number, step?: number): number {
  if (!step || step <= 0) return qty;
  const precision = Math.max(0, Math.round(-Math.log10(step)));
  return Number((Math.floor(qty / step) * step).toFixed(precision));
}

export const DEFAULT_PARTIAL_LADDER = [
  { atR: 1.5, closePct: 30 },
  { atR: 3.0, closePct: 30 },
];

export function buildExitPlan(args: {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopPrice: number;
  quantity: number;
  liquidationPrice?: number;
  partialLadder?: { atR: number; closePct: number }[];
  trailStartR?: number;
  trailDistanceR?: number;
  breakEvenAtR?: number;
  maxHoldBars?: number;
  /** 거래소 수량 단위. 맞추지 않으면 분할 주문이 거부된다. */
  qtyStep?: number;
  /** 거래소 최소 주문 수량. 이보다 작은 분할은 걸지 않는다. */
  minQty?: number;
}): ExitPlan {
  const ladder = args.partialLadder ?? DEFAULT_PARTIAL_LADDER;
  const notes: string[] = [];

  const cfg: AsymmetricConfig = {
    side: args.side,
    entryPrice: args.entryPrice,
    stopPrice: args.stopPrice,
    liquidationPrice: args.liquidationPrice,
    quantity: args.quantity,
    partialLadder: ladder,
    trailStartR: args.trailStartR ?? 2,
    trailDistanceR: args.trailDistanceR ?? 1,
    breakEvenAtR: args.breakEvenAtR ?? 1,
    maxHoldBars: args.maxHoldBars,
  };

  const orders: ExitOrder[] = [];

  // ── 고정 손절 — 전량. 분할 익절이 일부 체결돼도 남은 수량 전부를 덮는다.
  //    closePosition을 쓰는 이유: 수량을 지정하면 분할 체결 후 잔량과
  //    어긋나 손절이 일부만 걸린 상태가 될 수 있다.
  orders.push({
    kind: 'STOP',
    type: 'STOP_MARKET',
    price: args.stopPrice,
    label: '고정 손절 (-1R, 전량)',
  });

  // ── 분할 익절 사다리 ──
  let laddered = 0;
  for (const step of ladder) {
    const raw = args.quantity * (step.closePct / 100);
    const qty = floorToStep(raw, args.qtyStep);

    if (args.minQty != null && qty < args.minQty) {
      notes.push(`${step.atR}R 분할(${step.closePct}%) 생략 — 수량 ${qty}이 거래소 최소(${args.minQty}) 미만`);
      continue;
    }
    if (qty <= 0) {
      notes.push(`${step.atR}R 분할(${step.closePct}%) 생략 — 수량 단위에 맞추면 0이 됩니다`);
      continue;
    }
    if (laddered + qty >= args.quantity) {
      notes.push(`${step.atR}R 분할 생략 — 누적 수량이 전체를 넘습니다`);
      continue;
    }

    orders.push({
      kind: 'PARTIAL_TP',
      type: 'TAKE_PROFIT_MARKET',
      price: rToPrice(cfg, step.atR),
      quantity: qty,
      atR: step.atR,
      label: `${step.atR}R 분할 익절 ${step.closePct}%`,
    });
    laddered += qty;
  }

  const trailingQty = Math.max(0, args.quantity - laddered);
  if (trailingQty > 0) {
    notes.push(
      `잔량 ${trailingQty}는 트레일링에 남깁니다 (${cfg.trailStartR}R 돌파 시 시작, ${cfg.trailDistanceR}R 후행). ` +
      `트레일링·본전이동·시간청산은 거래소 주문으로 표현할 수 없어 감시 루프가 처리해야 합니다.`
    );
  }

  return {
    config: cfg,
    orders,
    trailingQty,
    trailStartR: cfg.trailStartR!,
    trailDistanceR: cfg.trailDistanceR!,
    breakEvenAtR: cfg.breakEvenAtR,
    maxHoldBars: cfg.maxHoldBars,
    notes,
  };
}

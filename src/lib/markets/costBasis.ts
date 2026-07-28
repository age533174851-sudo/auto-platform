// src/lib/markets/costBasis.ts
//
// 현물 평균 매수가와 실현손익.
//
// 왜 우리가 계산하나
// ──────────────────
// 거래소는 현물 평균 매수가를 주지 않는다. 체결 내역에서 직접 구해야 한다.
// 화면마다 각자 계산하면 화면마다 다른 수익률이 나오므로 한 곳에서 낸다.
//
// 계산 방식: 이동평균 원가
// ────────────────────────
// 매수하면 원가에 섞고, 매도하면 수량만 줄이고 단가는 유지한다.
// 그 순간 실현손익이 확정된다. 선입선출(FIFO)이 아니라 이동평균인 이유는
// 거래소·세무 실무에서 흔히 쓰는 방식이고, 부분 매도가 잦은 현물에서
// 단가가 튀지 않기 때문이다.
//
// 수수료
// ──────
// 매수 수수료를 코인으로 냈으면 **받은 수량이 그만큼 줄어든다.**
// 이걸 무시하면 보유 수량이 실제보다 많게 잡히고, 그 수량으로 매도를
// 걸면 거부된다. 매도 수수료는 보통 견적통화라 실현손익에서 뺀다.

export interface SpotTrade {
  isBuyer: boolean;
  qty: number;
  price: number;
  commission: number;
  commissionAsset: string;
  /** 이 종목의 기초자산 (BTCUSDT면 BTC) */
  baseAsset: string;
}

export interface SpotCostBasis {
  /** 현재 보유 수량 (체결 내역 기준) */
  qty: number;
  /** 평균 매수 단가. 보유가 0이면 null — 0이 아니다 */
  avgPrice: number | null;
  /** 지금까지 확정된 실현 손익 (수수료 반영) */
  realizedPnl: number;
  /** 지불한 수수료 합 */
  feePaid: number;
}

/**
 * 체결 내역에서 평균 매수가와 실현손익을 구한다.
 * **시간 오름차순 입력을 가정한다** — 순서가 뒤집히면 원가가 틀린다.
 */
export function computeCostBasis(trades: SpotTrade[]): SpotCostBasis {
  let qty = 0, cost = 0, realized = 0, fee = 0;

  for (const t of trades) {
    if (!Number.isFinite(t.qty) || !Number.isFinite(t.price)) continue;
    if (t.qty <= 0) continue;
    const c = Number.isFinite(t.commission) ? t.commission : 0;
    fee += c;

    if (t.isBuyer) {
      // 수수료를 코인으로 냈으면 그만큼 덜 받은 것이다
      const received = t.commissionAsset === t.baseAsset ? t.qty - c : t.qty;
      cost += t.qty * t.price;
      qty += received;
    } else {
      const avg = qty > 0 ? cost / qty : 0;
      // 보유보다 많이 팔린 기록이 있어도(이체 등) 원가는 보유분까지만 인식한다
      const sold = Math.min(t.qty, qty);
      realized += sold * (t.price - avg);
      // 매도 수수료는 보통 견적통화(USDT)로 낸다
      if (t.commissionAsset !== t.baseAsset) realized -= c;
      cost -= sold * avg;
      qty -= sold;
      // 부동소수점 찌꺼기가 남으면 "0.0000000001개 보유"가 된다
      if (qty < 1e-12) { qty = 0; cost = 0; }
    }
  }

  return {
    qty,
    // 보유가 없으면 평균가는 존재하지 않는다. 0으로 두면 "0원에 샀다"가 된다.
    avgPrice: qty > 0 ? cost / qty : null,
    realizedPnl: realized,
    feePaid: fee,
  };
}

/** 평가 손익 — 평균가나 현재가를 모르면 계산하지 않는다 */
export function unrealizedPnl(
  basis: SpotCostBasis, markPrice: number | null,
): { pnl: number; pct: number } | null {
  if (basis.avgPrice == null || markPrice == null) return null;
  if (!Number.isFinite(markPrice) || basis.avgPrice <= 0) return null;
  return {
    pnl: (markPrice - basis.avgPrice) * basis.qty,
    pct: ((markPrice - basis.avgPrice) / basis.avgPrice) * 100,
  };
}

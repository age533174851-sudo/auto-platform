// src/lib/markets/wallets.ts
//
// 통합 자산 — **합쳐서 보여주되 절대 섞지 않는다.**
//
//   통합 자산
//   ├─ 현물 지갑
//   │  ├─ USDT
//   │  ├─ BTC
//   │  └─ ETH
//   └─ 선물 지갑
//      ├─ 사용 가능 증거금
//      ├─ 포지션 증거금
//      └─ 미실현손익
//
// 왜 이 파일이 필요한가
// ─────────────────────
// 현물 USDT 1,000이 있고 선물 지갑이 비어 있으면, 총자산은 1,000이지만
// **선물에서 쓸 수 있는 증거금은 0이다.** 이 둘을 한 숫자로 합치는 순간
// "1,000까지 포지션을 잡을 수 있다"고 계산하게 되고, 실제로 주문을 내면
// 거부되거나 — 더 나쁘게 — 사용자가 그 크기를 믿고 전략을 짠다.
//
// 거래소에서 현물↔선물은 **이체(transfer)**를 해야 넘어간다. 화면이
// 그 사실을 지우면 안 된다.
//
// 모르는 것은 0이 아니다
// ──────────────────────
// 한쪽 지갑 조회에 실패했을 때 그쪽을 0으로 두고 합계를 내면, 총자산이
// 줄어든 것처럼 보인다. 사용자는 손실이 났다고 오해한다.
// 그래서 조회 실패는 null이고, null이 하나라도 있으면 합계도 null이다.

export interface SpotAsset {
  asset: string;
  free: number;
  locked: number;
  /** USD 환산액. 가격을 모르면 null — 0이 아니다 */
  valueUsd: number | null;
}

export interface SpotWallet {
  /** 조회에 성공했는가. false면 아래 값들은 의미 없다 */
  ok: boolean;
  assets: SpotAsset[];
  /** 현물에서 바로 쓸 수 있는 USDT */
  usdt: number;
  error?: string;
}

export interface FuturesWallet {
  ok: boolean;
  /** 지갑 잔고 (미실현손익 제외) */
  walletBalance: number;
  /** 신규 주문에 쓸 수 있는 증거금 */
  availableMargin: number;
  /** 열린 포지션이 잡고 있는 증거금 */
  positionMargin: number;
  /** 미실현 손익 */
  unrealizedPnl: number;
  error?: string;
}

export interface WalletTree {
  spot: SpotWallet;
  futures: FuturesWallet;
  /** 현물 총 평가액(USD). 값을 못 매긴 자산이 있으면 그만큼 빠진다 */
  spotValueUsd: number | null;
  /** 현물에서 USD 값을 못 매긴 자산 이름들 — 화면에 그대로 알려야 한다 */
  spotUnpriced: string[];
  /** 선물 순자산 = 지갑잔고 + 미실현손익 */
  futuresEquity: number | null;
  /** 총자산. 한쪽이라도 모르면 null */
  totalUsd: number | null;
  /**
   * 선물에서 지금 당장 쓸 수 있는 증거금.
   * **현물 잔고는 절대 포함되지 않는다.**
   */
  futuresUsableMargin: number | null;
  /** 현물에 있지만 선물에서 쓰려면 이체가 필요한 금액 */
  needsTransferUsd: number;
}

/**
 * 두 지갑을 하나의 트리로. 합치되 섞지 않는다.
 */
export function buildWalletTree(spot: SpotWallet, futures: FuturesWallet): WalletTree {
  // ── 현물 평가액 ──
  // 가격을 못 매긴 자산은 합계에서 빼되, 이름을 남긴다. 조용히 빼면
  // 총자산이 실제보다 적게 보이고 그 이유를 알 수 없다.
  let spotValueUsd: number | null = null;
  const unpriced: string[] = [];
  if (spot.ok) {
    let sum = 0;
    for (const a of spot.assets) {
      if (a.valueUsd == null) { unpriced.push(a.asset); continue; }
      sum += a.valueUsd;
    }
    spotValueUsd = sum;
  }

  const futuresEquity = futures.ok ? futures.walletBalance + futures.unrealizedPnl : null;

  // 한쪽이라도 모르면 합계를 내지 않는다. 반쪽 합계는 틀린 합계다.
  const totalUsd = spotValueUsd != null && futuresEquity != null
    ? spotValueUsd + futuresEquity
    : null;

  return {
    spot, futures,
    spotValueUsd,
    spotUnpriced: unpriced,
    futuresEquity,
    totalUsd,
    // 현물 USDT를 여기 더하지 않는다. 이 한 줄이 이 파일의 존재 이유다.
    futuresUsableMargin: futures.ok ? futures.availableMargin : null,
    needsTransferUsd: spot.ok ? spot.usdt : 0,
  };
}

/**
 * 이 금액으로 선물 주문을 낼 수 있는가.
 *
 * 현물에 돈이 아무리 많아도 선물 증거금이 부족하면 못 낸다.
 * 그 사실을 계산이 아니라 문장으로 돌려준다 — 숫자만 주면 호출자가
 * 또 자기 방식으로 합친다.
 */
export interface MarginCheck {
  ok: boolean;
  reason?: string;
  /** 부족분. 이체하면 되는 금액 */
  shortfallUsd?: number;
}

export function canOpenFutures(tree: WalletTree, requiredMarginUsd: number): MarginCheck {
  // 모양이 다른 응답이 와도 **화면이 죽지 않게** 한다.
  //
  // 예전에는 `tree.futures.ok`를 바로 읽었다. `/api/wallets`가 예전 모양을
  // 돌려주거나(배포 중 버전이 섞일 때) 오류 객체를 주면 여기서 TypeError가
  // 나고, 이 함수는 주문판 렌더 중에 불리므로 **터미널 전체가 흰 화면**이
  // 된다. 증거금을 모르는 것과 화면이 사라지는 것은 전혀 다른 문제다.
  if (!tree || typeof tree !== 'object' || !(tree as any).futures) {
    return { ok: false, reason: '지갑 정보를 읽지 못해 주문 가능 여부를 알 수 없습니다' };
  }
  if (tree.futures.ok !== true) {
    return { ok: false, reason: '선물 지갑을 확인하지 못해 주문 가능 여부를 알 수 없습니다' };
  }
  if (!Number.isFinite(requiredMarginUsd) || requiredMarginUsd <= 0) {
    return { ok: false, reason: '필요 증거금이 유효하지 않습니다' };
  }

  const avail = tree.futures.availableMargin;
  if (requiredMarginUsd <= avail) return { ok: true };

  const shortfall = requiredMarginUsd - avail;
  const inSpot = tree.spot?.ok ? tree.spot.usdt : 0;

  // 현물에 돈이 있다는 사실은 알려주되, 그것이 증거금이 아니라는 것도 같이 말한다.
  const hint = inSpot >= shortfall
    ? ` 현물 지갑에 ${inSpot.toFixed(2)} USDT가 있습니다 — 선물로 이체해야 사용됩니다.`
    : '';

  return {
    ok: false,
    shortfallUsd: shortfall,
    reason: `선물 증거금이 ${shortfall.toFixed(2)} USDT 부족합니다 ` +
            `(가용 ${avail.toFixed(2)} / 필요 ${requiredMarginUsd.toFixed(2)}).${hint}`,
  };
}

/**
 * 현물 자산을 큰 것부터. 0인 것은 이미 걸러진 상태를 가정한다.
 *
 * 비중은 **값을 매길 수 있는 자산 안에서만** 낸다. 못 매긴 자산을
 * 분모에서 빼지 않으면 비중 합이 100%를 넘거나 모자란다.
 */
export function spotAllocation(spot: SpotWallet): { asset: string; valueUsd: number; pct: number }[] {
  if (!spot.ok) return [];
  const priced = spot.assets.filter(a => a.valueUsd != null) as (SpotAsset & { valueUsd: number })[];
  const total = priced.reduce((s, a) => s + a.valueUsd, 0);
  if (total <= 0) return [];
  return priced
    .map(a => ({ asset: a.asset, valueUsd: a.valueUsd, pct: (a.valueUsd / total) * 100 }))
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

/** 조회 실패를 나타내는 값. 0으로 채운 지갑과 구분된다 */
export const SPOT_UNAVAILABLE: SpotWallet = { ok: false, assets: [], usdt: 0 };
export const FUTURES_UNAVAILABLE: FuturesWallet = {
  ok: false, walletBalance: 0, availableMargin: 0, positionMargin: 0, unrealizedPnl: 0,
};

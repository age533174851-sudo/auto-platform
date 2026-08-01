// src/lib/markets/spreadGuard.ts
//
// **이 매매가 비용을 이길 수 있는가.**
//
// 왜 필요한가
// ───────────
// 지금까지 이 앱이 다룬 것은 BTC·ETH 같은 두꺼운 시장이었다. 거기서는
// 스프레드가 0.01%라 없는 셈 쳐도 됐다.
//
// 토큰화 주식(xStocks 같은 것)은 다르다. 거래대금이 실제 종목의 수만
// 분의 1이라 호가가 **0.5~2%씩 벌어진다.** 단타 한 번의 목표가 1%인데
// 왕복 스프레드가 2%면, **이기는 매매를 해도 손실이다.**
//
// 그리고 이 비용은 어디에도 안 나타난다. 체결가에 녹아 있어서 "수수료
// 얼마" 같은 줄로도 안 잡힌다. 수익률이 이상하게 낮은데 이유를 못 찾는
// 상태가 된다 — 이 저장소가 계속 없애 온 그 모양이다.
//
// 그래서 주문 전에 **숫자로 계산해서 보여준다.** 못 이기는 매매면 그렇게
// 말한다. 막을지 말지는 그다음 문제다.
//
// 모르면 통과가 아니다
// ────────────────────
// 호가를 못 읽었으면 '스프레드 0'이 아니라 **확인 불가**다. 얇은 시장에서
// 스프레드를 모르는 채로 시장가 주문을 내는 것이 최악이라, 여기서는
// 모르면 막는 쪽이 맞다.

export interface Book {
  /** 최우선 매수호가 */
  bid: number | null | undefined;
  /** 최우선 매도호가 */
  ask: number | null | undefined;
}

export interface SpreadOptions {
  /** 이 이상 벌어지면 넓다고 본다 (%). 기본 0.3% */
  maxSpreadPct?: number;
  /** 한 번 체결당 수수료 (%). 기본 0.1% */
  feePct?: number;
  /**
   * 이 매매로 노리는 수익 (%). 손절 폭이나 익절 폭을 넣는다.
   *
   * 넣으면 **왕복 비용과 비교**해서 "구조적으로 못 이기는 매매"를
   * 짚어 준다. 이 비교가 이 파일의 존재 이유다.
   */
  targetPct?: number | null;
}

export type SpreadStatus = 'ok' | 'wide' | 'unwinnable' | 'unknown';

export interface SpreadVerdict {
  status: SpreadStatus;
  /** 호가 스프레드 (%). 못 읽었으면 null */
  spreadPct: number | null;
  /** 왕복 총비용 (%) = 스프레드 + 수수료 × 2. 못 읽었으면 null */
  roundTripPct: number | null;
  /** 이 주문을 내도 되는가 */
  canOrder: boolean;
  reason: string;
  /** 중간값 — 스프레드가 넓을 때 '현재가'로 쓸 수 있는 유일한 값 */
  mid: number | null;
}

const num = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const pct = (n: number) => `${n.toFixed(3)}%`;

/**
 * 호가를 보고 이 매매가 비용을 이길 수 있는지 판정한다.
 *
 * 순수 함수다 — 네트워크를 안 탄다.
 */
export function checkSpread(book: Book | null | undefined, opts: SpreadOptions = {}): SpreadVerdict {
  const maxSpread = Number.isFinite(opts.maxSpreadPct as any) ? Number(opts.maxSpreadPct) : 0.3;
  const fee = Number.isFinite(opts.feePct as any) ? Number(opts.feePct) : 0.1;

  const none = (reason: string): SpreadVerdict => ({
    status: 'unknown', spreadPct: null, roundTripPct: null,
    canOrder: false, reason, mid: null,
  });

  const bid = num(book?.bid);
  const ask = num(book?.ask);
  // **못 읽은 것을 0으로 치지 않는다.** 얇은 시장에서 스프레드를 모르는 채로
  // 시장가를 내는 것이 정확히 이 파일이 막으려는 것이다.
  if (bid == null || ask == null) {
    return none('호가를 읽지 못해 거래 비용을 계산하지 못했습니다 — 얇은 시장에서는 이대로 주문하지 않습니다');
  }
  if (ask < bid) {
    // 매도호가가 매수호가보다 낮다. 정상 시장에서는 있을 수 없다 —
    // 데이터가 뒤집혔거나 두 시점의 값을 섞은 것이다.
    return none(`호가가 뒤집혀 있습니다 (매수 ${bid} / 매도 ${ask}) — 데이터를 믿을 수 없습니다`);
  }

  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;
  const roundTripPct = spreadPct + fee * 2;

  const target = num(opts.targetPct);
  const costLine = `호가 차이 ${pct(spreadPct)} + 수수료 왕복 ${pct(fee * 2)} = 왕복 ${pct(roundTripPct)}`;

  // 목표 수익이 왕복 비용보다 작으면 **이겨도 손해다.** 승률이 아무리
  // 높아도 산수가 안 맞는다. 이건 넓다/좁다의 문제가 아니라 성립하지
  // 않는 매매다.
  if (target != null && target <= roundTripPct) {
    return {
      status: 'unwinnable', spreadPct, roundTripPct, mid, canOrder: false,
      reason: `목표 ${pct(target)}인데 ${costLine}. `
        + `맞춰도 ${pct(roundTripPct - target)} 손해입니다 — 이 매매는 이겨도 못 법니다`,
    };
  }

  if (spreadPct > maxSpread) {
    return {
      status: 'wide', spreadPct, roundTripPct, mid, canOrder: false,
      reason: `호가가 너무 벌어져 있습니다 — ${costLine} (기준 ${pct(maxSpread)})`,
    };
  }

  return {
    status: 'ok', spreadPct, roundTripPct, mid, canOrder: true,
    reason: target != null
      ? `${costLine} · 목표 ${pct(target)} 중 ${(roundTripPct / target * 100).toFixed(0)}%가 비용입니다`
      : costLine,
  };
}

/**
 * 목표 수익이 비용을 이기려면 최소 얼마여야 하는가.
 *
 * 화면에서 "이 종목은 최소 N% 노려야 합니다"로 쓴다. 못 이기는 매매를
 * 막기만 하고 얼마면 되는지 안 알려 주면, 사용자는 무엇을 고쳐야 할지
 * 모른 채로 화면만 본다.
 *
 * @param safety 비용 대비 배수. 기본 2 — 비용과 같은 수익은 본전이고,
 *               본전을 목표로 매매할 이유는 없다.
 */
export function minTargetPct(
  roundTripPct: number | null, safety = 2,
): number | null {
  if (roundTripPct == null || !Number.isFinite(roundTripPct)) return null;
  return roundTripPct * Math.max(1, safety);
}

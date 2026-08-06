// src/lib/engine/shortGuard.ts
//
// **숏은 롱의 부호 반전이 아니다.**
//
// 지금 무엇이 있었나
// ──────────────────
// `allowShort`는 켜고 끄는 스위치일 뿐이고, 진입 검사는 방향을 안 본다.
// 그래서 숏은 롱과 **똑같은 검사**를 통과해 나간다. 그런데 숏에는 롱에
// 없는 위험이 넷 있다:
//
//  1. **손실에 바닥이 없다.** 롱은 최악이 0원이지만 숏은 가격이 얼마든
//     올라갈 수 있다. 같은 1% 위험이라도 꼬리가 훨씬 두껍다.
//
//  2. **청산가가 위에 있고, 스퀴즈도 위로 간다.** 롱의 청산가는 아래에
//     있고 급락은 대개 빠르게 끝난다. 숏의 청산가는 위에 있고, 위로 가는
//     움직임은 손절이 몰려 있어 **연쇄로 가속된다.**
//
//  3. **들고 있으면 펀딩을 낼 수 있다.** 방향에 따라 받기도 하고 내기도
//     하는데, 롱만 보고 만든 코드는 그 부호를 안 본다.
//
//  4. **급락 뒤에 들어가면 반등에 맞는다.** 롱에도 대칭인 문제지만,
//     반등은 하락보다 빠르므로 숏 쪽이 더 자주 손절에 닿는다.
//
// 이 파일이 하는 일
// ─────────────────
// 숏 진입 앞에서만 도는 검사를 모은다. **막는 것과 알리는 것을 구분한다** —
// 청산가가 손절보다 가까운 것은 막아야 하고(그 손절은 장식이다), 펀딩이
// 불리한 것은 적어 두면 된다.
//
// 순수 함수다. 네트워크를 안 타고 주문을 내지 않는다.

export type ShortRiskCode =
  /** 청산이 손절보다 먼저 온다 — 그 손절은 장식이다 */
  | 'LIQ_BEFORE_STOP'
  /** 급락 직후 추격 */
  | 'CHASING_DROP'
  /** 바로 아래가 지지선 */
  | 'SUPPORT_BELOW'
  /** 숏이 몰려 있다 — 스퀴즈 위험 */
  | 'CROWDED_SHORT'
  /** 펀딩을 내는 쪽이다 */
  | 'FUNDING_COST'
  /** 상위 시간봉이 하락이 아니다 */
  | 'TREND_NOT_DOWN';

export interface ShortFinding {
  code: ShortRiskCode;
  /** true면 진입을 막는다. false면 적어 두기만 한다 */
  blocking: boolean;
  reason: string;
}

export interface ShortGuardInput {
  entryPrice: number;
  /** 숏의 손절가. 진입가 **위**에 있어야 한다 */
  stopPrice: number | null;
  /** 거래소가 준 청산가. 없으면 배율로 추정하지 않는다 — 모른다고 한다 */
  liquidationPrice?: number | null;
  /**
   * 최근 봉의 고가·저가. 급락 추격과 지지선 판단에 쓴다.
   * **모자라면 그 검사를 건너뛴다** — 없는 데이터로 판정하지 않는다.
   */
  recentHighs?: number[] | null;
  recentLows?: number[] | null;
  /** 변동성 기준. 없으면 급락 판정을 건너뛴다 */
  atr?: number | null;
  /**
   * 8시간 펀딩률(%). 양수면 롱이 내고 숏이 받는다.
   * **음수면 숏이 낸다** — 그때만 비용이다.
   */
  fundingRatePct8h?: number | null;
  /** 상위 시간봉 추세. 모르면 null */
  higherTrend?: 'UP' | 'DOWN' | 'RANGE' | null;
}

export interface ShortGuardResult {
  allowed: boolean;
  findings: ShortFinding[];
  /** 화면에 그대로 띄울 한 줄 */
  summary: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 숏 진입 앞 검사.
 *
 * **막는 것은 셋뿐이다** — 청산이 손절보다 먼저 오는 것, 상위 추세가
 * 반대인 것, 데이터가 아예 없는 것. 나머지는 적어 둔다.
 *
 * 다 막으면 아무도 이 화면을 안 쓰게 되고, 그러면 안전장치를 통째로 끈다.
 */
export function shortGuard(input: ShortGuardInput): ShortGuardResult {
  const findings: ShortFinding[] = [];
  const entry = num(input.entryPrice);
  const stop = num(input.stopPrice);

  if (entry == null || entry <= 0) {
    return {
      allowed: false, findings: [{ code: 'LIQ_BEFORE_STOP', blocking: true,
        reason: '진입가를 모르면 숏 위험을 계산할 수 없습니다' }],
      summary: '진입가 없음',
    };
  }

  // ── 1) 청산이 손절보다 먼저 오는가 ──
  //
  // 숏은 **둘 다 진입가 위에** 있다. 청산가가 손절보다 가까우면
  // 손절이 발동하기 전에 청산당한다 — 그 손절은 걸려 있을 뿐 아무것도
  // 지키지 않는다. 사용자는 "손절 1%"라고 믿고 있는데 실제로는
  // 계좌가 통째로 날아간다.
  //
  // 롱에도 같은 문제가 있지만 방향이 반대다(둘 다 아래). 여기서는
  // 숏만 본다 — 롱 쪽은 tpslPlan.checkStopLoss가 이미 본다.
  const liq = num(input.liquidationPrice);
  if (stop != null && stop > 0) {
    if (stop <= entry) {
      findings.push({
        code: 'LIQ_BEFORE_STOP', blocking: true,
        reason: `숏 손절 ${stop}이 진입가 ${entry} 아래입니다 — 숏의 손절은 위에 있어야 합니다`,
      });
    } else if (liq != null && liq > 0) {
      if (liq <= stop) {
        findings.push({
          code: 'LIQ_BEFORE_STOP', blocking: true,
          reason: `청산가 ${liq}가 손절 ${stop}보다 가깝습니다 — 손절이 발동하기 전에 청산됩니다. `
                + '배율을 낮추거나 손절을 좁히세요',
        });
      } else {
        // 여유가 얼마 없는 것도 위험하다. 손절 폭의 20% 미만이면
        // 슬리피지 한 번으로 순서가 뒤집힌다.
        const gap = liq - stop;
        const stopDist = stop - entry;
        if (stopDist > 0 && gap / stopDist < 0.2) {
          findings.push({
            code: 'LIQ_BEFORE_STOP', blocking: true,
            reason: `청산가와 손절 사이가 손절 폭의 ${(gap / stopDist * 100).toFixed(0)}%뿐입니다 — `
                  + '슬리피지 한 번이면 청산이 먼저 옵니다',
          });
        }
      }
    }
  }

  // ── 2) 급락 직후 추격인가 ──
  //
  // 반등은 하락보다 빠르다. 이미 크게 빠진 자리에서 숏을 잡으면
  // 되돌림 한 번에 손절에 닿는다.
  const atr = num(input.atr);
  const lows = Array.isArray(input.recentLows) ? input.recentLows.filter(v => num(v) != null).map(Number) : [];
  const highs = Array.isArray(input.recentHighs) ? input.recentHighs.filter(v => num(v) != null).map(Number) : [];

  if (atr != null && atr > 0 && highs.length >= 3) {
    const recentHigh = Math.max(...highs);
    const dropped = recentHigh - entry;
    // 최근 고점에서 3 ATR 넘게 빠진 자리
    if (dropped > atr * 3) {
      findings.push({
        code: 'CHASING_DROP', blocking: false,
        reason: `최근 고점 ${recentHigh}에서 ${(dropped / atr).toFixed(1)} ATR 빠진 자리입니다 — `
              + '반등은 하락보다 빠릅니다',
      });
    }
  }

  // ── 3) 바로 아래가 지지선인가 ──
  //
  // 지지선 바로 위에서 숏을 잡으면 목표까지 갈 자리가 없다.
  // 손절은 위에 있고 목표는 코앞이라 손익비가 무너진다.
  if (lows.length >= 3 && stop != null && stop > entry) {
    const support = Math.min(...lows);
    const room = entry - support;
    const risk = stop - entry;
    if (room > 0 && risk > 0 && room / risk < 1) {
      findings.push({
        code: 'SUPPORT_BELOW', blocking: false,
        reason: `아래 지지선 ${support}까지 ${room.toFixed(2)}인데 손절 폭은 ${risk.toFixed(2)}입니다 — `
              + '손익비가 1보다 작습니다',
      });
    }
  }

  // ── 4) 펀딩 ──
  //
  // 양수 펀딩은 롱이 내고 숏이 **받는다.** 음수일 때만 숏이 낸다.
  // 여기서 부호를 뒤집으면 유리한 자리를 위험하다고 적게 된다.
  const fr = num(input.fundingRatePct8h);
  if (fr != null && fr < 0) {
    findings.push({
      code: 'FUNDING_COST', blocking: false,
      reason: `펀딩률 ${fr}%로 숏이 내는 쪽입니다 — 오래 들고 있으면 비용이 쌓입니다`,
    });
    // 크게 음수면 숏이 몰려 있다는 뜻이기도 하다. 몰린 쪽이 스퀴즈로
    // 터진다 — 펀딩 비용보다 이쪽이 더 위험하다.
    if (fr <= -0.05) {
      findings.push({
        code: 'CROWDED_SHORT', blocking: false,
        reason: `펀딩률 ${fr}%는 숏이 몰려 있다는 뜻입니다 — 위로 가면 손절이 연쇄로 터집니다`,
      });
    }
  }

  // ── 5) 상위 시간봉 ──
  //
  // 상승 추세에서 숏을 잡는 것은 흐름을 거스르는 것이다. **막는다** —
  // 이건 신호의 질 문제가 아니라 방향 자체가 반대인 자리다.
  if (input.higherTrend === 'UP') {
    findings.push({
      code: 'TREND_NOT_DOWN', blocking: true,
      reason: '상위 시간봉이 상승 추세입니다 — 흐름을 거슬러 숏을 잡지 않습니다',
    });
  }

  const blockers = findings.filter(f => f.blocking);
  return {
    allowed: blockers.length === 0,
    findings,
    summary: blockers.length > 0
      ? blockers[0].reason
      : findings.length > 0
        ? `주의 ${findings.length}건 — ${findings[0].reason}`
        : '숏 진입 검사 통과',
  };
}

/**
 * 숏의 손절·익절 가격이 방향에 맞는가.
 *
 * **롱과 부호가 반대다.** 이걸 뒤집으면 손절이 익절 자리에 걸리고,
 * 화면에는 둘 다 '설정됨'으로 뜬다.
 *
 *   숏 손절 = 진입가 **위**  (올라가면 손실)
 *   숏 익절 = 진입가 **아래** (내려가면 이익)
 */
export function shortExitPrices(
  entry: number, stopPct: number, takePct?: number | null,
): { stop: number | null; take: number | null; reason: string } {
  const e = num(entry);
  const s = num(stopPct);
  if (e == null || e <= 0) return { stop: null, take: null, reason: '진입가가 없습니다' };
  if (s == null || s <= 0) return { stop: null, take: null, reason: '손절 폭이 없습니다' };

  const t = num(takePct);
  return {
    // 숏은 위로 가면 손실 → 손절은 위
    stop: e * (1 + s / 100),
    // 숏은 아래로 가면 이익 → 익절은 아래
    take: t != null && t > 0 ? e * (1 - t / 100) : null,
    reason: '',
  };
}

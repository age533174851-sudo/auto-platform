// src/lib/engine/leverageLadder.ts
//
// **배율이 하나의 값처럼 다뤄지고 있었다.**
//
// 화면에는 '배율 100배'라고 한 줄만 뜬다. 그런데 실제로는 서로 다른
// 다섯 개가 같은 이름을 쓰고 있었고, 그래서 이런 화면이 나왔다:
//
//   배율 상한        100x
//   1회 위험          10%
//   손절 거리        1.00%
//   100배 청산거리   0.60%   ← 손절보다 청산이 먼저다
//   화면 자체 계산   "이 손절이면 71배까지가 안전"
//   그런데 설정은     여전히 100배 허용
//
// 화면이 스스로 71배가 한계라고 계산해 놓고 100배를 그대로 허용했다.
// **설명만 하고 막지 않으면 그건 경고가 아니라 장식이다.**
//
// 그리고 더 나쁜 것
// ─────────────────
// 체크리스트에는 이렇게 떠 있었다:
//
//   거래소 실제  5배
//   TRAIGO 의도  49배
//
// 화면에서 20배를 눌렀는데 청산거리가 19.5%로 남아 있던 것도 같은
// 이유다 — 19.5%는 5배에서 나오는 값이다. **버튼 숫자만 바뀌고 거래소
// 포지션은 5배 그대로였다.** 사용자는 5배짜리 위험 구조를 보면서
// 20배라고 생각하게 된다.
//
// 그래서 이름을 나눈다
// ────────────────────
//   userCap             사용자가 정한 절대 상한 (목표가 아니다)
//   strategyCap         이 전략의 상한
//   venueCap            거래소가 허용하는 최대
//   liquidationSafeCap  이 손절에서 청산당하지 않는 최대 ← 계산값
//   riskEngineLeverage  위험엔진이 산출한 이번 주문 배율
//   venueActual         거래소에 **실제로 걸려 있는** 배율
//
// 최종 주문 배율은 앞의 다섯 중 **가장 작은 것**이고, venueActual과
// 정확히 같을 때만 주문이 나간다.

import { maxLeverageBeforeLiquidation, DEFAULT_MMR_PCT } from './leverageMath';

/**
 * 이론상 최대 배율을 그대로 쓰지 않는다.
 *
 * 71배가 이론값이라면 실제로는 유지증거금률 변동, 수수료, 슬리피지,
 * 마크가격 튐이 전부 그 여유를 갉아먹는다. 이론값에 딱 붙여 놓으면
 * **정상적인 시장 소음에도 청산된다.**
 *
 * 20%를 빼면 71배 → 56배. 사용자가 말한 '55~60배'와 같은 자리다.
 */
export const DEFAULT_SAFETY_BUFFER_PCT = 20;

export interface LeverageSources {
  /** 사용자가 정한 절대 상한. **목표가 아니다** */
  userCap?: any;
  /** 이 전략의 상한 */
  strategyCap?: any;
  /** 거래소가 허용하는 최대 */
  venueCap?: any;
  /** 위험엔진이 산출한 이번 주문 배율 */
  riskEngineLeverage?: any;
  /**
   * **테스트넷 스트레스 실험인가.** 기본 false.
   *
   * 켜면 사다리가 "가장 낮은 값"을 고르지 않는다. 사용자가 100배를 명시했으면
   * 100배로 요청하고, 못 하겠으면 **막는다** — 조용히 57배로 낮추지 않는다.
   *
   * 왜 필요한가
   * ───────────
   * 스트레스 실험의 목적은 **망가지는 지점을 보는 것**이다. 100배를
   * 요청했는데 청산안전 상한이 57배라고 57배로 낮춰 주문하면, 그건
   * 실험이 아니라 다른 설정으로 매매한 것이다. 화면에는 '이번 주문 57배'가
   * 뜨는데 사용자가 보려던 100배의 거동은 어디에도 안 남는다.
   *
   * 무엇이 달라지고 무엇이 안 달라지나
   * ──────────────────────────────────
   *  · 청산안전 상한 → **경고**로 바뀐다. 여전히 계산하고 여전히 보여 주되
   *    배율을 깎지 않는다. 못 구하면 그때는 막는다.
   *  · 거래소·전략 상한 → **깎지 않고 막는다.** 100배를 요청했는데 거래소가
   *    75배까지면 75배로 내려 보내지 않는다. 그건 다른 실험이다.
   *  · 거래소 상한을 **못 읽으면 막는다.** 스트레스에서는 특히, 무엇이
   *    한계인지 모르는 채로 최대 배율을 보낼 수 없다.
   *  · LIVE에서는 절대 켜지 않는다. 등급 관문(tierAllowedIn)이 이미 막지만,
   *    여기서도 부르는 쪽이 실수로 켜지 못하게 환경을 같이 받는다.
   */
  stressTestnet?: boolean;
  /** 손절 거리(%) — 청산안전 상한을 여기서 역산한다 */
  stopPct?: any;
  /** 유지증거금률(%) */
  mmrPct?: any;
  /** 안전 버퍼(%) */
  safetyBufferPct?: any;
}

export interface LadderRow {
  id: string;
  label: string;
  /** 배율. 모르면 null */
  value: number | null;
  known: boolean;
  /**
   * 이 값이 없으면 주문을 막아야 하는가.
   *
   * **'없음'과 '모름'을 가른다.** 전략 상한이 없는 것은 정말로 제한이
   * 없는 것이지만, 청산안전 상한을 못 구한 것은 위험을 확인하지 못한
   * 것이다. 앞은 통과, 뒤는 차단이다.
   */
  required: boolean;
  note: string;
}

export interface LadderResult {
  rows: LadderRow[];
  /** 이 손절에서 청산당하지 않는 최대 (버퍼 적용 후) */
  liquidationSafeCap: number | null;
  /** 버퍼 적용 전 이론값 — 화면에 같이 적어야 왜 낮아졌는지 안다 */
  liquidationTheoreticalCap: number | null;
  /** 최종 허용 배율. 막혔으면 null */
  allowed: number | null;
  /** 무엇이 이 값을 정했는가 */
  boundBy: string | null;
  blocked: boolean;
  blockReason: string;
  /** 사람이 읽는 한 줄 */
  summary: string;
  /**
   * 사용자가 **요청한** 배율. 실제 주문 배율(allowed)과 **다른 값이다.**
   *
   * 화면이 이 둘을 같은 칸에 쓰면 "100배로 켰는데 왜 57배로 나갔나"가
   * 설명되지 않는다. 요청·권고·실제를 각각 보여 줘야 한다.
   */
  requested: number | null;
  /** 스트레스 실험이라 깎지 않고 넘어간 상한들. 사람이 읽는 문장 */
  warnings: string[];
  /** 막았으면 그 이유의 기계 코드 */
  blockCode: 'VENUE_CAPPED' | 'VENUE_UNKNOWN' | 'CAP_BELOW_REQUEST' | 'MISSING_REQUIRED' | 'NO_CAPS' | 'SUB_ONE' | null;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 배율 사다리.
 *
 * **모르는 상한을 무한대로 치지 않는다.** 거래소 상한을 못 읽었다고
 * 100배를 허용하면, 확인하지 못한 것을 통과로 세는 것이다.
 */
export function leverageLadder(src: LeverageSources | null | undefined): LadderResult {
  const s = src ?? {};
  const stopPct = num(s.stopPct);
  const mmr = s.mmrPct == null ? DEFAULT_MMR_PCT : Number(s.mmrPct);
  const bufferPct = s.safetyBufferPct == null
    ? DEFAULT_SAFETY_BUFFER_PCT : Number(s.safetyBufferPct);

  const theoretical = stopPct != null && Number.isFinite(mmr) && mmr >= 0
    ? maxLeverageBeforeLiquidation(stopPct, mmr) : null;
  const buffered = theoretical != null && Number.isFinite(bufferPct)
    ? Math.floor(theoretical * (1 - Math.max(0, Math.min(95, bufferPct)) / 100))
    : null;
  const liqSafe = buffered != null && buffered >= 1 ? buffered : null;

  const rows: LadderRow[] = [
    {
      id: 'user', label: '사용자 최대', value: num(s.userCap),
      known: num(s.userCap) != null, required: false,
      note: '사용자가 정한 절대 상한 — 목표 배율이 아닙니다',
    },
    {
      id: 'strategy', label: '전략 최대', value: num(s.strategyCap),
      known: num(s.strategyCap) != null, required: false,
      note: '이 전략의 상한',
    },
    {
      id: 'venue', label: '거래소 최대', value: num(s.venueCap),
      known: num(s.venueCap) != null, required: false,
      note: '거래소가 이 심볼에서 허용하는 최대',
    },
    {
      id: 'liquidation', label: '청산안전 최대', value: liqSafe,
      known: liqSafe != null, required: true,
      note: theoretical != null
        ? `손절 ${stopPct}%·유지증거금 ${mmr}% 기준 이론 ${Math.floor(theoretical)}배`
          + ` · 안전 버퍼 ${bufferPct}% 적용`
        : '손절 거리를 몰라 계산하지 못했습니다',
    },
    {
      id: 'risk', label: '위험엔진 허용', value: num(s.riskEngineLeverage),
      known: num(s.riskEngineLeverage) != null, required: false,
      note: '1회 위험과 손절 거리에서 역산한 이번 주문 배율',
    },
  ];

  const requested = num(s.userCap);
  const stress = s.stressTestnet === true;

  // **필수 항목을 못 구했으면 막는다.** 확인하지 못한 것은 통과가 아니다.
  // 스트레스라고 이걸 열지 않는다 — 청산까지 얼마나 남았는지는 실험에서도
  // 알아야 하는 값이다. 다만 아래에서 그 값으로 **깎지는** 않는다.
  const missingRequired = rows.filter(r => r.required && !r.known);
  if (missingRequired.length > 0) {
    return {
      rows, liquidationSafeCap: liqSafe, liquidationTheoreticalCap: theoretical,
      allowed: null, boundBy: null, blocked: true, blockCode: 'MISSING_REQUIRED',
      requested, warnings: [],
      blockReason: `${missingRequired.map(r => r.label).join(' · ')}을 계산하지 못했습니다`
        + ' — 청산까지 얼마나 남았는지 모르는 채로 주문을 낼 수 없습니다',
      summary: '배율을 정할 수 없습니다',
    };
  }

  // ── 스트레스 실험: 깎지 않는다. 못 하면 막는다 ──
  if (stress) {
    if (requested == null) {
      return {
        rows, liquidationSafeCap: liqSafe, liquidationTheoreticalCap: theoretical,
        allowed: null, boundBy: null, blocked: true, blockCode: 'NO_CAPS',
        requested: null, warnings: [],
        blockReason: '요청 배율이 없습니다 — 스트레스 실험은 얼마를 시험할지 사용자가 정해야 합니다',
        summary: '배율을 정할 수 없습니다',
      };
    }

    // 거래소 상한을 **모르면 막는다.** 최대 배율을 시험하는 자리에서
    // 무엇이 한계인지 모르는 채로 보낼 수는 없다.
    const venue = num(s.venueCap);
    if (venue == null) {
      return {
        rows, liquidationSafeCap: liqSafe, liquidationTheoreticalCap: theoretical,
        allowed: null, boundBy: '거래소 최대', blocked: true, blockCode: 'VENUE_UNKNOWN',
        requested, warnings: [],
        blockReason: `거래소가 이 심볼에서 몇 배까지 허용하는지 읽지 못했습니다 — `
          + `${requested}배를 시험하려면 그 한계를 먼저 알아야 합니다`,
        summary: '배율을 정할 수 없습니다',
      };
    }
    if (venue < requested) {
      // **75배로 낮춰 보내지 않는다.** 그건 사용자가 요청한 실험이 아니다.
      return {
        rows, liquidationSafeCap: liqSafe, liquidationTheoreticalCap: theoretical,
        allowed: null, boundBy: '거래소 최대', blocked: true, blockCode: 'VENUE_CAPPED',
        requested, warnings: [],
        blockReason: `요청 ${requested}배인데 거래소 최대는 ${venue}배입니다 — `
          + `${venue}배로 낮춰 보내지 않습니다. 요청한 실험과 다른 설정이 되기 때문입니다. `
          + `${venue}배로 시험하려면 요청 배율을 직접 바꾸세요`,
        summary: `${requested}배를 낼 수 없습니다`,
      };
    }

    // 전략 상한도 같은 규칙 — 조용히 낮추지 않는다.
    const strat = num(s.strategyCap);
    if (strat != null && strat < requested) {
      return {
        rows, liquidationSafeCap: liqSafe, liquidationTheoreticalCap: theoretical,
        allowed: null, boundBy: '전략 최대', blocked: true, blockCode: 'CAP_BELOW_REQUEST',
        requested, warnings: [],
        blockReason: `요청 ${requested}배인데 전략 상한은 ${strat}배입니다 — `
          + '낮춰 보내지 않습니다. 전략 상한을 올리거나 요청 배율을 내리세요',
        summary: `${requested}배를 낼 수 없습니다`,
      };
    }

    // 여기부터는 **경고만** 한다. 깎지 않는다.
    const warnings: string[] = [];
    if (liqSafe != null && liqSafe < requested) {
      warnings.push(
        `청산안전 권고는 ${liqSafe}배인데 ${requested}배로 시험합니다 — `
        + '손절이 닿기 전에 청산될 수 있습니다. 스트레스 실험이라 낮추지 않았습니다');
    }
    const risk = num(s.riskEngineLeverage);
    if (risk != null && risk < requested) {
      warnings.push(
        `위험엔진 역산은 ${risk}배인데 ${requested}배로 시험합니다 — `
        + '1회 위험이 설정한 비율보다 커집니다');
    }

    return {
      rows, liquidationSafeCap: liqSafe, liquidationTheoreticalCap: theoretical,
      allowed: requested, boundBy: '요청 배율', blocked: false, blockReason: '',
      blockCode: null, requested, warnings,
      summary: `이번 주문 ${requested}배 — 요청 그대로 시험합니다`
        + (warnings.length > 0 ? ` (경고 ${warnings.length}건)` : ''),
    };
  }

  const candidates = rows.filter(r => r.known && r.value != null);
  if (candidates.length === 0) {
    return {
      rows, liquidationSafeCap: liqSafe, liquidationTheoreticalCap: theoretical,
      allowed: null, boundBy: null, blocked: true, blockCode: 'NO_CAPS',
      requested, warnings: [],
      blockReason: '배율 상한을 하나도 읽지 못했습니다',
      summary: '배율을 정할 수 없습니다',
    };
  }

  const min = candidates.reduce((a, b) => (b.value! < a.value! ? b : a));
  const allowed = Math.floor(min.value!);

  if (allowed < 1) {
    return {
      rows, liquidationSafeCap: liqSafe, liquidationTheoreticalCap: theoretical,
      allowed: null, boundBy: min.label, blocked: true, blockCode: 'SUB_ONE',
      requested, warnings: [],
      blockReason: `${min.label}이 1배 미만입니다 — 이 손절로는 어떤 배율도 안전하지 않습니다`,
      summary: '배율을 정할 수 없습니다',
    };
  }

  return {
    rows, liquidationSafeCap: liqSafe, liquidationTheoreticalCap: theoretical,
    allowed, boundBy: min.label, blocked: false, blockReason: '',
    blockCode: null, requested, warnings: [],
    summary: `이번 주문 ${allowed}배 — ${min.label}이 가장 낮습니다`,
  };
}

// ── 의도와 실제가 같은가 ──────────────────────────────────

export type VenueMatchCode =
  /** 같다 — 주문해도 된다 */
  | 'MATCH'
  /** 다르다 — **주문 금지** */
  | 'MISMATCH'
  /** 거래소 값을 못 읽었다 — 역시 금지 */
  | 'VENUE_UNKNOWN'
  /** 낼 배율을 정하지 못했다 */
  | 'INTENDED_UNKNOWN';

export interface VenueMatch {
  ok: boolean;
  code: VenueMatchCode;
  reason: string;
  /** 화면에 붙일 짧은 표시 */
  badge: string;
}

/**
 * 거래소에 실제로 걸린 배율이 의도와 같은가.
 *
 * **다르면 주문을 막는다.** 이게 없는 동안 화면은 49배를 보여주고
 * 거래소는 5배로 돌고 있었다. 그 상태로 주문이 나가면 사용자가 계산한
 * 손실도, 화면의 청산거리도 전부 틀린 숫자다.
 *
 * **모르는 것도 막는다.** 거래소 값을 못 읽었으면 같은지 다른지 모르는
 * 것이고, 그때 통과시키면 확인하지 못한 것을 통과로 세는 것이다.
 */
export function venueMatch(intended: any, venue: any): VenueMatch {
  const i = num(intended);
  const v = num(venue);

  if (i == null) {
    return { ok: false, code: 'INTENDED_UNKNOWN', badge: '배율 미정',
      reason: '이번 주문에 쓸 배율을 정하지 못했습니다' };
  }
  if (v == null) {
    return { ok: false, code: 'VENUE_UNKNOWN', badge: '거래소 확인 실패',
      reason: `거래소에 실제로 걸린 배율을 읽지 못했습니다 — 의도한 ${i}배가 적용됐는지 확인할 수 없습니다` };
  }
  // 거래소는 정수로 돌려준다. 소수점 반올림 차이로 막지 않는다.
  if (Math.round(i) !== Math.round(v)) {
    return { ok: false, code: 'MISMATCH', badge: `설정 ${Math.round(i)}x · 실제 ${Math.round(v)}x`,
      reason: `의도 ${Math.round(i)}배인데 거래소는 ${Math.round(v)}배입니다`
        + ' — 이 상태로 주문하면 화면의 손실·청산거리가 전부 틀린 숫자가 됩니다' };
  }
  return { ok: true, code: 'MATCH', badge: `${Math.round(v)}x ✓`, reason: '' };
}

// ── 손절이 청산보다 먼저 오는가 (가격으로) ────────────────

export type StopOrderCode =
  | 'SAFE'
  /** 손절보다 청산이 먼저 — **차단** */
  | 'LIQUIDATION_FIRST'
  /** 손절이 진입가 반대편에 있다 */
  | 'STOP_WRONG_SIDE'
  /** 청산가를 모른다 — 차단 */
  | 'LIQUIDATION_UNKNOWN'
  | 'INPUT_UNKNOWN';

export interface StopOrderVerdict {
  ok: boolean;
  code: StopOrderCode;
  reason: string;
  /** 손절과 청산 사이의 여유 (%) */
  bufferPct: number | null;
}

/**
 * 가격으로 확인한다 — **비율 계산이 아니라 실제 가격이다.**
 *
 *   LONG   청산가 < 손절가 < 진입가
 *   SHORT  진입가 < 손절가 < 청산가
 *
 * 청산가는 **거래소가 준 값을 쓴다.** 포지션이 이미 있으면 거래소의
 * liquidation price가 진실이고, 우리 공식은 근사다. 근사로 안전을
 * 판정하면 근사가 틀린 날 청산된다.
 */
export function stopBeforeLiquidation(input: {
  side?: any; entryPrice?: any; stopPrice?: any; liquidationPrice?: any;
} | null | undefined): StopOrderVerdict {
  const i = input ?? {};
  const side = String(i.side ?? '').trim().toUpperCase();
  const entry = num(i.entryPrice);
  const stop = num(i.stopPrice);
  const liq = num(i.liquidationPrice);

  if (side !== 'LONG' && side !== 'SHORT') {
    return { ok: false, code: 'INPUT_UNKNOWN', bufferPct: null,
      reason: '방향(LONG/SHORT)을 확인하지 못했습니다' };
  }
  if (entry == null || stop == null) {
    return { ok: false, code: 'INPUT_UNKNOWN', bufferPct: null,
      reason: '진입가나 손절가를 확인하지 못했습니다' };
  }
  if (liq == null) {
    // **못 읽은 것을 안전으로 읽지 않는다.**
    return { ok: false, code: 'LIQUIDATION_UNKNOWN', bufferPct: null,
      reason: '청산가를 확인하지 못했습니다 — 손절이 청산보다 먼저인지 모르는 채로 주문할 수 없습니다' };
  }

  const long = side === 'LONG';
  const stopOnRightSide = long ? stop < entry : stop > entry;
  if (!stopOnRightSide) {
    return { ok: false, code: 'STOP_WRONG_SIDE', bufferPct: null,
      reason: `${side} 손절가 ${stop}가 진입가 ${entry}의 반대편에 있습니다` };
  }

  const stopFirst = long ? liq < stop : liq > stop;
  const buffer = Math.abs(stop - liq) / entry * 100;

  if (!stopFirst) {
    return { ok: false, code: 'LIQUIDATION_FIRST', bufferPct: buffer,
      reason: `${side}에서 청산가 ${liq}가 손절가 ${stop}보다 먼저 옵니다`
        + ' — 손절이 작동하기 전에 증거금이 전액 사라집니다' };
  }

  return { ok: true, code: 'SAFE', bufferPct: buffer, reason: '' };
}

// ── 환경별 위험 프리셋 ────────────────────────────────────

export type RiskTier = 'STABILIZE' | 'AGGRESSIVE' | 'RESEARCH' | 'STRESS';

export interface TierLimit {
  label: string;
  /** 1회 위험 상한 (%) */
  maxRiskPct: number;
  /** 배율 상한 */
  maxLeverage: number;
  /** 이 등급을 쓸 수 있는 환경 */
  allowedEnvs: Array<'MOCK' | 'TESTNET' | 'LIVE'>;
  desc: string;
}

/**
 * 1회 위험 10% + 100배는 **일반 설정이 아니다.**
 *
 * 한 번 손절할 때 계좌의 10%가 사라지는 구조는 몇 번만 연달아 틀려도
 * 자산이 크게 줄어든다. 그런데 지금 그 조합이 자동매매 기본 화면에
 * 아무 표시 없이 앉아 있다 — 일반 설정처럼 보인다.
 *
 * 그래서 등급을 나누고, **연구용은 실전에서 못 쓰게 한다.**
 */
export const TIER_LIMITS: Record<RiskTier, TierLimit> = {
  STABILIZE: {
    label: '안정화', maxRiskPct: 0.5, maxLeverage: 20,
    allowedEnvs: ['MOCK', 'TESTNET', 'LIVE'],
    desc: '1회 위험 0.25~0.5% — 오래 살아남는 것이 목표입니다',
  },
  AGGRESSIVE: {
    label: '공격적', maxRiskPct: 1, maxLeverage: 30,
    allowedEnvs: ['MOCK', 'TESTNET', 'LIVE'],
    desc: '1회 위험 0.5~1% — 낙폭을 감수하고 성장을 노립니다',
  },
  RESEARCH: {
    label: '연구용', maxRiskPct: 2, maxLeverage: 50,
    allowedEnvs: ['MOCK', 'TESTNET'],
    desc: '1회 위험 1~2% — 실전에서는 쓸 수 없습니다',
  },
  // ── 스트레스는 TESTNET에서도 돈다 ──
  //
  // 예전에는 MOCK에서만 허용했다. 그런데 **MOCK에서 100배를 돌리는 것은
  // 아무것도 증명하지 않는다** — 체결도 슬리피지도 청산도 우리가 만든
  // 숫자다. "망가지는 지점을 본다"는 목적 자체가 거래소가 실제로
  // 어떻게 거절하고 어떻게 청산하는지를 보는 것이라, 그걸 보려면
  // 테스트넷이어야 한다. 그리고 테스트넷에서 잃을 돈은 없다.
  //
  // **LIVE는 계속 막는다.** 1회 위험 10%는 몇 번만 연달아 틀려도 계좌가
  // 크게 준다. 테스트넷에서 잘 돌던 설정을 그대로 실전으로 올리는 것이
  // 가장 자연스러운 동작이고, 그래서 가장 위험하다.
  //
  // 이 완화는 **등급 관문 하나만** 연다. 거래소 최대 배율, 배율 되읽기
  // 대조, 청산 안전거리, 포지션 모드, UNKNOWN 차단은 그대로다 —
  // 100배가 통과하는 것과 100배로 주문이 나가는 것은 다른 일이다.
  STRESS: {
    label: '스트레스 테스트', maxRiskPct: 10, maxLeverage: 100,
    allowedEnvs: ['MOCK', 'TESTNET'],
    desc: '1회 위험 10% · 100배 — 망가지는 지점을 보려는 설정입니다. 실전에서는 쓸 수 없습니다',
  },
};

export interface TierVerdict {
  ok: boolean;
  reason: string;
  /** 이 환경에서 쓸 수 있는 가장 가까운 등급 */
  suggested: RiskTier | null;
}

/**
 * 이 등급을 이 환경에서 써도 되는가.
 *
 * **연구용 100배/10%가 실전으로 그대로 승격되면 안 된다.** 테스트넷에서
 * 잘 돌던 설정을 그대로 올리는 것이 가장 자연스러운 동작이고, 그래서
 * 가장 위험하다.
 */
export function tierAllowedIn(tier: any, env: any): TierVerdict {
  const t = String(tier ?? '').trim().toUpperCase() as RiskTier;
  const e = String(env ?? '').trim().toUpperCase() as 'MOCK' | 'TESTNET' | 'LIVE';
  const limit = TIER_LIMITS[t];

  if (!limit) {
    return { ok: false, suggested: 'STABILIZE',
      reason: `모르는 위험 등급(${tier})입니다 — 안정화로 다루세요` };
  }
  if (e !== 'MOCK' && e !== 'TESTNET' && e !== 'LIVE') {
    return { ok: false, suggested: null,
      reason: '실행 환경을 확인하지 못했습니다' };
  }
  if (!limit.allowedEnvs.includes(e)) {
    // 이 환경에서 쓸 수 있는 것 중 가장 공격적인 것을 권한다.
    const order: RiskTier[] = ['STRESS', 'RESEARCH', 'AGGRESSIVE', 'STABILIZE'];
    const fallback = order.find(k => TIER_LIMITS[k].allowedEnvs.includes(e)) ?? null;
    return { ok: false, suggested: fallback,
      reason: `'${limit.label}' 등급은 ${e}에서 쓸 수 없습니다 — ${limit.desc}` };
  }
  return { ok: true, suggested: t, reason: '' };
}

/**
 * 이 설정이 등급 안에 들어오는가.
 *
 * 등급을 골랐다고 끝이 아니다 — 안정화를 골라 놓고 위험 10%를 넣으면
 * 그건 안정화가 아니다.
 */
export function withinTier(
  tier: any, riskPct: any, leverage: any,
): { ok: boolean; reason: string } {
  const t = String(tier ?? '').trim().toUpperCase() as RiskTier;
  const limit = TIER_LIMITS[t];
  if (!limit) return { ok: false, reason: `모르는 위험 등급(${tier})입니다` };

  // **모르는 값을 통과시키지 않는다.**
  //
  // `Number(null)`은 0이다. 그냥 Number.isFinite로 거르면 null이 '위험 0%'가
  // 되어 어떤 상한도 통과한다 — 모르는 것이 가장 안전한 값으로 둔갑한다.
  const parse = (v: any): number | null => {
    if (v == null || v === '' || typeof v === 'boolean') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const r = parse(riskPct);
  const l = parse(leverage);
  const bad: string[] = [];
  if (r == null) bad.push('1회 위험을 확인하지 못했습니다');
  else if (r > limit.maxRiskPct) bad.push(`1회 위험 ${r}%가 '${limit.label}' 상한 ${limit.maxRiskPct}%를 넘습니다`);
  if (l == null) bad.push('배율을 확인하지 못했습니다');
  else if (l > limit.maxLeverage) bad.push(`배율 ${l}배가 '${limit.label}' 상한 ${limit.maxLeverage}배를 넘습니다`);

  return bad.length === 0
    ? { ok: true, reason: '' }
    : { ok: false, reason: bad.join(' · ') };
}

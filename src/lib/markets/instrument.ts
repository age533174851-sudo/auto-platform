// src/lib/markets/instrument.ts
//
// **이 종목이 어떤 물건인가.**
//
// 왜 필요한가
// ───────────
// 이 앱은 포지션 크기를 손절 거리로 역산한다 — 허용손실 ÷ 손절거리.
// 그 계산은 "손절 2%는 어느 종목에서든 2%다"를 전제한다.
//
// 그 전제가 레버리지 상품에서 깨진다. 3배 ETF는 지수가 0.7% 움직이면
// 2.1% 움직인다. 일반 주식과 **같은 2% 손절을 걸면 3배 자주 걸린다.**
// 전략이 나쁜 게 아니라 손절이 잘못 잡힌 것인데, 화면에는 "승률이 낮다"로만
// 보인다. 원인을 못 찾는다.
//
// 그리고 새는 상품이 있다
// ───────────────────────
// 레버리지 ETF는 **하루 수익률**의 N배를 따라간다. 매일 리밸런싱하므로
// 횡보장에서는 지수가 제자리여도 값이 줄어든다(변동성 감쇄).
//
//   지수  +10% → −9.09%  = 본전
//   3배   +30% → −27.3%  = −5.5%
//
// 원유·천연가스 같은 선물 ETF는 롤오버 비용이 더해져 더 심하다. 유가가
// 회복해도 ETF는 안 돌아온다.
//
// 이건 전략의 문제가 아니라 **상품의 구조**다. 그래서 최대 보유 기간을
// 상품 자체에 붙인다 — 전략이 실수로 오래 들고 있는 것을 막는다.
//
// 모르면 1배로 치지 않는다
// ────────────────────────
// 모르는 종목을 1배로 두면 3배 ETF가 조용히 일반 주식처럼 다뤄진다.
// 모르면 **모른다고 하고**, 그 사실이 점검 목록에 뜨게 한다.

export type InstrumentKind =
  /** 개별 주식 */
  | 'STOCK'
  /** 일반 ETF (지수 추종, 1배) */
  | 'ETF'
  /** 레버리지·인버스 ETF — 매일 리밸런싱한다 */
  | 'LEVERAGED_ETF'
  /** 원자재 선물 ETF — 롤오버 비용이 붙는다 */
  | 'FUTURES_ETF'
  /** 코인 */
  | 'CRYPTO'
  /** 토큰화 주식 */
  | 'TOKENIZED'
  /** 선물 (직접) */
  | 'FUTURES';

export interface InstrumentSpec {
  symbol: string;
  name: string;
  kind: InstrumentKind;
  /**
   * 기초자산 대비 배수. 인버스는 음수다.
   *
   * 3배 → 3, 인버스 2배 → −2, 일반 → 1.
   * **모르면 null.** 1로 채우면 3배 ETF가 일반 주식처럼 다뤄진다.
   */
  leverageFactor: number | null;
  /**
   * 오래 들고 있으면 값이 새는가.
   *
   * 레버리지 ETF(일일 리밸런싱)와 선물 ETF(롤오버)가 여기 해당한다.
   */
  decays: boolean;
  /** 권장 최대 보유 기간(일). null이면 제한 없음 */
  maxHoldDays: number | null;
  /** 화면에 그대로 띄울 한 줄 */
  note: string;
}

const DAY_MS = 86_400_000;

/**
 * 알려진 종목표.
 *
 * 여기 없는 종목은 **모르는 것으로 둔다.** 이름으로 추측해서 채우면
 * ('레버리지'가 들어가면 2배 같은 식) 표기가 다른 종목을 놓치고,
 * 놓친 종목이 하필 3배짜리다.
 */
export const KNOWN_INSTRUMENTS: InstrumentSpec[] = [
  // ── 국내 ETF ────────────────────────────────────────────
  { symbol: '069500', name: 'KODEX 200', kind: 'ETF',
    leverageFactor: 1, decays: false, maxHoldDays: null, note: '코스피200 추종' },
  { symbol: '122630', name: 'KODEX 레버리지', kind: 'LEVERAGED_ETF',
    leverageFactor: 2, decays: true, maxHoldDays: 10,
    note: '코스피200 일일 2배 — 횡보장에서 값이 샙니다' },
  { symbol: '252670', name: 'KODEX 200선물인버스2X', kind: 'LEVERAGED_ETF',
    leverageFactor: -2, decays: true, maxHoldDays: 10,
    note: '코스피200 일일 −2배 — 횡보장에서 값이 샙니다' },
  { symbol: '233740', name: 'KODEX 코스닥150레버리지', kind: 'LEVERAGED_ETF',
    leverageFactor: 2, decays: true, maxHoldDays: 10,
    note: '코스닥150 일일 2배 — 횡보장에서 값이 샙니다' },
  { symbol: '261220', name: 'KODEX WTI원유선물', kind: 'FUTURES_ETF',
    leverageFactor: 1, decays: true, maxHoldDays: 20,
    note: '원유 선물 — 매달 롤오버 비용이 붙습니다. 유가가 회복해도 안 돌아옵니다' },
  { symbol: '132030', name: 'KODEX 골드선물(H)', kind: 'FUTURES_ETF',
    leverageFactor: 1, decays: true, maxHoldDays: 60,
    note: '금 선물 — 롤오버 비용이 있지만 원유보다는 완만합니다' },

  // ── 미국 ETF ────────────────────────────────────────────
  { symbol: 'SPY', name: 'SPDR S&P 500', kind: 'ETF',
    leverageFactor: 1, decays: false, maxHoldDays: null, note: 'S&P500 추종 · 배당 있음' },
  { symbol: 'QQQ', name: 'Invesco QQQ', kind: 'ETF',
    leverageFactor: 1, decays: false, maxHoldDays: null, note: '나스닥100 추종' },
  { symbol: 'SCHD', name: 'Schwab US Dividend', kind: 'ETF',
    leverageFactor: 1, decays: false, maxHoldDays: null, note: '배당주 · 장투용' },
  { symbol: 'TQQQ', name: 'ProShares UltraPro QQQ', kind: 'LEVERAGED_ETF',
    leverageFactor: 3, decays: true, maxHoldDays: 10,
    note: '나스닥100 일일 3배 — 2022년 −79%. 짧게 들고 나오는 물건입니다' },
  { symbol: 'SQQQ', name: 'ProShares UltraPro Short QQQ', kind: 'LEVERAGED_ETF',
    leverageFactor: -3, decays: true, maxHoldDays: 10,
    note: '나스닥100 일일 −3배 — 장기 보유하면 거의 확실히 잃습니다' },
  { symbol: 'SOXL', name: 'Direxion Semiconductor Bull 3X', kind: 'LEVERAGED_ETF',
    leverageFactor: 3, decays: true, maxHoldDays: 10,
    note: '반도체 일일 3배 — 변동성이 매우 큽니다' },
  { symbol: 'UNG', name: 'US Natural Gas Fund', kind: 'FUTURES_ETF',
    leverageFactor: 1, decays: true, maxHoldDays: 5,
    note: '천연가스 선물 — 롤오버 손실이 가장 심한 축입니다. 단타 전용' },
];

const BY_SYMBOL = new Map(KNOWN_INSTRUMENTS.map(i => [i.symbol.toUpperCase(), i]));

/**
 * 종목 정보를 찾는다. **모르면 null이다.**
 *
 * 이름으로 추측하지 않는다 — '레버리지'가 들어가면 2배로 치는 식으로
 * 만들면, 표기가 다른 3배 종목을 놓친다. 놓친 쪽이 더 위험하다.
 */
export function instrumentOf(symbol: string | null | undefined): InstrumentSpec | null {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s) return null;
  return BY_SYMBOL.get(s) ?? null;
}

// ── 위험 조정 ────────────────────────────────────────────────

export interface SizingVerdict {
  /** 이 종목에 쓸 실효 손절 폭(%) */
  effectiveStopPct: number | null;
  /** 포지션 크기를 몇 배로 줄여야 하는가 (3배 상품이면 3) */
  sizeDivisor: number | null;
  reason: string;
  /** 판정할 수 있었는가 */
  known: boolean;
}

/**
 * 배수를 반영한 크기·손절 조정.
 *
 * 두 가지 방법이 있는데 하나만 골라야 한다:
 *   (가) 손절 폭을 배수만큼 넓히고 크기를 그만큼 줄인다
 *   (나) 손절 폭을 그대로 두고 크기만 줄인다
 *
 * **(가)를 쓴다.** (나)는 손절이 배수만큼 자주 걸려서, 손실 한 번의
 * 크기는 같아도 **횟수가 배수만큼 늘어난다.** 기대손실이 그만큼 커진다.
 *
 * 둘 다 '한 번에 잃는 금액'은 같게 유지된다 — 그게 이 앱의 크기 계산
 * 전제이고, 여기서 깨지면 안 된다.
 */
export function adjustForLeverage(
  baseStopPct: number, spec: InstrumentSpec | null,
): SizingVerdict {
  const base = Number(baseStopPct);
  if (!Number.isFinite(base) || base <= 0) {
    return { effectiveStopPct: null, sizeDivisor: null, known: false, reason: '손절 폭이 없습니다' };
  }
  if (!spec) {
    // **모르는 종목을 1배로 치지 않는다.** 3배 ETF가 조용히 일반 주식처럼
    // 다뤄지면 손절이 3배 자주 걸리고, 화면에는 '승률이 낮다'로만 보인다.
    return {
      effectiveStopPct: null, sizeDivisor: null, known: false,
      reason: '모르는 종목입니다 — 배수를 확인하지 못해 위험을 계산할 수 없습니다',
    };
  }
  const lev = spec.leverageFactor;
  if (lev == null || !Number.isFinite(lev) || lev === 0) {
    return {
      effectiveStopPct: null, sizeDivisor: null, known: false,
      reason: `${spec.name}의 배수를 모릅니다 — 위험을 계산할 수 없습니다`,
    };
  }

  // 인버스는 방향만 반대고 변동성은 크기만큼이다. 부호를 그대로 쓰면
  // 손절 폭이 음수가 된다.
  const mag = Math.abs(lev);
  if (mag === 1) {
    return {
      effectiveStopPct: base, sizeDivisor: 1, known: true,
      reason: `${spec.name} · 1배 — 손절 ${base}% 그대로`,
    };
  }
  return {
    effectiveStopPct: base * mag,
    sizeDivisor: mag,
    known: true,
    reason: `${spec.name} · ${lev > 0 ? '' : '인버스 '}${mag}배 — `
      + `기초자산 ${base}%가 이 종목에서는 ${(base * mag).toFixed(2)}%입니다. `
      + `손절을 그만큼 넓히고 수량을 ${mag}분의 1로 줄입니다`,
  };
}

// ── 보유 기간 ────────────────────────────────────────────────

export type HoldStatus = 'ok' | 'warn' | 'over' | 'unknown';

export interface HoldVerdict {
  status: HoldStatus;
  heldDays: number | null;
  limitDays: number | null;
  reason: string;
}

/**
 * 너무 오래 들고 있지 않은가.
 *
 * 감쇄하는 상품에만 의미가 있다. 일반 주식·ETF는 오래 들고 있는 것이
 * 전략이지 실수가 아니다.
 *
 * **넘었다고 자동으로 팔지는 않는다.** 여기서는 판정만 하고, 팔지 말지는
 * 청산 감시가 정한다 — 장이 닫혀 있을 수도 있고, 그때 시장가로 던지는
 * 것이 더 나쁠 수도 있다.
 */
export function checkHoldPeriod(
  spec: InstrumentSpec | null,
  openedAtMs: number | null | undefined,
  nowMs: number,
): HoldVerdict {
  if (!spec) {
    return { status: 'unknown', heldDays: null, limitDays: null,
      reason: '모르는 종목이라 보유 기간 기준을 알 수 없습니다' };
  }
  if (spec.maxHoldDays == null) {
    return { status: 'ok', heldDays: null, limitDays: null,
      reason: `${spec.name} · 보유 기간 제한 없음` };
  }
  if (!Number.isFinite(openedAtMs as any) || !Number.isFinite(nowMs)) {
    // 언제 샀는지 모르면 '괜찮다'고 하지 않는다. 감쇄하는 상품을 언제부터
    // 들고 있는지 모르는 상태 자체가 문제다.
    return { status: 'unknown', heldDays: null, limitDays: spec.maxHoldDays,
      reason: `${spec.name} · 언제 샀는지 몰라 보유 기간을 계산하지 못했습니다` };
  }

  const heldDays = (nowMs - (openedAtMs as number)) / DAY_MS;
  if (heldDays < 0) {
    return { status: 'unknown', heldDays: null, limitDays: spec.maxHoldDays,
      reason: `${spec.name} · 매수 시각이 미래입니다 — 기록을 믿을 수 없습니다` };
  }

  const lim = spec.maxHoldDays;
  const d = heldDays.toFixed(1);
  if (heldDays >= lim) {
    return { status: 'over', heldDays, limitDays: lim,
      reason: `${spec.name} · ${d}일 보유 (권장 ${lim}일) — ${spec.note}` };
  }
  // 80%를 넘으면 미리 알린다. 한도에 닿는 날 갑자기 알리면 그날이
  // 하필 장이 닫힌 날일 수 있다.
  if (heldDays >= lim * 0.8) {
    return { status: 'warn', heldDays, limitDays: lim,
      reason: `${spec.name} · ${d}일 보유 — 권장 ${lim}일에 가까워졌습니다` };
  }
  return { status: 'ok', heldDays, limitDays: lim,
    reason: `${spec.name} · ${d}일 보유 (권장 ${lim}일 이내)` };
}

/** 장투에 써도 되는 물건인가 */
export function suitableForLongTerm(spec: InstrumentSpec | null): { ok: boolean; reason: string } {
  if (!spec) return { ok: false, reason: '모르는 종목이라 판단할 수 없습니다' };
  if (spec.decays) {
    return { ok: false, reason: `${spec.name}은 오래 들고 있으면 값이 샙니다 — ${spec.note}` };
  }
  return { ok: true, reason: `${spec.name} · 장기 보유 가능` };
}

// src/lib/strategies/sleeveLedger.ts
//
// **거래소 계좌는 하나여도 장부는 나뉘어야 한다.**
//
// 왜 필요한가
// ───────────
// 테스트넷 $50,000을 전략별로 나눠 동시에 검증하려면, 거래소 잔고 하나를
// 여러 전략이 나눠 쓰게 된다. 거기서 두 가지가 무너진다.
//
//   1. **성과를 못 가른다.** 거래소는 합계만 보여준다. 어느 전략이
//      벌었고 어느 전략이 잃었는지 알 수 없으면, 승격도 강등도 근거가 없다.
//
//   2. **한 전략이 남의 포지션을 닫는다.** 같은 심볼에 두 전략이 들어가면
//      거래소에서는 한 포지션으로 합쳐진다. 그때 단타 전략이 '전량청산'을
//      부르면 장기 전략의 몫까지 나간다 — 그 전략은 자기가 아직 들고
//      있다고 믿고 손절도 익절도 걸지 않는다.
//
// 그래서 이 파일은 **전략별 소유 수량과 자금**을 따로 센다.
//
// 무엇을 하지 않는가
// ──────────────────
// **거래소에 계좌를 더 만들지 않는다.** 내부 원장일 뿐이고, 실제 주문은
// 여전히 하나의 연결로 나간다. 그래서 이 장부와 거래소가 어긋날 수 있고,
// 어긋나는 것을 **찾아내는 것**까지가 이 파일의 일이다(reconcile).
//
// 규칙 하나: **배정하지 않은 돈은 쓸 수 없다.**
// 합이 총자금을 넘는 배분은 아예 만들 수 없게 한다. 넘겨 두면 두 전략이
// 같은 돈을 각자 자기 것으로 세고, 둘 다 진입하는 순간 증거금이 모자란다.

export interface SleeveSpec {
  /** 전략 계좌 id. 주문마다 새겨진다 */
  id: string;
  label: string;
  /** 배정 원금 */
  allocated: number;
  /** 이 계좌의 1회 위험 상한(%) */
  riskPerTradePct?: number | null;
  /** 이 계좌를 멈출 낙폭(%) */
  maxDrawdownPct?: number | null;
  /** 배율 상한 */
  maxLeverage?: number | null;
  /** 승격 단계 */
  stage?: SleeveStage;
}

export type SleeveStage =
  | 'SPECIFICATION' | 'BACKTEST' | 'WALK_FORWARD'
  | 'PAPER' | 'SHADOW' | 'TESTNET' | 'LIVE_SMALL' | 'LIVE_LIMITED';

export const STAGE_ORDER: SleeveStage[] = [
  'SPECIFICATION', 'BACKTEST', 'WALK_FORWARD',
  'PAPER', 'SHADOW', 'TESTNET', 'LIVE_SMALL', 'LIVE_LIMITED',
];

/** 이 단계에서 실제 돈이 나가는가 */
export function stageSpendsRealMoney(s: SleeveStage | null | undefined): boolean {
  return s === 'LIVE_SMALL' || s === 'LIVE_LIMITED';
}

export interface SleeveState {
  id: string;
  allocated: number;
  /** 지금 포지션에 묶여 있는 증거금 */
  reservedMargin: number;
  realizedPnl: number;
  unrealizedPnl: number;
  /** 이 계좌가 낸 수수료·펀딩비 합 */
  fees: number;
  /** 최고 자산 (낙폭 계산용) */
  peakEquity: number;
  maxDrawdownPct: number;
  /** 심볼 → 이 계좌가 소유한 수량 (롱 +, 숏 −) */
  positions: Record<string, number>;
  /**
   * 심볼 → 이 계좌의 매입 평균가.
   *
   * **없는 것과 0은 다르다.** 없으면 "이 계좌가 얼마에 샀는지 모른다"이고,
   * 그때는 청산 손익을 장부에 안 적는다 — 지어낸 평균가로 낸 손익이
   * 낙폭이 되고, 낙폭은 계좌를 멈추는 근거가 된다.
   */
  avgPrices?: Record<string, number>;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const n0 = (v: any): number => num(v) ?? 0;

export function freshSleeve(spec: SleeveSpec): SleeveState {
  const allocated = Math.max(0, n0(spec?.allocated));
  return {
    id: String(spec?.id ?? ''),
    allocated,
    reservedMargin: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    fees: 0,
    peakEquity: allocated,
    maxDrawdownPct: 0,
    positions: {},
    avgPrices: {},
  };
}

/** 지금 이 계좌의 자산 = 배정 + 실현 − 수수료 + 미실현 */
export function equityOf(s: SleeveState | null | undefined): number {
  if (!s) return 0;
  return n0(s.allocated) + n0(s.realizedPnl) - n0(s.fees) + n0(s.unrealizedPnl);
}

/**
 * 쓸 수 있는 현금 = 자산 − 묶인 증거금.
 *
 * **미실현 이익을 쓸 수 있는 돈으로 세지 않는다.** 아직 안 닫은 이익은
 * 다음 봉에 사라질 수 있고, 그걸로 새 포지션을 열면 이익이 사라지는
 * 순간 증거금이 모자란다.
 */
export function availableOf(s: SleeveState | null | undefined): number {
  if (!s) return 0;
  const realized = n0(s.allocated) + n0(s.realizedPnl) - n0(s.fees);
  // 미실현 **손실**은 뺀다(있는 돈이 아니므로). 미실현 이익은 안 더한다.
  const unreal = Math.min(0, n0(s.unrealizedPnl));
  return Math.max(0, realized + unreal - n0(s.reservedMargin));
}

// ── 배분 ─────────────────────────────────────────────────

export interface AllocationCheck {
  ok: boolean;
  total: number;
  allocated: number;
  /** 남는 돈 (예비 현금) */
  reserve: number;
  reason: string;
  /** 각 계좌가 총자금의 몇 %인가 */
  shares: Array<{ id: string; label: string; allocated: number; pct: number }>;
}

/**
 * 배분이 성립하는가.
 *
 * **합이 총자금을 넘으면 아예 거부한다.** 넘겨 두면 두 전략이 같은 돈을
 * 각자 자기 것으로 세고, 둘 다 진입하는 순간 증거금이 모자란다. 그때
 * 거래소는 둘 중 아무 쪽이나 거부하고, 어느 쪽이 거부될지는 순서가 정한다.
 */
export function checkAllocation(
  total: number, sleeves: SleeveSpec[] | null | undefined,
): AllocationCheck {
  const t = num(total);
  const list = (Array.isArray(sleeves) ? sleeves : []).filter(s => s && String(s.id ?? '').trim());

  if (t == null || t <= 0) {
    return { ok: false, total: 0, allocated: 0, reserve: 0, shares: [],
      reason: '총자금을 확인하지 못했습니다 — 배분할 수 없습니다' };
  }

  const shares = list.map(s => ({
    id: String(s.id), label: String(s.label ?? s.id),
    allocated: Math.max(0, n0(s.allocated)),
    pct: 0,
  }));
  for (const sh of shares) sh.pct = (sh.allocated / t) * 100;

  const allocated = shares.reduce((a, s) => a + s.allocated, 0);
  const reserve = t - allocated;

  // 중복 id를 잡는다. 같은 id가 둘이면 나중 것이 앞의 것을 덮어쓰고,
  // 그 전략의 포지션이 조용히 사라진다.
  const seen = new Set<string>();
  const dup = shares.find(s => { if (seen.has(s.id)) return true; seen.add(s.id); return false; });
  if (dup) {
    return { ok: false, total: t, allocated, reserve, shares,
      reason: `전략 계좌 id가 겹칩니다 (${dup.id}) — 한쪽의 포지션이 조용히 사라집니다` };
  }

  if (allocated > t + 1e-9) {
    return {
      ok: false, total: t, allocated, reserve, shares,
      reason: `배정 합계 ${allocated.toLocaleString()}이 총자금 ${t.toLocaleString()}을 넘습니다`
        + ' — 두 전략이 같은 돈을 각자 자기 것으로 세게 됩니다',
    };
  }

  return {
    ok: true, total: t, allocated, reserve, shares,
    reason: reserve > 0
      ? `예비 현금 ${reserve.toLocaleString()} (${((reserve / t) * 100).toFixed(1)}%)`
      : '예비 현금이 없습니다 — 전액이 배정되었습니다',
  };
}

// ── 포지션 소유권 ────────────────────────────────────────

export interface OwnershipCheck {
  allowed: boolean;
  /** 이 계좌가 실제로 소유한 수량 */
  owned: number;
  /** 요청한 수량 */
  requested: number;
  reason: string;
}

/**
 * 이 전략이 이만큼 닫아도 되는가.
 *
 * **거래소 합계가 아니라 이 계좌의 몫으로 판정한다.** 이게 없으면
 * 단타 전략의 '전량청산'이 장기 전략의 몫까지 닫고, 그 전략은 자기가
 * 아직 들고 있다고 믿는다 — 손절도 익절도 안 걸린 채로.
 */
export function canClose(
  s: SleeveState | null | undefined, symbol: string, qty: number,
): OwnershipCheck {
  const sym = String(symbol ?? '').toUpperCase();
  const owned = Math.abs(n0(s?.positions?.[sym]));
  const want = Math.abs(n0(qty));

  if (!sym) {
    return { allowed: false, owned, requested: want, reason: '심볼이 없습니다' };
  }
  if (want <= 0) {
    return { allowed: false, owned, requested: want, reason: '닫을 수량이 0입니다' };
  }
  if (owned <= 0) {
    return { allowed: false, owned, requested: want,
      reason: `이 전략 계좌는 ${sym}을 갖고 있지 않습니다 — 거래소에 포지션이 있어도 남의 것입니다` };
  }
  // 부동소수 꼬리는 봐 준다. 거래소가 준 수량을 그대로 넣으면 마지막
  // 자리가 다를 수 있고, 그때 전량청산이 막히면 그것대로 사고다.
  if (want > owned * (1 + 1e-9)) {
    return { allowed: false, owned, requested: want,
      reason: `이 계좌의 몫은 ${owned}인데 ${want}를 닫으려 합니다 — 나머지는 다른 전략의 것입니다` };
  }
  return { allowed: true, owned, requested: want, reason: '' };
}

/** 이 계좌의 포지션을 늘리거나 줄인다. 부호는 방향(롱 +, 숏 −) */
export function applyFill(
  s: SleeveState, symbol: string, deltaQty: number,
): SleeveState {
  const sym = String(symbol ?? '').toUpperCase();
  if (!sym) return s;
  const next = { ...s, positions: { ...s.positions } };
  const cur = n0(next.positions[sym]);
  const v = cur + n0(deltaQty);
  // 0에 아주 가까우면 지운다. 남겨 두면 '0.0000000001 보유'가 되어
  // 화면에 유령 포지션이 뜬다.
  if (Math.abs(v) < 1e-12) delete next.positions[sym];
  else next.positions[sym] = v;
  return next;
}

export interface PricedFill {
  state: SleeveState;
  /** 이번 체결로 확정된 손익. 진입이면 0 */
  realized: number;
  /** 무슨 일이 있었는가 — 화면과 로그에 그대로 적는다 */
  note: string;
}

/**
 * 가격을 아는 체결.
 *
 * **이게 없어서 전략 계좌의 손익이 영영 0이었다.**
 *
 * `applyFill`은 수량만 옮긴다. 그래서 진입도 청산도 `realizedPnl`을
 * 건드리지 않았고, 그러면 이런 일이 난다:
 *
 *   · `equityOf`가 언제나 배정액과 같다 — 얼마를 잃어도
 *   · 낙폭이 영원히 0% → `sleeveGate`의 낙폭 정지가 **한 번도 못 걸린다**
 *   · `availableOf`가 안 줄어 → 잃은 계좌가 계속 새로 들어간다
 *
 * "한 전략이 손실 한도에 걸려 그 전략만 멈춘다"가 전략 계좌를 나눈
 * 이유인데, 그 절반이 통째로 안 돌고 있었다.
 *
 * 평균가는 **줄일 때 안 바꾼다.** 절반을 닫아도 남은 절반의 매입가는
 * 그대로다. 늘릴 때만 가중평균으로 다시 낸다.
 *
 * 방향이 뒤집히는 체결(롱 1을 −3 해서 숏 2가 되는 것)은 **닫은 만큼만
 * 실현하고 나머지를 새 평균가로 연다.** 통째로 실현하면 열지도 않은
 * 구간의 손익이 장부에 들어간다.
 */
export function applyPricedFill(
  s: SleeveState, symbol: string, deltaQty: number, price: number, fee = 0,
): PricedFill {
  const sym = String(symbol ?? '').toUpperCase();
  const d = n0(deltaQty);
  const px = num(price);

  if (!sym || d === 0) {
    return { state: s, realized: 0, note: '' };
  }
  // **가격을 모르면 수량만 옮긴다.** 지어낸 가격으로 손익을 적으면
  // 그 숫자가 낙폭이 되고, 낙폭은 계좌를 멈추는 근거가 된다.
  if (px == null || px <= 0) {
    return {
      state: applyFill(s, sym, d), realized: 0,
      note: '체결가를 몰라 수량만 반영했습니다 — 이 체결의 손익은 장부에 없습니다',
    };
  }

  const before = n0(s.positions?.[sym]);
  const avgs = { ...(s.avgPrices ?? {}) };
  const avg = num(avgs[sym]);

  // 같은 방향으로 늘리거나, 없던 자리에 새로 여는 것
  const opening = before === 0 || Math.sign(before) === Math.sign(d);
  if (opening) {
    const total = Math.abs(before) + Math.abs(d);
    avgs[sym] = (avg != null && before !== 0)
      ? (avg * Math.abs(before) + px * Math.abs(d)) / total
      : px;
    const next = applyFill(s, sym, d);
    return {
      state: applyRealized({ ...next, avgPrices: avgs }, 0, fee),
      realized: 0,
      note: before === 0 ? '' : `평균가 ${avgs[sym].toFixed(8)}로 갱신`,
    };
  }

  // 줄이는 것. 닫히는 수량은 보유분을 넘지 않는다.
  const closedQty = Math.min(Math.abs(d), Math.abs(before));
  // 평균가를 모르면 손익을 낼 수 없다. **0으로 치지 않는다** —
  // 0은 '본전'이고 그건 확인한 사실이 아니다.
  const realized = avg == null ? 0
    : (px - avg) * closedQty * Math.sign(before);

  let next = applyFill(s, sym, d);
  const after = n0(next.positions?.[sym]);

  if (after === 0) {
    delete avgs[sym];
  } else if (Math.sign(after) !== Math.sign(before)) {
    // 방향이 뒤집혔다. 남은 것은 이 체결가로 새로 연 것이다.
    avgs[sym] = px;
  }
  // 같은 방향으로 줄기만 했으면 평균가는 그대로 둔다.

  next = applyRealized({ ...next, avgPrices: avgs }, realized, fee);
  return {
    state: next,
    realized,
    note: avg == null
      ? '매입 평균가를 몰라 이 청산의 손익을 장부에 적지 못했습니다'
      : `${closedQty} 청산 · 실현 ${realized.toFixed(4)}`,
  };
}

/** 실현손익을 반영하고 낙폭을 갱신한다 */
export function applyRealized(s: SleeveState, pnl: number, fee = 0): SleeveState {
  const next = { ...s };
  next.realizedPnl = n0(next.realizedPnl) + n0(pnl);
  next.fees = n0(next.fees) + Math.max(0, n0(fee));
  const eq = equityOf(next);
  if (eq > n0(next.peakEquity)) next.peakEquity = eq;
  const peak = n0(next.peakEquity);
  if (peak > 0) {
    const dd = ((peak - eq) / peak) * 100;
    if (dd > n0(next.maxDrawdownPct)) next.maxDrawdownPct = dd;
  }
  return next;
}

// ── 계좌 정지 판정 ───────────────────────────────────────

export type SleeveHalt = 'DRAWDOWN' | 'NO_CASH' | 'STAGE_NOT_LIVE';

export interface SleeveGate {
  allowed: boolean;
  halted: SleeveHalt | null;
  reason: string;
}

/**
 * 이 계좌가 지금 새로 진입해도 되는가.
 *
 * **한 전략이 망가졌다고 전체 계좌를 끄지 않는다.** 이 판정은 계좌
 * 하나만 본다 — 그것이 전략별로 나눈 이유의 절반이다.
 */
export function sleeveGate(
  s: SleeveState | null | undefined,
  spec: SleeveSpec | null | undefined,
  opts: { requireLive?: boolean } = {},
): SleeveGate {
  if (!s || !spec) {
    return { allowed: false, halted: null, reason: '전략 계좌를 찾지 못했습니다' };
  }

  // 실전 주문인데 이 계좌가 아직 실전 단계가 아니면 막는다.
  if (opts.requireLive && !stageSpendsRealMoney(spec.stage)) {
    return { allowed: false, halted: 'STAGE_NOT_LIVE',
      reason: `이 전략은 아직 ${spec.stage ?? '미지정'} 단계입니다 — 실전 자금을 쓰지 않습니다` };
  }

  const ddCap = num(spec.maxDrawdownPct);
  if (ddCap != null && ddCap > 0 && n0(s.maxDrawdownPct) >= ddCap) {
    return { allowed: false, halted: 'DRAWDOWN',
      reason: `낙폭 ${s.maxDrawdownPct.toFixed(1)}% ≥ 한도 ${ddCap}% — 이 전략만 신규 진입을 멈춥니다`
        + ' (기존 포지션 관리는 계속합니다)' };
  }

  if (availableOf(s) <= 0) {
    return { allowed: false, halted: 'NO_CASH',
      reason: '이 전략 계좌에 쓸 수 있는 현금이 없습니다 — 다른 계좌의 돈을 끌어오지 않습니다' };
  }

  return { allowed: true, halted: null, reason: '' };
}

// ── 거래소와 대조 ────────────────────────────────────────

export interface SleeveMismatch {
  symbol: string;
  /** 전략 장부의 합 */
  ledger: number;
  /** 거래소가 보고한 수량. 못 읽었으면 null */
  exchange: number | null;
  reason: string;
}

/**
 * 전략 장부의 합과 거래소 포지션이 맞는가.
 *
 * 내부 원장이라 언제든 어긋날 수 있다 — 손으로 낸 주문, 거래소 청산,
 * 앱이 못 본 체결. **어긋나는 것 자체를 막을 수는 없으니 찾아내는 것이
 * 이 함수의 일이다.**
 *
 * 못 읽은 심볼은 불일치로 세지 않는다. 조회 실패를 '없음'으로 읽으면
 * 멀쩡한 포지션이 유령이 된다.
 */
export function reconcileSleeves(
  sleeves: SleeveState[] | null | undefined,
  exchange: Record<string, number | null> | null | undefined,
): SleeveMismatch[] {
  const list = Array.isArray(sleeves) ? sleeves : [];
  const ex = exchange ?? {};

  const ledger: Record<string, number> = {};
  for (const s of list) {
    for (const [sym, q] of Object.entries(s?.positions ?? {})) {
      ledger[sym.toUpperCase()] = (ledger[sym.toUpperCase()] ?? 0) + n0(q);
    }
  }

  const symbols = new Set([...Object.keys(ledger), ...Object.keys(ex).map(k => k.toUpperCase())]);
  const out: SleeveMismatch[] = [];

  for (const sym of symbols) {
    const l = ledger[sym] ?? 0;
    const raw = ex[sym] ?? ex[sym.toLowerCase()];
    const e = raw === undefined ? null : num(raw);

    if (e == null) {
      // 장부에 있는데 거래소를 못 읽은 것은 **불일치가 아니라 모름**이다.
      if (Math.abs(l) > 1e-12) {
        out.push({ symbol: sym, ledger: l, exchange: null,
          reason: '거래소 수량을 읽지 못했습니다 — 없는 것이 아니라 모르는 것입니다' });
      }
      continue;
    }
    if (Math.abs(l - e) < 1e-9) continue;

    out.push({
      symbol: sym, ledger: l, exchange: e,
      reason: Math.abs(l) < 1e-12
        ? '거래소에는 있는데 어느 전략도 자기 것이라고 하지 않습니다 — 손으로 낸 주문일 수 있습니다'
        : Math.abs(e) < 1e-12
          ? '전략 장부에는 있는데 거래소에는 없습니다 — 이미 닫혔거나 조회 범위 밖입니다'
          : `장부 합 ${l} / 거래소 ${e}`,
    });
  }

  return out;
}

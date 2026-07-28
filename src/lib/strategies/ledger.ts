// src/lib/strategies/ledger.ts
//
// 전략별 독립 장부.
//
// 이 파일이 다루는 근본 문제
// ──────────────────────────
// **거래소는 전략을 모른다.** 전략 A가 BTC 0.02를 열고 전략 B가 0.03을
// 열면, 거래소에는 0.05짜리 포지션 하나만 있다. 전략별 구분은 우리가
// 앱에서 붙이는 **귀속(attribution)**이고, 거래소의 사실이 아니다.
//
// 여기서 나오는 두 가지 위험
// ──────────────────────────
//  1. 귀속이 현실과 어긋난다. 수동 주문·부분 청산·강제 청산이 일어나면
//     장부 합계와 거래소 수량이 달라진다. 그때 차이를 전략들에 임의로
//     나눠 붙이면 **모든 전략의 장부가 동시에 틀린다.**
//     그래서 차이는 '미귀속(unattributed)'으로 따로 둔다.
//
//  2. 한 전략이 다른 전략의 포지션을 닫는다. 전략 A의 손절이 "BTC 전량
//     청산"으로 나가면 전략 B의 물량까지 사라진다. B는 자기가 아직
//     들고 있다고 믿는다. 그래서 **닫을 수 있는 양은 자기 귀속분까지**다.
//
// 자금도 마찬가지다. 전략마다 예산을 정하고, 그 합이 지갑을 넘지 않게
// 한다. 넘으면 두 전략이 같은 돈을 각자 자기 것으로 계산한다.

import type { MarketType } from '@/lib/markets/marketType';

// ── 소유권 표식 ────────────────────────────────────────
//
// live_orders에 strategy_id 컬럼이 아직 없다. 시장 유형과 같은 방식으로
// signal_id 앞에 표식을 붙인다. 시장 표식([SPOT])과 서로 독립이라
// 한쪽만 있어도 읽힌다.

const STRAT_TAG = /\[s:([A-Za-z0-9_\-.]+)\]/;

/** signal_id에 전략 소유권을 새긴다 */
export function tagStrategy(signalId: string, strategyId: string): string {
  const clean = String(signalId || '').replace(STRAT_TAG, '');
  return `[s:${strategyId}]${clean}`;
}

/**
 * 주문 행에서 소유 전략을 읽는다. 모르면 null.
 *
 * null은 "공용"이 아니라 **주인을 모른다**는 뜻이다. 주인을 모르는
 * 포지션을 아무 전략에나 귀속시키면 그 전략의 손익이 틀어진다.
 */
export function strategyOf(row: any): string | null {
  const col = row?.strategy_id;
  if (typeof col === 'string' && col.trim()) return col.trim();
  const m = STRAT_TAG.exec(String(row?.signal_id || ''));
  return m ? m[1] : null;
}

// ── 귀속 ───────────────────────────────────────────────

export interface StrategyHolding {
  strategyId: string;
  symbol: string;
  market: MarketType;
  /** 선물은 부호 있음(LONG +, SHORT −). 현물은 항상 0 이상 */
  qty: number;
  avgPrice: number | null;
}

export interface AttributionResult {
  symbol: string;
  market: MarketType;
  /** 전략들에 귀속된 합계 */
  attributed: number;
  /** 거래소가 말하는 실제 수량. 조회 실패면 null */
  exchangeQty: number | null;
  /**
   * 거래소에는 있는데 어느 전략의 것도 아닌 수량.
   * 수동 주문이나 강제 청산이 있었다는 뜻이다.
   */
  unattributed: number | null;
  /** 장부와 거래소가 맞는가 */
  matched: boolean;
  note: string;
}

/** 수량 비교 허용 오차 — 거래소 반올림 때문에 완전 일치는 드물다 */
const QTY_TOL = 1e-8;

function nearlyEqual(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  if (diff <= QTY_TOL) return true;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base > 0 && diff / base < 0.001;   // 0.1%
}

/**
 * 한 종목에 대해 장부 합계와 거래소 수량을 대조한다.
 *
 * **차이를 전략들에 나눠 붙이지 않는다.** 나눠 붙이면 어느 전략의 장부가
 * 틀렸는지 알 수 없게 되고, 모든 전략의 손익이 조금씩 틀린다.
 */
export function attribute(
  holdings: StrategyHolding[],
  symbol: string,
  market: MarketType,
  exchangeQty: number | null,
): AttributionResult {
  const mine = holdings.filter(h => h.symbol === symbol && h.market === market);
  const attributed = mine.reduce((s, h) => s + h.qty, 0);

  if (exchangeQty === null) {
    return {
      symbol, market, attributed, exchangeQty: null, unattributed: null,
      matched: false,
      note: '거래소 수량을 확인하지 못해 대조할 수 없습니다 — 일치한다는 뜻이 아닙니다',
    };
  }

  const unattributed = exchangeQty - attributed;
  const matched = nearlyEqual(attributed, exchangeQty);

  let note: string;
  if (matched) note = '장부와 거래소가 일치합니다';
  else if (unattributed > 0) {
    note = `거래소에 ${unattributed} 더 있습니다 — 수동 주문이거나 장부에 없는 진입입니다`;
  } else {
    note = `장부가 ${-unattributed} 더 많습니다 — 강제 청산이나 수동 종료가 있었을 수 있습니다`;
  }

  return { symbol, market, attributed, exchangeQty, unattributed, matched, note };
}

// ── 청산 권한 ──────────────────────────────────────────

export interface CloseCheck {
  ok: boolean;
  /** 실제로 닫아도 되는 수량 */
  allowedQty: number;
  reason?: string;
}

/**
 * 이 전략이 이만큼 닫아도 되는가.
 *
 * 자기 귀속분을 넘겨 닫으면 다른 전략의 포지션이 사라진다. 그 전략은
 * 자기가 아직 들고 있다고 믿고 손절도, 익절도 걸지 않는다.
 *
 * closePosition=true 같은 '전량 청산' 주문이 특히 위험하다 — 그건
 * 언제나 계좌 전체를 닫는다. 이 검사는 그 주문을 막기 위한 것이다.
 */
export function canClose(
  holdings: StrategyHolding[],
  strategyId: string,
  symbol: string,
  market: MarketType,
  requestedQty: number,
): CloseCheck {
  const mine = holdings.find(
    h => h.strategyId === strategyId && h.symbol === symbol && h.market === market);
  const own = mine ? Math.abs(mine.qty) : 0;

  if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
    return { ok: false, allowedQty: 0, reason: '청산 수량이 유효하지 않습니다' };
  }
  if (own <= 0) {
    return {
      ok: false, allowedQty: 0,
      reason: `${strategyId} 전략은 ${symbol} 포지션을 갖고 있지 않습니다`,
    };
  }
  if (requestedQty > own + QTY_TOL) {
    const others = holdings
      .filter(h => h.symbol === symbol && h.market === market && h.strategyId !== strategyId)
      .map(h => h.strategyId);
    return {
      ok: false, allowedQty: own,
      reason: `${strategyId}의 보유는 ${own}입니다. ${requestedQty}를 닫으면 ` +
              (others.length
                ? `다른 전략(${others.join(', ')})의 포지션까지 사라집니다.`
                : '장부에 없는 물량까지 닫게 됩니다.'),
    };
  }
  return { ok: true, allowedQty: requestedQty };
}

// ── 자금 배분 ──────────────────────────────────────────

export interface Allocation {
  strategyId: string;
  /** 이 전략에 배정된 예산(USD) */
  budgetUsd: number;
  /** 지금 이 전략이 쓰고 있는 금액(USD) */
  usedUsd: number;
}

export interface BudgetCheck {
  ok: boolean;
  availableUsd: number;
  reason?: string;
}

/** 이 전략이 이 금액을 더 쓸 수 있는가 */
export function canSpend(
  allocations: Allocation[], strategyId: string, amountUsd: number,
): BudgetCheck {
  const a = allocations.find(x => x.strategyId === strategyId);
  if (!a) {
    return { ok: false, availableUsd: 0, reason: `${strategyId}에 배정된 예산이 없습니다` };
  }
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { ok: false, availableUsd: 0, reason: '금액이 유효하지 않습니다' };
  }
  const avail = a.budgetUsd - a.usedUsd;
  if (amountUsd > avail) {
    return {
      ok: false, availableUsd: Math.max(0, avail),
      reason: `${strategyId} 예산이 ${(amountUsd - avail).toFixed(2)} USD 부족합니다 ` +
              `(예산 ${a.budgetUsd.toFixed(2)} / 사용 ${a.usedUsd.toFixed(2)}). ` +
              '다른 전략의 자금은 쓸 수 없습니다.',
    };
  }
  return { ok: true, availableUsd: avail };
}

export interface OverAllocation {
  ok: boolean;
  totalBudget: number;
  walletUsd: number;
  excess: number;
  reason?: string;
}

/**
 * 예산 합계가 지갑을 넘는가.
 *
 * 넘으면 두 전략이 같은 돈을 각자 자기 것으로 계산한다. 둘 다 "예산
 * 안"이라며 주문을 내고, 두 번째가 거래소에서 거부된다 — 혹은 거부되지
 * 않고 증거금을 잡아 먹어 첫 번째가 청산된다.
 */
export function checkOverAllocation(
  allocations: Allocation[], walletUsd: number | null,
): OverAllocation {
  const totalBudget = allocations.reduce((s, a) => s + a.budgetUsd, 0);
  if (walletUsd === null) {
    return {
      ok: false, totalBudget, walletUsd: 0, excess: 0,
      reason: '지갑 잔고를 몰라 예산 합계를 검증할 수 없습니다',
    };
  }
  const excess = totalBudget - walletUsd;
  if (excess > 0.01) {
    return {
      ok: false, totalBudget, walletUsd, excess,
      reason: `전략 예산 합계(${totalBudget.toFixed(2)})가 지갑(${walletUsd.toFixed(2)})보다 ` +
              `${excess.toFixed(2)} 많습니다. 두 전략이 같은 돈을 각자 자기 것으로 계산하게 됩니다.`,
    };
  }
  return { ok: true, totalBudget, walletUsd, excess: 0 };
}

// ── 충돌 ───────────────────────────────────────────────

export type ConflictCode =
  | 'OPPOSITE_DIRECTION'   // 같은 종목에 서로 반대 방향
  | 'SAME_DIRECTION_STACK' // 같은 방향으로 쌓임 — 위험이 집중된다
  | 'SPOT_FUTURES_HEDGE';  // 현물 보유 + 선물 숏 — 의도적일 수 있다

export interface StrategyIntent {
  strategyId: string;
  symbol: string;
  market: MarketType;
  /** 선물은 부호, 현물은 양수 */
  qty: number;
}

export interface Conflict {
  code: ConflictCode;
  symbol: string;
  strategies: string[];
  /** 막아야 하는가, 알리기만 하면 되는가 */
  severity: 'block' | 'warn' | 'info';
  detail: string;
}

/**
 * 전략들의 의도가 서로 부딪히는지 본다.
 *
 * 반대 방향이 가장 위험하다. 같은 계좌에서 LONG과 SHORT를 동시에 내면
 * (One-way 모드에서는) 서로 상쇄되어 **둘 다 자기 포지션이 사라진다.**
 * 각자는 자기가 들고 있다고 믿는다.
 */
export function detectConflicts(intents: StrategyIntent[]): Conflict[] {
  const out: Conflict[] = [];
  const bySymbol = new Map<string, StrategyIntent[]>();
  for (const i of intents) {
    const k = `${i.market}:${i.symbol}`;
    if (!bySymbol.has(k)) bySymbol.set(k, []);
    bySymbol.get(k)!.push(i);
  }

  for (const [, group] of bySymbol) {
    if (group.length < 2) continue;
    const symbol = group[0].symbol;
    const longs = group.filter(g => g.qty > 0);
    const shorts = group.filter(g => g.qty < 0);

    if (longs.length > 0 && shorts.length > 0) {
      out.push({
        code: 'OPPOSITE_DIRECTION', symbol,
        strategies: group.map(g => g.strategyId),
        severity: 'block',
        detail: `${symbol}에 ${longs.map(l => l.strategyId).join(',')}는 LONG, ` +
                `${shorts.map(s => s.strategyId).join(',')}는 SHORT입니다. ` +
                'One-way 모드에서는 서로 상쇄되어 양쪽 다 포지션을 잃습니다.',
      });
    } else {
      out.push({
        code: 'SAME_DIRECTION_STACK', symbol,
        strategies: group.map(g => g.strategyId),
        severity: 'warn',
        detail: `${symbol}에 ${group.length}개 전략이 같은 방향으로 들어갑니다. ` +
                '한 종목에 위험이 집중되고 청산가가 서로 당겨집니다.',
      });
    }
  }

  // 현물 보유 + 선물 숏은 헤지일 수 있다. 막지 않고 알린다 —
  // 막으면 정상적인 헤지 전략을 못 쓴다.
  const spotSymbols = new Set(
    intents.filter(i => i.market === 'SPOT' && i.qty > 0).map(i => i.symbol));
  for (const i of intents) {
    if (i.market === 'SPOT' || i.qty >= 0) continue;
    if (!spotSymbols.has(i.symbol)) continue;
    out.push({
      code: 'SPOT_FUTURES_HEDGE', symbol: i.symbol,
      strategies: [i.strategyId],
      severity: 'info',
      detail: `${i.symbol} 현물을 보유한 채 선물 SHORT입니다 — 헤지로 보입니다. ` +
              '총 순노출을 확인하세요.',
    });
  }

  return out;
}

export type ConflictPolicy =
  | 'BLOCK'      // 충돌하면 둘 다 보류
  | 'PRIORITY'   // 우선순위가 높은 전략만 실행
  | 'ISOLATE'    // 헤지 모드로 분리 (거래소가 지원할 때만)
  | 'ALLOW';     // 알리기만 하고 진행

export interface Resolution {
  proceed: string[];
  blocked: string[];
  reason: string;
}

/**
 * 충돌을 어떻게 처리할지 정한다.
 *
 * ALLOW를 기본값으로 두지 않는다. 기본이 '진행'이면 설정을 안 한
 * 사용자가 가장 위험한 조합을 그대로 실행하게 된다.
 */
export function resolveConflict(
  conflict: Conflict,
  policy: ConflictPolicy,
  priority: string[] = [],
): Resolution {
  const all = conflict.strategies;

  if (conflict.severity === 'info' || policy === 'ALLOW') {
    return { proceed: all, blocked: [], reason: `${policy} 정책 — 진행합니다` };
  }

  if (policy === 'BLOCK') {
    return {
      proceed: [], blocked: all,
      reason: `${conflict.code} — 모두 보류했습니다. 사람이 정해야 합니다.`,
    };
  }

  if (policy === 'PRIORITY') {
    // 우선순위 목록에서 가장 앞선 전략 하나만
    const winner = priority.find(p => all.includes(p));
    if (!winner) {
      return {
        proceed: [], blocked: all,
        reason: '우선순위가 정해지지 않아 모두 보류했습니다',
      };
    }
    return {
      proceed: [winner], blocked: all.filter(s => s !== winner),
      reason: `우선순위에 따라 ${winner}만 실행합니다`,
    };
  }

  // ISOLATE — 헤지 모드가 켜져 있어야 의미가 있다.
  // 이 함수는 거래소 설정을 모르므로 진행 여부를 단정하지 않는다.
  return {
    proceed: [], blocked: all,
    reason: 'ISOLATE 정책은 거래소 Hedge 모드가 필요합니다. ' +
            '설정을 확인하기 전까지 보류합니다.',
  };
}

// ─────────────────────────────────────────────────────────────
// TRAIGO Hub Accounts — Sell Actions
// "한 번에 파는 기능" / 비율 매도 / 조건 매도
// 실거래 연결 전: mock state만 갱신
// ─────────────────────────────────────────────────────────────

import type { HubState, HubAccount, HubPosition, SellScope } from './types';
import { positionUnrealized } from './store';

interface MatchOptions {
  scope: SellScope;
}

// 매도 대상 포지션 필터링
export function matchPositions(state: HubState, opts: MatchOptions): HubPosition[] {
  if (!state || !Array.isArray(state.accounts)) return [];
  const all: HubPosition[] = [];
  for (const acc of state.accounts) {
    if (!acc || !Array.isArray(acc.positions)) continue;
    for (const p of acc.positions) {
      const pnl = positionUnrealized(p);
      switch (opts.scope) {
        case 'all':
          all.push(p); break;
        case 'shortterm_only':
          if (acc.kind === 'shortterm') all.push(p); break;
        case 'longterm_only':
          if (acc.kind === 'longterm') all.push(p); break;
        case 'crypto_perp':
          if (p.assetClass === 'crypto_perp') all.push(p); break;
        case 'stock_only':
          if (p.assetClass === 'stock' || p.assetClass === 'etf') all.push(p); break;
        case 'profit_only':
          if (pnl > 0) all.push(p); break;
        case 'loss_only':
          if (pnl < 0) all.push(p); break;
      }
    }
  }
  return all;
}

// 매도 실행 (mock) — ratio % 만큼 청산
export interface SellExecutionResult {
  closedCount: number;
  reducedCount: number;
  totalRealized: number;
  totalCashReturned: number;
  state: HubState;
}

export function executeSell(state: HubState, scope: SellScope, ratio: 25 | 50 | 75 | 100): SellExecutionResult {
  const targets = matchPositions(state, { scope });
  const targetIds = new Set(targets.map(t => t.id));

  let closedCount = 0;
  let reducedCount = 0;
  let totalRealized = 0;
  let totalCashReturned = 0;

  const newAccounts: HubAccount[] = state.accounts.map(acc => {
    if (!acc || !Array.isArray(acc.positions)) return acc;
    let accRealized = 0;
    let accCash = 0;

    const newPositions: HubPosition[] = [];
    for (const p of acc.positions) {
      if (!targetIds.has(p.id)) {
        newPositions.push(p);
        continue;
      }
      const sellQty = p.qty * (ratio / 100);
      const direction = p.side === 'short' ? -1 : 1;
      const realized = (p.currentPrice - p.avgPrice) * sellQty * direction;
      // 회수 현금: 현물은 currentPrice * sellQty, 선물은 마진 회수가 복잡하므로 단순화 — 평단 * 수량 + 손익
      const cashReturned = p.side === 'spot'
        ? p.currentPrice * sellQty
        : (p.avgPrice * sellQty / (p.leverage || 1)) + realized; // 마진 + 실현손익

      accRealized += realized;
      accCash += cashReturned;
      totalRealized += realized;
      totalCashReturned += cashReturned;

      if (ratio === 100) {
        closedCount += 1;
        // 포지션 제거
      } else {
        reducedCount += 1;
        newPositions.push({ ...p, qty: p.qty - sellQty });
      }
    }

    return {
      ...acc,
      positions: newPositions,
      realizedPnl: (acc.realizedPnl || 0) + accRealized,
      todayPnl: (acc.todayPnl || 0) + accRealized,
      cash: (acc.cash || 0) + accCash,
      balance: (acc.balance || 0) + accRealized,
    };
  });

  const newState: HubState = {
    ...state,
    accounts: newAccounts,
    recentSellActions: [
      { at: Date.now(), scope, ratio, pnl: totalRealized },
      ...(Array.isArray(state.recentSellActions) ? state.recentSellActions.slice(0, 19) : []),
    ],
  };

  return { closedCount, reducedCount, totalRealized, totalCashReturned, state: newState };
}

// 사람이 읽는 라벨
export const SELL_SCOPE_LABEL: Record<SellScope, string> = {
  all:            '전체 매도',
  shortterm_only: '단타 계좌만',
  longterm_only:  '장투 계좌만',
  crypto_perp:    '코인 선물만',
  stock_only:     '주식만',
  profit_only:    '수익 중인 포지션만',
  loss_only:      '손실 중인 포지션만',
};

export const SELL_SCOPE_DESC: Record<SellScope, string> = {
  all:            '모든 계좌의 모든 포지션을 청산합니다.',
  shortterm_only: '장투/현금은 그대로 두고 단타만 정리합니다.',
  longterm_only:  '장투 포지션만 매도합니다 (신중하게).',
  crypto_perp:    '코인 선물 포지션만 종료합니다.',
  stock_only:     '주식/ETF만 매도합니다.',
  profit_only:    '수익 중인 포지션만 익절합니다.',
  loss_only:      '손실 중인 포지션만 손절합니다.',
};

// ─────────────────────────────────────────────────────────────
// TRAIGO Hub Accounts — Emergency Exit
// 위험한 장에서 한 번에 정리하는 "긴급 탈출 모드"
// 순서:
//   1. 모든 자동매매 봇 OFF
//   2. 레버리지 포지션 우선 시장가 종료
//   3. 모든 선물 포지션 시장가 종료
//   4. 현물/장투 매도는 사용자 선택
//   5. 결과 요약 반환
// ─────────────────────────────────────────────────────────────

import type { HubState, HubAccount, HubPosition, EmergencyResult } from './types';
import { positionUnrealized } from './store';

export interface EmergencyOptions {
  closeSpot: boolean;      // 현물도 함께 매도할지
  closeLongterm: boolean;  // 장투도 함께 매도할지
}

export interface EmergencyExecutionResult {
  result: EmergencyResult;
  state: HubState;
}

export function executeEmergency(state: HubState, opts: EmergencyOptions): EmergencyExecutionResult {
  let stoppedBots = 0;
  let closedPerpPositions = 0;
  let closedLeveraged = 0;
  let closedSpot = 0;
  let notClosed = 0;
  let realizedPnl = 0;
  let cashRecovered = 0;

  const newAccounts: HubAccount[] = state.accounts.map(acc => {
    if (!acc) return acc;

    // 1. 봇 정지
    let newBotActive = acc.botActive;
    if (acc.botActive) {
      stoppedBots += 1;
      newBotActive = false;
    }

    // 2~4. 포지션별 청산 결정
    const remaining: HubPosition[] = [];
    let accRealized = 0;
    let accCash = 0;

    const positions = Array.isArray(acc.positions) ? acc.positions : [];
    // 레버리지 우선 정리 — leverage 큰 것부터 정렬
    const sorted = [...positions].sort((a, b) => (b.leverage || 0) - (a.leverage || 0));

    for (const p of sorted) {
      const isPerp = p.assetClass === 'crypto_perp';
      const isLeveraged = (p.leverage || 1) > 1;
      const isSpot = p.side === 'spot' || p.assetClass === 'crypto_spot' || p.assetClass === 'stock' || p.assetClass === 'etf';

      let shouldClose = false;
      if (isPerp || isLeveraged) {
        shouldClose = true; // 선물/레버리지는 무조건 정리
      } else if (isSpot && acc.kind === 'longterm') {
        shouldClose = opts.closeLongterm;
      } else if (isSpot) {
        shouldClose = opts.closeSpot;
      } else {
        shouldClose = true; // 그 외 (commodity 등) 모두 청산
      }

      if (!shouldClose) {
        notClosed += 1;
        remaining.push(p);
        continue;
      }

      const direction = p.side === 'short' ? -1 : 1;
      const r = (p.currentPrice - p.avgPrice) * p.qty * direction;
      const cash = p.side === 'spot'
        ? p.currentPrice * p.qty
        : (p.avgPrice * p.qty / (p.leverage || 1)) + r;

      accRealized += r;
      accCash += cash;
      realizedPnl += r;
      cashRecovered += cash;

      if (isLeveraged) closedLeveraged += 1;
      if (isPerp) closedPerpPositions += 1;
      if (isSpot && shouldClose) closedSpot += 1;
    }

    return {
      ...acc,
      botActive: newBotActive,
      positions: remaining,
      realizedPnl: (acc.realizedPnl || 0) + accRealized,
      todayPnl: (acc.todayPnl || 0) + accRealized,
      cash: (acc.cash || 0) + accCash,
      balance: (acc.balance || 0) + accRealized,
    };
  });

  const result: EmergencyResult = {
    ranAt: Date.now(),
    stoppedBots,
    closedPerpPositions,
    closedLeveraged,
    closedSpot,
    notClosed,
    realizedPnl,
    cashRecovered,
  };

  const newState: HubState = {
    ...state,
    accounts: newAccounts,
    emergencyMode: true,
    lastEmergencyResult: result,
  };

  return { result, state: newState };
}

// 긴급 모드 해제 (다시 매매 재개)
export function deactivateEmergency(state: HubState): HubState {
  return { ...state, emergencyMode: false };
}

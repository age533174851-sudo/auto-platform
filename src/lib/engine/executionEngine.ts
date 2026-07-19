// src/lib/engine/executionEngine.ts
// Order Execution Engine — 여러 전략의 주문을 넷/헤지/격리 모드로 조정 후 실행.
// 문서 지적: 무조건 순포지션으로 합치면 전략별 손익 추적 불가 → 3가지 모드 지원.
import type { PositionPlan } from './riskManager';

export type PositionMode = 'net' | 'hedge' | 'isolation';

export interface StrategyOrder {
  strategyId: string;
  bucket: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  positionSize: number;    // 명목가치 $
  leverage: number;
}

export interface ResolvedPosition {
  symbol: string;
  mode: PositionMode;
  // net 모드
  netSide?: 'LONG' | 'SHORT' | 'FLAT';
  netSize?: number;
  // hedge/isolation 모드
  legs?: Array<{ strategyId: string; side: 'LONG' | 'SHORT'; size: number; leverage: number }>;
  note: string;
}

// 여러 전략 주문을 모드에 따라 조정
export function resolvePositions(orders: StrategyOrder[], mode: PositionMode): ResolvedPosition[] {
  // 심볼별 그룹핑
  const bySymbol: Record<string, StrategyOrder[]> = {};
  for (const o of orders) (bySymbol[o.symbol] ||= []).push(o);

  const results: ResolvedPosition[] = [];
  for (const [symbol, group] of Object.entries(bySymbol)) {
    if (mode === 'net') {
      // 모든 주문을 하나의 순포지션으로 합산
      let net = 0;
      for (const o of group) net += o.side === 'LONG' ? o.positionSize : -o.positionSize;
      const netSide = net > 0 ? 'LONG' : net < 0 ? 'SHORT' : 'FLAT';
      results.push({ symbol, mode, netSide, netSize: Math.abs(net),
        note: `${group.length}개 전략 → 순포지션 ${netSide} $${Math.abs(net).toFixed(0)}` });
    } else if (mode === 'hedge') {
      // 롱/숏을 따로 유지 (양방향 동시 보유)
      const longs = group.filter(o => o.side === 'LONG');
      const shorts = group.filter(o => o.side === 'SHORT');
      const legs = [
        ...(longs.length ? [{ strategyId: `${longs.length}개 롱`, side: 'LONG' as const, size: longs.reduce((a, b) => a + b.positionSize, 0), leverage: Math.max(...longs.map(l => l.leverage)) }] : []),
        ...(shorts.length ? [{ strategyId: `${shorts.length}개 숏`, side: 'SHORT' as const, size: shorts.reduce((a, b) => a + b.positionSize, 0), leverage: Math.max(...shorts.map(s => s.leverage)) }] : []),
      ];
      results.push({ symbol, mode, legs, note: `헤지 모드 — 롱 $${legs.find(l=>l.side==='LONG')?.size.toFixed(0)||0} / 숏 $${legs.find(l=>l.side==='SHORT')?.size.toFixed(0)||0} 별도 유지` });
    } else {
      // isolation: 전략별 완전 분리 (각자 가상 포트폴리오)
      const legs = group.map(o => ({ strategyId: o.strategyId, side: o.side, size: o.positionSize, leverage: o.leverage }));
      results.push({ symbol, mode, legs, note: `전략 격리 모드 — ${group.length}개 전략 독립 운영` });
    }
  }
  return results;
}

// 충돌 감지: 같은 심볼에 롱/숏이 동시에 있으면 경고
export interface Conflict { symbol: string; type: 'opposing' | 'overexposed'; detail: string }

export function detectConflicts(orders: StrategyOrder[], accountEquity: number): Conflict[] {
  const conflicts: Conflict[] = [];
  const bySymbol: Record<string, StrategyOrder[]> = {};
  for (const o of orders) (bySymbol[o.symbol] ||= []).push(o);

  for (const [symbol, group] of Object.entries(bySymbol)) {
    const hasLong = group.some(o => o.side === 'LONG');
    const hasShort = group.some(o => o.side === 'SHORT');
    if (hasLong && hasShort) {
      conflicts.push({ symbol, type: 'opposing', detail: `${symbol}에 롱·숏 동시 존재 — 넷/헤지 모드 선택 필요` });
    }
    const totalNotional = group.reduce((a, b) => a + b.positionSize, 0);
    if (totalNotional > accountEquity * 3) {
      conflicts.push({ symbol, type: 'overexposed', detail: `${symbol} 명목가치 $${totalNotional.toFixed(0)} — 계좌 3배 초과` });
    }
  }
  return conflicts;
}

// 실행 시뮬레이션 (paper) — 실제 거래소 대신 체결 결과 반환
export interface ExecutionResult { ok: boolean; orderId: string; symbol: string; side: string; size: number; leverage: number; filledAt: number; mode: PositionMode }

export function simulateExecution(resolved: ResolvedPosition[], mode: PositionMode): ExecutionResult[] {
  const out: ExecutionResult[] = [];
  for (const r of resolved) {
    if (mode === 'net' && r.netSide && r.netSide !== 'FLAT') {
      out.push({ ok: true, orderId: 'sim_' + Math.random().toString(36).slice(2, 9), symbol: r.symbol, side: r.netSide, size: r.netSize || 0, leverage: 1, filledAt: Date.now(), mode });
    } else if (r.legs) {
      for (const leg of r.legs) out.push({ ok: true, orderId: 'sim_' + Math.random().toString(36).slice(2, 9), symbol: r.symbol, side: leg.side, size: leg.size, leverage: leg.leverage, filledAt: Date.now(), mode });
    }
  }
  return out;
}

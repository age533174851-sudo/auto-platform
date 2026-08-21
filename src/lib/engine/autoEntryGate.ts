// src/lib/engine/autoEntryGate.ts
//
// **자동으로 열리는 모든 주문은 같은 문을 지난다.**
//
// 감사에서 나온 것: 관문 검사가 `src/app/api/autotrade/*/route.ts`만
// 보고 있었다. 그 바깥에 자동 진입 경로가 더 있었다.
//
//   webhook/tradingview   외부 신호 → executeOrder
//   webhook/signal        외부 신호 → executeOrder
//
// 둘 다 사람 없이, 외부가 보낸 신호로, 반복해서 주문을 낸다. 그런데
// 마이그레이션·청산감시·지문·소유권·전략계좌 관문을 **하나도 지나지
// 않았다.** 워커 경로에 여섯 겹을 쌓아 두고 옆문이 열려 있던 셈이다.
//
// 왜 합성 함수인가
// ────────────────
// 관문 여섯 개를 라우트마다 따로 부르면, 새 경로가 생길 때 다섯 개만
// 복사하는 일이 반드시 생긴다. **한 번 부르면 여섯이 다 도는 문**을
// 하나 두고 모두 그것을 부른다.
//
// 무엇을 막고 무엇을 안 막나
// ─────────────────────────
// 막는 것은 **새로 여는 것뿐이다.** 청산·보호주문 정리·대조는 이 문을
// 지나지 않는다 — 못 여는 것은 불편이고 못 닫는 것은 사고다.

export type EntryBlockCode =
  | 'KILL_SWITCH'
  | 'MIGRATION_PENDING'
  | 'EXIT_MONITOR_STALE'
  | 'SECRET_MISMATCH'
  | 'STRATEGY_CONFLICT'
  | 'SLEEVE_BLOCKED'
  | 'GATE_UNKNOWN';

export interface EntryBlock {
  code: EntryBlockCode;
  message: string;
  /** 확인하지 못해서 막은 것인가 (고장이 아니라 모름) */
  unknown: boolean;
}

export interface EntryGateResult {
  allowed: boolean;
  blocks: EntryBlock[];
  /** 화면·로그에 그대로 쓸 한 줄 */
  reason: string;
  /** 지나간 관문 이름 — 무엇을 실제로 봤는지 증거로 남긴다 */
  passed: string[];
}

/**
 * 자동 진입 관문 여섯 겹.
 *
 * 순서가 있다. **사용자가 누른 정지(킬스위치)를 가장 먼저** 본다 —
 * 사람이 멈추라고 한 것을 다른 이유로 덮지 않는다.
 */
export async function autoEntryGate(sb: any, i: {
  userId: string;
  strategyId: string;
  symbol: string;
  connectionId: string;
  /** 지금 시각. 시험에서 고정하기 위해 받는다 */
  nowMs?: number;
}): Promise<EntryGateResult> {
  const blocks: EntryBlock[] = [];
  const passed: string[] = [];
  const nowMs = Number.isFinite(i?.nowMs as number) ? (i.nowMs as number) : Date.now();

  // 1. 사용자가 누른 정지
  try {
    const { killSwitchGate } = await import('../risk/killSwitch');
    const g = await killSwitchGate(sb, i.connectionId);
    if (!g.allowed) blocks.push({ code: 'KILL_SWITCH', message: g.message, unknown: false });
    else passed.push('killSwitch');
  } catch (e: any) {
    // **확인하지 못한 것은 통과가 아니다.**
    blocks.push({ code: 'GATE_UNKNOWN', unknown: true,
      message: `킬스위치를 확인하지 못했습니다: ${String(e?.message || e).slice(0, 120)}` });
  }

  // 2. DB가 코드를 따라왔는가
  try {
    const { migrationGate } = await import('../system/migrationGate');
    const m = await migrationGate(sb);
    if (!m.entryAllowed) {
      blocks.push({ code: 'MIGRATION_PENDING', message: m.entryReason, unknown: m.code === 'UNKNOWN' });
    } else passed.push('migration');
  } catch (e: any) {
    blocks.push({ code: 'GATE_UNKNOWN', unknown: true,
      message: `마이그레이션 상태를 확인하지 못했습니다: ${String(e?.message || e).slice(0, 120)}` });
  }

  // 3. 웹과 워커가 같은 것을 보고 있는가
  try {
    const { parityGate } = await import('../ops/parityGate');
    const p = await parityGate(sb);
    if (!p.entryAllowed) blocks.push({ code: 'SECRET_MISMATCH', message: p.entryReason, unknown: false });
    else passed.push('parity');
  } catch (e: any) {
    // 지문 비교가 고장 나서 매매를 멈추지는 않는다 — 사실만 남긴다.
    passed.push('parity(확인 실패)');
  }

  // 4. 닫아 줄 사람이 있는가
  try {
    const { exitMonitorGate } = await import('./exitMonitorGate');
    const em = await exitMonitorGate(sb, nowMs);
    if (em.blockEntry) blocks.push({ code: 'EXIT_MONITOR_STALE', message: em.reason, unknown: false });
    else passed.push('exitMonitor');
  } catch (e: any) {
    passed.push('exitMonitor(확인 실패)');
  }

  // 5. 같은 종목에 다른 전략이 켜져 있는가
  try {
    const { strategyConflictGate } = await import('./strategyConflictGate');
    const c = await strategyConflictGate(sb, {
      userId: i.userId, myStrategyId: i.strategyId, symbol: i.symbol, connectionId: i.connectionId,
    });
    if (!c.ok) {
      blocks.push({ code: 'STRATEGY_CONFLICT', message: c.reason, unknown: c.code === 'SCHEDULES_UNKNOWN' });
    } else passed.push('strategyConflict');
  } catch (e: any) {
    blocks.push({ code: 'GATE_UNKNOWN', unknown: true,
      message: `다른 전략과 겹치는지 확인하지 못했습니다: ${String(e?.message || e).slice(0, 120)}` });
  }

  // 6. 이 전략 계좌에 쓸 돈이 있는가
  try {
    const { sleeveCapitalGate } = await import('./strategyConflictGate');
    const s = await sleeveCapitalGate(sb, {
      userId: i.userId, strategyId: i.strategyId, connectionId: i.connectionId,
    });
    if (!s.allowed) {
      blocks.push({ code: 'SLEEVE_BLOCKED', message: s.reason, unknown: s.code === 'UNKNOWN' });
    } else passed.push('sleeveCapital');
  } catch (e: any) {
    blocks.push({ code: 'GATE_UNKNOWN', unknown: true,
      message: `전략 계좌를 확인하지 못했습니다: ${String(e?.message || e).slice(0, 120)}` });
  }

  if (blocks.length === 0) {
    return { allowed: true, blocks: [], passed, reason: `관문 ${passed.length}겹을 지났습니다` };
  }
  return {
    allowed: false, blocks, passed,
    reason: blocks.map(b => b.message).join(' · '),
  };
}

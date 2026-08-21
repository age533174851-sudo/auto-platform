// src/lib/engine/strategyConflictGate.ts
//
// **같은 판단을 세 곳에 복사해 두지 않는다.**
//
// `symbolOwnershipConflict()`는 #4-a에서 만들어졌고, `my-original-v1`
// **한 곳에서만** 쓰이고 있었다. `daily-ladder`와 `scalp`는 같은 계좌에
// 같은 종목으로 들어갈 수 있는데도 이 검사를 지나지 않았다.
//
// 이 저장소에서 가장 자주 난 고장 두 개 중 하나가 정확히 이것이다 —
// **경로가 둘인데 한쪽만 고침.** 그래서 읽기와 판정을 여기 한 곳에 두고
// 세 라우트가 같은 함수를 부른다. 새 진입 경로가 생기면 이 함수를
// 부르지 않는 한 CI가 잡는다(`scripts/check-entry-gates.mjs`).
//
// 왜 종목 하나에 전략 하나인가
// ───────────────────────────
// ONE_WAY 계좌는 종목당 포지션이 하나다. daily-ladder BTCUSDT와
// my-original-v1 BTCUSDT가 둘 다 켜져 있으면:
//
//   · 한쪽의 청산이 다른 쪽 포지션을 닫는다
//   · 한쪽의 손절이 다른 쪽 진입에 발동한다
//
// **주문에 소유권을 새겨도 포지션은 가를 수 없다.** 포지션 단위 소유권이
// 생기기 전까지는 같은 종목에 두 전략을 동시에 돌리지 않는다.
import { symbolOwnershipConflict, type ConflictVerdict } from './orderOwnership';

/**
 * 이 전략이 이 종목·이 연결로 들어가도 되는가.
 *
 * **못 읽으면 통과가 아니다.** 예약 표를 못 읽었는데 "겹치는 것 없음"으로
 * 읽으면, 정확히 막으려던 상황에서 막지 못한다.
 */
export async function strategyConflictGate(sb: any, i: {
  userId: string;
  myStrategyId: string;
  symbol: string;
  connectionId?: string | null;
}): Promise<ConflictVerdict> {
  let rows: any[] | null = null;
  try {
    const { data, error } = await (sb as any).from('autotrade_schedules')
      .select('symbol, connection_id, strategy_id, enabled')
      .eq('user_id', i.userId);
    if (!error) rows = Array.isArray(data) ? data : [];
    // 표가 없으면(031 이전) rows는 null로 남는다 — 그건 '겹침 없음'이 아니다.
  } catch { /* null */ }

  return symbolOwnershipConflict({
    rows,
    myStrategyId: i.myStrategyId,
    symbol: i.symbol,
    connectionId: i.connectionId ?? null,
  });
}

// ── 전략 계좌(sleeve) 관문 ──

export interface SleeveVerdict {
  allowed: boolean;
  code: 'OK' | 'NO_SLEEVE' | 'STAGE_NOT_LIVE' | 'DRAWDOWN' | 'NO_CASH' | 'UNKNOWN';
  reason: string;
  /** 이 전략이 지금 쓸 수 있는 돈 */
  availableUsd: number | null;
}

/**
 * 이 전략 계좌에 쓸 돈이 있는가.
 *
 * **다른 전략의 돈을 끌어오지 않는다.** 한 계좌를 여럿이 나눠 쓸 때
 * 잔고 전체를 자기 몫으로 읽으면, 먼저 들어간 쪽이 남의 증거금까지
 * 쓰고 나중 쪽이 진입에 실패한다.
 *
 * 세 가지를 가른다
 * ────────────────
 *   표가 없다        이 기능을 아직 안 쓴다 → 막지 않는다
 *   배정이 없다      이 전략은 sleeve를 안 쓴다 → 막지 않는다
 *   **읽지 못했다**  돈의 소유권을 모른다 → **막는다**
 *
 * 처음에는 셋째도 막지 않았다. "조회 실패로 매매가 멎으면 그게 더 큰
 * 사고"라고 봤기 때문이다. 그건 틀렸다 — **돈의 소유권을 못 읽었는데
 * 진입을 허용하면, 정확히 이 관문이 막으려던 상황(남의 증거금을 쓰는
 * 진입)에서 막지 못한다.**
 *
 * 그리고 막는 것은 **새로 여는 것뿐이다.** 이미 열린 포지션의 청산·
 * 보호주문 정리는 이 관문을 지나지 않는다.
 */
export async function sleeveCapitalGate(sb: any, i: {
  userId: string;
  strategyId: string;
  connectionId?: string | null;
  /** 실전 자금을 쓰는 주문인가 */
  requireLive?: boolean;
}): Promise<SleeveVerdict> {
  try {
    const { data, error } = await (sb as any).from('strategy_accounts')
      .select('*').eq('user_id', i.userId).eq('strategy_id', i.strategyId).maybeSingle();

    if (error) {
      if (/does not exist|schema cache|relation/i.test(String(error.message))) {
        // 041이 아직이다. 이 기능이 없던 때와 같이 동작한다 — 지금까지
        // sleeve 없이 돌던 전략이 갑자기 멈추면 안 된다.
        return { allowed: true, code: 'NO_SLEEVE', availableUsd: null,
          reason: '전략 계좌 표가 아직 없습니다 — 이 기준으로는 막지 않습니다' };
      }
      // **읽지 못한 것은 통과가 아니다.**
      return { allowed: false, code: 'UNKNOWN', availableUsd: null,
        reason: `전략 계좌를 읽지 못해 신규 진입을 막았습니다: ${String(error.message).slice(0, 150)} — `
          + '돈의 소유권을 모르는 채로 남의 증거금을 쓸 수 없습니다 '
          + '(이미 열린 포지션의 청산·보호는 계속 동작합니다)' };
    }
    if (!data) {
      return { allowed: true, code: 'NO_SLEEVE', availableUsd: null,
        reason: '이 전략에 배정된 계좌가 없습니다 — 이 기준으로는 막지 않습니다' };
    }

    const { sleeveGate, availableOf } = await import('../strategies/sleeveLedger');
    const spec = (data as any).spec ?? data;
    const state = (data as any).state ?? data;
    const g = sleeveGate(state as any, spec as any, { requireLive: !!i.requireLive });
    const available = availableOf(state as any);

    return {
      allowed: g.allowed,
      code: g.allowed ? 'OK' : ((g.halted as any) ?? 'UNKNOWN'),
      reason: g.reason,
      availableUsd: Number.isFinite(available) ? available : null,
    };
  } catch (e: any) {
    // 예외도 '못 읽음'이다. **예외를 통과로 읽지 않는다.**
    return { allowed: false, code: 'UNKNOWN', availableUsd: null,
      reason: `전략 계좌를 확인하지 못해 신규 진입을 막았습니다: ${String(e?.message || e).slice(0, 150)}` };
  }
}

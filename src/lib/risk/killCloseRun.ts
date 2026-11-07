// src/lib/risk/killCloseRun.ts
//
// **긴급 종료를 실제로 실행하는 순서 — 돌려서 증명할 수 있게 뗀다.**
//
// `killClosePlan`이 "무엇을 해도 되는가"를 정하고, 이 파일이 그 순서를
// 지켜 실행한다. 네트워크도 DB도 모른다 — 전부 주입받는다. 그래서 시험이
// 모드·타임아웃·부분 체결·중복 요청·재시작을 **sleep 없이** 재현한다.
//
// ★ 불변식 — 이 파일의 전부
// ─────────────────────────
//   ① 모드 관문 → 식별 → (닫을 수 있을 때만) 취소 → 종료 → 확인
//   ② `mayClose`가 거짓이면 **취소 0건 · 주문 0건**
//   ③ 모든 종료 주문은 **결정적 식별자**를 싣는다 (`killIntentId`)
//   ④ 재시도 전에 거래소에 **이미 있는지** 먼저 묻는다
//   ⑤ 조회 실패·결과 UNKNOWN을 **신규 주문 허가로 쓰지 않는다**
//   ⑥ 쓰기 직전 울타리를 재검증한다. 못 읽으면 쓰지 않는다
//   ⑦ 끝나고 **보호 상태**를 따로 판정한다 (`killProtectionVerdict`)
//
// ★ 보장하지 않는 것: 선점만으로 **이미 전송 중인** 주문은 취소되지
//   않는다. 그래서 ⑥은 "보내기 전"이고, 그 뒤의 겹침은 축소 전용
//   (`reduceOnly`)과 식별자 중복 인식, 그리고 마지막 재조회가 다룬다.

import {
  planKillClose, killProtectionVerdict,
  type KillClosePlan, type KillCloseTarget, type KillModeVerdictLike,
  type KillOpenOrderRow, type KillPositionRow, type KillProtectionVerdict,
} from './killClosePlan';
import { killIntentId, isDuplicateIntentError } from '../engine/exitIntent';

export type KillCloseRunCode =
  /** 보냈고 잔여 0을 확인했다 */
  | 'CLOSED_VERIFIED'
  /** 보냈는데 잔여가 남았다 */
  | 'CLOSE_INCOMPLETE'
  /** 보냈는지·닫혔는지 모른다 — 사람이 거래소와 대조해야 한다 */
  | 'CLOSE_UNKNOWN_RECONCILE_REQUIRED'
  /** 계획이 막았다. **주문 0건 · 취소 0건** */
  | 'BLOCKED'
  /** 닫을 노출이 없었다. 주문 0건 */
  | 'NOTHING_TO_DO'
  /** 쓰기 직전 울타리를 잃었다. **주문 0건** */
  | 'LEASE_LOST';

export interface KillCloseAttempt {
  symbol: string;
  clientOrderId: string;
  /** 주문을 **보냈는가** */
  sent: boolean;
  ok: boolean;
  /** 보냈는지 모른다 (타임아웃·중복 응답) */
  ambiguous: boolean;
  /** 이미 거래소에 있어서 보내지 않았다 */
  skippedExisting: boolean;
  /** 조회를 못 해서 보내지 않았다 */
  skippedUnknown: boolean;
  tries: number;
  message: string;
}

export interface KillCloseRunResult {
  code: KillCloseRunCode;
  plan: KillClosePlan;
  /** 취소를 **보냈는가**. 계획이 막으면 false */
  cancelAttempted: boolean;
  cancelOk: boolean | null;
  cancelledCount: number | null;
  attempts: KillCloseAttempt[];
  /** 실제로 거래소에 보낸 종료 주문 수 */
  ordersSent: number;
  leftoverPositions: number | null;
  protection: KillProtectionVerdict;
  reason: string;
}

export interface KillCloseDeps {
  /** 포지션 모드 관문 (`venuePositionOps.closeModeGate`를 싸서 넘긴다) */
  readMode(): Promise<KillModeVerdictLike>;
  readPositions(): Promise<{ ok: boolean; rows?: KillPositionRow[] | null }>;
  readOpenOrders(): Promise<{ ok: boolean; rows?: KillOpenOrderRow[] | null }>;
  /** **이 id들만** 취소한다. 목록을 통째로 지우지 않는다 */
  cancelOrders(ids: string[]): Promise<{ ok: boolean; cancelled?: number | null }>;
  /**
   * 한 심볼을 축소 전용으로 닫는다. `clientOrderId`를 **반드시** 싣는다.
   *
   * `ambiguous`는 "보냈는지 모른다"다 — 실패로 단정하면 안 나간 것으로
   * 읽혀 같은 자리에 또 보낸다.
   */
  closeOne(
    t: KillCloseTarget, clientOrderId: string,
  ): Promise<{ ok: boolean; ambiguous?: boolean; error?: string | null }>;
  /**
   * 이 식별자의 주문이 거래소에 **이미 있는가.**
   *
   * `ok:false`는 **못 물어봤다**는 뜻이고, 그때는 새 주문을 보내지 않는다.
   * 안 주면 재시도 전 확인을 할 수 없으므로 **재시도하지 않는다**.
   */
  findByClientId?(
    symbol: string, clientOrderId: string,
  ): Promise<{ ok: boolean; found: boolean }>;
  /** 종료 뒤 잔여. `positions: null`이면 **못 읽었다** */
  readLeftover(): Promise<{ ok: boolean; positions?: number | null }>;
  /**
   * 쓰기 직전 울타리 재검증. 안 주면 확인하지 않는다(예전 동작).
   *
   * **못 읽으면 거짓으로 떨어뜨린다** — 호출부가 그렇게 싸서 넘긴다.
   */
  stillMine?(): Promise<boolean>;
}

export interface KillCloseArgs {
  connectionId: string;
  exchange: 'binance' | 'gate';
  /** 어느 단계의 긴급 종료인가. 식별자에 들어간다 */
  actionMode: string;
  /** 닫기로 한 심볼. 비면 읽은 포지션 전체 */
  targetSymbols?: readonly string[] | null;
  /** 심볼당 최대 시도 수. 기본 3 */
  maxTriesPerSymbol?: number;
}

const blockedResult = (
  code: KillCloseRunCode, plan: KillClosePlan, reason: string,
): KillCloseRunResult => {
  // ★ **아는 것과 모르는 것을 구분한다.**
  //
  //   `NOTHING_TO_DO`는 포지션을 **읽었고 비어 있었다**는 뜻이다 —
  //   잔여 0을 아는 상태다. 그걸 `null`로 넘기면 보호 판정이
  //   `UNKNOWN`(수동 개입 필요)이 되고, 할 일이 없는 회차마다 운영자를
  //   부른다. 그러면 정말 불러야 할 때의 경고가 묻힌다.
  //
  //   그 외(모드 미확인·포지션 미조회 등)는 **모르는 것이 맞다** → null.
  const leftover = plan.code === 'NOTHING_TO_DO' ? 0 : null;
  return {
    code, plan,
    cancelAttempted: false, cancelOk: null, cancelledCount: null,
    attempts: [], ordersSent: 0, leftoverPositions: leftover,
    protection: killProtectionVerdict({
      plan, cancelAttempted: false, leftoverPositions: leftover,
    }),
    reason,
  };
};

/**
 * 긴급 종료 한 회차.
 *
 * 순서는 `KILL_CLOSE_SEQUENCE`이고, 각 단계는 앞 단계가 참일 때만
 * 일어난다 — 막히면 **그 아래 deps는 아예 호출되지 않는다.** 시험이
 * 호출 횟수로 그것을 센다.
 */
export async function runKillClose(
  args: KillCloseArgs, deps: KillCloseDeps,
): Promise<KillCloseRunResult> {
  // ── ① 모드 관문 (가장 먼저) ──
  let mode: KillModeVerdictLike;
  try { mode = await deps.readMode(); }
  catch (e: any) {
    mode = { ok: false, code: 'UNKNOWN', mode: null,
      message: `포지션 모드를 읽지 못했습니다 — ${String(e?.message || e)}` };
  }

  // ── ② 식별 ──
  //
  // ★ 모드가 막혔어도 포지션은 읽는다. **무엇이 열려 있는지 적어야**
  //   운영자가 거래소에서 직접 닫을 수 있다 — 조회는 주문이 아니다.
  let positions: { ok: boolean; rows?: KillPositionRow[] | null };
  try { positions = await deps.readPositions(); }
  catch { positions = { ok: false, rows: null }; }

  let openOrders: { ok: boolean; rows?: KillOpenOrderRow[] | null };
  try { openOrders = await deps.readOpenOrders(); }
  catch { openOrders = { ok: false, rows: null }; }

  const plan = planKillClose({
    modeVerdict: mode, positions, openOrders,
    targetSymbols: args?.targetSymbols ?? null,
  });

  if (plan.mayClose !== true) {
    // **주문 0건 · 취소 0건.** 보호주문은 그대로 남아 있다.
    return blockedResult(
      plan.code === 'NOTHING_TO_DO' ? 'NOTHING_TO_DO' : 'BLOCKED',
      plan, plan.reason);
  }

  // ── ③ 쓰기 직전 울타리 재검증 ──
  //
  // 취소보다 **앞**이다. 임차를 잃은 실행자가 남의 보호주문을 지우고
  // 끝나면 그게 이 파일이 막으려는 상태다.
  if (typeof deps.stillMine === 'function') {
    let mine = false;
    try { mine = await deps.stillMine(); }
    catch { mine = false; }          // 못 읽으면 쓰지 않는다
    if (mine !== true) {
      return blockedResult('LEASE_LOST', plan,
        '쓰기 직전 실행 권한(임차)이 내 것이 아니었습니다 — 주문 0건·취소 0건');
    }
  }

  // ── ④ 취소 — **대상 심볼의, 식별된 주문만** ──
  let cancelAttempted = false;
  let cancelOk: boolean | null = null;
  let cancelledCount: number | null = null;
  if (plan.mayCancel === true && plan.cancelIds.length > 0) {
    cancelAttempted = true;
    try {
      const r = await deps.cancelOrders(plan.cancelIds);
      cancelOk = r?.ok === true;
      cancelledCount = r?.cancelled ?? null;
    } catch { cancelOk = false; cancelledCount = null; }
  }

  // ── ⑤ 종료 ──
  const maxTries = Math.max(1, Math.min(5, Math.round(
    Number(args?.maxTriesPerSymbol) || 3)));
  const attempts: KillCloseAttempt[] = [];
  let ordersSent = 0;
  let anyAmbiguous = false;

  for (const t of plan.closes) {
    const clientOrderId = killIntentId({
      connectionId: args.connectionId, exchange: args.exchange,
      symbol: t.symbol, side: t.side,
      actionMode: args.actionMode, quantity: t.qty,
    });
    const a: KillCloseAttempt = {
      symbol: t.symbol, clientOrderId,
      sent: false, ok: false, ambiguous: false,
      skippedExisting: false, skippedUnknown: false,
      tries: 0, message: '',
    };

    for (let k = 1; k <= maxTries; k += 1) {
      // ★ **재시도 전에 거래소에 이미 있는지 먼저 묻는다.**
      //
      //   첫 시도에는 묻지 않는다 — 아직 보낸 적이 없다. 둘째부터
      //   묻고, 못 물어보면 **보내지 않는다**(조회 실패를 신규 주문
      //   허가로 쓰지 않는다).
      if (k > 1) {
        if (typeof deps.findByClientId !== 'function') {
          a.skippedUnknown = true;
          a.message = '재시도 전 주문 조회 수단이 없어 재전송하지 않았습니다';
          break;
        }
        let probe: { ok: boolean; found: boolean };
        try { probe = await deps.findByClientId(t.symbol, clientOrderId); }
        catch { probe = { ok: false, found: false }; }
        if (probe.ok !== true) {
          a.skippedUnknown = true;
          a.message = '이미 보냈는지 확인하지 못해 재전송하지 않았습니다'
            + ' — 조회 실패를 신규 주문 허가로 쓰지 않습니다';
          break;
        }
        if (probe.found === true) {
          a.skippedExisting = true;
          a.message = '같은 식별자의 주문이 거래소에 이미 있습니다 — 재전송하지 않았습니다';
          break;
        }
      }

      a.tries = k;
      let r: { ok: boolean; ambiguous?: boolean; error?: string | null };
      try { r = await deps.closeOne(t, clientOrderId); }
      catch (e: any) {
        r = { ok: false, ambiguous: true, error: String(e?.message || e) };
      }
      a.sent = true;
      ordersSent += 1;

      // **중복 식별자 거부는 실패가 아니다.** 같은 의도를 누군가 이미
      // 보냈다는 뜻이고, 결과는 재조회가 확정한다.
      if (r.ok !== true && isDuplicateIntentError(r.error)) {
        a.ambiguous = true;
        a.message = '같은 식별자가 이미 있다는 응답 — 실패로 적지 않고 재조회로 확정합니다';
        break;
      }
      if (r.ok === true) {
        a.ok = true;
        a.message = '접수';
        break;
      }
      if (r.ambiguous === true) {
        a.ambiguous = true;
        a.message = `보냈는지 모릅니다 — ${r.error || '응답 없음'}`;
        // 모호하면 **곧바로 재전송하지 않는다.** 다음 회차의 ④가
        // 거래소에 물어보고 결정한다.
        break;
      }
      a.message = r.error || '거부';
      // 명시적 거부는 다시 시도할 수 있다 — 다음 회차가 먼저 조회한다.
    }

    if (a.ambiguous) anyAmbiguous = true;
    attempts.push(a);
  }

  // ── ⑥ 확인 ──
  let leftover: number | null = null;
  try {
    const r = await deps.readLeftover();
    leftover = r?.ok === true ? (r.positions ?? null) : null;
  } catch { leftover = null; }

  const protection = killProtectionVerdict({
    plan, cancelAttempted, leftoverPositions: leftover,
  });

  const code: KillCloseRunCode =
    leftover == null ? 'CLOSE_UNKNOWN_RECONCILE_REQUIRED'
      : leftover <= 0 ? 'CLOSED_VERIFIED'
        : anyAmbiguous ? 'CLOSE_UNKNOWN_RECONCILE_REQUIRED'
          : 'CLOSE_INCOMPLETE';

  return {
    code, plan, cancelAttempted, cancelOk, cancelledCount,
    attempts, ordersSent, leftoverPositions: leftover, protection,
    reason: `${plan.reason} · ${protection.reason}`,
  };
}

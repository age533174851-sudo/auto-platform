// src/lib/engine/exitIntentStore.ts
//
// **청산 주문을 보내기 전에 보낸다는 사실을 남긴다.**
//
// 무엇이 없었나
// ─────────────
// 진입 경로(`orderExecutor`)는 거래소에 보내기 **전에** `live_orders`에
// `status: 'INTENT'` 행을 쓴다. 그래서 전송과 응답 사이에 프로세스가
// 죽어도, 재시작한 뒤 `client_order_id`로 "내가 보냈는가"를 물을 수 있다.
//
// 청산 경로에는 그것이 **없었다.** `venuePositionOps.sendSymbolClose`는
// payload를 만들어 거래소로 바로 보내고, 전후로 DB에 아무것도 쓰지
// 않는다. `lifecycleAction`도 쓰지 않는다. 즉 `clientOrderId`가
// **요청 메모리에만** 존재한다.
//
// 왜 그것이 사고가 되는가
// ───────────────────────
// 멱등 키는 지금 관측한 노출에서 만들어진다
// (`exitIntentId(connection, exchange, symbol, side, actionMode, quantity)`).
// 그래서 **부분 체결이 일어나면 다음 회차의 수량이 달라지고, 키도
// 달라진다.** 앞서 보낸 주문을 그 키로 더 이상 찾을 수 없다.
//
//     1회차  노출 0.010 → 키 A로 종료 주문 → 0.004만 체결 → 프로세스 죽음
//     2회차  노출 0.006 → 키 B 계산 → **키 A의 주문이 어떻게 됐는지 모른다**
//
// 열린 포지션이 남아 있으므로 다음 회차가 다시 닫으려 시도하는 것까지는
// 동작한다(통합 시험 ⑧-g). 그러나 "앞의 주문이 아직 살아 있는가"는
// 답할 수 없다. 그 상태에서 감시가 멈추면 아무 기록도 남지 않는다.
//
// 이 파일이 하는 일
// ─────────────────
// 기존 `live_orders` 표를 쓴다. **마이그레이션이 필요 없다** — 필요한
// 칸(`client_order_id` UNIQUE · `symbol` · `side` · `quantity` · `mode` ·
// `connection_id` · `reduce_only` · `status` · `exchange_order_id` ·
// `filled_qty`)이 이미 다 있다. 청산 행은 `reduce_only: true`로 구분되고,
// `managedPosition.ts:492`가 이미 그 행을 **진입으로 세지 않는다.**
//
// ★ **기록 실패가 청산 실패가 되지 않는다.**
//   DB에 못 썼다고 포지션에서 빠져나갈 길을 막으면, 못 여는 불편이
//   아니라 **못 닫는 사고**가 된다. `quantize.ts`가 규격 조회 실패에서
//   같은 판단을 적어 둔 것과 같은 방향이다. 그래서 이 모듈은 기록을
//   시도하고, 실패하면 **기록하지 못했다는 사실을 돌려주되 전송을
//   막지 않는다.**
//
// ★ 이 모듈은 주문을 보내지 않는다. 보낼 수단이 타입에 없다.

/** 청산 의도를 적을 때 필요한 사실. **시크릿을 받지 않는다** */
export interface ExitIntentRecord {
  /** 멱등 키. 거래소에 실리는 그 값이다 */
  clientOrderId: string;
  connectionId: string;
  exchange: string;
  /**
   * 'TESTNET' | 'LIVE' | 'MOCK' — 장부를 섞지 않기 위해 반드시 적는다.
   *
   * **null이면 기록하지 않는다.** 모드를 모른 채 적으면 어느 장부의
   * 청산인지 알 수 없고, 기본값으로 메우면 LIVE 청산이 TESTNET 장부에
   * 남는다. 그래도 전송은 막지 않는다.
   */
  mode: string | null;
  symbol: string;
  /** 보낼 주문 방향 (포지션의 반대) */
  orderSide: 'BUY' | 'SELL';
  /** 보낼 수량. 지금 관측한 노출에서 왔다 */
  quantity: number;
  userId?: string | null;
}

export type ExitIntentWriteCode =
  /** 새로 적었다 */
  | 'RECORDED'
  /** 같은 키의 행이 이미 있다 — 재시작·중복 워커의 정상 경로다 */
  | 'ALREADY_EXISTS'
  /** 적지 못했다. **전송을 막지 않는다** */
  | 'WRITE_FAILED'
  /** 적을 수단이 없다 (DB 핸들 없음) */
  | 'NO_STORE';

export interface ExitIntentWriteResult {
  code: ExitIntentWriteCode;
  /** 기록이 남았는가. false면 재시작 뒤 이 주문을 찾을 수 없다 */
  durable: boolean;
  /** 전송해도 되는가. **기록 실패에서도 참이다** */
  maySend: boolean;
  reason: string;
}

/** 최소한의 Supabase 모양. 전체 타입을 끌어오지 않는다 */
export interface MinimalStore {
  from(table: string): {
    insert(row: any): { select(cols: string): { single(): Promise<{ data: any; error: any }> } };
    update(patch: any): { eq(col: string, val: any): Promise<{ error: any }> };
    select(cols: string): {
      eq(col: string, val: any): any;
    };
  };
}

/** 이 상태의 청산 주문은 **아직 끝나지 않았다** */
export const PENDING_EXIT_STATUSES = ['INTENT', 'SENT', 'ACKED', 'UNKNOWN'] as const;

/**
 * 보내기 **전에** 적는다.
 *
 * 순서가 이 함수의 전부다. 전송 뒤에 적으면, 전송과 기록 사이에 죽는
 * 창이 그대로 남는다 — 그 창을 없애려고 만든 것이다.
 */
export async function recordExitIntent(
  sb: MinimalStore | null | undefined,
  r: ExitIntentRecord,
): Promise<ExitIntentWriteResult> {
  if (sb == null) {
    return { code: 'NO_STORE', durable: false, maySend: true,
      reason: '장부를 쓸 수 없습니다 — 기록 없이 전송합니다 (청산을 막지 않습니다)' };
  }
  const cid = String(r?.clientOrderId ?? '').trim();
  if (!cid) {
    return { code: 'WRITE_FAILED', durable: false, maySend: true,
      reason: '멱등 키가 없어 기록할 수 없습니다 — 전송은 막지 않습니다' };
  }
  const mode = String(r?.mode ?? '').trim();
  if (!mode) {
    // **모드를 메우지 않는다.** 어느 장부인지 모르는 행을 만들면
    // MOCK·TESTNET·LIVE가 섞이고, 그 섞임은 되돌릴 수 없다.
    return { code: 'WRITE_FAILED', durable: false, maySend: true,
      reason: '운영 모드를 읽지 못해 기록할 수 없습니다 — 기본값으로 메우지 않습니다. 전송은 막지 않습니다' };
  }
  try {
    const { error } = await sb.from('live_orders').insert({
      client_order_id: cid,
      connection_id: r.connectionId,
      exchange: r.exchange,
      mode,
      symbol: r.symbol,
      side: r.orderSide,
      quantity: r.quantity,
      // ★ 이 칸이 청산 행을 진입 행과 가른다. `managedPosition`이
      //   이것을 보고 진입으로 세지 않는다.
      reduce_only: true,
      order_type: 'MARKET',
      status: 'INTENT',
      ...(r.userId ? { user_id: r.userId } : {}),
    }).select('id, status').single();
    if (error) {
      // 23505 = unique 위반. **중복은 실패가 아니다** — 재시작했거나
      // 다른 워커가 같은 의도를 이미 적은 것이고, 둘 다 정상이다.
      if (String((error as any)?.code) === '23505') {
        return { code: 'ALREADY_EXISTS', durable: true, maySend: true,
          reason: '같은 멱등 키의 청산 의도가 이미 기록돼 있습니다' };
      }
      return { code: 'WRITE_FAILED', durable: false, maySend: true,
        reason: `청산 의도를 기록하지 못했습니다 — 전송은 막지 않습니다 (${String((error as any)?.code ?? 'unknown')})` };
    }
    return { code: 'RECORDED', durable: true, maySend: true, reason: '' };
  } catch (e: any) {
    return { code: 'WRITE_FAILED', durable: false, maySend: true,
      reason: `청산 의도 기록이 예외로 끝났습니다 — 전송은 막지 않습니다 (${String(e?.message ?? e).slice(0, 80)})` };
  }
}

export type ExitSendOutcome =
  /** 거래소가 접수했다 */
  | 'ACKED'
  /** 거래소가 거부했다 */
  | 'REJECTED'
  /** 보냈는지 접수됐는지 모른다 (타임아웃·연결 끊김) */
  | 'UNKNOWN';

/**
 * 전송 **뒤에** 결과를 적는다.
 *
 * ★ `UNKNOWN`을 `REJECTED`로 적지 않는다. 거부로 적으면 "안 나갔다"로
 *   읽혀 같은 자리에 또 보낸다.
 *
 * ★ 이 쓰기가 실패해도 호출부의 판정을 바꾸지 않는다. 행은 `INTENT`로
 *   남고, 그것은 **아직 끝나지 않은 상태**이므로 재시작이 다시 본다.
 */
export async function markExitIntentResult(
  sb: MinimalStore | null | undefined,
  clientOrderId: string,
  outcome: ExitSendOutcome,
  extra?: { exchangeOrderId?: string | null; executedQty?: number | null } | null,
): Promise<{ ok: boolean; reason: string }> {
  if (sb == null) return { ok: false, reason: '장부를 쓸 수 없습니다' };
  const cid = String(clientOrderId ?? '').trim();
  if (!cid) return { ok: false, reason: '멱등 키가 없습니다' };
  try {
    const { error } = await sb.from('live_orders').update({
      status: outcome,
      ...(extra?.exchangeOrderId != null
        ? { exchange_order_id: String(extra.exchangeOrderId) } : {}),
      // **보낸 수량을 체결량으로 적지 않는다.** 거래소가 말한 값만 적는다.
      ...(Number.isFinite(extra?.executedQty as number)
        ? { filled_qty: extra!.executedQty } : {}),
    }).eq('client_order_id', cid);
    return error
      ? { ok: false, reason: `결과를 적지 못했습니다 (${String((error as any)?.code ?? 'unknown')})` }
      : { ok: true, reason: '' };
  } catch (e: any) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 80) };
  }
}

// ══════════════════════════════════════════════════════════
// 판정 — 기록이 남지 않은 전송은 어떤 상태인가
// ══════════════════════════════════════════════════════════

export type ExitDurabilityCode =
  /** 기록이 남았다 — 재시작이 이 주문을 찾을 수 있다 */
  | 'DURABLE'
  /** 기록 없이 보냈다 — 재시작이 이 주문을 찾을 수 없다 */
  | 'SENT_UNRECORDED'
  /** 보내지 않았다 */
  | 'NOT_SENT';

export interface ExitDurabilityVerdict {
  code: ExitDurabilityCode;
  /** 운영자에게 알려야 하는가 */
  alertOperator: boolean;
  reason: string;
}

/**
 * 이 전송이 재시작을 견디는가.
 *
 * ★ `SENT_UNRECORDED`는 **실패가 아니다.** 청산 주문은 나갔고 그것이
 *   맞는 선택이었다. 다만 그 사실을 아무도 모르므로, 사람이 알아야
 *   한다. 조용히 넘기면 "보냈는데 기록이 없는" 주문이 생기고 다음
 *   회차가 그것을 모른다.
 */
export function judgeExitDurability(i: {
  attempted?: boolean | null;
  durable?: boolean | null;
} | null | undefined): ExitDurabilityVerdict {
  if (i?.attempted !== true) {
    return { code: 'NOT_SENT', alertOperator: false, reason: '' };
  }
  if (i?.durable === true) {
    return { code: 'DURABLE', alertOperator: false, reason: '' };
  }
  // attempted이고 durable이 아니다 — null·undefined도 여기로 온다.
  return {
    code: 'SENT_UNRECORDED', alertOperator: true,
    reason: '청산 주문을 보냈지만 기록이 남지 않았습니다'
      + ' — 재시작하면 이 주문을 멱등 키로 찾을 수 없습니다. 거래소에서 직접 확인해야 합니다',
  };
}

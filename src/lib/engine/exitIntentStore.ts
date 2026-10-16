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
  /** 새로 적었다 — 이 의도를 **내가 선점했다** */
  | 'RECORDED'
  /**
   * 같은 키의 행이 이미 있다 (UNIQUE 위반).
   *
   * ★ **이것은 전송 허가가 아니다.** 앞서 `findExitIntent`가 "없다"고
   *   읽었는데 INSERT가 충돌했다는 것은, 그 사이에 **다른 워커가 같은
   *   의도를 선점했다**는 뜻이다. 경쟁에서 졌으면 상대가 보내고 있다 —
   *   내가 또 보내면 중복 청산이다.
   *
   *   (같은 워커가 재시작 후 재시도하는 경우는 여기 오지 않는다.
   *   그때는 `findExitIntent`가 행을 찾고 `judgeExitSendPermission`이
   *   그 상태를 보고 판단한다.)
   */
  | 'ALREADY_EXISTS'
  /** 적지 못했다 */
  | 'WRITE_FAILED'
  /** 적을 수단이 없다 (DB 핸들 없음) */
  | 'NO_STORE';

/**
 * 자동 회차와 긴급 수동 청산의 **장애 정책은 다르다.**
 *
 *   AUTOMATIC  5분마다 다시 온다. 기록하지 못해 중복 아님을 증명할 수
 *              없으면 **이번 회차를 미룬다** — 영구 차단이 아니다.
 *   EMERGENCY  사람이 버튼을 눌렀고 다음 회차를 기다릴 수 없다.
 *              기록하지 못해도 **보낸다** — 중복 위험을 안고 간다.
 *
 * 둘을 한 정책으로 묶으면 한쪽이 반드시 틀린다. 자동에 긴급 정책을
 * 쓰면 DB 장애 때 무한 재전송이 되고, 긴급에 자동 정책을 쓰면 사람이
 * 누른 비상 정지가 DB 때문에 안 나간다.
 */
export type ExitSendPolicy = 'AUTOMATIC' | 'EMERGENCY';

export interface ExitIntentWriteResult {
  code: ExitIntentWriteCode;
  /** 기록이 남았는가. false면 재시작 뒤 이 주문을 찾을 수 없다 */
  durable: boolean;
  /**
   * 전송해도 되는가.
   *
   * ★ **`ALREADY_EXISTS`에서는 거짓이다.** 기존 intent의 존재가 새
   *   전송의 허가가 되어서는 안 된다.
   * ★ 기록 실패(`WRITE_FAILED`·`NO_STORE`)에서는 **정책에 따라 다르다.**
   */
  maySend: boolean;
  /** 이 전송이 중복일 수 있는가 */
  duplicateRisk: boolean;
  reason: string;
}

/** 최소한의 Supabase 모양. 전체 타입을 끌어오지 않는다 */
export interface MinimalStore {
  from(table: string): {
    insert(row: any): { select(cols: string): { single(): Promise<{ data: any; error: any }> } };
    update(patch: any): { eq(col: string, val: any): Promise<{ error: any }> };
    select(cols: string): { eq(col: string, val: any): any };
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
  policy: ExitSendPolicy = 'AUTOMATIC',
): Promise<ExitIntentWriteResult> {
  // 기록하지 못했을 때의 답. **자동과 긴급이 다르다.**
  const unrecorded = (code: ExitIntentWriteCode, why: string): ExitIntentWriteResult =>
    policy === 'EMERGENCY'
      ? { code, durable: false, maySend: true, duplicateRisk: true,
          reason: `${why} — 긴급 청산이라 중복 위험을 안고 보냅니다` }
      : { code, durable: false, maySend: false, duplicateRisk: false,
          reason: `${why} — 중복 아님을 증명할 수 없어 이번 회차를 미룹니다`
            + ' (다음 회차에 다시 봅니다)' };

  if (sb == null) return unrecorded('NO_STORE', '장부를 쓸 수 없습니다');
  const cid = String(r?.clientOrderId ?? '').trim();
  if (!cid) return unrecorded('WRITE_FAILED', '멱등 키가 없어 기록할 수 없습니다');
  const mode = String(r?.mode ?? '').trim();
  if (!mode) {
    // **모드를 메우지 않는다.** 어느 장부인지 모르는 행을 만들면
    // MOCK·TESTNET·LIVE가 섞이고, 그 섞임은 되돌릴 수 없다.
    return unrecorded('WRITE_FAILED', '운영 모드를 읽지 못해 기록할 수 없습니다');
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
      // ── 23505 = UNIQUE 위반 ──
      //
      //   **이 INSERT는 선점(claim)이다.** 앞서 조회가 "없다"고 읽었는데
      //   충돌했다는 것은 그 사이에 다른 워커가 같은 의도를 선점했다는
      //   뜻이다. 경쟁에서 졌으면 상대가 보내고 있다 — 내가 또 보내면
      //   중복 청산이다.
      //
      //   **기록이 있다는 사실이 전송 허가가 아니다.** 긴급도 예외가
      //   아니다: 같은 순간 다른 실행자가 이미 보내고 있는데 긴급이라고
      //   하나 더 보내면 두 건이 나간다.
      if (String((error as any)?.code) === '23505') {
        return { code: 'ALREADY_EXISTS', durable: true, maySend: false,
          duplicateRisk: false,
          reason: '같은 멱등 키의 청산 의도를 다른 실행자가 이미 선점했습니다'
            + ' — 이번 회차에는 보내지 않습니다' };
      }
      return unrecorded('WRITE_FAILED',
        `청산 의도를 기록하지 못했습니다 (${String((error as any)?.code ?? 'unknown')})`);
    }
    return { code: 'RECORDED', durable: true, maySend: true,
      duplicateRisk: false, reason: '' };
  } catch (e: any) {
    return unrecorded('WRITE_FAILED',
      `청산 의도 기록이 예외로 끝났습니다 (${String(e?.message ?? e).slice(0, 80)})`);
  }
}

/**
 * 이 멱등 키의 앞 시도를 장부에서 찾는다.
 *
 * ★ **못 읽은 것과 없는 것을 가른다.** `recordFound: undefined`가
 *   "못 읽었다"이고 `false`가 "없다"다. 둘을 섞으면 중복 주문이 난다.
 */
export async function findExitIntent(
  sb: MinimalStore | null | undefined, clientOrderId: string,
): Promise<{ recordFound: boolean | undefined; recordStatus: string | undefined }> {
  const cid = String(clientOrderId ?? '').trim();
  if (sb == null || !cid) return { recordFound: undefined, recordStatus: undefined };
  try {
    const q: any = sb.from('live_orders').select('status').eq('client_order_id', cid);
    const r = typeof q?.maybeSingle === 'function' ? await q.maybeSingle() : await q;
    if (r?.error) return { recordFound: undefined, recordStatus: undefined };
    const row = Array.isArray(r?.data) ? r.data[0] : r?.data;
    if (row == null) return { recordFound: false, recordStatus: undefined };
    const st = typeof row?.status === 'string' ? row.status : undefined;
    return { recordFound: true, recordStatus: st };
  } catch {
    return { recordFound: undefined, recordStatus: undefined };
  }
}

// ── RESEARCH CONTRACT: atomic same-seat exit ownership ─────────────────
// The previous select->insert two-step path cannot atomically serialize
// workers whose quantity-derived clientOrderIds differ. In particular, a
// PARTIAL fill can change the key. A *future* database implementation MUST
// claim one UNIQUE seat (user + connection + exchange + mode + symbol)
// using ONE transaction/unique constraint. A select followed by insert,
// a process-local mutex, or the clientOrderId uniqueness is insufficient.
//
// IMPORTANT: No running route calls this adapter; it cannot send an order.
// Deploying it would also require a new durable DB schema and a verified
// release/recovery procedure. Claims MUST NOT expire automatically: an
// already-sent market close may still be pending after a network timeout.
export interface AtomicExitSeatIdentity {
  userId: string;
  connectionId: string;
  exchange: string;
  mode: 'TESTNET';
  symbol: string;
  clientOrderId: string;
  ownerToken: string;
}

export type AtomicSeatClaimCode =
  | 'CLAIMED'
  | 'ALREADY_HELD'
  | 'UNAVAILABLE';

export type AtomicSeatClaimResult =
  | { code: 'CLAIMED'; record: AtomicExitSeatIdentity }
  | { code: 'ALREADY_HELD'; record: AtomicExitSeatIdentity | null }
  | { code: 'UNAVAILABLE'; record: null };

export interface AtomicExitSeatStore {
  // Must be implemented as one DB-atomic claim against UNIQUE seat identity;
  // NEVER implement this with a preflight SELECT followed by an INSERT.
  claimUniqueSeat: (intent: AtomicExitSeatIdentity) => Promise<AtomicSeatClaimResult>;
}

export interface AtomicExitSeatVerdict {
  seatClaimed: boolean;
  code: AtomicSeatClaimCode;
  duplicateRisk: false;
  // `seatClaimed` is only research evidence, NEVER authorization to send.
  // A successful claim ONLY proves we won the proposed research gate;
  // caller still needs connection-scoped TESTNET readiness, lease fencing,
  // fresh venue exposure and the existing order-intent write-ahead record.
  executionAuthorized: false;
}

export async function claimAtomicExitSeatForResearch(
  store: AtomicExitSeatStore | null | undefined,
  i: AtomicExitSeatIdentity,
): Promise<AtomicExitSeatVerdict> {
  const deny = (code: AtomicSeatClaimCode): AtomicExitSeatVerdict => ({
    seatClaimed: false, code, duplicateRisk: false, executionAuthorized: false,
  });
  const fields = [i?.userId, i?.connectionId, i?.exchange,
    i?.symbol, i?.clientOrderId, i?.ownerToken];
  if (!store || !i || i.mode !== 'TESTNET' ||
      fields.some(x => typeof x !== 'string' || !x.trim()) ||
      i.clientOrderId.length > 36 || i.symbol.length > 40 ||
      i.symbol !== i.symbol.toUpperCase() ||
      i.ownerToken.length > 128) {
    return deny('UNAVAILABLE');
  }
  try {
    const result = await store.claimUniqueSeat(i);
    if (result?.code !== 'CLAIMED') {
      return deny(result?.code === 'ALREADY_HELD' ? 'ALREADY_HELD' : 'UNAVAILABLE');
    }
    const r = result.record;
    // A successful-looking response is NOT enough. All claimed seat and
    // fencing identity must match exactly, including the unique client ID.
    if (!r || r.userId !== i.userId || r.connectionId !== i.connectionId ||
        r.exchange !== i.exchange || r.mode !== i.mode ||
        r.symbol !== i.symbol || r.clientOrderId !== i.clientOrderId ||
        r.ownerToken !== i.ownerToken) {
      return deny('UNAVAILABLE');
    }
    return { seatClaimed: true, code: 'CLAIMED', duplicateRisk: false,
      executionAuthorized: false };
  } catch {
    return deny('UNAVAILABLE');
  }
}

/** Prototype adapter for an UNDEPLOYED TESTNET-only table. NO route imports it.
 *
 * A database migration must first create `public.exit_seat_claims` with a
 * UNIQUE(user_id, connection_id, exchange, mode, symbol) constraint, NOT
 * merely UNIQUE(client_order_id). No SELECT-before-INSERT: the INSERT and
 * unique constraint together choose the sole seat winner atomically.
 *
 * 23505 conflict is NEVER permission to send. Missing table/RLS error,
 * timeout, partial payload, malformed owner identity => UNAVAILABLE.
 */
export function supabaseAtomicExitSeatStore(
  sb: MinimalStore | null | undefined,
  verifiedTestnet: boolean,
): AtomicExitSeatStore {
  return {
    async claimUniqueSeat(i): Promise<AtomicSeatClaimResult> {
      const unavailable: AtomicSeatClaimResult = {
        code: 'UNAVAILABLE', record: null,
      };
      if (!sb || verifiedTestnet !== true || i?.mode !== 'TESTNET') {
        return unavailable;
      }
      try {
        const { data, error } = await sb.from('exit_seat_claims')
          .insert({
            user_id: i.userId,
            connection_id: i.connectionId,
            exchange: i.exchange,
            mode: i.mode,
            symbol: i.symbol,
            client_order_id: i.clientOrderId,
            owner_token: i.ownerToken,
          })
          .select('user_id,connection_id,exchange,mode,symbol,client_order_id,owner_token')
          .single();
        if (error) {
          if (String(error.code) === '23505') {
            return { code: 'ALREADY_HELD', record: null };
          }
          return unavailable;
        }
        if (!data || data.user_id !== i.userId ||
            data.connection_id !== i.connectionId ||
            data.exchange !== i.exchange || data.mode !== i.mode ||
            data.symbol !== i.symbol ||
            data.client_order_id !== i.clientOrderId ||
            data.owner_token !== i.ownerToken) {
          return unavailable;
        }
        return { code: 'CLAIMED', record: i };
      } catch {
        return unavailable;
      }
    },
  };
}

// ── Same-seat pending exit preflight ──────────────────────────────────────
// A close ID is derived from quantity. A partially filled old close can have
// clientOrderId A while the remaining position produces clientOrderId B.
// Checking ONLY B cannot prove A isn't still an open reduceOnly order.
//
// This query intentionally does not authorize transmission: it is a
// conservative read-only prerequisite, scoped to the *same owner, connection,
// exchange, mode and symbol*. A successful empty ledger query is NOT proof of
// exchange absence: other writers/manual orders and races need venue evidence.
// The normal automatic path must defer if any other unresolved exit exists.
export type ExitSeatPendingCode =
  | 'CLEAR_IN_LEDGER'
  | 'BLOCKED_OTHER_PENDING_EXIT'
  | 'BLOCKED_SEAT_LOOKUP_UNKNOWN';

export interface ExitSeatPendingVerdict {
  code: ExitSeatPendingCode;
  mayProceedToExistingOrderGate: boolean;
  reason: string;
}

export async function findOtherPendingExitForSeat(
  sb: MinimalStore | null | undefined,
  i: {
    userId: string | null | undefined;
    connectionId: string | null | undefined;
    exchange: string | null | undefined;
    mode: string | null | undefined;
    symbol: string | null | undefined;
    clientOrderId: string | null | undefined;
  },
): Promise<ExitSeatPendingVerdict> {
  const blocked = (code: ExitSeatPendingCode, reason: string): ExitSeatPendingVerdict =>
    ({ code, mayProceedToExistingOrderGate: false, reason });
  const scoped = [
    i?.userId, i?.connectionId, i?.exchange, i?.mode,
    i?.symbol, i?.clientOrderId,
  ];
  if (!sb || scoped.some(x => typeof x !== 'string' || !x.trim())) {
    return blocked('BLOCKED_SEAT_LOOKUP_UNKNOWN',
      '청산 주문 소유권·거래소·망·종목·식별자 또는 장부를 확인할 수 없습니다');
  }
  try {
    const q: any = sb.from('live_orders')
      .select('client_order_id,status')
      .eq('user_id', i.userId)
      .eq('connection_id', i.connectionId)
      .eq('exchange', i.exchange)
      .eq('mode', i.mode)
      .eq('symbol', i.symbol)
      .eq('reduce_only', true)
      .in('status', [...PENDING_EXIT_STATUSES])
      .neq('client_order_id', i.clientOrderId)
      .limit(1);
    const res = await q;
    if (!res || res.error || (res.data != null && !Array.isArray(res.data))) {
      return blocked('BLOCKED_SEAT_LOOKUP_UNKNOWN',
        '동일 소유권·연결·종목의 이전 미결 청산 기록 조회에 실패했습니다');
    }
    const rows = res.data;
    if (rows == null) {
      // Successful PostgREST array selects return []; a null payload is
      // not equivalent evidence of an empty successful result.
      return blocked('BLOCKED_SEAT_LOOKUP_UNKNOWN',
        '미결 청산 조회 결과의 형태를 확인할 수 없습니다');
    }
    if (rows.length > 0) {
      return blocked('BLOCKED_OTHER_PENDING_EXIT',
        '같은 소유권·연결·종목에 다른 clientOrderId의 미결 reduceOnly 주문 기록이 있습니다'
        + ' — 부분 체결/재시작의 앞 주문을 대사하기 전 새 청산을 발송하지 않습니다');
    }
    return {
      code: 'CLEAR_IN_LEDGER', mayProceedToExistingOrderGate: true,
      reason: '',
    };
  } catch {
    return blocked('BLOCKED_SEAT_LOOKUP_UNKNOWN',
      '미결 청산 기록 조회가 예외로 종료됐습니다 — 없음으로 간주하지 않습니다');
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

// ══════════════════════════════════════════════════════════
// 전송 허가 — 처음 보내는 것과 다시 보내는 것은 다른 질문이다
// ══════════════════════════════════════════════════════════
//
// 두 정책이 충돌하는 것처럼 보였다
// ────────────────────────────────
//   · 이 파일(#331): **기록 실패에도 청산을 허용한다.** 못 썼다고
//     빠져나갈 길을 막으면 못 닫는 사고가 된다.
//   · #330의 분류기: **기록이 불확실하면 재전송을 금지한다.** 살아
//     있는 주문이 있는데 또 보내면 중복 청산이 된다.
//
// 둘은 충돌하지 않는다. **다른 질문에 대한 답이다.**
//
//     처음 보내는 것   → 기록 실패에도 허가한다 (청산 가능성 보존)
//     다시 보내는 것   → 기록이 확실할 때만 허가한다 (중복 차단)
//
// 그리고 확실할 때도 **무제한은 아니다.** 자동 재시작이 같은 키로
// 반복 전송하면, 각 회차가 "증거가 있다"고 판단하면서도 전체로는
// 무한 루프가 된다. 그래서 횟수 상한을 둔다.
//
// ★ 긴급 청산 가능성은 보존된다. `emergency: true`는 **명시적 결정**이고
//   기록에 남는다 — 기본값이 아니다. 기본값이면 모든 회차가 긴급이 된다.

/** 같은 멱등 키로 보낼 수 있는 최대 횟수. 이 저장소의 감시 주기는 5분이다 */
export const MAX_SENDS_PER_KEY = 3;

export type ExitSendPermissionCode =
  /** 이 노출에 대한 첫 전송이다 — 기록 실패에도 보낸다 */
  | 'FIRST_SEND'
  /** 앞 시도가 끝났음이 확인됐다 — 다시 보내도 된다 */
  | 'RESEND_PRIOR_RESOLVED'
  /** 앞 시도가 아직 살아 있다 — 보내지 않는다 */
  | 'BLOCKED_PRIOR_LIVE'
  /** 앞 시도의 상태를 모른다 — **보내지 않는다** */
  | 'BLOCKED_PRIOR_UNKNOWN'
  /** 같은 키로 이미 상한만큼 보냈다 */
  | 'BLOCKED_ATTEMPT_CAP'
  /** 긴급 종료로 명시적으로 허가됐다 */
  | 'EMERGENCY_OVERRIDE';

export interface ExitSendPermission {
  maySend: boolean;
  code: ExitSendPermissionCode;
  /** 이 전송이 중복일 수 있는가. 허가해도 참일 수 있다 */
  duplicateRisk: boolean;
  reason: string;
}

/**
 * 앞 시도에 대해 **확실히 아는 것**만 넘긴다.
 *
 * 세 값 모두 "모름"을 표현할 수 있어야 한다. `false`로 메우면
 * "없다"와 "모른다"가 같은 값이 되고, 그 섞임이 중복 주문을 만든다.
 */
export interface PriorAttemptEvidence {
  /**
   * 장부에서 이 멱등 키의 행을 읽었는가.
   * `undefined` = 장부를 못 읽었다 (false와 다르다)
   */
  recordFound: boolean | undefined;
  /** 그 행의 상태. 못 읽었으면 undefined */
  recordStatus: string | undefined;
  /**
   * 거래소에 이 멱등 키로 물어본 결과.
   * `ok: false`면 **물어보지 못한 것**이고 "없다"가 아니다.
   */
  venueLookup: { ok: boolean; found: boolean } | null;
  /** 이 키로 지금까지 보낸 횟수. 모르면 undefined */
  sendCount: number | undefined;
}

const TERMINAL_EXIT_STATUSES = ['FILLED', 'REJECTED', 'FAILED', 'RECONCILED'] as const;

/**
 * 이 전송을 보내도 되는가.
 *
 * ★ 판정 순서가 의미다. 긴급을 먼저 보고, 그다음 "처음인가"를 보고,
 *   재전송은 가장 엄격하게 본다.
 */
export function judgeExitSendPermission(i: {
  prior?: PriorAttemptEvidence | null;
  /** 긴급 종료로 명시적으로 허가됐는가. **기본값은 거짓이다** */
  emergency?: boolean | null;
  maxSends?: number | null;
} | null | undefined): ExitSendPermission {
  const cap = Number.isFinite(i?.maxSends as number) && (i?.maxSends as number) > 0
    ? (i!.maxSends as number) : MAX_SENDS_PER_KEY;
  const p = i?.prior ?? null;
  const sent = Number.isFinite(p?.sendCount as number) ? (p!.sendCount as number) : undefined;

  // ── 상한은 긴급보다도 앞이다 ──
  //
  //   긴급이 상한을 무시하면, 긴급 경로가 무한 재전송 경로가 된다.
  //   상한에 걸렸다는 것은 세 번 보냈는데도 안 끝났다는 뜻이고, 그때
  //   필요한 것은 네 번째 주문이 아니라 사람이다.
  if (sent != null && sent >= cap) {
    return { maySend: false, code: 'BLOCKED_ATTEMPT_CAP', duplicateRisk: false,
      reason: `같은 멱등 키로 이미 ${sent}번 보냈습니다 (상한 ${cap})`
        + ' — 네 번째 주문이 아니라 사람이 필요한 상태입니다' };
  }

  if (i?.emergency === true) {
    return { maySend: true, code: 'EMERGENCY_OVERRIDE', duplicateRisk: true,
      reason: '긴급 종료로 명시적으로 허가됐습니다 — 중복 가능성을 안고 보냅니다' };
  }

  // Existing row with an unknown send count: the caller cannot claim
  // the 3-send ceiling is enforced. Fail closed for automatic retries.
  // Explicit EMERGENCY remains a separate, audited human decision above.
  if (p?.recordFound === true && (sent == null || !Number.isSafeInteger(sent) || sent < 0)) {
    return { maySend: false, code: 'BLOCKED_PRIOR_UNKNOWN', duplicateRisk: false,
      reason: '이전 청산의 실제 전송 횟수가 확인되지 않아 자동 재전송을 차단합니다' };
  }

  // ── 처음 보내는가 ──
  //
  //   장부를 **읽었고** 그 키의 행이 없으면 첫 전송이다.
  //   장부를 못 읽었으면(undefined) 첫 전송인지 알 수 없다 — 아래로 간다.
  if (p?.recordFound === false) {
    return { maySend: true, code: 'FIRST_SEND', duplicateRisk: false,
      reason: '' };
  }

  // 장부도 못 읽었고 거래소에도 못 물어봤다. **첫 전송인지조차 모른다.**
  //
  //   이 자리에서 보내면 중복 위험이고, 막으면 첫 전송까지 막힌다.
  //   거래소에 물어볼 수 있으면 그것이 답이다 — 아래가 그 경로다.
  if (p == null || p.recordFound === undefined) {
    const lk = p?.venueLookup ?? null;
    if (lk?.ok === true && lk.found === false) {
      // 장부는 못 읽었지만 **거래소가 "그런 주문 없다"고 했다.**
      // 거래소가 최종 권위다 — 보내도 된다.
      return { maySend: true, code: 'FIRST_SEND', duplicateRisk: false,
        reason: '장부를 읽지 못했지만 거래소에 그 멱등 키의 주문이 없습니다' };
    }
    if (lk?.ok === true && lk.found === true) {
      return { maySend: false, code: 'BLOCKED_PRIOR_LIVE', duplicateRisk: false,
        reason: '거래소에 같은 멱등 키의 주문이 있습니다 — 다시 보내지 않습니다' };
    }
    return { maySend: false, code: 'BLOCKED_PRIOR_UNKNOWN', duplicateRisk: false,
      reason: '장부도 거래소도 읽지 못해 앞 시도가 살아 있는지 모릅니다'
        + ' — 모르는 상태에서 같은 주문을 또 보내지 않습니다'
        + ' (긴급 종료는 명시적으로 허가해야 합니다)' };
  }

  // ── 여기부터 recordFound === true. 재전송 질문이다 ──
  const st = String(p.recordStatus ?? '').trim().toUpperCase();
  if (!st) {
    return { maySend: false, code: 'BLOCKED_PRIOR_UNKNOWN', duplicateRisk: false,
      reason: '앞 시도의 상태를 읽지 못했습니다 — 살아 있는지 모르는 주문 위에 또 보내지 않습니다' };
  }
  if ((TERMINAL_EXIT_STATUSES as readonly string[]).includes(st)) {
    return { maySend: true, code: 'RESEND_PRIOR_RESOLVED', duplicateRisk: false,
      reason: `앞 시도가 ${st}로 끝났습니다` };
  }
  // INTENT · SENT · ACKED · UNKNOWN — 아직 끝나지 않았다.
  //
  //   거래소가 "없다"고 하면 그것이 장부보다 최신이다. 그때만 뚫는다.
  const lk = p.venueLookup;
  if (lk?.ok === true && lk.found === false) {
    return { maySend: true, code: 'RESEND_PRIOR_RESOLVED', duplicateRisk: false,
      reason: `장부는 ${st}이지만 거래소에 그 주문이 없습니다 — 거래소가 최종 권위입니다` };
  }
  return { maySend: false, code: 'BLOCKED_PRIOR_LIVE', duplicateRisk: false,
    reason: `앞 시도가 ${st} 상태로 남아 있습니다 — 끝났음을 확인하기 전에 또 보내지 않습니다` };
}

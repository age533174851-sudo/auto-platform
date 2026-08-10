// src/lib/engine/closeEvidence.ts
//
// **무엇을 근거로 "닫혔다"고 적을 수 있는가.**
//
// 실제로 있던 고장
// ────────────────
// 청산 감시(`exit-monitor`)의 CLOSE 분기가 이랬다:
//
//     const posRes = await getFuturesPositions(key, secret, testnet);
//     const list = Array.isArray(posRes?.positions) ? posRes.positions : [];
//     const pos = list.find(...);
//     if (!pos) { ok = true; }        // ← "이미 없다 — 목표 달성"
//     ...
//     status: ok ? 'CLOSED' : 'OPEN', closed_at: now
//
// `getFuturesPositions`는 실패하면 `{ success: false, message }`를
// 돌려준다 — **`positions` 칸이 아예 없다.** 그래서 인증 오류·타임아웃·
// 레이트리밋·네트워크 끊김이 전부 `list = []` → `pos = undefined` →
// `ok = true`가 되고, **아무것도 안 닫았는데 장부에 CLOSED로 적힌다.**
//
// 거래소별 문제가 아니다. 바이낸스에서 일시적인 오류가 나도 같다.
// 그리고 이 고장은 조용하다 — 로그에는 "청산 완료"가 남는다.
//
// 그리고 '주문을 냈다'와 '닫혔다'도 다르다
// ────────────────────────────────────────
// reduceOnly 시장가가 **접수**된 것과 포지션이 **없어진** 것은 다른
// 사실이다. 부분 체결로 끝날 수도 있고, 접수 뒤 거절될 수도 있다.
// 접수만 보고 CLOSED로 적으면 남은 수량이 장부에서 사라진다 —
// 보호 주문도 같이 잊힌다.
//
// 그래서 규칙 하나
// ────────────────
// **독립적인 거래소 조회가 성공해서 그 포지션이 없다고 말할 때만
// 닫힌 것이다.** 조회에 실패했으면 '모른다'이고, 모르는 것은 장부에
// 닫힘으로 적지 않는다 — 다음 주기에 다시 확인한다.

export interface PositionRead {
  /** 조회 자체가 성공했는가. **false면 아래 값들은 사실이 아니다** */
  ok: boolean;
  /** 그 심볼의 포지션이 남아 있는가. 조회 실패면 의미 없다 */
  found: boolean;
  /** 남은 수량(절대값). 못 읽으면 null */
  amount?: number | null;
  error?: string | null;
}

export interface CloseOrderResult {
  /** 청산 주문을 실제로 보냈는가 */
  attempted: boolean;
  /** 거래소가 접수했는가. **체결과 다르다** */
  ok: boolean;
  error?: string | null;
}

export type CloseCode =
  /** 조회 성공 · 포지션 없음 — 닫힌 것이 확인됐다 */
  | 'CLOSED_CONFIRMED'
  /** 청산 주문 뒤 조회 성공 · 포지션 없음 */
  | 'CLOSE_VERIFIED'
  /** 조회 성공 · 포지션이 남아 있다 */
  | 'STILL_OPEN'
  /** **조회에 실패했다.** 닫혔는지 모른다 */
  | 'READ_FAILED'
  /** 청산 주문이 거절됐다 */
  | 'ORDER_FAILED'
  /** 주문은 나갔는데 결과를 확인하지 못했다 — 대조가 필요하다 */
  | 'RECONCILE_REQUIRED';

export interface CloseVerdict {
  /** **장부에 CLOSED로 적어도 되는가.** 이 값만 그 판단을 한다 */
  closed: boolean;
  code: CloseCode;
  /** 사람이 거래소와 직접 맞춰 봐야 하는가 */
  needsReconcile: boolean;
  /** 다음 주기에 다시 시도해도 되는가 */
  retry: boolean;
  reason: string;
}

/**
 * 거래소 응답 → 포지션 조회 결과.
 *
 * **`positions`가 배열이 아닌 것을 '없음'으로 읽지 않는다.** 그게 이
 * 파일이 존재하는 이유다.
 */
export function readPositions(
  res: any, symbol: string,
): PositionRead {
  // 어댑터마다 성공 표시가 다르다: `{ok}` 또는 `{success}`.
  // **둘 다 없고 배열도 아니면 실패로 본다** — 모르는 모양을 성공으로
  // 읽으면 이 파일이 막으려는 고장이 그대로 돌아온다.
  const okFlag = res?.ok === true || res?.success === true;
  const list = Array.isArray(res?.positions) ? res.positions : null;
  if (!okFlag || list == null) {
    return {
      ok: false, found: false, amount: null,
      error: String(res?.error || res?.message || '포지션 조회 실패'),
    };
  }

  const want = norm(symbol);
  let amount: number | null = null;
  let found = false;
  for (const p of list) {
    if (norm(p?.symbol ?? p?.contract) !== want) continue;
    const a = Number(p?.amount ?? p?.size);
    // **수량을 못 읽은 것을 0으로 보지 않는다.** 줄이 있다는 것 자체가
    // 포지션이 있다는 뜻이다.
    if (!Number.isFinite(a)) { found = true; amount = null; break; }
    if (Math.abs(a) > 0) { found = true; amount = Math.abs(a); break; }
  }
  return { ok: true, found, amount, error: null };
}

/** `BTC_USDT` · `BTC/USDT` · `btcusdt` 를 한 모양으로 */
function norm(s: any): string {
  return String(s ?? '').toUpperCase().replace(/[_/\-\s]/g, '');
}

/**
 * 이 거래를 장부에 닫힘으로 적어도 되는가.
 *
 * 순서가 곧 의미다:
 *   1. **조회에 실패했으면 끝이다.** 그 뒤 값은 전부 근거가 못 된다
 *   2. 포지션이 없으면 닫힌 것이다 — 독립적인 거래소 증거다
 *   3. 청산 주문을 보냈으면, 보낸 뒤의 조회로 확인한다
 */
export function closeVerdict(i: {
  before: PositionRead;
  order?: CloseOrderResult | null;
  after?: PositionRead | null;
}): CloseVerdict {
  // 1. 청산 전 조회부터 실패했다.
  if (!i.before.ok) {
    return {
      closed: false, code: 'READ_FAILED', needsReconcile: true, retry: true,
      reason: `포지션을 조회하지 못했습니다 (${i.before.error || '사유 없음'}) — `
        + '조회 실패는 "닫혔다"가 아닙니다. 장부를 그대로 두고 다음 주기에 다시 확인합니다',
    };
  }

  // 2. 조회는 됐고 포지션이 없다. **이것이 닫힘의 증거다.**
  if (!i.before.found) {
    return {
      closed: true, code: 'CLOSED_CONFIRMED', needsReconcile: false, retry: false,
      reason: '거래소 조회에서 이 포지션이 없습니다 — 이미 닫혀 있습니다',
    };
  }

  // 3. 포지션은 있는데 청산 주문을 안 보냈다.
  const order = i.order ?? null;
  if (!order || !order.attempted) {
    return {
      closed: false, code: 'STILL_OPEN', needsReconcile: false, retry: true,
      reason: `포지션이 남아 있습니다${i.before.amount != null ? ` (${i.before.amount})` : ''} — 청산 주문을 보내지 않았습니다`,
    };
  }

  // 4. 주문이 거절됐다.
  if (!order.ok) {
    return {
      closed: false, code: 'ORDER_FAILED', needsReconcile: false, retry: true,
      reason: `청산 주문이 거절됐습니다: ${order.error || '사유 없음'}`,
    };
  }

  // 5. 주문은 접수됐다. **접수는 체결이 아니다** — 확인해야 한다.
  const after = i.after ?? null;
  if (!after || !after.ok) {
    return {
      closed: false, code: 'RECONCILE_REQUIRED', needsReconcile: true, retry: true,
      reason: '청산 주문은 접수됐지만 그 뒤 포지션을 확인하지 못했습니다 — '
        + '접수는 체결이 아니므로 닫힘으로 적지 않습니다. 거래소와 대조가 필요합니다',
    };
  }
  if (after.found) {
    return {
      closed: false, code: 'STILL_OPEN', needsReconcile: false, retry: true,
      reason: `청산 주문 뒤에도 포지션이 남아 있습니다${after.amount != null ? ` (${after.amount})` : ''} — `
        + '부분 체결일 수 있습니다. 다음 주기에 남은 수량을 다시 닫습니다',
    };
  }
  return {
    closed: true, code: 'CLOSE_VERIFIED', needsReconcile: false, retry: false,
    reason: '청산 주문 뒤 조회에서 포지션이 사라졌습니다 — 닫힘을 확인했습니다',
  };
}

/**
 * 장부의 `exit_reason`에 남길 한 줄.
 *
 * **닫지 못한 이유가 장부에 남아야 한다.** 로그에만 있으면 아무도 안
 * 보고, 다음 사람은 "왜 아직 OPEN이지"를 처음부터 다시 조사한다.
 */
export function exitReasonLine(base: any, v: CloseVerdict): string {
  const head = String(base ?? '').trim();
  if (v.closed) return head.slice(0, 300);
  const tag = v.needsReconcile ? 'RECONCILE_REQUIRED' : v.code;
  return `${head}${head ? ' — ' : ''}[${tag}] ${v.reason}`.slice(0, 300);
}

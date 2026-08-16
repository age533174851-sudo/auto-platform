// src/lib/engine/protectionLedger.ts
//
// **연 주문이 만든 보호주문을, 닫을 때 정확히 그 번호로 지운다.**
//
// 왜 이 파일이 생겼나
// ───────────────────
// 2026-08-15 21:16:16(KST)에 스모크가 만든 ETHUSDT 조건부 주문 2건이
// 포지션이 0이 된 뒤에도 Gate에 그대로 남았다. #128에서 정리 코드를
// 넣었는데도 남았다. 코드를 따라가 보면 남는 길이 둘이었다:
//
//   1. **되돌리기(undo)가 보호주문을 안 지운다.**
//      진입 → SL 등록 → TP 등록 → 되읽기 실패 → REQUIRED이므로 포지션을
//      되돌린다. 그런데 방금 등록한 SL·TP는 **취소하지 않는다.** 그리고
//      그 회차는 HOLDING이 된 적이 없으므로 settle이 영원히 안 돈다 —
//      #128의 정리 코드는 **실행 자체가 안 된다.**
//
//   2. **취소를 HTTP 성공만으로 완료로 적는다.**
//      `cancelProtectiveOrders`는 거래소가 200을 주면 `cancelled`에 넣는다.
//      200은 접수다. 조건부 주문은 그 뒤에도 남아 있을 수 있다.
//
// 그래서 규칙
// ───────────
// **취소 확인은 재조회로만 한다.** 요청했다 · 응답이 200이다 —
// 둘 다 "지워졌다"가 아니다. 목록을 다시 읽어 그 번호가 없어야 지워진
// 것이고, 목록을 못 읽었으면 **모르는 것이지 지워진 것이 아니다.**
//
// 그리고 소유 증거의 우선순위
// ───────────────────────────
// 걸 때 거래소가 준 **주문 번호가 가장 강한 증거**다. 식별자(text)
// 파싱은 그다음이다 — 형식이 한 번 깨지면 내 주문이 UNKNOWN이 되고,
// UNKNOWN은 안전을 이유로 안 지우므로 거래소에 계속 쌓인다.
// 실제로 그렇게 쌓였다.

const str = (v: any): string => String(v ?? '').trim();

/**
 * 이 포지션이 만든 보호주문 번호 전부.
 *
 * **두 곳에서 온다.** 하나는 등록 응답(`placed`), 하나는 되읽기에서
 * 확인한 번호(`readback`). 보통 같지만 다를 수 있다 — 등록 응답이
 * 번호를 안 주거나, 되읽기가 실패해 한쪽만 남는다. **둘 다 모은다.**
 * 하나라도 놓치면 그 주문이 거래소에 남는다.
 */
export function ownedOrderIds(i: {
  placed?: Array<string | null | undefined> | null;
  readback?: Array<string | null | undefined> | null;
  extra?: Array<string | null | undefined> | null;
}): string[] {
  const out: string[] = [];
  for (const list of [i?.placed, i?.readback, i?.extra]) {
    for (const raw of Array.isArray(list) ? list : []) {
      const s = str(raw);
      // 'null'·'undefined' 문자열이 DB를 거쳐 오는 경우가 있다.
      if (!s || s === 'null' || s === 'undefined') continue;
      if (!out.includes(s)) out.push(s);
    }
  }
  return out;
}

export type CancelState =
  /** 재조회에서 사라졌다. **이것만 완료다** */
  | 'CANCEL_CONFIRMED'
  /** 재조회에 아직 있다 */
  | 'STILL_PRESENT'
  /** 재조회를 못 했다 — 지워졌는지 모른다 */
  | 'CANCEL_UNKNOWN'
  /** 취소를 요청하지도 못했다 */
  | 'NOT_REQUESTED';

/** 취소 한 번의 기록. **비밀은 담지 않는다** — 번호와 응답 요약뿐 */
export interface CancelAttempt {
  id: string;
  /** 요청은 보냈는가. false면 보내지도 못했다 */
  requested: boolean;
  /** 거래소가 성공 응답을 줬는가. **이것만으로 완료로 적지 않는다** */
  httpOk: boolean;
  /** 거래소 응답 요약(에러 메시지 등) */
  response?: string | null;
  tries?: number;
}

export interface CancelEntry {
  id: string;
  state: CancelState;
  note: string;
}

export interface CancelLedger {
  /** **요청한 번호가 전부 사라진 것이 확인됐는가** */
  ok: boolean;
  code: 'CLEAR' | 'STILL_PRESENT' | 'UNKNOWN' | 'NOTHING_TO_CANCEL';
  entries: CancelEntry[];
  stillPresent: string[];
  unknown: string[];
  reason: string;
}

/** 거래소 주문 한 줄에서 번호를 뽑는다 (Gate: id · 바이낸스: orderId) */
export function orderIdOf(row: any): string {
  if (!row || typeof row !== 'object') return '';
  return str(row.id ?? row.orderId ?? row.order_id);
}

/**
 * 취소 결과를 **재조회로** 판정한다.
 *
 * `leftover`가 **null이면 목록을 못 읽은 것이다.** 그때는 HTTP가 200이든
 * 아니든 전부 UNKNOWN이다 — 못 읽은 것을 "없어졌다"로 읽으면 이 판정이
 * 있으나 마나다. 빈 배열 `[]`은 "하나도 없다"이고 그건 확인된 사실이다.
 */
export function cancelLedger(i: {
  ids: string[];
  attempts: CancelAttempt[];
  /** 취소 뒤 다시 읽은 조건부 주문 목록. **null이면 못 읽었다** */
  leftover: any[] | null;
}): CancelLedger {
  const ids = ownedOrderIds({ placed: i?.ids });
  if (ids.length === 0) {
    return { ok: true, code: 'NOTHING_TO_CANCEL', entries: [], stillPresent: [], unknown: [],
      reason: '취소할 보호주문 번호가 없습니다' };
  }

  const attemptOf = (id: string) =>
    (Array.isArray(i?.attempts) ? i.attempts : []).find(a => str(a?.id) === id) ?? null;

  const readable = Array.isArray(i?.leftover);
  const present = readable
    ? (i.leftover as any[]).map(orderIdOf).filter(Boolean)
    : null;

  const entries: CancelEntry[] = ids.map(id => {
    const a = attemptOf(id);
    if (present == null) {
      return { id, state: 'CANCEL_UNKNOWN',
        note: `${id}: 취소 뒤 목록을 읽지 못해 사라졌는지 확인하지 못했습니다`
          + (a ? ` (요청 ${a.requested ? '보냄' : '못 보냄'} · 응답 ${a.httpOk ? 'OK' : (a.response || '실패')})` : '') };
    }
    if (present.includes(id)) {
      return { id, state: 'STILL_PRESENT',
        note: `${id}: 취소 뒤에도 거래소에 남아 있습니다`
          + (a?.httpOk ? ' — 거래소는 성공을 줬지만 실제로는 안 지워졌습니다' : a ? ` (${a.response || '취소 실패'})` : ' (취소를 요청하지 않았습니다)') };
    }
    if (!a || !a.requested) {
      // 요청도 안 했는데 없다. 이미 발동했거나 다른 경로가 지웠다.
      // **없는 것은 사실이므로 통과다** — 없애는 것이 목적이었다.
      return { id, state: 'CANCEL_CONFIRMED', note: `${id}: 거래소에 없습니다 (취소 요청 전에 이미 사라졌습니다)` };
    }
    return { id, state: 'CANCEL_CONFIRMED', note: `${id}: 취소 확인 (재조회에서 사라짐)` };
  });

  const stillPresent = entries.filter(e => e.state === 'STILL_PRESENT').map(e => e.id);
  const unknown = entries.filter(e => e.state === 'CANCEL_UNKNOWN').map(e => e.id);

  if (stillPresent.length > 0) {
    return { ok: false, code: 'STILL_PRESENT', entries, stillPresent, unknown,
      reason: `보호주문 ${stillPresent.length}건이 취소 뒤에도 남아 있습니다 (${stillPresent.join(', ')}) — `
        + '다음 진입을 예상치 못하게 닫습니다' };
  }
  if (unknown.length > 0) {
    return { ok: false, code: 'UNKNOWN', entries, stillPresent, unknown,
      reason: `보호주문 ${unknown.length}건이 지워졌는지 확인하지 못했습니다 — 0건과 다릅니다` };
  }
  return { ok: true, code: 'CLEAR', entries, stillPresent, unknown,
    reason: `보호주문 ${ids.length}건 취소 확인 (재조회로 확인함)` };
}

/**
 * 진입을 되돌릴 때 같이 지워야 하는 보호주문.
 *
 * **여기가 8/15 잔여 2건의 자리다.** 되읽기 실패로 포지션을 되돌리면서
 * 방금 건 SL·TP를 그대로 뒀다. 포지션이 없어졌으므로 그 주문들은
 * 아무도 청구하지 않는 고아가 되고, 다음 진입을 예상치 못하게 닫는다.
 */
export function rollbackTargets(i: {
  slOrderId?: string | null;
  tpOrderId?: string | null;
}): string[] {
  return ownedOrderIds({ placed: [i?.slOrderId, i?.tpOrderId] });
}

/**
 * 되돌리기 결과를 사람이 읽는 한 줄로.
 *
 * **"되돌렸습니다"와 "보호주문도 지웠습니다"는 다른 사실이다.**
 * 한 문장에 섞으면 남은 주문을 아무도 안 찾는다.
 */
export function rollbackNote(i: {
  positionClosed: boolean;
  ledger: CancelLedger;
}): string {
  const pos = i?.positionClosed ? '포지션을 되돌렸습니다' : '⚠ 포지션 되돌리기 실패 — 거래소에서 직접 확인하세요';
  const led = i?.ledger;
  if (!led || led.code === 'NOTHING_TO_CANCEL') return pos;
  if (led.ok) return `${pos} · 걸어 둔 보호주문 ${led.entries.length}건도 취소 확인`;
  return `${pos} · ⚠ ${led.reason}`;
}

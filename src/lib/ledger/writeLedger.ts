// src/lib/ledger/writeLedger.ts
//
// **장부에 적는 길은 하나뿐이다.**
//
// 그리고 이 파일이 존재하는 이유가 하나 더 있다 — 이 저장소에서
// 반복된 고장이 "표는 만들었는데 채우는 코드가 없다"였다. 048
// (자산 스냅샷)이 그랬고, 그래서 지갑 곡선이 구조적으로 영원히 비어
// 있었다. 표를 만들면 **같은 PR에서 쓰는 쪽까지** 붙인다.
//
// 장부 쓰기가 실패해도 매매를 막지 않는다
// ───────────────────────────────────────
// 기록이 안 됐다고 주문을 되돌리면, 기록 장애가 매매 장애가 된다.
// 실패는 로그로 남기고 매매는 계속한다 — 다만 **조용히 넘기지 않는다.**
// 나중에 합계가 안 맞는 이유가 여기 있을 수 있기 때문이다.

import { ledgerEventOf, type LedgerEvent } from './ledgerEvent';

export interface WriteResult {
  ok: boolean;
  code: 'WRITTEN' | 'DUPLICATE' | 'REJECTED' | 'TABLE_MISSING' | 'FAILED';
  idempotencyKey: string | null;
  reason: string;
}

const isMissingTable = (m: any) =>
  /relation .* does not exist|schema cache|could not find the table/i.test(String(m ?? ''));
const isDuplicate = (m: any) =>
  /duplicate key|unique constraint/i.test(String(m ?? ''));

/**
 * 사건 하나를 적는다. **같은 사건은 두 번 적히지 않는다.**
 *
 * 두 번째 시도는 오류가 아니라 `DUPLICATE`다 — 거래소를 다시 읽거나
 * 워커가 재시작하면 당연히 또 온다. 그때 합계가 두 배가 되는 것이
 * 진짜 사고다.
 */
export async function writeLedgerEvent(sb: any, raw: Partial<LedgerEvent>): Promise<WriteResult> {
  const v = ledgerEventOf(raw);
  if (!v.ok || !v.event) {
    return { ok: false, code: 'REJECTED', idempotencyKey: null, reason: v.message };
  }
  const e = v.event;
  const row = {
    user_id: e.userId, env: e.env, connection_id: e.connectionId, exchange: e.exchange,
    kind: e.kind, strategy_id: e.strategyId, strategy_hash: e.strategyHash,
    symbol: e.symbol, venue_order_id: e.venueOrderId, order_intent_id: e.orderIntentId,
    amount: e.amount, currency: e.currency, quantity: e.quantity, price: e.price,
    occurred_at: new Date(e.occurredAtMs).toISOString(),
    source: e.source, correlation_id: e.correlationId,
    idempotency_key: e.idempotencyKey, note: e.note,
  };

  try {
    const { error } = await (sb as any).from('ledger_events').insert(row);
    if (!error) {
      return { ok: true, code: 'WRITTEN', idempotencyKey: e.idempotencyKey, reason: '' };
    }
    if (isDuplicate(error.message)) {
      // **이미 있는 것은 성공이다.** 멱등이란 그런 뜻이다.
      return { ok: true, code: 'DUPLICATE', idempotencyKey: e.idempotencyKey,
        reason: '이미 적힌 사건입니다 — 다시 적지 않습니다' };
    }
    if (isMissingTable(error.message)) {
      return { ok: false, code: 'TABLE_MISSING', idempotencyKey: e.idempotencyKey,
        reason: 'ledger_events 표가 없습니다 — 마이그레이션 056을 적용하세요' };
    }
    return { ok: false, code: 'FAILED', idempotencyKey: e.idempotencyKey,
      reason: String(error.message || error) };
  } catch (err: any) {
    return { ok: false, code: 'FAILED', idempotencyKey: e.idempotencyKey,
      reason: String(err?.message || err) };
  }
}

/**
 * 매매 경로에서 부르는 얇은 껍데기.
 *
 * **실패해도 예외를 던지지 않는다.** 장부 장애가 주문 장애가 되면 안
 * 된다. 다만 실패를 조용히 삼키지도 않는다 — 나중에 합계가 안 맞는
 * 이유가 여기 있을 수 있다.
 */
export async function recordLedgerEvent(
  sb: any, raw: Partial<LedgerEvent>, label = 'ledger',
): Promise<WriteResult> {
  const r = await writeLedgerEvent(sb, raw);
  if (!r.ok) {
    // 값은 안 찍는다 — 사유만.
    console.warn(`[${label}] 장부 기록 실패 (${r.code}): ${r.reason}`);
  }
  return r;
}

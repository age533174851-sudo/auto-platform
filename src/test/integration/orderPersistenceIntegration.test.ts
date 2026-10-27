// src/test/integration/orderPersistenceIntegration.test.ts
//
// **장부에 못 적었는데 주문이 나가지 않는가.**
//
// `executeOrder`는 전송 직전에 `status: 'SENT'`를 적는다. 그 기록이
// 실패해도 **지금은 그대로 주문을 보낸다** — `updateOrderRow`가 오류를
// 삼키고, 감싸는 `update()`도 예외를 삼키기 때문이다.
//
// 그러면 거래소에는 주문이 있고 장부에는 `INTENT`가 남는다. 그 줄은
// 미확정으로 쌓이고, 대조는 "보낸 적 없는 주문"으로 읽는다. 사람이
// 보는 모든 화면이 틀린 상태가 된다.
//
// 실패의 모양이 셋인 이유
// ───────────────────────
// 실제 DB 장애는 세 가지로 온다 — `error` 반환 · 예외 throw · **0행 갱신**.
// 마지막 것이 가장 조용하다: 오류가 없는데 아무것도 안 적힌다. 셋을
// 한 가지로만 시험하면 나머지 둘은 그대로 남는다.
//
// 전송 전과 전송 후는 다르다
// ──────────────────────────
// 전송 **전** 기록 실패는 보내지 않는 것이 맞다(fail-closed).
// 전송 **후** 기록 실패에 같은 규칙을 쓰면 안 된다 — 이미 나간 주문을
// "실패"로 적으면 사람은 포지션이 없다고 믿는다. 그건 더 나쁘다.
import { test, eq, assert } from '../harness';
import { FakeVenue, FakeDb, withCryptoEnv } from './venueHarness';
import { executeOrder } from '../../lib/engine/orderExecutor';

const BN_ORDER = '/fapi/v1/order';
const BN_POS = '/fapi/v2/positionRisk';
const BN_LEV = '/fapi/v1/leverage';
const BN_DUAL = '/fapi/v1/positionSide/dual';
const BN_EXINFO = '/fapi/v1/exchangeInfo';
const BN_MARGIN = '/fapi/v1/marginType';

const SYM = 'BTCUSDT';

function venueOk(entry: any = { orderId: 8100, symbol: SYM, status: 'FILLED',
  executedQty: '0.010', origQty: '0.010', avgPrice: '95000' }): FakeVenue {
  return new FakeVenue()
    .on(BN_EXINFO, { json: { symbols: [{ symbol: SYM, filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
    ] }] } })
    .on(BN_MARGIN, { json: { code: 200, msg: 'success' } })
    .on(BN_LEV, { json: { leverage: 100, symbol: SYM } })
    .on(BN_DUAL, { json: { dualSidePosition: false } })
    .on('/fapi/v1/account', { json: { positions: [], assets: [] } })
    .on(BN_POS, { json: [{ symbol: SYM, positionAmt: '0', entryPrice: '0',
      leverage: '100', marginType: 'isolated', liquidationPrice: '0' }] })
    .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
    .on(BN_ORDER, { json: entry }, 'POST');
}

const plan = (over: Record<string, any> = {}) => ({
  approved: true, symbol: SYM, side: 'LONG' as const,
  riskAmount: 10, riskAmountWithCosts: 10,
  stopDistancePct: 1, effectiveStopPct: 1,
  positionSize: 1000, quantity: 0.01, requiredMargin: 10,
  leverage: 100, liquidationPrice: 90000, liquidationDistancePct: 1,
  notes: [], ...over,
}) as any;

async function exec(db: FakeDb, args: Record<string, any> = {}) {
  return executeOrder(db as any, {
    userId: 'u1', connectionId: 'c1', signalId: 'sig-1',
    clientOrderId: args.clientOrderId ?? 'PERSIST-1',
    exchange: 'binance', mode: 'TESTNET',
    plan: args.plan ?? plan(),
    apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
    stopPolicy: 'NO_FIXED_SL', takeProfitPolicy: 'NO_FIXED_TP', protectionPolicy: 'NONE',
    ...args,
  } as any);
}

async function scenario<T>(venue: FakeVenue, body: () => Promise<T>): Promise<T | Error> {
  const restore = venue.install();
  const unenv = withCryptoEnv();
  try { return await body(); }
  catch (e: any) { return e instanceof Error ? e : new Error(String(e)); }
  finally { restore(); unenv(); }
}

/** 전송 직전 기록(`SENT`)만 골라 실패시킨다 */
const onSent = (p: Record<string, any>) => p.status === 'SENT';

export async function runOrderPersistenceTests() {
  console.log('[통합 — 장부에 못 적으면 주문도 나가지 않는다]');

  // ══════════ ① 전송 전 기록 실패 세 가지 — 전부 주문 0건 ══════════
  for (const mode of ['error', 'throw', 'zero-rows'] as const) {
    const db = new FakeDb({
      updateFailure: { table: 'live_orders', mode, onlyWhen: onSent },
    });
    const venue = venueOk();
    const r = await scenario(venue, () => exec(db, { clientOrderId: `PERSIST-${mode}` }));

    test(`★★ SENT 기록이 ${mode}로 실패하면 주문을 보내지 않는다`, () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0,
        '장부에 전송 기록을 못 남겼는데 주문이 나갔다'
        + ' — 거래소에는 주문이 있고 장부에는 INTENT가 남는다');
    });

    test(`★★ ${mode} 실패를 전송 성공으로 보고하지 않는다`, () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq((r as any).ok, false, `ok=${(r as any).ok} — 보내지도 않았는데 성공이다`);
      assert((r as any).status !== 'ACKED' && (r as any).status !== 'FILLED',
        `${(r as any).status}로 보고했다`);
      assert(/장부|기록|DB/.test(String((r as any).message ?? '')),
        `사유가 기록 실패라고 말하지 않는다: ${(r as any).message}`);
    });
  }

  // ══════════ ② 복구 컬럼 재시도도 실패하면 삼키지 않는다 ══════════
  //
  // `updateOrderRow`는 첫 update가 실패하면 복구 전용 칸을 떼고 **한 번
  // 더** 쓴다(스키마가 아직 그 칸을 모르는 경우를 위해서다). 그런데 그
  // 두 번째 결과를 **보지 않는다.** 그래서 진짜 DB 장애는 "재시도했으니
  // 됐겠지"로 조용히 통과한다. `SENT` 기록에는 `pos_qty_before`가 함께
  // 실려 있어 반드시 이 경로를 탄다.
  {
    const db = new FakeDb({
      updateFailure: { table: 'live_orders', mode: 'error', onlyWhen: onSent },
    });
    const venue = venueOk();
    const r = await scenario(venue, () => exec(db, { clientOrderId: 'PERSIST-RETRY' }));

    test('★★ 복구 칸을 뗀 재시도도 실패하면 주문을 보내지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0, '두 번째 쓰기 실패를 삼키고 주문을 보냈다');
    });
  }

  // ══════════ ③ 0행 갱신 — 가장 조용한 실패 ══════════
  {
    const db = new FakeDb({
      updateFailure: { table: 'live_orders', mode: 'zero-rows', onlyWhen: onSent },
    });
    const venue = venueOk();
    await scenario(venue, () => exec(db, { clientOrderId: 'PERSIST-ZERO' }));

    test('★★ 0행 갱신은 성공이 아니다 — 장부에 SENT가 남지 않았으면 보내지 않는다', () => {
      const row = db.table('live_orders')[0];
      assert(row, '장부 줄이 없다');
      assert(row.status !== 'SENT',
        '0행 갱신인데 장부에 SENT가 적혔다 — 가짜 성공이다');
      eq(venue.orderSends().length, 0, '아무 줄도 안 바뀌었는데 주문이 나갔다');
    });
  }

  // ══════════ ④ 전송 **뒤** 기록 실패는 실패로 단정하지 않는다 ══════════
  //
  // 이미 나간 주문을 "실패"로 적으면 사람은 포지션이 없다고 믿는다.
  // 전송 전과 **반대 방향**으로 안전해야 한다.
  {
    const db = new FakeDb({
      updateFailure: { table: 'live_orders', mode: 'error',
        onlyWhen: (p) => p.status === 'FILLED' || p.status === 'ACKED' },
    });
    const venue = venueOk();
    const r = await scenario(venue, () => exec(db, { clientOrderId: 'PERSIST-AFTER' }));

    test('★★ 전송 뒤 기록 실패를 "주문 실패"로 적지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 1, '주문은 나갔어야 한다');
      assert((r as any).status !== 'FAILED' && (r as any).status !== 'REJECTED',
        `이미 나간 주문을 ${(r as any).status}로 적었다 — 사람은 포지션이 없다고 믿는다`);
    });

    test('★★ 그 대신 "기록하지 못했다"는 사실이 남는다', () => {
      const row = db.table('live_orders')[0];
      assert(row, '장부 줄이 없다');
      const said = String((r as any)?.message ?? '') + String(row.error_message ?? '');
      assert(/장부|기록|확인/.test(said),
        `전송 뒤 기록 실패가 아무 데도 안 남았다: 반환="${(r as any)?.message}" 장부="${row.error_message}"`);
    });
  }

  // ══════════ ⑤ 정상 쓰기 — 기존 동작 그대로 ══════════
  {
    const db = new FakeDb();
    const venue = venueOk();
    const r = await scenario(venue, () => exec(db, { clientOrderId: 'PERSIST-OK' }));

    test('기록이 정상이면 예전처럼 주문 1건이 나가고 체결이 적힌다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 1);
      eq((r as any).ok, true, (r as any).message);
      const row = db.table('live_orders')[0];
      eq(row.status, 'FILLED', `장부가 ${row.status}다`);
    });
  }
}

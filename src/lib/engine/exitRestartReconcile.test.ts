import { test, eq } from '../../test/harness';
import { classifyExitRestart as decide } from './exitRestartReconcile';
import { reconcileExitRestartReadOnly } from './exitRestartEvidence';
import { gateRestartExitDispatch } from './exitRestartDispatch';
import { binanceExitOrderStatus } from './exitRestartOrderStatus';
import { claimExitBeforeSend, type ExitIntentRecord } from './exitRestartIntentStore';
import { supabaseTestnetExitIntentStore, EXIT_ORDER_INTENT_TABLE } from './exitRestartSupabaseStore';
import { readBinanceTestnetExitOrderEvidence } from './exitRestartBinanceRead';

export function runExitRestartReconcileTests() {
  console.log('\n🔒 #325 재시작 청산 대조 (가짜 거래소)');
  test('응답 유실 + 주문 미확인 + 포지션 잔존: 재전송 0', () => {
    const r = decide({ intent: 'UNKNOWN', position: { ok: true, found: true },
      order: { ok: true, state: 'NOT_FOUND' } });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayResend, false); eq(r.mayMarkClosed, false);
  });
  test('부분 체결 + 잔여 포지션: 재전송·종료 기록 모두 차단', () => {
    const r = decide({ intent: 'ACCEPTED', position: { ok: true, found: true },
      order: { ok: true, state: 'PARTIAL' } });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayResend, false); eq(r.mayMarkClosed, false);
  });
  test('포지션 조회 실패는 종료 증거가 아니다', () => {
    const r = decide({ intent: 'SENT', position: { ok: false, found: false },
      order: { ok: true, state: 'FILLED' } });
    eq(r.code, 'READ_FAILED'); eq(r.mayMarkClosed, false);
  });
  test('주문 조회 실패 + 포지션 0: 종료를 아직 확정하지 않는다', () => {
    const r = decide({ intent: 'UNKNOWN', position: { ok: true, found: false },
      order: { ok: false, state: 'UNKNOWN' } });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayMarkClosed, false);
  });
  test('체결 확인 + 포지션 0: 종료 기록만 허용, 재전송 불허', () => {
    const r = decide({ intent: 'FILLED', position: { ok: true, found: false },
      order: { ok: true, state: 'FILLED' } });
    eq(r.code, 'FLAT_VERIFIED'); eq(r.mayMarkClosed, true); eq(r.mayResend, false);
  });
  test('재시작 후 주문이 취소됐어도 포지션이 남으면 새 주문을 자동 발행하지 않는다', () => {
    const r = decide({ intent: 'ACCEPTED', position: { ok: true, found: true },
      order: { ok: true, state: 'CANCELLED' } });
    eq(r.code, 'POSITION_OPEN'); eq(r.mayResend, false);
  });
  test('거부된 주문 + 포지션 0은 이 청산의 성공 증거가 아니다', () => {
    const r = decide({ intent: 'REJECTED', position: { ok: true, found: false },
      order: { ok: true, state: 'REJECTED' } });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayMarkClosed, false);
  });
  test('취소된 주문 + 포지션 0도 이 청산의 성공 증거가 아니다', () => {
    const r = decide({ intent: 'ACCEPTED', position: { ok: true, found: false },
      order: { ok: true, state: 'CANCELLED' } });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayMarkClosed, false);
  });
  test('영속 의도가 NONE이면 타인의 체결로 종료 처리하지 않는다', () => {
    const r = decide({ intent: 'NONE', position: { ok: true, found: false },
      order: { ok: true, state: 'FILLED' } });
    eq(r.code, 'NO_INTENT'); eq(r.mayMarkClosed, false);
  });
  test('재시작 2회: 같은 영속 주문 ID로만 조회하고 신규 전송은 없다', async () => {
    const calls: string[] = [];
    const durable = { clientOrderId: 'exit-abc', state: 'UNKNOWN' as const };
    const reads = {
      loadIntent: async () => { calls.push('load'); return durable; },
      readPosition: async () => { calls.push('position'); return { ok: true, found: true }; },
      readOrder: async (id: string) => { calls.push('order:' + id);
        return { ok: true, state: 'NOT_FOUND' as const }; },
    };
    const a = await reconcileExitRestartReadOnly(reads);
    const b = await reconcileExitRestartReadOnly(reads);
    eq(a.mayResend, false); eq(b.mayResend, false);
    eq(a.needsReconcile, true); eq(b.needsReconcile, true);
    eq(calls.join(','), 'load,position,order:exit-abc,load,position,order:exit-abc');
  });
  test('동시 재시작 워커 3개: 같은 영속 주문 ID 조회만 하고 재전송 권한 0', async () => {
    const ids: string[] = [];
    const reads = {
      loadIntent: async () => ({ clientOrderId: 'exit-stable-325', state: 'UNKNOWN' as const }),
      readPosition: async () => ({ ok: true, found: true }),
      readOrder: async (id: string) => { ids.push(id);
        return { ok: true, state: 'NOT_FOUND' as const }; },
    };
    const verdicts = await Promise.all(Array.from({ length: 3 }, () =>
      reconcileExitRestartReadOnly(reads)));
    eq(ids.length, 3);
    eq(ids.every(id => id === 'exit-stable-325'), true);
    eq(verdicts.every(v => v.code === 'ORDER_UNRESOLVED'
      && v.mayResend === false && v.mayMarkClosed === false), true);
  });
  test('영속 주문 ID가 없으면 거래소를 조회하지 않고 차단', async () => {
    let queried = 0;
    const r = await reconcileExitRestartReadOnly({
      loadIntent: async () => ({ clientOrderId: null, state: 'SENT' }),
      readPosition: async () => { queried++; return { ok: true, found: false }; },
      readOrder: async () => { queried++; return { ok: true, state: 'FILLED' }; },
    });
    eq(queried, 0); eq(r.code, 'READ_FAILED'); eq(r.mayMarkClosed, false);
  });
  test('재시작 대조에서 주문 조회 예외는 종료가 아니다', async () => {
    const r = await reconcileExitRestartReadOnly({
      loadIntent: async () => ({ clientOrderId: 'exit-abc', state: 'UNKNOWN' }),
      readPosition: async () => ({ ok: true, found: false }),
      readOrder: async () => { throw new Error('timeout'); },
    });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayMarkClosed, false);
  });
  test('거부된 영속 의도와 체결된 거래소 주문이 충돌하면 종료 기록 금지', () => {
    const r = decide({ intent: 'REJECTED', position: { ok: true, found: false },
      order: { ok: true, state: 'FILLED' } });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayMarkClosed, false); eq(r.mayResend, false);
  });
  test('영속 기록 조회 예외 시 포지션·주문 조회 자체를 하지 않는다', async () => {
    let queried = 0;
    const r = await reconcileExitRestartReadOnly({
      loadIntent: async () => { throw new Error('db unavailable'); },
      readPosition: async () => { queried++; return { ok: true, found: false }; },
      readOrder: async () => { queried++; return { ok: true, state: 'FILLED' }; },
    });
    eq(queried, 0); eq(r.code, 'READ_FAILED'); eq(r.mayResend, false);
  });
  test('재시작 발송 관문: 주문 미확인 시 새 주문 허가하지 않음', async () => {
    const r = await gateRestartExitDispatch({
      loadIntent: async () => ({ clientOrderId: 'exit-325', state: 'UNKNOWN' }),
      readPosition: async () => ({ ok: true, found: true }),
      readOrder: async () => ({ ok: true, state: 'NOT_FOUND' }),
    });
    eq(r.code, 'RECONCILE_REQUIRED'); eq(r.maySend, false);
  });
  test('재시작 발송 관문: DB 장애 시 신규 주문 허가하지 않음', async () => {
    const r = await gateRestartExitDispatch({
      loadIntent: async () => { throw new Error('storage down'); },
      readPosition: async () => { throw new Error('must not read'); },
      readOrder: async () => { throw new Error('must not read'); },
    });
    eq(r.code, 'NO_DURABLE_INTENT'); eq(r.maySend, false);
  });
  test('재시작 발송 관문: 체결·포지션 0 확인 시에도 재전송하지 않음', async () => {
    const r = await gateRestartExitDispatch({
      loadIntent: async () => ({ clientOrderId: 'exit-325', state: 'FILLED' }),
      readPosition: async () => ({ ok: true, found: false }),
      readOrder: async () => ({ ok: true, state: 'FILLED' }),
    });
    eq(r.code, 'ALREADY_FLAT'); eq(r.maySend, false);
    eq(r.verdict.mayMarkClosed, true);
  });
  test('Binance 상태 변환: 체결·부분 체결·취소·거부를 구분', () => {
    const id = 'exit-stable-325';
    for (const [raw, expected] of [
      ['NEW', 'OPEN'], ['PARTIALLY_FILLED', 'PARTIAL'],
      ['FILLED', 'FILLED'], ['CANCELED', 'CANCELLED'],
      ['EXPIRED', 'CANCELLED'], ['REJECTED', 'REJECTED'],
    ] as const) {
      const r = binanceExitOrderStatus({ clientOrderId: id, status: raw }, id);
      eq(r.ok, true); eq(r.state, expected);
    }
  });
  test('Binance 상태 변환: 다른 주문 ID·빈 응답·알 수 없는 상태는 증거 아님', () => {
    const id = 'exit-stable-325';
    for (const raw of [
      null, { clientOrderId: 'another-order', status: 'FILLED' },
      { clientOrderId: id, status: 'SOMETHING_NEW' },
      { clientOrderId: id, status: null },
    ]) {
      const r = binanceExitOrderStatus(raw, id);
      eq(r.ok, false); eq(r.state, 'UNKNOWN');
    }
  });
  test('영속 청산 claim: 동시 3개 중 단 1개만 전송 권한', async () => {
    const intent: ExitIntentRecord = {
      clientOrderId: 'exit-325', connectionId: 'conn-1',
      symbol: 'BTCUSDT', state: 'SENT', ownerToken: 'owner-1',
    };
    let claimed = false;
    const store = {
      claim: async (i: ExitIntentRecord) => {
        if (claimed) return { code: 'EXISTS' as const, record: i };
        claimed = true;
        return { code: 'CLAIMED' as const, record: i };
      },
    };
    const results = await Promise.all(Array.from({ length: 3 },
      () => claimExitBeforeSend(store, intent)));
    eq(results.filter(r => r.maySend).length, 1);
    eq(results.filter(r => r.code === 'EXISTS').length, 2);
  });
  test('영속 청산 claim: 저장소 장애·위조 응답은 전송 차단', async () => {
    const intent: ExitIntentRecord = {
      clientOrderId: 'exit-325', connectionId: 'conn-1',
      symbol: 'BTCUSDT', state: 'SENT', ownerToken: 'owner-1',
    };
    const down = await claimExitBeforeSend({
      claim: async () => { throw new Error('db unavailable'); },
    }, intent);
    eq(down.maySend, false); eq(down.code, 'UNAVAILABLE');
    const wrong = await claimExitBeforeSend({
      claim: async i => ({ code: 'CLAIMED', record: { ...i, ownerToken: 'other' } }),
    }, intent);
    eq(wrong.maySend, false);
  });
  test('Supabase 원자 선점 경계: INSERT/PK 충돌만 사용, 3명 중 1명 허가', async () => {
    const intent: ExitIntentRecord = {
      clientOrderId: 'x5t-restart-325',
      connectionId: '44c25b6f-18cf-465f-9a21-c1b53569b999',
      symbol: 'BTCUSDT', state: 'SENT', ownerToken: 'worker-a',
    };
    let row: any = null;
    let insertCalls = 0;
    let lookupCalls = 0;
    const sb = {
      from: (table: string) => {
        eq(table, EXIT_ORDER_INTENT_TABLE);
        return {
          insert: (payload: any) => {
            insertCalls++;
            eq(payload.mode, 'TESTNET');
            return { select: (_: string) => ({
              single: async () => {
                if (row) return { data: null, error: { code: '23505' } };
                row = payload;
                return { data: row, error: null };
              },
            }) };
          },
          select: (_: string) => {
            lookupCalls++;
            return {
              eq: (column: string, value: string) => {
                eq(column, 'client_order_id'); eq(value, intent.clientOrderId);
                return { maybeSingle: async () => ({ data: row, error: null }) };
              },
            };
          },
        };
      },
    };
    const store = supabaseTestnetExitIntentStore(sb, true);
    const all = await Promise.all(Array.from({ length: 3 },
      () => claimExitBeforeSend(store, intent)));
    eq(all.filter(r => r.maySend).length, 1);
    eq(all.filter(r => r.code === 'EXISTS').length, 2);
    eq(insertCalls, 3); eq(lookupCalls, 2);
  });
  test('Supabase 선점: TESTNET 미검증 시 DB 접근 0·주문 권한 0', async () => {
    let calls = 0;
    const sb = { from: () => { calls++; throw new Error('MUST_NOT_TOUCH_DB'); } };
    const intent: ExitIntentRecord = {
      clientOrderId: 'x5t-restart-325',
      connectionId: '44c25b6f-18cf-465f-9a21-c1b53569b999',
      symbol: 'BTCUSDT', state: 'SENT', ownerToken: 'worker-a',
    };
    const result = await claimExitBeforeSend(
      supabaseTestnetExitIntentStore(sb, false), intent);
    eq(result.code, 'UNAVAILABLE'); eq(result.maySend, false); eq(calls, 0);
  });
  test('Supabase 선점: INSERT 결과가 LIVE 또는 다른 신원이라면 권한 0', async () => {
    const intent: ExitIntentRecord = {
      clientOrderId: 'x5t-restart-325',
      connectionId: '44c25b6f-18cf-465f-9a21-c1b53569b999',
      symbol: 'BTCUSDT', state: 'SENT', ownerToken: 'worker-a',
    };
    const make = (mode: string, owner: string) => ({
      from: () => ({ insert: (_: any) => ({ select: (_: string) => ({
        single: async () => ({ error: null, data: {
          client_order_id: intent.clientOrderId,
          connection_id: intent.connectionId, symbol: intent.symbol,
          owner_token: owner, mode, state: 'SENT',
        } }),
      }) }) }),
    });
    for (const [mode, owner] of [['LIVE', 'worker-a'], ['TESTNET', 'other']]) {
      const r = await claimExitBeforeSend(
        supabaseTestnetExitIntentStore(make(mode, owner), true), intent);
      eq(r.maySend, false);
    }
  });
  test('Supabase 선점: DB 읽기·쓰기 오류는 무조건 차단', async () => {
    const intent: ExitIntentRecord = {
      clientOrderId: 'x5t-restart-325',
      connectionId: '44c25b6f-18cf-465f-9a21-c1b53569b999',
      symbol: 'BTCUSDT', state: 'SENT', ownerToken: 'worker-a',
    };
    const sb = { from: () => ({ insert: (_: any) => ({
      select: (_: string) => ({ single: async () => { throw new Error('timeout'); } }),
    }) }) };
    const store = supabaseTestnetExitIntentStore(sb, true);
    const result = await claimExitBeforeSend(store, intent);
    eq(result.code, 'UNAVAILABLE'); eq(result.maySend, false);
  });
  test('Supabase 재시작 읽기: 원본 주문 ID와 연결이 모두 일치해야 한다', async () => {
    const id = 'x5t-restart-325';
    const conn = '44c25b6f-18cf-465f-9a21-c1b53569b999';
    let eqCalls: string[] = [];
    const sb = { from: () => ({
      select: (_: string) => ({
        eq: (field: string, val: string): any => {
          eqCalls.push(field + '=' + val);
          return { eq: (field2: string, val2: string) => {
            eqCalls.push(field2 + '=' + val2);
            return { maybeSingle: async () => ({ error: null, data: {
              client_order_id: id, connection_id: conn,
              symbol: 'BTCUSDT', owner_token: 'worker-a',
              state: 'SENT', mode: 'TESTNET',
            } }) };
          } };
        },
      }),
    }) };
    const loaded = await supabaseTestnetExitIntentStore(sb, true).load(id, conn);
    eq(loaded?.clientOrderId, id); eq(loaded?.state, 'SENT');
    eq(eqCalls.join(','), 'client_order_id=' + id + ',connection_id=' + conn);
  });
  test('Binance TESTNET 읽기: 검증 안 되면 거래소를 조회하지 않는다', async () => {
    let calls = 0;
    const q = { apiKey: 'test-key', apiSecret: 'test-secret',
      symbol: 'BTCUSDT', clientOrderId: 'x5tabc123', verifiedTestnet: false };
    const r = await readBinanceTestnetExitOrderEvidence(q, async () => {
      calls++; return { found: true, order: { status: 'FILLED',
        clientOrderId: 'x5tabc123' } };
    });
    eq(calls, 0); eq(r.ok, false); eq(r.state, 'UNKNOWN');
  });
  test('Binance TESTNET 읽기: 원본 ID로만 조회하고 강제로 testnet=true', async () => {
    const id = 'x5tabc123';
    const q = { apiKey: 'test-key', apiSecret: 'test-secret',
      symbol: 'BTCUSDT', clientOrderId: id, verifiedTestnet: true };
    const r = await readBinanceTestnetExitOrderEvidence(q,
      async (_key, _secret, symbol, gotId, testnet) => {
        eq(symbol, 'BTCUSDT'); eq(gotId, id); eq(testnet, true);
        return { found: true, order: { clientOrderId: id, status: 'FILLED' } };
      });
    eq(r.ok, true); eq(r.state, 'FILLED');
  });
  test('Binance TESTNET 읽기: 미발견·오류·ID 불일치는 재전송 근거가 아니다', async () => {
    const q = { apiKey: 'test-key', apiSecret: 'test-secret',
      symbol: 'BTCUSDT', clientOrderId: 'x5tabc123', verifiedTestnet: true };
    const missing = await readBinanceTestnetExitOrderEvidence(q,
      async () => ({ found: false }));
    eq(missing.ok, true); eq(missing.state, 'NOT_FOUND');
    const verdict = decide({ intent: 'SENT', position: { ok: true, found: true },
      order: missing });
    eq(verdict.mayResend, false); eq(verdict.code, 'ORDER_UNRESOLVED');
    const failure = await readBinanceTestnetExitOrderEvidence(q,
      async () => { throw new Error('timeout'); });
    eq(failure.ok, false); eq(failure.state, 'UNKNOWN');
    const wrong = await readBinanceTestnetExitOrderEvidence(q,
      async () => ({ found: true, order: { status: 'FILLED',
        clientOrderId: 'x5tother' } }));
    eq(wrong.ok, false); eq(wrong.state, 'UNKNOWN');
  });
  test('영속 의도 기록을 못 읽으면 차단한다', () => {
    const r = decide({ intent: undefined, position: { ok: true, found: false },
      order: { ok: true, state: 'FILLED' } });
    eq(r.code, 'READ_FAILED'); eq(r.mayMarkClosed, false);
  });
}

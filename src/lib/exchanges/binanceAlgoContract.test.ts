// Binance USD-M Algo conditional contract — zero-network synthetic tests.
// This suite MUST be registered once in scripts/run-tests.mjs.
import { test, eq, assert } from '../../test/harness';
import {
  buildBinanceConditionalAlgoPayload, parseBinanceAlgoAcceptance,
  verifyBinanceAlgoOpenReadback,
  inspectBinanceAlgoRecovery,
  queryBinanceAlgoByClientId,
  inspectBinanceAlgoCancellationEvidence,
  binanceAlgoCancellationIdentifier, type BinanceConditionalAlgoIntent,
} from './binanceAlgoContract';

const intent = (extra: Partial<BinanceConditionalAlgoIntent> = {}):
  BinanceConditionalAlgoIntent => ({
    environment: 'TESTNET', symbol: 'BTCUSDT', positionMode: 'ONE_WAY',
    closes: 'LONG', side: 'SELL', type: 'STOP_MARKET',
    triggerPrice: 65000.2, tickSize: 0.1,
    workingType: 'MARK_PRICE',
    referencePrice: 65000.3,
    referenceObservedAtMs: 100000, evaluatedAtMs: 100500,
    maxReferenceAgeMs: 3000,
    closeAll: true,
    clientAlgoId: 'TRAIGO_TEST_CLOSE_001',
    ...extra,
  });

export function runBinanceAlgoContractTests() {
  test('OFFLINE 32 scenario matrix BTC/ETH × LONG/SHORT × 10X/100X × STOP/TP × close forms', () => {
    let n = 0;
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
      for (const closes of ['LONG', 'SHORT'] as const) {
        for (const leverage of [10, 100]) {
          for (const type of ['STOP_MARKET', 'TAKE_PROFIT_MARKET'] as const) {
            for (const closeAll of [true, false]) {
              const request = intent({
                symbol, closes, side: closes === 'LONG' ? 'SELL' : 'BUY',
                type, closeAll,
                triggerPrice: symbol === 'BTCUSDT' ? 65000.2 : 3500.15,
                tickSize: symbol === 'BTCUSDT' ? .1 : .01,
                // The trigger must be above or below the same-type venue
                // reference depending on LONG/SHORT and STOP/TP.
                referencePrice: (symbol === 'BTCUSDT' ? 65000.2 : 3500.15) +
                  ((type === 'STOP_MARKET'
                    ? closes === 'LONG' : closes === 'SHORT')
                    ? (symbol === 'BTCUSDT' ? .1 : .01)
                    : -(symbol === 'BTCUSDT' ? .1 : .01)),
                clientAlgoId: 'SMOKE_' + n.toString().padStart(3, '0'),
                ...(closeAll ? {} : { quantity: symbol === 'BTCUSDT' ? 0.005 : 0.02,
                  quantityStep: .001, reduceOnly: true }),
              });
              // Leverage is an account condition and never sent as an Algo
              // order param. Running both 10X/100X validates no hidden fork.
              const v = buildBinanceConditionalAlgoPayload(request);
              eq(v.code, 'OK', symbol + closes + leverage + type);
              assert(!!v.payload);
              eq(v.payload!.algoType, 'CONDITIONAL');
              eq(v.payload!.positionSide, 'BOTH');
              eq(v.payload!.side, request.side);
              eq(v.payload!.type, type);
              eq(v.payload!.triggerPrice, String(request.triggerPrice));
              eq(v.payload!.clientAlgoId, request.clientAlgoId);
              eq(v.payload!.closePosition, closeAll ? 'true' : undefined);
              eq(v.payload!.reduceOnly, closeAll ? undefined : 'true');
              eq(v.payload!.quantity, closeAll ? undefined : String(request.quantity));
              eq('stopPrice' in v.payload!, false, 'Algo uses triggerPrice not stopPrice');
              eq('leverage' in v.payload!, false, 'Never change leverage in conditional payload');
              eq(v.executionAuthorized, false);
              n++;
            }
          }
        }
      }
    }
    eq(n, 32);
  });

  test('LIVE/UNKNOWN environment is rejected even with syntactically valid payload', () => {
    for (const environment of ['LIVE', 'UNKNOWN'] as const) {
      const v = buildBinanceConditionalAlgoPayload(intent({ environment }));
      eq(v.code, 'NOT_TESTNET'); eq(v.ok, false); eq(v.payload, null);
    }
  });

  test('HEDGE or unknown account position mode is blocked, not guessed to BOTH', () => {
    for (const positionMode of ['HEDGE', 'UNKNOWN'] as const) {
      eq(buildBinanceConditionalAlgoPayload(intent({ positionMode })).code,
        'MODE_UNKNOWN_OR_UNSUPPORTED');
    }
  });

  test('Wrong order side must never turn a close into an entry', () => {
    eq(buildBinanceConditionalAlgoPayload(intent({ closes: 'LONG', side: 'BUY' })).code,
      'SIDE_MISMATCH');
    eq(buildBinanceConditionalAlgoPayload(intent({ closes: 'SHORT', side: 'SELL' })).code,
      'SIDE_MISMATCH');
  });

  test('Close-all rejects even a dangling quantity OR reduceOnly argument', () => {
    for (const extra of [
      { quantity: 0.001 }, { reduceOnly: true },
      { quantity: 0.001, reduceOnly: true },
      { reduceOnly: false },
    ]) {
      eq(buildBinanceConditionalAlgoPayload(intent(extra)).code,
        'CONFLICTING_CLOSE_FORM');
    }
  });

  test('Quantity-close requires reduceOnly=true and independently verified lot grid', () => {
    for (const extra of [
      { quantity: undefined, reduceOnly: true, quantityStep: .001 },
      { quantity: 0.005, reduceOnly: undefined, quantityStep: .001 },
      { quantity: 0.005, reduceOnly: false, quantityStep: .001 },
      { quantity: 0.0055, reduceOnly: true, quantityStep: .001 },
      { quantity: 0.005, reduceOnly: true, quantityStep: null },
      { quantity: 0, reduceOnly: true, quantityStep: .001 },
    ]) {
      eq(buildBinanceConditionalAlgoPayload(intent({ closeAll: false, ...extra })).code,
        'QUANTITY_UNKNOWN_OR_OFF_GRID');
    }
  });

  test('No guessed ticks: off-grid trigger and unknown tick block sending', () => {
    for (const extra of [
      { triggerPrice: 65000.25 }, { tickSize: null },
      { tickSize: 0 }, { tickSize: NaN }, { triggerPrice: Infinity },
    ] as any[]) {
      assert(!buildBinanceConditionalAlgoPayload(intent(extra)).ok);
    }
  });

  test('Trigger side must match LONG/SHORT and STOP/TP; equality is not safe', () => {
    for (const closes of ['LONG', 'SHORT'] as const) {
      for (const type of ['STOP_MARKET', 'TAKE_PROFIT_MARKET'] as const) {
        const above = (type === 'STOP_MARKET') === (closes === 'SHORT');
        const reference = 65000.0;
        const safeTrigger = above ? 65000.1 : 64999.9;
        const safe = buildBinanceConditionalAlgoPayload(intent({
          closes, side: closes === 'LONG' ? 'SELL' : 'BUY',
          type, referencePrice: reference, triggerPrice: safeTrigger,
        }));
        eq(safe.code, 'OK', 'Proper trigger direction was rejected');
        for (const badTrigger of [reference, above ? 64999.9 : 65000.1]) {
          const bad = buildBinanceConditionalAlgoPayload(intent({
            closes, side: closes === 'LONG' ? 'SELL' : 'BUY',
            type, referencePrice: reference, triggerPrice: badTrigger,
          }));
          eq(bad.code, 'TRIGGER_WRONG_SIDE_OR_IMMEDIATE');
          eq(bad.executionAuthorized, false);
        }
      }
    }
  });

  test('Missing, stale or future-dated market reference cannot be used to create Algo trigger', () => {
    for (const extra of [
      { referencePrice: null },
      { referencePrice: 0 },
      { referencePrice: NaN },
      { referencePrice: Infinity },
      { referenceObservedAtMs: undefined },
      { referenceObservedAtMs: 96000 },
      { referenceObservedAtMs: 100501 },
      { evaluatedAtMs: 0 },
      { maxReferenceAgeMs: 0 },
      { maxReferenceAgeMs: 10000 },
      { maxReferenceAgeMs: 1.5 },
    ] as any[]) {
      const v = buildBinanceConditionalAlgoPayload(intent(extra));
      eq(v.code, 'REFERENCE_UNKNOWN_OR_STALE', JSON.stringify(extra));
      eq(v.payload, null);
    }
  });

  test('Client Algo IDs require a stable matching <=36 character identifier', () => {
    for (const clientAlgoId of ['', 'bad name', 'A'.repeat(37), 'bad?']) {
      eq(buildBinanceConditionalAlgoPayload(intent({ clientAlgoId })).code,
        'BAD_IDENTITY');
    }
    eq(buildBinanceConditionalAlgoPayload(intent({ clientAlgoId: 'SMOKE_20261016_0001' })).ok,true);
  });

  test('Response must match current clientAlgoId and symbol, not just have algoId', () => {
    const v = buildBinanceConditionalAlgoPayload(intent());
    const good = {
      algoId: '9007199254740993', clientAlgoId: v.payload!.clientAlgoId,
      algoType: 'CONDITIONAL', orderType: v.payload!.type,
      symbol: v.payload!.symbol, side: v.payload!.side, algoStatus: 'NEW',
    };
    const ack = parseBinanceAlgoAcceptance(good, v.payload);
    eq(ack.code, 'ACKED_UNVERIFIED');
    eq(ack.acceptedAlgoId, '9007199254740993');
    eq(ack.venueProtectionActiveVerified, false);
    eq(ack.executionAuthorized, false);
    for (const extra of [
      { algoId: 9007199254740992 },
      { clientAlgoId: 'stale-other-key' }, { algoId: 0 },
      { symbol: 'ETHUSDT' }, { side: 'BUY' },
      { orderType: 'TAKE_PROFIT_MARKET' }, { algoType: 'WRONG' },
      { algoId: null },
    ]) {
      const out = parseBinanceAlgoAcceptance({ ...good, ...extra }, v.payload);
      eq(out.code, 'UNKNOWN', JSON.stringify(extra));
      eq(out.venueProtectionActiveVerified, false);
    }
  });

  test('GET openAlgoOrders MUST independently prove exact algoId, clientAlgoId and trigger', () => {
    const build = buildBinanceConditionalAlgoPayload(intent());
    const p = build.payload!;
    const ack = parseBinanceAlgoAcceptance({
      algoId: '9007199254740993', clientAlgoId: p.clientAlgoId,
      algoType: 'CONDITIONAL', orderType: p.type,
      symbol: p.symbol, side: p.side,
    }, p);
    const open = { algoId: '9007199254740993',
      clientAlgoId: p.clientAlgoId, algoType: 'CONDITIONAL',
      orderType: p.type, symbol: p.symbol, side: p.side,
      positionSide: 'BOTH', algoStatus: 'NEW',
      workingType: p.workingType, triggerPrice: p.triggerPrice,
      closePosition: true, reduceOnly: false,
    };
    const result = verifyBinanceAlgoOpenReadback({
      accepted: ack, payload: p,
      venueRead: { success: true, orders: [open] },
    });
    eq(result.code, 'LISTED_OPEN_AT_READ');
    eq(result.listedOpenAtRead, true);
    eq(result.executionAuthorized, false);
    for (const mutation of [
      { algoId: '9007199254740994' },
      { side: 'BUY' }, { triggerPrice: '64000' },
      { positionSide: 'LONG' }, { algoStatus: 'EXPIRED' },
      { workingType: 'CONTRACT_PRICE' },
      { closePosition: false }, { clientAlgoId: 'another-id' },
    ]) {
      const r = verifyBinanceAlgoOpenReadback({
        accepted: ack, payload: p,
        venueRead: { success: true, orders: [{ ...open, ...mutation }] },
      });
      eq(r.listedOpenAtRead, false, JSON.stringify(mutation));
      eq(r.executionAuthorized, false);
    }
  });

  test('Missing from openAlgoOrders means UNKNOWN, NOT a safe resend', () => {
    const p = buildBinanceConditionalAlgoPayload(intent()).payload!;
    const ack = parseBinanceAlgoAcceptance({
      algoId: '321', clientAlgoId: p.clientAlgoId,
      algoType: 'CONDITIONAL', orderType: p.type,
      symbol: p.symbol, side: p.side,
    }, p);
    const noMatch = verifyBinanceAlgoOpenReadback({
      accepted: ack, payload: p, venueRead: { success: true, orders: [] },
    });
    eq(noMatch.code, 'NOT_LISTED_UNKNOWN');
    eq(noMatch.listedOpenAtRead, false);
    eq(noMatch.executionAuthorized, false);
    const readFailed = verifyBinanceAlgoOpenReadback({
      accepted: ack, payload: p,
      venueRead: { success: false, orders: [] },
    });
    eq(readFailed.code, 'READ_UNKNOWN');
    eq(readFailed.listedOpenAtRead, false);
  });

  test('Quantity-mode readback must match exact quantity and reduceOnly', () => {
    const p = buildBinanceConditionalAlgoPayload(intent({
      closeAll: false, quantity: 0.005, quantityStep: .001,
      reduceOnly: true,
    })).payload!;
    const a = parseBinanceAlgoAcceptance({
      algoId: '123', clientAlgoId: p.clientAlgoId,
      algoType: 'CONDITIONAL', orderType: p.type,
      symbol: p.symbol, side: p.side,
    }, p);
    const base = {
      algoId: '123', clientAlgoId: p.clientAlgoId,
      algoType: 'CONDITIONAL', orderType: p.type,
      symbol: p.symbol, side: p.side, positionSide: 'BOTH',
      algoStatus: 'NEW', workingType: p.workingType,
      triggerPrice: p.triggerPrice, reduceOnly: true,
      closePosition: false, quantity: '0.005',
    };
    eq(verifyBinanceAlgoOpenReadback({
      accepted: a, payload: p, venueRead: { success: true, orders: [base] },
    }).code, 'LISTED_OPEN_AT_READ');
    for (const mutation of [
      { quantity: '0.004' }, { reduceOnly: false },
      { closePosition: true }, { quantity: undefined },
    ]) {
      eq(verifyBinanceAlgoOpenReadback({
        accepted: a, payload: p, venueRead: {
          success: true, orders: [{ ...base, ...mutation }],
        },
      }).listedOpenAtRead, false);
    }
  });

  const recoveryEvidence = (params: Partial<BinanceConditionalAlgoIntent> = {}) => {
    const payload = buildBinanceConditionalAlgoPayload(intent(params)).payload!;
    const order = {
      algoId: '9007199254740993', clientAlgoId: payload.clientAlgoId,
      algoType: 'CONDITIONAL', symbol: payload.symbol,
      side: payload.side, orderType: payload.type,
      positionSide: 'BOTH', workingType: payload.workingType,
      triggerPrice: payload.triggerPrice, closePosition: true,
      reduceOnly: false, algoStatus: 'NEW',
      actualOrderId: '',
    };
    return { payload, order };
  };

  test('POST ACK lost: matching signed single-order + open-order reads forbid automatic resend', () => {
    const { payload, order } = recoveryEvidence();
    const v = inspectBinanceAlgoRecovery({
      expectedPayload: payload,
      orderLookup: { success: true, order },
      openLookup: { success: true, orders: [order] },
    });
    eq(v.code, 'OPEN_CONFIRMED_AT_READ');
    eq(v.algoId, '9007199254740993');
    eq(v.canResendAlgoOrder, false);
    eq(v.canCancelAlgoOrder, false);
    eq(v.mustInspectPositionAndFills, true);
    eq(v.executionAuthorized, false);
  });

  test('POST timeout + failed individual GET remains UNKNOWN even if openAlgoOrders is empty', () => {
    const { payload } = recoveryEvidence();
    for (const response of [
      null, { success: false, order: null }, { success: true, order: null },
    ]) {
      const v = inspectBinanceAlgoRecovery({
        expectedPayload: payload, orderLookup: response,
        openLookup: { success: true, orders: [] },
      });
      eq(v.code, 'ORDER_LOOKUP_UNKNOWN');
      eq(v.canResendAlgoOrder, false);
    }
  });

  test('Algo NEW but absent from open list / failed open GET is still blocked', () => {
    const { payload, order } = recoveryEvidence();
    for (const [openLookup, code] of [
      [{ success: true, orders: [] }, 'OPEN_LIST_CONFLICT_UNKNOWN'],
      [{ success: false, orders: [] }, 'OPEN_LOOKUP_UNKNOWN'],
      [{ success: true, orders: {} }, 'OPEN_LOOKUP_UNKNOWN'],
    ] as any[]) {
      const v = inspectBinanceAlgoRecovery({
        expectedPayload: payload,
        orderLookup: { success: true, order }, openLookup,
      });
      eq(v.code, code);
      eq(v.canResendAlgoOrder, false);
      eq(v.executionAuthorized, false);
    }
  });

  test('Triggered/FINISHED/CANCELED/EXPIRED orders require fills + position readback', () => {
    const { payload, order } = recoveryEvidence();
    for (const mutation of [
      { algoStatus: 'FINISHED', actualOrderId: '67890' },
      { algoStatus: 'CANCELED', actualOrderId: '' },
      { algoStatus: 'EXPIRED', actualOrderId: '' },
      { algoStatus: 'NEW', actualOrderId: '67890' },
    ]) {
      const v = inspectBinanceAlgoRecovery({
        expectedPayload: payload,
        orderLookup: { success: true, order: { ...order, ...mutation } },
        openLookup: { success: true, orders: [] },
      });
      eq(v.code, 'TRIGGERED_OR_TERMINAL_NEEDS_RECONCILIATION');
      eq(v.canResendAlgoOrder, false);
      eq(v.canCancelAlgoOrder, false);
      eq(v.mustInspectPositionAndFills, true);
    }
  });

  test('Wrong venue identity, trigger, positionSide and ownership IDs never reconcile', () => {
    const { payload, order } = recoveryEvidence();
    for (const mutation of [
      { clientAlgoId: 'foreign-client' },
      { symbol: 'ETHUSDT' },
      { algoId: 9007199254740992 },
      { side: 'BUY' }, { orderType: 'TAKE_PROFIT_MARKET' },
      { triggerPrice: '64000.2' }, { workingType: 'CONTRACT_PRICE' },
      { positionSide: 'LONG' }, { closePosition: false },
      { reduceOnly: true },
    ]) {
      const v = inspectBinanceAlgoRecovery({
        expectedPayload: payload,
        orderLookup: { success: true, order: { ...order, ...mutation } },
        openLookup: { success: true, orders: [order] },
      });
      eq(v.code, 'VENUE_IDENTITY_MISMATCH', JSON.stringify(mutation));
      eq(v.canResendAlgoOrder, false);
      eq(v.executionAuthorized, false);
    }
  });

  test('Quantity-only protective recovery enforces both quantity and reduceOnly', () => {
    const payload = buildBinanceConditionalAlgoPayload(intent({
      closeAll: false, quantity: .005, quantityStep: .001,
      reduceOnly: true,
    })).payload!;
    const o = {
      algoId: '999', clientAlgoId: payload.clientAlgoId,
      algoType: 'CONDITIONAL', orderType: payload.type,
      symbol: payload.symbol, side: payload.side, positionSide: 'BOTH',
      workingType: payload.workingType, triggerPrice: payload.triggerPrice,
      quantity: '.005', closePosition: false, reduceOnly: true,
      algoStatus: 'NEW', actualOrderId: '',
    };
    eq(inspectBinanceAlgoRecovery({
      expectedPayload: payload,
      orderLookup: { success: true, order: o },
      openLookup: { success: true, orders: [o] },
    }).code, 'OPEN_CONFIRMED_AT_READ');
    eq(inspectBinanceAlgoRecovery({
      expectedPayload: payload,
      orderLookup: { success: true, order: { ...o, quantity: '.006' } },
      openLookup: { success: true, orders: [o] },
    }).code, 'VENUE_IDENTITY_MISMATCH');
  });

  test('DELETE ACK is not cancellation proof; only CANCELED query + empty open list', () => {
    const { payload, order } = recoveryEvidence();
    const accepted = parseBinanceAlgoAcceptance(order, payload);
    const cancelled = inspectBinanceAlgoCancellationEvidence({
      expectedPayload: payload, accepted,
      deleteReceipt: { algoId: '9007199254740993',
        clientAlgoId: payload.clientAlgoId, code: '200', msg: 'success' },
      orderLookup: { success: true, order: { ...order, algoStatus: 'CANCELED' } },
      openLookup: { success: true, orders: [] },
    });
    eq(cancelled.code, 'CANCEL_OBSERVED_POSITION_UNKNOWN');
    eq(cancelled.canMarkPositionFlat, false);
    eq(cancelled.canStartNewPosition, false);
    eq(cancelled.canRepeatCancel, false);
    eq(cancelled.executionAuthorized, false);
  });

  test('Stale/mismatched DELETE receipt never proves cancellation', () => {
    const { payload, order } = recoveryEvidence();
    const accepted = parseBinanceAlgoAcceptance(order, payload);
    for (const receipt of [
      null, { code: 500, algoId: '9007199254740993',
        clientAlgoId: payload.clientAlgoId },
      { code: 200, algoId: '9007199254740994',
        clientAlgoId: payload.clientAlgoId },
      { code: 200, algoId: '9007199254740993', clientAlgoId: 'other-user' },
      { code: 200, algoId: 9007199254740992,
        clientAlgoId: payload.clientAlgoId },
    ]) {
      const r = inspectBinanceAlgoCancellationEvidence({
        expectedPayload: payload, accepted, deleteReceipt: receipt,
        orderLookup: { success: true, order: { ...order, algoStatus: 'CANCELED' } },
        openLookup: { success: true, orders: [] },
      });
      eq(r.code, 'RECEIPT_UNKNOWN');
      eq(r.canRepeatCancel, false);
    }
  });

  test('Cancelled individual lookup but Algo still open is conflict, not flat', () => {
    const { payload, order } = recoveryEvidence();
    const accepted = parseBinanceAlgoAcceptance(order, payload);
    const r = inspectBinanceAlgoCancellationEvidence({
      expectedPayload: payload, accepted,
      deleteReceipt: { code: 200, algoId: order.algoId,
        clientAlgoId: order.clientAlgoId },
      orderLookup: { success: true, order: { ...order, algoStatus: 'CANCELED' } },
      openLookup: { success: true, orders: [order] },
    });
    eq(r.code, 'STILL_OPEN');
    eq(r.canMarkPositionFlat, false);
  });

  test('Missing GET or terminal UNKNOWN after DELETE ACK cannot start another trade', () => {
    const { payload, order } = recoveryEvidence();
    const accepted = parseBinanceAlgoAcceptance(order, payload);
    for (const [query, open] of [
      [{ success: false, order: null }, { success: true, orders: [] }],
      [{ success: true, order: { ...order, algoStatus: 'CANCELED' } },
        { success: false, orders: [] }],
      [{ success: true, order: { ...order, algoStatus: 'EXPIRED' } },
        { success: true, orders: [] }],
      [{ success: true, order: { ...order, algoStatus: 'FINISHED' } },
        { success: true, orders: [] }],
    ] as any[]) {
      const r = inspectBinanceAlgoCancellationEvidence({
        expectedPayload: payload, accepted,
        deleteReceipt: { code: 200, algoId: order.algoId,
          clientAlgoId: order.clientAlgoId },
        orderLookup: query, openLookup: open,
      });
      eq(r.code, 'LOOKUP_UNKNOWN');
      eq(r.canStartNewPosition, false);
      eq(r.canRepeatCancel, false);
    }
  });

  test('READ ONLY signed GET uses exact algoOrder path and stable client key', async () => {
    const calls: Array<{ path: string; params: any }> = [];
    const r = await queryBinanceAlgoByClientId({
      environment: 'TESTNET', symbol: 'BTCUSDT',
      clientAlgoId: 'SMOKE_OLD_001',
    }, async (path, params) => {
      calls.push({ path, params });
      return {
        algoId: '9007199254740993', clientAlgoId: params.clientAlgoId,
        symbol: 'BTCUSDT', algoType: 'CONDITIONAL',
        algoStatus: 'NEW', orderType: 'STOP_MARKET',
        side: 'SELL', positionSide: 'BOTH',
      };
    });
    eq(r.code, 'FOUND_UNVERIFIED');
    eq(calls.length, 1);
    eq(calls[0].path, '/fapi/v1/algoOrder');
    eq(JSON.stringify(calls[0].params), '{"clientAlgoId":"SMOKE_OLD_001"}');
    eq(r.order.algoId, '9007199254740993');
    eq(r.canResend, false);
    eq(r.canCancel, false);
    eq(r.executionAuthorized, false);
  });

  test('LIVE, missing scope and malformed ID never invoke signed GET', async () => {
    let invoked = 0;
    const signed = async (): Promise<any> => { invoked++; throw new Error('called'); };
    for (const i of [
      { environment: 'LIVE', symbol: 'BTCUSDT', clientAlgoId: 'abc' },
      { environment: 'UNKNOWN', symbol: 'BTCUSDT', clientAlgoId: 'abc' },
      { environment: 'TESTNET', symbol: '', clientAlgoId: 'abc' },
      { environment: 'TESTNET', symbol: 'BTCUSDT', clientAlgoId: '' },
      { environment: 'TESTNET', symbol: 'BTCUSDT', clientAlgoId: 'bad id' },
      { environment: 'TESTNET', symbol: 'BTCUSDT', clientAlgoId: 'A'.repeat(37) },
    ] as any[]) {
      const r = await queryBinanceAlgoByClientId(i, signed);
      eq(r.code, 'INVALID_SCOPE');
      eq(r.order, null);
    }
    eq(invoked, 0);
  });

  test('Signed lookup 404, timeout and malformed 200 are UNKNOWN — never permission to retry', async () => {
    const input = { environment: 'TESTNET' as const, symbol: 'BTCUSDT',
      clientAlgoId: 'SMOKE_OLD_001' };
    for (const impl of [
      async () => { throw new Error('Binance 404 unknown order'); },
      async () => { throw new Error('network timeout'); },
      async () => null,
      async () => [],
      async () => 'OK',
    ]) {
      const r = await queryBinanceAlgoByClientId(input, impl as any);
      eq(r.canResend, false); eq(r.canCancel, false);
      eq(r.executionAuthorized, false);
      assert(r.code !== 'FOUND_UNVERIFIED');
    }
  });

  test('Foreign symbol/clientId or unsafe Algo number never match a known TESTNET seat', async () => {
    const input = { environment: 'TESTNET' as const, symbol: 'BTCUSDT',
      clientAlgoId: 'SMOKE_OLD_001' };
    const base = {
      algoId: '9007199254740993', clientAlgoId: input.clientAlgoId,
      symbol: input.symbol, algoType: 'CONDITIONAL',
      algoStatus: 'NEW', orderType: 'STOP_MARKET',
      side: 'SELL', positionSide: 'BOTH',
    };
    for (const override of [
      { algoId: 9007199254740992 },
      { algoId: null }, { clientAlgoId: 'OTHER' },
      { symbol: 'ETHUSDT' }, { algoType: 'WRONG' },
      { algoStatus: null }, { orderType: 'MARKET' },
      { side: 'wrong' }, { positionSide: '' },
    ]) {
      const r = await queryBinanceAlgoByClientId(input,
        async () => ({ ...base, ...override }));
      eq(r.code, 'VENUE_IDENTITY_MISMATCH', JSON.stringify(override));
      eq(r.order, null);
    }
  });

  test('Production read-only handler imports GET evidence but no POST/DELETE execution', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const route = fs.readFileSync(path.resolve(process.cwd(),
      'src/app/api/binance/futures/algo-read/route.ts'), 'utf8');
    const binance = fs.readFileSync(path.resolve(process.cwd(),
      'src/lib/exchanges/binanceFutures.ts'), 'utf8');
    assert(route.includes("resolveUserId(req.headers.get('authorization'), null, null)"));
    assert(route.includes('loadBinanceCreds('));
    assert(route.includes("creds.isTestnetRaw !== true"));
    assert(route.includes('getFuturesAlgoByClientIdReadOnly('));
    assert(!/\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.upsert\s*\(/.test(route));
    assert(binance.includes("fapiSigned('GET', path, key, secret, true, params)"));
    assert(!route.includes('placeFuturesTPSL('));
  });

  test('Cancel ID namespace ALGO != REGULAR orderId, even with same digits', () => {
    const regular = binanceAlgoCancellationIdentifier({
      kind: 'REGULAR', orderId: '12345678',
    });
    eq(regular.ok, false); eq(regular.algoId, null);
    const algo = binanceAlgoCancellationIdentifier({
      kind: 'ALGO', algoId: '12345678',
    });
    eq(algo.ok, true); eq(algo.algoId, '12345678');
    eq(algo.executionAuthorized, false);
    eq(binanceAlgoCancellationIdentifier({
      kind: 'ALGO', algoId: '1.234',
    }).ok, false);
  });

  test('Contract is not connected to production POST or DELETE until venue readback tests exist', () => {
    // Binance adapter still contains the known legacy stopPrice /order call;
    // never claim this research builder migrates it by itself.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(path.resolve(process.cwd(),
      'src/lib/exchanges/binanceFutures.ts'), 'utf8');
    assert(!source.includes('buildBinanceConditionalAlgoPayload('));
    assert(!source.includes('binanceAlgoCancellationIdentifier('));
  });
}

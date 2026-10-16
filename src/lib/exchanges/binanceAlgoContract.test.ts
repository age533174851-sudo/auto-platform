// Binance USD-M Algo conditional contract — zero-network synthetic tests.
// This suite MUST be registered once in scripts/run-tests.mjs.
import { test, eq, assert } from '../../test/harness';
import {
  buildBinanceConditionalAlgoPayload, parseBinanceAlgoAcceptance,
  verifyBinanceAlgoOpenReadback,
  binanceAlgoCancellationIdentifier, type BinanceConditionalAlgoIntent,
} from './binanceAlgoContract';

const intent = (extra: Partial<BinanceConditionalAlgoIntent> = {}):
  BinanceConditionalAlgoIntent => ({
    environment: 'TESTNET', symbol: 'BTCUSDT', positionMode: 'ONE_WAY',
    closes: 'LONG', side: 'SELL', type: 'STOP_MARKET',
    triggerPrice: 65000.2, tickSize: 0.1,
    workingType: 'MARK_PRICE', closeAll: true,
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

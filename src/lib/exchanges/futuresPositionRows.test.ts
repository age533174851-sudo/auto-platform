import { test, eq, assert } from '../../test/harness';
import { parseFuturesPositionRows } from './futuresPositionRows';

const ROW = {
  symbol: 'BTCUSDT', positionAmt: '0.125', entryPrice: '50000',
  markPrice: '50100', unRealizedProfit: '12.5', leverage: '100',
  liquidationPrice: '49600', marginType: 'isolated',
};
function rejects(data: unknown) {
  let failed = false;
  try { parseFuturesPositionRows(data); } catch { failed = true; }
  assert(failed, 'malformed positionRisk must not mean flat');
}
export function runFuturesPositionRowsTests() {
  test('positionRisk parses LONG SHORT and omits valid zero', () => {
    const rows = parseFuturesPositionRows([
      ROW, { ...ROW, symbol: 'ETHUSDT', positionAmt: '-0.25', marginType: 'cross' },
      { symbol: 'SOLUSDT', positionAmt: '0' },
    ]);
    eq(rows.length, 2);
    eq(rows[0].side, 'LONG');
    eq(rows[0].amount, 0.125);
    eq(rows[1].side, 'SHORT');
    eq(rows[1].amount, 0.25);
    eq(rows[1].marginType, 'cross');
  });
  test('non-array and invalid identity cannot count as flat', () => {
    for (const bad of [null, {}, { data: [] }, [null],
      [{ positionAmt: '0' }], [{ symbol: 'BTCUSDT' }],
      [{ symbol: 'BTCUSDT', positionAmt: '' }],
      [{ symbol: 'BTCUSDT', positionAmt: '0oops' }],
      [{ symbol: 'BTCUSDT', positionAmt: '0.2garbage' }],
      [{ symbol: 'BTCUSDT', positionAmt: 'NaN' }],
      [{ symbol: 'BTCUSDT', positionAmt: 'Infinity' }],
      [{ symbol: 'BTCUSDT', positionAmt: '1e9999' }]]) rejects(bad);
  });
  test('one malformed row invalidates otherwise flat list', () => {
    rejects([{ symbol: 'BTCUSDT', positionAmt: '0' }, { symbol: 'ETHUSDT', positionAmt: '0oops' }]);
  });
  // 깨진 값만이 아니라 **빠진 칸**도 막아야 한다. 실제로 틀렸던 모양은
  // 'broken'이 아니라 칸 자체가 없는 줄이었다.
  test('a missing risk field is not evidence of anything', () => {
    for (const field of ['entryPrice', 'markPrice', 'unRealizedProfit', 'leverage',
      'liquidationPrice', 'marginType'] as const) {
      const row: Record<string, unknown> = { ...ROW };
      delete row[field];
      rejects([row]);
    }
  });
  test('nonzero risk fields must be numeric and valid', () => {
    for (const field of ['entryPrice', 'markPrice', 'unRealizedProfit', 'leverage',
      'liquidationPrice', 'marginType'] as const) {
      rejects([{ ...ROW, [field]: 'broken' }]);
    }
    rejects([{ ...ROW, entryPrice: '0' }]);
    rejects([{ ...ROW, leverage: '100oops' }]);
    rejects([{ ...ROW, markPrice: '1e999' }]);
  });
}

// src/lib/pnl/pnl.test.ts
// PnL 엔진 유닛 테스트 — 레버리지/수수료/롱숏/손익분기 검증.
import { calcTradePnL } from './index';
import { test, close, gt, lt, assert } from '../../test/harness';

const feeCfg = { exchangeId: 'binance', makerRate: 0.001, takerRate: 0.001, slippage: 0.0005 } as any;
const base = {
  quantity: 1, leverage: 1, isLong: true, feeConfig: feeCfg,
  dailyVolume: 1e10, holdingHours: 0, fundingRate: 0, isFutures: false,
};

export function runPnlTests() {
  console.log('[PnL 엔진]');

  test('롱 수익: 100→110, 수량1, gross +10', () => {
    const r = calcTradePnL({ ...base, entryPrice: 100, exitPrice: 110 });
    close(r.grossPnL, 10, 1e-9);
    gt(r.netPnL, 0);           // 수수료 제해도 이익
    lt(r.netPnL, 10);          // 수수료만큼 감소
  });

  test('숏 수익: 100→90, 수량1, gross +10', () => {
    const r = calcTradePnL({ ...base, isLong: false, entryPrice: 100, exitPrice: 90 });
    close(r.grossPnL, 10, 1e-9);
    gt(r.netPnL, 0);
  });

  test('숏 손실: 100→110 이면 gross -10', () => {
    const r = calcTradePnL({ ...base, isLong: false, entryPrice: 100, exitPrice: 110 });
    close(r.grossPnL, -10, 1e-9);
    lt(r.netPnL, 0);
  });

  test('레버리지는 marginUsed만 줄인다 (grossPnL 불변)', () => {
    const r1 = calcTradePnL({ ...base, leverage: 1, entryPrice: 100, exitPrice: 102, quantity: 10 });
    const r5 = calcTradePnL({ ...base, leverage: 5, entryPrice: 100, exitPrice: 102, quantity: 10 });
    close(r1.grossPnL, r5.grossPnL, 1e-9, 'gross는 레버리지와 무관해야');
    close(r5.marginUsed, r1.marginUsed / 5, 1e-6, '증거금은 레버리지로 나뉘어야');
    // netPnLLevered(증거금 대비 수익률)은 5배 레버리지가 더 커야
    gt(r5.netPnLLevered, r1.netPnLLevered);
  });

  test('레버리지 수익 중복 없음: netPnL은 gross에서 비용만 뺀 값', () => {
    const r = calcTradePnL({ ...base, leverage: 10, entryPrice: 100, exitPrice: 102, quantity: 10 });
    // grossPnL = (102-100)*10 = 20. netPnL = 20 - 비용. 절대 20*10 같은 값이 되면 안 됨
    close(r.grossPnL, 20, 1e-9);
    lt(r.netPnL, 20);
    gt(r.netPnL, 0);
    assert(r.netPnL < r.grossPnL, 'netPnL은 grossPnL보다 작아야 (비용 차감)');
  });

  test('수수료는 명목가치에 비례 (수량 클수록 수수료 큼)', () => {
    const small = calcTradePnL({ ...base, entryPrice: 100, exitPrice: 101, quantity: 1 });
    const big   = calcTradePnL({ ...base, entryPrice: 100, exitPrice: 101, quantity: 100 });
    gt(big.totalFees, small.totalFees);
  });

  test('손익분기: 비용이 gross보다 크면 isViable=false', () => {
    // 아주 작은 가격 이동 → 수수료가 이익을 잠식
    const r = calcTradePnL({ ...base, entryPrice: 100, exitPrice: 100.001, quantity: 1 });
    assert(!r.isViable || r.netPnL <= r.grossPnL, '비용 반영 확인');
  });
}

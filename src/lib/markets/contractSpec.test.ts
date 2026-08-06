// src/lib/markets/contractSpec.test.ts
//
// 막으려는 것:
//  1. 배수를 모르는데 1로 채워, 금 1계약(100온스)을 1온스로 계산하는 것
//     — 실제 위험이 100배가 된다
//  2. 최소 1계약이 이미 예산을 넘는데 "조금 넘지만 넣자"로 통과하는 것
//     — 코인에는 없는 문제라 코인 코드를 그대로 쓰면 반드시 밟는다
//  3. 정수로 내린 뒤의 **실제** 위험 대신 요청한 위험을 성적표에 적는 것
//  4. 존재하지 않는 소수 계약(0.005계약)을 만들어 거래소에 보내는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  sizeByRisk, tickValueOf, riskPerUnit, continuousSpec, type ContractSpec,
} from './contractSpec';

/** 금 선물 — 1계약 100온스 */
const GOLD: ContractSpec = {
  symbol: 'GC', style: 'CONTRACT', multiplier: 100,
  tickSize: 0.1, tickValue: 10, minQty: 1, qtyStep: 1,
  currency: 'USD', timezone: 'America/New_York', expiry: '2026-12-26',
};

/** WTI 원유 — 1계약 1000배럴 */
const OIL: ContractSpec = {
  symbol: 'CL', style: 'CONTRACT', multiplier: 1000,
  tickSize: 0.01, tickValue: 10, minQty: 1, qtyStep: 1,
  currency: 'USD', timezone: 'America/New_York', expiry: '2026-11-20',
};

const BTC = continuousSpec('BTCUSDT', { tickSize: 0.1, qtyStep: 0.001, minQty: 0.001 });

export function runContractSpecTests() {
  console.log('[계약 명세 — 배수를 지어내지 않는다]');

  test('배수를 모르면 수량을 만들지 않는다', () => {
    // Gate에서 quanto_multiplier를 못 읽고 계약 수를 그대로 보내 주문이
    // 계속 실패했던 자리와 같다. 그때는 실패해서 다행이었다.
    const noMul: ContractSpec = { ...GOLD, multiplier: null };
    const r = sizeByRisk({ spec: noMul, riskBudget: 1000, stopDistance: 20, entryPrice: 2000 });
    eq(r.status, 'SPEC_UNKNOWN');
    eq(r.qty, null, '0이 아니라 null이어야 한다');
    assert(r.reason.includes('배수'), r.reason);
  });

  test('명세가 아예 없으면 계산하지 않는다', () => {
    eq(sizeByRisk({ spec: null, riskBudget: 1000, stopDistance: 20, entryPrice: 2000 }).status,
       'SPEC_UNKNOWN');
  });

  test('1틱 가치는 고시값이 우선, 없으면 배수로 계산', () => {
    eq(tickValueOf(GOLD), 10, '고시값');
    eq(tickValueOf({ ...GOLD, tickValue: null }), 10, '0.1 × 100');
    eq(tickValueOf({ ...GOLD, tickValue: null, multiplier: null }), null, '모르면 null');
  });

  test('1계약 위험은 손절거리 × 배수다', () => {
    // 금 손절 $20 → 1계약 위험 $2,000. 코인 감각으로 $20이라고 생각하면
    // 100배 틀린다.
    eq(riskPerUnit(GOLD, 20), 2000);
    eq(riskPerUnit(OIL, 0.5), 500);
    eq(riskPerUnit({ ...GOLD, multiplier: null }, 20), null);
  });

  console.log('[계약 명세 — 최소 단위가 예산을 넘을 때]');

  test('작은 계좌는 금 1계약도 못 산다 — 그렇다고 말한다', () => {
    // 계좌 $1,000, 1회 위험 1% = $10. 금 1계약 위험은 $2,000이다.
    // 코인이었다면 0.005계약을 사면 됐다. 금에는 그런 게 없다.
    const r = sizeByRisk({ spec: GOLD, riskBudget: 10, stopDistance: 20, entryPrice: 2000 });
    eq(r.status, 'MIN_SIZE_EXCEEDS_RISK');
    eq(r.qty, null);
    assert(r.reason.includes('배'), r.reason);
    assert(r.reason.includes('손절을 좁히거나'), '무엇을 바꿔야 하는지 적어야 한다');
  });

  test('허용을 명시해야만 예산을 넘는 최소 단위가 나간다', () => {
    const r = sizeByRisk({
      spec: GOLD, riskBudget: 10, stopDistance: 20, entryPrice: 2000,
      allowMinOverBudget: true,
    });
    eq(r.status, 'OK');
    eq(r.qty, 1);
    eq(r.actualRisk, 2000, '실제 위험은 예산이 아니라 2000이다');
    assert(r.reason.includes('넘습니다'), r.reason);
  });

  test('기본값은 거절이다 — 한도를 코드가 임의로 넘기지 않는다', () => {
    const r = sizeByRisk({ spec: OIL, riskBudget: 50, stopDistance: 1, entryPrice: 70 });
    eq(r.status, 'MIN_SIZE_EXCEEDS_RISK', '원유 1계약 위험 $1,000 > 예산 $50');
  });

  console.log('[계약 명세 — 정수로 내린 뒤의 실제 위험]');

  test('계약은 정수로 내린다', () => {
    // 예산 $5,000 / 1계약 위험 $2,000 = 2.5계약 → 2계약
    const r = sizeByRisk({ spec: GOLD, riskBudget: 5000, stopDistance: 20, entryPrice: 2000 });
    eq(r.status, 'OK');
    eq(r.qty, 2, '2.5계약은 존재하지 않는다');
  });

  test('내린 뒤의 실제 위험을 돌려준다 — 요청한 값이 아니다', () => {
    const r = sizeByRisk({ spec: GOLD, riskBudget: 5000, stopDistance: 20, entryPrice: 2000 });
    eq(r.actualRisk, 4000, '2계약 × $2,000');
    eq(r.requestedRisk, 5000);
    assert(r.reason.includes('실제 위험'),
      '20% 차이는 적어야 한다 — 모르면 "1% 위험인데 왜 수익이 이것뿐이냐"가 된다');
  });

  test('차이가 작으면 굳이 적지 않는다', () => {
    // 예산 $4,100 → 2계약($4,000). 2.4% 차이라 잔소리하지 않는다.
    const r = sizeByRisk({ spec: GOLD, riskBudget: 4100, stopDistance: 20, entryPrice: 2000 });
    eq(r.qty, 2);
    eq(r.reason, '', '작은 차이까지 경고하면 곧 아무도 안 읽는다');
  });

  test('명목가는 배수를 곱한 값이다', () => {
    const r = sizeByRisk({ spec: GOLD, riskBudget: 5000, stopDistance: 20, entryPrice: 2000 });
    eq(r.notional, 400_000, '2계약 × 100온스 × $2,000');
  });

  console.log('[계약 명세 — 코인은 예전처럼]');

  test('연속 수량은 쪼갤 수 있다', () => {
    // 예산 $100 / 손절 $500 = 0.2 BTC → step 0.001로 내림
    const r = sizeByRisk({ spec: BTC, riskBudget: 100, stopDistance: 500, entryPrice: 60000 });
    eq(r.status, 'OK');
    close(r.qty as number, 0.2, 1e-9);
    close(r.actualRisk as number, 100, 1e-6);
  });

  test('코인도 최소 수량 아래로는 못 간다', () => {
    // 예산 $0.1 / 손절 $500 = 0.0002 BTC < 최소 0.001
    const r = sizeByRisk({ spec: BTC, riskBudget: 0.1, stopDistance: 500, entryPrice: 60000 });
    eq(r.status, 'MIN_SIZE_EXCEEDS_RISK');
  });

  test('코인 명세는 배수가 1이라 예전 계산과 같다', () => {
    const r = sizeByRisk({ spec: BTC, riskBudget: 200, stopDistance: 1000, entryPrice: 60000 });
    close(r.qty as number, 0.2, 1e-9, '위험금액 ÷ 손절거리');
    close(r.notional as number, 12000, 1e-6, '0.2 × 60000');
  });

  console.log('[계약 명세 — 입력이 잘못됐을 때]');

  test('손절 없이는 크기를 정하지 않는다', () => {
    const r = sizeByRisk({ spec: GOLD, riskBudget: 5000, stopDistance: 0, entryPrice: 2000 });
    eq(r.status, 'BAD_INPUT');
    assert(r.reason.includes('손절'), r.reason);
  });

  test('예산이 없으면 계산하지 않는다', () => {
    eq(sizeByRisk({ spec: GOLD, riskBudget: 0, stopDistance: 20, entryPrice: 2000 }).status, 'BAD_INPUT');
    eq(sizeByRisk({ spec: GOLD, riskBudget: -5, stopDistance: 20, entryPrice: 2000 }).status, 'BAD_INPUT');
  });

  test('진입가가 없으면 명목가를 만들 수 없다', () => {
    eq(sizeByRisk({ spec: GOLD, riskBudget: 5000, stopDistance: 20, entryPrice: 0 }).status, 'BAD_INPUT');
  });

  test('못 낸 경우 수량은 언제나 null이다 — 0이 아니다', () => {
    for (const r of [
      sizeByRisk({ spec: null, riskBudget: 5000, stopDistance: 20, entryPrice: 2000 }),
      sizeByRisk({ spec: GOLD, riskBudget: 10, stopDistance: 20, entryPrice: 2000 }),
      sizeByRisk({ spec: GOLD, riskBudget: 0, stopDistance: 20, entryPrice: 2000 }),
    ]) {
      eq(r.qty, null, r.status);
      eq(r.actualRisk, null, r.status);
    }
  });

  console.log('[계약 명세 — Gate 선물이 증명 사례다]');

  test('Gate BTC_USDT를 계약 명세로 넣으면 예전 수량이 그대로 나온다', () => {
    // Gate 선물은 **이미 계약형 상품**이다 — 정수 계약, 1계약 0.0001 BTC.
    // 금 1계약이 100온스인 것과 구조가 같고 숫자만 다르다.
    //
    // 그러니 금을 붙일 때 새 계산을 만들 이유가 없다. 이 테스트가
    // 그것을 고정한다: 같은 함수에 Gate 명세를 넣으면 gateSizeFromBase가
    // 내던 값과 같아야 한다.
    const gate: ContractSpec = {
      symbol: 'BTC_USDT', style: 'CONTRACT', multiplier: 0.0001,
      tickSize: 0.1, tickValue: null, minQty: 1, qtyStep: 1,
      currency: 'USDT', timezone: '', expiry: null,
    };
    // 예산 $100, 손절 거리 $500
    //   1계약 위험 = 500 × 0.0001 = $0.05
    //   2000계약 = 0.2 BTC
    const r = sizeByRisk({ spec: gate, riskBudget: 100, stopDistance: 500, entryPrice: 60000 });
    eq(r.status, 'OK');
    eq(r.qty, 2000, '계약 수');
    close((r.qty as number) * (gate.multiplier as number), 0.2, 1e-9, '기초자산 수량');
    close(r.actualRisk as number, 100, 1e-6);
  });

  test('Gate 배수를 못 읽으면 Gate에서도 수량을 안 만든다', () => {
    // 실제로 났던 일이다 — quanto_multiplier를 아무도 안 읽어서 계약 수를
    // 그대로 보냈고 주문이 계속 400으로 실패했다. 그때는 실패해서 다행이었다.
    const broken: ContractSpec = {
      symbol: 'BTC_USDT', style: 'CONTRACT', multiplier: null,
      tickSize: 0.1, tickValue: null, minQty: 1, qtyStep: 1,
      currency: 'USDT', timezone: '', expiry: null,
    };
    eq(sizeByRisk({ spec: broken, riskBudget: 100, stopDistance: 500, entryPrice: 60000 }).status,
       'SPEC_UNKNOWN');
  });

  test('같은 예산에서 금과 Gate가 다른 수량을 낸다 — 배수가 다르니까', () => {
    // 이게 안 되면 배수가 어디선가 무시되고 있는 것이다.
    const budget = 5000, dist = 20, px = 2000;
    const gold = sizeByRisk({ spec: GOLD, riskBudget: budget, stopDistance: dist, entryPrice: px });
    const gate = sizeByRisk({
      spec: { ...GOLD, multiplier: 0.0001 },
      riskBudget: budget, stopDistance: dist, entryPrice: px,
    });
    eq(gold.qty, 2);
    assert((gate.qty as number) > 1_000_000, `배수가 무시됐다 (${gate.qty})`);
  });
}

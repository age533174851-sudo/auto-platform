// src/lib/engine/executionCost.test.ts
//
// **비용을 빼기 전의 여유는 여유가 아니다.**
//
// 이 파일은 비용 판정과 "비용 → 증거금 → 실효배율" 변환만 시험한다.
// 청산가 식 자체는 `liquidationDistance.test.ts`가 본다 — 두 곳에서 같은
// 것을 시험하면 한쪽만 고쳐지고 그때 두 답이 갈린다.
//
// ★ 진입 전 보호다. 종료 권한이 아니다.
import { test, eq, assert, close } from '../../test/harness';
import {
  assessExecutionCost, effectiveMarginAfterCost, vwapForEntry,
  type ExecutionCostInput,
} from './executionCost';

const COM = {
  takerRate: 0.0004, makerRate: 0.0002,
  source: 'EXCHANGE_ACCOUNT' as const, observedAtMs: 1,
};
const BOOK = {
  bids: [[49_995, 50]] as Array<[number, number]>,
  asks: [[50_005, 50]] as Array<[number, number]>,
  source: 'EXCHANGE_DEPTH' as const, observedAtMs: 1,
};
const NOW = 1_000_000_000_000;
const FUND = {
  rate: 0.0001, nextFundingTimeMs: NOW + 3_600_000, intervalHours: 8,
  intervalSource: 'EXCHANGE_FUNDING_INFO' as const, observedAtMs: 1,
};

const ok = (over: Partial<ExecutionCostInput> = {}): ExecutionCostInput => ({
  side: 'LONG', referencePrice: 50_000, quantity: 0.2, leverage: 100,
  fillKind: 'TAKER', commission: COM, book: BOOK, funding: FUND,
  nowMs: NOW, holdHorizonMs: 14_400_000,   // 계약이 선언한 4시간
  ...over,
});

export function runExecutionCostTests() {
  console.log('\n💸 실행·보유 비용 → 실질 청산 여유 (pre-entry)');

  // ── 체결가: 먹는 쪽 호가 ──

  test('LONG 진입은 매도호가를 먹는다 — 중간가·마크가가 아니다', () => {
    const v = assessExecutionCost(ok({ side: 'LONG' }));
    eq(v.ok, true, `★ 정상 입력이 막혔다 — ${v.reason}`);
    eq(v.expectedFillPrice, 50_005, '★ 유리한 쪽 호가로 계산했다');
  });

  test('SHORT 진입은 매수호가를 먹는다', () => {
    const v = assessExecutionCost(ok({ side: 'SHORT' }));
    eq(v.ok, true, `★ 정상 입력이 막혔다 — ${v.reason}`);
    eq(v.expectedFillPrice, 49_995, '★ 유리한 쪽 호가로 계산했다');
  });

  test('여러 호가를 걸치면 가중평균이다', () => {
    const book = { ...BOOK, asks: [[50_000, 0.1], [50_100, 0.1]] as Array<[number, number]> };
    const v = assessExecutionCost(ok({ book, quantity: 0.2 }));
    eq(v.ok, true);
    close(v.expectedFillPrice as number, 50_050, 1e-6, 'VWAP');
  });

  test('깊이가 모자라면 마지막 호가로 채우지 않고 막는다', () => {
    const v = assessExecutionCost(ok({ quantity: 1_000 }));
    eq(v.ok, false, '★ 호가에 안 들어가는 크기가 통과했다');
    eq(v.code, 'DEPTH_INSUFFICIENT');
  });

  test('vwapForEntry는 깊이가 모자라면 null이다', () => {
    eq(vwapForEntry('LONG', 1_000, BOOK), null);
    eq(vwapForEntry('LONG', 0.2, { ...BOOK, asks: [] }), null);
    eq(vwapForEntry('LONG', 0, BOOK), null);
  });

  // ── 슬리피지 ──

  test('불리한 체결만 비용이다 — 유리한 쪽은 0으로 깎는다', () => {
    // 매도호가가 기준가보다 **싸다**(유리). 그 예상을 안전 여유로 더하면
    // 그 예상이 틀린 날 청산된다.
    // 호가가 **교차하지 않게** 둘 다 기준가 아래로 내린다. 교차한 책은
    // 따로 거부되므로(BOOK_CROSSED) 그걸로는 이 규칙을 시험할 수 없다.
    const book = {
      ...BOOK,
      bids: [[49_400, 50]] as Array<[number, number]>,
      asks: [[49_500, 50]] as Array<[number, number]>,
    };
    const v = assessExecutionCost(ok({ book }));
    eq(v.ok, true, `★ 교차하지 않은 호가가 막혔다 — ${v.reason}`);
    eq(v.ok, true);
    eq(v.entrySlippageUsd, 0, '★ 유리한 슬리피지를 이익으로 적었다');
  });

  test('나갈 때의 슬리피지도 예약한다 — 진입에서 관측한 크기만큼', () => {
    const v = assessExecutionCost(ok());
    eq(v.exitSlippageReserveUsd, v.entrySlippageUsd,
      '★ 나갈 때 충격을 0으로 뒀다 — 들어간 만큼은 나올 때도 든다');
  });

  // ── 수수료 ──

  test('시장가(taker) 주문에는 taker 수수료율을 쓴다', () => {
    const v = assessExecutionCost(ok({ fillKind: 'TAKER' }));
    eq(v.commissionRate, COM.takerRate, '★ maker 수수료를 썼다 — 비용이 작아진다');
    close(v.entryFeeUsd as number, 50_005 * 0.2 * 0.0004, 1e-9, '진입 수수료');
  });

  test('나갈 때의 수수료도 예약한다', () => {
    const v = assessExecutionCost(ok());
    assert((v.exitFeeReserveUsd as number) > 0, '★ 나갈 때 수수료를 0으로 뒀다');
  });

  test('주문 유형을 모르면 maker/taker를 고르지 않고 막는다', () => {
    const v = assessExecutionCost(ok({ fillKind: null }));
    eq(v.ok, false);
    eq(v.code, 'FILL_KIND_UNKNOWN');
  });

  test('계정 수수료가 아니면 받지 않는다 — 기본값 표로 100배를 정하지 않는다', () => {
    const v = assessExecutionCost(ok({
      commission: { ...COM, source: 'DEFAULT_TABLE' as any },
    }));
    eq(v.ok, false);
    eq(v.code, 'COMMISSION_MISSING');
  });

  // ── 펀딩 ──

  test('주기를 8시간으로 박지 않는다 — 주기가 짧으면 횟수가 늘어난다', () => {
    const h8 = assessExecutionCost(ok());
    const h1 = assessExecutionCost(ok({ funding: { ...FUND, intervalHours: 1 } }));
    eq(h8.ok, true); eq(h1.ok, true);
    assert((h1.fundingEvents as number) > (h8.fundingEvents as number),
      `★ 주기를 읽지 않는다 (1h ${h1.fundingEvents} · 8h ${h8.fundingEvents})`);
  });

  test('주기를 못 읽으면 막는다', () => {
    const v = assessExecutionCost(ok({ funding: { ...FUND, intervalHours: null as any } }));
    eq(v.ok, false);
    eq(v.code, 'FUNDING_INTERVAL_UNUSABLE');
  });

  test('수취 예상치를 안전 여유로 쓰지 않는다 — 부호를 뒤집어도 예약은 같다', () => {
    const pay = assessExecutionCost(ok({ funding: { ...FUND, rate: 0.0001 } }));
    const recv = assessExecutionCost(ok({ funding: { ...FUND, rate: -0.0001 } }));
    eq(recv.fundingReserveUsd, pay.fundingReserveUsd,
      '★ 받을 것 같다는 예상으로 위험한 진입을 통과시킨다');
    // 방향은 관측에 남는다 — 예약과는 별개다.
    eq(pay.fundingSideNow, 'PAY');
    eq(recv.fundingSideNow, 'RECEIVE');
  });

  test('이미 지나간 펀딩은 세지 않는다', () => {
    // 응답이 낡아 다음 펀딩 시각이 과거일 수 있다. 그대로 세면 지나간
    // 펀딩까지 센다 — 실제로 그 일이 났고 비용이 명목가의 10%로 나왔다.
    const stale = { ...FUND, nextFundingTimeMs: NOW - 100 * 3_600_000 };
    const v = assessExecutionCost(ok({ funding: stale }));
    eq(v.ok, true, `★ 낡은 펀딩 시각이 막혔다 — ${v.reason}`);
    assert((v.fundingEvents as number) <= 1,
      `★ 4시간 구간·8시간 주기인데 펀딩 ${v.fundingEvents}회를 셌다`);
  });

  test('보유 구간이 없으면 막는다 — 펀딩 횟수를 셀 수 없다', () => {
    eq(assessExecutionCost(ok({ holdHorizonMs: null })).code, 'HOLD_HORIZON_UNUSABLE');
  });

  // ── 입력을 믿을 수 없으면 거부 ──

  for (const [why, over, code] of [
    ['방향 없음', { side: null }, 'SIDE_UNKNOWN'],
    ['기준가 0', { referencePrice: 0 }, 'REFERENCE_PRICE_UNUSABLE'],
    ['수량 NaN', { quantity: NaN }, 'QUANTITY_UNUSABLE'],
    ['배율 1', { leverage: 1 }, 'LEVERAGE_UNUSABLE'],
    ['호가 없음', { book: null }, 'BOOK_MISSING'],
    ['먹을 쪽 호가가 빔', { book: { ...BOOK, asks: [] } }, 'BOOK_SIDE_EMPTY'],
    ['펀딩 없음', { funding: null }, 'FUNDING_MISSING'],
  ] as const) {
    test(`${why} → 거부한다`, () => {
      const v = assessExecutionCost(ok(over as any));
      eq(v.ok, false, `★ ${why}인데 통과했다`);
      eq(v.code, code);
    });
  }

  test('호가가 교차하면 쓰지 않는다 — 음수 슬리피지가 이익처럼 읽힌다', () => {
    const v = assessExecutionCost(ok({
      book: { bids: [[50_010, 50]], asks: [[50_005, 50]],
              source: 'EXCHANGE_DEPTH', observedAtMs: 1 },
    }));
    eq(v.ok, false);
    eq(v.code, 'BOOK_CROSSED');
  });

  // ── 구성 요소가 따로 보인다 ──

  test('총 비용은 다섯 조각의 합이고, 조각이 각각 보인다', () => {
    const v = assessExecutionCost(ok());
    const parts = [v.entryFeeUsd, v.exitFeeReserveUsd, v.entrySlippageUsd,
                   v.exitSlippageReserveUsd, v.fundingReserveUsd] as number[];
    for (const p of parts) assert(Number.isFinite(p), '★ 조각 하나가 숫자가 아니다');
    close(v.totalCostUsd as number, parts.reduce((a, b) => a + b, 0), 1e-9, '합');
    // 한 숫자로 뭉개면 무엇이 여유를 먹었는지 말할 수 없다.
    assert((v.totalCostNotionalPct as number) > 0, '명목가 대비 %가 없다');
  });

  test('관측 시각과 출처를 보존한다 — ④가 검사할 근거다', () => {
    const v = assessExecutionCost(ok());
    eq(v.bookObservedAtMs, 1);
    eq(v.fundingObservedAtMs, 1);
    eq(v.commissionObservedAtMs, 1);
    eq(v.fundingIntervalSource, 'EXCHANGE_FUNDING_INFO');
  });

  // ── 비용 → 증거금 → 실효배율 ──

  test('비용은 증거금을 줄이고, 줄어든 증거금은 배율을 올린다', () => {
    const c = assessExecutionCost(ok());
    const e = effectiveMarginAfterCost(c, 100);
    eq(e.code, 'OK', e.reason);
    // 증거금 = 명목가 / 배율
    close(e.marginAtEntryUsd as number, (c.notionalAtFill as number) / 100, 1e-9, '증거금');
    assert((e.marginAfterCostUsd as number) < (e.marginAtEntryUsd as number),
      '★ 비용을 뺐는데 증거금이 그대로다');
    assert((e.effectiveLeverage as number) > 100,
      '★ 증거금이 줄었는데 배율이 그대로다 — 비용이 반영되지 않았다');
    // **진입가는 예상 체결가다.** 마크가로 두면 두 세계가 생긴다.
    eq(e.effectiveEntryPrice, c.expectedFillPrice,
      '★ 슬리피지를 비용 표 한 줄로만 적고 청산가는 옛 기준가로 뒀다');
  });

  test('실효배율은 줄어든 증거금을 그대로 대입한 것과 같다 — 근사가 아니다', () => {
    const c = assessExecutionCost(ok());
    const e = effectiveMarginAfterCost(c, 100);
    // 1/실효배율 === 남은증거금/명목가
    close(1 / (e.effectiveLeverage as number),
      (e.marginAfterCostUsd as number) / (c.notionalAtFill as number),
      1e-12, '1/L_eff = margin/notional');
  });

  test('비용이 증거금을 먹으면 막는다 — 들어가는 순간 증거금이 없다', () => {
    const c = assessExecutionCost(ok());
    const e = effectiveMarginAfterCost({ ...c, totalCostUsd: 1e9 }, 100);
    eq(e.code, 'COST_EXCEEDS_MARGIN');
  });

  test('비용을 확정하지 못했으면 실질 여유를 계산하지 않는다', () => {
    eq(effectiveMarginAfterCost({ ok: false, code: 'BOOK_MISSING' } as any, 100).code,
      'COST_NOT_ASSESSED');
    eq(effectiveMarginAfterCost(null, 100).code, 'COST_NOT_ASSESSED');
  });

  test('배율이 없으면 실효 증거금을 계산하지 않는다', () => {
    const c = assessExecutionCost(ok());
    eq(effectiveMarginAfterCost(c, null).code, 'MARGIN_UNUSABLE');
    eq(effectiveMarginAfterCost(c, 1).code, 'MARGIN_UNUSABLE');
  });
}

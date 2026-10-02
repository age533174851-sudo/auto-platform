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
  // **지금 요율이 아니라 거래소가 적어 둔 상한**이 예약의 근거다.
  capRate: 0.0005, floorRate: -0.0005,
  source: 'EXCHANGE_FUNDING_INFO' as const,
  // **서로 다른 값**이어야 한다. 같은 값으로 두면 두 칸을 하나로
  // 합치는 변경이 시험을 그대로 통과한다.
  premiumObservedAtMs: 1, premiumExchangeTimeMs: 1, premiumCache: 'FRESH' as const,
  fundingBoundsObservedAtMs: 2,
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

  test('나갈 때의 슬리피지는 **청산 쪽 명목가**에 걸어 예약한다', () => {
    const v = assessExecutionCost(ok());
    assert((v.exitSlippageReserveUsd as number) > 0,
      '★ 나갈 때 충격을 0으로 뒀다 — 들어간 만큼은 나올 때도 든다');
    // 진입에서 **관측한 비율**을 청산 쪽 명목가에 적용한다.
    const pct = (v.entrySlippageUsd as number) / (50_000 * 0.2);
    close(v.exitSlippageReserveUsd as number, pct * (v.worstCloseNotional as number),
      1e-9, '청산 쪽 명목가 기준 예약');
  });

  // ── SHORT의 청산 쪽 명목가 (재감사 지적) ──
  //
  // SHORT은 불리한 방향이 **가격 상승**이라 청산으로 갈수록 명목가가
  // 커진다. 진입 명목가를 청산·펀딩 비용의 기준으로 쓰면 과소 예약이다.

  test('SHORT의 청산 쪽 명목가는 진입 명목가보다 크다', () => {
    const v = assessExecutionCost(ok({ side: 'SHORT' }));
    eq(v.ok, true, v.reason);
    assert((v.worstCloseNotional as number) > (v.notionalAtFill as number),
      '★ SHORT인데 청산 쪽 명목가가 진입 명목가와 같다 — 과소 예약이다');
  });

  test('LONG의 청산 쪽 명목가는 진입 명목가다 — 작아지는 쪽은 진입가가 보수적', () => {
    const v = assessExecutionCost(ok({ side: 'LONG' }));
    eq(v.worstCloseNotional, v.notionalAtFill,
      '★ LONG에서 명목가를 깎았다 — 보수적인 쪽을 버렸다');
  });

  test('SHORT의 청산 수수료·펀딩 예약이 LONG보다 크다', () => {
    const l = assessExecutionCost(ok({ side: 'LONG' }));
    const sh = assessExecutionCost(ok({ side: 'SHORT' }));
    eq(l.ok, true); eq(sh.ok, true);
    assert((sh.exitFeeReserveUsd as number) > (l.exitFeeReserveUsd as number),
      '★ SHORT 청산 수수료가 LONG과 같거나 작다 — 커지는 명목가를 안 봤다');
    assert((sh.fundingReserveUsd as number) > (l.fundingReserveUsd as number),
      '★ SHORT 펀딩 예약이 LONG과 같거나 작다');
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

  test('예약은 **지금 요율이 아니라 상한**으로 한다', () => {
    // 지금 0.01%인데 정산 직전 커질 수 있다. 상한이 근거다.
    const v = assessExecutionCost(ok());
    eq(v.fundingWorstRate, 0.0005, '★ LONG 예약에 cap을 쓰지 않았다');
    close(v.fundingReserveUsd as number,
      (v.fundingEvents as number) * 0.0005 * (v.worstCloseNotional as number),
      1e-9, '펀딩 예약');
    // 지금 요율만 10배로 키워도 예약은 그대로다 — 상한이 안 바뀌었으므로.
    const hot = assessExecutionCost(ok({ funding: { ...FUND, rate: 0.001 } }));
    eq(hot.fundingReserveUsd, v.fundingReserveUsd,
      '★ 예약이 지금 요율을 따라간다 — 미래 정산의 상한이 아니다');
  });

  test('SHORT은 하한(floor)의 절댓값이 1회 최대 지불이다', () => {
    const v = assessExecutionCost(ok({
      side: 'SHORT', funding: { ...FUND, capRate: 0.0002, floorRate: -0.0009 },
    }));
    eq(v.ok, true, v.reason);
    eq(v.fundingWorstRate, 0.0009, '★ SHORT에 cap을 썼다 — 지불 방향이 반대다');
  });

  test('상한·하한을 못 읽으면 막는다 — 지금 요율로 때우지 않는다', () => {
    eq(assessExecutionCost(ok({ funding: { ...FUND, capRate: null as any } })).code,
      'FUNDING_BOUNDS_UNUSABLE');
    eq(assessExecutionCost(ok({ funding: { ...FUND, floorRate: null as any } })).code,
      'FUNDING_BOUNDS_UNUSABLE');
  });

  test('대상 종목에서 직접 읽은 값이 아니면 막는다', () => {
    // 예전에는 "목록에서 가장 짧은 주기"를 빌려 쓰고 authoritative인 척했다.
    const v = assessExecutionCost(ok({
      funding: { ...FUND, source: 'SHORTEST_LISTED' as any },
    }));
    eq(v.ok, false, '★ 다른 종목의 값을 빌려 쓰고 통과했다');
    eq(v.code, 'FUNDING_BOUNDS_UNUSABLE');
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

  test('총 비용에 **진입 슬리피지는 없다** — 청산가 계산에 이미 들어갔다', () => {
    const v = assessExecutionCost(ok());
    const counted = [v.entryFeeUsd, v.exitFeeReserveUsd,
                     v.exitSlippageReserveUsd, v.fundingReserveUsd] as number[];
    for (const p of counted) assert(Number.isFinite(p), '★ 조각 하나가 숫자가 아니다');
    close(v.totalCostUsd as number, counted.reduce((a, b) => a + b, 0), 1e-9, '합');
    // 진입 슬리피지는 관측용으로 **남아 있지만** 합에는 안 들어간다.
    assert((v.entrySlippageUsd as number) > 0, '★ 진입 슬리피지를 관측에서도 지웠다');
    const withEntry = counted.reduce((a, b) => a + b, 0) + (v.entrySlippageUsd as number);
    assert(Math.abs((v.totalCostUsd as number) - withEntry) > 1e-12,
      '★ 진입 슬리피지가 합에 들어갔다 — 청산가 진입가로 이미 반영된 것을 두 번 센다');
    assert((v.totalCostNotionalPct as number) > 0, '명목가 대비 %가 없다');
  });

  test('관측 시각과 출처를 보존한다 — ④가 검사할 근거다', () => {
    const v = assessExecutionCost(ok());
    eq(v.bookObservedAtMs, 1);
    eq(v.premiumObservedAtMs, 1);
    eq(v.fundingBoundsObservedAtMs, 2,
      '★ premium과 펀딩 상한의 시각이 한 칸으로 합쳐졌다');
    eq(v.commissionObservedAtMs, 1);
    eq(v.fundingSource, 'EXCHANGE_FUNDING_INFO');
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

  // ── LONG/SHORT 숫자 예제 (재감사 요구) ──
  //
  // 기준가 50,000 · 수량 0.2 · 100배 · taker 0.04% · 호가 ±5
  // 펀딩 상한 ±0.05% · 보유 4시간에 정산 1회
  //
  //   LONG   체결 50,005 · 진입명목가 10,001.00 · 청산쪽명목가 10,001.00
  //          수수료 4.0004+4.0004 · 청산슬리피지 1.0001 · 펀딩 5.0005
  //          총 14.0014 (0.1400%)  ← 진입슬리피지 1.0000은 **합에 없다**
  //   SHORT  체결 49,995 · 진입명목가  9,999.00 · 청산쪽명목가 10,098.99
  //          수수료 3.9996+4.0396 · 청산슬리피지 1.0099 · 펀딩 5.0495
  //          총 14.0986 (0.1410%)

  test('LONG 숫자 예제', () => {
    const v = assessExecutionCost(ok({ side: 'LONG' }));
    eq(v.ok, true, v.reason);
    eq(v.expectedFillPrice, 50_005);
    close(v.notionalAtFill as number, 10_001, 1e-9, '진입 명목가');
    close(v.worstCloseNotional as number, 10_001, 1e-9, 'LONG은 진입 명목가가 보수적');
    close(v.entryFeeUsd as number, 4.0004, 1e-4, '진입 수수료');
    close(v.fundingReserveUsd as number, 5.0005, 1e-4, '펀딩 예약');
    close(v.totalCostUsd as number, 14.0014, 1e-4, '총 비용');
    close(v.entrySlippageUsd as number, 1.0, 1e-9, '진입 슬리피지(관측)');
  });

  test('SHORT 숫자 예제 — 청산 쪽 명목가가 커진다', () => {
    const v = assessExecutionCost(ok({ side: 'SHORT' }));
    eq(v.ok, true, v.reason);
    eq(v.expectedFillPrice, 49_995);
    close(v.notionalAtFill as number, 9_999, 1e-9, '진입 명목가');
    close(v.worstCloseNotional as number, 10_098.99, 1e-2, '청산 쪽 명목가');
    close(v.exitFeeReserveUsd as number, 4.0396, 1e-3, '청산 수수료 예약');
    close(v.fundingReserveUsd as number, 5.0495, 1e-3, '펀딩 예약');
    close(v.totalCostUsd as number, 14.0986, 1e-3, '총 비용');
    // 지금 요율이 +0.01%라 SHORT은 **받는 쪽**인데, 예약은 그대로다.
    eq(v.fundingSideNow, 'RECEIVE');
    eq(v.fundingWorstRate, 0.0005);
  });

  test('진입 슬리피지는 청산가 계산 쪽에서 한 번만 반영된다', () => {
    const c = assessExecutionCost(ok({ side: 'LONG' }));
    const e = effectiveMarginAfterCost(c, 100);
    // 식에 넣을 진입가는 체결가다.
    eq(e.effectiveEntryPrice, 50_005);
    // 그런데 **비용에는 없다** — 두 번 세지 않는다.
    const sum = (c.entryFeeUsd as number) + (c.exitFeeReserveUsd as number)
      + (c.exitSlippageReserveUsd as number) + (c.fundingReserveUsd as number);
    close(c.totalCostUsd as number, sum, 1e-9, '합에 진입 슬리피지가 없다');
  });
}

// src/lib/strategies/originalV1.test.ts
//
// **원본 전략 v1 — 자금관리와 시간창.**
//
// 이 두 가지가 틀리면 조용히 틀린다. 크기가 10분의 1로 나가도 주문은
// 나가고, 시간창을 놓쳐도 오류는 안 난다. 그래서 값으로 못 박는다.

import { test, eq, assert } from '../../test/harness';
import {
  orderMarginFor, cycleStatusOf, applyRealized, nextCycleSeed,
  CYCLE_TARGET_USD, CYCLE_FLOOR_USD, LADDER_BANDS,
} from './ladderCycle';
import {
  windowVerdict, tradingDayKst, kstMinuteOfDay, originalV1Signal, barsInWindow,
  signalRuleConfigured, exitRuleConfigured,
  WINDOW_START_KST, WINDOW_END_KST, LATE_GRACE_MIN,
} from './originalV1';

/** 한국시간 그 날 그 시각의 ms. KST는 UTC+9 고정(서머타임 없음) */
const kst = (y: number, mo: number, d: number, hh: number, mm: number) =>
  Date.UTC(y, mo - 1, d, hh - 9, mm);

export function runOriginalV1Tests() {
  console.log('[원본 v1 — 자릿수 구간이 주문 크기를 정한다]');

  test('세 구간의 금액이 규칙 그대로다', () => {
    eq(orderMarginFor(100).marginUsd, 10);
    eq(orderMarginFor(1_000).marginUsd, 100);
    eq(orderMarginFor(10_000).marginUsd, 1_000);
  });

  test('구간 안에서는 잔고가 얼마든 같은 금액이다 — 연속 복리가 아니다', () => {
    // 이게 이 전략의 핵심이다. $1,120에서 $112가 나오면 다른 전략이다.
    for (const e of [100, 250, 500, 999, 999.99]) {
      eq(orderMarginFor(e).marginUsd, 10, `$${e}`);
    }
    for (const e of [1_000, 1_120, 3_000, 5_000, 9_999]) {
      eq(orderMarginFor(e).marginUsd, 100, `$${e}`);
    }
    for (const e of [10_000, 13_500, 50_000, 99_999]) {
      eq(orderMarginFor(e).marginUsd, 1_000, `$${e}`);
    }
  });

  test('사용자가 확인한 두 예시', () => {
    // "$500 시작이면 주문 $10, $5,000 시작이면 주문 $100"
    eq(orderMarginFor(500).marginUsd, 10);
    eq(orderMarginFor(5_000).marginUsd, 100);
  });

  test('문턱을 넘는 순간에만 10배로 뛴다', () => {
    eq(orderMarginFor(999.99).marginUsd, 10);
    eq(orderMarginFor(1_000).marginUsd, 100);
    eq(orderMarginFor(9_999.99).marginUsd, 100);
    eq(orderMarginFor(10_000).marginUsd, 1_000);
  });

  test('정확한 경계에서 한 칸 아래로 떨어지지 않는다', () => {
    // 계산식(10 ** (floor(log10(e)) - 1))으로 쓰면 부동소수점 때문에
    // 여기서 조용히 10분의 1이 나올 수 있다. 표로 두는 이유다.
    eq(orderMarginFor(1000).bandFloor, 1_000);
    eq(orderMarginFor(10000).bandFloor, 10_000);
  });

  test('$100,000에 닿으면 더 진입하지 않는다', () => {
    const v = orderMarginFor(CYCLE_TARGET_USD);
    eq(v.ok, false); eq(v.code, 'TARGET_REACHED'); eq(v.marginUsd, null);
  });

  test('$100 미만은 규칙이 없다 — 지어내지 않는다', () => {
    const v = orderMarginFor(99.99);
    eq(v.ok, false); eq(v.code, 'BELOW_FLOOR'); eq(v.marginUsd, null);
    assert(v.reason.includes('정해진 것이 없어'), v.reason);
    assert(CYCLE_FLOOR_USD === 100);
  });

  test('읽지 못한 잔고를 0으로 보지 않는다', () => {
    // Number(null) === 0 → BELOW_FLOOR가 되어 '$100 미만'이라고 적힌다.
    // 그건 사실이 아니라 '못 읽었다'다.
    for (const v of [null, undefined, '', true, 'abc']) {
      const r = orderMarginFor(v as any);
      eq(r.code, 'UNKNOWN', String(v));
      eq(r.marginUsd, null);
    }
  });

  test('구간표가 내림차순이다 — 위에서부터 훑으므로 순서가 곧 규칙이다', () => {
    for (let i = 1; i < LADDER_BANDS.length; i++) {
      assert(LADDER_BANDS[i - 1].floor > LADDER_BANDS[i].floor, '구간표 순서가 뒤집혔다');
    }
  });

  console.log('[원본 v1 — 회차]');

  test('시드 $1,000에서 시작하면 주문은 $100이다', () => {
    const s = cycleStatusOf({ seedUsd: 1_000, equityUsd: 1_000 });
    eq(s.state, 'RUNNING');
    eq(s.size.marginUsd, 100);
    eq(s.pnlUsd, 0);
  });

  test('목표에 닿으면 회차 완료다', () => {
    const s = cycleStatusOf({ seedUsd: 1_000, equityUsd: 100_000 });
    eq(s.state, 'COMPLETE');
    eq(s.pnlUsd, 99_000);
  });

  test('다음 회차는 처음 시드로 되돌아간다 — 거래소 잔고를 건드리지 않는다', () => {
    eq(nextCycleSeed(1_000), 1_000);
  });

  test('확정 손익만 원장에 더한다 · 센트에서 끊는다', () => {
    eq(applyRealized(1_000, 120.005), 1_120.01);
    eq(applyRealized(1_000, -50), 950);
    // 부동소수점 누적으로 999.9999가 되면 구간이 한 칸 떨어진다.
    eq(orderMarginFor(applyRealized(1_000.01, -0.01)).marginUsd, 100);
  });

  test('손익을 못 읽으면 원장을 바꾸지 않는다', () => {
    eq(applyRealized(1_000, null), null);
    eq(applyRealized(null, 100), null);
  });

  console.log('[원본 v1 — 하루 한 번, 아침 창]');

  test('창 안이면 판단한다', () => {
    const v = windowVerdict({ nowMs: kst(2026, 8, 10, 9, 15), lastEvaluatedDay: null });
    eq(v.evaluate, true); eq(v.code, 'IN_WINDOW');
    eq(v.tradingDay, '2026-08-10');
  });

  test('창의 양 끝은 포함이다', () => {
    eq(windowVerdict({ nowMs: kst(2026, 8, 10, 9, 10), lastEvaluatedDay: null }).code, 'IN_WINDOW');
    eq(windowVerdict({ nowMs: kst(2026, 8, 10, 9, 30), lastEvaluatedDay: null }).code, 'IN_WINDOW');
    eq(WINDOW_START_KST.hh, 9); eq(WINDOW_START_KST.mm, 10);
    eq(WINDOW_END_KST.hh, 9); eq(WINDOW_END_KST.mm, 30);
  });

  test('창 전에는 판단하지 않는다', () => {
    const v = windowVerdict({ nowMs: kst(2026, 8, 10, 9, 9), lastEvaluatedDay: null });
    eq(v.evaluate, false); eq(v.code, 'BEFORE');
  });

  test('실행기가 늦게 와도 그 거래일을 잃지 않는다', () => {
    // 이게 이 파일에서 가장 중요한 규칙이다. GitHub Actions는 15분 주기라
    // 09:31에 처음 올 수 있고, '지금이 창이면'으로 만들면 그날이 사라진다.
    const v = windowVerdict({ nowMs: kst(2026, 8, 10, 9, 45), lastEvaluatedDay: null });
    eq(v.evaluate, true); eq(v.code, 'LATE');
    eq(v.lateMin, 15);
  });

  test('유예를 넘기면 놓친 것으로 기록한다 — 조용히 넘기지 않는다', () => {
    const v = windowVerdict({ nowMs: kst(2026, 8, 10, 14, 0), lastEvaluatedDay: null });
    eq(v.evaluate, false); eq(v.code, 'MISSED');
    assert(v.reason.includes('놓쳤습니다'), v.reason);
    assert(LATE_GRACE_MIN > 15, '유예가 실행기 주기보다 짧으면 정상 지연도 매번 놓친다');
  });

  test('같은 거래일에 두 번 판단하지 않는다', () => {
    const v = windowVerdict({ nowMs: kst(2026, 8, 10, 9, 20), lastEvaluatedDay: '2026-08-10' });
    eq(v.evaluate, false); eq(v.code, 'ALREADY_DONE');
  });

  test('하루 1회 검사가 시각보다 먼저다 — 늦게 깨어나도 두 번은 없다', () => {
    const v = windowVerdict({ nowMs: kst(2026, 8, 10, 9, 50), lastEvaluatedDay: '2026-08-10' });
    eq(v.code, 'ALREADY_DONE');
  });

  test('다음 날이면 다시 판단한다', () => {
    const v = windowVerdict({ nowMs: kst(2026, 8, 11, 9, 15), lastEvaluatedDay: '2026-08-10' });
    eq(v.evaluate, true); eq(v.code, 'IN_WINDOW');
    eq(v.tradingDay, '2026-08-11');
  });

  test('거래일은 한국 날짜다 — UTC 날짜가 아니다', () => {
    // 한국 09:15는 UTC 00:15다. UTC로 자르면 같은 날이지만,
    // 한국 08:00(UTC 전날 23:00)에서는 하루가 어긋난다.
    eq(tradingDayKst(kst(2026, 8, 10, 9, 15)), '2026-08-10');
    eq(tradingDayKst(kst(2026, 8, 10, 0, 30)), '2026-08-10');
    eq(tradingDayKst(Date.UTC(2026, 7, 9, 23, 0)), '2026-08-10');
  });

  test('빈 문자열을 오늘로 읽지 않는다', () => {
    // ''를 '판단했다'로 읽으면 첫날이 통째로 막히고,
    // 오늘로 읽으면 하루 1회가 무너진다.
    const v = windowVerdict({ nowMs: kst(2026, 8, 10, 9, 15), lastEvaluatedDay: '' });
    eq(v.evaluate, true, v.reason);
  });

  test('시각을 못 읽으면 판단하지 않는다', () => {
    eq(windowVerdict({ nowMs: NaN, lastEvaluatedDay: null }).code, 'UNKNOWN');
    eq(kstMinuteOfDay(NaN), null);
  });

  console.log('[원본 v1 — 09:10~09:30 합성 봉이 방향을 정한다]');

  /** 09:10부터 5분 간격 봉 */
  const bar = (i: number, o: number, h: number, l: number, c: number) => ({
    openTimeMs: kst(2026, 8, 10, 9, 10 + i * 5), open: o, high: h, low: l, close: c,
  });
  const DAY = '2026-08-10';

  test('종가가 시가보다 높으면 LONG', () => {
    const v = originalV1Signal({
      bars: [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 102, 100, 101),
             bar(2, 101, 103, 101, 102), bar(3, 102, 104, 102, 103)],
      tradingDay: DAY,
    });
    eq(v.side, 'LONG'); eq(v.code, 'LONG');
    eq(v.evidence.windowOpen, 100);
    eq(v.evidence.windowClose, 103);
  });

  test('종가가 시가보다 낮으면 SHORT', () => {
    const v = originalV1Signal({
      bars: [bar(0, 100, 100, 98, 99), bar(1, 99, 99, 97, 97.5)],
      tradingDay: DAY,
    });
    eq(v.side, 'SHORT'); eq(v.code, 'SHORT');
  });

  test('약한 봉이라고 진입을 취소하지 않는다 — 원본은 방향이 나오면 들어간다', () => {
    // 몸통 0.001%. 세기 필터를 넣으면 여기서 NO_TRADE가 나온다.
    const v = originalV1Signal({
      bars: [bar(0, 100_000, 100_500, 99_500, 100_001)], tradingDay: DAY,
    });
    eq(v.side, 'LONG', v.reason);
    eq(v.evidence.strengthUsedForEntry, false, '세기를 진입 판단에 썼다고 기록되면 안 된다');
  });

  test('시가와 종가가 같을 때만 방향이 없다', () => {
    const v = originalV1Signal({ bars: [bar(0, 100, 105, 95, 100)], tradingDay: DAY });
    eq(v.side, null); eq(v.code, 'NO_TRADE');
  });

  test('구간 안의 5분봉을 각각 투표시키지 않는다 — 전체 구간 하나로 본다', () => {
    // 봉별로는 음봉 3 : 양봉 1이지만, 09:10 시가 100 → 09:30 종가 110이다.
    const v = originalV1Signal({
      bars: [bar(0, 100, 130, 100, 128), bar(1, 128, 128, 120, 121),
             bar(2, 121, 121, 114, 115), bar(3, 115, 115, 109, 110)],
      tradingDay: DAY,
    });
    eq(v.side, 'LONG', v.reason);
  });

  test('봉의 세기를 근거로 남긴다 — 나중에 파생 전략과 비교한다', () => {
    const v = originalV1Signal({ bars: [bar(0, 100, 110, 90, 105)], tradingDay: DAY });
    eq(v.evidence.strength.bodyPct, 5);
    eq(v.evidence.strength.rangePct, 20);
    eq(v.evidence.strength.bodyToRangeRatio, 0.25);
  });

  test('고저폭이 0이면 비율을 지어내지 않는다', () => {
    const v = originalV1Signal({ bars: [bar(0, 100, 100, 100, 100)], tradingDay: DAY });
    eq(v.evidence.strength.bodyToRangeRatio, null);
  });

  console.log('[원본 v1 — 창 밖의 봉을 섞지 않는다]');

  test('창을 덮는 봉만 고른다', () => {
    const bars = [
      { openTimeMs: kst(2026, 8, 10, 9, 5), open: 1, high: 1, low: 1, close: 1 },   // 창 전
      bar(0, 100, 101, 99, 100.5),
      bar(3, 102, 104, 102, 103),
      { openTimeMs: kst(2026, 8, 10, 9, 30), open: 9, high: 9, low: 9, close: 9 },  // 창 밖(시작이 09:30)
      { openTimeMs: kst(2026, 8, 9, 9, 15), open: 7, high: 7, low: 7, close: 7 },   // 어제
    ];
    const win = barsInWindow(bars as any, DAY);
    eq(win.length, 2);
    eq(win[0].open, 100);
    eq(win[1].close, 103);
  });

  test('구간을 덮는 봉이 없으면 방향을 만들지 않는다', () => {
    const v = originalV1Signal({
      bars: [{ openTimeMs: kst(2026, 8, 10, 14, 0), open: 1, high: 1, low: 1, close: 1 }] as any,
      tradingDay: DAY,
    });
    eq(v.side, null); eq(v.code, 'WINDOW_BARS_MISSING');
  });

  test('봉이 아예 없으면 조회 실패로 적는다 — 관망이 아니다', () => {
    const v = originalV1Signal({ bars: [], tradingDay: DAY });
    eq(v.code, 'BARS_UNAVAILABLE');
  });

  test('0이나 NaN을 가격으로 쓰지 않는다', () => {
    const v = originalV1Signal({
      bars: [{ openTimeMs: kst(2026, 8, 10, 9, 15), open: 0, high: 1, low: 1, close: 1 }] as any,
      tradingDay: DAY,
    });
    eq(v.code, 'BARS_UNAVAILABLE');
  });

  console.log('[원본 v1 — 손절·익절 규칙은 아직 비어 있다]');

  test('진입 규칙은 들어왔고 청산 규칙은 아직이다', () => {
    eq(signalRuleConfigured(), true);
    // **이 값이 true가 되기 전에는 주문이 나가면 안 된다.**
    // 손절 없이 100배로 들어가는 것이 이 저장소가 가장 피하는 일이다.
    eq(exitRuleConfigured(), false);
  });
}

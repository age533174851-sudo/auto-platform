// src/lib/engine/adaptiveLeverage.test.ts
//
// **이 파일이 지키는 것은 "배율이 올라가지 않는다"이다.**
//
// 적응형 배율에서 가장 비싼 고장은 틀린 숫자가 아니라 **방향**이다.
// 어떤 축이 나빠졌는데 배율이 그대로이거나 올라가면, 위험이 커진
// 순간에 노출도 같이 커진다. 그래서 값 하나하나보다 다음 셋을 본다:
//
//   ① 못 읽거나 오래된 입력 → **차단**(낮은 배율로 대신하지 않는다)
//   ② 어떤 축이든 나빠지면 배율은 **같거나 낮아진다**
//   ③ 어떤 입력으로도 100이 나오지 않는다
import { test, eq, assert } from '../../test/harness';
import {
  planAdaptiveLeverage, adaptiveLeverageAllows, rungAtOrBelow,
  ADAPTIVE_LADDER, ADAPTIVE_MIN_LEVERAGE, ADAPTIVE_MAX_LEVERAGE,
  ADAPTIVE_DEFAULT_TOP_RUNG, FORBIDDEN_LEVERAGE,
  type AdaptiveLeverageInput,
} from './adaptiveLeverage';

const NOW = 1_800_000_000_000;

/** 모든 축이 넉넉한 기준 입력. 각 시험은 **한 축만** 바꾼다 */
function base(over: Partial<AdaptiveLeverageInput> = {}): AdaptiveLeverageInput {
  return {
    nowMs: NOW,
    atrPct: 1.0,
    volatilityAsOfMs: NOW - 60_000,
    depthUsd: 2_000_000,
    bookAsOfMs: NOW - 1_000,
    spreadBps: 1,
    roundTripFeeBps: 8,
    allocatedMarginUsd: 100,
    maintenanceMarginRate: 0.004,
    exchangeMaxLeverage: 125,
    exchangeMaxAsOfMs: NOW - 60_000,
    ...over,
  };
}

export function runAdaptiveLeverageTests() {
  console.log('[적응형 레버리지 10~75배 — 올라가지 않는다]');

  // ══════════ ① 범위와 100배 배제 ══════════

  test('★★ 사다리는 10에서 시작해 75에서 끝난다 — 100은 없다', () => {
    eq(ADAPTIVE_LADDER[0], ADAPTIVE_MIN_LEVERAGE);
    eq(ADAPTIVE_LADDER[ADAPTIVE_LADDER.length - 1], ADAPTIVE_MAX_LEVERAGE);
    assert(!ADAPTIVE_LADDER.includes(FORBIDDEN_LEVERAGE),
      '사다리에 100이 들어 있다 — 전용 100배 계약과 섞인다');
    for (const rung of ADAPTIVE_LADDER) {
      assert(rung >= ADAPTIVE_MIN_LEVERAGE && rung <= ADAPTIVE_MAX_LEVERAGE,
        `사다리 칸 ${rung}이 범위 밖이다`);
    }
  });

  test('★★ 100배 요청은 이 정책이 거부한다', () => {
    eq(adaptiveLeverageAllows(100), false, '100을 허용했다');
    eq(adaptiveLeverageAllows(101), false);
    eq(adaptiveLeverageAllows(125), false);
    eq(adaptiveLeverageAllows(76), false, '75를 넘는 값을 허용했다');
    eq(adaptiveLeverageAllows(9), false, '최소 배율 아래를 허용했다');
    eq(adaptiveLeverageAllows(0), false);
    eq(adaptiveLeverageAllows(-10), false);
    eq(adaptiveLeverageAllows(null), false);
    eq(adaptiveLeverageAllows('100'), false);
    eq(adaptiveLeverageAllows(25), false, '사다리에 없는 값을 허용했다');
    for (const rung of ADAPTIVE_LADDER) {
      eq(adaptiveLeverageAllows(rung), true, `사다리 칸 ${rung}을 거부했다`);
    }
  });

  test('★★ 모든 축이 아무리 좋아도 75를 넘지 않는다 (거래소가 125를 허용해도)', () => {
    const r = planAdaptiveLeverage(base({
      atrPct: 0.01, depthUsd: 1e12, spreadBps: 0, roundTripFeeBps: 0,
      maintenanceMarginRate: 0, exchangeMaxLeverage: 125, highRiskApproved: true,
    }));
    eq(r.ok, true, r.message);
    eq(r.leverage, ADAPTIVE_MAX_LEVERAGE, '상한을 넘겼다');
    assert(r.leverage! < FORBIDDEN_LEVERAGE, '100 이상이 나왔다');
  });

  // ══════════ ② 못 읽은 것은 차단이다 — 낮은 배율이 아니다 ══════════

  const unreadable: Array<[string, Partial<AdaptiveLeverageInput>, string]> = [
    ['변동성 없음', { atrPct: null }, 'VOLATILITY_UNKNOWN'],
    ['변동성 시각 없음', { volatilityAsOfMs: null }, 'VOLATILITY_UNKNOWN'],
    ['변동성 이틀 전', { volatilityAsOfMs: NOW - 48 * 3600_000 }, 'VOLATILITY_STALE'],
    ['호가 깊이 없음', { depthUsd: null }, 'LIQUIDITY_UNKNOWN'],
    ['호가 시각 없음', { bookAsOfMs: null }, 'LIQUIDITY_UNKNOWN'],
    ['호가 1분 전', { bookAsOfMs: NOW - 60_000 }, 'LIQUIDITY_STALE'],
    ['스프레드 없음', { spreadBps: null }, 'SPREAD_UNKNOWN'],
    ['수수료 없음', { roundTripFeeBps: null }, 'COST_UNKNOWN'],
    ['유지증거금률 없음', { maintenanceMarginRate: null }, 'MAINTENANCE_UNKNOWN'],
    ['배정 증거금 없음', { allocatedMarginUsd: null }, 'MARGIN_UNKNOWN'],
    ['거래소 상한 없음', { exchangeMaxLeverage: null }, 'EXCHANGE_CAP_UNKNOWN'],
    ['거래소 상한 시각 없음', { exchangeMaxAsOfMs: null }, 'EXCHANGE_CAP_UNKNOWN'],
    ['거래소 상한 이틀 전', { exchangeMaxAsOfMs: NOW - 48 * 3600_000 }, 'EXCHANGE_CAP_STALE'],
  ];
  for (const [label, over, code] of unreadable) {
    test(`★★ ${label} → 진입 차단 (${code})`, () => {
      const r = planAdaptiveLeverage(base(over));
      eq(r.ok, false, `${label}인데 통과했다`);
      eq(r.code, code);
      eq(r.leverage, null, '막혔는데 배율이 적혔다 — null이어야 한다');
    });
  }

  test('★★ 0은 값이고 빈 칸은 값이 아니다 (Number(null) === 0 덫)', () => {
    // 수수료 0 · 스프레드 0 · 유지증거금률 0은 **실제로 있을 수 있는 값**이다.
    // 그래서 `Number.isFinite(Number(x))`로 거르면 못 읽은 칸이 전부 0으로
    // 통과한다. 이 판정의 첫 판이 정확히 그렇게 새어, 이 시험이 잡았다.
    const zeros = planAdaptiveLeverage(base({
      spreadBps: 0, roundTripFeeBps: 0, maintenanceMarginRate: 0,
    }));
    eq(zeros.ok, true, `0이 들어오면 통과해야 한다: ${zeros.message}`);

    for (const key of ['spreadBps', 'roundTripFeeBps', 'maintenanceMarginRate',
      'volatilityAsOfMs', 'bookAsOfMs', 'exchangeMaxAsOfMs'] as const) {
      for (const empty of [null, undefined, '']) {
        const r = planAdaptiveLeverage(base({ [key]: empty } as any));
        eq(r.ok, false, `${key}=${JSON.stringify(empty)}인데 통과했다 — 빈 칸을 0으로 읽었다`);
        assert(/UNKNOWN$/.test(r.code),
          `${key}가 비었는데 코드가 ${r.code}다 — "못 읽음"이 아니라 다른 뜻으로 적혔다`);
      }
    }
  });

  test('★★ 막혔을 때 최소 배율로 떨어지지 않는다', () => {
    for (const [, over] of unreadable) {
      const r = planAdaptiveLeverage(base(over));
      assert(r.leverage !== ADAPTIVE_MIN_LEVERAGE,
        '위험을 모르는데 10배로 주문하려 한다 — 10배도 주문이다');
    }
  });

  // ══════════ ③ 각 축이 실제로 상한을 잡는가 ══════════

  test('변동성이 커지면 칸이 내려간다', () => {
    const quiet = planAdaptiveLeverage(base({ atrPct: 0.5 }));
    const normal = planAdaptiveLeverage(base({ atrPct: 1.5 }));
    const wild = planAdaptiveLeverage(base({ atrPct: 4.0 }));
    eq(quiet.ok, true, quiet.message);
    eq(normal.ok, true, normal.message);
    eq(wild.ok, true, wild.message);
    assert(quiet.leverage! >= normal.leverage!, `${quiet.leverage} < ${normal.leverage}`);
    assert(normal.leverage! >= wild.leverage!, `${normal.leverage} < ${wild.leverage}`);
    assert(wild.leverage! <= 20, `ATR 4%인데 ${wild.leverage}배다`);
  });

  test('★ 변동성이 아주 크면 10배도 허용하지 않고 막는다', () => {
    const r = planAdaptiveLeverage(base({ atrPct: 9 }));
    eq(r.ok, false, `ATR 9%인데 ${r.leverage}배로 통과했다`);
    eq(r.code, 'BELOW_MIN_LEVERAGE');
    eq(r.leverage, null);
  });

  test('얇은 호가가 상한을 잡는다', () => {
    const thin = planAdaptiveLeverage(base({ depthUsd: 20_000 }));
    eq(thin.ok, true, thin.message);
    eq(thin.binding, 'liquidity', `유동성이 아니라 ${thin.binding}가 잡았다`);
    eq(thin.leverage, 20, `깊이 2만 달러에 증거금 100달러인데 ${thin.leverage}배다`);
  });

  test('★ 스프레드가 한도를 넘으면 배율을 낮추는 것이 아니라 막는다', () => {
    const r = planAdaptiveLeverage(base({ spreadBps: 25 }));
    eq(r.ok, false, '넓은 스프레드에서 통과했다');
    eq(r.code, 'SPREAD_TOO_WIDE');
  });

  test('거래 비용이 상한을 잡는다', () => {
    const cheap = planAdaptiveLeverage(base({ roundTripFeeBps: 2 }));
    const dear = planAdaptiveLeverage(base({ roundTripFeeBps: 9 }));
    eq(cheap.ok, true, cheap.message);
    eq(dear.ok, true, dear.message);
    assert(cheap.leverage! >= dear.leverage!,
      `비용이 비싼데 배율이 더 높다 (${dear.leverage} > ${cheap.leverage})`);
    eq(dear.binding, 'cost', `비용이 아니라 ${dear.binding}가 잡았다`);
  });

  test('거래소 상한을 넘지 않는다', () => {
    const r = planAdaptiveLeverage(base({ exchangeMaxLeverage: 25, highRiskApproved: true }));
    eq(r.ok, true, r.message);
    assert(r.leverage! <= 25, `거래소가 25배까지인데 ${r.leverage}배를 골랐다`);
    eq(r.leverage, 20);
  });

  test('★ 거래소 상한이 최소 배율보다 낮으면 막는다', () => {
    const r = planAdaptiveLeverage(base({ exchangeMaxLeverage: 5 }));
    eq(r.ok, false, '거래소 상한 5배인데 통과했다');
    eq(r.code, 'BELOW_MIN_LEVERAGE');
  });

  test('유지증거금률이 높으면 청산 여유가 상한을 잡는다', () => {
    const lo = planAdaptiveLeverage(base({ atrPct: 0.6, maintenanceMarginRate: 0.004 }));
    const hi = planAdaptiveLeverage(base({ atrPct: 0.6, maintenanceMarginRate: 0.05 }));
    eq(lo.ok, true, lo.message);
    eq(hi.ok, true, hi.message);
    assert(hi.leverage! <= lo.leverage!,
      `유지증거금률이 높은데 배율이 더 높다 (${hi.leverage} > ${lo.leverage})`);
    eq(hi.binding, 'liquidation');
  });

  // ══════════ ④ 75는 백테스트 전까지 후보다 ══════════

  test('★★ 백테스트 승인 전에는 75를 자동으로 고르지 않는다', () => {
    const quiet = base({ atrPct: 0.2, roundTripFeeBps: 1, spreadBps: 0 });
    const guarded = planAdaptiveLeverage(quiet);
    eq(guarded.ok, true, guarded.message);
    eq(guarded.leverage, ADAPTIVE_DEFAULT_TOP_RUNG, '승인 없이 50을 넘었다');
    eq(guarded.binding, 'policy');

    const approved = planAdaptiveLeverage({ ...quiet, highRiskApproved: true });
    eq(approved.leverage, ADAPTIVE_MAX_LEVERAGE, '승인했는데 75가 안 나온다');
  });

  test('★ 승인 플래그는 위험 축을 덮지 않는다', () => {
    // 승인해도 변동성이 크면 그대로 낮은 칸이다. 승인은 **윗칸을 여는
    // 것**이지 아래 축을 무시하는 것이 아니다.
    const r = planAdaptiveLeverage(base({ atrPct: 4.0, highRiskApproved: true }));
    eq(r.ok, true, r.message);
    assert(r.leverage! <= 20, `승인이 변동성 상한을 덮었다 (${r.leverage}배)`);
  });

  // ══════════ ⑤ 방향 — 어떤 축도 혼자 올리지 못한다 ══════════

  test('★★ 한 축을 나쁘게 하면 배율은 같거나 낮아진다 (전수)', () => {
    const good = planAdaptiveLeverage(base({ highRiskApproved: true }));
    eq(good.ok, true, good.message);
    const worse: Array<[string, Partial<AdaptiveLeverageInput>]> = [
      ['변동성 상승', { atrPct: 2.5 }],
      ['깊이 감소', { depthUsd: 100_000 }],
      ['스프레드 확대', { spreadBps: 6 }],
      ['수수료 상승', { roundTripFeeBps: 20 }],
      ['유지증거금률 상승', { maintenanceMarginRate: 0.02 }],
      ['거래소 상한 하락', { exchangeMaxLeverage: 30 }],
      ['증거금 증가(같은 깊이에서 더 큰 주문)', { allocatedMarginUsd: 5_000 }],
      ['고위험 승인 철회', { highRiskApproved: false }],
    ];
    for (const [label, over] of worse) {
      const r = planAdaptiveLeverage(base({ highRiskApproved: true, ...over }));
      const got = r.ok ? r.leverage! : 0;
      assert(got <= good.leverage!,
        `${label}인데 배율이 올라갔다 (${good.leverage} → ${got})`);
    }
  });

  test('★★ 기대 수익을 담는 입력 칸이 없다', () => {
    // 칸이 생기는 순간 다음 수정에서 그것이 배율을 **올리는** 가지가 된다.
    // 높은 배율은 같은 움직임에서 손익을 키울 뿐 우위를 만들지 않는다.
    const forbidden = ['edge', 'expectancy', 'winRate', 'signalStrength',
      'confidence', 'score', 'conviction', 'expectedReturn'];
    const keys = Object.keys(base());
    for (const f of forbidden) {
      assert(!keys.includes(f), `입력에 ${f}가 있다 — 수익 기대가 배율을 올리는 길이 열린다`);
    }
  });

  // ══════════ ⑥ 사다리 고르기 ══════════

  test('상한 이하의 가장 높은 칸을 고른다', () => {
    eq(rungAtOrBelow(9.9), null, '10에 못 미치는데 칸을 골랐다');
    eq(rungAtOrBelow(10), 10);
    eq(rungAtOrBelow(19.9), 10);
    eq(rungAtOrBelow(20), 20);
    eq(rungAtOrBelow(49.9), 30);
    eq(rungAtOrBelow(74.9), 50);
    eq(rungAtOrBelow(75), 75);
    eq(rungAtOrBelow(1000), 75, '상한이 아무리 커도 75까지다');
  });

  test('고른 칸은 모든 축의 상한 이하다', () => {
    const cases = [0.3, 0.8, 1.2, 2.0, 3.0];
    for (const atr of cases) {
      const r = planAdaptiveLeverage(base({ atrPct: atr, highRiskApproved: true }));
      if (!r.ok) continue;
      for (const [k, v] of Object.entries(r.caps!)) {
        assert(r.leverage! <= v + 1e-9,
          `ATR ${atr}%에서 고른 ${r.leverage}배가 ${k} 상한 ${v}를 넘는다`);
      }
    }
  });

  test('막힌 판정에도 왜 막혔는지가 남는다', () => {
    const r = planAdaptiveLeverage(base({ atrPct: 9 }));
    eq(r.ok, false);
    assert(!!r.caps, '상한 내역이 없다 — 왜 막혔는지 설명할 수 없다');
    assert(!!r.binding, '어느 축이 잡았는지가 없다');
    assert(r.message.length > 10, '사유가 비었다');
  });
}

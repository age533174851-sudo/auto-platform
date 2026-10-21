// src/lib/strategies/dailyForcedEntry.test.ts
//
// **신호가 없어도 09:00 KST에는 한 번 시도한다 — 그러나 모르면 안 한다.**
//
// 이 파일이 막는 두 가지 반대 방향의 고장:
//   · 창이 왔는데 아무것도 안 하는 것 (지금까지의 상태)
//   · 창이라는 이유로 모르는 것 위에 또 내는 것 (중복 진입)

import { test, eq, assert } from '../../test/harness';
import {
  forcedEntryVerdict, forcedEntrySignal, forcedWindowStartMs,
  FORCED_ENTRY_START_KST, FORCED_ENTRY_WINDOW_MIN, FORCED_ENTRY_SIDE,
} from './dailyForcedEntry';
import { SCALP_DEFAULTS, type Bars } from './scalpSignal';
import { toStandardSignal } from './scalpRun';
import { WINDOW_START_KST } from './originalV1';

/** 09:00 KST == 00:00 UTC */
const AT = (utcHH: number, utcMM: number) =>
  Date.parse(`2026-10-21T${String(utcHH).padStart(2, '0')}:${String(utcMM).padStart(2, '0')}:00Z`);

const OK = {
  mode: 'TESTNET', profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X',
  ordersTodayInWindow: 0,
};

/** 평탄하지 않은 봉 — ATR이 0이 아니어야 한다 */
function bars(n = 60, base = 60000): Bars {
  const closes: number[] = [], highs: number[] = [], lows: number[] = [], volumes: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = base + (i % 5) * 10;
    closes.push(c); highs.push(c + 25); lows.push(c - 25); volumes.push(100);
  }
  return { closes, highs, lows, volumes } as Bars;
}

export function runDailyForcedEntryTests() {
  console.log('[Exact100X — 09:00 KST 강제 진입]');

  test('창은 09:00 KST에 시작한다 — 원본 전략의 09:10과 다르다', () => {
    eq(FORCED_ENTRY_START_KST.hh, 9);
    eq(FORCED_ENTRY_START_KST.mm, 0);
    // 원본 전략(`my-original-v1`)은 그대로 09:10이다. 건드리지 않았다.
    eq(WINDOW_START_KST.hh, 9);
    eq(WINDOW_START_KST.mm, 10);
  });

  test('★ 창 안이고 오늘 낸 것이 없으면 신호 없이도 시도한다', () => {
    const v = forcedEntryVerdict({ nowMs: AT(0, 5), ...OK });
    eq(v.due, true); eq(v.code, 'DUE');
    eq(v.tradingDay, '2026-10-21');
  });

  test('창 경계: 09:00 포함, 09:30 제외', () => {
    eq(forcedEntryVerdict({ nowMs: AT(0, 0), ...OK }).due, true);
    eq(forcedEntryVerdict({ nowMs: AT(0, FORCED_ENTRY_WINDOW_MIN - 1), ...OK }).due, true);
    eq(forcedEntryVerdict({ nowMs: AT(0, FORCED_ENTRY_WINDOW_MIN), ...OK }).code, 'AFTER_WINDOW');
  });

  test('창 전·후에는 시도하지 않는다 — 지난 창을 뒤늦게 열지 않는다', () => {
    eq(forcedEntryVerdict({ nowMs: AT(23, 59), ...OK }).code, 'BEFORE_WINDOW');
    eq(forcedEntryVerdict({ nowMs: AT(5, 0), ...OK }).code, 'AFTER_WINDOW');
  });

  test('★ 오늘 이미 냈으면 또 내지 않는다 — 하루 한 번', () => {
    const v = forcedEntryVerdict({ nowMs: AT(0, 5), ...OK, ordersTodayInWindow: 1 });
    eq(v.due, false); eq(v.code, 'ALREADY_TODAY');
  });

  test('★ 오늘 냈는지 **못 읽으면** 내지 않는다 — 0건으로 접지 않는다', () => {
    for (const bad of [null, undefined, NaN, 'none' as any]) {
      const v = forcedEntryVerdict({ nowMs: AT(0, 5), ...OK, ordersTodayInWindow: bad });
      eq(v.due, false, String(bad));
      eq(v.code, 'HISTORY_UNKNOWN', String(bad));
    }
  });

  test('★ TESTNET이 아니면 절대 열리지 않는다', () => {
    for (const m of ['LIVE_SMALL', 'LIVE_LIMITED', 'SHADOW_LIVE', 'PAPER', 'UI_DEMO', '', null]) {
      const v = forcedEntryVerdict({ nowMs: AT(0, 5), ...OK, mode: m });
      eq(v.due, false, String(m));
      eq(v.code, 'NOT_TESTNET', String(m));
    }
  });

  test('★ Exact100X 계약이 아니면 열리지 않는다', () => {
    eq(forcedEntryVerdict({ nowMs: AT(0, 5), ...OK, profileId: 'OTHER' }).code, 'NOT_EXACT100X');
    eq(forcedEntryVerdict({ nowMs: AT(0, 5), ...OK, presetId: 'OTHER' }).code, 'NOT_EXACT100X');
    eq(forcedEntryVerdict({ nowMs: AT(0, 5), ...OK, profileId: null }).code, 'NOT_EXACT100X');
  });

  test('★ 시계를 읽지 못하면 내지 않는다', () => {
    for (const bad of [NaN, Infinity]) {
      eq(forcedEntryVerdict({ nowMs: bad, ...OK }).code, 'CLOCK_UNREADABLE', String(bad));
    }
  });

  test('창 시작 시각(ms)은 그날 09:00 KST다', () => {
    const at = AT(0, 17);
    eq(forcedWindowStartMs(at), AT(0, 0));
  });

  console.log('[강제 진입 주문 모양 — 크기는 평소와 같은 ATR로 센다]');

  test('★ 강제 신호는 주문 모양으로 변환된다 (손절 방향 포함)', () => {
    const r = forcedEntrySignal(bars(), SCALP_DEFAULTS);
    assert(r.signal != null, r.reason);
    eq(r.signal!.side, FORCED_ENTRY_SIDE);
    assert(r.signal!.stop < r.signal!.entry, '롱인데 손절이 진입가 위에 있습니다');
    assert(r.signal!.target > r.signal!.entry, '롱인데 목표가 진입가 아래에 있습니다');
    // 실제 주문 경로가 쓰는 변환을 통과해야 한다 — 여기서 null이면
    // 라우트가 `signal_unusable`로 끝난다.
    const std = toStandardSignal(r.signal!, 'BTCUSDT', 15, 'scalp');
    assert(std != null, '강제 신호가 표준 신호로 변환되지 않았습니다');
    eq(std!.signal, 'LONG');
  });

  test('★ 손절 폭을 모르면 강제라도 만들지 않는다', () => {
    // 봉이 모자라 ATR을 못 구하는 경우.
    const r = forcedEntrySignal(bars(3), SCALP_DEFAULTS);
    eq(r.signal, null);
    assert(/ATR/.test(r.reason), r.reason);
  });

  test('★ 종가를 못 읽으면 만들지 않는다', () => {
    eq(forcedEntrySignal({ closes: [], highs: [], lows: [], volumes: [] } as any, SCALP_DEFAULTS).signal, null);
    const b = bars(); (b.closes as any)[b.closes.length - 1] = NaN;
    eq(forcedEntrySignal(b, SCALP_DEFAULTS).signal, null);
  });

  test('★ 크기는 평소 신호와 같은 ATR·같은 배수로 센다', () => {
    const b = bars();
    const r = forcedEntrySignal(b, SCALP_DEFAULTS)!;
    const expectedStopDist = r.signal!.atr * SCALP_DEFAULTS.atrStopMult;
    assert(Math.abs((r.signal!.entry - r.signal!.stop) - expectedStopDist) < 1e-9,
      '강제 진입이 다른 손절 폭을 씁니다');
    assert(Math.abs((r.signal!.target - r.signal!.entry) - expectedStopDist * SCALP_DEFAULTS.rewardRisk) < 1e-9,
      '강제 진입이 다른 보상비를 씁니다');
  });

  test('★ 강제로 들어갔다는 사실이 기록에 남는다', () => {
    const r = forcedEntrySignal(bars(), SCALP_DEFAULTS);
    assert(r.signal!.notes.some(n => /강제 진입/.test(n)), r.signal!.notes.join(' · '));
  });
}

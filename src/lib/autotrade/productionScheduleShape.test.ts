// src/lib/autotrade/productionScheduleShape.test.ts
//
// **운영 예약의 실제 모양으로 09:00 강제 진입을 끝까지 따라간다.**
//
// Issue #450이 읽기 전용으로 확인해 준 운영 사실:
//
//   autotrade_schedules 2줄 (BTCUSDT · ETHUSDT)
//     mode=TESTNET · strategy_id=scalp · strategy_version=1 · interval_min=60
//     last_result = …NO_BREAKOUT
//
// `NO_BREAKOUT`은 **주문 전송 실패가 아니다.** 평가는 정상으로 끝났고
// 진입 조건이 없었다는 뜻이다(`runStrategy.ts`가 그렇게 분류한다).
//
// 그런데 09:00 강제 진입은 "조건이 없어도 하루 한 번 시도한다"가 규칙이다.
// 조건이 없었는데도 시도가 없었다면, 막은 곳이 따로 있다.
//
// 여기서 고정하는 것은 **차단 지점 둘**이다:
//
//   ① 배포된 scalp 경로에 강제 진입 분기가 **없다**
//      (`scalp/route.ts`의 `if (!scalp.signal)`에서 바로 끝난다.
//       그 자리에 분기를 넣는 것이 #386이고, 아직 Draft다)
//
//   ② 분기가 생겨도 **Exact100X 계약이 없으면 열리지 않는다**
//      (`dailyForcedEntry.ts`의 NOT_EXACT100X · 깨우기 쪽도 같은 조건)
//
// ②는 코드가 아니라 **예약 줄의 설정** 문제다. 그래서 코드로 고치지
// 않는다 — 운영 DB를 바꾸는 일이고 승인 사항이다. 대신 "계약이 없으면
// 9시에 아무 일도 일어나지 않는다"를 시험으로 박아, 설정이 빠진 채로
// 배포돼도 조용히 지나가지 않게 한다.
//
// 막으려는 것:
//  1. `NO_BREAKOUT`을 "주문이 실패했다"로 읽는 것
//  2. 계약 없는 예약을 9시 창이 있는 것처럼 보는 것
//  3. BTC만 보고 ETH도 될 것이라고 넘기는 것
//  4. 창·중복·유예 경계가 종목마다 달라지는 것
import { test, assert, eq } from '../../test/harness';
import { entryWindowOf } from './entryWindowDue';
import { dueCheck } from './evaluationLoop';
import { selectDueSchedules } from './schedulePoll';
import { scheduleProbeOf } from './scheduleProbe';
import {
  forcedEntryVerdict, FORCED_ENTRY_MODE,
  FORCED_ENTRY_PROFILE_ID, FORCED_ENTRY_PRESET_ID,
} from '../strategies/dailyForcedEntry';

const kst = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 9, 26, hh - 9, mm, ss);

interface SchedRow {
  id: string; symbol: string; mode: string; enabled: boolean; connection_id: string;
  strategy_id: string; strategy_version: number; interval_min: number;
  last_run_at: string; last_result: string;
  /** 09:00 강제 진입은 이 둘이 채워져 있어야 돈다. 운영에서는 비어 있을 수 있다 */
  execution_profile_id?: string | null;
  execution_preset_id?: string | null;
}

/** Issue #450이 적은 운영 예약 모양. **계약 칸은 비어 있다** */
const prodRow = (symbol: string, over: Record<string, any> = {}): SchedRow => ({
  id: `sch-${symbol}`, symbol, mode: 'TESTNET', enabled: true,
  connection_id: `conn-${symbol}`,
  strategy_id: 'scalp', strategy_version: 1, interval_min: 60,
  last_run_at: new Date(kst(8, 11)).toISOString(),
  last_result: '정상 평가 완료 · 진입 조건 없음 · 사유코드 NO_BREAKOUT',
  ...over,
});

/** 계약을 채운 모양 — 09:00 강제 진입이 돌 수 있는 상태 */
const withContract = (symbol: string, over: Record<string, any> = {}): SchedRow =>
  prodRow(symbol, {
    execution_profile_id: FORCED_ENTRY_PROFILE_ID,
    execution_preset_id: FORCED_ENTRY_PRESET_ID,
    ...over,
  });

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;

const wakeOf = (row: any, hh: number, mm: number, ss = 0) => dueCheck({
  nowMs: kst(hh, mm, ss), enabled: row.enabled, connectionId: row.connection_id,
  lastRunAtMs: row.last_run_at, intervalMin: row.interval_min,
  strategyId: row.strategy_id,
  profileId: row.execution_profile_id, presetId: row.execution_preset_id,
} as any);

export function runProductionScheduleShapeTests() {
  console.log('[운영 예약 모양 — 9시에 왜 아무 일도 없었나]');

  // ── ② 계약이 없으면 9시에 아무 일도 없다 ────────
  for (const sym of SYMBOLS) {
    test(`★★★ ${sym} — 계약 없는 운영 모양은 09:00 창이 열리지 않는다`, () => {
      const r = prodRow(sym);
      eq(entryWindowOf(r.strategy_id, {
        profileId: r.execution_profile_id, presetId: r.execution_preset_id,
      }), null);
      // 창 전체(09:00~09:30) 어디서도 깨우지 않는다 — 간격 판정만 남는다.
      for (let m = 0; m <= 30; m++) {
        assert(wakeOf(r, 9, m).code !== 'WINDOW', `09:${m}에 깨웠다`);
      }
    });

    test(`★★★ ${sym} — 계약이 없으면 판단 쪽도 NOT_EXACT100X로 막는다`, () => {
      const r = prodRow(sym);
      const v = forcedEntryVerdict({
        nowMs: kst(9, 15), mode: r.mode,
        profileId: r.execution_profile_id, presetId: r.execution_preset_id,
        ordersTodayInWindow: 0,
      });
      eq(v.due, false);
      eq(v.code, 'NOT_EXACT100X');
    });

    test(`★★ ${sym} — 진단이 "창 없음"을 값으로 드러낸다`, () => {
      // 이 한 줄이 응답에 있었다면 Fly 로그를 열 필요가 없었다.
      const p = scheduleProbeOf(prodRow(sym));
      eq(p.strategyId, 'scalp');
      eq(p.entryWindowKst, null);
      assert((p.lastResult ?? '').includes('NO_BREAKOUT'), p.lastResult ?? 'null');
    });
  }

  test('★★ NO_BREAKOUT은 주문 실패가 아니다 — 평가가 끝난 것이다', () => {
    // 이것을 전송 실패로 읽으면 거래소·키·네트워크를 뒤지게 된다.
    const p = scheduleProbeOf(prodRow('BTCUSDT'));
    assert(!/FAILED|UNKNOWN|REJECT/i.test(p.lastResult ?? ''), p.lastResult ?? '');
  });

  // ── 계약을 채우면 두 종목 모두 열린다 ───────────
  for (const sym of SYMBOLS) {
    test(`★★★ ${sym} — 계약을 채우면 불리한 위상(08:11)에서도 09:00에 깨운다`, () => {
      const r = withContract(sym);
      eq(wakeOf(r, 9, 0).code, 'WINDOW');
      eq(wakeOf(r, 9, 15).code, 'WINDOW');
      eq(wakeOf(r, 9, 29, 59).code, 'WINDOW');
    });

    test(`★★ ${sym} — 09:30 경계에서 깨우기와 판단이 함께 닫힌다`, () => {
      const r = withContract(sym);
      assert(wakeOf(r, 9, 30).code !== 'WINDOW', `09:30에 깨웠다: ${wakeOf(r, 9, 30).code}`);
      eq(forcedEntryVerdict({
        nowMs: kst(9, 30), mode: FORCED_ENTRY_MODE,
        profileId: FORCED_ENTRY_PROFILE_ID, presetId: FORCED_ENTRY_PRESET_ID,
        ordersTodayInWindow: 0,
      }).code, 'AFTER_WINDOW');
    });

    test(`★★ ${sym} — 창 안에서 한 번 평가했으면 다시 깨우지 않는다 (중복 실행)`, () => {
      const r = withContract(sym, { last_run_at: new Date(kst(9, 5)).toISOString() });
      for (const m of [10, 20, 29]) {
        assert(wakeOf(r, 9, m).code !== 'WINDOW', `09:${m}에 다시 깨웠다`);
      }
    });

    test(`★★ ${sym} — 이미 냈으면 · 이력을 모르면 주문하지 않는다`, () => {
      const base = {
        nowMs: kst(9, 15), mode: FORCED_ENTRY_MODE,
        profileId: FORCED_ENTRY_PROFILE_ID, presetId: FORCED_ENTRY_PRESET_ID,
      };
      eq(forcedEntryVerdict({ ...base, ordersTodayInWindow: 1 }).code, 'ALREADY_TODAY');
      eq(forcedEntryVerdict({ ...base, ordersTodayInWindow: null }).code, 'HISTORY_UNKNOWN');
    });
  }

  test('★★★ 두 종목이 같은 창·같은 경계를 쓴다 (한쪽만 열리지 않는다)', () => {
    const [b, e] = SYMBOLS.map(s => withContract(s));
    for (let m = 0; m <= 35; m++) {
      eq(wakeOf(b, 9, m).code, wakeOf(e, 9, m).code, `09:${m}`);
    }
  });

  test('★★ 폴러도 두 종목을 함께 고른다 — TESTNET + 계약일 때만', () => {
    const withC = SYMBOLS.map(s => withContract(s));
    eq(selectDueSchedules(withC as any, kst(9, 0)).due.length, 2);
    const without = SYMBOLS.map(s => prodRow(s));
    eq(selectDueSchedules(without as any, kst(9, 0)).due.length, 0);
  });

  test('★★ 실전 모드는 계약이 있어도 강제 진입하지 않는다', () => {
    eq(forcedEntryVerdict({
      nowMs: kst(9, 15), mode: 'LIVE',
      profileId: FORCED_ENTRY_PROFILE_ID, presetId: FORCED_ENTRY_PRESET_ID,
      ordersTodayInWindow: 0,
    }).code, 'NOT_TESTNET');
  });
}

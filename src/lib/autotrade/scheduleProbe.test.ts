// src/lib/autotrade/scheduleProbe.test.ts
//
// 막으려는 것:
//  1. "오늘 9시에 뭐가 돌았나"의 답이 **Fly 로그에만** 있는 것
//  2. 모르는 값을 빈 문자열·0으로 적는 것
//  3. 창이 없는 전략을 "창 있음"처럼 보이게 하는 것
//  4. 09:00 창(Exact100X 계약 필요)과 09:10 창(원본)을 섞는 것
import { test, assert, eq } from '../../test/harness';
import { scheduleProbeOf } from './scheduleProbe';
import {
  FORCED_ENTRY_PROFILE_ID, FORCED_ENTRY_PRESET_ID,
} from '../strategies/dailyForcedEntry';

export function runScheduleProbeTests() {
  console.log('[예약 진단 — 로그를 열지 않고도 무엇이 도는지 안다]');

  test('★★★ 09:16 틱이 답하지 못하던 세 가지를 값으로 돌려준다', () => {
    // 2026-10-26 09:16 KST 틱의 실제 모양 — 응답에는 symbol·mode·
    // "다음 평가까지 54분"뿐이었다.
    const p = scheduleProbeOf({
      symbol: 'BTCUSDT', mode: 'TESTNET', strategy_id: 'scalp',
      execution_profile_id: FORCED_ENTRY_PROFILE_ID,
      execution_preset_id: FORCED_ENTRY_PRESET_ID,
      last_run_at: '2026-10-26T00:10:00.000Z',
      last_outcome: 'NO_TRADE', last_reason: '조건 불충족',
    });
    eq(p.strategyId, 'scalp');                      // 어느 전략인가
    eq(p.lastRunAt, '2026-10-26T00:10:00.000Z');    // 언제 평가했나
    eq(p.lastOutcome, 'NO_TRADE');                  // 무엇을 결정했나
    eq(p.lastReason, '조건 불충족');
  });

  test('★★ Exact100X 계약이면 09:00 창이 보인다', () => {
    const p = scheduleProbeOf({
      strategy_id: 'scalp',
      execution_profile_id: FORCED_ENTRY_PROFILE_ID,
      execution_preset_id: FORCED_ENTRY_PRESET_ID,
    });
    eq(p.entryWindowKst, '09:00~09:30');
  });

  test('★★★ 계약 없는 scalp는 창이 없다고 적는다 — 9시 창을 기대하면 안 된다', () => {
    const p = scheduleProbeOf({ strategy_id: 'scalp' });
    eq(p.entryWindowKst, null);
  });

  test('★★ my-original-v1은 09:10 창 + 유예가 보인다 (09:00과 다르다)', () => {
    const p = scheduleProbeOf({ strategy_id: 'my-original-v1' });
    eq(p.entryWindowKst, '09:10~09:30 (+30분 유예)');
  });

  test('계단식은 창이 없다', () => {
    eq(scheduleProbeOf({ strategy_id: 'daily-ladder' }).entryWindowKst, null);
  });

  test('★★ strategy_id가 비어 있으면 정본대로 계단식으로 되돌린다', () => {
    for (const v of [null, undefined, '', '  ']) {
      eq(scheduleProbeOf({ strategy_id: v }).strategyId, 'daily-ladder');
    }
  });

  test('★★★ 모르는 값은 null이다 — 빈 문자열·0으로 적지 않는다', () => {
    const p = scheduleProbeOf({ strategy_id: 'scalp' });
    eq(p.lastRunAt, null);
    eq(p.lastOutcome, null);
    eq(p.lastReason, null);
  });

  test('공백만 있는 값도 null로 읽는다', () => {
    const p = scheduleProbeOf({
      strategy_id: 'scalp', last_run_at: '   ', last_outcome: '', last_reason: '  ',
    });
    eq(p.lastRunAt, null);
    eq(p.lastOutcome, null);
    eq(p.lastReason, null);
  });

  test('★ 한 번도 안 돈 예약은 "평가 없음"이 값으로 드러난다', () => {
    const p = scheduleProbeOf({
      strategy_id: 'scalp', last_run_at: null,
      execution_profile_id: FORCED_ENTRY_PROFILE_ID,
      execution_preset_id: FORCED_ENTRY_PRESET_ID,
    });
    eq(p.lastRunAt, null);
    assert(p.entryWindowKst === '09:00~09:30', p.entryWindowKst ?? 'null');
  });

  test('행 자체가 비어도 던지지 않는다', () => {
    const p = scheduleProbeOf({});
    eq(p.strategyId, 'daily-ladder');
    eq(p.lastRunAt, null);
    eq(p.entryWindowKst, null);
  });
}

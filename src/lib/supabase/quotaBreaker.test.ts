// src/lib/supabase/quotaBreaker.test.ts
//
// **한도에 걸렸을 때 재시도가 전송량을 더 늘리지 않는가.**
// 그리고 그 절약이 **포지션 보호를 건드리지 않는가.**

import { test, eq, assert } from '../../test/harness';
import {
  isQuotaError, noteResult, quotaGate, backoffMsFor, breakerLine,
  OPEN_BREAKER, BACKOFF_STEPS_MS, type BreakerState,
} from './quotaBreaker';

const T0 = Date.parse('2026-10-21T00:00:00Z');

export function runQuotaBreakerTests() {
  console.log('[DB 사용량 차단기 — 402에 재시도를 퍼붓지 않는다]');

  test('★ 402와 한도 초과를 알아본다', () => {
    for (const err of [
      { status: 402 },
      { code: 402 },
      { message: 'Payment Required' },
      { message: 'HTTP 402 returned by the gateway' },
      { message: 'Egress quota exceeded for this project' },
      { message: 'You have exceeded the free plan limit' },
      { message: 'bandwidth limit reached' },
    ]) {
      assert(isQuotaError(err), JSON.stringify(err));
    }
  });

  test('★ 평범한 오류를 한도로 오해하지 않는다', () => {
    for (const err of [
      null, undefined, {},
      { message: 'connection reset by peer' },
      { message: 'duplicate key value violates unique constraint' },
      { status: 500, message: 'internal error' },
      { message: 'relation "jobs" does not exist' },
    ]) {
      assert(!isQuotaError(err), JSON.stringify(err));
    }
  });

  test('★ 한도 오류 한 번이면 한가한 조회가 멈춘다', () => {
    const s = noteResult(OPEN_BREAKER, { error: { status: 402 } }, T0);
    eq(s.strikes, 1);
    eq(s.blockedUntilMs, T0 + BACKOFF_STEPS_MS[0]);
    const g = quotaGate(s, 'ROUTINE', T0 + 1000);
    eq(g.allowed, false);
    eq(g.code, 'SKIP_QUOTA');
    assert(/전송량/.test(g.reason), g.reason);
  });

  test('★★ 포지션 보호 조회는 차단기가 닫혀 있어도 **언제나** 보낸다', () => {
    // 한도를 아끼려고 보호를 멈추면, 아낀 것보다 큰 것을 잃는다.
    let s: BreakerState = OPEN_BREAKER;
    for (let i = 0; i < 10; i++) s = noteResult(s, { error: { status: 402 } }, T0);
    const g = quotaGate(s, 'PROTECTION', T0 + 1000);
    eq(g.allowed, true);
    eq(g.code, 'ALLOW');
  });

  test('★ 반복되면 대기가 길어지고 30분에서 멈춘다', () => {
    let s: BreakerState = OPEN_BREAKER;
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      s = noteResult(s, { error: { message: 'egress quota exceeded' } }, T0);
      waits.push(s.blockedUntilMs! - T0);
    }
    eq(waits[0], 60_000);
    eq(waits[1], 120_000);
    eq(waits[4], 960_000);
    eq(waits[5], 1_800_000);
    eq(waits[7], 1_800_000, '상한을 넘겨 계속 늘어났습니다');
    // 3초마다 보내던 것이 30분에 한 번이 된다 — 600분의 1이다.
    assert(backoffMsFor(99) === 1_800_000);
  });

  test('★ 대기가 지나면 다시 열린다 — 달이 바뀌면 풀리기 때문이다', () => {
    const s = noteResult(OPEN_BREAKER, { error: { status: 402 } }, T0);
    eq(quotaGate(s, 'ROUTINE', T0 + 59_999).allowed, false);
    eq(quotaGate(s, 'ROUTINE', T0 + 60_000).allowed, true);
  });

  test('★ 성공하면 즉시 연다', () => {
    let s = noteResult(OPEN_BREAKER, { error: { status: 402 } }, T0);
    s = noteResult(s, { error: null }, T0 + 60_000);
    eq(s.strikes, 0);
    eq(s.blockedUntilMs, null);
    eq(quotaGate(s, 'ROUTINE', T0 + 60_001).allowed, true);
  });

  test('★ 한도가 아닌 오류는 차단기를 **닫지도 열지도** 않는다', () => {
    // 네트워크 끊김까지 모아서 끊으면 고칠 수 있는 고장이 숨는다.
    // 그렇다고 열어 주면 확인하지 않은 것을 통과로 적는 것이 된다.
    const closed = noteResult(OPEN_BREAKER, { error: { status: 402 } }, T0);
    const after = noteResult(closed, { error: { message: 'connection reset' } }, T0 + 1000);
    eq(after.blockedUntilMs, closed.blockedUntilMs);
    eq(after.strikes, closed.strikes);

    const open = noteResult(OPEN_BREAKER, { error: { message: 'connection reset' } }, T0);
    eq(open.blockedUntilMs, null);
  });

  test('★ 상태 한 줄은 숫자를 지어내지 않는다', () => {
    eq(breakerLine(OPEN_BREAKER, T0), 'DB 사용량 차단기: 열림');
    const s = noteResult(OPEN_BREAKER, { error: { status: 402 } }, T0);
    assert(/닫힘 \(연속 1회 · 60초/.test(breakerLine(s, T0)), breakerLine(s, T0));
    // 대기가 지나면 열림으로 적는다 — 닫혔던 사실을 계속 적지 않는다.
    eq(breakerLine(s, T0 + 60_000), 'DB 사용량 차단기: 열림');
  });

  test('★ 상태가 없거나 깨져 있으면 막지 않는다 — 모른다고 보호를 멈추지 않는다', () => {
    for (const bad of [null, undefined, { strikes: 0, blockedUntilMs: NaN, lastQuotaFailureMs: null }]) {
      eq(quotaGate(bad as any, 'ROUTINE', T0).allowed, true);
      eq(quotaGate(bad as any, 'PROTECTION', T0).allowed, true);
    }
  });
}

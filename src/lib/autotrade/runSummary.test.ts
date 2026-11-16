// src/lib/autotrade/runSummary.test.ts
import { test, eq, assert } from '../../test/harness';
import { runSummary, blockedByConnection } from './runSummary';

export function runRunSummaryTests() {
  console.log('[실행 요약 — 못 돈 줄을 0으로 적지 않는다]');

  test('★★ 막힌 줄이 있으면 "실패 0건"으로 끝내지 않는다', () => {
    // 사용자가 실제로 본 상태: 4줄 중 2줄은 연결이 사라져 돌 수 없었다.
    const s = runSummary([
      { ok: true, executed: false },
      { ok: true, executed: false },
      { ok: false, blocked: true },
      { ok: false, blocked: true },
    ], 4);
    eq(s.blocked, 2);
    eq(s.failed, 0, '막힘을 실패로 중복해서 셌다');
    assert(/막힘 2건/.test(s.text), s.text);
    assert(/연결/.test(s.text), `무엇을 고쳐야 하는지가 없다: ${s.text}`);
  });

  test('★ 막힌 줄이 없으면 막힘을 적지 않는다', () => {
    const s = runSummary([{ ok: true }, { ok: true, executed: true }], 2);
    eq(s.blocked, 0);
    eq(s.entered, 1);
    assert(!/막힘/.test(s.text), s.text);
  });

  test('★ 실패와 막힘은 다른 칸이다', () => {
    const s = runSummary([
      { ok: false },               // 해 봤는데 안 됨
      { ok: false, blocked: true },// 해 볼 수조차 없음
    ], 2);
    eq(s.failed, 1);
    eq(s.blocked, 1);
    assert(/실패 1건/.test(s.text) && /막힘 1건/.test(s.text), s.text);
  });

  test('★★ 연결이 사라진 예약은 막힘이다', () => {
    eq(blockedByConnection('STALE')?.code, 'STALE_CONNECTION');
    eq(blockedByConnection('MISSING')?.code, 'NO_CONNECTION');
  });

  test('★★ 연결 목록을 못 읽은 것은 막힘이 아니다 — 모름을 막힘으로 적지 않는다', () => {
    eq(blockedByConnection('UNKNOWN'), null, '못 읽은 것을 막혔다고 적었다');
    eq(blockedByConnection(null), null);
    eq(blockedByConnection(undefined), null);
  });

  test('연결이 멀쩡하면 막힘이 아니다', () => {
    eq(blockedByConnection('OK'), null);
  });

  test('확인한 줄 수는 읽은 줄 수다 — 결과 배열 길이가 아니다', () => {
    eq(runSummary([], 7).checked, 7);
    eq(runSummary(null, 0).text, '0건 확인 · 진입 0건 · 실패 0건');
  });
}

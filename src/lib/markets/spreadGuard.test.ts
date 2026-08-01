import { test, eq, assert, close } from '../../test/harness';
import { checkSpread, minTargetPct } from './spreadGuard';

export function runSpreadGuardTests() {
  console.log('[거래 비용 — 이겨도 못 버는 매매]');

  // ── 두꺼운 시장 ─────────────────────────────────────────
  test('스프레드가 좁으면 통과', () => {
    // BTC 같은 시장: 0.01% 수준
    const r = checkSpread({ bid: 99_995, ask: 100_005 });
    eq(r.status, 'ok');
    eq(r.canOrder, true);
    close(r.spreadPct!, 0.01, 0.001);
  });

  test('왕복 비용은 스프레드 + 수수료 두 번이다', () => {
    // 사고 팔면 수수료를 두 번 낸다. 한 번만 세면 절반을 놓친다.
    const r = checkSpread({ bid: 100, ask: 100 }, { feePct: 0.1 });
    close(r.roundTripPct!, 0.2, 0.001);
  });

  test('중간값을 돌려준다 — 벌어졌을 때 쓸 수 있는 유일한 값', () => {
    eq(checkSpread({ bid: 98, ask: 102 }).mid, 100);
  });

  // ── 얇은 시장 ───────────────────────────────────────────
  test('스프레드가 넓으면 막는다', () => {
    // 토큰화 주식: 1% 수준
    const r = checkSpread({ bid: 99.5, ask: 100.5 });
    eq(r.status, 'wide');
    eq(r.canOrder, false);
    close(r.spreadPct!, 1, 0.01);
  });

  test('기준을 올리면 통과시킨다', () => {
    eq(checkSpread({ bid: 99.5, ask: 100.5 }, { maxSpreadPct: 2 }).status, 'ok');
  });

  test('막을 때 숫자를 적는다 — 얼마나 벌어졌는지 안 적으면 못 고친다', () => {
    const r = checkSpread({ bid: 99.5, ask: 100.5 });
    assert(r.reason.includes('%'), r.reason);
    assert(r.reason.includes('왕복'), r.reason);
  });

  // ── 이겨도 못 버는 매매 ─────────────────────────────────
  test('목표가 왕복 비용보다 작으면 성립하지 않는다', () => {
    // 목표 1%인데 왕복 2.2%면, 맞춰도 1.2% 손해다. 승률과 무관하게
    // 산수가 안 맞는다 — 넓다/좁다의 문제가 아니다.
    const r = checkSpread({ bid: 99, ask: 101 }, { maxSpreadPct: 5, feePct: 0.1, targetPct: 1 });
    eq(r.status, 'unwinnable');
    eq(r.canOrder, false);
    assert(r.reason.includes('이겨도'), r.reason);
  });

  test('목표가 비용보다 크면 통과', () => {
    const r = checkSpread({ bid: 99.9, ask: 100.1 }, { feePct: 0.1, targetPct: 3 });
    eq(r.status, 'ok');
  });

  test('목표와 비용이 같으면 성립하지 않는다 — 본전은 이긴 게 아니다', () => {
    // 스프레드 0 + 수수료 왕복 0.2% = 0.2%. 목표도 0.2%.
    eq(checkSpread({ bid: 100, ask: 100 }, { feePct: 0.1, targetPct: 0.2 }).status, 'unwinnable');
  });

  test('비용이 목표의 몇 %인지 적는다', () => {
    // 통과하더라도 "목표의 20%가 비용"이면 알아야 한다.
    const r = checkSpread({ bid: 99.9, ask: 100.1 }, { feePct: 0.1, targetPct: 2 });
    assert(r.reason.includes('비용'), r.reason);
  });

  test('못 이기는 것을 넓은 것보다 먼저 본다', () => {
    // 둘 다 해당해도 '못 번다'가 더 정확한 설명이다. '호가가 넓습니다'만
    // 뜨면 사용자는 기준을 올려서 통과시킨다 — 그래도 여전히 못 번다.
    const r = checkSpread({ bid: 99, ask: 101 }, { maxSpreadPct: 0.1, targetPct: 1 });
    eq(r.status, 'unwinnable');
  });

  // ── 모르면 막는다 ───────────────────────────────────────
  test('호가를 못 읽으면 스프레드 0이 아니라 확인 불가다', () => {
    // 0으로 치면 얇은 시장에서 스프레드를 모른 채로 시장가가 나간다.
    for (const b of [null, undefined, {}, { bid: 100 }, { ask: 100 }] as any[]) {
      const r = checkSpread(b);
      eq(r.status, 'unknown');
      eq(r.canOrder, false);
      eq(r.spreadPct, null);
    }
  });

  test('0이나 음수 호가는 못 읽은 것으로 본다', () => {
    eq(checkSpread({ bid: 0, ask: 100 }).status, 'unknown');
    eq(checkSpread({ bid: 100, ask: -1 }).status, 'unknown');
    eq(checkSpread({ bid: NaN, ask: 100 }).status, 'unknown');
  });

  test('호가가 뒤집혀 있으면 막는다', () => {
    // 매도가 매수보다 낮은 것은 정상 시장에 없다 — 데이터가 뒤집혔거나
    // 두 시점의 값을 섞은 것이다. 그대로 계산하면 음수 스프레드가 나와
    // "비용이 마이너스"라는 결론이 된다.
    const r = checkSpread({ bid: 101, ask: 99 });
    eq(r.status, 'unknown');
    assert(r.reason.includes('뒤집'), r.reason);
  });

  test('매수와 매도가 같으면 스프레드 0이다 — 이건 정상이다', () => {
    const r = checkSpread({ bid: 100, ask: 100 });
    eq(r.status, 'ok');
    eq(r.spreadPct, 0);
  });

  // ── 최소 목표 ───────────────────────────────────────────
  test('최소 얼마를 노려야 하는지 알려준다', () => {
    // 막기만 하고 얼마면 되는지 안 알려 주면 무엇을 고쳐야 할지 모른다.
    eq(minTargetPct(1), 2);
    eq(minTargetPct(1, 3), 3);
  });

  test('본전보다 낮은 배수는 받지 않는다', () => {
    // 비용과 같은 수익은 본전이고, 본전을 목표로 매매할 이유가 없다.
    eq(minTargetPct(1, 0.5), 1);
  });

  test('비용을 모르면 최소 목표도 모른다', () => {
    eq(minTargetPct(null), null);
    eq(minTargetPct(NaN), null);
  });
}

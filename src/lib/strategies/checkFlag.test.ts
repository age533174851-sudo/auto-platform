// src/lib/strategies/checkFlag.test.ts
//
// **"주문은 안 냅니다"라고 적힌 버튼이 주문을 내면 안 된다.**
//
// scalp에서 실제로 그랬다. 레지스트리는 점검 플래그를 `checkOnly`로
// 선언했고 화면은 그 이름으로 보냈는데, 라우트는 `dryRun`만 읽었다.
// 그래서 점검 요청이 주문 경로까지 갈 수 있었다.

import { test, eq, assert } from '../../test/harness';
import { checkOnlyOf, checkFlagNote, CHECK_FLAGS } from './checkFlag';
import { STRATEGIES } from './registry';
import { usableIntervals, timeframeVerdict, SCALP_DEFAULTS } from './scalpSignal';

export function runCheckFlagTests() {
  console.log('[점검 플래그 — 이름이 갈려도 점검으로 읽는다]');

  test('선언한 이름으로 오면 점검이다', () => {
    eq(checkOnlyOf('scalp', { checkOnly: true }).checkOnly, true);
    eq(checkOnlyOf('my-original-v1', { dryRun: true }).checkOnly, true);
  });

  test('반대 이름으로 와도 점검으로 읽는다 — scalp에서 난 그 고장', () => {
    // 이 한 줄이 없어서 점검 호출이 주문 경로까지 갔다.
    const v = checkOnlyOf('scalp', { dryRun: true });
    eq(v.checkOnly, true, '반대 이름을 실주문으로 읽었다');
    eq(v.mismatch, true, '갈렸다는 사실이 기록되지 않았다');
    eq(v.via, 'dryRun'); eq(v.declared, 'checkOnly');
  });

  test('갈린 것을 막지는 않는다 — 점검은 안전한 쪽이다', () => {
    // 막으면 옛 호출부가 죽는다. 점검으로 읽고 기록만 남긴다.
    const v = checkOnlyOf('my-original-v1', { checkOnly: true });
    eq(v.checkOnly, true); eq(v.mismatch, true);
    assert(checkFlagNote(v).includes('둘 다 점검으로 읽었습니다'), checkFlagNote(v));
  });

  test('플래그가 없으면 실주문이다', () => {
    const v = checkOnlyOf('scalp', { symbol: 'BTCUSDT' });
    eq(v.checkOnly, false); eq(v.via, null); eq(v.mismatch, false);
    eq(checkFlagNote(v), '');
  });

  test('`=== true`만 점검이다 — 문자열 false를 점검으로 읽지 않는다', () => {
    // 반대로 뒤집히면 점검 요청이 주문이 된다.
    for (const bad of ['true', 'false', 1, 0, {}, [], null, undefined]) {
      eq(checkOnlyOf('scalp', { checkOnly: bad }).checkOnly, false, JSON.stringify(bad));
      eq(checkOnlyOf('scalp', { dryRun: bad }).checkOnly, false, JSON.stringify(bad));
    }
  });

  test('모르는 전략도 점검 요청은 점검으로 읽는다', () => {
    const v = checkOnlyOf('does-not-exist', { checkOnly: true });
    eq(v.checkOnly, true, '명세를 못 찾았다고 실주문으로 읽었다');
    eq(v.declared, null);
    eq(v.mismatch, false, '비교할 선언이 없으면 갈린 것이 아니다');
  });

  test('이 저장소가 쓰는 점검 플래그는 둘뿐이다', () => {
    eq(CHECK_FLAGS.join(','), 'checkOnly,dryRun');
    // 레지스트리의 모든 전략이 그 둘 중 하나를 쓴다 — 셋째 이름이 생기면
    // checkOnlyOf가 못 읽고, 그때 점검이 주문이 된다.
    for (const s of STRATEGIES) {
      assert((CHECK_FLAGS as readonly string[]).includes(s.checkFlag),
        `${s.id}의 checkFlag '${s.checkFlag}'를 checkOnlyOf가 읽지 못한다`);
    }
  });

  console.log('[scalp 주기 — 고를 수 있는 것과 돌릴 수 있는 것이 같다]');

  test('레지스트리가 내려보내는 주기는 전부 실제로 돈다', () => {
    // 예전에는 [1,5,15,60]을 내려보냈는데 라우트가 1·5·15를 409로 막았다.
    // **화면에서 고를 수는 있는데 실행하면 끝나는 상태**였다.
    const scalp = STRATEGIES.find(s => s.id === 'scalp')!;
    for (const m of scalp.supportedIntervals) {
      eq(timeframeVerdict(m, SCALP_DEFAULTS.roundTripCostPct).usable, true,
        `${m}분을 고를 수 있는데 실행하면 막힌다`);
    }
    assert(scalp.supportedIntervals.length > 0, '고를 수 있는 주기가 하나도 없다');
  });

  test('비용이 낮아지면 짧은 주기도 열린다', () => {
    // 목록이 비용에서 나오므로, 비용이 바뀌면 목록도 같이 움직인다.
    const cheap = usableIntervals([1, 5, 15, 60], 0.02);
    assert(cheap.length > 1, `싼 비용에서도 ${cheap.length}개뿐이다`);
    const dear = usableIntervals([1, 5, 15, 60], 0.15);
    assert(dear.length <= cheap.length, '비싼 쪽이 더 많이 열렸다');
  });

  test('전부 걸러져도 빈 목록을 주지 않는다 — 예약을 못 만들게 되면 안 된다', () => {
    const v = usableIntervals([1, 5], 99);
    eq(v.length, 1, '비면 예약 자체를 만들 수 없고 이유도 안 보인다');
    eq(v[0], 5, '남길 거면 가장 긴 것을 남긴다');
  });

  test('이상한 후보는 걸러낸다', () => {
    eq(usableIntervals([]).length, 0);
    eq(usableIntervals([0, -5, NaN as any, 60], 0.15).join(','), '60');
  });
}

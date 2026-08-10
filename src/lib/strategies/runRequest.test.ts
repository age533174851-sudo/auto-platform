// src/lib/strategies/runRequest.test.ts
//
// **화면에서 고른 전략이 끝까지 같은 전략이어야 한다.**
//
// 실제로 있던 고장
// ────────────────
// 서버는 `strategy_id`를 저장하고 읽고 목록까지 내려줬는데, 화면은
// `/api/autotrade/daily-ladder`를 **직접** 불렀다. 그래서 예약에 무엇을
// 저장하든 화면의 점검과 첫 평가는 언제나 계단식이었다. 오류는 안 났다 —
// 계단식이 정상 응답을 주니까.
//
// 이 파일이 못 박는 것은 하나다:
//
//   저장 → 예약 GET → 첫 평가 → 주기 평가
//
// 이 넷을 지나는 동안 `strategyId`가 바뀌지 않는다.

import { test, eq, assert } from '../../test/harness';
import { strategyRunRequest } from './runRequest';
import { STRATEGIES, resolveStrategy, strategyIdOfRow, LEGACY_STRATEGY_ID } from './registry';

const ETH = {
  symbol: 'ETHUSDT', connectionId: 'conn-1', mode: 'TESTNET',
  env: 'TESTNET' as const, intervalMin: 15,
};

export function runRunRequestTests() {
  console.log('[전략 배선 — 고른 전략이 끝까지 유지된다]');

  test('저장 → GET → 첫 평가 → 주기 평가에서 같은 전략이 유지된다', () => {
    // 1) 화면에서 고른 값 (저장 POST에 실리는 것)
    const picked = 'my-original-v1';

    // 2) 서버가 그 값을 예약 줄에 적고, GET이 다시 읽는다
    const row = { strategy_id: picked, strategy_version: '1' };
    eq(strategyIdOfRow(row), picked, 'GET이 다른 전략으로 되돌렸다');

    // 3) 화면의 첫 평가
    const first = strategyRunRequest({ ...ETH, strategyId: strategyIdOfRow(row) });
    eq(first.ok, true, first.message);
    eq(first.spec?.id, picked);
    eq(first.route, '/api/autotrade/my-original-v1');

    // 4) 서버의 주기 평가 — **같은 함수로 만든다**
    const periodic = strategyRunRequest({
      ...ETH, strategyId: strategyIdOfRow(row), strategyVersion: row.strategy_version,
      userId: 'u1',
    });
    eq(periodic.route, first.route, '첫 평가와 주기 평가가 다른 주소로 갔다');
    eq(periodic.spec?.id, picked);
  });

  test('옛 예약(전략 칸 없음)은 계단식으로 읽는다 — 되돌리는 곳은 한 곳뿐이다', () => {
    // 기본값을 정하는 것은 strategyIdOfRow 하나다. strategyRunRequest는
    // 빈 값을 받으면 **대신 골라 주지 않고 막는다** — 두 곳이 각자
    // 기본값을 가지면 어느 쪽이 이겼는지 알 수 없게 된다.
    eq(strategyIdOfRow({}), LEGACY_STRATEGY_ID);
    const r = strategyRunRequest({ ...ETH, strategyId: undefined });
    eq(r.ok, false, '빈 전략에 기본값을 대신 넣었다');
    eq(r.route, null);
  });

  test('첫 평가와 주기 평가의 본문이 같다 (크론만 싣는 값 제외)', () => {
    const common = { ...ETH, strategyId: 'my-original-v1', leverageCap: 100, marginPct: 10 };
    const first = strategyRunRequest(common);
    const periodic = strategyRunRequest({ ...common, userId: 'u1', idempotencyKey: 'k' });
    for (const k of ['symbol', 'connectionId', 'mode', 'intervalMin', 'leverageCap', 'marginPct']) {
      eq((periodic.body as any)[k], (first.body as any)[k], k);
    }
  });

  console.log('[전략 배선 — 주소를 화면이 짐작하지 않는다]');

  test('전략마다 주소가 다르다', () => {
    eq(strategyRunRequest({ ...ETH, strategyId: 'daily-ladder', intervalMin: 60 }).route,
      '/api/autotrade/daily-ladder');
    eq(strategyRunRequest({ ...ETH, strategyId: 'scalp' }).route, '/api/autotrade/scalp');
    eq(strategyRunRequest({ ...ETH, strategyId: 'my-original-v1' }).route,
      '/api/autotrade/my-original-v1');
  });

  test('모르는 전략은 주소를 만들지 않는다 — 부를 수가 없다', () => {
    const r = strategyRunRequest({ ...ETH, strategyId: 'made-up' });
    eq(r.ok, false); eq(r.route, null); eq(r.body, null);
  });

  test('기본 전략으로 대신 부르지 않는다', () => {
    // 모르는 전략을 계단식으로 대신 돌리면 사용자가 고르지 않은 전략이
    // 그 사람 계좌에서 돈다.
    eq(strategyRunRequest({ ...ETH, strategyId: 'made-up' }).route, null);
  });

  console.log('[전략 배선 — 점검 깃발이 전략마다 다르다]');

  test('점검 깃발을 부르는 쪽이 외우지 않는다', () => {
    // 틀리면 점검인 줄 알았던 호출이 진짜 주문을 낸다.
    const ladder = strategyRunRequest({ ...ETH, strategyId: 'daily-ladder', intervalMin: 60, checkOnly: true });
    eq((ladder.body as any).checkOnly, true);
    const mine = strategyRunRequest({ ...ETH, strategyId: 'my-original-v1', checkOnly: true });
    eq((mine.body as any).dryRun, true);
    assert((mine.body as any).checkOnly === undefined, '원본 v1은 checkOnly를 안 읽는다');
  });

  test('점검이 아니면 어떤 깃발도 실리지 않는다', () => {
    const b: any = strategyRunRequest({ ...ETH, strategyId: 'my-original-v1' }).body;
    assert(b.dryRun === undefined && b.checkOnly === undefined, JSON.stringify(b));
  });

  test('모든 전략이 점검 깃발 이름을 갖는다 — 새 전략을 넣을 때 여기서 걸린다', () => {
    for (const sp of STRATEGIES) {
      assert(sp.checkFlag === 'checkOnly' || sp.checkFlag === 'dryRun', `${sp.id}: ${sp.checkFlag}`);
    }
  });

  console.log('[전략 배선 — 실전은 계속 막힌다]');

  test('원본 v1은 실전에서 주소를 만들지 않는다', () => {
    const r = strategyRunRequest({
      ...ETH, env: 'LIVE', mode: 'LIVE_LIMITED', strategyId: 'my-original-v1',
    });
    eq(r.ok, false); eq(r.route, null);
    eq(resolveStrategy({ id: 'my-original-v1', env: 'LIVE' }).code, 'ENV_NOT_READY');
  });

  test('테스트넷에서는 열린다', () => {
    eq(strategyRunRequest({ ...ETH, strategyId: 'my-original-v1' }).ok, true);
  });

  test('원본 v1은 하루 주기를 받지 않는다 — 창을 매일 놓친다', () => {
    // 마지막 평가가 오후 2시였으면 다음도 다음 날 오후 2시가 되어
    // 09:10~09:30을 영원히 못 만난다.
    eq(strategyRunRequest({ ...ETH, strategyId: 'my-original-v1', intervalMin: 1440 }).ok, false);
    eq(strategyRunRequest({ ...ETH, strategyId: 'my-original-v1', intervalMin: 15 }).ok, true);
  });

  console.log('[전략 배선 — 없는 값을 0으로 보내지 않는다]');

  test('안 정한 값은 null로 눕혀 보낸다', () => {
    const b: any = strategyRunRequest({ ...ETH, strategyId: 'my-original-v1' }).body;
    // undefined면 JSON에서 사라지고, 받는 쪽이 0으로 읽으면 배율 상한 0이
    // 되어 주문이 통째로 막힌다.
    eq(b.leverageCap, null);
    eq(b.riskPct, null);
    eq(b.marginPct, null);
  });

  test('빈 문자열도 0이 아니라 null이다', () => {
    const b: any = strategyRunRequest({ ...ETH, strategyId: 'my-original-v1', leverageCap: '' }).body;
    eq(b.leverageCap, null);
  });

  test('userId는 크론이 부를 때만 실린다', () => {
    assert((strategyRunRequest({ ...ETH, strategyId: 'my-original-v1' }).body as any).userId === undefined);
    eq((strategyRunRequest({ ...ETH, strategyId: 'my-original-v1', userId: 'u1' }).body as any).userId, 'u1');
  });
}

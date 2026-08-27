// src/lib/engine/exitLifecycle.test.ts
//
// **순서가 곧 안전이다.**
//
//   1. 정말 열려 있는가       못 읽으면 UNKNOWN이고 손대지 않는다
//   2. 이 전략의 것이 맞는가   증명 못 하면 손대지 않는다
//   3. 정책이 있는가          없으면 다른 전략 값을 빌리지 않는다
//   4. 시간이 다 됐는가       옮기는 것이 아니라 닫는다
//   5. 손절을 옮길 것인가     좁히기만 한다
import { test, assert, eq, close } from '../../test/harness';
import { lifecycleDecide } from './exitLifecycle';
import { lifecyclePolicyOf } from '../strategies/lifecyclePolicy';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const OPEN = Date.parse('2026-08-27T11:00:00.000Z');   // 1시간 전

/** 진입 100 · 손절 90 → 1R = 10 */
function pos(o: any = {}) {
  return {
    connectionId: 'c1', exchange: 'binance' as const, symbol: 'BTCUSDT',
    strategyId: 'scalp', side: 'LONG' as const,
    entryPrice: 100, stopLoss: 90, openedAt: OPEN,
    ownedProtectionIds: ['sl-1'], orderId: 'ord-1',
    ownership: { code: 'OWNED' as const, reason: '', claimants: ['scalp'] },
    ...o,
  };
}
const SCALP = lifecyclePolicyOf('scalp');
const OPEN_OK = { ok: true, found: true };

export function runExitLifecycleTests() {
  console.log('\n♻️  포지션 생명주기 판단 (못 읽은 것을 flat으로 읽지 않는다)');

  // ══ ① 정말 열려 있는가 ══
  test('포지션 조회 실패를 flat으로 읽지 않는다', () => {
    const v = lifecycleDecide({ position: pos(), policy: SCALP,
      live: { ok: false, found: false }, highWaterR: 3, lastPrice: 130, liveStop: 90, nowMs: NOW });
    eq(v.code, 'POSITION_UNKNOWN', '못 읽었다');
    eq(v.action, 'NONE', '아무것도 하지 않는다');
    assert(!v.mayCleanProtection, '**보호주문을 고아로 보지 않는다**');
    assert(v.reason.includes('없다는 뜻이 아니'), '통과로 읽히면 안 된다');
  });

  test('조회 결과 자체가 없어도 flat이 아니다', () => {
    const v = lifecycleDecide({ position: pos(), policy: SCALP, live: null,
      highWaterR: 3, lastPrice: 130, liveStop: 90, nowMs: NOW });
    eq(v.code, 'POSITION_UNKNOWN', 'null도 모른다');
    assert(!v.mayCleanProtection, '치우지 않는다');
  });

  test('거래소가 포지션 0이라고 답했을 때만 고아 정리를 허용한다', () => {
    const v = lifecycleDecide({ position: pos(), policy: SCALP,
      live: { ok: true, found: false }, highWaterR: null, lastPrice: null, liveStop: null, nowMs: NOW });
    eq(v.code, 'FLAT', '확인했다');
    assert(v.mayCleanProtection, '이때만 치운다');
    eq(v.action, 'NONE', '닫을 것이 없다');
  });

  // ══ ② 소유권 ══
  test('같은 자리를 두 전략이 주장하면 주문을 내지 않는다', () => {
    const v = lifecycleDecide({
      position: pos({ ownership: { code: 'OWNERSHIP_AMBIGUOUS', reason: '두 전략이 주장합니다', claimants: ['scalp', 'my-original-v1'] } }),
      policy: SCALP, live: OPEN_OK, highWaterR: 3, lastPrice: 130, liveStop: 90, nowMs: NOW });
    eq(v.code, 'OWNERSHIP_AMBIGUOUS', '증명 못 했다');
    eq(v.action, 'NONE', '**남의 포지션을 건드리지 않는다**');
  });

  test('주인을 모르는 포지션도 손대지 않는다', () => {
    const v = lifecycleDecide({
      position: pos({ strategyId: null, ownership: { code: 'OWNER_UNKNOWN', reason: '표식이 없습니다', claimants: [] } }),
      policy: SCALP, live: OPEN_OK, highWaterR: 3, lastPrice: 130, liveStop: 90, nowMs: NOW });
    eq(v.action, 'NONE', '아무것도 하지 않는다');
  });

  // ══ ③ 정책이 없으면 빌리지 않는다 ══
  test('정책이 선언되지 않은 전략은 아무것도 하지 않는다 — 기본값을 빌리지 않는다', () => {
    const v = lifecycleDecide({ position: pos({ strategyId: 'some-new-strategy' }), policy: null,
      live: OPEN_OK, highWaterR: 5, lastPrice: 150, liveStop: 90, nowMs: NOW });
    eq(v.code, 'NO_POLICY', '정책이 없다');
    eq(v.action, 'NONE', '**5R이 나도 움직이지 않는다**');
    assert(v.reason.includes('빌려 쓰지 않습니다'), '이유를 적는다');
  });

  test('레지스트리에 없는 전략은 정책도 없다', () => {
    eq(lifecyclePolicyOf('made-up'), null, '없는 것은 null');
    eq(lifecyclePolicyOf(null), null, 'null');
    eq(lifecyclePolicyOf(''), null, '빈 문자열');
  });

  // ══ ④ 시간청산 ══
  test('scalp는 6시간을 넘기면 닫는다', () => {
    const v = lifecycleDecide({ position: pos({ openedAt: NOW - 7 * 3600_000 }), policy: SCALP,
      live: OPEN_OK, highWaterR: 0.2, lastPrice: 101, liveStop: 90, nowMs: NOW });
    eq(v.code, 'TIME_EXIT', '시간 초과');
    eq(v.action, 'CLOSE', '닫는다');
    assert(v.reason.includes('6시간'), '몇 시간인지 적는다');
  });

  test('시간이 안 됐으면 시간청산하지 않는다', () => {
    const v = lifecycleDecide({ position: pos({ openedAt: NOW - 5 * 3600_000 }), policy: SCALP,
      live: OPEN_OK, highWaterR: 0.2, lastPrice: 101, liveStop: 90, nowMs: NOW });
    assert(v.code !== 'TIME_EXIT', '아직이다');
  });

  test('my-original-v1은 24시간이다 — scalp 값을 쓰지 않는다', () => {
    const p = lifecyclePolicyOf('my-original-v1')!;
    eq(p.maxHoldMs, 24 * 3600_000, '하루 1회 전략');
    const v = lifecycleDecide({ position: pos({ strategyId: 'my-original-v1', openedAt: NOW - 7 * 3600_000 }),
      policy: p, live: OPEN_OK, highWaterR: 0.2, lastPrice: 101, liveStop: 90, nowMs: NOW });
    assert(v.code !== 'TIME_EXIT', '7시간은 아직이다 — scalp였다면 닫혔을 시점');
  });

  test('daily-ladder의 5일은 그대로다 — 이 PR이 바꾸지 않는다', () => {
    const p = lifecyclePolicyOf('daily-ladder')!;
    eq(p.maxHoldMs, 5 * 24 * 3600_000, '5일');
    eq(p.trailStartR, 2, '2R'); eq(p.trailDistanceR, 1, '1R'); eq(p.breakEvenR, 1, '1R');
    eq(p.source, 'STRATEGY_DECLARED', '원래 선언돼 있던 값');
  });

  // ══ ⑤ 본전이동 · 트레일링 ══
  test('scalp는 0.5R에서 본전으로 옮긴다 — 목표 2R보다 앞이다', () => {
    const v = lifecycleDecide({ position: pos(), policy: SCALP,
      live: OPEN_OK, highWaterR: 0.6, lastPrice: 106, liveStop: 90, nowMs: NOW });
    eq(v.code, 'MOVE_STOP', '옮긴다');
    eq(v.newStop, 100, '본전');
  });

  test('scalp는 1R에서 트레일링을 시작한다 — 2R이면 이미 익절이 닿는다', () => {
    eq(SCALP!.trailStartR, 1, '목표 2R보다 앞');
    const v = lifecycleDecide({ position: pos(), policy: SCALP,
      live: OPEN_OK, highWaterR: 1.5, lastPrice: 115, liveStop: 100, nowMs: NOW });
    eq(v.code, 'MOVE_STOP', '옮긴다');
    close(v.newStop!, 110, 1e-9, '최고 1.5R − 거리 0.5R = 1R = 110');
  });

  test('손절을 넓히지 않는다 — 좁히기만 한다', () => {
    const v = lifecycleDecide({ position: pos(), policy: SCALP,
      live: OPEN_OK, highWaterR: 1.2, lastPrice: 112, liveStop: 115, nowMs: NOW });
    eq(v.action, 'NONE', '이미 더 좁은 손절이 걸려 있다');
  });

  test('현재가가 이미 새 손절선을 지났으면 옮기는 것이 아니라 닫는다', () => {
    const v = lifecycleDecide({ position: pos(), policy: SCALP,
      live: OPEN_OK, highWaterR: 3, lastPrice: 104, liveStop: 100, nowMs: NOW });
    eq(v.code, 'TRAIL_CLOSE', '지나간 자리에 손절을 걸 수 없다');
    eq(v.action, 'CLOSE', '닫는다');
  });

  test('최고 R을 못 구하면 0으로 두지 않고 건너뛴다', () => {
    const v = lifecycleDecide({ position: pos(), policy: SCALP,
      live: OPEN_OK, highWaterR: null, lastPrice: 130, liveStop: 90, nowMs: NOW });
    eq(v.code, 'NO_HIGH_WATER', '모른다');
    eq(v.action, 'NONE', '0R로 두면 본전이동이 영원히 안 걸린다');
  });

  test('1R은 진입 손절로만 잰다 — 지금 걸린 손절로 재지 않는다', () => {
    // 손절이 이미 100(본전)으로 올라가 있어도 1R은 여전히 10이다.
    const v = lifecycleDecide({ position: pos(), policy: SCALP,
      live: OPEN_OK, highWaterR: 2, lastPrice: 120, liveStop: 100, nowMs: NOW });
    eq(v.code, 'MOVE_STOP', '옮긴다');
    close(v.newStop!, 115, 1e-9, '최고 2R − 0.5R = 1.5R = 115 (1R=10 기준)');
  });

  // ══ 숏 ══
  test('숏도 같은 규칙이다', () => {
    const v = lifecycleDecide({
      position: pos({ side: 'SHORT', entryPrice: 100, stopLoss: 110 }), policy: SCALP,
      live: OPEN_OK, highWaterR: 1.5, lastPrice: 85, liveStop: 100, nowMs: NOW });
    eq(v.code, 'MOVE_STOP', '옮긴다');
    close(v.newStop!, 90, 1e-9, '숏은 아래로 좁힌다');
  });

  // ══ 정책 값이 어디서 왔는지 ══
  test('검증용 값과 원래 선언된 값을 구분해 적는다', () => {
    eq(lifecyclePolicyOf('scalp')!.source, 'LIFECYCLE_TESTNET_V1', '새로 정한 값');
    eq(lifecyclePolicyOf('my-original-v1')!.source, 'LIFECYCLE_TESTNET_V1', '새로 정한 값');
    eq(lifecyclePolicyOf('daily-ladder')!.source, 'STRATEGY_DECLARED', '원래 있던 값');
    assert(lifecyclePolicyOf('scalp')!.note.includes('원본 진입 규칙과 무관'),
      '원본 규칙으로 기록되지 않게 적어 둔다');
  });

  test('my-original-v1의 본전 손절은 청산선 안쪽이다', () => {
    // 손절 0.4% · 청산 거리 0.6%. 본전(0R)은 진입가이므로 청산선에서
    // 0.6% 떨어져 있다 — 본전이동이 손절을 청산선에 붙이지 않는다.
    const p = lifecyclePolicyOf('my-original-v1')!;
    assert(p.breakEvenR! > 0, '본전이동을 한다');
    const v = lifecycleDecide({
      position: pos({ strategyId: 'my-original-v1', entryPrice: 100, stopLoss: 99.6 }),
      policy: p, live: OPEN_OK, highWaterR: 0.6, lastPrice: 100.3, liveStop: 99.6, nowMs: NOW });
    eq(v.code, 'MOVE_STOP', '옮긴다');
    eq(v.newStop, 100, '본전 — 진입가다. 청산선보다 0.6% 위');
  });
}

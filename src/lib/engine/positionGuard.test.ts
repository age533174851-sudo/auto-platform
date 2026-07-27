// src/lib/engine/positionGuard.test.ts
//
// 이 테스트의 가장 중요한 목적은 "방향으로 청산하지 않는다"를 고정하는 것이다.
// 전략은 다음 날 09:00까지 보유다. 가격이 반대로 갔다는 이유로 닫으면
// 그건 다른 전략이 된다.
import { test, assert, eq } from '../../test/harness';
import { checkPositionGuard, type PositionSnapshot } from './positionGuard';

const base = (over: Partial<PositionSnapshot> = {}): PositionSnapshot => ({
  symbol: 'BTCUSDT',
  side: 'LONG',
  entryPrice: 100_000,
  markPrice: 100_000,
  liquidationPrice: 99_500,     // 초기 거리 500 (0.5%)
  marginType: 'isolated',
  hasProtectiveStop: true,
  exchangeReachable: true,
  ...over,
});

export function runPositionGuardTests() {
  console.log('[포지션 보호 — 방향으로는 닫지 않는다]');

  test('이상 없으면 아무것도 하지 않는다', () => {
    const v = checkPositionGuard(base());
    eq(v.action, 'NONE');
    eq(v.faults.length, 0);
  });

  test('불리하게 움직였어도 청산가에서 멀면 닫지 않는다', () => {
    // 초기 거리 500 중 150 소진(30%) — 남은 70%
    const v = checkPositionGuard(base({ markPrice: 99_850 }));
    eq(v.action, 'NONE', '방향이 흔들렸다는 이유로 닫으려 한다: ' + v.reason);
  });

  test('유리하게 움직여도 아무 조치를 하지 않는다', () => {
    const v = checkPositionGuard(base({ markPrice: 103_000 }));
    eq(v.action, 'NONE');
  });

  console.log('[기술적 사고에는 반응한다]');

  test('청산가에 근접하면 닫는다', () => {
    // 초기 거리 500 중 350 소진 — 남은 30% (기본 임계 35% 이하)
    const v = checkPositionGuard(base({ markPrice: 99_650 }));
    eq(v.action, 'CLOSE');
    assert(v.faults.some(f => f.code === 'LIQUIDATION_PROXIMITY'), '청산 근접이 잡히지 않았다');
  });

  test('Mark Price가 청산가를 지났으면 닫는다', () => {
    const v = checkPositionGuard(base({ markPrice: 99_400 }));
    eq(v.action, 'CLOSE');
  });

  test('마진 모드가 Cross면 닫는다', () => {
    const v = checkPositionGuard(base({ marginType: 'cross' }));
    eq(v.action, 'CLOSE');
    assert(v.faults.some(f => f.code === 'MARGIN_MODE_CHANGED'), 'Cross 감지 실패');
  });

  test('보호주문이 사라지면 닫는다', () => {
    const v = checkPositionGuard(base({ hasProtectiveStop: false }));
    eq(v.action, 'CLOSE');
    assert(v.faults.some(f => f.code === 'PROTECTIVE_ORDER_LOST'), '보호주문 소실 감지 실패');
  });

  test('보호주문 소실을 알림만으로 낮출 수 있다', () => {
    const v = checkPositionGuard(base({ hasProtectiveStop: false }), { closeOnMissingStop: false });
    eq(v.action, 'ALERT', '설정을 무시하고 청산하려 한다');
  });

  test('거래소 연결이 끊기면 알림만 — 주문이 나가지 않으므로', () => {
    const v = checkPositionGuard(base({ exchangeReachable: false }));
    eq(v.action, 'ALERT', '연결이 끊겼는데 청산을 시도하려 한다');
    assert(v.reason.includes('수동'), '수동 확인 안내가 없다');
  });

  test('Mark Price 급변은 경고로만 잡는다', () => {
    const v = checkPositionGuard(base({ recentMarks: [100_000, 100_200, 102_000] }));
    assert(v.faults.some(f => f.code === 'MARK_PRICE_SHOCK'), '급변이 감지되지 않았다');
    eq(v.action, 'ALERT', '급변만으로 청산하려 한다 — 방향 판단과 구분되지 않는다');
  });

  console.log('[SHORT 방향]');

  test('SHORT은 위로 갈 때 청산에 가까워진다', () => {
    const short = base({ side: 'SHORT', liquidationPrice: 100_500, markPrice: 100_350 });
    const v = checkPositionGuard(short);
    eq(v.action, 'CLOSE', 'SHORT 청산 근접이 잡히지 않았다');
  });

  test('SHORT이 유리하게(아래로) 가면 조치하지 않는다', () => {
    const short = base({ side: 'SHORT', liquidationPrice: 100_500, markPrice: 97_000 });
    eq(checkPositionGuard(short).action, 'NONE');
  });
}

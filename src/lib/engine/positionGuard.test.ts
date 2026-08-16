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
  console.log('[사고 점검 — 모르는 것을 사고로 읽지 않는다]');

  test('지금 가격을 못 읽으면 청산가 도달로 읽지 않는다', () => {
    // **여기가 위험했다.** 예전에는 호출부가 못 읽은 값을 0으로 넘겼고,
    // LONG에서 `0 - 청산가`는 음수라 "청산가를 지났습니다" → CLOSE가 됐다.
    // Gate는 포지션 응답에 mark price가 없어서 이 경로가 실제로 열려 있었다.
    const v = checkPositionGuard(base({ markPrice: null }));
    assert(v.action !== 'CLOSE', `모르는 가격으로 포지션을 닫았다 — ${v.reason}`);
    assert(v.faults.some(f => f.code === 'MARK_PRICE_UNKNOWN'), '못 읽었다는 사실이 안 남았다');
    // 경고이지 청산 사유가 아니다.
    eq(v.faults.find(f => f.code === 'MARK_PRICE_UNKNOWN')!.severity, 'warn');
  });

  test('0·NaN도 "모른다"로 읽는다 — 청산가 도달이 아니다', () => {
    for (const bad of [0, NaN, -1] as any[]) {
      const v = checkPositionGuard(base({ markPrice: bad }));
      assert(v.action !== 'CLOSE', `markPrice=${bad}로 포지션을 닫았다`);
    }
  });

  test('가격을 못 읽어도 다른 사고는 그대로 잡는다', () => {
    // 손절이 사라진 것은 가격과 무관한 사실이다 — 같이 묻히면 안 된다.
    const v = checkPositionGuard(base({ markPrice: null, hasProtectiveStop: false }));
    assert(v.faults.some(f => f.code === 'PROTECTIVE_ORDER_LOST'), v.faults.map(f => f.code).join(','));
  });

  test('가격을 읽었으면 예전과 똑같이 판정한다', () => {
    // 이 변경이 기존 동작을 느슨하게 만들지 않았는지 못 박는다.
    const v = checkPositionGuard(base({ markPrice: 99_400 }));
    eq(v.action, 'CLOSE');
  });

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

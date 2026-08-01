// src/lib/engine/trailPlan.test.ts
//
// 이 코드는 **실제 돈이 걸린 손절 주문을 옮긴다.** 그런데 지금까지
// 테스트가 하나도 없었다.
//
// 여기서 틀리면 셋 다 화면에는 '손절 이동됨'으로 똑같이 보인다:
//   · 손절이 진입가에서 멀어진다 → 손실 한도가 조용히 넓어진다
//   · 이미 지나간 가격으로 옮긴다 → 거래소가 거부하거나 즉시 체결된다
//   · '좁히기만' 규칙이 깨진다 → 이익을 반납하고도 손절이 그대로 남는다

import { test, eq, assert } from '../../test/harness';
import { planTrail, readTrailConfig, DEFAULT_TRAIL } from './trailPlan';

// LONG: 진입 100, **진입 시점** 손절 90 → 1R = 10 (영원히)
const long = (highWaterR: number | null, lastPrice: number | null, stop = 90) => planTrail({
  side: 'LONG', entryPrice: 100, initialStop: 90, currentStop: stop, highWaterR, lastPrice,
});
// SHORT: 진입 100, 진입 시점 손절 110 → 1R = 10
const short = (highWaterR: number | null, lastPrice: number | null, stop = 110) => planTrail({
  side: 'SHORT', entryPrice: 100, initialStop: 110, currentStop: stop, highWaterR, lastPrice,
});

export function runTrailPlanTests() {
  console.log('[트레일링 — 본전 이동]');

  test('1R에 닿으면 손절을 진입가로 올린다 (LONG)', () => {
    const v = long(1, 108);
    eq(v.action, 'MOVE_STOP');
    eq(v.newStop, 100);
    assert(v.reason.includes('본전'), v.reason);
  });

  test('SHORT은 손절을 진입가로 **내린다** — 부호를 뒤집으면 한도가 넓어진다', () => {
    const v = short(1, 92);
    eq(v.action, 'MOVE_STOP');
    eq(v.newStop, 100);
  });

  test('1R 미만이면 아무것도 하지 않는다', () => {
    eq(long(0.9, 108).action, 'NONE');
  });

  console.log('[트레일링 — 최고점 추종]');

  test('2R을 넘으면 (최고 − 1R) 자리로 옮긴다 (LONG)', () => {
    // 최고 3R → 손절을 2R 자리(=120)로
    const v = long(3, 128);
    eq(v.action, 'MOVE_STOP');
    eq(v.newStop, 120);
    assert(v.reason.includes('트레일링'), v.reason);
  });

  test('SHORT은 아래쪽으로 따라간다', () => {
    // 최고 3R → 손절을 2R 자리(=80)로
    const v = short(3, 72);
    eq(v.action, 'MOVE_STOP');
    eq(v.newStop, 80);
  });

  test('2R 직전에는 본전까지만', () => {
    const v = long(1.9, 118);
    eq(v.newStop, 100, '트레일링이 아직 시작되면 안 된다');
  });

  console.log('[트레일링 — 좁히기만 한다]');

  test('이미 더 좋은 손절이 걸려 있으면 되돌리지 않는다 (LONG)', () => {
    // 손절이 이미 115인데 최고 3R이면 트레일 자리는 120 → 개선이므로 이동
    eq(long(3, 128, 115).newStop, 120);
    // 손절이 이미 125면 트레일 자리 120은 **후퇴**다 → 하지 않는다
    eq(long(3, 128, 125).action, 'NONE');
  });

  test('SHORT도 마찬가지 — 더 낮은 손절을 위로 되돌리지 않는다', () => {
    eq(short(3, 72, 75).action, 'NONE', '75에서 80으로 올리면 한도가 넓어진다');
  });

  test('본전 이동도 후퇴하지 않는다', () => {
    // 손절이 이미 105(진입가보다 유리)인데 1R이면 본전(100)은 후퇴다
    eq(long(1, 108, 105).action, 'NONE');
  });

  test('손절이 움직여도 1R은 그대로다 — 여기가 예전 버그의 자리다', () => {
    // 진입 100, 진입 손절 90 (1R=10). 손절이 이미 120까지 올라간 상태에서
    // 최고 4R이면 트레일 자리는 100 + 10*3 = 130이어야 한다.
    // 예전처럼 현재 손절(120)로 1R을 다시 재면 1R=20이 되어 트레일 자리가
    // 100 + 20*3 = 160으로 튄다 — 현재가보다 위라 즉시 청산이 된다.
    const v = planTrail({
      side: 'LONG', entryPrice: 100, initialStop: 90, currentStop: 120,
      highWaterR: 4, lastPrice: 138,
    });
    eq(v.action, 'MOVE_STOP');
    eq(v.newStop, 130);
  });

  console.log('[트레일링 — 이미 지나간 자리]');

  test('현재가가 새 손절선을 지났으면 옮기지 않고 닫는다', () => {
    // 최고 3R까지 갔다가 118로 되돌아옴. 새 손절은 120 → 이미 지났다
    const v = long(3, 118);
    eq(v.action, 'CLOSE');
    eq(v.newStop, undefined, '닫는 결정에 손절가를 실으면 호출자가 헷갈린다');
    assert(v.reason.includes('즉시 청산'), v.reason);
  });

  test('SHORT도 같다', () => {
    const v = short(3, 82);   // 새 손절 80을 이미 지났다
    eq(v.action, 'CLOSE');
  });

  console.log('[트레일링 — 모르는 것은 건드리지 않는다]');

  test('최고 R을 모르면 아무것도 하지 않는다 — 0으로 치면 본전 이동이 영원히 안 걸린다', () => {
    const v = long(null, 108);
    eq(v.action, 'NONE');
    assert(v.reason.includes('건너뜁'), v.reason);
  });

  test('현재가를 모르면 옮기지 않는다 — 지나갔는지 판단할 수 없다', () => {
    const v = long(3, null);
    eq(v.action, 'NONE');
  });

  test('진입가·손절가가 이상하면 아무것도 하지 않는다', () => {
    eq(planTrail({ side: 'LONG', entryPrice: 0, initialStop: 90, currentStop: 90, highWaterR: 3, lastPrice: 128 }).action, 'NONE');
    eq(planTrail({ side: 'LONG', entryPrice: 100, initialStop: 90, currentStop: 0, highWaterR: 3, lastPrice: 128 }).action, 'NONE');
    eq(planTrail({ side: 'LONG', entryPrice: 100, initialStop: 100, currentStop: 100, highWaterR: 3, lastPrice: 128 }).action, 'NONE');
  });

  console.log('[트레일링 — 끄기]');

  test('둘 다 끄면 아무것도 하지 않는다', () => {
    const v = planTrail({
      side: 'LONG', entryPrice: 100, initialStop: 90, currentStop: 90, highWaterR: 5, lastPrice: 150,
      cfg: { useBreakEven: false, useTrailing: false },
    });
    eq(v.action, 'NONE');
  });

  test('본전만 켜면 트레일링은 안 한다', () => {
    const v = planTrail({
      side: 'LONG', entryPrice: 100, initialStop: 90, currentStop: 90, highWaterR: 5, lastPrice: 150,
      cfg: { useBreakEven: true, useTrailing: false },
    });
    eq(v.newStop, 100);
  });

  console.log('[트레일링 — 설정 읽기]');

  const envOf = (o: Record<string, string>) => (k: string) => o[k];

  test('기본값', () => {
    const { cfg } = readTrailConfig(envOf({}));
    eq(cfg.trailStartR, DEFAULT_TRAIL.trailStartR);
    eq(cfg.useTrailing, true);
  });

  test("TRAILING_STOP=off면 둘 다 끈다", () => {
    for (const v of ['off', 'false', '0', 'OFF']) {
      const { cfg } = readTrailConfig(envOf({ TRAILING_STOP: v }));
      eq(cfg.useTrailing, false, `${v}가 안 먹었다`);
      eq(cfg.useBreakEven, false);
    }
  });

  test('R 값을 바꿀 수 있다', () => {
    const { cfg } = readTrailConfig(envOf({ TRAIL_START_R: '3', TRAIL_DISTANCE_R: '1.5' }));
    eq(cfg.trailStartR, 3);
    eq(cfg.trailDistanceR, 1.5);
  });

  test('이상한 값은 기본값을 쓰되 그 사실을 남긴다', () => {
    const r = readTrailConfig(envOf({ TRAIL_START_R: 'abc' }));
    eq(r.cfg.trailStartR, DEFAULT_TRAIL.trailStartR);
    assert(r.note.includes('TRAIL_START_R'), `오타를 알려야 한다: ${r.note}`);
  });
}

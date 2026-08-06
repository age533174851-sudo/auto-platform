// src/lib/engine/shortGuard.test.ts
//
// 막으려는 것:
//  1. 숏의 손절을 진입가 아래에 거는 것 — 롱 코드를 부호만 바꿔 쓸 때 난다.
//     화면에는 '손절 설정됨'으로 뜨는데 실제로는 익절 자리다
//  2. 청산가가 손절보다 가까운데 진입하는 것 — 그 손절은 장식이고,
//     사용자는 "손절 1%"라고 믿는 채로 계좌가 날아간다
//  3. 펀딩 부호를 뒤집어, 숏이 **받는** 자리를 위험하다고 적는 것
//  4. 전부 막아서 사용자가 안전장치를 통째로 끄게 만드는 것
import { test, assert, eq, close } from '../../test/harness';
import { shortGuard, shortExitPrices } from './shortGuard';

const BASE = {
  entryPrice: 64000,
  stopPrice: 64640,          // 진입가 +1%
  liquidationPrice: 70000,   // 손절보다 멀다
};

export function runShortGuardTests() {
  console.log('[숏 — 손절과 익절의 방향]');

  test('숏 손절은 위, 익절은 아래다', () => {
    // 롱 코드를 부호만 바꿔 쓰면 여기가 뒤집힌다. 그러면 손절이
    // 익절 자리에 걸리고 화면에는 둘 다 '설정됨'으로 뜬다.
    const r = shortExitPrices(64000, 1, 2);
    close(r.stop as number, 64640, 1e-6, '손절은 진입가 위');
    close(r.take as number, 62720, 1e-6, '익절은 진입가 아래');
    assert((r.stop as number) > 64000 && (r.take as number) < 64000);
  });

  test('익절을 안 주면 null이다 — 0이 아니다', () => {
    const r = shortExitPrices(64000, 1, null);
    eq(r.take, null, '0이면 0원에 익절이 된다');
    assert(r.stop != null);
  });

  test('손절 폭이 없으면 만들지 않는다', () => {
    eq(shortExitPrices(64000, 0).stop, null);
    eq(shortExitPrices(0, 1).stop, null);
  });

  console.log('[숏 — 청산이 손절보다 먼저 오는가]');

  test('청산가가 손절보다 가까우면 막는다', () => {
    // 그 손절은 걸려 있을 뿐 아무것도 지키지 않는다. 사용자는
    // "손절 1%"라고 믿는데 실제로는 계좌가 통째로 날아간다.
    const r = shortGuard({ ...BASE, liquidationPrice: 64500 });
    eq(r.allowed, false);
    assert(r.summary.includes('청산가'), r.summary);
    assert(r.summary.includes('배율을 낮추거나'), '무엇을 바꿔야 하는지 적어야 한다');
  });

  test('여유가 손절 폭의 20% 미만이어도 막는다', () => {
    // 슬리피지 한 번이면 순서가 뒤집힌다.
    // 손절 폭 640, 청산 여유 100 → 15.6%
    const r = shortGuard({ ...BASE, liquidationPrice: 64740 });
    eq(r.allowed, false);
    assert(r.summary.includes('슬리피지'), r.summary);
  });

  test('여유가 충분하면 통과한다', () => {
    eq(shortGuard(BASE).allowed, true, shortGuard(BASE).summary);
  });

  test('숏 손절이 진입가 아래면 막는다', () => {
    // 롱 코드를 그대로 쓴 모양이다.
    const r = shortGuard({ ...BASE, stopPrice: 63360 });
    eq(r.allowed, false);
    assert(r.summary.includes('위에 있어야'), r.summary);
  });

  test('청산가를 모르면 그 검사만 건너뛴다', () => {
    // 못 읽었다고 진입을 막지는 않는다 — 다른 검사는 여전히 돈다.
    eq(shortGuard({ ...BASE, liquidationPrice: null }).allowed, true);
  });

  test('진입가가 없으면 아무것도 계산하지 않는다', () => {
    const r = shortGuard({ entryPrice: 0, stopPrice: 100 });
    eq(r.allowed, false);
  });

  console.log('[숏 — 펀딩 부호를 뒤집지 않는다]');

  test('양수 펀딩은 숏이 받는다 — 경고하지 않는다', () => {
    // 부호를 뒤집으면 유리한 자리를 위험하다고 적게 된다.
    const r = shortGuard({ ...BASE, fundingRatePct8h: 0.01 });
    eq(r.findings.filter(f => f.code === 'FUNDING_COST').length, 0);
    eq(r.allowed, true);
  });

  test('음수 펀딩일 때만 숏이 낸다', () => {
    const r = shortGuard({ ...BASE, fundingRatePct8h: -0.01 });
    assert(r.findings.some(f => f.code === 'FUNDING_COST'));
    eq(r.allowed, true, '비용은 막을 일이 아니라 적을 일이다');
  });

  test('크게 음수면 숏이 몰려 있다는 뜻이다', () => {
    // 몰린 쪽이 스퀴즈로 터진다 — 펀딩 비용보다 이쪽이 더 위험하다.
    const r = shortGuard({ ...BASE, fundingRatePct8h: -0.08 });
    assert(r.findings.some(f => f.code === 'CROWDED_SHORT'));
    assert(r.findings.find(f => f.code === 'CROWDED_SHORT')!.reason.includes('연쇄'));
  });

  console.log('[숏 — 급락 추격과 지지선]');

  test('최근 고점에서 크게 빠진 자리는 적어 둔다', () => {
    const r = shortGuard({
      ...BASE, atr: 200,
      recentHighs: [65000, 65200, 65100],   // 고점 65200, 진입 64000 → 1200 = 6 ATR
    });
    assert(r.findings.some(f => f.code === 'CHASING_DROP'));
    assert(r.findings.find(f => f.code === 'CHASING_DROP')!.reason.includes('반등'));
    eq(r.allowed, true, '막지는 않는다');
  });

  test('조금 빠진 자리는 경고하지 않는다', () => {
    const r = shortGuard({ ...BASE, atr: 500, recentHighs: [64100, 64200, 64150] });
    eq(r.findings.filter(f => f.code === 'CHASING_DROP').length, 0);
  });

  test('ATR을 모르면 급락 판정을 건너뛴다', () => {
    // 없는 데이터로 판정하지 않는다.
    const r = shortGuard({ ...BASE, atr: null, recentHighs: [70000, 70000, 70000] });
    eq(r.findings.filter(f => f.code === 'CHASING_DROP').length, 0);
  });

  test('바로 아래가 지지선이면 손익비를 적는다', () => {
    // 손절 폭 640, 지지선까지 300 → 손익비 0.47
    const r = shortGuard({ ...BASE, recentLows: [63700, 63800, 63750] });
    assert(r.findings.some(f => f.code === 'SUPPORT_BELOW'));
    assert(r.findings.find(f => f.code === 'SUPPORT_BELOW')!.reason.includes('손익비'));
  });

  test('지지선이 멀면 경고하지 않는다', () => {
    const r = shortGuard({ ...BASE, recentLows: [61000, 61500, 61200] });
    eq(r.findings.filter(f => f.code === 'SUPPORT_BELOW').length, 0);
  });

  test('봉이 모자라면 그 검사를 건너뛴다', () => {
    const r = shortGuard({ ...BASE, recentLows: [63900], recentHighs: [64100], atr: 100 });
    eq(r.findings.length, 0);
  });

  console.log('[숏 — 상위 시간봉]');

  test('상승 추세에서는 숏을 막는다', () => {
    // 신호의 질 문제가 아니라 방향 자체가 반대인 자리다.
    const r = shortGuard({ ...BASE, higherTrend: 'UP' });
    eq(r.allowed, false);
    assert(r.summary.includes('거슬러'), r.summary);
  });

  test('하락·횡보에서는 막지 않는다', () => {
    eq(shortGuard({ ...BASE, higherTrend: 'DOWN' }).allowed, true);
    eq(shortGuard({ ...BASE, higherTrend: 'RANGE' }).allowed, true);
  });

  test('추세를 모르면 막지 않는다', () => {
    // 못 읽었다고 막으면 상위 시간봉 조회가 흔들릴 때마다 숏이 멈춘다.
    eq(shortGuard({ ...BASE, higherTrend: null }).allowed, true);
  });

  console.log('[숏 — 막는 것과 알리는 것을 구분한다]');

  test('경고만 있으면 통과하되 요약에 적는다', () => {
    const r = shortGuard({
      ...BASE, fundingRatePct8h: -0.02, atr: 200, recentHighs: [66000, 66100, 66050],
    });
    eq(r.allowed, true);
    assert(r.findings.length >= 2);
    assert(r.summary.includes('주의'), r.summary);
  });

  test('막는 사유가 있으면 그것이 요약에 온다', () => {
    const r = shortGuard({
      ...BASE, liquidationPrice: 64100, fundingRatePct8h: -0.02,
    });
    eq(r.allowed, false);
    assert(r.summary.includes('청산가'), '경고가 아니라 막는 사유가 먼저다');
  });

  test('아무 문제 없으면 조용하다', () => {
    // 늘 경고가 뜨면 아무도 안 읽는다.
    const r = shortGuard(BASE);
    eq(r.findings.length, 0);
    eq(r.summary, '숏 진입 검사 통과');
  });
}

// src/lib/markets/priceBasis.test.ts
//
// 막으려는 것:
//  1. **마크가 자리에 체결가를 넣고 '마크가'라고 적는 것.** 청산 거리가
//     그렇게 계산되면 사용자는 틀린 숫자를 믿고 포지션 크기를 정한다
//  2. 못 구한 가격을 조용히 다른 값으로 메우는 것
//  3. 둘이 벌어졌는데 화면이 아무 말도 안 하는 것 — 차트의 선과 거래소가
//     보는 선이 다른 구간이다
import { test, assert, eq, close } from '../../test/harness';
import {
  basisFor, priceFor, basisGap, basisTag, LABEL, DIVERGENCE_WARN_PCT,
} from './priceBasis';

export function runPriceBasisTests() {
  console.log('[가격 기준 — 항목마다 다르다]');

  test('청산과 손익은 언제나 마크가다', () => {
    // 체결가로는 청산되지 않는다. 예외 없다.
    eq(basisFor('LIQUIDATION'), 'MARK');
    eq(basisFor('PNL'), 'MARK');
    eq(basisFor('LIQUIDATION', 'CONTRACT_PRICE'), 'MARK', 'workingType이 뒤집지 못한다');
  });

  test('내 체결은 체결가다', () => {
    eq(basisFor('EXECUTION'), 'LAST');
  });

  test('손절 발동은 주문이 정한다', () => {
    eq(basisFor('TRIGGER'), 'MARK', '안 주면 마크가 — 이 저장소가 거는 기본값이다');
    eq(basisFor('TRIGGER', 'MARK_PRICE'), 'MARK');
    eq(basisFor('TRIGGER', 'CONTRACT_PRICE'), 'LAST', '바이낸스의 체결가 기준 이름이다');
    eq(basisFor('TRIGGER', 'last_price'), 'LAST');
  });

  console.log('[가격 기준 — 조용히 메우지 않는다]');

  test('마크가가 없으면 청산 거리를 계산하지 않는다', () => {
    const p = priceFor('LIQUIDATION', { last: 64000, mark: null });
    eq(p.price, null, '체결가가 옆에 있어도 쓰지 않는다');
    eq(p.kind, null);
    eq(p.substituted, false);
    assert(p.reason.includes('대신 계산하지 않습니다'), p.reason);
  });

  test('대체는 허락받아야 하고, 허락해도 표시가 남는다', () => {
    const p = priceFor('LIQUIDATION', { last: 64000, mark: null }, { allowSubstitute: true });
    eq(p.price, 64000);
    eq(p.kind, 'LAST');
    eq(p.wanted, 'MARK');
    eq(p.substituted, true);
    assert(p.reason.includes('실제 판정 기준과 다릅니다'), p.reason);
    eq(basisTag(p), '체결가(대체)', '대체는 언제나 적는다');
  });

  test('대체는 가까운 값부터 — 마크가 대신 지수가가 체결가보다 낫다', () => {
    const p = priceFor('LIQUIDATION', { last: 64000, mark: null, index: 63990 },
      { allowSubstitute: true });
    eq(p.kind, 'INDEX');
  });

  test('하나도 없으면 없다고 말한다', () => {
    const p = priceFor('PNL', {}, { allowSubstitute: true });
    eq(p.price, null);
    assert(p.reason.includes('하나도'), p.reason);
    eq(basisTag(p), '확인 불가');
  });

  test('0과 음수는 가격이 아니다', () => {
    // 0을 그대로 쓰면 청산 거리가 100%가 되거나 0으로 나눈다.
    eq(priceFor('EXECUTION', { last: 0, mark: 64000 }).price, null);
    eq(priceFor('EXECUTION', { last: -1, mark: 64000 }).price, null);
    eq(priceFor('EXECUTION', { last: '' as any }).price, null);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(priceFor('PNL', null).price, null);
    eq(basisGap(null).pct, null);
  });

  console.log('[가격 기준 — 벌어지면 말한다]');

  test('평소 차이에는 아무 말도 안 한다', () => {
    // 매번 '체결가'라고 적으면 정작 벌어졌을 때의 경고가 묻힌다.
    const g = basisGap({ last: 64000, mark: 64005 });
    eq(g.diverged, false);
    eq(g.text, '');
    close(g.pct!, 0.0078, 1e-3);
  });

  test('벌어지면 무엇으로 판정되는지 같이 적는다', () => {
    const g = basisGap({ last: 64000, mark: 63500 });
    eq(g.diverged, true);
    assert(g.text.includes('0.79%'), g.text);
    assert(g.text.includes(LABEL.MARK), g.text);
  });

  test('경고선은 양쪽 다 본다', () => {
    // 마크가가 위에 있든 아래에 있든 화면의 숫자는 똑같이 틀린다.
    //
    // 분모는 마크가다 — 판정하는 쪽이 그것이라서 그렇다. 그래서 같은
    // 절대 차이여도 위아래 백분율이 미세하게 다르다. 경고선 바로 위를
    // 겨냥하면 그 비대칭에 걸리므로, 여기서는 넉넉히 벌려 놓고 **양쪽
    // 다 걸리는지**만 본다.
    const up = basisGap({ last: 64000, mark: 64000 * 1.005 });
    const down = basisGap({ last: 64000, mark: 64000 * 0.995 });
    eq(up.diverged, true);
    eq(down.diverged, true);
    assert(up.pct! > 0 && down.pct! < 0, '부호를 남긴다 — 어느 쪽이 앞서는지가 보인다');

    // 경고선 자체도 확인한다. 분모가 마크가이므로 마크가에서 역산한다.
    const exact = basisGap({ mark: 64000, last: 64000 * (1 - DIVERGENCE_WARN_PCT / 100) });
    close(exact.pct!, DIVERGENCE_WARN_PCT, 1e-9);
    eq(exact.diverged, true, '선 위는 포함이다');
  });

  test('벌어졌을 때만 꼬리표가 붙는다', () => {
    const p = priceFor('LIQUIDATION', { last: 64000, mark: 63500 });
    eq(basisTag(p, { last: 64000, mark: 63500 }), '마크가');
    eq(basisTag(p, { last: 64000, mark: 64005 }), '', '평소에는 글자를 안 늘린다');
    eq(basisTag(p, { last: 64000, mark: 64005 }, true), '마크가', '진단 화면은 언제나 적는다');
  });
}

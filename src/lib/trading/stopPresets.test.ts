// src/lib/trading/stopPresets.test.ts
import { test, eq, assert } from '../../test/harness';
import {
  STOP_PCTS, isValidStopPct, previewStopPrice, stopChoiceOf, stopRequestFields,
} from './stopPresets';

export function runStopPresetTests() {
  test('기존 주문폼의 손절 프리셋을 그대로 가져왔다', () => {
    eq(STOP_PCTS.join(','), '1,2,3,5,10');
  });

  // ── ★ 방향 ──
  test('★ 롱은 아래, 숏은 위에 손절이 선다', () => {
    eq(previewStopPrice(100, 'LONG', 2), 98);
    eq(previewStopPrice(100, 'SHORT', 2), 102);
  });

  test('★ 방향을 모르면 손절가를 만들지 않는다', () => {
    eq(previewStopPrice(100, '', 2), null);
    eq(previewStopPrice(100, null, 2), null);
    eq(previewStopPrice(100, 'BUY', 2), null);
  });

  test('시세를 모르면 손절가도 없다 — 0으로 적지 않는다', () => {
    for (const p of [null, undefined, '', 0, -1, 'x']) {
      eq(previewStopPrice(p, 'LONG', 2), null, `${String(p)}이 가격으로 읽혔습니다`);
    }
  });

  test('0%와 100% 이상은 손절이 아니다', () => {
    eq(isValidStopPct(0), false);
    eq(isValidStopPct(100), false);
    eq(isValidStopPct(150), false);
    eq(isValidStopPct(-1), false);
    eq(isValidStopPct(null), false);
    eq(isValidStopPct(''), false);
    eq(isValidStopPct(0.5), true);
    eq(isValidStopPct(10), true);
  });

  // ── ★ 둘 중 하나만 나간다 ──
  test('★ 직접 입력이 프리셋을 이긴다 — 보이는 값과 나가는 값이 같아야 한다', () => {
    const c = stopChoiceOf(5, '64000');
    eq(c.kind, 'PRICE');
    eq((c as any).price, 64000);
    eq(JSON.stringify(stopRequestFields(c)), JSON.stringify({ stopPrice: 64000 }));
  });

  test('★ 프리셋은 퍼센트로 나간다 — 화면이 손절가를 정하지 않는다', () => {
    const c = stopChoiceOf(3, '');
    eq(c.kind, 'PCT');
    const f = stopRequestFields(c);
    eq(JSON.stringify(f), JSON.stringify({ stopLossPct: 3 }));
    assert(!('stopPrice' in f), '프리셋이 가격을 직접 보냅니다');
  });

  test('손절이 없으면 칸을 아예 만들지 않는다', () => {
    eq(JSON.stringify(stopRequestFields(stopChoiceOf(null, ''))), '{}');
    eq(JSON.stringify(stopRequestFields(stopChoiceOf(0, '0'))), '{}');
  });

  test('이상한 직접 입력은 프리셋으로 되돌아간다', () => {
    eq(stopChoiceOf(2, 'abc').kind, 'PCT');
    eq(stopChoiceOf(2, '-5').kind, 'PCT');
  });
}

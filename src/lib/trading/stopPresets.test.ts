// src/lib/trading/stopPresets.test.ts
import { test, eq, assert } from '../../test/harness';
import {
  STOP_PCTS, isValidStopPct, previewStopPrice, stopChoiceOf, stopRequestFields,
} from './stopPresets';
import { tpslEditBody, readTpslEditValue } from './tpslEdit';

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

  // ── 열린 모의 포지션의 손절·익절 수정 (`/api/paper/modify`) ──
  //
  // 실제로 나던 일: 손절 칸에 `65,000`을 치면 `Number()`가 NaN을 내고,
  // `JSON.stringify`가 NaN을 **null**로 바꿔 보낸다. 서버에서 null은
  // '지우기'다 — **걸려 있던 손절이 사라지고 화면은 "저장했습니다"**였다.
  test('★ 숫자로 못 읽는 손절 입력은 보내지 않는다 — null(지우기)로 바뀌지 않는다', () => {
    for (const raw of ['65,000', 'abc', '0', '-5', '1e999', 'NaN']) {
      const r = tpslEditBody('pos-1', raw, '');
      eq(r.ok, false, `${raw}가 본문으로 나갔습니다`);
    }
    // 익절이 멀쩡해도 손절이 이상하면 **둘 다 안 보낸다** — 반만 저장하고
    // "저장했습니다"를 띄우면 사용자는 손절도 걸렸다고 읽는다.
    eq(tpslEditBody('pos-1', '65,000', '70000').ok, false);
    eq(tpslEditBody('pos-1', '60000', 'x').ok, false);
  });

  test('★ 실패 사유는 어느 칸의 어떤 값인지 적는다', () => {
    const r = tpslEditBody('pos-1', '65,000', '');
    assert(!r.ok && r.body === null && r.message.includes('손절') && r.message.includes('65,000'),
      '사유에 칸 이름·입력값이 없습니다');
  });

  test('빈 칸은 보내지 않는다(그대로) · 둘 다 비면 보낼 것이 없다', () => {
    const r = tpslEditBody('pos-1', '  ', '70000');
    assert(r.ok, '익절만 보낼 수 있어야 합니다');
    if (r.ok && r.body) {
      eq('stopLoss' in r.body, false);
      eq(r.body.takeProfit, 70000);
      eq(r.body.positionId, 'pos-1');
    }
    eq(tpslEditBody('pos-1', '', '').ok, false);
  });

  test('본문은 JSON을 지나도 같은 값이다 — NaN·null이 섞이지 않는다', () => {
    const r = tpslEditBody('pos-1', ' 60000.5 ', '70000');
    assert(r.ok, '정상 입력이 거부됐습니다');
    if (r.ok && r.body) {
      const back = JSON.parse(JSON.stringify(r.body));
      eq(back.stopLoss, 60000.5);
      eq(back.takeProfit, 70000);
    }
  });

  test('★ 서버: 이상한 값은 무시(그대로)가 아니라 거부다', () => {
    // 예전에는 음수·0·문자가 조용히 '그대로'가 되어, 같이 온 다른 칸만
    // 저장되고 "저장했습니다"가 나갔다.
    for (const v of [0, -1, 'abc', '65,000', true, false, NaN, Infinity, {}, []]) {
      eq(readTpslEditValue(v).kind, 'INVALID', `${String(v)}이 거부되지 않았습니다`);
    }
    eq(readTpslEditValue(undefined).kind, 'KEEP');
    eq(readTpslEditValue(null).kind, 'CLEAR');
    eq(readTpslEditValue('').kind, 'CLEAR');
    const v = readTpslEditValue(60000);
    eq(v.kind, 'SET');
    if (v.kind === 'SET') eq(v.price, 60000);
    const s = readTpslEditValue('60000');
    eq(s.kind === 'SET' ? s.price : null, 60000);
  });
}

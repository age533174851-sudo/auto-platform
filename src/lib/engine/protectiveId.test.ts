// src/lib/engine/protectiveId.test.ts
//
// **보호주문에 표식이 없으면 그 손절은 영영 고아로 남는다.**
//
// 고아 정리는 두 가지 증거를 본다:
//
//   1순위  장부에 적어 둔 거래소 주문 번호 (`live_orders.sl_order_id`)
//   2순위  주문에 새긴 식별자 (`clientOrderId` / Gate의 `text`)
//
// 1순위를 잃으면(트레일링으로 옮겼거나 기록이 실패했으면) 2순위만 남는다.
// 그런데 2순위가 이렇게 만들어지고 있었다:
//
//     clientOrderId: `${input.clientOrderId}SL`
//
// 소유권 형식은 **목적 글자 + 회차 숫자로 끝나야** 한다. 진입 id가
// `smo-abcdef1234ETHUSDE0`이면 `...E0SL`이 되는데 그건 그 형식이 아니다.
// `parseOwnedClientOrderId`가 UNKNOWN을 돌려주고, 정리 코드는 안전을
// 이유로 그 주문을 남긴다 — 실제로 Gate에 스모크 SL/TP가 매번 쌓였다.
//
// 바이낸스는 더 나빴다. **식별자를 아예 안 붙였다.**
import { test, eq, assert } from '../../test/harness';
import {
  ownedClientOrderId, protectiveClientOrderId, parseOwnedClientOrderId,
} from './orderOwnership';

export function runProtectiveIdTests() {
  console.log('[보호주문 표식 — 이어 붙이지 않고 바꿔 끼운다]');

  const entry = ownedClientOrderId({
    owner: { strategyId: 'my-original-v1', symbol: 'ETHUSDT' } as any,
    logicalKey: '2026-08-22', purpose: 'ENTRY',
  });

  test('진입 id는 소유권 형식으로 읽힌다', () => {
    eq(parseOwnedClientOrderId(entry).ok, true, entry);
  });

  test('손절 id도 소유권 형식으로 읽힌다', () => {
    // **여기가 깨져 있었다.** `${entry}SL`은 형식이 아니라 UNKNOWN이 된다.
    const sl = protectiveClientOrderId(entry, 'STOP_LOSS');
    eq(parseOwnedClientOrderId(sl).ok, true, `소유를 증명하지 못한다: ${sl}`);
    assert(!sl.endsWith('SL'), `이어 붙였다: ${sl}`);
  });

  test('익절 id도 마찬가지다', () => {
    const tp = protectiveClientOrderId(entry, 'TAKE_PROFIT');
    eq(parseOwnedClientOrderId(tp).ok, true, tp);
    assert(!tp.endsWith('TP'), `이어 붙였다: ${tp}`);
  });

  test('손절과 익절이 서로 다른 id다', () => {
    // 같으면 두 번째가 중복으로 거절되고, 보호가 하나만 걸린다.
    assert(
      protectiveClientOrderId(entry, 'STOP_LOSS') !== protectiveClientOrderId(entry, 'TAKE_PROFIT'),
      '손절과 익절이 같은 id다',
    );
  });

  test('길이가 늘지 않는다 — Gate의 28자에서 잘리면 소유를 잃는다', () => {
    eq(protectiveClientOrderId(entry, 'STOP_LOSS').length, entry.length);
    assert(entry.length <= 28, `${entry.length}자 — Gate 상한을 넘는다`);
  });

  test('같은 진입에서 같은 손절 id가 나온다 — 재시도가 중복이 되지 않는다', () => {
    eq(protectiveClientOrderId(entry, 'STOP_LOSS'), protectiveClientOrderId(entry, 'STOP_LOSS'));
  });

  test('보호주문 id에서 전략을 되읽을 수 있다', () => {
    const p = parseOwnedClientOrderId(protectiveClientOrderId(entry, 'STOP_LOSS'));
    eq(p.ok, true);
    eq(p.strategyPrefix, parseOwnedClientOrderId(entry).strategyPrefix,
      '전략 표식이 손절에서 사라졌다');
  });

  // ── 옛 형식은 동작이 안 바뀐다 ──
  //
  // daily-ladder의 `LD…`는 소유권 형식이 아니다. 그걸 지금 바꾸면
  // **멱등 열쇠가 바뀐다** — 배포 경계에서 같은 논리적 주문이 다른 id를
  // 갖게 되고, 그건 중복 주문의 문이다. 그 교체는 따로 한다.
  test('옛 형식은 예전처럼 이어 붙인다 — 멱등 열쇠를 건드리지 않는다', () => {
    eq(protectiveClientOrderId('LD20260822BTCUSDT', 'STOP_LOSS'), 'LD20260822BTCUSDTSL');
    eq(protectiveClientOrderId('LD20260822BTCUSDT', 'TAKE_PROFIT'), 'LD20260822BTCUSDTTP');
  });

  test('빈 id를 받아도 터지지 않는다', () => {
    assert(typeof protectiveClientOrderId('', 'STOP_LOSS') === 'string');
    assert(typeof protectiveClientOrderId(null as any, 'STOP_LOSS') === 'string');
  });

  test('회차를 주면 그 자리에 들어간다', () => {
    // 분할 익절 사다리는 같은 진입에서 여러 건이 나간다.
    const a = protectiveClientOrderId(entry, 'TAKE_PROFIT', 0);
    const b = protectiveClientOrderId(entry, 'TAKE_PROFIT', 1);
    assert(a !== b, `사다리 두 칸이 같은 id다: ${a}`);
    eq(parseOwnedClientOrderId(b).ok, true, b);
  });
}

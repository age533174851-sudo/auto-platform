// src/lib/engine/venuePositionOps.test.ts
//
// **취소 재조회가 주문 번호를 위조하던 자리 (#552).**
//
// `cancelExact`는 취소를 보낸 뒤 목록을 다시 읽어 그 번호가 사라졌는지
// 본다. 그 비교에 쓰던 식이 이것이었다:
//
//     String(row?.id ?? row?.orderId ?? '')
//
// 같은 저장소의 `protectionLedger.orderIdOf`는 **같은 값을 거부한다** —
// 안전 정수 범위를 넘은 `number`는 이미 반올림된 값이라 "복구가 아니라
// 위조"이기 때문이다(그 파일의 주석). 한쪽은 거부하고 한쪽은 문자열로
// 만들어 쓰고 있었다 — `CLAUDE.md`의 상습 고장 ② "경로가 둘인데 한쪽만
// 고침".
//
// 위조된 번호는 요청한 진짜 번호와 영원히 같아지지 않는다. 그래서
// `pending`에서 빠지지 않고, 취소를 `maxRounds`까지 다시 보내고,
// 끝내 `STILL_PRESENT`가 된다. 반대로 위조된 값이 다른 주문의 번호와
// 우연히 같아지면 **남아 있는 주문을 사라진 것으로 센다.**

import { test, eq } from '../../test/harness';
import { presentIdsOf } from './venuePositionOps';
import { orderIdOf } from './protectionLedger';

/** 안전 정수 범위를 넘은 주문 번호 (JSON이 숫자로 읽으면 반올림된다) */
const UNSAFE = 9007199254740993;   // 2^53 + 1 → 9007199254740992로 반올림된다

export function runVenuePositionOpsTests() {
  console.log('[취소 재조회 — 번호를 위조하지 않는다]');

  test('정밀도를 잃은 숫자는 남아 있는 번호로 세지 않는다', () => {
    // `String(9007199254740993)`은 '9007199254740992'다 — 없는 주문 번호다.
    eq(presentIdsOf([{ id: UNSAFE }]).length, 0);
  });

  test('같은 줄을 orderIdOf와 같게 읽는다 — 두 경로가 갈리지 않는다', () => {
    const rows = [{ id: 55 }, { orderId: 77 }, { order_id: 99 }, { id: UNSAFE }, {}, null];
    // **정본은 orderIdOf다.** 여기서 다르게 읽으면 취소 확인이 갈린다.
    eq(presentIdsOf(rows as any).join(','),
       (rows as any[]).map(orderIdOf).filter(Boolean).join(','));
  });

  test('읽을 수 있는 번호는 그대로 센다', () => {
    eq(presentIdsOf([{ id: '123456789' }, { orderId: 55 }]).join(','), '123456789,55');
  });

  test('목록이 아니면 빈 목록이다', () => {
    eq(presentIdsOf(null as any).length, 0);
    eq(presentIdsOf(undefined as any).length, 0);
  });

  test('Algo 전용 식별자만 있는 줄은 일반 번호가 없는 줄이다', () => {
    // 일반 취소 API로 지울 수 있는 번호가 아니다. 번호가 있는 것처럼
    // 세면 "사라졌다"를 잘못 적게 된다.
    eq(presentIdsOf([{ algoId: 'A-1', clientAlgoId: 'c-1' }]).length, 0);
  });
}

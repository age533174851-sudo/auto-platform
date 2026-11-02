// src/lib/engine/cancelReadbackChain.test.ts
//
// **두 수정이 같이 있어야 사슬이 안전하다 (#552).**
//
// `cancelExact`는 취소를 보낸 뒤 이렇게 판단한다:
//
//     const present = presentIdsOf(leftover);              // #556이 고친 자리
//     pending = pending.filter(id => present.includes(id));
//     ... 그리고 호출부가 cancelLedger({ ids, attempts, leftover })  // #555가 고친 자리
//
// 각 PR의 시험은 **자기 함수만** 본다. 그래서 둘을 따로 보면 둘 다 초록인데
// 사슬은 거짓 CLEAR를 낼 수 있다:
//
//   · `leftover = [{ algoId: '999' }]` 또는 `[{ id: 9007199254740993 }]`
//   · 요청한 번호 `'77'`은 **읽힌 번호 목록에 없다**
//   · 그래서 "사라졌다"로 읽힌다 — 그런데 그 못 읽은 줄이 바로 그 주문일
//     수 있다
//
// 그 거짓 CLEAR는 **main에 이미 있었다.** #556은 그것을 만들지도, 고치지도
// 않는다(번호를 위조하지 않게만 한다). 고치는 것은 #555다. 이 파일은
// **둘이 같이 있을 때 사슬 전체가 무엇을 말하는지** 고정한다.
//
// 여기서는 거래소를 부르지 않는다. `cancelExact`의 I/O는 주입할 수 없으므로
// **그 함수가 하는 순수한 계산을 같은 순서로** 합성한다 — 쓰는 함수는
// 제품의 것 그대로다(복제 없음).

import { test, eq, assert } from '../../test/harness';
import { presentIdsOf, pendingAfterReadback } from './venuePositionOps';
import { cancelLedger, type CancelAttempt } from './protectionLedger';

/** 안전 정수 범위를 넘은 번호 — JSON 숫자로 읽히면 반올림된다 */
const UNSAFE = 9007199254740993;

const A = (id: string, over: Partial<CancelAttempt> = {}): CancelAttempt =>
  ({ id, requested: true, httpOk: true, ...over });

/**
 * `cancelExact`가 재조회 뒤에 하는 계산.
 *
 * **제품과 같은 함수를 쓴다.** 처음에는 `pending` 분기를 이 파일에 다시
 * 썼는데, 그러면 제품 쪽 분기만 퇴행했을 때 이 시험이 잡지 못한다 —
 * 검수가 그 점을 지적했고 맞는 지적이다. 그래서 그 두 줄을 제품의
 * `pendingAfterReadback`으로 꺼내고 양쪽이 그것을 쓴다.
 */
function readbackRound(i: { ids: string[]; leftover: any[] | null }) {
  const present = Array.isArray(i.leftover) ? presentIdsOf(i.leftover) : null;
  const pending = pendingAfterReadback(i.ids, i.leftover);   // ← 제품 함수
  return { present, pending, leftover: i.leftover };
}

/** 사슬 전체: 재조회 계산 → 장부 판정 */
function chain(i: { ids: string[]; leftover: any[] | null }) {
  const r = readbackRound(i);
  const ledger = cancelLedger({
    ids: i.ids, attempts: i.ids.map(id => A(id)), leftover: r.leftover,
  });
  return { ...r, ledger };
}

export function runCancelReadbackChainTests() {
  console.log('[취소 사슬 — 번호를 못 읽은 줄이 있으면 사라졌다고 말하지 않는다]');

  test('★ Algo 식별자만 있는 줄이 남아 있으면 CLEAR가 아니다', () => {
    // 반례 ①. `presentIdsOf`는 이 줄에서 번호를 못 읽고(그게 맞다),
    // 장부가 그 사실을 UNKNOWN으로 적어야 사슬이 안전하다.
    const c = chain({ ids: ['77'], leftover: [{ algoId: '999', clientAlgoId: 'smoke-999' }] });
    eq(c.present!.length, 0, '못 읽을 번호를 읽었다고 했습니다');
    eq(c.ledger.ok, false, '거짓 CLEAR입니다 — 못 읽은 줄이 그 주문일 수 있습니다');
    eq(c.ledger.code, 'UNKNOWN');
  });

  test('★ 정밀도를 잃은 숫자가 남아 있으면 CLEAR가 아니다', () => {
    // 반례 ②. 위조하지 않는 것(#556)과 모른다고 적는 것(#555)이 둘 다 필요하다.
    const c = chain({ ids: ['77'], leftover: [{ id: UNSAFE }] });
    eq(c.present!.length, 0);
    eq(c.ledger.ok, false);
    eq(c.ledger.code, 'UNKNOWN');
  });

  test('★ 다른 주문은 읽혔고 미해독 줄이 섞여 있어도 CLEAR가 아니다', () => {
    // 반례 ③. 읽힌 번호가 있다는 사실이 "내가 전부 읽었다"는 뜻은 아니다.
    const c = chain({
      ids: ['77'],
      leftover: [{ id: '999', initial: { contract: 'ETH_USDT' } }, { orderId: UNSAFE }],
    });
    eq(c.present!.join(','), '999');
    eq(c.ledger.ok, false);
    eq(c.ledger.code, 'UNKNOWN');
  });

  test('★ 요청한 번호가 읽힌 줄에 남아 있으면 STILL_PRESENT다', () => {
    const c = chain({ ids: ['77'], leftover: [{ id: '77', initial: { contract: 'ETH_USDT' } }] });
    eq(c.present!.join(','), '77');
    eq(c.pending.join(','), '77', '아직 남아 있는데 재시도 목록에서 뺐습니다');
    eq(c.ledger.ok, false);
    eq(c.ledger.code, 'STILL_PRESENT');
  });

  test('★ 목록을 못 읽으면 재시도 목록에서 아무것도 빼지 않는다 — 제품 함수로 확인', () => {
    // **이 시험이 제품의 분기를 직접 본다.** 시험이 같은 분기를 다시 쓰고
    // 있으면 제품만 퇴행했을 때 못 잡는다(검수 지적).
    eq(pendingAfterReadback(['77', '88'], null).join(','), '77,88');
    eq(pendingAfterReadback(['77', '88'], undefined as any).join(','), '77,88');
  });

  test('★ 번호를 못 읽은 줄은 "남아 있는 번호"가 아니다 — 제품 함수로 확인', () => {
    eq(pendingAfterReadback(['77'], [{ algoId: '999' }]).length, 0);
    eq(pendingAfterReadback(['77'], [{ id: UNSAFE }]).length, 0);
    eq(pendingAfterReadback(['77'], [{ id: '77' }]).join(','), '77');
  });

  test('★★ 위조된 번호가 요청 번호와 같아지는 경우 — 제품 함수로 확인', () => {
    // **이 경우를 빼 두면 위조가 보이지 않는다.** `String(9007199254740993)`은
    // '9007199254740992'이고, 그 값이 요청한 번호와 같아지는 날에만
    // "남아 있는 주문"으로 세어진다. 돌연변이로 확인했다: 이 시험이 없으면
    // `presentIdsOf`를 다시 `String(...)`으로 되돌려도 7314개가 전부 통과한다.
    const forged = String(UNSAFE);                 // '9007199254740992'
    eq(pendingAfterReadback([forged], [{ id: UNSAFE }]).length, 0,
       '위조된 번호를 "거래소에 남아 있다"로 셌습니다 — 그 주문은 그 번호가 아닙니다');
    // 같은 줄을 장부가 보면 UNKNOWN이다 — 둘이 같은 말을 해야 한다.
    const l = chain({ ids: [forged], leftover: [{ id: UNSAFE }] });
    eq(l.ledger.code, 'UNKNOWN');
  });

  test('★ 빈 번호·공백은 재시도 대상이 아니다 — 제품 함수로 확인', () => {
    eq(pendingAfterReadback(['', '  ', '77'], [{ id: '77' }]).join(','), '77');
    eq(pendingAfterReadback([] as any, [{ id: '77' }]).length, 0);
    eq(pendingAfterReadback(null as any, null).length, 0);
  });

  test('★ 모든 줄의 번호를 읽었고 요청 번호가 없을 때만 CLEAR다', () => {
    const c = chain({ ids: ['77'], leftover: [{ id: '999', initial: { contract: 'ETH_USDT' } }] });
    eq(c.present!.join(','), '999');
    eq(c.pending.length, 0);
    eq(c.ledger.ok, true);
    eq(c.ledger.code, 'CLEAR');
  });

  test('★ 목록이 비어 있으면 CLEAR다 — 빈 목록은 "하나도 없다"다', () => {
    const c = chain({ ids: ['77'], leftover: [] });
    eq(c.ledger.ok, true);
    eq(c.ledger.code, 'CLEAR');
  });

  test('★ 목록을 못 읽었으면(null) UNKNOWN이고 재시도 목록도 그대로다', () => {
    const c = chain({ ids: ['77'], leftover: null });
    eq(c.present, null);
    eq(c.pending.join(','), '77');
    eq(c.ledger.ok, false);
    eq(c.ledger.code, 'UNKNOWN');
  });

  test('★ 위조된 번호가 재시도 판단을 흔들지 않는다', () => {
    // #556 이전에는 `String(9007199254740993)`이 '9007199254740992'가 되어
    // **없는 주문 번호**가 present에 들어갔다. 그 값이 요청 번호와 같아지는
    // 날에는 남아 있는 주문을 사라진 것으로 센다.
    const forged = String(UNSAFE);           // '9007199254740992'
    const c = chain({ ids: [forged], leftover: [{ id: UNSAFE }] });
    assert(!c.present!.includes(forged), `위조된 번호가 present에 들어갔습니다: ${c.present}`);
    eq(c.ledger.ok, false, '위조된 번호로 "사라졌다"고 적었습니다');
    eq(c.ledger.code, 'UNKNOWN');
  });
}

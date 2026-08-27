// src/lib/engine/stopMove.test.ts
//
// **순서가 곧 안전이다: 걸고 → 적고 → 치운다.**
//
// ②(적기)를 건너뛰고 ③(치우기)을 하면, 새 손절은 거래소에 있는데
// 그 번호가 장부에 없고 **기존 손절은 이미 취소돼 있다.** 앱이 아는
// 손절이 하나도 없는 상태로 포지션이 남는다.
//
// 그래서 아래 테스트는 **취소가 몇 번 불렸는지**를 센다.
import { test, assert, eq } from '../../test/harness';
import { moveStopSafely } from './stopMove';

function harness(o: any = {}) {
  const calls = { place: 0, record: 0, cancel: 0 };
  const run = () => moveStopSafely({
    symbol: 'BTCUSDT', side: 'LONG', newStop: 110,
    place: async () => { calls.place += 1; return o.place ?? { ok: true, orderId: 'sl-new' }; },
    record: async () => { calls.record += 1; return o.record ?? { ok: true }; },
    cancelOthers: async () => { calls.cancel += 1; return o.cancel ?? { cancelled: 1 }; },
  });
  return { calls, run };
}

export function runStopMoveTests() {
  console.log('\n🪜 손절 이동 순서 (걸고 → 적고 → 치운다)');

  test('정상: 걸고 적고 치운다', async () => {
    const h = harness();
    const r = await h.run();
    eq(r.code, 'MOVED', '옮겼다');
    assert(r.ok, '성공');
    eq(r.newOrderId, 'sl-new', '새 번호');
    eq(r.cancelledOld, 1, '옛 것 하나 치움');
    assert(!r.oldStopKept, '옛 손절은 없다');
    eq(h.calls.place, 1, '한 번 건다');
    eq(h.calls.record, 1, '한 번 적는다');
    eq(h.calls.cancel, 1, '한 번 치운다');
  });

  // ══ 이 파일이 존재하는 이유 ══
  test('장부 기록이 실패하면 기존 손절을 치우지 않는다', async () => {
    const h = harness({ record: { ok: false, message: 'DB 오류' } });
    const r = await h.run();
    eq(r.code, 'RECORD_FAILED', '적지 못했다');
    assert(!r.ok, '성공이 아니다');
    eq(h.calls.cancel, 0, '**취소를 부르지 않는다**');
    assert(r.oldStopKept, '기존 손절이 살아 있다');
    assert(r.reason.includes('둘인 편이'), '왜 남기는지 적는다');
  });

  test('장부 기록이 던져도 치우지 않는다', async () => {
    const calls = { cancel: 0 };
    const r = await moveStopSafely({
      symbol: 'BTCUSDT', side: 'LONG', newStop: 110,
      place: async () => ({ ok: true, orderId: 'sl-new' }),
      record: async () => { throw new Error('network'); },
      cancelOthers: async () => { calls.cancel += 1; return { cancelled: 1 }; },
    });
    eq(r.code, 'RECORD_FAILED', '적지 못했다');
    eq(calls.cancel, 0, '**취소를 부르지 않는다**');
    assert(r.oldStopKept, '기존 손절 유지');
  });

  test('새 손절을 못 걸면 적지도 치우지도 않는다', async () => {
    const h = harness({ place: { ok: false, orderId: null, message: '거절됨' } });
    const r = await h.run();
    eq(r.code, 'PLACE_FAILED', '못 걸었다');
    eq(h.calls.record, 0, '적을 것이 없다');
    eq(h.calls.cancel, 0, '**기존 손절을 지우지 않는다**');
    assert(r.oldStopKept, '기존 손절이 유일한 방어선이다');
    assert(r.reason.includes('기존 손절은 그대로'), '사실을 적는다');
  });

  test('새 손절 걸기가 던져도 기존 것을 건드리지 않는다', async () => {
    const calls = { record: 0, cancel: 0 };
    const r = await moveStopSafely({
      symbol: 'BTCUSDT', side: 'LONG', newStop: 110,
      place: async () => { throw new Error('timeout'); },
      record: async () => { calls.record += 1; return { ok: true }; },
      cancelOthers: async () => { calls.cancel += 1; return { cancelled: 1 }; },
    });
    eq(r.code, 'PLACE_FAILED', '못 걸었다');
    eq(calls.record, 0, '적지 않는다');
    eq(calls.cancel, 0, '치우지 않는다');
  });

  test('옛 손절을 못 치우면 성공이지만 그 사실을 적는다', async () => {
    const r = await moveStopSafely({
      symbol: 'BTCUSDT', side: 'LONG', newStop: 110,
      place: async () => ({ ok: true, orderId: 'sl-new' }),
      record: async () => ({ ok: true }),
      cancelOthers: async () => { throw new Error('cancel failed'); },
    });
    eq(r.code, 'OLD_STOP_REMAINS', '손절이 둘이다');
    assert(r.ok, '새 손절은 걸리고 적혔다 — 위험이 아니라 잡음이다');
    assert(r.oldStopKept, '옛 것이 남아 있다');
    assert(r.reason.includes('다음 주기'), '다시 시도한다고 적는다');
  });

  test('취소 개수를 못 읽어도 0으로 두고 성공은 유지한다', async () => {
    const r = await moveStopSafely({
      symbol: 'BTCUSDT', side: 'LONG', newStop: 110,
      place: async () => ({ ok: true, orderId: 'sl-new' }),
      record: async () => ({ ok: true }),
      cancelOthers: async () => ({ cancelled: NaN as any }),
    });
    eq(r.code, 'MOVED', '옮겼다');
    eq(r.cancelledOld, 0, '못 읽은 개수를 지어내지 않는다');
  });

  test('주문 번호를 못 받아도 기록 단계는 거친다 — 번호 없음도 기록 대상이다', async () => {
    const seen: any[] = [];
    const r = await moveStopSafely({
      symbol: 'BTCUSDT', side: 'LONG', newStop: 110,
      place: async () => ({ ok: true, orderId: null }),
      record: async (id) => { seen.push(id); return { ok: true }; },
      cancelOthers: async () => ({ cancelled: 0 }),
    });
    eq(seen.length, 1, '적기를 건너뛰지 않는다');
    eq(seen[0], null, '번호가 없다는 사실 그대로');
    eq(r.code, 'MOVED', '진행한다');
  });
}

// src/lib/engine/leverageSync.test.ts
//
// 막으려는 것:
//  1. 거래소가 5배인데 계획이 50배인 채로 **그대로 주문이 나가는 것.**
//     점검 목록의 배율 항목은 blocking:false라 경고만 뜨고 통과했다
//  2. 배율 변경 요청이 200을 받았다고 **걸린 것으로 믿는 것.**
//     열린 포지션·심볼 상한·교차/격리 때문에 무시돼도 응답은 성공이다
//  3. 못 읽은 배율을 '맞다'나 '다르다'로 읽는 것 — 둘 다 틀린 행동을 만든다
//  4. 거래소 오류 원문을 뭉개는 것
import { test, assert, eq } from '../../test/harness';
import { ensureLeverage, leverageSyncSummary } from './leverageSync';

/** 읽기·쓰기를 흉내내는 가짜 거래소 */
function fakeExchange(start: number | null, opts: {
  writeFails?: string;
  /** 쓰기는 성공하는데 실제로는 안 바뀌는 거래소 */
  ignoresWrite?: boolean;
  /** 상한에 걸려 잘리는 거래소 */
  cap?: number;
  readFailsAfterWrite?: boolean;
  readThrows?: boolean;
} = {}) {
  let cur = start;
  let wrote = 0;
  return {
    get writes() { return wrote; },
    get current() { return cur; },
    deps: {
      read: async () => {
        if (opts.readThrows) throw new Error('네트워크');
        if (opts.readFailsAfterWrite && wrote > 0) return null;
        return cur;
      },
      write: async (lev: number) => {
        wrote++;
        if (opts.writeFails) return { ok: false, message: opts.writeFails };
        if (!opts.ignoresWrite) cur = opts.cap != null ? Math.min(lev, opts.cap) : lev;
        return { ok: true };
      },
    },
  };
}

export function runLeverageSyncTests() {
  console.log('[배율 맞추기 — 이미 맞으면 건드리지 않는다]');

  test('같은 값이면 변경을 안 보낸다', async () => {
    const ex = fakeExchange(5);
    const r = await ensureLeverage(5, ex.deps);
    eq(r.ok, true);
    eq(r.code, 'ALREADY_MATCHED');
    eq(ex.writes, 0, '멀쩡한 계좌에 불필요한 변경을 쐈다');
  });

  test('5.0과 5를 다르다고 하지 않는다', async () => {
    // 거래소가 소수로 주는 경우가 있다.
    const ex = fakeExchange(5.0);
    eq((await ensureLeverage(5, ex.deps)).code, 'ALREADY_MATCHED');
    eq(ex.writes, 0);
  });

  console.log('[배율 맞추기 — 바꾸고 되읽는다]');

  test('다르면 바꾸고 확인한다', async () => {
    // 사진의 상태: 거래소 5배 / 의도 50배
    const ex = fakeExchange(5);
    const r = await ensureLeverage(50, ex.deps);
    eq(r.ok, true);
    eq(r.code, 'CHANGED');
    eq(r.before, 5);
    eq(r.after, 50);
    eq(ex.current, 50);
    assert(r.reason.includes('되읽어 확인'), r.reason);
  });

  test('바꿨다고 믿지 않는다 — 응답은 성공인데 안 바뀐 거래소', async () => {
    // 열린 포지션이 있으면 이렇게 된다. 응답은 200이고 값은 그대로다.
    const ex = fakeExchange(5, { ignoresWrite: true });
    const r = await ensureLeverage(50, ex.deps);
    eq(r.ok, false, '되읽지 않았으면 통과시켰을 자리다');
    eq(r.code, 'VERIFY_MISMATCH');
    eq(r.after, 5);
    assert(r.reason.includes('여전히 5배'), r.reason);
  });

  test('상한에 잘려도 잡는다', async () => {
    const ex = fakeExchange(5, { cap: 20 });
    const r = await ensureLeverage(50, ex.deps);
    eq(r.ok, false);
    eq(r.code, 'VERIFY_MISMATCH');
    eq(r.after, 20);
    assert(r.reason.includes('상한'), r.reason);
  });

  test('포지션이 열려 있으면 그 사실을 사유에 적는다', async () => {
    const ex = fakeExchange(5, { ignoresWrite: true });
    const r = await ensureLeverage(50, ex.deps, { positionOpen: true });
    assert(r.reason.includes('열린 포지션'), r.reason);
  });

  console.log('[배율 맞추기 — 못 읽으면 주문하지 않는다]');

  test('지금 배율을 못 읽으면 막는다', async () => {
    // 맞다고 보면 안 맞는 배율로 나가고, 다르다고 보면 멀쩡한 계좌에
    // 불필요한 변경을 쏜다. 둘 다 틀린 행동이다.
    const ex = fakeExchange(null);
    const r = await ensureLeverage(50, ex.deps);
    eq(r.ok, false);
    eq(r.code, 'READ_FAILED');
    eq(ex.writes, 0, '못 읽었는데 변경을 보냈다');
  });

  test('조회가 던져도 막는다', async () => {
    const ex = fakeExchange(5, { readThrows: true });
    const r = await ensureLeverage(50, ex.deps);
    eq(r.code, 'READ_FAILED');
  });

  test('바꾼 뒤 되읽지 못하면 통과가 아니다', async () => {
    // 확인하지 못한 것은 통과가 아니다.
    const ex = fakeExchange(5, { readFailsAfterWrite: true });
    const r = await ensureLeverage(50, ex.deps);
    eq(r.ok, false);
    eq(r.code, 'VERIFY_UNREADABLE');
    assert(r.reason.includes('확인되지 않았습니다'), r.reason);
  });

  console.log('[배율 맞추기 — 거래소 오류를 뭉개지 않는다]');

  test('변경이 거부되면 원문을 그대로 올린다', async () => {
    const ex = fakeExchange(5, { writeFails: 'code=-4028 leverage not valid' });
    const r = await ensureLeverage(50, ex.deps);
    eq(r.ok, false);
    eq(r.code, 'WRITE_FAILED');
    eq(r.exchangeMessage, 'code=-4028 leverage not valid');
    assert(r.reason.includes('-4028'), r.reason);
  });

  test('쓰기가 던져도 원문이 남는다', async () => {
    const r = await ensureLeverage(50, {
      read: async () => 5,
      write: async () => { throw new Error('timeout'); },
    });
    eq(r.code, 'WRITE_FAILED');
    assert((r.exchangeMessage || '').includes('timeout'), String(r.exchangeMessage));
  });

  console.log('[배율 맞추기 — 의도값이 없으면]');

  test('의도한 배율이 숫자가 아니면 시작도 안 한다', async () => {
    for (const v of [null, undefined, 0, -3, 'abc', NaN]) {
      const ex = fakeExchange(5);
      const r = await ensureLeverage(v, ex.deps);
      eq(r.ok, false, String(v));
      eq(r.code, 'BAD_INTENDED', String(v));
      eq(ex.writes, 0, String(v));
    }
  });

  test('0을 유효한 배율로 받지 않는다', async () => {
    // Gate에서 leverage 0은 교차 증거금이라는 뜻이다. 그걸 '0배'로
    // 읽어 맞추려 하면 안 된다.
    const ex = fakeExchange(0);
    const r = await ensureLeverage(0, ex.deps);
    eq(r.code, 'BAD_INTENDED');
  });

  console.log('[배율 맞추기 — 요약]');

  test('실패는 눈에 띄게 적는다', async () => {
    const bad = await ensureLeverage(50, fakeExchange(5, { ignoresWrite: true }).deps);
    assert(leverageSyncSummary(bad).startsWith('🛑'), leverageSyncSummary(bad));
    const good = await ensureLeverage(5, fakeExchange(5).deps);
    assert(!leverageSyncSummary(good).startsWith('🛑'), leverageSyncSummary(good));
    assert(leverageSyncSummary(null).includes('확인하지 않았습니다'));
  });
}

// src/lib/smoke/cancelOps.test.ts
//
// **"없다"와 "못 읽었다"를 가르는 자리 — 하필 즉시 중지 버튼이다.**
//
// `loadRun()`이 `const { data } = await …`로 error를 버리고 `data ?? null`을
// 돌려줬다. 실패한 select는 예외를 던지지 않고 `{ data: null, error }`를
// 주므로, DB 조회가 실패하면 그냥 null이 된다. 그리고 호출부 둘 다
//
//     if (!run) → 404 '그 반복 테스트를 찾지 못했습니다'
//
// 로 끝났다. 그 404가 나가는 자리가 **즉시 중지(`cancelNow`)**다.
// 사람이 100배 포지션을 닫으려고 누른 순간에 "그런 테스트가 없습니다"를
// 받으면, 닫을 것이 없다고 믿고 화면을 닫는다 — 포지션은 열려 있다.
//
// `maybeSingle()`은 줄이 0개일 때 `{ data: null, error: null }`을 준다.
// 그래서 둘은 깨끗하게 갈린다. 가르지 않은 것이 결함이었다.

import { test, eq, assert } from '../../test/harness';
import { stopAfterCurrent, cancelNow } from './cancelOps';

interface Sb {
  from(t: string): any;
  writes: { table: string; patch: any }[];
}

/**
 * `cancelOps`가 쓰는 표면만 흉내 낸다.
 *
 *   from(t).update(p).eq().eq().select(cols)      → 바꾼 줄
 *   from(t).select('*').eq().eq().maybeSingle()   → 한 줄
 */
function fakeSb(opts: {
  /** maybeSingle이 error를 돌려준다 (조회 실패) */
  loadFails?: boolean;
  /** 있으면 그 줄이 읽힌다. 없으면 "정말 없음" */
  row?: any;
} = {}): Sb {
  const writes: { table: string; patch: any }[] = [];
  const api: any = {
    writes,
    from(table: string) {
      let pending: any = null;
      const b: any = {
        update(patch: any) { pending = patch; return b; },
        select() {
          // update 뒤의 select는 "바꾼 줄"을 돌려준다.
          // 여기서는 **아무 줄도 안 바뀐 것**으로 둬서 loadRun까지 가게 한다.
          if (pending) { writes.push({ table, patch: pending }); return Promise.resolve({ data: [], error: null }); }
          return b;
        },
        eq() { return b; },
        async maybeSingle() {
          if (opts.loadFails) return { data: null, error: { message: '조회 실패' } };
          return { data: opts.row ?? null, error: null };
        },
      };
      return b;
    },
  };
  return api as Sb;
}

export function runCancelOpsTests() {
  console.log('[스모크 중지 — "없다"와 "못 읽었다"는 다르다]');

  // ══════════ ① 즉시 중지 — 못 읽으면 "없다"고 답하지 않는다 ══════════
  test('① cancelNow: 묶음을 못 읽으면 LOAD_FAILED(503)이지 NOT_FOUND가 아니다', async () => {
    const sb = fakeSb({ loadFails: true });
    const r = await cancelNow(sb as any, { runId: 'r-1', userId: 'u-1' });
    eq(r.ok, false);
    eq(r.code, 'LOAD_FAILED', '못 읽은 것을 "없다"로 적지 않는다');
    eq(r.status, 503, '404는 "없다"는 뜻이다 — 여기서는 거짓말이다');
    assert(r.message.includes('없다는 뜻이 아닙니다'),
      `사람이 화면을 닫지 않게 적어야 한다: ${r.message}`);
    eq(sb.writes.length, 0, '못 읽었으면 아무것도 바꾸지 않는다');
  });

  // ══════════ ② 정말 없으면 NOT_FOUND다 ══════════
  //
  // ①을 통과시키려고 전부 503으로 만들면, 진짜 없는 묶음에도
  // "다시 시도하세요"가 나간다 — 영원히 끝나지 않는 안내다.
  test('② cancelNow: 묶음이 정말 없으면 NOT_FOUND(404) 그대로다', async () => {
    const sb = fakeSb({ row: null });
    const r = await cancelNow(sb as any, { runId: 'r-1', userId: 'u-1' });
    eq(r.code, 'NOT_FOUND');
    eq(r.status, 404);
  });

  // ══════════ ③ 반복 중지도 같은 두 갈래 ══════════
  //
  // 같은 판단이 두 함수에 있으면 한쪽만 고쳐진다. 둘 다 본다.
  test('③ stopAfterCurrent: 못 읽으면 LOAD_FAILED, 정말 없으면 NOT_FOUND', async () => {
    const bad = await stopAfterCurrent(fakeSb({ loadFails: true }) as any,
      { runId: 'r-1', userId: 'u-1' });
    eq(bad.code, 'LOAD_FAILED');
    eq(bad.status, 503);

    const none = await stopAfterCurrent(fakeSb({ row: null }) as any,
      { runId: 'r-1', userId: 'u-1' });
    eq(none.code, 'NOT_FOUND');
    eq(none.status, 404);
  });

  // ══════════ ④ 읽혔으면 막지 않는다 ══════════
  //
  // 과잉 차단 방지. 줄을 읽었으면 LOAD_FAILED가 나오면 안 된다 —
  // 그 뒤 판단(ALREADY_DONE 등)은 원래 로직이 한다.
  test('④ 읽히면 LOAD_FAILED로 막지 않는다', async () => {
    const r = await stopAfterCurrent(
      fakeSb({ row: { id: 'r-1', state: 'DONE' } }) as any, { runId: 'r-1', userId: 'u-1' });
    assert(r.code !== 'LOAD_FAILED', `읽혔는데 막았습니다: ${r.code} ${r.message}`);
    eq(r.code, 'ALREADY_DONE');
    eq(r.state, 'DONE');
  });
}

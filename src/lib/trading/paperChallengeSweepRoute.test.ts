// src/lib/trading/paperChallengeSweepRoute.test.ts
//
// **챌린지 정리 실행자 — 확인하지 못한 것을 초록으로 답하지 않는다.**
//
// 무엇이 있었나
// ─────────────
// 워커는 `/api/paper/challenge-sweep`을 1분마다 부르고, `ok:false`일 때만
// 오류를 남긴다. `ok:true`이면 "한 것(started·expired·closed)"이나
// "막힌 것(waiting·unknownMarks)"이 있을 때만 한 줄 찍는다.
//
// 그런데 라우트는 두 자리에서 **확인하지 못한 것을 ok:true로 답했다:**
//
//   ⑴ CLOSING 챌린지의 열린 포지션을 못 읽으면 `POSITIONS_UNREADABLE`만
//      적고 넘어갔다. 요약은 그것을 어디에도 세지 않고(정리 중 0 · 마감 0),
//      `ok`는 그대로 true — 워커는 **아무 줄도 남기지 않는다.** 그 챌린지는
//      CLOSING에 머문 채 매 분 같은 침묵이 반복된다.
//   ⑵ CLOSED 뒤 "보고하는 쪽이 스스로를 한 번 더 본다"는 재확인이
//      `error`를 버렸다. 재확인을 못 하면 `after`가 null이고, 검사는
//      **조용히 통과**했다. 확인하지 못한 것은 통과가 아니다.
//
// 여기서는 실제 라우트 핸들러를 가짜 DB에 붙여 부른다.
import { test, eq, assert } from '../../test/harness';

interface SweepDb {
  /** CLOSING 챌린지의 열린 포지션 조회 결과 */
  positions: { data: any; error: any };
  /** CLOSED 뒤 재확인 조회 결과 */
  after: { data: any; error: any };
}

const CLOSING_ROW = {
  id: 'c1', user_id: 'u-1', paper_account_id: 'a1',
  close_intent: 'EXPIRED', terminal_status: null,
};

async function hitSweep(db: SweepDb) {
  const serverPath = require.resolve('../supabase/server');
  const adminPath = require.resolve('../supabase/admin');
  const routePath = require.resolve('../../app/api/paper/challenge-sweep/route');
  const prevServer = require.cache[serverPath];
  const prevAdmin = require.cache[adminPath];
  const rpcs: string[] = [];

  const fake = {
    from: (table: string) => {
      const q: any = {
        select: () => q,
        eq: () => q,
        // CLOSED 뒤 재확인만 `.maybeSingle()`을 쓴다.
        maybeSingle: async () => db.after,
        // 나머지 조회는 체인을 그대로 await 한다.
        then: (res: any, rej: any) => Promise.resolve(
          table === 'paper_positions'
            ? db.positions
            : { data: [CLOSING_ROW], error: null },
        ).then(res, rej),
      };
      return q;
    },
    rpc: async (name: string) => {
      rpcs.push(name);
      if (name === 'paper_challenge_sweep_due') return { data: [], error: null };
      if (name === 'paper_challenge_finalize') {
        return { data: [{ code: 'CLOSED', open_count: 0 }], error: null };
      }
      return { data: null, error: { message: `부르면 안 된다: ${name}` } };
    },
  };

  require.cache[serverPath] = {
    id: serverPath, filename: serverPath, loaded: true, exports: {
      getSupabaseAdmin: () => fake,
      resolveUserId: async () => 'u-1',
      getUserIdFromRequest: async () => 'u-1',
      serviceRoleKeyRole: () => 'service_role',
    },
  } as any;
  delete require.cache[adminPath];
  delete require.cache[routePath];
  let POST: (r: any) => Promise<any>;
  try {
    POST = require(routePath).POST;
  } finally {
    delete require.cache[routePath];
    delete require.cache[adminPath];
    if (prevServer) require.cache[serverPath] = prevServer; else delete require.cache[serverPath];
    if (prevAdmin) require.cache[adminPath] = prevAdmin;
  }
  const res = await POST!({ headers: { get: () => null }, json: async () => ({}) });
  return { status: res.status as number, json: await res.json(), rpcs };
}

export function runPaperChallengeSweepRouteTests() {
  console.log('[챌린지 정리 실행자 · 확인하지 못한 것]');

  test('★ CLOSING 챌린지의 포지션을 못 읽으면 ok:false — 워커가 침묵하지 않게', async () => {
    const r = await hitSweep({
      positions: { data: null, error: { message: 'connection reset' } },
      after: { data: null, error: null },
    });
    eq(r.json.ok, false, '확인하지 못한 챌린지를 초록으로 답했다');
    const breaks: string[] = Array.isArray(r.json.contractBreaks) ? r.json.contractBreaks : [];
    assert(breaks.some(b => b.includes('c1')),
      `어느 챌린지를 못 읽었는지 보고에 없다: ${JSON.stringify(breaks)}`);
    // 못 읽은 챌린지는 마감하러 가지 않는다 — 기존 계약 그대로.
    assert(!r.rpcs.includes('paper_challenge_finalize'), '못 읽은 챌린지를 마감하러 갔다');
    eq(r.json.finalizes?.[0]?.code, 'POSITIONS_UNREADABLE');
    eq(r.json.finalizes?.[0]?.openCount, null);
  });

  test('★ CLOSED 뒤 재확인을 못 읽으면 ok:false — 확인하지 못한 것은 통과가 아니다', async () => {
    const r = await hitSweep({
      positions: { data: [], error: null },
      after: { data: null, error: { message: 'connection reset' } },
    });
    eq(r.json.ok, false, '재확인을 못 했는데 초록으로 답했다');
    const breaks: string[] = Array.isArray(r.json.contractBreaks) ? r.json.contractBreaks : [];
    assert(breaks.some(b => b.includes('c1')),
      `재확인 실패가 보고에 없다: ${JSON.stringify(breaks)}`);
    // 마감 자체는 일어났다 — 그 사실은 지우지 않는다.
    eq(r.json.closed, 1);
  });

  test('재확인이 동결된 사유와 맞으면 그대로 ok:true', async () => {
    const r = await hitSweep({
      positions: { data: [], error: null },
      after: { data: { close_intent: 'EXPIRED', terminal_status: 'EXPIRED' }, error: null },
    });
    eq(r.json.ok, true, JSON.stringify(r.json.contractBreaks));
    eq(r.json.closed, 1);
    eq((r.json.contractBreaks ?? []).length, 0);
  });

  test('재확인이 동결된 사유와 다르면 그대로 ok:false', async () => {
    const r = await hitSweep({
      positions: { data: [], error: null },
      after: { data: { close_intent: 'EXPIRED', terminal_status: 'FAILED' }, error: null },
    });
    eq(r.json.ok, false);
    assert((r.json.contractBreaks ?? []).some((b: string) => b.includes('동결된 사유')),
      JSON.stringify(r.json.contractBreaks));
  });
}

// src/lib/trading/paperCloseReview.test.ts
//
// **전량청산 — 순서와 본문에 관한 사실들.**
//
// 무엇을 막는가
// ─────────────
// 이 층이 생기기 전에는 `[전량청산]` 한 번에 `/api/paper/close`가 나갔다.
// 되돌릴 수 없는 동작이고, 좁은 화면에서 옆 칸을 누르려다 닿는 자리에
// 있었다. 확인 창을 끼워 넣으면서 가장 쉽게 생기는 고장은 넷이다:
//
//   ⑴ 창을 열었는데 **그 자리에서 요청도 같이 나간다**
//   ⑵ 취소했는데 나간다 / 확인을 두 번 눌러 두 번 나간다
//   ⑶ 창에는 A가 적혀 있는데 **B가 닫힌다**
//   ⑷ 이미 닫힌 포지션을 다시 닫으려 한다
//
// 넷 다 "이 상태에서 저 사건이 오면 무엇이 일어나는가"이고, `useState`
// 안에 두면 시험이 닿지 못한다. 그래서 전이를 순수 함수로 빼 두고
// (`closeReviewReduce`), 여기서 **실제로 눌러 본다.**
import { test, eq, assert } from '../../test/harness';
import {
  CLOSE_REVIEW_CLOSED, closeConfirmVerdict, closeRequestBody, closeReviewPhaseOf,
  closeReviewReduce, closeRows, sameClose,
  type ClosePositionView, type CloseReviewEnv, type CloseReviewEvent, type CloseReviewState,
} from './paperCloseReview';
import { runPaperChallengeSweepRouteTests } from './paperChallengeSweepRoute.test';

const pos = (id: string, o: Partial<ClosePositionView> = {}): ClosePositionView => ({
  id, symbol: 'ETHUSDT', side: 'LONG',
  fillPrice: 3000, quantity: 1, leverage: 10, margin: 300,
  stopLoss: 2970, takeProfit: null, liquidationPrice: 2715,
  openedAt: '2026-09-27T00:00:00.000Z', ...o,
});

const THREE = [pos('p1'), pos('p2', { symbol: 'BTCUSDT', side: 'SHORT' }), pos('p3')];
const IDS = THREE.map(p => p.id);

const env = (o: Partial<CloseReviewEnv> = {}): CloseReviewEnv => ({
  openIds: IDS, hasAuth: true, busy: false, ...o,
});

/** 사건을 차례로 먹인다. **요청이 몇 번 났는지**를 센다 */
function drive(steps: Array<{ e: CloseReviewEvent; env?: Partial<CloseReviewEnv> }>,
  start: CloseReviewState = CLOSE_REVIEW_CLOSED) {
  let st = start;
  let closes = 0;
  for (const s of steps) {
    const step = closeReviewReduce(st, env(s.env), s.e);
    st = step.state;
    closes += step.effects.filter(f => f === 'CLOSE').length;
  }
  return { state: st, closes, phase: closeReviewPhaseOf(st, false) };
}

const OPEN = (positionId: string): CloseReviewEvent => ({ type: 'OPEN', positionId });

const rowOf = (rows: ReturnType<typeof closeRows>, key: string) => {
  const r = rows.find(x => x.key === key);
  assert(!!r, `${key} 칸이 없다`);
  return r!;
};

export function runPaperCloseReviewTests() {
  console.log('[전량청산 확인 창]');

  // ══════════ 1~2 · 어느 포지션인가 ══════════

  test('★① 포지션이 셋이면 셋 다 자기 id로 열린다', () => {
    // 목록이 `positions[0]`만 그리던 시절에는 두 번째·세 번째를 닫을
    // 방법이 화면에 없었다. 전이 쪽에서도 그 셋이 구별되는지 본다.
    for (const id of IDS) {
      const r = drive([{ e: OPEN(id) }]);
      eq(r.phase, 'REVIEW', `${id}의 창이 안 열렸다`);
      eq(r.state.opened?.positionId, id);
      eq(r.closes, 0);
    }
  });

  test('★② A를 눌렀는데 B가 열리지 않는다', () => {
    const r = drive([{ e: OPEN('p2') }]);
    eq(r.state.opened?.positionId, 'p2');
    assert(!sameClose(r.state.opened, { positionId: 'p1' }), 'A와 B가 같은 것으로 읽힌다');
  });

  test('장부에 없는 포지션의 창은 열리지 않는다', () => {
    const r = drive([{ e: OPEN('없는id') }]);
    eq(r.phase, 'NONE', '이미 닫힌 포지션의 확인 창이 열렸다');
    eq(r.closes, 0);
    eq(drive([{ e: OPEN('') }]).phase, 'NONE');
  });

  // ══════════ 3~6 · 요청은 몇 번 나가는가 ══════════

  test('★③ 첫 클릭에는 요청이 나가지 않는다', () => {
    const step = closeReviewReduce(CLOSE_REVIEW_CLOSED, env(), OPEN('p1'));
    eq(step.effects.length, 0, '★ 창을 여는데 청산이 나갔다');
  });

  test('★④ 취소하면 요청이 나가지 않는다', () => {
    const r = drive([{ e: OPEN('p1') }, { e: { type: 'CANCEL' } }]);
    eq(r.phase, 'NONE');
    eq(r.closes, 0, '★ 취소했는데 청산이 나갔다');
  });

  test('★⑤ 확인하면 **정확히 한 번** 나간다', () => {
    const r = drive([{ e: OPEN('p1') }, { e: { type: 'CONFIRM' } }]);
    eq(r.closes, 1);
    eq(r.state.sent, true);
  });

  test('★⑥ 확인을 연타해도 한 번뿐이다', () => {
    const r = drive([
      { e: OPEN('p1') },
      { e: { type: 'CONFIRM' } },
      { e: { type: 'CONFIRM' } },
      { e: { type: 'CONFIRM' }, env: { busy: true } },
    ]);
    eq(r.closes, 1, '★ 같은 포지션을 여러 번 닫았다');
  });

  // ══════════ 7 · 본문에 무엇이 실리는가 ══════════

  test('★⑦ 본문은 positionId 하나뿐이다', () => {
    const body = closeRequestBody('p2');
    eq(Object.keys(body).join(','), 'positionId');
    eq(body.positionId, 'p2');
    // 가격·계좌가 실리면 화면이 장부를 만들 수 있다
    for (const k of ['exitPrice', 'markPrice', 'market', 'accountId',
                     'paperAccountId', 'realizedPnl', 'pnlPct', 'challengeId']) {
      assert(!(k in (body as any)), `본문에 ${k}가 실렸다`);
    }
  });

  // ══════════ 8 · 사라진 포지션 ══════════

  test('★⑧ 창을 연 뒤 포지션이 사라지면 닫을 수 없다', () => {
    const gone = { openIds: ['p1', 'p3'] };   // p2가 사라졌다
    const r = drive([
      { e: OPEN('p2') },
      { e: { type: 'LEDGER' }, env: gone },
      { e: { type: 'CONFIRM' }, env: gone },
    ]);
    eq(r.phase, 'NONE', '사라진 포지션의 창이 남아 있다');
    eq(r.closes, 0, '★ 이미 닫힌 포지션을 다시 닫았다');
  });

  test('★⑧-b 창이 남아 있어도 사라진 포지션이면 확인이 막힌다 (방어 2겹)', () => {
    const v = closeConfirmVerdict({
      phase: 'REVIEW', opened: { positionId: 'p2' },
      openIds: ['p1', 'p3'], hasAuth: true, busy: false,
    });
    eq(v.off, true);
    eq(v.action, 'NONE');
    assert(/열려 있지 않/.test(v.reason || ''), `사유가 ${v.reason}이다`);
    const r = drive([{ e: { type: 'CONFIRM' }, env: { openIds: ['p1', 'p3'] } }],
      { opened: { positionId: 'p2' }, sent: false });
    eq(r.closes, 0);
  });

  test('★⑧-c 사라진 창을 **다른 포지션으로 재사용하지 않는다**', () => {
    // 목록이 바뀌었다고 창이 옆 포지션을 가리키기 시작하면, 사용자가 읽은
    // 것과 닫히는 것이 달라진다.
    const r = drive([
      { e: OPEN('p2') },
      { e: { type: 'LEDGER' }, env: { openIds: ['p1', 'p3'] } },
    ]);
    eq(r.state.opened, null);
  });

  // ══════════ 9~10 · 결과 처리 ══════════

  test('★⑨ 실패하면 창이 남고 다시 시도할 수 있다', () => {
    const r = drive([
      { e: OPEN('p1') }, { e: { type: 'CONFIRM' } },
      { e: { type: 'RESULT', ok: false } },
    ]);
    eq(r.phase, 'REVIEW', '실패했는데 창이 닫혀 사유가 사라졌다');
    eq(r.state.sent, false, '다시 시도할 수 없는 상태로 굳었다');
    // 실제로 다시 눌러 보낼 수 있다
    const again = drive([{ e: { type: 'CONFIRM' } }], r.state);
    eq(again.closes, 1);
  });

  test('★⑩ 성공하면 창이 닫힌다', () => {
    const r = drive([
      { e: OPEN('p1') }, { e: { type: 'CONFIRM' } },
      { e: { type: 'RESULT', ok: true } },
    ]);
    eq(r.phase, 'NONE');
    eq(r.closes, 1);
  });

  // ══════════ 11 · 보내는 중 ══════════

  test('★⑪ 보내는 중에는 닫지도, 다른 포지션을 열지도 못한다', () => {
    const r = drive([
      { e: OPEN('p1') }, { e: { type: 'CONFIRM' } },
      { e: { type: 'CANCEL' } },
      { e: OPEN('p3') },
      { e: { type: 'LEDGER' }, env: { openIds: ['p3'] } },
    ]);
    eq(r.state.opened?.positionId, 'p1', '보내는 중인데 창이 바뀌었다');
    eq(r.closes, 1);
  });

  test('보내는 중이면 확인 버튼이 꺼진다', () => {
    for (const o of [{ phase: 'SUBMITTING' as const, busy: false },
                     { phase: 'REVIEW' as const, busy: true }]) {
      const v = closeConfirmVerdict({
        phase: o.phase, opened: { positionId: 'p1' }, openIds: IDS,
        hasAuth: true, busy: o.busy,
      });
      eq(v.off, true);
      eq(v.action, 'NONE');
      assert(/보내는 중/.test(v.reason || ''), `사유가 ${v.reason}이다`);
    }
  });

  test('로그인하지 않았으면 확인이 막힌다', () => {
    const v = closeConfirmVerdict({
      phase: 'REVIEW', opened: { positionId: 'p1' }, openIds: IDS,
      hasAuth: false, busy: false,
    });
    eq(v.off, true);
    assert(/로그인/.test(v.reason || ''));
    eq(drive([{ e: { type: 'CONFIRM' }, env: { hasAuth: false } }],
      { opened: { positionId: 'p1' }, sent: false }).closes, 0);
  });

  test('★ 꺼졌으면 확인 버튼의 할 일은 언제나 NONE이다', () => {
    const cases = [
      { phase: 'NONE' as const, opened: null, openIds: IDS, hasAuth: true, busy: false },
      { phase: 'REVIEW' as const, opened: null, openIds: IDS, hasAuth: true, busy: false },
      { phase: 'REVIEW' as const, opened: { positionId: 'x' }, openIds: IDS, hasAuth: true, busy: false },
      { phase: 'REVIEW' as const, opened: { positionId: 'p1' }, openIds: IDS, hasAuth: false, busy: false },
      { phase: 'SUBMITTING' as const, opened: { positionId: 'p1' }, openIds: IDS, hasAuth: true, busy: false },
    ];
    for (const c of cases) {
      const v = closeConfirmVerdict(c);
      eq(v.off, true, JSON.stringify(c));
      eq(v.action, 'NONE', JSON.stringify(c));
      assert(!!v.reason, `사유 없이 꺼졌다: ${JSON.stringify(c)}`);
    }
  });

  // ══════════ 표시값 ══════════

  test('표시 줄은 정해진 순서와 개수다 — 칸이 조용히 사라지지 않는다', () => {
    eq(closeRows(pos('p1')).map(r => r.key).join(','),
      'SYMBOL,SIDE,ENTRY_PRICE,QUANTITY,LEVERAGE,MARGIN,'
      + 'STOP_LOSS,TAKE_PROFIT,LIQUIDATION_PRICE,OPENED_AT');
  });

  test('★ 없는 값은 "—"다 — 0으로 적지 않는다', () => {
    const rows = closeRows(pos('p1', {
      stopLoss: null, takeProfit: null, liquidationPrice: null, openedAt: null,
    }));
    for (const k of ['STOP_LOSS', 'TAKE_PROFIT', 'LIQUIDATION_PRICE', 'OPENED_AT']) {
      const v = rowOf(rows, k).value;
      eq(v.kind, 'UNKNOWN', `${k}를 0으로 적었다`);
      assert(!!(v as any).reason, `${k}에 왜 없는지 적지 않았다`);
    }
  });

  test('★ 손익 칸이 아예 없다 — 미실현 손익 정본이 없다', () => {
    // 있으면 세 번째 손익 권위가 된다. 칸을 만들지 않는 것이 계약이다.
    const keys = closeRows(pos('p1')).map(r => r.key).join(',');
    for (const banned of ['PNL', 'ROE', 'UNREALIZED', 'EXIT_PRICE', 'REALIZED']) {
      assert(!keys.includes(banned), `손익 칸이 생겼다 (${banned})`);
    }
  });

  test('장부가 준 값을 그대로 적는다 — 되만들지 않는다', () => {
    const rows = closeRows(pos('p1', { fillPrice: 2999.5, quantity: 0.25, margin: 74.99 }));
    eq((rowOf(rows, 'ENTRY_PRICE').value as any).amount, 2999.5);
    eq((rowOf(rows, 'QUANTITY').value as any).amount, 0.25);
    eq((rowOf(rows, 'MARGIN').value as any).amount, 74.99);
    eq((rowOf(rows, 'LEVERAGE').value as any).text, '10배');
  });

  // ══════════ 서버 쪽 · 포지션을 못 읽은 것은 "없음"이 아니다 ══════════
  //
  // 확인 창이 보내는 `/api/paper/close`가 포지션 SELECT의 `error`를 버리고
  // `data`만 보고 있었다. DB가 잠깐 실패하면 **있는 포지션을** 404
  // `not_found`로 답했다 — 사용자는 포지션이 사라진 줄 안다. 같은 장부를
  // 읽는 `/api/paper/positions`는 이미 503 `positions_unreadable`로 갈라 둔
  // 규칙이다.
  closeRouteFacts();
  modifyRouteFacts();

  // 같은 모의 장부의 **정리 실행자**. 이 자리에서 부르는 이유: 새 시험 파일을
  // `scripts/run-tests.mjs`에 올리면 그 파일을 이미 잡은 열린 PR들과
  // 겹친다. 그쪽이 합쳐진 뒤에는 러너로 옮겨도 된다.
  runPaperChallengeSweepRouteTests();
}

/** 실제 라우트 핸들러를 가짜 DB에 붙여 한 번 부른다 */
async function hitCloseRoute(read: { data: any; error: any }, uid = 'u-1') {
  return hitPaperRoute('close', { positionId: 'p1' }, read, uid);
}

async function hitPaperRoute(
  route: 'close' | 'modify', body: any, read: { data: any; error: any }, uid = 'u-1',
  opts: { write?: { data: any; error: any } } = {},
) {
  const serverPath = require.resolve('../supabase/server');
  const adminPath = require.resolve('../supabase/admin');
  const routePath = require.resolve(`../../app/api/paper/${route}/route`);
  const prevServer = require.cache[serverPath];
  const prevAdmin = require.cache[adminPath];
  let selects = 0;
  let rpcs = 0;
  let updates = 0;
  /** UPDATE에 붙은 조건. `status='open'`이 붙었는지 본다. */
  const writeEqs: Array<[string, unknown]> = [];
  const db = {
    from: (_t: string) => {
      let writing = false;
      const q: any = {
        // UPDATE 뒤의 `.select()`는 **맞은 행**을 돌려준다(PostgREST).
        select: () => {
          if (writing) return Promise.resolve(opts.write ?? { data: [{ id: 'p1' }], error: null });
          selects++; return q;
        },
        update: () => { updates++; writing = true; return q; },
        eq: (k: string, v: unknown) => { if (writing) writeEqs.push([k, v]); return q; },
        maybeSingle: async () => read,
      };
      return q;
    },
    rpc: async () => { rpcs++; return { data: null, error: { message: '부르면 안 된다' } }; },
  };
  require.cache[serverPath] = {
    id: serverPath, filename: serverPath, loaded: true, exports: {
      getSupabaseAdmin: () => db,
      resolveUserId: async () => uid,
      getUserIdFromRequest: async () => uid,
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
  const req = {
    json: async () => body,
    headers: { get: () => null },
  };
  const res = await POST!(req);
  return { status: res.status as number, json: await res.json(), selects, rpcs, updates, writeEqs };
}

function closeRouteFacts() {
  test('★ 포지션 조회가 실패하면 503 position_unreadable — 404 not_found로 적지 않는다', async () => {
    const r = await hitCloseRoute({ data: null, error: { message: 'connection reset' } });
    eq(r.selects, 1, '포지션을 읽으러 가지 않았다');
    eq(r.status, 503);
    eq(r.json.ok, false);
    eq(r.json.error, 'position_unreadable');
    assert(String(r.json.message).includes('없다는 뜻이 아닙니다'),
      `모름을 없음과 가르는 문장이 없다: ${r.json.message}`);
    eq(r.rpcs, 0, '못 읽은 포지션을 닫으러 갔다');
  });

  test('정말 없는 포지션은 그대로 404 not_found', async () => {
    const r = await hitCloseRoute({ data: null, error: null });
    eq(r.status, 404);
    eq(r.json.error, 'not_found');
    eq(r.rpcs, 0);
  });

  test('남의 포지션은 그대로 404 not_found — 있다는 사실도 알려 주지 않는다', async () => {
    const r = await hitCloseRoute({
      data: { id: 'p1', user_id: 'someone-else', symbol: 'ETHUSDT', status: 'open', market: 'USDM' },
      error: null,
    });
    eq(r.status, 404);
    eq(r.json.error, 'not_found');
    eq(r.rpcs, 0);
  });
}

// ══════════ 손절·익절 수정 · 같은 규칙 ══════════
//
// `/api/paper/modify`도 같은 포지션 SELECT를 하고, 같은 자리에서 `error`를
// 버리고 있었다. DB가 잠깐 실패하면 **있는 포지션의 손절을 옮기려던
// 사용자에게** 404 `not_found`가 갔다 — 청산만 고치고 수정은 남은 것이다.
function modifyRouteFacts() {
  const body = { positionId: 'p1', stopLoss: 2900 };

  test('★ 수정: 포지션 조회가 실패하면 503 position_unreadable — 404 not_found로 적지 않는다', async () => {
    const r = await hitPaperRoute('modify', body, { data: null, error: { message: 'connection reset' } });
    eq(r.selects, 1, '포지션을 읽으러 가지 않았다');
    eq(r.status, 503);
    eq(r.json.ok, false);
    eq(r.json.error, 'position_unreadable');
    assert(String(r.json.message).includes('없다는 뜻이 아닙니다'),
      `모름을 없음과 가르는 문장이 없다: ${r.json.message}`);
    eq(r.updates, 0, '못 읽은 포지션을 고치러 갔다');
  });

  test('수정: 정말 없는 포지션은 그대로 404 not_found', async () => {
    const r = await hitPaperRoute('modify', body, { data: null, error: null });
    eq(r.status, 404);
    eq(r.json.error, 'not_found');
    eq(r.updates, 0);
  });

  test('수정: 남의 포지션은 그대로 404 not_found', async () => {
    const r = await hitPaperRoute('modify', body, {
      data: { id: 'p1', user_id: 'someone-else', symbol: 'ETHUSDT', side: 'LONG', status: 'open', entry_price: 3000, market: 'USDM' },
      error: null,
    });
    eq(r.status, 404);
    eq(r.json.error, 'not_found');
    eq(r.updates, 0);
  });

  // ── 읽은 뒤에 닫힌 포지션 ──
  //
  // 포지션을 읽은 순간에는 열려 있었는데, 시세를 읽는 사이 감시기가 손절로
  // 닫았다(정산은 `status='open'`일 때만 바뀌는 조건부 UPDATE다 — 072).
  // 예전 수정 UPDATE는 `id`·`user_id`만 보고 **맞은 행 수를 보지 않았다.**
  // 그래서 닫힌 포지션의 손절 칸을 덮어쓰고 "저장했습니다"를 답했다 —
  // 사용자는 손절을 옮겼다고 믿는데 포지션은 이미 옛 손절로 닫혀 있다.
  //
  // 시세 조회는 네트워크로 가므로 시험에서는 **모르는 시장**을 준다 —
  // `readPaperMarkPrice`가 그 자리에서 UNSUPPORTED_MARKET으로 돌아오고,
  // 라우트는 진입가(3000)로 방향을 본다. 여기서 보려는 것은 그 뒤의 쓰기다.
  // (비동기 시험이 동시에 돌아 `require.cache` 스텁은 서로 새어 나간다.)
  const openPos = {
    id: 'p1', user_id: 'u-1', symbol: 'ETHUSDT', side: 'LONG',
    status: 'open', entry_price: 3000, market: 'TEST_OFFLINE',
  };

  test('★ 수정: UPDATE는 열린 포지션에만 맞는다 (status=open 조건)', async () => {
    const r = await hitPaperRoute('modify', body, { data: openPos, error: null }, 'u-1');
    eq(r.status, 200, JSON.stringify(r.json));
    eq(r.updates, 1);
    assert(r.writeEqs.some(([k, v]) => k === 'status' && v === 'open'),
      `UPDATE에 status='open' 조건이 없다: ${JSON.stringify(r.writeEqs)}`);
    assert(r.writeEqs.some(([k, v]) => k === 'user_id' && v === 'u-1'), '소유자 조건이 빠졌다');
  });

  test('★ 수정: 읽은 뒤 청산돼 0행이 바뀌면 409 already_closed — "저장했습니다"라 하지 않는다', async () => {
    const r = await hitPaperRoute('modify', body, { data: openPos, error: null }, 'u-1',
      { write: { data: [], error: null } });
    eq(r.status, 409, JSON.stringify(r.json));
    eq(r.json.ok, false);
    eq(r.json.error, 'already_closed');
    assert(!String(r.json.message).includes('저장했습니다'), `저장했다고 답했다: ${r.json.message}`);
  });

  test('★ 수정: 바뀐 행을 확인하지 못하면 성공으로 적지 않는다 (503)', async () => {
    const r = await hitPaperRoute('modify', body, { data: openPos, error: null }, 'u-1',
      { write: { data: null, error: null } });
    eq(r.status, 503, JSON.stringify(r.json));
    eq(r.json.ok, false);
    eq(r.json.error, 'update_unconfirmed');
  });

  test('수정: UPDATE 오류는 그대로 500 update_failed', async () => {
    const r = await hitPaperRoute('modify', body, { data: openPos, error: null }, 'u-1',
      { write: { data: null, error: { message: 'boom' } } });
    eq(r.status, 500);
    eq(r.json.error, 'update_failed');
  });
}

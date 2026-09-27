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
}

// src/lib/engine/paperEventTime.test.ts
//
// **사건 시각을 안 넘기면 돈이 안 움직인다 — 그러니 반드시 넘겨야 한다.**
//
// 회귀 대상: `085`는 `paper_open_position`과 `paper_settle_close`에
// `p_event_effective_at`을 **기본값 없이** 추가했다. 이름 인자로 부르는 이
// 저장소의 호출부가 그 값을 빼먹으면 Postgres는 함수를 찾지 못한다 —
// `function public.paper_open_position(...) does not exist`. 모의 매매 전체가
// 죽는다.
//
// 실제로 그랬다. 빈 DB에 `085`를 세우고 지금의 호출부 모양으로 불러 보니
// 그 오류가 났다. 그래서 이 시험은 **두 호출부가 그 값을 넘기는지**를 붙든다.
//
// 왜 값의 출처까지 보는가
// ───────────────────────
// 이 시각은 원장에 그대로 박히고, 챌린지의 달성 판정이 그것을 기준으로
// 유효기간을 본다. 요청 본문에서 온 값이 여기 닿으면 사용자가 자기 챌린지의
// 사건 시각을 정할 수 있다 — 기간 밖의 달성을 기간 안으로 적는 것이 가능해진다.
//
// 그래서 `paperEventTimeNow()`는 **인자를 받지 않는다.** 넘길 자리가 없으면
// 클라이언트 값이 들어올 길도 없다. 이 시험은 그 계약이 유지되는지도 본다.

import { test, eq, assert } from '../../test/harness';
import { paperEventTimeNow } from './paperEventTime';
import { openPaperPosition, closePaperPosition } from './paperStore';

const PLAN: any = {
  symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, positionSize: 1000,
  leverage: 10, requiredMargin: 100, approved: true,
  stopDistancePct: 2, effectiveStopPct: 2, riskAmount: 20,
  riskAmountWithCosts: 21, liquidationPrice: 0, liquidationDistancePct: 9, notes: [],
};

export function runPaperEventTimeTests() {
  console.log('[모의 회계 사건 시각 — 없으면 돈을 건드리지 않는다]');

  // ── 값의 모양 ──

  test('사건 시각은 ISO 8601 UTC 문자열이다', () => {
    const t = paperEventTimeNow();
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t),
      `ISO 8601 UTC가 아니다: ${t}`);
    // Postgres가 읽을 수 있는 값이어야 한다 — 되돌려 파싱했을 때 같아야 한다.
    eq(new Date(t).toISOString(), t);
  });

  test('인자를 받지 않는다 — 클라이언트 값이 들어올 자리가 없다', () => {
    // 인자를 받게 되면 요청 본문의 값이 원장까지 갈 통로가 생긴다.
    // 길이가 0이 아니게 되는 변경은 이 시험을 깨뜨려야 한다.
    eq(paperEventTimeNow.length, 0);
  });

  test('부를 때마다 지금을 만든다 — 상수로 굳어 있지 않다', () => {
    const before = Date.now();
    const t = Date.parse(paperEventTimeNow());
    const after = Date.now();
    // 밀리초 절단 때문에 before보다 1ms 이를 수 있다.
    assert(t >= before - 1 && t <= after + 1,
      `지금이 아니다: ${t} ∉ [${before}, ${after}]`);
  });

  // ── 진입 호출부 ──

  test('진입은 p_event_effective_at을 반드시 넘긴다', async () => {
    let params: any = null;
    const sb: any = {
      rpc: (_fn: string, p: any) => {
        params = p;
        return Promise.resolve({ data: [{ status: 'OPENED', position_id: 'pos-1' }], error: null });
      },
    };
    await openPaperPosition(sb, {
      userId: 'u', signalId: 's1', strategyId: 'scalp', plan: PLAN, entryPrice: 100_000,
    });
    assert(params !== null, 'RPC가 불리지 않았다');
    assert('p_event_effective_at' in params,
      'p_event_effective_at이 없다 — 085에서 이 함수는 기본값이 없으므로 ' +
      'Postgres가 함수를 찾지 못한다');
    assert(typeof params.p_event_effective_at === 'string' && params.p_event_effective_at !== '',
      `사건 시각이 문자열이 아니다: ${String(params.p_event_effective_at)}`);
    // **NULL을 넘기지 않는다.** 넘기면 함수가 진입에서 거부한다(22004).
    assert(params.p_event_effective_at != null, '사건 시각이 NULL이다');
    eq(new Date(params.p_event_effective_at).toISOString(), params.p_event_effective_at);
  });

  // ── 청산 호출부 ──

  test('청산도 p_event_effective_at을 반드시 넘긴다', async () => {
    let params: any = null;
    const sb: any = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: {
                id: 'pos-1', status: 'open', side: 'LONG',
                entry_price: 100, fill_price: 100, quantity: 1, notional: 100,
                leverage: 1, margin: 100, entry_fee: 0.5, liquidation_price: 50,
                opened_at: new Date().toISOString(),
              },
              error: null,
            }),
          }),
        }),
      }),
      rpc: (fn: string, p: any) => {
        eq(fn, 'paper_settle_close');
        params = p;
        return Promise.resolve({
          data: [{ settled: true, owner_id: 'u', settled_pnl: 1, settled_pnl_pct: 1 }],
          error: null,
        });
      },
    };
    const r = await closePaperPosition(sb, 'pos-1', 110, 'TP');
    eq(r.ok, true);
    assert(params !== null, 'RPC가 불리지 않았다');
    assert('p_event_effective_at' in params,
      'p_event_effective_at이 없다 — 085의 paper_settle_close는 이 값이 없으면 ' +
      '포지션을 닫지도 않는다');
    assert(params.p_event_effective_at != null, '사건 시각이 NULL이다');
    eq(new Date(params.p_event_effective_at).toISOString(), params.p_event_effective_at);
  });

  // ── 두 호출부가 같은 자리에서 시각을 만든다 ──

  test('진입과 청산의 시각은 같은 모양이다 — 자리가 둘로 갈리지 않았다', async () => {
    const seen: string[] = [];
    const sbOpen: any = {
      rpc: (_f: string, p: any) => {
        seen.push(p.p_event_effective_at);
        return Promise.resolve({ data: [{ status: 'OPENED', position_id: 'p' }], error: null });
      },
    };
    await openPaperPosition(sbOpen, {
      userId: 'u', signalId: 's2', strategyId: 'scalp', plan: PLAN, entryPrice: 100_000,
    });

    const sbClose: any = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: {
                id: 'p', status: 'open', side: 'LONG',
                entry_price: 100, fill_price: 100, quantity: 1, notional: 100,
                leverage: 1, margin: 100, entry_fee: 0.5, liquidation_price: 50,
                opened_at: new Date().toISOString(),
              },
              error: null,
            }),
          }),
        }),
      }),
      rpc: (_f: string, p: any) => {
        seen.push(p.p_event_effective_at);
        return Promise.resolve({
          data: [{ settled: true, owner_id: 'u', settled_pnl: 1, settled_pnl_pct: 1 }],
          error: null,
        });
      },
    };
    await closePaperPosition(sbClose, 'p', 110, 'TP');

    eq(seen.length, 2);
    for (const t of seen) {
      assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t),
        `모양이 다르다: ${t}`);
    }
  });
}

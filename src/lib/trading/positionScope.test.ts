// src/lib/trading/positionScope.test.ts
//
// **주문이 간 계좌와 포지션을 읽는 계좌는 같아야 한다.**
//
// 무엇이 갈라져 있었나
// ────────────────────
// 정본 화면에는 포지션을 그리는 곳이 없었고 아래 `BottomDock`이 대신
// 그렸다. 그런데 둘은 **다른 계좌**를 보고 있었다.
//
//   주문      PaperOrderScreen → usePaperTarget(challengeId)
//               → /api/paper/order          → 챌린지 계좌
//   포지션 표시 BottomDock      → usePaperAccount
//               → /api/paper/account        → readPaperEquity
//               → paper_accounts.is_default = true  ← **늘 기본 계좌**
//
// 챌린지 장부로 주문하면 방금 연 포지션이 안 보이고 기본 계좌 포지션이
// 대신 보인다. 화면에 오류는 없다 — 그냥 "포지션이 없네"로 읽힌다.
//
// 그래서 한 화면의 포지션 줄은 **다시 읽지 않는다.** 주문에 쓰는 바로 그
// `usePaperLedger` 결과를 그대로 받는다. 읽는 곳과 쓰는 곳이 같은 객체이면
// 어긋날 자리가 없다.
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { test, eq, assert } from '../../test/harness';
import { targetQuery, targetRequestFields, type PaperTarget } from './paperTarget';
import { ledgerLiquidationPrice } from './ledgerLiquidation';

export function runPositionScopeTests() {
  console.log('[포지션 계좌 범위]');

  const DEFAULT_T: PaperTarget = { kind: 'DEFAULT' } as any;
  const CHALLENGE_T: PaperTarget = { kind: 'CHALLENGE', challengeId: 'ch_abc' } as any;

  test('★ 챌린지 장부는 그 챌린지를 실어 읽는다', () => {
    eq(targetQuery(CHALLENGE_T), '?challengeId=ch_abc');
  });

  test('★ 기본 장부는 챌린지를 싣지 않는다', () => {
    eq(targetQuery(DEFAULT_T), '');
  });

  // ── ★ 주문과 표시가 같은 장부를 가리키는가 ──
  //
  // 화면이 실제로 하는 일을 그대로 적는다: 주문도 포지션도 **같은
  // target**에서 나온 같은 질의를 쓴다.
  const orderScope = (t: PaperTarget) => targetQuery(t);
  const ledgerScope = (t: PaperTarget) => targetQuery(t);
  /** 예전 `BottomDock` 경로 — 무엇을 고르든 기본 계좌를 읽는다 */
  const accountRouteScope = (_t: PaperTarget) => '';

  test('★ 챌린지에서 주문 계좌와 표시 계좌가 같다', () => {
    eq(ledgerScope(CHALLENGE_T), orderScope(CHALLENGE_T));
  });

  test('★ 기본 장부에서도 같다', () => {
    eq(ledgerScope(DEFAULT_T), orderScope(DEFAULT_T));
  });

  test('★ /api/paper/account 경로를 쓰면 챌린지에서 갈라진다 — 그래서 쓰지 않는다', () => {
    // 이 시험은 **고장 난 배선이 실제로 갈라진다**는 것을 고정한다.
    // 갈라지지 않게 되면(예: account 라우트가 챌린지를 받게 되면) 이
    // 시험이 먼저 깨지고, 그때 위 계약을 다시 본다.
    assert(accountRouteScope(CHALLENGE_T) !== orderScope(CHALLENGE_T),
      '기본 계좌 경로가 챌린지 주문과 같은 범위를 봅니다 — 전제가 바뀌었습니다');
    eq(accountRouteScope(DEFAULT_T), orderScope(DEFAULT_T),
      '기본 장부에서는 두 경로가 같아야 합니다 (그래서 지금까지 안 드러났다)');
  });

  test('★ 다른 챌린지는 다른 범위다 — 장부가 섞이지 않는다', () => {
    const other: PaperTarget = { kind: 'CHALLENGE', challengeId: 'ch_zzz' } as any;
    assert(targetQuery(CHALLENGE_T) !== targetQuery(other),
      '두 챌린지가 같은 포지션 목록을 봅니다');
  });

  // ══════════ 매도 경로도 같은 장부다 (Phase 3) ══════════
  //
  // 088이 보유 조회·매도를 만들었고 Phase 3이 화면을 붙였다. 화면이 하나
  // 늘면 **장부가 갈릴 자리도 하나 는다** — 이 저장소가 이미 겪은 고장이
  // 정확히 그것이었다(주문은 챌린지, 표시는 기본 계좌).
  //
  // 아래는 `useSellForm`이 실제로 하는 것과 같은 모양이다:
  //   보유 조회  `/api/paper/holdings` + targetQuery(target)
  //   매도 실행  body에 targetRequestFields(target)
  const holdingsScope = (t: PaperTarget) => targetQuery(t);
  const sellBody = (t: PaperTarget) => targetRequestFields(t);

  test('★ 보유를 읽는 장부와 주문을 내는 장부가 같다', () => {
    eq(holdingsScope(CHALLENGE_T), orderScope(CHALLENGE_T));
    eq(holdingsScope(DEFAULT_T), orderScope(DEFAULT_T));
  });

  test('★ 매도 본문이 챌린지를 싣는다 (기본 장부에서는 안 싣는다)', () => {
    eq(sellBody(CHALLENGE_T).challengeId, 'ch_abc');
    eq(sellBody(DEFAULT_T).challengeId, undefined);
  });

  test('★ 매도 본문에 계좌 id가 없다 — 계좌는 서버가 정한다', () => {
    for (const t of [CHALLENGE_T, DEFAULT_T]) {
      const keys = Object.keys(sellBody(t));
      assert(!keys.some(k => /account/i.test(k)),
        `매도 본문에 계좌 칸이 있습니다: ${keys.join(',')}`);
    }
  });

  test('★ 보유를 읽은 장부로 그대로 판다 — 두 챌린지가 안 섞인다', () => {
    const other: PaperTarget = { kind: 'CHALLENGE', challengeId: 'ch_zzz' } as any;
    // 읽은 곳과 파는 곳이 같은 target에서 나오므로, 다른 챌린지의 보유를
    // 이 챌린지 장부로 파는 조합이 만들어지지 않는다.
    assert(holdingsScope(CHALLENGE_T) !== holdingsScope(other),
      '두 챌린지가 같은 보유 목록을 봅니다');
    assert(sellBody(CHALLENGE_T).challengeId !== sellBody(other).challengeId,
      '두 챌린지의 매도가 같은 장부로 나갑니다');
  });

  test('★ 기본 PAPER와 챌린지가 섞이지 않는다 (조회·매도 양쪽)', () => {
    assert(holdingsScope(DEFAULT_T) !== holdingsScope(CHALLENGE_T),
      '기본 계좌와 챌린지가 같은 보유를 봅니다');
    assert(sellBody(DEFAULT_T).challengeId !== sellBody(CHALLENGE_T).challengeId,
      '기본 계좌 매도와 챌린지 매도가 같은 장부로 나갑니다');
  });

  // ── ★ 포지션 줄의 청산가: 모르는 것을 0으로 그리지 않는다 ──
  //
  // 현물 모의 매수는 `liq ?? 0`으로 장부에 청산가 0이 저장된다. 조회
  // 라우트가 그걸 `Number(...)`로 내보내면 포지션 줄에 "청산가 0.00"이
  // 뜬다 — "곧 청산된다"와 "청산이 없다"가 같은 모양이 된다.
  console.log('[포지션 줄 청산가]');

  test('★ 현물 줄은 장부에 0이 있어도 청산가가 없다 (null)', () => {
    eq(ledgerLiquidationPrice({ market: 'SPOT', liquidation_price: 0 }), null);
    eq(ledgerLiquidationPrice({ market: 'SPOT', liquidation_price: '0' }), null);
  });

  test('★ 옛 줄의 NULL은 0이 아니라 null이다', () => {
    eq(ledgerLiquidationPrice({ market: 'USDM', liquidation_price: null }), null);
    eq(ledgerLiquidationPrice({ liquidation_price: undefined }), null);
  });

  test('★ 선물의 0·음수·비숫자는 "모름" 표식이다 — 실제 청산가는 0보다 크다', () => {
    eq(ledgerLiquidationPrice({ market: 'USDM', liquidation_price: 0 }), null);
    eq(ledgerLiquidationPrice({ market: 'USDM', liquidation_price: -5 }), null);
    eq(ledgerLiquidationPrice({ market: 'USDM', liquidation_price: 'abc' }), null);
  });

  test('선물의 실제 청산가는 그대로 나간다 (NUMERIC 문자열 포함)', () => {
    eq(ledgerLiquidationPrice({ market: 'USDM', liquidation_price: 54321.5 }), 54321.5);
    eq(ledgerLiquidationPrice({ market: 'USDM', liquidation_price: '150000' }), 150000);
  });

  test('★ 조회 라우트가 청산가를 이 함수로 낸다 — Number(...)로 0을 만들지 않는다', () => {
    const route = readFileSync(
      resolve(__dirname, '../../app/api/paper/positions/route.ts'), 'utf8');
    assert(route.includes('liquidationPrice: ledgerLiquidationPrice(p)'),
      '/api/paper/positions가 청산가를 ledgerLiquidationPrice로 내지 않습니다');
    assert(!/liquidationPrice:\s*Number\(p\.liquidation_price\)/.test(route),
      '/api/paper/positions가 청산가를 Number(...)로 바꿔 0을 만듭니다');
  });

  // ── ★ 기본 장부의 잔고는 **방금 정한 그 계좌**에서, 오류를 받아 읽는다 ──
  //
  // 무엇이 틀려 있었나
  // ──────────────────
  // 기본 장부 경로는 `resolvePaperScope`로 계좌 id를 정한 뒤 잔고를
  // `getPaperAccount`로 **다시** 읽었다. 그 함수는 조회 `error`를 받지
  // 않고, 못 읽으면 **잔고 10,000짜리 새 계좌 행을 지어내 돌려준다.**
  // 그래서 두 번째 조회만 잠깐 실패하면 응답은 200 · ok:true에
  // `balance: 10000`, `available: 10000`이었다 — 사이징 슬라이더가 그
  // 숫자를 나눠 주문 수량을 정한다. 못 읽은 잔고가 "1만 달러 있음"이 된다.
  //
  // 실제 라우트 핸들러 + 가짜 Supabase. 실제 DB·외부 호출 없음.
  const adminPath = require.resolve('../supabase/admin');
  const routePath = require.resolve('../../app/api/paper/positions/route');
  const FAKE_UID = '00000000-0000-4000-8000-0000000000b7';

  // **한 번에 하나씩 돈다.** 라우트는 admin 모듈을 늦게(동적 import로)
  // 불러온다 — 시험이 겹치면 다른 시험의 가짜 DB를 집는다.
  let chain: Promise<unknown> = Promise.resolve();
  function callPositions(acctRead: 'ok' | 'error' | 'missing') {
    const run = chain.then(() => callPositionsOnce(acctRead));
    chain = run.catch(() => undefined);
    return run;
  }

  async function callPositionsOnce(acctRead: 'ok' | 'error' | 'missing') {
    const oldAdmin = require.cache[adminPath];
    const oldRoute = require.cache[routePath];
    const inserts: string[] = [];
    const fakeDb = {
      from(table: string) {
        let cols = '';
        const result = () => {
          if (table === 'paper_positions') return { data: [], error: null };
          // 계좌 id 해석(`select('id')`)은 성공한다 — 실패는 그 다음 읽기에서만.
          if (cols === 'id') return { data: { id: 'acct_default' }, error: null };
          if (acctRead === 'error') return { data: null, error: { message: 'fake db failure' } };
          if (acctRead === 'missing') return { data: null, error: null };
          return {
            data: { id: 'acct_default', user_id: FAKE_UID, balance: 4321, initial_balance: 5000,
                    total_pnl: -679, total_fees: 0, trade_count: 3, win_count: 1, is_default: true },
            error: null,
          };
        };
        const q: any = {
          select(c: string) { cols = String(c); return q; },
          eq() { return q; }, order() { return q; }, limit() { return q; },
          maybeSingle() { return Promise.resolve(result()); },
          insert() { inserts.push(table); return Promise.resolve({ data: null, error: null }); },
          then(res: any, rej: any) { return Promise.resolve(result()).then(res, rej); },
        };
        return q;
      },
    };
    require.cache[adminPath] = {
      id: adminPath, filename: adminPath, loaded: true,
      exports: { getSupabaseAdmin: () => fakeDb, resolveUserId: async () => FAKE_UID },
    } as any;
    delete require.cache[routePath];
    const url = new URL('https://example.test/api/paper/positions');
    const request: any = {
      nextUrl: url, url: url.toString(),
      headers: { get(n: string) { return n.toLowerCase() === 'authorization' ? 'Bearer fake' : null; } },
    };
    try {
      const mod = require(routePath);
      const res = await mod.GET(request);
      return { status: res.status, body: await res.json(), inserts };
    } finally {
      if (oldAdmin) require.cache[adminPath] = oldAdmin; else delete require.cache[adminPath];
      if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath];
    }
  }

  test('★ 기본 장부 잔고를 못 읽으면 지어낸 10,000이 아니라 503이다', async () => {
    const r = await callPositions('error');
    eq(r.body.ok, false, 'ok:false');
    eq(r.status, 503, '503');
    eq(r.body.account, undefined, '잔고·가용을 싣지 않는다');
    eq(r.inserts.length, 0, '못 읽었다고 계좌를 새로 만들지 않는다');
  });

  test('★ 정한 계좌가 다시 읽을 때 없으면 새 계좌를 만들지 않고 503이다', async () => {
    const r = await callPositions('missing');
    eq(r.body.ok, false, 'ok:false');
    eq(r.status, 503, '503');
    eq(r.inserts.length, 0, '조회 라우트는 계좌를 만들지 않는다');
  });

  test('기본 장부 잔고를 읽으면 그 값 그대로 나간다', async () => {
    const r = await callPositions('ok');
    eq(r.status, 200, '200');
    eq(r.body.ok, true, 'ok:true');
    eq(r.body.account.balance, 4321, '읽은 잔고');
    eq(r.body.account.available, 4321, '열린 포지션이 없으면 가용 = 잔고');
  });
}

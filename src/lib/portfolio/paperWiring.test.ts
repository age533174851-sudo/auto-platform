// src/lib/portfolio/paperWiring.test.ts
//
// **지갑 MOCK 탭 배선이 조용히 틀리지 않는가.**
//
// 이 파일이 못 박는 사고 다섯
// ───────────────────────────
//   1. 읽기만 했는데 생긴 10,000짜리 계좌를 **총자산이라고 적는 것**
//   2. 조회 실패를 **'시작 안 함'으로 읽는 것** — 그러면 화면이 시작하기를
//      그리고, 누르면 있던 장부가 초기화된다
//   3. 포지션 조회 실패를 **0건으로 읽는 것** — 증거금이 0이 되고 총자산이
//      현금과 같아진다. 숫자는 그럴듯하고 틀렸다
//   4. 모의의 현물 칸을 **0으로 적는 것** — "현물을 다 팔았다"로 읽힌다
//   5. 환율이 없는데 **원화를 지어내는 것**
import { test, eq, assert } from '../../test/harness';
import {
  paperStartedOf, paperEquityOf, paperEnvWalletOf,
  PAPER_SEED_CHOICES,
} from './paperAccount';
import { paperPositionViews, readPaperEquity } from './paperRead';
import { paperPanelOf, seedOptionsOf } from './paperPanel';
import { amountOf } from './wallet';

/** `paper_accounts` 한 줄과 `paper_positions` 몇 줄을 가진 가짜 Supabase */
function fakeSb(opts: {
  account?: any;
  accountError?: string | null;
  positions?: any[];
  positionsError?: string | null;
}) {
  const calls: string[] = [];
  const writes: Array<{ table: string; op: string }> = [];
  const sb: any = {
    from(table: string) {
      calls.push(table);
      const b: any = {
        select() { return b; },
        eq() { return b; },
        order() { return b; },
        limit() { return b; },
        maybeSingle() {
          return Promise.resolve(opts.accountError
            ? { data: null, error: { message: opts.accountError } }
            : { data: opts.account ?? null, error: null });
        },
        // `paper_positions`는 await로 끝난다 — thenable로 흉내 낸다.
        then(res: any, rej: any) {
          const out = opts.positionsError
            ? { data: null, error: { message: opts.positionsError } }
            : { data: Array.isArray(opts.positions) ? opts.positions : [], error: null };
          return Promise.resolve(out).then(res, rej);
        },
        // **쓰기가 일어나면 기록한다.** 읽기 경로는 계좌를 만들면 안 된다.
        insert() { writes.push({ table, op: 'insert' }); return b; },
        upsert() { writes.push({ table, op: 'upsert' }); return b; },
        update() { writes.push({ table, op: 'update' }); return b; },
      };
      return b;
    },
  };
  return { sb, calls, writes };
}

const ACTIVE_ROW = {
  balance: 10_000, initial_balance: 10_000,
  total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0,
  started_at: '2026-08-01T00:00:00Z',
};

/** 읽기 경로가 자동으로 만들어 둔 빈 껍데기 — 흔적이 하나도 없다 */
const AUTO_ROW = {
  balance: 10_000, initial_balance: 10_000,
  total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0,
  started_at: null,
};

export function runPaperWiringTests() {
  // ── ① 시작 판정 ──
  test('paperStartedOf: started_at이 있으면 DECLARED', () => {
    const r = paperStartedOf(ACTIVE_ROW);
    eq(r.started, true); eq(r.code, 'DECLARED');
  });

  test('paperStartedOf: 흔적 없는 자동 생성 줄은 NONE — 시작으로 치지 않는다', () => {
    const r = paperStartedOf(AUTO_ROW);
    eq(r.started, false); eq(r.code, 'NONE');
  });

  test('paperStartedOf: started_at이 없어도 매매 흔적이 있으면 USED', () => {
    eq(paperStartedOf({ ...AUTO_ROW, trade_count: 3 }).code, 'USED');
    eq(paperStartedOf({ ...AUTO_ROW, total_fees: 1.2 }).code, 'USED');
    eq(paperStartedOf({ ...AUTO_ROW, total_pnl: -40 }).code, 'USED');
    eq(paperStartedOf({ ...AUTO_ROW, balance: 9_500 }).code, 'USED');
  });

  test('paperStartedOf: 줄이 없으면 NONE', () => {
    eq(paperStartedOf(null).started, false);
    eq(paperStartedOf(undefined).code, 'NONE');
  });

  // ── ② 고른 적 없는 종잣돈을 총자산으로 적지 않는다 ──
  test('paperEquityOf: 자동 생성된 10,000짜리 줄은 NOT_STARTED다', () => {
    const e = paperEquityOf({ account: AUTO_ROW, positions: [] });
    eq(e.state, 'NOT_STARTED');
    // **10,000이 새어 나오면 안 된다.**
    eq(e.totalEquity, null);
    eq(e.cash, null);
    eq(e.initialBalance, null);
  });

  test('paperEquityOf: 시작한 계좌는 ACTIVE이고 총자산이 나온다', () => {
    const e = paperEquityOf({ account: ACTIVE_ROW, positions: [] });
    eq(e.state, 'ACTIVE');
    eq(e.totalEquity, 10_000);
  });

  // ── ③ 지갑 환경 한 칸 ──
  test('paperEnvWalletOf: 시작 전에는 연결 0 · 모든 칸이 값 없음', () => {
    const w = paperEnvWalletOf(paperEquityOf({ account: null, positions: [] }), amountOf as any);
    eq(w.env, 'MOCK');
    eq(w.connections, 0);
    eq(w.total.value, null);
    eq(w.total.readiness, 'NOT_APPLICABLE');
  });

  test('paperEnvWalletOf: 모의의 현물은 0이 아니라 해당 없음이다', () => {
    const w = paperEnvWalletOf(paperEquityOf({ account: ACTIVE_ROW, positions: [] }), amountOf as any);
    eq(w.spot.readiness, 'NOT_APPLICABLE');
    // **0이면 "현물을 다 팔았다"로 읽힌다.**
    eq(w.spot.value, null);
    eq(w.total.value, 10_000);
    eq(w.futuresEquity.value, 10_000);
    eq(w.connections, 1);
  });

  test('paperEnvWalletOf: 현재가를 모르면 총자산 칸이 확인 불가다', () => {
    const e = paperEquityOf({
      account: ACTIVE_ROW,
      positions: [{ margin: 100, unrealizedPnl: null }],
    });
    eq(e.totalEquity, null);
    const w = paperEnvWalletOf(e, amountOf as any);
    eq(w.total.value, null);
    eq(w.total.readiness, 'FAILED');
    // 현금은 아는 값이므로 남는다.
    eq(w.futures.value, 10_000);
  });

  // ── ④ 포지션 평가 ──
  test('paperPositionViews: 시세를 못 받으면 평가손익이 null이다 — 0이 아니다', () => {
    const v = paperPositionViews(
      [{ symbol: 'BTCUSDT', side: 'LONG', fill_price: 100, quantity: 2, margin: 50 }],
      new Map(),
    );
    eq(v.length, 1);
    eq(v[0].markPrice, null);
    eq(v[0].unrealizedPnl, null);
    eq(v[0].roiPct, null);
  });

  test('paperPositionViews: SHORT는 부호가 뒤집힌다', () => {
    const marks = new Map([['BTCUSDT', 90]]);
    const long = paperPositionViews(
      [{ symbol: 'BTCUSDT', side: 'LONG', fill_price: 100, quantity: 2, margin: 50 }], marks);
    const short = paperPositionViews(
      [{ symbol: 'BTCUSDT', side: 'SHORT', fill_price: 100, quantity: 2, margin: 50 }], marks);
    eq(long[0].unrealizedPnl, -20);
    eq(short[0].unrealizedPnl, 20);
    eq(short[0].roiPct, 40);
  });

  // ── ⑤ 읽기 경로 ──
  test('readPaperEquity: 시작 안 한 사용자에게 계좌를 만들지 않는다', async () => {
    const { sb, writes, calls } = fakeSb({ account: null });
    const r = await readPaperEquity(sb, 'u1');
    eq(r.ok, true);
    eq(r.code, 'NOT_STARTED');
    // **읽기가 쓰기를 하면 안 된다.**
    eq(writes.length, 0);
    // 시작하지 않았으면 포지션도 읽지 않는다.
    assert(!calls.includes('paper_positions'), 'paper_positions를 읽지 않아야 한다');
  });

  test('readPaperEquity: 자동 생성된 빈 줄도 NOT_STARTED다', async () => {
    const { sb } = fakeSb({ account: AUTO_ROW });
    const r = await readPaperEquity(sb, 'u1');
    eq(r.code, 'NOT_STARTED');
    eq(r.equity.totalEquity, null);
  });

  test('readPaperEquity: 계좌 조회 실패를 "시작 안 함"으로 읽지 않는다', async () => {
    const { sb } = fakeSb({ accountError: 'permission denied' });
    const r = await readPaperEquity(sb, 'u1');
    eq(r.ok, false);
    eq(r.code, 'UNREADABLE');
    assert(String(r.error).includes('permission'), '이유가 남아야 한다');
  });

  test('readPaperEquity: 포지션 조회 실패를 0건으로 읽지 않는다', async () => {
    const { sb } = fakeSb({ account: ACTIVE_ROW, positionsError: 'timeout' });
    const r = await readPaperEquity(sb, 'u1');
    eq(r.code, 'UNREADABLE');
    // **여기서 ACTIVE + totalEquity=10,000이 나오면 조용히 틀린 것이다.**
    eq(r.equity.totalEquity, null);
    eq(r.equity.state, 'UNREADABLE');
  });

  test('readPaperEquity: 시세를 못 받은 포지션이 있으면 총자산을 만들지 않는다', async () => {
    const { sb } = fakeSb({
      account: ACTIVE_ROW,
      positions: [{ id: 'p1', symbol: 'BTCUSDT', side: 'LONG', fill_price: 100, quantity: 1, margin: 100 }],
    });
    const r = await readPaperEquity(sb, 'u1', { markPrice: async () => null });
    eq(r.code, 'OK');
    eq(r.equity.totalEquity, null);
    eq(r.equity.usedMargin, 100);
  });

  test('readPaperEquity: 시세가 있으면 총자산 = 현금 + 미실현', async () => {
    const { sb } = fakeSb({
      account: ACTIVE_ROW,
      positions: [{ id: 'p1', symbol: 'BTCUSDT', side: 'LONG', fill_price: 100, quantity: 2, margin: 100 }],
    });
    const r = await readPaperEquity(sb, 'u1', { markPrice: async () => 110 });
    eq(r.code, 'OK');
    eq(r.equity.unrealizedPnl, 20);
    eq(r.equity.totalEquity, 10_020);
  });

  // ── ⑥ 화면 판정 ──
  test('paperPanelOf: 아직 못 읽었으면 시작 버튼을 내주지 않는다', () => {
    const p = paperPanelOf({ paper: null, loaded: false });
    eq(p.code, 'LOADING');
    eq(p.canStart, false);
  });

  test('paperPanelOf: 조회 실패는 시작 안 함이 아니다 — 시작 버튼 없음', () => {
    const p = paperPanelOf({ paper: { state: 'UNREADABLE', error: 'boom' }, loaded: true });
    eq(p.code, 'UNREADABLE');
    // **여기서 true가 되면, 누르는 순간 있던 장부가 초기화된다.**
    eq(p.canStart, false);
    for (const r of p.rows) eq(r.readiness, 'FAILED');
  });

  test('paperPanelOf: paper 블록이 아예 없어도 시작 안 함으로 적지 않는다', () => {
    const p = paperPanelOf({ paper: null, loaded: true });
    eq(p.code, 'UNREADABLE');
    eq(p.canStart, false);
  });

  test('paperPanelOf: NOT_STARTED일 때만 시작 버튼이 나온다', () => {
    const p = paperPanelOf({ paper: { state: 'NOT_STARTED' }, loaded: true });
    eq(p.code, 'NOT_STARTED');
    eq(p.canStart, true);
    // 시작 전 값은 0이 아니라 '해당 없음'이다.
    for (const r of p.rows) { eq(r.usd, null); eq(r.readiness, 'NOT_APPLICABLE'); }
  });

  test('paperPanelOf: ACTIVE면 값이 줄로 나오고 못 구한 것만 확인 불가다', () => {
    const p = paperPanelOf({
      loaded: true,
      paper: {
        state: 'ACTIVE',
        equity: { totalEquity: null, cash: 10_000, usedMargin: 100, unrealizedPnl: null,
          realizedPnl: 25, totalFees: 3, note: '포지션 1건의 현재가를 못 읽었습니다' },
        today: { pnl: null, note: '오늘의 기준점이 없습니다' },
      },
    });
    eq(p.code, 'ACTIVE');
    eq(p.canStart, false);
    const by = (k: string) => p.rows.find(r => r.key === k)!;
    eq(by('cash').usd, 10_000);
    eq(by('cash').readiness, 'OK');
    eq(by('total').usd, null);
    eq(by('total').readiness, 'FAILED');
    assert(by('total').hint.includes('현재가'), '왜 못 구했는지가 남아야 한다');
    eq(by('realized').usd, 25);
    eq(by('today').readiness, 'FAILED');
    assert(by('today').hint.includes('기준점'), '오늘 손익이 없는 이유가 남아야 한다');
  });

  // ── ⑦ 시작 금액 + 원화 병기 ──
  test('seedOptionsOf: 환율이 없으면 원화를 만들지 않는다', () => {
    const opts = seedOptionsOf(PAPER_SEED_CHOICES, null);
    eq(opts.length, 3);
    eq(opts[0].usd, 10_000);
    assert(opts[0].usdText.includes('USDT'), '장부 통화는 USDT다');
    for (const o of opts) eq(o.krwText, null);
  });

  test('seedOptionsOf: 환율이 있으면 원화를 병기한다', () => {
    const fx: any = { currency: 'KRW', rate: 1300, source: 'test', asOf: 0 };
    const opts = seedOptionsOf([10_000], fx);
    assert(opts[0].krwText != null, '환율이 있으면 원화가 나온다');
    assert(String(opts[0].krwText).includes('13,000,000'), `13,000,000원이어야 한다: ${opts[0].krwText}`);
  });

  test('seedOptionsOf: 환율이 있어도 USDT 표기는 그대로 남는다', () => {
    const fx: any = { currency: 'KRW', rate: 1300, source: 'test', asOf: 0 };
    const opts = seedOptionsOf([50_000], fx);
    assert(opts[0].usdText.includes('50,000'), '원화가 USDT를 대체하지 않는다');
  });
}

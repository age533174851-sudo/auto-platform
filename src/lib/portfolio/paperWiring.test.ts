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
import { test, eq, assert, close } from '../../test/harness';
import {
  paperStartedOf, paperEquityOf, paperEnvWalletOf, paperAccountStateOf,
  PAPER_SEED_CHOICES,
} from './paperAccount';
import { paperPositionViews, readPaperEquity, missingColumnOf } from './paperRead';
import { totalEquityOf } from './wallet';
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

/** 071 이전 DB에서 온 줄 — `started_at` **칸 자체가 없다** */
const LEGACY_ROW = {
  balance: 10_000, initial_balance: 10_000,
  total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0,
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
    eq(r.code, 'NO_ACCOUNT');
    // **읽기가 쓰기를 하면 안 된다.**
    eq(writes.length, 0);
    // 시작하지 않았으면 포지션도 읽지 않는다.
    assert(!calls.includes('paper_positions'), 'paper_positions를 읽지 않아야 한다');
  });

  test('readPaperEquity: 자동 생성된 빈 줄은 GHOST다 — 총자산을 만들지 않는다', async () => {
    const { sb } = fakeSb({ account: AUTO_ROW });
    const r = await readPaperEquity(sb, 'u1');
    eq(r.code, 'GHOST');
    eq(r.equity.totalEquity, null);
    eq(r.equity.state, 'NOT_STARTED');
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
    eq(r.code, 'READY');
    eq(r.equity.totalEquity, null);
    eq(r.equity.usedMargin, 100);
  });

  test('readPaperEquity: 시세가 있으면 총자산 = 현금 + 미실현', async () => {
    const { sb } = fakeSb({
      account: ACTIVE_ROW,
      positions: [{ id: 'p1', symbol: 'BTCUSDT', side: 'LONG', fill_price: 100, quantity: 2, margin: 100 }],
    });
    const r = await readPaperEquity(sb, 'u1', { markPrice: async () => 110 });
    eq(r.code, 'READY');
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

  // ── ⑧ 계좌 없음 · 확인 못 함 · 잔고 0 ──
  //
  // 화면에서 실제로 섞였다: 모의 계좌가 없는데 `0.00000000 USDT`가
  // 총자산으로 뜨고, 바로 아래 줄에 "계좌가 없습니다"가 같이 있었다.
  test('paperAccountStateOf: 조회 실패는 UNREADABLE — 계좌 없음이 아니다', () => {
    const v = paperAccountStateOf({ ok: false, row: null });
    eq(v.code, 'UNREADABLE');
    assert(v.reason.includes('없다는 뜻이 아닙니다'), '이유가 남아야 한다');
  });

  test('paperAccountStateOf: 줄이 없으면 NO_ACCOUNT', () => {
    eq(paperAccountStateOf({ ok: true, row: null }).code, 'NO_ACCOUNT');
  });

  test('paperAccountStateOf: 잔고 0인 계좌는 READY다 — 0은 진짜 0이다', () => {
    const v = paperAccountStateOf({
      ok: true, hasStartedAtColumn: true,
      row: { ...ACTIVE_ROW, balance: 0 },
    });
    eq(v.code, 'READY');
  });

  test('paperEquityOf: 잔고 0인 계좌는 총자산 0을 적는다 — 확인 불가가 아니다', () => {
    const e = paperEquityOf({
      account: { ...ACTIVE_ROW, balance: 0 }, positions: [], hasStartedAtColumn: true,
    });
    eq(e.state, 'ACTIVE');
    eq(e.code, 'READY');
    eq(e.totalEquity, 0);
    eq(e.cash, 0);
  });

  test('paperAccountStateOf: 빈 껍데기는 GHOST — 총자산을 만들지 않는다', () => {
    eq(paperAccountStateOf({ ok: true, row: AUTO_ROW, hasStartedAtColumn: true }).code, 'GHOST');
  });

  test('paperAccountStateOf: 줄은 있는데 잔고를 못 읽으면 UNREADABLE이 먼저다', () => {
    // GHOST로 내려가면 시작하기가 뜨고, 누르면 살아 있던 장부가 초기화된다.
    const v = paperAccountStateOf({
      ok: true, hasStartedAtColumn: true,
      row: { balance: null, initial_balance: 10_000 },
    });
    eq(v.code, 'UNREADABLE');
  });

  // ── ⑨ 071 적용 전에도 계좌를 부정하지 않는다 ──
  test('paperAccountStateOf: started_at 칸이 없으면 있는 계좌를 READY로 둔다', () => {
    const v = paperAccountStateOf({ ok: true, row: LEGACY_ROW, hasStartedAtColumn: false });
    // **마이그레이션이 늦었다는 이유로 "계좌가 없다"고 말하지 않는다.**
    eq(v.code, 'READY');
    eq(v.startedCode, null);
    assert(v.reason.includes('started_at'), '왜 가리지 못했는지 남긴다');
  });

  test('readPaperEquity: 071 이전 DB에서도 계좌를 읽는다', async () => {
    const { sb } = fakeSb({ account: LEGACY_ROW, positions: [] });
    const r = await readPaperEquity(sb, 'u1');
    eq(r.ok, true);
    eq(r.code, 'READY');
    eq(r.schema.startedAt, false);
    eq(r.equity.totalEquity, 10_000);
  });

  test('readPaperEquity: started_at 칸이 있으면 그 사실이 schema에 남는다', async () => {
    const { sb } = fakeSb({ account: ACTIVE_ROW, positions: [] });
    const r = await readPaperEquity(sb, 'u1');
    eq(r.schema.startedAt, true);
  });

  test('missingColumnOf: PostgREST의 두 가지 답을 모두 알아본다', () => {
    eq(missingColumnOf({ code: '42703',
      message: 'column paper_accounts.started_at does not exist' }, 'started_at'), true);
    eq(missingColumnOf({ code: 'PGRST204',
      message: "Could not find the 'started_at' column of 'paper_accounts' in the schema cache" },
      'started_at'), true);
    // 다른 오류를 "칸이 없다"로 읽으면, 진짜 실패가 조용히 우회된다.
    eq(missingColumnOf({ code: '42501', message: 'permission denied' }, 'started_at'), false);
    eq(missingColumnOf(null, 'started_at'), false);
  });

  // ── ⑩ DB 오류 원문을 사용자 문장에 넣지 않는다 ──
  const RAW = 'column paper_accounts.started_at does not exist';

  test('readPaperEquity: 원문 오류가 사용자 문장(note)으로 새지 않는다', async () => {
    const { sb } = fakeSb({ accountError: RAW });
    const r = await readPaperEquity(sb, 'u1');
    eq(r.code, 'UNREADABLE');
    // 원문은 진단 칸에만 남는다.
    assert(String(r.error).includes('does not exist'), '진단에는 원문이 있어야 한다');
    assert(!r.equity.note.includes('does not exist'),
      `사용자 문장에 원문이 들어갔다: ${r.equity.note}`);
    assert(!r.equity.note.includes('column'),
      `사용자 문장에 원문이 들어갔다: ${r.equity.note}`);
  });

  test('paperPanelOf: 원문은 detail에만 · note에는 사람 문장만', () => {
    const p = paperPanelOf({ loaded: true, paper: { code: 'UNREADABLE', error: RAW } });
    eq(p.code, 'UNREADABLE');
    eq(p.canStart, false);
    assert(p.detail.includes(RAW), '자세히에는 원문이 있어야 한다');
    assert(!p.note.includes('column') && !p.note.includes('does not exist'),
      `메인 문장에 원문이 새어 나갔다: ${p.note}`);
  });

  test('paperPanelOf: 071 미적용도 진단에만 적는다', () => {
    const p = paperPanelOf({
      loaded: true,
      paper: { code: 'READY', schema: { startedAt: false }, equity: { cash: 10_000, totalEquity: 10_000 } },
    });
    eq(p.code, 'ACTIVE');
    assert(p.detail.includes('071'), '진단에는 남는다');
  });

  test('paperPanelOf: NO_ACCOUNT와 GHOST는 같은 문장을 쓰되 진단이 다르다', () => {
    const a = paperPanelOf({ loaded: true, paper: { code: 'NO_ACCOUNT' } });
    const b = paperPanelOf({ loaded: true, paper: { code: 'GHOST' } });
    eq(a.code, 'NOT_STARTED'); eq(b.code, 'NOT_STARTED');
    eq(a.headline, '모의투자 계좌가 없습니다');
    eq(a.note, b.note);
    assert(b.detail.includes('빈 계좌'), '빈 껍데기였다는 사실은 진단에 남는다');
    eq(a.detail, '');
  });

  test('paperPanelOf: 잔고 0인 계좌는 0으로 그린다 — 확인 불가가 아니다', () => {
    const p = paperPanelOf({
      loaded: true,
      paper: { code: 'READY', equity: { cash: 0, totalEquity: 0, usedMargin: 0,
        unrealizedPnl: 0, realizedPnl: 0, totalFees: 0 }, today: { pnl: 0 } },
    });
    eq(p.code, 'ACTIVE');
    const total = p.rows.find(r => r.key === 'total')!;
    eq(total.usd, 0);
    eq(total.readiness, 'OK');
  });

  // ── ⑪ 빈 합계를 0이라고 적지 않는다 ──
  test('totalEquityOf: 모든 칸이 해당 없음이면 총자산은 0이 아니다', () => {
    const na = { value: null, readiness: 'NOT_APPLICABLE' as const, text: '해당 없음' };
    const v = totalEquityOf('MOCK', [
      { id: 'MOCK-futures', label: '선물', env: 'MOCK', kind: 'futures', amount: na },
      { id: 'MOCK-spot', label: '현물', env: 'MOCK', kind: 'spot', amount: na },
    ] as any);
    // **여기서 0이 나오면 "계좌가 없습니다" 옆에 0.00000000이 뜬다.**
    eq(v.total, null);
    eq(v.complete, false);
    assert(v.note.includes('아직 없습니다'), `이유를 남긴다 — ${v.note}`);
  });

  test('totalEquityOf: 쓸 수 있는 칸이 하나라도 있으면 그대로 합산한다', () => {
    const ok = (n: number) => ({ value: n, readiness: 'OK' as const, text: String(n) });
    const na = { value: null, readiness: 'NOT_APPLICABLE' as const, text: '해당 없음' };
    const v = totalEquityOf('TESTNET', [
      { id: 't-f', label: '선물', env: 'TESTNET', kind: 'futures', amount: ok(54_009.72) },
      { id: 't-s', label: '현물', env: 'TESTNET', kind: 'spot', amount: na },
    ] as any);
    eq(v.complete, true);
    close(v.total!, 54_009.72, 1e-9);
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

// 손익은 **세는 것**이지 만드는 것이 아니다.
//
// 이 시험이 지키는 규칙은 하나다: 확인하지 못한 것을 0으로 적지 않는다.
// 0은 "손익이 0이었다"는 뜻이고, 그것은 조회 실패와 완전히 다른 사실이다.
import { test, assert, eq } from '../../test/harness';
import { summarizeBotPerf, perfView, PERF_ROW_CAP, isClosedStatus, isOpenStatus } from './paperBotPerf';

const BOT = 'btcusdt-1d-breakout';
const OTHER = 'ethusdt-1d-trend-follow';
const closed = (o: any = {}) => ({ strategy_id: BOT, status: 'CLOSED', realized_pnl: 10, margin: 100, ...o });

export function runPaperBotPerfTests() {
  // ── ① 못 읽은 것은 0이 아니다 ──
  test('★★ 조회가 실패하면 손익은 null이다 — 0으로 적지 않는다', () => {
    const p = summarizeBotPerf({ rows: null, botIds: [BOT], unreadable: true })[BOT];
    eq(p.unreadable, true);
    eq(p.realizedPnl, null);
    eq(p.roiPct, null);
    assert(p.realizedPnl !== 0, '못 읽은 손익을 0으로 적었습니다');
  });

  test('rows가 배열이 아니면 그것도 못 읽은 것이다', () => {
    eq(summarizeBotPerf({ rows: undefined, botIds: [BOT] })[BOT].unreadable, true);
  });

  // ── ② 거래가 없는 것과 손익 0은 다르다 ──
  test('★★ 청산이 하나도 없으면 손익은 null이다 — ±0이 아니다', () => {
    const p = summarizeBotPerf({ rows: [], botIds: [BOT] })[BOT];
    eq(p.unreadable, false);
    eq(p.closed, 0);
    eq(p.realizedPnl, null);
    assert(p.realizedPnl !== 0, '거래가 없는데 손익 0으로 적었습니다');
  });

  test('들고만 있고 닫은 적이 없어도 손익은 null이다', () => {
    const p = summarizeBotPerf({ rows: [{ strategy_id: BOT, status: 'OPEN' }], botIds: [BOT] })[BOT];
    eq(p.open, 1); eq(p.closed, 0); eq(p.realizedPnl, null);
  });

  // ── ③ 실제로 센다 ──
  test('닫힌 체결의 손익을 더한다', () => {
    const p = summarizeBotPerf({ rows: [closed({ realized_pnl: 12.5 }), closed({ realized_pnl: -4.5 })], botIds: [BOT] })[BOT];
    eq(p.closed, 2);
    eq(p.realizedPnl, 8);
  });

  test('Supabase NUMERIC이 문자열로 와도 센다', () => {
    const p = summarizeBotPerf({ rows: [closed({ realized_pnl: '12.5', margin: '100' })], botIds: [BOT] })[BOT];
    eq(p.realizedPnl, 12.5);
    eq(p.marginSum, 100);
  });

  test('수익률은 투입 증거금이 분모다', () => {
    const p = summarizeBotPerf({ rows: [closed({ realized_pnl: 25, margin: 100 })], botIds: [BOT] })[BOT];
    eq(p.roiPct, 25);
  });

  test('★★ 분모가 없으면 수익률을 만들어 내지 않는다', () => {
    for (const m of [null, 0, 'x']) {
      const p = summarizeBotPerf({ rows: [closed({ margin: m })], botIds: [BOT] })[BOT];
      eq(p.roiPct, null);
      assert(p.realizedPnl === 10, '손익까지 버리지는 않는다');
    }
  });

  // ── ④ 봇의 장부를 섞지 않는다 ──
  test('★★ 다른 봇의 체결을 더하지 않는다', () => {
    const t = summarizeBotPerf({
      rows: [closed({ realized_pnl: 10 }), closed({ strategy_id: OTHER, realized_pnl: 999 })],
      botIds: [BOT, OTHER] });
    eq(t[BOT].realizedPnl, 10);
    eq(t[OTHER].realizedPnl, 999);
  });

  test('모르는 봇의 행은 아무 봇에도 더하지 않는다', () => {
    const t = summarizeBotPerf({ rows: [closed({ strategy_id: 'ghost', realized_pnl: 999 })], botIds: [BOT] });
    eq(t[BOT].realizedPnl, null);
    eq(t.ghost, undefined);
  });

  test('strategy_id가 없는 행은 버린다 — 아무 봇의 것도 아니다', () => {
    eq(summarizeBotPerf({ rows: [closed({ strategy_id: null, realized_pnl: 999 })], botIds: [BOT] })[BOT].realizedPnl, null);
  });

  // ── ⑤ 불완전한 것을 완전한 것처럼 적지 않는다 ──
  test('★★ 손익이 안 적힌 청산 행은 0으로 더하지 않고 센다', () => {
    const p = summarizeBotPerf({ rows: [closed({ realized_pnl: 10 }), closed({ realized_pnl: null })], botIds: [BOT] })[BOT];
    eq(p.closed, 2);
    eq(p.pnlMissing, 1);
    eq(p.realizedPnl, 10);   // 아는 것만 더한다
  });

  test('★★ 행 상한에 걸리면 총계라고 적지 않는다', () => {
    const many = Array.from({ length: PERF_ROW_CAP }, () => closed({ realized_pnl: 1 }));
    eq(summarizeBotPerf({ rows: many, botIds: [BOT] })[BOT].partial, true);
    eq(summarizeBotPerf({ rows: many.slice(0, PERF_ROW_CAP - 1), botIds: [BOT] })[BOT].partial, false);
  });

  // ── ⑥ 칸은 언제나 생긴다 ──
  test('체결이 없는 봇도 칸은 생긴다 — 칸이 없는 것과 거래가 없는 것은 다르다', () => {
    const t = summarizeBotPerf({ rows: [], botIds: [BOT, OTHER] });
    assert(t[BOT] != null && t[OTHER] != null, '칸이 빠졌습니다');
  });

  test('청산 상태 이름 흔들림을 한 곳에서 흡수한다', () => {
    for (const s of ['CLOSED', 'closed', 'LIQUIDATED', 'STOPPED_OUT', 'TAKE_PROFIT']) assert(isClosedStatus(s), s);
    for (const s of ['OPEN', 'filled']) assert(isOpenStatus(s), s);
    for (const s of [null, '', 'PENDING']) { assert(!isClosedStatus(s), String(s)); assert(!isOpenStatus(s), String(s)); }
  });

  test('PENDING은 닫힌 것도 든 것도 아니다 — 어느 쪽으로도 세지 않는다', () => {
    const p = summarizeBotPerf({ rows: [{ strategy_id: BOT, status: 'PENDING' }], botIds: [BOT] })[BOT];
    eq(p.closed, 0); eq(p.open, 0);
  });
}

// ── 화면 문장 — 여기가 "가짜 수익률 금지"를 막는 자리다 ──
export function runPaperBotPerfViewTests() {
  const base = { closed: 0, open: 0, realizedPnl: null, marginSum: null, roiPct: null,
    pnlMissing: 0, partial: false, unreadable: false } as any;

  test('★★ 못 읽은 성과에 숫자를 적지 않는다', () => {
    for (const p of [null, undefined, { ...base, unreadable: true }]) {
      const v = perfView(p as any);
      eq(v.amount, '확인 불가');
      eq(v.measured, false);
      eq(v.rate, null);
      assert(!/\d/.test(v.amount), `숫자를 적었습니다: ${v.amount}`);
    }
  });

  test('★★ 청산이 없으면 "성과 데이터 없음"이다 — +0.00이 아니다', () => {
    const v = perfView({ ...base, closed: 0 });
    eq(v.amount, '성과 데이터 없음');
    eq(v.measured, false);
    assert(!v.amount.includes('0'), v.amount);
  });

  test('★★ 분모가 없으면 수익률 칸이 비어 있다 — 만들어 내지 않는다', () => {
    const v = perfView({ ...base, closed: 1, realizedPnl: 12.3, roiPct: null });
    eq(v.rate, null);
    eq(v.amount, '+12.30 USDT');
  });

  test('수익금과 수익률은 서로 다른 칸이다', () => {
    const v = perfView({ ...base, closed: 2, realizedPnl: 12.3, marginSum: 100, roiPct: 12.3 });
    eq(v.amount, '+12.30 USDT');
    eq(v.rate, '+12.3%');
    assert(!v.amount.includes('%'), '금액 칸에 %를 섞었습니다');
    assert(v.rate!.includes('%') && !v.rate!.includes('USDT'), '수익률 칸에 통화를 섞었습니다');
  });

  test('손실은 부호로 구분한다', () => {
    const v = perfView({ ...base, closed: 1, realizedPnl: -4.5, marginSum: 100, roiPct: -4.5 });
    eq(v.sign, 'down');
    assert(v.amount.startsWith('−'), v.amount);
  });

  test('정확히 0인 실현 손익은 측정된 값이다 — 없음과 다르다', () => {
    const v = perfView({ ...base, closed: 1, realizedPnl: 0 });
    eq(v.measured, true);
    eq(v.sign, 'flat');
    eq(v.amount, '+0.00 USDT');
  });

  test('미결제·미기록·부분집계는 단서로 적는다 — 합에 섞지 않는다', () => {
    const v = perfView({ ...base, closed: 3, open: 2, pnlMissing: 1, partial: true, realizedPnl: 5 });
    assert(v.note!.includes('미결제 2건'), v.note!);
    assert(v.note!.includes('손익 미기록 1건'), v.note!);
    assert(v.note!.includes('최근 분만 집계'), v.note!);
    eq(v.amount, '+5.00 USDT');
  });

  test('거래가 없는 봇에는 "청산된 거래 없음"을 덧붙인다', () => {
    eq(perfView({ ...base, closed: 0 }).note, '청산된 거래 없음');
  });

  // ── 불완전한 합계는 접힌 카드에서도 구별돼야 한다 ──
  //
  // 이 시험이 막는 것: **1000행 상한에 잘린 합계가 완전한 합계와 똑같이
  // 보이는 것.** 단서가 `note`와 `title`에만 있던 동안, 320px 화면에서
  // 두 카드는 글자 하나 다르지 않았다 (hover는 터치에 없다).

  test('완전한 합계에는 표식이 없다', () => {
    const v = perfView({ closed: 10, open: 0, realizedPnl: 142.5, marginSum: 1000,
      roiPct: 14.25, pnlMissing: 0, partial: false, unreadable: false });
    eq(v.incomplete, false);
    eq(v.mark, null);
    eq(v.measured, true);
  });

  test('★ 상한에 걸린 합계는 incomplete이고 표식이 있다', () => {
    const v = perfView({ closed: PERF_ROW_CAP, open: 0, realizedPnl: 5120.75,
      marginSum: 40000, roiPct: 12.8, pnlMissing: 0, partial: true, unreadable: false });
    eq(v.incomplete, true);
    assert(v.mark != null && v.mark.length <= 4, '표식이 없거나 너무 길다');
    assert((v.note ?? '').includes('최근 분만 집계'), '전체 문구가 사라졌다');
  });

  test('★ 손익이 안 적힌 행이 있으면 incomplete이다', () => {
    const v = perfView({ closed: 5, open: 0, realizedPnl: 10, marginSum: 100,
      roiPct: 10, pnlMissing: 2, partial: false, unreadable: false });
    eq(v.incomplete, true);
    assert(v.mark != null);
  });

  test('★ 미결제는 incomplete로 세지 않는다 — 실현 손익의 일부가 아니다', () => {
    const v = perfView({ closed: 5, open: 3, realizedPnl: 10, marginSum: 100,
      roiPct: 10, pnlMissing: 0, partial: false, unreadable: false });
    eq(v.incomplete, false);
    eq(v.mark, null);
    assert((v.note ?? '').includes('미결제 3건'), '미결제 안내는 그대로 남아야 한다');
  });

  test('★ 못 읽은 것은 불완전한 합계가 아니다 — 금액 자리가 이미 말한다', () => {
    const v = perfView(null);
    eq(v.amount, '확인 불가');
    eq(v.incomplete, false);
    eq(v.mark, null);
  });

  test('청산이 없으면 표식을 붙이지 않는다 — 합계 자체가 없다', () => {
    const v = perfView({ closed: 0, open: 0, realizedPnl: null, marginSum: null,
      roiPct: null, pnlMissing: 0, partial: false, unreadable: false });
    eq(v.amount, '성과 데이터 없음');
    eq(v.incomplete, false);
    eq(v.mark, null);
  });

}

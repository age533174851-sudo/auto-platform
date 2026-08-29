// src/lib/engine/paperExitSweep.test.ts
//
// **모의 자동매매가 진입만 하고 자동청산이 안 되고 있었다.**
//
// 서버에는 열린 `paper_positions`를 읽어 SL/TP를 보는 실행자가 없었다.
// 이 파일은 그 실행자의 판정과, **같은 포지션을 두 번 닫아 계좌가 두 번
// 반영되는 것**을 못 박는다.
import { test, eq, close, assert } from '../../test/harness';
import { paperExitPlan, NO_TIME_EXIT_HOURS } from './paperExitSweep';
import { closePaperPosition } from './paperStore';

const NOW = Date.parse('2026-08-28T12:00:00Z');
const HOUR = 3_600_000;

const pos = (o: Partial<any> = {}) => ({
  id: o.id ?? 'p1',
  symbol: o.symbol ?? 'BTCUSDT',
  side: o.side ?? 'LONG',
  fillPrice: o.fillPrice ?? 100_000,
  quantity: o.quantity ?? 0.01,
  stopLoss: 'stopLoss' in o ? o.stopLoss : 98_000,
  takeProfit: 'takeProfit' in o ? o.takeProfit : 104_000,
  liquidationPrice: o.liquidationPrice ?? 50_000,
  openedAt: o.openedAt ?? NOW - HOUR,
});

function fakeDb(opts: { settleFails?: boolean } = {}) {
  const mk = (id: string, user: string) => ({
    id, user_id: user, side: 'LONG', status: 'open',
    entry_price: 100_000, fill_price: 100_000, quantity: 0.01,
    notional: 1_000, leverage: 10, margin: 100, entry_fee: 0.5,
    stop_loss: 98_000, take_profit: 104_000, liquidation_price: 50_000,
    opened_at: new Date(NOW - HOUR).toISOString(),
  } as any);
  const state = {
    positions: { p1: mk('p1', 'u1'), p2: mk('p2', 'u1'), pB: mk('pB', 'u2') } as Record<string, any>,
    accounts: {
      u1: { user_id: 'u1', balance: 10_000, total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0 },
      u2: { user_id: 'u2', balance: 10_000, total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0 },
    } as Record<string, any>,
    /** 정산 함수를 몇 번이나 실제로 적용했나 */
    settlements: 0,
    /** JS가 직접 연 표 (rpc는 여기 안 든다) */
    tablesTouched: [] as string[],
  };
  const sb: any = {
    from(table: string) {
      state.tablesTouched.push(table);
      const b: any = {
        _guards: [] as Array<{ col: string; val: any }>, _patch: null as any,
        select() { return b; },
        update(patch: any) { b._patch = patch; return b; },
        eq(col: string, val: any) { b._guards.push({ col, val }); return b; },
        _g(col: string) { return b._guards.find((x: any) => x.col === col)?.val; },
        maybeSingle() {
          if (table === 'paper_positions') {
            const r = state.positions[String(b._g('id'))];
            return Promise.resolve({ data: r ? { ...r } : null, error: null });
          }
          const a = state.accounts[String(b._g('user_id'))];
          return Promise.resolve({ data: a ? { ...a } : null, error: null });
        },
        then(res: any, rej: any) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
      };
      return b;
    },
    // ── 정산 함수: 하나의 트랜잭션 ──
    async rpc(fn: string, args: any) {
      if (fn !== 'paper_settle_close') return { data: null, error: { message: `모르는 함수 ${fn}` } };
      const row = state.positions[String(args.p_position_id)];
      // ① 선점 — status='open'인 줄만
      if (!row || row.status !== 'open') {
        return { data: [{ settled: false, owner_id: null, settled_pnl: null, settled_pnl_pct: null }], error: null };
      }
      const before = { ...row };
      state.positions[row.id] = {
        ...row, status: 'closed', exit_price: args.p_exit_price,
        exit_reason: args.p_exit_reason, exit_fee: args.p_exit_fee,
        gross_pnl: args.p_gross_pnl, realized_pnl: args.p_realized_pnl,
        pnl_pct: args.p_pnl_pct, closed_at: new Date().toISOString(),
      };
      // ② 정산 — **읽어서 덮는 것이 아니라 더한다**
      const acct = state.accounts[String(row.user_id)];
      if (opts.settleFails || !acct) {
        // 되돌린다. 포지션이 닫힌 채로 남지 않는다.
        state.positions[row.id] = before;
        return { data: null, error: { message: '계좌를 정산하지 못했습니다 — 청산을 되돌립니다' } };
      }
      acct.balance += args.p_gross_pnl - args.p_exit_fee;
      acct.total_pnl += args.p_realized_pnl;
      acct.total_fees += args.p_exit_fee;
      acct.trade_count += 1;
      acct.win_count += args.p_realized_pnl > 0 ? 1 : 0;
      state.settlements += 1;
      return { data: [{ settled: true, owner_id: row.user_id,
        settled_pnl: args.p_realized_pnl, settled_pnl_pct: args.p_pnl_pct }], error: null };
    },
  };
  return { sb, state };
}

export function runPaperExitSweepTests() {
  console.log('\n🧪 모의 포지션 청산 감시 (서버가 손절을 본다)');

  // ══ ① LONG ══
  test('LONG 손절: 현재가가 손절선 아래면 닫는다', () => {
    const p = paperExitPlan({ positions: [pos()] as any, marks: new Map([['BTCUSDT', 97_900]]), nowMs: NOW });
    eq(p.actions.length, 1);
    eq(p.actions[0].exitReason, 'SL');
    eq(p.actions[0].positionId, 'p1');
  });

  test('LONG 익절: 현재가가 익절선 위면 닫는다', () => {
    const p = paperExitPlan({ positions: [pos()] as any, marks: new Map([['BTCUSDT', 104_500]]), nowMs: NOW });
    eq(p.actions.length, 1);
    eq(p.actions[0].exitReason, 'TP');
  });

  // ══ ② SHORT — 부호가 뒤집힌다 ══
  test('SHORT 손절: 현재가가 손절선 위면 닫는다', () => {
    const s = pos({ id: 's1', side: 'SHORT', stopLoss: 102_000, takeProfit: 96_000, liquidationPrice: 150_000 });
    const p = paperExitPlan({ positions: [s] as any, marks: new Map([['BTCUSDT', 102_100]]), nowMs: NOW });
    eq(p.actions.length, 1);
    eq(p.actions[0].exitReason, 'SL');
  });

  test('SHORT 익절: 현재가가 익절선 아래면 닫는다', () => {
    const s = pos({ id: 's1', side: 'SHORT', stopLoss: 102_000, takeProfit: 96_000, liquidationPrice: 150_000 });
    const p = paperExitPlan({ positions: [s] as any, marks: new Map([['BTCUSDT', 95_900]]), nowMs: NOW });
    eq(p.actions.length, 1);
    eq(p.actions[0].exitReason, 'TP');
  });

  // ══ ③ 안 닿으면 안 닫는다 ══
  test('손절·익절 어느 쪽도 안 닿으면 아무것도 닫지 않는다', () => {
    const p = paperExitPlan({ positions: [pos()] as any, marks: new Map([['BTCUSDT', 100_500]]), nowMs: NOW });
    eq(p.actions.length, 0);
    eq(p.unknownMarks, 0);
  });

  // ══ ④ 시세를 모르면 건드리지 않는다 ══
  test('현재가를 못 구하면 그 포지션은 판단하지 않는다 — 0으로 읽지 않는다', () => {
    const p = paperExitPlan({ positions: [pos()] as any, marks: new Map(), nowMs: NOW });
    // 0으로 읽었으면 손절에 걸려 닫혔을 것이다.
    eq(p.actions.length, 0);
    eq(p.unknownMarks, 1);
    eq(p.unknownSymbols.join(','), 'BTCUSDT');
    assert(p.reason.includes('못 구해'), `왜 미뤘는지 적는다 — ${p.reason}`);
  });

  test('0이나 음수 시세는 없는 것으로 본다', () => {
    for (const bad of [0, -1, NaN]) {
      const p = paperExitPlan({ positions: [pos()] as any, marks: new Map([['BTCUSDT', bad]]), nowMs: NOW });
      eq(p.actions.length, 0);
      eq(p.unknownMarks, 1);
    }
  });

  test('한 심볼을 못 구해도 다른 심볼은 본다', () => {
    const p = paperExitPlan({
      positions: [pos({ id: 'a' }), pos({ id: 'b', symbol: 'ETHUSDT', fillPrice: 4_000, stopLoss: 3_900, takeProfit: 4_200, liquidationPrice: 2_000 })] as any,
      marks: new Map([['ETHUSDT', 3_800]]), nowMs: NOW,
    });
    eq(p.actions.length, 1);
    eq(p.actions[0].positionId, 'b');
    eq(p.unknownMarks, 1);
  });

  // ══ ⑤ 시간청산을 임의로 켜지 않는다 ══
  test('보유시간이 길어도 시간으로 닫지 않는다 — 명시된 정책이 없다', () => {
    const old = pos({ openedAt: NOW - 400 * HOUR });
    const p = paperExitPlan({ positions: [old] as any, marks: new Map([['BTCUSDT', 100_500]]), nowMs: NOW });
    eq(p.actions.length, 0);
  });

  test('시간청산 기본값은 꺼진 상태다', () => {
    assert(NO_TIME_EXIT_HOURS === Number.POSITIVE_INFINITY, '기본은 시간으로 닫지 않는다');
  });

  test('목록이 비면 아무것도 하지 않는다', () => {
    eq(paperExitPlan({ positions: [], marks: new Map(), nowMs: NOW }).actions.length, 0);
    eq(paperExitPlan({ positions: null, marks: null, nowMs: NOW }).scanned, 0);
  });

  // ══ ⑥ **청산과 정산은 하나다** ══
  //
  // 예전 구조: 조건부 UPDATE로 선점 → 계좌를 읽음 → 읽은 값 + 손익을 씀.
  //   · 포지션만 닫히고 계좌 갱신이 실패하면 되돌릴 수 없었다
  //   · **다른** 두 포지션이 동시에 닫히면 한쪽 손익이 사라졌다
  //
  // 지금은 `paper_settle_close`(마이그레이션 072) 하나로 나간다. 아래
  // 가짜 DB는 그 함수의 계약을 그대로 흉내 낸다 — 선점에 성공한 줄에만
  // **증분**을 적용하고, 정산이 실패하면 포지션 UPDATE까지 되돌린다.
  //
  // 이 파일이 증명하는 것은 **JS가 그 계약대로 부른다**는 것이다.
  // SQL 쪽 성질(status='open' 선점 · balance = balance + delta ·
  // RAISE EXCEPTION · RETURNING user_id)은
  // `scripts/check-mock-single-source.mjs` ⑧이 CI에서 못 박는다.

  test('순차로 두 번 청산하면 두 번째는 이미 청산됨이다', async () => {
    const { sb, state } = fakeDb();
    const a = await closePaperPosition(sb, 'p1', 97_900, 'SL');
    const b = await closePaperPosition(sb, 'p1', 97_900, 'SL');
    eq(a.ok, true);
    eq(b.ok, false);
    eq(state.settlements, 1);
  });

  test('**같은 포지션**을 동시에 두 번 닫아도 정산은 한 번이다', async () => {
    const { sb, state } = fakeDb();
    const [a, b] = await Promise.all([
      closePaperPosition(sb, 'p1', 97_900, 'SL'),
      closePaperPosition(sb, 'p1', 97_900, 'SL'),
    ]);
    eq([a, b].filter(r => r.ok).length, 1, '한 쪽만 이겨야 한다');
    eq(state.settlements, 1);
    eq(state.accounts.u1.trade_count, 1);
  });

  test('**서로 다른 두 포지션**을 동시에 닫으면 두 손익이 모두 남는다', async () => {
    // 이게 선점만으로는 못 막던 자리다. 두 포지션은 서로 다르므로 둘 다
    // 선점에 성공하고, 예전 구조에서는 **둘 다 옛 balance를 읽고** 각자
    // 덮어써서 한쪽 손익이 사라졌다.
    const { sb, state } = fakeDb();
    const before = state.accounts.u1.balance;
    const [a, b] = await Promise.all([
      closePaperPosition(sb, 'p1', 97_900, 'SL'),
      closePaperPosition(sb, 'p2', 104_500, 'TP'),
    ]);
    eq(a.ok, true);
    eq(b.ok, true);
    eq(state.settlements, 2, '둘 다 정산돼야 한다');
    eq(state.accounts.u1.trade_count, 2);
    close(state.accounts.u1.total_pnl, (a.realizedPnl as number) + (b.realizedPnl as number), 1e-6);

    // 잔고는 **차례로 닫았을 때와 같아야 한다.** 수수료 공식을 여기서 다시
    // 쓰지 않는다 — 한쪽 손익이 사라졌는지만 보면 되고, 그 답은 순차 결과와
    // 같은지로 나온다.
    const seq = fakeDb();
    await closePaperPosition(seq.sb, 'p1', 97_900, 'SL');
    await closePaperPosition(seq.sb, 'p2', 104_500, 'TP');
    close(state.accounts.u1.balance, seq.state.accounts.u1.balance, 1e-6);
    assert(state.accounts.u1.balance > before,
      `두 손익이 모두 반영되면 잔고가 움직인다 — ${before} → ${state.accounts.u1.balance}`);
  });

  test('정산이 실패하면 포지션도 닫히지 않는다 — 반쯤 닫힌 상태를 만들지 않는다', async () => {
    const { sb, state } = fakeDb({ settleFails: true });
    const r = await closePaperPosition(sb, 'p1', 97_900, 'SL');
    eq(r.ok, false);
    eq(state.positions.p1.status, 'open', '되돌아가서 다음 회차가 다시 집을 수 있어야 한다');
    eq(state.settlements, 0);
    eq(state.accounts.u1.balance, 10_000);
    assert(String(r.error).includes('기록하지 못했습니다'), `이유를 남긴다 — ${r.error}`);
  });

  test('선점에 실패하면 계좌를 아예 건드리지 않는다', async () => {
    const { sb, state } = fakeDb();
    state.positions.p1.status = 'closed';   // 다른 실행기가 이미 닫았다
    const r = await closePaperPosition(sb, 'p1', 97_900, 'SL');
    eq(r.ok, false);
    eq(state.settlements, 0);
    eq(state.accounts.u1.balance, 10_000);
  });

  test('JS는 paper_accounts를 직접 쓰지 않는다 — 정산 함수만 계좌를 움직인다', async () => {
    const { sb, state } = fakeDb();
    await closePaperPosition(sb, 'p1', 97_900, 'SL');
    // 계좌를 읽는 것까지 막지는 않는다. **쓰기 경로가 없어야** 한다.
    eq(state.settlements, 1, '정산은 함수를 통해서만 일어난다');
    eq(state.accounts.u1.trade_count, 1);
  });

  test('정산 대상은 포지션 줄의 주인이다 — 다른 사용자의 계좌는 그대로다', async () => {
    const { sb, state } = fakeDb();
    const r = await closePaperPosition(sb, 'pB', 97_900, 'SL');   // 주인은 u2
    eq(r.ok, true);
    eq(state.accounts.u2.trade_count, 1);
    eq(state.accounts.u1.trade_count, 0, '남의 계좌를 건드리지 않는다');
    eq(state.accounts.u1.balance, 10_000);
  });
}

// ══ ⑦ **워커가 다시 떠도 열린 포지션을 다시 본다** ══
//
// 판정기에 "이미 봤다" 기억이 있으면, 워커가 재시작한 뒤 예전 포지션이
// 감시 밖으로 빠진다. 손절이 걸린 채로 방치되는 길이다.
// 그래서 이 함수는 **상태를 갖지 않는다** — 같은 입력이면 몇 번을 불러도
// 같은 답이다.
export function runPaperExitSweepMoreTests() {
  console.log('\n🧪 모의 청산 — 재시작 · 사용자 격리 · 거래소 무접촉');

  test('워커가 재시작해도 기존 열린 포지션을 다시 감시한다 — 판정기에 기억이 없다', () => {
    const open = [pos()] as any;
    const marks = new Map([['BTCUSDT', 97_900]]);
    const first = paperExitPlan({ positions: open, marks, nowMs: NOW });
    // 프로세스가 죽었다 다시 떴다고 치자. 같은 목록·같은 시세.
    const second = paperExitPlan({ positions: open, marks, nowMs: NOW + 60_000 });
    eq(first.actions.length, 1);
    eq(second.actions.length, 1, '재시작 뒤에도 같은 포지션을 다시 집는다');
    eq(second.actions[0].positionId, 'p1');
  });

  test('한 번 스윕했다고 다음 회차에 안 보는 일이 없다 — 안 닿았던 것도 계속 본다', () => {
    const open = [pos()] as any;
    const hold = paperExitPlan({ positions: open, marks: new Map([['BTCUSDT', 100_500]]), nowMs: NOW });
    eq(hold.actions.length, 0);
    // 다음 회차에 값이 손절선을 깨면 그때 닫힌다.
    const hit = paperExitPlan({ positions: open, marks: new Map([['BTCUSDT', 97_000]]), nowMs: NOW + 60_000 });
    eq(hit.actions.length, 1);
    eq(hit.actions[0].exitReason, 'SL');
  });

  // ══ ⑧ 사용자 격리 · 장부 격리 ══
  //
  // 정산 대상은 **그 포지션의 주인**이다. 부르는 쪽이 준 id가 아니다 —
  // 함수가 `RETURNING user_id INTO`로 직접 집는다.
  test('A의 포지션을 닫으면 A의 계좌만 움직인다 — B는 그대로다', async () => {
    const { sb, state } = fakeDb();
    const r = await closePaperPosition(sb, 'p1', 97_900, 'SL');   // 주인 u1
    eq(r.ok, true);
    eq(state.accounts.u1.trade_count, 1, 'A의 매매횟수가 늘어야 한다');
    eq(state.accounts.u2.trade_count, 0, 'B의 장부는 건드리지 않는다');
    eq(state.accounts.u2.balance, 10_000);
    eq(state.positions.pB.status, 'open', 'B의 포지션은 열린 채로 남는다');
  });

  test('두 사용자의 포지션이 같이 걸려도 각자 자기 계좌에만 적힌다', async () => {
    const { sb, state } = fakeDb();
    const plan = paperExitPlan({
      positions: [
        { id: 'p1', symbol: 'BTCUSDT', side: 'LONG', fillPrice: 100_000, quantity: 0.01,
          stopLoss: 98_000, takeProfit: 104_000, liquidationPrice: 50_000, openedAt: NOW - HOUR },
        { id: 'pB', symbol: 'BTCUSDT', side: 'LONG', fillPrice: 100_000, quantity: 0.01,
          stopLoss: 98_000, takeProfit: 104_000, liquidationPrice: 50_000, openedAt: NOW - HOUR },
      ] as any,
      marks: new Map([['BTCUSDT', 97_900]]), nowMs: NOW,
    });
    eq(plan.actions.length, 2);
    await Promise.all(plan.actions.map(a =>
      closePaperPosition(sb, a.positionId as string, 97_900, a.exitReason as any)));
    eq(state.accounts.u1.trade_count, 1);
    eq(state.accounts.u2.trade_count, 1);
    eq(state.settlements, 2);
  });

  // ══ ⑨ PAPER / TESTNET / LIVE 격리 ══
  test('모의 청산은 paper_ 장부만 건드린다 — 실전 주문·포지션 표를 열지 않는다', async () => {
    const { sb, state } = fakeDb();
    await closePaperPosition(sb, 'p1', 97_900, 'SL');
    assert(state.tablesTouched.length > 0, '표를 하나는 열었어야 한다');
    const stray = state.tablesTouched.filter(t => !t.startsWith('paper_'));
    eq(stray.join(','), '', `모의 청산이 다른 장부를 열었다 — ${stray.join(',')}`);
  });

  test('모의 청산의 유일한 입출력 통로는 넘겨받은 sb다 — 거래소로 나갈 손이 없다', async () => {
    // **왜 global fetch를 가로채지 않는가**
    //
    // 처음엔 fetch를 stub해서 "0회"를 세려 했다. 그런데 이 하네스는 여러
    // 테스트의 비동기가 겹쳐 돌아서, 다른 스위트가 이미 띄워 둔 klines
    // 요청이 내 stub에 잡혔다. 남의 호출을 내 증거로 세는 테스트는
    // **아무것도 증명하지 못한다** — 통과해도 거짓이고 실패해도 거짓이다.
    //
    // 대신 진짜 계약을 본다: `closePaperPosition`은 인자로 받은 sb 말고는
    // 바깥과 이어진 손이 없다. 그래서 이 sb가 무엇을 열었는지만 보면
    // 이 함수가 무엇을 건드렸는지 전부다. 소스 수준의 "거래소 어댑터
    // import 없음"은 `scripts/check-mock-single-source.mjs`가 CI에서 못 박는다.
    const { sb, state } = fakeDb();
    const plan = paperExitPlan({
      positions: [{ id: 'p1', symbol: 'BTCUSDT', side: 'LONG', fillPrice: 100_000, quantity: 0.01,
        stopLoss: 98_000, takeProfit: 104_000, liquidationPrice: 50_000, openedAt: NOW - HOUR }] as any,
      marks: new Map([['BTCUSDT', 97_900]]), nowMs: NOW,
    });
    const r = await closePaperPosition(sb, plan.actions[0].positionId as string, 97_900, 'SL');
    eq(r.ok, true);
    const opened = Array.from(new Set(state.tablesTouched)).sort().join(',');
    eq(opened, 'paper_positions', `모의 청산이 연 표 — ${opened}`);
  });

  // ══ ⑩ DB를 못 읽으면 아무것도 닫지 않는다 ══
  test('포지션을 읽지 못하면 닫지 않는다 — 정산도 없다', async () => {
    let settlements = 0;
    const sb: any = {
      from() {
        const b: any = {
          select() { return b; }, update() { return b; }, eq() { return b; },
          maybeSingle() { return Promise.resolve({ data: null, error: { message: 'db down' } }); },
          then(res: any, rej: any) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
        };
        return b;
      },
      rpc() { settlements += 1; return Promise.resolve({ data: null, error: null }); },
    };
    const r = await closePaperPosition(sb, 'p1', 97_900, 'SL');
    eq(r.ok, false);
    eq(settlements, 0, 'DB를 못 읽었는데 정산을 부르면 안 된다');
  });

  test('정산 함수가 없으면 닫혔다고 적지 않는다 — 마이그레이션 전에도 거짓을 쓰지 않는다', async () => {
    const { sb, state } = fakeDb();
    sb.rpc = () => Promise.resolve({ data: null, error: { message: 'function paper_settle_close does not exist' } });
    const r = await closePaperPosition(sb, 'p1', 97_900, 'SL');
    eq(r.ok, false);
    eq(state.positions.p1.status, 'open');
    eq(state.accounts.u1.balance, 10_000);
  });
}

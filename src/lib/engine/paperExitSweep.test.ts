// src/lib/engine/paperExitSweep.test.ts
//
// **모의 자동매매가 진입만 하고 자동청산이 안 되고 있었다.**
//
// 서버에는 열린 `paper_positions`를 읽어 SL/TP를 보는 실행자가 없었다.
// 이 파일은 그 실행자의 판정과, **같은 포지션을 두 번 닫아 계좌가 두 번
// 반영되는 것**을 못 박는다.
import { test, eq, assert } from '../../test/harness';
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

  // ══ ⑥ **같은 포지션을 두 번 닫아도 계좌는 한 번만** ══
  //
  // 예전 closePaperPosition은 read → status 확인 → update → 계좌 반영이라,
  // 두 실행기가 동시에 집으면 둘 다 'open'을 보고 **둘 다 계좌를 더했다.**
  function fakeSb() {
    const state = {
      position: {
        id: 'p1', user_id: 'u1', side: 'LONG', status: 'open',
        entry_price: 100_000, fill_price: 100_000, quantity: 0.01,
        notional: 1_000, leverage: 10, margin: 100, entry_fee: 0.5,
        stop_loss: 98_000, take_profit: 104_000, liquidation_price: 50_000,
        opened_at: new Date(NOW - HOUR).toISOString(),
      } as any,
      account: { user_id: 'u1', balance: 10_000, total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0 } as any,
      accountUpdates: 0,
    };
    const sb: any = {
      from(table: string) {
        const b: any = {
          _patch: null as any, _guards: [] as Array<{ col: string; val: any }>,
          select() { return b; },
          update(patch: any) { b._patch = patch; return b; },
          eq(col: string, val: any) { b._guards.push({ col, val }); return b; },
          maybeSingle() {
            if (table === 'paper_positions') return Promise.resolve({ data: { ...state.position }, error: null });
            return Promise.resolve({ data: { ...state.account }, error: null });
          },
          then(res: any, rej: any) {
            let out: any = { data: null, error: null };
            if (b._patch && table === 'paper_positions') {
              // **조건부 UPDATE를 진짜로 흉내 낸다.** status 조건이 붙어
              // 있으면 지금 값과 같을 때만 쓰고, 아니면 0줄이다.
              const g = b._guards.find(x => x.col === 'status');
              const ok = g == null || state.position.status === g.val;
              if (ok) { state.position = { ...state.position, ...b._patch }; out = { data: [{ id: 'p1' }], error: null }; }
              else out = { data: [], error: null };
            } else if (b._patch && table === 'paper_accounts') {
              state.accountUpdates += 1;
              state.account = { ...state.account, ...b._patch };
              out = { data: [{ user_id: 'u1' }], error: null };
            }
            return Promise.resolve(out).then(res, rej);
          },
        };
        return b;
      },
    };
    return { sb, state };
  }

  test('순차로 두 번 청산하면 두 번째는 이미 청산됨이다', async () => {
    const { sb, state } = fakeSb();
    const a = await closePaperPosition(sb, 'p1', 97_900, 'SL');
    const b = await closePaperPosition(sb, 'p1', 97_900, 'SL');
    eq(a.ok, true);
    eq(b.ok, false);
    eq(state.accountUpdates, 1);
  });

  test('**동시에** 두 실행기가 같은 포지션을 집어도 계좌는 한 번만 반영된다', async () => {
    // 이게 진짜 경쟁이다. 순차 호출은 예전 코드(read → status 확인)도
    // 막았다 — **둘 다 읽은 뒤에 둘 다 쓰는 것**이 못 막던 자리다.
    //
    // `Promise.all`로 두 호출을 겹치면 둘 다 status='open'을 읽은 뒤에
    // 각자 update를 시도한다. 선점이 없으면 둘 다 성공하고 계좌가 두 번
    // 반영된다 — 잔고·손익·수수료·매매횟수가 전부 두 배다.
    const { sb, state } = fakeSb();
    const [a, b] = await Promise.all([
      closePaperPosition(sb, 'p1', 97_900, 'SL'),
      closePaperPosition(sb, 'p1', 97_900, 'SL'),
    ]);
    const okCount = [a, b].filter(r => r.ok).length;
    eq(okCount, 1, '한 쪽만 이겨야 한다');
    // **여기가 핵심이다.** 2가 나오면 계좌가 두 배로 움직인 것이다.
    eq(state.accountUpdates, 1);
    eq(state.account.trade_count, 1);
  });

  test('선점에 실패하면 계좌를 아예 건드리지 않는다', async () => {
    const { sb, state } = fakeSb();
    state.position.status = 'closed';   // 다른 실행기가 이미 닫았다
    const r = await closePaperPosition(sb, 'p1', 97_900, 'SL');
    eq(r.ok, false);
    eq(state.accountUpdates, 0);
  });

  test('청산 기록이 실패하면 성공으로 적지 않는다', async () => {
    const sb: any = {
      from(table: string) {
        const b: any = {
          select() { return b; }, update() { return b; }, eq() { return b; },
          maybeSingle() {
            return Promise.resolve({ data: table === 'paper_positions' ? {
              id: 'p1', user_id: 'u1', side: 'LONG', status: 'open',
              entry_price: 100_000, fill_price: 100_000, quantity: 0.01,
              notional: 1_000, leverage: 10, margin: 100, entry_fee: 0.5,
              liquidation_price: 50_000, opened_at: new Date(NOW - HOUR).toISOString(),
            } : {}, error: null });
          },
          then(res: any, rej: any) {
            return Promise.resolve({ data: null, error: { message: 'write denied' } }).then(res, rej);
          },
        };
        return b;
      },
    };
    const r = await closePaperPosition(sb, 'p1', 97_900, 'SL');
    eq(r.ok, false);
    assert(String(r.error).includes('기록하지 못했습니다'), `이유를 남긴다 — ${r.error}`);
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
  // 청산은 **그 포지션의 주인** 계좌에 적힌다. 부르는 쪽이 준 id가 아니다.
  function multiUserSb() {
    const state = {
      positions: {
        pA: { id: 'pA', user_id: 'userA', side: 'LONG', status: 'open',
              entry_price: 100_000, fill_price: 100_000, quantity: 0.01,
              notional: 1_000, leverage: 10, margin: 100, entry_fee: 0.5,
              stop_loss: 98_000, take_profit: 104_000, liquidation_price: 50_000,
              opened_at: new Date(NOW - HOUR).toISOString() } as any,
        pB: { id: 'pB', user_id: 'userB', side: 'LONG', status: 'open',
              entry_price: 100_000, fill_price: 100_000, quantity: 0.01,
              notional: 1_000, leverage: 10, margin: 100, entry_fee: 0.5,
              stop_loss: 98_000, take_profit: 104_000, liquidation_price: 50_000,
              opened_at: new Date(NOW - HOUR).toISOString() } as any,
      } as Record<string, any>,
      accounts: {
        userA: { user_id: 'userA', balance: 10_000, total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0 },
        userB: { user_id: 'userB', balance: 10_000, total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0 },
      } as Record<string, any>,
      /** **어떤 표를 건드렸나.** 여기에 paper_ 아닌 이름이 들어오면 사고다 */
      tablesTouched: [] as string[],
    };
    const sb: any = {
      from(table: string) {
        state.tablesTouched.push(table);
        const b: any = {
          _patch: null as any, _guards: [] as Array<{ col: string; val: any }>,
          select() { return b; },
          update(patch: any) { b._patch = patch; return b; },
          eq(col: string, val: any) { b._guards.push({ col, val }); return b; },
          _guard(col: string) { return b._guards.find((x: any) => x.col === col)?.val; },
          maybeSingle() {
            if (table === 'paper_positions') {
              const row = state.positions[String(b._guard('id'))];
              return Promise.resolve({ data: row ? { ...row } : null, error: null });
            }
            const acct = state.accounts[String(b._guard('user_id'))];
            return Promise.resolve({ data: acct ? { ...acct } : null, error: null });
          },
          then(res: any, rej: any) {
            let out: any = { data: null, error: null };
            if (b._patch && table === 'paper_positions') {
              const id = String(b._guard('id'));
              const want = b._guards.find((x: any) => x.col === 'status')?.val;
              const row = state.positions[id];
              if (row && (want == null || row.status === want)) {
                state.positions[id] = { ...row, ...b._patch };
                out = { data: [{ id }], error: null };
              } else out = { data: [], error: null };
            } else if (b._patch && table === 'paper_accounts') {
              const u = String(b._guard('user_id'));
              if (state.accounts[u]) state.accounts[u] = { ...state.accounts[u], ...b._patch };
              out = { data: [{ user_id: u }], error: null };
            }
            return Promise.resolve(out).then(res, rej);
          },
        };
        return b;
      },
    };
    return { sb, state };
  }

  test('A의 포지션을 닫으면 A의 계좌만 움직인다 — B는 그대로다', async () => {
    const { sb, state } = multiUserSb();
    const r = await closePaperPosition(sb, 'pA', 97_900, 'SL');
    eq(r.ok, true);
    assert(state.accounts.userA.trade_count === 1, 'A의 매매횟수가 늘어야 한다');
    eq(state.accounts.userB.trade_count, 0, 'B의 장부는 건드리지 않는다');
    eq(state.accounts.userB.balance, 10_000);
    eq(state.positions.pB.status, 'open', 'B의 포지션은 열린 채로 남는다');
  });

  test('두 사용자의 포지션이 같이 걸려도 각자 자기 계좌에만 적힌다', async () => {
    const { sb, state } = multiUserSb();
    const plan = paperExitPlan({
      positions: [
        { id: 'pA', symbol: 'BTCUSDT', side: 'LONG', fillPrice: 100_000, quantity: 0.01,
          stopLoss: 98_000, takeProfit: 104_000, liquidationPrice: 50_000, openedAt: NOW - HOUR },
        { id: 'pB', symbol: 'BTCUSDT', side: 'LONG', fillPrice: 100_000, quantity: 0.01,
          stopLoss: 98_000, takeProfit: 104_000, liquidationPrice: 50_000, openedAt: NOW - HOUR },
      ] as any,
      marks: new Map([['BTCUSDT', 97_900]]), nowMs: NOW,
    });
    eq(plan.actions.length, 2);
    for (const a of plan.actions) await closePaperPosition(sb, a.positionId as string, 97_900, a.exitReason as any);
    eq(state.accounts.userA.trade_count, 1);
    eq(state.accounts.userB.trade_count, 1);
  });

  // ══ ⑨ PAPER / TESTNET / LIVE 격리 ══
  test('모의 청산은 paper_ 장부만 건드린다 — 실전 주문·포지션 표를 열지 않는다', async () => {
    const { sb, state } = multiUserSb();
    await closePaperPosition(sb, 'pA', 97_900, 'SL');
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
    // 이 함수가 무엇을 건드렸는지 전부다.
    // 소스 수준의 "거래소 어댑터 import 없음"은
    // `scripts/check-mock-single-source.mjs` ⑦이 CI에서 못 박는다.
    const { sb, state } = multiUserSb();
    const plan = paperExitPlan({
      positions: [{ id: 'pA', symbol: 'BTCUSDT', side: 'LONG', fillPrice: 100_000, quantity: 0.01,
        stopLoss: 98_000, takeProfit: 104_000, liquidationPrice: 50_000, openedAt: NOW - HOUR }] as any,
      marks: new Map([['BTCUSDT', 97_900]]), nowMs: NOW,
    });
    const r = await closePaperPosition(sb, plan.actions[0].positionId as string, 97_900, 'SL');
    eq(r.ok, true);
    const opened = Array.from(new Set(state.tablesTouched)).sort().join(',');
    eq(opened, 'paper_accounts,paper_positions', `모의 청산이 연 표 — ${opened}`);
  });

  // ══ ⑩ DB를 못 읽으면 아무것도 닫지 않는다 ══
  test('포지션을 읽지 못하면 닫지 않는다 — 계좌도 그대로다', async () => {
    let accountWrites = 0;
    const sb: any = {
      from(table: string) {
        const b: any = {
          _patch: null as any,
          select() { return b; }, update(p: any) { b._patch = p; return b; }, eq() { return b; },
          maybeSingle() { return Promise.resolve({ data: null, error: { message: 'db down' } }); },
          then(res: any, rej: any) {
            if (b._patch && table === 'paper_accounts') accountWrites += 1;
            return Promise.resolve({ data: [], error: null }).then(res, rej);
          },
        };
        return b;
      },
    };
    const r = await closePaperPosition(sb, 'pA', 97_900, 'SL');
    eq(r.ok, false);
    eq(accountWrites, 0, 'DB를 못 읽었는데 계좌를 건드리면 안 된다');
  });
}

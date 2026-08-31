// src/lib/autotrade/practiceEnv.test.ts
//
// **연습 장부는 MOCK에서만 움직인다.**
//
// 여기서 보는 것은 "값이 맞는가"가 아니라 **어느 환경이 장부를 건드렸는가**다.
// 실제 거래소는 부르지 않는다 — 이 테스트는 브라우저 로컬 저장소만 본다.
import { test, eq, assert } from '../../test/harness';
import { tradeEnvOf, mayMutatePracticeLedger, LEGACY_LEDGER_STATUS } from './practiceEnv';
import {
  loadPaperBalance, savePaperBalance, resetPaperBalance, recordDailyPnL,
  paperBuy, paperSell, closePaperPosition, reversePaperPosition,
} from './store';
// **모듈 전체를 한 번 더 잡는다.** "없어진 것이 없는가"를 보려면 이름을
// 지목해 import할 수 없다 — 없는 이름을 import하면 컴파일에서 먼저 깨진다.
import * as store from './store';
import {
  planPracticeClose, planPracticeReverse, practiceCardEditable, PRACTICE_ACTION_KINDS,
} from './practiceActions';

/** localStorage 흉내. **네트워크도 거래소도 건드리지 않는다.** */
function fakeWindow() {
  const map = new Map<string, string>();
  return {
    localStorage: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, String(v)); },
      removeItem: (k: string) => { map.delete(k); },
    },
  } as any;
}

/**
 * 장부 전체를 한 문자열로 찍는다.
 *
 * **잔고·포지션만 보면 부족하다.** 실현손익 누계(`tg_day_pnl`)는 별도 키에
 * 있고, 화면은 "오늘 얼마 벌었나"를 그 값으로 읽는다. 그것만 새어 나가도
 * 실전 손익이 연습 성과로 남는다.
 */
const LEDGER_SNAPSHOT_KEYS = ['tg_day_pnl', 'tg_day_pnl_date'];
function ledgerSnapshot(): string {
  const w: any = (globalThis as any).window;
  const extra = LEDGER_SNAPSHOT_KEYS.map(k => `${k}=${w?.localStorage?.getItem(k) ?? ''}`).join('|');
  return JSON.stringify(loadPaperBalance()) + '||' + extra;
}

/** 장부를 놓고 한 가지 동작을 시킨 뒤, 장부가 변했는지만 본다 */
function withLedger(run: () => void): { before: string; after: string; changed: boolean } {
  const g: any = globalThis;
  const had = 'window' in g;
  const prev = g.window;
  g.window = fakeWindow();
  try {
    // 시작 상태: 잔고와 롱 포지션 하나
    savePaperBalance('MOCK', { krw: 10_000_000, positions: {}, totalPnL: 0 } as any);
    paperBuy('MOCK', 'btc', 100, 1_000_000, { side: 'long' });
    const before = ledgerSnapshot();
    run();
    const after = ledgerSnapshot();
    return { before, after, changed: before !== after };
  } finally {
    if (had) g.window = prev; else delete g.window;
  }
}

export function runPracticeEnvTests() {
  console.log('\n🧪 연습 장부 환경 격리 — 실전이 연습 장부에 적히지 않는가');

  // ══ ① 환경 판정 ══
  test('화면의 tradeMode를 환경으로 옮긴다', () => {
    eq(tradeEnvOf('mock'), 'MOCK');
    eq(tradeEnvOf('testnet'), 'TESTNET');
    eq(tradeEnvOf('live'), 'LIVE');
  });

  test('모르는 값을 MOCK으로 읽지 않는다', () => {
    // 오타 하나가 실전을 연습 장부에 적는 문이 되면 안 된다.
    for (const bad of ['real', 'paper', '', null, undefined, 0, {}, 'MOCK ']) {
      eq(tradeEnvOf(bad), 'UNKNOWN', `${JSON.stringify(bad)}를 MOCK으로 읽었다`);
    }
  });

  test('로컬 장부를 바꿔도 되는 환경은 MOCK 하나다', () => {
    eq(mayMutatePracticeLedger('MOCK'), true);
    eq(mayMutatePracticeLedger('TESTNET'), false);
    eq(mayMutatePracticeLedger('LIVE'), false);
    eq(mayMutatePracticeLedger('UNKNOWN'), false, '모르는 환경을 통과시켰다');
    eq(mayMutatePracticeLedger(null), false);
  });

  // ══ ② MOCK은 움직인다 — 막기만 하고 기능을 죽이면 그것도 고장이다 ══
  test('연습 진입은 로컬 장부를 바꾼다', () => {
    const r = withLedger(() => { paperBuy('MOCK', 'eth', 50, 500_000, { side: 'long' }); });
    assert(r.changed, 'MOCK 진입인데 장부가 그대로다');
  });

  test('연습 청산은 로컬 장부를 바꾼다', () => {
    const r = withLedger(() => { closePaperPosition('MOCK', 'btc', 110, 1); });
    assert(r.changed, 'MOCK 청산인데 장부가 그대로다');
  });

  test('연습 리버스와 매도는 로컬 장부를 바꾼다', () => {
    assert(withLedger(() => { reversePaperPosition('MOCK', 'btc', 110); }).changed, '리버스');
    assert(withLedger(() => { paperSell('MOCK', 'btc', 110, 500_000); }).changed, '매도');
  });

  test('연습 장부에는 자동 청산감시가 없다 — 그리고 예전 SL 값도 지우지 않는다', () => {
    // 예전에는 `checkPaperExits()`가 있었다. 부르는 곳이 없었는데도 화면에는
    // SL/TP 입력칸이 있었다 — 적히기만 하고 아무도 안 보는 값이었다.
    //
    // 여기서 고정하는 것은 두 가지다:
    //   ① 그 판정기가 모듈에 없다 (되살아나면 이 테스트가 깨진다)
    //   ② **이미 저장된 slPrice는 그대로 읽힌다** — 읽는 코드가 없어졌다는
    //      이유로 사용자의 저장 데이터를 지우지 않는다.
    const mod: any = store;
    eq(typeof mod.checkPaperExits, 'undefined', 'checkPaperExits가 되살아났다');

    const g: any = globalThis; const had = 'window' in g; const prev = g.window;
    g.window = fakeWindow();
    try {
      // 예전 판(slPrice·tp1Done·highWater가 붙은 포지션)을 그대로 심는다.
      g.window.localStorage.setItem('tg_paper_balance_v1', JSON.stringify({
        krw: 1_234_567, totalPnL: 42,
        positions: { btc: { qty: 1, avgPrice: 100, side: 'long', slPrice: 90, tpPrice: 130, tp1Done: true, highWater: 120 } },
      }));
      const b: any = loadPaperBalance();
      eq(b.krw, 1_234_567, '예전 잔고를 못 읽었다');
      eq(b.totalPnL, 42, '예전 실현손익을 못 읽었다');
      eq(b.positions.btc.qty, 1, '예전 포지션을 못 읽었다');
      eq(b.positions.btc.slPrice, 90, '예전 slPrice가 사라졌다 — 읽기가 값을 지웠다');
      eq(b.positions.btc.highWater, 120, '예전 highWater가 사라졌다');
      // 그리고 가격이 손절선 아래로 내려가도 **아무 일도 일어나지 않는다.**
      const before = g.window.localStorage.getItem('tg_paper_balance_v1');
      eq(g.window.localStorage.getItem('tg_paper_balance_v1'), before, '읽기만 했는데 장부가 바뀌었다');
    } finally { if (had) g.window = prev; else delete g.window; }
  });

  // ══ ③ TESTNET은 로컬 장부를 건드리지 않는다 ══
  //
  // 거래소에서 일어난 일의 정본은 거래소와 서버 기록이다.

  test('TESTNET 진입이 성공해도 로컬 장부는 그대로다', () => {
    const r = withLedger(() => {
      const out = paperBuy('TESTNET', 'btc', 100, 1_000_000, { side: 'long' });
      assert(out.ok === false && out.blocked === true, '막히지 않았다');
    });
    eq(r.after, r.before, 'TESTNET 진입이 연습 장부를 바꿨다');
  });

  test('TESTNET 청산이 성공해도 로컬 장부는 그대로다', () => {
    const r = withLedger(() => { closePaperPosition('TESTNET', 'btc', 110, 1); });
    eq(r.after, r.before, 'TESTNET 청산이 연습 장부를 바꿨다');
  });

  test('TESTNET 리버스도 로컬 장부를 바꾸지 않는다', () => {
    const r = withLedger(() => { reversePaperPosition('TESTNET', 'btc', 110); });
    eq(r.after, r.before, 'TESTNET 리버스가 연습 장부를 바꿨다');
  });

  // ══ ④ LIVE도 마찬가지 — 여기서 실제 주문은 나가지 않는다 ══
  //
  // 이 테스트는 순수 로컬 저장소만 본다. 거래소 어댑터를 부르지 않는다.

  test('LIVE 진입이 성공해도 로컬 장부는 그대로다', () => {
    const r = withLedger(() => {
      const out = paperBuy('LIVE', 'btc', 100, 1_000_000, { side: 'long' });
      assert(out.ok === false && out.blocked === true, '막히지 않았다');
    });
    eq(r.after, r.before, 'LIVE 진입이 연습 장부를 바꿨다');
  });

  test('LIVE 청산이 성공해도 로컬 장부는 그대로다', () => {
    const r = withLedger(() => { closePaperPosition('LIVE', 'btc', 110, 1); });
    eq(r.after, r.before, 'LIVE 청산이 연습 장부를 바꿨다');
  });

  test('LIVE 리버스도 로컬 장부를 바꾸지 않는다', () => {
    const r = withLedger(() => { reversePaperPosition('LIVE', 'btc', 110); });
    eq(r.after, r.before, 'LIVE 리버스가 연습 장부를 바꿨다');
  });

  // ══ ⑤ 나머지 변경 통로도 다 막혔는가 ══
  //
  // **한 군데만 막고 다른 문이 열려 있으면 막은 것이 아니다.**

  test('저장·초기화·매도도 MOCK 밖에서는 아무 일도 하지 않는다', () => {
    for (const env of ['TESTNET', 'LIVE', 'UNKNOWN'] as const) {
      eq(withLedger(() => { savePaperBalance(env, { krw: 1, positions: {}, totalPnL: 0 } as any); }).changed,
        false, `${env}: savePaperBalance가 통과했다`);
      eq(withLedger(() => { resetPaperBalance(env); }).changed, false, `${env}: resetPaperBalance가 통과했다`);
      eq(withLedger(() => { paperSell(env, 'btc', 110, 500_000); }).changed, false, `${env}: paperSell이 통과했다`);
    }
  });

  test('모르는 환경도 진입·청산·리버스를 통과시키지 않는다', () => {
    eq(withLedger(() => { paperBuy('UNKNOWN', 'btc', 100, 500_000); }).changed, false);
    eq(withLedger(() => { closePaperPosition('UNKNOWN', 'btc', 110, 1); }).changed, false);
    eq(withLedger(() => { reversePaperPosition('UNKNOWN', 'btc', 110); }).changed, false);
  });


  // ══ ⑤-2 실현손익 누계도 같은 계약을 받는다 ══
  //
  // 잔고·포지션만 막고 여기를 열어 두면 실전 손익이 연습 성과로 남는다.

  test('연습 실현손익은 MOCK에서 쌓인다', () => {
    const r = withLedger(() => { recordDailyPnL('MOCK', 12345); });
    assert(r.changed, 'MOCK인데 실현손익이 안 쌓였다');
    assert(r.after.includes('tg_day_pnl=12345'), `실현손익이 안 적혔다 — ${r.after.slice(-60)}`);
  });

  test('TESTNET·LIVE·UNKNOWN은 실현손익도 쌓지 않는다', () => {
    for (const env of ['TESTNET', 'LIVE', 'UNKNOWN'] as const) {
      const r = withLedger(() => { recordDailyPnL(env, 12345); });
      eq(r.changed, false, `${env}: 실현손익이 쌓였다`);
    }
  });

  test('MOCK 밖 청산은 실현손익 키까지 그대로 둔다', () => {
    // 청산이 막히면 잔고뿐 아니라 **손익 누계도** 그대로여야 한다.
    for (const env of ['TESTNET', 'LIVE'] as const) {
      const r = withLedger(() => { closePaperPosition(env, 'btc', 200, 1); });
      eq(r.after, r.before, `${env}: 청산이 장부(손익 포함)를 바꿨다`);
    }
  });

  // ══ ⑤-3 연습 포지션으로 거래소를 부르지 않는다 ══
  //
  // 반대 방향 오염이다. 예전에는 '모의 포지션' 카드의 종료·리버스가
  // 전역 tradeMode를 보고 **로컬 연습 장부의 수량으로 거래소 주문**을 냈다.
  //
  // 여기서는 실제 네트워크를 부르지 않는다. 대신 **부를 수 있는 선택지가
  // 아예 없다**는 것을 본다 — 그게 더 강한 증거다.

  test('연습 동작의 결과 종류에 거래소를 부르는 것이 없다', () => {
    for (const k of PRACTICE_ACTION_KINDS) {
      assert(/^(PRACTICE_|BLOCKED)/.test(k), `거래소를 부를 수 있는 종류가 생겼다 — ${k}`);
    }
    eq(PRACTICE_ACTION_KINDS.length, 3, '종류가 늘었다면 이 계약을 다시 보라');
  });

  test('TESTNET에서 연습 포지션 종료·리버스는 막힌다 (거래소 호출 0)', () => {
    const p = { asset: 'btc', qty: 1, avgPrice: 100, side: 'long' };
    for (const plan of [planPracticeClose('TESTNET', p, 1), planPracticeReverse('TESTNET', p)]) {
      eq(plan.kind, 'BLOCKED', 'TESTNET인데 연습 동작이 통과했다');
    }
    // 장부도 안 변한다
    eq(withLedger(() => { closePaperPosition('TESTNET', 'btc', 200, 1); }).changed, false);
    eq(withLedger(() => { reversePaperPosition('TESTNET', 'btc', 200); }).changed, false);
  });

  test('LIVE에서 연습 포지션 종료·리버스는 막힌다 (거래소 호출 0)', () => {
    const p = { asset: 'btc', qty: 1, avgPrice: 100, side: 'long' };
    for (const plan of [planPracticeClose('LIVE', p, 1), planPracticeReverse('LIVE', p)]) {
      eq(plan.kind, 'BLOCKED', 'LIVE인데 연습 동작이 통과했다');
    }
    eq(withLedger(() => { closePaperPosition('LIVE', 'btc', 200, 1); }).changed, false);
    eq(withLedger(() => { reversePaperPosition('LIVE', 'btc', 200); }).changed, false);
  });

  test('MOCK에서는 연습 종료·리버스가 연습 장부만 바꾼다', () => {
    const p = { asset: 'btc', qty: 1, avgPrice: 100, side: 'long' };
    eq(planPracticeClose('MOCK', p, 0.5).kind, 'PRACTICE_CLOSE');
    eq(planPracticeReverse('MOCK', p).kind, 'PRACTICE_REVERSE');
  });

  test('연습 카드는 MOCK 밖에서 읽기 전용이다', () => {
    eq(practiceCardEditable('MOCK'), true);
    for (const env of ['TESTNET', 'LIVE', 'UNKNOWN'] as const) {
      eq(practiceCardEditable(env), false, `${env}: 연습 카드가 편집 가능하다`);
    }
  });

  test('종목을 모르면 연습 동작도 하지 않는다', () => {
    // 종목을 못 읽었는데 진행하면 엉뚱한 자산을 닫는다.
    eq(planPracticeClose('MOCK', {}, 1).kind, 'BLOCKED');
    eq(planPracticeClose('MOCK', null, 1).kind, 'BLOCKED');
    eq(planPracticeReverse('MOCK', { qty: 1 }).kind, 'BLOCKED');
  });

  // ══ ⑥ 이미 섞인 과거는 추측으로 정리하지 않는다 ══
  test('과거 장부를 정본으로도 통계 근거로도 쓰지 않는다고 못 박는다', () => {
    eq(LEGACY_LEDGER_STATUS.canonical, false);
    eq(LEGACY_LEDGER_STATUS.usableForStats, false, '오염된 장부를 성과 근거로 쓰게 두었다');
    eq(LEGACY_LEDGER_STATUS.status, 'LEGACY_CONTAMINATED');
    assert(LEGACY_LEDGER_STATUS.why.includes('사후에 가려낼 수 없다'),
      '왜 자동 정리하지 않는지가 안 적혀 있다');
  });
}

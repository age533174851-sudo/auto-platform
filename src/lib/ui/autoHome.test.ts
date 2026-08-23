// src/lib/ui/autoHome.test.ts
//
// **큰 글씨로 적힌 0은 작은 글씨로 적힌 0보다 나쁘다.**
//
// 자동매매 홈을 "돈부터 보여주는" 구조로 바꾸면 맨 위에 큰 숫자가 온다.
// 그 자리에 모르는 값을 0으로 그리면 화면이 "오늘 안 벌었다"고 말하는데
// 실제로는 아직 세는 곳이 없는 것이다. 사람은 큰 숫자를 안 의심한다.
import { test, eq, assert } from '../../test/harness';
import { autoHomeView, statCell } from './autoHome';

const WALLET = {
  ok: true,
  envs: [
    { env: 'TESTNET', total: { value: 12450, readiness: 'OK', text: '' } },
    { env: 'LIVE', total: { value: 2000, readiness: 'OK', text: '' } },
  ],
  ledger: {
    TESTNET: { complete: true, tradingPnl: { value: 340.5, reason: '' } },
    LIVE: { complete: false, reason: '수수료를 못 읽었습니다',
      tradingPnl: { value: null, reason: '수수료를 못 읽어 매매손익을 확정할 수 없습니다' } },
  },
};

const SCHED = {
  ok: true,
  schedules: [
    { id: 's1', symbol: 'BTCUSDT', strategy_id: 'daily-ladder', enabled: true,
      mode: 'TESTNET', last_result: '조건 대기', last_run_at: '2026-08-22T00:00:00Z' },
    { id: 's2', symbol: 'ETHUSDT', strategy_id: 'scalp', enabled: false, mode: 'TESTNET' },
  ],
};

export function runAutoHomeTests() {
  console.log('[자동매매 홈 — 모르는 것을 0으로 그리지 않는다]');

  test('아는 값은 그대로 쓴다', () => {
    const v = autoHomeView({ env: 'TESTNET', schedule: SCHED, wallet: WALLET });
    eq(v.equity.known, true);
    eq(v.equity.value, 12450);
    eq(v.todayPnl.known, true);
    eq(v.todayPnl.value, 340.5);
    eq(v.running.value, 1, '켜진 예약만 센다');
  });

  test('환경을 섞지 않는다', () => {
    // MOCK/TESTNET/LIVE의 자산과 장부는 절대 합산하지 않는다.
    eq(autoHomeView({ env: 'LIVE', schedule: SCHED, wallet: WALLET }).equity.value, 2000);
  });

  test('장부가 불완전하면 오늘 손익을 0으로 적지 않는다', () => {
    const v = autoHomeView({ env: 'LIVE', schedule: SCHED, wallet: WALLET });
    eq(v.todayPnl.known, false);
    eq(v.todayPnl.value, null, '모르는데 숫자를 넣었다');
    assert((v.todayPnl.note || '').includes('수수료'), v.todayPnl.note || '');
  });

  test('지갑을 아직 안 읽었으면 총자산이 0이 아니다', () => {
    const v = autoHomeView({ env: 'TESTNET', schedule: SCHED, wallet: null });
    eq(v.equity.known, false);
    eq(v.equity.value, null);
    assert((v.equity.note || '').length > 0, '이유 없이 비워 뒀다');
  });

  test('지갑 계층이 적어 둔 이유를 그대로 쓴다', () => {
    // 화면이 문장을 지어내면 실제 원인과 갈린다.
    const w = { ok: true, envs: [{ env: 'TESTNET', total: { value: null, text: '값을 못 매긴 자산이 있습니다' } }] };
    const v = autoHomeView({ env: 'TESTNET', schedule: SCHED, wallet: w });
    eq(v.equity.note, '값을 못 매긴 자산이 있습니다');
  });

  test('예약을 못 읽은 것과 예약이 없는 것을 가른다', () => {
    const none = autoHomeView({ env: 'TESTNET', schedule: { ok: true, schedules: [] }, wallet: null });
    eq(none.schedulesReadOk, true);
    eq(none.running.value, 0, '읽었는데 0건이면 0이 맞다');

    const failed = autoHomeView({ env: 'TESTNET', schedule: { ok: false }, wallet: null });
    eq(failed.schedulesReadOk, false);
    eq(failed.running.known, false, '못 읽었는데 0건이라고 적었다');
  });

  // ── 아직 세는 곳이 없는 값 ──
  //
  // 예약 API도 지갑 API도 "오늘 몇 번 거래했는가"와 "이겼는가"를 주지
  // 않는다. 0으로 그리면 화면이 "오늘 한 번도 안 했다"고 말한다.
  test('지갑이 stats를 주면 그대로 쓴다', () => {
    const w = {
      ...WALLET,
      ledger: {
        ...WALLET.ledger,
        TESTNET: {
          complete: true,
          tradingPnl: { value: 340.5, reason: '' },
          stats: {
            fills: { known: true, value: 4, note: null },
            winRate: { known: true, value: 0.75, note: null },
            closed: { known: true, value: 4, note: null },
          },
        },
      },
    };
    const v = autoHomeView({ env: 'TESTNET', schedule: SCHED, wallet: w });
    eq(v.todayFills.value, 4);
    eq(v.winRate.value, 0.75);
    eq(v.closedTrades.value, 4);
  });

  test('옛 응답에 stats가 없으면 0으로 채우지 않는다', () => {
    // 없는 칸을 0으로 채우면 화면이 "오늘 한 번도 안 했다"고 말한다.
    const v = autoHomeView({ env: 'TESTNET', schedule: SCHED, wallet: WALLET });
    eq(v.todayFills.known, false);
    eq(v.todayFills.value, null);
    eq(v.winRate.known, false);
    assert((v.todayFills.note || '').length > 0);
  });

  test('지갑 계층이 "모른다"고 한 것을 아는 것으로 바꾸지 않는다', () => {
    const w = {
      ...WALLET,
      ledger: {
        TESTNET: {
          complete: false,
          tradingPnl: { value: null, reason: 'x' },
          stats: {
            fills: { known: true, value: 2, note: null },
            winRate: { known: false, value: null, note: '장부가 완전하지 않습니다' },
            closed: { known: false, value: null, note: '장부가 완전하지 않습니다' },
          },
        },
      },
    };
    const v = autoHomeView({ env: 'TESTNET', schedule: SCHED, wallet: w });
    eq(v.todayFills.value, 2, '센 만큼은 사실이다');
    eq(v.winRate.known, false);
    eq(v.winRate.note, '장부가 완전하지 않습니다');
  });

  console.log('[자동매매 홈 — 전략 이름을 지어내지 않는다]');

  test('서버가 준 전략만 카드가 된다', () => {
    const v = autoHomeView({ env: 'TESTNET', schedule: SCHED, wallet: WALLET });
    eq(v.cards.length, 2);
    eq(v.cards[0].strategyId, 'daily-ladder');
    eq(v.cards[0].running, true);
    eq(v.cards[1].running, false);
  });

  test('이름이 없으면 id를 쓴다 — 마케팅 이름을 만들지 않는다', () => {
    const v = autoHomeView({
      env: 'TESTNET', wallet: null,
      schedule: { ok: true, schedules: [{ id: 'x', symbol: 'BTCUSDT', strategy_id: 'my-original-v1' }] },
    });
    eq(v.cards[0].strategyName, 'my-original-v1');
    assert(!/AI|봇|스캘핑/.test(v.cards[0].strategyName), v.cards[0].strategyName);
  });

  test('서버가 이름을 주면 그것을 쓴다', () => {
    const v = autoHomeView({
      env: 'TESTNET', wallet: null,
      schedule: { ok: true, schedules: [
        { id: 'x', symbol: 'BTCUSDT', strategy_id: 'daily-ladder', strategyName: '일봉 계단식' }] },
    });
    eq(v.cards[0].strategyName, '일봉 계단식');
  });

  test('전략 id가 아예 없으면 미상이라고 적는다', () => {
    const v = autoHomeView({
      env: 'TESTNET', wallet: null,
      schedule: { ok: true, schedules: [{ id: 'x', symbol: 'BTCUSDT' }] },
    });
    eq(v.cards[0].strategyName, '(전략 미상)');
  });

  test('실전 여부는 mode로만 정한다', () => {
    const v = autoHomeView({
      env: 'LIVE', wallet: null,
      schedule: { ok: true, schedules: [
        { id: 'a', mode: 'LIVE_LIMITED' }, { id: 'b', mode: 'TESTNET' }, { id: 'c' }] },
    });
    eq(v.cards[0].live, true);
    eq(v.cards[1].live, false);
    eq(v.cards[2].live, false, 'mode를 모르는데 실전으로 읽었다');
  });

  console.log('[자동매매 홈 — 빈 칸에는 이유가 있다]');

  test('모르는 칸은 숫자 대신 이유를 그린다', () => {
    const c = statCell('오늘 손익', { known: false, value: null, note: '수수료를 못 읽었습니다' }, String);
    eq(c.text, null);
    eq(c.emptyText, '수수료를 못 읽었습니다');
    eq(c.known, false);
  });

  test('이유가 없어도 빈칸으로 두지 않는다', () => {
    const c = statCell('승률', { known: false, value: null, note: null }, String);
    assert((c.emptyText || '').length > 0);
  });

  test('부호가 있는 값만 색을 갖는다', () => {
    const f = (v: number) => String(v);
    eq(statCell('손익', { known: true, value: 10, note: null }, f, { signed: true }).tone, 'good');
    eq(statCell('손익', { known: true, value: -10, note: null }, f, { signed: true }).tone, 'bad');
    eq(statCell('손익', { known: true, value: 0, note: null }, f, { signed: true }).tone, 'plain');
    // 자산은 부호가 아니다 — 빨갛게 칠하면 손실로 읽힌다.
    eq(statCell('자산', { known: true, value: 100, note: null }, f).tone, 'plain');
  });

  test('0은 모르는 것이 아니다', () => {
    // 진짜로 0원 번 날은 0으로 그려야 한다.
    const c = statCell('오늘 손익', { known: true, value: 0, note: null }, v => `${v}원`);
    eq(c.known, true);
    eq(c.text, '0원');
  });
}

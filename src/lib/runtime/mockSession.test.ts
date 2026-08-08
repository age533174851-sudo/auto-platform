// src/lib/runtime/mockSession.test.ts
//
// 막으려는 것:
//  1. **놓친 구간을 시뮬레이션으로 채우는 것.** 12시간 꺼져 있었으면
//     12시간 안 돈 것이다. 되돌려 계산한 720번의 체결은 실제로 한 번도
//     일어나지 않았고, 그 성과를 보고 사용자는 실전 전환을 결정한다
//  2. 세션을 못 읽었는데 새로 시작하는 것 — 사흘치 기록이 사라지고
//     잔고가 종잣돈으로 리셋되는데, 사용자는 그게 조회 실패였다는 것을
//     모른다
//  3. 설정을 바꾸고도 같은 성과에 이어 붙이는 것
//  4. 가격을 못 읽었는데 마지막 가격으로 평가하는 것 — 멈춘 시계로는
//     급락이 안 보인다
import { test, assert, eq, close } from '../../test/harness';
import {
  statusOf, restoreVerdict, resumePlan, applyGap,
  equityOf, performanceOf, configChangeVerdict,
  NO_CATCH_UP_NOTE, MOCK_IS_NOT_ASSET_NOTE,
  type MockSession,
} from './mockSession';

const S = (over: Partial<MockSession> = {}): MockSession => ({
  id: 's1', seed: 1_000_000, cash: 1_000_000,
  positions: [], openOrders: [],
  startedAtMs: 0, lastTickAtMs: 1_000_000_000_000, intervalSec: 60,
  status: 'RUNNING', configVersion: 1, gapCount: 0, gapMs: 0,
  ...over,
});

export function runMockSessionTests() {
  console.log('[모의 세션 — 빈 구간을 채우지 않는다]');

  test('12시간 꺼져 있었으면 놓친 틱을 세되 되돌려 계산하지 않는다', () => {
    const s = S({ lastTickAtMs: 0, intervalSec: 60 });
    const p = resumePlan(s, 12 * 60 * 60 * 1000);
    assert(p.missedTicks! > 700, String(p.missedTicks));
    eq(p.catchUp, false);
    eq(p.ticksToSimulate, 0, '한 틱도 되돌려 계산하면 안 된다');
    eq(p.markGap, true);
    assert(p.note.includes('없던 거래'), p.note);
  });

  test('세는 것과 채우는 것은 다르다', () => {
    // missedTicks가 크다고 ticksToSimulate가 따라 커지면 안 된다.
    for (const hours of [1, 6, 24, 72]) {
      const p = resumePlan(S({ lastTickAtMs: 0 }), hours * 3600 * 1000);
      eq(p.ticksToSimulate, 0, `${hours}시간`);
      assert(p.missedTicks! > 0, `${hours}시간`);
    }
  });

  test('마지막 실행 시각을 몰라도 되돌려 계산하지 않는다', () => {
    const p = resumePlan(S({ lastTickAtMs: null }), 1_000);
    eq(p.ticksToSimulate, 0);
    eq(p.missedTicks, null);
    eq(p.markGap, false, '모르는 것을 빈 구간으로 단정하지도 않는다');
    assert(p.note.includes('되돌려 계산하지 않고'), p.note);
  });

  test('빈 구간이 없으면 조용하다', () => {
    const p = resumePlan(S({ lastTickAtMs: 1_000_000, intervalSec: 60 }), 1_030_000);
    eq(p.missedTicks, 0);
    eq(p.markGap, false);
    eq(p.note, '');
  });

  test('빈 구간을 세션에 새긴다', () => {
    const s = S({ lastTickAtMs: 0, gapCount: 2, gapMs: 1000 });
    const p = resumePlan(s, 3_600_000);
    const next = applyGap(s, p, 3_600_000);
    eq(next.gapCount, 3);
    eq(next.gapMs, 1000 + 3_600_000);
    eq(next.status, 'GAP');
  });

  test('빈 구간이 없으면 세션을 건드리지 않는다', () => {
    const s = S();
    const p = resumePlan(s, s.lastTickAtMs! + 30_000);
    eq(applyGap(s, p, s.lastTickAtMs! + 30_000), s);
  });

  test('왜 안 채우는지가 문장으로 남아 있다', () => {
    assert(NO_CATCH_UP_NOTE.includes('실전 전환'), NO_CATCH_UP_NOTE);
  });

  console.log('[모의 세션 — 못 읽은 것과 없는 것은 다르다]');

  test('세션을 못 읽으면 새로 시작하지 않는다', () => {
    // 새로 시작하면 사흘치 기록이 사라지고 잔고가 종잣돈으로 리셋된다.
    for (const v of [undefined, null]) {
      const r = restoreVerdict(v === null ? null : undefined,
        v === null ? { readFailed: true } : undefined);
      eq(r.action, 'BLOCK', String(v));
      assert(r.reason.includes('리셋'), r.reason);
    }
  });

  test('세션이 없으면 새로 시작해도 된다', () => {
    const r = restoreVerdict(null);
    eq(r.action, 'START_FRESH');
    eq(r.session, null);
  });

  test('종잣돈을 못 읽으면 막는다', () => {
    // 0으로 채우면 수익률이 종잣돈만큼 틀린다.
    const r = restoreVerdict({ id: 'a', seed: null, cash: 500 });
    eq(r.action, 'BLOCK');
    assert(r.reason.includes('종잣돈'), r.reason);
  });

  test('현금 0은 못 읽은 것이 아니다', () => {
    const r = restoreVerdict({ id: 'a', seed: 1000, cash: 0 });
    eq(r.action, 'RESUME');
    eq(r.session!.cash, 0);
  });

  test('스네이크 케이스 칸도 읽는다', () => {
    const r = restoreVerdict({
      id: 'a', seed: 1000, cash: 1000,
      last_tick_at_ms: 12345, interval_sec: 30, config_version: 4, gap_count: 2,
    });
    eq(r.session!.lastTickAtMs, 12345);
    eq(r.session!.intervalSec, 30);
    eq(r.session!.configVersion, 4);
    eq(r.session!.gapCount, 2);
  });

  test('모르는 상태를 RUNNING으로 읽지 않는다', () => {
    eq(statusOf(null), 'UNKNOWN');
    eq(statusOf('아무거나'), 'UNKNOWN');
    eq(statusOf(''), 'UNKNOWN');
    eq(statusOf('running'), 'RUNNING');
    eq(statusOf(' gap '), 'GAP');
  });

  console.log('[모의 세션 — 멈춘 시계로 손익을 재지 않는다]');

  test('현재가를 못 읽으면 평가액을 내지 않는다', () => {
    const e = equityOf(
      S({ cash: 500, positions: [{ symbol: 'BTC', side: 'LONG', qty: 1, entryPrice: 100 }] }),
      {},
    );
    eq(e.equity, null);
    assert(e.unpriced.includes('BTC'), e.unpriced.join(','));
    assert(e.note.includes('멈춘 시계'), e.note);
  });

  test('한 종목만 못 읽어도 총액을 내지 않는다', () => {
    const e = equityOf(
      S({ positions: [
        { symbol: 'BTC', side: 'LONG', qty: 1, entryPrice: 100 },
        { symbol: 'ETH', side: 'LONG', qty: 1, entryPrice: 50 },
      ] }),
      { BTC: 120 },
    );
    eq(e.equity, null);
    eq(e.unpriced.join(','), 'ETH');
  });

  test('전부 읽었으면 평가한다', () => {
    const e = equityOf(
      { cash: 500, positions: [{ symbol: 'BTC', side: 'LONG', qty: 2, entryPrice: 100 }] },
      { BTC: 120 },
    );
    // 현금 500 + 원금 200 + 평가익 40
    close(e.equity!, 740, 1e-9);
    eq(e.note, '');
  });

  test('숏은 반대로 센다', () => {
    const e = equityOf(
      { cash: 0, positions: [{ symbol: 'BTC', side: 'SHORT', qty: 1, entryPrice: 100 }] },
      { BTC: 80 },
    );
    close(e.equity!, 120, 1e-9);
  });

  test('현금을 못 읽으면 아무것도 내지 않는다', () => {
    eq(equityOf({ cash: null as any, positions: [] }, {}).equity, null);
    eq(equityOf(null, {}).equity, null);
  });

  console.log('[모의 세션 — 성과에 빈 구간을 붙인다]');

  test('꺼져 있던 세션의 수익률은 연속 운용 결과가 아니라고 적는다', () => {
    const p = performanceOf(
      S({ seed: 1_000_000, gapCount: 2, gapMs: 6 * 3600 * 1000, startedAtMs: 0 }),
      1_120_000, 24 * 3600 * 1000,
    );
    close(p.returnPct!, 12, 1e-9);
    close(p.uptimePct!, 75, 1e-9);
    eq(p.usable, false, '실전 판단에 쓰면 안 된다');
    assert(p.note.includes('연속 운용의 결과가 아닙니다'), p.note);
  });

  test('빈 구간이 없어도 모의라는 사실은 적는다', () => {
    const p = performanceOf(S({ startedAtMs: 0 }), 1_120_000, 24 * 3600 * 1000);
    eq(p.usable, true);
    assert(p.note.includes('슬리피지'), p.note);
    assert(p.note.includes('실전보다 좋게'), p.note);
  });

  test('시작 시각을 모르면 가동률을 100으로 채우지 않는다', () => {
    // 100%로 채우면 꺼져 있던 시간이 통째로 사라진다.
    const p = performanceOf(S({ startedAtMs: null, gapMs: 3600_000 }), 1_000_000, 7200_000);
    eq(p.uptimePct, null);
  });

  test('종잣돈이나 평가액을 모르면 수익률을 안 낸다', () => {
    eq(performanceOf(S(), null, 1000).returnPct, null);
    eq(performanceOf(S({ seed: 0 }), 100, 1000).returnPct, null);
    eq(performanceOf(null, 100, 1000).returnPct, null);
  });

  test('가동률이 100을 넘거나 음수가 되지 않는다', () => {
    const a = performanceOf(S({ gapMs: 999_999_999, startedAtMs: 0 }), 1_000_000, 1000);
    eq(a.uptimePct, 0);
    const b = performanceOf(S({ gapMs: 0, startedAtMs: 0 }), 1_000_000, 1000);
    eq(b.uptimePct, 100);
  });

  console.log('[모의 세션 — 설정을 바꾸면 성과를 끊는다]');

  test('돌던 중에 설정을 바꾸면 성과를 끊는다', () => {
    // 3배로 번 것과 20배로 잃은 것이 섞이면 어느 쪽이 좋았는지 모른다.
    const v = configChangeVerdict(S({ configVersion: 3 }), true);
    eq(v.bump, true);
    eq(v.nextVersion, 4);
    eq(v.splitPerformance, true);
    assert(v.note.includes('어느 설정이 좋았는지'), v.note);
  });

  test('안 바뀌었으면 판을 안 올린다', () => {
    const v = configChangeVerdict(S({ configVersion: 3 }), false);
    eq(v.bump, false);
    eq(v.nextVersion, 3);
    eq(v.note, '');
  });

  test('멈춘 세션도 성과는 따로 센다', () => {
    const v = configChangeVerdict(S({ status: 'STOPPED', configVersion: 1 }), true);
    eq(v.splitPerformance, true);
    eq(v.nextVersion, 2);
  });

  test('판 번호를 못 읽어도 0에서 올린다', () => {
    eq(configChangeVerdict(null, true).nextVersion, 1);
  });

  console.log('[모의 세션 — 실제 자산과 섞지 않는다]');

  test('모의 잔고를 총자산에 더하지 않는다고 적어 둔다', () => {
    assert(MOCK_IS_NOT_ASSET_NOTE.includes('더하지 않습니다'), MOCK_IS_NOT_ASSET_NOTE);
  });
}

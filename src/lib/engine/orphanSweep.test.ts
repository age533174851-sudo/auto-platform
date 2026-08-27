// src/lib/engine/orphanSweep.test.ts
//
// 포지션이 0인데 남은 보호주문을 **전략을 가리지 않고** 치우는 판단.
//
// 여기서 틀리면 두 방향으로 나쁘다:
//   · 너무 지우면 **남의 손절이 사라진다** — 되돌릴 수 없다
//   · 안 지우면 다음 진입이 옛 주문에 맞아 예상치 못하게 닫힌다
import { test, eq, assert } from '../../test/harness';
import {
  sweepTargets, sweepDecision, sweepSummary,
} from './orphanSweep';
import { exitCoverage, exitCoverageGaps, exitCoverageLine } from './exitCoverage';

export function runOrphanSweepTests() {
  console.log('[고아 보호주문 — 대상 고르기]');

  test('적어 둔 번호가 없는 줄은 대상이 아니다', () => {
    // 번호가 없으면 남의 주문과 구분할 방법이 없다.
    const s = sweepTargets([{ connection_id: 'c1', symbol: 'BTCUSDT', sl_order_id: null, tp_order_id: null }]);
    eq(s.targets.length, 0);
    eq(s.skipped.find(x => x.code === 'NO_PROTECTION_ID')?.count, 1);
  });

  test('연결을 추측하지 않는다', () => {
    // 사용자의 활성 연결 중 아무거나 고르면 실계좌 포지션을
    // 테스트넷에 물어보게 된다.
    const s = sweepTargets([{ user_id: 'u1', symbol: 'BTCUSDT', sl_order_id: '111' }]);
    eq(s.targets.length, 0);
    eq(s.skipped.find(x => x.code === 'NO_CONNECTION')?.count, 1);
  });

  test('건너뛴 것을 세어서 돌려준다', () => {
    // 조용히 빼면 '볼 것이 없었다'와 '볼 수 있는 모양이 아니었다'가 같아진다.
    const s = sweepTargets([
      { connection_id: 'c1', symbol: 'BTCUSDT', sl_order_id: null },
      { symbol: 'ETHUSDT', sl_order_id: '9' },
      { connection_id: 'c1', sl_order_id: '9' },
    ]);
    eq(s.targets.length, 0);
    eq(s.skipped.reduce((a, b) => a + b.count, 0), 3);
    assert(s.skipped.every(x => x.reason.length > 0), '이유 없이 건너뛰지 않는다');
  });

  test('같은 연결·종목은 한 번만 본다', () => {
    const s = sweepTargets([
      { connection_id: 'c1', symbol: 'BTCUSDT', sl_order_id: '1' },
      { connection_id: 'c1', symbol: 'btcusdt', tp_order_id: '2' },
      { connection_id: 'c2', symbol: 'BTCUSDT', sl_order_id: '3' },
    ]);
    eq(s.targets.length, 2);
    eq(s.targets[0].rows, 2);
  });

  test('전략을 가리지 않는다 — scalp·원본v1도 대상이다', () => {
    // 청산 감시가 읽던 ladder_daily_trades에는 이 줄들이 없다.
    const s = sweepTargets([
      { connection_id: 'c1', symbol: 'BTCUSDT', sl_order_id: '1', strategy_id: 'scalp' },
      { connection_id: 'c1', symbol: 'ETHUSDT', tp_order_id: '2', strategy_id: 'my-original-v1' },
    ]);
    eq(s.targets.length, 2);
  });

  test('빈 문자열·null 문자열을 번호로 읽지 않는다', () => {
    const s = sweepTargets([{ connection_id: 'c1', symbol: 'BTCUSDT', sl_order_id: 'null', tp_order_id: '  ' }]);
    eq(s.targets.length, 0);
  });

  test('상한을 넘긴 것은 버리지 않고 다음 회차로 적는다', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      connection_id: 'c1', symbol: `S${i}USDT`, sl_order_id: String(i + 1),
    }));
    const s = sweepTargets(rows, { limit: 2 });
    eq(s.targets.length, 2);
    eq(s.skipped.find(x => x.code === 'OVER_LIMIT')?.count, 3);
  });

  console.log('[고아 보호주문 — 치울 것인가]');

  test('포지션을 못 읽은 것을 0으로 읽지 않는다', () => {
    // 이걸 0으로 읽으면 **살아 있는 포지션의 손절을 지운다.**
    const d = sweepDecision({ position: { ok: false, found: false }, ownedIdCount: 2 });
    eq(d.code, 'UNREADABLE');
    eq(d.cleanup, false);
    assert(d.reason.includes('0이라는 뜻이 아니'), d.reason);
  });

  test('조회 결과가 아예 없는 것도 0이 아니다', () => {
    eq(sweepDecision({ position: null, ownedIdCount: 2 }).code, 'UNREADABLE');
    eq(sweepDecision({ position: undefined, ownedIdCount: 2 }).cleanup, false);
  });

  test('포지션이 있으면 보호주문을 건드리지 않는다', () => {
    const d = sweepDecision({ position: { ok: true, found: true }, ownedIdCount: 2 });
    eq(d.code, 'HAS_POSITION');
    eq(d.cleanup, false);
  });

  test('내 번호를 모르면 지우지 않는다', () => {
    // 여기서 지우면 Cancel All과 같아진다.
    const d = sweepDecision({ position: { ok: true, found: false }, ownedIdCount: 0 });
    eq(d.code, 'NO_OWNED_IDS');
    eq(d.cleanup, false);
  });

  test('포지션 0 확인 + 내 번호 있음일 때만 치운다', () => {
    const d = sweepDecision({ position: { ok: true, found: false }, ownedIdCount: 1 });
    eq(d.code, 'CLEANUP');
    eq(d.cleanup, true);
  });

  test('치우는 경우는 정확히 하나뿐이다', () => {
    const cases = [
      { position: { ok: false, found: false }, ownedIdCount: 1 },
      { position: { ok: false, found: true }, ownedIdCount: 1 },
      { position: { ok: true, found: true }, ownedIdCount: 1 },
      { position: { ok: true, found: false }, ownedIdCount: 0 },
      { position: { ok: true, found: false }, ownedIdCount: 1 },
    ];
    eq(cases.filter(c => sweepDecision(c).cleanup).length, 1);
  });

  test('아무것도 안 한 것과 못 한 것을 같게 적지 않는다', () => {
    const none = sweepSummary({ targets: 0, cleaned: 0, stillPresent: 0, unreadable: 0, skipped: 0 });
    const blind = sweepSummary({ targets: 0, cleaned: 0, stillPresent: 0, unreadable: 0, skipped: 3 });
    assert(none !== blind, '후보가 없는 것과 볼 수 없던 것이 같은 문장이면 안 된다');
    assert(blind.includes('3'), blind);
  });

  console.log('[청산 감시 커버리지 — 안 보는 것을 정상이라 적지 않는다]');

  test('실행 경로가 있는 전략은 전부 표에 있다', () => {
    const all = exitCoverage();
    assert(all.length >= 3, `전략 ${all.length}개`);
    const undeclared = all.filter(c => c.gap != null && c.gap.includes('exitCoverage.ts'));
    eq(undeclared.length, 0, `표에 없는 전략: ${undeclared.map(c => c.strategyId).join(', ')}`);
  });

  test('계단식만 트레일링·시간청산을 받는다는 사실을 그대로 적는다', () => {
    const by = new Map(exitCoverage().map(c => [String(c.strategyId), c]));
    eq(by.get('daily-ladder')!.trailing, true);
    eq(by.get('daily-ladder')!.timeExit, true);
    eq(by.get('scalp')!.trailing, false);
    eq(by.get('my-original-v1')!.timeExit, false);
  });

  test('고아 정리는 전략을 가리지 않는다', () => {
    assert(exitCoverage().every(c => c.orphanSweep), '한 전략이라도 빠지면 Positions 0 / Orders 1이 남는다');
  });

  test('빈 칸이 있으면 "정상"이라고 적지 않는다', () => {
    const line = exitCoverageLine();
    if (exitCoverageGaps().length > 0) {
      assert(!/정상|이상 없/.test(line), line);
      assert(/\d/.test(line), `몇 개인지 적어야 한다 — ${line}`);
    }
  });

  test('빈 칸에는 이유가 있다', () => {
    for (const g of exitCoverageGaps()) {
      assert((g.gap ?? '').length > 10, `${g.strategyId}: 이유가 비어 있다`);
    }
  });
}

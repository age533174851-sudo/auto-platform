// src/lib/portfolio/walletDetail.test.ts
//
// 막으려는 것:
//  1. **못 읽은 잔고를 0으로 그리는 것.** `Number(null)`이 0이라
//     그냥 통과시키면 조회 실패가 잔고 0원이 된다
//  2. 한 조각을 못 읽었는데 자산 배분 비율을 그리는 것 — 분모가
//     작아져서 나머지가 실제보다 커 보이고, 35%/25% 같은 딱 떨어지는
//     숫자가 뜨면 아무도 의심하지 않는다
//  3. 배정 자금을 모르는데 전략 수익률을 내는 것 — 분모를 현재 자산으로
//     대신하면 손실 중인 전략이 좋아 보인다
//  4. 다른 환경 계좌를 고를 수 있게 두는 것
//  5. 오래된 숫자를 최신인 줄 알고 보는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  cellOf, CELL_TEXT, futuresRowsOf, marginRatioOf, syncTextOf,
  spotRowsOf, strategyReturnOf, strategyTotalOf, allocationOf,
  accountsForEnv, accountsNoteOf,
  type SpotAsset, type StrategyAccount, type AccountOption,
  sleeveAccountsOf,
} from './walletDetail';

const ok = (n: number) => cellOf(n);
const bad = () => cellOf(null, 'FAILED');

export function runWalletDetailTests() {
  console.log('[지갑 상세 — 못 읽은 것을 0으로 만들지 않는다]');

  test('숫자가 아니면 전부 확인 불가다', () => {
    // Number(null)은 0이다. 그냥 통과시키면 조회 실패가 잔고 0원이 된다.
    for (const v of [null, undefined, '', 'abc', NaN, true, false]) {
      eq(cellOf(v).value, null, String(v));
      eq(cellOf(v).state, 'FAILED', String(v));
    }
  });

  test('진짜 0은 0이다', () => {
    eq(cellOf(0).value, 0);
    eq(cellOf(0).state, 'OK');
    eq(cellOf('0').value, 0, '문자열 0도 숫자다');
  });

  test('왜 없는지를 구분해 적는다', () => {
    eq(cellOf(null, 'SYNCING').text, '동기화 중');
    eq(cellOf(null, 'DISCONNECTED').text, '연결 끊김');
    eq(cellOf(null, 'UNSUPPORTED').text, '미지원');
    eq(CELL_TEXT.FAILED, '확인 불가');
  });

  test('상태가 OK가 아니면 값이 있어도 안 쓴다', () => {
    // 끊긴 연결에서 온 숫자는 옛날 값이다.
    eq(cellOf(500, 'DISCONNECTED').value, null);
  });

  console.log('[지갑 상세 — 선물]');

  test('바이낸스 순서대로 줄을 낸다', () => {
    const rows = futuresRowsOf({
      name: 'Gate Testnet Futures', env: 'TESTNET', exchange: 'gate',
      walletBalance: ok(569.09), availableBalance: ok(540.90),
      usedMargin: ok(28.19), maintenanceMargin: ok(1.2),
      unrealizedPnl: ok(-2.40), realizedPnl: ok(-41.48),
      marginRatio: ok(0.2), openPositions: ok(1), openOrders: ok(0),
      lastSyncAtMs: 0, connection: 'OK', note: '',
    });
    eq(rows[0].label, '지갑 잔고');
    eq(rows[1].label, '주문 가능');
    eq(rows[2].label, '사용 증거금');
    close(rows[0].cell.value!, 569.09, 1e-9);
  });

  test('계좌가 없으면 빈 목록이다', () => {
    eq(futuresRowsOf(null).length, 0);
  });

  test('분모를 못 읽으면 증거금 비율을 내지 않는다', () => {
    // 0으로 채우면 무한대나 0이 되는데, 화면에서는 '안전' 또는
    // '청산 직전'으로 읽힌다. 둘 다 사실이 아니다.
    eq(marginRatioOf(ok(1.2), bad()).value, null);
    eq(marginRatioOf(bad(), ok(500)).value, null);
    eq(marginRatioOf(ok(1.2), ok(0)).value, null, '순자산 0이면 비율에 뜻이 없다');
  });

  test('제대로 읽었으면 비율을 낸다', () => {
    close(marginRatioOf(ok(5), ok(500)).value!, 1, 1e-9);
  });

  test('동기화 시각을 모르면 방금이라고 하지 않는다', () => {
    const t = syncTextOf(null, 1000);
    assert(t.includes('언제 것인지 알 수 없습니다'), t);
  });

  test('오래됐으면 오래됐다고 적는다', () => {
    const now = 10 * 86400_000;
    assert(syncTextOf(now - 3 * 86400_000, now).includes('오래된 값입니다'), '3일 전');
    assert(syncTextOf(now - 30_000, now).includes('초 전'), '30초 전');
    assert(syncTextOf(now - 300_000, now).includes('분 전'), '5분 전');
  });

  console.log('[지갑 상세 — 현물]');

  test('수량 0인 코인은 빼고, 못 읽은 것은 남긴다', () => {
    // 빼 버리면 사용자는 그 코인이 없다고 믿는데 사실은 못 읽었을 뿐이다.
    const A = (symbol: string, qty: any, val: any): SpotAsset => ({
      symbol, quantity: qty, available: ok(0), locked: ok(0),
      valuation: val, change24hPct: ok(0),
    });
    const rows = spotRowsOf([
      A('ZERO', ok(0), ok(0)),
      A('BTC', ok(0.2), ok(100)),
      A('HUH', bad(), bad()),
    ]);
    eq(rows.length, 2);
    assert(rows.some(r => r.symbol === 'HUH'), '못 읽은 것은 남아야 한다');
    assert(!rows.some(r => r.symbol === 'ZERO'), '진짜 0은 빠진다');
  });

  test('못 읽은 것을 목록 위로 올린다', () => {
    const A = (symbol: string, val: any): SpotAsset => ({
      symbol, quantity: ok(1), available: ok(1), locked: ok(0),
      valuation: val, change24hPct: ok(0),
    });
    const rows = spotRowsOf([A('BTC', ok(100)), A('HUH', bad()), A('ETH', ok(50))]);
    eq(rows[0].symbol, 'HUH', '숨기지 않는다');
    eq(rows[1].symbol, 'BTC', '큰 것부터');
  });

  console.log('[지갑 상세 — 전략계좌]');

  const SA = (name: string, alloc: any, eq_: any): StrategyAccount => ({
    strategyName: name, allocatedCapital: alloc, currentEquity: eq_,
    availableCapital: ok(0), realizedPnl: ok(0), unrealizedPnl: ok(0),
    fees: ok(0), funding: ok(0), returnPct: ok(0), mddPct: ok(0), activePositions: ok(0),
  });

  test('배정 자금을 모르면 수익률을 내지 않는다', () => {
    // 분모를 현재 자산으로 대신하면 손실 중인 전략이 좋아 보인다.
    eq(strategyReturnOf(bad(), ok(6143)).value, null);
    eq(strategyReturnOf(ok(0), ok(6143)).value, null);
  });

  test('제대로 읽었으면 수익률을 낸다', () => {
    close(strategyReturnOf(ok(6000), ok(6143)).value!, 2.3833, 1e-3);
  });

  test('한 전략이라도 못 읽으면 총 전략 자산을 내지 않는다', () => {
    const t = strategyTotalOf([SA('VWAP', ok(6000), ok(6143)), SA('Swing', ok(7000), bad())]);
    eq(t.total, null);
    eq(t.complete, false);
    assert(t.missing.includes('Swing'), t.missing.join(','));
    assert(t.note.includes('없는 것처럼 보입니다'), t.note);
  });

  test('전부 읽었으면 합계를 낸다', () => {
    const t = strategyTotalOf([SA('a', ok(1), ok(6143)), SA('b', ok(1), ok(7302))]);
    close(t.total!, 13445, 1e-9);
    eq(t.complete, true);
  });

  test('전략이 없으면 0이 아니라고 적는다', () => {
    const t = strategyTotalOf([]);
    eq(t.total, null);
    assert(t.note.includes('0이라는 뜻이 아닙니다'), t.note);
  });

  console.log('[지갑 상세 — 자산 배분]');

  test('한 조각이라도 못 읽으면 비율을 내지 않는다', () => {
    // 분모가 작아져서 나머지가 실제보다 커 보이고, 그 그림에는
    // 틀렸다는 표시가 없다.
    const a = allocationOf([
      { label: '현물', cell: ok(35) },
      { label: '선물', cell: bad() },
    ]);
    eq(a.complete, false);
    eq(a.total, null);
    for (const s of a.slices) eq(s.pct, null, s.label);
    assert(a.note.includes('틀렸다는 표시가 없습니다'), a.note);
  });

  test('전부 읽었으면 비율을 낸다', () => {
    const a = allocationOf([
      { label: '현물', cell: ok(35) },
      { label: '선물', cell: ok(25) },
      { label: '장기투자', cell: ok(30) },
      { label: '현금', cell: ok(10) },
    ]);
    eq(a.complete, true);
    close(a.total!, 100, 1e-9);
    close(a.slices[0].pct!, 35, 1e-9);
    close(a.slices[3].pct!, 10, 1e-9);
  });

  test('자산이 0이면 비율을 안 낸다', () => {
    const a = allocationOf([{ label: '현물', cell: ok(0) }]);
    eq(a.complete, false);
    eq(a.slices[0].pct, null);
  });

  test('계좌가 없으면 빈 배분이다', () => {
    eq(allocationOf(null).slices.length, 0);
    eq(allocationOf([]).complete, false);
  });

  console.log('[지갑 상세 — 계좌 선택]');

  const AC = (key: string, env: any, conn: any = 'OK'): AccountOption =>
    ({ key, label: key, env, connection: conn });

  test('다른 환경 계좌는 고를 수 없다', () => {
    // 목록에 보이면 고를 수 있다고 읽히고, 고르는 순간 실전 화면에
    // 테스트넷 잔고가 뜬다.
    const list = [AC('live-gate', 'LIVE'), AC('test-gate', 'TESTNET'), AC('mock', 'MOCK')];
    eq(accountsForEnv('LIVE', list).length, 1);
    eq(accountsForEnv('LIVE', list)[0].key, 'live-gate');
    eq(accountsForEnv('MOCK', list)[0].key, 'mock');
  });

  test('끊긴 계좌가 있으면 그 사실을 먼저 적는다', () => {
    const n = accountsNoteOf([AC('a', 'LIVE'), AC('b', 'LIVE', 'DISCONNECTED')]);
    assert(n.includes('연결이 끊긴'), n);
    assert(n.includes('옛날 값입니다'), n);
  });

  test('다 정상이면 군말이 없다', () => {
    eq(accountsNoteOf([AC('a', 'LIVE')]), '');
  });

  test('계좌가 없으면 그렇다고 한다', () => {
    assert(accountsNoteOf([]).includes('연결된 계좌가 없습니다'), '빈 목록');
  });
  console.log('[전략계좌 — 표는 041이 만들었는데 화면이 안 물어봤다]');

  test('행에서 전략계좌를 만든다 — 자산 = 배정 + 실현 + 미실현 − 수수료', () => {
    const [a] = sleeveAccountsOf([{
      sleeve_id: 'MINERVINI', label: '미너비니', connection_id: 'c1',
      allocated: 1000, realized_pnl: 120, unrealized_pnl: -20, fees: 5,
      max_drawdown_seen_pct: 8, positions: { BTCUSDT: 0.5, ETHUSDT: 0 },
      stage: 'TESTNET', halted: false,
    }], { c1: 'TESTNET' });
    eq(a.strategyName, '미너비니');
    eq(a.currentEquity.value, 1095);
    eq(a.env, 'TESTNET');
    eq(a.activePositions.value, 1, '수량 0인 심볼은 보유가 아니다');
    // 수익률은 배정 대비다. (1095 - 1000) / 1000
    eq(Math.round((a.returnPct.value as number) * 100) / 100, 9.5);
  });

  test('한 항이라도 못 읽으면 자산을 만들지 않는다', () => {
    // 빠진 항이 있으면 그만큼이 전부 손익으로 보인다.
    const [a] = sleeveAccountsOf([{
      sleeve_id: 's', allocated: 1000, realized_pnl: null,
      unrealized_pnl: 0, fees: 0, connection_id: 'c1',
    }], { c1: 'LIVE' });
    eq(a.currentEquity.value, null);
    eq(a.returnPct.value, null, '자산을 모르는데 수익률이 나오면 안 된다');
  });

  test('연결이 없는 전략계좌를 LIVE로 승격하지 않는다', () => {
    const [a] = sleeveAccountsOf([{ sleeve_id: 's', connection_id: null, allocated: 1 }], { c1: 'LIVE' });
    eq(a.env, null);
    const [b] = sleeveAccountsOf([{ sleeve_id: 's', connection_id: 'zzz', allocated: 1 }], { c1: 'LIVE' });
    eq(b.env, null, '모르는 연결을 아무 환경에나 넣지 않는다');
  });

  test('이 조회가 안 주는 값은 0이 아니라 안 줌이다', () => {
    const [a] = sleeveAccountsOf([{ sleeve_id: 's', allocated: 1 }], {});
    eq(a.availableCapital.value, null);
    eq(a.funding.value, null, '펀딩을 0으로 적으면 수수료가 실제보다 작아 보인다');
  });

}

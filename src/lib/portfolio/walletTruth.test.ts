// src/lib/portfolio/walletTruth.test.ts
//
// **화면이 있는 것과 숫자가 맞는 것은 다르다.**
//
// 지갑은 "아직 미완성" 정도가 아니라 **틀린 숫자를 보여줄 수 있는**
// 상태였다. 여기 있는 것은 전부 현재 main에서 실제로 재현된 것들이다:
//
//   · 홈의 '내 총자산'이 선물 지갑잔고 하나였다 (현물·미실현 제외)
//   · 지갑의 총자산도 현물은 USDT만, 선물은 지갑잔고만 더했다
//   · 값을 못 매긴 코인이 있어도 부분합계를 총자산이라고 적었다
//   · 통화 버튼이 숫자를 그대로 두고 라벨만 바꿨다
//   · 포지션 조회가 실패하면 미실현손익이 0이 됐다
//   · 현물 조회가 실패해도 "모두 읽었습니다"라고 적었다
//   · env를 모르는 연결을 LIVE로 승격했다
//   · 입출금 일부를 못 읽어도 순입출금을 확정값처럼 만들었다

import { test, eq, assert } from '../../test/harness';
import { envWalletOf, bucketsOf, type ConnectionWallet } from './walletOverview';
import { totalEquityOf } from './wallet';
import { moneyView, currencyAvailable } from './walletMoney';
import { cashFlowOf, newestFirstToAsc, latestTakenMs } from './performance';
import { buildWalletTree, type SpotWallet, type FuturesWallet } from '../markets/wallets';

const conn = (over: Partial<ConnectionWallet> = {}): ConnectionWallet => ({
  connectionId: 'c1', exchangeId: 'binance', testnet: false, ok: true,
  futures: { ok: true, positionsOk: true, walletBalance: 200, availableMargin: 150,
    positionMargin: 50, unrealizedPnl: 0 },
  spot: { ok: true, usdt: 0, valueUsd: 100, knownValueUsd: 100, unpriced: [] },
  ...over,
});

export function runWalletTruthTests() {
  console.log('[지갑 진실 — 총자산은 현물 전체 + 선물 순자산]');

  test('**현물 BTC $100 + 선물 equity $200 → 총자산 $300**', () => {
    const e = envWalletOf('LIVE', [conn({
      spot: { ok: true, usdt: 0, valueUsd: 100, knownValueUsd: 100, unpriced: [] },
      futures: { ok: true, positionsOk: true, walletBalance: 200, availableMargin: 150,
        positionMargin: 50, unrealizedPnl: 0 },
    })]);
    eq(e.spot.value, 100);
    eq(e.futuresEquity.value, 200);
    eq(e.total.value, 300, '총자산이 현물 전체 + 선물 순자산이 아니다');
  });

  test('**현물 USDT만 더하지 않는다** — BTC·ETH가 총자산에서 빠지던 자리', () => {
    // 예전에는 `spot.usdt`만 합산했다. USDT 0 · BTC 5,000이면 현물이
    // 0으로 잡히고, 총자산에서 5,000이 통째로 사라졌다.
    const e = envWalletOf('LIVE', [conn({
      spot: { ok: true, usdt: 0, valueUsd: 5000, knownValueUsd: 5000, unpriced: [] },
      futures: { ok: true, positionsOk: true, walletBalance: 0, availableMargin: 0,
        positionMargin: 0, unrealizedPnl: 0 },
    })]);
    eq(e.spot.value, 5000);
    eq(e.total.value, 5000);
  });

  test('**선물은 지갑잔고가 아니라 순자산(잔고 + 미실현)이다**', () => {
    const e = envWalletOf('LIVE', [conn({
      spot: { ok: true, usdt: 0, valueUsd: 0, knownValueUsd: 0, unpriced: [] },
      futures: { ok: true, positionsOk: true, walletBalance: 1000, availableMargin: 900,
        positionMargin: 100, unrealizedPnl: -250 },
    })]);
    eq(e.futures.value, 1000, '지갑잔고는 따로 남아야 한다');
    eq(e.futuresEquity.value, 750);
    eq(e.total.value, 750, '미실현손익이 총자산에서 빠졌다');
  });

  test('버킷을 다 더하면 canonical 총자산과 같다 — 화면이 다른 숫자를 만들지 않는다', () => {
    const e = envWalletOf('LIVE', [conn({
      spot: { ok: true, usdt: 40, valueUsd: 300, knownValueUsd: 300, unpriced: [] },
      futures: { ok: true, positionsOk: true, walletBalance: 500, availableMargin: 400,
        positionMargin: 100, unrealizedPnl: 25 },
    })]);
    const t = totalEquityOf('LIVE', bucketsOf([e]));
    eq(e.total.value, 825);
    eq(t.total, 825, '버킷 합계와 총자산이 다르면 두 화면이 다른 숫자를 보인다');
  });

  console.log('[지갑 진실 — 모르면 총자산을 만들지 않는다]');

  test('**BTC 가격 UNKNOWN → 총자산 UNKNOWN, 확인된 부분만 따로**', () => {
    const spot: SpotWallet = { ok: true, usdt: 1000, assets: [
      { asset: 'USDT', free: 1000, locked: 0, valueUsd: 1000 },
      { asset: 'BTC', free: 1, locked: 0, valueUsd: null },
    ] };
    const fut: FuturesWallet = { ok: true, walletBalance: 200, availableMargin: 150,
      positionsOk: true, positionMargin: 50, unrealizedPnl: 10 };
    const tree = buildWalletTree(spot, fut);
    eq(tree.spotValueUsd, null);
    eq(tree.totalUsd, null, '미평가 자산이 있는데 총자산을 확정했다');
    eq(tree.spotKnownValueUsd, 1000, '확인된 부분합계는 남아야 한다');

    const e = envWalletOf('LIVE', [conn({
      spot: { ok: true, usdt: 1000, valueUsd: null, knownValueUsd: 1000, unpriced: ['BTC'] },
    })]);
    eq(e.total.value, null);
    eq(e.unpricedAssets.join(','), 'BTC');
    assert(/값을 매기지 못한/.test(e.note), e.note);
  });

  test('**futures positions 조회 실패 → 미실현손익이 0이 아니라 UNKNOWN**', () => {
    const e = envWalletOf('LIVE', [conn({
      futures: { ok: true, positionsOk: false, walletBalance: 200, availableMargin: 150,
        positionMargin: null, unrealizedPnl: null },
    })]);
    eq(e.unrealizedPnl.value, null, '포지션을 못 읽었는데 손익 0으로 적었다');
    eq(e.futuresEquity.value, null);
    eq(e.total.value, null, '모르는 미실현손익 위에 총자산을 만들었다');
  });

  test('**spot 조회 실패 → "모두 읽었습니다"라고 말하지 않는다**', () => {
    const e = envWalletOf('LIVE', [conn({ spot: { ok: false } })]);
    assert(!/모두 읽었습니다/.test(e.note), e.note);
    assert(/읽지 못한 값/.test(e.note), e.note);
    eq(e.total.value, null);
  });

  test('선물 잔고 실패도 총자산을 만들지 않는다', () => {
    const e = envWalletOf('LIVE', [conn({ futures: { ok: false } })]);
    eq(e.total.value, null);
    eq(e.futures.value, null);
  });

  console.log('[지갑 진실 — 환경을 모르면 어디에도 넣지 않는다]');

  test('**env null → LIVE 합계에서 제외된다**', () => {
    const rows = [conn({ connectionId: 'a', testnet: false }),
      conn({ connectionId: 'b', testnet: null })];
    const live = envWalletOf('LIVE', rows);
    eq(live.connections, 1, '환경을 모르는 연결이 실전 합계에 들어갔다');
    const test1 = envWalletOf('TESTNET', rows);
    eq(test1.connections, 0);
  });

  test('테스트넷과 실전은 서로 더해지지 않는다', () => {
    const rows = [
      conn({ connectionId: 'a', testnet: false,
        spot: { ok: true, usdt: 0, valueUsd: 100, knownValueUsd: 100, unpriced: [] } }),
      conn({ connectionId: 'b', testnet: true,
        spot: { ok: true, usdt: 0, valueUsd: 50000, knownValueUsd: 50000, unpriced: [] } }),
    ];
    eq(envWalletOf('LIVE', rows).spot.value, 100);
    eq(envWalletOf('TESTNET', rows).spot.value, 50000);
  });

  console.log('[지갑 진실 — 환율 없이 통화를 바꾸지 않는다]');

  test('**KRW 환율이 없으면 숫자에 ₩만 붙이지 않는다**', () => {
    const v = moneyView(5000, 'KRW', null);
    eq(v.converted, false);
    eq(v.available, false);
    eq(v.value, null);
    assert(!/5,000/.test(v.text), `달러 금액이 원화처럼 보인다: ${v.text}`);
    eq(currencyAvailable('KRW', null), false, '누를 수 없어야 하는 버튼이 열려 있다');
  });

  test('환율이 있으면 실제로 환산하고 근거를 남긴다', () => {
    const v = moneyView(100, 'KRW', { rate: 1300, currency: 'KRW', source: 'test', asOfMs: 0 });
    eq(v.converted, true);
    eq(v.value, 130000);
    assert(/1300/.test(v.reason), v.reason);
  });

  test('USD·USDT는 언제나 볼 수 있다 — 지갑 값이 USD 기준이다', () => {
    eq(currencyAvailable('USD', null), true);
    eq(currencyAvailable('USDT', null), true);
    assert(moneyView(1234.5, 'USD').text.startsWith('$'), moneyView(1234.5, 'USD').text);
    assert(/USDT$/.test(moneyView(1234.5, 'USDT').text), moneyView(1234.5, 'USDT').text);
  });

  test('USDT 표시는 1:1 가정이라는 사실을 숨기지 않는다', () => {
    assert(/1 USDT = 1 USD/.test(moneyView(10, 'USDT').reason), moneyView(10, 'USDT').reason);
  });

  test('값을 모르면 0으로 그리지 않는다', () => {
    eq(moneyView(null, 'USD').text, '확인 불가');
    eq(moneyView(null, 'USD').value, null);
  });

  console.log('[지갑 진실 — 입출금은 전 구간을 읽었을 때만 숫자다]');

  test('**일부 구간 UNKNOWN → 순입출금 null (Trading PnL도 못 낸다)**', () => {
    // 첫날 입금 100, 둘째 날 UNKNOWN이면 예전에는 합계가 정확한 100처럼
    // 나왔다. 그 값으로 매매손익을 내면 못 읽은 입금이 전부 수익이 된다.
    const cf = cashFlowOf([
      { takenAt: 1, totalEquity: 100, deposit: 100, withdrawal: 0 },
      { takenAt: 2, totalEquity: 300, deposit: null, withdrawal: 0 },
    ] as any);
    eq(cf.complete, false);
    eq(cf.net, null, '못 읽은 입금이 있는데 순입출금을 확정했다');
    eq(cf.deposit, null);
    eq(cf.unknownRows, 1);
  });

  test('전 구간을 읽었으면 숫자를 낸다', () => {
    const cf = cashFlowOf([
      { takenAt: 1, totalEquity: 100, deposit: 100, withdrawal: 0 },
      { takenAt: 2, totalEquity: 300, deposit: 50, withdrawal: 20 },
    ] as any);
    eq(cf.complete, true);
    eq(cf.deposit, 150);
    eq(cf.withdrawal, 20);
    eq(cf.net, 130);
  });

  test('기록이 아예 없으면 0이 아니라 모르는 것이다', () => {
    const cf = cashFlowOf([]);
    eq(cf.complete, false);
    eq(cf.net, null);
  });

  console.log('[지갑 진실 — 스냅샷 2001개]');

  test('**2001개가 쌓여도 최신 스냅샷을 고른다**', () => {
    // 15분마다 찍으면 하루 96개. 약 3주면 2000개를 넘고, 그때부터
    // `ascending + limit(2000)`은 **가장 오래된 2000개**만 읽는다.
    // 그러면 lastTaken이 3주 전에 고정되어 표가 계속 부풀고, 성과
    // 곡선과 현재 자산 기준점도 옛 구간을 본다.
    const total = 2001;
    const all = Array.from({ length: total }, (_, i) => ({
      takenAt: 1_700_000_000_000 + i * 15 * 60_000,
      totalEquity: 1000 + i,
    }));
    // DB에서 최신부터 2000개를 받은 상태 (가장 오래된 1개는 안 온다)
    const newestFirst = [...all].reverse().slice(0, 2000);
    const asc = newestFirstToAsc(newestFirst);

    eq(asc.length, 2000);
    eq(asc[0].takenAt < asc[asc.length - 1].takenAt, true, '오래된 순으로 정렬되지 않았다');
    eq(latestTakenMs(asc), all[total - 1].takenAt, '최신 스냅샷을 고르지 못했다');
    eq(asc[asc.length - 1].totalEquity, 1000 + (total - 1), '현재 자산 기준점이 옛 값이다');
  });

  test('뒤섞여 와도 시각으로 정렬한다 — DB 정렬을 믿지 않는다', () => {
    const rows = [{ takenAt: 30 }, { takenAt: 10 }, { takenAt: 20 }];
    eq(newestFirstToAsc(rows).map(r => r.takenAt).join(','), '10,20,30');
    eq(latestTakenMs(rows), 30);
  });

  test('기록이 없으면 마지막 시각은 0이 아니라 null이다', () => {
    eq(latestTakenMs([]), null);
    eq(latestTakenMs(null), null);
  });
}

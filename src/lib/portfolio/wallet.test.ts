// src/lib/portfolio/wallet.test.ts
//
// 막으려는 것:
//  1. **LIVE 화면에 MOCK 총자산이 섞이는 것.** 실제 돈과 테스트넷
//     가상자금과 모의 잔고는 더할 수 없다. 그냥 더하면 그럴듯한 숫자가
//     뜨는데 아무 뜻이 없다
//  2. 입금을 수익으로 세는 것 — 100만원을 넣으면 총자산이 100만원
//     늘지만 번 것은 0원이다
//  3. 조회 실패를 0으로 그리는 것 — 사용자는 자기 돈이 사라졌다고 본다
//  4. 세 칸 중 둘만 더해 '총자산'이라고 적는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  envOf, ENV_NOTE, WALLET_TABS, tabOf,
  amountOf, totalEquityOf, totalAcrossEnvs,
  equityChangeOf, todayPnlLabel, RECONCILE_EPS,
  type Bucket,
} from './wallet';

export function runWalletTests() {
  console.log('[지갑 — 환경을 절대 섞지 않는다]');

  const b = (id: string, env: any, value: any, readiness: any = 'OK'): Bucket =>
    ({ id, label: id, env, amount: amountOf(value, readiness) });

  test('다른 환경은 합산에서 빠지고, 그 사실을 적는다', () => {
    // LIVE 화면에 테스트넷 5만과 모의 1천만이 섞이면 총자산이 뜻을 잃는다.
    const t = totalEquityOf('LIVE', [
      b('gate-live', 'LIVE', 569),
      b('gate-testnet', 'TESTNET', 50_000),
      b('mock', 'MOCK', 10_000_000),
    ]);
    eq(t.total, 569);
    eq(t.buckets.length, 1);
    assert(t.note.includes('다른 환경의 계좌 2개는 합산에서 제외'), t.note);
  });

  test('환경을 합치려는 시도 자체를 막는다', () => {
    const v = totalAcrossEnvs();
    eq(v.total, null);
    assert(v.reason.includes('더할 수 없습니다'), v.reason);
  });

  test('모르는 환경을 실전으로 읽지 않는다', () => {
    // 실전으로 읽으면 가짜 돈이 실제 자산으로 합산된다.
    eq(envOf(null), 'TESTNET');
    eq(envOf('아무거나'), 'TESTNET');
    eq(envOf(''), 'TESTNET');
    eq(envOf('LIVE_SMALL'), 'LIVE');
    eq(envOf('PAPER'), 'MOCK');
  });

  test('테스트넷·모의에 실제 가치가 없다고 적는다', () => {
    assert(ENV_NOTE.TESTNET.includes('실제 가치가 없습니다'), ENV_NOTE.TESTNET);
    assert(ENV_NOTE.MOCK.includes('거래소와 무관'), ENV_NOTE.MOCK);
  });

  console.log('[지갑 — 못 읽은 것을 0으로 적지 않는다]');

  test('조회 실패는 0이 아니라 확인 불가다', () => {
    const a = amountOf(null, 'FAILED');
    eq(a.value, null);
    eq(a.text, '확인 불가');
  });

  test('숫자가 아니면 실패로 본다', () => {
    for (const bad of [null, undefined, '', 'abc', NaN, true]) {
      eq(amountOf(bad).value, null, String(bad));
    }
  });

  test('진짜 0은 0이다', () => {
    const a = amountOf(0);
    eq(a.value, 0);
    eq(a.readiness, 'OK');
  });

  test('한 칸이라도 못 읽으면 총자산을 내지 않는다', () => {
    // 세 칸 중 둘만 더해 '총자산'이라고 적으면 못 읽은 칸이 0으로 보인다.
    const t = totalEquityOf('LIVE', [
      b('선물', 'LIVE', 500),
      b('현물', 'LIVE', null, 'FAILED'),
    ]);
    eq(t.total, null);
    eq(t.complete, false);
    assert(t.missing.includes('현물'), t.missing.join(','));
    assert(t.note.includes('총자산을 내지 않습니다'), t.note);
  });

  test('계좌가 없으면 그렇다고 한다', () => {
    const t = totalEquityOf('LIVE', []);
    eq(t.total, null);
    assert(t.note.includes('계좌가 없습니다'), t.note);
  });

  test('전부 읽었으면 합계를 낸다', () => {
    const t = totalEquityOf('LIVE', [b('선물', 'LIVE', 500), b('현물', 'LIVE', 69)]);
    eq(t.total, 569);
    eq(t.complete, true);
    eq(t.note, '');
  });

  console.log('[지갑 — 입금은 수익이 아니다]');

  test('입금 때문에 자산이 는 것을 수익으로 세지 않는다', () => {
    // 100만원 넣고 매매로 1만원 벌었다.
    const c = equityChangeOf(1_010_000, {
      realizedPnl: 10_000, unrealizedPnl: 0,
      deposit: 1_000_000, withdrawal: 0, fees: 0, funding: 0,
    });
    eq(c.tradingPnl, 10_000);
    eq(c.netExternalFlow, 1_000_000);
    eq(c.reconciled, true);
    assert(c.equityDelta! > c.tradingPnl!, '자산 변화가 손익보다 커야 한다');
  });

  test('오늘 손익에 입출금이 있었다고 적는다', () => {
    const c = equityChangeOf(1_010_000, {
      realizedPnl: 10_000, unrealizedPnl: 0,
      deposit: 1_000_000, withdrawal: 0, fees: 0, funding: 0,
    });
    const l = todayPnlLabel(c);
    assert(l.headline.startsWith('+10,000'), l.headline);
    assert(l.caution.includes('입출금'), l.caution);
    assert(l.caution.includes('다릅니다'), l.caution);
  });

  test('입출금이 없으면 군말이 없다', () => {
    const c = equityChangeOf(9_700, {
      realizedPnl: 10_000, unrealizedPnl: 0,
      deposit: 0, withdrawal: 0, fees: 200, funding: 100,
    });
    eq(c.reconciled, true);
    eq(todayPnlLabel(c).caution, '');
  });

  test('비용을 빼고 센다', () => {
    const c = equityChangeOf(9_700, {
      realizedPnl: 10_000, unrealizedPnl: 0,
      deposit: 0, withdrawal: 0, fees: 200, funding: 100,
    });
    eq(c.costs, 300);
    eq(c.tradingPnl, 10_000, '손익 자체는 비용 전이다');
  });

  test('합이 안 맞으면 그렇다고 말한다', () => {
    // 안 세고 있는 항목이 있다는 뜻이다.
    const c = equityChangeOf(20_000, {
      realizedPnl: 10_000, unrealizedPnl: 0,
      deposit: 0, withdrawal: 0, fees: 0, funding: 0,
    });
    eq(c.reconciled, false);
    close(c.unexplained!, 10_000, 1e-9);
    assert(c.note.includes('안 세고 있는 항목'), c.note);
  });

  test('반올림 수준은 맞은 것으로 본다', () => {
    const c = equityChangeOf(10_000 + RECONCILE_EPS / 2, {
      realizedPnl: 10_000, unrealizedPnl: 0,
      deposit: 0, withdrawal: 0, fees: 0, funding: 0,
    });
    eq(c.reconciled, true);
  });

  test('항목을 못 읽으면 쪼개지 않는다', () => {
    // 모르는 값을 0으로 더하면 수익이 실제보다 좋게 나온다.
    const c = equityChangeOf(10_000, { realizedPnl: 10_000 });
    eq(c.tradingPnl, null);
    assert(c.missing.includes('수수료'), c.missing.join(','));
    assert(c.note.includes('좋게 나옵니다'), c.note);
  });

  test('자산 변화를 모르면 아무것도 못 쪼갠다', () => {
    const c = equityChangeOf(null, {
      realizedPnl: 1, unrealizedPnl: 0, deposit: 0, withdrawal: 0, fees: 0, funding: 0,
    });
    eq(c.tradingPnl, null);
    assert(c.missing.includes('자산 변화'), c.missing.join(','));
  });

  test('오늘 손익을 못 내면 확인 불가라고 적는다', () => {
    const l = todayPnlLabel(equityChangeOf(null, {}));
    eq(l.headline, '확인 불가');
    assert(l.caution.length > 0, l.caution);
  });

  console.log('[지갑 — 탭]');

  test('다섯 탭이 있고 개요가 처음이다', () => {
    eq(WALLET_TABS.length, 5);
    eq(WALLET_TABS[0].id, 'overview');
    eq(WALLET_TABS.map(t => t.id).join(','), 'overview,futures,spot,strategy,longterm');
  });

  test('모르는 탭은 개요다', () => {
    eq(tabOf(null), 'overview');
    eq(tabOf('아무거나'), 'overview');
    eq(tabOf('strategy'), 'strategy');
  });
}

// src/lib/portfolio/walletOverview.test.ts
//
// **환경이 다르면 다른 돈이다. 그리고 못 읽은 것은 0이 아니다.**
//
// 이 화면이 만들어진 이유가 "실전 화면에 모의 총자산이 섞여 있던 것"이다.
// 그 사고가 돌아오는 길을 값으로 막는다.

import { test, eq, assert } from '../../test/harness';
import {
  envOfConnection, envWalletOf, bucketsOf, totalAcrossEnvs,
  type ConnectionWallet,
} from './walletOverview';

const C = (over: Partial<ConnectionWallet> = {}): ConnectionWallet => ({
  connectionId: 'c1', exchangeId: 'gate', testnet: true, ok: true, error: null,
  futures: { ok: true, walletBalance: 1000, availableMargin: 900, positionMargin: 100, unrealizedPnl: 5 },
  spot: { ok: true, usdt: 50 },
  ...over,
});

export function runWalletOverviewTests() {
  console.log('[지갑 개요 — 환경을 섞지 않는다]');

  test('is_testnet === false 만 실전이다', () => {
    // 여기서만 다르게 읽으면 값이 빈 연결이 실전 합계에 들어간다.
    eq(envOfConnection({ testnet: false }), 'LIVE');
    eq(envOfConnection({ testnet: true }), 'TESTNET');
    // **모르는 것을 어느 쪽에도 넣지 않는다.**
    eq(envOfConnection({ testnet: null }), null);
    eq(envOfConnection({ testnet: undefined }), null);
  });

  test('실전과 테스트넷을 절대 합치지 않는다', () => {
    const all = [C({ connectionId: 'a', testnet: true }), C({ connectionId: 'b', testnet: false })];
    const live = envWalletOf('LIVE', all);
    const test = envWalletOf('TESTNET', all);
    eq(live.connections, 1); eq(test.connections, 1);
    eq(live.futures.value, 1000); eq(test.futures.value, 1000);
    // 합계를 구하는 함수 자체가 없다 — 있으면 언젠가 누가 쓴다.
    eq(totalAcrossEnvs().total, null);
    assert(totalAcrossEnvs().reason.includes('합치지 않습니다'), totalAcrossEnvs().reason);
  });

  test('같은 환경의 연결 여럿은 합친다 — 같은 성격의 돈이다', () => {
    const w = envWalletOf('TESTNET', [
      C({ connectionId: 'a' }),
      C({ connectionId: 'b', futures: { ok: true, walletBalance: 500, availableMargin: 500, positionMargin: 0, unrealizedPnl: 0 } }),
    ]);
    eq(w.futures.value, 1500);
    eq(w.connections, 2);
  });

  console.log('[지갑 개요 — 못 읽은 것을 0으로 만들지 않는다]');

  test('한 연결이라도 못 읽으면 그 환경의 합계는 확인 불가다', () => {
    // **부분 합계를 총자산이라 적지 않는다.** 조회가 하나 실패한 날
    // 자산이 줄어든 것처럼 보이면, 사용자는 손실이 난 줄 안다.
    const w = envWalletOf('TESTNET', [
      C({ connectionId: 'a' }),
      C({ connectionId: 'b', ok: false, futures: null, spot: null, error: 'timeout' }),
    ]);
    eq(w.futures.value, null);
    eq(w.futures.readiness, 'FAILED');
    assert(w.note.includes('부분 합계를'), w.note);
  });

  test('선물 조회만 실패해도 합계는 확인 불가다', () => {
    const w = envWalletOf('TESTNET', [C({ futures: { ok: false } })]);
    eq(w.futures.value, null);
    eq(w.futures.readiness, 'FAILED');
  });

  test('연결이 없으면 "없음"이지 "확인 불가"가 아니다', () => {
    const w = envWalletOf('LIVE', [C({ testnet: true })]);
    eq(w.connections, 0);
    eq(w.futures.readiness, 'NOT_APPLICABLE');
    assert(w.note.includes('연결된 계좌가 없습니다'), w.note);
  });

  test('환경을 모르는 연결은 어느 쪽에도 안 들어간다', () => {
    const all = [C({ testnet: null })];
    eq(envWalletOf('LIVE', all).connections, 0);
    eq(envWalletOf('TESTNET', all).connections, 0);
  });

  test('실제 0과 확인 불가를 구분한다', () => {
    // 잔고가 진짜 0인 계좌는 0으로 적어야 한다 — 그건 사실이다.
    const w = envWalletOf('TESTNET', [
      C({ futures: { ok: true, walletBalance: 0, availableMargin: 0, positionMargin: 0, unrealizedPnl: 0 } }),
    ]);
    eq(w.futures.value, 0);
    eq(w.futures.readiness, 'OK');
  });

  console.log('[지갑 개요 — 화면이 그리는 것]');

  test('전략계좌·장기투자는 0이 아니라 "아직 없음"이다', () => {
    // 0을 그리면 사용자는 그 칸의 돈이 사라졌다고 믿는다.
    const b = bucketsOf([envWalletOf('TESTNET', [C()])]);
    const strat = b.find(x => x.kind === 'strategy')!;
    eq(strat.amount.value, null);
    eq(strat.amount.readiness, 'NOT_APPLICABLE');
  });

  test('환경마다 버킷 네 개가 나온다', () => {
    const b = bucketsOf([envWalletOf('LIVE', []), envWalletOf('TESTNET', [C()])]);
    eq(b.length, 8);
    eq(b.filter(x => x.env === 'TESTNET').length, 4);
  });

  test('이상한 입력으로도 터지지 않는다', () => {
    eq(envWalletOf('LIVE', null as any).connections, 0);
    eq(bucketsOf(null as any).length, 0);
  });
}

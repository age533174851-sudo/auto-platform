// src/lib/markets/wallets.test.ts
//
// 막으려는 것: **현물 잔고가 선물 증거금으로 새는 것.**
// 현물 USDT 1,000이 있어도 선물 지갑이 비어 있으면 포지션은 못 연다.
// 그 사실이 계산 어디에서도 흐려지면 안 된다.
import { test, assert, eq } from '../../test/harness';
import {
  buildWalletTree, canOpenFutures, spotAllocation,
  SPOT_UNAVAILABLE, FUTURES_UNAVAILABLE,
  type SpotWallet, type FuturesWallet,
} from './wallets';

const spot = (over: Partial<SpotWallet> = {}): SpotWallet => ({
  ok: true, usdt: 1000,
  assets: [
    { asset: 'USDT', free: 1000, locked: 0, valueUsd: 1000 },
    { asset: 'BTC', free: 0.05, locked: 0, valueUsd: 3000 },
  ],
  ...over,
});

const fut = (over: Partial<FuturesWallet> = {}): FuturesWallet => ({
  ok: true, walletBalance: 200, availableMargin: 150,
  positionMargin: 50, unrealizedPnl: 10,
  ...over,
});

export function runWalletTests() {
  console.log('[통합 자산 — 현물이 선물 증거금으로 새지 않는다]');

  test('현물 USDT는 선물 가용 증거금에 포함되지 않는다', () => {
    const t = buildWalletTree(spot({ usdt: 1000 }), fut({ availableMargin: 150 }));
    eq(t.futuresUsableMargin, 150,
      '현물 잔고가 선물 증거금에 섞였다 — 없는 돈으로 포지션 크기를 정하게 된다');
  });

  test('현물에 돈이 많아도 선물 증거금이 모자라면 못 연다', () => {
    const t = buildWalletTree(spot({ usdt: 100_000 }), fut({ availableMargin: 150 }));
    const r = canOpenFutures(t, 500);
    eq(r.ok, false, '현물 잔고를 근거로 선물 주문이 통과했다');
    assert(Math.abs((r.shortfallUsd ?? 0) - 350) < 1e-9, String(r.shortfallUsd));
  });

  test('부족할 때 현물에 돈이 있으면 이체가 필요하다고 말해준다', () => {
    const t = buildWalletTree(spot({ usdt: 1000 }), fut({ availableMargin: 100 }));
    const r = canOpenFutures(t, 400);
    assert(r.reason!.includes('이체'), r.reason);
  });

  test('선물 증거금 안이면 통과한다', () => {
    const t = buildWalletTree(spot(), fut({ availableMargin: 150 }));
    eq(canOpenFutures(t, 100).ok, true);
    eq(canOpenFutures(t, 150).ok, true, '딱 맞는 금액이 막혔다');
  });

  test('이체가 필요한 금액을 따로 알려준다', () => {
    const t = buildWalletTree(spot({ usdt: 777 }), fut());
    eq(t.needsTransferUsd, 777);
  });

  console.log('[통합 자산 — 모르는 것은 0이 아니다]');

  test('선물 조회 실패면 가용 증거금이 0이 아니라 null이다', () => {
    const t = buildWalletTree(spot(), FUTURES_UNAVAILABLE);
    eq(t.futuresUsableMargin, null, '조회 실패를 "증거금 0"으로 보여줬다');
    eq(t.futuresEquity, null);
  });

  test('한쪽이라도 모르면 총자산을 내지 않는다', () => {
    eq(buildWalletTree(spot(), FUTURES_UNAVAILABLE).totalUsd, null,
      '반쪽 합계는 자산이 줄어든 것처럼 보인다');
    eq(buildWalletTree(SPOT_UNAVAILABLE, fut()).totalUsd, null);
  });

  test('둘 다 알면 합계를 낸다', () => {
    // 현물 4000 + 선물(200 잔고 + 10 미실현) = 4210
    const t = buildWalletTree(spot(), fut());
    eq(t.spotValueUsd, 4000);
    eq(t.futuresEquity, 210);
    eq(t.totalUsd, 4210);
  });

  test('선물 조회 실패면 주문 가능 여부도 모른다고 답한다', () => {
    const r = canOpenFutures(buildWalletTree(spot(), FUTURES_UNAVAILABLE), 10);
    eq(r.ok, false);
    assert(r.reason!.includes('확인하지 못'), r.reason);
  });

  console.log('[통합 자산 — 값을 못 매긴 자산]');

  test('가격을 모르는 자산은 합계에서 빼되 이름을 남긴다', () => {
    const t = buildWalletTree(spot({
      assets: [
        { asset: 'USDT', free: 1000, locked: 0, valueUsd: 1000 },
        { asset: 'XYZ', free: 5, locked: 0, valueUsd: null },
      ],
    }), fut());
    eq(t.spotValueUsd, 1000, '값을 모르는 자산을 0으로 더했다');
    eq(t.spotUnpriced.join(','), 'XYZ', '빠진 자산을 알려주지 않으면 이유를 알 수 없다');
  });

  test('비중은 값을 매길 수 있는 자산 안에서만 낸다', () => {
    const alloc = spotAllocation(spot({
      assets: [
        { asset: 'BTC', free: 1, locked: 0, valueUsd: 7500 },
        { asset: 'USDT', free: 2500, locked: 0, valueUsd: 2500 },
        { asset: 'XYZ', free: 5, locked: 0, valueUsd: null },
      ],
    }));
    eq(alloc.length, 2);
    eq(alloc[0].asset, 'BTC', '큰 것부터 나오지 않았다');
    assert(Math.abs(alloc[0].pct - 75) < 1e-9, String(alloc[0].pct));
    const sum = alloc.reduce((s, a) => s + a.pct, 0);
    assert(Math.abs(sum - 100) < 1e-9, `비중 합이 100이 아니다: ${sum}`);
  });

  test('현물 조회 실패면 비중을 내지 않는다', () => {
    eq(spotAllocation(SPOT_UNAVAILABLE).length, 0);
  });

  console.log('[통합 자산 — 두 지갑이 분리돼 있다]');

  test('트리에 두 지갑이 각각 남아 있다', () => {
    const t = buildWalletTree(spot(), fut());
    // 합계만 남기고 원본을 버리면 화면이 "어느 지갑의 돈인지"를 못 보여준다
    eq(t.spot.ok, true);
    eq(t.futures.ok, true);
    eq(t.futures.positionMargin, 50);
    eq(t.spot.assets.length, 2);
  });

  test('미실현손익은 선물 쪽에만 있다', () => {
    const t = buildWalletTree(spot(), fut({ unrealizedPnl: -30, walletBalance: 200 }));
    eq(t.futuresEquity, 170, '미실현손익이 순자산에 반영되지 않았다');
    eq(t.spotValueUsd, 4000, '현물이 선물 손익의 영향을 받았다');
  });
}

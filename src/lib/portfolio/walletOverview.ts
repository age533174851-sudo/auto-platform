// src/lib/portfolio/walletOverview.ts
//
// **환경이 다르면 다른 돈이다.**
//
// 지금 지갑 화면이 왜 "확인 불가"인가
// ───────────────────────────────────
// `/api/wallets`는 Gate·Binance의 현물·선물 잔고를 **이미 읽을 수 있다.**
// 그런데 `WalletPage`는 이렇게 돼 있었다:
//
//     const allAccounts: AccountOption[] = [];
//     const snapshots: any[] = [];
//     amountOf(null, 'LOADING')      ← 모든 버킷
//
// 돈을 못 읽는 게 아니라 **화면이 안 물어본 것**이다. 주석에는 "아직
// 거래소를 안 붙였다"고 정직하게 적혀 있었지만, 붙일 것은 이미 있었다.
//
// 이 파일이 하는 일
// ─────────────────
// 연결 여러 개의 조회 결과를 **환경별로** 묶는다. 그리고 규칙 하나:
//
//   **LIVE · TESTNET · MOCK을 절대 합치지 않는다.**
//
// 테스트넷 가상 자금과 실계좌 돈을 더한 숫자는 아무 뜻이 없고, 그걸
// 총자산이라고 보여주면 사용자는 있지도 않은 돈을 셈한다.
//
// 그리고 **못 읽은 것을 0으로 만들지 않는다.** 한 연결이라도 실패하면
// 그 환경의 합계는 null이다 — 부분 합계를 총자산이라고 적으면, 조회가
// 하나 실패한 날 자산이 줄어든 것처럼 보인다.

import { amountOf, type Amount, type Bucket, type WalletEnv } from './wallet';

/** 연결 하나의 조회 결과 (readWallet이 준 것에서 화면에 필요한 것만) */
export interface ConnectionWallet {
  connectionId: string;
  exchangeId: string | null;
  /** **`is_testnet === false`일 때만 실전이다** (저장소 공통 규칙) */
  testnet: boolean | null;
  label?: string | null;
  /** 연결 자체를 읽었는가. **안의 지갑이 다 맞다는 뜻이 아니다** */
  ok: boolean;
  error?: string | null;
  futures?: {
    ok: boolean;
    /** 포지션 목록을 읽었는가. false면 미실현손익은 모르는 값이다 */
    positionsOk?: boolean;
    walletBalance?: number | null;
    availableMargin?: number | null;
    positionMargin?: number | null;
    unrealizedPnl?: number | null;
  } | null;
  spot?: {
    ok: boolean;
    /** 현물에서 바로 쓸 수 있는 USDT (총자산이 아니다) */
    usdt?: number | null;
    /**
     * **현물 전체 평가액.** 값을 못 매긴 자산이 하나라도 있으면 null이다.
     *
     * 예전에는 `usdt`만 합산해서 BTC·ETH가 총자산에서 통째로 빠졌다.
     */
    valueUsd?: number | null;
    /** 값을 매길 수 있었던 자산만의 합 — 총액이 아니다 */
    knownValueUsd?: number | null;
    /** 값을 못 매긴 자산 이름 */
    unpriced?: string[] | null;
  } | null;
}

/**
 * 이 연결은 어느 환경인가.
 *
 * **못 읽었으면 null이다.** 모르는 연결을 LIVE로 넣으면 실계좌 합계가
 * 틀리고, TESTNET으로 넣으면 실제 돈이 가상 자금 칸에 들어간다.
 */
export function envOfConnection(c: { testnet: boolean | null | undefined }): WalletEnv | null {
  if (c?.testnet === false) return 'LIVE';
  if (c?.testnet === true) return 'TESTNET';
  return null;
}

export interface EnvWallet {
  env: WalletEnv;
  /** 이 환경의 연결 수 */
  connections: number;
  /** 읽는 데 성공한 연결 수 */
  read: number;
  /** 선물 **지갑잔고** 합계(미실현 제외). **하나라도 못 읽으면 null** */
  futures: Amount;
  /** 선물 순자산 = 지갑잔고 + 미실현손익. 미실현을 모르면 null */
  futuresEquity: Amount;
  /** 현물 **전체 평가액**. 값을 못 매긴 자산이 있으면 null */
  spot: Amount;
  /**
   * **이 환경의 총자산.** 화면이 '총자산'이라고 적을 수 있는 유일한 값.
   *
   * = 현물 전체 평가액 + 선물 순자산
   *
   * 예전에는 화면마다 자기 방식으로 만들었다. 홈은 `futures`(지갑잔고)
   * 하나를 총자산이라 적었고 — 현물도 미실현도 빠진 값이다 — 지갑은
   * 현물 USDT만 더했다. **같은 계좌가 화면마다 다른 총자산을 보였다.**
   */
  total: Amount;
  availableMargin: Amount;
  positionMargin: Amount;
  unrealizedPnl: Amount;
  /** 값을 못 매긴 현물 자산 이름 — 총자산이 null인 이유를 화면이 말한다 */
  unpricedAssets: string[];
  /** 화면이 그대로 적을 한 줄 */
  note: string;
}

const sumOrNull = (
  rows: Array<number | null | undefined>,
): { value: number | null; complete: boolean } => {
  let total = 0;
  for (const r of rows) {
    if (r == null || !Number.isFinite(Number(r))) return { value: null, complete: false };
    total += Number(r);
  }
  return { value: Number(total.toFixed(8)), complete: true };
};

function amountFrom(rows: Array<number | null | undefined>, anyConnections: boolean): Amount {
  if (!anyConnections) return amountOf(null, 'NOT_APPLICABLE');
  const s = sumOrNull(rows);
  // **부분 합계를 총자산이라 적지 않는다.**
  return s.complete ? amountOf(s.value, 'OK') : amountOf(null, 'FAILED');
}

/**
 * 환경 하나의 합계.
 *
 * 같은 환경 안에서는 연결이 여럿이어도 합친다 — 같은 성격의 돈이다.
 * **환경이 다르면 절대 합치지 않는다.**
 */
export function envWalletOf(env: WalletEnv, all: ConnectionWallet[]): EnvWallet {
  const mine = (Array.isArray(all) ? all : []).filter(c => envOfConnection(c) === env);
  const okOnes = mine.filter(c => c.ok);
  const has = mine.length > 0;

  const futures = amountFrom(mine.map(c => c.futures?.ok ? c.futures?.walletBalance : null), has);

  // **현물은 USDT가 아니라 전체 평가액이다.** 예전에는 `usdt`만 더해서
  // BTC·ETH가 총자산에서 통째로 빠졌다. 그리고 값을 못 매긴 자산이 있는
  // 연결은 `valueUsd`가 null이므로 여기서 합계도 null이 된다 — 맞다.
  const spot = amountFrom(mine.map(c => c.spot?.ok ? c.spot?.valueUsd : null), has);

  const unrealizedPnl = amountFrom(
    mine.map(c => (c.futures?.ok && c.futures?.positionsOk !== false) ? c.futures?.unrealizedPnl : null), has);

  // 선물 순자산 = 지갑잔고 + 미실현손익. 연결마다 계산해서 더한다 —
  // 합계끼리 더하면 한쪽이 null일 때 어느 연결이 문제인지 사라진다.
  const futuresEquity = amountFrom(mine.map(c => {
    if (!c.futures?.ok || c.futures?.positionsOk === false) return null;
    const w = c.futures?.walletBalance; const u = c.futures?.unrealizedPnl;
    if (w == null || u == null) return null;
    return Number(w) + Number(u);
  }), has);

  // **총자산은 현물 전체 + 선물 순자산이다.** 둘 중 하나라도 모르면 모른다.
  const total: Amount = !has
    ? amountOf(null, 'NOT_APPLICABLE')
    : (spot.value != null && futuresEquity.value != null)
      ? amountOf(Number((spot.value + futuresEquity.value).toFixed(8)), 'OK')
      : amountOf(null, 'FAILED');

  const unpricedAssets: string[] = [];
  for (const c of mine) {
    for (const a of (Array.isArray(c.spot?.unpriced) ? c.spot!.unpriced! : [])) {
      if (!unpricedAssets.includes(a)) unpricedAssets.push(a);
    }
  }

  // **부분 실패를 빠뜨리지 않는다.** 예전에는 선물 실패만 셌고 현물
  // 실패는 어디에도 안 잡혔다 — 그래서 "모두 읽었습니다"가 나왔다.
  const failed = mine.filter(c =>
    !c.ok || c.futures?.ok === false || c.spot?.ok === false || c.futures?.positionsOk === false);
  const note = !has
    ? `${env} 환경에 연결된 계좌가 없습니다`
    : failed.length > 0
      ? `연결 ${mine.length}개 중 ${failed.length}개에서 읽지 못한 값이 있습니다 — `
        + '부분 합계를 총자산으로 적지 않습니다'
      : unpricedAssets.length > 0
        ? `연결 ${mine.length}개를 모두 읽었지만 값을 매기지 못한 자산이 ${unpricedAssets.length}종 있습니다`
          + ` (${unpricedAssets.join(', ')}) — 총자산을 확정하지 않습니다`
        : `연결 ${mine.length}개를 모두 읽었습니다`;

  return {
    env, connections: mine.length, read: okOnes.length,
    futures, futuresEquity, spot, total,
    availableMargin: amountFrom(mine.map(c => c.futures?.ok ? c.futures?.availableMargin : null), has),
    positionMargin: amountFrom(
      mine.map(c => (c.futures?.ok && c.futures?.positionsOk !== false) ? c.futures?.positionMargin : null), has),
    unrealizedPnl,
    unpricedAssets,
    note,
  };
}

/**
 * 화면이 그리는 버킷.
 *
 * 전략계좌·장기투자는 아직 읽을 곳이 없다 — **0이 아니라 '아직 없음'이다.**
 * 0을 그리면 사용자는 그 칸의 돈이 사라졌다고 믿는다.
 */
export function bucketsOf(envs: EnvWallet[]): Bucket[] {
  const out: Bucket[] = [];
  for (const e of (Array.isArray(envs) ? envs : [])) {
    // **선물 칸은 순자산(지갑잔고 + 미실현손익)이다.**
    //
    // 예전에는 지갑잔고만 넣었다. 그러면 버킷을 다 더해도 총자산이 안
    // 나온다 — 화면이 "총자산"이라 적은 숫자와 서버가 만든 총자산이
    // 서로 달랐다. 두 값이 다르면 언젠가 둘 다 못 믿게 된다.
    out.push({ id: `${e.env}-futures`, label: '선물', env: e.env, kind: 'futures', amount: e.futuresEquity });
    out.push({ id: `${e.env}-spot`, label: '현물', env: e.env, kind: 'spot', amount: e.spot });
    out.push({
      id: `${e.env}-strategy`, label: '전략계좌', env: e.env, kind: 'strategy',
      amount: amountOf(null, 'NOT_APPLICABLE'),
    });
    out.push({
      id: `${e.env}-longterm`, label: '장기투자', env: e.env, kind: 'longterm',
      amount: amountOf(null, 'NOT_APPLICABLE'),
    });
  }
  return out;
}

/**
 * 환경을 합치려는 시도를 막는다.
 *
 * 이 함수는 **언제나 null을 돌려준다.** 함수로 두는 이유는 하나다 —
 * 나중에 누가 "전체 합계도 보여주자"고 할 때, 여기 와서 이 주석을
 * 읽게 하려는 것이다.
 *
 * 테스트넷 가상 자금 $50,000과 실계좌 $200을 더한 $50,200은 아무 뜻이
 * 없다. 그걸 총자산이라고 보여주면 사용자는 있지도 않은 돈을 셈한다.
 */
export function totalAcrossEnvs(): { total: null; reason: string } {
  return {
    total: null,
    reason: '실전 · 테스트넷 · 모의 자산은 합치지 않습니다 — 성격이 다른 돈입니다',
  };
}

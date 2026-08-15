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
  ok: boolean;
  error?: string | null;
  futures?: {
    ok: boolean;
    walletBalance?: number | null;
    availableMargin?: number | null;
    positionMargin?: number | null;
    unrealizedPnl?: number | null;
  } | null;
  spot?: { ok: boolean; usdt?: number | null } | null;
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
  /** 선물 지갑 합계. **하나라도 못 읽으면 null** */
  futures: Amount;
  spot: Amount;
  availableMargin: Amount;
  positionMargin: Amount;
  unrealizedPnl: Amount;
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
  const spot = amountFrom(mine.map(c => c.spot?.ok ? c.spot?.usdt : null), has);

  const failed = mine.filter(c => !c.ok || c.futures?.ok === false);
  const note = !has
    ? `${env} 환경에 연결된 계좌가 없습니다`
    : failed.length > 0
      ? `연결 ${mine.length}개 중 ${failed.length}개를 읽지 못했습니다 — `
        + '부분 합계를 총자산으로 적지 않습니다'
      : `연결 ${mine.length}개를 모두 읽었습니다`;

  return {
    env, connections: mine.length, read: okOnes.length,
    futures, spot,
    availableMargin: amountFrom(mine.map(c => c.futures?.ok ? c.futures?.availableMargin : null), has),
    positionMargin: amountFrom(mine.map(c => c.futures?.ok ? c.futures?.positionMargin : null), has),
    unrealizedPnl: amountFrom(mine.map(c => c.futures?.ok ? c.futures?.unrealizedPnl : null), has),
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
    out.push({ id: `${e.env}-futures`, label: '선물', env: e.env, kind: 'futures', amount: e.futures });
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

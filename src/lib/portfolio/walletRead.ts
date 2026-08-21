// src/lib/portfolio/walletRead.ts
//
// **같은 판단을 두 곳에 두지 않는다.**
//
// 자산을 찍는 일이 GET에서 워커로 옮겨 가면서, "이 사용자의 지갑을
// 읽는다"가 두 곳에 필요해졌다 — 화면에 보여줄 때(GET)와 곡선에 찍을
// 때(워커가 깨우는 POST).
//
// 그걸 복사하면 이 저장소가 반복해서 겪은 고장이 그대로 재현된다 —
// **경로가 둘인데 한쪽만 고침.** 화면이 보는 총자산과 곡선에 찍히는
// 총자산이 갈리면, 어느 쪽도 못 믿게 된다. 그래서 읽는 일은 여기 하나다.
//
// 이 파일은 판정을 하지 않는다. 조회하고, 이미 테스트가 붙은
// `envWalletOf`에 넘긴다.

import { readConnectionWallet } from '@/lib/markets/readWallet';
import { envWalletOf, type ConnectionWallet, type EnvWallet } from './walletOverview';

export interface WalletReadResult {
  /** 연결 목록을 읽었는가. **false면 아래 값들을 사실로 쓰면 안 된다** */
  ok: boolean;
  error: string | null;
  /** 활성 연결 원본 행 */
  connections: any[] | null;
  reads: ConnectionWallet[];
  envs: EnvWallet[];
  /** 계좌별 상세(현물 자산 목록·선물 칸) */
  detail: Record<string, { spotAssets: any[]; futures: any }>;
  /**
   * 환경별 활성 연결 id. **장부 완전성 대조의 기대 집합이다.**
   * 연결 목록을 못 읽었으면 null — 빈 배열로 두면 "대조할 것이 없다"가
   * 되어 언제나 통과한다.
   */
  connectionIdsByEnv: { LIVE: string[]; TESTNET: string[] } | null;
}

/** 이 워커·이 앱이 실행할 수 있는 거래소. 목록이 두 곳에 있으면 하나만 는다 */
const SUPPORTED = ['binance', 'gate'];

/**
 * 한 사용자의 지갑 전부.
 *
 * **못 읽은 것을 빈 목록으로 두지 않는다.** 빈 목록이면 화면이
 * "연결된 계좌가 없습니다"라고 적고, 사용자는 연결이 풀린 줄 안다.
 */
export async function readUserWallets(sb: any, userId: string): Promise<WalletReadResult> {
  let connections: any[] | null = null;
  let error: string | null = null;
  try {
    // **기본 합산은 살아 있는 연결만.** 비활성/옛 연결까지 조회하면 그
    // 실패 하나 때문에 환경 전체 총자산이 "확인 불가"가 되고, 쓸데없는
    // 거래소 호출도 늘어난다.
    const { data, error: e } = await sb.from('exchange_connections')
      .select('id, exchange_id, label, is_testnet, has_withdrawal, is_active')
      .eq('user_id', userId).eq('is_active', true);
    if (e) throw new Error(e.message);
    connections = (Array.isArray(data) ? data : []).filter((c: any) =>
      SUPPORTED.includes(String(c?.exchange_id ?? '').toLowerCase()));
  } catch (e: any) {
    error = String(e?.message || e);
  }

  if (connections == null) {
    return {
      ok: false, error, connections: null, reads: [], envs: [], detail: {},
      connectionIdsByEnv: null,
    };
  }

  const detail: Record<string, { spotAssets: any[]; futures: any }> = {};

  // 하나가 실패해도 나머지는 보여준다. **실패한 것을 0으로 채우지
  // 않는다** — 합산 쪽이 "하나라도 모르면 null"로 처리한다.
  const reads = await Promise.all(connections.map(async (c: any): Promise<ConnectionWallet> => {
    const r: any = await readConnectionWallet(sb, userId, String(c.id));
    detail[String(c.id)] = {
      // **못 읽었으면 빈 목록이 아니라 그 사실을 남긴다.**
      spotAssets: r.spotOk && Array.isArray(r.spot?.assets)
        ? r.spot.assets.map((a: any) => ({
          asset: a.asset, free: a.free, locked: a.locked, valueUsd: a.valueUsd,
        }))
        : [],
      futures: r.futuresOk ? {
        walletBalance: r.futures?.walletBalance ?? null,
        availableMargin: r.futures?.availableMargin ?? null,
        positionMargin: r.futures?.positionMargin ?? null,
        unrealizedPnl: r.futures?.unrealizedPnl ?? null,
        positionsOk: r.positionsOk,
      } : null,
    };
    return {
      connectionId: String(c.id),
      exchangeId: String(c.exchange_id ?? ''),
      // **저장소 공통 규칙: `is_testnet === false`일 때만 실전이다.**
      testnet: c.is_testnet === false ? false : c.is_testnet === true ? true : null,
      label: c.label ?? null,
      ok: r.ok,
      error: r.ok ? null : (r.message ?? r.error),
      futures: r.futures ? {
        ok: r.futures.ok,
        positionsOk: r.positionsOk,
        walletBalance: r.futures.walletBalance ?? null,
        availableMargin: r.futures.availableMargin ?? null,
        positionMargin: r.futures.positionMargin ?? null,
        unrealizedPnl: r.futures.unrealizedPnl ?? null,
      } : null,
      spot: r.spot ? {
        ok: r.spot.ok,
        usdt: r.spot.usdt ?? null,
        valueUsd: r.tree?.spotValueUsd ?? null,
        knownValueUsd: r.tree?.spotKnownValueUsd ?? null,
        unpriced: r.tree?.spotUnpriced ?? [],
      } : null,
    } as ConnectionWallet;
  }));

  const envs = (['LIVE', 'TESTNET'] as const).map(e => envWalletOf(e, reads));

  // **환경을 모르는 연결은 어느 집합에도 넣지 않는다.** LIVE로 승격하면
  // 정체 모를 연결이 실계좌 완전성 판정에 들어간다.
  const connectionIdsByEnv = {
    LIVE: reads.filter(r => r.testnet === false).map(r => r.connectionId),
    TESTNET: reads.filter(r => r.testnet === true).map(r => r.connectionId),
  };

  return { ok: true, error: null, connections, reads, envs, detail, connectionIdsByEnv };
}

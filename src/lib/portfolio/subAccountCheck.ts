// src/lib/portfolio/subAccountCheck.ts
//
// 서브계좌 한도를 판정하기 위한 **IO만** 한다.
// 판정 자체는 subAccount.ts의 순수 함수가 하고 여기서는 읽어 넘기기만 한다.
//
// 실패를 어떻게 다루는가
// ──────────────────────
// 바구니 목록을 못 읽으면 **막는다**(unknown). 손실 한도와 같은 규칙이다 —
// 한도가 있는지 없는지 모르는 채로 주문을 내보내면 그 한도는 없는 것과 같다.
//
// AI 거부권과 다르게 두는 이유: 저건 덧댄 의견이고 이건 **사용자가 직접
// 정한 자금 한도**다. 못 읽었다고 넘어가면 "600만 원까지"라고 적어 둔 것이
// 조회 한 번 실패로 무제한이 된다.

import { judgeSubAccount, type SubAccount, type OpenUse, type SubAccountVerdict } from './subAccount';

export interface CollectSubAccountArgs {
  sb: any;
  userId: string;
  /** 'SPOT' | 'USDM' | 'COINM' */
  market: string;
  symbol: string;
  /** 이 주문이 새로 묶는 증거금(USDT) */
  addMarginUsd: number | null | undefined;
  /**
   * 지금 열려 있는 것들 (증거금 기준).
   *
   * **null은 '못 읽었다'는 뜻이다.** 빈 배열로 치면 "아무것도 안 쓰고 있다"가
   * 되어 한도가 통째로 넉넉해진다 — 검사를 켜 놓고 안 거는 것과 같다.
   */
  open: OpenUse[] | null;
}

export async function collectSubAccount(
  args: CollectSubAccountArgs,
): Promise<{ verdict: SubAccountVerdict; accounts: SubAccount[] | null }> {
  let accounts: SubAccount[] | null = null;
  try {
    const { data, error } = await (args.sb as any).from('sub_accounts')
      .select('id, name, allocated_usd, markets, symbol_prefixes, sort_order, created_at')
      .eq('user_id', args.userId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    accounts = (Array.isArray(data) ? data : []).map((r: any) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      // 빈 값을 0으로 만들지 않는다. '미설정'과 '한도 0'은 다르다.
      allocatedUsd: r.allocated_usd == null || r.allocated_usd === ''
        ? null : Number(r.allocated_usd),
      markets: Array.isArray(r.markets) ? r.markets : undefined,
      symbolPrefixes: Array.isArray(r.symbol_prefixes) ? r.symbol_prefixes : undefined,
    }));
  } catch (e: any) {
    // 못 읽었다. **통과시키지 않는다** — 사용자가 정한 한도가 조회 실패
    // 한 번으로 무제한이 되면 안 된다.
    return {
      accounts: null,
      verdict: {
        status: 'unknown',
        reason: `서브계좌 한도를 읽지 못했습니다 (${e?.message || e}). 마이그레이션 024를 적용했는지 확인하세요.`,
        accountId: null, accountName: null, allocatedUsd: null,
        usedUsd: null, addUsd: null, remainingUsd: null,
      },
    };
  }

  // **바구니를 안 만들었으면 여기서 끝난다.**
  //
  // 이 순서가 중요하다. 열린 포지션 목록을 먼저 요구하면, 서브계좌를 쓰지도
  // 않는 사람의 주문이 "포지션을 못 읽었다"로 전부 막힌다 — 현물·COIN-M이
  // 오늘 손실 한도 때문에 통째로 막혀 있던 것과 똑같은 사고다.
  if (accounts.length === 0) {
    return {
      accounts,
      verdict: {
        status: 'ok', reason: '가상 서브계좌를 쓰지 않습니다',
        accountId: null, accountName: null, allocatedUsd: null,
        usedUsd: null, addUsd: null, remainingUsd: null,
      },
    };
  }

  // 바구니가 있는데 열린 포지션을 모르면 얼마를 쓰고 있는지 셀 수 없다.
  if (!Array.isArray(args.open)) {
    return {
      accounts,
      verdict: {
        status: 'unknown',
        reason: '열린 포지션을 확인하지 못해 서브계좌 사용액을 셀 수 없습니다',
        accountId: null, accountName: null, allocatedUsd: null,
        usedUsd: null, addUsd: null, remainingUsd: null,
      },
    };
  }

  return {
    accounts,
    verdict: judgeSubAccount({
      accounts,
      market: args.market,
      symbol: args.symbol,
      addMarginUsd: args.addMarginUsd,
      open: args.open,
    }),
  };
}

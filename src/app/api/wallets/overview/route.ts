// /api/wallets/overview
//
// **지갑 화면이 물어보는 곳.**
//
// 왜 새로 만드나
// ──────────────
// `/api/wallets`는 **연결 하나**의 지갑을 준다(`?connectionId=`). 그런데
// 지갑 화면은 "실전/테스트넷 각각 얼마인가"를 물어야 한다 — 연결이
// 여럿일 수 있고, 환경이 다르면 다른 돈이다.
//
// 화면이 연결 목록을 받아 각각 `/api/wallets`를 부르게 두면, 합치는
// 규칙이 브라우저에 생긴다. 그러면 "실전과 테스트넷을 합치지 않는다"가
// 화면마다 따로 구현되고, 언젠가 한 화면이 그걸 어긴다.
//
// **조회는 readWallet 하나, 합산은 walletOverview 하나.**
// 이 라우트는 그 둘을 잇기만 한다.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { readConnectionWallet } from '@/lib/markets/readWallet';
import {
  envWalletOf, bucketsOf, totalAcrossEnvs, type ConnectionWallet,
} from '@/lib/portfolio/walletOverview';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  // ── 내 연결 ──
  //
  // **못 읽은 것을 빈 목록으로 두지 않는다.** 빈 목록이면 화면이
  // "연결된 계좌가 없습니다"라고 적고, 사용자는 연결이 풀린 줄 안다.
  let conns: any[] | null = null;
  let connError: string | null = null;
  try {
    const { data, error } = await (sb as any).from('exchange_connections')
      .select('id, exchange_id, label, is_testnet, has_withdrawal')
      .eq('user_id', uid);
    if (error) throw new Error(error.message);
    conns = (data || []).filter((c: any) => {
      const ex = String(c.exchange_id ?? '').toLowerCase();
      return ex === 'binance' || ex === 'gate';
    });
  } catch (e: any) { connError = String(e?.message || e); }

  if (conns == null) {
    return NextResponse.json({
      ok: false, error: 'connections_unreadable',
      message: `거래소 연결 목록을 읽지 못했습니다 (${connError}) — `
        + '연결이 없다는 뜻이 아닙니다',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 연결마다 지갑을 읽는다 ──
  //
  // 하나가 실패해도 나머지는 보여준다. **실패한 것을 0으로 채우지
  // 않는다** — 합산 쪽이 "하나라도 모르면 null"로 처리한다.
  const reads = await Promise.all(conns.map(async (c: any): Promise<ConnectionWallet> => {
    const r = await readConnectionWallet(sb, uid, String(c.id));
    return {
      connectionId: String(c.id),
      exchangeId: String(c.exchange_id ?? ''),
      // **저장소 공통 규칙: `is_testnet === false`일 때만 실전이다.**
      // 여기서만 다르게 읽으면 값이 빈 연결이 실전 합계에 들어간다.
      testnet: c.is_testnet === false ? false : c.is_testnet === true ? true : null,
      label: c.label ?? null,
      ok: r.ok,
      error: r.ok ? null : (r.message ?? r.error),
      futures: r.futures ? {
        ok: r.futures.ok,
        walletBalance: (r.futures as any).walletBalance ?? null,
        availableMargin: (r.futures as any).availableMargin ?? null,
        positionMargin: (r.futures as any).positionMargin ?? null,
        unrealizedPnl: (r.futures as any).unrealizedPnl ?? null,
      } : null,
      spot: r.spot ? { ok: r.spot.ok, usdt: (r.spot as any).usdt ?? null } : null,
    };
  }));

  const envs = (['LIVE', 'TESTNET'] as const).map(e => envWalletOf(e, reads));

  return NextResponse.json({
    ok: true,
    // 환경별 합계. **서로 더하지 않는다.**
    envs,
    buckets: bucketsOf(envs),
    // 화면이 고를 계좌.
    accounts: reads.map(r => ({
      id: r.connectionId, exchangeId: r.exchangeId, label: r.label,
      env: r.testnet === false ? 'LIVE' : r.testnet === true ? 'TESTNET' : null,
      ok: r.ok, error: r.error,
    })),
    // **합치지 않는 이유를 값으로 준다** — 화면이 문장을 지어내지 않게.
    across: totalAcrossEnvs(),
    note: '실전 · 테스트넷 · 모의 자산은 합치지 않습니다. '
      + '한 연결이라도 읽지 못하면 그 환경의 합계는 "확인 불가"입니다 — 부분 합계를 총자산으로 적지 않습니다',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

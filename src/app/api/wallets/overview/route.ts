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
import { snapshotVerdict, snapshotRow } from '@/lib/portfolio/snapshotPlan';
import { equityPerformanceOf, elapsedText, newestFirstToAsc, latestTakenMs, type EquitySnapshot } from '@/lib/portfolio/performance';

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
    // **기본 합산은 살아 있는 연결만.** 비활성/옛 연결까지 조회하면 그
    // 실패 하나 때문에 환경 전체 총자산이 "확인 불가"가 되고, 쓸데없는
    // 거래소 호출도 늘어난다. 비활성은 아래에서 따로 보여준다.
    const { data, error } = await (sb as any).from('exchange_connections')
      .select('id, exchange_id, label, is_testnet, has_withdrawal, is_active')
      .eq('user_id', uid).eq('is_active', true);
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
        // **포지션을 못 읽었으면 미실현손익은 모르는 값이다.**
        positionsOk: r.positionsOk,
        walletBalance: (r.futures as any).walletBalance ?? null,
        availableMargin: (r.futures as any).availableMargin ?? null,
        positionMargin: (r.futures as any).positionMargin ?? null,
        unrealizedPnl: (r.futures as any).unrealizedPnl ?? null,
      } : null,
      // **현물은 USDT만이 아니라 전체 평가액을 넘긴다.** 예전에는
      // `usdt`만 넘겨서 BTC·ETH가 총자산에서 통째로 빠졌다.
      spot: r.spot ? {
        ok: r.spot.ok,
        usdt: (r.spot as any).usdt ?? null,
        valueUsd: r.tree?.spotValueUsd ?? null,
        knownValueUsd: r.tree?.spotKnownValueUsd ?? null,
        unpriced: r.tree?.spotUnpriced ?? [],
      } : null,
    };
  }));

  const envs = (['LIVE', 'TESTNET'] as const).map(e => envWalletOf(e, reads));

  // ── 자산을 찍어 둔다 ──
  //
  // **표(048)는 있는데 채우는 코드가 없었다.** 그래서 지갑 곡선은
  // 구조적으로 영원히 비어 있었다. 지금 잔고로 과거를 역산할 수는
  // 없으므로, 지금부터 찍어 두는 것 말고는 방법이 없다.
  //
  // 여기서 찍는 이유: 자산을 방금 읽었고, 사람이 지갑을 열 때마다
  // 자연스럽게 기록이 쌓인다. 워커가 도는 주기와 별개로 동작한다.
  // **읽기 요청이 쓰기를 하는 것이 어색하지만**, 표를 채우는 다른
  // 경로가 없는 상태를 더 두는 것이 나쁘다.
  const nowMs = Date.now();
  const snapshotNotes: Array<{ env: string; code: string; reason: string }> = [];
  const perf: Record<string, any> = {};

  for (const e of envs) {
    let history: EquitySnapshot[] = [];
    let lastTakenMs: number | null = null;
    try {
      const { data } = await (sb as any).from('account_equity_snapshots')
        .select('taken_at, total_equity, realized_pnl, unrealized_pnl, deposit, withdrawal, transfer, fees, funding')
        .eq('user_id', uid).eq('env', e.env)
        // **최신부터 읽는다.** 예전에는 `ascending: true` + `limit(2000)`
        // 이라 15분마다 찍으면 약 3주 뒤부터 **가장 오래된 2000개**만
        // 계속 읽었다. 그러면 `lastTakenMs`가 옛 시각에 고정되고,
        // "15분 지났다"는 판정이 매 요청마다 참이 되어 표가 부풀며,
        // 성과 곡선과 현재 자산 기준점도 전부 옛 구간을 본다.
        .order('taken_at', { ascending: false }).limit(2000);
      history = newestFirstToAsc((Array.isArray(data) ? data : []).map((r: any) => ({
        takenAt: Date.parse(String(r.taken_at)),
        totalEquity: r.total_equity == null ? null : Number(r.total_equity),
        realizedPnl: r.realized_pnl == null ? null : Number(r.realized_pnl),
        unrealizedPnl: r.unrealized_pnl == null ? null : Number(r.unrealized_pnl),
        deposit: r.deposit == null ? null : Number(r.deposit),
        withdrawal: r.withdrawal == null ? null : Number(r.withdrawal),
        fees: r.fees == null ? null : Number(r.fees),
        funding: r.funding == null ? null : Number(r.funding),
      })));
      // **가장 최근 시각을 값으로 고른다.** 배열의 끝을 믿지 않는다.
      lastTakenMs = latestTakenMs(history);
    } catch {
      // 표가 없거나 못 읽었다. **찍지 않는다** — 마지막 시각을 모르면
      // 매 요청마다 찍게 되고, 그건 표를 부풀린다.
      snapshotNotes.push({ env: e.env, code: 'HISTORY_UNREADABLE',
        reason: '기록을 읽지 못했습니다 — 마이그레이션 048이 필요할 수 있습니다' });
      perf[e.env] = equityPerformanceOf([]);
      continue;
    }

    // **찍는 값은 canonical 총자산이다.**
    //
    // 예전에는 `e.futures.value`(선물 지갑잔고)를 `total_equity`로 적었다.
    // 현물도 미실현손익도 빠진 값이다. 그런데 화면은 그걸 "시작 자산 ·
    // 현재 자산 · 최고 자산 · MDD"로 보여줬다 — 이름과 내용이 달랐다.
    //
    // 그리고 **하나라도 모르면 찍지 않는다.** 값을 못 매긴 자산이 있는
    // 순간의 부분합계를 찍으면, 그날 자산이 줄어든 것으로 곡선에 남고
    // 그 기록은 되돌릴 수 없다.
    const v = snapshotVerdict({
      nowMs, lastTakenMs,
      connections: e.connections,
      totalEquity: e.total.value,
    });
    snapshotNotes.push({ env: e.env, code: v.code, reason: v.reason });

    if (v.take && e.total.value != null && e.unpricedAssets.length === 0) {
      const row = snapshotRow({
        userId: uid, env: e.env, takenAtMs: nowMs,
        totalEquity: e.total.value,
        unrealizedPnl: e.unrealizedPnl.value,
      });
      try {
        await (sb as any).from('account_equity_snapshots').insert(row);
        history = [...history, {
          takenAt: nowMs, totalEquity: e.total.value,
          unrealizedPnl: e.unrealizedPnl.value,
        }];
      } catch { /* 못 남겨도 화면은 보여준다 — 다음 주기에 다시 찍는다 */ }
    }

    const p = equityPerformanceOf(history);
    perf[e.env] = { ...p, elapsedText: elapsedText(p.elapsedMs) };
  }

  return NextResponse.json({
    ok: true,
    // 환경별 합계. **서로 더하지 않는다.**
    envs,
    // 성과. **찍어 둔 시점에서만 나온다** — 지금 잔고로 과거를 역산하지 않는다.
    performance: perf,
    snapshots: snapshotNotes,
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
      + '한 연결이라도 읽지 못하거나 값을 매기지 못한 자산이 있으면 그 환경의 총자산은 "확인 불가"입니다 — '
      + '부분 합계를 총자산으로 적지 않습니다. 총자산 = 현물 전체 평가액 + 선물 순자산(지갑잔고 + 미실현손익)',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

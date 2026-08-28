// /api/wallets/overview
//
// **지갑 화면이 물어보는 곳. 이제 읽기만 한다.**
//
// 왜 새로 만들었나
// ────────────────
// `/api/wallets`는 **연결 하나**의 지갑을 준다(`?connectionId=`). 그런데
// 지갑 화면은 "실전/테스트넷 각각 얼마인가"를 물어야 한다 — 연결이
// 여럿일 수 있고, 환경이 다르면 다른 돈이다.
//
// 화면이 연결 목록을 받아 각각 `/api/wallets`를 부르게 두면, 합치는
// 규칙이 브라우저에 생긴다. 그러면 "실전과 테스트넷을 합치지 않는다"가
// 화면마다 따로 구현되고, 언젠가 한 화면이 그걸 어긴다.
//
// **조회는 readUserWallets 하나, 합산은 walletOverview 하나.**
//
// 쓰기를 들어냈다
// ───────────────
// 이 GET은 `account_equity_snapshots`에 INSERT를 했다. 그래서
// **사람이 앱을 여는 시간에만 자산이 기록됐고**, 탭을 두 개 열면 같은
// 순간이 두 번 찍혔다(간격 판정은 동시 요청 둘을 다 통과시킨다).
//
// 지금은 워커가 `/api/wallets/snapshot`을 15분마다 깨우고, 중복은
// 064의 칸 키 제약이 막는다. 이 라우트는 **찍힌 것을 읽고, 오래됐으면
// 오래됐다고 말한다** — 조용히 옛 곡선을 지금 자산인 척 보여주지 않는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { readUserWallets } from '@/lib/portfolio/walletRead';
import { bucketsOf, totalAcrossEnvs, accountWalletsOf } from '@/lib/portfolio/walletOverview';
import { snapshotFreshness } from '@/lib/portfolio/snapshotBucket';
import { equityPerformanceOf, elapsedText, newestFirstToAsc, latestTakenMs, type EquitySnapshot } from '@/lib/portfolio/performance';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  // ── 지갑을 읽는다 ──
  //
  // **못 읽은 것을 빈 목록으로 두지 않는다.** 빈 목록이면 화면이
  // "연결된 계좌가 없습니다"라고 적고, 사용자는 연결이 풀린 줄 안다.
  const w = await readUserWallets(sb, uid);
  if (!w.ok) {
    return NextResponse.json({
      ok: false, error: 'connections_unreadable',
      message: `거래소 연결 목록을 읽지 못했습니다 (${w.error}) — `
        + '연결이 없다는 뜻이 아닙니다',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const { reads, envs, detail } = w;

  // **계좌 선택이 실제로 숫자를 바꾸게 한다.** 환경 합계와 **같은
  // 함수**로 계산한다 — 두 규칙이 갈리면 전체와 계좌별이 안 맞는 날이 온다.
  const accountWallets = accountWalletsOf(reads);

  // ── 찍힌 자산을 읽는다 ──
  //
  // **여기서 찍지 않는다.** 찍는 것은 워커가 깨우는
  // `/api/wallets/snapshot`이다. 이 라우트가 찍으면 사람이 앱을 여는
  // 시간에만 곡선이 생기고, 동시 요청이 같은 순간을 두 번 남긴다.
  const nowMs = Date.now();
  const snapshotNotes: Array<{ env: string; code: string; reason: string; stale: boolean }> = [];
  const perf: Record<string, any> = {};
  // 화면이 곡선을 그릴 원본. **없는 구간을 지어내지 않는다** — 찍힌 시점만.
  const rawSnapshots: Record<string, Array<{ takenAt: number; totalEquity: number | null; unrealizedPnl: number | null }>> = {};

  for (const e of envs) {
    let history: EquitySnapshot[] = [];
    let historyOk = true;
    try {
      const { data, error } = await (sb as any).from('account_equity_snapshots')
        .select('taken_at, total_equity, realized_pnl, unrealized_pnl, deposit, withdrawal, transfer, fees, funding')
        .eq('user_id', uid).eq('env', e.env)
        // **최신부터 읽는다.** 예전에는 `ascending: true` + `limit(2000)`
        // 이라 15분마다 찍으면 약 3주 뒤부터 **가장 오래된 2000개**만
        // 계속 읽었다 — 곡선과 기준점이 전부 옛 구간을 봤다.
        .order('taken_at', { ascending: false }).limit(2000);
      // **오류를 반드시 받아 본다.** 예전에는 `catch`만 있어서, 조회가
      // 오류 객체로 실패하면(던지지 않는다) 빈 기록이 정상처럼 통과했다.
      if (error) throw new Error(error.message);
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
    } catch {
      historyOk = false;
    }

    // **오래됐으면 오래됐다고 말한다.**
    //
    // 이 판정은 쓰기를 워커로 옮기면서 필요해졌다. 예전에는 화면을 여는
    // 행위가 곧 기록이라 "오래됨"이 존재할 수 없었다. 이제는 워커가
    // 멈추면 곡선이 조용히 멈춘다 — 그러면 마지막 점이 지금 자산인 척한다.
    const f = snapshotFreshness({
      nowMs,
      lastTakenMs: historyOk ? latestTakenMs(history) : null,
      historyOk,
      connections: e.connections,
    });
    snapshotNotes.push({ env: e.env, code: f.code, reason: f.reason, stale: f.stale });

    const p = equityPerformanceOf(historyOk ? history : []);
    perf[e.env] = { ...p, elapsedText: elapsedText(p.elapsedMs) };
    rawSnapshots[e.env] = (historyOk ? history : []).map(h => ({
      takenAt: h.takenAt,
      totalEquity: h.totalEquity ?? null,
      unrealizedPnl: h.unrealizedPnl ?? null,
    }));
  }

  // ── 오늘 매매로 번 것 ──
  //
  // **매매손익 = 자산변화 − 외부유입 − 수수료 − 펀딩.**
  // 네 항을 전부 알 때만 숫자를 만든다(056).
  //
  // 완전성 판정을 고쳤다
  // ────────────────────
  // 예전에는 `ledger_ingest_state`에서 읽은 **행만** `every()`로 봤다.
  // `every()`는 배열에 있는 것만 본다 — 연결이 셋인데 상태 행이 하나면,
  // 그 하나가 오늘을 덮는 순간 참이다. **한 번도 수집된 적 없는 두
  // 연결은 검사에 등장조차 하지 않는다.** 그 연결의 수수료와 펀딩이
  // 빠진 채로 매매손익이 확정되고, 빠진 비용은 전부 수익으로 보인다.
  //
  // 이제 **활성 연결 집합과 덮인 집합을 대조한다**(`ledgerCompleteness`).
  const ledger: Record<string, any> = {};
  try {
    const { ledgerTotals, tradingPnlOf } = await import('@/lib/ledger/ledgerEvent');
    const { ledgerWindowOf } = await import('@/lib/ledger/coverageWindow');
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const fromMs = dayStart.getTime();

    for (const e of ['LIVE', 'TESTNET'] as const) {
      // **못 읽은 것을 빈 배열로 두지 않는다.** null이면 판정이
      // "완전하다고 말하지 않는다"로 간다.
      let states: any[] | null = null;
      try {
        const { data, error } = await (sb as any).from('ledger_ingest_state')
          .select('connection_id, covered_from, covered_to')
          .eq('user_id', uid).eq('env', e);
        if (error) throw new Error(error.message);
        states = (Array.isArray(data) ? data : []).map((r: any) => ({
          connectionId: String(r.connection_id ?? ''),
          fromMs: Date.parse(String(r.covered_from ?? '')) || null,
          toMs: Date.parse(String(r.covered_to ?? '')) || null,
        }));
      } catch { states = null; }

      // ── **"지금까지 덮였는가"를 묻지 않는다** ──
      //
      // 수집은 15분마다 돈다. `covered_to`는 마지막 수집 시각이므로
      // 지갑이 요청하는 시각보다 언제나 뒤에 있다 — 그 조건으로 물으면
      // 연결이 정상이고 매 회차 성공해도 **오늘 손익은 영원히 확인
      // 불가다.** 실제로 그 상태였다.
      //
      // 그래서 "오늘 중 어디까지 덮였는가"를 묻고, 그 구간에서만 센다.
      // 덮이지 않은 구간을 덮었다고 하지 않으면서 값이 나온다.
      const win = ledgerWindowOf({
        // 기대 집합 = 이 환경의 활성 연결. **환경을 모르는 연결은 빠진다.**
        expected: w.connectionIdsByEnv?.[e] ?? null,
        states,
        dayStartMs: fromMs, nowMs,
      });
      // **못 쓰는 창이면 아무 값도 만들지 않는다.** 0으로 바꾸지 않는다.
      const asOf = win.usable ? (win.asOfMs as number) : null;

      let totals: any = null;
      if (asOf != null) {
        try {
          const { data, error } = await (sb as any).from('ledger_events')
            .select('kind, amount')
            .eq('user_id', uid).eq('env', e)
            .gte('occurred_at', new Date(fromMs).toISOString())
            // **상한을 건다.** 없으면 덮였다고 판정한 구간 바깥의 사건까지
            // 합계에 들어가, 자산 변화와 장부가 서로 다른 구간을 본다.
            .lte('occurred_at', new Date(asOf).toISOString());
          if (error) throw new Error(error.message);
          totals = ledgerTotals((Array.isArray(data) ? data : []).map((r: any) => ({
            kind: r.kind, amount: Number(r.amount),
          })) as any);
        } catch { /* null — 못 읽은 것을 0으로 적지 않는다 */ }
      }

      // 오늘 자산 변화. **장부와 같은 창에서 잰다** — 창이 어긋나면
      // 매매손익 = 자산변화 − 유입 − 수수료 − 펀딩의 네 항이 서로 다른
      // 기간을 가리킨다.
      const series = Array.isArray(rawSnapshots?.[e]) ? rawSnapshots[e] : [];
      const today = series.filter((r: any) => Number(r?.takenAt) >= fromMs
        && (asOf == null || Number(r?.takenAt) <= asOf)
        && r?.totalEquity != null);
      const equityChange = today.length >= 2
        ? Number(today[today.length - 1].totalEquity) - Number(today[0].totalEquity)
        : null;

      const tp = tradingPnlOf({ equityChange, totals, ledgerComplete: win.usable });
      ledger[e] = {
        complete: win.usable, reason: win.reason, code: win.code,
        // **언제까지의 자료인가.** 화면이 "N분 전 기준"을 말할 수 있게 한다.
        asOf: asOf == null ? null : new Date(asOf).toISOString(),
        lagMinutes: win.lagMs == null ? null : Math.round(win.lagMs / 60_000),
        stale: win.stale,
        // **무엇이 빠졌는지 값으로 준다** — 화면이 문장을 지어내지 않게.
        missingConnections: win.missing, partialConnections: win.partial,
        totals,
        equityChange,
        tradingPnl: tp,
      };
    }
  } catch (e: any) {
    // 장부가 고장 나도 지갑은 보여야 한다. 다만 조용히 넘기지 않는다.
    ledger.error = String(e?.message || e).slice(0, 200);
  }

  // ── 전략계좌 ──
  //
  // **표는 041이 만들었는데 화면이 물어보지 않고 있었다.**
  //
  // 지갑의 전략계좌 탭에는 `const strategies = []`가 박혀 있었고, 주석은
  // "전략별 귀속 장부가 붙어야 실제 값이 생긴다"였다. 그 장부는
  // `strategy_accounts`로 이미 있다 — 만들어 놓고 배선을 안 한 것이다.
  //
  // **못 읽은 것을 '전략 없음'으로 적지 않는다.** 빈 목록이면 화면이
  // "전략계좌가 없습니다"라고 적고, 사용자는 배정한 돈이 사라진 줄 안다.
  let strategies: any[] | null = null;
  let strategiesError: string | null = null;
  try {
    const { sleeveAccountsOf } = await import('@/lib/portfolio/walletDetail');
    const { data, error } = await (sb as any).from('strategy_accounts')
      .select('sleeve_id, label, connection_id, allocated, realized_pnl, unrealized_pnl, fees, max_drawdown_seen_pct, positions, stage, halted')
      .eq('user_id', uid);
    if (error) throw new Error(error.message);
    // 연결 id → 환경. **환경을 못 읽은 연결은 넣지 않는다.**
    const envByConnection: Record<string, 'LIVE' | 'TESTNET'> = {};
    for (const r of reads) {
      if (r.testnet === false) envByConnection[r.connectionId] = 'LIVE';
      else if (r.testnet === true) envByConnection[r.connectionId] = 'TESTNET';
    }
    strategies = sleeveAccountsOf(Array.isArray(data) ? data : [], envByConnection);
  } catch (e: any) {
    strategiesError = String(e?.message || e).slice(0, 200);
  }

  return NextResponse.json({
    ok: true,
    // 환경별 합계. **서로 더하지 않는다.**
    envs,
    // 오늘 매매로 번 것. 완전하지 않으면 tradingPnl.value가 null이고
    // 무엇을 몰라서인지 적혀 있다.
    ledger,
    // 성과. **찍어 둔 시점에서만 나온다** — 지금 잔고로 과거를 역산하지 않는다.
    performance: perf,
    // 자산 기록이 지금 것인가. `stale: true`면 화면이 경고를 띄운다.
    snapshots: snapshotNotes,
    // 자산 곡선의 원본. 환경별로 오래된 순이다.
    snapshotSeries: rawSnapshots,
    buckets: bucketsOf(envs),
    // 전략계좌. **null은 '없다'가 아니라 '못 읽었다'이다.**
    strategies,
    strategiesError,
    // 화면이 고를 계좌 — **숫자까지 같이 준다.**
    accounts: accountWallets.map(a => ({
      id: a.connectionId, exchangeId: a.exchangeId, label: a.label,
      // **모르는 환경을 LIVE로 승격하지 않는다.**
      env: (reads.find(r => r.connectionId === a.connectionId)?.testnet === false) ? 'LIVE'
        : (reads.find(r => r.connectionId === a.connectionId)?.testnet === true) ? 'TESTNET' : null,
      ok: a.ok, partial: a.partial,
      error: reads.find(r => r.connectionId === a.connectionId)?.error ?? null,
      total: a.total, spot: a.spot, futures: a.futures, futuresEquity: a.futuresEquity,
      availableMargin: a.availableMargin, positionMargin: a.positionMargin,
      unrealizedPnl: a.unrealizedPnl, unpricedAssets: a.unpricedAssets,
      note: a.note,
      // 화면의 현물·선물 탭이 그릴 실제 값. **못 읽었으면 spotOk가 false다**
      spotAssets: detail[a.connectionId]?.spotAssets ?? [],
      spotOk: reads.find(r => r.connectionId === a.connectionId)?.spot?.ok ?? false,
      futuresDetail: detail[a.connectionId]?.futures ?? null,
    })),
    // **합치지 않는 이유를 값으로 준다** — 화면이 문장을 지어내지 않게.
    across: totalAcrossEnvs(),
    note: '실전 · 테스트넷 · 모의 자산은 합치지 않습니다. '
      + '한 연결이라도 읽지 못하거나 값을 매기지 못한 자산이 있으면 그 환경의 총자산은 "확인 불가"입니다 — '
      + '부분 합계를 총자산으로 적지 않습니다. 총자산 = 현물 전체 평가액 + 선물 순자산(지갑잔고 + 미실현손익)',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

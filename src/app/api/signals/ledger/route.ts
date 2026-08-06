// /api/signals/ledger — 크리에이터 신호의 장부 세 권
//
// POST: 아직 장부가 없는 신호를 계산해 저장한다
// GET : 저장된 장부를 세그먼트로 나눠 판정한다
//
// 왜 계산해서 저장하는가
// ──────────────────────
// 장부는 **신호 시점 전후의 가격 경로**를 필요로 한다. 그건 화면을 열
// 때마다 다시 가져올 수 있는 것이 아니고, 거래소 캔들 보관 기간이 지나면
// 아예 못 가져온다. 지금 계산해 두지 않으면 그 신호의 성적은 **다시는
// 계산할 수 없다.**
//
// 무엇을 하지 않는가
// ──────────────────
// **주문을 내지 않는다.** 이 라우트는 끝까지 기록과 집계뿐이다.
// 판정이 FOLLOW로 나와도 그건 "다음 단계(SHADOW_LIVE)로 갈 수 있다"는
// 뜻이지 주문을 내도 된다는 뜻이 아니다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { intakeAll } from '@/lib/signals/creatorIntake';
import { buildSignalPath, windowFor } from '@/lib/signals/signalPath';
import {
  buildLedgerRow, judgeAllSegments, canPromote, latencyBucketOf, holdBucketOf,
  type LedgerRow, type SegmentDim, type MarketRegime,
} from '@/lib/signals/creatorLedger';
import { fetchVenueBars, intervalMs } from '@/lib/markets/venueBars';
import { futuresExchangeOf } from '@/lib/exchanges/futuresAdapter';
import type { SimConfig } from '@/lib/signals/creatorEdge';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * 세 장부에 **똑같이** 적용되는 조건.
 *
 * 하나라도 다르면 비교가 성립하지 않는다. 그래서 요청마다 다르게 두지
 * 않고 한 곳에 적어 두고, 계산한 값을 장부에 함께 저장한다 — 나중에
 * 조건을 바꿨을 때 예전 행과 섞이는 것을 막기 위해서다.
 */
const DEFAULT_SIM: Omit<SimConfig, 'delaySec'> = {
  // 바이낸스 선물 테이커 왕복. 한쪽 값이다.
  feePctPerSide: 0.045,
  // 시장가는 호가를 먹고 들어간다. 0으로 두면 실제보다 좋게 나온다.
  slippagePct: 0.02,
  maxHoldSec: 4 * 3600,
  // 손절을 말하지 않은 신호는 gateSignal이 막는다. 이 값은 쓰이지 않지만,
  // allowMissingStop을 켜는 연구용 경로가 생겼을 때 0으로 떨어지지 않게 둔다.
  defaultStopPct: 1,
  takePct: null,
};

/** 어느 봉으로 채점할 것인가. 짧을수록 꼬리를 잘 본다 */
const BAR_INTERVAL = '1m';

export async function POST(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  let body: any = {};
  try { body = await req.json(); } catch { /* 본문 없이도 돈다 */ }

  const exchange = futuresExchangeOf(body?.exchange) ?? 'binance';
  const testnet = body?.testnet === true;
  const limit = Math.min(200, Math.max(1, Number(body?.limit) || 50));

  // ── 아직 장부가 없는 신호 ──
  const { data: rows, error } = await (sb as any).from('trader_signals')
    .select('*, trader_channels(name)')
    .eq('user_id', uid)
    .order('detected_at', { ascending: false })
    .limit(limit);
  if (error) {
    return NextResponse.json({ error: 'signals_unreadable', message: error.message }, { status: 502 });
  }

  const flat = (rows || []).map((r: any) => ({
    ...r, creator: r?.trader_channels?.name ?? r?.channel_id ?? '',
  }));

  // 검수·발언시각·발언종류·확신도·손절을 여기서 거른다. **못 태운 것도
  // 돌려준다** — 버리면 왜 40건이 빠졌는지 아무도 모른다.
  const intake = intakeAll(flat, { allowUnreviewed: body?.allowUnreviewed === true });

  const built: LedgerRow[] = [];
  const failures: Array<{ id: string; reason: string }> = [];
  const step = intervalMs(BAR_INTERVAL) ?? 60_000;

  for (const { row, intake: it } of intake.accepted) {
    const sig = it.signal!;
    // 지연을 모르면 채점하지 않는다. 0으로 떨어뜨리면 볼 수 없었던
    // 가격에 체결한 성과가 나오고, 그건 언제나 실제보다 좋다.
    if (it.delaySec == null) {
      failures.push({ id: String(row.id), reason: '발언→감지 지연을 알 수 없습니다' });
      continue;
    }
    const cfg: SimConfig = { ...DEFAULT_SIM, delaySec: it.delaySec };
    const w = windowFor(sig.saidAtMs, cfg.delaySec, cfg.maxHoldSec, step);
    if (!w) { failures.push({ id: String(row.id), reason: '조회 구간을 만들 수 없습니다' }); continue; }

    const bars = await fetchVenueBars({
      exchange, symbol: sig.symbol, interval: BAR_INTERVAL,
      limit: 1000, testnet, startTimeMs: w.startMs, endTimeMs: w.endMs,
    });
    if (!bars.bars) {
      failures.push({ id: String(row.id), reason: bars.error || '봉을 읽지 못했습니다' });
      continue;
    }
    const b = bars.bars;
    const barRows = b.closes.map((_c, i) => ({
      openTime: b.openTimes[i], open: b.opens[i], high: b.highs[i], low: b.lows[i], close: b.closes[i],
    }));

    const p = buildSignalPath(barRows, {
      saidAtMs: sig.saidAtMs, delaySec: cfg.delaySec, maxHoldSec: cfg.maxHoldSec, intervalMs: step,
    });
    // **구간이 모자라면 저장하지 않는다.** 있는 데까지 돌리면 최대
    // 보유시간을 못 채운 거래가 '시간 청산'으로 기록되고, 그 손익은
    // 일어난 적 없는 시점의 가격이다. 표본 수는 늘고 뜻은 흐려진다.
    if (!p.covers) {
      failures.push({ id: String(row.id), reason: p.error });
      continue;
    }

    const lr = buildLedgerRow(
      { ...sig, signalId: String(row.id), creator: String(row.creator), symbol: sig.symbol,
        regime: it.regime as MarketRegime } as any,
      p.path, cfg);
    built.push(lr);

    const { error: upErr } = await (sb as any).from('creator_ledger').upsert({
      user_id: uid,
      signal_id: row.id,
      creator: lr.creator, symbol: lr.symbol, direction: lr.direction, regime: lr.regime,
      said_at: new Date(lr.saidAtMs).toISOString(),
      delay_sec: cfg.delaySec,
      fee_pct_side: cfg.feePctPerSide,
      slippage_pct: cfg.slippagePct,
      max_hold_sec: cfg.maxHoldSec,
      // 못 돌렸으면 NULL이다. 0은 '거래해서 본전'이라는 뜻이고,
      // 그러면 IGNORE 장부와 구별되지 않는다.
      follow_r: Number.isFinite(lr.books.FOLLOW.rMultiple) ? lr.books.FOLLOW.rMultiple : null,
      follow_exit: lr.books.FOLLOW.exitReason,
      inverse_r: Number.isFinite(lr.books.INVERSE.rMultiple) ? lr.books.INVERSE.rMultiple : null,
      inverse_exit: lr.books.INVERSE.exitReason,
      hold_sec: lr.holdSec,
      skipped: lr.skipped,
      computed_at: new Date().toISOString(),
    }, { onConflict: 'signal_id' });
    if (upErr) failures.push({ id: String(row.id), reason: `저장 실패: ${upErr.message}` });
  }

  return NextResponse.json({
    ok: true,
    exchange, testnet, interval: BAR_INTERVAL,
    computed: built.length,
    // **못 만든 것을 숨기지 않는다.** 이 숫자가 0이 아니면 화면이
    // 그 이유를 보여줘야 사용자가 무엇을 고쳐야 하는지 안다.
    skippedIntake: intake.rejected.length,
    intakeReasons: intake.reasonCounts,
    failures: failures.slice(0, 50),
    sim: { ...DEFAULT_SIM },
    note: '이 라우트는 기록과 집계만 합니다 — 주문을 내지 않습니다',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const dimsRaw = String(req.nextUrl.searchParams.get('dims') || 'creator')
    .split(',').map(s => s.trim()).filter(Boolean);
  const ALLOWED: SegmentDim[] = ['creator', 'symbol', 'direction', 'regime', 'latency', 'hold'];
  const dims = dimsRaw.filter((d): d is SegmentDim => (ALLOWED as string[]).includes(d));

  const { data, error } = await (sb as any).from('creator_ledger')
    .select('*').eq('user_id', uid).order('said_at', { ascending: true }).limit(5000);
  if (error) {
    return NextResponse.json({ error: 'ledger_unreadable', message: error.message }, { status: 502 });
  }

  // 표의 행 → 장부 행. 여기서 NULL을 0으로 접으면 못 돌린 거래가
  // '본전'이 되어 기대값을 위로 끌어올린다.
  const rows: LedgerRow[] = (data || []).map((r: any) => {
    const said = Date.parse(r.said_at);
    const fr = r.follow_r == null ? NaN : Number(r.follow_r);
    const ir = r.inverse_r == null ? NaN : Number(r.inverse_r);
    const holdSec = r.hold_sec == null ? null : Number(r.hold_sec);
    const delaySec = Number(r.delay_sec);
    return {
      signalId: String(r.signal_id), creator: String(r.creator ?? ''),
      symbol: String(r.symbol ?? ''), direction: r.direction === 'SHORT' ? 'SHORT' : 'LONG',
      saidAtMs: Number.isFinite(said) ? said : 0,
      regime: (r.regime ?? 'UNKNOWN') as MarketRegime,
      delaySec,
      latency: latencyBucketOf(delaySec),
      holdSec,
      hold: holdBucketOf(holdSec),
      books: {
        FOLLOW: { book: 'FOLLOW', rMultiple: fr, netPct: NaN, exitReason: r.follow_exit ?? 'NO_DATA', traded: true, side: null },
        INVERSE: { book: 'INVERSE', rMultiple: ir, netPct: NaN, exitReason: r.inverse_exit ?? 'NO_DATA', traded: true, side: null },
        IGNORE: { book: 'IGNORE', rMultiple: 0, netPct: 0, exitReason: 'NO_TRADE', traded: false, side: null },
      },
      skipped: String(r.skipped ?? ''),
    } as LedgerRow;
  });

  const segments = judgeAllSegments(rows, dims).map(sj => ({
    ...sj,
    promote: canPromote(sj),
  }));

  return NextResponse.json({
    ok: true,
    total: rows.length,
    dims,
    // **비교한 세그먼트 수를 응답에 싣는다.** 이 숫자가 클수록 통과
    // 문턱이 높아졌다는 사실이 화면에 보여야, "왜 +0.3R인데 통과가
    // 아니냐"는 물음에 답이 있다.
    comparisons: segments.length,
    segments,
    note: '이 표는 모의매매 표본입니다 — 특정 기간·특정 종목의 결과이고, '
        + '사람에 대한 평가가 아닙니다. 통과해도 다음 단계는 SHADOW_LIVE입니다.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

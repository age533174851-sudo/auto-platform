// GET /api/cron/ai-scoring
//
// AI가 한 말을 **채점한다.** 이게 없으면 `outcome`이 영원히 NULL이고,
// 캘리브레이션은 언제 물어도 "결과 대기 중"만 답한다 — 기록은 쌓이는데
// 아무도 맞았는지 모르는 상태다.
//
// 무엇을 채점하는가
// ─────────────────
// `ai_predictions`에서 **예측 시점 + horizon_min이 지났는데 아직 결과가
// 없는** 행. 예측 당시 가격과 그 뒤 가격을 비교해 실제 방향을 정한다.
//
// 왜 klines로 예측 당시 가격을 다시 읽는가
// ────────────────────────────────────────
// `entry_price`는 그 판단이 **실제 주문에 쓰였을 때만** 채워진다
// (markApplied). 쓰이지 않은 판단이 훨씬 많은데, 그것들을 못 채점하면
// "막았을 때만 채점된" 성적표가 된다 — 그게 바로 이 기능이 피하려는 착시다.
// 그래서 없으면 그 시각의 1분봉 종가를 읽어 채운다.
//
// 되돌릴 수 없는 일을 하지 않는다
// ───────────────────────────────
// 이 라우트는 `outcome`이 **NULL인 행만** 채운다. 이미 채점된 것은 건드리지
// 않는다 — 성적표를 나중에 고칠 수 있으면 그 성적표는 증거가 아니다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { outcomeFromPrices } from '@/lib/ai/calibration';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 한 번에 이만큼만. 크론이 타임아웃으로 통째로 실패하는 것보다 낫다 */
const MAX_PER_RUN = 200;

/**
 * 그 시각의 1분봉 종가.
 *
 * 실패하면 null이다. **0을 돌려주지 않는다** — 0은 '값이 0'이고 null은
 * '모른다'인데, 0을 쓰면 그 예측이 −100%로 채점된다.
 */
async function closeAt(symbol: string, atMs: number): Promise<number | null> {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}`
      + `&interval=1m&startTime=${atMs}&limit=1`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const close = Array.isArray(rows) && rows[0] ? Number(rows[0][4]) : NaN;
    return Number.isFinite(close) && close > 0 ? close : null;
  } catch { return null; }
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || '';
  if (secret) {
    const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      || req.nextUrl.searchParams.get('secret') || '';
    if (given !== secret) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const now = Date.now();
  let rows: any[] = [];
  try {
    const { data, error } = await (sb as any).from('ai_predictions')
      .select('id, symbol, decided_at, horizon_min, entry_price')
      .is('outcome', null)
      .order('decided_at', { ascending: true })
      .limit(MAX_PER_RUN * 3);   // 아직 기한이 안 된 것이 섞여 있다
    if (error) throw new Error(error.message);
    rows = Array.isArray(data) ? data : [];
  } catch (e: any) {
    return NextResponse.json({
      ok: false, error: 'query_failed',
      message: `채점 대상을 읽지 못했습니다 (${e?.message || e}). 마이그레이션 023을 적용했는지 확인하세요.`,
    }, { status: 500 });
  }

  // 기한이 지난 것만. 아직 안 된 것은 다음 실행에서 본다.
  const due = rows.filter(r => {
    const at = Date.parse(String(r.decided_at || ''));
    const h = Number(r.horizon_min);
    if (!Number.isFinite(at) || !Number.isFinite(h) || h <= 0) return false;
    return now >= at + h * 60_000;
  }).slice(0, MAX_PER_RUN);

  let scored = 0;
  // 가격을 못 읽어 못 채점한 것. **조용히 넘기지 않는다** — 이 숫자가 크면
  // 성적표가 일부만 보고 만들어진 것이고, 그 사실을 알아야 한다.
  let unpriced = 0;
  let failed = 0;

  for (const r of due) {
    const at = Date.parse(String(r.decided_at));
    const h = Number(r.horizon_min);
    const symbol = String(r.symbol || '');
    if (!symbol) { unpriced++; continue; }

    const entry = Number.isFinite(Number(r.entry_price)) && Number(r.entry_price) > 0
      ? Number(r.entry_price)
      : await closeAt(symbol, at);
    const later = await closeAt(symbol, at + h * 60_000);

    const outcome = outcomeFromPrices(entry, later);
    // 둘 중 하나라도 못 읽었으면 **건드리지 않는다.** 다음 실행에서 다시
    // 시도한다 — 여기서 'neutral'로 적으면 못 읽은 것이 결과가 된다.
    if (outcome == null) { unpriced++; continue; }

    try {
      const { error } = await (sb as any).from('ai_predictions')
        .update({
          outcome,
          outcome_price: later,
          entry_price: entry,
          scored_at: new Date(now).toISOString(),
        })
        .eq('id', r.id)
        // 경합 방지. 다른 실행이 이미 채점했으면 덮어쓰지 않는다.
        .is('outcome', null);
      if (error) throw new Error(error.message);
      scored++;
    } catch { failed++; }
  }

  return NextResponse.json({
    ok: true,
    checked: rows.length, due: due.length,
    scored, unpriced, failed,
    note: unpriced > 0
      ? `${unpriced}건은 가격을 못 읽어 채점하지 못했습니다 — 결과 없음으로 남겨 다음 실행에서 다시 시도합니다`
      : null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

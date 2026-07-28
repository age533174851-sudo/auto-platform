// GET /api/cron/news-sync
//
// 뉴스를 수집해 중복을 걷고 저장한다. **AI는 부르지 않는다.**
//
// 수집과 분석을 나눈 이유
// ───────────────────────
// 붙여 두면 수집이 느려지고, 분석이 실패했을 때 원문까지 다시 받아야 한다.
// 원문은 사실이라 한 번만 받으면 되고, 분석은 모델을 바꾸면 다시 만든다.
//
// 화면을 열 때마다 수집하지 않는 이유
// ──────────────────────────────────
// 사용자가 열 때마다 외부 API를 때리면 요금 한도가 사람 수만큼 곱해진다.
// 예약으로 모아 두고 화면은 저장된 것을 읽는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { collectFrom, onlyNew } from '@/lib/news/collect';
import { saveArticles, knownHashes } from '@/lib/news/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export async function GET(req: NextRequest) {
  // 크론 인증. 없으면 아무나 호출해 외부 API 한도를 태울 수 있다.
  const secret = process.env.CRON_SECRET || '';
  if (secret) {
    const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      || req.nextUrl.searchParams.get('secret') || '';
    if (given !== secret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const batches: { provider: string; items: any[] | null }[] = [];
  const sourceStatus: Record<string, string> = {};

  // ── Finnhub ──
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (finnhubKey) {
    const d = await fetchJson(`https://finnhub.io/api/v1/news?category=general&token=${finnhubKey}`);
    batches.push({ provider: 'finnhub', items: Array.isArray(d) ? d : null });
    sourceStatus.finnhub = Array.isArray(d) ? `${d.length}건` : '응답 없음';
  } else sourceStatus.finnhub = 'FINNHUB_API_KEY 없음';

  // ── FMP ──
  const fmpKey = process.env.FMP_API_KEY;
  if (fmpKey) {
    const d = await fetchJson(`https://financialmodelingprep.com/api/v3/stock_news?limit=50&apikey=${fmpKey}`);
    batches.push({ provider: 'fmp', items: Array.isArray(d) ? d : null });
    sourceStatus.fmp = Array.isArray(d) ? `${d.length}건` : '응답 없음';
  } else sourceStatus.fmp = 'FMP_API_KEY 없음';

  // ── NewsAPI ──
  const newsKey = process.env.NEWS_API_KEY;
  if (newsKey) {
    const d = await fetchJson(
      `https://newsapi.org/v2/everything?q=crypto%20OR%20bitcoin%20OR%20stock%20market&sortBy=publishedAt&pageSize=50&language=en&apiKey=${newsKey}`);
    const items = Array.isArray(d?.articles) ? d.articles : null;
    batches.push({ provider: 'newsapi', items });
    sourceStatus.newsapi = items ? `${items.length}건` : '응답 없음';
  } else sourceStatus.newsapi = 'NEWS_API_KEY 없음';

  const collected = collectFrom(batches);

  // 수집처가 하나도 없으면 그 사실을 분명히 말한다. 0건과 '키가 없다'는
  // 화면에서 똑같이 '뉴스 없음'으로 보인다.
  if (batches.length === 0) {
    return NextResponse.json({
      ok: false,
      message: '뉴스 공급자 키가 하나도 없습니다. FINNHUB_API_KEY / FMP_API_KEY / NEWS_API_KEY 중 하나를 넣으세요.',
      sources: sourceStatus,
    }, { status: 503 });
  }

  const sb = getSupabaseAdmin();

  // 이미 저장된 것을 빼고 새 것만 넣는다. 조회가 실패하면 null이 오는데,
  // 그때는 전부 새 기사로 취급한다 — 중복 저장은 hash 충돌로 무시되므로
  // 손해가 없지만, 반대로 빈 집합으로 착각하면 안 된다.
  const hashes = collected.unique.map(a => a.hash);
  const known = await knownHashes(sb, hashes);
  const fresh = known ? onlyNew(collected.unique, known) : collected.unique;

  const saved = await saveArticles(sb, fresh);

  return NextResponse.json({
    ok: saved.ok || saved.skippedNoTable,
    sources: sourceStatus,
    collected: collected.unique.length,
    duplicatesRemoved: collected.removed,
    // 버린 개수를 숨기면 공급자 형식이 바뀌어도 모른다
    skippedInvalid: collected.skipped,
    newArticles: fresh.length,
    saved: saved.saved,
    knownLookupFailed: known === null,
    storageWarning: saved.skippedNoTable ? saved.error : (saved.error || null),
    note: '원문만 저장했습니다. AI 분석은 /api/cron/ai-enrichment에서 따로 돌립니다.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

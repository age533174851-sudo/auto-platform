// GET /api/news/stored?limit=30&direction=bullish&analyzed=1
//
// 저장된 뉴스와 AI 분석을 읽는다. **여기서 수집하지 않는다.**
//
// 화면을 열 때마다 외부 API를 때리면 요금 한도가 사람 수만큼 곱해진다.
// 수집은 크론이 하고 화면은 저장된 것을 읽는다.
//
// 분석이 없는 기사도 돌려준다
// ───────────────────────────
// 분석된 것만 주면 화면에 뉴스가 늦게 뜬다 — 수집은 됐는데 분석이 아직
// 안 붙은 30분 동안 빈 화면이 된다. 대신 분석 유무를 필드로 구분해서,
// 화면이 '분석 대기 중'과 '분석함'을 다르게 그릴 수 있게 한다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { DIRECTION_KO, HORIZON_KO, type NewsDirection, type NewsHorizon } from '@/lib/news/schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DIRECTIONS = ['bullish', 'neutral', 'bearish', 'uncertain'];

export async function GET(req: NextRequest) {
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const sp = req.nextUrl.searchParams;
  const limit = Math.max(1, Math.min(100, Number(sp.get('limit')) || 30));
  const dir = String(sp.get('direction') || '').toLowerCase();
  const onlyAnalyzed = sp.get('analyzed') === '1';

  try {
    // 019는 아직 실행 전이라 생성된 DB 타입에 news_articles가 없다.
    // 다른 라우트들과 같은 방식으로 any를 거쳐 부른다 — 마이그레이션을
    // 돌리고 타입을 다시 생성하면 이 캐스팅을 지울 수 있다.
    let q = ((sb as any).from('news_articles') as any)
      .select('hash, title, url, published_at, source, provider, analyzed_at, ai_provider, ai_model, title_ko, summary, direction, confidence, horizon, reasons, risks, affected_assets')
      .order('published_at', { ascending: false })
      .limit(limit);

    if (DIRECTIONS.includes(dir)) q = q.eq('direction', dir);
    if (onlyAnalyzed) q = q.not('analyzed_at', 'is', null);

    const { data, error } = await q;

    if (error) {
      const msg = String(error.message || '').toLowerCase();
      const missing = String(error.code) === '42P01'
        || msg.includes('does not exist') || msg.includes('could not find the table');
      // 테이블이 없는 것과 조회가 실패한 것은 다르다. 둘 다 '뉴스 없음'으로
      // 보이면 왜 비어 있는지 알 수 없다.
      return NextResponse.json({
        ok: false,
        needsMigration: missing,
        items: [],
        message: missing
          ? 'news_articles 테이블이 없습니다 — supabase/migrations/019_news_articles.sql을 실행하세요.'
          : `뉴스를 읽지 못했습니다: ${error.message}`,
      }, { status: 503 });
    }

    const items = (data || []).map((r: any) => {
      const analyzed = !!r.analyzed_at;
      const d = String(r.direction || '') as NewsDirection;
      const h = String(r.horizon || 'unknown') as NewsHorizon;
      return {
        id: r.hash,
        title: r.title,
        url: r.url,
        source: r.source || r.provider || '',
        publishedAt: r.published_at,

        // 분석 유무를 감추지 않는다. null과 '분석 대기'는 화면에서
        // 다르게 보여야 한다 — 안 그러면 사용자는 AI가 판단을 안 한
        // 것인지 아직 안 돌린 것인지 모른다.
        analyzed,
        titleKo: analyzed ? r.title_ko : null,
        summary: analyzed ? r.summary : null,
        direction: analyzed && DIRECTIONS.includes(d) ? d : null,
        directionKo: analyzed && DIRECTIONS.includes(d) ? DIRECTION_KO[d] : null,
        confidence: analyzed && Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null,
        horizon: analyzed ? h : null,
        horizonKo: analyzed ? (HORIZON_KO[h] ?? HORIZON_KO.unknown) : null,
        reasons: Array.isArray(r.reasons) ? r.reasons : [],
        risks: Array.isArray(r.risks) ? r.risks : [],
        affectedAssets: Array.isArray(r.affected_assets) ? r.affected_assets : [],
        aiProvider: r.ai_provider || null,
        aiModel: r.ai_model || null,
        analyzedAt: r.analyzed_at || null,
      };
    });

    return NextResponse.json({
      ok: true,
      items,
      total: items.length,
      analyzedCount: items.filter(i => i.analyzed).length,
      note: 'AI 분석은 예측이며 투자 조언이 아닙니다. 원문을 함께 확인하세요.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({
      ok: false, items: [], message: e?.message || '뉴스 조회 중 오류',
    }, { status: 500 });
  }
}

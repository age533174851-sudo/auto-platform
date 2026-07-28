// POST /api/ai/consensus
// { article: { title, body?, url, publishedAt, source? } }
//
// 같은 기사를 여러 AI에게 각각 물어보고 의견을 모은다.
//
// 모든 기사에 쓰지 않는다
// ───────────────────────
// 3개 공급자를 부르면 비용이 세 배다. 사양대로 중요한 뉴스에만 쓴다.
// 어떤 기사가 중요한지는 lib/news/consensus의 worthConsensus가 정한다 —
// 그때그때 사람이 정하면 결국 전부 돌리게 된다.
//
// 병렬로 부르는 이유
// ──────────────────
// 크론의 분석과 달리 여기는 사용자가 화면에서 기다린다. 순서대로 부르면
// 지연이 세 배가 되는데, 서로 다른 공급자라 한도도 따로 걸린다.
import { NextRequest, NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/supabase/server';
import { analyzeArticle } from '@/lib/news/analyzeOne';
import { aggregate, type Opinion } from '@/lib/news/consensus';
import { callProvider, availableProviders } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const a = body?.article;
  if (!a || typeof a !== 'object') {
    return NextResponse.json({ error: 'article_required' }, { status: 400 });
  }

  const providers = availableProviders();
  if (providers.length === 0) {
    return NextResponse.json({
      error: 'no_ai_provider',
      message: 'AI 공급자 키가 설정되지 않았습니다.',
    }, { status: 503 });
  }

  // 하나뿐이면 합의를 만들 수 없다. 부르기 전에 말한다 — 불러 놓고
  // '합의 실패'라고 하면 모델이 실패한 것처럼 보인다.
  if (providers.length < 2) {
    return NextResponse.json({
      ok: false,
      message: `AI 공급자가 ${providers.length}개뿐입니다. 합의 분석에는 최소 2개가 필요합니다 — 단일 분석(/api/ai/news/analyze)을 쓰세요.`,
      available: providers,
    }, { status: 400 });
  }

  const article = {
    title: String(a.title ?? ''),
    body: a.body ? String(a.body) : undefined,
    url: String(a.url ?? ''),
    publishedAt: String(a.publishedAt ?? ''),
    source: a.source ? String(a.source) : undefined,
  };

  // 각 공급자에게 **같은 질문**을 던진다. 프롬프트가 다르면 의견 차이가
  // 모델 차이인지 질문 차이인지 알 수 없다.
  const settled = await Promise.all(providers.map(async p => {
    const r = await analyzeArticle(article, (input) => callProvider(p, input));
    return { provider: p, r };
  }));

  const opinions: Opinion[] = [];
  const skipped: { provider: string; reason: string }[] = [];

  for (const { provider, r } of settled) {
    if (r.ok && r.value) {
      opinions.push({
        provider,
        direction: r.value.direction,
        confidence: r.value.confidence,
        reasons: r.value.reasons,
        risks: r.value.risks,
      });
    } else {
      // 빠진 공급자를 숨기지 않는다. 둘이 답했는데 셋이 답한 줄 알면
      // 합의의 무게를 잘못 읽는다.
      skipped.push({ provider, reason: r.reason });
    }
  }

  const result = aggregate(opinions);

  return NextResponse.json({
    ok: true,
    consensus: {
      level: result.level,
      direction: result.direction,
      directionKo: result.directionKo,
      confidence: result.confidence,
      summary: result.summary,
      votes: result.votes,
      responded: result.responded,
    },
    // AI별 의견을 그대로 노출한다. 합의만 보여주면 왜 그 결론인지
    // 되짚을 수 없고, 갈린 지점이야말로 이 기능의 값어치다.
    opinions: opinions.map(o => ({
      provider: o.provider, direction: o.direction,
      confidence: o.confidence, reasons: o.reasons ?? [],
    })),
    sharedReasons: result.sharedReasons,
    uniqueReasons: result.uniqueReasons,
    skipped,
    note: '여러 AI의 예측을 모은 것이며 투자 조언이 아닙니다. 의견이 갈린 경우 방향을 내지 않습니다.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

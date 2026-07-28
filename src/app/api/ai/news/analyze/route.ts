// POST /api/ai/news/analyze
// { article: { title, body?, url, publishedAt, source? }, provider? }
//
// 기사 하나를 AI로 분석한다. 규칙은 전부 lib/news/analyzeOne에 있고
// 여기서는 인증과 위임만 한다.
//
// 여기서 뉴스를 만들지 않는다
// ───────────────────────────
// AI는 주어진 원문을 해석만 한다. 그래서 url·publishedAt은 요청에서 온
// 값을 그대로 쓰고, 모델이 다른 값을 답하면 검증 단계에서 되돌린다.
import { NextRequest, NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/supabase/server';
import { analyzeArticle } from '@/lib/news/analyzeOne';
import { callAny, availableProviders, type AiProvider } from '@/lib/ai/providers';

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

  // 키가 하나도 없으면 부르기 전에 말한다. 호출해 봐야 같은 결론인데,
  // 그때는 '모델이 실패했다'로 보여서 원인을 찾기 어려워진다.
  if (availableProviders().length === 0) {
    return NextResponse.json({
      error: 'no_ai_provider',
      message: 'AI 공급자 키가 설정되지 않았습니다. OPENAI_API_KEY 등을 먼저 넣으세요.',
    }, { status: 503 });
  }

  const prefer = String(body?.provider || '').trim().toLowerCase();
  const preferred = (['openai', 'anthropic', 'gemini'] as string[]).includes(prefer)
    ? prefer as AiProvider : undefined;

  const r = await analyzeArticle({
    title: String(a.title ?? ''),
    body: a.body ? String(a.body) : undefined,
    url: String(a.url ?? ''),
    publishedAt: String(a.publishedAt ?? ''),
    source: a.source ? String(a.source) : undefined,
  }, (input) => callAny(input, preferred));

  if (!r.ok) {
    // 실패를 200으로 감싸지 않는다. 화면이 '분석 없음'과 '분석 실패'를
    // 구분할 수 있어야 한다.
    return NextResponse.json({
      ok: false, hash: r.hash, message: r.reason,
    }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    hash: r.hash,
    analysis: r.value,
    // 검증이 고친 항목을 숨기지 않는다. 모델 품질이 나빠지면 여기가 먼저 는다.
    repaired: r.repaired,
    note: '예측이며 투자 조언이 아닙니다. 원문을 함께 확인하세요.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

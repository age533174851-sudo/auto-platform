// GET /api/ai/usage?days=1
//
// 공급자별 사용량·응답시간·오류·예상 비용.
//
// 화면이 답해야 하는 질문
// ───────────────────────
// "지금 어느 공급자가 살아 있나", "어제부터 실패가 늘었나", "오늘 얼마
// 나갔나". 세 개 다 숫자 하나로는 답이 안 되고, 특히 세 번째는 틀린
// 숫자를 보여주는 게 안 보여주는 것보다 나쁘다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth/isAdmin';
import { availableProviders, type AiProvider } from '@/lib/ai/providers';
import { sumCost, estimateCost, PRICING_AS_OF } from '@/lib/ai/pricing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LABEL: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Claude', gemini: 'Gemini',
};

/** 중앙값. 평균은 느린 호출 하나에 통째로 끌려간다 */
function median(xs: number[]): number | null {
  const v = xs.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

export async function GET(req: NextRequest) {
  // 관리자만. 이 화면은 **전체 사용자의** 호출량과 비용을 보여준다 —
  // 다른 사람이 얼마나 썼는지, 어떤 오류가 났는지가 그대로 드러난다.
  // 화면에서 메뉴를 숨기는 것으로는 못 막는다. API를 직접 부르면 그만이다.
  const guard = await requireAdmin(req.headers.get('authorization'));
  if (guard instanceof Response) return guard;

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const days = Math.max(1, Math.min(30, Number(req.nextUrl.searchParams.get('days')) || 1));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const configured = availableProviders();
  const all: AiProvider[] = ['openai', 'anthropic', 'gemini'];

  let rows: any[] = [];
  let logWarning: string | null = null;

  try {
    const { data, error } = await (sb.from('ai_usage') as any)
      .select('provider, model, input_tokens, output_tokens, latency_ms, ok, error_text, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) {
      // 컬럼이 없으면 020을 안 돌린 것이다. 기록이 0건인 것과 다르다 —
      // 화면이 '호출을 안 했다'로 오해하면 안 된다.
      logWarning = /column|does not exist/i.test(String(error.message))
        ? 'ai_usage에 상세 컬럼이 없습니다 — supabase/migrations/020_ai_usage_detail.sql을 실행하세요. 사용량이 0으로 보이는 것은 기록이 없어서지 호출이 없어서가 아닐 수 있습니다.'
        : `사용 기록을 읽지 못했습니다: ${error.message}`;
    } else rows = Array.isArray(data) ? data : [];
  } catch (e: any) {
    logWarning = `사용 기록 조회 중 오류: ${e?.message || e}`;
  }

  const byProvider = all.map(p => {
    const mine = rows.filter(r => String(r.provider) === p);
    const okRows = mine.filter(r => r.ok !== false);
    const failRows = mine.filter(r => r.ok === false);
    const cost = sumCost(mine.map(r => ({
      model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
    })));
    const lat = median(mine.map(r => Number(r.latency_ms)));

    return {
      id: p,
      label: LABEL[p],
      configured: configured.includes(p),
      calls: mine.length,
      ok: okRows.length,
      failed: failRows.length,
      // 성공률은 호출이 있어야 의미가 있다. 0건일 때 100%로 적으면
      // '완벽하게 동작 중'으로 읽힌다.
      successRate: mine.length > 0 ? Math.round((okRows.length / mine.length) * 100) : null,
      // 평균이 아니라 중앙값. 평균은 느린 호출 하나에 통째로 끌려간다.
      latencyMedianMs: lat,
      cost: {
        label: cost.label, usd: cost.usd, isPartial: cost.isPartial,
        unpricedCalls: cost.unpriced, untokenedCalls: cost.untokened,
      },
      // 최근 오류를 그대로 보여준다. 횟수만으로는 대응을 정할 수 없다.
      recentErrors: failRows.slice(0, 3).map(r => ({
        at: r.created_at, text: String(r.error_text || '').slice(0, 160),
      })),
    };
  });

  const total = sumCost(rows.map(r => ({
    model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
  })));

  const wanted = String(process.env.AI_DEFAULT_PROVIDER || '').trim().toLowerCase();
  const fallbacks = String(process.env.AI_FALLBACK_PROVIDERS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(s => (all as string[]).includes(s));

  return NextResponse.json({
    ok: true,
    days,
    providers: byProvider,
    total: {
      calls: rows.length,
      failed: rows.filter(r => r.ok === false).length,
      cost: { label: total.label, usd: total.usd, isPartial: total.isPartial },
    },
    defaultProvider: (all as string[]).includes(wanted) ? wanted : null,
    fallbacks,
    // 단가는 낡는다. 언제 기준인지 화면이 같이 보여줘야 숫자를 얼마나
    // 믿을지 사용자가 정할 수 있다.
    pricingAsOf: PRICING_AS_OF,
    pricingNote: '공급자 공시가 기준 추정치입니다. 실제 청구액은 각 공급자 콘솔을 확인하세요.',
    logWarning,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

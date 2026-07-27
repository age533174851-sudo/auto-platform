// /api/ai/keys
// 개인 AI API 키(BYOK) 등록·조회·삭제 + 오늘 사용량.
// 키는 암호화 저장하고, 응답에는 마스킹된 형태만 반환한다.
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;

// 제공자별 키 형식 간단 검증 (오타로 인한 결제 실패 방지)
function looksValid(provider: string, key: string): boolean {
  if (!key || key.length < 20) return false;
  if (provider === 'openai') return key.startsWith('sk-');
  if (provider === 'anthropic') return key.startsWith('sk-ant-');
  if (provider === 'gemini') return key.length >= 30;
  return true;
}

async function db() {
  const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
  return getSupabaseAdmin();
}

export async function GET(req: NextRequest) {
  const userId = new URL(req.url).searchParams.get('userId');
  if (!userId) return NextResponse.json({ ok: false, error: 'userId 필요' }, { status: 400 });

  try {
    const sb = await db();
    const { data: keys } = await sb.from('ai_keys')
      .select('provider, key_masked, active, last_used_at, created_at').eq('user_id', userId);

    // 오늘 사용량
    const today = new Date().toISOString().slice(0, 10);
    const { data: usage } = await sb.from('ai_usage')
      .select('tier, credits, used_own_key, cache_hit').eq('user_id', userId).eq('usage_date', today);

    const rows = Array.isArray(usage) ? usage : [];
    const platformCredits = rows.filter(r => !r.used_own_key).reduce((a, r) => a + (Number(r.credits) || 0), 0);
    const cacheHits = rows.filter(r => r.cache_hit).length;

    const { PLAN_QUOTAS } = await import('@/lib/ai/gateway');
    const hasOwnKey = Array.isArray(keys) && keys.some(k => k.active);
    const plan = hasOwnKey ? 'byok' : 'free';
    const quota = PLAN_QUOTAS[plan as keyof typeof PLAN_QUOTAS];

    return NextResponse.json({
      ok: true,
      keys: (keys || []).map(k => ({ provider: k.provider, masked: k.key_masked, active: k.active, lastUsedAt: k.last_used_at })),
      usage: {
        date: today,
        callCount: rows.length,
        cacheHits,
        creditsUsed: platformCredits,
        dailyLimit: quota.dailyCredits,
        remaining: quota.dailyCredits < 0 ? -1 : Math.max(0, quota.dailyCredits - platformCredits),
        plan: quota.label,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '조회 실패' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'JSON 파싱 실패' }, { status: 400 }); }

  const { userId, provider, apiKey } = body || {};
  if (!userId) return NextResponse.json({ ok: false, error: 'userId 필요' }, { status: 400 });
  if (!PROVIDERS.includes(provider)) {
    return NextResponse.json({ ok: false, error: `provider는 ${PROVIDERS.join(', ')} 중 하나여야 합니다` }, { status: 400 });
  }
  if (!looksValid(provider, String(apiKey || ''))) {
    return NextResponse.json({ ok: false, error: '키 형식이 올바르지 않습니다' }, { status: 400 });
  }

  try {
    const sb = await db();
    const { encryptSecret, maskKey } = await import('@/lib/exchanges/crypto');
    await sb.from('ai_keys').upsert({
      user_id: userId, provider,
      key_enc: encryptSecret(String(apiKey)),
      key_masked: maskKey(String(apiKey)),
      active: true,
    }, { onConflict: 'user_id,provider' });

    return NextResponse.json({
      ok: true, provider, masked: maskKey(String(apiKey)),
      message: '개인 키가 등록되었습니다. 이제 AI 사용료는 회원님 계정으로 청구되며 일일 한도가 없습니다.',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '등록 실패' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const userId = url.searchParams.get('userId');
  const provider = url.searchParams.get('provider');
  if (!userId || !provider) return NextResponse.json({ ok: false, error: 'userId, provider 필요' }, { status: 400 });

  try {
    const sb = await db();
    await sb.from('ai_keys').delete().eq('user_id', userId).eq('provider', provider);
    return NextResponse.json({ ok: true, message: '키가 삭제되었습니다. 이후 기본 플랜 한도가 적용됩니다.' });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '삭제 실패' }, { status: 500 });
  }
}

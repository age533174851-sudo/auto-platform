// /api/ai/keys
// 개인 AI API 키(BYOK) 등록·조회·삭제 + 오늘 사용량.
// 키는 암호화 저장하고, 응답에는 마스킹된 형태만 반환한다.
//
// ── 인증 ────────────────────────────────────────────────────────
// **예전에는 인증이 아예 없었고, userId를 클라이언트가 정했다.**
//
//   GET    /api/ai/keys?userId=<남의 UUID>
//     → 그 사람의 키 목록·사용량·요금제가 그대로 나온다
//   POST   { userId: <남의 UUID>, provider, apiKey }
//     → 그 사람 계정에 키를 심는다. 이후 그 사람의 AI 호출이
//       심어 둔 키로 나가고 요금이 그쪽에 청구된다
//   DELETE /api/ai/keys?userId=<남의 UUID>&provider=openai
//     → 그 사람의 키를 지운다
//
// 이 라우트는 service-role 클라이언트를 쓰므로 RLS도 걸리지 않는다.
// 즉 UUID 하나만 알면 남의 계정을 읽고 쓰고 지울 수 있었다.
//
// **주인은 토큰이 정한다.** 본문·쿼리의 userId는 받지 않는다 —
// 받아서 "토큰과 같은지 확인"하는 것보다, 아예 안 보는 편이 낫다.
// 확인을 한 군데서 빠뜨리면 그 순간 다시 열린다.
import { NextRequest, NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/supabase/admin';

/** 요청자 본인. 아니면 401. */
async function requireSelf(req: NextRequest): Promise<{ userId: string } | Response> {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) {
    return NextResponse.json(
      { ok: false, error: 'auth_required', message: '로그인이 필요합니다' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  return { userId: uid };
}

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
  const who = await requireSelf(req);
  if (who instanceof Response) return who;
  const { userId } = who;

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

  const who = await requireSelf(req);
  if (who instanceof Response) return who;
  const { userId } = who;

  // body.userId는 무시한다. 보내도 안 쓴다.
  const { provider, apiKey } = body || {};
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
  const who = await requireSelf(req);
  if (who instanceof Response) return who;
  const { userId } = who;

  const provider = new URL(req.url).searchParams.get('provider');
  if (!provider) return NextResponse.json({ ok: false, error: 'provider 필요' }, { status: 400 });

  try {
    const sb = await db();
    await sb.from('ai_keys').delete().eq('user_id', userId).eq('provider', provider);
    return NextResponse.json({ ok: true, message: '키가 삭제되었습니다. 이후 기본 플랜 한도가 적용됩니다.' });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '삭제 실패' }, { status: 500 });
  }
}

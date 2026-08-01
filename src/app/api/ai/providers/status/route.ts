// GET /api/ai/providers/status
//
// 어떤 AI 공급자를 쓸 수 있는지. **키 값은 절대 내보내지 않는다.**
//
// 이 화면이 필요한 이유
// ─────────────────────
// 키가 없어서 분석이 안 나오는 것과, 키는 있는데 모델이 실패하는 것은
// 완전히 다른 문제인데 화면에서는 둘 다 "분석 없음"으로 보인다.
// 여기서 그 둘을 갈라 준다.
import { NextRequest, NextResponse } from 'next/server';
import {
  availableProviders, providerRoutes, ALL_PROVIDERS, PROVIDER_LABEL,
  type AiProvider,
} from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: NextRequest) {
  const avail = availableProviders();
  const all = ALL_PROVIDERS;
  const routes = providerRoutes();

  // 기본 공급자가 실제로 쓸 수 있는지도 본다. 환경변수에 이름만 적어 두고
  // 키를 안 넣은 경우가 흔한데, 그러면 조용히 다른 공급자로 넘어가서
  // 왜 다른 모델이 답했는지 알 수 없다.
  const wanted = String(process.env.AI_DEFAULT_PROVIDER || '').trim().toLowerCase();
  const defaultProvider = (all as string[]).includes(wanted) ? wanted as AiProvider : null;
  const defaultUsable = defaultProvider ? avail.includes(defaultProvider) : false;

  const fallbacks = String(process.env.AI_FALLBACK_PROVIDERS || '')
    .split(',').map(s => s.trim().toLowerCase())
    .filter(s => (all as string[]).includes(s)) as AiProvider[];

  return NextResponse.json({
    ok: true,
    // 하나도 없으면 그 사실을 맨 앞에 둔다
    anyConfigured: avail.length > 0,
    providers: all.map(p => {
      const route = routes.find(r => r.provider === p);
      return {
        id: p,
        label: PROVIDER_LABEL[p],
        configured: avail.includes(p),
        // 직접 연결인지 OpenRouter 경유인지. 같은 '사용 가능'이라도 비용과
        // 장애 원인이 다르다 — 중계가 죽으면 경유하는 것만 전부 죽는다.
        via: route?.via ?? 'none',
        model: route?.model ?? null,
        envVar: route?.keyEnv ?? null,
        reason: route?.reason ?? '',
        isDefault: defaultProvider === p,
      };
    }),
    // OpenRouter가 켜져 있는가. 켜져 있으면 자기 키가 없는 제공자도 돈다.
    openrouter: {
      configured: !!(process.env.OPENROUTER_API_KEY || '').trim(),
      routed: routes.filter(r => r.via === 'openrouter').map(r => r.provider),
      note: 'OpenRouter는 중계입니다. 자기 키가 있는 제공자는 직접 연결이 우선입니다 '
          + '(수수료가 없고, 중계가 죽어도 살아 있습니다).',
    },
    defaultProvider,
    defaultUsable,
    defaultWarning: defaultProvider && !defaultUsable
      ? `AI_DEFAULT_PROVIDER가 ${PROVIDER_LABEL[defaultProvider]}인데 키가 없습니다. 다른 공급자로 넘어갑니다.`
      : null,
    fallbacks,
    message: avail.length === 0
      ? 'AI 공급자 키가 하나도 없습니다. 뉴스 분석은 동작하지 않습니다.'
      : `${avail.map(p => PROVIDER_LABEL[p]).join(' · ')} 사용 가능`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

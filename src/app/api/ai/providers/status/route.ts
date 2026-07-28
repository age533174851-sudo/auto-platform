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
import { availableProviders, type AiProvider } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI', anthropic: 'Claude', gemini: 'Gemini',
};
const ENV_NAME: Record<AiProvider, string> = {
  openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY',
};

export async function GET(_req: NextRequest) {
  const avail = availableProviders();
  const all: AiProvider[] = ['openai', 'anthropic', 'gemini'];

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
    providers: all.map(p => ({
      id: p,
      label: LABEL[p],
      configured: avail.includes(p),
      envVar: ENV_NAME[p],
      isDefault: defaultProvider === p,
    })),
    defaultProvider,
    defaultUsable,
    defaultWarning: defaultProvider && !defaultUsable
      ? `AI_DEFAULT_PROVIDER가 ${LABEL[defaultProvider]}인데 ${ENV_NAME[defaultProvider]}가 없습니다. 다른 공급자로 넘어갑니다.`
      : null,
    fallbacks,
    message: avail.length === 0
      ? 'AI 공급자 키가 하나도 없습니다. 뉴스 분석은 동작하지 않습니다.'
      : `${avail.map(p => LABEL[p]).join(' · ')} 사용 가능`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

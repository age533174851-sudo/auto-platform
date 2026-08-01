// GET /api/diagnostics/ip — **이 서버가 거래소에 보일 때의 IP**
//
// 왜 필요한가
// ───────────
// 거래소 키에 IP 제한을 걸면, 허용 목록에 넣어야 하는 것은 사용자의 폰이나
// PC가 아니라 **주문을 실제로 보내는 이 서버**다. 그런데 앱은 지금까지
// "이 서버 IP가 허용 목록에 있는지 확인하세요"라고만 적고 그 IP가 무엇인지는
// 어디에서도 알려주지 않았다. 확인할 방법이 없는 안내는 안내가 아니다.
//
// 왜 밖에 물어보는가
// ──────────────────
// 서버는 자기 공인 IP를 스스로 모른다. `req`의 헤더에 있는 것은 **들어온**
// 쪽 주소(사용자)이고, 거래소가 보는 것은 **나가는** 쪽 주소다. 둘은 다르다.
// 그래서 밖의 에코 서비스에 물어본다.
//
// 못 읽으면 못 읽었다고 한다
// ──────────────────────────
// 에코가 막히면 요청자 IP(x-forwarded-for)로 대신 채우고 싶어지는데, 그건
// **사용자의 IP**다. 그것을 거래소 허용 목록에 넣으면 영원히 안 된다.
// 잘못된 값을 주느니 확인 불가라고 적는다.
import { NextRequest, NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 하나가 막혀도 다른 하나로. 둘 다 실패하면 모른다고 한다 */
const ECHOES: Array<{ name: string; url: string; pick: (t: string) => string }> = [
  { name: 'ipify', url: 'https://api.ipify.org?format=json', pick: t => { try { return JSON.parse(t)?.ip || ''; } catch { return ''; } } },
  { name: 'ifconfig.me', url: 'https://ifconfig.me/ip', pick: t => t.trim() },
  { name: 'icanhazip', url: 'https://icanhazip.com', pick: t => t.trim() },
];

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

async function ask(e: typeof ECHOES[number]): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(e.url, { signal: ac.signal, cache: 'no-store' });
    if (!r.ok) return '';
    const ip = e.pick(await r.text());
    // 모양이 IP가 아니면 버린다. 에러 페이지 본문을 IP라고 적으면
    // 사용자가 그걸 거래소 허용 목록에 붙여 넣는다.
    return (IPV4.test(ip) || (ip.includes(':') && IPV6.test(ip))) ? ip : '';
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

export async function GET(req: NextRequest) {
  // 인프라 정보라 로그인은 받는다. 다만 이건 비밀이 아니라 **사용자가
  // 거래소에 등록해야 하는 값**이므로 권한을 더 요구하지는 않는다.
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const tried: string[] = [];
  for (const e of ECHOES) {
    const ip = await ask(e);
    tried.push(e.name);
    if (ip) {
      return NextResponse.json({
        ok: true, ip, source: e.name, tried,
        // **고정이라고 말하지 않는다.**
        //
        // Vercel 서버리스는 요청마다 다른 인스턴스에서 돌고 나가는 IP가
        // 바뀐다. 이 값 하나만 허용 목록에 넣으면 지금은 되고 나중에
        // 조용히 막힌다 — 고쳤다고 믿는 동안 주문이 안 나가는 상태가
        // 가장 나쁘다.
        stable: false,
        note: '이 IP는 요청마다 바뀔 수 있습니다(서버리스). 거래소 IP 허용 목록을 쓰려면 고정 IP가 필요하고, 그게 없으면 키의 IP 제한을 끄는 편이 안전합니다.',
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
  }

  return NextResponse.json({
    ok: false, error: 'echo_unreachable', tried,
    message: '서버 IP를 확인하지 못했습니다 — 바깥으로 나가는 요청이 막혀 있을 수 있습니다',
  }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
}

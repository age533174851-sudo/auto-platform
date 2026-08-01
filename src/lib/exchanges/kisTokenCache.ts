// src/lib/exchanges/kisTokenCache.ts
//
// KIS 접근토큰을 DB에 캐시한다.
//
// **왜 반드시 캐시해야 하는가**
// KIS는 토큰 재발급 횟수를 제한한다. 매 요청마다 새로 받으면 금방 막히고,
// 막히면 주문도 조회도 전부 실패한다. 크론이 1분마다 도는 이 앱에서는
// 캐시가 없으면 하루도 못 간다.
//
// 이 파일은 kis.ts의 TokenCache 모양만 맞춰 준다. 만료 판정은 여기 없다 —
// kisCore의 tokenNeedsRefresh가 한다. 판정을 두 곳에 두지 않는다.
import type { KisToken } from './kisCore';
import type { TokenCache } from './kis';

/**
 * 연결 한 건에 붙는 토큰 캐시.
 *
 * 읽기·쓰기가 실패하면 **예외를 던진다.** 조용히 null을 돌려주면
 * 호출부가 "캐시에 없구나" 하고 매번 새로 받게 되고, 그게 정확히
 * 한도에 걸리는 길이다. getAccessToken이 그 예외를 잡아 cacheNote에
 * 적는다 — 동작은 계속하되 보이게 만든다.
 */
export function supabaseTokenCache(sb: any, connectionId: string): TokenCache {
  return {
    async read(): Promise<KisToken | null> {
      const { data, error } = await (sb as any)
        .from('exchange_connections')
        .select('kis_access_token, kis_token_expires_at')
        .eq('id', connectionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const tok = data?.kis_access_token;
      const exp = data?.kis_token_expires_at;
      if (!tok || !exp) return null;
      const ms = Date.parse(String(exp));
      // 만료 시각을 못 읽으면 **토큰이 없는 것으로 친다.** 언제까지
      // 유효한지 모르는 토큰을 쓰면 어느 순간부터 조용히 401이 된다.
      if (!Number.isFinite(ms)) return null;
      return { accessToken: String(tok), expiresAtMs: ms };
    },

    async write(t: KisToken): Promise<void> {
      const { error } = await (sb as any)
        .from('exchange_connections')
        .update({
          kis_access_token: t.accessToken,
          kis_token_expires_at: new Date(t.expiresAtMs).toISOString(),
        })
        .eq('id', connectionId);
      if (error) throw new Error(error.message);
    },
  };
}

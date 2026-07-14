// src/lib/risk/idempotency.ts
// 웹훅 중복 주문 방지 — 같은 신호를 짧은 시간에 두 번 받으면 한 번만 처리.
// Supabase webhook_dedup 테이블의 UNIQUE(key) 제약으로 원자적 dedup.
// (TradingView 알림 중복 발사·재시도로 인한 이중 주문 차단)

export function signalKey(params: {
  clientId?: string | null;   // 클라이언트가 준 고유 id (있으면 최우선)
  connectionId: string;
  symbol: string;
  action: string;
  side: string;
  windowSec?: number;
}): string {
  if (params.clientId) return `cid:${params.clientId}`;
  // 고유 id가 없으면 (연결·종목·액션·방향 + 시간버킷) 조합으로 근사 dedup
  const win = params.windowSec ?? 15;
  const bucket = Math.floor(Date.now() / (win * 1000));
  return `${params.connectionId}:${params.symbol}:${params.action}:${params.side}:${bucket}`.toLowerCase();
}

/**
 * 신호를 'claim' 시도. 최초면 true(처리 진행), 이미 있으면 false(중복 → 스킵).
 * DB 오류 시엔 안전을 위해 통과(true)시키되 호출측에서 로깅 권장.
 */
export async function claimSignal(sb: any, key: string, windowSec = 15): Promise<{ ok: boolean; duplicate: boolean; error?: string }> {
  try {
    const now = Date.now();
    const expiresAt = new Date(now + windowSec * 1000).toISOString();
    // UNIQUE(key) 위반 시 중복으로 판단 (원자적)
    const { error } = await sb.from('webhook_dedup').insert({
      key,
      created_at: new Date(now).toISOString(),
      expires_at: expiresAt,
    });
    if (error) {
      // 23505 = unique_violation → 이미 처리된 신호
      if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
        return { ok: false, duplicate: true };
      }
      // 그 외 오류 → fail-open (주문 자체를 막지 않되 중복 아님 처리)
      return { ok: true, duplicate: false, error: error.message };
    }
    return { ok: true, duplicate: false };
  } catch (e: any) {
    return { ok: true, duplicate: false, error: e?.message || 'idempotency error' };
  }
}

// 만료된 dedup 레코드 정리 (주기적 호출용, 선택)
export async function cleanupDedup(sb: any): Promise<void> {
  try { await sb.from('webhook_dedup').delete().lt('expires_at', new Date().toISOString()); } catch {}
}

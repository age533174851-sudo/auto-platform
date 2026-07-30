// src/lib/exchanges/loadCreds.ts
//
// 연결에서 API 키를 꺼낸다. 소유권·거래소·출금권한 검사를 함께 한다.
//
// 왜 공용으로 빼는가
// ──────────────────
// 킬스위치·전량청산·미체결취소·부분청산·TP/SL 라우트가 전부 같은 다섯 줄을
// 복사해 갖고 있었다. 그중 하나만 빠뜨리면 그 경로에서 남의 연결로 주문하거나
// 출금 권한 키를 쓰게 된다 — 그리고 그런 누락은 코드를 훑어봐도 안 보인다.
//
// 이 함수를 통과하지 못하면 키를 얻지 못하므로, 검사를 건너뛰는 길이 없다.

/**
 * 판별 유니온(`{ok:true,...}|{ok:false,...}`)으로 쓰지 않는 이유: 이 프로젝트는
 * tsconfig가 `strict:false`라 그 형태의 narrowing이 동작하지 않는다.
 * `if(!r.ok) r.error`가 타입 에러가 된다 — lib/auth/adminGate.ts와 같은 이유다.
 */
export interface CredsResult {
  ok: boolean;
  key?: string;
  secret?: string;
  testnet?: boolean;
  connectionId?: string;
  /** ok=false일 때. 그대로 HTTP 상태로 쓴다 */
  status?: number;
  error?: string;
  message?: string;
}

/**
 * 바이낸스 연결의 키를 꺼낸다.
 *
 * `userId`로 소유권을 확인한다 — sb는 service-role이라 RLS가 적용되지 않으므로,
 * 이 조건이 없으면 connectionId를 아는 사람이 남의 키로 주문할 수 있다.
 */
export async function loadBinanceCreds(
  sb: any, userId: string, connectionId: string,
): Promise<CredsResult> {
  if (!connectionId) {
    return { ok: false, status: 400, error: 'missing_connectionId' };
  }

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, is_testnet, has_withdrawal, api_key, api_secret_enc, encrypted_secret')
    .eq('id', connectionId).eq('user_id', userId).maybeSingle();

  if (!conn) return { ok: false, status: 404, error: 'connection_not_found' };
  if (String(conn.exchange_id).toLowerCase() !== 'binance') {
    return { ok: false, status: 400, error: 'not_binance' };
  }
  if (conn.has_withdrawal === true) {
    return { ok: false, status: 403, error: 'withdrawal_key_blocked',
      message: '출금 권한이 있는 키는 자동매매에 사용할 수 없습니다' };
  }
  if (!conn.api_key) {
    return { ok: false, status: 400, error: 'connection_key_missing' };
  }

  let secret: string;
  try {
    const { decryptSecret } = await import('./crypto');
    secret = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '');
  } catch (e: any) {
    // 복호화 실패를 빈 문자열로 넘기면 거래소가 서명 오류를 주고, 화면에는
    // '주문 실패'로만 보인다. 원인이 암호화 키 교체라는 것을 알 수 없다.
    return { ok: false, status: 500, error: 'decrypt_failed',
      message: `API 시크릿을 복호화하지 못했습니다 (${e?.message || '사유 미상'}). `
             + '암호화 키가 바뀌었다면 연결을 다시 등록해야 합니다.' };
  }
  if (!secret) {
    return { ok: false, status: 500, error: 'decrypt_failed',
      message: 'API 시크릿이 비어 있습니다. 연결을 다시 등록하세요.' };
  }

  return {
    ok: true, key: conn.api_key, secret,
    // 명시적으로 false일 때만 실전이다. null·undefined는 테스트넷으로 본다 —
    // 모르는 값이 실전이 되면 안 된다.
    testnet: conn.is_testnet !== false,
    connectionId,
  };
}

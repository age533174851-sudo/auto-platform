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
  /** 어느 거래소인가. `loadFuturesCreds`만 채운다 */
  exchange?: 'binance' | 'gate';
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
  const r = await loadFuturesCreds(sb, userId, connectionId);
  if (r.ok && r.exchange !== 'binance') {
    return { ok: false, status: 400, error: 'not_binance',
      message: `이 연결은 ${r.exchange}입니다 — 이 기능은 아직 바이낸스 연결만 지원합니다` };
  }
  return r;
}

/**
 * 선물 주문 경로가 다루는 거래소(바이낸스·Gate)의 키를 꺼낸다.
 *
 * 왜 `loadBinanceCreds`와 나누는가
 * ─────────────────────────────────
 * 예전에는 이 함수 하나가 `exchange_id !== 'binance'`면 `not_binance`로
 * 거절했다. 그런데 이걸 쓰는 라우트가 12개다 — 한도 조회·마진 모드·
 * 킬스위치·전량청산·미체결취소까지. **Gate 연결을 고른 사용자는 그 화면들이
 * 전부 죽어 있었다.**
 *
 * 실제로 화면에는 이렇게 떴다:
 *   · 마진 모드 칸: "모드 ?"
 *   · 오늘 한도:    "확인 불가"
 * 둘 다 "고장"이 아니라 "이 라우트는 Gate를 모른다"였는데, 화면은 그걸
 * 구분해 말할 수 없었다.
 *
 * **못 닫는 것이 가장 나쁘다.** 전량청산·미체결취소가 Gate에서 안 되면
 * 열린 포지션을 화면에서 닫을 방법이 없다. 그래서 거래소를 함께 돌려주는
 * 이 함수를 만들고, 진짜로 바이낸스 전용인 것만 위의 얇은 래퍼를 쓴다.
 */
export async function loadFuturesCreds(
  sb: any, userId: string, connectionId: string,
): Promise<CredsResult> {
  if (!connectionId) {
    return { ok: false, status: 400, error: 'missing_connectionId' };
  }

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, is_testnet, has_withdrawal, api_key, api_secret_enc, encrypted_secret')
    .eq('id', connectionId).eq('user_id', userId).maybeSingle();

  if (!conn) return { ok: false, status: 404, error: 'connection_not_found' };

  // 이름 정규화는 futuresAdapter 한 곳에 있다 — `gate`와 `gateio`가 저장소
  // 안에 같이 돌아다니고, 정확히 'gate'만 보면 `gateio` 연결이 조용히 빠진다.
  const { futuresExchangeOf } = await import('./futuresAdapter');
  const exchange = futuresExchangeOf(conn.exchange_id);
  if (!exchange) {
    return { ok: false, status: 400, error: 'unsupported_exchange',
      message: `이 연결(${conn.exchange_id || '알 수 없음'})은 선물 경로가 다루지 않습니다 `
             + '— 지금 지원하는 곳은 바이낸스와 게이트아이오입니다' };
  }
  if (conn.has_withdrawal === true) {
    return { ok: false, status: 403, error: 'withdrawal_key_blocked',
      message: '출금 권한이 있는 키는 자동매매에 사용할 수 없습니다' };
  }
  if (!conn.api_key) {
    return { ok: false, status: 400, error: 'connection_key_missing' };
  }

  // ── 왜 못 읽었는지까지 말한다 ──
  //
  // **예전에는 네 가지가 한 문장으로 뭉개졌다:**
  //
  //   이 배포에 암호화 키가 없다 / 키가 다르다 / 저장된 모양이 깨졌다 /
  //   정말로 비어 있다
  //
  // 전부 "API 시크릿이 비어 있습니다. 연결을 다시 등록하세요."였다.
  // 그런데 원인이 앞의 둘일 때 그 말을 따르면 **더 나빠진다** —
  // 그 배포의 키로 다시 암호화한 값이 저장되고, 원래 키를 쓰는
  // 배포(운영)가 그 값을 못 읽는다.
  //
  // **고치라는 곳이 틀린 안내는 안내가 없는 것보다 나쁘다.**
  const { decryptSecretResult } = await import('./crypto');
  const dec = decryptSecretResult(conn.api_secret_enc ?? conn.encrypted_secret ?? '');
  if (!dec.ok) {
    return {
      ok: false, status: dec.code === 'EMPTY' || dec.code === 'MALFORMED' ? 400 : 500,
      // 원인을 코드로도 준다 — 화면이 문장을 다시 지어내지 않게.
      error: dec.code === 'NO_KEY' ? 'encryption_key_missing'
        : dec.code === 'KEY_MISMATCH' ? 'encryption_key_mismatch'
        : 'decrypt_failed',
      message: dec.message,
    };
  }
  const secret = dec.value;

  return {
    ok: true, key: conn.api_key, secret, exchange,
    // 명시적으로 false일 때만 실전이다. null·undefined는 테스트넷으로 본다 —
    // 모르는 값이 실전이 되면 안 된다.
    testnet: conn.is_testnet !== false,
    connectionId,
  };
}

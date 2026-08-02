// src/lib/exchanges/connection.ts
//
// **거래소 연결을 읽는 유일한 자리.**
//
// 왜 이 파일이 생겼나
// ───────────────────
// 주문·잔고·대사(對査) 경로 여덟 곳이 각자 이렇게 읽고 있었다:
//
//   .select('exchange, api_key, api_secret_enc, encrypted_secret, has_withdrawal')
//
// `exchange_connections`에 **`exchange` 칸도 `encrypted_secret` 칸도
// 없다.** 실제 이름은 `exchange_id`와 `api_secret_enc`다.
//
// PostgREST는 없는 칸을 고르면 **질의 전체를 실패시킨다** — 그 칸만
// 빠지는 것이 아니다. 그리고 supabase-js는 던지지 않고 { data: null,
// error }를 돌려준다. 여덟 곳 전부 error를 안 보고 `if (conn)`으로만
// 갈라서, 연결이 멀쩡히 저장돼 있어도 **언제나 '연결 없음'**이었다.
// 로그도 경고도 없었다. 화면의 연결 목록은 올바른 칸을 쓰므로 잘 보였고,
// 그래서 "연결은 돼 있는데 주문이 안 나간다"가 됐다.
//
// 같은 select 문자열을 여덟 번 손으로 적었기 때문에 한 번의 오타가 여덟
// 곳으로 복사됐다. 그래서 자리를 하나로 줄인다.

/** 실제로 존재하는 칸만. 여기에 없는 이름을 적으면 질의가 통째로 죽는다. */
export const CONN_SELECT =
  'id, user_id, exchange_id, label, api_key, api_secret_enc, api_passphrase_enc, '
  + 'account_no, has_withdrawal, is_active, is_testnet, is_paper, auto_trading_enabled';

export interface ExchangeConnection {
  id: string;
  userId: string | null;
  /** 'binance' | 'gate' | 'kis' | 그 밖의 원문 */
  exchange: string;
  label: string;
  apiKey: string;
  /** 복호화된 시크릿. **빈 문자열이면 못 쓴다** */
  apiSecret: string;
  passphrase: string;
  accountNo: string | null;
  hasWithdrawal: boolean;
  isTestnet: boolean;
  isActive: boolean;
}

export interface LoadResult {
  conn: ExchangeConnection | null;
  /** 왜 못 썼는가. conn이 있으면 빈 문자열. **null + 빈 이유는 없다** */
  error: string;
}

const fail = (error: string): LoadResult => ({ conn: null, error });

/** 거래소 태그를 정규화한다. 모르면 원문을 그대로 둔다 — binance로 추측하지 않는다 */
export function normalizeExchange(raw: any): string {
  const s = String(raw || '').toLowerCase();
  if (!s) return '';
  if (s.includes('gate')) return 'gate';
  if (s.includes('binance')) return 'binance';
  if (s.includes('kis') || s.includes('한국투자')) return 'kis';
  return s;
}

/**
 * 연결 하나를 읽어 바로 쓸 수 있는 모양으로 돌려준다.
 *
 * **실패는 전부 이유가 붙어서 나온다.** 예전처럼 조용히 null이 되면
 * "연결 없음"과 "칸 이름이 틀림"과 "남의 연결"이 화면에서 똑같아 보인다.
 *
 * @param userId 넘기면 그 사람 것만. 크론(service_role)은 안 넘길 수 있다.
 */
export async function loadConnection(
  sb: any,
  connectionId: string | null | undefined,
  userId?: string | null,
): Promise<LoadResult> {
  if (!sb) return fail('supabase가 설정되지 않았습니다');
  const id = String(connectionId || '');
  if (!id) return fail('연결(connectionId)이 지정되지 않았습니다');

  let row: any = null;
  try {
    let q = sb.from('exchange_connections').select(CONN_SELECT).eq('id', id);
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q.maybeSingle();
    // **error를 본다.** 이 한 줄이 없어서 여덟 곳이 전부 조용히 죽었다.
    if (error) return fail(`연결 조회 실패: ${error.message}`);
    row = data;
  } catch (e: any) {
    return fail(`연결 조회 실패: ${e?.message || e}`);
  }

  if (!row) {
    return fail(userId
      ? '연결을 찾지 못했습니다 — 지워졌거나 내 연결이 아닙니다'
      : '연결을 찾지 못했습니다');
  }

  // 출금 권한이 있는 키는 자동매매에 쓰지 않는다. 이건 '경고'가 아니라
  // 차단이다 — 경고로 두면 아무도 안 읽는다.
  if (row.has_withdrawal === true) {
    return fail('출금 권한이 있는 키입니다 — 자동매매에 쓸 수 없습니다. 출금 권한을 뺀 키로 다시 등록하세요');
  }
  if (row.is_active === false) {
    return fail('꺼져 있는 연결입니다');
  }

  const exchange = normalizeExchange(row.exchange_id);
  if (!exchange) return fail('연결에 거래소가 지정돼 있지 않습니다');

  const apiKey = String(row.api_key || '');
  if (!apiKey) return fail('연결에 API 키가 비어 있습니다 — 다시 등록하세요');

  const { decryptSecret } = await import('./crypto');
  const apiSecret = decryptSecret(String(row.api_secret_enc || ''));
  // 복호화가 실패해도 decryptSecret은 ''를 돌려준다. 빈 시크릿으로 서명하면
  // 거래소는 -2015 같은 인증 오류를 주는데, 그 메시지로는 '키가 틀렸다'와
  // '키를 못 읽었다'를 구분할 수 없다. 여기서 갈라 놓는다.
  if (!apiSecret) {
    return fail('시크릿을 복호화하지 못했습니다 — EXCHANGE_ENCRYPTION_KEY가 등록 당시와 다르거나 값이 비어 있습니다. 키를 되돌리거나 연결을 다시 등록하세요');
  }

  return {
    conn: {
      id: String(row.id),
      userId: row.user_id ? String(row.user_id) : null,
      exchange,
      label: String(row.label || ''),
      apiKey,
      apiSecret,
      passphrase: decryptSecret(String(row.api_passphrase_enc || '')),
      accountNo: row.account_no != null ? String(row.account_no) : null,
      hasWithdrawal: row.has_withdrawal === true,
      // **모르면 테스트넷으로 본다.** 실전 여부를 추측해서 틀리면 실제
      // 돈이 나간다. is_testnet === false일 때만 실전이다.
      isTestnet: row.is_testnet !== false,
      isActive: row.is_active !== false,
    },
    error: '',
  };
}

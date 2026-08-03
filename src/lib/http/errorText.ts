// src/lib/http/errorText.ts
//
// **기계 코드를 사람에게 던지지 않는다.**
//
// 왜 이 파일이 생겼나
// ───────────────────
// 게이트아이오 연결로 USDⓈ-M 주문을 눌렀더니 토스트에 `not_binance`
// 한 단어가 떴다. 무엇이 잘못됐는지도, 무엇을 해야 하는지도 없다.
//
// 라우트를 세어 보니 사람 문장 없이 코드만 돌려주는 자리가 **464곳**,
// 종류로는 134가지였다. 그걸 하나씩 고치면 다음에 라우트가 하나 늘 때
// 또 샌다. 거래소가 늘수록(바이낸스·게이트·한국투자…) 라우트도 는다.
//
// 그래서 **화면에 닿기 직전 한 곳**에서 막는다. 라우트가 무엇을 보내든
// 사용자는 사람 문장을 본다.
//
// 원문을 숨기지 않는다
// ────────────────────
// 모르는 코드는 문장으로 감싸되 코드를 괄호에 남긴다. 지우면 사용자가
// 캡처를 보내와도 원인을 좁힐 수 없다 — 오늘 하루가 그 작업이었다.

/**
 * 이미 사람이 읽을 문장인가.
 *
 * 공백이 있거나 한글이 있으면 사람 말로 본다. `not_binance`,
 * `MISSING_ID` 같은 것은 코드다. 이 판정이 틀려도 손해는 작다 —
 * 문장을 코드로 오인하면 괄호가 하나 붙을 뿐이다.
 */
export function looksLikeCode(s: string): boolean {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/[가-힣]/.test(t)) return false;           // 한글이 있으면 사람 말
  if (/\s/.test(t)) return false;                // 띄어쓰기가 있으면 문장
  return /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(t);   // snake_case · SCREAMING · dotted
}

/**
 * 코드 → 한국어 문장.
 *
 * 문장은 **무엇이 일어났는지와 무엇을 해야 하는지**를 같이 적는다.
 * "인증 필요"만 적으면 사용자는 이미 로그인했다고 생각하고 멈춘다.
 */
const TEXT: Record<string, string> = {
  // ── 인증·세션 ──
  auth_required: '로그인이 필요합니다 — 로그아웃됐을 수 있으니 다시 로그인해 주세요',
  unauthorized: '권한이 없습니다 — 이 작업을 할 수 있는 계정으로 로그인하세요',
  Unauthorized: '권한이 없습니다 — 이 작업을 할 수 있는 계정으로 로그인하세요',
  no_token: '로그인 정보가 없습니다 — 다시 로그인해 주세요',
  invalid_token: '로그인 정보가 만료됐습니다 — 다시 로그인해 주세요',
  missing_token: '로그인 정보가 없습니다 — 다시 로그인해 주세요',
  forbidden: '이 계정으로는 할 수 없는 작업입니다',

  // ── 서버 설정 ──
  // 사용자가 고칠 수 없는 것은 그렇다고 말한다. "다시 시도하세요"라고
  // 적으면 될 때까지 누르게 된다.
  supabase_not_configured: '서버 데이터베이스 설정이 빠져 있어 처리할 수 없습니다 — 앱 설정 문제이니 관리자에게 알려주세요',
  admin_secret_missing: '서버에 ADMIN_SECRET이 없어 자동 실행을 부를 수 없습니다 — 설정 후 재배포가 필요합니다',
  encryption_not_configured: '암호화 키가 설정되지 않아 API 키를 안전하게 다룰 수 없습니다 — 관리자에게 알려주세요',

  // ── 요청 모양 ──
  invalid_json: '요청을 읽지 못했습니다 — 화면을 새로고침한 뒤 다시 시도해 주세요',
  invalid_body: '요청 내용이 올바르지 않습니다 — 화면을 새로고침한 뒤 다시 시도해 주세요',
  missing_params: '필요한 값이 빠졌습니다 — 입력란을 다시 확인해 주세요',
  invalid_action: '알 수 없는 동작입니다 — 앱을 최신으로 새로고침해 주세요',
  unknown_action: '알 수 없는 동작입니다 — 앱을 최신으로 새로고침해 주세요',
  not_found: '대상을 찾지 못했습니다 — 이미 지워졌을 수 있습니다',
  missing_id: '대상이 지정되지 않았습니다',
  id_required: '대상이 지정되지 않았습니다',
  missing_symbol: '종목이 지정되지 않았습니다',
  symbol_required: '종목이 지정되지 않았습니다',

  // ── 거래소 연결 ──
  connection_not_found: '거래소 연결을 찾지 못했습니다 — 지워졌거나 내 연결이 아닙니다',
  missing_connectionId: '거래소 연결이 지정되지 않았습니다 — 위쪽에서 연결을 고르세요',
  connection_key_missing: '이 연결에 API 키가 없습니다 — 거래소 연결 화면에서 다시 등록하세요',
  connection_unusable: '이 연결로는 주문할 수 없습니다 — 거래소 연결 화면에서 상태를 확인하세요',
  decrypt_failed: '저장된 API 시크릿을 복호화하지 못했습니다 — 연결을 다시 등록하세요',
  not_binance: '이 연결은 바이낸스가 아닙니다 — 이 화면의 주문은 바이낸스 연결로만 나갑니다',
  withdrawal_key_blocked: '출금 권한이 있는 키입니다 — 주문에 쓸 수 없습니다. 출금 권한을 뺀 키로 다시 등록하세요',
  missing_credentials: 'API 키와 시크릿이 필요합니다',

  // ── 주문 ──
  invalid_quantity: '주문 수량이 올바르지 않습니다',
  invalid_amount: '금액이 올바르지 않습니다',
  invalid_side: '매수/매도 방향이 올바르지 않습니다',
  invalid_position_side: '포지션 방향(LONG/SHORT)이 올바르지 않습니다',
  invalid_leverage: '배율이 올바르지 않습니다',
  invalid_risk: '1회 위험 비율이 올바르지 않습니다',
  invalid_interval: '실행 간격이 올바르지 않습니다',
  unsupported_interval: '거래소가 지원하지 않는 봉 주기입니다',
  unsupported_timeframe: '지원하지 않는 봉 주기입니다',
  plan_rejected: '위험 관리 단계에서 주문이 거부됐습니다',
  confirmation_required: '확인이 필요합니다 — 확인 후 다시 눌러 주세요',
  kill_switch_active: '긴급 정지가 켜져 있어 신규 진입이 막혀 있습니다',
  job_not_found: '해당 작업을 찾지 못했습니다',
  timeframe_unusable: '이 봉 주기는 왕복 비용을 넘기기 어렵습니다',
  signal_unusable: '신호를 주문 모양으로 바꾸지 못했습니다',

  // ── 저장·조회 ──
  save_failed: '저장하지 못했습니다 — 잠시 뒤 다시 시도해 주세요',
  query_failed: '조회하지 못했습니다 — 잠시 뒤 다시 시도해 주세요',
  fetch_failed: '가져오지 못했습니다 — 잠시 뒤 다시 시도해 주세요',
  table_missing: '필요한 데이터베이스 표가 없습니다 — 마이그레이션이 적용되지 않았습니다',
  no_profile: '계정 정보를 찾지 못했습니다',
  lookup_failed: '확인하지 못했습니다 — 통과 여부를 알 수 없어 중단합니다',
};

/**
 * 화면에 띄울 문장을 만든다.
 *
 * @param raw   서버가 준 error/message. 이미 문장이면 그대로 둔다.
 * @param fallback raw가 비었을 때 쓸 말.
 */
export function humanError(raw: any, fallback = '처리하지 못했습니다'): string {
  if (raw == null) return fallback;

  // 문자열이 아닌 것이 온다. 서버가 { error: { code, msg } }를 그대로
  // 실어 보내는 라우트가 있고, String()에 넣으면 **[object Object]**가
  // 화면에 뜬다. 그건 코드보다 나쁘다 — 코드는 검색이라도 된다.
  if (typeof raw !== 'string') {
    if (typeof raw === 'number' || typeof raw === 'boolean') return `${fallback} (코드: ${raw})`;
    // 객체 안에 사람이 읽을 만한 칸이 있으면 그것을 쓴다.
    const inner = (raw as any)?.message ?? (raw as any)?.msg ?? (raw as any)?.error ?? (raw as any)?.code;
    if (inner != null && typeof inner !== 'object') return humanError(inner, fallback);
    return fallback;
  }

  const s = raw.trim();
  if (!s) return fallback;

  const known = TEXT[s];
  if (known) return known;

  // 대소문자만 다른 경우까지 받아준다 (`Unauthorized` / `unauthorized`)
  const lower = TEXT[s.toLowerCase()];
  if (lower) return lower;

  // 사람 말이면 손대지 않는다. 서버가 공들여 쓴 문장을 덮으면 안 된다.
  if (!looksLikeCode(s)) return s;

  // 모르는 코드다. **문장으로 감싸되 코드를 남긴다** — 지우면 캡처를
  // 받아도 원인을 좁힐 수 없다.
  return `${fallback} (코드: ${s})`;
}

/**
 * 응답 본문에서 사용자에게 보여줄 한 줄을 고른다.
 *
 * `message`가 있으면 그것이 우선이다 — 라우트가 상황에 맞게 쓴 말이
 * 사전보다 정확하다. 없으면 `error`를 사람 말로 바꾼다.
 */
export function errorTextOf(body: any, fallback = '처리하지 못했습니다'): string {
  const msg = body?.message;
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  return humanError(body?.error, fallback);
}

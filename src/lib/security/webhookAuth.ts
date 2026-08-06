// src/lib/security/webhookAuth.ts
//
// **웹훅 시크릿을 사람마다 따로 둔다.**
//
// 지금 무엇이 문제인가
// ────────────────────
// 트레이딩뷰 웹훅은 환경변수 시크릿 **하나**로 인증한다. 그 값을 아는
// 사람은 누구든 신호를 넣을 수 있고, `connectionId`만 바꾸면 **남의
// 계좌로** 주문을 낸다. (연결 소유권 검사가 뒤늦게 붙어 지금은 id와
// 사용자가 맞아야 하지만, 시크릿 자체가 공용이라는 사실은 그대로다.)
//
// 그리고 이 시크릿은 트레이딩뷰 알림 본문에 평문으로 들어간다. 알림
// 설정을 화면 공유하거나 스크린샷을 찍는 순간 노출된다. 공용이면 그
// 한 번으로 **모든 사용자**가 뚫린다.
//
// 무엇을 저장하는가
// ─────────────────
// **평문을 저장하지 않는다.** 해시만 둔다 — 데이터베이스가 새어도 그
// 값으로 주문을 낼 수 없어야 한다. API 키를 다루는 원칙과 같다.
//
// 그래서 시크릿은 **만들 때 한 번만** 보여 준다. 잃어버리면 새로
// 발급하는 것이지 되찾는 것이 아니다. 되찾을 수 있다면 그건 평문을
// 어딘가 들고 있다는 뜻이다.
//
// 비교는 상수 시간으로
// ────────────────────
// `a === b`는 다른 글자를 만나면 즉시 끝난다. 그 시간 차이로 앞에서부터
// 한 글자씩 맞춰 볼 수 있다. 웹훅은 외부에서 마음껏 두드릴 수 있는
// 입구라 이 공격이 실제로 성립한다.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** 시크릿 앞에 붙는 표식. 로그에서 눈으로 알아볼 수 있게 */
export const SECRET_PREFIX = 'tvw_';

/**
 * 새 시크릿을 만든다.
 *
 * 32바이트 난수. 짧게 만들면 무차별 대입이 가능해지는데, 웹훅은
 * 인증 실패를 200으로 돌려주므로(신호를 흘리는 것이 목적이라) 시도
 * 횟수 제한이 약하다.
 */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('base64url');
}

/** 저장할 해시. 평문은 어디에도 남기지 않는다 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(String(secret ?? ''), 'utf8').digest('hex');
}

/**
 * 화면·로그에 적을 지문.
 *
 * 시크릿 자체는 절대 다시 보여 주지 않지만, "지금 걸려 있는 것이
 * 내가 아는 그것인가"는 확인할 수 있어야 한다. 해시 앞 6자리면
 * 그 목적에는 충분하고 되돌릴 수는 없다.
 */
export function fingerprint(secret: string | null | undefined): string {
  if (!secret) return '';
  return hashSecret(secret).slice(0, 6);
}

/** 저장된 해시에서 바로 지문을 낸다 (평문이 없을 때) */
export function fingerprintOfHash(hash: string | null | undefined): string {
  return String(hash ?? '').slice(0, 6);
}

/**
 * 상수 시간 비교.
 *
 * 길이가 다르면 timingSafeEqual이 던지므로 먼저 확인하는데, **길이는
 * 어차피 새어 나간다** — 그건 시크릿 값을 좁히는 데 거의 도움이 안 된다.
 * 위험한 것은 내용의 앞에서부터 맞춰 보는 쪽이다.
 */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) return false;
  if (x.length === 0) return false;   // 빈 값끼리 통과시키지 않는다
  try { return timingSafeEqual(x, y); } catch { return false; }
}

export type WebhookAuthStatus =
  | 'OK'
  /** 시크릿을 안 보냈다 */
  | 'MISSING'
  /** 이 사용자에게 발급된 시크릿이 없다 */
  | 'NOT_CONFIGURED'
  /** 폐기된 시크릿이다 */
  | 'REVOKED'
  /** 값이 틀리다 */
  | 'MISMATCH';

export interface StoredSecret {
  userId: string;
  secretHash: string;
  revokedAt?: string | null;
}

export interface WebhookAuthResult {
  ok: boolean;
  status: WebhookAuthStatus;
  /** 화면·로그에 적을 문구. **시크릿 값은 절대 안 들어간다** */
  reason: string;
  userId: string | null;
}

/**
 * 이 요청이 이 사용자의 것인가.
 *
 * 순수 함수다 — 저장소를 읽지 않는다. 호출부가 이미 읽어 온 것을 넘긴다.
 *
 * **발급된 것이 없으면 통과시키지 않는다.** 예전 전역 시크릿으로
 * 떨어뜨리면 사람마다 나누는 의미가 사라진다 — 공용 값을 아는 사람이
 * 여전히 아무 계정으로나 들어온다.
 */
export function verifyWebhookSecret(
  presented: string | null | undefined,
  stored: StoredSecret | null | undefined,
): WebhookAuthResult {
  const p = String(presented ?? '').trim();
  if (!p) {
    return { ok: false, status: 'MISSING', userId: null,
      reason: '웹훅 시크릿이 없습니다' };
  }
  if (!stored || !stored.secretHash) {
    return { ok: false, status: 'NOT_CONFIGURED', userId: null,
      reason: '이 계정에 발급된 웹훅 시크릿이 없습니다 — 설정에서 발급하세요' };
  }
  if (stored.revokedAt) {
    return { ok: false, status: 'REVOKED', userId: null,
      reason: '폐기된 웹훅 시크릿입니다 — 새로 발급하세요' };
  }
  if (!safeEqual(hashSecret(p), stored.secretHash)) {
    // **어디가 틀렸는지 말하지 않는다.** "앞 네 글자는 맞습니다" 같은
    // 힌트를 주면 그게 곧 공격 도구가 된다.
    return { ok: false, status: 'MISMATCH', userId: null,
      reason: '웹훅 시크릿이 일치하지 않습니다' };
  }
  return { ok: true, status: 'OK', userId: stored.userId, reason: '' };
}

/**
 * 로그에 남길 수 있는 모양으로 줄인다.
 *
 * 인증 실패를 기록할 때 요청 본문을 통째로 남기면 **시크릿이 로그에
 * 평문으로 들어간다.** 실패 로그는 남겨야 하고 시크릿은 남으면 안 되므로,
 * 여기서 한 번 걸러 낸다.
 */
export function redactSecrets<T extends Record<string, any>>(body: T | null | undefined): Record<string, any> {
  if (!body || typeof body !== 'object') return {};
  const KEYS = ['secret', 'code', 'token', 'password', 'apiKey', 'api_key', 'passphrase'];
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(body)) {
    if (KEYS.includes(k)) {
      // 지문만 남긴다 — "어떤 값으로 시도했는가"를 나중에 대조할 수는
      // 있어야 하지만, 그 값으로 다시 주문을 낼 수는 없어야 한다.
      out[k] = typeof v === 'string' && v ? `[redacted:${fingerprint(v)}]` : '[redacted]';
    } else if (v && typeof v === 'object') {
      out[k] = '[object]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

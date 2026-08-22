// ─────────────────────────────────────────────────────────────
// TRAIGO Exchange Crypto Utilities
// AES-256-GCM encryption for API secrets — server-side only
// ─────────────────────────────────────────────────────────────
import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'crypto';

const ALGO = 'aes-256-gcm';

/**
 * 암호화 키 파생.
 *
 * 보안: 기본키(fallback)를 두지 않는다. 소스에 공개된 문자열로 거래소 secret을
 * 암호화하면 DB 유출 시 그대로 복호화된다. 키가 없으면 실패시킨다.
 *
 * EXCHANGE_ENCRYPTION_KEY: 32바이트(64 hex) 이상 전용 키.
 *   생성: openssl rand -hex 32
 */
function getKey(): Buffer {
  const secret = process.env.EXCHANGE_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error(
      'EXCHANGE_ENCRYPTION_KEY가 설정되지 않았거나 너무 짧습니다(32자 이상 필요). ' +
      '거래소 API 키를 안전하게 저장할 수 없어 중단합니다. `openssl rand -hex 32`로 생성하세요.'
    );
  }
  return Buffer.from(
    createHmac('sha256', 'traigo-key-derivation').update(secret).digest('hex').slice(0, 64),
    'hex'
  );
}

/** 암호화 키가 설정되어 있는지 확인 (헬스체크용 — 키 값은 노출하지 않음) */
export function isEncryptionConfigured(): boolean {
  const s = process.env.EXCHANGE_ENCRYPTION_KEY;
  return !!s && s.length >= 32;
}

/** Encrypt API secret before storing in DB */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv  = randomBytes(16);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(32hex) + tag(32hex) + encrypted(hex)
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * 복호화가 왜 실패했는가.
 *
 * **네 가지가 전부 빈 문자열 하나로 뭉개져 있었다.**
 *
 *   NO_KEY      이 환경에 EXCHANGE_ENCRYPTION_KEY가 없다
 *   KEY_MISMATCH 키가 있는데 이 값을 만든 키가 아니다
 *   MALFORMED   저장된 값이 iv:tag:enc 모양이 아니다
 *   EMPTY       저장된 값 자체가 비어 있다
 *
 * 그래서 화면은 넷 다 **"API 시크릿이 비어 있습니다. 연결을 다시
 * 등록하세요."**라고 적었다. 그런데 원인이 `NO_KEY`나 `KEY_MISMATCH`일
 * 때 그 말을 따르면 **더 나빠진다** — 그 환경의 키로 다시 암호화한
 * 값이 저장되고, 원래 키를 쓰는 환경(운영)이 그 값을 못 읽는다.
 *
 * 고치라는 곳이 틀린 안내는 안내가 없는 것보다 나쁘다.
 */
export type DecryptCode = 'OK' | 'NO_KEY' | 'KEY_MISMATCH' | 'MALFORMED' | 'EMPTY';

export interface DecryptResult {
  ok: boolean;
  code: DecryptCode;
  /** 성공했을 때만 값이 있다 */
  value: string;
  /** 사람이 읽고 **어디를 고칠지** 알 수 있는 한 줄 */
  message: string;
}

const DECRYPT_MESSAGE: Record<DecryptCode, string> = {
  OK: '',
  NO_KEY:
    '이 배포에 EXCHANGE_ENCRYPTION_KEY가 없습니다 — 저장된 값이 비어서가 아닙니다. '
    + '연결을 다시 등록하지 마세요: 다른 키로 덮어쓰면 원래 키를 쓰는 배포가 그 값을 못 읽습니다',
  KEY_MISMATCH:
    'EXCHANGE_ENCRYPTION_KEY가 이 값을 만든 키와 다릅니다 — 저장된 값이 비어서가 아닙니다. '
    + '키를 맞추는 것이 먼저입니다. 연결을 다시 등록하면 다른 배포가 못 읽게 됩니다',
  MALFORMED: '저장된 API 시크릿의 모양이 올바르지 않습니다 — 연결을 다시 등록해야 합니다',
  EMPTY: 'API 시크릿이 저장되어 있지 않습니다 — 연결을 다시 등록해야 합니다',
};

/**
 * 복호화하고 **왜 실패했는지까지** 돌려준다.
 *
 * **키 값도, 평문도 메시지에 담지 않는다.**
 */
export function decryptSecretResult(ciphertext: string): DecryptResult {
  const raw = String(ciphertext ?? '');
  if (!raw.trim()) {
    return { ok: false, code: 'EMPTY', value: '', message: DECRYPT_MESSAGE.EMPTY };
  }
  if (!isEncryptionConfigured()) {
    return { ok: false, code: 'NO_KEY', value: '', message: DECRYPT_MESSAGE.NO_KEY };
  }
  const [ivHex, tagHex, encHex] = raw.split(':');
  if (!ivHex || !tagHex || !encHex) {
    return { ok: false, code: 'MALFORMED', value: '', message: DECRYPT_MESSAGE.MALFORMED };
  }
  try {
    const key = getKey();
    const iv        = Buffer.from(ivHex, 'hex');
    const tag       = Buffer.from(tagHex, 'hex');
    const encrypted = Buffer.from(encHex, 'hex');
    const decipher  = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const out = decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
    // 복호화는 됐는데 평문이 비었다. 그건 저장이 잘못된 것이다.
    if (!out) return { ok: false, code: 'EMPTY', value: '', message: DECRYPT_MESSAGE.EMPTY };
    return { ok: true, code: 'OK', value: out, message: '' };
  } catch {
    // 모양이 맞는데 여기서 실패하면 **인증 태그가 안 맞는 것**이다 —
    // 즉 이 값을 만든 키가 아니다.
    return { ok: false, code: 'KEY_MISMATCH', value: '', message: DECRYPT_MESSAGE.KEY_MISMATCH };
  }
}

/**
 * Decrypt stored API secret — only called on server.
 *
 * **왜 실패했는지가 필요하면 `decryptSecretResult`를 쓴다.** 이 함수는
 * 빈 문자열만 돌려주므로, 그 값을 그대로 "비어 있습니다"로 옮기면
 * 고치라는 곳이 틀린 안내가 나간다.
 */
export function decryptSecret(ciphertext: string): string {
  return decryptSecretResult(ciphertext).value;
}

/** Mask key for display: first 4 + **** + last 4 */
export function maskKey(key: string): string {
  if (!key || key.length < 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

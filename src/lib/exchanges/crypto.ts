// ─────────────────────────────────────────────────────────────
// TRAIGO Exchange Crypto Utilities
// AES-256-GCM encryption for API secrets — server-side only
// ─────────────────────────────────────────────────────────────
import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'crypto';
import { fingerprintOf } from '../system/fingerprint';

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

/** Decrypt stored API secret — only called on server */
export function decryptSecret(ciphertext: string): string {
  try {
    const key = getKey();
    const [ivHex, tagHex, encHex] = ciphertext.split(':');
    if (!ivHex || !tagHex || !encHex) return '';
    const iv        = Buffer.from(ivHex, 'hex');
    const tag       = Buffer.from(tagHex, 'hex');
    const encrypted = Buffer.from(encHex, 'hex');
    const decipher  = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
  } catch { return ''; }
}

/**
 * 화면·응답·DB에 남길 **키 표시값.**
 *
 * ── 왜 앞 4 + 뒤 4를 버렸나 ──
 *
 *   예전 구현은 `key.slice(0, 4) + '****' + key.slice(-4)`였다. 값의
 *   **일부가 그대로** 응답으로 나가고 `api_key_masked` 컬럼에 저장됐다.
 *   이 저장소의 규칙은 "키·시크릿 값은 로그·응답·커밋 어디에도 남기지
 *   않는다. **지문만 비교한다**"다 — 앞뒤 4자는 그 규칙을 어긴다.
 *
 *   8자를 알면 되찾을 수 있냐고 물으면 아니다. 그런데 그 질문이 잘못됐다:
 *   유출 판단의 기준은 "복원 가능한가"가 아니라 "그 값의 일부를 우리가
 *   흘렸는가"다. 거래소 지원에 문의하거나 다른 유출과 교차 대조할 때
 *   앞뒤 4자는 **식별자로 충분히 쓸 수 있다.**
 *
 * ── 그래도 사용자는 자기 키를 구별해야 한다 ──
 *
 *   그래서 지문을 쓴다. 같은 키는 늘 같은 지문을 받으므로 "어느 키인가"는
 *   구별되고, 지문에서 값을 되찾을 수는 없다. 이 저장소가 이미 쓰는
 *   방식이다(`src/lib/system/fingerprint.ts`).
 */
export function maskKey(key: string): string {
  const fp = fingerprintOf(key);
  return fp ? `fp:${fp}` : '****';
}

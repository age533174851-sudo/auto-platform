// worker/src/crypto.ts — Vercel과 동일한 AES-256-GCM 복호화 (키 파생 동일)
import { createDecipheriv, createHmac } from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  // Vercel과 동일 파생. 값은 Vercel의 EXCHANGE_ENCRYPTION_KEY와 반드시 동일해야 함.
  // 보안: fallback 기본키를 두지 않는다. 키가 없으면 워커를 중단시킨다.
  const secret = process.env.EXCHANGE_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error(
      'EXCHANGE_ENCRYPTION_KEY가 없거나 32자 미만입니다. 거래소 secret을 복호화할 수 없어 워커를 중단합니다.'
    );
  }
  return Buffer.from(
    createHmac('sha256', 'traigo-key-derivation').update(secret).digest('hex').slice(0, 64),
    'hex',
  );
}

export function decryptSecret(ciphertext: string): string {
  try {
    const key = getKey();
    const [ivHex, tagHex, encHex] = (ciphertext || '').split(':');
    if (!ivHex || !tagHex || !encHex) return '';
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex')).toString('utf8') + decipher.final('utf8');
  } catch { return ''; }
}

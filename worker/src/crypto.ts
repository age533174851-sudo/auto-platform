// worker/src/crypto.ts — Vercel과 동일한 AES-256-GCM 복호화 (키 파생 동일)
import { createDecipheriv, createHmac } from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  // Vercel과 동일 파생. 값은 Vercel의 EXCHANGE_ENCRYPTION_KEY와 반드시 동일해야 함.
  const secret = process.env.EXCHANGE_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'traigo-fallback-key-change-in-prod!';
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

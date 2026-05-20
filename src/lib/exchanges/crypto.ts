// ─────────────────────────────────────────────────────────────
// TRAIGO Exchange Crypto Utilities
// AES-256-GCM encryption for API secrets — server-side only
// ─────────────────────────────────────────────────────────────
import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const secret = process.env.EXCHANGE_ENCRYPTION_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'traigo-fallback-key-change-in-prod!';
  // Derive a 32-byte key from whatever string we have
  return Buffer.from(
    createHmac('sha256', 'traigo-key-derivation').update(secret).digest('hex').slice(0, 64),
    'hex'
  );
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

/** Mask key for display: first 4 + **** + last 4 */
export function maskKey(key: string): string {
  if (!key || key.length < 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

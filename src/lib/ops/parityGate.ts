// src/lib/ops/parityGate.ts
//
// **웹과 워커가 다른 것을 보고 있으면 새 주문을 내지 않는다.**
//
// 판정은 secretParity.ts에 있다. 이 파일은 읽어 오기만 한다.
import { secretParity, type ParityReport } from './secretParity';
import { fingerprintOf } from '../system/fingerprint';
import { serverSupabaseUrl } from '../supabase/url';

export async function parityGate(sb: any): Promise<ParityReport> {
  let row: any = null;
  let present = false;
  try {
    const { data, error } = await (sb as any).from('worker_heartbeat')
      .select('supabase_fingerprint, encryption_fingerprint')
      .order('last_seen', { ascending: false }).limit(1).maybeSingle();
    if (!error && data) { row = data; present = true; }
    // 057 이전이거나 워커가 안 떴으면 present=false로 남는다.
    // **그 상태에서 막지 않는다** — 지문이 없다는 것은 값이 다르다는 뜻이 아니다.
  } catch { /* present=false */ }

  return secretParity({
    // **admin client가 고른 URL의 지문이어야 한다.** 여기서 따로
    // 고르면 "웹과 워커가 같은 DB"라고 적어 놓고 실제로는 다른 곳을
    // 읽는 상태가 만들어진다 — 실제로 그랬다.
    webSupabaseFp: serverSupabaseUrl().fingerprint,
    workerSupabaseFp: row?.supabase_fingerprint ?? null,
    webEncryptionFp: fingerprintOf(process.env.EXCHANGE_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || ''),
    workerEncryptionFp: row?.encryption_fingerprint ?? null,
    workerPresent: present,
  });
}

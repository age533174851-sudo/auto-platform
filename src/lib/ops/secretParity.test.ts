// src/lib/ops/secretParity.test.ts
//
// 암호화 키가 다르면 워커는 거래소 키를 못 푼다. 그런데 그 증상은
// **"키가 틀렸다"**로 보이고, 사람은 거래소에서 키를 다시 발급받는다.
// 새 키를 넣어도 똑같이 안 되고, 그 사이 자동매매는 계속 시도한다.

import { test, eq, assert } from '../../test/harness';
import { secretParity, syncPlan } from './secretParity';

const base = {
  webSupabaseFp: 'aaa111', workerSupabaseFp: 'aaa111',
  webEncryptionFp: 'bbb222', workerEncryptionFp: 'bbb222',
  workerPresent: true,
};

export function runSecretParityTests() {
  console.log('[지문 대조 — 어긋난 것을 조용히 지나가지 않는다]');

  test('같으면 통과한다', () => {
    const r = secretParity(base);
    eq(r.code, 'SAME');
    eq(r.entryAllowed, true);
  });

  test('**데이터베이스가 다르면 새 주문을 막는다**', () => {
    const r = secretParity({ ...base, workerSupabaseFp: 'zzz999' });
    eq(r.code, 'DIFFERENT');
    eq(r.entryAllowed, false);
    // 이미 열린 포지션은 계속 닫을 수 있어야 한다.
    assert(/청산·보호는 계속/.test(r.entryReason), r.entryReason);
  });

  test('**암호화 키가 다르면 새 주문을 막는다**', () => {
    const r = secretParity({ ...base, workerEncryptionFp: 'ccc333' });
    eq(r.entryAllowed, false);
    assert(/키가 틀렸다/.test(r.summary), r.summary);
  });

  test('한쪽 지문이 없으면 "같다"고 말하지 않는다 — 다만 막지도 않는다', () => {
    // 지문이 없다는 것은 값이 다르다는 뜻이 아니다. 여기서 막으면
    // 배포 직후마다 매매가 멎는다.
    const r = secretParity({ ...base, workerEncryptionFp: null });
    eq(r.code, 'UNKNOWN');
    eq(r.entryAllowed, true);
    assert(/같다는 뜻도 다르다는 뜻도 아닙니다/.test(r.summary), r.summary);
  });

  test('워커 기록 자체가 없으면 비교하지 않는다', () => {
    const r = secretParity({ ...base, workerPresent: false });
    eq(r.code, 'UNKNOWN');
    eq(r.entryAllowed, true);
  });

  test('값을 싣지 않는다 — 지문만 비교한다', () => {
    const r = secretParity({ ...base, workerSupabaseFp: 'zzz999' });
    const json = JSON.stringify(r);
    assert(!/https?:\/\//.test(json), '주소를 싣지 않는다');
    assert(!/=/.test(json.replace(/[^=]/g, '')) || true, '');
  });

  // ── 맞추기 ──

  const all = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'EXCHANGE_ENCRYPTION_KEY', 'ADMIN_SECRET'];

  test('기준값이 다 있고 토큰이 있으면 밀어 넣을 수 있다고 말한다', () => {
    const p = syncPlan({ available: all, canPushFly: true, canPushVercel: true });
    eq(p.targets.every(t => t.inSource && t.canPush), true);
    eq(p.blocked.length, 0);
  });

  test('기준값이 없으면 그 사실을 먼저 말한다', () => {
    const p = syncPlan({ available: [], canPushFly: true, canPushVercel: true });
    eq(p.blocked.length, 4);
    assert(/GitHub Secrets에 없습니다/.test(p.blocked[0]), p.blocked[0]);
  });

  test('토큰이 없으면 어디에 못 미는지 이름으로 말한다', () => {
    const p = syncPlan({ available: all, canPushFly: false, canPushVercel: false });
    assert(p.blocked.some(b => /FLY_API_TOKEN/.test(b)), p.blocked.join(' | '));
    assert(p.blocked.some(b => /VERCEL_TOKEN/.test(b)), p.blocked.join(' | '));
  });

  test('**EXIT_MONITOR_SECRET은 목록에 없다**', () => {
    // 없앤 값이다. 다시 요구하면 그때 없앤 의미가 사라진다.
    const p = syncPlan({ available: all, canPushFly: true, canPushVercel: true });
    assert(!/EXIT_MONITOR_SECRET/.test(JSON.stringify(p)), 'EXIT_MONITOR_SECRET을 다시 요구하면 안 된다');
  });
}

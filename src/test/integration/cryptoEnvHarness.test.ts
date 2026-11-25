// src/test/integration/cryptoEnvHarness.test.ts
//
// **시험 하네스가 암호키를 스스로 공급하는지 본다.**
//
// 왜 이 시험이 필요한가
// ─────────────────────
// `withCryptoEnv()`는 오랫동안 `ENCRYPTION_KEY`만 넣었다. 그런데
// `crypto.ts:getKey()`가 읽는 이름은 **`EXCHANGE_ENCRYPTION_KEY`**다.
// 접두사가 달라서 호출부는 "키를 넣었다"고 믿고 `encryptSecret`은
// 키 없이 돌았다 — **조용한 빈 동작**이었다.
//
// 그런데도 묶음은 초록이었다. `src/lib/exchanges/connection.test.ts`가
// `EXCHANGE_ENCRYPTION_KEY`를 설정하고 **원복하지 않아서**, 그 뒤에 도는
// 통합시험들이 그 유출된 키를 주워 썼다. 즉 암호화가 **시험 순서에
// 매달려** 있었다. 그 파일을 고치거나 러너 순서가 바뀌면 열 몇 개가
// 한꺼번에 "EXCHANGE_ENCRYPTION_KEY가 설정되지 않았거나 너무
// 짧습니다"로 깨진다.
//
// 그래서 이 시험은 **남이 흘린 키를 먼저 치운다.** 치우지 않으면
// `withCryptoEnv`가 또 틀린 이름을 넣어도 통과한다 — 그러면 이 시험은
// 아무것도 지키지 않는다.
import { test, eq, assert } from '../harness';
import { withCryptoEnv } from './venueHarness';
import { encryptSecret, decryptSecret, isEncryptionConfigured } from '../../lib/exchanges/crypto';

/** 다른 시험이 흘린 키를 치우고 돌린 뒤 정확히 되돌린다 */
function withoutLeakedKey<T>(body: () => T): T {
  const leaked = process.env.EXCHANGE_ENCRYPTION_KEY;
  const leakedPlain = process.env.ENCRYPTION_KEY;
  delete process.env.EXCHANGE_ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  try {
    return body();
  } finally {
    if (leaked === undefined) delete process.env.EXCHANGE_ENCRYPTION_KEY;
    else process.env.EXCHANGE_ENCRYPTION_KEY = leaked;
    if (leakedPlain === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = leakedPlain;
  }
}

export function runCryptoEnvHarnessTests() {
  console.log('[시험 하네스 — 암호키는 스스로 공급한다]');

  test('★ 흘린 키를 치우면 withCryptoEnv 없이는 암호화가 실패한다 (이 시험의 전제)', () => {
    withoutLeakedKey(() => {
      eq(isEncryptionConfigured(), false, '키를 치웠는데 설정됐다고 답한다');
      let threw = '';
      try { encryptSecret('X'); } catch (e: any) { threw = String(e?.message || e); }
      assert(threw.includes('EXCHANGE_ENCRYPTION_KEY'),
        '키 없이 암호화가 성공했다 — 이 시험이 아무것도 지키지 않는다: ' + threw);
    });
  });

  test('★ withCryptoEnv가 crypto.ts가 읽는 이름을 실제로 채운다 (왕복까지)', () => {
    withoutLeakedKey(() => {
      const un = withCryptoEnv();
      try {
        eq(isEncryptionConfigured(), true, 'withCryptoEnv 뒤에도 키가 없다 — 이름이 틀렸다');
        const enc = encryptSecret('SECRET-ROUNDTRIP');
        eq(decryptSecret(enc), 'SECRET-ROUNDTRIP', '암호화는 됐는데 복호화가 안 된다');
      } finally { un(); }
    });
  });

  test('★ 지문 비교용 대체 이름도 같이 채운다 — parityGate가 "키 없음"을 보지 않는다', () => {
    withoutLeakedKey(() => {
      const un = withCryptoEnv();
      try {
        assert((process.env.ENCRYPTION_KEY ?? '').length >= 32,
          'ENCRYPTION_KEY를 지우면 parityGate·runtime-health가 키 없음을 본다');
      } finally { un(); }
    });
  });

  test('★ 벗으면 둘 다 원래대로 — 뒤에 도는 시험에 키를 흘리지 않는다', () => {
    withoutLeakedKey(() => {
      const un = withCryptoEnv();
      un();
      eq(process.env.EXCHANGE_ENCRYPTION_KEY, undefined, 'EXCHANGE_ENCRYPTION_KEY를 흘렸다');
      eq(process.env.ENCRYPTION_KEY, undefined, 'ENCRYPTION_KEY를 흘렸다');
    });
  });

  test('★ 원래 값이 있었으면 그 값으로 되돌린다 (지우지 않는다)', () => {
    const prev = process.env.EXCHANGE_ENCRYPTION_KEY;
    process.env.EXCHANGE_ENCRYPTION_KEY = 'z'.repeat(40);
    try {
      const un = withCryptoEnv();
      un();
      eq(process.env.EXCHANGE_ENCRYPTION_KEY, 'z'.repeat(40), '원래 값을 지웠다');
    } finally {
      if (prev === undefined) delete process.env.EXCHANGE_ENCRYPTION_KEY;
      else process.env.EXCHANGE_ENCRYPTION_KEY = prev;
    }
  });
}

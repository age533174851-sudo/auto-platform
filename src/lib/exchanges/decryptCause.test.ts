// src/lib/exchanges/decryptCause.test.ts
//
// **네 가지 원인이 빈 문자열 하나로 뭉개져 있었다.**
//
//   이 배포에 암호화 키가 없다  (NO_KEY)
//   키가 있는데 다른 키다        (KEY_MISMATCH)
//   저장된 모양이 깨졌다         (MALFORMED)
//   정말로 비어 있다             (EMPTY)
//
// 전부 `decryptSecret()`이 `''`를 돌려주고, 화면은
// **"API 시크릿이 비어 있습니다. 연결을 다시 등록하세요."**라고 적었다.
//
// 앞의 둘일 때 그 말을 따르면 **더 나빠진다** — 그 배포의 키로 다시
// 암호화한 값이 저장되고, 원래 키를 쓰는 배포(운영)가 그 값을 못 읽는다.
// **고치라는 곳이 틀린 안내는 안내가 없는 것보다 나쁘다.**
import { test, eq, assert } from '../../test/harness';
import { decryptSecretResult, encryptSecret } from './crypto';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

function withKey<T>(k: string | undefined, fn: () => T): T {
  const before = process.env.EXCHANGE_ENCRYPTION_KEY;
  if (k === undefined) delete process.env.EXCHANGE_ENCRYPTION_KEY;
  else process.env.EXCHANGE_ENCRYPTION_KEY = k;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.EXCHANGE_ENCRYPTION_KEY;
    else process.env.EXCHANGE_ENCRYPTION_KEY = before;
  }
}

export function runDecryptCauseTests() {
  console.log('[복호화 실패 — 왜 실패했는지까지 말한다]');

  test('제대로 된 값은 그대로 돌아온다', () => {
    withKey(KEY_A, () => {
      const enc = encryptSecret('super-secret-value');
      const r = decryptSecretResult(enc);
      eq(r.ok, true, r.message);
      eq(r.code, 'OK');
      eq(r.value, 'super-secret-value');
    });
  });

  test('이 배포에 키가 없는 것을 "비어 있다"로 적지 않는다', () => {
    const enc = withKey(KEY_A, () => encryptSecret('x'));
    withKey(undefined, () => {
      const r = decryptSecretResult(enc);
      eq(r.code, 'NO_KEY', '키 없음을 다른 원인으로 읽었다');
      assert(!/다시 등록해야 합니다|다시 등록하세요/.test(r.message),
        `재등록하라고 안내했다 — 그러면 운영이 못 읽는다: ${r.message}`);
      assert(r.message.includes('다시 등록하지 마세요'), r.message);
    });
  });

  test('키가 다른 것을 "비어 있다"로 적지 않는다', () => {
    const enc = withKey(KEY_A, () => encryptSecret('x'));
    withKey(KEY_B, () => {
      const r = decryptSecretResult(enc);
      eq(r.code, 'KEY_MISMATCH', '키 불일치를 다른 원인으로 읽었다');
      assert(!/다시 등록해야 합니다|다시 등록하세요/.test(r.message), r.message);
      assert(r.message.includes('키를 맞추는 것이 먼저'), r.message);
    });
  });

  test('저장된 모양이 깨진 것은 재등록이 맞다', () => {
    withKey(KEY_A, () => {
      const r = decryptSecretResult('not-a-valid-shape');
      eq(r.code, 'MALFORMED');
      assert(r.message.includes('다시 등록'), r.message);
    });
  });

  test('정말 비어 있는 것도 재등록이 맞다', () => {
    withKey(KEY_A, () => {
      eq(decryptSecretResult('').code, 'EMPTY');
      eq(decryptSecretResult('   ').code, 'EMPTY');
    });
  });

  test('빈 값은 키가 없어도 EMPTY다', () => {
    // 저장된 것이 없으면 키 이야기를 꺼낼 필요가 없다.
    withKey(undefined, () => eq(decryptSecretResult('').code, 'EMPTY'));
  });

  test('실패한 결과에는 값이 없다', () => {
    const enc = withKey(KEY_A, () => encryptSecret('x'));
    withKey(KEY_B, () => eq(decryptSecretResult(enc).value, ''));
  });

  test('키 값도 평문도 메시지에 담지 않는다', () => {
    const enc = withKey(KEY_A, () => encryptSecret('PLAINTEXT-SECRET'));
    withKey(KEY_B, () => {
      const m = decryptSecretResult(enc).message;
      assert(!m.includes(KEY_A) && !m.includes(KEY_B), '키가 메시지에 실렸다');
      assert(!m.includes('PLAINTEXT-SECRET'), '평문이 메시지에 실렸다');
    });
  });

  test('네 원인이 서로 다른 코드다', () => {
    // 하나라도 겹치면 화면이 다시 뭉갠다.
    const enc = withKey(KEY_A, () => encryptSecret('x'));
    const codes = [
      withKey(undefined, () => decryptSecretResult(enc).code),
      withKey(KEY_B, () => decryptSecretResult(enc).code),
      withKey(KEY_A, () => decryptSecretResult('broken').code),
      withKey(KEY_A, () => decryptSecretResult('').code),
    ];
    eq(new Set(codes).size, 4, `겹친 코드: ${codes.join(', ')}`);
  });
}

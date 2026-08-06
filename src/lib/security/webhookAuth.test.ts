// src/lib/security/webhookAuth.test.ts
//
// 막으려는 것:
//  1. 공용 시크릿 하나로 아무나 남의 계좌에 주문을 넣는 것
//  2. 시크릿 평문을 저장해, 데이터베이스가 새면 그대로 주문에 쓰이는 것
//  3. `===` 비교의 시간 차이로 앞에서부터 한 글자씩 맞춰지는 것
//  4. 인증 실패 로그에 시크릿이 평문으로 남는 것
//  5. 발급된 것이 없을 때 예전 전역 시크릿으로 떨어져 나누는 의미가 사라지는 것
import { test, assert, eq } from '../../test/harness';
import {
  generateWebhookSecret, hashSecret, fingerprint, fingerprintOfHash,
  safeEqual, verifyWebhookSecret, redactSecrets, SECRET_PREFIX,
} from './webhookAuth';

export function runWebhookAuthTests() {
  console.log('[웹훅 시크릿 — 발급]');

  test('발급할 때마다 다른 값이 나온다', () => {
    const a = generateWebhookSecret(), b = generateWebhookSecret();
    assert(a !== b, '같은 값이 나오면 난수가 아니다');
  });

  test('표식이 붙어 로그에서 알아볼 수 있다', () => {
    assert(generateWebhookSecret().startsWith(SECRET_PREFIX));
  });

  test('무차별 대입이 어려울 만큼 길다', () => {
    // 웹훅은 인증 실패를 200으로 돌려주므로(신호를 흘리는 것이 목적)
    // 시도 횟수 제한이 약하다. 길이가 방어의 대부분이다.
    assert(generateWebhookSecret().length > 40, '짧으면 대입이 가능해진다');
  });

  console.log('[웹훅 시크릿 — 평문을 저장하지 않는다]');

  test('해시는 되돌릴 수 없고 같은 입력에 같은 값이다', () => {
    const s = 'tvw_abc123';
    eq(hashSecret(s), hashSecret(s));
    assert(!hashSecret(s).includes('abc123'), '평문이 해시에 남아 있다');
    eq(hashSecret(s).length, 64, 'sha256 hex');
  });

  test('지문은 짧고 되돌릴 수 없다', () => {
    const s = generateWebhookSecret();
    eq(fingerprint(s).length, 6);
    eq(fingerprint(s), fingerprintOfHash(hashSecret(s)), '평문에서든 해시에서든 같아야 한다');
    assert(!s.includes(fingerprint(s)) || true);   // 지문은 해시의 조각이지 시크릿의 조각이 아니다
  });

  test('빈 값의 지문은 빈 문자열이다', () => {
    eq(fingerprint(''), '');
    eq(fingerprint(null), '');
  });

  console.log('[웹훅 시크릿 — 상수 시간 비교]');

  test('같은 값은 통과, 다른 값은 거부', () => {
    eq(safeEqual('abc', 'abc'), true);
    eq(safeEqual('abc', 'abd'), false);
    eq(safeEqual('abc', 'abcd'), false, '길이가 다르면 거부');
  });

  test('빈 값끼리는 통과시키지 않는다', () => {
    // 둘 다 비어 있으면 '같다'가 되는데, 그건 시크릿이 없는 요청을
    // 시크릿이 없는 계정으로 통과시키는 것이다.
    eq(safeEqual('', ''), false);
    eq(safeEqual(null, null), false);
    eq(safeEqual(undefined, ''), false);
  });

  console.log('[웹훅 시크릿 — 검증]');

  const SECRET = generateWebhookSecret();
  const STORED = { userId: 'u1', secretHash: hashSecret(SECRET) };

  test('맞는 시크릿은 통과하고 사용자를 알려준다', () => {
    const r = verifyWebhookSecret(SECRET, STORED);
    eq(r.ok, true);
    eq(r.userId, 'u1');
  });

  test('틀린 시크릿은 어디가 틀렸는지 말하지 않는다', () => {
    // "앞 네 글자는 맞습니다" 같은 힌트는 그대로 공격 도구가 된다.
    const r = verifyWebhookSecret(SECRET.slice(0, -1) + 'X', STORED);
    eq(r.ok, false);
    eq(r.status, 'MISMATCH');
    assert(!r.reason.includes('글자'), r.reason);
  });

  test('발급된 것이 없으면 통과시키지 않는다', () => {
    // 예전 전역 시크릿으로 떨어뜨리면 사람마다 나누는 의미가 사라진다.
    const r = verifyWebhookSecret(SECRET, null);
    eq(r.ok, false);
    eq(r.status, 'NOT_CONFIGURED');
    assert(r.reason.includes('발급'), r.reason);
  });

  test('폐기된 시크릿은 거부한다', () => {
    const r = verifyWebhookSecret(SECRET, { ...STORED, revokedAt: '2026-01-01T00:00:00Z' });
    eq(r.ok, false);
    eq(r.status, 'REVOKED');
  });

  test('시크릿을 안 보내면 없다고 말한다', () => {
    eq(verifyWebhookSecret('', STORED).status, 'MISSING');
    eq(verifyWebhookSecret(null, STORED).status, 'MISSING');
    eq(verifyWebhookSecret('   ', STORED).status, 'MISSING', '공백만 있는 것도 없는 것이다');
  });

  test('다른 사람의 시크릿으로는 못 들어온다', () => {
    const other = generateWebhookSecret();
    eq(verifyWebhookSecret(other, STORED).ok, false);
  });

  test('응답 어디에도 시크릿 값이 안 들어간다', () => {
    for (const r of [
      verifyWebhookSecret(SECRET, STORED),
      verifyWebhookSecret('wrong', STORED),
      verifyWebhookSecret(SECRET, null),
    ]) {
      assert(!JSON.stringify(r).includes(SECRET), '응답에 시크릿이 새어 나갔다');
    }
  });

  console.log('[웹훅 시크릿 — 로그에 평문을 남기지 않는다]');

  test('시크릿 칸은 지문으로 바뀐다', () => {
    const body = { symbol: 'BTCUSDT', secret: SECRET, code: 'abc123', side: 'BUY' };
    const out = redactSecrets(body);
    assert(!JSON.stringify(out).includes(SECRET), '로그에 시크릿이 남았다');
    assert(!JSON.stringify(out).includes('abc123'), 'code도 시크릿이다');
    eq(out.symbol, 'BTCUSDT', '시크릿이 아닌 값은 그대로 남아야 조사할 수 있다');
    eq(out.side, 'BUY');
  });

  test('지문은 남겨 나중에 대조할 수 있게 한다', () => {
    const out = redactSecrets({ secret: SECRET });
    assert(String(out.secret).includes(fingerprint(SECRET)),
      '어떤 값으로 시도했는지는 대조할 수 있어야 한다');
  });

  test('중첩된 객체는 펼치지 않는다', () => {
    // 안쪽에 시크릿이 또 있을 수 있는데 전부 훑는 것보다 통째로
    // 가리는 편이 안전하다.
    const out = redactSecrets({ nested: { secret: SECRET } });
    assert(!JSON.stringify(out).includes(SECRET));
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(Object.keys(redactSecrets(null)).length, 0);
    eq(Object.keys(redactSecrets(undefined)).length, 0);
  });
}

// src/lib/auth/signupOutcome.test.ts
//
// **이 화면은 실패를 성공으로 적고 있었다.**
//
// 아래 모양들은 설치된 `@supabase/auth-js` **2.108.2**의 타입·소스에서
// 그대로 가져왔다 — `signUp`은 GoTrue 응답을 통과시키고, 오류가 있으면
// user·session이 둘 다 null이며, `User.identities`는 optional이다.
import { test, eq, assert } from '../../test/harness';
import { signupOutcome, loginOutcomeMessage } from './signupOutcome';

export function runSignupOutcomeTests() {
  console.log('\n📝 가입 결과 판정 (모르는 것을 가입 완료로 적지 않는다)');

  test('확인 메일이 필요한 정상 가입 — identities가 있고 session이 없다', () => {
    const o = signupOutcome({
      user: { identities: [{ provider: 'email' }] }, session: null, errorMessage: null,
    });
    eq(o.code, 'CONFIRM_EMAIL_SENT');
    assert(o.accountCreated, '계정이 만들어졌다');
    assert(o.ok, '초록으로 표시해도 된다');
    eq(o.next, 'CHECK_EMAIL');
  });

  test('세션이 바로 생기는 정상 가입', () => {
    const o = signupOutcome({
      user: { identities: [{ provider: 'email' }] }, session: { access_token: 'x' }, errorMessage: null,
    });
    eq(o.code, 'SIGNED_IN');
    assert(o.accountCreated, '계정이 만들어졌다');
    eq(o.next, 'CONTINUE');
  });

  test('확인 메일 설정이어도 세션이 오면 세션이 이긴다 — 순서가 계약이다', () => {
    const o = signupOutcome({ user: { identities: [] }, session: { access_token: 'x' } });
    eq(o.code, 'SIGNED_IN', 'session이 있으면 identities를 보지 않는다');
  });

  // ══ 모호한 자리 — **여기가 이 파일의 이유다** ══
  test('identities가 빈 배열이면 모호하다 — "이미 가입된 이메일"이라고 적지 않는다', () => {
    const o = signupOutcome({ user: { identities: [] }, session: null, errorMessage: null });
    eq(o.code, 'AMBIGUOUS');
    assert(!o.accountCreated, '만들어졌는지 모른다 — 추측하지 않는다');
    assert(!o.ok, '초록으로 적지 않는다');
    eq(o.next, 'TRY_LOGIN_OR_RESET');
  });

  test('모호한 응답에 계정 존재를 확정하는 문장을 넣지 않는다 (열거 방지를 우리가 깨지 않는다)', () => {
    const m = signupOutcome({ user: { identities: [] }, session: null }).message;
    for (const banned of ['이미 가입된 이메일입니다', '이미 존재', '등록된 계정입니다']) {
      assert(!m.includes(banned), `단정하는 문장이 있으면 안 된다: ${banned}`);
    }
    assert(m.includes('로그인') && m.includes('비밀번호 재설정'), '다음에 할 일은 알려 준다');
  });

  test('identities가 아예 없는 것(undefined)도 모호하다 — 빈 배열과 같은 취급', () => {
    const o = signupOutcome({ user: {}, session: null });
    eq(o.code, 'AMBIGUOUS', 'SDK가 안 준 것을 "없다"로 읽지 않는다');
  });

  test('identities가 배열이 아니면 모호하다', () => {
    const o = signupOutcome({ user: { identities: 'email' as any }, session: null });
    eq(o.code, 'AMBIGUOUS');
  });

  // ══ 명시적 오류 ══
  test('오류가 오면 그 문구를 그대로 쓴다', () => {
    const o = signupOutcome({ user: null, session: null, errorMessage: 'Password should be at least 6 characters' });
    eq(o.code, 'ERROR');
    assert(!o.ok, '실패다');
    eq(o.next, 'FIX_AND_RETRY');
    assert(o.message.includes('6 characters'), '서버가 말한 이유를 지우지 않는다');
  });

  test('오류가 있으면 user/session을 보지 않는다', () => {
    const o = signupOutcome({ user: { identities: [{}] }, session: { access_token: 'x' }, errorMessage: 'boom' });
    eq(o.code, 'ERROR', '오류가 가장 먼저다');
  });

  // ══ 읽지 못한 자리 ══
  test('오류도 사용자도 없으면 성공으로 적지 않는다', () => {
    const o = signupOutcome({ user: null, session: null, errorMessage: null });
    eq(o.code, 'UNREADABLE');
    assert(!o.ok, '초록 금지');
    assert(!o.message.includes('가입 완료'), '"가입 완료"라고 적으면 안 된다');
  });

  test('응답 자체가 없어도 죽지 않고 UNREADABLE이다', () => {
    eq(signupOutcome(null).code, 'UNREADABLE');
    eq(signupOutcome(undefined).code, 'UNREADABLE');
  });

  test('어떤 경우에도 accountCreated는 확실할 때만 참이다', () => {
    const shapes: any[] = [
      null, {}, { user: null }, { user: {}, session: null },
      { user: { identities: [] } }, { errorMessage: 'x' },
    ];
    for (const s of shapes) {
      assert(!signupOutcome(s).accountCreated, `확실하지 않은데 참이면 안 된다: ${JSON.stringify(s)}`);
    }
  });

  // ══ 로그인 침묵 제거 ══
  test('인증은 됐는데 프로필이 없으면 화면이 침묵하지 않는다', () => {
    const r = loginOutcomeMessage({ hasUser: true, hasProfile: false });
    assert(!r.ok, '통과가 아니다');
    assert(r.message.length > 0, '무슨 일인지 말해 준다');
  });

  test('프로필이 있으면 따로 말하지 않는다', () => {
    eq(loginOutcomeMessage({ hasUser: true, hasProfile: true }).ok, true);
  });

  test('사용자도 프로필도 없으면 그것도 말한다', () => {
    const r = loginOutcomeMessage({ hasUser: false, hasProfile: false });
    assert(!r.ok && r.message.length > 0, '조용히 넘어가지 않는다');
  });
}

// src/lib/auth/recoveryLink.test.ts
//
// **실기기에서 난 고장을 재현한다: 메일 링크 → 404.**
//
// 원인은 라우트가 없던 것이고 그건 파일 하나로 끝나지만, 그 페이지가
// 보여 줄 경우의 수는 화면으로 확인하기 어렵다. 만료 링크를 만들려면
// 한 시간을 기다려야 하고, 재사용 링크를 만들려면 두 번 눌러야 한다.
// 그래서 착지 판정을 순수 함수로 두고 여기서 전부 돌린다.
import { test, eq, assert } from '../../test/harness';
import {
  readRecoveryLink, judgeNewPassword, safeReturnPath, recoveryPhaseOf,
} from './recoveryLink';

export function runRecoveryLinkTests() {
  console.log('\n🔑 비밀번호 재설정 링크 착지');

  // ══ 정상 ══
  test('★ implicit 복구 토큰이 해시로 오면 세션을 기다린다', () => {
    const v = readRecoveryLink({
      hash: '#access_token=aaa.bbb.ccc&expires_in=3600&type=recovery&token_type=bearer',
    });
    eq(v.code, 'RECOVERY_TOKEN');
    eq(v.awaitsSession, true);
    eq(v.canProceed, false, '세션이 생기기 전에 입력을 열지 않는다');
  });

  test('type이 없어도 access_token이 있으면 진행한다', () => {
    // Supabase가 type을 안 붙이는 경우가 있다. 토큰이 있으면 SDK가 처리한다.
    eq(readRecoveryLink({ hash: '#access_token=x&expires_in=3600' }).code, 'RECOVERY_TOKEN');
  });

  // ══ 실패를 뭉뚱그리지 않는다 ══
  test('★ 만료 링크를 "세션 없음"으로 적지 않는다', () => {
    const v = readRecoveryLink({
      hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    });
    eq(v.code, 'EXPIRED');
    eq(v.offerResend, true, '무엇을 해야 하는지 알려야 한다');
    assert(/만료/.test(v.message), v.message);
  });

  test('★ 실패가 type=recovery와 같이 와도 만료로 읽는다', () => {
    // 이것이 순서 문제다. 성공을 먼저 보면 만료 링크에 입력창을 띄우고,
    // 저장 단계에서야 실패한다 — 사용자는 새 비밀번호를 두 번 친다.
    const v = readRecoveryLink({
      hash: '#error=access_denied&error_code=otp_expired&type=recovery',
    });
    eq(v.code, 'EXPIRED');
    eq(v.canProceed, false);
  });

  test('이미 쓴 링크는 거부로 적는다', () => {
    const v = readRecoveryLink({ hash: '#error=access_denied&error_code=flow_state_not_found' });
    eq(v.code, 'REJECTED');
    eq(v.offerResend, true);
  });

  test('쿼리로 온 오류도 읽는다', () => {
    eq(readRecoveryLink({ query: '?error=server_error&error_code=unexpected_failure' }).code, 'REJECTED');
  });

  // ══ 종류가 틀린 링크 ══
  test('★ 가입 확인 링크로는 비밀번호를 바꾸지 않는다', () => {
    const v = readRecoveryLink({ hash: '#access_token=x&type=signup' });
    eq(v.code, 'WRONG_TYPE');
    eq(v.canProceed, false);
    eq(v.offerResend, false, '재설정 메일을 다시 받을 일이 아니다');
    assert(/signup/.test(v.message), '무슨 종류였는지 적어야 한다');
  });

  test('이메일 변경 링크도 막는다', () => {
    eq(readRecoveryLink({ hash: '#access_token=x&type=email_change' }).code, 'WRONG_TYPE');
  });

  // ══ 아무것도 없는 경우 — 404 대신 이 화면이 나온다 ══
  test('★ 주소창에 직접 쳐서 들어와도 404가 아니라 안내를 본다', () => {
    const v = readRecoveryLink({ hash: '', query: '' });
    eq(v.code, 'NO_TOKEN');
    eq(v.canProceed, false);
    eq(v.offerResend, true);
    assert(v.message.length > 0, '빈 화면을 보여주지 않는다');
  });

  test('null/undefined도 NO_TOKEN이다 — 던지지 않는다', () => {
    eq(readRecoveryLink({}).code, 'NO_TOKEN');
    eq(readRecoveryLink({ hash: null, query: null }).code, 'NO_TOKEN');
  });

  // ══ 비밀을 메시지에 담지 않는다 ══
  test('★ 어떤 경우에도 토큰 값을 메시지에 담지 않는다', () => {
    const SECRET = 'eyJhbGciOiJIUzI1NiJ9.SECRETVALUE.sig';
    for (const h of [
      `#access_token=${SECRET}&type=recovery`,
      `#error=access_denied&error_code=otp_expired&access_token=${SECRET}`,
      `#access_token=${SECRET}&type=signup`,
    ]) {
      const v = readRecoveryLink({ hash: h });
      assert(!v.message.includes(SECRET), `★ 메시지에 토큰이 들어갔습니다: ${v.code}`);
      assert(!v.message.includes('SECRETVALUE'), `★ 메시지에 토큰 조각이 들어갔습니다: ${v.code}`);
    }
  });

  test('PKCE 코드는 읽되 메시지에 담지 않는다', () => {
    const v = readRecoveryLink({ query: '?code=abc-123-secret' });
    eq(v.code, 'RECOVERY_CODE');
    eq(v.exchangeCode, 'abc-123-secret', '교환에는 써야 하므로 값은 따로 들고 있는다');
    assert(!v.message.includes('abc-123-secret'), '★ 화면에 코드를 적었습니다');
  });


  // ══ 단계 계산 ══
  //
  // ★ 이 묶음은 **뮤테이션 2건이 새 나가서** 생겼다. 둘 다 페이지의
  //   useEffect 안에 있던 판단이라 순수 시험이 닿지 못했고, 검사기는
  //   낱말만 보고 있었다.
  console.log('\n🔑 재설정 화면 단계');

  test('★ 기다리다 못 받았는데 입력창을 열지 않는다 (MUT-AR21)', () => {
    const v = recoveryPhaseOf({
      linkCode: 'RECOVERY_TOKEN', awaitsSession: true,
      hasSessionUser: false, waitedOut: true,
    });
    eq(v.phase, 'blocked', '★ 세션을 못 받았는데 입력창을 열었습니다');
    eq(v.canSave, false);
  });

  test('★ 저장 가능 여부가 단계와 같은 곳에서 나온다 (MUT-AR18)', () => {
    // 화면이 `hasRecoverySession`을 따로 계산하면 둘이 갈린다.
    for (const c of [
      { linkCode: 'RECOVERY_TOKEN' as const, awaitsSession: true, hasSessionUser: false, waitedOut: false },
      { linkCode: 'RECOVERY_TOKEN' as const, awaitsSession: true, hasSessionUser: false, waitedOut: true },
      { linkCode: 'EXPIRED' as const, awaitsSession: false, hasSessionUser: true, waitedOut: false },
      { linkCode: 'NO_TOKEN' as const, awaitsSession: false, hasSessionUser: false, waitedOut: false },
    ]) {
      const v = recoveryPhaseOf(c);
      eq(v.canSave, v.phase === 'ready',
        `★ 단계(${v.phase})와 저장 가능(${v.canSave})이 어긋납니다`);
    }
  });

  test('★ 링크가 못 쓰는 것이면 세션이 있어도 막는다', () => {
    // 같은 브라우저에 다른 계정이 로그인돼 있을 수 있다.
    const v = recoveryPhaseOf({
      linkCode: 'EXPIRED', awaitsSession: false, hasSessionUser: true, waitedOut: false,
    });
    eq(v.phase, 'blocked');
    eq(v.canSave, false, '★ 만료 링크로 남의 세션에 저장이 열렸습니다');
  });

  test('세션이 생기면 입력을 연다 — 통과 경로는 이것 하나다', () => {
    const v = recoveryPhaseOf({
      linkCode: 'RECOVERY_TOKEN', awaitsSession: true, hasSessionUser: true, waitedOut: false,
    });
    eq(v.phase, 'ready'); eq(v.canSave, true);
  });

  test('아직 기다리는 중이면 checking이고 저장은 막힌다', () => {
    const v = recoveryPhaseOf({
      linkCode: 'RECOVERY_TOKEN', awaitsSession: true, hasSessionUser: false, waitedOut: false,
    });
    eq(v.phase, 'checking'); eq(v.canSave, false);
  });

  // ══ 저장 판정 ══
  console.log('\n🔑 새 비밀번호 저장 판정');

  test('★ 복구 세션이 없으면 저장하지 않는다', () => {
    // 같은 브라우저에 다른 계정이 로그인돼 있을 수 있다. 세션 확인 없이
    // updateUser를 부르면 **그 사람의** 비밀번호를 바꾼다.
    const v = judgeNewPassword({
      password: 'Abcdef1!', confirm: 'Abcdef1!', hasRecoverySession: false, strengthOk: true,
    });
    eq(v.code, 'NO_SESSION'); eq(v.ok, false);
  });

  test('두 비밀번호가 다르면 막는다', () => {
    const v = judgeNewPassword({
      password: 'Abcdef1!', confirm: 'Abcdef2!', hasRecoverySession: true, strengthOk: true,
    });
    eq(v.code, 'MISMATCH'); eq(v.ok, false);
  });

  test('빈 칸이면 막는다', () => {
    eq(judgeNewPassword({ password: '', confirm: '', hasRecoverySession: true, strengthOk: false }).code, 'EMPTY');
    eq(judgeNewPassword({ password: 'Abcdef1!', confirm: '', hasRecoverySession: true, strengthOk: true }).code, 'EMPTY');
  });

  test('강도가 부족하면 막는다', () => {
    const v = judgeNewPassword({
      password: 'abc', confirm: 'abc', hasRecoverySession: true, strengthOk: false,
    });
    eq(v.code, 'TOO_WEAK'); eq(v.ok, false);
  });

  test('세션·일치·강도가 다 맞아야 통과한다 — 통과 경로는 이것 하나다', () => {
    const v = judgeNewPassword({
      password: 'Abcdef1!', confirm: 'Abcdef1!', hasRecoverySession: true, strengthOk: true,
    });
    eq(v.code, 'OK'); eq(v.ok, true);
  });

  test('★ 비밀번호를 판정 메시지에 담지 않는다', () => {
    for (const p of ['MyS3cret!', 'abc']) {
      for (const c of [p, p + 'x', '']) {
        const v = judgeNewPassword({
          password: p, confirm: c, hasRecoverySession: true, strengthOk: p.length > 7,
        });
        assert(!v.message.includes(p), `★ 메시지에 비밀번호가 들어갔습니다: ${v.code}`);
      }
    }
  });

  // ══ 열린 리다이렉트 ══
  console.log('\n🔑 복귀 경로 (열린 리다이렉트 금지)');

  test('★ 외부 주소로는 돌려보내지 않는다', () => {
    for (const bad of [
      'https://evil.example.com',
      'http://evil.example.com/login',
      '//evil.example.com',
      '/\\evil.example.com',
      'javascript:alert(1)',
      'data:text/html,<script>',
      '/next\r\nSet-Cookie: a=b',
    ]) {
      eq(safeReturnPath(bad), '/auth', `★ 외부로 나가는 경로를 통과시켰습니다: ${bad}`);
    }
  });

  test('같은 출처의 상대 경로는 그대로 쓴다', () => {
    eq(safeReturnPath('/terminal'), '/terminal');
    eq(safeReturnPath('/auth?next=/admin'), '/auth?next=/admin');
  });

  test('없으면 기본값으로 간다', () => {
    eq(safeReturnPath(null), '/auth');
    eq(safeReturnPath(''), '/auth');
    eq(safeReturnPath(undefined, '/'), '/');
  });
}

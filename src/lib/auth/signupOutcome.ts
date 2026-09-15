// src/lib/auth/signupOutcome.ts
//
// **가입 결과를 읽는 쪽이 틀리면, 그 가입은 없느니만 못하다.**
//
// 실제로 이렇게 틀렸다
// ────────────────────
// `handleSignup`은 `error`만 봤다:
//
//     const { error } = await sbSignUp(...);
//     if (error) { ...; return; }
//     showToast('가입 완료! 이메일을 확인하여 계정을 인증하세요.', 'success');
//
// `signUp`은 오류가 없어도 **계정이 만들어지지 않은 응답**을 돌려줄 수 있다.
// 그러면 화면은 "가입 완료!"라고 적고, 사용자는 오지 않을 메일을 기다린다.
// 2026-09-15 운영 관측에서 최근 7일 가입 2명·미확인 0·설정 정상이었는데
// "가입이 안 된다"는 제보가 있었다 — 이 화면이 실패를 성공처럼 적으면
// 그 둘은 동시에 참일 수 있다.
//
// 설치된 SDK가 실제로 보장하는 것만 쓴다
// ──────────────────────────────────────
// `@supabase/auth-js` **2.108.2**의 소스와 타입을 직접 읽고 맞췄다:
//
//   · `signUp`은 GoTrue 응답을 **그대로 통과**시킨다. "이미 가입됨"이라는
//     표식을 클라이언트가 따로 받지 않는다 (GoTrueClient.js의 signUp)
//   · `AuthResponse`는 `{ user: User|null, session: Session|null }`이고
//     오류가 있으면 둘 다 null이다 (types.d.ts)
//   · `User.identities`는 **optional**이다 — `UserIdentity[] | undefined`
//
// **그래서 `identities.length === 0`에 "이미 가입된 이메일"을 박지 않는다.**
// 빈 배열은 GoTrue의 열거 방지(enumeration protection)가 만들 수도 있지만,
// 같은 모양이 **익명 사용자** 응답에도 나온다(SDK 문서 예시). 게다가 그
// 보호는 프로젝트 설정에 따라 켜지고 꺼진다. 확실하지 않은 것을 확정해서
// 말하면 **우리가 그 보호를 대신 깨는 것**이 된다 — 공격자가 이메일 존재
// 여부를 우리 화면에서 읽어 간다.
//
// 그래서 모호한 것은 **모호하다고 말하고**, 사용자가 다음에 무엇을 하면
// 되는지만 정확히 알려 준다.

/** 가입 요청의 결말. **성공/실패 둘로 접지 않는다** */
export type SignupOutcomeCode =
  /** 계정이 만들어졌고 확인 메일이 필요하다 */
  | 'CONFIRM_EMAIL_SENT'
  /** 계정이 만들어졌고 세션까지 바로 생겼다 */
  | 'SIGNED_IN'
  /** 요청은 받아들여졌는데 **새 계정이 생겼는지 이 응답만으로는 알 수 없다** */
  | 'AMBIGUOUS'
  /** 서버가 오류를 돌려줬다 */
  | 'ERROR'
  /** 오류도 없고 사용자도 없다. **성공으로 적지 않는다** */
  | 'UNREADABLE';

/** 사용자가 다음에 할 일 — 화면은 이걸 보고 안내한다 */
export type SignupNextAction =
  | 'CHECK_EMAIL'
  | 'CONTINUE'
  | 'TRY_LOGIN_OR_RESET'
  | 'FIX_AND_RETRY'
  | 'RETRY_LATER';

export interface SignupOutcome {
  code: SignupOutcomeCode;
  /** 계정이 **확실히** 만들어졌는가. 모르면 false — 추측하지 않는다 */
  accountCreated: boolean;
  /** 초록(성공)으로 표시해도 되는가 */
  ok: boolean;
  next: SignupNextAction;
  message: string;
}

export interface SignupResultShape {
  /** `data.user` */
  user?: { identities?: unknown } | null;
  /** `data.session` */
  session?: unknown | null;
  /** `error.message` (있으면) */
  errorMessage?: string | null;
}

/**
 * 가입 응답을 읽는다.
 *
 * **순서가 계약이다.** 오류 → 세션 → identities. 앞의 것이 참이면 뒤는 보지
 * 않는다. `identities`가 아예 없는 것(undefined)과 빈 배열은 **다른 사실**이고,
 * 둘 다 "이미 가입됨"을 뜻하지는 않는다.
 */
export function signupOutcome(r: SignupResultShape | null | undefined): SignupOutcome {
  const err = typeof r?.errorMessage === 'string' ? r.errorMessage.trim() : '';
  if (err) {
    return {
      code: 'ERROR', accountCreated: false, ok: false, next: 'FIX_AND_RETRY',
      message: err,
    };
  }

  const user = r?.user ?? null;
  const session = r?.session ?? null;

  if (!user) {
    // 오류도 없고 사용자도 없다. 무슨 일이 있었는지 모른다 —
    // **모르는 것을 "가입 완료"로 적지 않는다.**
    return {
      code: 'UNREADABLE', accountCreated: false, ok: false, next: 'RETRY_LATER',
      message: '가입 요청의 결과를 확인하지 못했습니다. 잠시 후 로그인해 보시고, '
             + '로그인이 안 되면 다시 시도해 주세요.',
    };
  }

  if (session) {
    return {
      code: 'SIGNED_IN', accountCreated: true, ok: true, next: 'CONTINUE',
      message: '가입이 완료되어 바로 로그인됐습니다.',
    };
  }

  const identities = (user as any).identities;
  if (Array.isArray(identities) && identities.length > 0) {
    return {
      code: 'CONFIRM_EMAIL_SENT', accountCreated: true, ok: true, next: 'CHECK_EMAIL',
      message: '가입 요청을 보냈습니다. 메일함에서 인증 링크를 눌러 주세요 '
             + '(스팸함도 확인해 주세요).',
    };
  }

  // 여기가 모호한 자리다. 빈 배열일 수도, 아예 없을 수도 있다.
  //
  // **"이미 가입된 이메일입니다"라고 적지 않는다.** 그 문장은 (1) 확실하지
  // 않고 (2) 맞더라도 계정 존재 여부를 알려 주는 셈이 된다. 대신 사용자가
  // 다음에 할 일을 정확히 알려 준다 — 그것만으로 막힌 곳을 지나갈 수 있다.
  return {
    code: 'AMBIGUOUS', accountCreated: false, ok: false, next: 'TRY_LOGIN_OR_RESET',
    message: '요청은 접수됐지만 새 계정이 만들어졌는지는 확인되지 않았습니다. '
           + '잠시 뒤에도 인증 메일이 오지 않으면, 이미 쓰고 있는 주소일 수 있으니 '
           + '로그인하거나 비밀번호 재설정을 이용해 주세요.',
  };
}

/**
 * 로그인은 됐는데 프로필이 없다 — **화면이 침묵하면 안 된다.**
 *
 * `handleLogin`은 `if (profile) { ... }`만 있었다. 인증에 성공해도 프로필이
 * null이면 토스트도 이동도 없어서, 사용자에게는 **버튼이 안 눌린 것처럼**
 * 보였다. 2026-09-15 운영에는 고아 사용자가 0명이라 지금 발현 중은 아니지만,
 * 침묵하는 화면은 그 사실을 확인할 방법조차 주지 않는다.
 */
export function loginOutcomeMessage(i: {
  hasUser: boolean; hasProfile: boolean;
}): { ok: boolean; message: string } {
  if (i.hasProfile) return { ok: true, message: '' };
  if (i.hasUser) {
    return {
      ok: false,
      message: '로그인은 됐지만 계정 정보를 불러오지 못했습니다. '
             + '잠시 후 다시 시도해 주세요 — 계속되면 관리자에게 알려 주세요.',
    };
  }
  return { ok: false, message: '로그인 결과를 확인하지 못했습니다. 다시 시도해 주세요.' };
}

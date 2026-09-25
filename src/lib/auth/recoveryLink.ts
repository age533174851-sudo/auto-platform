// src/lib/auth/recoveryLink.ts
//
// **비밀번호 재설정 링크를 열었을 때 무엇을 보여줄 것인가 — 판단만.**
//
// 왜 이 파일이 따로 있는가
// ────────────────────────
// 이 저장소의 1번 고장이 정확히 여기서 났다: `sbResetPassword`는 메일을
// `${origin}/auth/reset`으로 보내고 있었는데 **그 페이지가 없었다.**
// 요청 쪽과 변경 쪽(`sbUpdatePassword`)은 둘 다 있었고, 그 사이 착지만
// 비어 있었다. 사용자는 메일을 받고 링크를 눌러 Next.js 404를 봤다.
//
// 페이지를 만드는 김에 판단을 페이지 밖으로 뺀다. 착지 판정은 경우가
// 많고(만료·이미 씀·세션 없음·엉뚱한 종류), 그 경우들은 화면을 띄워 보는
// 것으로는 확인하기 어렵다. 여기 있으면 시험이 전부 돌려 볼 수 있다.
//
// ★ 이 프로젝트는 implicit flow다 — 확인하고 적는다
// ─────────────────────────────────────────────────
// `getSupabaseClient()`가 `flowType`을 지정하지 않고, auth-js 2.108.2의
// 기본값은 `'implicit'`이다(`GoTrueClient.js`의 DEFAULT_OPTIONS).
// 그래서 복구 토큰은 **URL 해시**로 온다:
//
//   https://앱/auth/reset#access_token=...&type=recovery&expires_in=3600
//
// `?code=`를 받아 `exchangeCodeForSession`을 부르는 PKCE 예제를 그대로
// 붙이면 이 프로젝트에서는 동작하지 않는다. 그래서 양쪽 모양을 다 읽되,
// **무엇을 읽었는지 코드로 남긴다** — 나중에 flowType을 바꾸면 여기가
// 먼저 말해 준다.
//
// 실패도 해시로 온다
// ──────────────────
// 만료·재사용 링크는 302로 이렇게 떨어진다:
//
//   .../auth/reset#error=access_denied&error_code=otp_expired&error_description=...
//
// 이때 세션은 안 생긴다. 이것을 "세션 없음"으로 뭉뚱그리면 사용자는
// 무엇을 해야 할지 모른다 — 만료면 다시 받으면 되고, 종류가 틀렸으면
// 다른 링크를 눌러야 한다.

export type RecoveryLinkCode =
  /** 해시에 복구 토큰이 있다 — SDK가 세션을 만들 것이다 */
  | 'RECOVERY_TOKEN'
  /** PKCE 코드가 있다 — 교환이 필요하다 */
  | 'RECOVERY_CODE'
  /** 링크가 만료됐다 */
  | 'EXPIRED'
  /** 이미 쓴 링크이거나 거부됐다 */
  | 'REJECTED'
  /** 복구가 아닌 다른 종류의 링크다 (가입 확인 등) */
  | 'WRONG_TYPE'
  /** 아무 표시도 없다. 주소창에 직접 친 경우가 대부분이다 */
  | 'NO_TOKEN';

export interface RecoveryLinkVerdict {
  code: RecoveryLinkCode;
  /** 새 비밀번호 입력을 보여도 되는가 */
  canProceed: boolean;
  /** 복구 세션이 생기기를 기다려야 하는가 */
  awaitsSession: boolean;
  /** PKCE 교환에 쓸 코드. 없으면 null */
  exchangeCode: string | null;
  /** 사용자에게 보여줄 말. **토큰 값은 절대 담지 않는다** */
  message: string;
  /** "재설정 링크 다시 받기"를 권해야 하는가 */
  offerResend: boolean;
}

/** 해시·쿼리 문자열을 키 묶음으로. `#`·`?`는 있어도 없어도 된다 */
function params(s: string | null | undefined): URLSearchParams {
  const t = String(s || '').replace(/^[#?]/, '');
  return new URLSearchParams(t);
}

/**
 * 착지한 주소만 보고 무엇을 보여줄지 정한다.
 *
 * **값을 메시지에 넣지 않는다.** access_token·code·token_hash는 그 자체가
 * 세션을 만들 수 있는 비밀이다. 화면·로그·텔레메트리 어디에도 남기지
 * 않는다 — 이 함수는 존재 여부만 보고 판정한다.
 */
export function readRecoveryLink(i: {
  hash?: string | null;
  query?: string | null;
}): RecoveryLinkVerdict {
  const h = params(i?.hash);
  const q = params(i?.query);

  // ── ① 실패가 먼저다 ──
  //
  // 만료 링크에도 `type=recovery`가 같이 올 수 있다. 성공을 먼저 보면
  // 만료된 링크에 새 비밀번호 입력을 띄우고, 저장 단계에서야 실패한다.
  const err = h.get('error') || q.get('error') || '';
  const errCode = h.get('error_code') || q.get('error_code') || '';
  if (err || errCode) {
    const expired = /otp_expired|expired/i.test(`${err} ${errCode}`);
    if (expired) {
      return {
        code: 'EXPIRED', canProceed: false, awaitsSession: false, exchangeCode: null,
        offerResend: true,
        message: '재설정 링크가 만료되었습니다. 보안을 위해 링크는 일정 시간 뒤 사용할 수 없습니다 '
          + '— 아래에서 새 링크를 받아 주세요.',
      };
    }
    return {
      code: 'REJECTED', canProceed: false, awaitsSession: false, exchangeCode: null,
      offerResend: true,
      message: '이 재설정 링크는 더 이상 사용할 수 없습니다. 이미 사용했거나 새 링크가 발급된 '
        + '경우입니다 — 아래에서 새 링크를 받아 주세요.',
    };
  }

  // ── ② 종류가 맞는가 ──
  //
  // 가입 확인(signup)·이메일 변경(email_change) 링크가 이 주소로 오면
  // 여기서 비밀번호를 바꾸게 두지 않는다.
  const type = (h.get('type') || q.get('type') || '').toLowerCase();
  if (type && type !== 'recovery') {
    return {
      code: 'WRONG_TYPE', canProceed: false, awaitsSession: false, exchangeCode: null,
      offerResend: false,
      message: `이 링크는 비밀번호 재설정용이 아닙니다 (${type}). 메일에서 "비밀번호 재설정" 링크를 눌러 주세요.`,
    };
  }

  // ── ③ 토큰이 있는가 ──
  if (h.get('access_token')) {
    return {
      code: 'RECOVERY_TOKEN', canProceed: false, awaitsSession: true, exchangeCode: null,
      offerResend: false,
      message: '재설정 링크를 확인하고 있습니다...',
    };
  }
  // PKCE로 바뀌었을 때를 대비해 읽기만 한다. 지금 이 프로젝트는 implicit다.
  const code = q.get('code') || h.get('code');
  if (code) {
    return {
      code: 'RECOVERY_CODE', canProceed: false, awaitsSession: true, exchangeCode: code,
      offerResend: false,
      message: '재설정 링크를 확인하고 있습니다...',
    };
  }

  return {
    code: 'NO_TOKEN', canProceed: false, awaitsSession: false, exchangeCode: null,
    offerResend: true,
    message: '재설정 링크 정보가 없습니다. 메일의 "비밀번호 재설정" 링크로 다시 들어와 주세요.',
  };
}

// ── 지금 화면이 어느 단계인가 ──
//
// ★ 이 함수는 **뮤테이션 2건이 새 나가서** 생겼다.
//
//   MUT-AR18 착지 화면이 세션 여부를 판정에 안 넘긴다
//   MUT-AR21 세션을 못 기다렸는데 입력창을 연다
//
//   둘 다 페이지의 `useEffect` 안에 있던 판단이라 순수 시험이 닿지 못했고,
//   검사기는 `hasRecoverySession`이라는 **낱말이 있는지**만 봤다. 그래서
//   그 값을 `true`로 박아도 통과했다 — 이 저장소에서 반복된 실패다:
//   이름을 보고 모양을 안 본다.
//
//   그래서 단계 계산을 여기로 뗀다. 화면은 이 값을 그대로 쓰고,
//   "저장해도 되는가"도 같은 값에서 나온다 — 두 곳에 두면 갈린다.

export type RecoveryPhase =
  /** 복구 세션을 기다리는 중 */
  | 'checking'
  /** 새 비밀번호를 받아도 된다 */
  | 'ready'
  /** 쓸 수 없는 링크다. 안내와 재발송을 보여준다 */
  | 'blocked';

export interface RecoveryPhaseVerdict {
  phase: RecoveryPhase;
  /** 저장 판정에 넘길 값. **`phase`와 같은 곳에서 나온다** */
  canSave: boolean;
}

/**
 * 링크 판정 + 세션 유무 + 대기 만료 → 지금 보여줄 단계.
 *
 * **기다리다 못 받은 것을 "받았다"로 적지 않는다.** 한도를 넘겼는데
 * 입력창을 열면, 사용자는 새 비밀번호를 다 치고 저장 단계에서야 실패한다.
 */
export function recoveryPhaseOf(i: {
  linkCode: RecoveryLinkCode;
  awaitsSession: boolean;
  hasSessionUser: boolean;
  waitedOut: boolean;
}): RecoveryPhaseVerdict {
  // 링크 자체가 못 쓰는 것이면 세션과 무관하게 막는다.
  if (!i?.awaitsSession) return { phase: 'blocked', canSave: false };
  // 세션이 생겼다 — 여기 하나만 통과 경로다.
  if (i.hasSessionUser) return { phase: 'ready', canSave: true };
  // 한도를 넘겼다. **확인 못 한 것은 통과가 아니다.**
  if (i.waitedOut) return { phase: 'blocked', canSave: false };
  return { phase: 'checking', canSave: false };
}

// ── 새 비밀번호를 저장해도 되는가 ──

export type NewPasswordCode =
  | 'OK'
  | 'TOO_WEAK'
  | 'MISMATCH'
  | 'EMPTY'
  | 'NO_SESSION';

export interface NewPasswordVerdict {
  code: NewPasswordCode;
  ok: boolean;
  message: string;
}

/**
 * 저장 버튼을 눌렀을 때의 판정.
 *
 * **세션 확인이 먼저다.** 복구 세션이 없는데 `updateUser`를 부르면
 * "로그인한 다른 사람"의 비밀번호를 바꿀 수 있다 — 같은 브라우저에 다른
 * 계정이 로그인돼 있고 링크가 만료된 경우가 그렇다.
 */
export function judgeNewPassword(i: {
  password: string;
  confirm: string;
  hasRecoverySession: boolean;
  strengthOk: boolean;
}): NewPasswordVerdict {
  if (!i?.hasRecoverySession) {
    return { code: 'NO_SESSION', ok: false,
      message: '재설정 세션이 없습니다. 메일의 링크로 다시 들어와 주세요.' };
  }
  if (!i.password || !i.confirm) {
    return { code: 'EMPTY', ok: false, message: '새 비밀번호를 두 칸 모두 입력해 주세요.' };
  }
  if (i.password !== i.confirm) {
    return { code: 'MISMATCH', ok: false, message: '두 비밀번호가 서로 다릅니다.' };
  }
  if (!i.strengthOk) {
    return { code: 'TOO_WEAK', ok: false, message: '비밀번호 조건을 모두 만족해야 합니다.' };
  }
  return { code: 'OK', ok: true, message: '' };
}

// ── 어디로 돌려보낼 것인가 ──

/**
 * 성공 뒤 이동할 곳.
 *
 * ★ **열린 리다이렉트를 만들지 않는다.** `?next=https://남의사이트`를
 *   그대로 쓰면, 우리 도메인에서 출발해 남의 로그인 화면으로 데려다주는
 *   링크를 누구나 만들 수 있다. 그래서 **같은 출처의 상대 경로만** 받는다.
 *
 *   `//evil.com`은 브라우저가 프로토콜 상대 URL로 읽어 외부로 나간다.
 *   `/` 하나로 시작하는지만 보면 그걸 놓친다.
 */
export function safeReturnPath(next: string | null | undefined, fallback = '/auth'): string {
  const v = String(next ?? '').trim();
  if (!v) return fallback;
  if (!v.startsWith('/')) return fallback;   // 절대 URL·스킴 전부 거절
  if (v.startsWith('//')) return fallback;   // 프로토콜 상대 URL
  if (v.startsWith('/\\')) return fallback;  // 백슬래시 우회
  if (/[\r\n]/.test(v)) return fallback;     // 헤더 주입
  return v;
}

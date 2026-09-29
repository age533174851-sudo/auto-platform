// src/lib/auth/siteOrigin.ts
//
// **인증 메일이 어느 주소로 돌아올 것인가 — 그리고 그 주소를 어떻게 알았는가.**
//
// 왜 "어떻게 알았는가"까지 돌려주는가
// ───────────────────────────────────
// 예전 `getSiteUrl()`은 문자열 하나만 돌려줬다:
//
//   NEXT_PUBLIC_SITE_URL → window.location.origin → ''
//
// 그런데 이 저장소 어디에서도 `NEXT_PUBLIC_SITE_URL`을 설정하지 않는다
// (참조처는 그 함수 한 곳뿐이다). 즉 실제로는 **언제나 브라우저의 현재
// origin**이 쓰인다. 사용자가 preview 배포에서 재설정을 요청하면 복구
// 메일이 그 preview 주소로 나가고, 그 배포가 지워지면 링크는 죽는다.
//
// 이건 조용히 틀리는 종류다 — 메일은 정상으로 보이고 링크만 안 된다.
// 그래서 값과 함께 **출처**를 돌려준다. 화면·보고가 "설정된 정본을 썼다"와
// "지금 보고 있는 주소를 그대로 썼다"를 구분할 수 있어야 한다.

export type OriginSource =
  /** NEXT_PUBLIC_SITE_URL — 운영 정본 */
  | 'CONFIGURED'
  /** 지금 브라우저가 보고 있는 주소. 정본이라는 보장이 없다 */
  | 'BROWSER'
  /** 알 수 없다. Supabase Dashboard의 Site URL이 쓰인다 */
  | 'UNKNOWN';

export interface SiteOrigin {
  /** 끝의 `/`를 뗀 origin. 모르면 빈 문자열 */
  origin: string;
  source: OriginSource;
  /** 운영 정본으로 믿어도 되는가 */
  canonical: boolean;
  reason: string;
}

function clean(v: string | null | undefined): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  // 스킴 없는 값은 받지 않는다. `//evil.com`이나 `app.example.com`을
  // 그대로 쓰면 메일 링크가 엉뚱한 곳으로 간다.
  if (!/^https?:\/\//i.test(s)) return '';
  return s.replace(/\/+$/, '');
}

/**
 * 인증 메일이 돌아올 origin을 정한다.
 *
 * **아무 도메인도 코드에 박지 않는다.** 운영 도메인을 여기 적으면 미리보기
 * 배포에서도 그 도메인으로 메일이 가고, 그러면 미리보기에서 인증 흐름을
 * 시험할 수 없다. 정본은 환경변수로 들어와야 한다.
 */
export function resolveSiteOrigin(i: {
  configured?: string | null;
  browserOrigin?: string | null;
} = {}): SiteOrigin {
  const cfg = clean(i?.configured);
  if (cfg) {
    return { origin: cfg, source: 'CONFIGURED', canonical: true,
      reason: 'NEXT_PUBLIC_SITE_URL에 설정된 주소를 씁니다' };
  }
  const br = clean(i?.browserOrigin);
  if (br) {
    return { origin: br, source: 'BROWSER', canonical: false,
      reason: 'NEXT_PUBLIC_SITE_URL이 없어 지금 보고 있는 주소를 씁니다 '
        + '— 미리보기 배포에서 요청하면 그 주소로 메일이 갑니다' };
  }
  return { origin: '', source: 'UNKNOWN', canonical: false,
    reason: '돌아올 주소를 정하지 못했습니다 — Supabase Dashboard의 Site URL이 쓰입니다' };
}

/** 인증 메일이 착지해야 하는 경로들. **라우트가 실제로 있어야 한다** */
export const AUTH_RETURN_PATHS = {
  /** 가입 확인 · OAuth */
  callback: '/auth/callback',
  /** 비밀번호 재설정 — 이 경로가 없어서 사용자가 404를 봤다 */
  reset: '/auth/reset',
} as const;

/** `origin`을 모르면 `undefined`. Supabase는 그때 Dashboard의 Site URL을 쓴다 */
export function authReturnUrl(
  o: SiteOrigin, path: (typeof AUTH_RETURN_PATHS)[keyof typeof AUTH_RETURN_PATHS],
): string | undefined {
  if (!o?.origin) return undefined;
  return `${o.origin}${path}`;
}

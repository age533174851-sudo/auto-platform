// src/lib/auth/siteOrigin.test.ts
//
// **복구 메일이 죽은 주소로 나가는 것을 막는다.**
//
// `NEXT_PUBLIC_SITE_URL`은 이 저장소 어디에서도 설정되지 않는다. 그래서
// 실제로는 언제나 브라우저의 현재 origin이 쓰였고, preview 배포에서 요청한
// 복구 메일은 그 preview 주소로 나갔다. 배포가 지워지면 링크도 죽는다.
// 조용히 틀리는 종류라 시험으로 출처를 붙잡아 둔다.
import { test, eq, assert } from '../../test/harness';
import {
  resolveSiteOrigin, authReturnUrl, AUTH_RETURN_PATHS,
} from './siteOrigin';

export function runSiteOriginTests() {
  console.log('\n🌐 인증 메일 복귀 주소');

  test('설정된 정본이 있으면 그것을 쓰고 canonical로 적는다', () => {
    const o = resolveSiteOrigin({ configured: 'https://app.example.com', browserOrigin: 'https://preview-x.vercel.app' });
    eq(o.origin, 'https://app.example.com');
    eq(o.source, 'CONFIGURED');
    eq(o.canonical, true);
  });

  test('끝의 슬래시를 뗀다 — //auth/reset가 되지 않게', () => {
    eq(resolveSiteOrigin({ configured: 'https://app.example.com/' }).origin, 'https://app.example.com');
    eq(resolveSiteOrigin({ configured: 'https://app.example.com///' }).origin, 'https://app.example.com');
  });

  test('★ 설정이 없으면 브라우저 주소를 쓰되 canonical이 아니라고 적는다', () => {
    const o = resolveSiteOrigin({ configured: '', browserOrigin: 'https://preview-x.vercel.app' });
    eq(o.origin, 'https://preview-x.vercel.app');
    eq(o.source, 'BROWSER');
    eq(o.canonical, false, '★ preview 주소를 운영 정본으로 적었습니다');
    assert(/미리보기/.test(o.reason), o.reason);
  });

  test('★ 스킴 없는 값은 받지 않는다 — 메일 링크가 엉뚱한 곳으로 간다', () => {
    for (const bad of ['app.example.com', '//evil.example.com', 'javascript:alert(1)', 'ftp://x']) {
      const o = resolveSiteOrigin({ configured: bad });
      assert(o.source !== 'CONFIGURED', `★ 스킴 없는 값을 정본으로 받았습니다: ${bad}`);
    }
  });

  test('아무것도 없으면 UNKNOWN이고 origin은 빈 문자열이다', () => {
    const o = resolveSiteOrigin({});
    eq(o.source, 'UNKNOWN');
    eq(o.origin, '');
    eq(o.canonical, false);
  });

  test('★ origin을 모르면 redirectTo를 만들지 않는다 (undefined)', () => {
    // 빈 문자열을 붙이면 `"/auth/reset"`이라는 상대 경로가 Supabase로 가고,
    // 그건 허용 목록과 대조할 수 없는 값이다.
    eq(authReturnUrl(resolveSiteOrigin({}), AUTH_RETURN_PATHS.reset), undefined);
  });

  test('복귀 주소를 만든다', () => {
    const o = resolveSiteOrigin({ configured: 'https://app.example.com' });
    eq(authReturnUrl(o, AUTH_RETURN_PATHS.reset), 'https://app.example.com/auth/reset');
    eq(authReturnUrl(o, AUTH_RETURN_PATHS.callback), 'https://app.example.com/auth/callback');
  });

  test('★ 경로 정본이 앱 라우트와 같은 모양이다', () => {
    // 이 값이 바뀌면 `src/app/...`에 같은 이름의 라우트가 있어야 한다.
    // 실제로 그것을 안 만들어서 사용자가 404를 봤다 — 라우트 존재 확인은
    // `scripts/check-auth-recovery.mjs`가 한다.
    eq(AUTH_RETURN_PATHS.reset, '/auth/reset');
    eq(AUTH_RETURN_PATHS.callback, '/auth/callback');
    for (const p of Object.values(AUTH_RETURN_PATHS)) {
      assert(p.startsWith('/') && !p.startsWith('//'), `경로가 이상합니다: ${p}`);
    }
  });
}

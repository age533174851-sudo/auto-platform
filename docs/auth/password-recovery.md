# 비밀번호 재설정 — 흐름과 수동 설정

## 무엇이 고장나 있었나

사용자 실기기 재현: 재설정 메일은 정상 수신 → "Reset password" 클릭 →
**Next.js 404.**

원인은 메일이 아니었다. `sbResetPassword`가 메일을 `${origin}/auth/reset`으로
보내고 있었는데 **`/auth/reset` 라우트가 저장소에 없었다.**

```
$ find src/app/auth -type f          # 수정 전
src/app/auth/page.tsx
src/app/auth/callback/page.tsx       ← /auth/reset 없음
```

요청 쪽(`sbResetPassword`)도 있고 변경 쪽(`sbUpdatePassword`)도 있었는데
그 사이 착지만 비어 있었다. `sbUpdatePassword`는 "보안 설정" 화면에서만
불렸고, 그 화면은 **이미 로그인한 사람**만 닿을 수 있다 — 비밀번호를 잊은
사람은 정의상 거기 갈 수 없다.

이 저장소가 이름 붙인 1번 고장이다: 만들어 놓고 배선을 안 함.

## 흐름

```
로그인 → 비밀번호 찾기 → 이메일 입력
  └→ sbResetPassword(email)
       redirectTo = getSiteOrigin().origin + AUTH_RETURN_PATHS.reset
                                              ("/auth/reset")
  ↓ Supabase가 메일 발송
메일의 "Reset password"
  ↓
{SUPABASE_URL}/auth/v1/verify?token=...&type=recovery&redirect_to={redirectTo}
  ↓ 302
{앱}/auth/reset#access_token=...&type=recovery      ← implicit flow
  ↓
src/app/auth/reset/page.tsx
  ├ 렌더 중에 해시를 잡는다 (SDK가 지우기 전에)
  ├ readRecoveryLink()로 판정 (만료 / 재사용 / 종류 틀림 / 없음)
  ├ 복구 세션을 기다린다 (PASSWORD_RECOVERY 또는 getSession, 6초 한도)
  ├ 새 비밀번호 · 확인 → judgeNewPassword()
  ├ supabase.auth.updateUser({ password })
  └ signOut() 후 로그인 화면으로
```

### flow type은 implicit이다

`getSupabaseClient()`가 `flowType`을 지정하지 않고, auth-js 2.108.2의
기본값이 `'implicit'`이다. 따라서 복구 토큰은 **URL 해시**로 오고
`detectSessionInUrl: true`가 소비한다.

`?code=` + `exchangeCodeForSession`(PKCE) 예제를 그대로 붙이면 안 된다.
착지 판정은 PKCE 모양도 읽지만, 그건 나중에 `flowType: 'pkce'`로 바꿀
경우를 위한 것이다.

## MANUAL SUPABASE CONFIG REQUIRED

아래는 **코드로 해결할 수 없다.** 배포 도메인이 등록돼 있지 않으면
Supabase가 `redirect_to`를 거부하고 Dashboard의 Site URL로 떨어뜨린다 —
그러면 코드가 맞아도 사용자는 엉뚱한 곳에 착지한다.

### ① Supabase Dashboard → Authentication → URL Configuration

| 항목 | 넣을 값 |
| --- | --- |
| **Site URL** | 운영 canonical origin (예: `https://<운영도메인>`) |
| **Redirect URLs** | `https://<운영도메인>/auth/reset` |
| | `https://<운영도메인>/auth/callback` |
| | (미리보기를 쓸 경우) `https://*-<팀/프로젝트>.vercel.app/auth/reset` |
| | (미리보기를 쓸 경우) `https://*-<팀/프로젝트>.vercel.app/auth/callback` |
| | (로컬) `http://localhost:3000/auth/reset` |
| | (로컬) `http://localhost:3000/auth/callback` |

> **운영 도메인은 이 문서가 정하지 않는다.** 저장소에는 확정된 운영
> 도메인이 없다 — `.env.example`은 `https://your-app.vercel.app`
> 자리표시자이고, 워크플로 주석의 `https://auto-platform-zeta.vercel.app`은
> `EXIT_MONITOR_URL`의 **예시**다. 실제 값은 Vercel 프로젝트의 Production
> Domain으로 확인해서 넣어야 한다. 추측해서 코드에 박지 않는다.

### ② Vercel → Project → Settings → Environment Variables

| 이름 | 환경 | 값 |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Production | 위 Site URL과 **같은 값** |
| `NEXT_PUBLIC_SITE_URL` | Preview | 비워 둔다 (브라우저 주소를 쓰게) |

미설정이면 `resolveSiteOrigin`이 `source: 'BROWSER'`, `canonical: false`로
떨어진다 — 동작은 하지만 preview 배포에서 요청한 메일이 그 preview
주소로 나가고, 배포가 지워지면 링크가 죽는다.

### ③ 이메일 템플릿 — NOT VERIFIED

Dashboard에 접근할 수 없어 **현재 템플릿 내용을 확인하지 못했다.**
확인 없이 "정상"이라고 적지 않는다.

확인해야 할 것: Authentication → Email Templates → **Reset Password**의
링크가 `{{ .ConfirmationURL }}`를 쓰고 있는지. 그 변수가 위 `redirect_to`를
품은 `/auth/v1/verify` 주소로 펼쳐진다. `{{ .SiteURL }}`에 경로를 직접
이어 붙이는 식으로 바꿔 놓았다면 `redirectTo`가 무시된다.

**이번 수정의 목적은 템플릿 디자인이 아니다.** 우선순위는 클릭 →
정상 착지 → 실제 변경 성공이다.

## 회귀 방지

- `scripts/check-auth-recovery.mjs` — `AUTH_RETURN_PATHS`의 모든 경로에
  실제 라우트 파일이 있는지 **파일 시스템으로** 확인한다. 이번 고장을
  잡는 검사다.
- `scripts/auth-recovery-mutations.mjs` — `MUT-AR1`이 `/auth/reset`을
  통째로 치워 그 고장을 그대로 재현한다.
- `src/lib/auth/recoveryLink.test.ts` · `siteOrigin.test.ts` — 만료·재사용·
  종류 틀림·비밀 미노출·열린 리다이렉트·세션 선행 확인.

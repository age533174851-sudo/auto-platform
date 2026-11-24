// src/lib/ops/cronAuthContract.ts
//
// **크론 인증의 두 가지 실패를 값으로 판정한다 (#582).**
//
// 무엇을 겪었나
// ─────────────
// `news-pipeline` 워크플로는 **첫 실행부터 지금까지 성공이 0회**다.
// `/api/cron/news-sync`가 HTTP 401로 거절한다.
//
// 원인을 따라가 보면 이 저장소가 이미 이름 붙인 고장이다 —
// **"같은 비밀에 이름이 둘이면 언젠가 갈린다."**
//
//   워크플로가 보내는 것 : `secrets.NEWS_CRON_SECRET`
//   서버가 비교하는 것   : `process.env.CRON_SECRET`
//   sync-secrets가 관리  : SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY ·
//                          EXCHANGE_ENCRYPTION_KEY · ADMIN_SECRET  ← 둘 다 없다
//
// 즉 **두 이름 모두 아무것도 동기화하지 않는다.** 사람이 서로 다른 두
// 곳에 서로 다른 이름으로 같은 값을 손으로 넣어야 하고, 한 번도 맞은
// 적이 없다. `autotrade-tick`이 `EXIT_MONITOR_SECRET`으로 30회 넘게
// 연속 401이던 것과 **같은 고장**이다. 그쪽은 정본 이름 하나로
// 모았고(`ADMIN_SECRET`), `Authorization: Bearer` 쪽은 안 했다.
//
// 그리고 더 중요한 것 — 미설정이면 **열린다**
// ────────────────────────────────────────────
// `/api/cron/*` 다섯 개가 모두 이 모양이다:
//
//   const secret = process.env.CRON_SECRET || '';
//   if (secret) { ...401... }       ← 비어 있으면 **검사 자체를 건너뛴다**
//
// 관리되지 않는 비밀이므로 "비어 있음"은 현실적인 상태다(새 환경,
// 환경변수 정리, 프리뷰 배포). 그러면 그 주소들은 **누구나 부를 수 있다.**
// 지금 401이 난다는 것은 운영에는 값이 들어 있다는 뜻이므로 **잠재적**
// 노출이고 현재 노출은 아니다. 다만 `cleanup`은 행을 지우고(보존일수·
// 1회 상한 가드는 있다), `ai-*`는 유료 API를 호출한다.
//
// 이 모듈이 지키는 규칙
// ─────────────────────
// **모르는 것을 통과로 적지 않는다.** 알아보지 못한 모양은 `UNKNOWN`이고,
// `UNKNOWN`은 FAIL_CLOSED가 아니다.
//
// **주석은 미리 지워서 넘긴다 — 이 모듈이 직접 지우지 않는다.**
// 처음에는 주석 제거기를 이 파일에 복사해 넣었다. 그것이 바로 이
// 저장소가 금지한 것이다 — "같은 판단이 두 곳에 있으면 언젠가 갈린다",
// 그리고 주석 제거기는 `scripts/lib/strip-comments.mjs` **한 곳**에
// 있어야 한다(그 파일이 직접 적어 둔 이유다). 그래서 이 함수들은
// **이미 주석이 지워진 소스**를 받는다. 호출자가 정본 제거기를 쓴다.
//
// 주석이 섞인 소스를 넘기면 판정이 틀린다 — 그 사실 자체를 시험으로
// 고정해 뒀다(`cronAuthContract.test.ts`의 ★ 주석 전제 시험).

/** 라우트가 비밀 미설정 상태에서 어떻게 행동하는가 */
export type AuthMode =
  /** 비밀이 없으면 거절한다 */
  | 'FAIL_CLOSED'
  /** 비밀이 없으면 **통과시킨다** */
  | 'FAIL_OPEN'
  /** 비밀 검사가 아예 없다 */
  | 'NONE'
  /** 모양을 알아보지 못했다 — 통과로 적지 않는다 */
  | 'UNKNOWN';

export interface RouteAuth {
  mode: AuthMode;
  /** 비교에 쓰는 환경변수 이름(첫 번째). 못 찾으면 null */
  envName: string | null;
  /**
   * 비교에 쓰는 환경변수 **전부**. 대비 경로가 있는 라우트가 있다 —
   * `process.env.CRON_SECRET || process.env.ADMIN_SECRET || ''`.
   * 처음에는 마지막 하나만 집어서 `cron/reconcile`을 UNKNOWN으로 읽었다.
   */
  envNames: string[];
  reason: string;
}

/**
 * 라우트 소스를 읽어 미설정 시 동작을 판정한다.
 *
 * **`strippedSource`는 주석이 이미 지워진 소스여야 한다**
 * (`scripts/lib/strip-comments.mjs`의 `stripJsComments`). 주석이 남아
 * 있으면 설명 문구를 코드로 읽어 판정이 틀린다.
 *
 * 알아보는 모양만 단정하고, 나머지는 `UNKNOWN`이다.
 */
export function classifyRouteAuth(strippedSource: string): RouteAuth {
  const src = String(strippedSource ?? '');
  const has401 = /\b401\b/.test(src);

  // `const <var> = process.env.A || process.env.B || '';` — 대비 경로를
  // 포함한 **전체 사슬**을 잡는다. 하나만 잡으면 대비 경로가 있는
  // 라우트를 UNKNOWN으로 잘못 읽는다(`cron/reconcile`이 그랬다).
  const declM =
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*((?:process\.env\.[A-Z][A-Z0-9_]*\s*\|\|\s*)+'')/
      .exec(src);

  if (!declM) {
    // 사슬은 못 찾았지만 env를 읽기는 하는가
    const anyEnv = /process\.env\.([A-Z][A-Z0-9_]*)/.exec(src);
    if (!anyEnv) {
      return { mode: has401 ? 'UNKNOWN' : 'NONE', envName: null, envNames: [],
        reason: has401
          ? '401은 있는데 비밀을 읽는 자리를 찾지 못했습니다 — 통과로 적지 않습니다'
          : '비밀 검사가 없습니다' };
    }
    return { mode: 'UNKNOWN', envName: anyEnv[1], envNames: [anyEnv[1]],
      reason: `${anyEnv[1]}을 읽지만 어떤 변수에 담는지 알아보지 못했습니다` };
  }

  const v = declM[1];
  const envNames = [...declM[2].matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
  const envName = envNames[0] ?? null;
  const label = envNames.join(' 또는 ');

  if (!has401) {
    return { mode: 'NONE', envName, envNames,
      reason: `${label}을 읽지만 거절하는 자리가 없습니다` };
  }

  // **미설정을 명시적으로 거절하면 fail-closed다.** 이것을 먼저 본다 —
  // fail-closed 라우트에도 `if (<var>)` 형태가 뒤에 나올 수 있다.
  const rejectsMissing =
    new RegExp(`if\\s*\\(\\s*!\\s*${v}\\s*\\)`).test(src)
    || new RegExp(`if\\s*\\(\\s*${v}\\s*===?\\s*''\\s*\\)`).test(src)
    || new RegExp(`!${v}\\s*\\|\\|`).test(src);
  if (rejectsMissing) {
    return { mode: 'FAIL_CLOSED', envName, envNames,
      reason: `${label}이 비어 있으면 거절합니다` };
  }

  // 거절이 `if (<var>)` 안에만 있으면 미설정 시 건너뛴다.
  const guarded = new RegExp(`if\\s*\\(\\s*${v}\\s*\\)\\s*\\{`).test(src);
  if (guarded) {
    return { mode: 'FAIL_OPEN', envName, envNames,
      reason: `${label}이 비어 있으면 \`if (${v})\`가 거짓이 되어 `
        + '인증 검사를 건너뜁니다 — 누구나 부를 수 있습니다' };
  }

  return { mode: 'UNKNOWN', envName, envNames,
    reason: `${label}의 미설정 처리를 알아보지 못했습니다 — 통과로 적지 않습니다` };
}

/** 워크플로가 보내는 비밀 이름이 동기화되는가 */
export type SecretManagement = 'MANAGED' | 'HAND_SET';

export function classifySecretName(
  name: string, managed: readonly string[],
): SecretManagement {
  const n = String(name ?? '').trim();
  if (!n) return 'HAND_SET';
  return (managed ?? []).includes(n) ? 'MANAGED' : 'HAND_SET';
}

/**
 * `sync-secrets.mjs`의 `NAMES` 한 줄에서 관리 목록을 읽는다.
 * 입력은 주석이 지워진 소스여야 한다.
 *
 * **목록을 여기 베껴 쓰지 않는다** — 두 곳에 두면 언젠가 갈리고, 그러면
 * 이 검사가 조용히 거짓을 말한다. 읽지 못하면 `null`(UNKNOWN)이다.
 */
export function managedNamesFrom(strippedSyncSecretsSource: string): string[] | null {
  const src = String(strippedSyncSecretsSource ?? '');
  const m = /const\s+NAMES\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!m) return null;
  const names = [...m[1].matchAll(/['"]([A-Z][A-Z0-9_]*)['"]/g)].map((x) => x[1]);
  return names.length ? names : null;
}

/** 안전한 상태인가 — UNKNOWN은 안전이 아니다 */
export function routeIsHardened(a: RouteAuth): boolean {
  return a.mode === 'FAIL_CLOSED';
}

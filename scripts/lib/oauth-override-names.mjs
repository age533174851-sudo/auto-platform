// scripts/lib/oauth-override-names.mjs
//
// **OAuth 전용 회차에서 OAuth를 밀어내는 이름을 한 곳에 둔다.**
//
// 공식 인증 우선순위(code.claude.com/docs/en/authentication):
//
//   ① 클라우드 공급자(Bedrock/Vertex) → ② ANTHROPIC_AUTH_TOKEN
//   → ③ ANTHROPIC_API_KEY → ④ apiKeyHelper → ⑤ CLAUDE_CODE_OAUTH_TOKEN
//
// ①~④ 중 **하나라도** 회차에 들어오면 ⑤는 쓰이지 않는다. 그래서 OAuth
// 토큰을 넣어 두고도 종량제로 돌 수 있고, 로그의 `인증: ...OAUTH_TOKEN`은
// **시크릿이 비어 있지 않다는 것만** 뜻하므로 그 사실을 가린다.
//
// 그런데 들어올 자리가 **둘**이다:
//
//   ㉮ 워크플로 YAML (`.github/workflows/claude-hourly-*.yml`)
//   ㉯ 체크아웃에 **커밋된** 프로젝트 설정 파일
//      (`.claude/settings.json` · `.claude/settings.local.json`)
//
// 공식 설정 문서의 색인은 `apiKeyHelper`와 `env`의 적용 범위를 둘 다
// **"Any file"** 로 적는다 — 즉 저장소에 커밋된 프로젝트 설정 파일에서도
// 적용된다. 그리고 우선순위에서 프로젝트 로컬 설정은 사용자 설정보다
// 위다. 즉 ㉯는 ㉮만 검사하는 울타리가 **구조적으로 볼 수 없는 자리**다.
//
// 두 자리가 각자 자기 목록을 들고 있으면 언젠가 한쪽만 늘어나고, 그때부터
// 다른 쪽은 조용히 아무것도 막지 않는다(이 저장소에서 반복된 고장 ②:
// "경로가 둘인데 한쪽만 고침"). 그래서 목록은 **여기 하나뿐이다.**

/** 이름 → 왜 이것이 OAuth를 밀어내는가 */
export const OAUTH_OVERRIDE_NAMES = [
  ['CLAUDE_CODE_USE_BEDROCK', '우선순위 ① 클라우드 공급자 — OAuth 토큰을 아예 쓰지 않습니다'],
  ['CLAUDE_CODE_USE_VERTEX', '우선순위 ① 클라우드 공급자 — OAuth 토큰을 아예 쓰지 않습니다'],
  ['ANTHROPIC_AUTH_TOKEN', '우선순위 ② — OAuth(⑤)보다 먼저 선택됩니다'],
  ['ANTHROPIC_API_KEY', '우선순위 ③ — 비대화형(-p) 회차에서는 있으면 항상 쓰입니다'],
  ['ANTHROPIC_BASE_URL', '엔드포인트가 바뀌면 구독 인증 회차라는 증거가 사라집니다'],
  ['apiKeyHelper', '우선순위 ④ — OAuth(⑤)보다 먼저 API 키를 만들어 씁니다'],
];

const BY_LOWER = new Map(OAUTH_OVERRIDE_NAMES.map(([n, why]) => [n.toLowerCase(), { name: n, why }]));

/** 이 이름이 OAuth를 밀어내는 이름인가. 맞으면 표준 표기와 이유를 돌려준다 */
export function overrideNameOf(key) {
  return BY_LOWER.get(String(key).trim().toLowerCase()) ?? null;
}

/** 중첩이 이보다 깊으면 **다 보지 못했다고 적는다.** 끝까지 봤다고 하지 않는다 */
export const MAX_DEPTH = 32;

/**
 * 파싱된 설정에서 **키 이름만** 찾는다.
 *
 * 값은 읽지도, 돌려주지도, 어디에도 적지 않는다 — 값이 토큰일 수 있다.
 * 돌려주는 `path`는 **키 이름만** 이어 붙인 것이다.
 *
 * `truncated`가 참이면 더 깊은 곳을 보지 못한 것이다. 못 본 것을
 * "없음"으로 적지 않기 위해 호출하는 쪽이 이것을 실패로 다룬다.
 */
export function findOverrideKeys(value) {
  const hits = [];
  let truncated = false;
  const walk = (v, path, depth) => {
    if (depth > MAX_DEPTH) { truncated = true; return; }
    if (Array.isArray(v)) {
      v.forEach((e, i) => walk(e, [...path, `[${i}]`], depth + 1));
      return;
    }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const m = overrideNameOf(k);
        if (m) hits.push({ name: m.name, why: m.why, path: [...path, k].join('.') });
        walk(v[k], [...path, k], depth + 1);
      }
    }
  };
  walk(value, [], 0);
  return { hits, truncated };
}

// ── 판단을 **CI가 이미 부르는 자리에서** 증명한다 ──
//
// 이 판단의 음성 시험을 `scripts/test-*.mjs`에만 두면 **CI에서 한 번도
// 돌지 않는다.** `ci.yml`의 `.mjs` 시험 단계는 파일 이름을 두 개 적어
// 부르고(`test-claude-api-preflight` · `test-claude-exec-category`),
// `npm test`는 TypeScript 하네스라 `.mjs`가 안 걸린다. `ci.yml` 자신이
// 그 자리에 이렇게 적어 두었다: "여기서 돌리지 않으면 **PR에서 한 번도
// 안 돈다** — 이 저장소가 이미 당한 모양이다."
//
// 그래서 목록에 파일 이름을 하나 더 더하는 대신, **판단이 자기 자신을
// 증명하게** 한다. `check-claude-hourly.mjs`는 CI의 `무인 회차 울타리`
// 단계에서 이미 돌고, 거기서 이 시험을 매번 돌린다. 유지해야 할 목록이
// 없으므로 "배선을 안 함"이 다시 생길 자리가 없다.
//
// 시험 자료는 여기 한 벌뿐이고, 검사기와 `node --test`가 **같은 자료를**
// 쓴다. 두 벌로 두면 언젠가 한쪽만 늘어난다.

/** 시험용 가짜 값. 실제 토큰이 아니며, 출력에 새는지도 함께 센다 */
export const SELF_TEST_FAKE = 'SELF-TEST-FAKE-VALUE-NOT-A-TOKEN';

const F = SELF_TEST_FAKE;

/** 깊이 초과 자료 — MAX_DEPTH보다 깊게 감싼다 */
function tooDeep() {
  let v = { apiKeyHelper: F };
  for (let i = 0; i <= MAX_DEPTH + 2; i += 1) v = { nest: v };
  return v;
}

export const SELF_TEST_CASES = [
  { what: '권한 규칙만 — 찾는 것이 없다',
    input: { permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] } },
    paths: [], truncated: false },
  { what: 'apiKeyHelper 한 줄 (우선순위 ④)',
    input: { apiKeyHelper: F }, paths: ['apiKeyHelper'], truncated: false },
  { what: 'env.ANTHROPIC_AUTH_TOKEN (우선순위 ②)',
    input: { env: { ANTHROPIC_AUTH_TOKEN: F } },
    paths: ['env.ANTHROPIC_AUTH_TOKEN'], truncated: false },
  { what: '소문자로 적어도 찾는다',
    input: { env: { anthropic_api_key: F } },
    paths: ['env.anthropic_api_key'], truncated: false },
  { what: '여섯 이름 전부 — 하나도 빠뜨리지 않는다',
    input: { apiKeyHelper: F, env: Object.fromEntries(
      OAUTH_OVERRIDE_NAMES.filter(([n]) => n !== 'apiKeyHelper').map(([n]) => [n, F])) },
    paths: ['apiKeyHelper', ...OAUTH_OVERRIDE_NAMES
      .filter(([n]) => n !== 'apiKeyHelper').map(([n]) => `env.${n}`)].sort(),
    truncated: false },
  { what: '배열·중첩 안에 숨겨도 찾는다',
    input: { a: [{ b: { apiKeyHelper: F } }] },
    paths: ['a.[0].b.apiKeyHelper'], truncated: false },
  { what: '이름을 품고 있을 뿐인 키는 찾지 않는다 (거짓 빨강 방지)',
    input: { env: { MY_ANTHROPIC_API_KEY_BACKUP: F, NOTE_ABOUT_APIKEYHELPER: F } },
    paths: [], truncated: false },
  { what: '너무 깊으면 "없음"이 아니라 못 봤다고 적는다',
    input: tooDeep(), paths: [], truncated: true },
];

/**
 * 위 자료를 전부 돌린다. 돌려주는 `failed`가 비어 있지 않으면 **판단이
 * 깨진 것**이므로 부르는 쪽이 실패로 다룬다. 값이 결과에 새는지도 센다.
 */
export function selfTest() {
  const failed = [];
  for (const c of SELF_TEST_CASES) {
    const { hits, truncated } = findOverrideKeys(c.input);
    const got = hits.map((h) => h.path).sort();
    const want = [...c.paths].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failed.push(`${c.what} — 기대 ${want.length}건, 실제 ${got.length}건`);
    } else if (truncated !== c.truncated) {
      failed.push(`${c.what} — truncated 기대 ${c.truncated}, 실제 ${truncated}`);
    } else if (JSON.stringify(hits).includes(SELF_TEST_FAKE)) {
      failed.push(`${c.what} — 결과에 값이 섞여 있습니다`);
    }
  }
  return { total: SELF_TEST_CASES.length, failed };
}

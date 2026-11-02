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

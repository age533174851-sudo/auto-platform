# SAFETY — 전체정지가 서버에 닿지 못하고 있었다

> 사용자가 위험하다고 판단해 누르는 버튼이 아무 일도 하지 않았다.

| | |
|---|---|
| base | `d614dfbc3a7a49486a9d62f211190defd4cb9583` (UI-4B 종료 main) |
| 재현 | `node scripts/probe/global-stop-auth.mjs <port>` |
| 검사기 | `scripts/check-global-stop-auth.mjs` (CI 배선) |

## 무엇이 고장나 있었나

전체정지는 서버를 두 번 부른다.

```
GET   /api/autotrade/schedule        무엇을 끌지 읽는다
PATCH /api/autotrade/schedule        하나씩 끈다
```

둘 다 `localStorage.sb_access_token`을 읽고 있었다. 세 사실이 맞물린다.

| # | 사실 | 근거 |
|---|---|---|
| 1 | 서버는 **검증된 Supabase JWT만** 받는다 | `resolveUserId` → `getUserIdFromRequest` → `sb.auth.getUser(token)`. production에서 JWT가 없으면 `return null` → 401 |
| 2 | 클라이언트는 **저장소에서 writer를 찾지 못한 키**를 읽는다 | `git log -S"setItem('sb_access_token'" --all` → production writer 0건. 걸린 커밋 4개는 전부 프로브용이었고 이미 제거됨 |
| 3 | 비어 있으면 **요청 전에 멈춘다** | 읽는 4곳 전부 `if(!tok) return` |

정리하면 — **저장소 역사에서 production writer를 찾지 못했고, 정상
production app flow에서는 legacy key가 채워지지 않아 base 재현에서 Global
Stop이 GET/PATCH 전에 종료됐다.**

표현을 여기까지만 쓰는 이유가 있다. 코드 감사로 배제한 것은 **저장소 안의
writer**까지다. 수동 `localStorage` 주입이나 저장소 밖 경로로 그 키가
채워지는 경우까지 확인한 것은 아니다. 그런 환경에서는 예전 코드도 서버에
닿았을 수 있다. **확인하지 못한 것을 확인한 것처럼 적지 않는다.**

브라우저로 잰 사실은 그대로 강하게 적는다 — base `d614dfb`의
canonical-session fixture에서 버튼을 누른 뒤 **GET 0회 · PATCH 0회**를
재현했다.

표시용 카드(`AutotradeControl`)는 정본 Supabase 세션을 쓰므로 화면은 예약을
정확히 그렸다. 그래서 **"화면은 멀쩡한데 정지만 안 되는"** 형태로 숨어
있었다.

한 가지는 분명히 해 둔다 — **화면이 "전부 껐다"고 거짓말하지는 않았다.**
`globalStop` 모듈이 서버 확인 없이는 UNVERIFIED로 적는다. 그 계약이
사고를 한 단계 막아 주고 있었다. 고장은 "거짓 보고"가 아니라 "정지가
동작하지 않음"이다.

## 실측 — 같은 프로브, 같은 fixture

버튼을 누른 **뒤에 늘어난** 요청만 전체정지의 몫으로 센다. 표시용 카드도
같은 GET을 쓰기 때문이다.

| | base (`d614dfb`) | head |
|---|---|---|
| 전체정지 후 GET | **0회** | 3회 |
| 전체정지 후 PATCH | **0회** | **2회** (켜져 있던 예약 수) |
| PATCH 인증 헤더 | 나간 요청 없음 | `Bearer …` (정본) |
| 표시용 카드 인증 | `Bearer …` (정본) | `Bearer …` (정본) |
| 결과 문장 | "자동매매 예약을 읽지 못했습니다 — 무엇이 돌고 있는지 확인하지 못했습니다" | "예약 2개를 껐고, **다시 확인하니 켜져 있는 예약이 없습니다**" |

base 열의 "표시용 카드 인증 = 정본"이 핵심이다. 로그인은 정상이었고
전체정지만 닿지 못했다.

## 고친 방법

읽기와 쓰기가 **같은 정본 경로**를 쓴다 — `lib/auth/authToken`.

```ts
const auth = await probeAuthToken();
if (auth === null) return { ok:false, rows:[], reason:'로그인 상태를 확인하지 못했습니다' };
if (!auth)         return { ok:false, rows:[], reason:'로그인이 필요합니다' };
fetch('/api/autotrade/schedule', { headers: { Authorization: auth }, cache:'no-store' })
```

`readAuthToken`이 아니라 `probeAuthToken`을 쓰는 이유가 있다. 이쪽은 셋을
구분한다.

```
'Bearer …'  로그인돼 있다
''          확실히 로그인 안 돼 있다
null        확인하지 못했다
```

안전 경로에서 `null`을 `''`로 눕히면, 세션이 멀쩡한데 잠깐 못 읽은 것을
사용자가 로그인 문제로 오해한다. **확인하지 못한 것을 단정하지 않는다.**

## 검사기 (돌연변이 4/4 검출)

| 규칙 | 되돌리면 |
|---|---|
| legacy `sb_access_token`으로 인증하지 않는다 | FAIL |
| 읽기·쓰기 **양쪽 모두** 정본 토큰을 얻는다 | PATCH만 바꿔도 FAIL |
| `Bearer`를 한 번 더 붙이지 않는다 | FAIL (정본 값에 이미 들어 있다) |
| '확인 못 함'과 '로그인 안 됨'을 가른다 | FAIL |

함수 본문은 정규식이 아니라 인덱스로 잘라 온다 — 여러 줄 시그니처에서
타입 블록까지만 잡혀 본문을 못 보는 일을 이 저장소에서 이미 겪었다.

## 프로브를 두 번 고쳤다 — 두 번 다 프로브가 틀렸다

1. **포괄 라우트가 스케줄 호출을 삼켰다.** Playwright는 **나중에 등록한**
   라우트를 먼저 쓴다. `**/api/**`를 마지막에 걸어서 스케줄 라우트가 한 번도
   안 불렸고, "요청 0회"라는 **맞는 결론이 틀린 이유로** 나왔다. 포괄
   라우트를 맨 앞으로 옮겼다.
2. **`[role="status"]`가 첫 줄을 집었다.** 첫 줄(`ExecutionTruthHero`)도
   같은 role이라, 버튼을 누르지 않아도 문장이 잡혔다. 전체정지 결과 상자만
   고르도록 좁혔다.

## 건드리지 않은 것

- **서버 인증 로직** (`resolveUserId`·`getUserIdFromRequest`) — 그대로
- **`/api/autotrade/schedule`의 의미** — GET/PATCH 동작 변경 없음
- **정지 판정 규칙** (`globalStop.ts`의 `ALL_STOPPED`/`REMAINS`/`UNVERIFIED`)
- kill-switch backend · worker · scheduler · risk · migrations
- 같은 뿌리의 다른 증상 2건 — `HomePage`의 자동매매 계획 카드(86행)와
  지갑 개요(152행)도 같은 legacy 키를 읽는다. 안전 문제가 아니라 **표시
  실패**(빈 화면 / "로그인하면 실제 자산을 읽습니다")로 나타난다. 안전 PR에
  섞지 않고 별도로 남긴다.
- `scripts/check-undefined.mjs` CI 미배선 — 기존 툴링 부채, 별도 건

# UI-4B 자동매매 첫 화면 — 실행 진실 측정 결과

이 화면이 답해야 하는 질문은 하나다.

> **지금 내 돈이 실제로 자동으로 움직이고 있는가?**

| | |
|---|---|
| base | `c7e9365b7c3a605b7cc0524cf0f8af01413f5d37` (UI-4A 종료 main) |
| head | 이 PR의 마지막 커밋 |
| 화면 상태 | 5개 — `UNKNOWN` · `OFF` · `BLOCKED` · `UNCONFIRMED` · `ARMED` |
| 재현 상황 | 8개 (아래 표) |
| 뷰포트 | 10개 (PC 5 · 태블릿 2 · 모바일 3) |
| 칸 | 10 × 8 = **80** |

재현:

```bash
# 프로브 빌드 — 정본 로그인 경로를 재현하려면 Supabase 설정이 있어야 한다.
# 값은 scripts/probe/lib/auth.mjs가 들고 있다(실제 프로젝트가 아니다).
NEXT_PUBLIC_SUPABASE_URL=https://probe-local.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$(node -e "import('./scripts/probe/lib/auth.mjs').then(m=>console.log(m.PROBE_SUPABASE_ANON))")" \
  npx next build && npx next start -p 3900 &

node scripts/probe/auto-cockpit.mjs 3900 /tmp/out          # 10 뷰포트 × 8 상황
SHOT_PREFIX=base node scripts/probe/auto-cockpit.mjs 3901 /tmp/out   # base 쪽
node scripts/probe/auto-interaction.mjs 3900               # 상태 전이·조작
node scripts/probe/auto-cockpit-mutations.mjs 3900         # 프로브 자신 검증
node scripts/probe/auto-snapshot-stability.mjs 3900        # 발행이 멈추는가
node scripts/check-auto-cockpit.mjs                        # 소스 계약
```

## 무엇이 고장나 있었나

이 질문의 주인이 **둘**이었다.

| 주인 | 근거 | 결과 |
|---|---|---|
| `AutotradeControl` | 서버 예약·연결·실행기 | 실제 사실 |
| `AutoPage` | `useState<ExecMode>('paper')` | **서버를 부르지 않음** |

두 번째가 "모의 자동매매 모드 — **실제 자금 이동 없음**"이라고 단정했다.
기본값이 `paper`이므로, **실전 예약이 켜져 있어도 그렇게 적혔다.**
사용자가 가장 믿으면 안 되는 방향으로 틀린다.

그리고 캡처를 보다 하나가 더 나왔다 — 첫 줄이 `LIVE`인데 바로 아래 카드가
`자동매매 (테스트넷) TESTNET`이라고 말했다. `AutotradeControl`이 **읽기
실패를 빈 배열로 눕혀서** `headerEnvOf([])`의 기본값 TESTNET을 얻고 있었다.
같은 형태의 고장이 다른 소유자에 있었다.

## 판정을 한 곳으로

`src/lib/ui/autoCockpit.ts` — 서버가 이미 만든 사실만 조합한다.
새 판단을 만들지 않는다.

```
enabled · mode · connectionState · strategyRunnable · runtime.state
   (전부 /api/autotrade/schedule 이 줄마다 붙여 주는 값)
+ autotradeHealth()의 전역 관문 항목
환경 판정은 기존 autoOverview(headerEnvOf/envOf)를 그대로 쓴다.
```

**`RUNNING`이라는 상태 이름을 두지 않았다.** 이 화면이 증명할 수 있는 것은
"켜져 있고 막힌 것이 없다"(`ARMED`)까지다. 지금 이 순간 주문이 나가는
중인지는 다른 사실이고 그것을 말할 정본이 없다. 이름이 생기면 언젠가
`enabled`에 붙는다 — 검사기가 그 이름을 막는다.

| 화면 상태 | 뜻 | 환경 배지 | 개수 |
|---|---|---|---|
| `UNKNOWN` | 예약을 **못 읽었다**. 꺼짐이 아니다 | 없음 | `null` |
| `OFF` | 읽었고 켜진 예약이 없다 | 없음 | `0` |
| `BLOCKED` | 켜져 있지만 지금 주문이 나갈 수 없다 | 있음 | 실제 수 |
| `UNCONFIRMED` | 켜져 있는데 **나갈 수 있는지 확인하지 못했다** | 있음 | 실제 수 |
| `ARMED` | 켜져 있고 줄도 전역 관문도 전부 통과했다 | 있음 | 실제 수 |

## 재현한 8가지 상황 → 실제로 그린 것 (390×844 실측)

상태는 5개지만, **같은 상태로 떨어지는 서로 다른 원인**을 갈라서 재현한다.
`BLOCKED` 하나만 봐도 줄이 막힌 것·전역 관문이 막은 것·실전인데 목적지가
테스트넷인 것은 사용자가 해야 할 일이 전부 다르다.

| 프로브 상황 | 그린 상태 | 배지 | 첫 줄에 실제로 적힌 것 |
|---|---|---|---|
| `UNKNOWN` | `UNKNOWN` | 없음 | 자동매매 상태를 확인하지 못했습니다 · 로그인이 필요합니다 |
| `OFF` | `OFF` | 없음 | 켜져 있는 자동매매가 없습니다 · 등록된 예약 1개가 모두 꺼져 있습니다 |
| `ARMED_TESTNET` | `ARMED` | TESTNET | 테스트넷 자동매매가 켜져 있습니다 · 예약 2개 |
| `ARMED_LIVE` | `ARMED` | **LIVE** | 실전 자동매매가 켜져 있습니다 — **실제 돈이 나갈 수 있습니다** · 예약 2개 (실전 1개 포함) |
| `LIVE_WRONG_DEST` | `BLOCKED` | LIVE | 안전 점검이 막고 있습니다 · 막힌 이유: **연결 목적지** |
| `BLOCKED` | `BLOCKED` | TESTNET | 지금은 주문이 나가지 않습니다 · 막힌 이유: 주 실행기가 12분째 응답이 없습니다 |
| `GATE_BLOCKED` | `BLOCKED` | TESTNET | 안전 점검이 막고 있습니다 · 막힌 이유: **자동 실행 열쇠** |
| `UNCONFIRMED` | `UNCONFIRMED` | TESTNET | 실행 가능 여부를 **확인하지 못했습니다** · 확인하지 못한 점검 1개 |

`LIVE_WRONG_DEST`는 프로브를 만들다 나온 것이다. 처음에는 fixture가
LIVE 예약을 **테스트넷 연결**에 물려 놓고 `ARMED`를 기대했다. 화면은
`BLOCKED`를 그렸고, 그게 맞다 — fixture가 틀렸다. 그대로 지우지 않고
"실전인데 목적지가 테스트넷"이라는 별도 상황으로 남겼다.

## 상태 × 뷰포트

10 뷰포트 × 8 상황 = **head 80/80 통과 · base 0/80.**

각 칸에서 확인한 것:

- `data-state`·`data-env`가 기대와 같은가
- 첫 줄이 **스크롤 없이** 보이는가
- 첫 줄보다 위에 있는 상주 카드가 0인가 (진단이 진실을 밀어냈는가)
- 다른 조작 요소와 겹침 0
- 40px 미만 조작 대상 0
- body 가로 넘침 0 · 화면 밖 이탈 0
- **6가지 답이 첫 Fold 안에 내용까지 있는가** — 환경 · 개수 · 실행 가능
  여부 · 대상 · 마지막 판단 · 막는 것. 켜진 예약이 있는 6개 상황에서는
  6/6, `UNKNOWN`·`OFF`에서는 지어내지 않는 것이 맞으므로 2/2를 본다.

base는 `[data-region="executionTruth"]` 자체가 없어 80칸 전부 실패다 —
그 화면에는 이 질문에 답할 자리가 없었다.

첫 줄의 위치·높이(head, `ARMED_LIVE`):

| 뷰포트 | top | 높이 | 첫 화면 안 |
|---|---|---|---|
| 1366×768 | 107 | 123 | ✓ |
| 1440×900 | 109 | 123 | ✓ |
| 1664×936 | 109 | 123 | ✓ |
| 1920×1080 | 109 | 123 | ✓ |
| 2560×1440 | 109 | 123 | ✓ |
| 1024×768 | 107 | 123 | ✓ |
| 834×1194 | 107 | 123 | ✓ |
| 430×932 | 103 | 149 | ✓ |
| 390×844 | 139 | 168 | ✓ |
| 360×800 | 139 | 168 | ✓ |

전체 수치는 `state-base.json` · `state-head.json`.

## 스냅샷 서명 — 원본 필드를 나열하지 않는다

읽는 곳을 하나로 합치면서, 카드가 읽은 스냅샷을 화면 위로 올리게 했다.
부모가 중복 갱신을 막으려면 "같은 값인가"를 물어야 하는데, `autotradeHealth()`는
렌더마다 새 배열을 준다. 참조로 비교하면 값이 안 바뀌어도 늘 "달라졌다"가
된다.

처음 서명은 `enabled`·`mode`·`connectionState`·`runtime.state`처럼 **입력
필드를 손으로 나열**했다. 그 방식은 조용히 어긋난다 — 화면 결과를 바꾸는데
목록에 없는 필드가 생기면 값이 바뀌어도 서명은 그대로다. 실제로 다섯 자리가
빠져 있었다.

| 빠진 자리 | 화면에서 바뀌는 것 |
|---|---|
| `runtime.lastEvaluationAtMs` | 어느 줄이 '마지막 판단'인지 |
| `connectionNote` | 막힌 사유 문구 |
| `strategyNote` | 전략 사유 문구 |
| health의 `label` | 첫 줄에 뜨는 막은 항목 이름 |
| 같은 `id`에서 `symbol` 변경 | 대상과 정지 라벨 |

그래서 입력이 아니라 **부모가 실제로 관찰하는 결과**로 서명을 만든다.
이 화면에서 스냅샷의 소비자는 정확히 둘이다 — 첫 줄이 그리는 전부인
`cockpitVerdict(rows, err, health)`와, 켜진 예약 수·정지 대상인
`stopTargets(rows)`. 둘의 결과를 직렬화하므로 목록을 갱신하는 것을 잊을
자리가 없다.

시각 자체는 넣지 않는다. `lastEvaluationAtMs`가 흘러도 최신 판단이 그대로면
같은 서명이고, 최신 판단이 BTC→ETH로 넘어갈 때만 달라진다.

**양방향으로 못박았다.**

- 옛 구현(원본 필드 나열)으로 되돌리면 **기존 서명 시험 5건은 전부 통과**하고
  새 시험 5건만 실패한다 — 거짓 통과를 그대로 재현했다.
- 반대로 타임스탬프를 무조건 서명에 넣으면 "시각이 흘러도 최신 판단이 같으면
  같은 서명" 쪽이 깨진다.
- 의미가 같은 새 객체·새 배열은 여전히 같은 서명이다(중복 갱신 차단이라는
  원래 목적).

## 인증 — 합친 것과 합치지 않은 것

**합친 것은 자동매매 화면 표시용 예약 목록을 읽는 주인 하나다.** 첫 줄과
아래 카드가 각자 `/api/autotrade/schedule`을 부르던 것을 `AutotradeControl`
하나로 모았다. 그 주인은 정본 경로(`lib/auth/authToken` → Supabase 세션)만
쓴다.

**합치지 않은 것은 전체정지의 인증 경로다.** `AutoPage.loadSchedules`와
전체정지 PATCH는 아직 `localStorage.sb_access_token`을 직접 읽는다. 그런데
저장소 전체에서 **그 키에 쓰는 코드는 한 곳도 없다**(읽는 곳 5, 쓰는 곳 0).
즉 그 경로는 실제로는 빈 Bearer로 나간다. 화면 정리가 아니라 안전 문제이므로
이 PR에 섞지 않고 **별도 안전 blocker**로 분리한다 —
`SAFETY BLOCKER — Global Stop authentication`.

### 프로브용 우회를 제품에 남기지 않는다

한 번은 이렇게 해결했었다.

```ts
watchAuthToken(t => setAuth(t || localStorageToken()))   // ← 되돌렸다
```

이유는 "프로브 환경에 Supabase 설정이 없어 세션을 재현할 수 없다"였다.
그건 제품 코드가 프로브의 사정을 떠안은 것이다. 검증되지 않은 인증 경로가
제품에 영구히 남고, 정본 경로가 고장 나도 프로브는 계속 초록으로 나온다 —
없애야 할 실패 지점을 자동화로 덮는 꼴이다.

그래서 제품이 아니라 **환경**을 바꿨다(`scripts/probe/lib/auth.mjs`).

- 프로브 빌드에만 `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY`를 준다
- 브라우저에는 supabase-js가 스스로 쓰는 저장소 키에 세션을 심는다.
  키는 URL에서 계산한다(`sb-${hostname.split('.')[0]}-auth-token`) — URL을
  바꾸면 키도 따라간다
- 화면은 평소와 똑같이 `lib/auth/authToken` → `getSession()`을 탄다.
  **제품에 프로브용 분기가 하나도 없다**
- `blockAuthHost`로 그 호스트로 나가는 요청을 전부 막는다

실측(프로브 빌드, `localhost`):

| | |
|---|---|
| `/api/autotrade/schedule`이 받은 헤더 | `Bearer probe.access.token` |
| `localStorage.sb_access_token` | 없음 (정본 경로에서만 나왔다) |
| `supabase.co` 응답 수신 | **0** |
| `supabase.co` 요청 차단 | 7 (`net::ERR_FAILED`) |

## 조작 (7/7)

문서에는 원래 "7건 전부 통과"라고만 적혀 있었다. 다시 돌려 보니 **2건이
FAIL**이었다.

```
✗ 로딩 중 → 로딩 후   기대 ARMED/LIVE, 실제 BLOCKED/LIVE
✗ 로컬 "모의" 토글     세 조건은 다 맞는데 state가 ARMED가 아니었다
```

화면이 아니라 fixture가 틀렸다. 전역 관문 판정을 첫 줄에 붙인 뒤
cockpit 프로브의 fixture는 관문에 맞게 고쳤지만 **interaction 프로브의
fixture는 옛날 그대로**였다. 관문이 없는 응답이니 `BLOCKED`가 맞고, 화면은
옳게 그리고 있었다. LIVE 예약이 테스트넷 연결에 물려 있던 것도 같이 나왔다 —
그건 '연결 목적지'가 막는 것이 옳다.

같은 판단이 두 파일에 있으면 언젠가 갈린다. 실제로 갈렸다. 그래서 fixture는
`scripts/probe/lib/fixtures.mjs` 하나에 두고 네 프로브가 전부 그것을 쓴다.
한 항목을 일부러 뒤집는 것(`adminSecretSet: false` 같은)은 그 프로브의
시나리오이므로 그대로 둔다. 검사기가 이 규칙을 지킨다.

아래 7건은 **그 수정 뒤에 실제로 돌린 값**이다.

| | 확인한 것 |
|---|---|
| 로딩 중 → 완료 | 응답이 늦는 동안 `OFF`로 새지 않는가 (`UNKNOWN` → `ARMED/LIVE`) |
| 테스트넷 → 실전 추가 | 첫 줄이 `TESTNET` → `LIVE`로 바뀌는가 |
| **로컬 "모의" 토글** | 실전 첫 줄을 덮지 못하는가 (`LIVE` → `LIVE`, "실제 자금 이동 없음" 문구 없음) |
| 막힌 예약 | 사유가 보이고 "실행중"이라 쓰지 않는가 |
| 읽기 실패 | `UNKNOWN`이고 "켜져 있는 자동매매가 없습니다"라 하지 않는가 |
| 모바일 390 | 스크롤 없이 첫 줄 전체가 보이는가 |
| **모순** | 한 화면이 두 실행환경을 주장하지 않는가 |

## 검사기를 네 번 고쳤다 — 네 번 다 내 검사기·fixture가 틀렸다

프로브를 만들면서 나온 거짓 신호들이다. 그대로 뒀으면 **켜져 있는 것처럼
보이면서 아무것도 확인하지 않는 검사기**가 됐다.

1. **정상(변형 없음)이 FAIL로 나왔다.** 온보딩 언어 선택이 남아 그 버튼이
   첫 줄과 겹쳤다. 그 상태에서는 다른 돌연변이도 의도한 신호가 아니라 그
   겹침 때문에 잡힌다 — 실제로 M11이 그렇게 잡혔다.
2. **`body`에 3000px 요소를 넣는 변형이 안 잡혔다.** 앱 래퍼의
   `overflow-x:hidden`이 잘라서 body 넘침으로는 안 보인다. 사용자가 보는
   것은 '잘려서 안 보이는 내용'이므로 뷰포트 밖으로 나간 요소를 세는
   지표(`escaped`)를 추가했다.
3. **그래도 안 잡혔다.** `width: 3000px`이 366px로 눌리고 있었다 —
   모바일의 `* { max-width: 100% }`가 이미 막아 준다(실측 3000 → 366).
   검사기를 검증하려면 그 보호가 막지 못하는 경로(`min-width`)로 밀어야
   했다. 앱의 보호가 실제로 동작한다는 사실도 함께 확인됐다.

4. **조작 2건이 FAIL로 돌아섰다.** 관문 판정을 첫 줄에 붙인 뒤 cockpit
   프로브의 fixture만 고치고 interaction 프로브의 fixture는 그대로 뒀다.
   화면은 옳았고 fixture가 낡아 있었다. fixture를 한 파일로 모았다.

지표를 바꿨으므로 80개 칸을 **base·head 모두 같은 자로 다시 쟀다.**

## 화면 캡처 — `shots/`

파일 이름이 `{base|head}-{뷰포트}-{상황}.jpg`다. 손으로 이름을 바꾸지
않는다 — `SHOT_PREFIX=base`가 접두어를 정한다.

head는 캡처하는 6개 상황 × 10 뷰포트 = **60장 전부**다. base는 80칸이 전부
같은 이유(첫 줄이 아예 없음)로 실패하므로 대표 14장만 둔다 — base 80칸의
수치는 `state-base.json`에 전부 있다.

**기하 수치의 정본은 `state-*.json`이고 캡처는 눈으로 보는 용도다.** 그래서
PNG(120장 18MB)를 JPEG 품질 82로 다시 인코딩했다(74장 6.6MB). 저장소 팩이
10MB인데 캡처 한 벌이 그보다 커지면, 다음 단계마다 저장소가 두 배씩 는다.

## 이번에 하지 않은 것

- **전체정지 인증 경로 통합** — 별도 안전 blocker (위 참조)
- exposure · 계좌 PnL · 체결(fill) 표시 — UI-4B 감사에서 콕핏이 소비할
  정본 경로를 찾지 못했다. **0으로 채우지 않고 그리지 않았다.**
- 킬 스위치 표시 — 정본이 셋(브라우저 / 프로세스 메모리 / Supabase)이고
  실제로 주문을 막는 것은 Supabase 쪽 하나다. 배선은 별도 단계다.
- Redis · SafeQuantizer · Zustand · Pine · 성능 — 후속 백로그.

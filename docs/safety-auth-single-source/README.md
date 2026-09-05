# 홈의 두 카드가 서버에서 값을 읽지 못하고 있었다

`#242`에서 전체정지를 고치며 같은 뿌리를 남겨 뒀다 — 화면 네 곳이
`localStorage.sb_access_token`을 읽었고, 그중 둘이 홈에 있었다.

| | |
|---|---|
| base | `6402c87137950b57dc3185b7c8289094df75ce64` (#242 종료 main) |
| 재현 | `node scripts/probe/home-auth.mjs <port>` |
| 검사기 | `scripts/check-legacy-auth-key.mjs` (CI 배선) |

## 뿌리는 하나, 증상은 자리마다 달랐다

저장소 역사에서 그 키를 쓰는 production writer를 찾지 못했다
(`git log -S"setItem('sb_access_token'" --all` → 0건). 정상 production app
flow에서는 채워지지 않으므로 읽는 쪽은 값을 못 얻고 요청 전에 종료한다.

| 자리 | 종료 후 화면에 남는 것 |
|---|---|
| 전체정지 (#242에서 해결) | 버튼을 눌러도 GET·PATCH가 나가지 않는다 |
| **홈 자동매매 카드** | 아무 상태도 세우지 않고 반환 → 라벨이 **영구히 '읽는 중…'** |
| **홈 지갑 개요** | **로그인한 사용자에게** '로그인하면 실제 자산을 읽습니다' |

자동매매 카드 쪽이 더 나쁘다. 실패를 실패로 적지 않고 **아직 읽는 중인
척한다.** 사용자는 기다리면 뜰 것이라고 생각한다.

```ts
const tok = localStorage.getItem('sb_access_token') || '';
if (!tok) return;              // ← autoPlan도 autoErr도 그대로다
```

## 실측 — 같은 프로브, 같은 fixture

| | base (`6402c871`) | head |
|---|---|---|
| `GET /api/autotrade/schedule` | **0회** | 1회 |
| `GET /api/wallets/overview` | **0회** | 1회 |
| 자동매매 카드 | `자동매매 읽는 중… 탭하여 자동매매 시작` | `자동매매 실행중 예약 1개가 조건을 기다립니다` |
| "로그인하면 실제 자산을 읽습니다" | 떠 있다 | 없다 |
| 요청 인증 | 나간 요청 없음 | `Bearer …` (정본) |

## 고친 방법

두 곳 다 정본 경로(`lib/auth/authToken`)의 `probeAuthToken()`을 쓴다.
셋을 구분하는 것이 핵심이다.

```
'Bearer …'  로그인돼 있다        → 읽는다
''          확실히 로그인 안 됨   → "로그인하면 …"
null        확인하지 못했다       → "확인하지 못했습니다"
```

자동매매 카드에는 `autoOut`(확실히 로그아웃) 상태를 따로 뒀다. 기존
`autoErr`('확인 못 함')와 **다른 말**이기 때문이다. 그리고 어느 경우든
**조용히 반환하지 않는다** — 영구 '읽는 중…'이 다시 생기지 않게.

숫자를 지어내지 않는 기존 계약은 그대로다. 못 읽으면 '확인하지
못했습니다'이고, 0으로 채우지 않는다.

## 검사기

제품 코드(`src/`)에서 그 키를 **읽는 코드**가 다시 생기면 실패한다.
주석은 통과시킨다 — 옛 방식을 설명하는 기록까지 막으면 왜 그렇게 됐는지
남길 수 없다. 그래서 주석을 걷어낸 뒤 검사한다.

| 돌연변이 | 결과 |
|---|---|
| HomePage에 legacy 키 복귀 | FAIL ← 검출 |
| 다른 파일에 legacy 키 추가 | FAIL ← 검출 |
| 주석 안의 언급 (허용돼야 함) | PASS ← 의도대로 |

## 이번에 하지 않은 것

- 서버 인증 로직 · API 의미 · kill-switch backend · worker · scheduler ·
  risk · migrations
- `scripts/check-undefined.mjs` CI 미배선 — 기존 툴링 부채, 별도 건

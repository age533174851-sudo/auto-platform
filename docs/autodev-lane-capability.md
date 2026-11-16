# 무인 갈래가 **실제로 할 수 있는 일** (그리고 못 하는 일)

정본은 코드다 — `scripts/lib/autodev-delivery.mjs` 의 `LANE_FILE_TOOLS` ·
`READ_SCOPE` · `FENCE_PATHS_*` · `LANE_DENY_PATHS` 가 목록을 쥐고 있고,
`scripts/check-claude-hourly.mjs` 가 두 워크플로를 그 목록과 대조한다.
이 문서는 그것을 사람 말로 적은 것이다. **둘이 어긋나면 코드가 맞다.**

## 왜 이 문서가 필요한가

2026-11-03 부터 두 갈래는 **성공했는데 아무것도 내놓지 못했다.** 로그에는
`✅ 변경 없음` 만 남았다. 두 번 다른 이유였다:

1. **올릴 수 없었다** — 허용 목록에 `git push`·`gh pr create` 가 없었다.
   (2026-11-04, `scripts/autodev-submit.mjs` 로 해결)
2. **고칠 수 없었다** — 허용 목록에 `Read`·`Glob`·`Grep`·`Edit` 가 없었다.
   (2026-11-13, 이 변경)

둘 다 "고칠 것이 없었다" 와 구분되지 않는 모양으로 끝난다. 그래서 **무엇을
할 수 있는지 적어 두고, 검사기가 그 목록을 지킨다.**

## 할 수 있는 일

| | dev | trading |
|---|---|---|
| 읽기 (`Read`) | `src/` `scripts/` `worker/` `supabase/` `docs/` `public/` `.github/` + 최상위 설정 5개 | 같음 |
| 찾기 (`Glob`·`Grep`) | 범위 없음 — 아래 "아직 모르는 것" 참조 | 같음 |
| **고치기 (`Edit`)** | `src/**` · `scripts/**` | `src/**` · `scripts/**` · `worker/**` |
| 돌리기 | `npm test` · `npx tsc --noEmit` · `npm run build` · `worker:build` · `scripts/check-*.mjs` | 같음 + 100X 자기 점검 |
| 담기 | `git switch -c` · `git add` · `git commit` | 같음 |
| 올리기 | `node scripts/autodev-submit.mjs` 하나뿐 (Draft 고정, refspec 고정) | 같음 |

## 못 하는 일 — 그리고 그게 왜 울타리인가

**새 파일을 만들 수 없다.** `Write` 를 열지 않았다. `Edit` 는 **이미 있는
파일만** 고친다. 그래서 첫 회차가 할 수 있는 수정은 이런 모양이다:

- 기존 소스의 버그 수정
- **이미 있는** `*.test.ts` 에 시험 케이스 추가
- 기존 검사기(`scripts/check-*.mjs`)의 판정 보강
- 기존 문서 갱신

할 수 없는 모양:

- 새 모듈 파일 추가
- 새 시험 파일 추가 (→ 기존 시험 파일에 케이스를 더하는 쪽으로 좁혀야 한다)
- 새 검사기 추가

`Write` 를 여는 것은 **별도 승인 사항**이다. 필요하다는 증거(회차가 실제로
새 파일이 필요해서 막힌 run 로그)가 생기면 그때 올린다. 지금은 증거가
없고, 증거 없이 여는 것은 울타리를 넓히는 것이다.

**울타리 파일은 못 고친다.** 두 hourly 워크플로 · `scripts/autodev-submit.mjs` ·
`scripts/lib/autodev-delivery.mjs` · `supabase/migrations/**` · `.env` 류.
세 겹으로 막는다: 허용 목록이 표현 못 함(바깥) → 정확한 경로 금지(안쪽) →
`check-autodev-safety` 가 실제 diff 를 봄.

**dev 갈래는 거래 엔진에 손대지 못한다.** `src/lib/engine|strategies|exchanges|
smoke|execution|risk|backtest` · `worker/`. 그 수정은 trading 갈래에서,
더 센 검증을 받고 한다.

**병합·배포·주문·운영 DB·시크릿·`gh workflow run`·force push 는 전부 막혀 있다.**

## 아직 모르는 것 (0 으로 적지 않는다)

1. **`Glob`·`Grep` 의 경로 범위** — 그 둘에 경로를 줄 수 있는지 공식 문서에서
   확인하지 못했다. 그래서 범위 없이 두었고, **저장소 밖 파일 이름·내용을
   훑을 수 있는지는 UNKNOWN** 이다. 내용을 꺼내는 `Read` 는 범위를 적었으므로
   꺼내 가는 길은 좁지만, 이 자리를 "막았다"고 적지 않는다.
   검사기가 매 회차 `⚠️ 아직 모르는 것` 으로 같이 찍는다.
2. **심링크** — 울타리 밖을 가리키는 심링크는 재지 못했다. 만들려면 `ln` 이
   필요하고 그것은 Bash 허용 목록에 없지만, 그것이 증명은 아니다.
3. **`:*` 등가의 정확한 뜻** — 문서의 서술이 두 가지로 읽힌다. 그래서 금지된
   모양을 대조할 때 **두 읽기를 모두** 재고 어느 한쪽에서라도 통과하면
   실패로 센다.
4. **무인 실증** — 실제 회차가 파일을 열어 고치고 Draft PR 을 올리는 것을
   run 로그로 **본 적이 없다.** 그 전까지 "자동 개발 복구" 로 적지 않는다.
   지금까지 확인된 것은 (가) 검사기가 변이를 막는다 (나) 권한 흐름이 코드
   수준에서 끊기지 않는다, 둘뿐이다.

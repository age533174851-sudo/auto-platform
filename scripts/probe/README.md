# 거래화면 기하 검사 (수동 실행)

브라우저를 띄워 **실제 렌더 결과**를 잰다. CI에는 넣지 않는다 —
Playwright가 이 저장소의 의존성이 아니고, UI 검증 하나 때문에 무거운
의존성을 추가하지 않는다. 대신 소스 계약은 `scripts/check-trading-layout.mjs`가
CI에서 지킨다.

## 왜 필요한가

`npm test`가 초록이고 `next build`가 성공해도 화면은 깨질 수 있다.
실제로 그랬다 — 1664×936에서 주문판이 301px로 눌려 라벨과 값이 겹쳤고,
종목 레일의 "종목 · 거래대금"은 폭 10px에 글자가 세로로 쌓였다.
CI는 전부 초록이었다.

## 쓰는 법

```bash
npm run build
npx next start -p 3900 &
node scripts/probe/trading-geometry.mjs 3900 head /tmp/shots
node scripts/probe/trading-mutations.mjs 3900     # 검사기 자체 검증
```

세 번째 인자는 결과 JSON·스크린샷을 남길 디렉터리다.
네 번째 인자로 뷰포트 하나만 지정할 수 있다 (`1664x936`).

## 무엇을 재는가

- `bodyOverflow` — 문서 전체 가로 넘침 (0이어야 한다)
- `persistentOverlaps` — 상주 영역끼리 의도치 않은 겹침
- `orderOverlaps` / `headerOverlaps` — 주문판·상단바 **내부** 글자 겹침
- `clipping` — 종목 패널 핵심 정보가 칸 밖으로 잘림
- `wordBreaks` — 한국어 단어가 줄 **중간**에서 끊김
- `escapes` — 조작이 뷰포트 밖으로 나감
- 데스크톱 배치에서 주문 >= 340px · 중앙 >= 560px

## 잘못 재기 쉬운 두 가지 (실제로 겪음)

1. **겹침을 bounding box로 재면 안 된다.** 줄바꿈된 인라인 요소는
   `getBoundingClientRect()`가 모든 줄을 덮는 상자를 돌려준다. 실제로는
   나란히 있는데 겹친 것으로 나온다. `getClientRects()` 줄 조각으로 본다.
2. **단어 끊김을 Range로 재면 안 된다.** 이미 끊긴 단어는 좁게 접힌
   상자를 돌려주므로 "칸에 들어간다"로 나온다. 글꼴로 계산한 고유 폭
   (`canvas.measureText`)과 칸 폭을 비교한다.

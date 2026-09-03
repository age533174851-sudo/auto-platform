# UI-3C 거래화면 기하 측정 결과

`scripts/probe/trading-geometry.mjs`가 실제 렌더에서 잰 값이다.
같은 검사기로 base와 head를 각각 빌드해 측정했다.

| | |
|---|---|
| base | `92c01760804a05ea92b46bdc44bed4b766093551` (UI-3B 종료 main) |
| head | 이 PR |
| 뷰포트 | 10개 (PC 5 · 태블릿 2 · 모바일 3) |

재현:

```bash
npm run build && npx next start -p 3900 &
node scripts/probe/trading-geometry.mjs 3900 head docs/ui-3c
```

## 읽는 법

- `kind` — desktop / tablet / mobile 중 어떤 배치인가
- `rects.chart.w` · `rects.order.w` — 중앙 차트와 주문판의 실제 픽셀 폭
- `orderOverlaps` / `headerOverlaps` — 주문판·상단바 **내부** 글자 겹침 수
- `wordBreaks` — 한국어 단어가 줄 중간에서 끊긴 곳
- `bodyOverflow` — 문서 전체 가로 넘침
- `clipping` · `escapes` — 칸 밖 잘림 · 뷰포트 이탈

`base.json`에서 834 이하 뷰포트의 `kind`가 `desktop`으로 적힌 것은
**측정 한계**다. base에는 배치를 알리는 `data-region="tradingShell"`
표식이 없어서 검사기가 분류하지 못했다. 그 폭에서 base는 실제로
MobileShell을 그리고 있었다(`tierOf(window.innerWidth) < 900`).
1024×768은 그렇지 않다 — 거기서는 base가 데스크톱 3열을 그렸고
주문판이 151px였다.

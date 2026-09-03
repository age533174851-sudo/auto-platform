# UI-3C 거래화면 기하 측정 결과

`scripts/probe/trading-geometry.mjs`가 실제 렌더에서 잰 값이다.
같은 검사기로 base와 head를 각각 빌드해 측정했다.

| | |
|---|---|
| base | `92c01760804a05ea92b46bdc44bed4b766093551` (UI-3B 종료 main) |
| head | 이 PR |
| 뷰포트 | 10개 (PC 5 · 태블릿 2 · 모바일 3) |
| 화면 캡처 | `shots/` — base 10장 · head 10장 · 뉴스 열기 전후 4장 |

재현:

```bash
npm run build && npx next start -p 3900 &
node scripts/probe/trading-geometry.mjs 3900 head docs/ui-3c   # 기하
node scripts/probe/trading-interaction.mjs 3900                 # 조작
node scripts/probe/trading-mutations.mjs 3900                   # 검사기 자체 검증
```

## 전후 비교

| 뷰포트 | base 배치 | base 차트 | base 주문 | base 결함 | head 배치 | head 차트 | head 주문 | head 결함 |
|---|---|---|---|---|---|---|---|---|
| 1366x768 | desktop | 460 | 226 | 넘침0 영역겹침0 글자겹침15 잘림0 단어끊김2 | desktop | 684 | 340 | 0 |
| 1440x900 | desktop | 490 | 240 | 넘침0 영역겹침0 글자겹침9 잘림0 단어끊김2 | desktop | 602 | 340 | 0 |
| 1664x936 | desktop | 613 | 301 | 넘침0 영역겹침0 글자겹침7 잘림0 단어끊김0 | desktop | 574 | 340 | 0 |
| 1920x1080 | desktop | 754 | 370 | 0 | desktop | 830 | 340 | 0 |
| 2560x1440 | desktop | 1106 | 543 | 0 | desktop | 1470 | 340 | 0 |
| 1024x768 | desktop | 404 | 151 | 넘침0 영역겹침0 글자겹침18 잘림0 단어끊김0 | tablet | 318 | 437 | 0 |
| 834x1194 | desktop | 258 | 355 | 0 | tablet | 258 | 355 | 0 |
| 430x932 | desktop | 181 | 248 | 0 | mobile | 181 | 248 | 0 |
| 390x844 | desktop | 164 | 225 | 0 | mobile | 164 | 225 | 0 |
| 360x800 | desktop | 151 | 208 | 0 | mobile | 151 | 208 | 0 |

데스크톱 판정 기준은 중앙 차트 ≥ 560px · 주문판 ≥ 340px이다.
base는 10곳 중 2곳(1920 · 2560)만 그 기준을 만족했다.

## 읽는 법

- `kind` — desktop / tablet / mobile 중 어떤 배치인가
- `rects.chart.w` · `rects.order.w` — 중앙 차트와 주문판의 실제 픽셀 폭
- `orderOverlaps` / `headerOverlaps` — 주문판·상단바 **내부** 글자 겹침 수
- `wordBreaks` — 한국어 단어가 줄 중간에서 끊긴 곳
- `bodyOverflow` — 문서 전체 가로 넘침
- `clipping` · `escapes` — 칸 밖 잘림 · 뷰포트 이탈

`geometry-base.json`에서 834 이하 뷰포트의 `kind`가 `desktop`으로 적힌 것은
**측정 한계**다. base에는 배치를 알리는 `data-region="tradingShell"`
표식이 없어서 검사기가 분류하지 못했다. 그 폭에서 base는 실제로
MobileShell을 그리고 있었다(`tierOf(window.innerWidth) < 900`).
1024×768은 그렇지 않다 — 거기서는 base가 데스크톱 3열을 그렸고
주문판이 151px였다.

## 뉴스 레일을 열었을 때

우선순위가 가장 낮은 뉴스를 열었다고 차트와 주문판이 물러나면 순서가
거꾸로다. 1440에서 레일을 **칸**으로 열면 매매 영역이 900px가 되어
데스크톱 배치가 성립하지 않았다(실측: 열자마자 tablet으로 떨어졌다).

그래서 폭이 정말 남는 화면에서만 칸으로 열고, 모자라면 겹쳐서 연다.
기준은 화면 폭 숫자가 아니라 **"칸으로 열고도 매매 최소폭이 남는가"**이다
(`railPresentationFor`).

| 뷰포트 | 여는 방식 | 초기 | 열기 1회 | 닫기 1회 |
|---|---|---|---|---|
| 1440×900 | 겹침 | desktop 차트602 주문340 | desktop 차트602 주문340 | desktop 차트602 주문340 |
| 1366×768 | 겹침 | desktop 차트684 주문340 | desktop 차트684 주문340 | desktop 차트684 주문340 |
| 1920×1080 | 칸 | desktop 차트830 주문340 | desktop 차트1082 주문340 | desktop 차트830 주문340 |
| 2560×1440 | 칸 | desktop 차트1470 주문340 | desktop 차트1722 주문340 | desktop 차트1470 주문340 |

세 단계 모두 body 가로 넘침 0, 종목 패널 모드 유지.
1920·2560은 처음부터 레일이 펼쳐져 있어 첫 클릭이 '닫기'가 된다.

겹쳐서 여는 동안 뉴스 레일이 주문판 오른쪽 일부를 가린다. 이것은 겹쳐
여는 방식의 성질이며, 같은 버튼을 한 번 더 누르면 즉시 걷힌다. 매매 영역
자체의 폭은 열기 전후로 바뀌지 않는다(`shots/head-1440x900-news-*.png`).

## 화면 캡처

| 뷰포트 | before | after |
|---|---|---|
| 1366×768 | `shots/base-1366x768.png` | `shots/head-1366x768.png` |
| 1440×900 | `shots/base-1440x900.png` | `shots/head-1440x900.png` |
| 1664×936 | `shots/base-1664x936.png` | `shots/head-1664x936.png` |
| 1920×1080 | `shots/base-1920x1080.png` | `shots/head-1920x1080.png` |
| 2560×1440 | `shots/base-2560x1440.png` | `shots/head-2560x1440.png` |
| 1024×768 | `shots/base-1024x768.png` | `shots/head-1024x768.png` |
| 834×1194 | `shots/base-834x1194.png` | `shots/head-834x1194.png` |
| 430×932 | `shots/base-430x932.png` | `shots/head-430x932.png` |
| 390×844 | `shots/base-390x844.png` | `shots/head-390x844.png` |
| 360×800 | `shots/base-360x800.png` | `shots/head-360x800.png` |

뉴스 레일: `shots/head-1440x900-news-collapsed.png` ·
`shots/head-1440x900-news-open.png` ·
`shots/head-1366x768-news-collapsed.png` ·
`shots/head-1366x768-news-open.png`

캡처의 차트가 비어 있는 것은 이 환경에 시세·차트 네트워크가 없기
때문이다. 배치 결함이 아니다.

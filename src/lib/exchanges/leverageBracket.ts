// src/lib/exchanges/leverageBracket.ts
//
// **leverageBracket 응답을 구간 표로 바꾸는 자리.**
//
// 왜 `binanceFutures.ts`에서 떼어 냈나
// ───────────────────────────────────
// 파싱 자체는 순수 함수인데, 그 파일은 서명·HTTP·`crypto`까지 들고 있어서
// 따로 컴파일할 수가 없다. 그래서 검사기가 **동작으로** 확인할 방법이
// 없었고, 결국 "소스에 그 단어가 있는가"라는 이름 검사로 남았다.
// 그 검사는 샜다 — 타입 별칭의 튜플 라벨에도 같은 단어가 있어서, 파서가
// 값을 버려도 통과했다.
//
// 떼어 내면 검사기가 가짜 응답을 넣고 결과를 볼 수 있다. 내용은
// 한 글자도 바꾸지 않았다.

export type BracketTier =
  [cap: number, mmr: number, maintAmount: number, notionalCoef?: number];

/**
 * 응답 한 줄을 구간 표로. **내보내는 이유는 검사기가 동작으로 보기
 * 위해서다** — 이름이 소스에 있는지로는 "필드를 읽는가"를 알 수 없다
 * (타입 별칭의 튜플 라벨에도 같은 단어가 있어서 실제로 샜다).
 */
export function parseBrackets(raw: any): BracketTier[] {
  const arr = Array.isArray(raw?.brackets) ? raw.brackets : [];
  // ★ **`notionalCoef`는 bracket 줄 안이 아니라 symbol 객체 최상위다.**
  //
  //   바이낸스 응답 모양:
  //     { symbol: 'BTCUSDT', notionalCoef: 1.5, brackets: [ {...}, ... ] }
  //
  //   예전 코드는 `brackets[i].notionalCoef`를 읽었다. 실제 응답에는 거기
  //   그런 칸이 없으므로 **언제나 undefined**였다 — 즉 "조정 배수를
  //   보존한다"고 적어 놓고 실제로는 계속 버리고 있었다. 더 나쁜 것은
  //   검사기 fixture도 같은 잘못된 모양을 넣고 있어서 둘이 같은 오해를
  //   공유한 채 초록이었다는 점이다.
  //
  //   계정-level 값이므로 **모든 구간에 같은 값**을 싣는다. 구간마다 다른
  //   값이 들어갈 자리가 아니다.
  const coefRaw = raw?.notionalCoef;
  const coef = coefRaw == null ? undefined : Number(coefRaw);
  return arr
    .map((b: any): BracketTier => [
      parseFloat(b.notionalCap),
      parseFloat(b.maintMarginRatio),
      parseFloat(b.cum ?? b.cumFastMaintenanceAmount ?? '0'),
      coef,
    ])
    .sort((a: BracketTier, b: BracketTier) => a[0] - b[0]);
}

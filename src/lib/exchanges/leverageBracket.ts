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
  return arr
    .map((b: any): BracketTier => [
      parseFloat(b.notionalCap),
      parseFloat(b.maintMarginRatio),
      parseFloat(b.cum ?? b.cumFastMaintenanceAmount ?? '0'),
      // ★ **계정별 브래킷 조정 배수를 버리지 않는다.**
      //
      //   예전에는 이 칸을 읽지도 않았다. 버린다는 것은 "조정이 없다"고
      //   가정하는 것과 같은데 우리는 그것을 확인한 적이 없다. 적용 방식을
      //   모르므로 **적용하지는 않고 보존만 한다** — 1이 아닌 값이 오면
      //   Exact100X 청산거리 판정이 막는다(liquidationDistance.ts).
      //   없는 응답에서는 undefined가 되어 지금 동작 그대로다.
      b?.notionalCoef == null ? undefined : Number(b.notionalCoef),
    ])
    .sort((a: BracketTier, b: BracketTier) => a[0] - b[0]);
}

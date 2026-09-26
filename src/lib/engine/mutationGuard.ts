// src/lib/engine/mutationGuard.ts
//
// **같은 자리에 두 번 주문하지 않는다 — 두 가지 다른 중복을 구분해서.**
//
// 중복은 한 종류가 아니다
// ───────────────────────
//   ① 회차 **안**의 중복
//      같은 계좌·종목·방향을 두 줄이 가리킨다. 한 실행 안에서 벌어지므로
//      메모리로 막을 수 있다. 이 파일이 그것이다.
//
//   ② 실행 **사이**의 중복
//      워커가 둘 떠 있거나, 느린 실행이 임차를 잃은 뒤 뒤늦게 깨어난다.
//      메모리로는 못 막는다 — 다른 프로세스다. 그건 임차(fence)와
//      `stillMine()` 확인이 막는다.
//
// **둘을 한 장치로 막으려 하면 둘 다 못 막는다.** 그래서 이 파일은 ①만
// 맡고, 그 사실을 이름으로 적는다(`fence`를 같이 받는 이유).
//
// 왜 fence를 같이 받는가
// ──────────────────────
// 표식이 "어느 권한 아래에서 이미 처리했는가"를 담아야, 임차가 바뀌면
// 표식이 자동으로 무의미해진다. 같은 프로세스가 임차를 새로 잡아 다시
// 도는 경우(갱신) 옛 표식으로 새 회차를 막으면 안 된다.
//
// 새 소유권 모델을 만들지 않는다
// ──────────────────────────────
// 키는 기존 `mutationKeyOf`(connectionId + symbol + side)를 그대로 쓴다.
// 전략별 소유권은 다른 문제이고 이 PR의 것이 아니다.

export interface MutationGuard {
  /**
   * 이 자리를 지금 처리해도 되는가.
   *
   * 처음이면 `true`를 돌려주고 표식을 남긴다. 이미 처리했으면 `false`다.
   * **부작용이 있다** — 묻는 것과 표시하는 것을 나누면, 그 사이에 또
   * 부르는 코드가 생긴다.
   */
  claim: (key: string) => boolean;
  /** 이번 회차에 이미 처리한 자리 수 */
  size: () => number;
  /** 이 표식이 어느 권한 아래의 것인가. 임차가 없는 배포면 null */
  fence: number | null;
}

/**
 * 한 회차짜리 중복 방지.
 *
 * 임차 번호가 다르면 **다른 회차**다 — 표식을 물려주지 않는다.
 */
export function mutationGuardFor(fence: number | null | undefined): MutationGuard {
  const done = new Set<string>();
  const f = typeof fence === 'number' && Number.isFinite(fence) ? fence : null;
  return {
    fence: f,
    size: () => done.size,
    claim: (key: string) => {
      const k = String(key ?? '');
      // **빈 키를 통과시키지 않는다.** 키를 못 만든 줄이 여럿이면 전부
      // 같은 자리로 보이거나 전부 다른 자리로 보인다 — 어느 쪽도 위험하다.
      if (!k) return false;
      if (done.has(k)) return false;
      done.add(k);
      return true;
    },
  };
}

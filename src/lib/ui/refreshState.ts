// src/lib/ui/refreshState.ts
//
// **갱신이 실패했다고 방금까지 보던 값을 지우지 않는다.**
//
// 무엇이 있었나
// ─────────────
// `PaperAutomationControl`은 15초마다 상태를 다시 읽고, 그 호출이 한 번
// 실패하면 `setStatus(null)`로 **잔고·체결 이력·반복 상태를 전부 지웠다.**
// 화면에는 "상태 확인 전"이 떴다.
//
// 두 가지가 동시에 틀렸다:
//
//   · 확인을 **했고** 실패한 것인데 "확인 전"이라고 적는다.
//   · 방금까지 보던 숫자가 사라진다. 사용자는 자기 모의 계좌가 비었거나
//     자동매매가 꺼진 것으로 읽을 수 있다 — 네트워크가 한 번 끊긴 것인데.
//
// 지우는 쪽이 오히려 숨기는 것이다
// ────────────────────────────────
// 값을 지우면 "지금 읽은 결과 비어 있음"과 구별되지 않는다. 낡은 값을
// **낡았다고 표시해서** 남겨 두는 것이 더 많은 정보를 준다.
//
// 신선도 판정은 여기서 하지 않는다
// ────────────────────────────────
// `FRESH`/`LAGGING`/`STALE`/`NONE`과 나이 표기는 이미
// `src/lib/engine/dataQuality.ts`에 있고 테스트가 붙어 있다. 그걸 다시
// 쓰면 두 벌이 되고 언젠가 갈린다. 이 파일은 **상태 전이만** 한다 —
// 언제 성공했고 지금 실패 중인지를 기록하고, 판정은 `assess()`에 넘긴다.

/** 화면이 들고 있는 것. `data`는 마지막으로 **성공한** 응답이다 */
export interface RefreshState<T> {
  data: T | null;
  /** 마지막 성공 시각(ms). 한 번도 성공하지 않았으면 null */
  okAt: number | null;
  /** 지금 보여 줄 오류 메시지. 없으면 빈 문자열 */
  error: string;
  /** 연속 실패 횟수. 한 번 끊긴 것과 계속 끊긴 것은 다르다 */
  failures: number;
}

export function refreshStart<T>(): RefreshState<T> {
  return { data: null, okAt: null, error: '', failures: 0 };
}

/** 성공 — 값과 시각을 갈아 끼우고 오류·실패 기록을 지운다 */
export function refreshOk<T>(data: T, nowMs: number): RefreshState<T> {
  return { data, okAt: nowMs, error: '', failures: 0 };
}

/**
 * 실패 — **`data`와 `okAt`을 그대로 둔다.**
 *
 * 이 한 줄이 이 파일의 이유다. 여기서 `data: null`을 돌려주면 다시 예전
 * 고장이 된다.
 */
export function refreshFailed<T>(prev: RefreshState<T>, message: string, _nowMs?: number): RefreshState<T> {
  return {
    data: prev.data,
    okAt: prev.okAt,
    error: message || '상태를 갱신하지 못했습니다',
    failures: prev.failures + 1,
  };
}

/** 로그아웃 등 "보여 줄 것이 없다"가 맞는 경우에만 비운다 */
export function refreshCleared<T>(): RefreshState<T> {
  return refreshStart<T>();
}

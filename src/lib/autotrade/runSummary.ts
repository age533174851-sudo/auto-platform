// src/lib/autotrade/runSummary.ts
//
// **못 돈 줄을 "확인 · 실패 0건"으로 세지 않는다.**
//
// 2026-11-14 사용자 화면에 이 둘이 **같이** 떠 있었다.
//
//   위:  자동매매 4개 중 2개가 막혀 있습니다
//        연결 다시 선택 필요 — 이 예약이 가리키는 거래소 연결이 더 이상 없습니다
//
//   아래: 켜져 있고 실제로 돌고 있습니다
//        마지막 실행 10:45 · ok — 4건 확인 · 진입 0건 · 실패 0건
//
// 둘 다 같은 4줄을 말한다. 하나는 "2개가 막혔다", 다른 하나는 "실패 0건".
// 사용자가 어느 쪽을 믿어야 하는지 알 방법이 없다.
//
// 왜 갈렸나
// ─────────
// 목록 API는 `scheduleConnState`로 판정한다. 실행기(`daily-ladder` GET)는
// 그 함수를 **부르지 않는다.** 실행기가 보는 것은 `evaluationLoop`의
// `NO_CONNECTION`뿐인데, 그건 연결 id가 **비어 있을 때만** 난다:
//
//     if (i.connectionId != null && String(i.connectionId).trim() === '')
//
// id가 적혀 있는데 그 행이 사라진 경우는 이 검사를 그냥 통과한다. 그
// 줄은 '간격이 안 됐다'로 건너뛰어지고, 건너뛴 것은 실패가 아니므로
// **ok로 집계된다.** 주문을 낼 수 없는 예약이 "실패 0건"에 들어간다.
//
// `CLAUDE.md`: 경로가 둘인데 한쪽만 고침. 그리고: UNKNOWN을 0으로 적지
// 않는다. 막힌 것도 0이 아니다.
//
// 그래서 세는 일을 여기 한 곳에 두고 시험을 붙인다.

export interface RunResultLike {
  /** 평가가 정상적으로 끝났는가 (건너뜀 포함) */
  ok?: boolean;
  /** 실제로 진입했는가 */
  executed?: boolean;
  /**
   * 애초에 돌 수 없는 상태인가 (연결이 사라졌다 등).
   *
   * **실패와 따로 센다.** 실패는 '해 봤는데 안 됐다'이고, 막힘은
   * '해 볼 수조차 없다'이다. 둘을 합치면 사용자가 거래소를 의심한다 —
   * 고칠 곳은 예약의 연결이다.
   */
  blocked?: boolean;
}

export interface RunSummary {
  checked: number;
  entered: number;
  failed: number;
  blocked: number;
  text: string;
}

/**
 * 크론 로그 한 줄.
 *
 * `checked`는 **읽은 줄 수**다(결과 배열 길이가 아니다). 읽기는 됐는데
 * 결과가 안 쌓인 경우를 "0줄이었다"로 눕히지 않기 위해서다.
 */
export function runSummary(results: RunResultLike[] | null | undefined, checked: number): RunSummary {
  const rs = Array.isArray(results) ? results : [];
  const blocked = rs.filter(r => r?.blocked === true).length;
  const entered = rs.filter(r => r?.executed === true).length;
  // 막힌 줄은 실패로 중복해서 세지 않는다.
  const failed = rs.filter(r => r?.ok !== true && r?.blocked !== true).length;
  const n = Number.isFinite(checked) ? Math.max(0, Math.trunc(checked)) : 0;
  const text = `${n}건 확인 · 진입 ${entered}건 · 실패 ${failed}건`
    // 0건이면 적지 않는다 — 평소 줄이 길어지면 진짜 있을 때 눈에 안 띈다.
    + (blocked > 0 ? ` · 막힘 ${blocked}건(연결 없음 — 예약의 연결을 다시 고르세요)` : '');
  return { checked: n, entered, failed, blocked, text };
}

/**
 * 이 예약이 **애초에 돌 수 있는 상태인가.**
 *
 * `scheduleConnState`가 내린 판정을 집계가 쓰는 모양으로 옮긴다.
 * 판정 자체는 거기 한 곳에 있다 — 여기서 다시 내리지 않는다.
 *
 * `UNKNOWN`(연결 목록을 못 읽음)은 **막힘이 아니다.** 못 읽은 것을
 * 막힘으로 적으면 멀쩡한 예약이 전부 빨개지고, 사용자는 멀쩡한 연결을
 * 다시 고른다. 0과 모름은 다른 값이다.
 */
export function blockedByConnection(
  state: 'OK' | 'STALE' | 'MISSING' | 'UNKNOWN' | null | undefined,
): { blocked: true; code: 'STALE_CONNECTION' | 'NO_CONNECTION' } | null {
  if (state === 'STALE') return { blocked: true, code: 'STALE_CONNECTION' };
  if (state === 'MISSING') return { blocked: true, code: 'NO_CONNECTION' };
  return null;
}

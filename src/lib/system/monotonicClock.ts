// src/lib/system/monotonicClock.ts
//
// **지속시간(duration)은 단조 시계로 잰다. 정본은 여기 하나다.**
//
// 왜 `Date.now()` 차가 아닌가
// ───────────────────────────
// epoch 시계는 NTP 보정으로 **뒤로 갈 수 있다.** 보정이 한 번 끼면 그
// 순간의 차가 음수가 되거나 몇 초씩 튄다. 그 표본으로 문턱을 유도하면
// **보정 한 번이 문턱을 바꾼다.**
//
// 그래서 나눈다:
//
//   epoch(`…AtMs`)      "언제 일어났는가" — provenance
//   duration(`…ElapsedMs`) "얼마나 걸렸는가" — 단조
//
// 두 값을 같은 칸에 담지 않고, 서로 빼지도 않는다.
//
// 못 재면 `null`이다
// ──────────────────
// 런타임이 `performance.now()`를 주지 않으면 **재지 않는다.**
// `Date.now()`로 대신하면 오염된 줄과 깨끗한 줄을 나중에 구분할 수
// 없다 — 섞인 분포보다 빈 칸이 낫다.

/** 지금 단조 눈금(ms). 못 쓰면 null */
export function monotonicNowMs(): number | null {
  const p = (globalThis as any)?.performance;
  return typeof p?.now === 'function' ? p.now() : null;
}

/**
 * 두 단조 눈금의 차(ms). **하나라도 없으면 null이고 0이 아니다.**
 *
 * 0으로 적으면 "가장 빠른 응답"으로 보인다 — 못 잰 것과 빠른 것은
 * 다른 사실이다.
 */
export function monotonicSpanMs(
  from: number | null | undefined, to: number | null | undefined,
): number | null {
  if (typeof from !== 'number' || typeof to !== 'number') return null;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return to - from;
}

/**
 * 구간 하나를 재는 작은 자.
 *
 * ★ **`await`를 추가하지 않는다.** 눈금 두 개를 찍을 뿐이다 — 재려다가
 *   ⑤A가 만든 "재검증과 전송 사이 await 0" 불변식을 깨면 안 된다.
 */
export function startSpan(now: () => number | null = monotonicNowMs) {
  const t0 = now();
  return {
    /** 지금까지 걸린 시간(ms). 못 재면 null */
    elapsedMs(): number | null { return monotonicSpanMs(t0, now()); },
    /** 시작 눈금. 다른 구간의 끝과 이어 붙일 때 쓴다 */
    startedAt(): number | null { return t0; },
  };
}

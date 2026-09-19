// src/lib/trading/chartLoadState.ts
//
// **"지금 화면에 무엇을 보여줄 것인가" — 차트의 상태를 정하는 한 곳.**
//
// 무엇이 고장이었나
// ─────────────────
// 차트는 30초마다 봉을 다시 받는다. 그런데 그 갱신이 간격 전환과 **같은
// 이펙트**를 탔고, 이펙트는 들어가자마자 이렇게 했다:
//
//   setState('LOADING');            → 전체 오버레이가 캔들을 덮는다
//   ...실패하면 setBars(null)       → 잘 보고 있던 봉이 지워진다
//
// 결과가 실측에서 이렇게 나왔다: venue가 한 번 딸꾹하면 **정상 캔들이
// 사라지고 오류 문구만 남았다.** 성공하는 갱신도 30초마다 화면을 덮었다.
//
// 갱신과 전환은 다른 사건이다
// ───────────────────────────
// **갱신 실패**는 "새 값을 못 받았다"이고, 이미 받은 값은 여전히 유효하다.
// 마지막 값을 그대로 두고 낡았다고 말하면 된다.
//
// **전환 실패**는 다르다. 1분을 보다가 1시간을 눌렀는데 실패했다면, 화면에
// 남아 있는 1분 봉은 **지금 고른 간격의 값이 아니다.** 그걸 그대로 두면
// 사용자는 1시간 차트를 보고 있다고 믿는다 — 그래서 전환 실패는 지운다.
//
// 이 파일이 만들지 않는 것
// ────────────────────────
// 봉을 만들어 채우는 함수는 없다. 실패는 실패로 남고, 보여줄 것이 없으면
// 없다고 적는다.

export type ChartPhase =
  /** 처음 받는 중 — 보여줄 것이 아직 없다 */
  | 'FIRST_LOAD'
  /** 받은 값을 그리고 있다 */
  | 'READY'
  /** 이미 그린 값이 있고, 뒤에서 새 값을 받는 중 — **덮지 않는다** */
  | 'REFRESHING'
  /** 갱신이 실패했다. 마지막 값을 그대로 두고 낡았다고 말한다 */
  | 'STALE'
  /** 보여줄 것이 없다 */
  | 'ERROR';

/** 요청이 시작될 때의 상태. */
export function phaseOnStart(i: {
  /** 종목·간격·시장이 바뀐 요청인가 (아니면 주기 갱신) */
  isSwitch: boolean;
  /** 지금 화면에 그려 둔 봉이 있는가 */
  hasBars: boolean;
}): ChartPhase {
  // 전환이면 이전 간격의 봉은 더 이상 이 화면의 값이 아니다.
  if (i.isSwitch) return 'FIRST_LOAD';
  // 갱신인데 그려 둔 것이 없으면 그것도 첫 로딩이다.
  return i.hasBars ? 'REFRESHING' : 'FIRST_LOAD';
}

/** 응답이 성공했을 때. */
export function phaseOnSuccess(): ChartPhase {
  return 'READY';
}

/** 응답이 실패했을 때. */
export function phaseOnFailure(i: { isSwitch: boolean; hasBars: boolean }): ChartPhase {
  // 전환 실패 — 남은 봉은 다른 간격의 것이다. 보여줄 것이 없다.
  if (i.isSwitch) return 'ERROR';
  // 갱신 실패 — 마지막 값은 여전히 그 시각의 사실이다.
  return i.hasBars ? 'STALE' : 'ERROR';
}

/**
 * 실패했을 때 **그려 둔 봉을 지울 것인가.**
 *
 * 갱신 실패로 지우면 그것이 곧 "차트 증발"이다.
 */
export function shouldClearBarsOnFailure(i: { isSwitch: boolean }): boolean {
  return i.isSwitch;
}

/**
 * 캔들을 덮는 전체 오버레이를 띄울 것인가.
 *
 * **보여줄 것이 있는 동안에는 절대 덮지 않는다.** `REFRESHING`과 `STALE`은
 * 화면에 값이 있는 상태다.
 */
export function showsBlockingOverlay(phase: ChartPhase): boolean {
  return phase === 'FIRST_LOAD' || phase === 'ERROR';
}

/** 지금 그려 둔 값이 낡았다고 말해야 하는가. */
export function isStale(phase: ChartPhase): boolean {
  return phase === 'STALE';
}

/** 낡음 배지에 적을 한 줄. 낡지 않았으면 null. */
export function staleNotice(phase: ChartPhase): string | null {
  return phase === 'STALE'
    ? '갱신 실패 · 마지막 값 표시 중'
    : null;
}

/**
 * 이 봉이 지금 고른 화면의 것인가.
 *
 * 봉에 **어느 요청의 결과인지**를 붙여 두고 비교한다. 간격을 바꾼 뒤
 * 이전 간격의 봉이 남아 있으면 화면이 거짓말을 한다.
 */
export function barsMatchRequest(barsKey: string | null, currentKey: string): boolean {
  return !!barsKey && barsKey === currentKey;
}

/** 종목·간격·시장을 한 값으로. 이 값이 바뀌면 전환이다. */
export function requestKeyOf(symbol: string, interval: string, market: string): string {
  return `${symbol}|${interval}|${market}`;
}

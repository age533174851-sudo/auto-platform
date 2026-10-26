// src/lib/markets/dailyBarEvidence.ts
//
// **일봉 기준선은 "일봉이 맞는가"를 확인한 뒤에만 쓴다.**
//
// 무엇이 비어 있었나
// ──────────────────
// 고배율 진입의 변동성 관문은 `computeAtrBaseline(highs, lows, closes)`로
// 기준선을 만든다. 그 함수는 **숫자 배열 세 개만** 받는다 — 시각이 없다.
// 그래서 넘긴 배열이
//
//   · 실제로 **일봉**인지 (1시간봉을 넣어도 모른다)
//   · 중간에 **하루가 빠지지** 않았는지
//   · **오늘 것**인지, 3주 전에 멈춘 피드인지
//
// 를 알 방법이 없다. 호출부가 맞는 것을 넘긴다고 **믿는 구조**다.
//
// 실제로 그 믿음이 깨졌다. 가짜 거래소가 20일 지난 1시간봉을 일봉
// 응답으로 돌려줬는데 변동성 관문이 **통과**했다. 관문은 켜져 있었고,
// 입력이 거짓이었다.
//
// 그래서 여기서 **시각으로** 확인한다
// ───────────────────────────────────
// `VenueBars`에는 `openTimes`가 이미 들어 있다. 쓰지 않았을 뿐이다.
//   · 이웃한 봉의 간격이 하루인가          (아니면 일봉이 아니다)
//   · 간격이 하루에서 어긋난 자리가 있는가  (빠진 날)
//   · 마지막 봉이 충분히 최근인가           (멈춘 피드)
//   · 표본이 충분한가
//
// **하나라도 아니면 배열을 돌려주지 않는다.** 그러면 호출부는 기준선을
// 못 만들고, 기존 fail-closed 관문(`VOLATILITY_DATA_MISSING`)이 100배
// 진입을 막는다. 새 관문을 세우는 것이 아니라 **있는 관문에 맞는 입력을
// 주는 것**이다 — 거짓 입력으로 통과하던 길을 닫는다.

/** 하루(ms) */
export const DAY_MS = 86_400_000;

/**
 * 간격 허용 오차.
 *
 * 거래소 일봉은 UTC 00:00 정각에 열려 정확히 86,400,000ms 간격이다.
 * 그래도 1분을 열어 둔다 — 0으로 두면 응답의 반올림 하나로 전체가
 * 거짓이 된다. 1분은 1시간봉(3,600,000ms)과 구분하기에 충분히 좁다.
 */
export const SPACING_TOLERANCE_MS = 60_000;

/** 기준선에 필요한 최소 표본. 이보다 적으면 중앙값이 의미가 없다 */
export const MIN_DAILY_BARS = 30;

/**
 * 마지막 완성 일봉이 얼마나 오래돼도 되는가.
 *
 * 판정 시각이 UTC 자정 직후면 가장 최근 **완성** 일봉은 어제 00:00에
 * 열린 것이라 이미 24시간이 넘는다. 그래서 2일이 하한이다. 그보다
 * 좁히면 매일 자정마다 거짓 STALE이 난다.
 */
export const MAX_NEWEST_AGE_DAYS = 2;

export type DailyEvidenceCode =
  /** 일봉이 맞고 연속이고 최신이다 */
  | 'OK'
  /** 봉을 못 읽었거나 배열이 어긋난다. **없는 것과 다르다** */
  | 'UNREADABLE'
  /** 표본이 모자란다 */
  | 'TOO_FEW'
  /** 간격이 하루가 아니다 — 다른 주기의 봉을 일봉 자리에 넣었다 */
  | 'NOT_DAILY'
  /** 대체로 일봉인데 빠진 날이 있다 */
  | 'GAPPED'
  /** 마지막 봉이 오래됐다 — 멈춘 피드다 */
  | 'STALE';

export interface DailyBarEvidence {
  ok: boolean;
  code: DailyEvidenceCode;
  /** `OK`일 때만 값이 있다. 아니면 **null** — 호출부가 기준선을 못 만든다 */
  bars: { highs: number[]; lows: number[]; closes: number[] } | null;
  sampleCount: number;
  /** 마지막 봉이 열린 시각. 못 읽었으면 null */
  newestOpenMs: number | null;
  /** 마지막 봉의 나이(일). 못 읽었으면 null */
  ageDays: number | null;
  reason: string;
}

const arr = (v: any): number[] | null =>
  Array.isArray(v) && v.every((x) => Number.isFinite(x)) ? (v as number[]) : null;

/**
 * 이 봉들을 일봉 기준선으로 써도 되는가.
 *
 * **아니면 배열을 돌려주지 않는다.** 그게 이 함수의 전부다 — 판정을
 * 돌려주고 끝내면 호출부가 그 판정을 무시하고 배열을 쓸 수 있다.
 */
export function dailyBarEvidence(i: {
  bars: { highs?: any; lows?: any; closes?: any; openTimes?: any } | null | undefined;
  nowMs: number;
  minBars?: number;
  maxNewestAgeDays?: number;
}): DailyBarEvidence {
  const minBars = Number.isFinite(i?.minBars as number) ? (i.minBars as number) : MIN_DAILY_BARS;
  const maxAge = Number.isFinite(i?.maxNewestAgeDays as number)
    ? (i.maxNewestAgeDays as number) : MAX_NEWEST_AGE_DAYS;

  const no = (code: DailyEvidenceCode, reason: string, over: Partial<DailyBarEvidence> = {})
    : DailyBarEvidence => ({
    ok: false, code, bars: null, sampleCount: 0, newestOpenMs: null, ageDays: null,
    reason, ...over,
  });

  const highs = arr(i?.bars?.highs);
  const lows = arr(i?.bars?.lows);
  const closes = arr(i?.bars?.closes);
  const openTimes = arr(i?.bars?.openTimes);
  if (!highs || !lows || !closes || !openTimes) {
    return no('UNREADABLE', '일봉을 읽지 못했습니다 — 못 읽은 것을 기준선으로 쓰지 않습니다');
  }
  const n = closes.length;
  if (n === 0 || highs.length !== n || lows.length !== n || openTimes.length !== n) {
    return no('UNREADABLE', `일봉 배열 길이가 어긋납니다 (고가 ${highs.length} · 저가 ${lows.length} `
      + `· 종가 ${closes.length} · 시각 ${openTimes.length})`);
  }
  if (!Number.isFinite(i?.nowMs)) {
    return no('UNREADABLE', '판정 시각을 읽지 못했습니다', { sampleCount: n });
  }

  if (n < minBars) {
    return no('TOO_FEW', `일봉 표본이 ${n}개뿐입니다 (최소 ${minBars}개) — `
      + '중앙값 기준선을 만들 수 없습니다', { sampleCount: n });
  }

  // ── 간격이 하루인가 ──
  //
  // 하나라도 하루가 아니면 멈춘다. "대체로 일봉"은 기준선으로 쓸 수 없다.
  let dailySpaced = 0;
  let firstBadAt = -1;
  for (let k = 1; k < n; k++) {
    const d = openTimes[k] - openTimes[k - 1];
    if (Math.abs(d - DAY_MS) <= SPACING_TOLERANCE_MS) { dailySpaced++; continue; }
    if (firstBadAt < 0) firstBadAt = k;
  }
  const pairs = n - 1;
  const newestOpenMs = openTimes[n - 1];
  const ageDays = (i.nowMs - newestOpenMs) / DAY_MS;
  const shared = { sampleCount: n, newestOpenMs, ageDays };

  if (dailySpaced === 0) {
    const d = pairs > 0 ? openTimes[1] - openTimes[0] : 0;
    return no('NOT_DAILY', `일봉이 아닙니다 — 봉 간격이 약 ${(d / 3_600_000).toFixed(2)}시간입니다. `
      + '다른 주기의 봉을 일봉 기준선 자리에 넣으면 비교 대상이 달라집니다', shared);
  }
  if (dailySpaced !== pairs) {
    const missing = pairs - dailySpaced;
    return no('GAPPED', `일봉이 ${missing}곳에서 끊깁니다 (첫 끊김 ${firstBadAt}번째 봉) — `
      + '빠진 날이 있는 series로 변동성 기준선을 만들지 않습니다', shared);
  }

  // ── 마지막 봉이 최신인가 ──
  if (!(ageDays <= maxAge)) {
    return no('STALE', `마지막 일봉이 ${ageDays.toFixed(1)}일 전 것입니다 (허용 ${maxAge}일) — `
      + '멈춘 피드로 오늘의 변동성을 판정하지 않습니다', shared);
  }
  if (ageDays < -1) {
    return no('STALE', `마지막 일봉이 미래(${(-ageDays).toFixed(1)}일 뒤)입니다 — `
      + '시각을 신뢰할 수 없습니다', shared);
  }

  return {
    ok: true, code: 'OK', bars: { highs, lows, closes },
    sampleCount: n, newestOpenMs, ageDays,
    reason: `일봉 ${n}개 · 연속 · 마지막 봉 ${ageDays.toFixed(1)}일 전`,
  };
}

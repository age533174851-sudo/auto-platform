// src/lib/strategies/originalV1.ts
//
// **원본 전략 v1 — 하루 한 번, 한국시간 아침 창에서만 판단한다.**
//
// 이 파일이 담는 것은 둘이다:
//   1. 오늘 판단할 차례인가 (시간창 + 하루 1회)
//   2. 롱인가 숏인가 — **아직 규칙을 받지 못했다**
//
// 2번을 지어내지 않는다
// ─────────────────────
// 진입 조건은 사용자의 원본 규칙이고, 그것을 추측해서 만들면 **다른
// 전략이 그 사람 계좌에서 도는 것**이다. 규칙이 들어올 때까지
// `RULE_NOT_CONFIGURED`를 돌려주고 진입하지 않는다.
//
// 그동안에도 이 전략은 돈다: 예약 저장 → 주기 평가 → 시간창 판정 →
// 하루 1회 기록 → 크기 계산까지 전부 실제로 실행되고 기록된다. 마지막
// 한 칸만 비어 있다. **그 한 칸이 채워지면 그때부터 주문이 나간다.**
//
// 크론 시각에 기대지 않는다
// ─────────────────────────
// 지금 평가를 깨우는 것은 GitHub Actions(15분 주기)이고 **부하에 따라
// 몇 분에서 몇십 분 늦는다.** 그래서 "지금이 09:10~09:30이면 판단한다"로
// 만들면, 스케줄러가 09:31에 오는 날은 그 거래일이 통째로 사라진다 —
// 그리고 아무 오류도 안 난다. 이 저장소가 반복해서 당한 모양이다.
//
// 그래서 기준을 **시각이 아니라 거래일**로 둔다:
//
//   "오늘(KST) 아직 판단하지 않았고, 지금이 허용 구간 안이면 한 번 한다"
//
// 늦게 온 것과 못 온 것을 구분한다
// ────────────────────────────────
// 창이 닫힌 뒤에도 유예 시간까지는 **늦었다고 적으면서** 판단한다.
// 그 뒤로는 `MISSED`다 — 조용히 넘기지 않고 그 거래일을 놓쳤다고
// 기록한다. 놓친 것을 기록하지 않으면 "어제 왜 안 들어갔지"의 답이
// 어디에도 없다.

/** 판단 창 시작 (KST) */
export const WINDOW_START_KST = { hh: 9, mm: 10 };
/** 판단 창 끝 (KST) */
export const WINDOW_END_KST = { hh: 9, mm: 30 };

/**
 * 창이 닫힌 뒤 몇 분까지 늦게라도 판단할 것인가.
 *
 * **이 값은 시세 위험과 직결된다.** 09:10~09:30 봉을 보고 정한 방향으로
 * 두 시간 뒤에 들어가면 그건 같은 거래가 아니다 — 특히 100배에서는.
 * 그래서 짧게 잡되, 스케줄러가 한 번 늦는 정도(15분 주기 × 2)는
 * 흡수한다.
 */
export const LATE_GRACE_MIN = 30;

export const KST = 'Asia/Seoul';

/**
 * 그 시각의 **한국 날짜**(YYYY-MM-DD).
 *
 * 거래일의 기준이다. 서버가 UTC로 돌기 때문에 `toISOString().slice(0,10)`을
 * 쓰면 한국시간 아침 9시가 **전날**로 찍힌다 — 그러면 하루 1회 제한이
 * 날짜 경계에서 두 번 열린다.
 */
export function tradingDayKst(nowMs: number): string | null {
  if (!Number.isFinite(nowMs)) return null;
  try {
    // en-CA는 YYYY-MM-DD를 준다. 로케일에 따라 순서가 바뀌지 않는다.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(nowMs));
  } catch { return null; }
}

/** 그 시각의 한국 시계(분 단위 누계). 못 읽으면 null */
export function kstMinuteOfDay(nowMs: number): number | null {
  if (!Number.isFinite(nowMs)) return null;
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: KST, hour12: false, hour: '2-digit', minute: '2-digit',
    });
    const got: Record<string, string> = {};
    for (const p of f.formatToParts(new Date(nowMs))) got[p.type] = p.value;
    // 자정을 '24'로 주는 환경이 있다.
    const hh = Number(got.hour) % 24;
    const mm = Number(got.minute);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return hh * 60 + mm;
  } catch { return null; }
}

export type WindowCode =
  /** 창 안이다 — 정시 판단 */
  | 'IN_WINDOW'
  /** 창은 지났지만 유예 안이다 — 늦게라도 한 번 한다 */
  | 'LATE'
  /** 아직 창 전이다 */
  | 'BEFORE'
  /** 유예까지 지났다 — **이 거래일은 놓쳤다.** 기록만 남긴다 */
  | 'MISSED'
  /** 오늘 이미 판단했다 */
  | 'ALREADY_DONE'
  /** 시각을 읽지 못했다 */
  | 'UNKNOWN';

export interface WindowVerdict {
  /** 지금 판단해도 되는가 */
  evaluate: boolean;
  code: WindowCode;
  /** 이 판단이 속한 거래일(KST). 기록·중복 방지의 열쇠다 */
  tradingDay: string | null;
  /** 창 기준 몇 분 늦었는가. 정시면 0 */
  lateMin: number;
  reason: string;
}

const startMin = WINDOW_START_KST.hh * 60 + WINDOW_START_KST.mm;
const endMin = WINDOW_END_KST.hh * 60 + WINDOW_END_KST.mm;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * 오늘 판단할 차례인가.
 *
 * @param lastEvaluatedDay 이 전략·이 예약이 마지막으로 판단한 거래일(KST).
 *   **없으면 null이다.** 빈 문자열을 '오늘'로 읽으면 하루 1회가 무너진다.
 */
export function windowVerdict(i: {
  nowMs: number;
  lastEvaluatedDay?: any;
  graceMin?: number;
}): WindowVerdict {
  const day = tradingDayKst(i.nowMs);
  const minute = kstMinuteOfDay(i.nowMs);
  if (day == null || minute == null) {
    return {
      evaluate: false, code: 'UNKNOWN', tradingDay: null, lateMin: 0,
      reason: '한국 시각을 읽지 못했습니다 — 판단하지 않습니다',
    };
  }

  // ── 하루 1회. 시각보다 먼저 본다 ──
  //
  // 창 안에서 두 번 깨어나도, 늦게 한 번 더 깨어나도 결과는 하나다.
  const last = i.lastEvaluatedDay == null ? null : String(i.lastEvaluatedDay).trim() || null;
  if (last === day) {
    return {
      evaluate: false, code: 'ALREADY_DONE', tradingDay: day, lateMin: 0,
      reason: `${day} 판단을 이미 마쳤습니다 — 같은 거래일에 두 번 판단하지 않습니다`,
    };
  }

  if (minute < startMin) {
    return {
      evaluate: false, code: 'BEFORE', tradingDay: day, lateMin: 0,
      reason: `아직 판단 창 전입니다 (지금 ${hhmm(minute)} KST · 창 ${hhmm(startMin)}~${hhmm(endMin)})`,
    };
  }
  if (minute <= endMin) {
    return {
      evaluate: true, code: 'IN_WINDOW', tradingDay: day, lateMin: 0,
      reason: `판단 창 안입니다 (${hhmm(minute)} KST)`,
    };
  }

  const grace = Number.isFinite(i.graceMin as any) ? Number(i.graceMin) : LATE_GRACE_MIN;
  const late = minute - endMin;
  if (late <= grace) {
    return {
      evaluate: true, code: 'LATE', tradingDay: day, lateMin: late,
      reason: `창이 닫힌 뒤 ${late}분 지났습니다 (유예 ${grace}분) — 실행기 지연으로 보고 늦게 판단합니다`,
    };
  }
  return {
    // **판단하지 않지만 '아무 일도 없었다'로 두지 않는다.** 부르는 쪽이
    // 이 거래일을 놓쳤다고 기록한다.
    evaluate: false, code: 'MISSED', tradingDay: day, lateMin: late,
    reason: `${day} 판단 창(${hhmm(startMin)}~${hhmm(endMin)} KST)을 ${late}분 놓쳤습니다 `
          + `— 유예 ${grace}분을 넘겨 이 거래일은 진입하지 않습니다`,
  };
}

// ── 진입 방향 ────────────────────────────────────────

export type SignalCode =
  | 'LONG'
  | 'SHORT'
  /** 시가와 종가가 같다 — 방향이 없다 */
  | 'NO_TRADE'
  /** 봉을 못 읽었다 */
  | 'BARS_UNAVAILABLE'
  /** 구간을 덮는 봉이 없다 */
  | 'WINDOW_BARS_MISSING';

export interface CandleStrength {
  /** (종가 - 시가) / 시가 × 100. 부호가 곧 방향이다 */
  bodyPct: number;
  /** (고가 - 저가) / 시가 × 100 */
  rangePct: number;
  /** 몸통 / 고저폭. 1에 가까울수록 꼬리가 없다. 고저폭이 0이면 null */
  bodyToRangeRatio: number | null;
}

export interface SignalVerdict {
  side: 'LONG' | 'SHORT' | null;
  code: SignalCode;
  reason: string;
  /** 사람이 볼 근거 + 파생 전략이 나중에 비교할 값 */
  evidence: Record<string, any>;
}

export interface WindowBar {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** 이 구간을 덮는 봉만 고른다. 창 밖의 봉을 섞으면 다른 구간을 판단하게 된다 */
export function barsInWindow(bars: WindowBar[], tradingDay: string): WindowBar[] {
  const out: WindowBar[] = [];
  for (const b of Array.isArray(bars) ? bars : []) {
    const t = Number(b?.openTimeMs);
    if (!Number.isFinite(t)) continue;
    if (tradingDayKst(t) !== tradingDay) continue;
    const m = kstMinuteOfDay(t);
    // 봉의 시작 시각이 창 안이면 그 봉은 이 구간에 속한다.
    // 09:30 시작 봉은 창을 넘어가므로 넣지 않는다.
    if (m == null || m < startMin || m >= endMin) continue;
    out.push(b);
  }
  return out.sort((a, b) => a.openTimeMs - b.openTimeMs);
}

/** 값이 유한한 양수인가. **0과 NaN을 가격으로 쓰지 않는다** */
const price = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 09:10~09:30 구간을 **하나의 합성 봉**으로 보고 방향을 정한다.
 *
 * 규칙 (사용자 확정)
 * ──────────────────
 *   시가  = 09:10의 첫 가격
 *   종가  = 09:30까지의 마지막 확정 가격
 *   종가 > 시가 → LONG
 *   종가 < 시가 → SHORT
 *
 * **구간 안의 5분봉 네 개를 각각 투표시키지 않는다.** 전체 구간 하나의
 * 방향이 기준이다 — 봉을 쪼개면 같은 구간에서 다른 답이 나올 수 있고,
 * 그건 사용자가 하던 방식이 아니다.
 *
 * 봉의 힘은 왜 계산만 하는가
 * ──────────────────────────
 * `bodyPct` · `rangePct` · `bodyToRangeRatio`를 함께 남긴다. 하지만
 * **v1에서는 이 값으로 진입을 취소하거나 주문 금액·배율을 바꾸지
 * 않는다.** 원본 전략은 방향이 나오면 들어가는 전략이고, 여기에 세기
 * 필터를 넣는 순간 그건 다른 전략이다 — 그러면 원본의 성적을 알 수 없다.
 *
 * 이 값들은 나중에 v2(강한 봉만 진입 · 세기별 크기)와 **숫자로 비교**
 * 하기 위한 기록이다.
 */
export function originalV1Signal(input: {
  bars: WindowBar[];
  tradingDay?: string | null;
  prevDayClose?: number | null;
}): SignalVerdict {
  const day = input.tradingDay ?? null;
  const all = Array.isArray(input.bars) ? input.bars : [];
  if (all.length === 0) {
    return { side: null, code: 'BARS_UNAVAILABLE', evidence: {},
      reason: '봉을 받지 못했습니다 — 방향을 정하지 않습니다' };
  }

  const win = day ? barsInWindow(all, day) : all;
  if (win.length === 0) {
    return { side: null, code: 'WINDOW_BARS_MISSING', evidence: { received: all.length },
      reason: `${day ?? ''} 09:10~09:30 구간을 덮는 봉이 없습니다 — 없는 봉으로 방향을 만들지 않습니다` };
  }

  const open = price(win[0].open);
  const close = price(win[win.length - 1].close);
  if (open == null || close == null) {
    return { side: null, code: 'BARS_UNAVAILABLE', evidence: { bars: win.length },
      reason: '구간의 시가/종가를 읽지 못했습니다' };
  }

  // 고가·저가는 구간 전체에서 모은다. 못 읽은 봉은 세지 않는다 —
  // 0으로 채우면 저가가 0이 되어 고저폭이 터무니없어진다.
  let high = -Infinity, low = Infinity;
  for (const b of win) {
    const h = price(b.high); const l = price(b.low);
    if (h != null) high = Math.max(high, h);
    if (l != null) low = Math.min(low, l);
  }
  const haveRange = Number.isFinite(high) && Number.isFinite(low) && high >= low;

  const bodyPct = ((close - open) / open) * 100;
  const rangePct = haveRange ? ((high - low) / open) * 100 : 0;
  const strength: CandleStrength = {
    bodyPct: Number(bodyPct.toFixed(4)),
    rangePct: Number(rangePct.toFixed(4)),
    bodyToRangeRatio: haveRange && high > low
      ? Number((Math.abs(close - open) / (high - low)).toFixed(4))
      : null,
  };

  const evidence = {
    windowOpen: open, windowClose: close,
    windowHigh: haveRange ? high : null, windowLow: haveRange ? low : null,
    bars: win.length,
    strength,
    // **이 값들은 판단에 쓰이지 않았다는 사실을 같이 남긴다.**
    // 기록만 보고 "세기로 걸렀다"고 읽으면 안 된다.
    strengthUsedForEntry: false,
    prevDayClose: input.prevDayClose ?? null,
  };

  if (close > open) {
    return { side: 'LONG', code: 'LONG', evidence,
      reason: `09:10 ${open} → 09:30 ${close} 양봉 (몸통 ${strength.bodyPct}%) — LONG` };
  }
  if (close < open) {
    return { side: 'SHORT', code: 'SHORT', evidence,
      reason: `09:10 ${open} → 09:30 ${close} 음봉 (몸통 ${strength.bodyPct}%) — SHORT` };
  }
  // **시가와 종가가 같을 때만 방향이 없다.** 약한 봉은 NO_TRADE가 아니다.
  return { side: null, code: 'NO_TRADE', evidence,
    reason: `09:10과 09:30 가격이 같습니다 (${open}) — 방향이 없어 진입하지 않습니다` };
}

/** 규칙이 실제로 들어왔는가. 화면·응답이 이 값을 그대로 적는다 */
export function signalRuleConfigured(): boolean {
  return true;
}

/** 손절·익절 규칙이 들어왔는가. **아직 아니다** */
export function exitRuleConfigured(): boolean {
  return false;
}

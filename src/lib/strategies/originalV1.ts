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
  /** **아직 규칙을 받지 못했다.** 추측해서 만들지 않는다 */
  | 'RULE_NOT_CONFIGURED'
  | 'LONG'
  | 'SHORT'
  | 'NO_TRADE'
  /** 봉을 못 읽었다 */
  | 'BARS_UNAVAILABLE';

export interface SignalVerdict {
  side: 'LONG' | 'SHORT' | null;
  code: SignalCode;
  reason: string;
  /** 사람이 볼 근거. 규칙이 들어오면 여기 숫자가 찬다 */
  evidence: Record<string, any>;
}

export interface WindowBar {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 09:10~09:30 구간의 봉을 보고 방향을 정한다.
 *
 * **이 함수만 비어 있다.** 나머지(시간창·하루 1회·크기·배율·안전 관문·
 * 주문 경로·기록)는 전부 실제로 돈다. 규칙이 들어오면 여기만 채운다 —
 * 그때 다른 파일은 건드리지 않는다.
 *
 * 무엇이 필요한가 (사용자 확인 대기):
 *   · 무슨 봉을 보는가 — 09:10~09:30 한 덩어리인가, 그 안의 5분봉 4개인가
 *   · 무엇과 비교하는가 — 시가 대비 종가, 전일 종가, 그 구간의 고저
 *   · 임계값이 있는가 — 몇 % 이상이어야 방향으로 인정하는가
 *   · 방향이 안 나오면 NO_TRADE인가, 아니면 다른 조건으로 넘어가는가
 */
export function originalV1Signal(_input: {
  bars: WindowBar[];
  prevDayClose?: number | null;
}): SignalVerdict {
  return {
    side: null,
    code: 'RULE_NOT_CONFIGURED',
    reason: '진입 방향 규칙이 아직 입력되지 않았습니다 — 추측해서 만들지 않습니다. '
          + '규칙이 들어오기 전까지 이 전략은 평가만 하고 진입하지 않습니다',
    evidence: {},
  };
}

/** 규칙이 실제로 들어왔는가. 화면·응답이 이 값을 그대로 적는다 */
export function signalRuleConfigured(): boolean {
  return originalV1Signal({ bars: [] }).code !== 'RULE_NOT_CONFIGURED';
}

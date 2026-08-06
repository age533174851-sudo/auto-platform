// src/lib/markets/futuresHours.ts
//
// **선물 거래시간 — 주식과 규칙이 다르다.**
//
// 왜 marketHours를 그냥 못 쓰는가
// ───────────────────────────────
// `marketHours.ts`는 주식용이다. 정규장 09:30–16:00, 토·일 휴장. 그
// 규칙을 CME 금·원유에 그대로 쓰면 **거의 모든 시간을 닫힘으로 판정한다.**
// 선물은 하루 23시간 열려 있다.
//
// 세 가지가 다르다:
//
//  1. **일요일에 열린다.** 일요일 18:00 ET에 주간 거래가 시작된다.
//     주식 규칙(토·일 휴장)을 쓰면 일요일 밤 세션을 통째로 놓친다.
//
//  2. **매일 한 시간 쉰다.** 17:00–18:00 ET는 정산 시간이라 닫힌다.
//     이 한 시간을 모르면 그때 낸 주문이 거부되는데, 화면에는 이유가
//     안 뜬다 — "요청은 성공했는데 실제로는 안 되어 있다"의 그 모양이다.
//
//  3. **금요일 17:00에 닫혀 일요일 18:00까지 안 연다.** 이틀이 넘는다.
//     주식의 "주말"과 길이가 다르다.
//
// 그래서 별도 파일이지만, **zonedParts는 marketHours 것을 쓴다.**
// 시간대 계산을 두 벌 두면 서머타임 처리가 한쪽만 고쳐진다 — 그리고
// 서머타임은 손으로 계산하면 반드시 틀리는 종류다.
//
// 공휴일은 여전히 모른다
// ──────────────────────
// CME 휴장일(추수감사절·크리스마스 등)과 단축 거래일 목록은 여기 없다.
// 넣어 두면 해가 바뀔 때마다 조용히 틀리기 시작한다. **모른다고 말한다** —
// 거래소가 거부하는 것이 최종 방어선이고, 이 판정은 그 앞에서 대부분을
// 걸러 주는 것이다.

import { zonedParts, zonedDateKey, type MarketPhase } from './marketHours';

/** 선물 거래소 */
export type FuturesVenue = 'CME';

export interface FuturesSession {
  venue: FuturesVenue;
  tz: string;
  /**
   * 주간 개장 — 요일과 현지 시각(분).
   * CME는 일요일(0) 18:00 = 1080분.
   */
  weekOpenDow: number;
  weekOpenMin: number;
  /** 주간 폐장 — 금요일(5) 17:00 = 1020분 */
  weekCloseDow: number;
  weekCloseMin: number;
  /** 매일 쉬는 구간 [시작, 끝) 현지 분. CME는 17:00–18:00 */
  dailyBreak: [number, number] | null;
  label: string;
}

export const FUTURES_SESSIONS: Record<FuturesVenue, FuturesSession> = {
  // CME Globex — 금(GC)·원유(CL)·지수(ES/NQ)가 전부 이 시간표다.
  //
  // 상품마다 개장이 몇 분씩 다른 경우가 있지만(예: 일부 농산물), 여기
  // 붙이는 금·원유·지수는 같다. **다른 상품을 추가할 때 이 표를 같이
  // 고쳐야 한다** — 안 고치면 그 상품이 조용히 이 시간표로 판정된다.
  CME: {
    venue: 'CME', tz: 'America/Chicago',
    // 시카고 기준이다. ET로 적으면 한 시간 어긋난다 —
    // CME 문서는 CT로 고시한다(일요일 17:00 CT = 18:00 ET).
    weekOpenDow: 0, weekOpenMin: 17 * 60,
    weekCloseDow: 5, weekCloseMin: 16 * 60,
    dailyBreak: [16 * 60, 17 * 60],
    label: 'CME',
  },
};

export interface FuturesHoursVerdict {
  venue: FuturesVenue;
  phase: MarketPhase;
  /** 지금 신규 주문을 내도 되는가 */
  canOrder: boolean;
  reason: string;
  /** 현지 시각 'YYYY-MM-DD HH:mm'. 못 읽었으면 null */
  localTime: string | null;
  /** 휴장일 목록을 받았는가. false면 휴장일에도 열림으로 보일 수 있다 */
  holidaysKnown: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/**
 * 지금 이 선물 시장이 열려 있는가.
 *
 * 순수 함수다 — 네트워크를 안 탄다.
 *
 * **모르면 닫힘이다.** 시간대를 못 읽은 채로 주문을 내보내면 그 주문이
 * 언제 나가는지 아무도 모른다. marketHours와 같은 규칙이다.
 */
export function futuresPhase(
  venue: FuturesVenue,
  nowMs: number,
  opts: { holidays?: string[] | null } = {},
): FuturesHoursVerdict {
  const s = FUTURES_SESSIONS[venue];
  const holidaysKnown = Array.isArray(opts.holidays);
  const base = { venue, localTime: null as string | null, holidaysKnown };

  if (!s) {
    return { ...base, phase: 'UNKNOWN', canOrder: false, reason: `모르는 거래소입니다: ${venue}` };
  }
  if (!Number.isFinite(nowMs)) {
    return { ...base, phase: 'UNKNOWN', canOrder: false, reason: '현재 시각을 알 수 없습니다' };
  }

  // 시간대 계산은 marketHours 것을 쓴다. 두 벌 두면 서머타임이 한쪽만
  // 고쳐지고, 서머타임은 손으로 계산하면 반드시 틀리는 종류다.
  const p = zonedParts(nowMs, s.tz);
  if (!p) {
    return {
      ...base, phase: 'UNKNOWN', canOrder: false,
      reason: `${s.label}의 현지 시각을 계산하지 못했습니다 — 확인 전에는 주문하지 않습니다`,
    };
  }

  const localTime = `${zonedDateKey(p)} ${pad(p.hh)}:${pad(p.mm)}`;
  const out = { ...base, localTime };
  const cur = p.hh * 60 + p.mm;

  // ── 주간 휴장 ──
  //
  // 금요일 16:00 CT ~ 일요일 17:00 CT. 주식의 "토·일"과 다르다 —
  // 금요일 저녁과 일요일 저녁이 갈린다.
  const closedForWeek =
    (p.dow === 5 && cur >= s.weekCloseMin)      // 금요일 장 마감 후
    || p.dow === 6                               // 토요일 종일
    || (p.dow === 0 && cur < s.weekOpenMin);     // 일요일 개장 전

  if (closedForWeek) {
    return {
      ...out, phase: 'WEEKEND', canOrder: false,
      reason: `${s.label} 주간 휴장 · 현지 ${localTime} `
            + `(일요일 ${hhmm(s.weekOpenMin)} 개장 · 금요일 ${hhmm(s.weekCloseMin)} 마감)`,
    };
  }

  if (holidaysKnown && opts.holidays!.includes(zonedDateKey(p))) {
    return { ...out, phase: 'HOLIDAY', canOrder: false, reason: `${s.label} 휴장일 · 현지 ${localTime}` };
  }

  // ── 매일 쉬는 한 시간 ──
  //
  // 이 구간을 모르면 그때 낸 주문이 거부되는데, 화면에는 이유가 안 뜬다.
  // 일요일 개장 전은 위에서 이미 걸렀으므로 여기서는 평일만 본다.
  if (s.dailyBreak && p.dow !== 0) {
    const [a, b] = s.dailyBreak;
    if (cur >= a && cur < b) {
      return {
        ...out, phase: 'AFTER', canOrder: false,
        reason: `${s.label} 일일 정산 휴식 · 현지 ${localTime} `
              + `(${hhmm(a)}–${hhmm(b)}에는 주문이 거부됩니다)`,
      };
    }
  }

  return {
    ...out, phase: 'OPEN', canOrder: true,
    reason: `${s.label} 거래 중 · 현지 ${localTime}`
      + (holidaysKnown ? '' : ' (휴장일 목록이 없어 공휴일은 거르지 못합니다)'),
  };
}

/**
 * 선물 심볼 → 거래소.
 *
 * **모르면 null이다.** 여기서 CME로 떨어뜨리면, 다른 거래소 상품이
 * 조용히 CME 시간표로 판정된다 — 그리고 그 판정은 대부분의 시간에
 * '열림'이라 통과한다.
 */
const CME_ROOTS = new Set([
  'GC', 'SI', 'HG',           // 금·은·구리
  'CL', 'NG', 'RB', 'HO',     // 원유·천연가스·휘발유·난방유
  'ES', 'NQ', 'YM', 'RTY',    // S&P500·나스닥100·다우·러셀2000
]);

export function futuresVenueOf(symbol: string | null | undefined): FuturesVenue | null {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s) return null;
  // 'GCZ6'처럼 월물 코드가 붙는다. 앞 두 글자가 루트다.
  // 세 글자 루트(RTY)를 먼저 본다 — 두 글자로 먼저 자르면 'RT'가 되어 못 찾는다.
  if (CME_ROOTS.has(s)) return 'CME';
  if (s.length >= 3 && CME_ROOTS.has(s.slice(0, 3))) return 'CME';
  if (s.length >= 2 && CME_ROOTS.has(s.slice(0, 2))) return 'CME';
  return null;
}

/**
 * 만기까지 며칠인가. 롤오버 경고에 쓴다.
 *
 * **만기를 모르면 null이다.** 0으로 두면 '오늘 만기'가 되고, 그건
 * 확인한 적 없는 사실이다.
 */
export function daysToExpiry(expiry: string | null | undefined, nowMs: number): number | null {
  if (!expiry) return null;
  const t = Date.parse(`${String(expiry).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return null;
  return Math.floor((t - nowMs) / 86_400_000);
}

/**
 * 만기가 가까우면 새로 들어가지 않는다.
 *
 * 왜 필요한가: 만기 직전에는 유동성이 다음 월물로 빠져나가 호가가 벌어지고,
 * 만기일에 남아 있으면 **실물 인수 절차**로 넘어가는 상품이 있다(원유가
 * 그렇다). 전략이 그걸 알 리 없으므로 앞에서 막는다.
 *
 * 기본 5일. 원유처럼 인수가 걸린 상품은 더 길게 잡아야 하지만, 그건
 * 상품별 값이라 호출부가 정한다.
 */
export function expiryGate(
  expiry: string | null | undefined, nowMs: number, minDays = 5,
): { ok: boolean; days: number | null; reason: string } {
  const d = daysToExpiry(expiry, nowMs);
  if (d == null) {
    // **모르면 통과시키지 않는다.** 만기가 없는 상품(코인 무기한)은
    // 애초에 이 검사를 부르지 않는다. 여기까지 왔는데 만기를 모른다면
    // 그건 명세를 못 읽은 것이다.
    return { ok: false, days: null,
      reason: '만기를 알 수 없습니다 — 만기 직전 진입은 유동성이 빠지고 실물 인수로 갈 수 있습니다' };
  }
  if (d < 0) {
    return { ok: false, days: d, reason: `이미 만기가 지난 월물입니다 (${-d}일 전)` };
  }
  if (d < minDays) {
    return { ok: false, days: d,
      reason: `만기까지 ${d}일 남았습니다 (기준 ${minDays}일) — 다음 월물로 넘어가세요` };
  }
  return { ok: true, days: d, reason: '' };
}

// src/lib/markets/marketHours.ts
//
// **지금 이 시장이 열려 있는가.**
//
// 왜 이것부터인가
// ───────────────
// 이 앱은 코인용으로 만들어졌다. 코인은 24시간이라, 지금까지 "언제
// 주문할 수 있는가"를 물어본 코드가 **한 줄도 없다.** 주식을 붙이면서
// 그대로 두면 크론이 새벽 3시에 국내 주식 주문을 낸다. 증권사는 그걸
// 거부하거나 다음 영업일 예약주문으로 받는다.
//
// 둘 다 화면에는 에러로 안 뜬다. 전략은 "진입했다"고 믿고 손절 감시를
// 시작하는데 포지션은 없다. 오늘 하루에만 여섯 번 나온 그 모양 —
// **요청은 성공했는데 실제로는 안 되어 있다** — 이 그대로다.
//
// 서머타임을 손으로 계산하지 않는다
// ─────────────────────────────────
// 미국 장은 09:30–16:00 America/New_York이다. 이걸 UTC-5로 고정하면
// 3월~11월에 **한 시간이 통째로 어긋난다.** 규칙(3월 둘째 일요일…)을
// 직접 적는 것도 답이 아니다 — 규칙은 바뀐 적이 있고 또 바뀔 수 있다.
// Intl에 물어본다. 물어볼 수 없으면 '모른다'로 두고 막는다.
//
// 공휴일은 모른다고 적는다
// ────────────────────────
// 설날·추석·독립기념일 목록은 여기 없다. 넣어 두면 해가 바뀔 때마다
// 조용히 틀리기 시작한다. 대신 **모른다고 말한다** — `holidaysKnown`이
// false면 화면이 "휴장일은 못 거릅니다"라고 적는다. 증권사가 거부하는
// 것이 최종 방어선이고, 이 판정은 그 앞에서 대부분을 걸러 주는 것이다.

export type StockMarket = 'KRX' | 'US';

export type MarketPhase =
  /** 정규장 */
  | 'OPEN'
  /** 장 시작 전 (같은 날) */
  | 'PRE'
  /** 장 마감 후 (같은 날) */
  | 'AFTER'
  /** 주말 */
  | 'WEEKEND'
  /** 알려진 휴장일 */
  | 'HOLIDAY'
  /** **시각을 확인하지 못했다.** 열림도 닫힘도 아니다 */
  | 'UNKNOWN';

export interface MarketHoursVerdict {
  market: StockMarket;
  phase: MarketPhase;
  /** 지금 신규 주문을 내도 되는가 */
  canOrder: boolean;
  reason: string;
  /** 그 시장 현지 시각 'YYYY-MM-DD HH:mm' — 못 읽었으면 null */
  localTime: string | null;
  /** 공휴일 목록을 받았는가. false면 휴장일에도 OPEN으로 보일 수 있다 */
  holidaysKnown: boolean;
}

interface Hours {
  tz: string;
  /** 정규장 시작 (현지 분 단위, 자정부터) */
  openMin: number;
  closeMin: number;
  label: string;
}

export const MARKET_HOURS: Record<StockMarket, Hours> = {
  // 한국거래소 정규장 09:00–15:30. 서머타임이 없다.
  //
  // 장전/장후 시간외는 여기 넣지 않는다. 체결 방식(단일가·경쟁대량)이
  // 달라서 정규장과 같은 전략을 그대로 쓰면 안 되고, "열려 있다"고
  // 적으면 그대로 쓰게 된다.
  KRX: { tz: 'Asia/Seoul', openMin: 9 * 60, closeMin: 15 * 60 + 30, label: '한국거래소' },
  // 미국 정규장 09:30–16:00 (뉴욕). 서머타임은 Intl이 처리한다.
  US: { tz: 'America/New_York', openMin: 9 * 60 + 30, closeMin: 16 * 60, label: '미국 정규장' },
};

interface ZonedParts { y: number; m: number; d: number; hh: number; mm: number; dow: number }

/**
 * 어떤 시각을 그 시장의 **현지 시각**으로 바꾼다.
 *
 * Intl을 못 쓰면 null이다 — 추측한 오프셋으로 대신하지 않는다. 한 시간
 * 어긋난 판정은 없느니만 못하다.
 */
export function zonedParts(ms: number, timeZone: string): ZonedParts | null {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
    const got: Record<string, string> = {};
    for (const p of f.formatToParts(new Date(ms))) got[p.type] = p.value;

    const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const y = Number(got.year), m = Number(got.month), d = Number(got.day);
    // 자정을 '24'로 주는 환경이 있다. 그대로 두면 00:10이 24:10이 되어
    // 하루 종일 장외로 판정된다.
    const hh = Number(got.hour) % 24;
    const mm = Number(got.minute);
    const dow = DOW[String(got.weekday)];
    if (![y, m, d, hh, mm, dow].every(v => Number.isFinite(v))) return null;
    return { y, m, d, hh, mm, dow };
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' — 공휴일 목록과 맞춰 보는 열쇠 */
export function zonedDateKey(p: ZonedParts): string {
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/**
 * 지금 이 시장이 열려 있는가.
 *
 * 순수 함수다 — 네트워크를 안 탄다.
 *
 * @param holidays 'YYYY-MM-DD' 목록(그 시장 현지 날짜). **넘기지 않으면
 *                 휴장일을 못 거른다는 사실이 결과에 그대로 적힌다.**
 */
export function marketPhase(
  market: StockMarket,
  nowMs: number,
  opts: { holidays?: string[] | null } = {},
): MarketHoursVerdict {
  const h = MARKET_HOURS[market];
  const holidaysKnown = Array.isArray(opts.holidays);
  const base = { market, localTime: null as string | null, holidaysKnown };

  if (!h) {
    return { ...base, phase: 'UNKNOWN', canOrder: false, reason: `모르는 시장입니다: ${market}` };
  }
  if (!Number.isFinite(nowMs)) {
    return { ...base, phase: 'UNKNOWN', canOrder: false, reason: '현재 시각을 알 수 없습니다' };
  }

  const p = zonedParts(nowMs, h.tz);
  if (!p) {
    // **여기서 열림으로 기울면 안 된다.** 시간대를 못 읽은 채로 주문을
    // 내보내면 그 주문이 언제 나가는지 아무도 모른다.
    return {
      ...base, phase: 'UNKNOWN', canOrder: false,
      reason: `${h.label}의 현지 시각을 계산하지 못했습니다 — 확인 전에는 주문하지 않습니다`,
    };
  }

  const localTime = `${zonedDateKey(p)} ${pad(p.hh)}:${pad(p.mm)}`;
  const out = { ...base, localTime };
  const cur = p.hh * 60 + p.mm;
  const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  const window = `${hhmm(h.openMin)}–${hhmm(h.closeMin)}`;

  if (p.dow === 0 || p.dow === 6) {
    return { ...out, phase: 'WEEKEND', canOrder: false, reason: `${h.label} 휴장 (주말) · 현지 ${localTime}` };
  }

  if (holidaysKnown && opts.holidays!.includes(zonedDateKey(p))) {
    return { ...out, phase: 'HOLIDAY', canOrder: false, reason: `${h.label} 휴장일 · 현지 ${localTime}` };
  }

  if (cur < h.openMin) {
    return { ...out, phase: 'PRE', canOrder: false,
      reason: `${h.label} 개장 전 · 현지 ${localTime} (정규장 ${window})` };
  }
  // 마감 시각 자체는 닫힌 것으로 본다. 15:30:00에 낸 주문이 들어갈지는
  // 초 단위 경합이라, 되는 쪽으로 읽으면 "가끔 되는" 상태가 된다.
  if (cur >= h.closeMin) {
    return { ...out, phase: 'AFTER', canOrder: false,
      reason: `${h.label} 마감 후 · 현지 ${localTime} (정규장 ${window})` };
  }

  return { ...out, phase: 'OPEN', canOrder: true,
    reason: `${h.label} 정규장 · 현지 ${localTime}`
      + (holidaysKnown ? '' : ' (휴장일 목록이 없어 공휴일은 거르지 못합니다)') };
}

/**
 * 종목 코드로 시장을 고른다.
 *
 * 국내는 여섯 자리 숫자다(005930·069500). 그 외는 미국으로 본다 —
 * 지금 붙이는 해외 시장이 미국뿐이기 때문이다. **일본·홍콩을 추가할 때
 * 이 함수를 같이 고쳐야 한다.** 안 고치면 그 종목이 조용히 미국 시간표로
 * 판정된다.
 */
export function marketOfSymbol(symbol: string | null | undefined): StockMarket | null {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s) return null;
  if (/^\d{6}$/.test(s)) return 'KRX';
  if (/^[A-Z.]{1,6}$/.test(s)) return 'US';
  return null;
}

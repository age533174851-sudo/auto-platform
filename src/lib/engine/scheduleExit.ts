// src/lib/engine/scheduleExit.ts
//
// **시간 예약 청산** — "내일 15:30에 판다".
//
// 이 파일이 답하는 것은 하나다: *지금 이 예약을 실행해야 하는가.*
// 주문은 내지 않는다. 주문은 라우트가 낸다.
//
// ─────────────────────────────────────────────────────────────
// 이 기능에서 가장 위험한 것: **예약해 놓고 안 나가는 것**
// ─────────────────────────────────────────────────────────────
// 화면에 "15:30 매도 예약됨"이라고 적어 두면 사람은 그 시각에 팔릴 것을
// 전제로 다른 결정을 한다 — 자러 가거나, 다른 포지션을 더 연다.
// 그런데 이 저장소의 크론은 **하루 1회**다(Vercel 무료 플랜 제한).
// 그대로 두면 15:30 예약이 다음날 09:00에 나간다. 17시간 반 늦게.
//
// 그건 예약 매도가 아니라 **예약 매도처럼 보이는 것**이다.
//
// 그래서 이 모듈은 두 가지를 강제한다.
//   1. `lateness`를 항상 같이 계산한다 — 얼마나 늦었는지. 화면과 기록에
//      그 값이 그대로 남는다.
//   2. `graceMs`를 넘겨 너무 늦은 예약은 **자동으로 안 나간다**(stale).
//      12시간 늦게 파는 것은 사용자가 예약한 그 거래가 아니다. 그 사이
//      가격이 어디로 갔는지 모른 채 시장가로 던지는 것이 더 위험하다.
//
// 실행기가 셋이다
// ───────────────
// 어느 것이 도는지에 따라 정확도가 다르고, **그 사실을 화면이 말해야 한다.**
//   · 앱이 열려 있을 때 도는 타이머 — 제 시각에 나간다. 앱을 닫으면 안 돈다
//   · 하루 1회 크론 — 언제나 돌지만 최대 하루 늦는다
//   · 외부 스케줄러(분 단위로 우리 주소를 호출) — 제 시각 + 앱과 무관
// 이 모듈은 누가 불렀는지 모른다. 판단만 한다.

/** 예약 한 줄. DB 행과 같은 모양이다. */
export interface ExitSchedule {
  id?: string | null;
  symbol?: string | null;
  /** 실행 시각(UTC ms). **모르면 실행하지 않는다** */
  runAtMs?: number | null;
  /** 'CLOSE' — 전량 청산. 지금은 이것뿐이다 */
  action?: string | null;
  /** 전량이 아니면 비율(1~100). 없으면 전량 */
  portionPct?: number | null;
  enabled?: boolean | null;
  /** 이미 실행됐으면 그 시각 */
  firedAtMs?: number | null;
}

export type DueVerdict =
  /** 지금 실행한다 */
  | 'due'
  /** 아직 시각이 안 됐다 */
  | 'waiting'
  /** 너무 늦었다 — 자동으로 내지 않는다 */
  | 'stale'
  /** 이미 실행됐다 */
  | 'done'
  /** 꺼져 있다 */
  | 'off'
  /** 값이 모자라 판단할 수 없다 */
  | 'invalid';

export interface DueCheck {
  verdict: DueVerdict;
  /** 예정 시각보다 얼마나 늦었나(ms). 아직이면 음수 */
  latenessMs: number | null;
  reason: string;
}

/**
 * 기본 유예. 이 시간을 넘겨 늦으면 자동으로 내지 않는다.
 *
 * 30분으로 잡는 이유: 분 단위 실행기가 있으면 늦어야 몇 초다. 하루 1회
 * 크론만 있으면 거의 항상 이 값을 넘는데, **그게 맞다** — 그 환경에서는
 * 시간 예약이 제대로 동작하지 않는다는 사실이 드러나야 한다.
 * 조용히 늦게 실행해서 '되는 것처럼' 보이면 안 된다.
 */
export const DEFAULT_GRACE_MS = 30 * 60_000;

export function checkDue(
  s: ExitSchedule | null | undefined,
  nowMs: number,
  graceMs: number = DEFAULT_GRACE_MS,
): DueCheck {
  const out = (verdict: DueVerdict, reason: string, latenessMs: number | null = null): DueCheck =>
    ({ verdict, latenessMs, reason });

  if (!s) return out('invalid', '예약이 없습니다');
  if (s.enabled === false) return out('off', '꺼져 있는 예약입니다');
  if (s.firedAtMs != null) return out('done', '이미 실행된 예약입니다');

  const at = Number(s.runAtMs);
  if (!Number.isFinite(at) || at <= 0) {
    // 0을 '지금'으로 읽으면, 시각을 못 채운 예약이 만들어지자마자 나간다.
    return out('invalid', '실행 시각이 없습니다');
  }

  const lateness = nowMs - at;
  if (lateness < 0) return out('waiting', `실행까지 ${fmtGap(-lateness)} 남았습니다`, lateness);

  const grace = Math.max(0, Number(graceMs) || 0);
  if (lateness > grace) {
    return out('stale',
      `예정보다 ${fmtGap(lateness)} 늦었습니다 — 자동으로 실행하지 않습니다. `
      + '그 사이 가격이 어디로 갔는지 모른 채 시장가로 내는 것이 더 위험합니다.',
      lateness);
  }

  return out('due', lateness < 1000 ? '실행 시각입니다' : `실행 시각입니다 (${fmtGap(lateness)} 늦음)`, lateness);
}

/** 사람이 읽는 시간 간격 */
export function fmtGap(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}시간 ${rm}분` : `${h}시간`;
  const d = Math.floor(h / 24);
  return `${d}일 ${h % 24}시간`;
}

/**
 * 화면에서 고른 '오늘/내일 15:30'을 UTC ms로 바꾼다.
 *
 * **시간대를 손으로 계산하지 않는다.** KST는 서머타임이 없지만 이 함수는
 * 미국 주식에도 쓰이고, 거기는 있다. 손으로 +9를 더하는 코드는 한 번은
 * 맞고 그다음에 틀린다. Intl에게 맡긴다.
 *
 * @param dateISO 'YYYY-MM-DD' (그 시간대 기준의 날짜)
 * @param hhmm    'HH:MM' (24시간)
 * @param timeZone 'Asia/Seoul' 같은 IANA 이름
 * @returns UTC ms. 못 만들면 **null** — 0을 돌려주면 1970년이 되고,
 *          그건 언제나 '지났음'이라 만들자마자 실행된다.
 */
export function toUtcMs(
  dateISO: string | null | undefined,
  hhmm: string | null | undefined,
  timeZone: string,
): number | null {
  const d = String(dateISO || '').trim();
  const t = String(hhmm || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  if (!/^\d{1,2}:\d{2}$/.test(t)) return null;

  const [hh, mm] = t.split(':').map(Number);
  if (!(hh >= 0 && hh <= 23) || !(mm >= 0 && mm <= 59)) return null;

  // 그 시간대에서 이 벽시계 시각이 가리키는 UTC 순간을 찾는다.
  // UTC로 한 번 만든 뒤, 그 순간을 대상 시간대로 표시했을 때 생기는
  // 차이만큼 되민다. 서머타임 경계에서도 한 번의 보정으로 맞는다.
  const guess = Date.UTC(
    Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), hh, mm, 0, 0);
  const offset = tzOffsetMs(guess, timeZone);
  if (offset == null) return null;
  const first = guess - offset;
  // 경계를 넘었으면 오프셋이 달라진다. 한 번 더 본다.
  const offset2 = tzOffsetMs(first, timeZone);
  if (offset2 == null) return null;
  return offset2 === offset ? first : guess - offset2;
}

/** 이 순간, 그 시간대의 UTC 오프셋(ms). 못 구하면 null */
function tzOffsetMs(utcMs: number, timeZone: string): number | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (k: string) => Number(parts.find(p => p.type === k)?.value);
    const y = get('year'), mo = get('month'), da = get('day');
    let ho = get('hour');
    const mi = get('minute'), se = get('second');
    if ([y, mo, da, ho, mi, se].some(v => !Number.isFinite(v))) return null;
    // 일부 환경에서 자정을 24로 준다
    if (ho === 24) ho = 0;
    return Date.UTC(y, mo - 1, da, ho, mi, se) - utcMs;
  } catch { return null; }
}

/**
 * 예약을 만들 수 있는가.
 *
 * **과거는 거부한다.** 지난 시각으로 만들면 저장되자마자 stale이 되고,
 * 화면에는 '예약됨'으로 뜬다 — 영원히 안 나가는 예약이다.
 */
export function validateSchedule(
  runAtMs: number | null | undefined,
  nowMs: number,
  opts: { maxAheadDays?: number } = {},
): { ok: boolean; reason: string } {
  const at = Number(runAtMs);
  if (!Number.isFinite(at) || at <= 0) {
    return { ok: false, reason: '실행 시각을 읽지 못했습니다 — 날짜와 시각을 다시 고르세요' };
  }
  if (at <= nowMs) {
    return { ok: false, reason: '지난 시각으로는 예약할 수 없습니다' };
  }
  const maxDays = opts.maxAheadDays ?? 30;
  if (at - nowMs > maxDays * 86_400_000) {
    // 아주 먼 예약은 대개 날짜를 잘못 고른 것이다. 그리고 그 사이 포지션이
    // 남아 있을 것이라고 가정할 수 없다.
    return { ok: false, reason: `${maxDays}일 뒤까지만 예약할 수 있습니다` };
  }
  return { ok: true, reason: '' };
}

/**
 * 이 예약이 **실제로 제때 나갈 수 있는가.**
 *
 * 화면이 이 값을 그대로 적는다. 실행기가 하루 1회 크론뿐이면
 * "15:30에 팝니다"라고 쓰면 안 된다.
 *
 * @param runners 지금 살아 있는 실행기들
 */
export function accuracyNote(runners: {
  /** 앱이 열려 있는 동안 도는 타이머 */
  appOpen?: boolean;
  /** 분 단위로 우리 주소를 부르는 외부 스케줄러 */
  external?: boolean;
  /**
   * 저장소 예약 워크플로(GitHub Actions, 5분마다).
   *
   * **브라우저 없이 도는 유일한 실행기다.** 다만 GitHub 예약은
   * best-effort라 부하가 몰리면 5~15분씩 늦고, 저장소가 60일간 조용하면
   * GitHub이 꺼 버린다. 그래서 '상시 실행 Worker'라고 부르지 않는다.
   */
  repoCron?: boolean;
  /** 하루 1회 크론 */
  dailyCron?: boolean;
}): { canBeOnTime: boolean; text: string; browserFree: boolean } {
  // **브라우저 없이 도는 것이 하나라도 있는가.**
  //
  // 이게 이 함수가 답해야 할 진짜 질문이다. 앱이 열려 있으면 제 시각에
  // 나가지만, 그건 사용자가 화면을 보고 있을 때만이다 — 예약 청산은
  // 자고 있을 때 걸리라고 만든 기능이다.
  const browserFree = runners.external === true || runners.repoCron === true;

  if (runners.external) {
    return { browserFree: true, canBeOnTime: true,
      text: '외부 스케줄러가 분 단위로 확인합니다 — 앱을 닫아도 제 시각에 나갑니다.' };
  }
  if (runners.repoCron) {
    return {
      browserFree: true, canBeOnTime: true,
      text: '저장소 예약(5분마다)이 앱을 닫아도 실행합니다. '
        + '다만 GitHub 예약은 부하에 따라 5~15분 늦을 수 있어 **분 단위 정확도는 보장되지 않습니다** '
        + '— 정확도가 필요하면 상시 Worker가 필요합니다.'
        + (runners.appOpen ? ' 앱이 열려 있는 동안은 30초마다 함께 확인합니다.' : ''),
    };
  }
  if (runners.appOpen) {
    return {
      browserFree: false, canBeOnTime: true,
      text: '이 앱이 열려 있는 동안에만 제 시각에 나갑니다. '
        + '**앱을 닫거나 화면이 잠기면 그 시각에 안 나갑니다.**',
    };
  }
  if (runners.dailyCron) {
    return {
      browserFree: false, canBeOnTime: false,
      text: '지금은 하루 1회 크론만 있습니다 — 예약 시각에 나가지 않습니다. '
        + '늦으면 자동 실행하지 않으므로, 이 예약은 사실상 알림에 가깝습니다.',
    };
  }
  return { browserFree: false, canBeOnTime: false,
    text: '이 예약을 실행할 것이 없습니다 — 저장은 되지만 나가지 않습니다.' };
}

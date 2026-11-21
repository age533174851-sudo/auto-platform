// ─────────────────────────────────────────────────────────────
// 다음 평가 시각을 **짧게, 그리고 참말로** 적는다.
//
// 사진(7055.jpg)이 보여 준 것
// ───────────────────────────
//     btcusdt-1d-breakout · BTCUSDT · 일봉 · 돌파
//     · 다음 평가 2026. 11. 18. 오후 1:15:32   [정지]
//
// 한 줄에 두 가지 고장이 있다.
//
// ① **길이** — 30초 뒤에 올 시각을 연·월·일·초까지 적는다. 목록이
//    열 줄이 되는 이유의 절반이 이 문자열이다. 오늘 안에 올 시각에
//    날짜는 정보가 아니다.
//
// ② **거짓말** — `next_run_at`은 `last_run_at + interval`이라 **꺼져
//    있어도 계산된다.** 정지된 봇도 곧 돌 것처럼 시각을 적었다.
//    `dueDiagView`가 자동매매 예약 쪽에서 같은 결함을 고쳤다.
//
// **왜 모듈로 빼는가.** 같은 판단이 화면 두 곳(모의 봇 목록 · 자동매매
// 예약)에 있으면 언젠가 갈린다 — CLAUDE.md가 "경로가 둘인데 한쪽만
// 고침"을 상습 고장으로 적어 둔 그것이다. 판단은 여기 한 곳에 두고
// 시험을 붙인다.
//
// ⚠ 아직 `dueDiagView`는 제 복사본을 쓴다. 그 파일은 지금 PR #693이
//   잡고 있어 **같은 파일을 두 PR이 건드리지 않기 위해** 이번에는
//   건드리지 않는다. 합치는 것은 #693이 머지된 뒤의 후속 작업이다.
// ─────────────────────────────────────────────────────────────

export interface NextRunView {
  /**
   * 좁은 칸에 적을 **짧은 말**. 320px에서 이 칸은 105px밖에 안 된다 —
   * 「지금 차례 — 다음 회차에 평가합니다」는 실측에서 180px를 요구해
   * 말줄임이 뜻을 지웠다(`지금 차례 — 다음 회…`). 짧은 말을 적고
   * 설명은 `detail`로 내린다.
   */
  text: string;
  /** 같은 사실을 끝까지 적은 문장. 툴팁·상세에 쓴다 */
  detail: string;
  /** 예정 자체가 없다 (정지 등). 시각이 아니라 이유를 적은 것 */
  blocked: boolean;
  /** 예정 시각이 이미 지났다 — 실행기가 밀린 것이다 */
  overdue: boolean;
}

/** 읽지 못한 것은 통과가 아니다. 0도 "없음"도 아니다 */
export const UNKNOWN_TEXT = '확인 불가';

/**
 * 시각을 **오늘 기준으로** 짧게 적는다.
 *
 *   오늘   → `오후 1:15`
 *   내일   → `내일 오후 1:15`
 *   어제   → `어제 오후 1:15`
 *   그 밖  → `11. 20. 오후 1:15`
 *
 * 초는 어디에도 적지 않는다. 평가 주기가 분 단위라 초는 읽는 사람에게
 * 쓸모가 없고, 자리만 네 칸 먹는다.
 */
export function compactTime(atMs: number, nowMs: number, timeZone?: string): string {
  if (!Number.isFinite(atMs)) return UNKNOWN_TEXT;
  const hhmm = new Date(atMs).toLocaleTimeString('ko-KR',
    { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-CA',
    timeZone ? { timeZone } : undefined); // YYYY-MM-DD, 비교용
  const a = day(atMs), n = day(nowMs);
  if (a === n) return hhmm;
  const DAY = 86_400_000;
  if (a === day(nowMs + DAY)) return `내일 ${hhmm}`;
  if (a === day(nowMs - DAY)) return `어제 ${hhmm}`;
  const md = new Date(atMs).toLocaleDateString('ko-KR',
    { month: 'numeric', day: 'numeric', ...(timeZone ? { timeZone } : {}) });
  return `${md} ${hhmm}`;
}

/**
 * 다음 평가 칸을 정한다. **순서가 규칙이다.**
 *
 *   ① 막힌 이유가 있으면  → 그 이유. 시각은 적지 않는다
 *   ② 시각을 못 읽었으면  → 확인 불가 (0도 "없음"도 아니다)
 *   ③ 이미 지난 시각이면  → 지금 차례
 *   ④ 그 밖               → 짧은 시각
 *
 * `blockedReason`은 **부르는 쪽이 판정해서** 넘긴다. 여기서 `enabled`를
 * 다시 읽지 않는다 — 그러면 같은 규칙이 또 두 곳이 된다.
 */
export function nextRunText(input: {
  /** 짧은 말. 예: `예정 없음` */
  blockedReason?: string | null;
  /** 그 이유를 끝까지. 없으면 짧은 말을 그대로 쓴다 */
  blockedDetail?: string | null;
  atMs?: number | null;
  nowMs: number;
  timeZone?: string;
}): NextRunView {
  const { blockedReason, blockedDetail, atMs, nowMs, timeZone } = input;
  if (blockedReason) {
    return { text: blockedReason, detail: blockedDetail || blockedReason,
      blocked: true, overdue: false };
  }
  if (atMs == null || !Number.isFinite(atMs)) {
    return { text: UNKNOWN_TEXT, detail: '다음 평가 시각을 읽지 못했습니다',
      blocked: false, overdue: false };
  }
  if (atMs <= nowMs) {
    return { text: '지금 차례', detail: '예정 시각이 지났습니다 — 다음 회차에 평가합니다',
      blocked: false, overdue: true };
  }
  const t = compactTime(atMs, nowMs, timeZone);
  return { text: t, detail: `다음 평가 ${t}`, blocked: false, overdue: false };
}

/** 문자열 시각을 ms로. 못 읽으면 null — **0으로 적지 않는다** */
export function parseAt(v: string | null | undefined): number | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

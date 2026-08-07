// src/lib/ui/autoOverview.ts
//
// **자동매매 화면이 조작 화면이 아니라 진단 로그처럼 보인다.**
//
// 등록된 예약 · 스위치 · 거래소 연결 · 자동 실행 열쇠 · 크론 열쇠 ·
// 1회 증거금 · 실제 실행 · 마지막 판단이 전부 같은 비중으로 세로로
// 늘어서 있다. 그런데 매일 보고 싶은 것은 다섯 개뿐이다.
//
//   ① 지금 켜졌나  ② 다음 실행 언제인가  ③ 어떤 전략이 도나
//   ④ 왜 진입했거나 안 했나  ⑤ 문제가 있나
//
// 나머지는 문제가 생겼을 때만 필요하다. 그래서 **정상일 때는 한 줄로
// 접고, 막힌 것이 있을 때만 펼친다.**
//
// 그리고 순서가 거꾸로였다
// ────────────────────────
// 가장 중요한 '마지막 판단'이 맨 아래에 작은 글씨로 묻혀 있었다.
// 사용자가 이 화면에 오는 이유가 대부분 그것인데도 그렇다. 위로 올린다.
//
// 여기서 판정만 한다
// ──────────────────
// 색·글꼴·배치는 화면이 정한다. 이 파일은 **무엇을 접고 무엇을 올릴지**를
// 정하고, 그 판정에 테스트를 붙일 수 있게 한다. 화면 안에서 이 판단을
// 하면 "정상인데 왜 펼쳐졌나"를 아무도 확인할 수 없다.

// ── 탭 ────────────────────────────────────────────────────

export type AutoTabId = 'overview' | 'strategies' | 'schedule' | 'history' | 'diagnostics';

/**
 * 화면 탭.
 *
 * **진단이 마지막인 것이 요점이다.** 지금 기본 화면에 길게 펼쳐진 것
 * 대부분이 여기로 가야 한다.
 */
export const AUTO_TABS: Array<{ id: AutoTabId; label: string; desc: string }> = [
  { id: 'overview',    label: '개요',   desc: '지금 상태만 — 매일 보는 것' },
  { id: 'strategies',  label: '전략',   desc: '어떤 전략이 도는가 · 전략 계좌' },
  { id: 'schedule',    label: '예약',   desc: '실행 주기와 조건' },
  { id: 'history',     label: '기록',   desc: '진입 · 관망 · 차단 · 오류' },
  { id: 'diagnostics', label: '진단',   desc: '점검 목록과 개발용 상세' },
];

export function tabOf(v: any): AutoTabId {
  const s = String(v ?? '').trim();
  return AUTO_TABS.some(t => t.id === s) ? (s as AutoTabId) : 'overview';
}

// ── 실행 환경 ─────────────────────────────────────────────

export type RunEnv = 'MOCK' | 'TESTNET' | 'LIVE';

/**
 * 이 예약이 어느 환경에서 도는가.
 *
 * **모르는 값을 실전으로도 모의로도 읽지 않는다.** 실전으로 읽으면
 * 멀쩡한 테스트넷 화면이 빨갛게 겁을 주고, 모의로 읽으면 실제 돈이
 * 나가는 화면이 조용해진다. 뒤쪽이 훨씬 나쁘므로 **모르면 TESTNET**이다
 * — 이 저장소의 규칙(`is_testnet === false`일 때만 실전)과 같은 방향이다.
 */
export function envOf(mode: any): RunEnv {
  const s = String(mode ?? '').trim().toUpperCase();
  if (s.startsWith('LIVE')) return 'LIVE';
  if (s === 'PAPER' || s === 'MOCK' || s.startsWith('PAPER')) return 'MOCK';
  return 'TESTNET';
}

export const ENV_LABEL: Record<RunEnv, string> = {
  MOCK: 'MOCK', TESTNET: 'TESTNET', LIVE: 'LIVE',
};

/** 화면이 색으로 옮길 의미. 이 파일은 색을 모른다 */
export type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'live';

export const ENV_TONE: Record<RunEnv, Tone> = {
  MOCK: 'muted', TESTNET: 'warn', LIVE: 'live',
};

/**
 * 제목.
 *
 * '실제 실행'이라는 말이 무섭게 읽힌다는 지적이 맞다. 환경을 괄호로
 * 붙이면 무엇이 걸려 있는지가 오해 없이 그대로 나온다.
 */
export function autoTitle(env: RunEnv): string {
  return env === 'LIVE' ? '자동매매 (실전)'
    : env === 'MOCK' ? '자동매매 (모의)'
      : '자동매매 (테스트넷)';
}

/**
 * 머리말에 적을 환경 하나.
 *
 * 예약이 여럿이면 환경이 섞일 수 있다. 그때 **가장 위험한 쪽을 적는다** —
 * 실전 예약이 하나라도 켜져 있는데 머리말이 'TESTNET'이면, 사용자는
 * 실제 돈이 걸린 화면을 연습 화면으로 본다.
 *
 * 켜진 예약만 센다. 꺼 둔 실전 예약 때문에 화면이 빨개지면, 그 빨강은
 * 곧 배경이 된다.
 */
export function headerEnvOf(schedules: any[] | null | undefined): RunEnv {
  const on = (Array.isArray(schedules) ? schedules : []).filter(s => s?.enabled);
  if (on.length === 0) return 'TESTNET';
  const envs = on.map(s => envOf(s.mode));
  if (envs.includes('LIVE')) return 'LIVE';
  if (envs.includes('TESTNET')) return 'TESTNET';
  return 'MOCK';
}

// ── 안전 점검 접기 ────────────────────────────────────────

export interface HealthLike {
  id?: string;
  label?: string;
  state?: 'ok' | 'bad' | 'unknown' | string;
}

export interface HealthSummary {
  ok: number;
  bad: number;
  unknown: number;
  total: number;
  /** 전부 ok인가. **확인 못 한 것은 ok가 아니다** */
  allGood: boolean;
  /** 막힌 항목 수 */
  blockingCount: number;
  /**
   * 접힌 채로 둘 것인가.
   *
   * 막힌 것이 있으면 펼친다. 확인 못 한 것만 있을 때는 **펼치지 않고
   * 개수를 접힌 줄에 적는다** — 그것까지 펼치면 거의 언제나 펼쳐져 있고,
   * 그러면 접는 뜻이 없어진다. 다만 숨기지도 않는다.
   */
  expandByDefault: boolean;
  /** 접힌 한 줄 */
  label: string;
  /** 막힌 항목 이름들 */
  blockingLabels: string[];
}

export function healthSummaryOf(items: HealthLike[] | null | undefined): HealthSummary {
  const list = Array.isArray(items) ? items : [];
  const bad = list.filter(i => i?.state === 'bad');
  const unknown = list.filter(i => i?.state === 'unknown');
  const ok = list.filter(i => i?.state === 'ok').length;
  const total = list.length;

  const blockingLabels = bad.map(i => String(i?.label ?? i?.id ?? '이름 없는 항목'));

  let label: string;
  if (total === 0) {
    label = '점검할 항목을 읽지 못했습니다';
  } else if (bad.length > 0) {
    label = `${ok}/${total} · 주문 차단 항목 ${bad.length}개`;
  } else if (unknown.length > 0) {
    // **'정상'이라고 쓰지 않는다.** 확인하지 못한 것은 통과가 아니다.
    label = `${ok}/${total} · 확인 못 한 항목 ${unknown.length}개`;
  } else {
    label = `${ok}/${total} 정상`;
  }

  return {
    ok, bad: bad.length, unknown: unknown.length, total,
    allGood: total > 0 && ok === total,
    blockingCount: bad.length,
    expandByDefault: bad.length > 0,
    label,
    blockingLabels,
  };
}

export function healthTone(s: HealthSummary): Tone {
  if (s.total === 0) return 'muted';
  if (s.bad > 0) return 'bad';
  if (s.unknown > 0) return 'warn';
  return 'good';
}

// ── 마지막 판단 ───────────────────────────────────────────

export type DecisionVerdict =
  /** 진입했다 */
  | 'ENTERED'
  /** 조건이 안 맞아 안 들어갔다 — **정상이고 실패가 아니다** */
  | 'WATCHING'
  /** 설정·안전장치에 막혔다 */
  | 'BLOCKED'
  /** 실행 자체가 실패했다 */
  | 'ERROR'
  /** 기록이 없거나 읽지 못했다 */
  | 'UNKNOWN';

export const DECISION_LABEL: Record<DecisionVerdict, string> = {
  ENTERED: '진입',
  WATCHING: '거래 안 함',
  BLOCKED: '차단됨',
  ERROR: '오류',
  UNKNOWN: '기록 없음',
};

export const DECISION_TONE: Record<DecisionVerdict, Tone> = {
  ENTERED: 'good', WATCHING: 'warn', BLOCKED: 'bad', ERROR: 'bad', UNKNOWN: 'muted',
};

export interface DecisionCard {
  verdict: DecisionVerdict;
  tone: Tone;
  badge: string;
  symbol: string;
  /** 사람이 읽는 한 줄 */
  headline: string;
  /** 원문 그대로 — 파싱이 놓친 것을 사용자가 직접 볼 수 있어야 한다 */
  detail: string;
  longScore: number | null;
  shortScore: number | null;
  /** 두 점수의 차이 */
  margin: number | null;
  /** 진입에 필요한 최소 차이 */
  minMargin: number | null;
  /**
   * 점수를 실제로 읽었는가.
   *
   * **못 읽었으면 0으로 채우지 않는다.** 0:0은 '읽지 못함'이 아니라
   * '완전한 무승부'로 읽히고, 그 둘은 전혀 다른 이야기다.
   */
  scoresKnown: boolean;
  agoMs: number | null;
}

/**
 * 마지막 판단의 점수는 문장에서 읽는다.
 *
 * **문장을 파싱하는 것은 좋은 설계가 아니다.** 지금 `autotrade_schedules`
 * 에는 `last_result` 문자열 한 칸뿐이라 점수를 따로 담을 자리가 없다
 * (구조화해서 저장하는 것이 다음 할 일이다).
 *
 * 대신 **못 읽으면 없다고 말한다.** dailyBattle의 문장이 바뀌면 여기가
 * 조용히 0을 그리는 대신 "점수를 읽지 못했습니다"가 뜬다. 그리고 그
 * 문장 형식은 테스트가 붙들고 있으므로, 바뀌면 CI가 먼저 깨진다.
 */
export function parseScores(text: any): {
  longScore: number | null; shortScore: number | null;
  margin: number | null; minMargin: number | null;
} {
  const s = String(text ?? '');
  const num = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  //  "(LONG 54 : 46 SHORT)"  — 거래하지 않을 때의 문장
  let long: number | null = null, short: number | null = null;
  const m1 = s.match(/LONG\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*SHORT/);
  if (m1) { long = num(m1[1]); short = num(m1[2]); }

  //  "LONG 우세 (54 : 46)" · "SHORT 우세(54:46)였으나"
  //  **앞이 언제나 LONG이다** — dailyBattle이 side와 무관하게
  //  `${longTotal} : ${shortTotal}` 순으로 적는다.
  if (long == null) {
    const m2 = s.match(/(?:LONG|SHORT)\s*우세\s*\(\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*\)/);
    if (m2) { long = num(m2[1]); short = num(m2[2]); }
  }

  const mMin = s.match(/최소\s*우위\s*(\d+(?:\.\d+)?)\s*점/);
  //  "점수 차이 8점" · "점수차 8점"
  const mGap = s.match(/점수\s*차이?\s*(\d+(?:\.\d+)?)\s*점/);

  let margin = mGap ? num(mGap[1]) : null;
  if (margin == null && long != null && short != null) margin = Math.abs(long - short);

  return {
    longScore: long, shortScore: short,
    margin, minMargin: mMin ? num(mMin[1]) : null,
  };
}

/**
 * 저장되는 판단 기록 (`autotrade_schedules.last_decision`).
 *
 * **문장이 아니라 숫자로 담는다.** 예전에는 이 값이 없어서 화면이
 * dailyBattle의 한국어 문장을 정규식으로 파싱했다 — 말을 다듬는 순간
 * 화면이 조용히 숫자를 잃는 구조였다.
 */
export interface StoredDecision {
  verdict?: DecisionVerdict | string | null;
  side?: 'LONG' | 'SHORT' | 'NO_TRADE' | string | null;
  longScore?: number | null;
  shortScore?: number | null;
  margin?: number | null;
  minMargin?: number | null;
  reason?: string | null;
}

export interface BattleLike {
  side?: any;
  longTotal?: any;
  shortTotal?: any;
  margin?: any;
  minMarginRequired?: any;
  reason?: any;
}

/**
 * 실행 결과를 저장할 모양으로 만든다.
 *
 * **읽지 못한 값은 넣지 않는다.** 0을 넣으면 그게 '완전한 무승부'로
 * 저장되고, 나중에 그 행을 보는 사람은 엔진이 실제로 0점을 매겼다고
 * 읽는다. 없는 것과 0은 다르다.
 */
export function decisionRecordOf(
  verdict: DecisionVerdict, reason: any, battle?: BattleLike | null,
): StoredDecision {
  const n = (v: any): number | null => {
    if (v == null || v === '' || typeof v === 'boolean') return null;
    const x = Number(v);
    return Number.isFinite(x) ? Number(x.toFixed(2)) : null;
  };
  const b = battle ?? {};
  const long = n(b.longTotal);
  const short = n(b.shortTotal);
  let margin = n(b.margin);
  if (margin == null && long != null && short != null) margin = Math.abs(long - short);

  return {
    verdict,
    side: b.side == null ? null : String(b.side),
    longScore: long, shortScore: short,
    margin, minMargin: n(b.minMarginRequired),
    reason: reason == null ? null : String(reason).slice(0, 300),
  };
}

export interface DecisionInput {
  symbol?: any;
  /** `autotrade_schedules.last_result` */
  lastResult?: any;
  /**
   * `autotrade_schedules.last_decision` — 있으면 **이쪽이 우선이다.**
   * 문장 파싱은 이 칸이 없는 옛 기록을 위한 대비책일 뿐이다.
   */
  stored?: StoredDecision | null;
  lastRunAtMs?: number | null;
  nowMs?: number | null;
}

/**
 * 마지막 판단 카드.
 *
 * **'돌았다'와 '진입했다'는 다르다.** 대부분의 날은 조건이 안 맞아
 * 진입하지 않고, 그건 정상이다. 그래서 관망을 실패와 같은 색으로
 * 칠하지 않는다 — 그러면 매일 빨간 화면을 보게 되고, 진짜 고장이 났을 때
 * 아무도 안 놀란다.
 */
export function decisionCardOf(input: DecisionInput | null | undefined): DecisionCard {
  const i = input ?? {};
  const raw = i.lastResult == null ? '' : String(i.lastResult).trim();
  const symbol = String(i.symbol ?? '').trim();
  const now = Number(i.nowMs);
  const at = Number(i.lastRunAtMs);
  const agoMs = Number.isFinite(now) && Number.isFinite(at) && at > 0
    ? Math.max(0, now - at) : null;

  // **저장된 숫자가 있으면 문장을 안 읽는다.** 문장 파싱은 이 칸이
  // 생기기 전의 기록을 위한 대비책이지, 정상 경로가 아니다.
  const st = i.stored ?? null;
  const numOf = (v: any): number | null => {
    if (v == null || v === '' || typeof v === 'boolean') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const storedLong = numOf(st?.longScore);
  const storedShort = numOf(st?.shortScore);

  const scores = storedLong != null && storedShort != null
    ? {
      longScore: storedLong, shortScore: storedShort,
      margin: numOf(st?.margin) ?? Math.abs(storedLong - storedShort),
      minMargin: numOf(st?.minMargin),
    }
    : parseScores(raw);
  const scoresKnown = scores.longScore != null && scores.shortScore != null;

  // 원문은 저장된 reason을 먼저 쓴다 — 같은 값이지만, last_result가
  // 300자에서 잘렸을 때 이쪽이 남아 있을 수 있다.
  const detail = String(st?.reason ?? '').trim() || raw;

  const make = (verdict: DecisionVerdict, headline: string): DecisionCard => ({
    verdict, tone: DECISION_TONE[verdict], badge: DECISION_LABEL[verdict],
    symbol, headline, detail,
    longScore: scores.longScore, shortScore: scores.shortScore,
    margin: scores.margin, minMargin: scores.minMargin,
    scoresKnown, agoMs,
  });

  const headlineFor = (v: DecisionVerdict): string => {
    if (v === 'WATCHING') {
      const gapText = scores.margin != null && scores.minMargin != null
        ? `실제 차이 ${scores.margin}점 · 진입 필요 최소차이 ${scores.minMargin}점`
        : '';
      return gapText ? `신호 우위가 부족해 관망했습니다 — ${gapText}`
        : '조건이 맞지 않아 진입하지 않았습니다';
    }
    if (v === 'ENTERED') return '진입했습니다';
    if (v === 'ERROR') return '실행이 실패했습니다';
    if (v === 'BLOCKED') return '안전장치에 막혀 주문을 내지 않았습니다';
    return '판단 결과를 해석하지 못했습니다';
  };

  // **저장된 판정이 있으면 그것을 믿는다.** 실행기가 직접 적은 값이고,
  // 문장에서 되짚는 것보다 언제나 정확하다.
  const storedVerdict = String(st?.verdict ?? '').trim().toUpperCase();
  if (storedVerdict && storedVerdict in DECISION_TONE && storedVerdict !== 'UNKNOWN') {
    return make(storedVerdict as DecisionVerdict, headlineFor(storedVerdict as DecisionVerdict));
  }

  if (!detail) return make('UNKNOWN', '아직 판단 기록이 없습니다');

  // ── 옛 기록: 문장에서 되짚는다 ──
  //
  // **'진입 안 함'을 먼저 본다.** '진입'으로 시작하는지만 보면 관망이
  // 진입으로 읽힌다 — 포지션이 없는데 있다고 믿게 된다.
  if (detail.startsWith('진입 안 함')) return make('WATCHING', headlineFor('WATCHING'));
  if (detail.startsWith('진입')) return make('ENTERED', headlineFor('ENTERED'));
  if (/^(호출 실패|실패)/.test(detail)) return make('ERROR', headlineFor('ERROR'));
  if (detail.startsWith('연결 없음')) {
    return make('BLOCKED', '거래소 연결이 없어 주문을 낼 수 없습니다');
  }
  // 모르는 문장은 **오류로도 정상으로도 세지 않는다.** 원문을 그대로 보여준다.
  return make('UNKNOWN', headlineFor('UNKNOWN'));
}

// ── 무엇을 맨 위에 둘 것인가 ──────────────────────────────

export type PrimaryCard = 'POSITION' | 'DECISION';

/**
 * 포지션이 있으면 판단보다 포지션이 먼저다.
 *
 * 돈이 실제로 걸려 있는 동안 "왜 안 들어갔는지"는 두 번째 관심사다.
 */
export function primaryCardOf(openPositions: any): PrimaryCard {
  const n = Number(openPositions);
  return Number.isFinite(n) && n > 0 ? 'POSITION' : 'DECISION';
}

/**
 * '전략 중지'가 실제로 무엇을 멈추는가.
 *
 * **신규 진입만 멈춘다. 열린 포지션 관리는 계속된다.**
 * 이 구분이 화면에 안 적히면, 사용자는 중지를 누르고 손절도 같이
 * 꺼졌다고 믿거나 반대로 포지션이 정리된 줄 안다. 못 여는 것은
 * 불편이고 못 닫는 것은 사고다.
 */
export function stopStrategyEffect(): {
  blocksNewEntry: boolean; keepsManagingPosition: boolean; note: string;
} {
  return {
    blocksNewEntry: true,
    keepsManagingPosition: true,
    note: '신규 진입만 멈춥니다 — 이미 열린 포지션의 손절·익절 관리는 계속됩니다',
  };
}

// ── 위험 상태 우선 표시 ───────────────────────────────────

export interface AlertInput {
  /** 대조되지 않은 주문 수 */
  unknownOrders?: number | null;
  /** 보호 주문이 없는 포지션 수 */
  unprotectedPositions?: number | null;
  /** 거래소 연결이 끊겼는가 */
  feedDown?: boolean | null;
  /** 시세 지연(초) */
  feedLagSec?: number | null;
  /** 점검에서 막힌 항목 이름들 */
  blockingLabels?: string[] | null;
}

export interface Alert { id: string; text: string; tone: Tone }

/** 이 이상 늦으면 시세를 믿고 주문할 수 없다 */
export const FEED_LAG_WARN_SEC = 5;

/**
 * 맨 위에 띄울 경고.
 *
 * **정상일 때는 빈 배열이다.** 정상 상태에서도 경고 자리를 차지하면
 * 그 자리는 배경이 되고, 진짜 경고가 떠도 아무도 안 본다.
 *
 * 순서가 판정이다 — 못 닫는 쪽(보호 없는 포지션)이 못 여는 쪽보다 먼저다.
 */
export function alertsOf(input: AlertInput | null | undefined): Alert[] {
  const i = input ?? {};
  const out: Alert[] = [];
  const n = (v: any): number => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };

  if (n(i.unprotectedPositions) > 0) {
    out.push({ id: 'unprotected', tone: 'bad',
      text: `보호 없는 포지션 ${n(i.unprotectedPositions)}건 — 손절이 붙지 않았습니다` });
  }
  if (n(i.unknownOrders) > 0) {
    out.push({ id: 'unknown', tone: 'bad',
      text: `대조 안 된 주문 ${n(i.unknownOrders)}건 — 나갔는지 확인되지 않았습니다` });
  }
  if (i.feedDown === true) {
    out.push({ id: 'feed', tone: 'bad', text: '거래소 연결이 끊겼습니다' });
  } else if (n(i.feedLagSec) >= FEED_LAG_WARN_SEC) {
    out.push({ id: 'lag', tone: 'warn',
      text: `시세 지연 ${n(i.feedLagSec).toFixed(1)}초` });
  }
  for (const label of (Array.isArray(i.blockingLabels) ? i.blockingLabels : [])) {
    out.push({ id: `block:${label}`, tone: 'bad', text: `자동매매 차단 · ${label}` });
  }
  return out;
}

// ── 예약 한 줄 요약 ───────────────────────────────────────

export interface ScheduleSummary {
  symbol: string;
  env: RunEnv;
  /** '10분마다' — 주기를 못 읽으면 빈 문자열 */
  intervalText: string;
  /** 계좌 표시. 연결이 없으면 그렇게 말한다 */
  accountText: string;
  connected: boolean;
  /** 기본 화면에 접어 둘 수 없는 것: 연결 없음은 주문이 안 나간다는 뜻이다 */
  blocking: boolean;
}

/**
 * 예약 카드는 기본 화면에서 네 줄이면 된다.
 *
 * 주기 · 다음 확인 · 심볼 · 계좌. 전체 목록은 예약 탭으로 보낸다 —
 * 아래로 스크롤해서 찾아갈 일이 아니다.
 */
export function scheduleSummaryOf(row: any, exchangeName?: string): ScheduleSummary {
  const r = row ?? {};
  const env = envOf(r.mode);
  const iv = Number(r.interval_min);
  const connected = !!r.connection_id;
  const ex = String(exchangeName ?? '').trim();

  return {
    symbol: String(r.symbol ?? '').trim() || '심볼 없음',
    env,
    intervalText: Number.isFinite(iv) && iv > 0 ? `${iv}분마다` : '',
    accountText: connected
      ? [ex, ENV_LABEL[env]].filter(Boolean).join(' ')
      : '연결 없음 — 주문을 낼 수 없습니다',
    connected,
    blocking: !connected,
  };
}

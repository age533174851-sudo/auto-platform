// src/lib/risk/lossStreak.ts
//
// 하루 한도만으로는 못 막는 두 가지 — **순수 함수**.
//
// 하루 한도(dailyLoss.ts)는 하루 안의 피해만 자른다. 그런데 실제로 계좌가
// 사라지는 모양은 보통 이렇다:
//
//   월 −2.8% · 화 −2.9% · 수 −2.7% · 목 −2.9% · 금 −2.6%
//
// 매일 한도(−3%)를 넘지 않았다. 하루 잠금은 **한 번도 안 걸린다.** 그런데
// 한 주에 −13%다. 하루 단위로만 보면 이 주를 볼 수 있는 눈이 없다.
//
// 그리고 연패. 다섯 번 연속 손절은 "운이 나빴다"일 수도 있지만, **전략이
// 지금 시장과 안 맞는다**는 신호일 때가 더 많다. 그 상태에서 여섯 번째를
// 넣는 것은 정보가 없는 상태로 넣는 것이다. 하루 쉬면 최소한 다음 날의
// 시장을 보고 다시 시작한다.
//
// 무엇을 잠그고 무엇을 안 잠그나
// ──────────────────────────────
// **신규 진입만 잠근다. 청산은 절대 막지 않는다.** 못 나가게 막는 잠금은
// 손실을 키우는 잠금이고, 잠금의 목적과 정반대다. 하루 한도와 같은 규칙이다.
//
// 모르는 것은 통과가 아니다
// ─────────────────────────
// 주간 손익을 못 읽었으면 한도를 넘었는지 알 수 없다. 그때는 `unknown`이고
// 막는 쪽이다. "조회가 실패했으니 일단 보내자"는 한도를 안 건 것과 같다.

export const DAY_MS = 86_400_000;

// ── 주간 한도 ────────────────────────────────────────────────

export interface WeeklyLossConfig {
  /** 주간 손실 한도(%). null이면 안 씀 */
  maxLossPct: number | null;
  /** 절대 금액 한도(USDT). 둘 다 있으면 **작은 쪽**이 이긴다 */
  maxLossUsd: number | null;
}

export const DEFAULT_WEEKLY: WeeklyLossConfig = {
  maxLossPct: 7,
  maxLossUsd: null,
};

export type LockStatus = 'ok' | 'locked' | 'unknown';

export interface LockVerdict {
  status: LockStatus;
  /** 신규 진입을 막아야 하는가. unknown도 막는다 */
  blockEntries: boolean;
  reason: string;
  /** 한도까지 남은 금액(USDT). 모르면 null */
  remainingUsd: number | null;
  /** 적용된 한도(USDT). 모르면 null */
  limitUsd: number | null;
  /** 언제 풀리는가 (epoch ms). 모르거나 해당 없으면 null */
  unlockAtMs: number | null;
}

const verdict = (v: Partial<LockVerdict> & { status: LockStatus; reason: string }): LockVerdict => ({
  blockEntries: v.status !== 'ok',
  remainingUsd: null, limitUsd: null, unlockAtMs: null,
  ...v,
});

export interface WeeklyLossInput {
  /** 이번 주 순손익(USDT). **모르면 null** — 0으로 주지 말 것 */
  weekNetUsd: number | null;
  /** 주 시작 시점의 자산(USDT). 비율 한도를 쓰려면 필요하다 */
  weekStartEquityUsd: number | null;
  cfg: WeeklyLossConfig;
  /** 다음 주 시작 시각 — 언제 풀리는지 알려주기 위해 */
  nextWeekStartMs?: number | null;
}

/**
 * 이번 주에 더 들어가도 되는가.
 *
 * 두 한도가 다 있으면 **작은 쪽**이 이긴다. 큰 쪽을 쓰면 한도를 두 개 건
 * 의미가 없다 — 사용자는 둘 다 지켜지길 기대하고 적었다.
 */
export function judgeWeeklyLoss(i: WeeklyLossInput): LockVerdict {
  const { cfg } = i;
  const hasPct = cfg.maxLossPct != null && Number(cfg.maxLossPct) > 0;
  const hasUsd = cfg.maxLossUsd != null && Number(cfg.maxLossUsd) > 0;

  if (!hasPct && !hasUsd) {
    return verdict({ status: 'ok', reason: '주간 한도가 설정되지 않았습니다' });
  }

  if (i.weekNetUsd == null || !Number.isFinite(Number(i.weekNetUsd))) {
    return verdict({
      status: 'unknown',
      reason: '이번 주 손익을 확인하지 못해 한도를 넘었는지 알 수 없습니다 — 신규 진입을 막습니다',
    });
  }

  const net = Number(i.weekNetUsd);
  const equity = i.weekStartEquityUsd;
  const equityOk = equity != null && Number.isFinite(Number(equity)) && Number(equity) > 0;

  if (hasPct && !equityOk) {
    // 비율 한도를 걸어 놨는데 기준 자산을 모르면 그 한도는 계산할 수 없다.
    // '한도 없음'으로 넘기면 사용자가 건 잠금이 조용히 사라진다.
    return verdict({
      status: 'unknown',
      reason: '주 시작 자산을 확인하지 못해 비율 한도를 계산할 수 없습니다 — 신규 진입을 막습니다',
    });
  }

  const limits: number[] = [];
  if (hasPct && equityOk) limits.push(Number(equity) * (Number(cfg.maxLossPct) / 100));
  if (hasUsd) limits.push(Number(cfg.maxLossUsd));
  // 센트 단위로 반올림한다. 10000 × 7% 는 자바스크립트에서
  // **700.0000000000001**이 나오고, 정확히 700을 잃은 사용자가
  // `700 >= 700.0000000000001`에서 통과해 버린다. 한도에 닿았는데 안
  // 잠기는 것은 한도를 한 번 더 넘게 두는 것이다 — 테스트가 이걸 잡았다.
  const limitUsd = Math.round(Math.min(...limits) * 100) / 100;

  const lost = net < 0 ? -net : 0;
  const remainingUsd = Math.max(0, limitUsd - lost);

  if (lost >= limitUsd) {
    return verdict({
      status: 'locked', limitUsd, remainingUsd: 0,
      unlockAtMs: i.nextWeekStartMs ?? null,
      reason: `이번 주 손실 ${lost.toFixed(2)} USDT가 주간 한도 ${limitUsd.toFixed(2)} USDT에 닿았습니다 `
        + '— 다음 주까지 신규 진입이 잠깁니다 (청산은 계속됩니다)',
    });
  }

  return verdict({
    status: 'ok', limitUsd, remainingUsd,
    reason: `주간 여유 ${remainingUsd.toFixed(2)} USDT`,
  });
}

// ── 연패 잠금 ────────────────────────────────────────────────

export interface StreakConfig {
  /** 이만큼 연속으로 잃으면 잠근다. null이면 안 씀 */
  maxConsecutiveLosses: number | null;
  /** 잠금 길이(시간). 기본은 다음 UTC 자정까지 */
  lockHours: number | null;
}

export const DEFAULT_STREAK: StreakConfig = {
  maxConsecutiveLosses: 5,
  lockHours: null,   // null = 다음 UTC 자정까지
};

export interface StreakTrade {
  /** 청산 시각 (ms) */
  closedAtMs: number;
  /** 순손익 (수수료 포함) */
  realizedPnl: number;
}

export interface StreakInput {
  /**
   * 최근 청산된 거래들. 순서는 상관없다 — 여기서 시각순으로 정렬한다.
   *
   * **null이면 '모른다'**. 빈 배열([])은 '거래가 없다'로, 둘은 다르다.
   */
  trades: StreakTrade[] | null | undefined;
  nowMs: number;
  cfg: StreakConfig;
}

export interface StreakVerdict extends LockVerdict {
  /** 지금 연패 수 */
  streak: number;
  /** 연패를 만든 마지막 거래 시각 */
  lastLossAtMs: number | null;
}

/**
 * 연속으로 몇 번 잃었는가, 그래서 쉬어야 하는가.
 *
 * 최근 거래부터 거꾸로 세다가 **이익이 하나 나오면 멈춘다.** 본전(±0)은
 * 연패를 끊지 않는다 — 잃지도 벌지도 않은 거래가 '반등'의 증거는 아니다.
 * 다만 세지도 않는다.
 *
 * 잠금은 **마지막 손절 시각 기준**이다. 지금 시각 기준으로 하면 조회할
 * 때마다 잠금이 뒤로 밀려 영원히 안 풀린다.
 */
export function judgeLossStreak(i: StreakInput): StreakVerdict {
  const base = { streak: 0, lastLossAtMs: null as number | null };
  const max = i.cfg.maxConsecutiveLosses;

  if (max == null || !Number.isFinite(Number(max)) || Number(max) <= 0) {
    return { ...verdict({ status: 'ok', reason: '연패 잠금이 설정되지 않았습니다' }), ...base };
  }

  if (!Array.isArray(i.trades)) {
    return {
      ...verdict({
        status: 'unknown',
        reason: '최근 거래 기록을 확인하지 못해 연패 여부를 알 수 없습니다 — 신규 진입을 막습니다',
      }), ...base,
    };
  }

  const rows = i.trades
    .filter(t => t && Number.isFinite(t.closedAtMs) && Number.isFinite(t.realizedPnl))
    .sort((a, b) => b.closedAtMs - a.closedAtMs);   // 최근 것부터

  let streak = 0;
  let lastLossAtMs: number | null = null;
  for (const t of rows) {
    if (t.realizedPnl > 0) break;          // 이익이 나오면 끊긴다
    if (t.realizedPnl === 0) continue;     // 본전은 끊지도 세지도 않는다
    streak++;
    if (lastLossAtMs == null) lastLossAtMs = t.closedAtMs;
  }

  if (streak < Number(max)) {
    return {
      ...verdict({
        status: 'ok',
        reason: streak > 0
          ? `연속 ${streak}회 손실 (${max}회에서 잠깁니다)`
          : '연패 없음',
      }),
      streak, lastLossAtMs,
    };
  }

  // 잠금 해제 시각. **마지막 손절 시각 기준**이다 (위 주석 참조).
  const from = lastLossAtMs ?? i.nowMs;
  const unlockAtMs = i.cfg.lockHours != null && Number(i.cfg.lockHours) > 0
    ? from + Number(i.cfg.lockHours) * 3_600_000
    : nextUtcDayStart(from);

  if (i.nowMs >= unlockAtMs) {
    return {
      ...verdict({
        status: 'ok',
        reason: `연속 ${streak}회 손실이 있었지만 잠금 시간이 지났습니다`,
      }),
      streak, lastLossAtMs,
    };
  }

  return {
    ...verdict({
      status: 'locked', unlockAtMs,
      reason: `연속 ${streak}회 손절 — ${new Date(unlockAtMs).toISOString().slice(0, 16).replace('T', ' ')} UTC까지 `
        + '신규 진입이 잠깁니다 (청산은 계속됩니다)',
    }),
    streak, lastLossAtMs,
  };
}

// ── 시간 경계 ────────────────────────────────────────────────

/** 다음 UTC 자정 */
export function nextUtcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + DAY_MS;
}

/**
 * 이번 주의 시작 — **UTC 월요일 0시**.
 *
 * 일요일 시작으로 하면 주말에 걸친 손실이 두 주로 쪼개진다. 그리고
 * 거래소 주간 통계도 대부분 월요일 기준이다.
 */
export function utcWeekStart(ms: number): number {
  const d = new Date(ms);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  // getUTCDay: 0=일요일. 월요일을 0으로 옮긴다 (일요일은 6일 전이 월요일)
  const shift = (d.getUTCDay() + 6) % 7;
  return dayStart - shift * DAY_MS;
}

/** 다음 주 시작 (UTC 월요일 0시) */
export function nextUtcWeekStart(ms: number): number {
  return utcWeekStart(ms) + 7 * DAY_MS;
}

// ── 설정 ─────────────────────────────────────────────────────

export function readWeeklyLossConfig(
  env: (k: string) => string | undefined,
  /**
   * 실전인가 연습인가. 기본은 LIVE — **안 넘기면 예전과 똑같이 동작한다.**
   * 스코프를 새로 넣으면서 기존 호출부가 조용히 느슨해지면 안 된다.
   */
  scope: import('./limitScope').LimitScope = 'LIVE',
): { cfg: WeeklyLossConfig; note: string } {
  const notes: string[] = [];
  const num = (k: string, fallback: number | null): number | null => {
    const raw = env(k);
    if (raw == null || String(raw).trim() === '') return fallback;
    if (/^(off|none|false|0)$/i.test(String(raw).trim())) return null;   // 명시적으로 끄기
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
    notes.push(`${k}='${raw}'는 쓸 수 없는 값이라 기본값을 씁니다`);
    return fallback;
  };
  const { scopedEnv, scopedDefault } = require('./limitScope');
  const e = scopedEnv(env, scope);
  const pctDefault = scopedDefault(scope, 'weeklyMaxLossPct', DEFAULT_WEEKLY.maxLossPct);
  if (scope === 'TESTNET') notes.push('연습 환경 한도');
  return {
    cfg: {
      maxLossPct: numFrom(e, notes, 'WEEKLY_MAX_LOSS_PCT', pctDefault),
      maxLossUsd: numFrom(e, notes, 'WEEKLY_MAX_LOSS_USD', DEFAULT_WEEKLY.maxLossUsd),
    },
    note: notes.join(' · '),
  };
}

/** 스코프를 적용한 환경변수 읽기. `num`과 규칙이 같다 */
function numFrom(
  env: (k: string) => string | undefined, notes: string[],
  k: string, fallback: number | null,
): number | null {
  const raw = env(k);
  if (raw == null || String(raw).trim() === '') return fallback;
  if (/^(off|none|false|0)$/i.test(String(raw).trim())) return null;
  const v = Number(raw);
  if (Number.isFinite(v) && v > 0) return v;
  notes.push(`${k}='${raw}'는 쓸 수 없는 값이라 기본값을 씁니다`);
  return fallback;
}

export function readStreakConfig(
  env: (k: string) => string | undefined,
  scope: import('./limitScope').LimitScope = 'LIVE',
): { cfg: StreakConfig; note: string } {
  const notes: string[] = [];
  const { scopedEnv: sE, scopedDefault: sDefault } = require('./limitScope');
  const sEnv = sE(env, scope);
  const num = (k: string, fallback: number | null): number | null => {
    const raw = env(k);
    if (raw == null || String(raw).trim() === '') return fallback;
    if (/^(off|none|false|0)$/i.test(String(raw).trim())) return null;
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
    notes.push(`${k}='${raw}'는 쓸 수 없는 값이라 기본값을 씁니다`);
    return fallback;
  };
  return {
    cfg: {
      maxConsecutiveLosses: numFrom(sEnv, notes, 'MAX_CONSECUTIVE_LOSSES',
        sDefault(scope, 'maxConsecutiveLosses', DEFAULT_STREAK.maxConsecutiveLosses)),
      lockHours: numFrom(sEnv, notes, 'LOSS_STREAK_LOCK_HOURS', DEFAULT_STREAK.lockHours),
    },
    note: notes.join(' · '),
  };
}

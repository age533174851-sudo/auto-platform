// src/lib/runtime/mockSession.ts
//
// **모의 자동매매가 새로고침 한 번에 사라진다.**
//
//   src/components/MockAutoTrade.tsx
//   const [positions, setPositions] = useState([]);
//   const [cash, setCash] = useState(SEED);
//
// 세션이 컴포넌트 상태 안에만 있다. 탭을 닫으면 끝이고, 새로고침하면
// 종잣돈으로 돌아간다. 사용자가 사흘 돌린 모의 성과가 실수로 새로고침
// 한 번에 없어진다.
//
// 그래서 서버로 옮긴다. 그런데 옮기는 순간 **더 위험한 실수 하나가
// 가능해진다** — 따라잡기다.
//
// 따라잡기를 하면 안 되는 이유
// ────────────────────────────
// 세션을 서버에 저장하면 "12시간 꺼져 있었다"는 사실이 남는다. 이때
// 놓친 720번의 틱을 되돌려 계산하고 싶어진다. 그러면 안 된다:
//
//   · 그 구간의 시장 움직임을 우리는 모른다. 1분봉을 다시 받아 와도
//     그건 체결이 아니라 **재구성**이다
//   · 지어낸 체결은 없던 거래를 만든다. 모의 성과가 실제로는 한 번도
//     일어나지 않은 진입·청산으로 채워진다
//   · 그 성과를 보고 사용자는 실전 전환을 결정한다. **거짓 성과가
//     실제 돈을 움직인다**
//
// 그래서 규칙은 하나다: **빈 구간은 채우지 않고 빈 구간으로 남긴다.**
// 12시간 꺼져 있었으면 12시간 안 돈 것이다. 그 사실이 성과 옆에
// 적혀야 사용자가 숫자를 제대로 읽는다.
//
// 이 파일이 막으려는 것
// ─────────────────────
//   1. 놓친 구간을 시뮬레이션으로 채우는 것
//   2. 세션을 못 읽었는데 새 세션으로 시작하는 것 — 기록이 통째로
//      사라지고 잔고가 종잣돈으로 리셋된다
//   3. 설정을 바꾸고도 같은 성과에 이어 붙이는 것 — 무엇의 성과인지
//      알 수 없게 된다
//   4. 가격을 못 읽었는데 마지막 가격으로 평가하는 것 — 멈춘 시계로
//      손익을 내면 손실이 안 보인다
//   5. 모의 잔고를 실제 자산처럼 더하는 것

import { gapCheck } from './persistentRuntime';

// ── 상태 ──────────────────────────────────────────────────

export type MockStatus =
  /** 돌고 있다 */
  | 'RUNNING'
  /** 사용자가 멈췄다. 포지션은 그대로 */
  | 'PAUSED'
  /** 끝났다 */
  | 'STOPPED'
  /** 켜져 있어야 하는데 빈 구간이 있었다 */
  | 'GAP'
  /** 확인하지 못했다 */
  | 'UNKNOWN';

const STATUSES: MockStatus[] = ['RUNNING', 'PAUSED', 'STOPPED', 'GAP'];

/**
 * **모르는 상태를 RUNNING으로 읽지 않는다.**
 *
 * 안 도는 것을 돈다고 적으면 사용자는 기다린다. 기다리는 동안
 * 아무 일도 안 일어난다.
 */
export function statusOf(raw: any): MockStatus {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return (STATUSES as string[]).includes(s) ? (s as MockStatus) : 'UNKNOWN';
}

export interface MockPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
}

export interface MockOrder {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
}

export interface MockSession {
  id: string;
  /** 종잣돈. 성과를 재려면 출발점이 있어야 한다 */
  seed: number;
  /** 현금 */
  cash: number;
  positions: MockPosition[];
  openOrders: MockOrder[];
  /** 처음 시작한 시각. 가동률의 분모다 */
  startedAtMs: number | null;
  /** 마지막으로 실제 한 틱을 돌린 시각 */
  lastTickAtMs: number | null;
  intervalSec: number;
  status: MockStatus;
  /**
   * 설정 판. 설정을 바꾸면 올라간다.
   *
   * 이게 없으면 레버리지 3배로 낸 성과와 20배로 낸 성과가 한 줄에
   * 섞이고, 어느 쪽이 좋았는지 영영 알 수 없다.
   */
  configVersion: number;
  /** 빈 구간이 몇 번 있었는가 */
  gapCount: number;
  /** 빈 구간 때문에 안 돈 시간 합계(ms) */
  gapMs: number;
}

// ── 복구 ──────────────────────────────────────────────────

export type RestoreAction =
  /** 이어서 돌린다 */
  | 'RESUME'
  /** 새 세션을 만든다 */
  | 'START_FRESH'
  /** 아무것도 하지 않는다 */
  | 'BLOCK';

export interface RestoreVerdict {
  action: RestoreAction;
  session: MockSession | null;
  reason: string;
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 저장된 세션을 되살릴 수 있는가.
 *
 * **못 읽은 것과 없는 것을 구분한다.** 없으면 새로 시작해도 되지만,
 * 못 읽었는데 새로 시작하면 사흘 돌린 기록이 사라지고 잔고가 종잣돈으로
 * 리셋된다. 그리고 사용자는 그게 조회 실패였다는 것을 영영 모른다.
 *
 * @param row  DB 행. `null`이면 "없다", `undefined`면 "못 읽었다"
 */
export function restoreVerdict(row: any, opts?: { readFailed?: boolean }): RestoreVerdict {
  if (opts?.readFailed || row === undefined) {
    return { action: 'BLOCK', session: null,
      reason: '세션을 읽지 못했습니다 — 여기서 새 세션을 만들면 기존 모의 기록과 잔고가'
        + ' 종잣돈으로 리셋됩니다. 없는 것과 못 읽은 것은 다릅니다' };
  }
  if (row === null) {
    return { action: 'START_FRESH', session: null, reason: '' };
  }

  const seed = num(row.seed);
  const cash = num(row.cash);
  if (seed === null || cash === null) {
    return { action: 'BLOCK', session: null,
      reason: '세션은 있는데 종잣돈이나 현금을 읽지 못했습니다 — 0으로 채우면'
        + ' 손익이 종잣돈만큼 틀립니다' };
  }

  const iv = num(row.intervalSec ?? row.interval_sec);
  return {
    action: 'RESUME',
    session: {
      id: String(row.id ?? ''),
      seed, cash,
      positions: Array.isArray(row.positions) ? row.positions : [],
      openOrders: Array.isArray(row.openOrders ?? row.open_orders)
        ? (row.openOrders ?? row.open_orders) : [],
      startedAtMs: num(row.startedAtMs ?? row.started_at_ms),
      lastTickAtMs: num(row.lastTickAtMs ?? row.last_tick_at_ms),
      intervalSec: iv !== null && iv > 0 ? iv : 60,
      status: statusOf(row.status),
      configVersion: num(row.configVersion ?? row.config_version) ?? 0,
      gapCount: num(row.gapCount ?? row.gap_count) ?? 0,
      gapMs: num(row.gapMs ?? row.gap_ms) ?? 0,
    },
    reason: '',
  };
}

// ── 재개 ──────────────────────────────────────────────────

export interface ResumePlan {
  /** **언제나 false다.** 이 필드가 있는 이유는 아래 주석 참고 */
  catchUp: false;
  /** 되돌려 계산할 틱 수. 언제나 0 */
  ticksToSimulate: 0;
  /** 놓친 틱 수. 세는 것과 채우는 것은 다르다 */
  missedTicks: number | null;
  /** 빈 구간으로 기록해야 하는가 */
  markGap: boolean;
  /** 여기서부터 다시 시작한다 */
  resumeFromMs: number | null;
  note: string;
}

/**
 * 꺼져 있던 세션을 다시 켤 때 무엇을 하는가.
 *
 * **놓친 틱을 세되 채우지 않는다.**
 *
 * `catchUp`을 리터럴 `false` 타입으로 둔 것은 실수 방지다. 나중에
 * 누군가 "따라잡기 옵션"을 붙이려 하면 타입에서 먼저 막힌다 —
 * 그때 이 주석을 읽게 된다. 세는 것(missedTicks)과 채우는 것은 다르다.
 */
export function resumePlan(
  session: Pick<MockSession, 'lastTickAtMs' | 'intervalSec'> | null | undefined,
  nowMs: any,
): ResumePlan {
  const now = num(nowMs);
  const g = gapCheck({
    lastTickAtMs: session?.lastTickAtMs,
    nowMs: now,
    intervalSec: session?.intervalSec,
  });

  if (g.missedTicks === null) {
    return { catchUp: false, ticksToSimulate: 0, missedTicks: null, markGap: false,
      resumeFromMs: now,
      note: '마지막 실행 시각을 몰라 빈 구간을 세지 못했습니다 —'
        + ' 되돌려 계산하지 않고 지금부터 다시 시작합니다' };
  }

  if (!g.hasGap) {
    return { catchUp: false, ticksToSimulate: 0, missedTicks: 0, markGap: false,
      resumeFromMs: now, note: '' };
  }

  return {
    catchUp: false, ticksToSimulate: 0, missedTicks: g.missedTicks,
    markGap: true, resumeFromMs: now,
    note: `${g.missedTicks}번의 실행을 놓쳤습니다. 그 구간은 되돌려 계산하지 않고`
      + ' 빈 구간으로 남깁니다 — 그때의 시장을 우리는 모르고,'
      + ' 지어낸 체결은 없던 거래를 만듭니다. 성과를 읽을 때 이 구간을 빼고 보세요',
  };
}

/**
 * 빈 구간을 세션에 새긴다.
 *
 * **성과 옆에 이 숫자가 있어야 한다.** "수익률 12%"만 보면 좋아 보이지만
 * "그중 절반은 꺼져 있었다"면 다른 이야기다.
 */
export function applyGap(session: MockSession, plan: ResumePlan, nowMs: any): MockSession {
  if (!plan.markGap) return session;
  const now = num(nowMs);
  const last = session.lastTickAtMs;
  const add = now !== null && last !== null ? Math.max(0, now - last) : 0;
  return {
    ...session,
    status: 'GAP',
    gapCount: session.gapCount + 1,
    gapMs: session.gapMs + add,
  };
}

// ── 평가 ──────────────────────────────────────────────────

export interface MockEquity {
  equity: number | null;
  /** 가격을 못 읽은 종목 */
  unpriced: string[];
  note: string;
}

/**
 * 지금 이 세션이 얼마인가.
 *
 * **가격을 못 읽은 포지션이 하나라도 있으면 총액을 내지 않는다.**
 * 마지막 가격으로 대신 평가하면 멈춘 시계로 손익을 재는 것이고,
 * 그러면 급락 중에도 화면은 평온하다.
 */
export function equityOf(
  session: Pick<MockSession, 'cash' | 'positions'> | null | undefined,
  marks: Record<string, any> | null | undefined,
): MockEquity {
  const cash = num(session?.cash);
  if (cash === null) {
    return { equity: null, unpriced: [],
      note: '현금을 읽지 못해 평가액을 내지 않습니다' };
  }

  const positions = Array.isArray(session?.positions) ? session!.positions : [];
  const m = marks ?? {};
  const unpriced: string[] = [];
  let value = cash;

  for (const p of positions) {
    const qty = num(p?.qty);
    const entry = num(p?.entryPrice);
    const mark = num(m[p?.symbol]);
    if (qty === null || entry === null || mark === null) {
      unpriced.push(String(p?.symbol ?? '?'));
      continue;
    }
    const dir = p.side === 'SHORT' ? -1 : 1;
    value += entry * qty + dir * (mark - entry) * qty;
  }

  if (unpriced.length > 0) {
    return { equity: null, unpriced,
      note: `${unpriced.join(', ')}의 현재가를 읽지 못했습니다 —`
        + ' 마지막 가격으로 대신 평가하면 멈춘 시계로 손익을 재는 것이라 평가액을 내지 않습니다' };
  }
  return { equity: value, unpriced: [], note: '' };
}

export interface MockPerformance {
  returnPct: number | null;
  /** 실제로 돈 시간 비율(%). 빈 구간을 뺀 것 */
  uptimePct: number | null;
  note: string;
  /** 이 성과를 실전 판단에 써도 되는가 */
  usable: boolean;
}

/**
 * 모의 성과.
 *
 * **빈 구간이 있으면 성과에 그 사실을 붙인다.** 그리고 이건 모의다 —
 * 슬리피지도, 부분체결도, 거래소 지연도 없다. 그 차이를 안 적으면
 * 사용자는 이 숫자가 실전에서도 나올 거라고 믿는다.
 */
export function performanceOf(
  session: Pick<MockSession, 'seed' | 'gapCount' | 'gapMs' | 'startedAtMs'> | null | undefined,
  equity: number | null,
  nowMs: any,
): MockPerformance {
  const seed = num(session?.seed);
  const eq = num(equity);
  const gapMs = num(session?.gapMs) ?? 0;

  // 가동률의 분모는 "켠 뒤로 흐른 시간"이다. 시작 시각을 모르면
  // 분모가 없으므로 가동률을 내지 않는다 — 100%로 채우면 꺼져 있던
  // 시간이 통째로 사라진다.
  const started = num(session?.startedAtMs);
  const now = num(nowMs);
  const total = started !== null && now !== null ? Math.max(0, now - started) : null;

  const uptimePct = total !== null && total > 0
    ? Math.max(0, Math.min(100, ((total - gapMs) / total) * 100))
    : null;

  const base = '모의 결과입니다 — 슬리피지·부분체결·거래소 지연이 없어 실전보다 좋게 나옵니다';

  if (seed === null || seed <= 0 || eq === null) {
    return { returnPct: null, uptimePct, usable: false,
      note: '종잣돈이나 평가액을 몰라 수익률을 내지 않습니다. ' + base };
  }

  const returnPct = ((eq - seed) / seed) * 100;
  const gaps = num(session?.gapCount) ?? 0;

  if (gaps > 0) {
    return { returnPct, uptimePct, usable: false,
      note: `꺼져 있던 구간이 ${gaps}번 있었습니다`
        + (uptimePct !== null ? ` (실제 가동 ${uptimePct.toFixed(0)}%)` : '')
        + ' — 그 구간은 되돌려 계산하지 않았으므로 이 수익률은 연속 운용의 결과가 아닙니다. '
        + base };
  }
  return { returnPct, uptimePct, usable: true, note: base };
}

// ── 설정 변경 ─────────────────────────────────────────────

export interface ConfigChangeVerdict {
  /** 판을 올려야 하는가 */
  bump: boolean;
  nextVersion: number;
  /** 여기서 성과를 끊어야 하는가 */
  splitPerformance: boolean;
  note: string;
}

/**
 * 돌고 있는 세션의 설정을 바꿨다.
 *
 * **바꾸기 전과 후의 성과를 한 줄에 이어 붙이면 안 된다.** 레버리지
 * 3배로 번 것과 20배로 잃은 것이 섞이면, 어느 설정이 좋았는지를
 * 영영 알 수 없고 사용자는 잘못된 설정을 계속 쓴다.
 *
 * 세션을 지우자는 게 아니다 — **경계를 남기자는 것이다.**
 */
export function configChangeVerdict(
  session: Pick<MockSession, 'configVersion' | 'status'> | null | undefined,
  changed: boolean,
): ConfigChangeVerdict {
  const cur = num(session?.configVersion) ?? 0;
  if (!changed) {
    return { bump: false, nextVersion: cur, splitPerformance: false, note: '' };
  }
  const running = session?.status === 'RUNNING' || session?.status === 'GAP';
  return {
    bump: true, nextVersion: cur + 1, splitPerformance: true,
    note: running
      ? '돌고 있는 중에 설정을 바꿨습니다 — 여기서 성과를 끊습니다.'
        + ' 바꾸기 전과 후를 한 줄로 이으면 어느 설정이 좋았는지 알 수 없습니다'
      : '설정이 바뀌었습니다 — 이전 성과와 따로 셉니다',
  };
}

// ── 실제 자산과 섞지 않는다 ───────────────────────────────

/**
 * **모의 잔고는 자산이 아니다.**
 *
 * 지갑 화면의 총자산에 모의 1천만원이 더해지면 그 숫자는 뜻을 잃는다.
 * 여기서 한 번 더 막는다 — 합산하는 쪽에서 실수해도 걸리도록.
 */
export const MOCK_IS_NOT_ASSET_NOTE =
  '모의 잔고는 실제 자산이 아닙니다 — 총자산에 더하지 않습니다';

export const NO_CATCH_UP_NOTE =
  '꺼져 있던 구간은 되돌려 계산하지 않습니다. 그때의 시장을 우리는 모르고,'
  + ' 지어낸 체결은 없던 거래를 만듭니다 — 그 성과를 보고 실전 전환을 결정하게 됩니다';

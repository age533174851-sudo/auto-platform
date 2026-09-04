// src/lib/ui/autoCockpit.ts
//
// **자동매매 첫 화면이 답해야 하는 한 가지 질문.**
//
//   "지금 내 돈이 실제로 자동으로 움직이고 있는가?"
//
// 왜 이 파일이 생겼나
// ───────────────────
// 이 화면에는 그 질문의 주인이 **둘**이었다.
//
//   · AutotradeControl — 서버 예약·연결·실행기 건강을 읽어 판정한다.
//   · AutoPage         — `useState<ExecMode>('paper')` 로컬 토글로
//                        "모의 자동매매 모드 — 실제 자금 이동 없음"
//                        같은 배너를 **혼자** 그린다.
//
// 두 번째는 서버를 한 번도 부르지 않는다. 그래서 실전 예약이 켜져 있어도
// 같은 화면이 "실제 자금 이동 없음"이라고 말할 수 있었다. 사용자가 가장
// 믿으면 안 되는 방향으로 틀리는 배치다.
//
// 그래서 판정을 **한 곳**으로 모은다. 이 파일은 서버가 이미 만든 사실만
// 조합한다 — 새 판단을 만들지 않는다:
//
//   enabled · mode · connectionState · strategyRunnable · runtime.state
//   (전부 /api/autotrade/schedule 이 줄마다 붙여 주는 값)
//
// 지켜야 하는 것
// ──────────────
//   · 못 읽은 것은 0도 OFF도 아니다 → UNKNOWN
//   · `enabled === true` 하나로 '실행 중'이라고 쓰지 않는다
//   · 환경이 섞이면 **가장 위험한 쪽**을 머리말에 쓴다(LIVE 우선)
//   · 막혔으면 왜 막혔는지까지 말한다
//
// 이 파일은 색도 글꼴도 모른다. 화면이 tone을 색으로 옮긴다.

import type { Tone } from './display';
import { envOf, headerEnvOf, type RunEnv } from './autoOverview';

/**
 * 첫 화면이 말할 수 있는 상태.
 *
 * **`RUNNING`이라는 이름을 쓰지 않는다.** 이 화면이 실제로 증명할 수 있는
 * 것은 "예약이 켜져 있고 막힌 것이 없다"까지다. 지금 이 순간 주문이
 * 나가는 중인지는 다른 사실이고, 그것을 말할 정본은 아직 없다.
 */
export type CockpitState =
  /** 예약을 읽지 못했다. **꺼짐이 아니다** */
  | 'UNKNOWN'
  /** 읽었고, 켜진 예약이 없다 */
  | 'OFF'
  /** 켜진 예약이 있지만 지금은 주문이 나갈 수 없다 */
  | 'BLOCKED'
  /** 켜진 예약이 있고 막힌 것이 없다 — 조건이 맞으면 주문이 나간다 */
  | 'ARMED';

export interface CockpitBlocker {
  /** 어느 예약인가 (종목). 줄을 특정할 수 없으면 빈 문자열 */
  where: string;
  /** 왜 막혔는가 */
  why: string;
}

export interface CockpitVerdict {
  state: CockpitState;
  /** 켜진 예약 기준 환경. UNKNOWN·OFF에서는 null — 없는 환경을 지어내지 않는다 */
  env: RunEnv | null;
  tone: Tone;
  headline: string;
  /** 머리말 아래 한 줄. 무엇을 근거로 그렇게 말하는지 */
  detail: string;
  blockers: CockpitBlocker[];
  /** 켜진 예약 수. **모르면 null** */
  activeCount: number | null;
  /** 그중 실전. **모르면 null** */
  liveCount: number | null;
  /** 사용자가 다음에 할 일. 없으면 빈 문자열 */
  nextAction: string;
}

const s = (v: any): string => (v == null ? '' : String(v));

/** 이 줄이 지금 주문을 낼 수 없는 이유. 없으면 null */
function blockerOf(row: any): string | null {
  // 연결이 사라졌거나 다시 묶어야 한다 — 예약 시각이 와도 아무 일도 없다.
  const conn = s(row?.connectionState).toUpperCase();
  if (row?.needsRebind === true) return s(row?.connectionNote) || '거래소 연결을 다시 묶어야 합니다';
  if (conn && conn !== 'OK' && conn !== 'ACTIVE') {
    return s(row?.connectionNote) || `거래소 연결 상태: ${conn}`;
  }
  // 이 전략이 지금 코드로 돌 수 없다.
  if (row?.strategyRunnable === false) return s(row?.strategyNote) || '이 전략은 지금 실행할 수 없습니다';

  // 서버가 이미 판정한 runtime. **여기서 다시 판단하지 않는다.**
  const rt = s(row?.runtime?.state).toUpperCase();
  if (rt === 'STALE' || rt === 'BLOCKED' || rt === 'FAILED') {
    return s(row?.runtime?.reason) || `실행 상태: ${rt}`;
  }
  return null;
}

/**
 * 첫 화면의 판정 하나.
 *
 * @param rows `/api/autotrade/schedule`의 줄들. **못 읽었으면 `null`을 넘긴다.**
 *             빈 배열(`[]`)은 "읽었고 없다"는 **다른 뜻**이다.
 * @param readError 못 읽은 이유(있으면 화면에 그대로 보여 준다)
 */
export function cockpitVerdict(
  rows: any[] | null | undefined,
  readError?: string | null,
): CockpitVerdict {
  // ── 못 읽었다 ──
  // 여기서 0이나 '꺼짐'으로 눕히면, 실제로 돌고 있는 자동매매를 사용자가
  // 멈춰 있다고 읽는다. 그 방향의 오해가 가장 비싸다.
  if (!Array.isArray(rows)) {
    return {
      state: 'UNKNOWN', env: null, tone: 'muted',
      headline: '자동매매 상태를 확인하지 못했습니다',
      detail: s(readError) || '예약 목록을 읽지 못했습니다 — 꺼져 있다는 뜻이 아닙니다',
      blockers: [], activeCount: null, liveCount: null,
      nextAction: '새로고침하거나 로그인 상태를 확인하세요',
    };
  }

  const on = rows.filter(r => r?.enabled === true);

  // ── 읽었고, 켜진 것이 없다 ──
  if (on.length === 0) {
    return {
      state: 'OFF', env: null, tone: 'muted',
      headline: '켜져 있는 자동매매가 없습니다',
      detail: rows.length === 0
        ? '등록된 예약이 없습니다'
        : `등록된 예약 ${rows.length}개가 모두 꺼져 있습니다`,
      blockers: [], activeCount: 0,
      liveCount: 0,
      nextAction: '아래에서 종목·연결을 고르고 자동매매를 켜세요',
    };
  }

  const env = headerEnvOf(rows);
  const liveCount = on.filter(r => envOf(r?.mode) === 'LIVE').length;

  const blockers: CockpitBlocker[] = [];
  for (const r of on) {
    const why = blockerOf(r);
    if (why) blockers.push({ where: s(r?.symbol), why });
  }

  const envWord = env === 'LIVE' ? '실전' : env === 'MOCK' ? '모의' : '테스트넷';

  // ── 켜져 있는데 막혔다 ──
  // **'실행중'이라고 쓰지 않는다.** 켜짐과 나갈 수 있음은 다른 사실이다.
  if (blockers.length > 0) {
    const allBlocked = blockers.length === on.length;
    return {
      state: 'BLOCKED',
      env, tone: 'bad',
      headline: allBlocked
        ? `자동매매가 켜져 있지만 지금은 주문이 나가지 않습니다`
        : `자동매매 ${on.length}개 중 ${blockers.length}개가 막혀 있습니다`,
      detail: `${envWord} · 막힌 이유: ${blockers[0].why}`,
      blockers,
      activeCount: on.length, liveCount,
      nextAction: '아래 막힌 예약의 사유를 확인하세요',
    };
  }

  // ── 켜져 있고 막힌 것이 없다 ──
  return {
    state: 'ARMED',
    env,
    // 실전은 색부터 다르다. 연습 화면과 같은 초록이면 안 된다.
    tone: env === 'LIVE' ? 'live' : env === 'MOCK' ? 'muted' : 'warn',
    headline: env === 'LIVE'
      ? `실전 자동매매가 켜져 있습니다 — 실제 돈이 나갈 수 있습니다`
      : `${envWord} 자동매매가 켜져 있습니다`,
    detail: liveCount > 0 && on.length > liveCount
      ? `예약 ${on.length}개 (실전 ${liveCount}개 포함) · 조건이 맞으면 주문이 나갑니다`
      : `예약 ${on.length}개 · 조건이 맞으면 주문이 나갑니다`,
    blockers: [],
    activeCount: on.length, liveCount,
    nextAction: '',
  };
}

/**
 * 첫 화면에 띄울 환경 배지 글자.
 *
 * **없는 환경을 지어내지 않는다.** 켜진 예약이 없거나 못 읽었으면 배지
 * 자체를 그리지 않는다(null). 예전에는 로컬 토글 기본값 때문에 아무것도
 * 켜져 있지 않아도 'PAPER'라고 적혀 있었다.
 */
export function cockpitEnvBadge(v: CockpitVerdict): string | null {
  return v.env == null ? null : v.env;
}

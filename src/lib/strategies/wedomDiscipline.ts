// src/lib/strategies/wedomDiscipline.ts
//
// **웨돔 규율 게이트 — 진입 조건이 아니라 '안 하는 규칙'.**
//
// 무엇을 구현한 것인가
// ────────────────────
// 웨돔 매매법의 핵심은 특정 지표가 아니라 **행동 원칙**이다:
//
//   기다림이 가장 큰 무기 · 애매하면 안 한다 · 진입하면 계획대로 끝낸다
//   불필요한 매매를 줄인다 · 하락 패턴이 보이면 미련 없이 정리한다
//
// 이 중 **구조 판단(그림·BOS·FVG·OB)은 여기 없다.** 그건 차트 구조
// 인식이 필요하고 아직 없다. 없는 것을 있는 척하면 이 파일 전체가
// 못 믿을 것이 된다.
//
// 여기 있는 것은 **기계가 완벽하게 지킬 수 있고 사람이 가장 자주 어기는
// 부분**이다 — 횟수 제한, 회전율 제한, 애매하면 패스, 진입 후 개입 금지.
// 실제로 그 부분이 대부분의 손실을 만든다.
//
// 왜 이것만으로도 값이 있는가
// ───────────────────────────
// 좋은 진입 조건을 아는 사람은 많다. 그걸 알면서 하루에 스무 번 매매해서
// 잃는다. 이 게이트는 그 스무 번을 세 번으로 만든다. 진입 로직이 하나도
// 없어도 그것만으로 결과가 바뀐다.
//
// **NO TRADE도 결과다**
// ─────────────────────
// 이 파일은 "오늘 0회"를 정상으로 표시한다. 포지션이 없는 것을 실패로
// 그리면 사람은 자리를 만들어서라도 들어간다 — 그게 정확히 없애려는
// 행동이다.

export interface DisciplineConfig {
  /** 이 점수 미만이면 진입하지 않는다 (0~100) */
  minScore: number;
  /** 하루 최대 진입 횟수 */
  maxTradesPerDay: number;
  /** 이 시간 안에 이 횟수를 넘으면 강제 휴식 */
  churnWindowMs: number;
  churnLimit: number;
  /** 강제 휴식 길이 */
  coolDownMs: number;
  /** 손익비가 이것보다 낮은 계획은 받지 않는다 */
  minRewardRisk: number;
}

/**
 * 기본값.
 *
 * minScore 95는 웨돔 원칙 그대로다. **이 값이 높다는 것이 핵심이다** —
 * 대부분의 자리를 거르는 것이 이 전략의 전부다. 낮추면 다른 전략이 된다.
 */
export const WEDOM_DEFAULTS: DisciplineConfig = {
  minScore: 95,
  maxTradesPerDay: 3,
  churnWindowMs: 3 * 3_600_000,
  churnLimit: 10,
  coolDownMs: 3 * 3_600_000,
  minRewardRisk: 2,
};

export interface DisciplineState {
  /**
   * 이 자리의 조건 만족도 (0~100).
   *
   * **모르면 null.** null이면 막는다 — 점수를 못 매겼다는 것은 자리를
   * 판단하지 못했다는 뜻이고, 판단 못 한 자리에 들어가는 것이 정확히
   * 이 전략이 금지하는 것이다.
   */
  score: number | null;
  /** 오늘 이미 진입한 횟수. 모르면 null → 막는다 */
  tradesToday: number | null;
  /** 최근 진입 시각들(ms). 회전율 판정용 */
  recentEntryMs: number[];
  /** 계획한 손절 폭과 목표 폭 (같은 단위). 손익비 판정용 */
  riskPct: number | null;
  rewardPct: number | null;
  /** 지금 열려 있는 포지션이 있는가 */
  hasOpenPosition: boolean;
  /** 사용자가 '애매하다'고 표시했는가 */
  unsure: boolean;
}

export interface DisciplineVerdict {
  allowed: boolean;
  /** 막은 이유들. 여러 개면 여러 개 다 적는다 */
  blocks: string[];
  /** 막지는 않지만 알아둘 것 */
  notes: string[];
  /** 화면에 그대로 쓸 한 줄 */
  headline: string;
  /** 강제 휴식 중이면 언제까지 */
  restUntilMs: number | null;
}

/**
 * 지금 진입해도 되는가.
 *
 * 순수 함수다. 진입 **조건**은 보지 않는다 — 그건 다른 모듈의 일이고,
 * 이 게이트는 그 결과(score)를 받아 규율만 본다.
 */
export function checkDiscipline(
  state: DisciplineState,
  nowMs: number,
  cfg: DisciplineConfig = WEDOM_DEFAULTS,
): DisciplineVerdict {
  const blocks: string[] = [];
  const notes: string[] = [];
  let restUntilMs: number | null = null;

  // ── 1. 애매하면 안 한다 ──
  //
  // 원칙 중 가장 먼저 본다. 애매한데 다른 조건이 좋아서 통과하는 일이
  // 없어야 한다.
  if (state?.unsure) {
    blocks.push('애매하다고 표시했습니다 — 애매하면 안 합니다');
  }

  // ── 2. 조건 만족도 ──
  const score = state?.score;
  if (score == null || !Number.isFinite(score)) {
    // **모르면 막는다.** 점수를 못 매긴 자리는 판단하지 못한 자리다.
    blocks.push('자리 점수를 매기지 못했습니다 — 판단 못 한 자리에는 들어가지 않습니다');
  } else if (score < cfg.minScore) {
    blocks.push(`자리 점수 ${score}점 (기준 ${cfg.minScore}점) — 대부분의 자리를 거르는 것이 이 전략입니다`);
  }

  // ── 3. 하루 횟수 ──
  const today = state?.tradesToday;
  if (today == null || !Number.isFinite(today)) {
    blocks.push('오늘 진입 횟수를 확인하지 못했습니다');
  } else if (today >= cfg.maxTradesPerDay) {
    blocks.push(`오늘 ${today}회 진입했습니다 (최대 ${cfg.maxTradesPerDay}회)`);
  } else if (today === 0) {
    // **0회를 실패로 그리지 않는다.** 포지션이 없는 것을 문제로 표시하면
    // 사람은 자리를 만들어서라도 들어간다.
    notes.push('오늘 아직 진입하지 않았습니다 — 정상입니다. 안 하는 것도 전략입니다');
  }

  // ── 4. 회전율 (쥐꼬리 매매 금지) ──
  const recent = Array.isArray(state?.recentEntryMs) ? state.recentEntryMs : [];
  const inWindow = recent.filter(t => Number.isFinite(t) && nowMs - t <= cfg.churnWindowMs);
  if (inWindow.length >= cfg.churnLimit) {
    const last = Math.max(...inWindow);
    restUntilMs = last + cfg.coolDownMs;
    if (nowMs < restUntilMs) {
      const mins = Math.ceil((restUntilMs - nowMs) / 60_000);
      blocks.push(
        `${Math.round(cfg.churnWindowMs / 3_600_000)}시간 안에 ${inWindow.length}번 진입했습니다 — ` +
        `${mins}분 강제 휴식`);
    } else {
      restUntilMs = null;
    }
  }

  // ── 5. 손익비 ──
  //
  // 승률보다 손익비다. 1:1짜리를 여러 번 하는 것이 이 전략이 없애려는
  // 행동이다.
  const risk = state?.riskPct, reward = state?.rewardPct;
  if (risk == null || reward == null || !(risk > 0) || !(reward > 0)) {
    blocks.push('손절 폭이나 목표 폭이 없습니다 — 손익비를 계산할 수 없습니다');
  } else {
    const rr = reward / risk;
    if (rr < cfg.minRewardRisk) {
      blocks.push(`손익비 ${rr.toFixed(2)} (기준 ${cfg.minRewardRisk}) — 승률보다 손익비입니다`);
    } else {
      notes.push(`손익비 ${rr.toFixed(2)}`);
    }
  }

  // ── 6. 이미 들고 있으면 새로 안 들어간다 ──
  //
  // 진입하면 손절이나 익절까지 차트를 안 본다는 원칙의 뒷면이다.
  // 들고 있는 채로 또 들어가는 것은 계획을 중간에 바꾸는 것이다.
  if (state?.hasOpenPosition) {
    blocks.push('이미 포지션이 있습니다 — 진입하면 손절이나 익절까지 그대로 둡니다');
  }

  const allowed = blocks.length === 0;
  return {
    allowed, blocks, notes, restUntilMs,
    headline: allowed
      ? '진입 조건과 규율을 모두 통과했습니다'
      : blocks.length === 1 ? blocks[0] : `${blocks.length}가지가 막고 있습니다`,
  };
}

/**
 * 진입한 뒤 손대도 되는가.
 *
 * 웨돔 원칙 2번 — 진입하면 손절이나 익절까지 차트를 안 본다.
 * **손절을 불리하게 옮기는 것만 막는다.** 유리한 쪽(본전 이동·트레일링)은
 * 위험을 줄이는 방향이라 허용한다 — 이 앱의 다른 검사들과 같은 기준이다.
 */
export function checkIntervention(
  side: 'LONG' | 'SHORT',
  currentStop: number | null | undefined,
  newStop: number | null | undefined,
): { allowed: boolean; reason: string } {
  // **Number(null)은 0이다.** 그대로 쓰면 손절가를 모르는 경우가
  // '0원'으로 읽혀서, 롱에서 어떤 값으로든 옮기는 것이 '올리는 것'이
  // 되어 전부 통과한다.
  const asNum = (v: any): number => (v == null || v === '') ? NaN : Number(v);
  const cur = asNum(currentStop), next = asNum(newStop);
  if (!Number.isFinite(cur) || !Number.isFinite(next)) {
    // 값을 모르면 옮기지 않는다. 모르는 채로 손절을 움직이는 것이
    // 가장 위험하다.
    return { allowed: false, reason: '지금 손절가나 새 손절가를 확인하지 못했습니다' };
  }
  const favorable = side === 'LONG' ? next > cur : next < cur;
  if (favorable) {
    return { allowed: true, reason: '위험을 줄이는 방향이라 허용합니다 (본전 이동·트레일링)' };
  }
  if (next === cur) return { allowed: true, reason: '같은 값입니다' };
  return {
    allowed: false,
    reason: '손절을 불리한 쪽으로 옮기는 것은 막습니다 — 진입하면 손절이나 익절까지 그대로 둡니다',
  };
}

/**
 * 이 전략이 지금 무엇을 하고 있는지 한 줄.
 *
 * 진입이 없을 때 화면이 비어 있으면 사람은 고장 났다고 생각하고, 그러면
 * 다른 데서 매매한다. **안 하고 있다는 것을 적극적으로 보여준다.**
 */
export function idleHeadline(state: DisciplineState, nowMs: number, cfg = WEDOM_DEFAULTS): string {
  const v = checkDiscipline(state, nowMs, cfg);
  if (v.allowed) return '지금 진입할 수 있는 자리입니다';
  if (v.restUntilMs) return `강제 휴식 중 — ${new Date(v.restUntilMs).toLocaleTimeString('ko-KR')}까지`;
  if (state?.tradesToday === 0) return '오늘 아직 안 했습니다. 기다리는 중입니다';
  return '자리를 기다리는 중입니다';
}

// src/lib/strategies/validationStage.ts
//
// **"모의 결과가 좋아 보인다"에서 끝내지 않는다.**
//
// 지금 전략은 확률 시뮬레이션과 백테스트에서 좋아 보이면 그걸로 끝이다.
// 그런데 그 둘이 답하지 못하는 질문이 있다:
//
//   확률 시뮬   승률을 **가정**했을 때 자금관리가 버티는가
//   백테스트     과거 데이터에서 진입 조건에 우위가 있었는가
//   ─────────────────────────────────────────────────────
//   TESTNET      주문이 실제로 나가고 체결되고 손절이 붙는가
//   LIVE_SMALL   진짜 시장에서 비용·지연·슬리피지를 빼고도 남는가
//
// 아래 둘은 앞의 둘로 절대 대신할 수 없다. 테스트넷은 **거래 시스템**을
// 검증하는 곳이고, 실전 소액은 **전략 + 실행 전체**를 검증하는 곳이다.
//
// 단계가 내려갈수록 우위는 깎인다
// ────────────────────────────────
//   백테스트 +10%p → Paper +7%p → Testnet +4%p → Live +2%p
//
// 이건 고장이 아니라 정상이다. 체결비용·지연·부분체결이 매번 조금씩
// 먹는다. **문제는 그 감소를 못 보는 것**이다 — 백테스트 숫자를 그대로
// 믿고 실전 금액을 키우면 거기서 처음 알게 된다.
//
// 그래서 이 파일이 막으려는 것
// ────────────────────────────
//   1. **가정 승률을 실제 신호로 쓰는 것.** '무우위 / +5%p / +10%p'는
//      자금관리 가정이지 매수·매도 조건이 아니다
//   2. 테스트넷 성과를 실전 성과로 복사하는 것
//   3. 수익률만 보고 다음 단계로 올리는 것
//   4. 사람 승인 없이 자동으로 실전에 올라가는 것
//   5. 브라우저가 열려 있어야만 도는 것을 '상시 실행'이라 부르는 것

export type ValidationStage =
  | 'DRAFT'
  | 'SIMULATED'
  | 'BACKTESTED'
  | 'WALK_FORWARD_VALIDATED'
  | 'PAPER'
  | 'SHADOW'
  | 'TESTNET'
  | 'TESTNET_VALIDATED'
  | 'LIVE_SMALL'
  | 'LIVE_LIMITED'
  | 'LIVE_FULL';

export const STAGE_ORDER: ValidationStage[] = [
  'DRAFT', 'SIMULATED', 'BACKTESTED', 'WALK_FORWARD_VALIDATED',
  'PAPER', 'SHADOW', 'TESTNET', 'TESTNET_VALIDATED',
  'LIVE_SMALL', 'LIVE_LIMITED', 'LIVE_FULL',
];

export const STAGE_LABEL: Record<ValidationStage, string> = {
  DRAFT: '초안',
  SIMULATED: '확률 시뮬',
  BACKTESTED: '백테스트',
  WALK_FORWARD_VALIDATED: '워크포워드',
  PAPER: '페이퍼',
  SHADOW: '섀도',
  TESTNET: '테스트넷',
  TESTNET_VALIDATED: '테스트넷 검증됨',
  LIVE_SMALL: '실전 소액',
  LIVE_LIMITED: '실전 제한',
  LIVE_FULL: '실전 전체',
};

/** 이 단계에서 실제 돈이 걸리는가 */
export function isRealMoney(stage: ValidationStage): boolean {
  return stage === 'LIVE_SMALL' || stage === 'LIVE_LIMITED' || stage === 'LIVE_FULL';
}

/**
 * 모르는 단계를 올려 읽지 않는다.
 *
 * **`DRAFT`로 떨어뜨리는 것이 안전한 방향이다.** 모르는 값을 LIVE로
 * 읽으면 검증 안 된 전략이 실전 단계로 보인다.
 */
export function stageOf(v: any): ValidationStage {
  const s = String(v ?? '').trim().toUpperCase();
  return (STAGE_ORDER as string[]).includes(s) ? (s as ValidationStage) : 'DRAFT';
}

export function stageIndex(stage: ValidationStage): number {
  return STAGE_ORDER.indexOf(stage);
}

// ── 가정 승률과 관측 우위를 섞지 않는다 ──────────────────

export type EdgeSource =
  /** 확률 시뮬의 가정값. **신호가 아니다** */
  | 'ASSUMED'
  /** 과거 데이터에서 관측 */
  | 'HISTORICAL'
  /** 페이퍼/섀도에서 관측 */
  | 'PAPER'
  /** 테스트넷에서 관측 */
  | 'TESTNET'
  /** 실전에서 관측 */
  | 'LIVE';

export const EDGE_LABEL: Record<EdgeSource, string> = {
  ASSUMED: '가정 우위', HISTORICAL: '백테스트 관측',
  PAPER: '페이퍼 관측', TESTNET: '테스트넷 관측', LIVE: '실전 관측',
};

/**
 * 이 우위 값을 진입 신호로 써도 되는가.
 *
 * **가정값은 절대 안 된다.** '무우위 / +5%p / +10%p'는 "이 정도 승률이면
 * 자금관리가 어떻게 되나"를 보는 숫자다. 시장에서 언제 사고팔지에 대해
 * 아무 말도 하지 않는다. 이걸 신호로 쓰면 주사위로 매매하는 것과 같다.
 */
export function usableAsSignal(source: EdgeSource): { ok: boolean; reason: string } {
  if (source === 'ASSUMED') {
    return { ok: false,
      reason: '확률 시뮬의 가정 승률입니다 — 자금관리를 보려고 정한 숫자이지'
        + ' 언제 사고팔지에 대한 조건이 아닙니다. 진입은 실제 신호 전략이 정해야 합니다' };
  }
  return { ok: true, reason: '' };
}

// ── 단계별 성과는 절대 섞지 않는다 ────────────────────────

export interface StageMetrics {
  /** 표본 */
  signals?: number | null;
  entries?: number | null;
  wins?: number | null;
  losses?: number | null;
  /** 비용 후 기대값(%) */
  netExpectancyPct?: number | null;
  profitFactor?: number | null;
  mddPct?: number | null;
  /** 실제 관측 우위(%p) */
  observedEdgePp?: number | null;

  // ── 실행 품질. 수익률만큼 중요하다 ──
  avgSlippagePct?: number | null;
  partialFillRate?: number | null;
  rejectRate?: number | null;
  /** 결과를 모르는 주문의 비율. **0이어야 한다** */
  unknownRate?: number | null;
  /** 손절이 실제로 거래소에 붙은 비율. **100%여야 한다** */
  protectiveStopSuccessRate?: number | null;
  /** 브라우저 없이 도는가 */
  runtimeIndependent?: boolean | null;
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── 승격 판정 ─────────────────────────────────────────────

export interface PromotionCheck {
  label: string;
  /** 통과했는가. **모르면 null — 통과가 아니다** */
  pass: boolean | null;
  detail: string;
}

export interface PromotionVerdict {
  from: ValidationStage;
  to: ValidationStage;
  checks: PromotionCheck[];
  /** 자동으로 올려도 되는가 */
  autoAllowed: boolean;
  /** 사람이 눌러야 하는가 */
  requiresHuman: boolean;
  /** 지금 올릴 수 있는가 */
  ok: boolean;
  reason: string;
}

/** 테스트넷 검증에 필요한 최소 표본 */
export const MIN_TESTNET_ENTRIES = 200;
/** 실전 소액 검증에 필요한 최소 표본 */
export const MIN_LIVE_SMALL_ENTRIES = 100;
export const MAX_ACCEPTABLE_MDD_PCT = 15;

/**
 * 다음 단계로 올려도 되는가.
 *
 * **수익률만 보지 않는다.** 표본이 충분한가, 비용 후 기대값이 플러스인가,
 * 결과를 모르는 주문이 없는가, 손절이 실제로 붙었는가, 브라우저 없이
 * 도는가까지 본다. 이 중 하나라도 '모름'이면 통과가 아니다 —
 * **확인하지 못한 것은 통과가 아니다.**
 *
 * 그리고 실전으로 넘어가는 문턱은 **자동으로 열리지 않는다.**
 */
export function promotionVerdict(
  from: ValidationStage,
  m: StageMetrics | null | undefined,
): PromotionVerdict {
  const to = STAGE_ORDER[Math.min(stageIndex(from) + 1, STAGE_ORDER.length - 1)];
  const x = m ?? {};
  const checks: PromotionCheck[] = [];

  const need = (label: string, v: number | null, min: number, unit = '') =>
    checks.push({
      label,
      pass: v === null ? null : v >= min,
      detail: v === null ? '확인하지 못했습니다' : `${v}${unit} (기준 ${min}${unit} 이상)`,
    });

  const entries = num(x.entries);
  const minEntries = from === 'TESTNET' ? MIN_TESTNET_ENTRIES : MIN_LIVE_SMALL_ENTRIES;

  if (from === 'TESTNET' || isRealMoney(from)) {
    need('표본(진입 수)', entries, minEntries, '건');

    const netExp = num(x.netExpectancyPct);
    checks.push({
      label: '비용 후 기대값',
      pass: netExp === null ? null : netExp > 0,
      detail: netExp === null ? '확인하지 못했습니다'
        : `${netExp > 0 ? '+' : ''}${netExp}% (수수료·슬리피지·펀딩 반영 후)`,
    });

    const mdd = num(x.mddPct);
    checks.push({
      label: '최대 낙폭',
      pass: mdd === null ? null : Math.abs(mdd) <= MAX_ACCEPTABLE_MDD_PCT,
      detail: mdd === null ? '확인하지 못했습니다' : `${mdd}% (기준 ±${MAX_ACCEPTABLE_MDD_PCT}% 이내)`,
    });

    // ── 여기부터는 수익과 무관한, 그러나 더 중요한 것들 ──
    const unknown = num(x.unknownRate);
    checks.push({
      label: '결과 모르는 주문',
      pass: unknown === null ? null : unknown === 0,
      detail: unknown === null ? '확인하지 못했습니다'
        : `${unknown}% — 결과를 모르는 주문이 하나라도 있으면 장부가 실제와 다릅니다`,
    });

    const prot = num(x.protectiveStopSuccessRate);
    checks.push({
      label: '손절 부착 성공률',
      pass: prot === null ? null : prot >= 100,
      detail: prot === null ? '확인하지 못했습니다'
        : `${prot}% — 손절이 안 붙은 포지션이 하나라도 있으면 그 한 번에 계좌가 날아갑니다`,
    });

    checks.push({
      label: '브라우저 없이 실행',
      pass: x.runtimeIndependent === null || x.runtimeIndependent === undefined
        ? null : x.runtimeIndependent === true,
      detail: x.runtimeIndependent === true
        ? '서버에서 돕니다'
        : x.runtimeIndependent === false
          ? '이 화면을 닫으면 멈춥니다 — 실전에서는 손절도 같이 멈춥니다'
          : '확인하지 못했습니다',
    });
  } else {
    // 시뮬·백테스트 구간. 여기는 검증 자체가 가볍다.
    need('표본(진입 수)', entries, 30, '건');
  }

  const failed = checks.filter(c => c.pass === false);
  const unknownChecks = checks.filter(c => c.pass === null);
  const allPass = failed.length === 0 && unknownChecks.length === 0;

  // **실전으로 넘어가는 문은 자동으로 열리지 않는다.**
  const toRealMoney = isRealMoney(to);
  const requiresHuman = toRealMoney;

  return {
    from, to, checks,
    autoAllowed: allPass && !toRealMoney,
    requiresHuman,
    ok: allPass,
    reason: !allPass
      ? (failed.length > 0
          ? `${failed.map(c => c.label).join(', ')}이(가) 기준에 못 미칩니다`
          : `${unknownChecks.map(c => c.label).join(', ')}을(를) 확인하지 못했습니다 —`
            + ' 확인하지 못한 것은 통과가 아닙니다')
      : toRealMoney
        ? `기준은 모두 통과했습니다. 다만 ${STAGE_LABEL[to]}은(는) 실제 돈이 걸리므로`
          + ' 자동으로 올리지 않습니다 — 사람이 직접 승인해야 합니다'
        : '',
  };
}

// ── 단계 사이의 성능 감소 ─────────────────────────────────

export interface Degradation {
  /** 우위가 얼마나 깎였는가(%p) */
  edgeDropPp: number | null;
  /** 낙폭이 얼마나 깊어졌는가(%p) */
  mddWorsePp: number | null;
  /** 슬리피지가 몇 배가 됐는가 */
  slippageRatio: number | null;
  /** 신규 진입을 멈춰야 하는가 */
  shouldHalt: boolean;
  note: string;
}

/**
 * 앞 단계 대비 얼마나 나빠졌는가.
 *
 * **깎이는 것 자체는 정상이다.** 체결비용·지연이 매번 조금씩 먹는다.
 * 문제는 그 감소를 못 보는 것이고, 더 나쁜 것은 **깎여서 마이너스가
 * 됐는데 계속 도는 것**이다.
 *
 * 그래서 우위가 0 아래로 내려가면 신규 진입을 멈춘다. 청산은 막지
 * 않는다 — 못 여는 것은 불편이고 못 닫는 것은 사고다.
 */
export function degradationOf(
  prev: StageMetrics | null | undefined,
  cur: StageMetrics | null | undefined,
): Degradation {
  const pe = num(prev?.observedEdgePp), ce = num(cur?.observedEdgePp);
  const pm = num(prev?.mddPct), cm = num(cur?.mddPct);
  const ps = num(prev?.avgSlippagePct), cs = num(cur?.avgSlippagePct);

  const edgeDropPp = pe !== null && ce !== null ? pe - ce : null;
  const mddWorsePp = pm !== null && cm !== null ? Math.abs(cm) - Math.abs(pm) : null;
  const slippageRatio = ps !== null && cs !== null && ps > 0 ? cs / ps : null;

  // 지금 단계의 우위가 0 이하면 멈춘다. **모르면 멈추지 않는다** —
  // 모른다는 이유로 멈추면 첫날부터 아무것도 못 돈다. 대신 적는다.
  const shouldHalt = ce !== null && ce <= 0;

  const parts: string[] = [];
  if (edgeDropPp !== null && edgeDropPp > 0) {
    parts.push(`우위가 ${edgeDropPp.toFixed(1)}%p 깎였습니다`);
  }
  if (slippageRatio !== null && slippageRatio > 2) {
    parts.push(`슬리피지가 ${slippageRatio.toFixed(1)}배가 됐습니다`);
  }
  if (mddWorsePp !== null && mddWorsePp > 0) {
    parts.push(`낙폭이 ${mddWorsePp.toFixed(1)}%p 깊어졌습니다`);
  }
  if (ce === null) {
    parts.push('이 단계의 관측 우위를 아직 내지 못했습니다 — 표본이 쌓여야 합니다');
  }

  return {
    edgeDropPp, mddWorsePp, slippageRatio, shouldHalt,
    note: shouldHalt
      ? `비용을 빼고 나니 우위가 남지 않았습니다 (${ce}%p) — 신규 진입을 멈춥니다.`
        + ' 청산은 계속됩니다'
      : parts.join(' · '),
  };
}

/**
 * 실전 소액에 걸어도 되는 상한.
 *
 * **금액이 아니라 위험으로 제한한다.** 사용자가 배정 금액을 정하되,
 * 시스템은 "한 번에 얼마까지 잃을 수 있는가"로 막는다 — 같은 100만원도
 * 레버리지에 따라 위험이 열 배 다르다.
 */
export const LIVE_SMALL_CAPS = {
  /** 1회 위험 (전략계좌 자산 대비 %) */
  riskPerTradePct: 0.25,
  /** 동시에 열린 위험 합계 */
  maxOpenRiskPct: 1,
  maxLeverage: 5,
} as const;

export const LIVE_LIMITED_CAPS = {
  riskPerTradePct: 0.5,
  maxOpenRiskPct: 2,
  maxLeverage: 10,
} as const;

export function capsFor(stage: ValidationStage) {
  if (stage === 'LIVE_SMALL') return LIVE_SMALL_CAPS;
  if (stage === 'LIVE_LIMITED') return LIVE_LIMITED_CAPS;
  return null;
}

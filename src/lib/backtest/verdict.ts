// src/lib/backtest/verdict.ts
//
// **거래 8건으로 승률 25%를 통계처럼 보여주고 있었다.**
//
// 실제 화면:
//
//   365개 캔들 · BTCUSDT
//   수익률       -2.27%
//   MDD          -5.92%
//   승률           25%
//   Profit Factor 0.77
//   Sharpe       -0.23
//   거래           8회
//
// 승률 25%는 2승 6패다. 동전을 여덟 번 던져도 그 정도는 흔히 나온다.
// 그런데 화면은 이 숫자들을 다른 검증 결과와 **똑같은 크기와 모양**으로
// 보여준다. 그러면 사람은 "이 전략은 승률이 낮구나"라고 읽는다 — 실제로
// 알 수 있는 것은 **아무것도 없다는 것**뿐인데도.
//
// 그리고 그 아래에 복리 성장 분석이 붙어 있었다
// ─────────────────────────────────────────────
// 기대값이 음수인 전략에 복리를 곱하면 그건 손실을 복리로 키우는
// 그림이다. 그 화면을 보고 자금을 늘릴 이유가 하나도 없다.
//
// 순서가 있다: **우위 → 위험 → 표본 → 강건성 → 그다음이 복리다.**
//
// 이 파일이 정하는 것
// ───────────────────
// 숫자를 보여줄지 말지가 아니라, **그 숫자로 무엇을 주장할 수 있는지**를
// 정한다. 표본이 모자라면 "성적이 나쁘다"가 아니라 "아직 모른다"이고,
// 둘은 다음에 할 일이 완전히 다르다.
//
//   성적이 나쁘다  →  전략을 고친다
//   아직 모른다    →  기간을 늘려 다시 돌린다

export type BacktestVerdict =
  /** 표본이 모자라 아무 주장도 못 한다 */
  | 'INSUFFICIENT_SAMPLE'
  /** 비용 후 기대값이 0 이하 */
  | 'NO_EDGE'
  /** 기대값은 양수인데 낙폭·손실이 과하다 */
  | 'OVER_RISKED'
  /** 방향은 좋은데 아직 검증 단계가 남았다 */
  | 'PROMISING'
  /** 여러 검증을 통과했다 */
  | 'ROBUST'
  /** 판정할 값을 못 읽었다 */
  | 'UNKNOWN';

export const VERDICT_LABEL: Record<BacktestVerdict, string> = {
  INSUFFICIENT_SAMPLE: '표본 부족 — 판단 불가',
  NO_EDGE: '우위 없음',
  OVER_RISKED: '위험 과다',
  PROMISING: '가능성 있음',
  ROBUST: '견고',
  UNKNOWN: '판정 불가',
};

/**
 * 이보다 적으면 어떤 통계도 주장하지 않는다.
 *
 * 30건은 "많다"가 아니라 **"이 아래로는 확실히 아무것도 모른다"**는 선이다.
 * 승률 하나만 봐도 30건에서 표준오차가 9%p쯤 된다 — 45%와 55%를 구분
 * 못 한다는 뜻이다. 진짜 판단은 수백 건이 필요하다.
 */
export const MIN_TRADES_FOR_ANY_CLAIM = 30;

/** 이 정도는 돼야 '검증했다'고 말할 수 있다 */
export const MIN_TRADES_FOR_CONFIDENCE = 200;

/** 낙폭이 이보다 크면 기대값이 양수여도 못 쓴다 */
export const MAX_ACCEPTABLE_MDD_PCT = 30;

export interface BacktestLike {
  totalTrades?: any;
  totalReturnPct?: any;
  profitFactor?: any;
  sharpe?: any;
  maxDrawdownPct?: any;
  winRate?: any;
  /** 이 결과에 비용이 들어갔는가 */
  costIncluded?: any;
}

export interface VerdictResult {
  verdict: BacktestVerdict;
  /** 승격 후보로 볼 수 있는가 */
  promotable: boolean;
  /**
   * 이 결과의 숫자로 성적을 주장해도 되는가.
   *
   * **false면 화면이 승률·PF·Sharpe를 큰 글씨로 띄우면 안 된다.**
   */
  statsMeaningful: boolean;
  /** 판정 근거들 */
  reasons: string[];
  /** 다음에 할 일 */
  nextStep: string;
  /** 표본에 대한 한 줄 */
  sampleNote: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 백테스트 결과 판정.
 *
 * **순서가 판정이다.** 표본을 가장 먼저 본다 — 표본이 모자라면 나머지
 * 숫자는 전부 우연일 수 있고, 그 위에 '우위 없음'이라고 적으면 없는
 * 결론을 만드는 것이다.
 */
export function backtestVerdict(r: BacktestLike | null | undefined): VerdictResult {
  const b = r ?? {};
  const trades = num(b.totalTrades);
  const ret = num(b.totalReturnPct);
  const pf = num(b.profitFactor);
  const sharpe = num(b.sharpe);
  const mdd = num(b.maxDrawdownPct);

  // 0. 표본 수를 모르면 아무 말도 안 한다.
  if (trades == null) {
    return {
      verdict: 'UNKNOWN', promotable: false, statsMeaningful: false,
      reasons: ['거래 건수를 확인하지 못했습니다'],
      nextStep: '백테스트를 다시 돌려 주세요',
      sampleNote: '표본 수를 알 수 없습니다',
    };
  }

  const sampleNote = trades < MIN_TRADES_FOR_ANY_CLAIM
    ? `거래 ${trades}회 — 통계 판단에 표본이 부족합니다 (최소 ${MIN_TRADES_FOR_ANY_CLAIM}회)`
    : trades < MIN_TRADES_FOR_CONFIDENCE
      ? `거래 ${trades}회 — 방향은 볼 수 있지만 확신하기엔 모자랍니다 (권장 ${MIN_TRADES_FOR_CONFIDENCE}회)`
      : `거래 ${trades}회`;

  // 1. **표본이 먼저다.**
  //
  // 8회에서 승률 25%는 2승 6패다. 여기에 '우위 없음'이라고 적으면
  // 없는 결론을 만드는 것이다 — 실제로 알 수 있는 것은 '모른다'뿐이다.
  if (trades < MIN_TRADES_FOR_ANY_CLAIM) {
    return {
      verdict: 'INSUFFICIENT_SAMPLE', promotable: false, statsMeaningful: false,
      reasons: [
        sampleNote,
        '승률·Profit Factor·Sharpe는 이 표본에서 우연으로도 나올 수 있는 값입니다',
      ],
      nextStep: '기간을 늘려 다시 검증하세요 — 조건을 고치는 것은 그다음입니다',
      sampleNote,
    };
  }

  const reasons: string[] = [];
  if (ret != null && ret <= 0) reasons.push(`비용 후 수익률 ${ret.toFixed(2)}%`);
  if (pf != null && pf < 1) reasons.push(`Profit Factor ${pf.toFixed(2)} (1 미만)`);
  if (sharpe != null && sharpe < 0) reasons.push(`Sharpe ${sharpe.toFixed(2)} (음수)`);

  // 2. 우위가 없으면 나머지는 볼 이유가 없다.
  if (reasons.length > 0) {
    return {
      verdict: 'NO_EDGE', promotable: false, statsMeaningful: true,
      reasons: [...reasons, sampleNote],
      nextStep: '배율이나 자금을 늘려도 해결되지 않습니다 — 진입 조건과 TP/SL 구조를 바꿔야 합니다',
      sampleNote,
    };
  }

  // 3. 기대값이 양수여도 낙폭이 크면 못 쓴다.
  //    낙폭은 절대값으로 본다 — 이 저장소는 -5.92처럼 음수로 담는다.
  if (mdd != null && Math.abs(mdd) >= MAX_ACCEPTABLE_MDD_PCT) {
    return {
      verdict: 'OVER_RISKED', promotable: false, statsMeaningful: true,
      reasons: [`최대 낙폭 ${Math.abs(mdd).toFixed(1)}%`, sampleNote],
      nextStep: '거래당 위험과 배율을 낮춰 같은 조건으로 다시 돌리세요',
      sampleNote,
    };
  }

  // 4. 표본이 방향만 볼 수준이면 아직 '검증됨'이 아니다.
  if (trades < MIN_TRADES_FOR_CONFIDENCE) {
    return {
      verdict: 'PROMISING', promotable: false, statsMeaningful: true,
      reasons: [sampleNote],
      nextStep: 'Walk-forward와 Out-of-sample로 이어가세요 — 백테스트 하나로 승격하지 않습니다',
      sampleNote,
    };
  }

  return {
    verdict: 'ROBUST', promotable: true, statsMeaningful: true,
    reasons: [sampleNote],
    nextStep: 'Walk-forward → Monte Carlo → Paper 순으로 이어가세요',
    sampleNote,
  };
}

// ── 복리 분석을 언제 보여줄 것인가 ────────────────────────

export interface CompoundGate {
  allowed: boolean;
  reason: string;
}

/**
 * 복리 성장 분석을 보여줘도 되는가.
 *
 * **기대값이 음수인 전략에 복리를 곱하면 손실을 복리로 키우는 그림이다.**
 * 그런데 화면은 그것을 '성장 분석'이라는 이름으로 보여줬다. 그 그림을
 * 보고 자금을 늘릴 이유가 하나도 없다.
 *
 * 순서: 우위 → 위험 → 표본 → 강건성 → **그다음이 복리다.**
 */
export function compoundAllowed(v: VerdictResult | null | undefined): CompoundGate {
  const verdict = v?.verdict ?? 'UNKNOWN';
  if (verdict === 'ROBUST' || verdict === 'PROMISING') {
    return { allowed: true, reason: '' };
  }
  if (verdict === 'INSUFFICIENT_SAMPLE') {
    return {
      allowed: false,
      reason: '표본이 부족해 우위가 있는지 아직 모릅니다 — 복리 분석은 우위가 확인된 뒤에 뜻이 있습니다',
    };
  }
  if (verdict === 'NO_EDGE') {
    return {
      allowed: false,
      reason: '비용 후 우위가 검증되지 않았습니다 — 이 전략에 복리를 곱하면 손실을 복리로 키우는 그림이 됩니다',
    };
  }
  if (verdict === 'OVER_RISKED') {
    return {
      allowed: false,
      reason: '낙폭이 과해 복리를 논할 단계가 아닙니다 — 위험을 먼저 낮추세요',
    };
  }
  return { allowed: false, reason: '판정하지 못한 결과에는 복리 분석을 붙이지 않습니다' };
}

// ── 기간이 충분한가 ───────────────────────────────────────

export interface RangeCheck {
  /** 대략 며칠치인가 */
  days: number | null;
  enough: boolean;
  note: string;
}

/** 최종 검증에 이보다 짧은 구간을 쓰지 않는다 */
export const MIN_BACKTEST_DAYS = 180;

/**
 * 365개 캔들이면 충분한가.
 *
 * 1시간봉 365개는 **약 15일**이다. 그 안에 추세장·횡보장·고변동이
 * 다 들어 있을 리 없고, 그러면 이 결과는 "그 15일 동안" 이상을
 * 말하지 못한다. 화면에 캔들 개수만 적으면 그 사실이 안 보인다.
 */
export function rangeCheck(candles: any, timeframe: any): RangeCheck {
  const n = num(candles);
  const tf = String(timeframe ?? '').trim().toLowerCase();
  const MIN_PER: Record<string, number> = {
    '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
    '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720,
    '1d': 1440, '1w': 10080,
  };
  const per = MIN_PER[tf];
  if (n == null || per == null) {
    return { days: null, enough: false, note: '검증 기간을 계산하지 못했습니다 — 캔들 개수만으로는 며칠치인지 알 수 없습니다' };
  }
  const days = (n * per) / 1440;
  return {
    days,
    enough: days >= MIN_BACKTEST_DAYS,
    note: days >= MIN_BACKTEST_DAYS
      ? `약 ${Math.round(days)}일치`
      : `약 ${Math.round(days)}일치 — 최종 검증에는 ${MIN_BACKTEST_DAYS}일 이상을 권합니다`
        + ' (이 구간에 추세장·횡보장이 모두 들어 있지 않을 수 있습니다)',
  };
}

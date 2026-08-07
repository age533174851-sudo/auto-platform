// src/lib/ui/strategyCard.ts
//
// **전략이 일곱 개인데 카드가 일곱 개의 복사본이다.**
//
// 지금 모든 전략 카드가 똑같이 이것만 보여준다:
//
//   자산 / 레버리지 / 익절 / 손절
//   [▶ 시작] [■ 중지] [설정]
//
// 그래서 EMA 추세추종, RSI 반전, 브레이크아웃, DCA, 펀딩비, AI 전략이
// **왜 서로 다른 전략인지 화면에서 전혀 안 보인다.**
//
// 특히 DCA가 이상하다
// ───────────────────
// BTC DCA 적립에 익절 50% / 손절 20%가 다른 전략과 같은 자리에 떠 있다.
// DCA에서 중요한 것은 그게 아니라 **다음 적립일 · 적립금액 · 평균단가 ·
// 누적투입액**이다. 익절 50%짜리 적립 전략은 사실상 익절이 없는 것이고,
// 그 칸을 크게 보여주면 있는 규칙처럼 읽힌다.
//
// 이 파일이 하는 일
// ─────────────────
// **전략 종류마다 무엇을 보여줄지 정한다.** 값을 만들지는 않는다 —
// 그건 각 전략 엔진이 할 일이고, 지금 대부분 없다.
//
// 없는 값을 어떻게 다루는가
// ─────────────────────────
// **지어내지 않는다.** 이 저장소에서 이미 한 번 크게 덴 자리다:
// 예시 카드에 승률 67% · 누적 +₩847,000이 박혀 있었고, 화면은 '실행중'
// 이라고 말했지만 아무것도 안 돌고 있었다. 사용자는 자동매매가 돈을
// 벌고 있다고 믿고 실제 자금을 넣는다.
//
// 그래서 값이 없으면 '—'이고, 카드는 **무엇이 아직 계산되지 않는지**를
// 스스로 말한다. 그러면 이 화면이 그대로 "안 붙인 배선 목록"이 된다.

// ── 전략 종류 ─────────────────────────────────────────────

export type StrategyKind =
  /** 추세를 따라간다 — EMA/MACD/스윙 */
  | 'TREND'
  /** 되돌림을 노린다 — RSI 반전·급락 매수 */
  | 'REVERSAL'
  /** 눌린 구간의 돌파를 기다린다 */
  | 'BREAKOUT'
  /** 짧게 자주 */
  | 'SCALP'
  /** 정기 분할 매수 — **손익비 전략이 아니다** */
  | 'ACCUMULATE'
  /** 펀딩비 과열 */
  | 'FUNDING'
  /** 모델 판단 */
  | 'AI'
  | 'UNKNOWN';

const KIND_BY_TYPE: Record<string, StrategyKind> = {
  ema_cross: 'TREND', macd_trend: 'TREND', swing: 'TREND',
  rsi_reversal: 'REVERSAL', buy_dip: 'REVERSAL',
  breakout: 'BREAKOUT',
  scalping: 'SCALP',
  dca: 'ACCUMULATE',
  funding_rate: 'FUNDING',
  ai_strategy: 'AI',
};

/** 모르는 종류는 UNKNOWN이다 — 아무 종류로나 밀어 넣지 않는다 */
export function kindOf(type: any): StrategyKind {
  return KIND_BY_TYPE[String(type ?? '').trim().toLowerCase()] ?? 'UNKNOWN';
}

export const KIND_LABEL: Record<StrategyKind, string> = {
  TREND: '추세', REVERSAL: '반전', BREAKOUT: '돌파', SCALP: '단타',
  ACCUMULATE: '적립', FUNDING: '펀딩비', AI: 'AI 판단', UNKNOWN: '분류 없음',
};

// ── 종류마다 무엇을 보여주는가 ────────────────────────────

export type FieldFormat = 'price' | 'pct' | 'score' | 'count' | 'money' | 'text' | 'date';

export interface FieldSpec {
  key: string;
  label: string;
  format: FieldFormat;
  /** 이 값을 지금 계산하는 곳이 저장소에 있는가 */
  wired?: boolean;
}

const f = (key: string, label: string, format: FieldFormat): FieldSpec =>
  ({ key, label, format, wired: false });

/**
 * 전략 종류별 핵심 지표.
 *
 * **이게 그 전략이 지금 무엇을 보고 있는가다.** 그래야 "왜 아직 안
 * 들어가는지"를 화면에서 알 수 있다.
 */
export const KIND_FIELDS: Record<StrategyKind, FieldSpec[]> = {
  TREND: [
    f('trend', '추세', 'text'),
    f('emaFast', 'EMA 단기', 'price'),
    f('emaSlow', 'EMA 장기', 'price'),
    f('rsi', 'RSI', 'score'),
  ],
  REVERSAL: [
    f('rsi', '현재 RSI', 'score'),
    f('rsiOversold', '과매도 기준', 'score'),
    f('rsiOverbought', '과매수 기준', 'score'),
    f('divergence', '다이버전스', 'text'),
  ],
  BREAKOUT: [
    f('resistance', '저항', 'price'),
    f('lastPrice', '현재', 'price'),
    f('distanceToBreakPct', '돌파까지', 'pct'),
    f('bandWidth', '볼린저 폭', 'text'),
  ],
  SCALP: [
    f('spreadPct', '스프레드', 'pct'),
    f('volatilityPct', '변동성', 'pct'),
    f('lastPrice', '현재', 'price'),
    f('tradesToday', '오늘 거래', 'count'),
  ],
  // **익절·손절이 없다.** DCA에서 중요한 것이 아니다.
  ACCUMULATE: [
    f('nextBuyAt', '다음 매수', 'date'),
    f('intervalText', '주기', 'text'),
    f('amountPerBuy', '1회 투자', 'money'),
    f('investedTotal', '누적 투자', 'money'),
    f('avgCost', '평균 매수가', 'price'),
    f('returnPct', '현재 수익률', 'pct'),
  ],
  FUNDING: [
    f('fundingRatePct', '현재 펀딩', 'pct'),
    f('nextFundingAt', '다음 정산', 'date'),
    f('openInterestTrend', 'OI', 'text'),
    f('longShortRatio', 'Long/Short', 'text'),
    f('crowding', 'Crowding', 'text'),
  ],
  AI: [
    f('regime', '시장 국면', 'text'),
    f('longScore', 'LONG', 'score'),
    f('shortScore', 'SHORT', 'score'),
    f('confidencePct', '신뢰도', 'pct'),
    f('minConfidencePct', '최소 진입 신뢰도', 'pct'),
  ],
  UNKNOWN: [
    f('lastPrice', '현재', 'price'),
  ],
};

/**
 * 익절·손절을 카드 앞면에 둘 것인가.
 *
 * **적립 전략은 아니다.** 익절 50% / 손절 20%짜리 DCA는 사실상 그 규칙이
 * 없는 것인데, 다른 전략과 같은 자리에 크게 띄우면 있는 규칙으로 읽힌다.
 */
export function showsTpSl(kind: StrategyKind): boolean {
  return kind !== 'ACCUMULATE';
}

// ── 값 채우기 ─────────────────────────────────────────────

export interface CardRow {
  key: string;
  label: string;
  /** 화면에 그대로 쓸 문자열. 모르면 '—' */
  value: string;
  /** 값을 실제로 알았는가. **false면 0이 아니라 모르는 것이다** */
  known: boolean;
}

/** 모르는 값 자리 */
export const UNKNOWN_TEXT = '—';

function fmt(v: any, format: FieldFormat): string | null {
  if (v == null || v === '') return null;
  if (format === 'text' || format === 'date') {
    const s = String(v).trim();
    return s ? s : null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  switch (format) {
    case 'pct': return `${n >= 0 ? '' : ''}${n.toFixed(2)}%`;
    case 'score': return String(Math.round(n));
    case 'count': return `${Math.round(n)}건`;
    case 'money': return n.toLocaleString('ko-KR');
    case 'price': return n.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
    default: return String(n);
  }
}

/**
 * 카드에 그릴 줄.
 *
 * **없는 값을 0으로 채우지 않는다.** RSI 0은 극단적 과매도이지 '모름'이
 * 아니다. 평균단가 0은 공짜로 샀다는 뜻이지 '아직 안 샀다'가 아니다.
 */
export function cardRowsOf(
  kind: StrategyKind, metrics: Record<string, any> | null | undefined,
): CardRow[] {
  const m = metrics ?? {};
  return (KIND_FIELDS[kind] ?? KIND_FIELDS.UNKNOWN).map(spec => {
    const text = fmt(m[spec.key], spec.format);
    return {
      key: spec.key, label: spec.label,
      value: text ?? UNKNOWN_TEXT, known: text != null,
    };
  });
}

/**
 * 이 카드에서 **아직 아무도 계산하지 않는** 값들.
 *
 * 이 목록이 비면 그 전략은 화면에 붙을 준비가 된 것이고, 비지 않으면
 * 그 자체가 다음 할 일 목록이다. 이 저장소에서 가장 자주 난 고장이
 * "만들어 놓고 배선을 안 함"이라, 그것을 화면이 직접 말하게 한다.
 */
export function unwiredFieldsOf(
  kind: StrategyKind, metrics: Record<string, any> | null | undefined,
): string[] {
  return cardRowsOf(kind, metrics).filter(r => !r.known).map(r => r.label);
}

// ── 무엇이 지금 도는가 ────────────────────────────────────

export type Activity =
  /** 실제로 돌고 있다 */
  | 'RUNNING'
  /** 안 돌지만 진입 기준에 근접했다 */
  | 'OPPORTUNITY'
  /** 안 돌고 근접하지도 않았다 */
  | 'WAITING'
  /** 사용자가 꺼 뒀다 */
  | 'STOPPED'
  | 'ERROR';

export const ACTIVITY_LABEL: Record<Activity, string> = {
  RUNNING: '실행중', OPPORTUNITY: '기회 근접', WAITING: '대기',
  STOPPED: '정지', ERROR: '오류',
};

export type Tone = 'good' | 'warn' | 'bad' | 'muted';

export const ACTIVITY_TONE: Record<Activity, Tone> = {
  RUNNING: 'good', OPPORTUNITY: 'warn', WAITING: 'muted',
  STOPPED: 'muted', ERROR: 'bad',
};

/**
 * 진입 기준의 몇 %까지 왔으면 '기회 근접'인가.
 *
 * 80점이 기준일 때 72점(90%)이면 곧 닿을 수 있다. 이보다 낮으면
 * '근접'이라고 말할 근거가 없다.
 */
export const OPPORTUNITY_RATIO = 0.9;

export interface ActivityInput {
  status?: any;
  enabled?: any;
  /** 현재 신호 점수 */
  score?: number | null;
  /** 진입에 필요한 점수 */
  requiredScore?: number | null;
}

/**
 * 이 전략이 지금 어느 칸에 들어가는가.
 *
 * **점수를 모르면 '기회'가 아니다.** 모르는 것을 기회로 세면 기본
 * 필터(실행중 + 기회)가 결국 전부를 보여주게 되고, 그러면 필터가 없는
 * 것과 같아진다.
 */
export function activityOf(input: ActivityInput | null | undefined): Activity {
  const i = input ?? {};
  const st = String(i.status ?? '').trim().toLowerCase();

  if (st === 'error') return 'ERROR';
  if (st === 'running') return 'RUNNING';
  if (st === 'paused') return 'STOPPED';

  const score = Number(i.score);
  const need = Number(i.requiredScore);
  if (Number.isFinite(score) && Number.isFinite(need) && need > 0
    && score >= need * OPPORTUNITY_RATIO) {
    return 'OPPORTUNITY';
  }
  // 꺼져 있고 근접하지도 않았다. **'정지'와 '대기'를 가르는 것은
  // 사용자가 껐는가**다 — 켜 뒀는데 조건이 안 맞는 것은 대기다.
  return i.enabled ? 'WAITING' : 'STOPPED';
}

// ── 필터 ──────────────────────────────────────────────────

export const ALL_ACTIVITIES: Activity[] = ['RUNNING', 'OPPORTUNITY', 'WAITING', 'STOPPED', 'ERROR'];

/**
 * 기본 필터.
 *
 * **정지된 전략 스무 개를 매번 스크롤할 이유가 없다.** 다만 오류는
 * 언제나 보인다 — 숨기면 고장이 조용해진다.
 */
export const DEFAULT_FILTERS: Activity[] = ['RUNNING', 'OPPORTUNITY', 'ERROR'];

export function filterCountsOf(list: Activity[] | null | undefined): Record<Activity, number> {
  const out: Record<Activity, number> = {
    RUNNING: 0, OPPORTUNITY: 0, WAITING: 0, STOPPED: 0, ERROR: 0,
  };
  for (const a of (Array.isArray(list) ? list : [])) {
    if (a in out) out[a]++;
  }
  return out;
}

/**
 * 필터를 통과하는가.
 *
 * **빈 필터는 '전체'다.** 아무것도 안 고른 상태에서 화면이 텅 비면,
 * 사용자는 전략이 사라졌다고 읽는다.
 */
export function passesFilter(a: Activity, filters: Activity[] | null | undefined): boolean {
  const list = Array.isArray(filters) ? filters : [];
  return list.length === 0 || list.includes(a);
}

// ── 버튼 ──────────────────────────────────────────────────

export interface CardActions {
  /** 가장 큰 버튼 하나 */
  primary: { id: 'start' | 'pause'; label: string };
  /** 그 옆 하나 */
  secondary: { id: 'detail'; label: string };
  /** ⋯ 안으로 들어가는 것들 */
  inMenu: Array<{ id: 'settings' | 'stop'; label: string }>;
}

/**
 * 버튼 세 개가 언제나 자리를 차지할 이유가 없다.
 *
 * 멈춰 있으면 [시작]만, 돌고 있으면 [일시정지]만 크게. 설정과 중지는
 * ⋯ 안으로 넣는다 — 카드 높이가 그만큼 줄고, 그게 스무 개면 화면 하나다.
 */
export function actionsOf(a: Activity): CardActions {
  const running = a === 'RUNNING';
  return {
    primary: running
      ? { id: 'pause', label: '일시정지' }
      : { id: 'start', label: '자동매매 시작' },
    secondary: { id: 'detail', label: '상세' },
    // 돌고 있을 때만 '중지'가 뜻이 있다.
    inMenu: running
      ? [{ id: 'stop', label: '중지' }, { id: 'settings', label: '설정' }]
      : [{ id: 'settings', label: '설정' }],
  };
}

/**
 * 접힌 한 줄로 보일 것인가.
 *
 * 정지된 전략은 오늘 아무것도 안 한다. 실행중인 것과 같은 크기로
 * 늘어서 있으면 매번 그 사이를 찾아 스크롤해야 한다.
 */
export function isCompact(a: Activity): boolean {
  return a === 'STOPPED';
}

// ── 전략별 자금 ───────────────────────────────────────────

export interface MoneyRow {
  label: string;
  value: string;
  known: boolean;
}

export interface StrategyMoney {
  /** 배정 금액 */
  allocated?: number | null;
  /** 현재 자산 */
  equity?: number | null;
  /** 누적 손익 */
  pnl?: number | null;
  /** 현재 위험(계좌 대비 %) */
  riskPct?: number | null;
  openPositions?: number | null;
}

/**
 * 이 전략에 돈을 얼마 맡겼는가.
 *
 * 지금 카드에는 이 정보가 아예 없다. 그래서 "얘는 벌고 있고 얘는 계속
 * 잃는다"를 화면에서 판단할 수 없다.
 *
 * **모르는 칸은 0이 아니라 '—'다.** 배정 0은 '이 전략에 돈을 안 맡겼다'는
 * 뜻이고, 그건 '아직 계산 안 됨'과 전혀 다르다.
 */
export function moneyRowsOf(m: StrategyMoney | null | undefined): MoneyRow[] {
  const v = m ?? {};
  const row = (label: string, raw: any, format: FieldFormat): MoneyRow => {
    const text = fmt(raw, format);
    return { label, value: text ?? UNKNOWN_TEXT, known: text != null };
  };
  return [
    row('배정 금액', v.allocated, 'money'),
    row('현재 자산', v.equity, 'money'),
    row('누적 손익', v.pnl, 'money'),
    row('현재 위험', v.riskPct, 'pct'),
    row('활성 포지션', v.openPositions, 'count'),
  ];
}

export interface StrategyPerf {
  return30dPct?: number | null;
  winRatePct?: number | null;
  profitFactor?: number | null;
  maxDrawdownPct?: number | null;
  /** 이 성적이 몇 건 위에 서 있는가 */
  trades?: number | null;
}

/** 이보다 적으면 성적이라고 부르지 않는다 */
export const MIN_TRADES_FOR_PERF = 20;

export interface PerfSummary {
  rows: MoneyRow[];
  /** 표본이 충분한가 */
  enoughSamples: boolean;
  /** 표본이 모자랄 때 붙일 한 줄 */
  note: string;
}

/**
 * 성과 요약.
 *
 * **표본이 몇 건인지 같이 말한다.** 3건에서 나온 승률 67%는 정보가
 * 아니라 우연이고, 그걸 다른 전략의 46%와 나란히 놓으면 잘못된 비교가 된다.
 */
export function perfSummaryOf(p: StrategyPerf | null | undefined): PerfSummary {
  const v = p ?? {};
  const trades = Number(v.trades);
  const known = Number.isFinite(trades);
  const enough = known && trades >= MIN_TRADES_FOR_PERF;

  const row = (label: string, raw: any, format: FieldFormat): MoneyRow => {
    const text = fmt(raw, format);
    return { label, value: text ?? UNKNOWN_TEXT, known: text != null };
  };

  return {
    rows: [
      row('최근 30일', v.return30dPct, 'pct'),
      row('승률', v.winRatePct, 'pct'),
      row('Profit Factor', v.profitFactor, 'text'),
      row('MDD', v.maxDrawdownPct, 'pct'),
    ],
    enoughSamples: enough,
    note: !known
      ? '거래 건수를 확인하지 못했습니다 — 이 성적이 몇 건 위에 선 것인지 알 수 없습니다'
      : enough ? ''
        : `표본 ${trades}건 — ${MIN_TRADES_FOR_PERF}건 미만은 우연일 수 있습니다`,
  };
}

// ── 실행 환경이 카드에도 보여야 한다 ──────────────────────

export interface EnvLine {
  text: string;
  /** 실제 돈이 걸려 있는가 */
  realMoney: boolean;
}

/**
 * 모의 · 테스트넷 · 실전을 골랐는데 카드가 똑같으면, 그 선택은 있으나
 * 마나로 느껴진다. 카드에도 무엇이 걸려 있는지 적는다.
 *
 * **모르는 값은 실전이 아니다.** 다만 모의라고도 하지 않는다 —
 * `envOf`(autoOverview)와 같은 규칙으로 테스트넷이 기본이다.
 */
export function envLineOf(mode: any, exchange?: any): EnvLine {
  const s = String(mode ?? '').trim().toUpperCase();
  const ex = String(exchange ?? '').trim();
  if (s.startsWith('LIVE')) {
    return { text: [ 'LIVE', ex ].filter(Boolean).join(' · ') + ' · 실제 자금', realMoney: true };
  }
  if (s === 'PAPER' || s === 'MOCK' || s.startsWith('PAPER')) {
    return { text: 'PAPER · 실시간 시세 · MOCK 체결', realMoney: false };
  }
  return { text: [ 'TESTNET', ex ].filter(Boolean).join(' · ') + ' · 가상 자금', realMoney: false };
}

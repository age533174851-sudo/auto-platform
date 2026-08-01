// src/lib/ai/tradeVeto.ts
//
// AI 합의를 매매 판단에 붙인다 — **거부권만 준다.**
//
// 왜 거부권만인가
// ───────────────
// "AI가 추천했다고 바로 사면 안 돼. AI는 분석을 잘하는 거지 미래를 아는 건
// 아니야." 이 파일은 그 말을 코드로 옮긴 것이다.
//
// AI에게 진입을 **만들게** 하면 두 가지가 동시에 무너진다:
//  1. 전략의 성적표가 의미를 잃는다. 어떤 거래가 전략이 낸 것이고 어떤 것이
//     AI가 낸 것인지 섞이면, 백테스트로 검증한 그 전략을 돌리고 있는 것이
//     아니다
//  2. 되돌릴 수 없는 쪽으로 실수한다. AI가 틀려서 **안 산 것**은 기회를
//     놓친 것이고, AI가 틀려서 **산 것**은 돈을 잃은 것이다
//
// 그래서 입력은 이미 전략이 정한 방향이고, 출력은 "막을 것인가"뿐이다.
// 같은 방향으로 AI가 동의해도 크기를 키우지 않는다 — 동의는 아무것도
// 바꾸지 않는다.
//
// 커버리지가 왜 결과의 일부인가
// ─────────────────────────────
// 다섯에게 물어 둘이 답했는데 그 둘이 같은 말을 하면 '만장일치'다. 숫자만
// 보면 가장 강한 합의처럼 보이는데, 실제로는 **가장 적게 확인된 판단**이다.
// 물어본 수와 답한 수를 같이 들고 다니지 않으면 이 구분이 사라진다.
//
// 못 물어봤을 때 막지 않는 이유
// ─────────────────────────────
// 이 저장소의 규칙은 '확인하지 못한 것은 통과가 아니다'이고, 손실 한도·마진
// 모드는 모르면 막는다. AI는 다르게 둔다: **AI는 안전장치가 아니라 덧댄
// 의견**이다. OpenAI가 5분 죽었다고 매매가 멈추면, 그건 AI를 안전장치로
// 쓴 것이고 그 순간 AI 장애가 매매 장애가 된다.
//
// 대신 **통과라고 적지도 않는다.** 못 물어본 것은 'abstain'이고 화면에
// 그대로 뜬다(체크리스트에서 warn). 정말로 막고 싶으면 strict를 켜면 되고,
// 그때는 확인 못 함이 되어 막힌다 — 선택이지 기본값이 아니다.

/** 이 판정에 필요한 것만. news/consensus의 결과를 그대로 넣을 수 있다 */
export interface ConsensusSnapshot {
  /** 'UNANIMOUS' | 'MAJORITY' | 'SPLIT' | 'INSUFFICIENT' */
  level: string;
  /** 'bullish' | 'bearish' | 'neutral' | 'uncertain' | null */
  direction: string | null;
  /** 0~100. 갈렸으면 이미 깎여 있다 */
  confidence: number | null;
  /** 실제로 답한 공급자 수 */
  responded: number | null;
  /** 물어본 공급자 수. responded와 같으면 전원 응답 */
  asked: number | null;
  /** 이 합의를 만든 시각(ms). 오래된 의견으로 지금을 막지 않는다 */
  asOfMs?: number | null;
}

export type VetoStatus =
  /** AI가 충분히 답했고 이 방향을 반대하지 않았다 */
  | 'ok'
  /** 반대 합의가 충분히 강하다 — 진입을 막는다 */
  | 'blocked'
  /** AI가 판단하지 않았다(부족·갈림·오래됨). 막지 않지만 통과도 아니다 */
  | 'abstain'
  /** strict를 켰는데 판단하지 못했다 — 막는다 */
  | 'unknown';

export interface VetoJudgement {
  status: VetoStatus;
  /** 사람이 읽을 한 줄. 통과일 때도 근거를 적는다 */
  reason: string;
  /** 몇이 물었고 몇이 답했나. 화면에서 지우면 안 되는 값 */
  coverage: { asked: number | null; responded: number | null };
  /** 이 판정에 쓴 합의 방향(정규화) */
  aiDirection: 'bullish' | 'bearish' | 'neutral' | null;
  /** 반대 방향인가 */
  opposes: boolean;
  /** 캘리브레이션에 남길 확신도 */
  confidence: number | null;
}

export interface VetoConfig {
  /** 꺼져 있으면 이 검사는 목록에 아예 안 나온다 */
  enabled: boolean;
  /** 이만큼은 답해야 합의라고 부른다 */
  minResponded: number;
  /** 반대 합의가 이 확신도를 넘어야 막는다 */
  minConfidence: number;
  /** 이보다 오래된 의견은 쓰지 않는다 (ms) */
  maxAgeMs: number;
  /** 켜면 판단 못 한 것도 막는다 */
  strict: boolean;
}

export const VETO_DEFAULTS: VetoConfig = {
  enabled: false,        // 어떤 거래를 할지 바꾸는 검사다. 켜는 것은 명시적 선택이어야 한다
  minResponded: 2,       // 하나는 합의가 아니라 단일 의견이다
  minConfidence: 70,     // 어중간한 반대로 전략을 덮어쓰지 않는다
  maxAgeMs: 30 * 60_000, // 30분
  strict: false,
};

/** 숫자를 읽는다. null·''·NaN을 0으로 만들지 않는다 — 0과 모름은 다르다 */
function num(v: any): number | null {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: any, dflt: boolean): boolean {
  if (v == null) return dflt;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'y'].includes(s)) return true;
  if (['0', 'false', 'off', 'no', 'n'].includes(s)) return false;
  return dflt;
}

export function readVetoConfig(env: Record<string, any> = {}): VetoConfig {
  const minResponded = num(env.AI_VETO_MIN_PROVIDERS);
  const minConfidence = num(env.AI_VETO_MIN_CONFIDENCE);
  const maxAgeMin = num(env.AI_VETO_MAX_AGE_MIN);
  return {
    enabled: bool(env.AI_VETO_ENABLED, VETO_DEFAULTS.enabled),
    // 1로 내리면 단일 의견이 전략을 덮어쓴다. 바닥을 2로 둔다.
    minResponded: minResponded != null && minResponded >= 2
      ? Math.floor(minResponded) : VETO_DEFAULTS.minResponded,
    minConfidence: minConfidence != null && minConfidence >= 0 && minConfidence <= 100
      ? minConfidence : VETO_DEFAULTS.minConfidence,
    maxAgeMs: maxAgeMin != null && maxAgeMin > 0
      ? maxAgeMin * 60_000 : VETO_DEFAULTS.maxAgeMs,
    strict: bool(env.AI_VETO_STRICT, VETO_DEFAULTS.strict),
  };
}

/** 합의 방향을 매매 방향과 비교할 수 있는 형태로 */
function normalizeDirection(d: string | null | undefined): 'bullish' | 'bearish' | 'neutral' | null {
  if (d == null) return null;
  const s = String(d).trim().toLowerCase();
  if (s === 'bullish' || s === 'long' || s === 'buy') return 'bullish';
  if (s === 'bearish' || s === 'short' || s === 'sell') return 'bearish';
  if (s === 'neutral') return 'neutral';
  // 'uncertain'을 neutral로 접지 않는다. 보류는 '방향이 없다'가 아니라
  // '모르겠다'이고, 둘을 합치면 모른다는 사실이 사라진다.
  return null;
}

/**
 * 이 진입을 AI가 막는가.
 *
 * `side`는 전략이 이미 정한 방향이다. 이 함수는 그것을 바꾸지 못하고,
 * 막을지 말지만 답한다.
 */
export function judgeAiVeto(input: {
  side: 'LONG' | 'SHORT' | null | undefined;
  consensus: ConsensusSnapshot | null | undefined;
  nowMs: number;
}, cfg: VetoConfig = VETO_DEFAULTS): VetoJudgement {
  const asked = num(input.consensus?.asked);
  const responded = num(input.consensus?.responded);
  const coverage = { asked, responded };
  const confidence = num(input.consensus?.confidence);

  const abstain = (reason: string): VetoJudgement => ({
    // strict면 같은 상황이 '확인 못 함'이 되어 막힌다. 문구는 그대로 두어
    // 왜 막혔는지가 같은 문장으로 읽히게 한다.
    status: cfg.strict ? 'unknown' : 'abstain',
    reason, coverage, aiDirection: null, opposes: false, confidence,
  });

  if (!input.consensus) return abstain('AI 합의를 받지 못했습니다');

  // 방향이 없으면 막을 근거도 없다. 전략의 방향을 모르는 채로 반대인지
  // 판정하면 그건 방향과 무관하게 막는 것이다.
  if (input.side !== 'LONG' && input.side !== 'SHORT') {
    return abstain('진입 방향이 정해지지 않아 AI 판단을 적용하지 않았습니다');
  }

  if (responded == null) return abstain('몇 개 AI가 답했는지 알 수 없습니다');
  if (responded < cfg.minResponded) {
    return abstain(
      `AI ${responded}개만 답했습니다 (필요 ${cfg.minResponded}개)`
      + (asked != null ? ` — ${asked}개에 물었습니다` : '')
      + '. 합의가 아니라 단일 의견이라 적용하지 않았습니다');
  }

  // 오래된 의견으로 지금을 막지 않는다. 30분 전 뉴스 판단이 지금 호가에
  // 대해 무엇을 말하는지 알 수 없다.
  const asOf = num(input.consensus.asOfMs);
  if (asOf != null) {
    const age = input.nowMs - asOf;
    if (age > cfg.maxAgeMs) {
      const min = Math.round(age / 60_000);
      return abstain(`AI 합의가 ${min}분 전 것입니다 (허용 ${Math.round(cfg.maxAgeMs / 60_000)}분) — 적용하지 않았습니다`);
    }
    // 미래 시각은 시계가 틀린 것이다. 조용히 통과시키지 않는다.
    if (age < -60_000) {
      return abstain('AI 합의 시각이 미래입니다 — 시계를 확인하세요');
    }
  }

  const level = String(input.consensus.level ?? '').toUpperCase();
  if (level !== 'UNANIMOUS' && level !== 'MAJORITY') {
    return abstain(
      level === 'SPLIT'
        ? 'AI 의견이 갈렸습니다 — 방향을 내지 않으므로 적용하지 않았습니다'
        : `AI 합의가 성립하지 않았습니다 (${level || '알 수 없음'})`);
  }

  const aiDirection = normalizeDirection(input.consensus.direction);
  if (aiDirection == null) {
    return abstain('AI가 방향을 내지 않았습니다');
  }

  const opposes =
    (input.side === 'LONG' && aiDirection === 'bearish') ||
    (input.side === 'SHORT' && aiDirection === 'bullish');

  const base = { coverage, aiDirection, opposes, confidence };
  const cov = asked != null ? `${responded}/${asked}` : `${responded}`;
  const ko = aiDirection === 'bullish' ? '상승' : aiDirection === 'bearish' ? '하락' : '보합';

  if (!opposes) {
    // **같은 방향이어도 아무것도 키우지 않는다.** 동의는 통과일 뿐이다.
    // 이 문장을 화면에 그대로 적는 이유: "AI도 상승이래"를 보면 사람은
    // 크기를 키우고 싶어진다. 시스템이 안 키운다는 것을 같이 말해야 한다.
    const agree = aiDirection === 'neutral'
      ? `AI ${cov}가 보합으로 봤습니다 — 반대하지 않습니다`
      : `AI ${cov}가 ${ko}으로 봤습니다 — ${input.side} 진입에 반대하지 않습니다`;
    return { ...base, status: 'ok', reason: `${agree}. AI 동의는 크기를 키우지 않습니다` };
  }

  // 반대다. 그래도 확신이 약하면 막지 않는다 — 어중간한 반대로 검증된
  // 전략을 덮어쓰기 시작하면 그건 다른 전략이다.
  if (confidence == null) {
    return abstain(`AI ${cov}가 ${ko}으로 반대했지만 확신도를 알 수 없어 적용하지 않았습니다`);
  }
  if (confidence < cfg.minConfidence) {
    // strict여도 여기서는 막지 않는다. strict는 '판단하지 못한 것'을 막는
    // 스위치이지, '판단했는데 약한 것'을 막는 스위치가 아니다. 둘을 같이
    // 묶으면 strict를 켜는 순간 AI가 사실상 매수 필터가 된다.
    return {
      ...base, status: 'abstain',
      reason: `AI ${cov}가 ${ko}으로 반대했지만 확신도 ${confidence}%로 기준(${cfg.minConfidence}%)에 못 미쳐 막지 않았습니다`,
    };
  }

  return {
    ...base, status: 'blocked',
    reason: `AI ${cov}가 ${ko}으로 봤습니다 (확신도 ${confidence}%) — ${input.side} 진입과 반대입니다`,
  };
}

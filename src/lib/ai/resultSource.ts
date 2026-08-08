// src/lib/ai/resultSource.ts
//
// **AI 호출이 실패했는데 화면은 'AI 분석 결과'라고 적고 있었다.**
//
// 실제 화면:
//
//   AI 분석 결과
//   신뢰도 75% · fallback
//   OpenAI 호출 실패 — fallback 사용 (openai_status_429)
//
// OpenAI가 429로 거절했고, 내부 규칙 템플릿이 결과를 만들었다. 그런데
// 제목은 'AI 분석 결과'이고 신뢰도 75%가 붙어 있다. 아래 작은 글씨를
// 읽지 않으면 **AI가 실제로 분석했다고 믿게 된다.**
//
// 신뢰도 75%가 특히 나쁘다
// ────────────────────────
// 그 숫자는 어디서 왔는가? AI가 낸 것이 아니다. 템플릿에 박혀 있던
// 상수다. **모델의 확신과 템플릿의 기본값을 같은 이름·같은 숫자로
// 보여주면, 둘의 차이가 화면에서 영영 사라진다.**
//
// 이 저장소의 규칙이 여기에도 그대로 적용된다: 모르는 것을 지어내지
// 않는다. 템플릿은 자기가 얼마나 맞을지 모른다 — 그러면 신뢰도는
// null이지 75%가 아니다.
//
// 그리고 하나 더
// ──────────────
// 실패했을 때 **직전 성공 결과를 새 결과처럼 재사용하면 안 된다.**
// 사용자는 방금 누른 버튼의 답으로 읽는다.

export type ResultSource =
  /** 모델이 실제로 답했다 */
  | 'AI_GENERATED'
  /** 호출이 실패해 내부 규칙 템플릿이 만들었다 */
  | 'FALLBACK_TEMPLATE'
  /** 사람이 직접 썼다 */
  | 'MANUAL'
  /** 출처를 확인하지 못했다 */
  | 'UNKNOWN';

/**
 * 화면 제목.
 *
 * **fallback에는 'AI 분석 결과'라고 쓰지 않는다.** 그 말이 이 문제의
 * 시작이었다.
 */
export const SOURCE_TITLE: Record<ResultSource, string> = {
  AI_GENERATED: 'AI 분석 결과',
  FALLBACK_TEMPLATE: '기본 전략 초안',
  MANUAL: '직접 작성',
  UNKNOWN: '출처 미상 초안',
};

export const SOURCE_BADGE: Record<ResultSource, string> = {
  AI_GENERATED: 'AI 생성',
  FALLBACK_TEMPLATE: 'Fallback Template',
  MANUAL: '직접 작성',
  UNKNOWN: '출처 미상',
};

export const SOURCE_DESC: Record<ResultSource, string> = {
  AI_GENERATED: '모델이 실제로 응답한 결과입니다. 검증은 아직 하지 않았습니다.',
  FALLBACK_TEMPLATE:
    'AI 분석을 사용할 수 없어 내부 규칙 템플릿이 만든 초안입니다. '
    + '시장 데이터를 보고 판단한 것이 아니라 정해진 틀을 채운 것입니다.',
  MANUAL: '사람이 직접 작성한 설정입니다.',
  UNKNOWN: '이 결과를 무엇이 만들었는지 확인하지 못했습니다.',
};

/**
 * 응답에서 출처를 읽는다.
 *
 * **모르는 값을 AI로 읽지 않는다.** 그쪽으로 기울면 실패한 호출이
 * 성공으로 보인다 — 정확히 지금 난 고장이다.
 */
export function sourceOf(raw: any): ResultSource {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return 'UNKNOWN';
  if (s === 'MANUAL' || s === 'USER') return 'MANUAL';
  if (s === 'FALLBACK' || s === 'FALLBACK_TEMPLATE' || s === 'TEMPLATE') return 'FALLBACK_TEMPLATE';
  // 알려진 제공자 이름만 AI로 센다. 모르는 문자열은 AI가 아니다.
  const PROVIDERS = ['OPENAI', 'ANTHROPIC', 'CLAUDE', 'GEMINI', 'GOOGLE', 'OPENROUTER', 'GROQ', 'AI'];
  return PROVIDERS.includes(s) ? 'AI_GENERATED' : 'UNKNOWN';
}

export interface AiResultView {
  source: ResultSource;
  title: string;
  badge: string;
  desc: string;
  /**
   * 화면에 적을 신뢰도 (%). **AI가 실제로 답했을 때만 값이 있다.**
   *
   * 템플릿은 자기가 얼마나 맞을지 모른다 — 그때는 null이고, 화면은
   * 그 자리에 숫자 대신 '해당 없음'을 적어야 한다.
   */
  confidencePct: number | null;
  /** 신뢰도를 안 보여주는 이유 */
  confidenceNote: string;
  /** 검증을 마쳤는가 — AI가 만들었든 아니든 기본은 미검증이다 */
  validated: boolean;
  /** 실패했다면 무엇 때문인가 */
  failureNote: string;
  /** 다시 시도할 수 있는가 */
  retryable: boolean;
}

/**
 * 429·5xx 같은 실패 코드를 사람 말로.
 *
 * **상태 코드만 남기면 '왜'를 모른다.** 429는 요청 제한과 잔액 부족이
 * 둘 다 쓰는 코드인데 대응이 완전히 다르다.
 */
export function failureText(code: any): string {
  const s = String(code ?? '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('429')) {
    return '요청이 몰려 거절됐습니다 (429) — 잠시 뒤 다시 시도하거나 잔액·한도를 확인하세요';
  }
  if (s.includes('401') || s.includes('403')) return '키가 거절됐습니다 — API 키를 확인하세요';
  if (s.includes('timeout') || s.includes('abort')) return '응답이 시간 안에 오지 않았습니다';
  if (/(50\d)/.test(s)) return '제공자 쪽 오류입니다 — 잠시 뒤 다시 시도하세요';
  return `호출이 실패했습니다 (${code})`;
}

export interface AiResultInput {
  /** 응답의 provider/source 값 */
  source?: any;
  /** 모델이 준 신뢰도 (0~100) */
  confidence?: any;
  /** 실패 코드 */
  errorCode?: any;
  /** 검증을 마쳤는가 */
  validated?: any;
}

/**
 * 화면이 쓸 모양으로 만든다.
 *
 * 핵심 규칙 둘:
 *   1. fallback에는 **AI 신뢰도를 붙이지 않는다**
 *   2. fallback을 **'AI 분석 결과'라고 부르지 않는다**
 */
export function aiResultView(input: AiResultInput | null | undefined): AiResultView {
  const i = input ?? {};
  const source = sourceOf(i.source);
  const failureNote = failureText(i.errorCode);

  const rawConf = Number(i.confidence);
  const hasConf = Number.isFinite(rawConf) && rawConf >= 0 && rawConf <= 100;

  // **AI가 실제로 답했을 때만 신뢰도가 있다.**
  const confidencePct = source === 'AI_GENERATED' && hasConf ? rawConf : null;
  const confidenceNote =
    source === 'AI_GENERATED'
      ? (hasConf ? '' : '모델이 신뢰도를 주지 않았습니다')
      : source === 'FALLBACK_TEMPLATE'
        ? '템플릿은 자기가 얼마나 맞을지 모릅니다 — AI 신뢰도가 아닙니다'
        : '이 결과에는 신뢰도가 없습니다';

  return {
    source,
    title: SOURCE_TITLE[source],
    badge: SOURCE_BADGE[source],
    desc: SOURCE_DESC[source],
    confidencePct,
    confidenceNote,
    // **기본은 미검증이다.** AI가 만들었다는 것과 쓸 만하다는 것은 다르다.
    validated: i.validated === true,
    failureNote,
    retryable: source !== 'AI_GENERATED',
  };
}

// ── 429를 어떻게 다시 시도할 것인가 ───────────────────────

/** 이 이상은 기다리지 않는다 */
export const MAX_RETRY_DELAY_MS = 60_000;

export interface RetryPlan {
  /** 다시 시도해도 되는가 */
  should: boolean;
  /** 얼마나 기다린 뒤에 */
  delayMs: number;
  reason: string;
}

/**
 * 다시 시도 계획.
 *
 * **Retry-After를 존중한다.** 제공자가 몇 초 뒤에 오라고 말했으면 그
 * 시간을 지켜야 한다 — 무시하고 바로 다시 때리면 한도가 더 늦게 풀린다.
 *
 * 그리고 **연타를 막는다.** 버튼을 여러 번 누르면 요청이 그만큼 나가고,
 * 429가 난 상황에서 그건 상황을 악화시키기만 한다.
 */
export function retryPlan(input: {
  attempt?: any; retryAfterSec?: any; errorCode?: any; inFlight?: any;
} | null | undefined): RetryPlan {
  const i = input ?? {};
  if (i.inFlight === true) {
    return { should: false, delayMs: 0, reason: '이미 요청이 나가 있습니다 — 연타는 한도만 더 씁니다' };
  }

  const code = String(i.errorCode ?? '');
  const attempt = Math.max(0, Math.floor(Number(i.attempt) || 0));
  if (attempt >= 4) {
    return { should: false, delayMs: 0, reason: '4번 시도했습니다 — 여기서 멈추고 사람이 확인해야 합니다' };
  }

  const after = Number(i.retryAfterSec);
  if (Number.isFinite(after) && after > 0) {
    return {
      should: true,
      delayMs: Math.min(MAX_RETRY_DELAY_MS, Math.ceil(after * 1000)),
      reason: `제공자가 ${after}초 뒤에 오라고 했습니다`,
    };
  }

  // 429·5xx만 재시도한다. 401은 몇 번을 해도 같은 답이다.
  const retryable = code.includes('429') || /(50\d)/.test(code)
    || code.includes('timeout') || code.includes('abort');
  if (!retryable) {
    return { should: false, delayMs: 0, reason: '다시 보내도 같은 답이 오는 오류입니다' };
  }

  // 2초 → 4초 → 8초 → 16초
  return {
    should: true,
    delayMs: Math.min(MAX_RETRY_DELAY_MS, 2000 * Math.pow(2, attempt)),
    reason: `${attempt + 1}번째 재시도`,
  };
}

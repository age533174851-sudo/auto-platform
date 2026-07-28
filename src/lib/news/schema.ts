// src/lib/news/schema.ts
//
// AI가 돌려준 뉴스 분석을 검증한다.
//
// 왜 순수 모듈로 빼는가
// ─────────────────────
// AI 응답은 신뢰할 수 없는 입력이다. 모델이 바뀌면 형식도 바뀌고, 같은
// 모델도 가끔 필드를 빠뜨리거나 없는 숫자를 지어낸다. 그걸 그대로
// 화면과 전략에 흘리면 "AI가 상승이라고 했다"가 근거 없는 사실이 된다.
//
// 그래서 검증을 라우트가 아니라 여기서 한다. 라우트는 인증과 위임만
// 하고, 무엇이 통과할 수 있는지는 테스트가 있는 이 파일이 정한다.
//
// uncertain이 왜 별도 값인가
// ──────────────────────────
// 방향을 세 개(상승/보합/하락)로만 두면 모델은 언제나 셋 중 하나를
// 고른다. 모르는 것과 "움직이지 않을 것 같다"는 완전히 다른 말인데
// 둘 다 neutral이 된다. 판단 보류를 표현할 자리가 없으면 모델은
// 보류하지 않는다.

import type { NewsAnalysis, NewsPrediction } from './types';

export type NewsDirection = 'bullish' | 'neutral' | 'bearish' | 'uncertain';

export const DIRECTION_KO: Record<NewsDirection, string> = {
  bullish: '상승', neutral: '보합', bearish: '하락', uncertain: '판단 보류',
};

/** 예측 기간. 없거나 모르면 unknown — 임의로 '단기'라고 하지 않는다 */
export type NewsHorizon = 'intraday' | 'short' | 'medium' | 'long' | 'unknown';

export const HORIZON_KO: Record<NewsHorizon, string> = {
  intraday: '당일', short: '단기', medium: '중기', long: '장기', unknown: '기간 불명',
};

export interface NewsAnalysisV2 {
  titleKo: string;
  summary: string;
  affectedAssets: string[];
  direction: NewsDirection;
  directionKo: string;
  confidence: number;          // 0~100
  horizon: NewsHorizon;
  reasons: string[];
  risks: string[];
  sourceUrl: string;
  publishedAt: string;         // ISO UTC
  provider: string;
  model: string;
  analyzedAt: string;          // ISO UTC
}

export interface ValidateResult {
  ok: boolean;
  value: NewsAnalysisV2 | null;
  /** 왜 떨어졌는지. 사용자가 아니라 로그와 개발자를 위한 것 */
  errors: string[];
  /** 고쳐서 통과시킨 항목. 조용히 고치면 모델이 나빠져도 알 수 없다 */
  repaired: string[];
}

const DIRECTIONS: NewsDirection[] = ['bullish', 'neutral', 'bearish', 'uncertain'];
const HORIZONS: NewsHorizon[] = ['intraday', 'short', 'medium', 'long', 'unknown'];

/** 모르는 방향 값은 uncertain. 임의로 neutral로 바꾸면 '보합 전망'이 된다 */
export function parseDirection(raw: unknown): NewsDirection {
  const s = String(raw ?? '').trim().toLowerCase();
  if ((DIRECTIONS as string[]).includes(s)) return s as NewsDirection;
  // 모델이 한국어나 다른 표현으로 답하는 경우가 있다
  if (/bull|up|positive|상승|호재/.test(s)) return 'bullish';
  if (/bear|down|negative|하락|악재/.test(s)) return 'bearish';
  if (/flat|neutral|보합|중립/.test(s)) return 'neutral';
  return 'uncertain';
}

export function parseHorizon(raw: unknown): NewsHorizon {
  const s = String(raw ?? '').trim().toLowerCase();
  if ((HORIZONS as string[]).includes(s)) return s as NewsHorizon;
  if (/intraday|당일|하루/.test(s)) return 'intraday';
  if (/short|단기/.test(s)) return 'short';
  if (/medium|중기/.test(s)) return 'medium';
  if (/long|장기/.test(s)) return 'long';
  return 'unknown';
}

/** 0~100으로 자른다. 숫자가 아니면 null — 0으로 두면 "확신 없음"이 아니라 "확신 0%"가 된다 */
export function parseConfidence(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  if (!Number.isFinite(n)) return null;
  // 0~1로 답하는 모델이 있다. 0.72를 72%로 읽는다.
  const v = n > 0 && n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function strArray(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(x => String(x ?? '').trim())
    .filter(x => x.length > 0 && x.length < 400)
    .slice(0, max);
}

/** 주소 자리를 채우려고 넣는 값들. 있으나 마나가 아니라 없는 것이다 */
const PLACEHOLDER_URLS = new Set(['#', '-', 'n/a', 'na', 'null', 'undefined', 'about:blank']);

/**
 * 원문 주소를 검증한다. 못 쓰는 주소면 null.
 *
 * "비어 있지 않으면 통과"로는 부족하다. 뉴스 제공자는 주소가 없을 때
 * '#'을 채워 보내고(newsapi 매핑이 그렇게 한다), 그 '#'은 링크처럼
 * 생겼지만 아무 데도 가지 않는다. 출처를 확인할 수 없다는 점에서
 * 빈 문자열과 똑같다.
 *
 * http(s)만 통과시킨다. 이 주소는 결국 window.open에 들어간다 —
 * javascript: 를 통과시키면 뉴스 제공자가 우리 페이지에서 코드를 실행한다.
 */
export function parseSourceUrl(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s || PLACEHOLDER_URLS.has(s.toLowerCase())) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // 호스트에 점이 없으면 진짜 출처가 아니다 (localhost, 오타)
  if (!u.hostname || !u.hostname.includes('.')) return null;
  return u.toString();
}

const MIN_PUBLISHED_MS = Date.UTC(2000, 0, 1);
const FUTURE_TOLERANCE_MS = 2 * 24 * 60 * 60 * 1000;  // 시차·서버 시계 오차

/**
 * 발행 시각을 ISO UTC로 맞춘다. 읽을 수 없으면 null.
 *
 * 여기서도 "비어 있지 않으면 통과"는 위험하다. 목록에 쓰는 표시용 문자열
 * ('5분 전')이 그대로 넘어오면 통과해 버리고, 화면에는 Invalid Date가 뜬다.
 * 실제로 이 앱의 뉴스 항목은 time 필드에 '5분 전'을 담고 있다.
 *
 * 미래 시각도 떨어뜨린다. 아직 나오지 않은 기사를 근거로 방향을 말할 수는 없다.
 */
export function parsePublishedAt(raw: unknown, nowMs?: number): string | null {
  if (raw == null || raw === '') return null;

  let ms: number;
  if (raw instanceof Date) {
    ms = raw.getTime();
  } else if (typeof raw === 'number') {
    ms = raw;
  } else {
    const s = String(raw).trim();
    if (!s) return null;
    // 숫자만 있으면 epoch로 본다
    ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  }
  if (!Number.isFinite(ms)) return null;

  // 초 단위 epoch을 ms로 (2001년 이후 ms 값은 모두 1e12를 넘는다)
  if (ms > 0 && ms < 1e12) ms *= 1000;

  const now = nowMs ?? Date.now();
  if (ms < MIN_PUBLISHED_MS) return null;
  if (ms > now + FUTURE_TOLERANCE_MS) return null;

  return new Date(ms).toISOString();
}

/**
 * AI 응답 객체를 검증한다.
 *
 * 통과 조건은 느슨하지 않다. 원문 URL과 발행 시각이 없으면 떨어뜨린다 —
 * 출처를 확인할 수 없는 분석은 화면에 "AI가 그렇다고 했다"만 남는다.
 */
export function validateAnalysis(
  raw: any,
  ctx: {
    sourceUrl?: string;
    /** ISO 문자열·epoch(초/ms)·Date 무엇이든 받는다. 읽을 수 없으면 떨어뜨린다 */
    publishedAt?: string | number | Date;
    provider: string;
    model: string;
    now?: string;
  },
): ValidateResult {
  const errors: string[] = [];
  const repaired: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, value: null, errors: ['객체가 아닙니다'], repaired };
  }

  const titleKo = String(raw.titleKo ?? raw.title_ko ?? '').trim();
  if (!titleKo) errors.push('titleKo 없음');

  const summary = String(raw.summary ?? raw.summaryKo ?? '').trim();
  if (!summary) errors.push('summary 없음');

  // 출처는 컨텍스트가 진실이다. 모델이 URL을 지어내는 일이 흔하다 —
  // 그럴듯한 주소를 만들어 붙이면 사람은 확인 없이 믿는다.
  const sourceUrl = parseSourceUrl(ctx.sourceUrl);
  if (!sourceUrl) errors.push('sourceUrl 없음/부적합 (원문 없는 분석은 저장하지 않는다)');
  if (raw.sourceUrl && String(raw.sourceUrl).trim() !== (sourceUrl ?? '')) {
    repaired.push('모델이 만든 sourceUrl을 원문 값으로 되돌림');
  }

  const publishedAt = parsePublishedAt(ctx.publishedAt);
  if (!publishedAt) errors.push('publishedAt 없음/읽을 수 없음');

  const direction = parseDirection(raw.direction);
  if (raw.direction != null && direction === 'uncertain'
      && !/uncertain|보류/i.test(String(raw.direction))) {
    repaired.push(`알 수 없는 direction('${raw.direction}') → uncertain`);
  }

  let confidence = parseConfidence(raw.confidence);
  if (confidence == null) {
    confidence = 0;
    repaired.push('confidence 없음 → 0 (판단 보류로 처리)');
  }

  const horizon = parseHorizon(raw.horizon);
  const reasons = strArray(raw.reasons, 5);
  const risks = strArray(raw.risks, 5);
  const affectedAssets = strArray(raw.affectedAssets ?? raw.assets, 10)
    .map(s => s.toUpperCase().replace(/[^A-Z0-9._/-]/g, ''))
    .filter(Boolean);

  // 방향을 단정하면서 근거가 없으면 보류로 내린다. 근거 없는 방향은
  // 예측이 아니라 추측이고, 화면에서는 둘이 똑같아 보인다.
  let finalDirection = direction;
  let finalConfidence = confidence;
  if (finalDirection !== 'uncertain' && reasons.length === 0) {
    finalDirection = 'uncertain';
    finalConfidence = Math.min(finalConfidence, 30);
    repaired.push('근거가 없어 방향을 uncertain으로 내림');
  }
  // 보류인데 확신이 높다고 하는 것은 모순이다
  if (finalDirection === 'uncertain' && finalConfidence > 50) {
    finalConfidence = 50;
    repaired.push('uncertain인데 confidence가 높아 50으로 제한');
  }

  if (errors.length) return { ok: false, value: null, errors, repaired };

  return {
    ok: true,
    errors: [],
    repaired,
    value: {
      titleKo, summary, affectedAssets,
      direction: finalDirection,
      directionKo: DIRECTION_KO[finalDirection],
      confidence: finalConfidence,
      horizon, reasons, risks,
      sourceUrl, publishedAt,
      provider: ctx.provider, model: ctx.model,
      analyzedAt: ctx.now ?? new Date().toISOString(),
    },
  };
}

/**
 * 모델이 코드펜스나 설명을 섞어 답하는 경우가 있어 JSON만 뽑아낸다.
 * 실패하면 null — 억지로 고치려 들면 엉뚱한 조각을 파싱한다.
 */
export function extractJson(text: string | null | undefined): any | null {
  if (!text) return null;
  const t = String(text).trim();
  const candidates = [t];

  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.unshift(fence[1].trim());

  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1));

  for (const c of candidates) {
    try { const v = JSON.parse(c); if (v && typeof v === 'object') return v; } catch { /* 다음 후보 */ }
  }
  return null;
}

/**
 * 같은 기사를 두 번 분석하지 않기 위한 지문.
 *
 * URL만 쓰지 않는 이유: 같은 기사가 추적 파라미터(utm_*)를 달고 여러 번
 * 들어온다. 제목만 쓰지 않는 이유: 다른 기사가 같은 제목을 쓴다.
 */
export function contentHash(input: { url?: string; title?: string; publishedAt?: string }): string {
  const url = String(input.url ?? '').trim().toLowerCase()
    .replace(/[?#].*$/, '')      // 쿼리·앵커 제거
    .replace(/\/+$/, '');
  const title = String(input.title ?? '').trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '');
  const day = String(input.publishedAt ?? '').slice(0, 10);
  const basis = `${url}|${title}|${day}`;

  // 외부 의존 없이 안정적인 해시(FNV-1a 32bit ×2)면 충분하다.
  // 암호용이 아니라 중복 판별용이다.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < basis.length; i++) {
    const c = basis.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

/**
 * 뉴스 항목 → 캐시 키.
 *
 * id를 그대로 쓰면 안 된다. 제공자가 주는 id는 같은 기사에 대해서도
 * 요청마다 달라지고(추적 파라미터가 섞인 URL로 만들어진다), 그러면 같은
 * 기사를 계속 다시 분석한다 — 돈이 나가고 결과도 매번 조금씩 달라진다.
 *
 * 주소도 제목도 없으면 지문을 만들 수 없으니 id로 물러선다.
 */
export function newsCacheKey(n: {
  id?: string;
  title?: string;
  url?: string;
  publishedAt?: string | number;
  time?: string | number;
}): string {
  if (!n.url && !n.title) return `id:${n.id ?? ''}`;
  return contentHash({
    url: n.url,
    title: n.title,
    // 하루 단위로만 쓰이므로 읽을 수 없으면 비워 둔다
    publishedAt: parsePublishedAt(n.publishedAt ?? n.time) ?? '',
  });
}

/** V2 방향 → 화면이 쓰는 예측 값. uncertain은 접지 않고 그대로 넘긴다 */
const DIRECTION_TO_PREDICTION: Record<NewsDirection, NewsPrediction> = {
  bullish: 'up', bearish: 'down', neutral: 'flat', uncertain: 'unknown',
};

/**
 * 검증된 V2 결과를 화면이 쓰는 NewsAnalysis로 옮긴다.
 *
 * uncertain → unknown으로 간다. flat으로 접으면 "보합 예상"이 되고,
 * 그건 모델이 하지 않은 말이다. 검증을 붙인 이유가 사라진다.
 *
 * 자산별 방향은 전체 방향을 그대로 쓴다. V2는 자산 목록만 받는다 —
 * 자산마다 다른 방향을 물으면 모델이 지어낼 자리가 하나 더 생긴다.
 */
export function toLegacyAnalysis(v2: NewsAnalysisV2): NewsAnalysis {
  const prediction = DIRECTION_TO_PREDICTION[v2.direction];
  const analyzedAtMs = Date.parse(v2.analyzedAt);
  return {
    titleKo:   v2.titleKo,
    summaryKo: v2.summary,
    prediction,
    confidence: v2.confidence,
    reasons:    v2.reasons,
    affectedAssets: v2.affectedAssets.map(symbol => ({ symbol, direction: prediction })),
    source:     v2.provider === 'mock' ? 'mock' : 'openai',
    analyzedAt: Number.isFinite(analyzedAtMs) ? analyzedAtMs : Date.now(),
  };
}

/** AI에게 줄 출력 형식 지시. 프롬프트에 붙인다 */
export const ANALYSIS_JSON_INSTRUCTION = `반드시 아래 JSON만 출력해라. 설명·코드펜스 금지.
{
  "titleKo": "한국어 제목",
  "summary": "핵심 2~3줄 요약",
  "affectedAssets": ["BTC","NASDAQ"],
  "direction": "bullish | neutral | bearish | uncertain",
  "confidence": 0-100,
  "horizon": "intraday | short | medium | long | unknown",
  "reasons": ["근거1","근거2"],
  "risks": ["위험1"]
}
규칙:
- 주어진 원문에 있는 내용만 쓴다. 없는 수치나 사실을 만들지 않는다.
- 확실하지 않으면 direction은 uncertain으로 한다. 억지로 방향을 고르지 않는다.
- 근거를 댈 수 없으면 direction은 uncertain이다.
- 이것은 투자 조언이 아니라 분석이다.`;

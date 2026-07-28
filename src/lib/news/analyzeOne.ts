// src/lib/news/analyzeOne.ts
//
// 기사 하나를 AI로 분석한다.
//
// 왜 라우트가 아니라 여기인가
// ───────────────────────────
// 라우트는 인증과 위임만 한다. 무엇이 통과할 수 있는지, 실패했을 때
// 무엇을 돌려주는지는 테스트가 붙는 곳에서 정해야 한다. 이 파일은
// fetch를 직접 하지 않고 호출 함수를 주입받는다 — 그래야 키 없이도
// 동작을 검증할 수 있다.
//
// AI가 못 하는 일
// ───────────────
// 뉴스를 만들어내는 것. 여기 오는 건 이미 수집된 원문이고, AI는 그걸
// 해석만 한다. 그래서 sourceUrl·publishedAt은 모델 응답이 아니라
// 원문에서 온 값을 쓴다.
import {
  validateAnalysis, extractJson, contentHash,
  ANALYSIS_JSON_INSTRUCTION, type NewsAnalysisV2,
} from './schema';

export interface ArticleInput {
  title: string;
  body?: string;
  url: string;
  publishedAt: string;
  source?: string;
}

/** providers.callAny와 같은 모양. 테스트에서는 가짜를 넣는다 */
export type AiCaller = (input: {
  system: string; user: string; maxTokens?: number; jsonOnly?: boolean;
}) => Promise<{ ok: boolean; provider: string; model: string; text: string | null; error?: string }>;

export interface AnalyzeResult {
  ok: boolean;
  hash: string;
  value: NewsAnalysisV2 | null;
  /** 사용자에게 보여줄 이유. 실패를 조용히 넘기지 않는다 */
  reason: string;
  /** 검증이 고친 항목. 모델 품질이 나빠지면 여기가 먼저 늘어난다 */
  repaired: string[];
}

const SYSTEM = [
  '너는 금융 뉴스 분석기다. 주어진 원문만 근거로 분석한다.',
  '원문에 없는 수치나 사실을 만들지 마라.',
  '확실하지 않으면 direction은 uncertain으로 한다.',
  '이것은 투자 조언이 아니라 분석이다.',
].join('\n');

/** 본문이 길면 자른다. 전부 보내면 비용이 커지고 지연도 늘어난다 */
const MAX_BODY = 4000;

export function buildPrompt(a: ArticleInput): string {
  const body = String(a.body ?? '').slice(0, MAX_BODY);
  return [
    `제목: ${a.title}`,
    a.source ? `출처: ${a.source}` : '',
    `발행: ${a.publishedAt}`,
    body ? `본문:\n${body}` : '(본문 없음 — 제목만으로 판단할 수 없으면 uncertain)',
    '',
    ANALYSIS_JSON_INSTRUCTION,
  ].filter(Boolean).join('\n');
}

export async function analyzeArticle(a: ArticleInput, call: AiCaller): Promise<AnalyzeResult> {
  const hash = contentHash({ url: a.url, title: a.title, publishedAt: a.publishedAt });

  // 원문이 없으면 부르지 않는다. 링크 없는 분석은 저장해도 확인할 수 없고,
  // 호출 비용만 나간다.
  if (!a.url || !a.title) {
    return { ok: false, hash, value: null, reason: '원문 URL이나 제목이 없어 분석하지 않았습니다', repaired: [] };
  }

  let r;
  try {
    r = await call({ system: SYSTEM, user: buildPrompt(a), maxTokens: 700, jsonOnly: true });
  } catch (e: any) {
    return { ok: false, hash, value: null, reason: `AI 호출 실패: ${e?.message || e}`, repaired: [] };
  }

  if (!r?.ok || !r.text) {
    return { ok: false, hash, value: null, reason: `AI 응답 없음: ${r?.error || '사유 미상'}`, repaired: [] };
  }

  const raw = extractJson(r.text);
  if (!raw) {
    // 여기서 억지로 텍스트를 파싱해 넘기지 않는다. 형식이 깨진 응답을
    // 통과시키면 화면에는 그럴듯한 빈 카드가 뜬다.
    return { ok: false, hash, value: null, reason: 'AI가 JSON 형식으로 답하지 않았습니다', repaired: [] };
  }

  const v = validateAnalysis(raw, {
    sourceUrl: a.url, publishedAt: a.publishedAt,
    provider: r.provider, model: r.model,
  });

  return {
    ok: v.ok, hash, value: v.value,
    reason: v.ok ? '' : `검증 실패: ${v.errors.join(', ')}`,
    repaired: v.repaired,
  };
}

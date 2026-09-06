// src/lib/news/sources.ts
// 뉴스 출처별 신뢰도 가중치 + 영향도 점수 계산
//
// 신뢰도(reliability) 0-100:
//   1차 통신사 / 메이저 매체: 90~100
//   2차 미디어 / 블로그: 50~80
//   포럼 / 트위터: 20~50
//   알 수 없는 출처: 40 (기본)
//
// 영향도(impact) = 출처 신뢰도 × 최신성 × 영향 자산 수
// **모델 자기평가 confidence는 들어가지 않는다** — CalcInput 주석 참고

export type SourceTier = 'tier1' | 'tier2' | 'tier3' | 'unknown';

interface SourceInfo {
  tier:        SourceTier;
  reliability: number;        // 0~100
  label:       string;        // 한글 표시명
}

// 주요 출처 (대소문자 무관, 부분 매칭)
const SOURCE_RULES: { match: RegExp; info: SourceInfo }[] = [
  // Tier 1 — 통신사 / 메이저 금융 매체 (90-100)
  { match: /reuters|로이터/i,                  info: { tier: 'tier1', reliability: 98, label: '로이터' } },
  { match: /bloomberg|블룸버그/i,              info: { tier: 'tier1', reliability: 96, label: '블룸버그' } },
  { match: /associated press|^ap$|ap뉴스/i,    info: { tier: 'tier1', reliability: 96, label: 'AP' } },
  { match: /wall street journal|wsj/i,         info: { tier: 'tier1', reliability: 94, label: 'WSJ' } },
  { match: /financial times|^ft$|ft.com/i,     info: { tier: 'tier1', reliability: 94, label: 'FT' } },
  { match: /cnbc/i,                            info: { tier: 'tier1', reliability: 88, label: 'CNBC' } },
  { match: /yonhap|연합뉴스/i,                  info: { tier: 'tier1', reliability: 92, label: '연합뉴스' } },
  // Tier 2 — 신뢰할 만한 매체 (70-89)
  { match: /coindesk/i,                        info: { tier: 'tier2', reliability: 82, label: 'CoinDesk' } },
  { match: /cointelegraph/i,                   info: { tier: 'tier2', reliability: 78, label: 'CoinTelegraph' } },
  { match: /the block/i,                       info: { tier: 'tier2', reliability: 80, label: 'The Block' } },
  { match: /investing.com/i,                   info: { tier: 'tier2', reliability: 75, label: 'Investing.com' } },
  { match: /marketwatch/i,                     info: { tier: 'tier2', reliability: 78, label: 'MarketWatch' } },
  { match: /yahoo finance/i,                   info: { tier: 'tier2', reliability: 74, label: 'Yahoo Finance' } },
  { match: /seeking alpha/i,                   info: { tier: 'tier2', reliability: 70, label: 'Seeking Alpha' } },
  { match: /benzinga/i,                        info: { tier: 'tier2', reliability: 68, label: 'Benzinga' } },
  { match: /tossinvest|토스증권/i,             info: { tier: 'tier2', reliability: 76, label: '토스증권' } },
  { match: /naver|네이버/i,                    info: { tier: 'tier2', reliability: 70, label: '네이버' } },
  { match: /hankyung|한국경제|한경/i,          info: { tier: 'tier2', reliability: 80, label: '한국경제' } },
  { match: /chosun|조선/i,                     info: { tier: 'tier2', reliability: 78, label: '조선일보' } },
  { match: /joongang|중앙/i,                   info: { tier: 'tier2', reliability: 78, label: '중앙일보' } },
  // Tier 3 — 블로그 / 소셜 (40-65)
  { match: /reddit/i,                          info: { tier: 'tier3', reliability: 45, label: 'Reddit' } },
  { match: /twitter|x\.com|트위터/i,           info: { tier: 'tier3', reliability: 50, label: 'Twitter/X' } },
  { match: /medium/i,                          info: { tier: 'tier3', reliability: 55, label: 'Medium' } },
  { match: /substack/i,                        info: { tier: 'tier3', reliability: 60, label: 'Substack' } },
];

export function getSourceInfo(sourceName: string | undefined): SourceInfo {
  if (!sourceName) return { tier: 'unknown', reliability: 40, label: '알 수 없음' };
  for (const rule of SOURCE_RULES) {
    if (rule.match.test(sourceName)) return rule.info;
  }
  return { tier: 'unknown', reliability: 50, label: sourceName.slice(0, 20) };
}

export const TIER_COLOR: Record<SourceTier, string> = {
  tier1:   '#10B981',
  tier2:   '#60A5FA',
  tier3:   '#F59E0B',
  unknown: 'var(--t-sub)',
};

export const TIER_LABEL: Record<SourceTier, string> = {
  tier1:   '1차 매체',
  tier2:   '신뢰 매체',
  tier3:   '소셜',
  unknown: '미확인',
};

// ─── 영향도 점수 계산 ────────────────────────────────────────
// 0~100 — 사용자에게 뉴스가 얼마나 강하게 영향 줄지
export interface ImpactScore {
  total:       number;          // 0~100 종합
  sentiment:   number;          // 0~50 (방향 강도)
  reliability: number;          // 0~25 (출처 신뢰)
  recency:     number;          // 0~25 (시간 감쇠)
  reasoning:   string[];        // 사람이 읽을 수 있는 이유
}

/**
 * 영향도 입력.
 *
 * **모델이 스스로 매긴 확신도(confidence)는 여기 들어오지 않는다.**
 *
 * 두 번 고쳤다. 처음에는 `confidence ?? 50`이었다 — 모델이 답하지
 * 않았는데 50%가 관측된 것처럼 점수에 들어갔다. 그 다음에는 관측된
 * 값만 쓰게 고쳤는데, 그래도 **보정되지 않은 자기평가 숫자가 사람을
 * 깨우는 판단에 들어간다**는 문제가 그대로 남았다.
 *
 * 72%는 과거 적중률로 보정된 값이 아니라 모델이 스스로 적은 숫자다.
 * 화면에서 %를 지운 이유가 그것인데, 화면에서만 지우고 알림 점수에는
 * 그대로 쓰면 "표시만 안 할 뿐 여전히 그 숫자가 사람을 깨운다"가 된다.
 *
 * 그래서 타입에서 아예 없앴다. 새 공식을 만들지 않는다 — 보정된 지표가
 * 생기기 전까지 영향도는 **관측 가능한 것만** 쓴다: 출처 신뢰도 ·
 * 최신성 · 영향 자산 수. 방향이 있는지 없는지는 점수가 아니라
 * `matcher`의 관문에서 본다.
 */
interface CalcInput {
  sourceName?:  string;
  prediction?:  'up' | 'down' | 'flat';
  publishedAt?: number;         // ms timestamp
  numAffectedAssets?: number;
}

/**
 * 방향 항목의 고정 몫.
 *
 * 예전에 `(confidence/100) * 50`이던 자리다. 새 공식을 만들지 않으려고
 * **이미 코드에 있던 하한값**을 그대로 상수로 둔다 — 확신도를 관측하지
 * 못했을 때 주던 값이 10이었다. 올리려면 근거(보정된 적중률)가 먼저다.
 */
const DIRECTION_POINTS = 10;

export function calculateImpact(input: CalcInput): ImpactScore {
  const reasons: string[] = [];

  // 1) 방향 — **강도를 매기지 않는다.**
  //
  // 여기가 모델 confidence를 최대 50점으로 환산하던 자리다. 방향이 있다는
  // 사실과 그 방향을 얼마나 믿을 만한지는 다른 문제이고, 후자는 지금
  // 보정된 값이 없다. 그래서 방향은 점수 크기에 영향을 주지 않는다.
  // 실제 관문(uncertain은 알리지 않는다)은 matcher에 있다.
  const directional = input.prediction === 'up' || input.prediction === 'down';
  const sentimentScore = DIRECTION_POINTS;
  reasons.push(directional
    ? `예측 ${input.prediction === 'up' ? '상승' : '하락'} — 강도는 매기지 않음(보정된 지표 없음)`
    : '방향성 약함 (보합)');

  // 2) 출처 신뢰도
  const src = getSourceInfo(input.sourceName);
  const reliabilityScore = (src.reliability / 100) * 25;
  reasons.push(`출처 ${src.label} 신뢰도 ${src.reliability}점`);

  // 3) 최근성 — 24시간 내 100%, 1주일 0%
  let recencyScore = 0;
  if (input.publishedAt) {
    const ageHours = (Date.now() - input.publishedAt) / (1000 * 60 * 60);
    if (ageHours < 1)         recencyScore = 25;
    else if (ageHours < 6)    recencyScore = 22;
    else if (ageHours < 24)   recencyScore = 18;
    else if (ageHours < 72)   recencyScore = 12;
    else if (ageHours < 168)  recencyScore = 6;
    else                      recencyScore = 2;
    if (ageHours < 24)        reasons.push('최신 (24시간 이내)');
    else if (ageHours < 72)   reasons.push('비교적 최신 (3일 이내)');
    else                      reasons.push('오래된 뉴스 (영향 약화)');
  } else {
    recencyScore = 10;
  }

  // 4) 영향 자산 수 — 많을수록 임팩트 (보정)
  const numAssets = input.numAffectedAssets ?? 0;
  let assetBonus = 0;
  if (numAssets >= 3) {
    assetBonus = 5;
    reasons.push(`다수 자산 영향 (${numAssets}개)`);
  }

  const total = Math.max(0, Math.min(100,
    Math.round(sentimentScore + reliabilityScore + recencyScore + assetBonus)
  ));

  return { total, sentiment: Math.round(sentimentScore), reliability: Math.round(reliabilityScore), recency: Math.round(recencyScore), reasoning: reasons };
}

// 영향도 등급
export type ImpactLevel = 'high' | 'medium' | 'low' | 'minimal';

export function impactLevel(score: number): { level: ImpactLevel; label: string; color: string } {
  if (score >= 70) return { level: 'high',    label: '강함',  color: '#EF4444' };
  if (score >= 50) return { level: 'medium',  label: '보통',  color: '#F59E0B' };
  if (score >= 30) return { level: 'low',     label: '약함',  color: '#60A5FA' };
  return            { level: 'minimal', label: '미미',  color: 'var(--t-sub)' };
}

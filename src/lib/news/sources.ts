// src/lib/news/sources.ts
// 뉴스 출처별 신뢰도 가중치 + 영향도 점수 계산
//
// 신뢰도(reliability) 0-100:
//   1차 통신사 / 메이저 매체: 90~100
//   2차 미디어 / 블로그: 50~80
//   포럼 / 트위터: 20~50
//   알 수 없는 출처: 40 (기본)
//
// 영향도(impact) = sentiment 강도 × confidence × reliability_factor × time_decay

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
  unknown: '#94A3B8',
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

interface CalcInput {
  sourceName?:  string;
  prediction?:  'up' | 'down' | 'flat';
  confidence?:  number;         // 0~100
  publishedAt?: number;         // ms timestamp
  numAffectedAssets?: number;
}

export function calculateImpact(input: CalcInput): ImpactScore {
  const reasons: string[] = [];

  // 1) sentiment 강도 — flat이면 작음
  const conf = Math.max(0, Math.min(100, input.confidence ?? 50));
  let sentimentScore = 0;
  if (input.prediction === 'up' || input.prediction === 'down') {
    sentimentScore = (conf / 100) * 50;
    reasons.push(`예측 ${input.prediction === 'up' ? '상승' : '하락'} (신뢰도 ${conf}%)`);
  } else {
    sentimentScore = 10;
    reasons.push('방향성 약함 (보합)');
  }

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
  return            { level: 'minimal', label: '미미',  color: '#94A3B8' };
}

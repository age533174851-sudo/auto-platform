// ─────────────────────────────────────────────────────────────
// TRAIGO — Mock News Analyzer
// OpenAI 키가 없거나 호출 실패 시 fallback
// 결정적: 같은 입력 → 같은 출력 (해시 기반)
// ─────────────────────────────────────────────────────────────

import type { NewsAnalysis, NewsPrediction, NewsSentiment } from './types';

// 간단한 결정적 해시 (id에서 confidence 등을 안정적으로 뽑기 위해)
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ── 감성/방향 키워드 사전 ─────────────────────────────────
const BULLISH_KW = [
  'surge', 'soar', 'jump', 'rally', 'rise', 'gain', 'climb', 'boost', 'rebound', 'breakthrough',
  'record', 'high', 'beat', 'outperform', 'upgrade', 'approval', 'green light', 'positive', 'optimistic',
  'inflow', 'buy', 'bullish', 'recovery', 'expand', 'partnership', 'launch', 'milestone',
  '상승', '급등', '돌파', '호조', '강세', '매수', '회복', '확대', '승인', '신고가',
];

const BEARISH_KW = [
  'fall', 'drop', 'plunge', 'crash', 'tumble', 'slump', 'decline', 'loss', 'lose', 'sink',
  'sell-off', 'selloff', 'bearish', 'downgrade', 'miss', 'underperform', 'weak', 'concern', 'worry', 'fear',
  'outflow', 'lawsuit', 'investigation', 'fine', 'sanction', 'recall', 'layoff', 'cut',
  '하락', '급락', '폭락', '약세', '매도', '우려', '경고', '제재', '하향', '감소',
];

const MACRO_KW: Record<string, NewsPrediction> = {
  'rate cut':       'up',
  'rate hike':      'down',
  'rate hold':      'flat',
  '금리 인하':       'up',
  '금리 인상':       'down',
  '금리 동결':       'flat',
  'recession':      'down',
  '경기 침체':       'down',
  'inflation':      'down',
  '인플레이션':      'down',
  'cpi rises':      'down',
  'cpi falls':      'up',
};

// 자산 추출 키워드
const ASSET_KEYWORDS: { keywords: string[]; symbol: string; dirOnBullish: NewsPrediction; dirOnBearish: NewsPrediction }[] = [
  { keywords: ['bitcoin', 'btc', '비트코인'],         symbol: 'BTC',  dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['ethereum', 'eth', '이더리움'],         symbol: 'ETH',  dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['solana', 'sol', '솔라나'],             symbol: 'SOL',  dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['nvidia', 'nvda', '엔비디아'],          symbol: 'NVDA', dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['tesla', 'tsla', '테슬라'],             symbol: 'TSLA', dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['apple', 'aapl', '애플'],               symbol: 'AAPL', dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['microsoft', 'msft', '마이크로소프트'], symbol: 'MSFT', dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['google', 'googl', 'alphabet', '구글'], symbol: 'GOOGL',dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['amazon', 'amzn', '아마존'],            symbol: 'AMZN', dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['meta', 'facebook', '메타'],            symbol: 'META', dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['ferrari', '페라리'],                   symbol: 'RACE', dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['samsung', '삼성전자'],                 symbol: '005930', dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['s&p 500', 'sp500', 's&p500', '에스앤피'], symbol: 'VOO', dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['nasdaq', '나스닥'],                   symbol: 'QQQ',  dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['gold', '금'],                          symbol: 'GOLD', dirOnBullish: 'up', dirOnBearish: 'down' },
  { keywords: ['fed', 'federal reserve', '연준'],      symbol: 'QQQ',  dirOnBullish: 'up', dirOnBearish: 'down' },
];

// ── 영어 → 한글 번역 (단순 매핑, 실제 번역은 OpenAI에서) ──
const QUICK_TRANSLATE: { from: RegExp; to: string }[] = [
  { from: /shares fall (\d+)%?/i,      to: '주가 $1% 하락' },
  { from: /shares jump (\d+)%?/i,      to: '주가 $1% 급등' },
  { from: /shares rise (\d+)%?/i,      to: '주가 $1% 상승' },
  { from: /shares drop (\d+)%?/i,      to: '주가 $1% 급락' },
  { from: /stock falls (\d+)%?/i,      to: '주가 $1% 하락' },
  { from: /stock soars/i,              to: '주가 급등' },
  { from: /reports earnings/i,         to: '실적 발표' },
  { from: /beats expectations/i,       to: '시장 기대치 상회' },
  { from: /misses expectations/i,      to: '시장 기대치 하회' },
  { from: /electric vehicle/i,         to: '전기차' },
  { from: /\bev\b/i,                    to: '전기차' },
  { from: /\bipo\b/i,                   to: 'IPO' },
  { from: /\bfed\b/i,                   to: '연준' },
  { from: /interest rate/i,             to: '금리' },
  { from: /rate cut/i,                  to: '금리 인하' },
  { from: /rate hike/i,                 to: '금리 인상' },
  { from: /inflation/i,                 to: '인플레이션' },
  { from: /recession/i,                 to: '경기 침체' },
  { from: /\bcpi\b/i,                   to: 'CPI' },
  { from: /\bsec\b/i,                   to: 'SEC' },
  { from: /\betf\b/i,                   to: 'ETF' },
  { from: /\bai\b/i,                    to: 'AI' },
  { from: /artificial intelligence/i,   to: '인공지능' },
  { from: /lawsuit/i,                   to: '소송' },
  { from: /investigation/i,             to: '조사' },
  { from: /partnership/i,               to: '파트너십' },
  { from: /acquisition/i,               to: '인수' },
  { from: /merger/i,                    to: '합병' },
  { from: /investor/i,                  to: '투자자' },
  { from: /\bafter\b/i,                 to: '이후' },
  { from: /following/i,                 to: '이후' },
  { from: /due to/i,                    to: ' 영향으로' },
];

function quickTranslate(text: string): string {
  if (!text) return text;
  let out = text;
  for (const r of QUICK_TRANSLATE) out = out.replace(r.from, r.to);
  return out;
}

// 한글이 충분히 들어있으면 번역 안 함 (이미 한국어 기사인 경우)
function isLikelyKorean(text: string): boolean {
  if (!text) return false;
  const matches = text.match(/[가-힣]/g);
  return !!matches && matches.length >= Math.min(6, Math.floor(text.length * 0.2));
}

// ── 메인 분석 함수 ────────────────────────────────────────
export function mockAnalyze(item: { id: string; title: string; summary?: string; tickers?: string[]; category?: string }): NewsAnalysis {
  const titleLow = item.title.toLowerCase();
  const summaryLow = (item.summary || '').toLowerCase();
  const combined = titleLow + ' ' + summaryLow;

  // 1) sentiment 계산 — 키워드 카운트
  let bullScore = 0;
  let bearScore = 0;
  for (const kw of BULLISH_KW) if (combined.includes(kw.toLowerCase())) bullScore++;
  for (const kw of BEARISH_KW) if (combined.includes(kw.toLowerCase())) bearScore++;

  // 2) 매크로 키워드 우선 처리
  let prediction: NewsPrediction = 'flat';
  for (const [kw, dir] of Object.entries(MACRO_KW)) {
    if (combined.includes(kw)) { prediction = dir; break; }
  }
  if (prediction === 'flat') {
    if (bullScore > bearScore)      prediction = 'up';
    else if (bearScore > bullScore) prediction = 'down';
    else                            prediction = 'flat';
  }

  // 3) confidence — 키워드 개수와 차이 기반 (45~88 사이로)
  const diff = Math.abs(bullScore - bearScore);
  const totalSignals = bullScore + bearScore;
  let confidence = 50 + diff * 8 + Math.min(15, totalSignals * 2);
  // 결정성 위해 id 해시로 ±5 변동
  const h = hash(item.id || item.title);
  confidence += (h % 11) - 5;
  confidence = Math.max(45, Math.min(88, Math.round(confidence)));
  // 매크로 키워드면 신뢰도 조금 올림
  if (Object.keys(MACRO_KW).some(kw => combined.includes(kw))) {
    confidence = Math.min(90, confidence + 8);
  }

  // 4) reasons (2~3개 자동 추출)
  const reasons: string[] = [];
  if (combined.includes('earnings') || combined.includes('실적')) reasons.push('기업 실적 발표');
  if (combined.includes('etf') && combined.includes('flow')) reasons.push('ETF 자금 흐름');
  if (combined.includes('rate') || combined.includes('금리')) reasons.push('금리 환경 변화');
  if (combined.includes('partnership') || combined.includes('파트너십')) reasons.push('전략적 제휴');
  if (combined.includes('lawsuit') || combined.includes('investigation')) reasons.push('법적 리스크 부각');
  if (combined.includes('launch') || combined.includes('출시')) reasons.push('신제품/서비스 출시');
  if (combined.includes('layoff') || combined.includes('cut')) reasons.push('비용 절감/구조조정');
  if (combined.includes('institutional') || combined.includes('기관')) reasons.push('기관 자금 동향');

  // sentiment 기반 보강
  if (prediction === 'up' && reasons.length < 2) {
    reasons.push('투자 심리 개선');
    if (totalSignals >= 2) reasons.push('긍정적 시장 신호 다수');
  } else if (prediction === 'down' && reasons.length < 2) {
    reasons.push('투자 심리 위축');
    if (totalSignals >= 2) reasons.push('하방 압력 시그널 증가');
  } else if (prediction === 'flat' && reasons.length === 0) {
    reasons.push('명확한 방향성 부재');
    reasons.push('관망세 지속 가능성');
  }

  // 5) affected assets
  const affectedAssets: NewsAnalysis['affectedAssets'] = [];
  const seen = new Set<string>();

  // 명시적 tickers 먼저
  if (Array.isArray(item.tickers)) {
    for (const t of item.tickers) {
      if (seen.has(t)) continue;
      seen.add(t);
      affectedAssets.push({ symbol: t, direction: prediction });
    }
  }
  // 키워드 매칭 보강
  for (const a of ASSET_KEYWORDS) {
    if (seen.has(a.symbol)) continue;
    if (a.keywords.some(kw => combined.includes(kw))) {
      const dir: NewsPrediction = prediction === 'up' ? a.dirOnBullish : prediction === 'down' ? a.dirOnBearish : 'flat';
      affectedAssets.push({ symbol: a.symbol, direction: dir });
      seen.add(a.symbol);
    }
  }

  // 6) 한글 번역 (이미 한국어면 그대로)
  const titleKo = isLikelyKorean(item.title) ? item.title : quickTranslate(item.title);
  const summarySource = item.summary || '';
  const summaryKo = isLikelyKorean(summarySource)
    ? summarySource
    : summarySource ? quickTranslate(summarySource).slice(0, 140) : '';

  // sentiment ↔ prediction 일관성
  const sentiment: NewsSentiment = prediction === 'up' ? 'bullish' : prediction === 'down' ? 'bearish' : 'neutral';
  void sentiment;

  return {
    titleKo,
    summaryKo: summaryKo || titleKo, // summary가 없으면 제목으로
    prediction,
    confidence,
    reasons: reasons.slice(0, 4),
    affectedAssets: affectedAssets.slice(0, 5),
    source: 'mock',
    analyzedAt: Date.now(),
  };
}

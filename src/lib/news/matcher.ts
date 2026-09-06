// src/lib/news/matcher.ts
// 분석된 뉴스가 사용자의 관심종목/포트폴리오 자산을 언급하면 매칭
// 강한 영향도 + 매칭 시 알림 후보로 처리
//
// 어떤 분석을 받는가 — **정본 하나뿐이다**
// ────────────────────────────────────────
// 예전에는 브라우저가 화면을 열 때마다 만든 `NewsAnalysis`를 받았다. 그
// 경로는 OpenAI 호출이 실패하면 키워드와 id 해시로 prediction·confidence를
// **지어내서** 채웠고, 그 값이 그대로 여기 들어와 영향도 60점을 넘기면
// 브라우저 알림이 나갔다. 근거가 없는 숫자로 사람을 깨우는 셈이었다.
//
// 이제 저장된 분석(`news_articles` ← `analyzeOne`)만 받는다. 그 경로는
// 원문만 근거로 쓰고, 실패하면 값을 만들지 않고 실패로 남는다.
import { calculateImpact, impactLevel } from './sources';

/**
 * 매칭에 필요한 만큼의 분석. `/api/news/stored`가 돌려주는 모양이다.
 *
 * 여기에 legacy `NewsAnalysis`를 다시 붙이지 않는다 — 정본이 둘이 되면
 * 그중 하나는 언젠가 다시 지어낸 값을 나른다.
 */
export interface MatchAnalysis {
  /** bullish · bearish · neutral · uncertain. 모르면 null */
  direction: string | null;
  /** 모델이 답하지 않았으면 null. **숫자를 만들지 않는다** */
  confidence: number | null;
  /** 심볼 목록 */
  affectedAssets?: string[] | null;
}

/** 저장된 방향을 영향도 계산이 아는 말로. uncertain은 방향이 아니다 */
const PREDICTION_OF: Record<string, 'up' | 'down' | 'flat'> = {
  bullish: 'up', bearish: 'down', neutral: 'flat',
};

const SEEN_KEY = 'tg_news_seen_v1';     // 이미 본 뉴스 ID (중복 알림 방지)

// ─── 사용자 자산 목록 가져오기 ───────────────────────────
export function getUserAssets(): Set<string> {
  const out = new Set<string>();
  if (typeof window === 'undefined') return out;
  try {
    // 1) 관심종목 (개별)
    const watchRaw = window.localStorage.getItem('tg_watchlist_v2');
    if (watchRaw) {
      const arr = JSON.parse(watchRaw);
      if (Array.isArray(arr)) {
        for (const x of arr) {
          const sym = typeof x === 'string' ? x : (x?.sym || x?.id);
          if (sym) out.add(String(sym).toUpperCase());
        }
      }
    }
    // 2) 관심종목 그룹
    const groupsRaw = window.localStorage.getItem('tg_watch_groups_v1');
    if (groupsRaw) {
      const groups = JSON.parse(groupsRaw);
      if (Array.isArray(groups)) {
        for (const g of groups) {
          const items = g?.items;
          if (Array.isArray(items)) {
            for (const x of items) {
              const sym = typeof x === 'string' ? x : (x?.sym || x?.id);
              if (sym) out.add(String(sym).toUpperCase());
            }
          }
        }
      }
    }
    // 3) 포트폴리오
    const portRaw = window.localStorage.getItem('tg_portfolio_v1');
    if (portRaw) {
      const port = JSON.parse(portRaw);
      const positions = Array.isArray(port?.positions) ? port.positions : (Array.isArray(port) ? port : []);
      for (const p of positions) {
        const sym = p?.assetId || p?.sym || p?.symbol;
        if (sym) out.add(String(sym).toUpperCase());
      }
    }
  } catch {}
  return out;
}

// ─── 매칭 결과 ──────────────────────────────────────────
export interface NewsMatch {
  newsId:        string;
  matchedAssets: string[];
  impactScore:   number;
  impactLevel:   ReturnType<typeof impactLevel>;
  shouldNotify:  boolean;
  reason:        string;
}

// 뉴스 + 분석 → 매칭 결과
export function matchNews(
  newsId: string,
  analysis: MatchAnalysis | undefined,
  sourceName?: string,
  publishedAt?: number,
  userAssets?: Set<string>,
): NewsMatch | null {
  if (!analysis) return null;
  const assets = userAssets ?? getUserAssets();
  if (assets.size === 0) return null;

  // 분석에서 추출된 영향 자산 중 사용자 자산과 매칭
  const matched: string[] = [];
  for (const a of (analysis.affectedAssets || [])) {
    const sym = String(a || '').toUpperCase();
    if (!sym) continue;
    // 정확한 매치
    if (assets.has(sym)) { matched.push(sym); continue; }
    // BTC ↔ BTCUSDT 같은 매칭
    if (assets.has(sym.replace(/USDT$/, ''))) { matched.push(sym); continue; }
    if (assets.has(sym + 'USDT')) { matched.push(sym); continue; }
  }
  if (matched.length === 0) return null;

  // 방향. **모르는 값을 방향으로 바꾸지 않는다** — uncertain은 판단 보류다.
  const prediction = PREDICTION_OF[String(analysis.direction)];

  // 영향도 계산
  const impact = calculateImpact({
    sourceName,
    prediction,
    confidence: analysis.confidence,
    publishedAt,
    numAffectedAssets: analysis.affectedAssets?.length || 0,
  });
  const level = impactLevel(impact.total);

  // 알림 트리거.
  //
  // 점수만으로 정하지 않는다. 영향도는 출처 신뢰도와 최신성만으로도 60점을
  // 넘을 수 있어서(로이터 + 방금 나온 기사 + 다수 자산 = 64점), **확신도를
  // 관측하지 못한 분석도 알림을 낼 수 있었다.** 그래서 관측 조건을 따로 건다:
  //
  //   · 방향을 실제로 말했는가 (판단 보류로 사람을 깨우지 않는다)
  //   · 확신도를 실제로 관측했는가 (없는 값으로 깨우지 않는다)
  //   · 영향도가 문턱을 넘는가
  //   · 아직 안 본 뉴스인가
  const observedDirection = prediction === 'up' || prediction === 'down';
  const observedConfidence = typeof analysis.confidence === 'number'
    && Number.isFinite(analysis.confidence);
  const shouldNotify = observedDirection
    && observedConfidence
    && impact.total >= 60
    && !hasSeen(newsId);

  return {
    newsId,
    matchedAssets: matched,
    impactScore:   impact.total,
    impactLevel:   level,
    shouldNotify,
    reason:        `${matched.join(', ')} ${prediction === 'up' ? '상승' : prediction === 'down' ? '하락' : '영향'} 가능 (영향도 ${impact.total}점)`,
  };
}

// ─── 본 뉴스 추적 (중복 알림 방지) ───────────────────────
export function hasSeen(newsId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (!raw) return false;
    const set = new Set(JSON.parse(raw));
    return set.has(newsId);
  } catch { return false; }
}

export function markSeen(newsId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const arr: string[] = raw ? JSON.parse(raw) : [];
    if (arr.includes(newsId)) return;
    arr.push(newsId);
    // 최근 200개만 유지
    const next = arr.slice(-200);
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {}
}

// ─── 일괄 매칭 + 알림 후보 추출 ────────────────────────
export interface BatchMatchResult {
  matches:      NewsMatch[];
  notifications: NewsMatch[];        // shouldNotify=true만
}

export function batchMatchNews(
  items: Array<{ id: string; sourceName?: string; publishedAt?: number; analysis?: MatchAnalysis }>,
): BatchMatchResult {
  const userAssets = getUserAssets();
  const matches: NewsMatch[] = [];
  for (const it of items) {
    const m = matchNews(it.id, it.analysis, it.sourceName, it.publishedAt, userAssets);
    if (m) matches.push(m);
  }
  const notifications = matches.filter(m => m.shouldNotify);
  return { matches, notifications };
}

// ─── 브라우저 Notification 전송 ───────────────────────
export function triggerNotification(match: NewsMatch, title: string): boolean {
  if (typeof window === 'undefined') return false;
  if (!('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;
  try {
    new Notification(`📰 ${title.slice(0, 60)}`, {
      body: match.reason,
      icon: '/icon-192.png',
      tag: `news-${match.newsId}`,
    });
    markSeen(match.newsId);
    return true;
  } catch {
    return false;
  }
}

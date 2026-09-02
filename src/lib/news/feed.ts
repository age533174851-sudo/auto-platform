// src/lib/news/feed.ts
//
// **"최신 뉴스"라는 이름으로 만들어 둔 기사를 보여 주지 않는다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 홈과 데스크톱 오른쪽 레일이 `MOCK_NEWS` 상수를 그대로 그렸다. 제목은
// `최신 뉴스`였고, 그 안에는:
//
//   · 실제 매체명 (CoinDesk · Reuters · Bloomberg)
//   · 실제 주소 (coindesk.com)
//   · 구체적인 가격 ("비트코인 94,230,000원 돌파")
//   · "5분 전" — 언제 열어도 항상 5분 전
//
// 가 들어 있었다. 어디에도 예시라는 표시가 없었다. 정작 뉴스 화면은
// 진짜 API를 부르고 있어서, "더보기"를 누르면 내용이 달라졌다.
//
// 여기서 하는 일
// ──────────────
// 서버 라우트(`/api/news?action=latest`)는 이미 출처를 알려 준다 —
// 공급자에서 못 받으면 `source: 'mock'`으로 답한다. 그동안 화면이
// 그 필드를 **읽지 않았다.** 이 파일이 응답을 출처와 함께 정규화해서
// 돌려주고, 화면은 출처가 실물이 아닐 때 그 사실을 적는다.
//
// 왜 상수를 지우지 않고 이렇게 하나
// ─────────────────────────────────
// 라우트가 여전히 폴백으로 MOCK_NEWS를 돌려준다. 화면에서 상수만
// 지우면 같은 데이터가 서버를 거쳐 그대로 들어오고, 이번에는 출처가
// 'newsapi'가 아니라는 것조차 화면이 모른다. **읽는 쪽이 출처를 보게
// 만드는 것**이 고치는 것이다.

export type NewsProvenance =
  /** 공급자에서 실제로 받은 기사 */
  | 'LIVE'
  /** 서버가 폴백으로 돌려준 예시 기사 */
  | 'SAMPLE'
  /** 아직 못 읽었다 */
  | 'LOADING'
  /** 읽지 못했다 */
  | 'ERROR';

export interface FeedItem {
  id: string;
  title: string;
  source: string;
  time: string;
  category: string;
  sentiment: string;
  url?: string;
  summary?: string;
  content?: string;
  tickers?: string[];
}

export interface NewsFeed {
  provenance: NewsProvenance;
  items: FeedItem[];
  /** 화면에 그대로 적을 수 있는 사유 (LIVE면 빈 문자열) */
  note: string;
}

export const LOADING_FEED: NewsFeed = { provenance: 'LOADING', items: [], note: '뉴스를 불러오는 중입니다' };

/** 라우트가 알려 준 출처 문자열을 판정으로 바꾼다. */
export function provenanceOf(source: unknown): NewsProvenance {
  // **모르는 값을 실물로 읽지 않는다.** 새 공급자가 붙어 'newsapi'가
  // 아닌 이름을 보내면 그건 확인이 필요한 것이지 통과가 아니다.
  return source === 'newsapi' ? 'LIVE' : 'SAMPLE';
}

function str(v: unknown, fb = ''): string {
  return typeof v === 'string' && v ? v : fb;
}

/** 응답 한 줄을 화면이 쓸 수 있는 모양으로. 못 쓰는 줄은 버린다. */
export function normalizeItem(raw: unknown, i: number): FeedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const title = str(n.title);
  if (!title) return null;   // 제목 없는 기사는 화면에 그릴 것이 없다
  return {
    id: str(n.id) || `${str(n.source, 'src')}_${str(n.time, String(i))}_${title.slice(0, 20)}`,
    title,
    source: str(n.source),
    time: str(n.time),
    category: str(n.category, '뉴스'),
    sentiment: str(n.sentiment, 'neutral'),
    url: str(n.url) || undefined,
    summary: str(n.summary) || undefined,
    content: str(n.content) || undefined,
    tickers: Array.isArray(n.tickers) ? n.tickers.filter((t): t is string => typeof t === 'string') : [],
  };
}

/**
 * `/api/news` 응답을 출처와 함께 정규화한다.
 *
 * 응답을 못 읽었으면 **예시로 채우지 않는다.** 빈 목록 + ERROR를
 * 돌려주고, 화면은 "읽지 못했습니다"라고 적는다. 없는 것을 그럴듯한
 * 것으로 메우는 것이 이 파일이 없애려는 문제다.
 */
export function toFeed(json: unknown): NewsFeed {
  if (!json || typeof json !== 'object') {
    return { provenance: 'ERROR', items: [], note: '뉴스를 읽지 못했습니다' };
  }
  const j = json as Record<string, unknown>;
  const rawList = Array.isArray(j.news) ? j.news : null;
  if (!rawList) {
    return { provenance: 'ERROR', items: [], note: '뉴스를 읽지 못했습니다' };
  }
  const items = rawList.map(normalizeItem).filter((x): x is FeedItem => x !== null);
  if (items.length === 0) {
    return { provenance: 'ERROR', items: [], note: '받은 뉴스가 없습니다' };
  }
  const provenance = provenanceOf(j.source);
  return {
    provenance,
    items,
    note: provenance === 'LIVE'
      ? ''
      : '예시 기사입니다 — 뉴스 공급자에서 받지 못해 화면 확인용 자료를 보여 주고 있습니다',
  };
}

export function errorFeed(reason?: string): NewsFeed {
  return { provenance: 'ERROR', items: [], note: reason || '뉴스를 읽지 못했습니다' };
}

/**
 * 카드 제목.
 *
 * 실물일 때만 "최신 뉴스"라고 부른다. 예시를 그러고 있으면서 최신이라고
 * 적는 것이 원래 문제였다.
 */
export function feedTitle(p: NewsProvenance): string {
  switch (p) {
    case 'LIVE':    return '최신 뉴스';
    case 'SAMPLE':  return '뉴스 (예시)';
    case 'LOADING': return '뉴스';
    case 'ERROR':   return '뉴스';
  }
}

/** 제목 옆 배지. 실물이면 배지가 없다 — 정상 상태에 라벨을 붙이지 않는다. */
export function feedBadge(p: NewsProvenance): string {
  return p === 'SAMPLE' ? '예시' : '';
}

/**
 * 기사 한 줄에 붙일 시각 표시.
 *
 * 예시 기사에는 "5분 전"이 박혀 있다. 그것을 그대로 그리면 방금 들어온
 * 기사처럼 보인다. 예시일 때는 시각을 지운다.
 */
export function itemTime(p: NewsProvenance, time: string): string {
  return p === 'LIVE' ? time : '';
}

/**
 * 기사 출처(매체명) 표시.
 *
 * 예시인데 CoinDesk라고 적으면 그 매체가 실제로 낸 기사처럼 읽힌다.
 */
export function itemSource(p: NewsProvenance, source: string): string {
  return p === 'LIVE' ? source : '';
}

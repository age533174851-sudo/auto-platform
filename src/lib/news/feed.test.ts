// src/lib/news/feed.test.ts
//
// 이 테스트가 막는 것: **만들어 둔 기사를 "최신 뉴스"라고 부르는 것.**
//
// 홈과 오른쪽 레일이 MOCK_NEWS를 그대로 그리면서 제목은 `최신 뉴스`,
// 매체는 CoinDesk, 시각은 "5분 전"이라고 적고 있었다. 라우트는 이미
// `source: 'mock'`으로 알려 주고 있었는데 화면이 그 필드를 안 봤다.

import { test, eq, assert } from '../../test/harness';
import {
  provenanceOf, normalizeItem, toFeed, errorFeed,
  feedTitle, feedBadge, itemTime, itemSource, LOADING_FEED,
} from './feed';

const live = (n = 2) => ({
  source: 'newsapi',
  news: Array.from({ length: n }, (_, i) => ({
    id: `x${i}`, title: `기사 ${i}`, source: 'Reuters', time: '3분 전',
    category: '코인', sentiment: 'bullish', url: 'https://example.com',
  })),
});

export function runNewsFeedTests() {
  console.log('[뉴스 출처 — 예시를 최신이라고 부르지 않는다]');

  // ── 출처 판정 ─────────────────────────────────────────────
  test('공급자에서 받은 것만 실물이다', () => {
    eq(provenanceOf('newsapi'), 'LIVE');
    eq(provenanceOf('mock'), 'SAMPLE');
  });

  test('모르는 출처를 실물로 읽지 않는다', () => {
    // 새 공급자가 붙어 다른 이름이 오면 확인이 필요한 것이지 통과가 아니다.
    eq(provenanceOf('someNewProvider'), 'SAMPLE');
    eq(provenanceOf(undefined), 'SAMPLE');
    eq(provenanceOf(null), 'SAMPLE');
    eq(provenanceOf(1 as any), 'SAMPLE');
  });

  // ── 제목·배지 ─────────────────────────────────────────────
  test('실물일 때만 "최신 뉴스"라고 부른다', () => {
    eq(feedTitle('LIVE'), '최신 뉴스');
    assert(!feedTitle('SAMPLE').includes('최신'), `예시인데 최신이라 부른다: ${feedTitle('SAMPLE')}`);
    assert(!feedTitle('ERROR').includes('최신'), `못 읽었는데 최신이라 부른다: ${feedTitle('ERROR')}`);
    assert(!feedTitle('LOADING').includes('최신'), '읽는 중인데 최신이라 부른다');
  });

  test('예시에는 배지가 붙고, 정상 상태에는 안 붙는다', () => {
    eq(feedBadge('SAMPLE'), '예시');
    eq(feedBadge('LIVE'), '');
    // 정상인 것에 라벨을 붙이면 라벨이 의미를 잃는다
    eq(feedBadge('LOADING'), '');
  });

  // ── 시각·매체 가리기 ──────────────────────────────────────
  test('예시 기사의 "5분 전"을 그리지 않는다', () => {
    // 언제 열어도 5분 전이라 방금 들어온 기사처럼 보인다.
    eq(itemTime('LIVE', '3분 전'), '3분 전');
    eq(itemTime('SAMPLE', '5분 전'), '');
    eq(itemTime('ERROR', '5분 전'), '');
  });

  test('예시 기사에 실제 매체명을 적지 않는다', () => {
    eq(itemSource('LIVE', 'Reuters'), 'Reuters');
    eq(itemSource('SAMPLE', 'CoinDesk'), '');
  });

  // ── 정규화 ────────────────────────────────────────────────
  test('제목 없는 줄은 버린다', () => {
    eq(normalizeItem({ source: 'x' }, 0), null);
    eq(normalizeItem(null, 0), null);
    eq(normalizeItem('기사', 0), null);
    assert(normalizeItem({ title: '있음' }, 0) !== null, '제목 있는 줄을 버렸다');
  });

  test('id가 없으면 만들어 준다 — 키 없는 목록은 리액트가 잘못 그린다', () => {
    const a = normalizeItem({ title: '가', source: 'R', time: '1분 전' }, 0)!;
    const b = normalizeItem({ title: '나', source: 'R', time: '2분 전' }, 1)!;
    assert(!!a.id && !!b.id, 'id가 비었다');
    assert(a.id !== b.id, 'id가 겹친다');
  });

  test('tickers가 배열이 아니면 빈 배열이다', () => {
    eq(normalizeItem({ title: '가', tickers: 'BTC' }, 0)!.tickers!.length, 0);
    eq(normalizeItem({ title: '가', tickers: ['BTC', 1, 'ETH'] }, 0)!.tickers!.join(','), 'BTC,ETH');
  });

  // ── 응답 → 피드 ───────────────────────────────────────────
  test('실물 응답은 그대로 실물이다', () => {
    const f = toFeed(live(3));
    eq(f.provenance, 'LIVE');
    eq(f.items.length, 3);
    eq(f.note, '');
  });

  test('서버가 mock이라고 답하면 예시로 표시한다', () => {
    const f = toFeed({ source: 'mock', news: [{ title: '가', source: 'CoinDesk', time: '5분 전' }] });
    eq(f.provenance, 'SAMPLE');
    assert(f.note.includes('예시'), `예시라고 말하지 않는다: ${f.note}`);
  });

  test('못 읽었으면 예시로 채우지 않는다', () => {
    // 없는 것을 그럴듯한 것으로 메우는 것이 이 파일이 없애려는 문제다.
    for (const bad of [null, undefined, {}, { news: null }, 'oops', { news: {} }]) {
      const f = toFeed(bad as any);
      eq(f.provenance, 'ERROR');
      eq(f.items.length, 0);
      assert(f.note.length > 0, '왜 비었는지 말하지 않는다');
    }
  });

  test('제목 있는 기사가 하나도 없으면 ERROR다 — 빈 카드를 그리지 않는다', () => {
    const f = toFeed({ source: 'newsapi', news: [{ source: 'R' }, {}] });
    eq(f.provenance, 'ERROR');
    eq(f.items.length, 0);
  });

  test('읽는 중과 못 읽음을 구분한다', () => {
    eq(LOADING_FEED.provenance, 'LOADING');
    eq(LOADING_FEED.items.length, 0);
    eq(errorFeed().provenance, 'ERROR');
    assert(errorFeed('타임아웃').note.includes('타임아웃'), '사유를 안 남긴다');
  });

  test('어떤 상태에서도 예시를 최신이라 부르지 않는다', () => {
    for (const p of ['LIVE', 'SAMPLE', 'LOADING', 'ERROR'] as const) {
      if (p === 'LIVE') continue;
      const text = feedTitle(p) + ' ' + feedBadge(p);
      assert(!text.includes('최신'), `${p}에서 최신이라 말한다: ${text}`);
    }
  });
}

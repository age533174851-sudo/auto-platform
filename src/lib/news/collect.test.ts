// src/lib/news/collect.test.ts
//
// 막으려는 사고:
//  1. 유닉스 초를 밀리초로 읽어 기사가 1970년으로 밀리는 것 — 목록에서는
//     그냥 이상한 날짜로만 보인다
//  2. 같은 기사가 여러 공급자에서 와서 AI를 세 번 부르는 것 — 비용이 곱해진다
//  3. 중복을 걷을 때 본문 있는 판본을 제목만 있는 판본이 덮는 것
//  4. 원문 링크가 없는 기사를 저장해 확인할 수 없는 목록을 만드는 것
import { test, assert, eq } from '../../test/harness';
import { toIso, normalizeArticle, dedupe, collectFrom, onlyNew } from './collect';

const ok = {
  title: 'Bitcoin ETF inflows hit record',
  url: 'https://news.example/btc',
  publishedAt: '2026-07-28T00:00:00Z',
  description: '기관 자금 유입',
  source: { name: 'Reuters' },
};

export function runCollectTests() {
  console.log('[뉴스 수집 — 시각 파싱]');

  test('유닉스 초를 밀리초로 오해하지 않는다', () => {
    // 1769558400 = 2026-01-28. 밀리초로 읽으면 1970년이 된다.
    const iso = toIso(1769558400);
    assert(iso!.startsWith('2026-'), `1970년으로 밀렸다: ${iso}`);
  });

  test('유닉스 밀리초도 받는다', () => {
    const iso = toIso(1769558400000);
    assert(iso!.startsWith('2026-'), String(iso));
  });

  test('초와 밀리초가 같은 시각을 가리킨다', () => {
    eq(toIso(1769558400), toIso(1769558400000));
  });

  test('ISO 문자열은 그대로', () => {
    eq(toIso('2026-07-28T00:00:00Z'), '2026-07-28T00:00:00.000Z');
  });

  test('숫자 문자열도 유닉스로 읽는다', () => {
    eq(toIso('1769558400'), toIso(1769558400));
  });

  test('알아볼 수 없으면 null', () => {
    eq(toIso('어제'), null);
    eq(toIso(null), null);
    eq(toIso(''), null);
    eq(toIso(0), null);
    eq(toIso(-5), null);
  });

  console.log('[뉴스 수집 — 정규화]');

  test('표준 모양으로 바꾼다', () => {
    const n = normalizeArticle(ok, 'newsapi')!;
    eq(n.title, ok.title);
    eq(n.url, ok.url);
    eq(n.source, 'Reuters', '중첩된 source.name을 읽어야 한다');
    eq(n.provider, 'newsapi');
    assert(n.hash.length === 16, n.hash);
  });

  test('공급자마다 다른 필드 이름을 받는다', () => {
    const finnhub = normalizeArticle(
      { headline: 'T', url: 'https://a.com/1', datetime: 1769558400, summary: 'S' }, 'finnhub')!;
    eq(finnhub.title, 'T');
    assert(finnhub.body.length > 0);
    const fmp = normalizeArticle(
      { title: 'T2', link: 'https://a.com/2', date: '2026-07-28', text: 'X' }, 'fmp')!;
    eq(fmp.url, 'https://a.com/2');
  });

  test('원문 링크가 없으면 버린다', () => {
    // 확인할 수 없는 기사를 저장하면 목록만 늘고 신뢰는 준다
    eq(normalizeArticle({ ...ok, url: '' }, 'x'), null);
    eq(normalizeArticle({ ...ok, url: '/relative/path' }, 'x'), null);
    eq(normalizeArticle({ ...ok, url: 'javascript:alert(1)' }, 'x'), null);
  });

  test('제목이나 시각이 없으면 버린다', () => {
    eq(normalizeArticle({ ...ok, title: '' }, 'x'), null);
    eq(normalizeArticle({ ...ok, publishedAt: '어제쯤' }, 'x'), null);
  });

  test('객체가 아니면 버린다', () => {
    eq(normalizeArticle(null as any, 'x'), null);
    eq(normalizeArticle('문자열' as any, 'x'), null);
  });

  console.log('[뉴스 수집 — 중복 제거]');

  test('같은 기사를 한 번만 남긴다', () => {
    const a = normalizeArticle(ok, 'newsapi')!;
    const b = normalizeArticle({ ...ok, url: ok.url + '?utm_source=x' }, 'finnhub')!;
    const r = dedupe([a, b]);
    eq(r.unique.length, 1, 'AI를 두 번 부르면 비용이 두 배다');
    eq(r.removed, 1);
  });

  test('본문이 있는 판본을 남긴다', () => {
    const thin = normalizeArticle({ ...ok, description: '' }, 'a')!;
    const rich = normalizeArticle({ ...ok, description: '아주 긴 본문입니다'.repeat(10) }, 'b')!;
    // 순서를 바꿔도 결과가 같아야 한다
    eq(dedupe([thin, rich]).unique[0].body.length, rich.body.length);
    eq(dedupe([rich, thin]).unique[0].body.length, rich.body.length);
  });

  test('최신순으로 돌려준다', () => {
    const older = normalizeArticle({ ...ok, url: 'https://a.com/1', publishedAt: '2026-07-01T00:00:00Z' }, 'x')!;
    const newer = normalizeArticle({ ...ok, url: 'https://a.com/2', publishedAt: '2026-07-28T00:00:00Z' }, 'x')!;
    const r = dedupe([older, newer]);
    eq(r.unique[0].url, 'https://a.com/2');
  });

  test('다른 기사는 그대로 둔다', () => {
    const a = normalizeArticle({ ...ok, url: 'https://a.com/1' }, 'x')!;
    const b = normalizeArticle({ ...ok, url: 'https://a.com/2' }, 'x')!;
    eq(dedupe([a, b]).unique.length, 2);
    eq(dedupe([a, b]).removed, 0);
  });

  console.log('[뉴스 수집 — 여러 공급자 합치기]');

  test('여러 배치를 합치고 버린 개수를 알린다', () => {
    const r = collectFrom([
      { provider: 'newsapi', items: [ok, { ...ok, url: '' }] },
      { provider: 'finnhub', items: [{ headline: 'T', url: 'https://b.com/1', datetime: 1769558400 }] },
    ]);
    eq(r.unique.length, 2);
    eq(r.skipped, 1, '버린 개수를 감추면 공급자가 망가져도 모른다');
  });

  test('응답이 배열이 아니어도 죽지 않는다', () => {
    const r = collectFrom([
      { provider: 'a', items: null },
      { provider: 'b', items: undefined },
      { provider: 'c', items: { error: 'rate limit' } as any },
      { provider: 'd', items: [ok] },
    ]);
    eq(r.unique.length, 1);
  });

  test('빈 입력이면 빈 결과', () => {
    const r = collectFrom([]);
    eq(r.unique.length, 0);
    eq(r.removed, 0);
    eq(r.skipped, 0);
  });

  console.log('[뉴스 수집 — 이미 저장된 것 거르기]');

  test('아는 지문은 뺀다', () => {
    const a = normalizeArticle(ok, 'x')!;
    const b = normalizeArticle({ ...ok, url: 'https://a.com/2' }, 'x')!;
    eq(onlyNew([a, b], [a.hash]).length, 1);
    eq(onlyNew([a, b], new Set([a.hash, b.hash])).length, 0);
    eq(onlyNew([a, b], []).length, 2);
  });
}

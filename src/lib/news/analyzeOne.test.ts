// src/lib/news/analyzeOne.test.ts
//
// 막으려는 사고:
//  1. AI가 못 답했는데 빈 카드를 화면에 띄우는 것 — 실패가 조용히 넘어간다
//  2. 형식이 깨진 응답을 억지로 파싱해 통과시키는 것
//  3. 원문 없이 AI를 불러 돈만 쓰는 것
//  4. 모델이 준 URL·시각을 원문 대신 쓰는 것
import { test, assert, eq } from '../../test/harness';
import { analyzeArticle, buildPrompt, type AiCaller } from './analyzeOne';

const ART = {
  title: 'Bitcoin ETF sees record inflows',
  body: 'Institutional buyers added $1.2B this week.',
  url: 'https://news.example/btc-etf',
  publishedAt: '2026-07-28T00:00:00Z',
  source: 'Example Wire',
};

const okJson = JSON.stringify({
  titleKo: '비트코인 ETF 사상 최대 유입',
  summary: '기관 자금이 이번 주 12억 달러 들어왔다',
  direction: 'bullish', confidence: 74, horizon: 'short',
  reasons: ['기관 순유입 증가'], risks: ['단기 과열'],
  affectedAssets: ['BTC'],
});

const caller = (text: string | null, over: any = {}): AiCaller =>
  async () => ({ ok: text != null, provider: 'openai', model: 'gpt-4o-mini', text, ...over });

export function runAnalyzeOneTests() {
  console.log('[뉴스 분석 — 정상 경로]');

  test('정상 응답이면 값이 나온다', async () => {
    const r = await analyzeArticle(ART, caller(okJson));
    eq(r.ok, true, r.reason);
    eq(r.value!.direction, 'bullish');
    eq(r.value!.provider, 'openai');
  });

  test('원문 URL과 발행 시각은 원문에서 온다', async () => {
    // 모델이 지어낸 값을 쓰면 확인할 수 없는 링크가 저장된다
    const lying = JSON.stringify({
      ...JSON.parse(okJson),
      sourceUrl: 'https://fake.example/made-up',
      publishedAt: '1999-01-01T00:00:00Z',
    });
    const r = await analyzeArticle(ART, caller(lying));
    eq(r.ok, true, r.reason);
    eq(r.value!.sourceUrl, ART.url);
    eq(r.value!.publishedAt, ART.publishedAt);
  });

  test('지문은 같은 기사에 대해 안정적이다', async () => {
    const a = await analyzeArticle(ART, caller(okJson));
    const b = await analyzeArticle({ ...ART, url: ART.url + '?utm_source=x' }, caller(okJson));
    eq(a.hash, b.hash, '같은 기사를 두 번 분석하면 돈이 두 번 나간다');
  });

  console.log('[뉴스 분석 — 실패를 조용히 넘기지 않는다]');

  test('AI가 실패하면 이유를 남긴다', async () => {
    const r = await analyzeArticle(ART, caller(null, { ok: false, error: '429 rate limit' }));
    eq(r.ok, false);
    eq(r.value, null, '빈 카드를 화면에 띄우면 안 된다');
    assert(r.reason.includes('429'), r.reason);
  });

  test('JSON이 아니면 억지로 파싱하지 않는다', async () => {
    const r = await analyzeArticle(ART, caller('아마 오를 것 같습니다.'));
    eq(r.ok, false);
    eq(r.value, null);
    assert(r.reason.includes('JSON'), r.reason);
  });

  test('호출이 던져도 결과를 돌려준다', async () => {
    const boom: AiCaller = async () => { throw new Error('네트워크 끊김'); };
    const r = await analyzeArticle(ART, boom);
    eq(r.ok, false);
    assert(r.reason.includes('네트워크'), r.reason);
  });

  test('원문이 없으면 AI를 부르지 않는다', async () => {
    let called = 0;
    const counting: AiCaller = async () => { called++; return { ok: true, provider: 'x', model: 'y', text: okJson }; };
    const r = await analyzeArticle({ ...ART, url: '' }, counting);
    eq(r.ok, false);
    eq(called, 0, '원문 없이 부르면 돈만 나간다');
  });

  test('검증에서 떨어지면 이유가 붙는다', async () => {
    const noTitle = JSON.stringify({ ...JSON.parse(okJson), titleKo: '' });
    const r = await analyzeArticle(ART, caller(noTitle));
    eq(r.ok, false);
    assert(r.reason.includes('검증 실패'), r.reason);
  });

  console.log('[뉴스 분석 — 프롬프트]');

  test('본문이 없으면 보류하라고 적는다', () => {
    const p = buildPrompt({ ...ART, body: '' });
    assert(p.includes('uncertain'), p.slice(0, 200));
  });

  test('본문이 길면 자른다', () => {
    const p = buildPrompt({ ...ART, body: 'x'.repeat(10_000) });
    assert(p.length < 6000, `프롬프트가 너무 길다: ${p.length}`);
  });

  test('원문 제목과 발행 시각이 프롬프트에 들어간다', () => {
    const p = buildPrompt(ART);
    assert(p.includes(ART.title), '제목 없음');
    assert(p.includes(ART.publishedAt), '발행 시각 없음');
  });
}

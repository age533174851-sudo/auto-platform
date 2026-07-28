// src/lib/news/consensus.test.ts
//
// 막으려는 사고:
//  1. 상승 80%와 하락 80%를 평균해 "80% 확신"을 만드는 것 — 실제로는
//     아무것도 모르는 상태인데 화면에서는 확신 있어 보인다
//  2. 하나만 답했는데 '합의'라고 부르는 것 — 사용자는 셋이 동의한 줄 안다
//  3. 갈린 사실을 하나로 뭉개는 것 — 이 기능의 값어치가 거기 있다
//  4. 판단 보류가 우세한데 방향을 내는 것
//  5. 모든 기사에 3개 AI를 불러 비용을 세 배로 만드는 것
import { test, assert, eq } from '../../test/harness';
import { aggregate, worthConsensus, MIN_FOR_CONSENSUS, type Opinion } from './consensus';

const op = (provider: string, direction: any, confidence: number, reasons: string[] = []): Opinion =>
  ({ provider, direction, confidence, reasons });

export function runConsensusTests() {
  console.log('[합의 분석 — 만장일치]');

  test('전원 같은 방향이면 만장일치다', () => {
    const r = aggregate([
      op('openai', 'bullish', 80), op('anthropic', 'bullish', 70), op('gemini', 'bullish', 90),
    ]);
    eq(r.level, 'UNANIMOUS');
    eq(r.direction, 'bullish');
    eq(r.directionKo, '상승');
    eq(r.confidence, 80);   // (80+70+90)/3
    eq(r.responded, 3);
  });

  console.log('[합의 분석 — 갈렸을 때]');

  test('정반대 둘을 평균해 확신을 만들지 않는다', () => {
    // 이게 이 파일의 핵심이다. 80과 80을 평균하면 80이 되는데,
    // 두 모델이 정반대를 말한 상태는 확신 80%가 아니다.
    const r = aggregate([op('a', 'bullish', 80), op('b', 'bearish', 80)]);
    eq(r.level, 'SPLIT');
    eq(r.direction, null, '갈렸는데 방향을 고르면 안 된다');
    assert(r.confidence <= 50, `갈렸는데 확신도가 ${r.confidence}%다`);
    assert(r.summary.includes('갈렸'), r.summary);
  });

  test('동점이면 방향을 내지 않는다', () => {
    const r = aggregate([
      op('a', 'bullish', 90), op('b', 'bearish', 90),
      op('c', 'bullish', 50), op('d', 'bearish', 50),
    ]);
    eq(r.level, 'SPLIT');
    eq(r.direction, null);
  });

  test('갈린 내역을 요약에 적는다', () => {
    // 뭉개면 이 기능의 값어치가 사라진다
    const r = aggregate([op('a', 'bullish', 70), op('b', 'bearish', 70)]);
    assert(r.summary.includes('상승') && r.summary.includes('하락'), r.summary);
    eq(r.votes.bullish, 1);
    eq(r.votes.bearish, 1);
  });

  console.log('[합의 분석 — 과반]');

  test('과반이면 방향을 내되 확신을 깎는다', () => {
    const r = aggregate([
      op('a', 'bullish', 90), op('b', 'bullish', 90), op('c', 'bearish', 90),
    ]);
    eq(r.level, 'MAJORITY');
    eq(r.direction, 'bullish');
    // 90 × (2/3) = 60. 만장일치와 같은 90이면 안 된다.
    eq(r.confidence, 60);
    assert(r.summary.includes('나머지는 다르게'), r.summary);
  });

  test('반대한 모델의 확신도를 합의에 섞지 않는다', () => {
    // 반대 모델이 확신 100이어도 합의 확신을 올리면 안 된다
    const low = aggregate([op('a', 'bullish', 50), op('b', 'bullish', 50), op('c', 'bearish', 100)]);
    const same = aggregate([op('a', 'bullish', 50), op('b', 'bullish', 50), op('c', 'bearish', 10)]);
    eq(low.confidence, same.confidence, '반대 모델의 확신도가 결과를 바꿨다');
  });

  console.log('[합의 분석 — 판단 보류]');

  test('보류가 최다면 방향을 내지 않는다', () => {
    const r = aggregate([
      op('a', 'uncertain', 30), op('b', 'uncertain', 30), op('c', 'bullish', 80),
    ]);
    eq(r.level, 'SPLIT');
    eq(r.direction, null, '보류 우세는 방향이 아니다');
    assert(r.summary.includes('보류'), r.summary);
  });

  test('보류가 소수면 다수 방향을 낸다', () => {
    const r = aggregate([
      op('a', 'bullish', 80), op('b', 'bullish', 80), op('c', 'uncertain', 20),
    ]);
    eq(r.level, 'MAJORITY');
    eq(r.direction, 'bullish');
  });

  console.log('[합의 분석 — 응답이 부족할 때]');

  test('하나만 답하면 합의가 아니다', () => {
    const r = aggregate([op('openai', 'bullish', 90)]);
    eq(r.level, 'INSUFFICIENT');
    eq(r.direction, null, '하나를 합의로 부르면 셋이 동의한 줄 안다');
    eq(r.confidence, 0);
    assert(r.summary.includes('단일 의견'), r.summary);
  });

  test('아무도 안 답하면 그렇게 말한다', () => {
    const r = aggregate([]);
    eq(r.level, 'INSUFFICIENT');
    eq(r.responded, 0);
    assert(r.summary.includes('답하지 않'), r.summary);
  });

  test('깨진 의견은 세지 않는다', () => {
    const r = aggregate([
      op('a', 'bullish', 80),
      { provider: 'b', direction: null as any, confidence: 80 },
      { provider: 'c', direction: 'bullish' as any, confidence: NaN },
    ]);
    eq(r.responded, 1, '깨진 응답을 세면 없는 합의가 생긴다');
    eq(r.level, 'INSUFFICIENT');
  });

  test('최소 인원 상수가 2 이상이다', () => {
    assert(MIN_FOR_CONSENSUS >= 2, '1이면 단일 의견이 합의가 된다');
  });

  console.log('[합의 분석 — 근거 모으기]');

  test('둘 이상이 든 근거를 공통으로 묶는다', () => {
    const r = aggregate([
      op('a', 'bullish', 80, ['기관 순유입 증가', 'ETF 승인']),
      op('b', 'bullish', 80, ['기관 순유입 증가.', '금리 인하 기대']),
    ]);
    eq(r.sharedReasons.length, 1);
    assert(r.sharedReasons[0].includes('기관 순유입'), r.sharedReasons.join(','));
  });

  test('한 모델만 든 근거를 버리지 않는다', () => {
    // 남들이 놓친 것일 수 있다
    const r = aggregate([
      op('a', 'bullish', 80, ['공통', '나만 봄']),
      op('b', 'bullish', 80, ['공통']),
    ]);
    eq(r.uniqueReasons.length, 1);
    eq(r.uniqueReasons[0].provider, 'a');
    eq(r.uniqueReasons[0].reason, '나만 봄');
  });

  test('근거가 없어도 죽지 않는다', () => {
    const r = aggregate([op('a', 'bullish', 80), op('b', 'bullish', 80)]);
    eq(r.sharedReasons.length, 0);
    eq(r.uniqueReasons.length, 0);
  });

  console.log('[합의 분석 — 언제 돌릴 것인가]');

  test('판단 보류는 다시 물어본다', () => {
    // 다른 모델은 볼 수도 있다
    const r = worthConsensus({ confidence: 20, direction: 'uncertain', affectedCount: 1 });
    eq(r.yes, true);
    assert(r.why.includes('보류'), r.why);
  });

  test('확신이 어중간하면 물어본다', () => {
    eq(worthConsensus({ confidence: 55, direction: 'bullish', affectedCount: 1 }).yes, true);
  });

  test('아주 확신하거나 아주 자신 없으면 안 물어본다', () => {
    // 더 물어봐도 답이 크게 안 바뀐다. 비용만 세 배다.
    eq(worthConsensus({ confidence: 92, direction: 'bullish', affectedCount: 1 }).yes, false);
    eq(worthConsensus({ confidence: 10, direction: 'bearish', affectedCount: 1 }).yes, false);
  });

  test('영향 자산이 넓으면 물어본다', () => {
    eq(worthConsensus({ confidence: 95, direction: 'bullish', affectedCount: 4 }).yes, true);
  });

  test('확신도를 모르면 물어보지 않는다', () => {
    // null을 0으로 보면 '아주 자신 없음'이라 안 물어본다 — 비용이 안전한 쪽
    eq(worthConsensus({ confidence: null, direction: 'bullish', affectedCount: 1 }).yes, false);
  });
}

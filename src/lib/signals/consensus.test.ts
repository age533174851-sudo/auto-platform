import { test, eq, assert } from '../../test/harness';
import { computeConsensus, canTradeOnConsensus, consensusHeadline, STALE_MS, type ConsensusInput } from './consensus';
import { scoreTrader, type ScoredSignal } from './traderScore';

export function runConsensusSignalTests() {
  console.log('[방송자 합의 — 여럿이 같은 말을 한다고 맞는 게 아니다]');

  const now = 1_800_000_000_000;
  const HOUR = 3_600_000;

  /** 검증된 성적을 만든다 (끝난 신호 20건, 손익비 3) */
  const proven = (name: string) => {
    const sig = (pct: number): ScoredSignal => ({
      trader: name, symbol: 'BTC', side: 'LONG', confidence: 'likely',
      detectedAtMs: 0, entryPrice: 100, exitPrice: 100 * (1 + pct / 100), exitAtMs: HOUR,
    });
    return scoreTrader(name, [
      ...Array.from({ length: 15 }, () => sig(10)),
      ...Array.from({ length: 5 }, () => sig(-10)),
    ]);
  };

  const v = (o: Partial<ConsensusInput>): ConsensusInput => ({
    trader: 'A', side: 'LONG', confidence: 'likely', atMs: now - 60_000, stats: null, ...o,
  });

  // ── 기본 ────────────────────────────────────────────────
  test('한쪽이 많으면 그쪽으로 기운다', () => {
    const r = computeConsensus('BTC', [
      v({ trader: 'A', side: 'LONG', stats: proven('A') }),
      v({ trader: 'B', side: 'LONG', stats: proven('B') }),
      v({ trader: 'C', side: 'SHORT', stats: proven('C') }),
    ], now);
    eq(r.side, 'LONG');
    eq(r.counted, 3);
    eq(r.longVoices.length, 2);
  });

  test('팽팽하면 방향을 안 정한다', () => {
    const r = computeConsensus('BTC', [
      v({ trader: 'A', side: 'LONG', stats: proven('A') }),
      v({ trader: 'B', side: 'SHORT', stats: proven('B') }),
    ], now);
    eq(r.side, null);
  });

  // ── 성적으로 가중한다 ───────────────────────────────────
  test('검증 안 된 사람 여럿보다 검증된 한 사람이 무겁다', () => {
    // 머릿수만 세면 방송을 많이 켜 놓은 쪽이 이긴다.
    const r = computeConsensus('BTC', [
      v({ trader: 'A', side: 'LONG', stats: null }),
      v({ trader: 'B', side: 'LONG', stats: null }),
      v({ trader: 'P', side: 'SHORT', stats: proven('P') }),
    ], now);
    // 검증 안 된 둘(0.4×0.7=0.28씩) vs 검증된 하나(1×0.7=0.7)
    eq(r.side, 'SHORT');
  });

  test('검증 안 된 사람 수를 적는다', () => {
    const r = computeConsensus('BTC', [v({ stats: null })], now);
    eq(r.unproven, 1);
    assert(r.note.includes('검증되지 않아'), r.note);
  });

  test('추정은 확정보다 가볍다', () => {
    const r = computeConsensus('BTC', [
      v({ trader: 'A', side: 'LONG', confidence: 'uncertain', stats: proven('A') }),
      v({ trader: 'B', side: 'SHORT', confidence: 'confirmed', stats: proven('B') }),
    ], now);
    eq(r.side, 'SHORT');
  });

  // ── 오래된 발언 ─────────────────────────────────────────
  test('오래된 발언은 세지 않는다', () => {
    // 두 시간 전 "롱 잡았습니다"는 지금 포지션이라는 보장이 없다.
    // 계속 세면 이미 나간 사람이 영원히 롱을 들고 있는 것으로 집계된다.
    const r = computeConsensus('BTC', [
      v({ trader: 'A', side: 'LONG', atMs: now - STALE_MS - 1 }),
      v({ trader: 'B', side: 'SHORT', atMs: now - 60_000, stats: proven('B') }),
    ], now);
    eq(r.stale, 1);
    eq(r.counted, 1);
    eq(r.side, 'SHORT');
  });

  test('전부 오래됐으면 방향이 없다', () => {
    const r = computeConsensus('BTC', [
      v({ atMs: now - 5 * HOUR }),
      v({ atMs: now - 6 * HOUR }),
    ], now);
    eq(r.side, null);
    eq(r.counted, 0);
    assert(r.note.includes('오래된'), r.note);
  });

  test('시각이 깨진 발언도 뺀다', () => {
    eq(computeConsensus('BTC', [v({ atMs: NaN })], now).stale, 1);
  });

  // ── 전원 일치는 경고다 ──────────────────────────────────
  test('전원 한 방향이면 붐빈 자리로 표시한다', () => {
    // **맞다는 뜻이 아니다.** 다 같이 롱이면 롱 청산이 몰린다.
    const r = computeConsensus('BTC', [
      v({ trader: 'A', side: 'LONG', stats: proven('A') }),
      v({ trader: 'B', side: 'LONG', stats: proven('B') }),
      v({ trader: 'C', side: 'LONG', stats: proven('C') }),
    ], now);
    eq(r.crowded, true);
    assert(r.note.includes('붐볐다'), r.note);
  });

  test('한 명이라도 반대면 붐빈 것이 아니다', () => {
    const r = computeConsensus('BTC', [
      v({ trader: 'A', side: 'LONG', stats: proven('A') }),
      v({ trader: 'B', side: 'LONG', stats: proven('B') }),
      v({ trader: 'C', side: 'SHORT', stats: proven('C') }),
    ], now);
    eq(r.crowded, false);
  });

  test('두 명뿐이면 붐빈 것으로 안 본다', () => {
    // 둘이 같은 말 하는 건 흔하다.
    const r = computeConsensus('BTC', [
      v({ trader: 'A', side: 'LONG', stats: proven('A') }),
      v({ trader: 'B', side: 'LONG', stats: proven('B') }),
    ], now);
    eq(r.crowded, false);
  });

  // ── 믿을 만한가 ─────────────────────────────────────────
  test('셋 미만이면 합의라고 부르지 않는다', () => {
    // 한 사람이 바뀌면 결과가 뒤집힌다.
    const r = computeConsensus('BTC', [v({ stats: proven('A') })], now);
    eq(r.reliable, false);
    assert(r.note.includes('합의라고 보기 어렵'), r.note);
  });

  test('전원이 미검증이면 믿을 수 없다', () => {
    const r = computeConsensus('BTC', [
      v({ trader: 'A', stats: null }), v({ trader: 'B', stats: null }), v({ trader: 'C', stats: null }),
    ], now);
    eq(r.reliable, false);
  });

  test('검증된 사람이 섞여 있고 셋 이상이면 믿을 만하다', () => {
    const r = computeConsensus('BTC', [
      v({ trader: 'A', side: 'LONG', stats: proven('A') }),
      v({ trader: 'B', side: 'LONG', stats: proven('B') }),
      v({ trader: 'C', side: 'SHORT', stats: null }),
    ], now);
    eq(r.reliable, true);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(computeConsensus('BTC', null, now).side, null);
    eq(computeConsensus('BTC', [], now).counted, 0);
  });

  // ── 문구 ────────────────────────────────────────────────
  test('표본이 부족하면 문구가 그렇게 말한다', () => {
    const r = computeConsensus('BTC', [v({ stats: proven('A') })], now);
    assert(consensusHeadline(r).includes('표본이 부족'), consensusHeadline(r));
  });

  test('붐볐으면 문구가 그렇게 말한다', () => {
    const r = computeConsensus('BTC', [
      v({ trader: 'A', side: 'LONG', stats: proven('A') }),
      v({ trader: 'B', side: 'LONG', stats: proven('B') }),
      v({ trader: 'C', side: 'LONG', stats: proven('C') }),
    ], now);
    assert(consensusHeadline(r).includes('붐빈'), consensusHeadline(r));
  });

  test('방향이 갈리면 그렇게 말한다', () => {
    eq(consensusHeadline(null), '방향이 갈립니다');
  });

  // ── 자동매매 경계 ───────────────────────────────────────
  test('합의로는 주문을 못 낸다', () => {
    // 합의는 정확도의 근거가 아니다. 그리고 이 숫자는 '다른 사람들이
    // 무엇을 했는지에 대한 추측'을 모은 것이라, 추측 위에 추측을 쌓은 값이다.
    eq(canTradeOnConsensus(), false);
  });
}

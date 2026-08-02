import { test, eq, assert, close } from '../../test/harness';
import {
  scoreTrader, trustTier, MIN_SAMPLE, TIER_LABEL, type ScoredSignal,
} from './traderScore';

export function runTraderScoreTests() {
  console.log('[방송자 성적 — 표본이 적으면 승률을 말하지 않는다]');

  const HOUR = 3_600_000;
  const base = { trader: 'A', symbol: 'BTC', confidence: 'likely' as const, detectedAtMs: 0 };
  const sig = (o: Partial<ScoredSignal>): ScoredSignal =>
    ({ ...base, side: 'LONG', entryPrice: 100, exitPrice: null, exitAtMs: null, ...o } as ScoredSignal);

  /** n건의 결과를 만든다 */
  const many = (n: number, pct: number) => Array.from({ length: n }, () =>
    sig({ exitPrice: 100 * (1 + pct / 100), exitAtMs: HOUR }));

  // ── 기본 계산 ───────────────────────────────────────────
  test('롱 수익률을 계산한다', () => {
    const st = scoreTrader('A', [sig({ exitPrice: 110, exitAtMs: HOUR })]);
    eq(st.closed, 1);
    eq(st.wins, 1);
    close(st.totalPct, 10, 0.01);
  });

  test('숏은 방향을 뒤집어 계산한다', () => {
    // 숏은 가격이 내려야 이익이다. 롱과 같은 식으로 계산하면 성적이
    // 정확히 반대로 나온다.
    const st = scoreTrader('A', [sig({ side: 'SHORT', entryPrice: 100, exitPrice: 90, exitAtMs: HOUR })]);
    eq(st.wins, 1);
    close(st.totalPct, 10, 0.01);
  });

  test('다른 사람의 신호는 안 센다', () => {
    const st = scoreTrader('A', [
      sig({ exitPrice: 110, exitAtMs: HOUR }),
      { ...sig({ exitPrice: 200, exitAtMs: HOUR }), trader: 'B' },
    ]);
    eq(st.closed, 1);
  });

  // ── 없는 결과를 만들지 않는다 ───────────────────────────
  test('청산 신호가 없으면 미결로 남긴다', () => {
    // 지금 가격으로 임의 청산하면 아직 살아 있는 포지션이 손익으로
    // 확정되어 성적이 실제와 달라진다.
    const st = scoreTrader('A', [sig({ exitPrice: null })]);
    eq(st.open, 1);
    eq(st.closed, 0);
    eq(st.totalPct, 0);
    assert(st.note.includes('청산 신호가 없어'), st.note);
  });

  test('진입가를 모르면 채점 자체를 안 한다', () => {
    // 지금 가격으로 대신 쓰면 신호가 뜬 뒤 움직인 만큼이 통째로 성적에 들어간다.
    const st = scoreTrader('A', [sig({ entryPrice: null, exitPrice: 110 })]);
    eq(st.unscorable, 1);
    eq(st.closed, 0);
  });

  test('채점 못 한 건수를 조용히 빼지 않는다', () => {
    // 이 숫자가 크면 나머지 성적도 못 믿는다.
    const st = scoreTrader('A', [sig({ entryPrice: 0, exitPrice: 110 })]);
    assert(st.note.includes('가격을 몰라'), st.note);
  });

  // ── 표본 ────────────────────────────────────────────────
  test('표본이 적으면 승률을 안 준다', () => {
    // 3전 2승은 67%가 아니라 "아직 모른다"다.
    const st = scoreTrader('A', [
      sig({ exitPrice: 110, exitAtMs: HOUR }),
      sig({ exitPrice: 110, exitAtMs: HOUR }),
      sig({ exitPrice: 90, exitAtMs: HOUR }),
    ]);
    eq(st.winRate, null);
    eq(st.profitFactor, null);
    eq(st.enough, false);
    assert(st.note.includes(String(MIN_SAMPLE)), st.note);
  });

  test('표본이 충분하면 승률을 준다', () => {
    const st = scoreTrader('A', [...many(15, 10), ...many(5, -10)]);
    eq(st.closed, 20);
    eq(st.enough, true);
    eq(st.winRate, 75);
  });

  test('손실이 없으면 손익비를 숫자로 안 적는다', () => {
    // 무한대를 큰 숫자로 적으면 "아주 좋다"로 읽히는데, 실제로는
    // 표본이 모자란 것이다.
    const st = scoreTrader('A', many(25, 5));
    eq(st.profitFactor, null);
  });

  test('손익비를 계산한다', () => {
    // 이익 15×10=150, 손실 5×10=50 → 3.0
    const st = scoreTrader('A', [...many(15, 10), ...many(5, -10)]);
    eq(st.profitFactor, 3);
  });

  // ── 낙폭 ────────────────────────────────────────────────
  test('최대 낙폭을 순서대로 잰다', () => {
    const st = scoreTrader('A', [
      sig({ exitPrice: 120, exitAtMs: HOUR }),   // +20 (누적 20, 고점 20)
      sig({ exitPrice: 70, exitAtMs: HOUR }),    // -30 (누적 -10, 낙폭 30)
      sig({ exitPrice: 110, exitAtMs: HOUR }),   // +10 (누적 0)
    ]);
    close(st.maxDrawdownPct, 30, 0.01);
  });

  test('한 번도 안 내려가면 낙폭 0', () => {
    eq(scoreTrader('A', many(3, 5)).maxDrawdownPct, 0);
  });

  // ── 편향 ────────────────────────────────────────────────
  test('롱 비중을 적는다', () => {
    // 한쪽에 치우쳐 있으면 시장이 그 방향일 때만 맞는다.
    const st = scoreTrader('A', [
      sig({ side: 'LONG', exitPrice: 110, exitAtMs: HOUR }),
      sig({ side: 'LONG', exitPrice: 110, exitAtMs: HOUR }),
      sig({ side: 'SHORT', exitPrice: 90, exitAtMs: HOUR }),
      sig({ side: 'SHORT', exitPrice: 90, exitAtMs: HOUR }),
    ]);
    eq(st.longBiasPct, 50);
  });

  test('신호가 없으면 편향도 없다', () => {
    eq(scoreTrader('A', []).longBiasPct, null);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(scoreTrader('A', null).closed, 0);
    eq(scoreTrader('A', undefined).closed, 0);
    eq(scoreTrader('A', []).enough, false);
  });

  // ── 신뢰 단계 ───────────────────────────────────────────
  test('성적이 없으면 지켜보기다', () => {
    eq(trustTier(null).tier, 'watch');
    eq(trustTier(scoreTrader('A', [])).tier, 'notify');
  });

  test('채점 못 한 신호가 많으면 지켜보기로 내린다', () => {
    // 나머지 숫자도 못 믿는다.
    const st = scoreTrader('A', [
      ...Array.from({ length: 10 }, () => sig({ entryPrice: null })),
      ...many(5, 10),
    ]);
    eq(trustTier(st).tier, 'watch');
  });

  test('표본이 적으면 알림까지만', () => {
    eq(trustTier(scoreTrader('A', many(5, 10))).tier, 'notify');
  });

  test('손익비가 1 미만이면 따라가지 않는다', () => {
    // 이기는 횟수가 많아도 손익비가 1 미만이면 결국 잃는다.
    const st = scoreTrader('A', [...many(15, 2), ...many(5, -12)]);
    const t = trustTier(st);
    eq(t.tier, 'notify');
    assert(t.reason.includes('잃습니다'), t.reason);
  });

  test('낙폭이 크면 모의까지만', () => {
    const st = scoreTrader('A', [
      ...many(10, 10),        // +100
      ...many(5, -12),        // -60 → 낙폭 60
      ...many(10, 8),
    ]);
    assert(['paper', 'notify'].includes(trustTier(st).tier), trustTier(st).tier);
  });

  test('성적이 좋아도 자동 주문 단계는 없다', () => {
    // 가장 높은 단계가 '수동 주문'이다. 남의 신호로 자동 주문을 내는
    // 경로는 이 앱에 만들지 않는다.
    const st = scoreTrader('A', [...many(15, 10), ...many(5, -5)]);
    const t = trustTier(st);
    assert(t.tier !== ('auto' as any), '자동 단계가 있으면 안 된다');
    eq(t.tier, 'semi_auto');
    assert(TIER_LABEL.semi_auto.note.includes('자동은 아닙니다'), TIER_LABEL.semi_auto.note);
  });

  test('모든 단계에 설명이 있다', () => {
    for (const k of ['watch', 'notify', 'paper', 'semi_auto'] as const) {
      assert(TIER_LABEL[k].text.length > 0 && TIER_LABEL[k].note.length > 0, `${k} 설명 없음`);
    }
  });

  test('단계마다 이유를 적는다', () => {
    // 왜 이 단계인지 안 적으면 사용자는 올리려고 아무거나 눌러 본다.
    assert(trustTier(scoreTrader('A', many(5, 10))).reason.length > 0, '이유가 없다');
  });
}

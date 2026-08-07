// src/lib/backtest/verdict.test.ts
//
// 실제 화면이었던 것:
//
//   365개 캔들 · 거래 8회 · 승률 25% · PF 0.77 · Sharpe -0.23
//   그리고 바로 아래 '복리 성장 분석'
//
// 승률 25%는 2승 6패다. 동전 여덟 번으로도 나온다. 그런데 화면은 이
// 숫자를 다른 검증 결과와 똑같은 크기로 보여줬다.
//
// 막으려는 것:
//  1. 8건짜리 표본에 '우위 없음' 같은 결론을 붙이는 것 —
//     실제로 알 수 있는 것은 '모른다'뿐이다
//  2. 기대값이 음수인 전략에 복리 분석을 붙이는 것.
//     그건 손실을 복리로 키우는 그림이다
//  3. 캔들 개수만 적어서 15일치를 충분한 검증으로 보이게 하는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  backtestVerdict, compoundAllowed, rangeCheck,
  MIN_TRADES_FOR_ANY_CLAIM, MIN_TRADES_FOR_CONFIDENCE, MIN_BACKTEST_DAYS,
} from './verdict';

export function runBacktestVerdictTests() {
  console.log('[백테스트 판정 — 표본이 먼저다]');

  test('거래 8회에 우위 없음이라고 하지 않는다', () => {
    // 실제 화면 그대로의 값.
    const v = backtestVerdict({
      totalTrades: 8, totalReturnPct: -2.27, profitFactor: 0.77,
      sharpe: -0.23, maxDrawdownPct: -5.92, winRate: 25,
    });
    eq(v.verdict, 'INSUFFICIENT_SAMPLE');
    eq(v.promotable, false);
    eq(v.statsMeaningful, false, '이 숫자로는 성적을 주장할 수 없다');
    assert(v.nextStep.includes('기간을 늘려'), v.nextStep);
    assert(v.nextStep.includes('조건을 고치는 것은 그다음'), v.nextStep);
  });

  test('표본 부족이면 승률·PF를 근거로 쓰지 말라고 적는다', () => {
    const v = backtestVerdict({ totalTrades: 8, totalReturnPct: -2.27, profitFactor: 0.77 });
    assert(v.reasons.some(r => r.includes('우연으로도 나올 수 있는')), v.reasons.join(' / '));
    assert(v.sampleNote.includes('8회'), v.sampleNote);
  });

  test('표본 기준선이 30건이다', () => {
    eq(MIN_TRADES_FOR_ANY_CLAIM, 30);
    eq(backtestVerdict({ totalTrades: 29, totalReturnPct: 5, profitFactor: 2 }).verdict, 'INSUFFICIENT_SAMPLE');
    assert(backtestVerdict({ totalTrades: 30, totalReturnPct: 5, profitFactor: 2, sharpe: 1, maxDrawdownPct: -5 }).verdict !== 'INSUFFICIENT_SAMPLE', '30건부터는 방향을 볼 수 있다');
  });

  test('건수를 모르면 아무 말도 안 한다', () => {
    const v = backtestVerdict({ totalReturnPct: 50, profitFactor: 3 });
    eq(v.verdict, 'UNKNOWN');
    eq(v.statsMeaningful, false);
  });

  console.log('[백테스트 판정 — 표본이 충분해진 뒤]');

  test('표본이 충분하고 우위가 없으면 우위 없음이다', () => {
    const v = backtestVerdict({
      totalTrades: 300, totalReturnPct: -2.27, profitFactor: 0.77, sharpe: -0.23, maxDrawdownPct: -5.9,
    });
    eq(v.verdict, 'NO_EDGE');
    eq(v.statsMeaningful, true);
    assert(v.reasons.some(r => r.includes('Profit Factor')), v.reasons.join(' / '));
    assert(v.nextStep.includes('배율이나 자금을 늘려도'), v.nextStep);
  });

  test('기대값이 양수여도 낙폭이 크면 못 쓴다', () => {
    const v = backtestVerdict({
      totalTrades: 300, totalReturnPct: 40, profitFactor: 1.4, sharpe: 0.8, maxDrawdownPct: -45,
    });
    eq(v.verdict, 'OVER_RISKED');
    assert(v.nextStep.includes('위험과 배율을 낮춰'), v.nextStep);
  });

  test('낙폭을 음수로 담아도 절대값으로 본다', () => {
    // 이 저장소는 -45로 담는다. 부호를 안 보면 -45 < 30이라 통과해 버린다.
    eq(backtestVerdict({ totalTrades: 300, totalReturnPct: 40, profitFactor: 1.4, sharpe: .8, maxDrawdownPct: -45 }).verdict, 'OVER_RISKED');
    eq(backtestVerdict({ totalTrades: 300, totalReturnPct: 40, profitFactor: 1.4, sharpe: .8, maxDrawdownPct: 45 }).verdict, 'OVER_RISKED');
  });

  test('방향은 좋은데 표본이 모자라면 아직 검증됨이 아니다', () => {
    const v = backtestVerdict({
      totalTrades: 100, totalReturnPct: 20, profitFactor: 1.4, sharpe: 0.9, maxDrawdownPct: -8,
    });
    eq(v.verdict, 'PROMISING');
    eq(v.promotable, false, '백테스트 하나로 승격하지 않는다');
    assert(v.nextStep.includes('Walk-forward'), v.nextStep);
  });

  test('표본과 지표가 다 좋으면 견고다', () => {
    const v = backtestVerdict({
      totalTrades: MIN_TRADES_FOR_CONFIDENCE, totalReturnPct: 35, profitFactor: 1.6,
      sharpe: 1.2, maxDrawdownPct: -9,
    });
    eq(v.verdict, 'ROBUST');
    eq(v.promotable, true);
  });

  console.log('[백테스트 판정 — 복리는 마지막이다]');

  test('우위가 없으면 복리 분석을 잠근다', () => {
    // 손실을 복리로 키우는 그림을 '성장 분석'이라고 부르면 안 된다.
    const g = compoundAllowed(backtestVerdict({
      totalTrades: 300, totalReturnPct: -2.27, profitFactor: 0.77, sharpe: -0.23,
    }));
    eq(g.allowed, false);
    assert(g.reason.includes('손실을 복리로 키우는'), g.reason);
  });

  test('표본이 부족해도 잠근다', () => {
    const g = compoundAllowed(backtestVerdict({ totalTrades: 8, totalReturnPct: -2.27 }));
    eq(g.allowed, false);
    assert(g.reason.includes('아직 모릅니다'), g.reason);
  });

  test('낙폭이 과해도 잠근다', () => {
    const g = compoundAllowed(backtestVerdict({
      totalTrades: 300, totalReturnPct: 40, profitFactor: 1.4, sharpe: .8, maxDrawdownPct: -45,
    }));
    eq(g.allowed, false);
  });

  test('판정 못 한 결과에도 안 붙인다', () => {
    eq(compoundAllowed(null).allowed, false);
    eq(compoundAllowed(backtestVerdict({})).allowed, false);
  });

  test('가능성 있음부터 복리를 본다', () => {
    eq(compoundAllowed(backtestVerdict({
      totalTrades: 100, totalReturnPct: 20, profitFactor: 1.4, sharpe: .9, maxDrawdownPct: -8,
    })).allowed, true);
  });

  console.log('[백테스트 판정 — 365개 캔들은 며칠인가]');

  test('1시간봉 365개는 약 15일이다', () => {
    const r = rangeCheck(365, '1h');
    close(r.days!, 15.2, 0.1);
    eq(r.enough, false);
    assert(r.note.includes('추세장·횡보장이 모두 들어 있지 않을 수 있습니다'), r.note);
  });

  test('충분한 기간은 그렇다고 한다', () => {
    // 1시간봉으로 180일이면 4,320개.
    const r = rangeCheck(4320 + 1, '1h');
    eq(r.enough, true);
    assert(!r.note.includes('권합니다'), r.note);
  });

  test('일봉은 개수가 적어도 기간이 길다', () => {
    const r = rangeCheck(365, '1d');
    close(r.days!, 365, 1e-9);
    eq(r.enough, true);
  });

  test('모르는 시간봉이면 며칠인지 지어내지 않는다', () => {
    const r = rangeCheck(365, '7h');
    eq(r.days, null);
    eq(r.enough, false);
    assert(r.note.includes('캔들 개수만으로는'), r.note);
  });

  test('기준선은 180일이다', () => {
    eq(MIN_BACKTEST_DAYS, 180);
  });
}

// src/lib/accounts/drip.test.ts
//
// 막으려는 것: **배당 성장을 두 번 세는 것.**
//
// 배당 수익률은 '주당 배당 ÷ 주가'다. 주가가 7% 오르고 주당 배당이 8%
// 오르면 수익률은 거의 그대로(1.08/1.07)여야 한다. 그런데 수익률 자체를
// 매년 8%씩 키우고 그것을 **이미 7% 오른 평가금액**에 곱하면, 주당
// 배당은 해마다 1.07 × 1.08 ≈ 15.6%씩 자란다 — 사용자가 넣은 8%가 아니다.
//
// 그 결과 배당 계산기의 SCHD 기본값(1천만 원·3.5%·배당 8%·주가 7%·20년)이
// 재투자 총자산을 실제 약 7,817만 원 대신 1억 6천만 원 넘게 보여 주었고,
// 20년째 한 해 배당이 원금의 55%로 찍혔다(맞는 값은 약 15%).
//
// 검사 기준은 코드와 독립된 사실이다: **현금 수령이면 주식 수가 그대로다.**
// 그러면 n년째 배당은 '첫해 배당 × (1+배당 성장률)^(n−1)'이고, 주가가
// 몇 % 오르든 바뀌지 않는다.
import { test, assert, close } from '../../test/harness';
import { simulateDrip, compareDrip } from './drip';

/** 누적 배당에서 해마다 받은 배당을 되돌려 낸다 */
function yearlyDividends(rows: { cumulativeDividends: number }[]): number[] {
  return rows.map((r, i) => r.cumulativeDividends - (i ? rows[i - 1].cumulativeDividends : 0));
}

export function runDripTests() {
  console.log('[배당 재투자 — 배당 성장을 두 번 세지 않는다]');

  test('현금 수령: 주가만 올라도 주당 배당은 그대로다', () => {
    const rows = simulateDrip({
      principal: 1_000_000, annualYield: 4, divGrowth: 0, priceGrowth: 10,
      years: 10, reinvest: false,
    });
    const divs = yearlyDividends(rows);
    for (let i = 0; i < divs.length; i++) {
      // 주식 수 그대로 · 주당 배당 그대로 → 해마다 40,000원
      close(divs[i], 40_000, 1, `${i + 1}년째 배당 ${divs[i]}`);
    }
  });

  test('현금 수령: n년째 배당 = 첫해 배당 × (1+배당 성장률)^(n−1)', () => {
    const rows = simulateDrip({
      principal: 10_000_000, annualYield: 3.5, divGrowth: 8, priceGrowth: 7,
      years: 20, reinvest: false,
    });
    const divs = yearlyDividends(rows);
    for (let n = 1; n <= 20; n++) {
      const expected = 10_000_000 * 0.035 * Math.pow(1.08, n - 1);
      close(divs[n - 1], expected, 2, `${n}년째 배당 ${divs[n - 1]} ≠ ${Math.round(expected)}`);
    }
    // 평가금액은 주가 상승률만 따른다
    close(rows[19].value, 10_000_000 * Math.pow(1.07, 20), 1);
  });

  test('주가·배당이 같이 자라면 수익률은 처음 그대로다', () => {
    // 주가 5%·주당 배당 5% → 배당 ÷ 평가금액은 늘 4%
    const rows = simulateDrip({
      principal: 1_000_000, annualYield: 4, divGrowth: 5, priceGrowth: 5,
      years: 15, reinvest: false,
    });
    const divs = yearlyDividends(rows);
    for (let n = 2; n <= 15; n++) {
      // n년째 배당은 그해 초 평가금액(= n−1년 말 value)의 4%
      close(divs[n - 1], rows[n - 2].value * 0.04, 2, `${n}년째`);
    }
  });

  test('대조군: 성장이 없으면 재투자는 수익률로 복리가 된다', () => {
    const rows = simulateDrip({
      principal: 1_000_000, annualYield: 5, divGrowth: 0, priceGrowth: 0,
      years: 10, reinvest: true,
    });
    close(rows[9].totalReturn, 1_000_000 * Math.pow(1.05, 10), 1);
  });

  test('SCHD 기본값 20년 재투자가 원금의 16배로 부풀지 않는다', () => {
    const { reinvest, cash } = compareDrip({
      principal: 10_000_000, annualYield: 3.5, divGrowth: 8, priceGrowth: 7, years: 20,
    });
    const r = reinvest[19].totalReturn;
    assert(r < 100_000_000, `재투자 총자산 ${r}`);
    // 주식 수 n_t, 주당 배당 d_t, 주가 p_t를 따로 굴린 기준값
    let shares = 10_000_000 / 100, price = 100, dps = 3.5;
    for (let y = 0; y < 20; y++) {
      const div = shares * dps;
      price *= 1.07;
      shares += div / price;
      dps *= 1.08;
    }
    close(r, shares * price, 2);
    // 현금 수령 쪽 마지막 해 배당은 35만 × 1.08^19
    const cd = yearlyDividends(cash);
    close(cd[19], 350_000 * Math.pow(1.08, 19), 2);
  });
}

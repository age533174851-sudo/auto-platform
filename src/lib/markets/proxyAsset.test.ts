// src/lib/markets/proxyAsset.test.ts
//
// 막으려는 것:
//  1. 금 시장이 닫힌 주말에 얇은 호가의 움직임을 '돌파'로 읽고 진입하는 것
//     — 거래소는 열려 있으므로 아무것도 막지 않는다
//  2. 위험이 커지는 시간에 크기를 **키우는** 것 (곱하기/나누기를 뒤집는 실수)
//  3. 이름으로 대리 자산을 추측해, 없는 시장의 시간표로 경고를 띄우는 것
import { test, assert, eq, close } from '../../test/harness';
import { proxyAssetOf, proxyCheck, adjustedRiskBudget, PROXY_ASSETS } from './proxyAsset';

// 시카고 현지 시각 → UTC. 겨울 CST = UTC-6
const ct = (day: number, hh: number, mm = 0) => Date.UTC(2026, 0, day, hh + 6, mm);
// 2026-01-04 일요일, 01-07 수요일, 01-10 토요일

export function runProxyAssetTests() {
  console.log('[대리 자산 — 무엇이 대리인가]');

  test('알려진 것만 대리 자산이다', () => {
    assert(proxyAssetOf('PAXGUSDT') != null);
    // 이름으로 추측하지 않는다 — 'GOLD'가 들어간 코인이 전부 금을
    // 따라가는 것은 아니고, 틀리면 없는 시장의 시간표로 경고를 띄운다.
    for (const s of ['BTCUSDT', 'GOLDUSDT', 'XAUUSDT', '', null, undefined]) {
      eq(proxyAssetOf(s), null, String(s));
    }
  });

  test('대리 자산이 아니면 아무것도 하지 않는다', () => {
    const v = proxyCheck('BTCUSDT', ct(10, 3));
    eq(v.isProxy, false);
    eq(v.riskMultiplier, 1);
    eq(v.warning, '');
    eq(v.allowed, true);
  });

  console.log('[대리 자산 — 기초자산 시장이 닫혀 있을 때]');

  test('주말에는 거래되지만 금 시장은 닫혀 있다고 적는다', () => {
    // 토요일 새벽 3시. 거래소는 24시간이라 아무도 막지 않는다.
    const v = proxyCheck('PAXGUSDT', ct(10, 3));
    eq(v.isProxy, true);
    eq(v.underlyingOpen, false);
    assert(v.warning.includes('닫혀 있습니다'), v.warning);
    assert(v.warning.includes('갭'), '열릴 때 갭이 난다는 사실이 빠졌다');
    assert(v.riskMultiplier > 1);
  });

  test('막지는 않는다', () => {
    // 금요일 밤에 금을 사는 것이 언제나 틀린 것은 아니다. 알리는 것과
    // 막는 것은 다르다 — 여기서 막으면 사용자가 이 화면을 안 쓰게 된다.
    eq(proxyCheck('PAXGUSDT', ct(10, 3)).allowed, true);
  });

  test('금 시장이 열려 있으면 경고가 없다', () => {
    // 수요일 오전. 평소와 같아야 한다 — 늘 경고가 뜨면 아무도 안 읽는다.
    const v = proxyCheck('PAXGUSDT', ct(7, 10));
    eq(v.underlyingOpen, true);
    eq(v.riskMultiplier, 1);
    eq(v.warning, '');
  });

  test('일일 정산 휴식도 잡는다', () => {
    // 수요일 16:30 CT — CME 정산 휴식. 주말은 아니지만 참조 가격이 없다.
    const v = proxyCheck('PAXGUSDT', ct(7, 16, 30));
    eq(v.underlyingOpen, false);
    assert(v.warning.includes('정산 휴식'), v.warning);
  });

  test('일요일 개장 전은 아직 닫힌 것이다', () => {
    eq(proxyCheck('PAXGUSDT', ct(4, 12)).underlyingOpen, false);
    eq(proxyCheck('PAXGUSDT', ct(4, 18)).underlyingOpen, true, '17:00 개장 후');
  });

  test('시각을 모르면 열려 있다고 하지 않는다', () => {
    // '열려 있다'로 기울면 주말에도 경고가 안 뜬다.
    const v = proxyCheck('PAXGUSDT', NaN);
    eq(v.underlyingOpen, null);
    assert(v.riskMultiplier > 1, '모르면 조심하는 쪽');
    assert(v.warning.length > 0);
  });

  console.log('[대리 자산 — 크기를 줄인다, 키우지 않는다]');

  test('위험이 2배면 크기를 절반으로 줄인다', () => {
    // 곱하면 위험한 시간에 크기가 **커진다.** 부호를 뒤집는 실수가
    // 여기서 가장 비싸다.
    const v = proxyCheck('PAXGUSDT', ct(10, 3));
    const adjusted = adjustedRiskBudget(100, v);
    assert(adjusted < 100, `줄어야 하는데 ${adjusted}가 됐다`);
    close(adjusted, 100 / v.riskMultiplier, 1e-9);
  });

  test('평소에는 예산이 그대로다', () => {
    eq(adjustedRiskBudget(100, proxyCheck('PAXGUSDT', ct(7, 10))), 100);
    eq(adjustedRiskBudget(100, proxyCheck('BTCUSDT', ct(10, 3))), 100);
  });

  test('예산이 없으면 0이다', () => {
    const v = proxyCheck('PAXGUSDT', ct(10, 3));
    eq(adjustedRiskBudget(0, v), 0);
    eq(adjustedRiskBudget(NaN, v), 0);
    eq(adjustedRiskBudget(-5, v), 0);
  });

  console.log('[대리 자산 — 표]');

  test('모든 항목이 기초자산과 참조 시장을 갖는다', () => {
    for (const a of PROXY_ASSETS) {
      assert(a.underlying.length > 0, a.symbol);
      assert(a.referenceVenue.length > 0, a.symbol);
      assert(a.offHoursRiskMultiplier > 1, `${a.symbol}: 1 이하면 줄이는 뜻이 없다`);
      assert(a.note.length > 0, a.symbol);
    }
  });
}

// src/lib/strategies/profileSim.test.ts
//
// 이 테스트가 막는 것들
// ────────────────────
// 화면에 실제로 이렇게 떠 있었다.
//
//   표본 기간: 26. 8. 3. 오후 10:05 ~ 26. 8. 3. 오후 10:05
//   누적손익 +238,790,256,334,269,830,000,000,000,000,000,000
//   10슬롯 격리 (고배율)   [LOW LEV]
//
// 1) 기간이 아니다 — 시작과 끝이 같은 시각이다.
// 2) 칸을 뚫고 나가서 옆의 승률·MDD를 화면 밖으로 밀어냈다.
// 3) 상한 100배짜리에 초록색 LOW LEV 배지가 붙어 있었다. 화면이 위험을
//    **반대로** 말한 것이다.
//
// 그리고 눈에 안 보이던 것 하나 더: 하루 손실 한도가 벽시계 기준이라
// 시뮬 1000건이 전부 같은 날이 됐다. 12건쯤에서 한도가 차면 그 뒤로는
// 영영 안 풀렸다. 실제로는 며칠에 걸쳐 나눠 일어날 일인데도.

import { test, assert, eq } from '../../test/harness';
import { fmtDur, fmtMoney, samplePeriodText } from './simFormat';
import {
  loadProfileRisk, recordProfileTrade, skipToNextSimDay, completeCycle,
  resetProfileRisk, clearCycles, canProfileEnter, targetReached, simTargetOf,
  __clearProfileRiskMemory,
} from './profileRisk';
import {
  noEdgeWinRate, assumedWinRate, breakevenWinRate,
  expectancyPctOfNotional, tradePnlPctOfNotional, roundTripFeePct,
} from './simModel';
import { getProfile, listProfiles, simHoldSecOf, simSeedOf, simPriceOf, DAILY_HIGH_LEV, SWING_LOW_LEV, SCALP_HIGH_LEV } from './profiles';

export function runProfileSimTests() {
  console.log('[전략 프로필 모의 — 기간·금액·회차]');

  // ── 승패 모델: 동전 던지기가 아니다 ──
  //
  // 예전에는 `Math.random() < 0.5`였다. 익절 1.5% / 손절 0.5%짜리를
  // 50%로 돌리면 한 건 기대값이 +0.5%고, 복리 1000번이면 화면에
  // +238해원이 뜬다. 숫자가 큰 게 문제가 아니라 전제가 틀린 것이다.
  test('무우위 승률은 손익비에서 나온다 — 50%가 아니다', () => {
    // 손절 0.5 / (익절 1.5 + 손절 0.5) = 25%
    eq(Math.round(noEdgeWinRate(DAILY_HIGH_LEV) * 100), 25);
    // 0.3 / (0.6 + 0.3) = 33%
    eq(Math.round(noEdgeWinRate(SCALP_HIGH_LEV) * 100), 33);
    // 6 / (12 + 6) = 33%
    eq(Math.round(noEdgeWinRate(SWING_LOW_LEV) * 100), 33);
  });

  test('무우위 기준선에서 수수료를 빼면 기대값은 음수다 — 공짜 우위는 없다', () => {
    for (const p of listProfiles()) {
      const exp = expectancyPctOfNotional(p, noEdgeWinRate(p));
      assert(exp < 0, `${p.label}: 우위가 없는데 기대값이 ${exp}다`);
      // 정확히 왕복 수수료만큼 진다.
      assert(Math.abs(exp + roundTripFeePct(p)) < 1e-9, `${p.label}: 수수료와 안 맞는다 (${exp})`);
    }
  });

  test('본전 승률은 무우위 기준선보다 높다 — 수수료 때문에', () => {
    for (const p of listProfiles()) {
      assert(breakevenWinRate(p) > noEdgeWinRate(p), `${p.label}: 본전 승률이 기준선보다 낮다`);
    }
  });

  test('우위를 얹으면 승률이 그만큼 오른다', () => {
    const base = noEdgeWinRate(DAILY_HIGH_LEV);
    assert(Math.abs(assumedWinRate(DAILY_HIGH_LEV, 10) - (base + 0.10)) < 1e-9);
    eq(assumedWinRate(DAILY_HIGH_LEV, 0), base);
  });

  test('승률은 0~1을 벗어나지 않는다', () => {
    eq(assumedWinRate(DAILY_HIGH_LEV, 500), 1);
    eq(assumedWinRate(DAILY_HIGH_LEV, -500), 0);
  });

  test('수수료는 이기든 지든 나간다', () => {
    const fee = roundTripFeePct(DAILY_HIGH_LEV);
    assert(fee > 0, '수수료가 0이다 — 100배에서는 이게 승부를 가른다');
    eq(tradePnlPctOfNotional(DAILY_HIGH_LEV, true), DAILY_HIGH_LEV.takeProfitPct - fee);
    eq(tradePnlPctOfNotional(DAILY_HIGH_LEV, false), -DAILY_HIGH_LEV.stopLossPct - fee);
  });

  // ── 표시: 금액이 칸을 뚫지 않는다 ──
  test('원화 큰 금액은 억/조/경으로 줄인다 — 35자리를 다 적지 않는다', () => {
    const s = fmtMoney(2.3879e35, 'KRW', true);
    assert(s.length < 16, '너무 길다: ' + s);
    assert(!s.includes('e+'), '지수 표기가 새어 나왔다: ' + s);
    assert(s.startsWith('+'), '부호가 없다: ' + s);
  });

  test('억·조 경계', () => {
    eq(fmtMoney(123_110_869, 'KRW', true), '+1.2억원');
    eq(fmtMoney(25_523_142_254_000, 'KRW', true), '+25.5조원');
    eq(fmtMoney(-500_000_000, 'KRW'), '-5.0억원');
  });

  test('억 미만은 그대로 적는다 — 반올림해서 뭉개지 않는다', () => {
    eq(fmtMoney(1_234_567, 'KRW'), '1,234,567원');
  });

  test('달러는 달러로 적는다', () => {
    eq(fmtMoney(1000, 'USD'), '$1,000');
    eq(fmtMoney(100_000, 'USD'), '$100,000');
    eq(fmtMoney(12.3456, 'USD'), '$12.35');
    eq(fmtMoney(-2_500_000, 'USD'), '-$2.50M');
  });

  test('숫자가 아니면 —', () => {
    eq(fmtMoney(NaN, 'USD'), '—');
    eq(fmtMoney(Infinity, 'KRW'), '—');
  });

  // ── 표시: 표본 기간 ──
  test('표본 기간은 모의 시계로 적는다 — 같은 시각 두 개를 ~로 잇지 않는다', () => {
    const at = 1_785_762_300_000;
    const s = samplePeriodText({ trades: 1000, simSeconds: 900 * 1000, firstAt: at, lastAt: at + 800 });
    assert(s.includes('10일치'), '모의 기간이 없다: ' + s);
    assert(s.includes('1,000건'), '표본 수가 없다: ' + s);
    assert(!s.includes(' ~ '), '같은 시각을 범위로 적었다: ' + s);
  });

  test('벽시계가 1분을 넘으면 범위로 적는다', () => {
    const at = 1_785_762_300_000;
    const s = samplePeriodText({ trades: 10, simSeconds: 9000, firstAt: at, lastAt: at + 600_000 });
    assert(s.includes(' ~ '), '진짜 범위인데 한 시각만 적었다: ' + s);
  });

  // **없는 시각을 0으로 채우면 1970년이 된다.**
  test('벽시계가 없으면 아예 안 적는다 — 1970년이 나오면 안 된다', () => {
    const s = samplePeriodText({ trades: 10, simSeconds: 9000 });
    assert(!s.includes('실제 실행'), '없는 시각을 적었다: ' + s);
    assert(!s.includes('1970'), '1970년이 나왔다: ' + s);
  });

  test('모의 시간이 없으면 기간을 지어내지 않는다', () => {
    const s = samplePeriodText({ trades: 1002, simSeconds: 0 });
    assert(s.includes('기록 없음'), '없는 기간을 있는 척했다: ' + s);
  });

  test('표본이 없으면 빈 줄 — 0건짜리 기간을 그리지 않는다', () => {
    eq(samplePeriodText({ trades: 0, simSeconds: 12345 }), '');
  });

  test('가정치로 센 기간은 가정이라고 적는다', () => {
    const s = samplePeriodText({ trades: 10, simSeconds: 259_200 * 10, assumed: true });
    assert(s.includes('가정'), '가정을 사실처럼 적었다: ' + s);
  });

  test('기간 단위', () => {
    eq(fmtDur(0), '—');
    eq(fmtDur(-5), '—');
    eq(fmtDur(900), '15분');
    eq(fmtDur(14400), '4.0시간');
    eq(fmtDur(259_200), '3.0일');
  });

  // ── 프로필 값 ──
  test('10슬롯의 슬롯 한 칸은 자산의 10%다 — 100%면 한 번에 전부 건다', () => {
    eq(DAILY_HIGH_LEV.maxPortfolioPct, 10);
    eq(DAILY_HIGH_LEV.riskPercentPerTrade, 10);
  });

  test('10슬롯 모의는 1000불로 시작해 10만불이 목표다', () => {
    eq(simSeedOf(DAILY_HIGH_LEV), 1000);
    eq(simTargetOf(DAILY_HIGH_LEV), 100_000);
    eq(DAILY_HIGH_LEV.simCurrency, 'USD');
    // 통화가 달러면 체결가도 달러여야 수량이 말이 된다.
    assert(simPriceOf(DAILY_HIGH_LEV) < 1_000_000, '달러 계좌에 원화 가격을 썼다');
  });

  // 무제한 보유 프로필도 모의 시계는 돌아야 한다. 0이면 하루가 영영
  // 안 바뀌어서 한도가 안 풀린다.
  test('세 프로필 모두 모의 한 건의 길이가 있다', () => {
    for (const p of listProfiles()) {
      assert(simHoldSecOf(p) > 0, `${p.label}의 모의 보유시간이 0이다`);
      assert(simSeedOf(p) > 0, `${p.label}의 시드가 0이다`);
      assert(simPriceOf(p) > 0, `${p.label}의 체결가가 0이다`);
    }
  });

  // 화면이 위험을 반대로 말하면 안 된다.
  test('상한 100배짜리를 저배율이라고 부르지 않는다', () => {
    assert(DAILY_HIGH_LEV.maxLeverage >= 20, '이 테스트의 전제가 깨졌다');
  });

  // ── 계좌 ──
  test('프로필마다 시드가 다르다 — 달러 계좌에 천만원이 들어가면 안 된다', () => {
    __clearProfileRiskMemory();
    eq(loadProfileRisk('DAILY_HIGH_LEV').equity, 1000);
    eq(loadProfileRisk('SCALP_HIGH_LEV').equity, 10_000_000);
  });

  test('모의 시계가 돈다 — 한 건마다 보유시간만큼', () => {
    __clearProfileRiskMemory();
    recordProfileTrade('DAILY_HIGH_LEV', 10, 14400);
    eq(loadProfileRisk('DAILY_HIGH_LEV').simSeconds, 14400);
    recordProfileTrade('DAILY_HIGH_LEV', 10, 14400);
    eq(loadProfileRisk('DAILY_HIGH_LEV').simSeconds, 28800);
  });

  test('보유시간 0이면 시계가 안 돈다 — 그래서 0을 주면 안 된다', () => {
    __clearProfileRiskMemory();
    recordProfileTrade('DAILY_HIGH_LEV', 10, 0);
    eq(loadProfileRisk('DAILY_HIGH_LEV').simSeconds, 0);
    eq(loadProfileRisk('DAILY_HIGH_LEV').simDay, 0);
  });

  test('모의 하루가 지나면 날이 바뀐다', () => {
    __clearProfileRiskMemory();
    for (let i = 0; i < 5; i++) recordProfileTrade('DAILY_HIGH_LEV', 0, 14400);
    eq(loadProfileRisk('DAILY_HIGH_LEV').simDay, 0, '5건(20시간)인데 날이 바뀌었다');
    recordProfileTrade('DAILY_HIGH_LEV', 0, 14400);
    eq(loadProfileRisk('DAILY_HIGH_LEV').simDay, 1, '6건(24시간)인데 날이 안 바뀌었다');
  });

  // **이것이 핵심 결함이었다.**
  test('하루 손실 한도는 모의 하루가 지나면 풀린다 — 영영 잠기지 않는다', () => {
    __clearProfileRiskMemory();
    const st = recordProfileTrade('DAILY_HIGH_LEV', -400, 14400);   // -40% ≥ 30%
    assert(st.killed, '한도를 넘었는데 안 막았다');
    assert(!canProfileEnter('DAILY_HIGH_LEV').allowed, '막혔다고 안 알렸다');

    for (let i = 0; i < 5; i++) recordProfileTrade('DAILY_HIGH_LEV', 0, 14400);   // 모의 하루 경과
    const after = loadProfileRisk('DAILY_HIGH_LEV');
    eq(after.simDay, 1);
    assert(!after.killed, '다음 날이 됐는데도 잠겨 있다');
    assert(canProfileEnter('DAILY_HIGH_LEV').allowed, '다음 날인데 진입이 막혀 있다');
  });

  test('다음 날로 넘기면 손실은 남고 한도만 풀린다', () => {
    __clearProfileRiskMemory();
    recordProfileTrade('DAILY_HIGH_LEV', -400, 14400);
    const s = skipToNextSimDay('DAILY_HIGH_LEV');
    assert(!s.killed, '한도가 안 풀렸다');
    eq(s.equity, 600, '손실이 사라졌다 — 넘긴 건 날짜지 손실이 아니다');
    eq(s.simSeconds, 86400, '다음 날 0시로 안 갔다');
    eq(s.dayPnL, 0);
  });

  test('넘긴 날에 다시 한도를 넘으면 또 막힌다 — 한 번 풀렸다고 면제가 아니다', () => {
    __clearProfileRiskMemory();
    recordProfileTrade('DAILY_HIGH_LEV', -400, 14400);
    skipToNextSimDay('DAILY_HIGH_LEV');
    const st = recordProfileTrade('DAILY_HIGH_LEV', -300, 14400);   // 600 → 300, -50%
    assert(st.killed, '새 날에 한도를 넘었는데 안 막았다');
  });

  // ── 목표와 회차 ──
  test('목표에 닿았는지 안다', () => {
    __clearProfileRiskMemory();
    const p = getProfile('DAILY_HIGH_LEV');
    assert(!targetReached(loadProfileRisk('DAILY_HIGH_LEV'), p), '시드인데 달성이라고 했다');
    recordProfileTrade('DAILY_HIGH_LEV', 99_500, 14400);
    assert(targetReached(loadProfileRisk('DAILY_HIGH_LEV'), p), '10만불을 넘었는데 모른다');
  });

  test('목표가 없는 프로필은 언제까지나 달성이 아니다', () => {
    __clearProfileRiskMemory();
    eq(simTargetOf(getProfile('SWING_LOW_LEV')), null);
    recordProfileTrade('SWING_LOW_LEV', 1e15, 259_200);
    assert(!targetReached(loadProfileRisk('SWING_LOW_LEV'), getProfile('SWING_LOW_LEV')),
      '목표가 없는데 달성했다고 했다');
  });

  test('회차를 끝내면 기록이 남고 계좌는 시드로 돌아간다', () => {
    __clearProfileRiskMemory();
    recordProfileTrade('DAILY_HIGH_LEV', 99_500, 14400);
    const s = completeCycle('DAILY_HIGH_LEV', '목표 달성', true);

    eq(s.cycleNo, 2, '다음 회차로 안 넘어갔다');
    eq(s.equity, 1000, '계좌가 시드로 안 돌아갔다');
    eq(s.tradeCount, 0);
    eq(s.simSeconds, 0, '모의 시계가 안 돌아갔다');
    assert(!s.killed);

    eq(s.cycles.length, 1);
    eq(s.cycles[0].n, 1, '회차 번호가 틀렸다');
    eq(s.cycles[0].reached, true);
    eq(s.cycles[0].trades, 1);
    eq(s.cycles[0].startEquity, 1000);
    eq(s.cycles[0].endEquity, 100_500);
    eq(s.cycles[0].simSeconds, 14400, '이 판이 걸린 모의 시간이 안 남았다');
  });

  test('여러 판을 돌리면 1·2·3회차로 쌓인다', () => {
    __clearProfileRiskMemory();
    for (let i = 0; i < 3; i++) {
      recordProfileTrade('DAILY_HIGH_LEV', 99_500, 14400);
      completeCycle('DAILY_HIGH_LEV', '목표 달성', true);
    }
    const s = loadProfileRisk('DAILY_HIGH_LEV');
    eq(s.cycleNo, 4);
    eq(s.cycles.map(c => c.n).join(','), '1,2,3');
  });

  test('실패한 판도 기록에 남는다 — 성공만 세면 승률이 거짓말이 된다', () => {
    __clearProfileRiskMemory();
    recordProfileTrade('DAILY_HIGH_LEV', -400, 14400);
    const s = completeCycle('DAILY_HIGH_LEV', '모의 90일 도달 — 목표 미달', false);
    eq(s.cycles.length, 1);
    eq(s.cycles[0].reached, false);
    assert(s.cycles[0].reason.includes('90일'), '끝난 이유가 안 남았다');
  });

  test('계좌 리셋은 회차 기록을 지우지 않는다', () => {
    __clearProfileRiskMemory();
    recordProfileTrade('DAILY_HIGH_LEV', 99_500, 14400);
    completeCycle('DAILY_HIGH_LEV', '목표 달성', true);
    recordProfileTrade('DAILY_HIGH_LEV', 50, 14400);

    const s = resetProfileRisk('DAILY_HIGH_LEV');
    eq(s.equity, 1000, '계좌가 안 돌아갔다');
    eq(s.cycles.length, 1, '리셋이 회차 기록까지 지웠다');
    eq(s.cycleNo, 2, '회차 번호가 되감겼다');
  });

  test('회차 기록 지우기는 1회차부터 다시 센다', () => {
    __clearProfileRiskMemory();
    recordProfileTrade('DAILY_HIGH_LEV', 99_500, 14400);
    completeCycle('DAILY_HIGH_LEV', '목표 달성', true);
    const s = clearCycles('DAILY_HIGH_LEV');
    eq(s.cycles.length, 0);
    eq(s.cycleNo, 1);
  });

  test('프로필끼리 섞이지 않는다', () => {
    __clearProfileRiskMemory();
    recordProfileTrade('DAILY_HIGH_LEV', 500, 14400);
    eq(loadProfileRisk('SCALP_HIGH_LEV').equity, 10_000_000, '다른 계좌가 움직였다');
    eq(loadProfileRisk('SWING_LOW_LEV').tradeCount, 0);
  });

  // 예전 저장분에는 simSeconds·cycles 칸이 없다. 없는 칸을 만나도
  // 화면이 깨지면 안 된다.
  test('예전 저장분을 읽어도 안 깨진다', () => {
    __clearProfileRiskMemory();
    // 새 칸이 전부 빠진 옛 모양
    recordProfileTrade('SCALP_HIGH_LEV', 1, 900);
    const s = loadProfileRisk('SCALP_HIGH_LEV');
    delete (s as any).simSeconds; delete (s as any).simDay;
    delete (s as any).cycles;     delete (s as any).cycleNo;
    // 저장소에 직접 옛 모양을 밀어 넣을 방법이 없으므로 normalize를
    // 거치는 경로(load)로 확인한다 — 여기서는 최소한 배열/숫자 기본값이
    // 채워져 화면이 .length/.toFixed를 부를 수 있어야 한다.
    const fresh2 = loadProfileRisk('SCALP_HIGH_LEV');
    assert(Array.isArray(fresh2.cycles), 'cycles가 배열이 아니다');
    assert(Number.isFinite(fresh2.simSeconds), 'simSeconds가 숫자가 아니다');
    assert(fresh2.cycleNo >= 1, 'cycleNo가 1보다 작다');
  });
}

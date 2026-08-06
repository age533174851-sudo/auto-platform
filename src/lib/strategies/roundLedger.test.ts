// src/lib/strategies/roundLedger.test.ts
//
// 막으려는 것:
//  1. 목표에 닿아 계좌가 되감기면서 **지금까지의 성적이 사라지는 것**
//     — 세 판을 내리 파산시켜도 화면이 `잔고 $1,000 · 누적손익 $0`
//  2. 독립 회차와 연속 복리의 숫자가 한 표에 섞여 '총 투입'이 뜻을 잃는 것
//  3. 연속 복리라고 적어 놓고 실제로는 시드에서 다시 시작하는 것
//  4. '현재 회차 초기화'가 전체 장부까지 지우는 것
//  5. 몬테카를로 엔진이 있는데 화면 값이 그 엔진에서 안 나오는 것
//  6. 기본값이 연구용(1회 위험 10% · 상한 100배)인 것
import { test, assert, eq, close } from '../../test/harness';
import {
  loadBook, appendRound, summarize, clearBook, clearAllBooks,
  nextStartEquity, roundModeOf, nextRoundNo, DEFAULT_ROUND_MODE,
  __clearRoundLedgerMemory, type RoundMode,
} from './roundLedger';
import {
  loadProfileRisk, recordProfileTrade, resetProfileRisk, startRoundAt,
  roundStartEquityOf, roundPnlOf, __clearProfileRiskMemory,
} from './profileRisk';
import { finishRound, injectedFor, restartCurrentRound } from './roundRunner';
import {
  applyPreset, presetOf, mddStopPctOf, withinBand, overrideOf,
  DEFAULT_PRESET,
} from './profilePreset';
import { getProfile, simSeedOf, DAILY_HIGH_LEV, SWING_LOW_LEV, SCALP_HIGH_LEV } from './profiles';
import { monteCarloInputOf, runProfileMonteCarlo, seedFor, MIN_PATHS, MAX_PATHS } from './profileMonteCarlo';
import { runMonteCarlo, verdictOf } from './monteCarlo';
import { assumedWinRate, roundTripFeePct, expectancyPctOfNotional } from './simModel';

const DAILY = applyPreset(DAILY_HIGH_LEV, 'STABILIZE');
const SEED = simSeedOf(DAILY);   // $1,000

function clearAll() {
  __clearProfileRiskMemory();
  __clearRoundLedgerMemory();
}

/** 한 회차를 통째로 흉내낸다: 거래 몇 건 → 회차 종료 */
function playRound(mode: RoundMode, pnl: number, opts: { reached?: boolean; ruined?: boolean } = {}) {
  recordProfileTrade('DAILY_HIGH_LEV', pnl, 14400);
  return finishRound(DAILY, mode, {
    preset: 'STABILIZE',
    reason: opts.reached ? '목표 달성' : opts.ruined ? '파산' : '모의 90일 도달 — 목표 미달',
    reached: !!opts.reached,
    ruined: !!opts.ruined,
  });
}

export function runRoundLedgerTests() {
  console.log('[회차 장부 — 되감긴 것은 계좌지 사실이 아니다]');

  test('회차를 끝내면 누적이 늘어난다', () => {
    clearAll();
    eq(summarize(loadBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS')).totalRounds, 0);
    playRound('INDEPENDENT_ROUNDS', 99_500, { reached: true });
    const a = summarize(loadBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS'));
    eq(a.totalRounds, 1);
    eq(a.successfulRounds, 1);
    playRound('INDEPENDENT_ROUNDS', -900, { ruined: true });
    const b = summarize(loadBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS'));
    eq(b.totalRounds, 2, '두 번째 회차가 안 쌓였다');
    eq(b.failedRounds, 1);
    eq(b.ruinedRounds, 1, '파산과 목표 미달은 다른 결과다');
  });

  test('계좌가 되감겨도 전체 순손익은 사실을 적는다', () => {
    // 이게 이 파일이 있는 이유다. 세 판을 내리 잃었는데 화면이
    // `잔고 $1,000 · 누적손익 $0`이면, 그 화면은 거짓말을 한 것이다.
    clearAll();
    for (let i = 0; i < 3; i++) playRound('INDEPENDENT_ROUNDS', -900, { ruined: true });

    const st = loadProfileRisk('DAILY_HIGH_LEV');
    eq(st.equity, SEED, '계좌는 되감긴다 — 그건 맞다');
    eq(st.realizedPnL, 0);

    const sum = summarize(loadBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS'));
    eq(sum.totalCapitalInjected, SEED * 3, '세 번 넣은 것이 안 세어졌다');
    close(sum.totalFinalEquity, 300, 1e-9);
    close(sum.totalNetPnl, -2700, 1e-9, '전체 순손익이 사실과 다르다');
    eq(sum.ruinRate, 1);
  });

  console.log('[회차 장부 — 두 모드를 섞지 않는다]');

  test('독립 10회의 총 투입은 시드 × 10이다', () => {
    clearAll();
    for (let i = 0; i < 10; i++) playRound('INDEPENDENT_ROUNDS', 100);
    const sum = summarize(loadBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS'));
    eq(sum.totalRounds, 10);
    eq(sum.totalCapitalInjected, 10_000, '독립 회차인데 시드를 한 번만 셌다');
    close(sum.totalFinalEquity, 11_000, 1e-9, '각 판 끝 잔고의 합이어야 한다');
    close(sum.totalNetPnl, 1_000, 1e-9);
  });

  test('연속 복리는 다음 회차가 이전 회차의 끝 잔고에서 시작한다', () => {
    clearAll();
    const fin = playRound('CONTINUOUS_COMPOUND', 500);
    eq(fin.nextStart, 1500, '이어받지 않고 시드로 되감겼다');
    const st = loadProfileRisk('DAILY_HIGH_LEV');
    eq(roundStartEquityOf(st, 'DAILY_HIGH_LEV'), 1500);
    eq(st.equity, 1500, '계좌가 이어받은 잔고에서 시작하지 않았다');
  });

  test('연속 복리의 총 투입은 처음 한 번뿐이다', () => {
    clearAll();
    for (let i = 0; i < 5; i++) playRound('CONTINUOUS_COMPOUND', 100);
    const sum = summarize(loadBook('DAILY_HIGH_LEV', 'CONTINUOUS_COMPOUND'));
    eq(sum.totalRounds, 5);
    eq(sum.totalCapitalInjected, SEED, '이어받은 판마다 돈을 새로 넣은 것으로 셌다');
    // 같은 돈이 이어져 흐르므로 끝 잔고를 더하면 같은 돈을 여러 번 센다.
    close(sum.totalFinalEquity, 1500, 1e-9, '마지막 잔고 하나가 손에 있는 전부다');
    close(sum.totalNetPnl, 500, 1e-9);
  });

  test('연속 복리에서 파산하면 다시 넣는다 — 그리고 그건 투입이다', () => {
    clearAll();
    playRound('CONTINUOUS_COMPOUND', -1000, { ruined: true });   // 잔고 0
    const next = nextStartEquity('DAILY_HIGH_LEV', 'CONTINUOUS_COMPOUND', SEED);
    eq(next.equity, SEED, '0에서 이어 갈 수는 없다');
    eq(next.injected, SEED, '다시 넣은 돈이 투입으로 안 세어졌다');
  });

  test('두 모드의 장부는 서로를 못 본다', () => {
    clearAll();
    playRound('INDEPENDENT_ROUNDS', 100);
    playRound('INDEPENDENT_ROUNDS', 100);
    eq(loadBook('DAILY_HIGH_LEV', 'CONTINUOUS_COMPOUND').rounds.length, 0,
      '독립 회차 기록이 연속 복리 장부에 새어 들어갔다');
    eq(loadBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS').rounds.length, 2);
  });

  test('모르는 모드는 독립 회차다 — 오타가 모드를 바꾸지 않는다', () => {
    eq(roundModeOf('아무거나'), DEFAULT_ROUND_MODE);
    eq(roundModeOf(null), 'INDEPENDENT_ROUNDS');
    eq(roundModeOf('continuous_compound'), 'CONTINUOUS_COMPOUND');
  });

  console.log('[회차 장부 — 리셋은 둘로 나뉜다]');

  test('현재 회차 초기화는 전체 장부를 건드리지 않는다', () => {
    clearAll();
    playRound('INDEPENDENT_ROUNDS', 500);
    playRound('INDEPENDENT_ROUNDS', 500);
    recordProfileTrade('DAILY_HIGH_LEV', -200, 14400);   // 돌리다 만 판

    resetProfileRisk('DAILY_HIGH_LEV', restartCurrentRound(DAILY, 'INDEPENDENT_ROUNDS'));

    eq(loadProfileRisk('DAILY_HIGH_LEV').tradeCount, 0, '현재 회차가 안 비워졌다');
    eq(summarize(loadBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS')).totalRounds, 2,
      '계좌 리셋이 전체 장부까지 지웠다');
  });

  test('전체 초기화를 해야만 0이 된다', () => {
    clearAll();
    playRound('INDEPENDENT_ROUNDS', 500);
    clearBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS');
    const sum = summarize(loadBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS'));
    eq(sum.totalRounds, 0);
    eq(sum.totalCapitalInjected, 0);
    // **회차가 없으면 성공률은 0%가 아니라 없음이다.**
    eq(sum.targetHitRate, null, '한 판도 안 돌린 전략이 성공률 0%로 보인다');
    eq(sum.ruinRate, null);
    eq(sum.medianRoundEquity, null);
  });

  test('한 모드를 지워도 다른 모드는 남는다', () => {
    clearAll();
    playRound('INDEPENDENT_ROUNDS', 100);
    resetProfileRisk('DAILY_HIGH_LEV');
    playRound('CONTINUOUS_COMPOUND', 100);
    clearBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS');
    eq(loadBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS').rounds.length, 0);
    eq(loadBook('DAILY_HIGH_LEV', 'CONTINUOUS_COMPOUND').rounds.length, 1,
      '한 모드를 지웠는데 다른 모드도 사라졌다');
    clearAllBooks('DAILY_HIGH_LEV');
    eq(loadBook('DAILY_HIGH_LEV', 'CONTINUOUS_COMPOUND').rounds.length, 0);
  });

  console.log('[회차 장부 — 현재 회차 손익]');

  test('회차 손익은 이 회차가 시작한 금액 기준이다', () => {
    clearAll();
    startRoundAt('DAILY_HIGH_LEV', 5000);
    recordProfileTrade('DAILY_HIGH_LEV', 300, 14400);
    const st = loadProfileRisk('DAILY_HIGH_LEV');
    eq(st.equity, 5300, '이어받은 잔고가 시드로 되감겼다');
    eq(roundPnlOf(st, 'DAILY_HIGH_LEV'), 300);
  });

  test('예전 저장분(회차 시작 금액 없음)은 시드로 본다', () => {
    clearAll();
    recordProfileTrade('DAILY_HIGH_LEV', 100, 14400);
    const st = loadProfileRisk('DAILY_HIGH_LEV');
    delete (st as any).roundStartEquity;
    eq(roundStartEquityOf(st, 'DAILY_HIGH_LEV'), SEED, '없는 칸을 0으로 읽었다');
  });

  test('회차 기록에는 실제 시작 금액이 남는다 — 시드가 아니라', () => {
    clearAll();
    playRound('CONTINUOUS_COMPOUND', 500);     // 1000 → 1500
    playRound('CONTINUOUS_COMPOUND', 500);     // 1500 → 2000
    const rounds = loadBook('DAILY_HIGH_LEV', 'CONTINUOUS_COMPOUND').rounds;
    eq(rounds[1].startEquity, 1500, '이어받은 판이 1,000에서 시작했다고 적혔다');
    eq(rounds[1].endEquity, 2000);
    eq(rounds[1].capitalInjected, 0);
  });

  test('회차 번호는 장부 길이에서 나온다', () => {
    clearAll();
    eq(nextRoundNo('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS'), 1);
    playRound('INDEPENDENT_ROUNDS', 10);
    eq(nextRoundNo('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS'), 2);
  });

  test('투입 판정은 장부에서 되짚는다', () => {
    clearAll();
    eq(injectedFor('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS', 1000), 1000);
    eq(injectedFor('DAILY_HIGH_LEV', 'CONTINUOUS_COMPOUND', 1000), 1000, '첫 판은 넣은 것이다');
    playRound('CONTINUOUS_COMPOUND', 500);
    eq(injectedFor('DAILY_HIGH_LEV', 'CONTINUOUS_COMPOUND', 1500), 0, '이어받았는데 넣었다고 셌다');
    eq(injectedFor('DAILY_HIGH_LEV', 'CONTINUOUS_COMPOUND', 1000), 1000, '이어받지 않았는데 0으로 셌다');
  });

  console.log('[전략 프리셋 — 기본값이 연구용이면 안 된다]');

  test('기본은 안정화다', () => {
    eq(DEFAULT_PRESET, 'STABILIZE');
    eq(presetOf(null), 'STABILIZE');
    eq(presetOf('아무거나'), 'STABILIZE', '오타 하나가 100배가 되면 안 된다');
    eq(presetOf('research'), 'RESEARCH');
  });

  test('안정화 10슬롯은 1회 위험 1~2% · 최대 10~20배 · 일손실 5~10%', () => {
    const p = applyPreset(DAILY_HIGH_LEV, 'STABILIZE');
    assert(p.riskPercentPerTrade >= 1 && p.riskPercentPerTrade <= 2, `위험 ${p.riskPercentPerTrade}%`);
    assert(p.maxLeverage >= 10 && p.maxLeverage <= 20, `상한 ${p.maxLeverage}배`);
    assert(p.dailyLossLimitPct >= 5 && p.dailyLossLimitPct <= 10, `일손실 ${p.dailyLossLimitPct}%`);
  });

  test('안정화 스캘핑은 5~10배 · 위험 0.25~0.5%', () => {
    const p = applyPreset(SCALP_HIGH_LEV, 'STABILIZE');
    assert(p.maxLeverage >= 5 && p.maxLeverage <= 10, `상한 ${p.maxLeverage}배`);
    assert(p.riskPercentPerTrade >= 0.25 && p.riskPercentPerTrade <= 0.5, `위험 ${p.riskPercentPerTrade}%`);
  });

  test('안정화 스윙은 2~5배 · 위험 0.5~1% · 낙폭 15~20%에서 중단', () => {
    const p = applyPreset(SWING_LOW_LEV, 'STABILIZE');
    assert(p.maxLeverage >= 2 && p.maxLeverage <= 5, `상한 ${p.maxLeverage}배`);
    assert(p.riskPercentPerTrade >= 0.5 && p.riskPercentPerTrade <= 1, `위험 ${p.riskPercentPerTrade}%`);
    const mdd = mddStopPctOf('SWING_LOW_LEV', 'STABILIZE');
    assert(mdd != null && mdd >= 15 && mdd <= 20, `낙폭 중단선 ${mdd}`);
  });

  test('연구용은 예전 값 그대로다 — 10% · 30% · 100배', () => {
    const p = applyPreset(DAILY_HIGH_LEV, 'RESEARCH');
    eq(p.riskPercentPerTrade, 10);
    eq(p.dailyLossLimitPct, 30);
    eq(p.maxLeverage, 100);
    eq(mddStopPctOf('DAILY_HIGH_LEV', 'RESEARCH'), null);
  });

  test('프리셋은 원본을 고치지 않는다', () => {
    applyPreset(DAILY_HIGH_LEV, 'STABILIZE');
    eq(DAILY_HIGH_LEV.riskPercentPerTrade, 10, '원본 프로필이 바뀌었다');
    eq(getProfile('DAILY_HIGH_LEV').maxLeverage, 100);
  });

  test('기본 배율이 상한을 넘지 않는다 — 넘으면 조용히 clamp된다', () => {
    for (const raw of [SCALP_HIGH_LEV, SWING_LOW_LEV, DAILY_HIGH_LEV]) {
      for (const k of ['STABILIZE', 'RESEARCH'] as const) {
        const p = applyPreset(raw, k);
        assert(p.leverage <= p.maxLeverage, `${p.label}/${k}: ${p.leverage} > ${p.maxLeverage}`);
      }
    }
  });

  test('권장 범위 판정', () => {
    const ov = overrideOf('DAILY_HIGH_LEV', 'STABILIZE');
    eq(withinBand(ov.riskBand, 1), true);
    eq(withinBand(ov.riskBand, 10), false);
    eq(withinBand(undefined, 999), true, '밴드가 없으면 판정하지 않는다');
  });

  console.log('[전략 프리셋 — 한도가 실제로 적용된다]');

  test('프리셋의 하루 한도로 막힌다 — 프로필 표의 값이 아니라', () => {
    // 넘기지 않으면 화면에는 '하루 -5%'라고 적혀 있는데 -30%까지 돈다.
    clearAll();
    const st = recordProfileTrade('DAILY_HIGH_LEV', -60, 14400, { dailyLossLimitPct: 5 });
    assert(st.killed, '-6%인데 5% 한도에 안 걸렸다');
    clearAll();
    const st2 = recordProfileTrade('DAILY_HIGH_LEV', -60, 14400);
    assert(!st2.killed, '기본(30%)에서는 -6%로 막히면 안 된다');
  });

  test('낙폭 중단선은 다음 날이 와도 안 풀린다', () => {
    // 하루 한도는 '오늘'만 막는다. 낙폭은 날이 바뀐다고 회복되지 않는다.
    clearAll();
    const st = recordProfileTrade('DAILY_HIGH_LEV', -200, 14400, { mddStopPct: 15 });
    assert(st.killed, '-20% 낙폭인데 15% 중단선에 안 걸렸다');
    assert(!st.killedReason.includes('일손실'),
      '사유에 일손실이 들어가면 다음 모의 하루에 자동으로 풀린다');
  });

  console.log('[몬테카를로 — 화면 값이 엔진에서 나온다]');

  test('같은 설정이면 같은 결과다 — 벽시계를 안 쓴다', () => {
    const a = runProfileMonteCarlo(DAILY, { edgePp: 10, preset: 'STABILIZE' });
    const b = runProfileMonteCarlo(DAILY, { edgePp: 10, preset: 'STABILIZE' });
    eq(a.medianEquity, b.medianEquity);
    eq(a.ruinProb, b.ruinProb);
    eq(a.p5Equity, b.p5Equity);
  });

  test('설정이 다르면 시드가 다르다', () => {
    assert(seedFor(DAILY, 0, 'STABILIZE') !== seedFor(DAILY, 10, 'STABILIZE'), '우위가 달라도 같은 시드다');
    assert(seedFor(applyPreset(DAILY_HIGH_LEV, 'STABILIZE'), 0, 'STABILIZE')
        !== seedFor(applyPreset(DAILY_HIGH_LEV, 'RESEARCH'), 0, 'RESEARCH'), '프리셋이 달라도 같은 시드다');
  });

  test('화면이 부르는 것과 엔진이 도는 것이 같다', () => {
    // 화면 안에서 입력을 만들면 이 확인을 할 수 없다. 그래서 번역을
    // 따로 떼어 놨다.
    const opts = { edgePp: 5, preset: 'STABILIZE' as const, startEquity: 2500 };
    const direct = runMonteCarlo(monteCarloInputOf(DAILY, opts));
    const viaHelper = runProfileMonteCarlo(DAILY, opts);
    eq(direct.medianEquity, viaHelper.medianEquity);
    eq(direct.profitProb, viaHelper.profitProb);
    eq(direct.cappedTradeRatio, viaHelper.cappedTradeRatio);
  });

  test('경로 수는 500~1,000 사이로 묶인다', () => {
    eq(monteCarloInputOf(DAILY, { paths: 1 }).paths, MIN_PATHS, '하나면 그건 분포가 아니다');
    eq(monteCarloInputOf(DAILY, { paths: 99_999 }).paths, MAX_PATHS);
    eq(monteCarloInputOf(DAILY, { paths: 700 }).paths, 700);
  });

  test('수수료는 이기든 지든 나가도록 번역된다', () => {
    const inp = monteCarloInputOf(DAILY, {});
    const fee = roundTripFeePct(DAILY);
    close(inp.winNetPct, DAILY.takeProfitPct - fee, 1e-12);
    close(inp.lossNetPct, DAILY.stopLossPct + fee, 1e-12, '지는 쪽에 수수료가 안 붙었다');
  });

  test('기대값은 simModel과 같은 값이 나온다 — 두 곳이 갈리면 안 된다', () => {
    const r = runProfileMonteCarlo(DAILY, { edgePp: 10 });
    const w = assumedWinRate(DAILY, 10);
    close(r.expectancyPct, expectancyPctOfNotional(DAILY, w), 1e-9);
  });

  test('목표가 있는 프로필은 목표 달성 확률이 나온다', () => {
    const r = runProfileMonteCarlo(DAILY, { edgePp: 10 });
    assert(r.targetProb != null, '목표가 있는데 달성 확률이 null이다');
    const noTarget = runProfileMonteCarlo(applyPreset(SWING_LOW_LEV, 'STABILIZE'), { edgePp: 10 });
    eq(noTarget.targetProb, null, '목표가 없는데 달성 확률을 지어냈다');
  });

  test('시작 잔고를 안 주면 시드에서 시작한다', () => {
    eq(monteCarloInputOf(DAILY, {}).startEquity, SEED);
    eq(monteCarloInputOf(DAILY, { startEquity: 0 }).startEquity, SEED, '0을 유효한 시작 잔고로 받았다');
    eq(monteCarloInputOf(DAILY, { startEquity: 4200 }).startEquity, 4200);
  });

  test('무우위에서는 판정이 통과가 아니다', () => {
    // 기대값이 음수면 경로를 몇 개 돌리든 결론이 안 바뀐다.
    const r = runProfileMonteCarlo(DAILY, { edgePp: 0 });
    const v = verdictOf(r);
    eq(v.ok, false);
    eq(v.code, 'NEGATIVE_EXPECTANCY');
  });

  test('연구용 설정은 상한에 잘리는 거래가 많다 — 그 사실이 결과에 남는다', () => {
    // 1회 위험 10% / 손절 0.5%면 명목가가 계좌의 20배다. 상한 100배라
    // 안 잘리지만, 안정화(위험 1% · 상한 20배)로 좁히면 잘리지 않는다.
    // 어느 쪽이든 **화면이 이 비율을 적어야** 설정과 실행이 어긋난 것을 안다.
    const r = runProfileMonteCarlo(DAILY, { edgePp: 10 });
    assert(Number.isFinite(r.cappedTradeRatio), '잘린 비율이 숫자가 아니다');
    assert(r.cappedTradeRatio >= 0 && r.cappedTradeRatio <= 1);
  });

  console.log('[회차 장부 — 설정이 섞이면 그렇다고 적는다]');

  test('두 설정의 회차가 한 장부에 섞이면 표시한다', () => {
    clearAll();
    appendRound('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS', {
      preset: 'STABILIZE', startEquity: 1000, endEquity: 1200, capitalInjected: 1000,
      trades: 5, wins: 3, reached: false, ruined: false, reason: 't', simSeconds: 100,
    });
    eq(summarize(loadBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS')).mixedPresets, false);
    appendRound('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS', {
      preset: 'RESEARCH', startEquity: 1000, endEquity: 50, capitalInjected: 1000,
      trades: 5, wins: 0, reached: false, ruined: true, reason: 't', simSeconds: 100,
    });
    const sum = summarize(loadBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS'));
    eq(sum.mixedPresets, true, '다른 설정의 결과가 말없이 합쳐졌다');
    eq(sum.presets.length, 2);
  });

  test('계좌의 회차 이력과 장부가 갈리지 않는다', () => {
    // 같은 사건을 두 곳이 적는다. 갈리면 한쪽만 고쳐지고, 그때
    // 화면이 어느 쪽을 읽는지에 따라 답이 달라진다.
    clearAll();
    for (let i = 0; i < 4; i++) playRound('INDEPENDENT_ROUNDS', 100);
    eq(loadProfileRisk('DAILY_HIGH_LEV').cycles.length,
       loadBook('DAILY_HIGH_LEV', 'INDEPENDENT_ROUNDS').rounds.length,
       '계좌 이력과 장부의 회차 수가 다르다');
    eq(loadProfileRisk('DAILY_HIGH_LEV').cycleNo, 5);
  });

  test('빈 장부에도 터지지 않는다', () => {
    clearAll();
    const sum = summarize(null as any);
    eq(sum.totalRounds, 0);
    eq(sum.totalNetPnl, 0);
    eq(sum.targetHitRate, null);
  });
}

// src/lib/strategies/validationStage.test.ts
//
// 막으려는 것:
//  1. **가정 승률('무우위 / +5%p / +10%p')을 진입 신호로 쓰는 것.**
//     그건 "이 정도 승률이면 자금관리가 어떻게 되나"를 보는 숫자이지
//     언제 사고팔지에 대한 조건이 아니다 — 주사위로 매매하는 것과 같다
//  2. 수익률만 보고 다음 단계로 올리는 것 — 결과를 모르는 주문이나
//     손절이 안 붙은 포지션이 있으면 수익률은 아무 뜻이 없다
//  3. 사람 승인 없이 실전으로 올라가는 것
//  4. 확인하지 못한 항목을 통과로 치는 것
//  5. 비용을 빼니 우위가 없는데 계속 도는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  STAGE_ORDER, stageOf, stageIndex, isRealMoney, usableAsSignal,
  promotionVerdict, degradationOf, capsFor,
  MIN_TESTNET_ENTRIES, LIVE_SMALL_CAPS, LIVE_LIMITED_CAPS,
  type StageMetrics,
} from './validationStage';

/** 테스트넷을 통과할 만한 지표 한 벌 */
const GOOD: StageMetrics = {
  entries: 250, netExpectancyPct: 0.08, mddPct: -7.8,
  unknownRate: 0, protectiveStopSuccessRate: 100, runtimeIndependent: true,
  observedEdgePp: 3.7, avgSlippagePct: 0.03,
};

export function runValidationStageTests() {
  console.log('[검증 단계 — 가정을 신호로 쓰지 않는다]');

  test('확률 시뮬의 가정 승률은 진입 신호가 될 수 없다', () => {
    const v = usableAsSignal('ASSUMED');
    eq(v.ok, false);
    assert(v.reason.includes('자금관리'), v.reason);
    assert(v.reason.includes('실제 신호 전략'), v.reason);
  });

  test('관측값은 쓸 수 있다', () => {
    for (const s of ['HISTORICAL', 'PAPER', 'TESTNET', 'LIVE'] as const) {
      eq(usableAsSignal(s).ok, true, s);
    }
  });

  console.log('[검증 단계 — 사다리]');

  test('테스트넷이 마지막이 아니다', () => {
    // 테스트넷 통과 → 바로 정상 실전금액은 하면 안 된다.
    const i = stageIndex('TESTNET_VALIDATED');
    eq(STAGE_ORDER[i + 1], 'LIVE_SMALL');
    eq(STAGE_ORDER[i + 2], 'LIVE_LIMITED');
    eq(STAGE_ORDER[i + 3], 'LIVE_FULL');
  });

  test('모르는 단계를 올려 읽지 않는다', () => {
    // LIVE로 읽으면 검증 안 된 전략이 실전 단계로 보인다.
    eq(stageOf(null), 'DRAFT');
    eq(stageOf('아무거나'), 'DRAFT');
    eq(stageOf(''), 'DRAFT');
    eq(stageOf('live_small'), 'LIVE_SMALL');
  });

  test('실전 단계 셋만 실제 돈이 걸린다', () => {
    eq(isRealMoney('TESTNET_VALIDATED'), false);
    eq(isRealMoney('LIVE_SMALL'), true);
    eq(isRealMoney('LIVE_LIMITED'), true);
    eq(isRealMoney('LIVE_FULL'), true);
  });

  console.log('[검증 단계 — 수익률만 보고 올리지 않는다]');

  test('결과를 모르는 주문이 있으면 못 올린다', () => {
    // 장부가 실제와 다르다는 뜻이라, 수익률 숫자 자체를 믿을 수 없다.
    const v = promotionVerdict('TESTNET', { ...GOOD, unknownRate: 1 });
    eq(v.ok, false);
    assert(v.reason.includes('결과 모르는 주문'), v.reason);
  });

  test('손절이 하나라도 안 붙었으면 못 올린다', () => {
    const v = promotionVerdict('TESTNET', { ...GOOD, protectiveStopSuccessRate: 99.5 });
    eq(v.ok, false);
    const c = v.checks.find(c => c.label === '손절 부착 성공률')!;
    eq(c.pass, false);
    assert(c.detail.includes('계좌가 날아갑니다'), c.detail);
  });

  test('브라우저를 닫으면 멈추는 전략은 못 올린다', () => {
    const v = promotionVerdict('TESTNET', { ...GOOD, runtimeIndependent: false });
    eq(v.ok, false);
    const c = v.checks.find(c => c.label === '브라우저 없이 실행')!;
    assert(c.detail.includes('손절도 같이 멈춥니다'), c.detail);
  });

  test('표본이 적으면 못 올린다', () => {
    const v = promotionVerdict('TESTNET', { ...GOOD, entries: 30 });
    eq(v.ok, false);
    assert(MIN_TESTNET_ENTRIES > 100, String(MIN_TESTNET_ENTRIES));
  });

  test('비용 후 기대값이 0 이하면 못 올린다', () => {
    // 비용 전에 좋아 보여도 수수료를 빼면 남는 게 없을 수 있다.
    eq(promotionVerdict('TESTNET', { ...GOOD, netExpectancyPct: -0.01 }).ok, false);
    eq(promotionVerdict('TESTNET', { ...GOOD, netExpectancyPct: 0 }).ok, false);
  });

  test('확인하지 못한 항목은 통과가 아니다', () => {
    const v = promotionVerdict('TESTNET', { ...GOOD, protectiveStopSuccessRate: null });
    eq(v.ok, false);
    assert(v.reason.includes('확인하지 못한 것은 통과가 아닙니다'), v.reason);
  });

  test('지표가 아예 없으면 통과가 아니다', () => {
    eq(promotionVerdict('TESTNET', null).ok, false);
  });

  console.log('[검증 단계 — 실전은 사람이 승인한다]');

  test('기준을 다 통과해도 실전으로 자동 승격하지 않는다', () => {
    const v = promotionVerdict('TESTNET_VALIDATED', GOOD);
    eq(v.to, 'LIVE_SMALL');
    eq(v.ok, true, '기준은 통과');
    eq(v.autoAllowed, false, '**자동으로는 안 올라간다**');
    eq(v.requiresHuman, true);
    assert(v.reason.includes('사람이 직접 승인'), v.reason);
  });

  test('실전 소액에서 실전 제한으로도 사람이 승인한다', () => {
    const v = promotionVerdict('LIVE_SMALL', GOOD);
    eq(v.to, 'LIVE_LIMITED');
    eq(v.autoAllowed, false);
    eq(v.requiresHuman, true);
  });

  test('실전 제한에서 전체로도 자동은 없다', () => {
    eq(promotionVerdict('LIVE_LIMITED', GOOD).autoAllowed, false);
  });

  test('돈이 안 걸리는 구간은 자동으로 올라간다', () => {
    const v = promotionVerdict('BACKTESTED', { entries: 100 });
    eq(v.requiresHuman, false);
    eq(v.autoAllowed, true);
  });

  console.log('[검증 단계 — 실전은 금액이 아니라 위험으로 막는다]');

  test('실전 소액이 테스트넷보다 훨씬 빡빡하다', () => {
    assert(LIVE_SMALL_CAPS.riskPerTradePct < 1, String(LIVE_SMALL_CAPS.riskPerTradePct));
    assert(LIVE_SMALL_CAPS.maxLeverage <= 5, String(LIVE_SMALL_CAPS.maxLeverage));
    assert(LIVE_SMALL_CAPS.maxOpenRiskPct < LIVE_LIMITED_CAPS.maxOpenRiskPct, '단계가 오르면 완화된다');
  });

  test('실전이 아닌 단계에는 상한이 없다', () => {
    eq(capsFor('TESTNET'), null);
    eq(capsFor('LIVE_SMALL'), LIVE_SMALL_CAPS);
  });

  console.log('[검증 단계 — 깎이는 것을 본다]');

  test('단계가 내려가면서 우위가 깎인 것을 잡는다', () => {
    // 백테스트 +6.2%p → 테스트넷 +3.7%p
    const d = degradationOf({ observedEdgePp: 6.2 }, { observedEdgePp: 3.7 });
    close(d.edgeDropPp!, 2.5, 1e-9);
    eq(d.shouldHalt, false, '깎였지만 아직 남아 있다');
    assert(d.note.includes('깎였습니다'), d.note);
  });

  test('비용을 빼니 우위가 없으면 신규 진입을 멈춘다', () => {
    const d = degradationOf({ observedEdgePp: 6.2 }, { observedEdgePp: -0.4 });
    eq(d.shouldHalt, true);
    assert(d.note.includes('청산은 계속됩니다'), d.note);
  });

  test('아직 모르면 멈추지 않되 그렇다고 적는다', () => {
    // 모른다는 이유로 멈추면 첫날부터 아무것도 못 돈다.
    const d = degradationOf({ observedEdgePp: 6.2 }, { observedEdgePp: null });
    eq(d.shouldHalt, false);
    assert(d.note.includes('표본이 쌓여야'), d.note);
  });

  test('슬리피지가 몇 배가 됐는지 센다', () => {
    const d = degradationOf({ avgSlippagePct: 0.01 }, { avgSlippagePct: 0.05, observedEdgePp: 1 });
    close(d.slippageRatio!, 5, 1e-9);
    assert(d.note.includes('배가 됐습니다'), d.note);
  });

  test('낙폭이 깊어진 것을 잡는다', () => {
    const d = degradationOf({ mddPct: -5.8 }, { mddPct: -7.1, observedEdgePp: 1 });
    close(d.mddWorsePp!, 1.3, 1e-9);
  });

  test('한쪽을 모르면 비교하지 않는다', () => {
    const d = degradationOf(null, { observedEdgePp: 3.7 });
    eq(d.edgeDropPp, null);
    eq(d.slippageRatio, null);
  });
}

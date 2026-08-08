// src/lib/engine/reconcileEvidence.test.ts
//
// **자동 대조 여섯 항목이 전부 "점검 항목을 찾지 못했습니다"로 떴다.**
//
// 실제 포지션 · 실제 배율 · 포지션 모드 · 청산가 · 보호 주문 · 잔고·증거금.
// 서버는 멀쩡히 조회하고 있었고, 화면이 그 결과를 못 읽고 있었다. 세 군데가
// 어긋나 있었다:
//
//   1. `checklist`는 배열이 아니라 **객체**다. 항목은 `.results`에 있다
//   2. 상태 칸 이름은 `state`가 아니라 **`status`**이고,
//      값은 'ok'가 아니라 **'pass' | 'warn' | 'fail' | 'unknown'**이다
//   3. id를 부분 문자열로 찾고 있었다 — 'mode'는 POSITION_MODE보다
//      운영 모드(MODE)에 먼저 걸리고, 'balance'는 아무 항목에도 안 걸린다
//
// 세 번째가 특히 나쁘다. 고쳐도 조용히 **다른 항목의 결과를 보여 준다.**
// 그래서 이 파일은 화면이 쓰는 짝을 값으로 못 박는다.

import { test, eq, assert } from '../../test/harness';
import { RECONCILE_STEPS, reconcileRunOf, type StepResult } from './reconcilePlan';
import { runChecklist, CHECK_SPECS, type CheckId } from './preTradeChecklist';

/**
 * 화면(AutotradeControl)이 쓰는 짝. **여기와 화면이 같아야 한다.**
 *
 * 부분 일치를 쓰지 않는 이유가 이 표에 그대로 있다 — POSITION_MODE와 MODE는
 * 부분 문자열로 구분되지 않고, 잔고 항목의 id에는 'balance'가 없다.
 */
const STEP_TO_CHECK: Array<[string, CheckId]> = [
  ['POSITIONS', 'EXISTING_POSITION'],
  ['LEVERAGE', 'LEVERAGE'],
  ['POSITION_MODE', 'POSITION_MODE'],
  ['LIQUIDATION', 'LIQUIDATION_DISTANCE'],
  ['PROTECTIVE_STOP', 'PROTECTIVE_ORDER'],
  ['BALANCE', 'MARGIN_SUFFICIENT'],
];

/** Gate TESTNET에서 값을 다 읽어 온 상태 */
const fullInput = () => ({
  mode: { disposition: 'SEND' as const, reason: '주문을 보냅니다' },
  clock: { localMs: 1_700_000_000_000, serverMs: 1_700_000_000_100 },
  reconcile: { reachable: true, blockNewOrders: false, summary: '일치' },
  unresolvedOrderCount: 0,
  marginType: 'isolated',
  leverage: { actual: 10, intended: 10 },
  existingPositionQty: 0.5,
  positionMode: { mode: 'ONE_WAY' as const },
  protectiveOrders: { count: 1, reason: 'BTC_USDT 보호 주문 1건' },
  stopPrice: 60000,
  liquidationPrice: 55000,
  side: 'LONG' as const,
  margin: { required: 100, available: 1000 },
  todayEntry: { alreadyTraded: false },
});

const byId = (v: any) => new Map(v.results.map((r: any) => [r.id, r]));

export function runReconcileEvidenceTests() {
  console.log('[자동 대조 — 여섯 항목이 결과에 실제로 있는가]');

  test('여섯 항목이 모두 점검 결과에 나온다 — 하나라도 없으면 화면이 "찾지 못했습니다"가 된다', () => {
    const v = runChecklist(fullInput() as any, { market: 'USDM', intent: 'ENTRY', dailyLimit: true, exchangeEvidence: true });
    const m = byId(v);
    for (const [step, checkId] of STEP_TO_CHECK) {
      assert(m.has(checkId), `${step} → ${checkId} 항목이 결과에 없다`);
    }
  });

  test('짝지은 id가 점검 목록에 실제로 정의돼 있다', () => {
    const defined = new Set(CHECK_SPECS.map(s => s.id));
    for (const [, checkId] of STEP_TO_CHECK) {
      assert(defined.has(checkId), `${checkId}가 CHECK_SPECS에 없다`);
    }
  });

  test('대조 단계 id도 실제로 정의돼 있다', () => {
    const defined = new Set(RECONCILE_STEPS.map(s => s.id));
    for (const [step] of STEP_TO_CHECK) {
      assert(defined.has(step as any), `${step}가 RECONCILE_STEPS에 없다`);
    }
  });

  test('부분 문자열로 찾으면 틀린 항목을 가리킨다 — 그래서 정확한 id를 쓴다', () => {
    const v = runChecklist(fullInput() as any, { market: 'USDM', intent: 'ENTRY', dailyLimit: true, exchangeEvidence: true });
    const ids: string[] = v.results.map((r: any) => String(r.id));

    // 'mode'로 찾으면 POSITION_MODE가 아니라 운영 모드(MODE)가 먼저 걸린다.
    const byNeedle = ids.find(id => id.toLowerCase().includes('mode'));
    assert(byNeedle !== 'POSITION_MODE',
      '부분 일치가 우연히 맞아떨어지면 이 테스트의 의미가 없다 — 순서가 바뀌었는지 확인할 것');

    // 'balance'는 **아무 항목에도** 없다. 잔고 항목의 id는 MARGIN_SUFFICIENT다.
    eq(ids.some(id => id.toLowerCase().includes('balance')), false,
      "'balance'를 포함하는 항목이 생겼다 — 화면의 짝을 다시 확인할 것");
  });

  console.log('[자동 대조 — 못 읽으면 통과가 아니다]');

  test('포지션 모드를 못 읽으면 신규 진입을 막는다', () => {
    const inp: any = { ...fullInput(), positionMode: { mode: null, reason: '조회 실패' } };
    const v = runChecklist(inp, { market: 'USDM', intent: 'ENTRY', dailyLimit: true, exchangeEvidence: true });
    const hit: any = byId(v).get('POSITION_MODE');
    eq(hit.status, 'unknown');
    eq(hit.blocks, true, '모르는데 진입이 통과됐다');
    eq(v.allowed, false);
  });

  test('보호 주문을 못 읽으면 신규 진입을 막는다 — 0과 모름은 다르다', () => {
    const inp: any = { ...fullInput(), protectiveOrders: { count: null, reason: '조회 실패' } };
    const v = runChecklist(inp, { market: 'USDM', intent: 'ENTRY', dailyLimit: true, exchangeEvidence: true });
    const hit: any = byId(v).get('PROTECTIVE_ORDER');
    eq(hit.status, 'unknown');
    eq(hit.blocks, true);
  });

  test('포지션이 있는데 거래소에 보호 주문이 0건이면 막는다', () => {
    const inp: any = { ...fullInput(), protectiveOrders: { count: 0 } };
    const v = runChecklist(inp, { market: 'USDM', intent: 'ENTRY', dailyLimit: true, exchangeEvidence: true });
    const hit: any = byId(v).get('PROTECTIVE_ORDER');
    eq(hit.status, 'fail');
    eq(hit.blocks, true);
  });

  test('포지션이 없으면 보호 주문이 없어도 막지 않는다 — 아직 지킬 것이 없다', () => {
    const inp: any = { ...fullInput(), existingPositionQty: 0, protectiveOrders: { count: 0 } };
    const v = runChecklist(inp, { market: 'USDM', intent: 'ENTRY', dailyLimit: true, exchangeEvidence: true });
    const hit: any = byId(v).get('PROTECTIVE_ORDER');
    eq(hit.status, 'pass');
    eq(hit.blocks, false);
  });

  test('계획에 손절가가 있어도 거래소에 없으면 통과가 아니다 — 둘은 다른 질문이다', () => {
    // stopPrice(계획)는 멀쩡한데 거래소에는 아무것도 없는 상태.
    const inp: any = { ...fullInput(), stopPrice: 60000, protectiveOrders: { count: 0 } };
    const v = runChecklist(inp, { market: 'USDM', intent: 'ENTRY', dailyLimit: true, exchangeEvidence: true });
    const m = byId(v);
    eq((m.get('STOP_ATTACHED') as any).status, 'pass', '계획의 손절가는 멀쩡하다');
    eq((m.get('PROTECTIVE_ORDER') as any).status, 'fail', '거래소에는 없다 — 여기서 잡혀야 한다');
  });

  test('청산은 이 둘로 막지 않는다 — 못 닫게 만들면 안 된다', () => {
    const inp: any = {
      ...fullInput(),
      positionMode: { mode: null, reason: '조회 실패' },
      protectiveOrders: { count: null, reason: '조회 실패' },
    };
    const v = runChecklist(inp, { market: 'USDM', intent: 'EXIT', exchangeEvidence: true });
    const m = byId(v);
    // 포지션 모드는 청산 목록에도 남는다 — 사실은 보여 주되 **막지는 않는다.**
    const pm: any = m.get('POSITION_MODE');
    if (pm) eq(pm.blocks, false, '청산인데 포지션 모드가 막았다 — 못 닫게 만들면 안 된다');
    eq(m.has('PROTECTIVE_ORDER'), false, '청산 목록에 보호 주문이 들어갔다');
    // 이 둘 때문에 청산이 막히지 않아야 한다.
    eq(v.blockers.some((b: any) => String(b).includes('보호 주문')), false);
  });

  console.log('[자동 대조 — UNKNOWN은 완료가 아니다]');

  test('UNKNOWN이 하나라도 있으면 대조 완료가 아니다', () => {
    const results: StepResult[] = RECONCILE_STEPS.map(s => ({ id: s.id, state: 'OK' as const }));
    results[5] = { id: 'LEVERAGE', state: 'UNKNOWN', detail: '배율을 못 읽었습니다' };
    const run = reconcileRunOf(results);
    eq(run.completed, false, 'UNKNOWN인데 완료로 적혔다');
    eq(run.totalFixed, null, '못 읽은 단계가 있는데 합계를 냈다');
    assert(run.remaining.some(x => x.includes('확인하지 못했습니다')),
      `모름이라고 적혀야 한다: ${run.remaining.join(' / ')}`);
  });

  test('멈추는 단계에서 UNKNOWN이면 실패와 똑같이 멈춘다', () => {
    // POSITIONS는 continueOnFail이 false다 — 못 읽으면 뒤 비교가 뜻을 잃는다.
    const results: StepResult[] = RECONCILE_STEPS.map(s => ({ id: s.id, state: 'OK' as const }));
    const i = RECONCILE_STEPS.findIndex(s => s.id === 'POSITIONS');
    results[i] = { id: 'POSITIONS', state: 'UNKNOWN' };
    const run = reconcileRunOf(results);
    eq(run.stoppedAt, 'POSITIONS');
  });

  test('전부 OK면 완료다 — 새 상태가 기존 통과를 깨지 않는다', () => {
    const results: StepResult[] = RECONCILE_STEPS.map(s => ({ id: s.id, state: 'OK' as const }));
    const run = reconcileRunOf(results);
    eq(run.completed, true);
    eq(run.stoppedAt, null);
  });
}

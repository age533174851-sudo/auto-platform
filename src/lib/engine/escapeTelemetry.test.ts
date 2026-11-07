// src/lib/engine/escapeTelemetry.test.ts
//
// **⑤B-3A-1 — 닫는 데 얼마나 걸렸는지 제대로 재는가.**
//
// 여기서 지키는 것의 절반은 "하지 않는다"다: wall-clock으로 duration을
//만들지 않는다, 체결가를 버리지 않는다, 첫 재조회를 실제 flat이라고
// 부르지 않는다, 계측 때문에 경로에 await를 끼우지 않는다.
import { test, assert, eq } from '../../test/harness';
import { runExitAuthority, type ExitRunDeps } from './exitAuthorityRun';
import { closeSlippage } from './closeSlippage';
import { monotonicSpanMs, startSpan } from '../system/monotonicClock';
import {
  escapeObservationRow, recordEscapeObservation,
  type EscapeObservationInput,
} from './escapeObservationStore';

const NOW = 1_780_000_000_000;
const EXACT100X = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 };
const FOUR_H = 4 * 3600 * 1000;

const candidate = (over: any = {}) => ({
  positionIdentity: {
    exchange: 'binance' as const, connectionId: 'conn-1', symbol: 'BTCUSDT',
    side: 'LONG' as const, executionIdentity: EXACT100X, openingOrderId: 'ord-1',
  },
  strategyId: 'scalp', executionIdentity: EXACT100X,
  capabilities: { fixedStopAtEntry: false, breakEven: false, trailing: false,
    timeExit: true, emergency: false },
  reason: 'TIME_EXIT' as const, openedAtMs: NOW - FOUR_H, ...over,
});

/** 단조 눈금을 호출마다 1씩 전진 — 구간이 섞이면 바로 드러난다 */
function mono() { let t = 0; return () => (t += 1); }

function rig(over: Partial<ExitRunDeps> = {}, opts: { avg?: number | null; noAvg?: boolean; found?: boolean } = {}) {
  const log: string[] = [];
  const deps: ExitRunDeps = {
    leaseOwned: async () => { log.push('lease'); return { owned: true, identity: { holder: 'w', fence: 1 } }; },
    prepareClose: async () => { log.push('prepare'); return { code: 'READY' as const, message: '',
      prepared: { quantity: 1, orderSide: 'SELL' as const, reduceOnly: true as const,
        observedQty: 1, positionMode: 'ONE_WAY' as const } }; },
    revalidateFence: async () => { log.push('revalidate'); return true; },
    sendClose: async () => { log.push('send'); return { attempted: true, ok: true, error: null,
      ...(opts.noAvg ? {} : { reportedAvgPrice: opts.avg === undefined ? 49_900 : opts.avg }) }; },
    readAfter: async () => { log.push('readAfter'); return { ok: true, found: opts.found ?? false }; },
    monotonicNowMs: mono(),
    ...over,
  };
  return { deps, log };
}

export function runEscapeTelemetryTests() {
  console.log('\n⏱  ⑤B-3A-1 탈출 계측 (닫는 데 얼마나 걸리는가)');

  test('구간마다 따로 잰다 — 하나로 뭉개지 않는다', async () => {
    const { deps } = rig();
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'CLOSED_VERIFIED');
    const t = r.timing;
    for (const k of ['leaseCheckElapsedMs', 'prepareCloseElapsedMs',
                     'fenceRevalidationElapsedMs', 'criticalWindowElapsedMs',
                     'submitElapsedMs', 'submitAcceptedToFirstReadAfterMs'] as const) {
      assert(t[k] != null, `★ ${k}를 재지 않았다`);
    }
  });

  test('★ critical window를 0으로 적지 않는다 — 실제로 잰다', async () => {
    const { deps } = rig();
    const r = await runExitAuthority(candidate(), deps, NOW);
    assert(r.timing.criticalWindowElapsedMs != null,
      '★ 왕복이 0이라고 측정을 생략했다');
    // 눈금이 1씩 오르는 시계라 실제로 잰 구간은 0보다 크다.
    assert((r.timing.criticalWindowElapsedMs ?? -1) > 0,
      `★ 재지 않고 0을 적었다 (${r.timing.criticalWindowElapsedMs})`);
  });

  test('★ 계측이 재검증→전송 사이에 await를 끼우지 않는다', async () => {
    const { deps, log } = rig();
    await runExitAuthority(candidate(), deps, NOW);
    eq(log.join('→'), 'lease→prepare→revalidate→send→readAfter',
      '★ 계측 때문에 경로 순서가 바뀌었다');
    const i = log.indexOf('revalidate');
    eq(log[i + 1], 'send', '★ 재검증과 전송 사이에 무언가 끼었다');
  });

  test('★ 거래소가 준 평균가를 **버리지 않는다**', async () => {
    const { deps } = rig({}, { avg: 49_900 });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.reportedAvgPrice, 49_900);
  });

  test('★ 평균가가 0이거나 없으면 null이다 — 0으로 적지 않는다', async () => {
    for (const avg of [0, null, NaN, -1]) {
      const { deps } = rig({}, { avg: avg as any });
      const r = await runExitAuthority(candidate(), deps, NOW);
      eq(r.reportedAvgPrice, null, `평균가 ${String(avg)}`);
    }
    // 칸 자체가 없는 응답(Gate 경로)도 null이다.
    const { deps } = rig({}, { noAvg: true });
    eq((await runExitAuthority(candidate(), deps, NOW)).reportedAvgPrice, null, '칸 없음');
  });

  test('★ 첫 재조회를 실제 flat 시각이라고 부르지 않는다', async () => {
    const flat = await runExitAuthority(candidate(), rig({}, { found: false }).deps, NOW);
    eq(flat.timing.flatObservedAtFirstRead, true);
    // 아직 남아 있으면 **실제 flat 시점은 모른다**.
    const left = await runExitAuthority(candidate(), rig({}, { found: true }).deps, NOW);
    eq(left.timing.flatObservedAtFirstRead, false);
    // `actualTimeToFlatMs` 칸을 만들지 않았다.
    for (const r of [flat, left]) {
      eq('actualTimeToFlatMs' in (r.timing as any), false,
        '★ 첫 재조회 지연을 실제 flat 시간이라고 이름 지었다');
    }
  });

  test('★ 실행하지 않은 회차는 구간이 비어 있다 — 0으로 채우지 않는다', async () => {
    const { deps } = rig({ leaseOwned: async () => ({ owned: false, identity: null, reason: 'x' }) });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.attemptedWrite, false);
    eq(r.timing.submitElapsedMs, null, '★ 보내지도 않았는데 전송 시간을 적었다');
    eq(r.timing.criticalWindowElapsedMs, null);
    eq(r.reportedAvgPrice, null);
  });

  test('★ 단조 시계가 없으면 재지 않는다 — Date.now로 메우지 않는다', async () => {
    const { deps } = rig({ monotonicNowMs: () => null });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'CLOSED_VERIFIED', '측정 실패가 종료를 막지 않는다');
    for (const k of Object.keys(r.timing)) {
      if (k === 'flatObservedAtFirstRead') continue;
      eq((r.timing as any)[k], null, `★ ${k}를 지어냈다`);
    }
  });

  // ── 슬리피지 ──

  test('★ 불리하면 양수다 — 방향이 섞이지 않는다', () => {
    // LONG 종료 = SELL. 싸게 팔렸으면 불리.
    eq(closeSlippage({ side: 'LONG', markPrice: 50_000, fillPrice: 49_900 })
      .adverseCloseSlippagePct, 0.2);
    // SHORT 종료 = BUY. 비싸게 샀으면 불리.
    eq(closeSlippage({ side: 'SHORT', markPrice: 50_000, fillPrice: 50_100 })
      .adverseCloseSlippagePct, 0.2);
    // 유리하게 체결되면 음수. 있을 수 있는 일이다.
    assert((closeSlippage({ side: 'LONG', markPrice: 50_000, fillPrice: 50_100 })
      .adverseCloseSlippagePct ?? 0) < 0);
  });

  test('★ 한쪽이라도 없으면 null이다 — 0이 아니다', () => {
    for (const i of [
      { side: 'LONG' as const, markPrice: null, fillPrice: 49_900 },
      { side: 'LONG' as const, markPrice: 50_000, fillPrice: null },
      { side: 'LONG' as const, markPrice: 0, fillPrice: 49_900 },
      { side: null as any, markPrice: 50_000, fillPrice: 49_900 },
    ]) {
      const r = closeSlippage(i);
      eq(r.adverseCloseSlippagePct, null,
        `★ 모르는 슬리피지를 0으로 적었다 — 분포가 0으로 쏠린다`);
      assert(r.code !== 'MEASURED');
    }
  });

  test('★ 슬리피지 helper에 문턱이 없다', async () => {
    const src = await import('./closeSlippage');
    const r = closeSlippage({ side: 'LONG', markPrice: 50_000, fillPrice: 49_900 });
    for (const k of Object.keys(r)) {
      assert(!/threshold|tolerance|ok|good|bad|limit/i.test(k),
        `★ 슬리피지 결과에 판정 칸이 있다 (${k})`);
    }
    eq(Object.keys(src).includes('closeSlippage'), true);
  });

  // ── 단조 시계 정본 ──

  test('★ 눈금이 없으면 span은 null이다', () => {
    eq(monotonicSpanMs(null, 5), null);
    eq(monotonicSpanMs(5, null), null);
    eq(monotonicSpanMs(NaN, 5), null);
    eq(monotonicSpanMs(1, 5), 4);
  });

  test('★ startSpan은 await를 추가하지 않는다', () => {
    let calls = 0;
    const s = startSpan(() => { calls += 1; return calls; });
    eq(calls, 1, '시작 눈금 하나');
    eq(s.elapsedMs(), 1);
    eq(calls, 2, '끝 눈금 하나 — 그 사이에 아무것도 부르지 않는다');
  });

  // ── 적재 ──

  const escInput = (over: Partial<EscapeObservationInput> = {}): EscapeObservationInput => ({
    sampleOrigin: 'SYNTHETIC_TEST_ONLY', env: 'TESTNET',
    connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG',
    executionIdentity: EXACT100X,
    wakeSource: 'worker', wakeDelayMs: null, configuredIntervalMs: 300_000,
    observation: { markReadElapsedMs: 12, bracketReadElapsedMs: 8,
      positionRiskElapsedMs: 74, riskMeasurementElapsedMs: 0.4 },
    timing: { leaseCheckElapsedMs: 5, prepareCloseElapsedMs: 180,
      fenceRevalidationElapsedMs: 6, criticalWindowElapsedMs: 0.2,
      submitElapsedMs: 210, submitAcceptedToFirstReadAfterMs: 90,
      flatObservedAtFirstRead: true },
    runCode: 'CLOSED_VERIFIED', attemptedWrite: true, accepted: true,
    flatVerified: true, requestedQuantity: 1,
    reportedAvgPrice: 49_900, exchangeOrderId: 'o-1', executedQty: 1,
    markAtSubmit: 50_000,
    signedPositionAmt: 1, testnet: true, exchange: 'binance', ...over,
  });

  function fakeDb(over: { error?: any } = {}) {
    const rows: any[] = [];
    return { rows, sb: { from: (table: string) => ({
      insert: async (row: any) => { rows.push({ table, row }); return { error: over.error ?? null }; },
    }) } };
  }

  test('★ 종료 계측은 위험 스냅숏 표와 다른 표에 적는다', async () => {
    const { sb, rows } = fakeDb();
    const r = await recordEscapeObservation(sb, escInput());
    eq(r.code, 'RECORDED');
    eq(rows[0].table, 'exact100x_exit_escape_observations',
      '★ 성격이 다른 두 시계열을 한 표에 섞었다');
  });

  test('★ 보낸 수량과 체결 수량을 다른 칸에 적는다', () => {
    const row = escapeObservationRow(escInput({ requestedQuantity: 1, executedQty: 0.6 }));
    eq(row.requested_quantity, 1);
    eq(row.executed_qty, 0.6);
    assert(row.requested_quantity !== row.executed_qty,
      '★ 보낸 수량을 체결 수량으로 적었다');
  });

  test('★ 슬리피지는 적재기가 아니라 정본이 계산한다', () => {
    const row = escapeObservationRow(escInput());
    eq(row.adverse_close_slippage_pct, 0.2);
    // 마크가가 없으면 null — 지어내지 않는다.
    eq(escapeObservationRow(escInput({ markAtSubmit: null })).adverse_close_slippage_pct, null);
  });

  test('★ wake source를 추측하지 않는다', () => {
    eq(escapeObservationRow(escInput({ wakeSource: 'github-actions' })).wake_source,
      'github-actions');
    eq(escapeObservationRow(escInput({ wakeSource: null })).wake_source, null);
    // 모르는 지연을 5분 기준으로 추정하지 않는다.
    eq(escapeObservationRow(escInput({ wakeDelayMs: null })).wake_delay_ms, null);
  });

  test('★ LIVE·MOCK을 VERIFIED_TESTNET으로 적을 수 없다', async () => {
    for (const env of ['LIVE', 'MOCK'] as const) {
      const { sb, rows } = fakeDb();
      const r = await recordEscapeObservation(sb, escInput({
        sampleOrigin: 'VERIFIED_TESTNET_OBSERVATION', env }));
      eq(r.code, 'ORIGIN_IMPOSSIBLE', env);
      eq(rows.length, 0);
    }
  });

  test('★ 다른 계약의 종료를 Exact100X 표본에 섞지 않는다', async () => {
    const { sb, rows } = fakeDb();
    const r = await recordEscapeObservation(sb, escInput({
      sampleOrigin: 'VERIFIED_TESTNET_OBSERVATION',
      executionIdentity: { profileId: 'SCALP_HIGH_LEV', presetId: 'STABILIZE',
        contractVersion: 2 },
    }));
    eq(r.code, 'NOT_ELIGIBLE');
    eq(r.eligibility, 'IDENTITY_MISMATCH');
    eq(rows.length, 0);
  });

  test('★ 적재기에 거래소를 바꿀 수단이 없다', async () => {
    const src = await import('./escapeObservationStore');
    for (const bad of ['sendClose', 'sendSymbolClose', 'placeFuturesOrder',
                       'runExitAuthority', 'closePosition']) {
      eq(Object.keys(src).includes(bad), false, `★ ${bad}를 내보낸다`);
    }
  });

  test('★ 계측 줄에 시크릿·문턱 칸이 없다', () => {
    const row = escapeObservationRow(escInput());
    for (const k of Object.keys(row)) {
      assert(!/key|secret|signature|token|passphrase|raw/i.test(k), `시크릿성 칸 (${k})`);
      assert(!/threshold|tolerance|should|verdict/i.test(k), `판정 칸 (${k})`);
      assert(!/actual_time_to_flat/i.test(k), `★ 실제 flat 시간 칸을 만들었다 (${k})`);
    }
  });

  test('★ 적재 실패를 성공으로 적지 않는다', async () => {
    const { sb } = fakeDb({ error: { message: 'denied' } });
    eq((await recordEscapeObservation(sb, escInput())).code, 'WRITE_FAILED');
  });
}

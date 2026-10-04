// src/lib/engine/riskObservationStore.test.ts
//
// **⑤B-2 — 실측과 주입값을 섞으면 통계가 거짓이 된다.**
//
// 이 파일이 지키는 것의 절반은 "적지 않는다"다. 출처를 모르면 적지
// 않고, 주문 수단을 들지 않고, 090 원본을 갱신하지 않는다.
import { test, assert, eq } from '../../test/harness';
import {
  recordRiskObservation, riskObservationRow,
  type RiskObservationInput,
} from './riskObservationStore';
import type { PostEntryRiskMeasurement } from './postEntryRisk';

const N = 1_780_000_000_000;

const MEASUREMENT = {
  status: 'MEASURED', reason: '', internalTrustworthy: true,
  side: 'LONG', markPrice: 50_000,
  exchangeLiquidationPrice: 49_700, estimatedLiquidationPrice: 49_690,
  exchangeHeadroomPct: 0.6, estimatedHeadroomPct: 0.62,
  absoluteDelta: 10, deltaPct: 0.0201,
  liquidationSources: 'BOTH_AVAILABLE',
  entryAdverseDistancePct: 0.4, entryLiquidationDistancePctRaw: 0.6,
  provenance: {
    positionRiskSource: 'V2',
    positionRiskRequestStartedAtMs: N - 180, positionRiskReceivedAtMs: N - 100,
    positionRiskWallClockDeltaMs: 80,
    positionRiskElapsedMs: 74, accountElapsedMs: null, helperElapsedMs: 74,
    accountRequestStartedAtMs: null, accountReceivedAtMs: null,
    positionUpdateTimeMs: N - 3_600_000,
    markExchangeTimeMs: N - 200, markReceivedAtMs: N - 150,
    markObservedAtMs: N - 150, bracketObservedAtMs: N - 60_000,
  },
  freshness: { code: 'OK' } as any,
  internal: { code: 'ADVERSE_DISTANCE_UNKNOWN', entryTierIndex: 1,
    tier: { mmr: 0.005, maintAmount: 50 } } as any,
} as unknown as PostEntryRiskMeasurement;

const input = (over: Partial<RiskObservationInput> = {}): RiskObservationInput => ({
  sampleOrigin: 'SYNTHETIC_TEST_ONLY',
  env: 'TESTNET',
  connectionId: 'conn-1',
  symbol: 'BTCUSDT', side: 'LONG',
  executionIdentity: { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 },
  measurement: MEASUREMENT,
  position: { entryPrice: 50_000, quantity: 0.2, leverage: 100, marginMode: 'isolated' },
  bracketFreshness: 'FRESH',
  signedPositionAmt: 0.2,
  testnet: true,
  exchange: 'binance',
  ...over,
});

/** insert만 받는 최소 supabase 흉내 */
function fakeDb(over: { error?: any; throws?: boolean } = {}) {
  const rows: any[] = [];
  const sb = {
    from(table: string) {
      return {
        insert: async (row: any) => {
          if (over.throws) throw new Error('db down');
          rows.push({ table, row });
          return { error: over.error ?? null };
        },
      };
    },
  };
  return { sb, rows };
}

export function runRiskObservationStoreTests() {
  console.log('\n🧪 ⑤B-2 위험 관측 적재 (실측과 주입값을 섞지 않는다)');

  test('관측 한 줄을 표 모양으로 만든다', () => {
    const r = riskObservationRow(input());
    eq(r.symbol, 'BTCUSDT');
    eq(r.sample_origin, 'SYNTHETIC_TEST_ONLY');
    eq(r.execution_preset_id, 'EXACT_100X');
    eq(r.exchange_liquidation_price, 49_700);
    eq(r.estimated_liquidation_price, 49_690);
    eq(r.status, 'MEASURED');
  });

  test('★ duration과 epoch을 **다른 칸**에 적는다', () => {
    const r = riskObservationRow(input());
    eq(r.position_risk_elapsed_ms, 74, '단조 측정');
    eq(r.position_risk_wall_clock_delta_ms, 80, 'epoch 차는 참고값');
    eq(r.position_risk_received_at_ms, N - 100, 'epoch 시각');
    assert(r.position_risk_elapsed_ms !== r.position_risk_wall_clock_delta_ms,
      '★ 두 값이 같다 — 한 칸이 다른 칸을 덮었다');
    // duration 칸이 epoch 범위 숫자가 되면 섞인 것이다.
    assert(r.position_risk_elapsed_ms < 1_000_000,
      '★ duration 칸에 epoch timestamp가 들어갔다');
  });

  test('★ updateTime을 청산가 시각 칸으로 옮기지 않는다', () => {
    const r = riskObservationRow(input());
    eq(r.position_update_time_ms, N - 3_600_000);
    for (const bad of ['liquidation_exchange_time_ms', 'liquidation_observed_at_ms']) {
      eq(bad in r, false, `★ ${bad} 칸을 만들었다`);
    }
    assert(r.position_risk_received_at_ms !== r.position_update_time_ms,
      '★ updateTime이 관측 시각으로 승격됐다');
  });

  test('★ 090 원본을 갱신하지 않는다 — 사본만 적는다', async () => {
    const { sb, rows } = fakeDb();
    await recordRiskObservation(sb, input());
    eq(rows.length, 1);
    eq(rows[0].table, 'exact100x_risk_observations',
      '★ live_orders에 시계열을 썼다 — 진입 불변 스냅숏이 덮인다');
    eq(rows[0].row.entry_adverse_distance_pct, 0.4, '사본은 그대로 적는다');
  });

  test('★ 출처를 안 고르면 적지 않는다 — 실측으로 둔갑하는 길을 막는다', async () => {
    for (const bad of [undefined, null, '', 'REAL', 'TESTNET']) {
      const { sb, rows } = fakeDb();
      const r = await recordRiskObservation(sb, input({ sampleOrigin: bad as any }));
      eq(r.code, 'ORIGIN_UNSPECIFIED', `출처 "${String(bad)}"`);
      eq(rows.length, 0, '★ 출처 없이 줄이 쌓였다');
    }
  });

  test('★ MOCK·LIVE를 실측이라고 적을 수 없다', async () => {
    for (const env of ['MOCK', 'LIVE'] as const) {
      const { sb, rows } = fakeDb();
      const r = await recordRiskObservation(sb, input({
        sampleOrigin: 'VERIFIED_TESTNET_OBSERVATION', env,
      }));
      eq(r.code, 'ORIGIN_IMPOSSIBLE', `${env} 환경`);
      eq(rows.length, 0, `★ ${env} 관측이 TESTNET 실측으로 쌓였다`);
    }
  });

  test('★ 열린 포지션이 아니면 실측으로 적지 않는다 — 쓰기 실패가 아니다', async () => {
    for (const [amt, code] of [[0, 'NO_POSITION'], [-0.2, 'SIDE_MISMATCH'],
                               [null, 'POSITION_UNUSABLE']] as Array<[any, string]>) {
      const { sb, rows } = fakeDb();
      const r = await recordRiskObservation(sb, input({
        sampleOrigin: 'VERIFIED_TESTNET_OBSERVATION', signedPositionAmt: amt,
      }));
      eq(r.code, 'NOT_ELIGIBLE', `수량 ${String(amt)}`);
      eq(r.eligibility, code, '자격 사유를 그대로 전한다');
      eq(rows.length, 0, '★ 자격 없는 줄이 실측 통계에 쌓였다');
    }
  });

  test('★ 자격 없음을 SYNTHETIC으로 바꿔 적지 않는다', async () => {
    const { sb, rows } = fakeDb();
    await recordRiskObservation(sb, input({
      sampleOrigin: 'VERIFIED_TESTNET_OBSERVATION', signedPositionAmt: 0,
    }));
    eq(rows.length, 0,
      '★ 실제 런타임 상황을 시험값이라고 적었다 — 그것도 출처 오염이다');
  });

  test('실제 열린 TESTNET 포지션은 실측으로 적는다', async () => {
    const { sb, rows } = fakeDb();
    const r = await recordRiskObservation(sb, input({
      sampleOrigin: 'VERIFIED_TESTNET_OBSERVATION',
    }));
    eq(r.code, 'RECORDED');
    eq(rows[0].row.sample_origin, 'VERIFIED_TESTNET_OBSERVATION');
    eq(rows[0].row.env, 'TESTNET');
  });

  test('★ 위험 데이터가 불완전해도 실측은 실측이다', async () => {
    // 계정 조회가 실패해 배율·마진 모드를 못 읽은 경우.
    // VERIFIED의 뜻은 "열린 TESTNET 포지션에서 얻었다"이지
    // "모든 데이터가 완벽했다"가 아니다.
    const { sb, rows } = fakeDb();
    const r = await recordRiskObservation(sb, input({
      sampleOrigin: 'VERIFIED_TESTNET_OBSERVATION',
      position: { entryPrice: 50_000, quantity: 0.2, leverage: null, marginMode: null },
    }));
    eq(r.code, 'RECORDED', '★ 불완전한 데이터를 자격 미달로 읽었다');
    eq(rows[0].row.leverage, null, '못 읽은 것은 null로 남는다');
  });

  test('★ 적지 못하면 **세어서 돌려준다** — 조용히 삼키지 않는다', async () => {
    const a = await recordRiskObservation(fakeDb({ error: { message: 'denied' } }).sb, input());
    eq(a.code, 'WRITE_FAILED');
    assert(a.reason.includes('denied'), '사유를 적는다');
    const b = await recordRiskObservation(fakeDb({ throws: true }).sb, input());
    eq(b.code, 'WRITE_FAILED', '★ 예외를 성공으로 적었다');
  });

  test('★ 실패해도 호출부를 던지지 않는다 — 감시를 끄지 않는다', async () => {
    // 위 시험이 await로 통과한 것 자체가 증거다. 한 번 더 못으로 박는다.
    let threw = false;
    try { await recordRiskObservation(null as any, input()); }
    catch { threw = true; }
    eq(threw, false, '★ 기록 실패가 감시 회차를 죽인다');
  });

  test('★ 적재기는 거래소를 바꿀 수단이 없다', async () => {
    const src = await import('./riskObservationStore');
    for (const bad of ['sendClose', 'closePosition', 'sendSymbolClose',
                       'runExitAuthority', 'placeFuturesOrder']) {
      eq(Object.keys(src).includes(bad), false, `★ 적재기가 ${bad}를 내보낸다`);
    }
  });

  test('★ 시크릿을 적지 않는다', () => {
    const r = riskObservationRow(input());
    for (const k of Object.keys(r)) {
      assert(!/key|secret|signature|token|passphrase/i.test(k),
        `★ 관측 줄에 시크릿성 칸이 있다 (${k})`);
    }
    // 연결은 id로만 가리킨다.
    eq(r.connection_id, 'conn-1');
  });

  test('★ 문턱성 칸을 만들지 않는다', () => {
    const r = riskObservationRow(input());
    for (const k of Object.keys(r)) {
      assert(!/threshold|tolerance|ratio|consistent|should|action|verdict/i.test(k),
        `★ 관측 줄에 판단 칸이 있다 (${k})`);
    }
  });

  test('측정 불가도 그대로 적는다 — 빈 줄로 만들지 않는다', async () => {
    const { sb, rows } = fakeDb();
    const unusable = { ...MEASUREMENT, status: 'RISK_DATA_UNUSABLE',
      reason: '마크가를 읽지 못했습니다' } as PostEntryRiskMeasurement;
    const r = await recordRiskObservation(sb, input({ measurement: unusable }));
    eq(r.code, 'RECORDED');
    eq(rows[0].row.status, 'RISK_DATA_UNUSABLE');
    eq(rows[0].row.reason, '마크가를 읽지 못했습니다');
  });
}

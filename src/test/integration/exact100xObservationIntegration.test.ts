// src/test/integration/exact100xObservationIntegration.test.ts
//
// **관측 표가 0건이다 — 대상이 없어서인가, 저장이 안 이어져서인가.**
//
// 두 원인은 고칠 것이 정반대다
// ────────────────────────────
//   (가) 대상 포지션이 없다        → 고칠 것이 없다. 0건이 정직한 답이다
//   (나) 저장 경로가 안 이어졌다   → 노출이 열려 있는데 표가 비어 있다
//   (다) 대상이 **생기지 못한다**  → 노출은 열려 있고 저장도 이어져 있는데
//                                    후보 선정에서 전부 탈락한다
//
// (다)는 (가)처럼 보인다. 둘 다 `authorityCandidates: []`로 끝나기
// 때문이다. 화면에 "후보 0건"만 적히면 운영자는 (가)라고 읽고, 열려 있는
// 100배 포지션이 관측 없이 방치된다. **그 둘을 숫자로 가른다.**
//
// 여기서 보는 것
// ──────────────
//   Ⓐ 후보 선정 — 무엇이 탈락시키는가 (순수 함수, 실제 `managedCandidates`)
//   Ⓑ 저장 경로 — 자격이 되면 **실제로 한 줄이 들어가는가** (실제 store + 가짜 DB)
//
//   Ⓒ 자격 판독 — 연결을 **못 읽은 것**을 "연결이 없다"로 적지 않는가
//
// 거래소는 가짜다. 이 시험은 **실제 주문을 내지 않는다** —
// `Ⓑ`가 부르는 것은 `insert` 하나뿐이고, 이 파일은 주문 함수를
// import하지 않는다.

import { test, eq, assert } from '../harness';
import { FakeDb } from './venueHarness';
import { managedCandidates } from '../../lib/engine/managedPosition';
import { makeCredsReader } from '../../lib/engine/connectionCreds';
import { credentialDiagnosisReason } from '../../lib/engine/testnetReadiness';
import { sweepCredentialDisposition } from '../../lib/engine/orphanSweep';
import { recordRiskObservation } from '../../lib/engine/riskObservationStore';
import { loadLifecycleRows, LIFECYCLE_SELECT_LEGACY } from '../../lib/engine/lifecycleRows';
import { EXECUTION_CONTRACT_VERSION } from '../../lib/execution/profile';
import type { PostEntryRiskMeasurement } from '../../lib/engine/postEntryRisk';

const OBS_TABLE = 'exact100x_risk_observations';

/** Exact100X 계약 세 칸. 값을 지어내지 않고 정본 상수를 쓴다 */
const CONTRACT = {
  execution_profile_id: 'MAX_LEV_100X',
  execution_preset_id: 'EXACT_100X',
  execution_contract_version: EXECUTION_CONTRACT_VERSION,
};

/**
 * 실제로 열려 있는 Exact100X 노출 한 줄 (`live_orders` 모양).
 *
 * `acked_at`은 **방금**이다 — 시간 청산이 걸리지 않는 상태에서
 * 관측만 보기 위해서다.
 */
function exact100xRow(over: Record<string, any> = {}) {
  return {
    id: 'o-100x', user_id: 'u-1', connection_id: 'c-testnet',
    exchange: 'binance', symbol: 'BTCUSDT', side: 'BUY',
    avg_price: 60000, price: 60000, stop_loss: null,
    stop_policy: 'NO_FIXED_SL',
    ...CONTRACT,
    entry_adverse_distance_pct: 0.4,
    entry_liquidation_distance_pct_raw: 0.9,
    sl_order_id: null, tp_order_id: null,
    status: 'FILLED', reduce_only: false,
    acked_at: new Date(Date.now() - 60_000).toISOString(),
    created_at: new Date(Date.now() - 90_000).toISOString(),
    signal_id: null,
    strategy_id: 'max-lev-100x',
    ...over,
  };
}

/** 고정 손절을 쓰는 평범한 줄 — Exact100X 대상이 아니다 */
function ordinaryRow(over: Record<string, any> = {}) {
  return {
    id: 'o-plain', user_id: 'u-1', connection_id: 'c-testnet',
    exchange: 'binance', symbol: 'ETHUSDT', side: 'BUY',
    avg_price: 3000, price: 3000, stop_loss: 2900,
    stop_policy: 'FIXED_SL',
    status: 'FILLED', reduce_only: false,
    acked_at: new Date(Date.now() - 60_000).toISOString(),
    created_at: new Date(Date.now() - 90_000).toISOString(),
    strategy_id: 'my-original-v1',
    ...over,
  };
}

/** 측정값 한 벌. 관측 줄을 만들 수 있는 최소 모양이다 */
function measurement(over: Partial<PostEntryRiskMeasurement> = {}): PostEntryRiskMeasurement {
  return {
    status: 'MEASURED', reason: '',
    markPrice: 60100,
    exchangeLiquidationPrice: 59500,
    estimatedLiquidationPrice: 59480,
    internalTrustworthy: true,
    internal: null,
    freshness: null,
    exchangeHeadroomPct: 1.0,
    estimatedHeadroomPct: 1.03,
    absoluteDelta: 20,
    deltaPct: 0.03,
    liquidationSources: ['EXCHANGE', 'INTERNAL'],
    entryAdverseDistancePct: 0.4,
    entryLiquidationDistancePctRaw: 0.9,
    provenance: {
      markExchangeTimeMs: 1, markReceivedAtMs: 2, markObservedAtMs: 3,
      positionRiskSource: 'V2', positionRiskRequestStartedAtMs: 4,
      positionRiskReceivedAtMs: 5, positionUpdateTimeMs: 6,
      positionRiskElapsedMs: 7, accountElapsedMs: 8, helperElapsedMs: 9,
      positionRiskWallClockDeltaMs: 1, bracketObservedAtMs: 10,
    },
    ...over,
  } as any;
}

/** 관측 한 벌의 입력. `env`·수량만 바꿔 자격을 가른다 */
function obsInput(over: Record<string, any> = {}): any {
  return {
    sampleOrigin: 'VERIFIED_TESTNET_OBSERVATION',
    env: 'TESTNET',
    connectionId: 'c-testnet',
    symbol: 'BTCUSDT', side: 'LONG',
    executionIdentity: {
      profileId: CONTRACT.execution_profile_id,
      presetId: CONTRACT.execution_preset_id,
      contractVersion: CONTRACT.execution_contract_version,
    },
    measurement: measurement(),
    position: { entryPrice: 60000, quantity: 0.01, leverage: 100, marginMode: 'isolated' },
    bracketFreshness: 'FRESH',
    signedPositionAmt: 0.01,
    testnet: true, exchange: 'binance',
    ...over,
  };
}

export async function runExact100xObservationTests() {
  console.log('[통합 — Exact100X 관측이 0건인 이유를 가른다]');

  // ══════════════════════════════════════════════════════════
  // Ⓐ 후보 선정 — "대상 없음"과 "탈락"을 가른다
  // ══════════════════════════════════════════════════════════

  // Ⓐ-1 진짜로 대상이 없다 (정직한 0건)
  const a1 = managedCandidates([ordinaryRow()]);
  test('Ⓐ-1 Exact100X 노출이 없으면 후보 0 · 유예 0 — 고칠 것이 없는 0건이다', () => {
    eq(a1.authorityCandidates.length, 0, '후보가 없어야 한다');
    eq(a1.deferred.filter(d => String(d.code).startsWith('NO_FIXED_SL')).length, 0,
      'NO_FIXED_SL 유예가 없어야 한다');
    eq(a1.positions.length, 1, '평범한 줄은 일반 생명주기가 본다');
  });

  // Ⓐ-2 계약 세 칸이 비어 있다 — **노출은 열려 있는데** 후보가 안 생긴다
  const a2 = managedCandidates([exact100xRow({
    execution_profile_id: null, execution_preset_id: null,
    execution_contract_version: null,
  })]);
  test('Ⓐ-2 계약 세 칸이 null이면 후보 0인데 유예에는 남는다 — 0건의 뜻이 다르다', () => {
    eq(a2.authorityCandidates.length, 0, '계약을 모르면 전용 권한에 넘기지 않는다');
    eq(a2.deferred.length, 1, '노출을 인식했다는 기록은 남아야 한다');
    eq(a2.deferred[0].code, 'NO_FIXED_SL_EXIT_UNWIRED');
    eq(a2.deferred[0].executionIdentity, null, '없는 계약을 지어내지 않는다');
    // ★ 이것이 Ⓐ-1과 숫자로 구별되는 지점이다.
    assert(a2.deferred.length > a1.deferred.length,
      '같은 "후보 0건"이지만 유예 수가 다르다 — 이 차이가 두 원인을 가른다');
  });

  // Ⓐ-3 다 갖춰져 있으면 후보가 생긴다 (저장 경로가 도달 가능하다)
  const a3 = managedCandidates([exact100xRow()]);
  test('Ⓐ-3 계약 세 칸 + acked_at이 있으면 후보가 1건 생긴다', () => {
    eq(a3.authorityCandidates.length, 1, '후보가 생겨야 ⑤B 블록이 돈다');
    const c = a3.authorityCandidates[0];
    eq(c.symbol, 'BTCUSDT'); eq(c.side, 'LONG');
    eq(c.exposureClass, 'NO_FIXED_SL_EXACT100X');
    eq(c.connectionId, 'c-testnet');
    assert(Number.isFinite(c.openedAt), '진입 시각이 숫자여야 한다');
    eq(a3.positions.length, 0, '전용 후보는 일반 생명주기와 겹치지 않는다');
  });

  // Ⓐ-4 체결 시각이 없으면 후보가 안 생긴다 (시간 청산 기준이 없다)
  const a4 = managedCandidates([exact100xRow({ acked_at: null })]);
  test('Ⓐ-4 acked_at이 없으면 후보 0 — created_at으로 대신하지 않는다', () => {
    eq(a4.authorityCandidates.length, 0);
    eq(a4.deferred.length, 1, '유예 기록은 남는다');
  });

  // Ⓐ-5 상태가 UNKNOWN이면 후보도 유예도 아니다 — **못 확인한 것**이다
  const a5 = managedCandidates([exact100xRow({ status: 'UNKNOWN' })]);
  test('Ⓐ-5 UNKNOWN 상태는 후보 0 · 유예 0 · skipped에 남는다', () => {
    eq(a5.authorityCandidates.length, 0);
    eq(a5.deferred.length, 0);
    assert(a5.skipped.some(s => s.code === 'NOT_ENTERED'),
      '세지 못한 이유가 skipped에 남아야 한다');
  });

  // ══════════════════════════════════════════════════════════
  // Ⓐ-6 090가 아직인 DB — 투영이 LEGACY면 계약 칸이 **구조적으로** 없다
  // ══════════════════════════════════════════════════════════
  //
  //   이 경우 관측은 영원히 0건이다. 대상이 없어서가 아니라 후보가
  //   생길 수 없어서다. 그 사실을 `projection`이 말해야 한다.
  {
    const row = exact100xRow();
    const legacyOnly = async (select: string) => {
      if (select !== LIFECYCLE_SELECT_LEGACY) {
        return { data: null, error: {
          code: '42703',
          message: 'column live_orders.execution_profile_id does not exist',
        } };
      }
      // 옛 모양은 세 칸을 **고르지 않는다** — 그래서 줄에도 없다.
      const cols = select.split(',').map(s => s.trim());
      const projected: Record<string, any> = {};
      for (const c of cols) projected[c] = (row as any)[c];
      return { data: [projected], error: null };
    };
    const loaded = await loadLifecycleRows(legacyOnly);
    const a6 = managedCandidates(loaded.rows);    test('Ⓐ-6 090 이전 DB는 투영이 LEGACY고 후보가 0 — "대상 없음"이 아니다', () => {
      eq(loaded.error, null, '옛 모양으로라도 읽어야 한다');
      eq(loaded.projection, 'LEGACY');
      eq(loaded.rows.length, 1, '노출 줄 자체는 읽혔다');
      eq(a6.authorityCandidates.length, 0, '계약 칸이 없으니 후보가 생길 수 없다');
      eq(a6.deferred.length, 1, '노출은 인식했다 — 유예에 남는다');
    });
  }

  // ══════════════════════════════════════════════════════════
  // Ⓑ 저장 경로 — 자격이 되면 **실제로 한 줄 들어가는가**
  // ══════════════════════════════════════════════════════════

  // Ⓑ-1 TESTNET · 열린 포지션 → 적힌다
  {
    const db = new FakeDb();
    const r = await recordRiskObservation(db as any, obsInput());
    test('Ⓑ-1 자격이 되면 관측이 실제로 한 줄 적힌다 — 저장 경로는 이어져 있다', () => {
      eq(r.code, 'RECORDED', `적혀야 한다 (받은 사유: ${r.reason})`);
      eq(db.table(OBS_TABLE).length, 1, '표에 한 줄 들어가야 한다');
      const w = db.writes.filter(w => w.table === OBS_TABLE && w.kind === 'insert');
      eq(w.length, 1, 'insert 한 번');
      eq(w[0].patch.sample_origin, 'VERIFIED_TESTNET_OBSERVATION');
      eq(w[0].patch.env, 'TESTNET');
      eq(w[0].patch.symbol, 'BTCUSDT');
      eq(w[0].patch.execution_profile_id, 'MAX_LEV_100X');
    });
  }

  // Ⓑ-2 LIVE 연결 → 설계상 0건이다 (쓰기 실패가 아니다)
  {
    const db = new FakeDb();
    const r = await recordRiskObservation(db as any, obsInput({ env: 'LIVE', testnet: false }));
    test('Ⓑ-2 LIVE 연결이면 ORIGIN_IMPOSSIBLE — 0건이 설계된 결과다', () => {
      eq(r.code, 'ORIGIN_IMPOSSIBLE');
      eq(db.table(OBS_TABLE).length, 0, 'LIVE 값이 실측 표에 들어가지 않는다');
      eq(db.writes.length, 0, '쓰기 0건');
    });
  }

  // Ⓑ-3 수량 0 → 열린 포지션이 아니다
  {
    const db = new FakeDb();
    const r = await recordRiskObservation(db as any, obsInput({ signedPositionAmt: 0 }));
    test('Ⓑ-3 수량 0은 NOT_ELIGIBLE(NO_POSITION) — 없는 포지션을 통계에 넣지 않는다', () => {
      eq(r.code, 'NOT_ELIGIBLE');
      eq(r.eligibility, 'NO_POSITION');
      eq(db.table(OBS_TABLE).length, 0);
    });
  }

  // Ⓑ-4 testnet을 못 읽었다 → 통과가 아니다
  {
    const db = new FakeDb();
    const r = await recordRiskObservation(db as any, obsInput({ testnet: null }));
    test('Ⓑ-4 testnet을 못 읽었으면 NOT_TESTNET — null을 통과로 읽지 않는다', () => {
      eq(r.code, 'NOT_ELIGIBLE');
      eq(r.eligibility, 'NOT_TESTNET');
      eq(db.table(OBS_TABLE).length, 0);
    });
  }

  // Ⓑ-5 DB 쓰기가 실패한다 → **0건의 또 다른 원인.** 자격 탈락과 섞지 않는다
  {
    const db = new FakeDb({ failInsertCode: { table: OBS_TABLE, code: 'XX000' } });
    const r = await recordRiskObservation(db as any, obsInput());
    test('Ⓑ-5 insert가 실패하면 WRITE_FAILED — NOT_ELIGIBLE과 같은 숫자로 세지 않는다', () => {
      eq(r.code, 'WRITE_FAILED');
      assert(r.code !== 'NOT_ELIGIBLE', '쓰기 실패를 자격 탈락으로 적지 않는다');
      eq(db.table(OBS_TABLE).length, 0);
    });
  }

  // Ⓑ-6 다른 계약의 노출은 Exact100X 표에 섞이지 않는다
  {
    const db = new FakeDb();
    const r = await recordRiskObservation(db as any, obsInput({
      executionIdentity: { profileId: 'SCALP', presetId: 'BALANCED', contractVersion: EXECUTION_CONTRACT_VERSION },
    }));
    test('Ⓑ-6 다른 계약이면 IDENTITY_MISMATCH — 표본이 섞이지 않는다', () => {
      eq(r.code, 'NOT_ELIGIBLE');
      eq(r.eligibility, 'IDENTITY_MISMATCH');
      eq(db.table(OBS_TABLE).length, 0);
    });
  }

  // ══════════════════════════════════════════════════════════
  // Ⓒ 자격 판독 — 관측 0건의 **세 번째 원인**을 가린다
  // ══════════════════════════════════════════════════════════
  //
  //   후보가 생겨도 그 연결의 자격을 못 읽으면 관측은 0건이 된다.
  //   그런데 판독기는 **조회 실패와 연결 없음을 한 코드로** 적었다:
  //
  //     const { data } = await sb.from('exchange_connections')…
  //
  //   `error`를 받지 않는다. Supabase는 실패해도 던지지 않고
  //   `{ data: null, error }`를 준다 — 그래서 `data ?? null`이 null이
  //   되고, `rowFound: false`가 되어 `NO_CONNECTION`("연결 기록이
  //   삭제됐다")으로 적힌다.
  //
  //   두 사실은 처분이 다르다. 연결이 **삭제된** 과거 주문은 건드리지
  //   않는 것이 맞고(고아 정리가 그렇게 설계됐다), 연결을 **못 읽은**
  //   것은 지금 고쳐야 할 장애다. 한 코드로 적으면 뒤쪽이 영원히
  //   앞쪽으로 분류된다.
  //
  //   막는 방향은 둘 다 같다(READY만 통과) — 바뀌는 것은 **진단**이다.

  const readerFor = (db: FakeDb) => makeCredsReader({
    sb: db as any,
    resolveExchange: () => ({ exchange: 'binance' as const }),
    decrypt: (s: string) => (s ? 'plain-secret' : ''),
  });

  /** 쓸 수 있는 연결 한 줄 */
  const connRow = (over: Record<string, any> = {}) => ({
    id: 'c-testnet', user_id: 'u-1', exchange_id: 'binance',
    api_key: 'K'.repeat(64), api_secret_enc: 'enc',
    has_withdrawal: false, is_testnet: true, is_active: true,
    ...over,
  });

  // Ⓒ-0 정상 경로가 그대로 통과하는지 먼저 고정한다
  {
    const db = new FakeDb().seed('exchange_connections', [connRow()]);
    const reader = readerFor(db);
    const v = await reader.get('c-testnet');
    test('Ⓒ-0 읽을 수 있는 연결은 READY — 이 수정이 정상 경로를 막지 않는다', () => {
      eq(reader.codeOf('c-testnet'), 'READY');
      assert(v != null, '자격이 나와야 한다');
      eq(v!.testnet, true, '연결이 망을 정한다');
    });
  }

  // Ⓒ-1 조회가 실패했다 — **연결이 없다는 뜻이 아니다**
  {
    const db = new FakeDb({ failSelectsOn: 'exchange_connections' })
      .seed('exchange_connections', [connRow()]);
    const reader = readerFor(db);
    const v = await reader.get('c-testnet');
    const code = reader.codeOf('c-testnet');
    test('Ⓒ-1 연결 조회가 실패하면 READ_FAILED — "연결 기록이 삭제됐다"로 적지 않는다', () => {
      eq(v, null, '못 읽었으면 자격을 주지 않는다 (fail-closed는 그대로다)');
      eq(code, 'READ_FAILED', '조회 실패를 NO_CONNECTION으로 적으면 영원히 "삭제된 연결"로 분류된다');
    });
    test('Ⓒ-1b 그 문구가 두 사실을 구별한다', () => {
      const reason = credentialDiagnosisReason(code);
      assert(reason.includes('조회하지 못'),
        `조회 실패임을 말해야 한다 (받은 문구: ${reason})`);
      assert(!reason.includes('삭제'), '삭제됐다고 적지 않는다');
    });
  }

  // Ⓒ-2 조회는 됐고 **줄이 정말 없다** — 이쪽은 NO_CONNECTION이 맞다
  {
    const db = new FakeDb().seed('exchange_connections', []);
    const reader = readerFor(db);
    const v = await reader.get('c-gone');
    test('Ⓒ-2 줄이 정말 없으면 NO_CONNECTION — 이 뜻은 바뀌지 않는다', () => {
      eq(v, null);
      eq(reader.codeOf('c-gone'), 'NO_CONNECTION');
    });
  }

  // Ⓒ-3 조회가 **던졌다** — 이것도 "연결 없음"이 아니다
  {
    const thrower: any = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => { throw new Error('연결 끊김'); } }) }),
      }),
    };
    const reader = makeCredsReader({
      sb: thrower, resolveExchange: () => ({ exchange: 'binance' as const }),
      decrypt: () => 'plain-secret',
    });
    const v = await reader.get('c-testnet');
    test('Ⓒ-3 조회가 예외로 끝나도 READ_FAILED — 예외를 "연결 없음"으로 적지 않는다', () => {
      eq(v, null);
      eq(reader.codeOf('c-testnet'), 'READ_FAILED');
    });
  }

  // Ⓒ-4 처분이 갈린다 — 이것이 두 코드를 나누는 이유다
  test('Ⓒ-4 고아 정리의 처분: 삭제된 연결은 건너뛰고, 못 읽은 것은 실패로 센다', () => {
    const gone = sweepCredentialDisposition('NO_CONNECTION');
    eq(gone.skip, true, '삭제된 연결은 건드리지 않는다');
    eq(gone.failure, false);
    const unread = sweepCredentialDisposition('READ_FAILED' as any);
    eq(unread.failure, true, '못 읽은 것은 조용히 넘기지 않는다');
    eq(unread.code, 'CREDENTIAL_UNREADABLE');
  });

  // Ⓒ-5 어떤 코드든 READY만 통과한다 — 코드를 더해도 관문은 그대로다
  test('Ⓒ-5 READY가 아닌 코드는 전부 자격을 주지 않는다', () => {
    const codes = ['NO_CONNECTION', 'READ_FAILED', 'UNSUPPORTED_EXCHANGE',
      'WITHDRAWAL_ENABLED', 'KEY_MISSING', 'SECRET_MISSING', 'DECRYPT_FAILED'];
    for (const c of codes) {
      assert(c !== 'READY', `${c}는 통과 코드가 아니다`);
      assert(credentialDiagnosisReason(c as any).length > 0,
        `${c}에는 사람이 읽을 사유가 있어야 한다`);
    }
  });
}

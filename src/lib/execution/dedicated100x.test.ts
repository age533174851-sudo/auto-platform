// 전용 100배 프로필이 **적힌 그대로 실행되는가.**
//
// 이 파일이 지키는 것은 수익이 아니라 일치다. 화면에 100배라고 적혀
// 있으면 거래소에도 100배가 걸려 있고, 아니면 주문이 나가지 않는다.
// 고정 손절을 안 쓴다고 했으면 lifecycle 어디에서도 손절이 새로 걸리지
// 않는다. 크기의 근거가 없으면 크기를 만들지 않는다.
import { test, assert, eq, flushAsync } from '../../test/harness';
import {
  resolveExecutionProfile, stopPolicyOfContract, sizingPolicyOfContract,
  pairMismatchReason, EXCLUSIVE_PAIRS, takeProfitPolicyOfContract,
  EXECUTION_CONTRACT_VERSION, CONTRACT_FIELDS, isExecutionResolveError,
} from './profile';
import { executionGateVerdict, enableFilterSpec, OPEN_COMBOS } from './dormantGate';
import { carriesExecutionContract } from './profile';
import { PROFILES, stopPolicyInvariantErrors } from '../strategies/profiles';
import { PRESET_TABLE, applyPreset } from '../strategies/profilePreset';
import { planSize100x, verifyLeverageExact } from '../engine/sizing100x';
import {
  prepareEntry100x, commitEntry100x, MUTATING_DEPS, READONLY_DEPS,
  type Entry100xDeps,
} from '../engine/entry100x';

/**
 * 두 단계를 이어 부르는 **시험용** 합성.
 *
 * 아래 시험들은 "이 입력이면 최종적으로 어떤 판정이 나오는가"를 본다 —
 * 그 기대는 단계를 나눠도 그대로여야 한다. 제품 경로는 두 단계를 따로
 * 부르고, 그 사이에 쓰기 없이 판정하는 관문(1회 상한)이 들어간다.
 *
 * 막힌 계획에서는 `commitEntry100x`가 곧바로 되돌려주므로, 이 합성으로도
 * "막힐 요청은 쓰기 0"이 그대로 확인된다.
 */
const planEntry100x = async (
  c: Parameters<typeof prepareEntry100x>[0],
  pct: number | null,
  deps: Entry100xDeps,
) => commitEntry100x(await prepareEntry100x(c, pct, deps), deps);
import {
  entryAuthorityVerdict, guardedEntry, type EntryAuthorityFacts,
} from '../engine/entryAuthority';
import { stopReattachVerdict } from '../engine/stopReattach';
import { leverageVerdict } from '../exchanges/futuresExec';
import { appliesTo, FIXED_STOP_ONLY_CHECKS } from '../engine/preTradeChecklist';

const V = EXECUTION_CONTRACT_VERSION;
const ID = 'MAX_LEV_100X';
const PRESET = 'EXACT_100X';

const failCode = (r: ReturnType<typeof resolveExecutionProfile>) =>
  (isExecutionResolveError(r) ? r.code : '');

/** 통과하는 사이징 입력 한 벌. 시험마다 한 칸씩만 바꿔서 쓴다 */
const goodSizing = {
  requiredLeverage: 100,
  availableUsd: 1_000,
  // 배정 비율은 **예약이 주는 값**이라 시험이 주입한다. 정본에는 없다.
  marginAllocationPct: 10,
  referencePrice: 50_000,
};

/** 전부 통과하는 가짜 거래소 어댑터. 시험마다 한 곳씩만 망가뜨린다 */
const okDeps = (over: Partial<Entry100xDeps> = {}): Entry100xDeps => ({
  observeMarginMode: async () => 'isolated',
  applyLeverage: async (lev: number) => ({ ok: true, observed: lev, message: `${lev}배 확인` }),
  availableUsd: async () => 1_000,
  referencePrice: async () => 50_000,
  quantize: async (q: number) => ({ qty: q, message: '' }),
  ...over,
});

const contract100x = { leverage: 100, sizingPolicy: 'MARGIN_ALLOCATION', marginModes: ['isolated'] };

/** 열린 조합 한 벌 — 켜기 관련 시험이 쓴다 */
const openRow = {
  strategyId: 'scalp',
  profileId: ID, presetId: PRESET, contractVersion: V,
  mode: 'TESTNET', marginAllocationPct: 10,
};

export async function runDedicated100xTests() {
  // ── ① 정체 ──────────────────────────────────────────────
  test('전용 100배는 별도 id다 — 기존 세 프로필의 의미가 바뀌지 않았다', () => {
    assert(!!(PROFILES as any)[ID], '전용 100배 프로필이 없다');
    eq(PROFILES.DAILY_HIGH_LEV.leverage, 10, 'DAILY_HIGH_LEV가 재정의됐다');
    eq(PROFILES.DAILY_HIGH_LEV.maxLeverage, 100, 'DAILY_HIGH_LEV 상한이 바뀌었다');
    eq(PROFILES.DAILY_HIGH_LEV.stopLossPct, 0.5, 'DAILY_HIGH_LEV 손절이 바뀌었다');
    eq(PROFILES.SCALP_HIGH_LEV.leverage, 25, 'SCALP가 바뀌었다');
    eq(PROFILES.SWING_LOW_LEV.leverage, 4, 'SWING이 바뀌었다');
    // 마진 모드 의미도 그대로다.
    eq(PROFILES.SWING_LOW_LEV.marginModes.join(','), 'isolated,cross');
    eq(PROFILES.DAILY_HIGH_LEV.marginModes.join(','), 'isolated');
  });

  test('전용 100배는 요청값이 정확히 100이다 — 상한이 아니다', () => {
    eq(PROFILES[ID].leverage, 100);
    eq(PROFILES[ID].maxLeverage, 100, '상한과 요청값이 다르면 "정확히 100"이 아니다');
  });

  test('전용 100배는 ISOLATED 전용이다 (사용자 확정 정책)', () => {
    eq(PROFILES[ID].marginModes.join(','), 'isolated', 'cross가 열리면 다른 전략이 된다');
  });

  // ── ② 프로필 × 프리셋 조합 ──────────────────────────────
  test('전용 100배는 EXACT_100X 프리셋에서만 해석된다', () => {
    const ok = resolveExecutionProfile(ID, PRESET, V);
    assert(ok.ok && ok.kind === 'contract', `${ID}/${PRESET} 해석 실패`);
    for (const sid of ['STABILIZE', 'RESEARCH']) {
      const r = resolveExecutionProfile(ID, sid, V);
      eq(failCode(r), 'PROFILE_PRESET_MISMATCH', `${ID}/${sid}가 통과했다`);
    }
  });

  test('EXACT_100X 프리셋은 다른 프로필에 붙지 않는다', () => {
    for (const pid of ['SCALP_HIGH_LEV', 'SWING_LOW_LEV', 'DAILY_HIGH_LEV']) {
      const r = resolveExecutionProfile(pid, PRESET, V);
      eq(failCode(r), 'PROFILE_PRESET_MISMATCH', `${pid}/${PRESET}가 통과했다`);
    }
  });

  test('기존 프로필 × 기존 프리셋 조합은 그대로 해석된다', () => {
    for (const pid of ['SCALP_HIGH_LEV', 'SWING_LOW_LEV', 'DAILY_HIGH_LEV']) {
      for (const sid of ['STABILIZE', 'RESEARCH']) {
        const r = resolveExecutionProfile(pid, sid, V);
        assert(r.ok && r.kind === 'contract', `${pid}/${sid}가 막혔다 — 기존 동작이 바뀌었다`);
      }
    }
  });

  test('조합 규칙은 양방향이다 — 한쪽만 막으면 반대가 샌다', () => {
    eq(EXCLUSIVE_PAIRS.length > 0, true);
    assert(pairMismatchReason(ID, 'STABILIZE') !== '', '프로필 쪽이 안 막힌다');
    assert(pairMismatchReason('SCALP_HIGH_LEV', PRESET) !== '', '프리셋 쪽이 안 막힌다');
    eq(pairMismatchReason(ID, PRESET), '');
    eq(pairMismatchReason('SCALP_HIGH_LEV', 'STABILIZE'), '');
  });

  test('전용 프리셋 표에 항목이 실제로 적혀 있다 — 키 누락에 기대지 않는다', () => {
    const row = (PRESET_TABLE as any)[PRESET]?.[ID];
    assert(row && row.leverage === 100 && row.maxLeverage === 100,
      `${PRESET}에 ${ID} 항목이 없다 — 지금 100인 것이 우연이 된다`);
    const merged = applyPreset(PROFILES[ID], PRESET as any);
    eq(merged.leverage, 100);
    eq(merged.maxLeverage, 100);
  });

  // ── ③ 손절·사이징 정책 ──────────────────────────────────
  test('stopPolicy·sizingPolicy·stopLossPct의 짝이 맞는다', () => {
    eq(stopPolicyInvariantErrors().join(' / '), '', '정책과 숫자가 어긋난 프로필이 있다');
  });

  test('전용 100배에는 synthetic stop이 없다', () => {
    eq(PROFILES[ID].stopPolicy, 'NO_FIXED_SL');
    eq(PROFILES[ID].sizingPolicy, 'MARGIN_ALLOCATION');
    eq(PROFILES[ID].stopLossPct, null, '숫자가 남아 있으면 그것이 손절로 되살아난다');
  });

  test('계약 칸은 정책 두 개다 — 배정 비율은 계약이 아니다', () => {
    assert(CONTRACT_FIELDS.includes('stopPolicy' as any), 'stopPolicy가 계약 칸이 아니다');
    assert(CONTRACT_FIELDS.includes('sizingPolicy' as any), 'sizingPolicy가 계약 칸이 아니다');
    assert(!CONTRACT_FIELDS.includes('marginAllocationPct' as any),
      '배정 비율이 계약에 있다 — 예약이 값을 바꿔도 계약은 옛 값을 가리킨다');
    const r = resolveExecutionProfile(ID, PRESET, V);
    if (r.ok && r.kind === 'contract') {
      eq(r.contract.stopPolicy, 'NO_FIXED_SL');
      eq(r.contract.sizingPolicy, 'MARGIN_ALLOCATION');
      eq(r.contract.leverage, 100);
      eq(r.contract.stopLossPct, null);
      eq((r.contract as any).marginAllocationPct, undefined);
    }
  });

  // ── ④ 누출 방지 ─────────────────────────────────────────
  test('계약이 없으면 100X 실행 의미를 만들 수 없다 — 레거시 levCap 100은 계약이 아니다', () => {
    eq(stopPolicyOfContract(null), 'FIXED_SL');
    eq(stopPolicyOfContract(undefined), 'FIXED_SL');
    eq(sizingPolicyOfContract(null), 'STOP_RISK');
    eq(sizingPolicyOfContract(undefined), 'STOP_RISK');
  });

  test('전용 100배 외의 어떤 조합도 NO_FIXED_SL / MARGIN_ALLOCATION이 아니다', () => {
    for (const pid of ['SCALP_HIGH_LEV', 'SWING_LOW_LEV', 'DAILY_HIGH_LEV']) {
      for (const sid of ['STABILIZE', 'RESEARCH']) {
        const r = resolveExecutionProfile(pid, sid, V);
        if (r.ok && r.kind === 'contract') {
          eq(stopPolicyOfContract(r.contract), 'FIXED_SL', `${pid}/${sid}의 손절 정책이 다르다`);
          eq(sizingPolicyOfContract(r.contract), 'STOP_RISK', `${pid}/${sid}의 사이징이 다르다`);
        }
      }
    }
  });

  // ── ⑤ 정확 배율 ─────────────────────────────────────────
  test('되읽은 배율이 정확히 100일 때만 크기를 만든다', () => {
    const ok = planSize100x(goodSizing);
    assert(ok.ok, `정상 입력이 막혔다: ${ok.message}`);
    eq(ok.allocatedMargin, 100);
    eq(ok.targetNotional, 10_000);
    eq(ok.quantity, 0.2);
  });

  // 정확 배율 판정은 크기 계산에서 떼어냈다. 후보 수량은 **요구 배율**로
  // 계산되고(그래야 쓰기 전에 계산할 수 있다), 되읽은 값 확인은 주문
  // 직전의 별도 권한이다. 막는 힘은 그대로여야 한다.
  for (const [label, observed] of [['99배', 99], ['75배', 75], ['모름', null]] as const) {
    test(`되읽은 배율이 ${label}이면 주문을 허락하지 않는다`, () => {
      const bad = verifyLeverageExact(100, observed as any);
      assert(bad !== null, `${label}인데 통과했다`);
      eq(bad!.code, 'LEVERAGE_NOT_EXACT');
    });
  }

  test('정확히 요구 배율이면 통과한다', () => {
    eq(verifyLeverageExact(100, 100), null);
  });

  test('배율 판정은 leverageVerdict와 같은 방향이다', () => {
    eq(leverageVerdict(100, 100, 100).ok, true);
    eq(leverageVerdict(100, 100, 75).ok, false, '거래소가 낮춘 것을 통과시키면 안 된다');
    eq(leverageVerdict(100, 100, null).ok, false);
    eq(leverageVerdict(100, 100, 101).ok, false);
  });

  // ── ⑥ 크기의 근거 ───────────────────────────────────────
  test('증거금 배정 미지정이면 막는다 — 화면 기본값을 빌려 오지 않는다', () => {
    const v = planSize100x({ ...goodSizing, marginAllocationPct: null });
    eq(v.ok, false);
    eq(v.code, 'MARGIN_ALLOCATION_UNSET');
  });

  test('잔고를 못 읽으면 BALANCE_UNKNOWN이다 — 0으로 눕히지 않는다', () => {
    eq(planSize100x({ ...goodSizing, availableUsd: null }).code, 'BALANCE_UNKNOWN');
    eq(planSize100x({ ...goodSizing, availableUsd: 0 }).code, 'BALANCE_EMPTY');
  });

  test('기준가를 못 읽으면 막는다', () => {
    eq(planSize100x({ ...goodSizing, referencePrice: null }).code, 'PRICE_UNKNOWN');
  });

  test('배정 비율이 범위를 벗어나면 막는다', () => {
    for (const pct of [0, -5, 101, NaN]) {
      const v = planSize100x({ ...goodSizing, marginAllocationPct: pct });
      eq(v.ok, false, `${pct}%가 통과했다`);
      eq(v.code, 'MARGIN_ALLOCATION_INVALID');
    }
  });

  // ── ⑦ 진입 계획 (가짜 거래소 어댑터) ────────────────────
  test('가짜 어댑터: 전부 정상이면 수량이 나온다', async () => {
    const v = await planEntry100x(contract100x, 10, okDeps());
    assert(v.ok, `정상 입력이 막혔다: ${v.message}`);
    eq(v.leverage, 100);
    eq(v.quantity, 0.2);
    eq(v.marginMode, 'isolated');
    eq(v.requiredMargin, 100);
  });

  test('가짜 어댑터: 거래소가 교차 마진이면 진입하지 않는다', async () => {
    const v = await planEntry100x(contract100x, 10, okDeps({ observeMarginMode: async () => 'cross' }));
    eq(v.ok, false, '교차인데 100배 주문이 나갔다');
    eq(v.code, 'MARGIN_MODE_NOT_ISOLATED');
    eq(v.quantity, null);
  });

  test('가짜 어댑터: 마진 모드를 모르면 진입하지 않는다', async () => {
    const v = await planEntry100x(contract100x, 10, okDeps({ observeMarginMode: async () => null }));
    eq(v.ok, false, '담보 범위를 모르는데 주문이 나갔다');
    eq(v.code, 'MARGIN_MODE_UNKNOWN');
  });

  test('가짜 어댑터: 마진 모드 확인이 배율 설정보다 먼저다', async () => {
    // 교차 계좌에 배율부터 걸면, 막을 주문을 위해 계좌 설정을 먼저 바꾸는
    // 것이 된다. 순서가 뒤집히면 여기서 applyLeverage가 불린다.
    let applied = false;
    const v = await planEntry100x(contract100x, 10, okDeps({
      observeMarginMode: async () => 'cross',
      applyLeverage: async (lev: number) => { applied = true; return { ok: true, observed: lev, message: '' }; },
    }));
    eq(v.ok, false);
    eq(applied, false, '교차인 걸 알기 전에 배율을 걸었다');
  });

  for (const [label, observed] of [['99배', 99], ['75배', 75], ['모름', null]] as const) {
    test(`가짜 어댑터: 되읽은 배율이 ${label}이면 진입하지 않는다`, async () => {
      const v = await planEntry100x(contract100x, 10, okDeps({
        // 되읽기가 요청과 다르거나 못 읽은 경우다. 설정 자체는 성공했다고
        // 두어, **되읽은 값만으로 막는지**를 본다.
        applyLeverage: async () => ({ ok: true, observed: observed as any, message: '되읽음' }),
      }));
      eq(v.ok, false, `${label}인데 주문이 나갔다`);
      eq(v.code, 'LEVERAGE_NOT_EXACT');
    });
  }

  test('가짜 어댑터: 배정 비율이 없으면 진입하지 않는다', async () => {
    const v = await planEntry100x(contract100x, null, okDeps());
    eq(v.ok, false);
    eq(v.code, 'SIZING_BLOCKED');
  });

  test('가짜 어댑터: 잔고·기준가를 못 읽으면 진입하지 않는다', async () => {
    eq((await planEntry100x(contract100x, 10, okDeps({ availableUsd: async () => null }))).code, 'SIZING_BLOCKED');
    eq((await planEntry100x(contract100x, 10, okDeps({ referencePrice: async () => null }))).code, 'SIZING_BLOCKED');
  });

  test('가짜 어댑터: 거래소 규격에 못 맞추면 진입하지 않는다', async () => {
    const v = await planEntry100x(contract100x, 10, okDeps({
      quantize: async () => ({ qty: null, message: '규격을 읽지 못했습니다' }),
    }));
    eq(v.ok, false);
    eq(v.code, 'QUANTIZE_FAILED');
  });

  test('가짜 어댑터: 수량을 올림해서 배정을 넘으면 진입하지 않는다', async () => {
    // 0.2 → 0.3으로 올라가면 필요 증거금이 150이 되어 배정 100을 넘는다.
    const v = await planEntry100x(contract100x, 10, okDeps({
      quantize: async () => ({ qty: 0.3, message: '단위 0.1' }),
    }));
    eq(v.ok, false, '허락받은 적 없는 증거금으로 주문이 나갔다');
    eq(v.code, 'MARGIN_EXCEEDED');
  });

  test('가짜 어댑터: 내림은 통과한다 — 배정을 넘지 않는다', async () => {
    const v = await planEntry100x(contract100x, 10, okDeps({
      quantize: async () => ({ qty: 0.1, message: '단위 0.1' }),
    }));
    assert(v.ok, `내림이 막혔다: ${v.message}`);
    eq(v.requiredMargin, 50);
  });

  test('가짜 어댑터: 손절 거리 사이징 계약은 이 경로를 타지 않는다', async () => {
    const v = await planEntry100x(
      { ...contract100x, sizingPolicy: 'STOP_RISK' }, 10, okDeps());
    eq(v.ok, false);
    eq(v.code, 'NOT_MARGIN_ALLOCATION');
  });

  // ── ⑧ 고정 손절 재부착 0건 ──────────────────────────────
  test('NO_FIXED_SL 주문에는 손절을 다시 걸지 않는다 — 손절가가 남아 있어도', () => {
    const v = stopReattachVerdict({ stop_policy: 'NO_FIXED_SL', stop_loss: 49_000 });
    eq(v.attach, false, '고정 손절 없는 프로필에 손절이 다시 걸린다');
    eq(v.code, 'NO_FIXED_SL');
    assert(v.note !== '', '일부러 안 했다는 사실이 기록에 남지 않는다');
  });

  test('정책이 값보다 먼저다 — 순서가 뒤집히면 이 시험이 깨진다', () => {
    eq(stopReattachVerdict({ stop_policy: 'NO_FIXED_SL', stop_loss: 1 }).code, 'NO_FIXED_SL');
    eq(stopReattachVerdict({ stop_policy: 'NO_FIXED_SL' }).code, 'NO_FIXED_SL');
  });

  test('기존 주문의 복구는 그대로 동작한다', () => {
    const v = stopReattachVerdict({ stop_loss: 49_000 });
    eq(v.attach, true, '고정 손절 전략의 복구가 막혔다');
    eq(v.stopPrice, 49_000);
    eq(stopReattachVerdict({ reduce_only: true, stop_loss: 1 }).code, 'REDUCE_ONLY');
    eq(stopReattachVerdict({ sl_order_id: 'x', stop_loss: 1 }).code, 'ALREADY_ATTACHED');
    eq(stopReattachVerdict({ stop_loss: 0 }).code, 'NO_PLANNED_STOP');
    eq(stopReattachVerdict({}).code, 'NO_PLANNED_STOP');
  });

  // ── ⑨ 체크리스트 N/A ────────────────────────────────────
  test('NO_FIXED_SL에서는 손절 항목이 목록에서 빠진다 — pass로 적지 않는다', () => {
    for (const id of FIXED_STOP_ONLY_CHECKS) {
      eq(appliesTo(id as any, 'USDM', 'ENTRY', false, false, false, false, true, 'NO_FIXED_SL'),
        false, `${id}가 목록에 남아 있다`);
      eq(appliesTo(id as any, 'USDM', 'ENTRY', false, false, false, false, true, 'FIXED_SL'),
        true, `${id}가 고정 손절 전략에서도 빠졌다`);
    }
  });

  test('손절과 무관한 검사는 하나도 사라지지 않는다', () => {
    const keep = [
      'MODE', 'CLOCK_SKEW', 'STATE_RECONCILE', 'UNRESOLVED_ORDERS', 'MARGIN_ISOLATED',
      'MARGIN_SUFFICIENT', 'DAILY_LOSS_LIMIT', 'WEEKLY_LOSS_LIMIT', 'LOSS_STREAK',
      'SUBACCOUNT_LIMIT', 'LEVERAGE', 'EXISTING_POSITION', 'POSITION_MODE',
    ];
    for (const id of keep) {
      const fixed = appliesTo(id as any, 'USDM', 'ENTRY', false, false, false, false, true, 'FIXED_SL');
      const none = appliesTo(id as any, 'USDM', 'ENTRY', false, false, false, false, true, 'NO_FIXED_SL');
      eq(none, fixed, `${id}가 NO_FIXED_SL에서 같이 사라졌다`);
    }
  });

  // ── ⑩ 켜기 게이트 ───────────────────────────────────────
  test('열린 조합은 scalp · TESTNET 하나뿐이다 — LIVE는 아직 아니다', () => {
    eq(OPEN_COMBOS.length, 1);
    eq(OPEN_COMBOS[0].strategyId, 'scalp',
      '계약을 해석하는 라우트는 scalp 하나다 — 다른 전략을 열면 저장된 의미와 도는 의미가 갈린다');
    eq(OPEN_COMBOS[0].profileId, ID);
    eq(OPEN_COMBOS[0].presetId, PRESET);
    eq(OPEN_COMBOS[0].contractVersion, V);
    eq(OPEN_COMBOS[0].modes.join(','), 'TESTNET',
      '자동 종료 권한 증명 전에 LIVE가 열렸다 — dormantGate 머리말 참조');
    eq(OPEN_COMBOS[0].requiresMarginAllocation, true);
  });

  test('검증된 조합은 켤 수 있다', () => {
    const v = executionGateVerdict(openRow);
    eq(v.allowed, true, `열린 조합이 막혔다: ${v.reason}`);
  });

  test('LIVE는 막힌다', () => {
    const v = executionGateVerdict({ ...openRow, mode: 'LIVE' });
    eq(v.allowed, false, 'LIVE가 열렸다');
  });

  test('배정 비율이 없으면 켤 수 없다', () => {
    for (const pct of [null, undefined, 0, -1, 101]) {
      const v = executionGateVerdict({ ...openRow, marginAllocationPct: pct });
      eq(v.allowed, false, `배정 ${String(pct)}로 켜졌다`);
    }
  });

  test('프리셋·버전이 다르면 켤 수 없다', () => {
    eq(executionGateVerdict({ ...openRow, presetId: 'STABILIZE' }).allowed, false);
    eq(executionGateVerdict({ ...openRow, contractVersion: 1 }).allowed, false);
  });

  test('계약을 해석하지 않는 전략은 켤 수 없다', () => {
    // daily-ladder·my-original-v1 라우트에는 resolveExecutionProfile이 없다.
    // 여기서 통과하면 저장된 것은 100X인데 도는 것은 그 전략이 된다.
    for (const sid of ['daily-ladder', 'my-original-v1', '', 'scalp2']) {
      const v = executionGateVerdict({ ...openRow, strategyId: sid });
      eq(v.allowed, false, `${sid || '(없음)'}에서 100X가 켜졌다`);
      assert(v.reason.includes('전략'), `이유가 전략을 가리키지 않는다: ${v.reason}`);
    }
  });

  test('전략이 맞으면 켤 수 있다 — 나머지 조건이 전부 맞을 때', () => {
    eq(executionGateVerdict({ ...openRow, strategyId: 'scalp' }).allowed, true);
  });

  test('전략 조건은 다른 조건을 대신하지 않는다', () => {
    // scalp이어도 LIVE·배정 없음은 여전히 막힌다.
    eq(executionGateVerdict({ ...openRow, mode: 'LIVE' }).allowed, false);
    eq(executionGateVerdict({ ...openRow, marginAllocationPct: null }).allowed, false);
  });

  test('기존 세 프로필의 명시적 선택은 켤 수 없다', () => {
    for (const pid of ['SCALP_HIGH_LEV', 'SWING_LOW_LEV', 'DAILY_HIGH_LEV']) {
      const v = executionGateVerdict({ ...openRow, profileId: pid, presetId: 'STABILIZE' });
      eq(v.allowed, false, `${pid}가 켜졌다`);
    }
  });

  test('프로필이 없는 기존 예약은 게이트와 무관하다', () => {
    for (const v of [null, undefined, '', '   ']) {
      eq(executionGateVerdict({ profileId: v }).allowed, true, `기존 예약이 막혔다: ${JSON.stringify(v)}`);
    }
  });

  test('모르는 프로필 id는 프로필 없음으로 읽지 않는다', () => {
    eq(executionGateVerdict({ ...openRow, profileId: 'NOPE_100X' }).allowed, false,
      '오타 하나가 기존 방식으로 도는 예약이 된다');
  });

  // ── ⑩-b 차단될 요청은 거래소를 건드리지 않는다 ──
  //
  // "주문이 안 나갔다"로는 부족하다. 요청이 TESTNET인데 연결이 실계좌면,
  // 주문이 막혀도 그 전에 실계좌의 배율이 바뀔 수 있다. 계좌 설정이
  // 바뀌었고, 그 자리에 포지션이 있었다면 청산가가 함께 움직인다.
  const okFacts: EntryAuthorityFacts = {
    exchangeSupported: true, connIsLive: false, modeNeedsLiveKey: false,
    killSwitchReason: '', migrationReason: '', liveClosedReason: '',
  };

  test('권한이 통과하면 거래소 단계가 실행된다', async () => {
    let calls = 0;
    const r = await guardedEntry(okFacts, async () => { calls += 1; return 'planned'; });
    eq(r.verdict.allowed, true, r.verdict.reason);
    eq(r.result, 'planned');
    eq(calls, 1);
  });

  for (const [label, over, code] of [
    ['TESTNET 요청 + 실계좌 연결', { connIsLive: true }, 'MODE_CONN_MISMATCH'],
    ['실계좌 모드 + 테스트넷 연결', { modeNeedsLiveKey: true }, 'MODE_CONN_MISMATCH'],
    ['킬 스위치', { killSwitchReason: '사용자가 멈춤' }, 'KILL_SWITCH'],
    ['마이그레이션 밀림', { migrationReason: '칸이 없음' }, 'MIGRATION_PENDING'],
    ['선물 불가 거래소', { exchangeSupported: false }, 'NO_CONNECTION'],
  ] as const) {
    test(`${label}이면 거래소 단계가 한 번도 실행되지 않는다`, async () => {
      let calls = 0;
      const r = await guardedEntry({ ...okFacts, ...(over as any) },
        async () => { calls += 1; return 'planned'; });
      eq(r.verdict.allowed, false, `${label}인데 통과했다`);
      eq(r.verdict.code, code);
      eq(calls, 0, '차단될 요청인데 거래소 단계가 실행됐다');
      eq(r.result, null);
    });
  }

  test('목적지 확인이 킬 스위치보다 먼저다 — 어긋난 계좌를 먼저 걸러낸다', () => {
    const v = entryAuthorityVerdict({
      ...okFacts, connIsLive: true, killSwitchReason: '멈춤',
    });
    eq(v.code, 'MODE_CONN_MISMATCH', '엉뚱한 계좌인지부터 봐야 한다');
  });

  test('거래소를 건드리는 의존이 전부 분류돼 있다', () => {
    // 나중에 마진 모드 setter 같은 쓰기가 붙어도 같은 결함이 되살아나지
    // 않게, **모든 의존**을 읽기/쓰기로 나눠 둔다.
    const all = [...MUTATING_DEPS, ...READONLY_DEPS].sort();
    const probe = okDeps();
    eq(Object.keys(probe).sort().join(','), all.join(','),
      '분류되지 않은 의존이 있다 — 새 쓰기가 카운터 밖으로 샌다');
    eq(MUTATING_DEPS.join(','), 'applyLeverage');
  });

  test('진입 계획의 거래소 쓰기는 배율 하나뿐이다 — 통합 카운터', async () => {
    let writes = 0;
    const counted = okDeps({
      applyLeverage: async (lev: number) => { writes += 1; return { ok: true, observed: lev, message: '' }; },
    });
    await planEntry100x(contract100x, 10, counted);
    eq(writes, 1, '쓰기 횟수가 기대와 다르다');
    // 교차 마진이면 쓰기 0이어야 한다 — 막을 주문을 위해 계좌를 바꾸지 않는다.
    writes = 0;
    await planEntry100x(contract100x, 10,
      okDeps({
        observeMarginMode: async () => 'cross',
        applyLeverage: async (lev: number) => { writes += 1; return { ok: true, observed: lev, message: '' }; },
      }));
    eq(writes, 0, '교차인 걸 알기 전에 거래소를 바꿨다');
  });

  // ── ⑩-c 손절과 익절은 다른 축이다 ──
  test('전용 100배는 고정 익절도 걸지 않는다 — 숫자를 남기지 않았다', () => {
    eq(PROFILES[ID].takeProfitPolicy, 'NO_FIXED_TP');
    eq(PROFILES[ID].takeProfitPct, null,
      '복사해 온 익절 숫자가 남아 있으면 그것이 실제 익절 주문이 된다');
  });

  test('기존 프로필의 익절 의미는 그대로다', () => {
    for (const pid of ['SCALP_HIGH_LEV', 'SWING_LOW_LEV', 'DAILY_HIGH_LEV'] as const) {
      eq(PROFILES[pid].takeProfitPolicy, 'FIXED_TP', `${pid}의 익절이 꺼졌다`);
      assert(Number(PROFILES[pid].takeProfitPct) > 0, `${pid}의 익절 숫자가 사라졌다`);
    }
  });

  test('익절 정책은 손절 정책과 별개 축이다', () => {
    assert(CONTRACT_FIELDS.includes('takeProfitPolicy' as any),
      'takeProfitPolicy가 계약 칸이 아니다 — 지문이 이 변경을 못 잡는다');
    eq(takeProfitPolicyOfContract(null), 'FIXED_TP', '계약이 없으면 기존대로 익절을 건다');
    const r = resolveExecutionProfile(ID, PRESET, V);
    if (r.ok && r.kind === 'contract') {
      eq(r.contract.takeProfitPolicy, 'NO_FIXED_TP');
      eq(r.contract.takeProfitPct, null);
    }
  });

  // ── ⑪ 계약을 해석하지 않는 라우트는 계약을 받지 않는다 ──
  test('계약을 실은 요청을 알아본다 — 반쪽 선택도 계약이다', () => {
    eq(carriesExecutionContract({ executionProfileId: ID }), true);
    eq(carriesExecutionContract({ executionPresetId: PRESET }), true);
    eq(carriesExecutionContract({ executionContractVersion: 2 }), true);
    eq(carriesExecutionContract({ symbol: 'BTCUSDT' }), false);
    eq(carriesExecutionContract({ executionProfileId: null, executionPresetId: '' }), false);
    eq(carriesExecutionContract(null), false);
  });

  // ── ⑫ 켜기 조건(L3)이 표를 실제로 읽는가 ────────────────
  test('켜기 조건이 열린 조합을 그대로 담는다', () => {
    const spec = enableFilterSpec();
    eq(spec.kind, 'or', '켜기(L3) 조건이 표를 읽지 않는다');
    if (spec.kind === 'or') {
      assert(spec.expr.includes('execution_profile_id.is.null'), '기존 예약이 켜기에서 빠졌다');
      assert(spec.expr.includes(`execution_profile_id.eq.${ID}`), `${ID}가 없다`);
      assert(spec.expr.includes(`execution_preset_id.eq.${PRESET}`), '프리셋 조건이 없다');
      assert(spec.expr.includes('strategy_id.eq.scalp'), '전략 조건이 없다');
      assert(spec.expr.includes('mode.eq.TESTNET'), '모드 조건이 없다');
      assert(spec.expr.includes('margin_allocation_pct.not.is.null'), '배정 조건이 없다');
      assert(!spec.expr.includes('mode.eq.LIVE'), 'LIVE가 켜기 조건에 들어갔다');
    }
  });

  test('표가 비면 켜기 조건은 예전과 같다', () => {
    eq(enableFilterSpec([]).kind, 'isNull');
  });

  test('이상한 값은 켜기 조건 문자열을 만들지 못한다', () => {
    eq(enableFilterSpec([
      { strategyId: 'scalp', profileId: 'a,b', presetId: PRESET, contractVersion: 2, modes: ['TESTNET'], requiresMarginAllocation: true },
    ]).kind, 'isNull');
    eq(enableFilterSpec([
      { strategyId: 'scalp', profileId: ID, presetId: PRESET, contractVersion: 2, modes: ['TEST)NET'], requiresMarginAllocation: true },
    ]).kind, 'isNull');
    eq(enableFilterSpec([
      { strategyId: 'sc,alp', profileId: ID, presetId: PRESET, contractVersion: 2, modes: ['TESTNET'], requiresMarginAllocation: true },
    ]).kind, 'isNull');
  });

  // async 시험이 실패해도 통과로 집계되지 않게 여기서 기다린다.
  await flushAsync();
}

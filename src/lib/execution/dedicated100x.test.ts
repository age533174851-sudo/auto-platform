// 전용 100배 프로필이 **적힌 그대로 실행되는가.**
//
// 이 파일이 지키는 것은 수익이 아니라 일치다. 화면에 100배라고 적혀
// 있으면 거래소에도 100배가 걸려 있고, 아니면 주문이 나가지 않는다.
// 고정 손절을 안 쓴다고 했으면 lifecycle 어디에서도 손절이 새로 걸리지
// 않는다. 크기의 근거가 없으면 크기를 만들지 않는다.
import { test, assert, eq } from '../../test/harness';
import {
  resolveExecutionProfile, stopPolicyOfContract, marginAllocationOfContract,
  EXECUTION_CONTRACT_VERSION, CONTRACT_FIELDS,
} from './profile';
import { executionGateVerdict, enableFilterSpec, EXECUTABLE_PROFILE_IDS } from './dormantGate';
import { PROFILES, stopPolicyInvariantErrors } from '../strategies/profiles';
import { PRESET_TABLE, applyPreset } from '../strategies/profilePreset';
import { planSize100x } from '../engine/sizing100x';
import { stopReattachVerdict } from '../engine/stopReattach';
import { leverageVerdict } from '../exchanges/futuresExec';
import { appliesTo, FIXED_STOP_ONLY_CHECKS } from '../engine/preTradeChecklist';

const V = EXECUTION_CONTRACT_VERSION;
const ID = 'MAX_LEV_100X';

/** 통과하는 사이징 입력 한 벌. 시험마다 한 칸씩만 바꿔서 쓴다 */
const goodSizing = {
  requiredLeverage: 100,
  observedLeverage: 100,
  availableUsd: 1_000,
  // **정본은 null이다.** 시험이 값을 주입해서 성공 경로를 확인한다 —
  // 정본에 숫자를 넣으면 아직 정하지 않은 값을 정한 것이 된다.
  marginAllocationPct: 10,
  referencePrice: 50_000,
};

export function runDedicated100xTests() {
  // ── ① 정체 ──────────────────────────────────────────────
  test('전용 100배는 별도 id다 — 기존 세 프로필의 의미가 바뀌지 않았다', () => {
    assert(!!(PROFILES as any)[ID], '전용 100배 프로필이 없다');
    eq(PROFILES.DAILY_HIGH_LEV.leverage, 10, 'DAILY_HIGH_LEV가 재정의됐다');
    eq(PROFILES.DAILY_HIGH_LEV.maxLeverage, 100, 'DAILY_HIGH_LEV 상한이 바뀌었다');
    eq(PROFILES.DAILY_HIGH_LEV.stopLossPct, 0.5, 'DAILY_HIGH_LEV 손절이 바뀌었다');
    eq(PROFILES.SCALP_HIGH_LEV.leverage, 25, 'SCALP가 바뀌었다');
    eq(PROFILES.SWING_LOW_LEV.leverage, 4, 'SWING이 바뀌었다');
  });

  test('전용 100배는 요청값이 정확히 100이다 — 상한이 아니다', () => {
    eq(PROFILES[ID].leverage, 100);
    eq(PROFILES[ID].maxLeverage, 100, '상한과 요청값이 다르면 "정확히 100"이 아니다');
  });

  // ── ② 프리셋 불변 ───────────────────────────────────────
  test('어느 프리셋에서도 전용 100배의 배율은 100이다', () => {
    for (const sid of Object.keys(PRESET_TABLE)) {
      const merged = applyPreset(PROFILES[ID], sid as any);
      eq(merged.leverage, 100, `${sid}에서 기본 배율이 100이 아니다`);
      eq(merged.maxLeverage, 100, `${sid}에서 상한이 100이 아니다`);
    }
  });

  test('프리셋 표에 전용 100배 항목이 실제로 적혀 있다 — 키 누락에 기대지 않는다', () => {
    for (const sid of Object.keys(PRESET_TABLE)) {
      const row = (PRESET_TABLE as any)[sid][ID];
      assert(row && row.maxLeverage === 100,
        `${sid}에 ${ID} 항목이 없다 — 지금은 100이지만 그건 항목이 없어서다`);
    }
  });

  // ── ③ 손절 정책 ─────────────────────────────────────────
  test('stopPolicy와 stopLossPct의 짝이 맞는다', () => {
    const errs = stopPolicyInvariantErrors();
    eq(errs.join(' / '), '', '정책과 손절 숫자가 어긋난 프로필이 있다');
  });

  test('전용 100배에는 synthetic stop이 없다 — stopLossPct는 null이다', () => {
    eq(PROFILES[ID].stopPolicy, 'NO_FIXED_SL');
    eq(PROFILES[ID].stopLossPct, null, '0이나 다른 숫자가 남아 있으면 그것이 손절로 되살아난다');
  });

  test('계약에도 두 축이 실려 나간다', () => {
    assert(CONTRACT_FIELDS.includes('stopPolicy' as any), 'stopPolicy가 계약 칸이 아니다');
    assert(CONTRACT_FIELDS.includes('marginAllocationPct' as any),
      'marginAllocationPct가 계약 칸이 아니다');
    const r = resolveExecutionProfile(ID, 'STABILIZE', V);
    assert(r.ok && r.kind === 'contract', '전용 100배 계약이 해석되지 않는다');
    if (r.ok && r.kind === 'contract') {
      eq(r.contract.stopPolicy, 'NO_FIXED_SL');
      eq(r.contract.leverage, 100);
      eq(r.contract.stopLossPct, null);
      eq(r.contract.marginAllocationPct, null, '증거금 배정은 아직 정해지지 않았다');
    }
  });

  // ── ④ 누출 방지 ─────────────────────────────────────────
  test('계약이 없으면 NO_FIXED_SL 의미를 만들 수 없다 — 레거시 levCap 100은 계약이 아니다', () => {
    eq(stopPolicyOfContract(null), 'FIXED_SL');
    eq(stopPolicyOfContract(undefined), 'FIXED_SL');
    eq(marginAllocationOfContract(null), null);
  });

  test('전용 100배 외의 어떤 프로필도 NO_FIXED_SL이 아니다', () => {
    for (const pid of Object.keys(PROFILES)) {
      for (const sid of Object.keys(PRESET_TABLE)) {
        const r = resolveExecutionProfile(pid, sid, V);
        assert(r.ok && r.kind === 'contract', `${pid}/${sid} 해석 실패`);
        if (r.ok && r.kind === 'contract') {
          const want = pid === ID ? 'NO_FIXED_SL' : 'FIXED_SL';
          eq(stopPolicyOfContract(r.contract), want, `${pid}/${sid}의 손절 정책이 다르다`);
        }
      }
    }
  });

  // ── ⑤ 정확 배율 ─────────────────────────────────────────
  test('되읽은 배율이 정확히 100일 때만 크기를 만든다', () => {
    const ok = planSize100x(goodSizing);
    assert(ok.ok, `정상 입력이 막혔다: ${ok.message}`);
    eq(ok.leverage, 100);
    // 1000 × 10% = 100 증거금 → ×100배 = 10,000 명목가 ÷ 50,000 = 0.2
    eq(ok.allocatedMargin, 100);
    eq(ok.targetNotional, 10_000);
    eq(ok.quantity, 0.2);
  });

  for (const [label, observed] of [['99배', 99], ['75배', 75], ['모름', null]] as const) {
    test(`되읽은 배율이 ${label}이면 크기를 만들지 않는다`, () => {
      const v = planSize100x({ ...goodSizing, observedLeverage: observed as any });
      eq(v.ok, false, `${label}인데 통과했다`);
      eq(v.code, 'LEVERAGE_NOT_EXACT');
      eq(v.quantity, null, '막았는데 수량이 남아 있다');
    });
  }

  test('배율 판정은 leverageVerdict와 같은 방향이다 — 두 곳이 갈리지 않는다', () => {
    eq(leverageVerdict(100, 100, 100).ok, true);
    eq(leverageVerdict(100, 100, 75).ok, false, '거래소가 낮춘 것을 통과시키면 안 된다');
    eq(leverageVerdict(100, 100, null).ok, false);
    eq(leverageVerdict(100, 100, 101).ok, false);
  });

  // ── ⑥ 크기의 근거가 없으면 크기를 만들지 않는다 ──────────
  test('증거금 배정 미지정이면 막는다 — 화면 기본값을 빌려 오지 않는다', () => {
    const v = planSize100x({ ...goodSizing, marginAllocationPct: null });
    eq(v.ok, false);
    eq(v.code, 'MARGIN_ALLOCATION_UNSET');
    eq(v.quantity, null);
  });

  test('정본 프로필 그대로면 지금은 반드시 막힌다 — 배정 비율이 아직 없다', () => {
    const v = planSize100x({ ...goodSizing, marginAllocationPct: PROFILES[ID].marginAllocationPct });
    eq(v.ok, false, '아직 정하지 않은 값으로 100배 주문이 나갔다');
    eq(v.code, 'MARGIN_ALLOCATION_UNSET');
  });

  test('잔고를 못 읽으면 막는다 — 0으로 눕히지 않는다', () => {
    const v = planSize100x({ ...goodSizing, availableUsd: null });
    eq(v.ok, false);
    eq(v.code, 'BALANCE_UNKNOWN');
  });

  test('기준가를 못 읽으면 막는다', () => {
    const v = planSize100x({ ...goodSizing, referencePrice: null });
    eq(v.ok, false);
    eq(v.code, 'PRICE_UNKNOWN');
  });

  test('배정 비율이 범위를 벗어나면 막는다', () => {
    for (const pct of [0, -5, 101, NaN]) {
      const v = planSize100x({ ...goodSizing, marginAllocationPct: pct });
      eq(v.ok, false, `${pct}%가 통과했다`);
      eq(v.code, 'MARGIN_ALLOCATION_INVALID');
    }
  });

  // ── ⑦ 고정 손절 재부착 0건 ──────────────────────────────
  test('NO_FIXED_SL 주문에는 손절을 다시 걸지 않는다 — 손절가가 남아 있어도', () => {
    const v = stopReattachVerdict({ stop_policy: 'NO_FIXED_SL', stop_loss: 49_000 });
    eq(v.attach, false, '고정 손절 없는 프로필에 손절이 다시 걸린다');
    eq(v.code, 'NO_FIXED_SL');
    assert(v.note !== '', '일부러 안 했다는 사실이 기록에 남지 않는다');
  });

  test('정책이 값보다 먼저다 — 순서가 뒤집히면 이 시험이 깨진다', () => {
    // stop_loss가 채워져 있는데도 정책이 이긴다. 값 검사가 앞에 오면
    // 여기서 ATTACH가 나온다.
    eq(stopReattachVerdict({ stop_policy: 'NO_FIXED_SL', stop_loss: 1 }).code, 'NO_FIXED_SL');
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

  // ── ⑧ 체크리스트 N/A ────────────────────────────────────
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

  // ── ⑨ dormant 게이트 ────────────────────────────────────
  test('열린 목록이 비어 있으면 전용 100배는 켜지지 않는다', () => {
    eq(EXECUTABLE_PROFILE_IDS.length, 0,
      '자동 종료 권한 증명 전에 목록이 채워졌다 — dormantGate 머리말 참조');
    const v = executionGateVerdict(ID);
    eq(v.allowed, false);
    assert(v.reason !== '', '막았는데 이유가 없다');
  });

  test('프로필이 없는 기존 예약은 게이트와 무관하다', () => {
    for (const v of [null, undefined, '', '   ']) {
      eq(executionGateVerdict(v).allowed, true, `기존 예약이 막혔다: ${JSON.stringify(v)}`);
    }
  });

  test('모르는 프로필 id는 프로필 없음으로 읽지 않는다', () => {
    const v = executionGateVerdict('NOPE_100X');
    eq(v.allowed, false, '오타 하나가 기존 방식으로 도는 예약이 된다');
  });

  test('목록을 채우면 세 층이 함께 열린다 — 한 곳만 열리지 않는다', () => {
    const opened = [ID];
    eq(executionGateVerdict(ID, opened).allowed, true, '실행기(L4)가 안 열린다');
    const spec = enableFilterSpec(opened);
    eq(spec.kind, 'or', '켜기(L3) 조건이 목록을 읽지 않는다');
    assert(spec.kind === 'or' && spec.expr.includes(ID),
      `켜기 조건에 ${ID}가 없다: ${JSON.stringify(spec)}`);
    assert(spec.kind === 'or' && spec.expr.includes('is.null'),
      '기존 예약(프로필 없음)이 켜기에서 빠졌다');
  });

  test('목록이 비면 켜기 조건은 지금까지와 같다', () => {
    eq(enableFilterSpec([]).kind, 'isNull');
    eq(enableFilterSpec().kind, 'isNull');
  });

  test('이상한 id는 켜기 조건 문자열을 만들지 못한다', () => {
    // 쉼표·괄호가 들어가면 PostgREST 문법이 깨져서 조건이 통째로 무의미해진다.
    eq(enableFilterSpec(['a,b', 'x)y', '']).kind, 'isNull');
  });
}

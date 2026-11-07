// src/lib/engine/exitAuthority.test.ts
//
// **종료 권한은 "닫을 수 있다"가 아니라 "닫아도 된다"를 시험한다.**
//
// 이 파일은 권한 판정만 본다. 실제 전송 순서(권한 → 전송 → 재조회)는
// `lifecycleAction`이, 정책 숫자는 `exitPolicy`가 본다 — 같은 것을 두
// 곳에서 시험하면 한쪽만 고쳐지고 그때 두 답이 갈린다.
//
// ★ 진입 후 보호다. 하지만 **지금 열려 있는 사유는 시간 청산 하나뿐**
//   이고, 그 사실 자체를 시험한다.
import { test, eq, assert } from '../../test/harness';
import {
  decideExitAuthority, type ExitAuthorityInput, type ExitCapabilities,
  type PositionIdentity,
} from './exitAuthority';
import { resolveExitPolicy } from './exitPolicy';
import { seatExitCapabilities } from './managedPosition';

const NOW = 1_800_000_000_000;
const FOUR_H = 4 * 3600 * 1000;

/** 전용 100배 계약. `profiles.MAX_LEV_100X`가 4시간을 선언한다 */
const EXACT100X = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 };

const CAPS: ExitCapabilities = {
  fixedStopAtEntry: false, breakEven: false, trailing: false,
  timeExit: true, emergency: false,
};

const PID = (over: Partial<PositionIdentity> = {}): PositionIdentity => ({
  exchange: 'binance', connectionId: 'conn-1', symbol: 'BTCUSDT', side: 'LONG',
  executionIdentity: EXACT100X, openingOrderId: 'ord-1',
  positionMode: 'ONE_WAY', ...over,
});

const input = (over: Partial<ExitAuthorityInput> = {}): ExitAuthorityInput => ({
  positionIdentity: PID(),
  strategyId: 'scalp',
  capabilities: { ...CAPS },
  reason: 'TIME_EXIT',
  openedAtMs: NOW - FOUR_H,
  observed: { ok: true, found: true, qty: 0.2, side: 'LONG' },
  lease: { owned: true, identity: { holder: 'worker:a', fence: 7 } },
  nowMs: NOW,
  ...over,
});

export function runExitAuthorityTests() {
  // ══════════════════════════════════════════════════════════
  // 대조군 — 정상 케이스가 **실제로 통과한다**
  // ══════════════════════════════════════════════════════════
  test('4시간에 도달한 Exact100X 포지션은 축소 전용 청산이 허가된다', () => {
    const d = decideExitAuthority(input());
    assert(d.authorized, `정상인데 막혔다 — ${d.reason}`);
    eq(d.code, 'AUTHORIZED');
    eq(d.reasonCode, 'TIME_EXIT');
    eq(d.requestedAction, 'CLOSE');
    eq(d.reduceOnly, true, '★ 축소 전용이 아니면 반대 포지션이 생긴다');
    eq(d.requestedQuantity, 0.2);
    eq(d.policySource, 'EXECUTION_CONTRACT');
    eq(d.policyVersion, 'contract:MAX_LEV_100X/EXACT_100X/v2');
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-12 경계 — `>=`인가 `>`인가
  // ══════════════════════════════════════════════════════════
  test('보유 < 4시간이면 닫지 않는다', () => {
    const d = decideExitAuthority(input({ openedAtMs: NOW - FOUR_H + 1 }));
    assert(!d.authorized); eq(d.code, 'POLICY_NOT_DUE');
  });

  test('보유 == 4시간이면 닫는다 (경계는 >=다)', () => {
    const d = decideExitAuthority(input({ openedAtMs: NOW - FOUR_H }));
    assert(d.authorized, `★ 경계를 >로 두면 정확히 4시간인 포지션이 통과한다 — ${d.reason}`);
    eq(d.heldMs, FOUR_H);
  });

  test('보유 > 4시간이면 닫는다', () => {
    const d = decideExitAuthority(input({ openedAtMs: NOW - FOUR_H - 1 }));
    assert(d.authorized); eq(d.code, 'AUTHORIZED');
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-2 정책 소유자 — 전략 6시간으로 내려가지 않는다
  // ══════════════════════════════════════════════════════════
  test('계약 4시간을 쓴다 — 전략 scalp의 6시간이 아니다', () => {
    // 5시간 보유: 계약(4h)이면 닫히고, 전략(6h)이면 안 닫힌다.
    const d = decideExitAuthority(input({ openedAtMs: NOW - 5 * 3600 * 1000 }));
    assert(d.authorized, '★ 전략 6시간으로 판정하면 여기서 막힌다');
    const pol = resolveExitPolicy({ executionIdentity: EXACT100X, strategyId: 'scalp' });
    eq(pol.maxHoldMs, FOUR_H, '★ 계약이 선언한 4시간이 아니다');
    eq(pol.source, 'EXECUTION_CONTRACT');
  });

  test('계약 기록이 없으면 전략 기본값으로 닫지 않는다 — fail-closed', () => {
    const d = decideExitAuthority(input({
      positionIdentity: PID({ executionIdentity: null }),
      openedAtMs: NOW - 7 * 3600 * 1000,   // 전략 6시간이면 넘는다
    }));
    assert(!d.authorized, '★ 사용자가 고르지 않은 보유 한도로 닫았다');
    eq(d.code, 'IDENTITY_INCOMPLETE');
  });

  test('계약을 풀지 못하면 막는다 — 전략 값으로 내려가지 않는다', () => {
    const d = decideExitAuthority(input({
      positionIdentity: PID({
        executionIdentity: { profileId: 'NO_SUCH', presetId: 'NOPE', contractVersion: 1 },
      }),
      openedAtMs: NOW - 7 * 3600 * 1000,
    }));
    assert(!d.authorized); eq(d.code, 'POLICY_UNRESOLVED');
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-12 openedAt
  // ══════════════════════════════════════════════════════════
  for (const [label, v] of [
    ['null', null], ['undefined', undefined], ['NaN', NaN],
    ['Infinity', Infinity], ['0', 0], ['음수', -1], ['문자열', 'x'],
  ] as const) {
    test(`진입 시각이 ${label}이면 막는다 — 지금으로도 0으로도 대체하지 않는다`, () => {
      const d = decideExitAuthority(input({ openedAtMs: v as any }));
      assert(!d.authorized, `${label}인데 통과했다`);
      eq(d.code, 'OPENED_AT_UNUSABLE');
    });
  }

  test('진입 시각이 미래면 막는다 — 경과를 0으로 깎지 않는다', () => {
    const d = decideExitAuthority(input({ openedAtMs: NOW + 60_000 }));
    assert(!d.authorized, '★ 미래 시각이 "방금 열림"으로 읽혀 조용히 통과했다');
    eq(d.code, 'OPENED_AT_UNUSABLE');
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-5 임차 — 거래소를 **읽기 전에** 본다
  // ══════════════════════════════════════════════════════════
  test('임차가 내 것이 아니면 막는다', () => {
    const d = decideExitAuthority(input({
      lease: { owned: false, identity: { holder: 'worker:b', fence: 9 },
               reason: '내 울타리(7)가 낡았습니다 — 지금은 9입니다' },
    }));
    assert(!d.authorized); eq(d.code, 'NOT_OWNER');
    assert(d.reason.includes('울타리'), '왜 아닌지 적어야 한다');
  });

  test('임차 판정이 없으면 막는다 — 확인하지 못한 것은 통과가 아니다', () => {
    for (const lease of [null, undefined, {} as any]) {
      const d = decideExitAuthority(input({ lease }));
      assert(!d.authorized, `lease=${JSON.stringify(lease)}인데 통과했다`);
      eq(d.code, 'NOT_OWNER');
    }
  });

  test('임차 신원(울타리 번호)을 판정에 남긴다', () => {
    const d = decideExitAuthority(input());
    eq(d.leaseIdentity?.fence, 7);
    eq(d.leaseIdentity?.holder, 'worker:a');
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-7/⑤-8/⑤-9 현재 노출
  // ══════════════════════════════════════════════════════════
  test('포지션을 못 읽으면 flat으로 읽지 않는다', () => {
    const d = decideExitAuthority(input({ observed: { ok: false, found: false, qty: null, side: null } }));
    assert(!d.authorized); eq(d.code, 'POSITION_READ_FAILED');
  });

  test('이미 flat이면 주문을 만들지 않는다', () => {
    const d = decideExitAuthority(input({ observed: { ok: true, found: false, qty: 0, side: null } }));
    assert(!d.authorized, '★ flat에 MARKET 주문을 내면 반대 포지션이 된다');
    eq(d.code, 'ALREADY_FLAT');
    eq(d.requestedAction, 'NONE');
    eq(d.requestedQuantity, null);
  });

  test('거래소 방향이 장부와 다르면 막는다 — 다른 다리를 닫지 않는다', () => {
    const d = decideExitAuthority(input({
      observed: { ok: true, found: true, qty: 0.2, side: 'SHORT' },
    }));
    assert(!d.authorized); eq(d.code, 'IDENTITY_MISMATCH');
  });

  test('포지션 모드를 모르거나 헤지면 막는다', () => {
    for (const mode of [null, 'HEDGE'] as const) {
      const d = decideExitAuthority(input({ positionIdentity: PID({ positionMode: mode }) }));
      assert(!d.authorized, `모드 ${String(mode)}인데 통과했다`);
      eq(d.code, 'IDENTITY_MISMATCH');
    }
  });

  test('닫을 수량은 **지금 관측한 노출**이다 — 진입 수량이 아니다', () => {
    // 수동으로 절반을 닫아 둔 상태.
    const d = decideExitAuthority(input({
      observed: { ok: true, found: true, qty: 0.07, side: 'LONG' },
    }));
    assert(d.authorized);
    eq(d.requestedQuantity, 0.07, '★ 진입 수량으로 닫으면 반대 포지션이 생긴다');
    eq(d.observedPositionQuantity, 0.07);
  });

  for (const [label, q] of [['null', null], ['0', 0], ['음수', -1], ['NaN', NaN]] as const) {
    test(`관측 수량이 ${label}이면 막는다`, () => {
      const d = decideExitAuthority(input({
        observed: { ok: true, found: true, qty: q as any, side: 'LONG' },
      }));
      assert(!d.authorized, `${label}인데 통과했다`);
      assert(d.code === 'QUANTITY_UNUSABLE' || d.code === 'ALREADY_FLAT',
        `예상 밖 코드 ${d.code}`);
    });
  }

  test('포지션 신원이 반쪽이면 막는다 — 종목만 보고 닫지 않는다', () => {
    for (const over of [{ symbol: '' }, { connectionId: '' },
                        { side: null as any }, { exchange: null as any }]) {
      const d = decideExitAuthority(input({ positionIdentity: PID(over) }));
      assert(!d.authorized, `${JSON.stringify(over)}인데 통과했다`);
      eq(d.code, 'IDENTITY_INCOMPLETE');
    }
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-4/⑤-15 capability — 네 기능을 같이 열지 않는다
  // ══════════════════════════════════════════════════════════
  test('시간 청산이 닫혀 있으면 허가하지 않는다', () => {
    const d = decideExitAuthority(input({
      capabilities: { ...CAPS, timeExit: false },
    }));
    assert(!d.authorized); eq(d.code, 'CAPABILITY_NOT_ENABLED');
  });

  test('NO_FIXED_SL 전용 100배 노출은 **시간 청산만** 열린다', () => {
    const c = seatExitCapabilities({
      stopPolicy: 'NO_FIXED_SL', hasStopValue: false, executionIdentity: EXACT100X,
    });
    eq(c.exposureClass, 'NO_FIXED_SL_EXACT100X');
    eq(c.capabilities.timeExit, true);
    eq(c.capabilities.trailing, false, '★ 트레일링이 함께 열렸다');
    eq(c.capabilities.breakEven, false, '★ 본전이동이 함께 열렸다');
    eq(c.capabilities.fixedStopAtEntry, false, '★ 고정 손절이 함께 열렸다');
    eq(c.capabilities.emergency, false, '★ 구현이 없는 비상 종료를 true로 적었다');
  });

  test('계약 기록이 없는 NO_FIXED_SL은 아무것도 열지 않는다', () => {
    const c = seatExitCapabilities({
      stopPolicy: 'NO_FIXED_SL', hasStopValue: false, executionIdentity: null,
    });
    eq(c.exposureClass, 'BROKEN_CONTRACT');
    eq(c.capabilities.timeExit, false);
  });

  test('계약과 장부가 어긋나면(손절 값이 있음) 아무것도 열지 않는다', () => {
    const c = seatExitCapabilities({
      stopPolicy: 'NO_FIXED_SL', hasStopValue: true, executionIdentity: EXACT100X,
    });
    eq(c.exposureClass, 'BROKEN_CONTRACT');
    eq(c.capabilities.timeExit, false);
  });

  test('모르는 손절 정책은 아무것도 열지 않는다', () => {
    const c = seatExitCapabilities({
      stopPolicy: 'UNKNOWN', hasStopValue: true, executionIdentity: EXACT100X,
    });
    eq(c.exposureClass, 'BROKEN_CONTRACT');
    for (const k of Object.keys(c.capabilities) as Array<keyof typeof c.capabilities>) {
      eq(c.capabilities[k], false, `${k}가 열렸다`);
    }
  });

  // ══════════════════════════════════════════════════════════
  // 막혔을 때도 기록을 남긴다
  // ══════════════════════════════════════════════════════════
  test('막힌 판정도 신원·정책·시각을 들고 있다', () => {
    const d = decideExitAuthority(input({ openedAtMs: NOW - 60_000 }));
    assert(!d.authorized);
    eq(d.positionIdentity.symbol, 'BTCUSDT');
    eq(d.executionProfileId, 'MAX_LEV_100X');
    eq(d.decisionAt, NOW);
    eq(d.policySource, 'EXECUTION_CONTRACT');
    assert(d.heldMs != null, '보유 경과를 적어야 한다');
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-13 판정 시각은 인자다
  // ══════════════════════════════════════════════════════════
  test('같은 입력에 같은 판정 시각이면 같은 답이다 (Date.now를 안 부른다)', () => {
    const a = decideExitAuthority(input({ nowMs: NOW }));
    const b = decideExitAuthority(input({ nowMs: NOW }));
    eq(a.code, b.code); eq(a.heldMs, b.heldMs); eq(a.decisionAt, b.decisionAt);
    // 판정 시각을 바꾸면 답이 바뀐다 — 즉 내부에서 Date.now를 쓰지 않는다.
    const c = decideExitAuthority(input({ nowMs: NOW - FOUR_H }));
    eq(c.code, 'POLICY_NOT_DUE');
  });
}

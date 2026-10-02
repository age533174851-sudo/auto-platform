// src/lib/engine/exitAuthorityRun.test.ts
//
// **"닫을 수 있다"가 아니라 "두 번 닫지 않는다"를 시험한다.**
//
// 단일 함수 시험만으로는 이 단계가 끝나지 않는다. 가장 위험한 고장은
// 경합에서 나온다 — 임차 탈취 · 수동 청산 · 전송 성공 후 기록 전 죽음.
// 전부 **주입한 의존으로 결정적으로** 재현한다. sleep은 쓰지 않는다.
import { test, eq, assert } from '../../test/harness';
import {
  runExitAuthority, type ExitRunCandidate, type ExitRunDeps,
} from './exitAuthorityRun';

const NOW = 1_800_000_000_000;
const FOUR_H = 4 * 3600 * 1000;
const EXACT100X = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 };

const candidate = (over: Partial<ExitRunCandidate> = {}): ExitRunCandidate => ({
  positionIdentity: {
    exchange: 'binance', connectionId: 'conn-1', symbol: 'BTCUSDT', side: 'LONG',
    executionIdentity: EXACT100X, openingOrderId: 'ord-1',
  },
  strategyId: 'scalp',
  executionIdentity: EXACT100X,
  capabilities: {
    fixedStopAtEntry: false, breakEven: false, trailing: false,
    timeExit: true, emergency: false,
  },
  reason: 'TIME_EXIT',
  openedAtMs: NOW - FOUR_H,
  ...over,
});

/** 호출을 순서대로 적는 가짜 바깥 세계 */
function rig(over: Partial<ExitRunDeps> = {}, opts: {
  fenceFirst?: boolean; fenceSecond?: boolean;
  exposure?: number | null; readOk?: boolean;
  sendResult?: { attempted: boolean; ok: boolean; error: string | null; ambiguous?: boolean };
  afterFound?: boolean; afterOk?: boolean;
} = {}) {
  const log: string[] = [];
  const base: ExitRunDeps = {
    leaseOwned: async () => {
      log.push('lease');
      return opts.fenceFirst === false
        ? { owned: false, identity: { holder: 'b', fence: 11 }, reason: '울타리가 낡았습니다' }
        : { owned: true, identity: { holder: 'a', fence: 10 } };
    },
    prepareClose: async () => {
      log.push('prepare');
      if (opts.readOk === false) {
        return { code: 'READ_FAILED' as const, prepared: null, message: '포지션 조회 실패' };
      }
      const q = opts.exposure === undefined ? 0.2 : opts.exposure;
      if (q === 0 || q == null) {
        return { code: 'ALREADY_FLAT' as const, prepared: null, message: '이미 포지션이 없습니다' };
      }
      return {
        code: 'READY' as const,
        prepared: { quantity: q, orderSide: 'SELL' as const, reduceOnly: true as const,
                    observedQty: q, positionMode: 'ONE_WAY' as const },
        message: `${q} 종료 준비`,
      };
    },
    revalidateFence: async () => {
      log.push('revalidate');
      return opts.fenceSecond !== false;
    },
    sendClose: async () => {
      log.push('send');
      return opts.sendResult ?? { attempted: true, ok: true, error: null };
    },
    readAfter: async () => {
      log.push('readAfter');
      return { ok: opts.afterOk !== false, found: opts.afterFound === true };
    },
    ...over,
  };
  return { deps: base, log };
}

export function runExitAuthorityRunTests() {
  // ══════════════════════════════════════════════════════════
  // 런타임 순서 — **타입 선언이 아니라 실제 호출로** 증명한다
  // ══════════════════════════════════════════════════════════
  test('정상 경로의 호출 순서 — 재검증이 전송 **바로 앞**이다', async () => {
    const { deps, log } = rig();
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'CLOSED_VERIFIED', r.reason);
    eq(log.join(' > '), 'lease > prepare > revalidate > send > readAfter',
      '★ 순서가 계약과 다르다');
    // 재검증과 전송 사이에 **아무것도 없다.** 그 창이 넓으면 느린 실행자가
    // 울타리를 확인하고도 남의 포지션에 주문을 낸다.
    const i = log.indexOf('revalidate');
    eq(log[i + 1], 'send', '★ 재검증과 전송 사이에 다른 호출이 끼었다');
  });

  test('노출 조회·모드 확인은 재검증 **앞**에서 끝난다', async () => {
    const { deps, log } = rig();
    await runExitAuthority(candidate(), deps, NOW);
    assert(log.indexOf('prepare') < log.indexOf('revalidate'),
      '★ 재검증 뒤에 조회가 남아 있으면 그만큼 창이 넓어진다');
  });

  // ══════════════════════════════════════════════════════════
  // Case A — A가 임차, B는 실패 → 청산 1회
  // ══════════════════════════════════════════════════════════
  test('Case A: 임차를 못 얻은 실행자는 거래소를 읽지도 쓰지도 않는다', async () => {
    const { deps, log } = rig({}, { fenceFirst: false });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'NOT_OWNER');
    eq(r.attemptedWrite, false);
    eq(log.join(' > '), 'lease', '★ 남의 임차인데 거래소를 건드렸다');
  });

  test('Case A: 임차를 얻은 실행자만 정확히 한 번 보낸다', async () => {
    const { deps, log } = rig();
    await runExitAuthority(candidate(), deps, NOW);
    eq(log.filter(x => x === 'send').length, 1, '★ 두 번 보냈다');
  });

  // ══════════════════════════════════════════════════════════
  // Case B — 느린 A가 뒤늦게 깨어난다 (stale fence)
  // ══════════════════════════════════════════════════════════
  test('Case B: 판정 시점엔 내 것이었는데 쓰기 직전에 넘어갔으면 보내지 않는다', async () => {
    // A는 fence 10으로 임차를 얻고 노출까지 읽었다. 그 사이 만료되어
    // B가 fence 11을 얻었다. A의 **쓰기 직전 재검증**이 막아야 한다.
    const { deps, log } = rig({}, { fenceFirst: true, fenceSecond: false });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'LEASE_LOST');
    eq(r.attemptedWrite, false, '★ 울타리가 넘어갔는데 주문이 나갔다');
    assert(!log.includes('send'), `★ 주문을 보냈다 — ${log.join(' > ')}`);
    eq(log.join(' > '), 'lease > prepare > revalidate');
  });

  // ══════════════════════════════════════════════════════════
  // Case C — 이번 단계의 핵심
  // ══════════════════════════════════════════════════════════
  test('Case C: 노출 READ 도중 권한을 잃으면 즉시 재검사가 막는다', async () => {
    // 첫 확인은 true, 노출을 읽는 동안 임차가 넘어가고, 즉시 재검사는 false.
    let owned = true;
    const { deps, log } = rig({
      leaseOwned: async () => { log.push('lease'); return { owned: true, identity: { holder: 'a', fence: 10 } }; },
      prepareClose: async () => {
        log.push('prepare');
        owned = false;   // ← 읽는 동안 넘어갔다
        return { code: 'READY' as const,
          prepared: { quantity: 0.2, orderSide: 'SELL' as const, reduceOnly: true as const,
                      observedQty: 0.2, positionMode: 'ONE_WAY' as const },
          message: '준비' };
      },
      revalidateFence: async () => { log.push('revalidate'); return owned; },
    });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'LEASE_LOST', '★ 첫 확인만 믿으면 여기서 주문이 나간다');
    eq(r.attemptedWrite, false);
    assert(!log.includes('send'));
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-10 crash-before-persist 멱등
  // ══════════════════════════════════════════════════════════
  test('Case D: 전송 성공 후 기록 전에 죽고 재시작하면 두 번째는 주문 0건', async () => {
    // 1회차: 정상 청산. 기록은 못 했다고 치자.
    const first = rig();
    const r1 = await runExitAuthority(candidate(), first.deps, NOW);
    eq(r1.code, 'CLOSED_VERIFIED');
    eq(first.log.filter(x => x === 'send').length, 1);

    // 2회차: 같은 후보를 다시 발견. 거래소는 이미 flat이다.
    const second = rig({}, { exposure: 0 });
    const r2 = await runExitAuthority(candidate(), second.deps, NOW);
    eq(r2.code, 'ALREADY_FLAT');
    eq(r2.attemptedWrite, false, '★ 두 번째 reduceOnly MARKET 주문이 나갔다');
    eq(r2.reconciledFlat, true);
    eq(r2.ok, true, '할 일이 끝난 것이다 — 실패가 아니다');
    assert(!second.log.includes('send'), `★ 주문을 보냈다 — ${second.log.join(' > ')}`);
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-11 수동 청산 경합
  // ══════════════════════════════════════════════════════════
  test('Case E: 후보 생성 뒤 사용자가 수동으로 닫았으면 자동 주문 0건', async () => {
    const { deps, log } = rig({}, { exposure: 0 });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'ALREADY_FLAT');
    eq(r.attemptedWrite, false, '★ flat에 MARKET을 보내면 반대 포지션이 된다');
    eq(r.closedQuantity, null);
    assert(!log.includes('send'));
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-7 ALREADY_FLAT 의미
  // ══════════════════════════════════════════════════════════
  test('ALREADY_FLAT은 "성공"과 "전송"을 같은 값으로 적지 않는다', async () => {
    const { deps } = rig({}, { exposure: 0 });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.ok, true);
    eq(r.attemptedWrite, false);
    eq(r.accepted, null);
    eq(r.reconciledFlat, true);
    eq(r.failed, false, '안전 상태를 실패 집계에 넣지 않는다');
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-9 timeout / ambiguous
  // ══════════════════════════════════════════════════════════
  test('전송 결과를 몰라도 재조회가 flat이면 대조로 닫힌 것이다', async () => {
    const { deps, log } = rig({}, {
      sendResult: { attempted: true, ok: false, error: 'socket hang up', ambiguous: true },
      afterFound: false,
    });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'RECONCILED_CLOSED', '★ 타임아웃을 실패로 적으면 같은 자리에 또 보낸다');
    eq(r.ok, true);
    eq(r.accepted, null, '접수 여부는 모른다');
    eq(r.flatVerified, true);
    assert(log.includes('readAfter'), '★ 보냈으면 반드시 다시 읽는다');
  });

  test('전송 결과를 모르고 포지션도 남아 있으면 대조 대상이다', async () => {
    const { deps } = rig({}, {
      sendResult: { attempted: true, ok: false, error: 'timeout', ambiguous: true },
      afterFound: true,
    });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'CLOSE_UNKNOWN_RECONCILE_REQUIRED');
    eq(r.needsReconcile, true);
    eq(r.failed, true);
  });

  test('재조회에 실패하면 "닫혔다"로 적지 않는다', async () => {
    const { deps } = rig({}, { afterOk: false });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'CLOSE_UNKNOWN_RECONCILE_REQUIRED');
    eq(r.flatVerified, null, '★ 못 읽은 것을 0으로 적었다');
    eq(r.needsReconcile, true);
  });

  test('거래소가 명시적으로 거부하면 대조 대상이 아니다', async () => {
    const { deps } = rig({}, {
      sendResult: { attempted: true, ok: false, error: '-2022 ReduceOnly Order is rejected' },
    });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'CLOSE_REJECTED');
    eq(r.needsReconcile, false, '거부는 "모름"이 아니다');
    eq(r.failed, true);
  });

  test('접수됐는데 잔여가 남으면 부분 종료다 — 닫혔다고 적지 않는다', async () => {
    const { deps } = rig({}, { afterFound: true });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'CLOSE_INCOMPLETE');
    eq(r.flatVerified, false);
    eq(r.needsReconcile, true);
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-5 노출을 못 읽으면 flat이 아니다
  // ══════════════════════════════════════════════════════════
  test('노출을 못 읽으면 주문 0건이고 실패로 센다', async () => {
    const { deps, log } = rig({}, { readOk: false });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'POSITION_READ_FAILED');
    eq(r.attemptedWrite, false);
    eq(r.failed, true, '★ 못 읽은 회차를 조용한 정상으로 적으면 아무도 모른다');
    assert(!log.includes('send'));
  });

  // ══════════════════════════════════════════════════════════
  // ⑤-5 수량은 현재 노출에서 온다
  // ══════════════════════════════════════════════════════════
  test('닫는 수량은 지금 관측한 노출이다 — 진입 수량이 아니다', async () => {
    const { deps } = rig({}, { exposure: 0.07 });
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'CLOSED_VERIFIED');
    eq(r.closedQuantity, 0.07);
    eq(r.decision?.observedPositionQuantity, 0.07);
    eq(r.decision?.reduceOnly, true);
  });

  // ══════════════════════════════════════════════════════════
  // 때가 아니면 거래소를 **읽지도** 않는다
  // ══════════════════════════════════════════════════════════
  test('아직 4시간이 안 됐으면 주문도 조회 결과 사용도 없다', async () => {
    const { deps, log } = rig();
    const r = await runExitAuthority(candidate({ openedAtMs: NOW - FOUR_H + 1 }), deps, NOW);
    eq(r.code, 'POLICY_NOT_DUE');
    eq(r.blocked, true); eq(r.failed, false);
    assert(!log.includes('send'));
  });

  test('계약을 못 풀면 전략 6시간으로 닫지 않는다', async () => {
    const { deps, log } = rig();
    const r = await runExitAuthority(candidate({
      positionIdentity: {
        exchange: 'binance', connectionId: 'c', symbol: 'BTCUSDT', side: 'LONG',
        executionIdentity: { profileId: 'NOPE', presetId: 'NOPE', contractVersion: 9 },
        openingOrderId: null,
      },
      openedAtMs: NOW - 7 * 3600 * 1000,
    }), deps, NOW);
    eq(r.code, 'POLICY_UNRESOLVED');
    assert(!log.includes('send'), '★ 사용자가 고르지 않은 한도로 닫았다');
  });

  test('시간 청산이 닫혀 있으면 아무것도 하지 않는다', async () => {
    const { deps, log } = rig();
    const r = await runExitAuthority(candidate({
      capabilities: { fixedStopAtEntry: false, breakEven: false, trailing: false,
                      timeExit: false, emergency: false },
    }), deps, NOW);
    eq(r.code, 'CAPABILITY_NOT_ENABLED');
    assert(!log.includes('send'));
  });
}

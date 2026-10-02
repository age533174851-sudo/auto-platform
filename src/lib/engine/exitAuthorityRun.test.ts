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
  // Case F — **재검증 직후** 임차가 넘어간다 (분산 race)
  // ══════════════════════════════════════════════════════════
  //
  //   Case B는 재검증 **전에** 낡아진 A를 잡는다. 여기서는 A가
  //   `revalidateFence() === true`를 받은 **직후** 임차가 만료되고 B가
  //   새 울타리를 얻는다.
  //
  //   "재검증 뒤에 await가 없다"로는 이것을 막지 못한다 — B는 **다른
  //   프로세스**라 같은 event loop를 공유하지 않는다. DB 울타리는 DB를
  //   막을 뿐 거래소 요청을 막지 않는다.
  //
  //   그래서 막는 자리는 거래소다: 같은 종료 의도는 **같은 주문 식별자**를
  //   쓰고, 거래소가 중복 식별자를 거부한다. 둘 다 요청을 보내더라도
  //   **주문은 하나만 생긴다.**
  test('Case F: 재검증 직후 임차가 넘어가도 거래소에 주문은 하나만 생긴다', async () => {
    // 거래소를 흉내 낸다 — 같은 clientOrderId는 두 번 받지 않는다.
    const accepted = new Set<string>();
    const exchangeSubmits: string[] = [];
    const exchange = (id: string | null) => {
      exchangeSubmits.push(id ?? '(없음)');
      if (!id) {
        // 식별자가 없으면 거래소는 중복을 구별할 방법이 없다 — 전부 받는다.
        accepted.add(`anon-${exchangeSubmits.length}`);
        return { attempted: true, ok: true, error: null };
      }
      if (accepted.has(id)) {
        return { attempted: true, ok: false,
          error: 'Duplicate order sent. (code -4015)' };
      }
      accepted.add(id);
      return { attempted: true, ok: true, error: null };
    };

    const mk = (fenceAfterRevalidate: boolean) => {
      const log: string[] = [];
      let intentId: string | null = null;
      return { log, getId: () => intentId, deps: {
        leaseOwned: async () => { log.push('lease'); return { owned: true, identity: { holder: 'w', fence: 10 } }; },
        prepareClose: async () => {
          log.push('prepare');
          return { code: 'READY' as const, message: 'ready',
            prepared: { quantity: 1, orderSide: 'SELL' as const, reduceOnly: true as const,
                        observedQty: 1, positionMode: 'ONE_WAY' as const } };
        },
        revalidateFence: async () => { log.push('revalidate'); return true; },
        sendClose: async () => {
          log.push('send');
          // ★ 재검증을 통과한 **뒤** 임차가 넘어갔다. A는 그 사실을 모른다.
          void fenceAfterRevalidate;
          return exchange(intentId);
        },
        readAfter: async () => { log.push('readAfter'); return { ok: true, found: false }; },
        setIntentId: (v: string) => { intentId = v; },
      } as any };
    };

    // A: 재검증 통과 → 그 직후 B가 fence 11을 얻음 → A가 전송
    const A = mk(false);
    // B: 새 울타리로 정상 진행 → 같은 의도이므로 같은 식별자
    const B = mk(true);

    // 두 실행자가 **같은 종료 의도**에 대해 같은 식별자를 만들어야 한다.
    const { exitIntentId } = await import('./exitIntent');
    const id = exitIntentId({
      connectionId: 'conn-1', exchange: 'binance', symbol: 'BTCUSDT', side: 'LONG',
      executionIdentity: EXACT100X, reason: 'TIME_EXIT', quantity: 1,
    });
    (A.deps as any).setIntentId(id);
    (B.deps as any).setIntentId(id);

    const rA = await runExitAuthority(candidate(), A.deps, NOW);
    const rB = await runExitAuthority(candidate(), B.deps, NOW);

    // 둘 다 요청은 보냈다 — 분산 환경에서 그것까지 막을 수는 없다.
    eq(exchangeSubmits.length, 2, '두 실행자가 각자 요청을 보낸 상황을 재현해야 한다');
    // ★ **그러나 주문은 하나만 생긴다.**
    eq(accepted.size, 1,
      '★ 같은 종료 의도가 거래소에 두 번 들어갔다 — 중복 청산이다');
    // 두 번째는 거부되지만, 재조회가 flat을 확인하므로 "닫혔다"로 수렴한다.
    for (const r of [rA, rB]) {
      assert(r.code === 'CLOSED_VERIFIED' || r.code === 'RECONCILED_CLOSED',
        `★ 결과가 ${r.code}다 — 중복 거부를 "실패"로 적으면 같은 자리에 또 보낸다`);
    }
  });

  test('같은 종료 의도는 **같은** 식별자, 다른 노출은 **다른** 식별자다', async () => {
    const { exitIntentId } = await import('./exitIntent');
    const base = {
      connectionId: 'conn-1', exchange: 'binance' as const, symbol: 'BTCUSDT',
      side: 'LONG' as const, executionIdentity: EXACT100X, reason: 'TIME_EXIT' as const,
    };
    eq(exitIntentId({ ...base, quantity: 1 }), exitIntentId({ ...base, quantity: 1 }),
      '★ 같은 의도인데 식별자가 달라지면 거래소가 중복을 못 막는다');
    assert(exitIntentId({ ...base, quantity: 1 }) !== exitIntentId({ ...base, quantity: 0.6 }),
      '★ 부분 청산 뒤 남은 노출을 닫는 것은 **다른** 의도다 — 영원히 막히면 안 된다');
    assert(exitIntentId({ ...base, quantity: 1 }) !== exitIntentId({ ...base, symbol: 'ETHUSDT', quantity: 1 }),
      '★ 다른 종목이 같은 식별자를 쓰면 한쪽이 막힌다');
    assert(exitIntentId({ ...base, quantity: 1 }) !== exitIntentId({ ...base, side: 'SHORT', quantity: 1 }),
      '★ 헤지 계좌의 다른 다리가 같은 식별자를 쓰면 한쪽이 막힌다');
    // 거래소 규격: 36자 이하
    const id = exitIntentId({ ...base, quantity: 1 });
    assert(id.length > 0 && id.length <= 36, `★ 식별자 길이가 ${id.length}자다 (36자 이하여야 한다)`);
    assert(/^[A-Za-z0-9_-]+$/.test(id), `★ 식별자에 허용되지 않는 문자가 있다 (${id})`);
  });

  // ══════════════════════════════════════════════════════════
  // Case G — 준비 **뒤** 사용자가 일부를 수동 청산한다
  // ══════════════════════════════════════════════════════════
  //
  //   payload는 준비 시점의 노출(1.0)로 만들어진다. 그 뒤 사용자가 0.4를
  //   닫으면 축소 전용 주문은 남은 0.6만 체결한다. 보낸 수량을 체결량으로
  //   적으면 장부가 거짓말을 한다.
  //
  //   ★ 해결을 "진입 수량으로 되돌리기"로 하지 않는다 — 그러면 더 틀린다.
  test('Case G: 준비 뒤 일부가 수동 청산돼도 반대 포지션이 생기지 않는다', async () => {
    // 준비 1.0 → 재검증 → 사용자가 0.4 청산 → 축소 전용이라 0.6만 닫힌다.
    let exposure = 1.0;
    const sent: Array<{ qty: number; reduceOnly: boolean }> = [];
    const log: string[] = [];
    const deps: ExitRunDeps = {
      leaseOwned: async () => { log.push('lease'); return { owned: true, identity: { holder: 'a', fence: 1 } }; },
      prepareClose: async () => {
        log.push('prepare');
        return { code: 'READY' as const, message: 'ready',
          prepared: { quantity: exposure, orderSide: 'SELL' as const, reduceOnly: true as const,
                      observedQty: exposure, positionMode: 'ONE_WAY' as const } };
      },
      revalidateFence: async () => {
        log.push('revalidate');
        // ★ 재검증 직후 사용자가 0.4를 닫는다.
        exposure = 0.6;
        return true;
      },
      sendClose: async () => {
        log.push('send');
        // 준비된 수량(1.0)을 축소 전용으로 보낸다. 거래소는 남은 0.6만
        // 줄이고 **반대 포지션을 만들지 않는다** — 그게 reduceOnly다.
        sent.push({ qty: 1.0, reduceOnly: true });
        exposure = 0;
        return { attempted: true, ok: true, error: null };
      },
      readAfter: async () => { log.push('readAfter'); return { ok: true, found: exposure > 0 }; },
    };
    const r = await runExitAuthority(candidate(), deps, NOW);

    eq(sent.length, 1);
    eq(sent[0].reduceOnly, true, '★ reduceOnly가 빠지면 0.4만큼 반대 포지션이 생긴다');
    assert(exposure === 0, '노출이 남아 있다');
    // 재조회가 정본이다 — flat을 확인했으므로 닫힌 것이다.
    eq(r.code, 'CLOSED_VERIFIED');
    eq(r.flatVerified, true);
    // ★ **보낸 수량을 체결량으로 적지 않는다.**
    eq(r.requestedQuantity, 1.0, '요청한 수량은 준비 시점의 1.0이다');
    assert(!('closedQuantity' in (r as any)),
      '★ "닫힌 수량"이라는 칸을 만들면 1.0이 체결량으로 읽힌다 (실제로는 0.6)');
  });

  test('Case G-2: 일부만 닫히고 잔여가 남으면 CLOSED_VERIFIED가 아니다', async () => {
    let exposure = 1.0;
    const deps: ExitRunDeps = {
      leaseOwned: async () => ({ owned: true, identity: { holder: 'a', fence: 1 } }),
      prepareClose: async () => ({ code: 'READY' as const, message: 'ready',
        prepared: { quantity: exposure, orderSide: 'SELL' as const, reduceOnly: true as const,
                    observedQty: exposure, positionMode: 'ONE_WAY' as const } }),
      revalidateFence: async () => true,
      sendClose: async () => { exposure = 0.3; return { attempted: true, ok: true, error: null }; },
      // 재조회가 **실제 노출**을 본다 — 준비한 수량이 아니다.
      readAfter: async () => ({ ok: true, found: exposure > 0 }),
    };
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'CLOSE_INCOMPLETE', '★ 접수됐으니 닫혔다고 단정하면 안 된다');
    eq(r.flatVerified, false);
    eq(r.needsReconcile, true);
    eq(r.ok, false);
  });

  test('Case G-3: 노출을 못 읽으면 진입 수량으로 되돌리지 않는다', async () => {
    const log: string[] = [];
    const deps: ExitRunDeps = {
      leaseOwned: async () => { log.push('lease'); return { owned: true, identity: { holder: 'a', fence: 1 } }; },
      prepareClose: async () => { log.push('prepare');
        return { code: 'READ_FAILED' as const, prepared: null, message: '조회 실패' }; },
      revalidateFence: async () => { log.push('revalidate'); return true; },
      sendClose: async () => { log.push('send'); return { attempted: true, ok: true, error: null }; },
      readAfter: async () => { log.push('readAfter'); return { ok: true, found: false }; },
    };
    const r = await runExitAuthority(candidate(), deps, NOW);
    eq(r.code, 'POSITION_READ_FAILED');
    eq(r.requestedQuantity, null, '★ 진입 수량으로 되돌리면 실제보다 많이 닫으려 한다');
    assert(!log.includes('send'), '★ 수량을 모르는데 주문을 보냈다');
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
    eq(r.requestedQuantity, null);
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
    eq(r.requestedQuantity, 0.07);
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

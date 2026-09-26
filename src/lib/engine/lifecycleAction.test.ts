// src/lib/engine/lifecycleAction.test.ts
//
// **청산 실행을 가짜 거래소로 실제로 돌려서 순서·횟수를 센다.**
//
// 왜 정규식 검사로는 부족한가
// ───────────────────────────
// 검사기는 "그 줄이 있는가"만 본다. 그런데 이 단계에서 나는 고장은
// **순서와 횟수**다:
//
//   · 권한 확인이 전송 뒤에 있으면 — 줄은 다 있는데 보호가 안 된다
//   · 재조회를 안 하면 — 접수를 체결로 적는다
//   · 재조회 실패를 0으로 읽으면 — 안 닫힌 포지션이 닫혔다고 남는다
//
// 그래서 호출을 세고 순서를 기록한다.
import { test, eq, assert } from '../../test/harness';
import { applyLifecycleClose } from './lifecycleAction';

/** 호출 순서를 기록하는 가짜 거래소 */
function fake(o: {
  mine?: boolean | (() => boolean);
  closeOk?: boolean;
  closeAttempted?: boolean;
  closeThrows?: boolean;
  closeAmbiguous?: boolean;
  afterOk?: boolean;
  afterFound?: boolean;
  afterThrows?: boolean;
} = {}) {
  const calls: string[] = [];
  let closes = 0, reads = 0, mines = 0;
  return {
    calls, counts: () => ({ closes, reads, mines }),
    deps: {
      stillMine: o.mine === undefined ? undefined : async () => {
        calls.push('stillMine'); mines += 1;
        return typeof o.mine === 'function' ? o.mine() : !!o.mine;
      },
      close: async () => {
        calls.push('close'); closes += 1;
        if (o.closeThrows) throw new Error('네트워크 끊김');
        return { attempted: o.closeAttempted !== false, ok: o.closeOk !== false,
          error: o.closeOk === false ? '거절' : null, ambiguous: o.closeAmbiguous === true };
      },
      readAfter: async () => {
        calls.push('readAfter'); reads += 1;
        if (o.afterThrows) throw new Error('조회 실패');
        return { ok: o.afterOk !== false, found: o.afterFound === true };
      },
    },
  };
}

export function runLifecycleActionTests() {
  console.log('\n🔒 청산 실행 (권한 → 전송 → 재조회)');

  // ══ ④ 재조회로 flat 확인된 경우만 CLOSED ══
  test('★ ④ 보내고 포지션 0을 확인하면 CLOSED_VERIFIED', async () => {
    const f = fake({ mine: true });
    const r = await applyLifecycleClose(f.deps as any);
    eq(r.code, 'CLOSED_VERIFIED');
    eq(r.ok, true);
    eq(r.attempted, true); eq(r.accepted, true); eq(r.flatVerified, true);
    eq(f.counts().closes, 1, '청산을 한 번만 보내야 합니다');
    eq(f.counts().reads, 1, '보낸 뒤 한 번 다시 읽어야 합니다');
  });

  test('★ 순서: 권한 확인이 전송보다 **앞**이다', async () => {
    const f = fake({ mine: true });
    await applyLifecycleClose(f.deps as any);
    eq(f.calls.join('→'), 'stillMine→close→readAfter',
      `순서가 다릅니다: ${f.calls.join('→')}`);
  });

  // ══ ① 임차를 잃으면 전송 0회 ══
  test('★ ① 임차를 잃으면 청산을 **보내지 않는다** (전송 0회)', async () => {
    const f = fake({ mine: false });
    const r = await applyLifecycleClose(f.deps as any);
    eq(r.code, 'LEASE_LOST');
    eq(r.ok, false); eq(r.attempted, false);
    eq(f.counts().closes, 0, '★ 권한이 없는데 청산을 보냈습니다');
    eq(f.counts().reads, 0);
  });

  test('★ 권한 확인이 던져도 보내지 않는다 (fail-closed)', async () => {
    let closes = 0;
    const r = await applyLifecycleClose({
      stillMine: async () => { throw new Error('DB 끊김'); },
      close: async () => { closes += 1; return { attempted: true, ok: true, error: null }; },
      readAfter: async () => ({ ok: true, found: false }),
    } as any);
    eq(r.code, 'LEASE_LOST');
    eq(closes, 0, '★ 권한을 못 읽었는데 청산을 보냈습니다');
  });

  // ══ ② 접수됐지만 포지션이 남아 있다 ══
  test('★ ② 접수 + 재조회에서 포지션이 남아 있으면 CLOSED가 아니다', async () => {
    const f = fake({ mine: true, afterFound: true });
    const r = await applyLifecycleClose(f.deps as any);
    eq(r.code, 'CLOSE_INCOMPLETE');
    eq(r.ok, false);
    eq(r.accepted, true, '접수 사실은 남아야 합니다');
    eq(r.flatVerified, false);
  });

  // ══ ③ 접수됐지만 재조회 실패 ══
  test('★ ③ 접수 + 재조회 실패를 "닫혔다"로 읽지 않는다 (대조 필요)', async () => {
    const f = fake({ mine: true, afterOk: false });
    const r = await applyLifecycleClose(f.deps as any);
    eq(r.code, 'CLOSE_UNVERIFIED');
    eq(r.ok, false);
    eq(r.flatVerified, null, '★ 못 읽은 것을 boolean으로 적었습니다');
  });

  test('재조회가 던져도 닫혔다고 적지 않는다', async () => {
    const f = fake({ mine: true, afterThrows: true });
    const r = await applyLifecycleClose(f.deps as any);
    eq(r.code, 'CLOSE_UNVERIFIED');
    eq(r.flatVerified, null);
  });

  // ══ ⑤ 거부 ══
  test('★ ⑤ 거래소가 거부하면 CLOSED가 아니다', async () => {
    const f = fake({ mine: true, closeOk: false });
    const r = await applyLifecycleClose(f.deps as any);
    eq(r.code, 'CLOSE_REJECTED');
    eq(r.ok, false);
  });

  // ══ 모호한 전송을 거부로 단정하지 않는다 ══
  //
  // 타임아웃·연결 끊김은 "거부됐다"가 아니다. 거부로 적으면 안 나간 것으로
  // 읽혀 같은 자리에 또 보낸다 — 실제로는 나갔을 수 있다.

  test('★ 전송 중 예외는 "안 보냈다"도 "거부됐다"도 아니다', async () => {
    const f = fake({ mine: true, closeThrows: true });
    const r = await applyLifecycleClose(f.deps as any);
    assert(r.code !== 'CLOSE_REJECTED', '★ 모호한 전송을 거부로 단정했습니다');
    eq(r.attempted, true, '★ 보냈을 수 있는 것을 안 보냈다고 적었습니다');
    eq(r.accepted, null, '★ 접수 여부를 모르는데 boolean으로 적었습니다');
    eq(f.counts().reads, 1, '★ 결과를 확인하러 다시 읽지 않았습니다');
  });

  test('★ 전송이 모호해도 재조회로 0을 보면 종료다', async () => {
    // 결과는 거래소에만 있다. 전송 응답을 못 받았다고 안 닫힌 것이 아니다.
    const f = fake({ mine: true, closeThrows: true });
    const r = await applyLifecycleClose(f.deps as any);
    eq(r.code, 'CLOSED_VERIFIED');
    eq(r.ok, true);
    eq(r.flatVerified, true);
    eq(r.needsReconcile, false);
  });

  test('★ 전송이 모호하고 포지션도 남아 있으면 대조 대상이다', async () => {
    const f = fake({ mine: true, closeThrows: true, afterFound: true });
    const r = await applyLifecycleClose(f.deps as any);
    eq(r.code, 'CLOSE_AMBIGUOUS');
    eq(r.ok, false);
    eq(r.accepted, null);
    eq(r.needsReconcile, true, '★ 사람이 대조해야 하는데 표시가 없습니다');
    eq(f.counts().closes, 1, '★ 모호한 상태에서 또 보냈습니다');
  });

  test('★ 전송이 모호하고 재조회도 실패하면 확정하지 않는다', async () => {
    const f = fake({ mine: true, closeThrows: true, afterOk: false });
    const r = await applyLifecycleClose(f.deps as any);
    eq(r.code, 'CLOSE_UNVERIFIED');
    eq(r.accepted, null);
    eq(r.flatVerified, null);
    eq(r.needsReconcile, true);
  });

  test('★ 거래소가 ambiguous로 표시한 실패도 거부가 아니다', async () => {
    // closeSymbolPosition이 타임아웃을 unknownResultVerdict로 분류해 넘긴다.
    const f = fake({ mine: true, closeOk: false, closeAmbiguous: true, afterFound: true });
    const r = await applyLifecycleClose(f.deps as any);
    eq(r.code, 'CLOSE_AMBIGUOUS');
    assert(r.code !== 'CLOSE_REJECTED', '★ 모호한 실패를 거부로 적었습니다');
  });

  test('명시적 거부는 그대로 거부다 — 모호함과 섞지 않는다', async () => {
    const f = fake({ mine: true, closeOk: false });
    const r = await applyLifecycleClose(f.deps as any);
    eq(r.code, 'CLOSE_REJECTED');
    eq(r.accepted, false, '거부는 "받지 않았다"가 확정이다');
    eq(f.counts().reads, 0, '거부된 주문에 재조회는 뜻이 없습니다');
  });

  test('권한 확인을 안 주면 확인하지 않는다 (임차 표 없는 배포)', async () => {
    const f = fake({ closeOk: true });
    const r = await applyLifecycleClose(f.deps as any);
    eq(r.code, 'CLOSED_VERIFIED');
    eq(f.counts().mines, 0);
    eq(f.calls.join('→'), 'close→readAfter');
  });

  test('★ 어떤 경로에서도 청산을 두 번 보내지 않는다', async () => {
    for (const o of [{ mine: true }, { mine: true, afterFound: true },
                     { mine: true, afterOk: false }, { mine: true, closeOk: false },
                     { mine: true, closeThrows: true }, { mine: false }]) {
      const f = fake(o);
      await applyLifecycleClose(f.deps as any);
      assert(f.counts().closes <= 1, `청산을 ${f.counts().closes}번 보냈습니다`);
    }
  });

  test('★ ok는 attempted·accepted·flatVerified가 다 참일 때만이다', async () => {
    for (const o of [{ mine: true }, { mine: true, afterFound: true },
                     { mine: true, afterOk: false }, { mine: true, closeOk: false },
                     { mine: false }]) {
      const r = await applyLifecycleClose(fake(o).deps as any);
      eq(r.ok, r.attempted && r.flatVerified === true,
        `★ ok(${r.ok})가 확인 사실과 어긋납니다: ${r.code}`);
    }
  });
}

// src/lib/safety/auditStore.test.ts
//
// **감사 기록이 사라졌다는 사실조차 남지 않는 상태**를 막는 테스트.
//
// 지키는 네 가지
//  1. critical audit은 insert가 끝나기 전에 응답 완료로 판정하지 않는다
//  2. audit 실패가 주문을 다시 보내지 않는다 (중복 주문 금지)
//  3. audit 실패를 audit 성공처럼 표시하지 않는다
//  4. detail의 시크릿은 여전히 걸러진다
import { test, assert, eq } from '../../test/harness';
import {
  recordAudit, recordCriticalAudit, auditReceipt, auditFollowUp,
  auditResponseField, auditRow,
} from './auditStore';

/** insert가 언제 끝나는지 우리가 정하는 가짜 Supabase */
function fakeSb(opts: { error?: any; throwOn?: boolean } = {}) {
  const state = {
    inserted: [] as any[],
    resolved: false,
    release: null as null | (() => void),
    tables: [] as string[],
  };
  const sb = {
    from(t: string) {
      state.tables.push(t);
      return {
        insert(row: any) {
          state.inserted.push(row);
          if (opts.throwOn) throw new Error('network down');
          // **아직 끝내지 않는다.** release()를 불러야 끝난다.
          return new Promise<any>(res => {
            state.release = () => { state.resolved = true; res({ error: opts.error ?? null }); };
          });
        },
      };
    },
  };
  return { sb, state };
}

export function runAuditStoreTests() {
  console.log('\n📒 감사 기록 내구성 (auditStore)');

  // ── 1. insert가 끝나기 전에 응답 완료로 판정하지 않는다 ──
  test('critical audit은 insert가 resolve되기 전에 완료되지 않는다', async () => {
    const { sb, state } = fakeSb();
    let done = false;
    const p = recordCriticalAudit(sb, { action: 'LIVE_ORDER', resource: 'binance:BTCUSDT' })
      .then(r => { done = true; return r; });

    // 마이크로태스크를 여러 번 돌려도 아직 끝나면 안 된다.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert(!done, 'insert가 끝나기 전에 감사 기록이 완료로 판정됐다 — 서버리스에서 그대로 잘린다');
    assert(!state.resolved, '가짜 insert가 아직 안 끝났어야 한다');

    state.release!();
    const r = await p;
    assert(done, 'insert가 끝났는데도 완료되지 않았다');
    eq(r.code, 'RECORDED', '성공 코드');
    assert(r.recorded, '기록됨');
    eq(state.tables[0], 'audit_events', 'audit_events에 쓴다 (audit_logs가 아니다)');
  });

  test('telemetry(recordAudit)는 기다리지 않는다 — 두 갈래가 실제로 다르다', () => {
    const { sb, state } = fakeSb();
    const ret = recordAudit(sb, { action: 'NOTICE_CREATE' }) as any;
    assert(ret === undefined, 'recordAudit은 프라미스를 돌려주지 않는다');
    eq(state.inserted.length, 1, 'insert는 시작한다');
    assert(!state.resolved, '끝나기를 기다리지 않는다');
  });

  // ── 2. 실패가 주문을 다시 보내지 않는다 ──
  test('audit insert 실패가 주문을 다시 보내지 않는다', async () => {
    let orders = 0;
    const placeOrder = () => { orders += 1; return { success: true, orderId: 'X1' }; };

    // 실제 주문 경로와 같은 순서: 주문 → 감사(await) → 응답
    const result = placeOrder();
    const { sb, state } = fakeSb({ error: { message: 'relation "audit_events" does not exist' } });
    const p = recordCriticalAudit(sb, {
      action: 'LIVE_ORDER', result: result.success ? 'success' : 'failed',
    });
    await Promise.resolve();
    state.release!();
    const receipt = await p;

    assert(!receipt.recorded, '감사는 실패했다');
    const next = auditFollowUp(receipt);
    assert(next.retryOrder === false, '감사 실패로 주문을 다시 보내면 중복 주문이 된다');
    assert(next.failRequest === false, '감사 실패로 주문 자체를 실패시키지 않는다');

    // 후속 판단대로 움직였을 때 주문이 몇 번 나갔는가
    if (next.retryOrder) placeOrder();
    eq(orders, 1, '주문은 한 번만 나갔다');
    // 주문 결과는 감사 실패와 무관하게 그대로다
    assert(result.success === true, '감사 실패가 주문 결과를 뒤집으면 안 된다');
  });

  test('어떤 실패 코드에서도 재시도·요청실패로 이어지지 않는다', () => {
    const codes = [
      auditReceipt({ hasDb: false }),
      auditReceipt({ hasDb: true, error: { message: 'x' } }),
      auditReceipt({ hasDb: true, threw: new Error('y') }),
      auditReceipt({ hasDb: true }),
    ];
    for (const r of codes) {
      const n = auditFollowUp(r);
      assert(n.retryOrder === false, `${r.code}에서 retryOrder가 켜졌다`);
      assert(n.failRequest === false, `${r.code}에서 failRequest가 켜졌다`);
    }
  });

  // ── 3. 실패를 성공처럼 표시하지 않는다 ──
  test('insert 오류를 성공으로 적지 않는다', async () => {
    const { sb, state } = fakeSb({ error: { message: 'permission denied for table audit_events' } });
    const p = recordCriticalAudit(sb, { action: 'KILL_SWITCH' });
    await Promise.resolve();
    state.release!();
    const r = await p;
    assert(!r.recorded, 'insert 오류인데 recorded=true였다 — 화면이 "기록됨"으로 그린다');
    eq(r.code, 'INSERT_FAILED', '실패 코드');
    assert(/permission denied/.test(r.message), '왜 실패했는지가 남아야 한다');
    const field = auditResponseField(r);
    assert(field.recorded === false, '응답 필드도 실패로 나가야 한다');
  });

  test('클라이언트가 던져도 성공으로 적지 않는다', async () => {
    const { sb } = fakeSb({ throwOn: true });
    const r = await recordCriticalAudit(sb, { action: 'EMERGENCY_BOT_STOP' });
    assert(!r.recorded, '던졌는데 recorded=true였다');
    eq(r.code, 'THREW', '던짐 코드');
  });

  test('Supabase가 없으면 NO_DB — 성공이 아니다', async () => {
    const r = await recordCriticalAudit(null, { action: 'LIVE_ORDER' });
    assert(!r.recorded, 'DB가 없는데 기록됨으로 적었다');
    eq(r.code, 'NO_DB', 'DB 없음 코드');
  });

  test('던지지 않는다 — 어떤 실패도 호출부로 새지 않는다', async () => {
    const nasty = { from() { throw new Error('boom'); } };
    const r = await recordCriticalAudit(nasty, { action: 'LIVE_ORDER' });
    eq(r.code, 'THREW', '던짐을 영수증으로 바꾼다');
  });

  // ── 4. 시크릿 걸러내기 ──
  test('critical 경로에서도 시크릿은 걸러진다', async () => {
    const { sb, state } = fakeSb();
    const p = recordCriticalAudit(sb, {
      action: 'LIVE_ORDER',
      detail: { symbol: 'BTCUSDT', secret: 'S3CR3T-VALUE', apiKey: 'AK-1234', qty: 1 },
    });
    await Promise.resolve();
    state.release!();
    await p;
    const row = state.inserted[0];
    const s = JSON.stringify(row);
    assert(!s.includes('S3CR3T-VALUE'), '시크릿 값이 감사 표에 그대로 들어갔다');
    assert(!s.includes('AK-1234'), 'API 키가 감사 표에 그대로 들어갔다');
    assert(/redacted/.test(String(row.detail.secret)), '가려졌다는 흔적은 남아야 한다');
    eq(row.detail.symbol, 'BTCUSDT', '시크릿이 아닌 값은 남는다');
  });

  test('detail에 문자열을 넘겨도 던지지 않고 담는다', () => {
    const row = auditRow({ action: 'CAPABILITY_CHANGE', detail: 'a → b' as any });
    eq(typeof row.detail, 'object', 'detail은 객체여야 한다');
    assert(String(JSON.stringify(row.detail)).includes('a → b'), '내용이 사라지면 안 된다');
  });

  test('auditRow는 audit_events의 칸 이름을 쓴다', () => {
    const row = auditRow({ userId: 'u1', action: 'X', resource: 'r', result: 'failed', connectionId: 'c1' });
    eq(row.user_id, 'u1', 'user_id');
    eq(row.action, 'X', 'action');
    eq(row.resource, 'r', 'resource');
    eq(row.result, 'failed', 'result');
    eq(row.connection_id, 'c1', 'connection_id');
  });
}

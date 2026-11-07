// src/lib/engine/pendingReconcile.test.ts
//
// 막으려는 것:
//  1. 방금 나간 주문을 앞질러 '거래소에 없음'으로 확정하는 것 — 1초 뒤에
//     체결 응답이 오고, 확정을 되돌릴 방법은 없다
//  2. 상한에 걸렸을 때 **가장 오래 방치된 것**이 뒤로 밀리는 것
//  3. 연결을 모르는 주문을 아무 키로나 물어보는 것
//  4. 시각이 깨진 행 하나가 영영 미확정으로 남아 자동매매를 계속 막는 것
//  5. 대조 실패를 '확정 0건'과 같게 적는 것
import { test, assert, eq } from '../../test/harness';
import { ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from './orderExecutor';
import {
  RECONCILE_QUERY_STATUSES, RECONCILE_TARGET_STATUSES,
  pendingTargets, skipReason, summarizeOutcomes,
  PENDING_STATUSES, DEFAULT_GRACE_MS,
} from './pendingReconcile';

const NOW = 1_800_000_000_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

export function runPendingReconcileTests() {
  console.log('[미확정 대조 — 방금 나간 주문은 건드리지 않는다]');

  // ── ACKED만 남은 연결이 영원히 방문되지 않았다 ──
  //
  //   해소 능력(`resolveAcked`)은 이미 있었다. 그런데 cron이 **방문할
  //   연결**을 고르는 목록에 ACKED가 없어서 그 방아쇠가 당겨지지 않았다.
  //   ACKED는 같은 연결에 다른 상태의 줄이 **우연히** 있을 때만 쓸려
  //   들어갔다 — 그건 보장이 아니다.

  test('★ ACKED만 있는 연결도 대조 대상이다', () => {
    const t = pendingTargets([
      { connection_id: 'c1', user_id: 'u1', status: 'ACKED', created_at: new Date(0).toISOString() },
    ], { now: 600_000 });
    eq(t.length, 1);
    eq(t[0].connectionId, 'c1');
    eq(t[0].count, 1);
  });

  test('★ 해소 가능한 상태는 전부 방문 대상에 들어 있다', () => {
    // 해소할 수 있는데 방문하지 않는 상태가 있으면 그 줄은 영구 미확정이다.
    for (const st of RECONCILE_QUERY_STATUSES) {
      assert((RECONCILE_TARGET_STATUSES as readonly string[]).includes(st));
      const t = pendingTargets([
        { connection_id: 'c1', user_id: 'u1', status: st, created_at: new Date(0).toISOString() },
      ], { now: 600_000 });
      eq(t.length, 1);
    }
  });

  test('★ 종결되지 않은 모든 주문 상태가 방문 대상이다 (어휘 드리프트)', () => {
    const terminal = new Set<string>(TERMINAL_ORDER_STATUSES);
    const target = new Set<string>(RECONCILE_TARGET_STATUSES);
    const orphan = ORDER_STATUSES.filter(x => !terminal.has(x) && !target.has(x));
    if (orphan.length > 0) {
      throw new Error(`종결도 아니고 대조 대상도 아닌 상태: ${orphan.join(', ')}`
        + ' — 그 줄은 영구 미확정으로 남습니다');
    }
    // 종결 상태는 방문 대상이 아니어야 한다 — 끝난 주문을 계속 물어보지 않는다.
    for (const st of TERMINAL_ORDER_STATUSES) {
      assert(!target.has(st));
    }
  });

  test('★ 종결된 주문은 대조 대상이 아니다', () => {
    for (const st of TERMINAL_ORDER_STATUSES) {
      const t = pendingTargets([
        { connection_id: 'c1', user_id: 'u1', status: st, created_at: new Date(0).toISOString() },
      ], { now: 600_000 });
      eq(t.length, 0);
    }
  });

  test('유예 시간 안의 주문은 대상이 아니다', () => {
    // 다른 요청이 아직 거래소 응답을 기다리는 중일 수 있다. 그때 대조하면
    // "없네 → 안 나갔다"로 확정하는데 1초 뒤에 체결 응답이 온다.
    const r = pendingTargets([
      { connection_id: 'c1', status: 'UNKNOWN', created_at: ago(5_000) },
    ], { now: NOW });
    eq(r.length, 0);
  });

  test('유예를 지난 주문은 대상이다', () => {
    const r = pendingTargets([
      { connection_id: 'c1', status: 'UNKNOWN', created_at: ago(DEFAULT_GRACE_MS + 1_000), user_id: 'u1' },
    ], { now: NOW });
    eq(r.length, 1);
    eq(r[0].connectionId, 'c1');
    eq(r[0].userId, 'u1');
  });

  test('유예는 조절할 수 있다', () => {
    const rows = [{ connection_id: 'c1', status: 'SENT', created_at: ago(10_000) }];
    eq(pendingTargets(rows, { now: NOW, graceMs: 5_000 }).length, 1);
    eq(pendingTargets(rows, { now: NOW, graceMs: 30_000 }).length, 0);
  });

  console.log('[미확정 대조 — 오래된 것부터]');

  test('가장 오래 방치된 연결이 먼저다', () => {
    // 새것부터 하면 상한에 걸렸을 때 제일 위험한 것이 영영 뒤로 밀린다.
    const r = pendingTargets([
      { connection_id: 'new', status: 'UNKNOWN', created_at: ago(200_000) },
      { connection_id: 'old', status: 'UNKNOWN', created_at: ago(9_000_000) },
      { connection_id: 'mid', status: 'UNKNOWN', created_at: ago(600_000) },
    ], { now: NOW });
    eq(r.map(t => t.connectionId).join(','), 'old,mid,new');
  });

  test('상한을 넘으면 오래된 쪽만 남는다', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      connection_id: `c${i}`, status: 'UNKNOWN', created_at: ago(200_000 + i * 1000),
    }));
    const r = pendingTargets(rows, { now: NOW, maxConnections: 3 });
    eq(r.length, 3);
    eq(r[0].connectionId, 'c9', '가장 오래된 것이 빠졌다');
  });

  test('같은 연결의 여러 주문은 한 번만 대조한다', () => {
    const r = pendingTargets([
      { connection_id: 'c1', status: 'UNKNOWN', created_at: ago(200_000) },
      { connection_id: 'c1', status: 'SENT', created_at: ago(900_000) },
      { connection_id: 'c1', status: 'INTENT', created_at: ago(300_000) },
    ], { now: NOW });
    eq(r.length, 1);
    eq(r[0].count, 3, '몇 건인지가 안 세어졌다');
    eq(r[0].oldestAgeMs, 900_000, '가장 오래된 것의 나이를 써야 한다');
  });

  console.log('[미확정 대조 — 모르는 것은 건드리지 않는다]');

  test('연결을 모르는 주문은 대상이 아니다', () => {
    // 어느 키로 물어볼지 모르는 주문을 아무 연결로나 물어보면,
    // 그 거래소에 없다고 확정해 버린다.
    const r = pendingTargets([
      { connection_id: null, status: 'UNKNOWN', created_at: ago(900_000) },
      { connection_id: '', status: 'UNKNOWN', created_at: ago(900_000) },
    ], { now: NOW });
    eq(r.length, 0);
  });

  test('확정된 상태는 대상이 아니다', () => {
    const r = pendingTargets([
      { connection_id: 'c1', status: 'FILLED', created_at: ago(900_000) },
      { connection_id: 'c2', status: 'REJECTED', created_at: ago(900_000) },
      { connection_id: 'c3', status: 'RECONCILED', created_at: ago(900_000) },
    ], { now: NOW });
    eq(r.length, 0);
    eq(PENDING_STATUSES.includes('UNKNOWN' as any), true);
  });

  test('시각이 깨진 행은 유예를 지난 것으로 본다', () => {
    // 여기서 건너뛰면 그 행 하나가 영영 미확정으로 남아 자동매매를
    // 계속 막는다.
    const r = pendingTargets([
      { connection_id: 'c1', status: 'UNKNOWN', created_at: '알 수 없음' },
      { connection_id: 'c2', status: 'UNKNOWN', created_at: null },
    ], { now: NOW });
    eq(r.length, 2);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(pendingTargets(null, { now: NOW }).length, 0);
    eq(pendingTargets([], { now: NOW }).length, 0);
    eq(pendingTargets([null as any, undefined as any], { now: NOW }).length, 0);
  });

  console.log('[미확정 대조 — 쓰면 안 되는 연결]');

  test('출금 권한 키는 건너뛴다', () => {
    const s = skipReason({ api_key: 'k', api_secret_enc: 'e', has_withdrawal: true });
    assert(s != null && s.includes('출금'), String(s));
  });

  test('키나 시크릿이 없으면 건너뛴다 — 빈 키로 서명하지 않는다', () => {
    assert(skipReason({ api_secret_enc: 'e' }) != null);
    assert(skipReason({ api_key: 'k' }) != null);
    assert(skipReason(null) != null);
  });

  test('정상 연결은 건너뛰지 않는다', () => {
    eq(skipReason({ api_key: 'k', api_secret_enc: 'e', has_withdrawal: false }), null);
  });

  console.log('[미확정 대조 — 0건과 못 함은 다르다]');

  test('실패는 앞줄에 적는다', () => {
    // 앞줄만 읽는 사람이 많다. 뒤에 숨기면 "대조 정상"으로 읽힌다.
    const s = summarizeOutcomes([
      { connectionId: 'a', ok: true, resolved: 2 },
      { connectionId: 'b', ok: false, error: '타임아웃' },
    ]);
    assert(s.startsWith('⚠️'), s);
    assert(s.includes('대조 실패 1개'), s);
  });

  test('건너뛴 것은 실패가 아니다', () => {
    const s = summarizeOutcomes([
      { connectionId: 'a', ok: true, skipped: '출금 권한이 있는 키입니다' },
    ]);
    assert(!s.includes('실패'), s);
    assert(s.includes('건너뜀 1개'), s);
  });

  test('대상이 없으면 없다고 적는다 — 0건 대조와 다르다', () => {
    const s = summarizeOutcomes([]);
    assert(s.includes('없습니다'), s);
  });

  test('확정 건수를 합산한다', () => {
    const s = summarizeOutcomes([
      { connectionId: 'a', ok: true, resolved: 2 },
      { connectionId: 'b', ok: true, resolved: 3 },
    ]);
    assert(s.includes('확정 5건'), s);
  });
}

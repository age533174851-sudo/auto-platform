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
import { scanPendingRows } from './pendingReconcileScan';
import { ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from './orderExecutor';
import {
  RECONCILE_QUERY_STATUSES, RECONCILE_TARGET_STATUSES,
  pendingTargets, skipReason, summarizeOutcomes, connectionLookupOutcome,
  PENDING_STATUSES, DEFAULT_GRACE_MS, parseReconcileGraceMs,
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

  test('★ graceSec 미지정은 0초가 아니라 기본 90초 유예다', () => {
    eq(parseReconcileGraceMs(null), DEFAULT_GRACE_MS);
    eq(parseReconcileGraceMs(''), DEFAULT_GRACE_MS);
    eq(parseReconcileGraceMs('  '), DEFAULT_GRACE_MS);
    const justSent = [{ connection_id: 'fresh', status: 'UNKNOWN', created_at: ago(5_000) }];
    eq(pendingTargets(justSent, {
      now: NOW, graceMs: parseReconcileGraceMs(null),
    }).length, 0, '미지정 유예로 진행 중인 주문을 조기 대조하면 안 된다');
  });

  test('★ graceSec=0 명시만 즉시 대조를 허용한다', () => {
    eq(parseReconcileGraceMs('0'), 0);
    eq(parseReconcileGraceMs('90'), 90_000);
    const justSent = [{ connection_id: 'fresh', status: 'UNKNOWN', created_at: ago(5_000) }];
    eq(pendingTargets(justSent, {
      now: NOW, graceMs: parseReconcileGraceMs('0'),
    }).length, 1);
  });

  test('★ 잘못된 graceSec은 안전 기본값으로 돌아간다', () => {
    for (const bad of ['-1', 'NaN', 'Infinity', 'not-a-number']) {
      eq(parseReconcileGraceMs(bad), DEFAULT_GRACE_MS, bad);
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

  test('★ 연결 조회 DB 오류는 건너뜀/성공이 아니라 대조 실패다', () => {
    const outcome = connectionLookupOutcome('c1', {
      data: null, error: { message: 'secret DB failure detail' },
    });
    assert(outcome !== null);
    eq(outcome!.connectionId, 'c1');
    eq(outcome!.ok, false);
    eq(outcome!.error, 'connection_lookup_failed');
    eq(outcome!.skipped, undefined);
    const summary = summarizeOutcomes([outcome!]);
    assert(summary.startsWith('⚠️ 대조 실패 1개'), summary);
    assert(!summary.includes('secret DB failure detail'));
  });

  test('★ 데이터가 있어도 오류가 동반되면 연결을 사용하지 않는다', () => {
    const outcome = connectionLookupOutcome('c2', {
      data: { api_key: 'untrusted', api_secret_enc: 'untrusted' },
      error: { code: 'XX000' },
    });
    eq(outcome?.ok, false);
    eq(outcome?.error, 'connection_lookup_failed');
  });

  test('★ 연결 부재와 조회 실패는 구분한다', () => {
    eq(connectionLookupOutcome('missing', { data: null, error: null }), null);
    eq(connectionLookupOutcome('present', {
      data: { api_key: 'k', api_secret_enc: 'e' }, error: null,
    }), null);
    eq(connectionLookupOutcome('malformed', null)?.ok, false);
    eq(connectionLookupOutcome('malformed', { error: null })?.ok, false);
    eq(connectionLookupOutcome('malformed', { data: undefined, error: null })?.ok, false);
  });




  // ── Issue #453: 미확정 대상 500건 잘림 및 페이지 신뢰성 ──
  const scanRow = (id: number, connection: string, status = 'INTENT', createdAt = ago(900_000)) =>
    ({ id: String(id).padStart(6, '0'), connection_id: connection,
       user_id: 'u1', status, created_at: createdAt });
  const scanFixture = (rows: ReturnType<typeof scanRow>[]) =>
    async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null });

  test('★ #453 500개 오래된 INTENT 뒤의 c2 UNKNOWN도 방문 대상으로 읽는다', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => scanRow(i, 'c1'));
    rows.push(scanRow(500, 'c2', 'UNKNOWN', ago(300_000)));
    const r = await scanPendingRows(scanFixture(rows));
    eq(r.complete, true, '뒤 페이지를 읽지 못했다');
    eq(r.rows.length, 501);
    const t = pendingTargets(r.rows, { now: NOW });
    eq(t.map(x => x.connectionId).join(','), 'c1,c2');
    eq(t[0].count, 500);
  });

  test('★ #453 정확히 500행이면 다음 빈 페이지를 읽고 complete 증명', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => scanRow(i, 'c1'));
    const requests: string[] = [];
    const r = await scanPendingRows(async (from, to) => {
      requests.push(from + ':' + to);
      return { data: rows.slice(from, to + 1), error: null };
    });
    eq(r.complete, true);
    eq(r.rows.length, 500);
    eq(requests.length, 2);
    eq(requests[1], '500:999');
  });

  test('★ #453 둘째 페이지 조회 실패를 빈 목록/ok true로 숨기지 않는다', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => scanRow(i, 'c1'));
    const r = await scanPendingRows(async (from, to) =>
      from >= 500 ? { data: null, error: { message: 'db unavailable' } }
        : { data: rows.slice(from, to + 1), error: null });
    eq(r.complete, false);
    eq(r.error, 'query_failed');
    eq(r.rows.length, 500);
  });

  test('★ #453 전체 빈 DB는 정상적인 0건이다', async () => {
    const r = await scanPendingRows(scanFixture([]));
    eq(r.complete, true);
    eq(r.rows.length, 0);
    eq(r.pages, 1);
  });

  test('★ #453 페이지 상한 초과는 대조 완료로 보고하지 않는다', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => scanRow(i, 'c1'));
    const r = await scanPendingRows(scanFixture(rows), { pageSize: 500, maxPages: 1 });
    eq(r.complete, false);
    eq(r.error, 'scan_limit');
    eq(r.rows.length, 500);
  });

  test('★ #453 같은 created_at의 경계 행도 id 순서로 모두 보존', async () => {
    const timestamp = ago(900_000);
    const rows = Array.from({ length: 502 }, (_, i) =>
      scanRow(i, i < 500 ? 'c1' : 'c2', 'UNKNOWN', timestamp));
    const r = await scanPendingRows(scanFixture(rows));
    eq(r.complete, true);
    eq(r.rows.length, 502);
    eq(new Set(r.rows.map(x => x.id)).size, 502);
    eq(r.rows[501].id, '000501');
  });

  test('★ #453 offset 드리프트로 같은 ID가 다음 페이지에 중복되면 실패', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => scanRow(i, 'c1'));
    const r = await scanPendingRows(async (from, to) =>
      from === 500
        ? { data: [rows[499]], error: null }
        : { data: rows.slice(from, to + 1), error: null });
    eq(r.complete, false);
    eq(r.error, 'unstable_page');
  });

  test('★ #453 비배열 페이지 응답은 정상 빈 페이지가 아니다', async () => {
    const r = await scanPendingRows(async () => ({ data: null, error: null }));
    eq(r.complete, false);
    eq(r.error, 'invalid_page');
  });


  test('★ #453 페이지 사이 앞쪽 행 삭제 시 OFFSET 누락 없이 커서로 이어 읽는다', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => scanRow(i, 'c1'));
    let reads = 0;
    const r = await scanPendingRows(async (from, to, cursor?) => {
      // 첫 500건을 읽은 직후 앞쪽 한 행이 삭제된다.
      // OFFSET 500은 원래 501번째 행을 건너뛰지만 keyset은 그렇지 않다.
      if (reads++ === 1) rows.splice(100, 1);
      const remaining = cursor
        ? rows.filter(x => x.created_at > cursor.createdAt
          || (x.created_at === cursor.createdAt && x.id > cursor.id))
        : rows;
      const start = cursor ? 0 : from;
      return { data: remaining.slice(start, start + to - from + 1), error: null };
    });
    eq(r.complete, true);
    eq(r.rows.length, 1001, 'OFFSET 드리프트로 한 행이 누락됐다');
    eq(r.rows.some(x => x.id === '000500'), true, '경계 바로 뒤의 주문이 누락됐다');
  });

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

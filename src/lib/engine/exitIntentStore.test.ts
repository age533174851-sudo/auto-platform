// src/lib/engine/exitIntentStore.test.ts
//
// **기록 실패가 청산 실패가 되지 않는가. UNKNOWN을 거부로 적지 않는가.**
import { test, assert, eq } from '../../test/harness';
import {
  recordExitIntent, markExitIntentResult, judgeExitDurability,
  judgeExitSendPermission, findExitIntent, findOtherPendingExitForSeat,
  claimAtomicExitSeatForResearch, type AtomicExitSeatIdentity,
  type AtomicExitSeatStore, MAX_SENDS_PER_KEY,
  PENDING_EXIT_STATUSES, type ExitIntentRecord,
} from './exitIntentStore';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 가짜 장부. 삽입·갱신을 세고, 지정한 오류를 돌려준다 */
function fakeStore(opts: {
  insertError?: any; updateError?: any; throwOn?: 'insert' | 'update';
} = {}) {
  const rows: any[] = [];
  const calls = { insert: 0, update: 0, tables: [] as string[] };
  const store = {
    from(table: string) {
      calls.tables.push(table);
      return {
        insert(row: any) {
          calls.insert += 1;
          if (opts.throwOn === 'insert') throw new Error('연결 끊김');
          if (opts.insertError) {
            return { select: () => ({ single: async () => ({ data: null, error: opts.insertError }) }) };
          }
          // UNIQUE(client_order_id) 를 흉내낸다
          if (rows.some(r => r.client_order_id === row.client_order_id)) {
            return { select: () => ({ single: async () => ({ data: null, error: { code: '23505' } }) }) };
          }
          rows.push({ ...row, id: `row-${rows.length + 1}` });
          return { select: () => ({ single: async () => ({ data: { id: `row-${rows.length}`, status: row.status }, error: null }) }) };
        },
        update(patch: any) {
          calls.update += 1;
          if (opts.throwOn === 'update') throw new Error('연결 끊김');
          return {
            eq: async (col: string, val: any) => {
              if (opts.updateError) return { error: opts.updateError };
              for (const r of rows) if (r[col] === val) Object.assign(r, patch);
              return { error: null };
            },
          };
        },
        select: () => ({ eq: () => ({}) }),
      };
    },
  };
  return { store: store as any, rows, calls };
}

const intent = (over: Partial<ExitIntentRecord> = {}): ExitIntentRecord => ({
  clientOrderId: 'x5t_abc', connectionId: 'conn-1', exchange: 'binance',
  mode: 'TESTNET', symbol: 'BTCUSDT', orderSide: 'SELL', quantity: 0.01, ...over,
});

export function runExitIntentStoreTests() {

  // ── ① 보내기 전에 적는다 ──

  test('기록 ① 정상이면 INTENT 행을 적는다', async () => {
    const f = fakeStore();
    const r = await recordExitIntent(f.store, intent());
    eq(r.code, 'RECORDED'); eq(r.durable, true); eq(r.maySend, true);
    eq(f.rows.length, 1);
    eq(f.rows[0].status, 'INTENT');
    eq(f.calls.tables[0], 'live_orders');
  });

  test('★ 기록 ② 청산 행은 reduce_only로 표시된다 (진입으로 세지 않게)', async () => {
    const f = fakeStore();
    await recordExitIntent(f.store, intent());
    eq(f.rows[0].reduce_only, true,
      'reduce_only가 없으면 managedPosition이 이 행을 진입으로 센다');
  });

  test('★ 기록 ③ 장부를 섞지 않게 mode를 반드시 적는다', async () => {
    const f = fakeStore();
    await recordExitIntent(f.store, intent({ mode: 'TESTNET' }));
    eq(f.rows[0].mode, 'TESTNET');
  });

  // ── ② 기록 실패가 청산을 막지 않는다 ──

  // ── 자동과 긴급의 장애 정책은 다르다 ──
  //
  //   처음에는 "기록 실패에도 무조건 전송 허가"로 적었다. 독립 감사가
  //   그것이 자동 회차에서 중복 재전송을 허용한다고 지적했고, 맞다.
  //   자동은 5분 뒤 다시 오므로 **미루면 된다.** 긴급은 사람이 눌렀고
  //   다음 회차를 기다릴 수 없으므로 **보내야 한다.**

  test('★ 실패 ① 자동 회차: DB 오류면 이번 회차를 미룬다', async () => {
    const f = fakeStore({ insertError: { code: '42501' } });
    const r = await recordExitIntent(f.store, intent(), 'AUTOMATIC');
    eq(r.code, 'WRITE_FAILED'); eq(r.durable, false);
    eq(r.maySend, false, '중복 아님을 증명할 수 없으면 보내지 않는다');
    assert(/다음 회차/.test(r.reason), '영구 차단이 아님을 이유에 적는다');
  });

  test('★ 실패 ①-b 긴급 청산: DB 오류에도 보낸다', async () => {
    const f = fakeStore({ insertError: { code: '42501' } });
    const r = await recordExitIntent(f.store, intent(), 'EMERGENCY');
    eq(r.code, 'WRITE_FAILED'); eq(r.durable, false);
    eq(r.maySend, true, '사람이 누른 비상 정지가 DB 때문에 안 나가면 안 된다');
    eq(r.duplicateRisk, true, '중복 위험을 숨기지 않는다');
  });

  test('★ 실패 ①-c 기본 정책은 자동이다 (긴급이 기본이면 전부 긴급이 된다)', async () => {
    const f = fakeStore({ insertError: { code: '42501' } });
    const r = await recordExitIntent(f.store, intent());
    eq(r.maySend, false, '정책을 안 적으면 자동으로 다룬다');
  });

  test('★ 실패 ② 예외도 정책을 따른다', async () => {
    eq((await recordExitIntent(fakeStore({ throwOn: 'insert' }).store, intent(),
      'AUTOMATIC')).maySend, false);
    eq((await recordExitIntent(fakeStore({ throwOn: 'insert' }).store, intent(),
      'EMERGENCY')).maySend, true);
  });

  test('★ 실패 ③ 장부 핸들이 없어도 정책을 따른다', async () => {
    for (const sb of [null, undefined] as any[]) {
      eq((await recordExitIntent(sb, intent(), 'AUTOMATIC')).maySend, false);
      eq((await recordExitIntent(sb, intent(), 'EMERGENCY')).maySend, true);
    }
  });

  test('★ 실패 ③-b 모드를 모르면 기본값으로 메우지 않는다', async () => {
    const f = fakeStore();
    for (const m of [null, undefined, '', '  '] as any[]) {
      // 자동 회차: 기록할 수 없으니 미룬다.
      const a = await recordExitIntent(f.store, intent({ mode: m }), 'AUTOMATIC');
      eq(a.code, 'WRITE_FAILED', String(m));
      eq(a.durable, false);
      eq(a.maySend, false, '중복 아님을 증명할 수 없으면 미룬다');
      // 긴급: 기록은 못 해도 보낸다.
      const e = await recordExitIntent(f.store, intent({ mode: m }), 'EMERGENCY');
      eq(e.maySend, true, '사람이 누른 비상 정지는 모드 불명에도 나간다');
      eq(e.duplicateRisk, true);
    }
    eq(f.rows.length, 0, "★ 'TESTNET'으로 메운 행이 생기면 LIVE 청산이 섞인다");
  });

  test('★ 실패 ④ 멱등 키가 없으면 삽입을 시도하지 않는다', async () => {
    const f = fakeStore();
    for (const cid of ['', '   '] as any[]) {
      const r = await recordExitIntent(f.store, intent({ clientOrderId: cid }), 'AUTOMATIC');
      eq(r.code, 'WRITE_FAILED'); eq(r.maySend, false);
    }
    eq(f.calls.insert, 0);
  });

  test('★ 실패 ⑤ 긴급은 어떤 장애에서도 길이 남는다 (영구 차단 없음)', async () => {
    for (const f of [
      fakeStore({ insertError: { code: '23503' } }),
      fakeStore({ insertError: { code: 'PGRST301' } }),
      fakeStore({ throwOn: 'insert' }),
    ]) {
      eq((await recordExitIntent(f.store, intent(), 'EMERGENCY')).maySend, true);
    }
    eq((await recordExitIntent(null as any, intent(), 'EMERGENCY')).maySend, true);
  });

  // ── ③ 중복 워커 · 재시작 ──

  test('★★ 중복 ① 선점에서 지면 보내지 않는다 (23505 ≠ 전송 허가)', async () => {
    // 독립 감사가 잡은 결함이다. `ALREADY_EXISTS`에서 maySend:true를
    // 돌려주면, 다른 워커가 방금 선점한 의도를 내가 또 보낸다.
    const f = fakeStore();
    const a = await recordExitIntent(f.store, intent());
    const b = await recordExitIntent(f.store, intent());
    eq(a.code, 'RECORDED'); eq(a.maySend, true, '먼저 잡은 쪽은 보낸다');
    eq(b.code, 'ALREADY_EXISTS');
    eq(b.maySend, false,
      '★ 기존 intent의 존재가 새 전송의 허가가 되어서는 안 된다');
    eq(f.rows.length, 1, '행이 두 개가 되지 않는다');
  });

  test('★★ 중복 ①-b 긴급도 선점을 뚫지 않는다', async () => {
    // 같은 순간 다른 실행자가 이미 보내고 있는데 긴급이라고 하나 더
    // 보내면 두 건이 나간다. 긴급의 목적은 "막힌 청산을 뚫는 것"이고
    // "중복을 만드는 것"이 아니다.
    const f = fakeStore();
    await recordExitIntent(f.store, intent());
    const b = await recordExitIntent(f.store, intent(), 'EMERGENCY');
    eq(b.code, 'ALREADY_EXISTS'); eq(b.maySend, false);
  });

  test('★★ 중복 ①-c 동시 워커 3개 — 정확히 하나만 보낸다', async () => {
    const f = fakeStore();
    const rs = await Promise.all([
      recordExitIntent(f.store, intent()),
      recordExitIntent(f.store, intent()),
      recordExitIntent(f.store, intent()),
    ]);
    const allowed = rs.filter(r => r.maySend);
    eq(allowed.length, 1, `전송 허가가 ${allowed.length}건이다 — 정확히 1건이어야 한다`);
    eq(allowed[0].code, 'RECORDED');
    eq(f.rows.length, 1);
    for (const r of rs.filter(r => !r.maySend)) eq(r.code, 'ALREADY_EXISTS');
  });

  test('★★ 중복 ①-d 동시 워커 3개 + 긴급 섞임 — 여전히 하나만', async () => {
    const f = fakeStore();
    const rs = await Promise.all([
      recordExitIntent(f.store, intent(), 'AUTOMATIC'),
      recordExitIntent(f.store, intent(), 'EMERGENCY'),
      recordExitIntent(f.store, intent(), 'EMERGENCY'),
    ]);
    eq(rs.filter(r => r.maySend).length, 1,
      '긴급이 섞여도 선점은 하나다 — 긴급이 중복을 만들지 않는다');
  });

  test('★ 중복 ② 수량이 다르면 다른 키이므로 다른 행이다 (부분 체결 뒤)', async () => {
    // 이것이 이 모듈이 필요한 이유다. 키는 수량에서 나오므로 부분 체결
    // 뒤에는 키가 바뀐다. 앞 행이 남아 있어야 앞 주문을 찾을 수 있다.
    const f = fakeStore();
    await recordExitIntent(f.store, intent({ clientOrderId: 'x5t_A', quantity: 0.010 }));
    await recordExitIntent(f.store, intent({ clientOrderId: 'x5t_B', quantity: 0.006 }));
    eq(f.rows.length, 2);
    const pending = f.rows.filter(r => (PENDING_EXIT_STATUSES as readonly string[]).includes(r.status));
    eq(pending.length, 2, '★ 두 의도가 모두 미결로 남아 재시작이 둘 다 본다');
  });

  // ── ④ 전송 결과 ──

  test('결과 ① 접수를 적는다', async () => {
    const f = fakeStore();
    await recordExitIntent(f.store, intent());
    const r = await markExitIntentResult(f.store, 'x5t_abc', 'ACKED',
      { exchangeOrderId: '9100', executedQty: 0.01 });
    eq(r.ok, true);
    eq(f.rows[0].status, 'ACKED');
    eq(f.rows[0].exchange_order_id, '9100');
    eq(f.rows[0].filled_qty, 0.01);
  });

  test('★ 결과 ② UNKNOWN을 거부로 적지 않는다', async () => {
    const f = fakeStore();
    await recordExitIntent(f.store, intent());
    await markExitIntentResult(f.store, 'x5t_abc', 'UNKNOWN');
    eq(f.rows[0].status, 'UNKNOWN',
      '거부로 적으면 "안 나갔다"로 읽혀 같은 자리에 또 보낸다');
    assert((PENDING_EXIT_STATUSES as readonly string[]).includes('UNKNOWN'),
      'UNKNOWN은 아직 끝나지 않은 상태여야 한다');
  });

  test('★ 결과 ③ 체결량을 모르면 적지 않는다 (보낸 수량으로 메우지 않는다)', async () => {
    const f = fakeStore();
    await recordExitIntent(f.store, intent());
    await markExitIntentResult(f.store, 'x5t_abc', 'ACKED', { executedQty: null });
    eq(f.rows[0].filled_qty, undefined, '모르는 체결량을 보낸 수량으로 적지 않는다');
    await markExitIntentResult(f.store, 'x5t_abc', 'ACKED', { executedQty: Number.NaN });
    eq(f.rows[0].filled_qty, undefined);
  });

  test('★ 결과 ④ 갱신이 실패하면 행은 미결 상태로 남는다', async () => {
    const f = fakeStore({ updateError: { code: '42501' } });
    await recordExitIntent(f.store, intent());
    const r = await markExitIntentResult(f.store, 'x5t_abc', 'ACKED');
    eq(r.ok, false);
    eq(f.rows[0].status, 'INTENT',
      '미결로 남는 것이 맞다 — 재시작이 다시 본다');
    assert((PENDING_EXIT_STATUSES as readonly string[]).includes('INTENT'));
  });

  test('★ 결과 ⑤ 갱신 예외도 던지지 않고 돌려준다', async () => {
    const f = fakeStore({ throwOn: 'update' });
    const r = await markExitIntentResult(f.store, 'x5t_abc', 'ACKED');
    eq(r.ok, false);
    assert(r.reason.length > 0, '이유를 비우지 않는다');
  });

  // ── ⑤ 내구성 판정 ──

  test('내구성 ① 보내고 기록됐으면 알리지 않는다', () => {
    const v = judgeExitDurability({ attempted: true, durable: true });
    eq(v.code, 'DURABLE'); eq(v.alertOperator, false);
  });

  test('★ 내구성 ② 기록 없이 보냈으면 사람을 부른다', () => {
    for (const d of [false, null, undefined] as any[]) {
      const v = judgeExitDurability({ attempted: true, durable: d });
      eq(v.code, 'SENT_UNRECORDED', String(d));
      eq(v.alertOperator, true,
        '조용히 넘기면 "보냈는데 기록이 없는" 주문을 다음 회차가 모른다');
    }
  });

  test('내구성 ③ 보내지 않았으면 알리지 않는다', () => {
    for (const i of [{ attempted: false }, {}, null, undefined] as any[]) {
      const v = judgeExitDurability(i);
      eq(v.code, 'NOT_SENT'); eq(v.alertOperator, false);
    }
  });

  test('★ 내구성 ④ SENT_UNRECORDED를 실패로 적지 않는다', () => {
    // 주문은 나갔고 그것이 맞는 선택이었다. 실패가 아니라 기록의 공백이다.
    const v = judgeExitDurability({ attempted: true, durable: false });
    assert(!/실패/.test(v.reason), `이유에 "실패"가 들어갔다: ${v.reason}`);
    assert(/기록/.test(v.reason), '무엇이 없는지 적는다');
  });

  // ══════════════════════════════════════════════════════════
  // ⑥ 전송 허가 — 두 정책의 통합 (D 목록)
  // ══════════════════════════════════════════════════════════

  const perm = (over: any = {}) => judgeExitSendPermission({
    prior: { recordFound: false, recordStatus: undefined,
      venueLookup: null, sendCount: 0, ...(over.prior ?? {}) },
    ...(over.emergency != null ? { emergency: over.emergency } : {}),
    ...(over.maxSends != null ? { maxSends: over.maxSends } : {}),
  });

  test('★ 허가 ① 첫 전송은 기록 실패와 무관하게 허가한다', () => {
    const v = perm();
    eq(v.code, 'FIRST_SEND'); eq(v.maySend, true);
  });

  test('★ 허가 ② D: 전송 성공 + 응답 유실 → 다시 보내지 않는다', () => {
    // 응답을 못 받았으니 장부는 UNKNOWN으로 남는다. 그 위에 또 보내면
    // 중복 청산이다.
    const v = perm({ prior: { recordFound: true, recordStatus: 'UNKNOWN' } });
    eq(v.code, 'BLOCKED_PRIOR_LIVE'); eq(v.maySend, false);
  });

  test('★ 허가 ③ 거래소가 "없다"고 하면 거래소가 최종 권위다', () => {
    const v = perm({ prior: { recordFound: true, recordStatus: 'UNKNOWN',
      venueLookup: { ok: true, found: false } } });
    eq(v.code, 'RESEND_PRIOR_RESOLVED'); eq(v.maySend, true);
  });

  test('★ 허가 ④ 거래소가 "있다"고 하면 막는다', () => {
    const v = perm({ prior: { recordFound: true, recordStatus: 'ACKED',
      venueLookup: { ok: true, found: true } } });
    eq(v.code, 'BLOCKED_PRIOR_LIVE'); eq(v.maySend, false);
  });

  test('★ 허가 ⑤ 조회 실패를 "없다"로 읽지 않는다', () => {
    // `ok: false`는 못 물어본 것이다. 이것을 없음으로 읽으면 중복이 난다.
    for (const st of ['INTENT', 'SENT', 'ACKED', 'UNKNOWN']) {
      const v = perm({ prior: { recordFound: true, recordStatus: st,
        venueLookup: { ok: false, found: false } } });
      eq(v.maySend, false, `${st}에서 재전송이 열렸다`);
    }
  });

  test('★ 허가 ⑥ D: 서버 재시작 — 장부도 거래소도 못 읽으면 보내지 않는다', () => {
    const v = judgeExitSendPermission({
      prior: { recordFound: undefined, recordStatus: undefined,
        venueLookup: { ok: false, found: false }, sendCount: undefined } });
    eq(v.code, 'BLOCKED_PRIOR_UNKNOWN'); eq(v.maySend, false);
    assert(/긴급 종료는 명시적으로/.test(v.reason), '빠져나갈 길을 이유에 적는다');
  });

  test('★ 허가 ⑦ 장부를 못 읽어도 거래소가 "없다"면 첫 전송이다', () => {
    const v = judgeExitSendPermission({
      prior: { recordFound: undefined, recordStatus: undefined,
        venueLookup: { ok: true, found: false }, sendCount: undefined } });
    eq(v.code, 'FIRST_SEND'); eq(v.maySend, true);
  });

  test('허가 ⑧ 앞 시도가 끝났으면 다시 보낸다', () => {
    for (const st of ['FILLED', 'REJECTED', 'FAILED', 'RECONCILED']) {
      const v = perm({ prior: { recordFound: true, recordStatus: st } });
      eq(v.code, 'RESEND_PRIOR_RESOLVED', st); eq(v.maySend, true);
    }
  });

  test('★ 허가 ⑨ D: 동시 워커 — 상한을 넘으면 사람이 필요하다', () => {
    const v = perm({ prior: { recordFound: true, recordStatus: 'FAILED', sendCount: 3 } });
    eq(v.code, 'BLOCKED_ATTEMPT_CAP'); eq(v.maySend, false);
    assert(/사람이 필요한/.test(v.reason));
  });

  test('★ 허가 ⑩ 상한은 긴급보다도 앞이다 (긴급이 무한 루프가 되지 않게)', () => {
    const v = judgeExitSendPermission({
      prior: { recordFound: true, recordStatus: 'UNKNOWN',
        venueLookup: null, sendCount: 5 },
      emergency: true });
    eq(v.code, 'BLOCKED_ATTEMPT_CAP', '긴급이 상한을 무시하면 무한 재전송 경로가 된다');
    eq(v.maySend, false);
  });

  test('★ 허가 ⑪ 긴급 청산 가능성은 보존된다 (명시적일 때만)', () => {
    const v = judgeExitSendPermission({
      prior: { recordFound: true, recordStatus: 'UNKNOWN',
        venueLookup: null, sendCount: 1 },
      emergency: true });
    eq(v.code, 'EMERGENCY_OVERRIDE'); eq(v.maySend, true);
    eq(v.duplicateRisk, true, '중복 가능성을 숨기지 않는다');
  });

  test('★ 허가 ⑫ 긴급은 기본값이 아니다', () => {
    for (const e of [false, null, undefined] as any[]) {
      const v = judgeExitSendPermission({
        prior: { recordFound: true, recordStatus: 'UNKNOWN',
          venueLookup: null, sendCount: 1 },
        ...(e != null ? { emergency: e } : {}) });
      assert(v.code !== 'EMERGENCY_OVERRIDE', `${String(e)}에서 긴급이 됐다`);
      eq(v.maySend, false);
    }
  });

  test('★ 허가 ⑬ 상태를 못 읽은 행 위에 또 보내지 않는다', () => {
    for (const st of [undefined, '', '   '] as any[]) {
      const v = perm({ prior: { recordFound: true, recordStatus: st } });
      eq(v.code, 'BLOCKED_PRIOR_UNKNOWN', String(st)); eq(v.maySend, false);
    }
  });

  test('★ 허가 ⑭ 입력이 아예 없으면 보내지 않는다', () => {
    for (const i of [null, undefined, {}] as any[]) {
      const v = judgeExitSendPermission(i);
      eq(v.maySend, false, String(JSON.stringify(i)));
      eq(v.code, 'BLOCKED_PRIOR_UNKNOWN');
    }
  });

  test('★ 허가 ⑮ 무제한 재전송 경로가 존재하지 않는다 (전수)', () => {
    // 허가가 나는 모든 조합에서, 상한에 닿으면 반드시 막혀야 한다.
    const vals = [true, false, undefined] as any[];
    const statuses = [undefined, 'INTENT', 'SENT', 'ACKED', 'UNKNOWN',
      'FILLED', 'REJECTED', 'FAILED', 'RECONCILED'] as any[];
    const lookups = [null, { ok: true, found: true }, { ok: true, found: false },
      { ok: false, found: false }] as any[];
    let allowed = 0;
    for (const rf of vals) for (const st of statuses) for (const lk of lookups)
      for (const em of [true, false] as any[]) {
        const atCap = judgeExitSendPermission({
          prior: { recordFound: rf, recordStatus: st, venueLookup: lk,
            sendCount: MAX_SENDS_PER_KEY },
          emergency: em });
        eq(atCap.maySend, false,
          `상한에서 허가가 났다: rf=${String(rf)} st=${String(st)} em=${em}`);
        const under = judgeExitSendPermission({
          prior: { recordFound: rf, recordStatus: st, venueLookup: lk, sendCount: 0 },
          emergency: em });
        if (under.maySend) allowed += 1;
      }
    assert(allowed > 0, '허가되는 경우가 없으면 청산이 영구히 막힌다');
  });

  // ── ⑦ 장부 조회 ──

  test('★ 조회 ① 못 읽은 것과 없는 것을 가른다', async () => {
    const found = {
      from: () => ({ select: () => ({ eq: () => ({
        maybeSingle: async () => ({ data: { status: 'ACKED' }, error: null }) }) }) }),
    };
    eq((await findExitIntent(found as any, 'k')).recordFound, true);
    eq((await findExitIntent(found as any, 'k')).recordStatus, 'ACKED');

    const empty = {
      from: () => ({ select: () => ({ eq: () => ({
        maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    };
    eq((await findExitIntent(empty as any, 'k')).recordFound, false, '없다');

    const broken = {
      from: () => ({ select: () => ({ eq: () => ({
        maybeSingle: async () => ({ data: null, error: { code: '42501' } }) }) }) }),
    };
    eq((await findExitIntent(broken as any, 'k')).recordFound, undefined,
      '★ 못 읽은 것을 "없다"로 적으면 중복 주문이 난다');

    const throws = { from: () => { throw new Error('x'); } };
    eq((await findExitIntent(throws as any, 'k')).recordFound, undefined);
    eq((await findExitIntent(null as any, 'k')).recordFound, undefined);
    eq((await findExitIntent(found as any, '')).recordFound, undefined);
  });

  // ── ⑦-b 부분 체결 시 바뀐 clientOrderId의 이전 청산을 찾는다 ──
  // All fake DB rows are intentionally synthetic. This is not real Binance
  // openOrders evidence and cannot authorize a send to either environment.
  const seatOf = (clientOrderId = 'new_qty_key') => ({
    userId: 'u1', connectionId: 'conn-1', exchange: 'binance',
    mode: 'TESTNET', symbol: 'BTCUSDT', clientOrderId,
  });
  const fakeSeatDb = (rows: Record<string, any>[], error: any = null) => {
    const observed = { tables: [] as string[], filters: [] as string[] };
    const db = {
      from(table: string) {
        observed.tables.push(table);
        let subset = [...rows];
        let limit = 999;
        const chain = {
          eq(col: string, val: any) {
            observed.filters.push(col);
            subset = subset.filter(r => r[col] === val); return this;
          },
          neq(col: string, val: any) {
            observed.filters.push('neq:' + col);
            subset = subset.filter(r => r[col] !== val); return this;
          },
          in(col: string, vals: string[]) {
            observed.filters.push('in:' + col);
            subset = subset.filter(r => vals.includes(r[col])); return this;
          },
          limit(n: number) { limit = n; return this; },
          then(yes: any, no: any) {
            return Promise.resolve({ data: subset.slice(0, limit), error }).then(yes, no);
          },
        };
        return { select: () => chain };
      },
    };
    return { db: db as any, observed };
  };
  const fakeExitRow = (over: Record<string, any> = {}) => ({
    user_id: 'u1', connection_id: 'conn-1', exchange: 'binance',
    mode: 'TESTNET', symbol: 'BTCUSDT',
    client_order_id: 'old_qty_key', reduce_only: true, status: 'UNKNOWN',
    ...over,
  });

  test('★ partial-fill restart: older quantity-derived key blocks next close', async () => {
    const f = fakeSeatDb([fakeExitRow()]);
    const r = await findOtherPendingExitForSeat(f.db, seatOf());
    eq(r.code, 'BLOCKED_OTHER_PENDING_EXIT');
    eq(r.mayProceedToExistingOrderGate, false);
    eq(f.observed.tables[0], 'live_orders');
    for (const col of ['user_id', 'connection_id', 'exchange', 'mode',
      'symbol', 'reduce_only', 'in:status', 'neq:client_order_id']) {
      assert(f.observed.filters.includes(col), 'Scope/filter missing: ' + col);
    }
  });

  test('★ restart 3 times: same pending old key never opens a second automatic send', async () => {
    const f = fakeSeatDb([fakeExitRow()]);
    for (let restart = 0; restart < 3; restart++) {
      const r = await findOtherPendingExitForSeat(f.db, seatOf());
      eq(r.mayProceedToExistingOrderGate, false, 'restart=' + restart);
    }
  });

  test('★ same owner and symbol but different connection / mode / exchange is separate seat', async () => {
    const f = fakeSeatDb([
      fakeExitRow({ connection_id: 'other-conn' }),
      fakeExitRow({ user_id: 'other-user' }),
      fakeExitRow({ mode: 'LIVE' }),
      fakeExitRow({ exchange: 'other-venue' }),
      fakeExitRow({ symbol: 'ETHUSDT' }),
    ]);
    const r = await findOtherPendingExitForSeat(f.db, seatOf());
    eq(r.code, 'CLEAR_IN_LEDGER');
    eq(r.mayProceedToExistingOrderGate, true);
  });

  test('★ entry orders, completed exits and same key do not masquerade as OTHER pending', async () => {
    const f = fakeSeatDb([
      fakeExitRow({ reduce_only: false }),
      fakeExitRow({ status: 'FILLED' }),
      fakeExitRow({ status: 'RECONCILED' }),
      fakeExitRow({ client_order_id: 'new_qty_key' }),
    ]);
    const r = await findOtherPendingExitForSeat(f.db, seatOf());
    eq(r.mayProceedToExistingOrderGate, true);
    // Same-key pending is still blocked by existing findExitIntent/judge
    // in the route; this gate only covers a DIFFERENT quantity-derived key.
  });

  test('★ read errors, thrown DB calls and malformed payload block instead of empty', async () => {
    const broken = fakeSeatDb([], { code: '42501' });
    eq((await findOtherPendingExitForSeat(broken.db, seatOf())).code,
      'BLOCKED_SEAT_LOOKUP_UNKNOWN');
    const throws = { from: () => { throw new Error('read unavailable'); } };
    eq((await findOtherPendingExitForSeat(throws as any, seatOf())).code,
      'BLOCKED_SEAT_LOOKUP_UNKNOWN');
    const malformed = { from: () => ({ select: () => {
      const q: any = { eq() { return q; }, in() { return q; },
        neq() { return q; }, limit() { return Promise.resolve({ data: null, error: null }); } };
      return q;
    } }) };
    eq((await findOtherPendingExitForSeat(malformed as any, seatOf())).code,
      'BLOCKED_SEAT_LOOKUP_UNKNOWN');
  });

  test('★ missing scope or missing DB does not fall back to all-users lookup', async () => {
    const f = fakeSeatDb([]);
    eq((await findOtherPendingExitForSeat(f.db, { ...seatOf(), userId: '' })).code,
      'BLOCKED_SEAT_LOOKUP_UNKNOWN');
    eq((await findOtherPendingExitForSeat(f.db, { ...seatOf(), connectionId: null })).code,
      'BLOCKED_SEAT_LOOKUP_UNKNOWN');
    eq((await findOtherPendingExitForSeat(null, seatOf())).code,
      'BLOCKED_SEAT_LOOKUP_UNKNOWN');
    eq(f.observed.tables.length, 0, 'Invalid scope must not issue broad DB search');
  });

  test('★ unknown send count on EXISTING intent may not bypass 3-send cap', () => {
    const prior = { recordFound: true, recordStatus: 'RECONCILED',
      venueLookup: { ok: true, found: false }, sendCount: undefined };
    const r = judgeExitSendPermission({ prior });
    eq(r.code, 'BLOCKED_PRIOR_UNKNOWN');
    eq(r.maySend, false);
    const provenFirst = judgeExitSendPermission({
      prior: { ...prior, sendCount: 0 },
    });
    eq(provenFirst.code, 'RESEND_PRIOR_RESOLVED');
    eq(provenFirst.maySend, true);
  });

  test('★ route wires seat lookup BEFORE checking current key / writing intent', () => {
    const route = readFileSync(resolve(process.cwd(),
      'src/app/api/autotrade/exit-monitor/route.ts'), 'utf8');
    const marker = 'await findOtherPendingExitForSeat(sb as any';
    const idx = route.indexOf(marker);
    assert(idx >= 0, 'No per-seat pending exit check in production route');
    const after = route.slice(idx);
    assert(after.indexOf('await findExitIntent') > 0, 'Missing existing-key reconciliation');
    assert(after.indexOf('await recordExitIntent') > 0, 'No write-ahead intent');
    assert(after.indexOf('await findExitIntent') < after.indexOf('await recordExitIntent'),
      'Existing-key query must occur before claiming the order');
  });

  // ── ⑦-c 원자적 seat claim 계약 (아직 실행 경로 미배선) ──
  const atomicSeat = (over: Partial<AtomicExitSeatIdentity> = {}): AtomicExitSeatIdentity => ({
    userId: 'owner-1', connectionId: 'conn-1', exchange: 'binance',
    mode: 'TESTNET', symbol: 'BTCUSDT',
    clientOrderId: 'close-qty-010', ownerToken: 'fence-1',
    ...over,
  });
  const atomicFake = () => {
    const claims = new Map<string, AtomicExitSeatIdentity>();
    const keyOf = (x: AtomicExitSeatIdentity) =>
      JSON.stringify([x.userId, x.connectionId, x.exchange, x.mode, x.symbol]);
    const store: AtomicExitSeatStore = {
      // IMPORTANT: fake atomic unique insert, NOT a production DB adapter.
      // This map.set is synchronous before any await (single JS scheduler).
      async claimUniqueSeat(x) {
        const key = keyOf(x);
        const older = claims.get(key);
        if (older) return { code: 'ALREADY_HELD' as const, record: older };
        claims.set(key, x);
        return { code: 'CLAIMED' as const, record: x };
      },
    };
    return { claims, store };
  };

  test('★ 3 simultaneous workers with different quantities/IDs -> ONE seat winner', async () => {
    const { claims, store } = atomicFake();
    const candidates = [
      atomicSeat({ clientOrderId: 'close-qty-010', ownerToken: 'worker-a' }),
      atomicSeat({ clientOrderId: 'close-qty-006', ownerToken: 'worker-b' }),
      atomicSeat({ clientOrderId: 'close-qty-003', ownerToken: 'worker-c' }),
    ];
    const out = await Promise.all(candidates.map(i => claimAtomicExitSeatForResearch(store, i)));
    eq(out.filter(x => x.seatClaimed).length, 1,
      'Different clientOrderIds for the same net position must not BOTH win');
    eq(out.filter(x => x.code === 'ALREADY_HELD').length, 2);
    eq(claims.size, 1);
    out.forEach(x => eq(x.executionAuthorized, false,
      'Research seat wins must NEVER authorize a trade'));
  });

  test('★ 3 consecutive restarts: same CID is not a new atomic seat', async () => {
    const { claims, store } = atomicFake();
    eq((await claimAtomicExitSeatForResearch(store, atomicSeat())).seatClaimed, true);
    for (let restart = 1; restart <= 3; restart++) {
      const response = await claimAtomicExitSeatForResearch(store,
        atomicSeat({ ownerToken: 'restarted-' + restart }));
      eq(response.code, 'ALREADY_HELD');
      eq(response.seatClaimed, false);
    }
    eq(claims.size, 1);
  });

  test('★ different owner, connection, exchange, mode or symbol are distinct seats', async () => {
    const { claims, store } = atomicFake();
    const identities = [
      atomicSeat(),
      atomicSeat({ userId: 'owner-2', clientOrderId: 'c2' }),
      atomicSeat({ connectionId: 'conn-2', clientOrderId: 'c3' }),
      atomicSeat({ exchange: 'gate', clientOrderId: 'c4' }),
      atomicSeat({ symbol: 'ETHUSDT', clientOrderId: 'c5' }),
    ];
    const outcomes = await Promise.all(identities.map(i=>claimAtomicExitSeatForResearch(store, i)));
    eq(outcomes.filter(x=>x.seatClaimed).length, identities.length);
    eq(claims.size, identities.length);
  });

  test('★ stale claim never auto-expires because a delayed order can still arrive', async () => {
    const { claims, store } = atomicFake();
    const before = await claimAtomicExitSeatForResearch(store, atomicSeat());
    eq(before.code, 'CLAIMED');
    // No TTL or wall-clock is part of the atomic claim contract. Reconciliation
    // plus owner-confirmed flat/fully resolved evidence is required later.
    const after = await claimAtomicExitSeatForResearch(store,
      atomicSeat({ clientOrderId: 'new-after-timeout' }));
    eq(after.code, 'ALREADY_HELD');
    eq(claims.size, 1);
  });

  test('★ missing owner/connection/mode or non-TESTNET is rejected BEFORE store', async () => {
    const { store } = atomicFake();
    let calls = 0;
    const counted: AtomicExitSeatStore = {
      claimUniqueSeat: async i => { calls++; return store.claimUniqueSeat(i); },
    };
    const cases = [
      atomicSeat({ userId: '' }), atomicSeat({ connectionId: '' }),
      atomicSeat({ clientOrderId: '' }), atomicSeat({ ownerToken: '' }),
      atomicSeat({ symbol: 'btcusdt' }), atomicSeat({ mode: 'LIVE' as any }),
      atomicSeat({ clientOrderId: 'c'.repeat(37) }),
    ];
    for (const i of cases) {
      const result = await claimAtomicExitSeatForResearch(counted, i);
      eq(result.code, 'UNAVAILABLE'); eq(result.seatClaimed, false);
    }
    eq(calls, 0);
    eq((await claimAtomicExitSeatForResearch(null, atomicSeat())).code, 'UNAVAILABLE');
  });

  test('★ claimed-looking database response with wrong seat/fence never succeeds', async () => {
    for (const altered of [
      { userId: 'other-user' }, { connectionId: 'other-connection' },
      { exchange: 'other-exchange' }, { symbol: 'ETHUSDT' },
      { clientOrderId: 'wrong-cid' }, { ownerToken: 'stale-fence' },
    ]) {
      const store: AtomicExitSeatStore = {
        claimUniqueSeat: async i => ({
          code: 'CLAIMED', record: { ...i, ...altered },
        }),
      };
      const r = await claimAtomicExitSeatForResearch(store, atomicSeat());
      eq(r.code, 'UNAVAILABLE'); eq(r.seatClaimed, false);
    }
  });

  test('★ unavailable/throwing atomic DB cannot be interpreted as free seat', async () => {
    const failed: AtomicExitSeatStore = {
      claimUniqueSeat: async () => ({ code: 'UNAVAILABLE', record: null }),
    };
    eq((await claimAtomicExitSeatForResearch(failed, atomicSeat())).seatClaimed, false);
    const throws: AtomicExitSeatStore = {
      claimUniqueSeat: async () => { throw new Error('database unavailable'); },
    };
    const x = await claimAtomicExitSeatForResearch(throws, atomicSeat());
    eq(x.code, 'UNAVAILABLE'); eq(x.seatClaimed, false);
    eq(x.executionAuthorized, false);
  });

  test('★ atomic research contract stays disconnected from active route', () => {
    const route = readFileSync(resolve(process.cwd(),
      'src/app/api/autotrade/exit-monitor/route.ts'), 'utf8');
    eq(route.includes('claimAtomicExitSeatForResearch('), false,
      'It must not be connected without deployed schema and safe claim release logic');
  });

  // ── ⑧ 정본이 순수한가 ──

  test('★ 이 모듈은 주문을 보내지 않는다', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/lib/engine/exitIntentStore.ts'), 'utf8');
    eq(/^import /m.test(src), false);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    for (const bad of ['fetch(', 'sendSymbolClose', 'placeFuturesOrder',
      'sendPreparedClose', 'apiSecret', 'process.env']) {
      eq(code.includes(bad), false, `${bad}가 보인다`);
    }
  });

  test('★ 미결 상태 목록이 종료 상태를 포함하지 않는다', () => {
    for (const terminal of ['FILLED', 'REJECTED', 'FAILED', 'RECONCILED']) {
      assert(!(PENDING_EXIT_STATUSES as readonly string[]).includes(terminal),
        `${terminal}이 미결 목록에 있다 — 끝난 주문을 재시작이 다시 본다`);
    }
  });
}

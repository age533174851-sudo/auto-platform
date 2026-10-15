// src/lib/engine/exitIntentStore.test.ts
//
// **기록 실패가 청산 실패가 되지 않는가. UNKNOWN을 거부로 적지 않는가.**
import { test, assert, eq } from '../../test/harness';
import {
  recordExitIntent, markExitIntentResult, judgeExitDurability,
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

  test('★ 실패 ① DB 오류에서도 전송을 허가한다', async () => {
    const f = fakeStore({ insertError: { code: '42501' } });
    const r = await recordExitIntent(f.store, intent());
    eq(r.code, 'WRITE_FAILED');
    eq(r.durable, false);
    eq(r.maySend, true,
      '★ 못 썼다고 청산을 막으면 못 여는 불편이 아니라 못 닫는 사고가 된다');
  });

  test('★ 실패 ② 예외에서도 전송을 허가한다', async () => {
    const f = fakeStore({ throwOn: 'insert' });
    const r = await recordExitIntent(f.store, intent());
    eq(r.code, 'WRITE_FAILED'); eq(r.maySend, true); eq(r.durable, false);
  });

  test('★ 실패 ③ 장부 핸들이 없어도 전송을 허가한다', async () => {
    for (const sb of [null, undefined] as any[]) {
      const r = await recordExitIntent(sb, intent());
      eq(r.code, 'NO_STORE'); eq(r.maySend, true); eq(r.durable, false);
    }
  });

  test('★ 실패 ③-b 모드를 모르면 기본값으로 메우지 않는다', async () => {
    const f = fakeStore();
    for (const m of [null, undefined, '', '  '] as any[]) {
      const r = await recordExitIntent(f.store, intent({ mode: m }));
      eq(r.code, 'WRITE_FAILED', String(m));
      eq(r.durable, false);
      eq(r.maySend, true, '모드를 몰라도 청산을 막지 않는다');
      assert(/메우지 않습니다/.test(r.reason), '왜 안 적는지 적는다');
    }
    eq(f.rows.length, 0, "★ 'TESTNET'으로 메운 행이 생기면 LIVE 청산이 섞인다");
  });

  test('★ 실패 ④ 멱등 키가 없으면 적지 못하지만 전송은 막지 않는다', async () => {
    const f = fakeStore();
    for (const cid of ['', '   '] as any[]) {
      const r = await recordExitIntent(f.store, intent({ clientOrderId: cid }));
      eq(r.code, 'WRITE_FAILED'); eq(r.maySend, true);
    }
    eq(f.calls.insert, 0, '키가 없으면 삽입을 시도하지 않는다');
  });

  test('★ 실패 ⑤ 어떤 입력에서도 maySend가 거짓이 되지 않는다', async () => {
    const cases = [
      fakeStore({ insertError: { code: '23503' } }),
      fakeStore({ insertError: { code: 'PGRST301' } }),
      fakeStore({ throwOn: 'insert' }),
      fakeStore(),
    ];
    for (const f of cases) {
      const r = await recordExitIntent(f.store, intent());
      eq(r.maySend, true, `maySend가 거짓이 됐다 (${r.code})`);
    }
    eq((await recordExitIntent(null as any, intent())).maySend, true);
  });

  // ── ③ 중복 워커 · 재시작 ──

  test('★ 중복 ① 같은 멱등 키의 둘째 기록은 실패가 아니다', async () => {
    const f = fakeStore();
    const a = await recordExitIntent(f.store, intent());
    const b = await recordExitIntent(f.store, intent());
    eq(a.code, 'RECORDED');
    eq(b.code, 'ALREADY_EXISTS',
      '재시작·중복 워커의 정상 경로다 — 실패로 적으면 둘째 워커가 재시도한다');
    eq(b.durable, true, '기록은 남아 있다');
    eq(b.maySend, true);
    eq(f.rows.length, 1, '행이 두 개가 되지 않는다');
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

  // ── ⑥ 정본이 순수한가 ──

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

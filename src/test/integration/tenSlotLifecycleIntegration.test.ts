// src/test/integration/tenSlotLifecycleIntegration.test.ts
//
// **전송 뒤의 슬롯 수명주기 — 오프라인.** (#537)
//
// 여기서 증명하는 것
// ──────────────────
// "우리가 **어떤 사건을, 어떤 증거로, 어떤 순서로** 적는가."
//
// 여기서 증명하지 않는 것
// ───────────────────────
// 098의 전이표가 그 사건을 받아 상태를 어떻게 바꾸는가. **그건 SQL의
// 몫이고 실제 PostgreSQL 시험에서 증명된다**(`scripts/ten-slot-pg.test.mjs`).
// 그래서 이 파일의 가짜 DB는 전이표를 **흉내내지 않는다** — 흉내내면
// 같은 판단이 두 곳에 생기고, 둘이 갈리면 여기서는 초록인데 운영에서는
// 안 되는 상태가 된다.
//
// 가짜 DB는 사건을 **받아 적기만** 하고, 시험이 정한 코드·상태를 돌려준다.
import { test, eq, assert } from '../harness';
import { FakeDb } from './venueHarness';
import {
  slotEventForExec, slotEventForCloseRequest, slotEventForCloseConfirm,
  applySlotEvent, eventResultOf, EVENT_APPLIED,
} from '../../lib/engine/tenSlotLifecycle';

const CAMPAIGN = 'camp-life-1';
const COID = 'TS-COID-LIFE';
const OWNER = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';

const args = (over: Record<string, any> = {}) => ({
  campaignId: CAMPAIGN, expectedVersion: 1, slotIndex: 0,
  eventId: 'ev-1', userId: OWNER, connectionId: CONN, clientOrderId: COID,
  ...over,
});

/** 사건을 받아 적고, 시험이 정한 응답을 돌려주는 가짜 DB */
const eventDb = (reply: any = { data: [{ code: EVENT_APPLIED, slot_status: 'OPEN', campaign_version: 2 }] }) =>
  new FakeDb({ rpc: { ten_slot_apply_event: reply } });

export async function runTenSlotLifecycleTests() {
  console.log('[10슬롯 수명주기 — 전송 뒤 (오프라인)]');

  // ══════════ ① 접수 증거는 거래소 주문 번호다 ══════════
  for (const status of ['ACKED', 'FILLED', 'RECONCILED']) {
    test(`★★ ${status} + 주문 번호 → ACK / VENUE_ORDER`, () => {
      const v: any = slotEventForExec({ status, exchangeOrderId: '7001', filledQty: 0.01, avgPrice: 100000 });
      eq(v.kind, 'ACK');
      eq(v.evidence, 'VENUE_ORDER');
      eq(v.exchangeOrderId, '7001');
      // 체결 수량은 **칸으로** 따라간다. 상태 이름으로 가지 않는다.
      eq(v.filledQty, 0.01);
      eq(v.avgPrice, 100000);
    });

    test(`★★ ${status}인데 주문 번호가 없으면 접수로 적지 않는다`, () => {
      const v: any = slotEventForExec({ status, filledQty: 0.01 });
      eq(v.kind, 'UNKNOWN_RESPONSE', '번호도 없는데 접수로 적었다');
      eq(v.evidence, 'NONE');
    });
  }

  // ══════════ ② 확정되지 않은 것은 모른다고 적는다 ══════════
  for (const status of ['SENT', 'UNKNOWN', 'INTENT']) {
    test(`${status} → UNKNOWN_RESPONSE`, () => {
      const v: any = slotEventForExec({ status, exchangeOrderId: '7001' });
      eq(v.kind, 'UNKNOWN_RESPONSE');
      eq(v.evidence, 'NONE');
    });
  }

  // ══════════ ③ **보내지 않은 것이 확인된 경우 적을 사건이 없다** ══════════
  //
  // 098의 사건은 다섯 가지뿐이고 "안 나갔다"가 없다. `UNKNOWN_RESPONSE`로
  // 적으면 장부가 거짓이 되고(모르는 게 아니라 아는 것이다),
  // `UNKNOWN`에서 `FREE`로 돌아가는 길도 098에 없다 — 슬롯이 영원히 묶인다.
  //
  // 그래서 **아무것도 적지 않고 사람에게 넘긴다.** 사건 종류를 늘리는
  // 것은 마이그레이션이고 사람 승인 사항이다.
  for (const status of ['FAILED', 'REJECTED']) {
    test(`★★ ${status}는 모른다로 적지 않고 사람에게 넘긴다`, () => {
      const v: any = slotEventForExec({ status });
      eq(v.kind, null, '보내지 않은 것을 사건으로 적었다');
      eq(v.needsHuman, true);
      assert(String(v.reason).includes('098'), '왜 적을 수 없는지 적지 않았다');
    });
  }

  test('처음 보는 상태도 사건으로 적지 않는다', () => {
    const v: any = slotEventForExec({ status: 'WAT' });
    eq(v.kind, null);
    eq(v.needsHuman, true);
  });

  test('상태를 못 읽으면 사건으로 적지 않는다', () => {
    eq((slotEventForExec({}) as any).kind, null);
    eq((slotEventForExec(null) as any).kind, null);
  });

  // ══════════ ④ 닫기: 의도와 확인을 **따로** 적는다 ══════════
  test('닫겠다는 의도는 증거가 필요하지 않다', () => {
    const v = slotEventForCloseRequest();
    eq(v.kind, 'CLOSE_REQUEST');
    eq(v.evidence, 'NONE');
  });

  test('★★ 포지션을 못 읽었으면 닫혔다고 적지 않는다', () => {
    const v: any = slotEventForCloseConfirm({ ok: false, remainingQty: null });
    eq(v.kind, 'UNKNOWN_RESPONSE');
    eq(v.evidence, 'NONE');
  });

  test('★★ 조회가 실패했는데 수량 칸이 0이어도 닫힘으로 적지 않는다', () => {
    // **이 경우가 위험하다.** 조회가 실패하면 수량 칸은 아무 값일 수 있고,
    // 거기 0이 들어 있으면 "닫혔다"로 읽힌다. 조회 성공 여부를 먼저 보지
    // 않으면 그 길이 열린다 — 변이로 확인했다(관문을 떼면 CLOSED가 된다).
    const v: any = slotEventForCloseConfirm({ ok: false, remainingQty: 0 });
    eq(v.kind, 'UNKNOWN_RESPONSE', '못 읽은 조회의 0을 닫힘으로 적었다');
    eq(v.evidence, 'NONE');
  });

  test('★★ 조회는 됐지만 수량을 못 읽으면 0으로 적지 않는다', () => {
    const v: any = slotEventForCloseConfirm({ ok: true, remainingQty: null });
    eq(v.kind, 'UNKNOWN_RESPONSE', '못 읽은 수량을 0으로 바꿔 닫힘으로 적었다');
  });

  test('★★ 남아 있으면 닫힘으로 적지 않는다', () => {
    const v: any = slotEventForCloseConfirm({ ok: true, remainingQty: 0.004, openEntryOrders: 0 });
    eq(v.kind, null, '남아 있는데 닫힘으로 적었다');
    eq(v.needsHuman, false);
  });

  test('★★ 포지션 0 **그리고** 진입 주문 0을 확인했을 때만 CLOSED / VENUE_POSITION', () => {
    const v: any = slotEventForCloseConfirm({ ok: true, remainingQty: 0, openEntryOrders: 0 });
    eq(v.kind, 'CLOSED');
    eq(v.evidence, 'VENUE_POSITION');
  });

  // ══════════ ④-a 수량을 **숫자로** 받아들일 수 없으면 닫힘이 아니다 ══════════
  //
  // 처음 쓴 조건은 `left == null` · `left > 0` · 그 밖에는 CLOSED였다.
  // 그러면 `'invalid' > 0`이 거짓이 되어 **닫힘으로 떨어진다.** 조건을
  // 그대로 떼어 돌려 확인한 모양:
  //
  //   -1 · NaN · '0' · 'invalid'  → 전부 CLOSED
  //
  // 변환은 여기서 하지 않는다. 문자열이 왔다는 것은 거래소 어댑터가
  // 파싱하지 않았다는 뜻이고, 그 파싱을 추측으로 대신하면 정본이
  // 두 곳이 된다.
  for (const [label, q] of [
    ['음수', -1], ['NaN', Number.NaN], ['무한', Number.POSITIVE_INFINITY],
    ["문자열 '0'", '0' as any], ["문자열 'invalid'", 'invalid' as any],
    ['참', true as any], ['객체', {} as any],
  ] as Array<[string, number]>) {
    test(`★★ 남은 수량이 ${label}이면 닫힘으로 적지 않는다`, () => {
      const v: any = slotEventForCloseConfirm({ ok: true, remainingQty: q, openEntryOrders: 0 });
      eq(v.kind, 'UNKNOWN_RESPONSE', `${label}을 0으로 읽어 닫힘으로 적었다`);
      eq(v.evidence, 'NONE');
    });
  }

  // ══════════ ④-b 포지션 0만으로는 닫힘 증거가 아니다 ══════════
  //
  // 미체결 진입 주문이 살아 있으면 지금 0이어도 **나중에 체결된다.**
  // 098은 `CLOSED/VENUE_POSITION`을 받으면 `CLOSING→SPENT`로 넘기므로,
  // 그 슬롯은 닫힌 것으로 적힌 뒤에 포지션이 생긴다.
  test('★★ 살아 있는 진입 주문을 세지 못했으면 닫힘으로 적지 않는다', () => {
    const v: any = slotEventForCloseConfirm({ ok: true, remainingQty: 0 });
    eq(v.kind, 'UNKNOWN_RESPONSE', '진입 주문을 세지 않고 닫힘으로 적었다');
  });

  test('★★ 진입 주문이 살아 있으면 포지션 0이어도 닫힘으로 적지 않는다', () => {
    const v: any = slotEventForCloseConfirm({ ok: true, remainingQty: 0, openEntryOrders: 1 });
    eq(v.kind, null, '나중에 체결될 수 있는데 닫힘으로 적었다');
    eq(v.needsHuman, false);
  });

  for (const [label, n] of [
    ['NaN', Number.NaN], ['음수', -1], ["문자열 '0'", '0' as any],
  ] as Array<[string, number]>) {
    test(`★ 진입 주문 수가 ${label}이면 닫힘으로 적지 않는다`, () => {
      const v: any = slotEventForCloseConfirm({ ok: true, remainingQty: 0, openEntryOrders: n });
      eq(v.kind, 'UNKNOWN_RESPONSE', `${label}을 0으로 읽었다`);
    });
  }

  // ══════════ ⑤ 응답 해석: 커밋만 ok다 ══════════
  test('EVENT_APPLIED와 멱등 재적용은 커밋이다', () => {
    eq(eventResultOf([{ code: 'EVENT_APPLIED', slot_status: 'OPEN', campaign_version: 2 }]).ok, true);
    eq(eventResultOf([{ code: 'EVENT_ALREADY_APPLIED', slot_status: 'OPEN', campaign_version: 2 }]).ok, true);
  });

  // ══════════ ⑤-a **잘린 성공 응답**을 커밋으로 읽지 않는다 ══════════
  //
  // 098은 코드·상태·버전 셋을 돌려준다. 코드만 있고 상태나 버전이 없으면
  // 응답을 끝까지 읽지 못한 것이다. 그걸 커밋으로 적으면 다음 단계가
  // `null` 버전을 들고 CAS에 간다.
  for (const [label, row] of [
    ['상태 없음', { code: 'EVENT_APPLIED', campaign_version: 2 }],
    ['버전 없음', { code: 'EVENT_APPLIED', slot_status: 'OPEN' }],
    ['둘 다 없음', { code: 'EVENT_APPLIED' }],
    ['상태가 빈 문자열', { code: 'EVENT_APPLIED', slot_status: '  ', campaign_version: 2 }],
    ['버전이 소수', { code: 'EVENT_APPLIED', slot_status: 'OPEN', campaign_version: 1.5 }],
    ['버전이 음수', { code: 'EVENT_APPLIED', slot_status: 'OPEN', campaign_version: -1 }],
    ['버전이 NaN', { code: 'EVENT_APPLIED', slot_status: 'OPEN', campaign_version: Number.NaN }],
    ['버전이 안전 정수 초과', { code: 'EVENT_APPLIED', slot_status: 'OPEN', campaign_version: 9007199254740993 }],
    ['버전이 숫자 아닌 문자열', { code: 'EVENT_APPLIED', slot_status: 'OPEN', campaign_version: 'x' }],
  ] as Array<[string, any]>) {
    test(`★★ 성공 코드인데 ${label}이면 커밋으로 적지 않는다`, () => {
      const r = eventResultOf([row]);
      eq(r.ok, false, `잘린 성공 응답(${label})을 커밋으로 읽었다`);
      assert(typeof r.reason === 'string' && r.reason.length > 0, '왜 아닌지 적지 않았다');
    });
  }

  test('버전이 문자열 숫자로 와도 받는다 — PostgREST의 BIGINT 직렬화', () => {
    // BIGINT는 직렬화에 따라 문자열로 올 수 있다. 자릿수가 정수 범위
    // 안이면 받고, 그 밖이면 위 시험들이 막는다.
    const r = eventResultOf([{ code: 'EVENT_APPLIED', slot_status: 'OPEN', campaign_version: '7' }]);
    eq(r.ok, true);
    eq(r.campaignVersion, 7);
  });

  for (const code of ['EVENT_OUT_OF_ORDER', 'EVENT_CONFLICT', 'EVIDENCE_MISSING',
    'ORDER_ID_MISMATCH', 'STALE_VERSION', 'SLOT_MISSING', 'CAMPAIGN_MISSING',
    'CALLER_UNKNOWN', 'CALLER_NOT_OWNER', 'CLAIM_IDENTITY_MISMATCH']) {
    test(`★ ${code}는 커밋이 아니다`, () => {
      const r = eventResultOf([{ code, slot_status: null, campaign_version: null }]);
      eq(r.ok, false, `${code}를 커밋으로 읽었다`);
      eq(r.code, code);
      assert(typeof r.reason === 'string' && r.reason.length > 0, '왜 아닌지 적지 않았다');
    });
  }

  for (const [label, data, err] of [
    ['오류', null, { message: 'boom' }],
    ['빈 응답', [], null],
    ['null', null, null],
    ['두 줄', [{ code: 'EVENT_APPLIED' }, { code: 'EVENT_APPLIED' }], null],
    ['코드 없음', [{ slot_status: 'OPEN' }], null],
  ] as Array<[string, any, any]>) {
    test(`★★ 응답을 못 읽으면(${label}) 커밋으로 적지 않는다`, () => {
      const r = eventResultOf(data, err);
      eq(r.ok, false);
      eq(r.code, null);
    });
  }

  // ══════════ ⑥ 고른 사건을 **그대로** 넘긴다 ══════════
  {
    const db = eventDb();
    const plan: any = slotEventForExec({ status: 'ACKED', exchangeOrderId: '7001', filledQty: 0.01, avgPrice: 100000 });
    const r = await applySlotEvent(db as any, plan, args());

    test('★★ 사건 종류·증거를 올려 적지 않고 그대로 넘긴다', () => {
      eq(db.rpcCalls.length, 1);
      eq(db.rpcCalls[0].name, 'ten_slot_apply_event');
      const a = db.rpcCalls[0].args;
      eq(a.p_kind, 'ACK');
      eq(a.p_evidence, 'VENUE_ORDER');
      eq(a.p_exchange_order_id, '7001');
      eq(a.p_filled_qty, 0.01);
      eq(a.p_avg_price, 100000);
      // 098이 요구하는 정체성과 예약 번호를 들고 간다.
      eq(a.p_caller_user_id, OWNER);
      eq(a.p_caller_connection_id, CONN);
      eq(a.p_client_order_id, COID);
      eq(a.p_expected_version, 1);
      eq(a.p_slot_index, 0);
      eq(a.p_event_id, 'ev-1');
      eq(r.ok, true);
      eq(r.slotStatus, 'OPEN');
      eq(r.campaignVersion, 2);
    });
  }

  {
    const db = eventDb({ error: { message: 'boom' } });
    const plan: any = slotEventForExec({ status: 'ACKED', exchangeOrderId: '7001' });
    const r = await applySlotEvent(db as any, plan, args());
    test('★★ 사건 기록이 실패하면 커밋으로 적지 않는다', () => {
      eq(r.ok, false);
      eq(r.code, null);
    });
  }

  {
    const db = eventDb({ throws: '연결이 끊겼습니다' });
    const plan: any = slotEventForExec({ status: 'ACKED', exchangeOrderId: '7001' });
    const r = await applySlotEvent(db as any, plan, args());
    test('★★ 호출이 던져도 커밋으로 적지 않는다', () => {
      eq(r.ok, false);
      eq(r.code, null);
    });
  }

  // ══════════ ⑦ 한 슬롯의 순서: ACK → 부분체결 → 닫기 요청 → 닫힘 확인 ══════════
  //
  // 가짜 DB는 전이표를 흉내내지 않는다. 시험이 정한 상태를 돌려주고,
  // 여기서 보는 것은 **우리가 보낸 사건의 순서와 증거**다.
  {
    const seq: Array<{ kind: string; evidence: string }> = [];
    const statuses = ['OPEN', 'OPEN', 'CLOSING', 'SPENT'];
    const db = new FakeDb({
      rpc: {
        ten_slot_apply_event: (a: any) => {
          seq.push({ kind: a.p_kind, evidence: a.p_evidence });
          return { data: [{ code: EVENT_APPLIED, slot_status: statuses[seq.length - 1] ?? null,
            campaign_version: 1 + seq.length }] };
        },
      },
    });

    // 전송 결과(접수) → ACK
    const ack: any = slotEventForExec({ status: 'ACKED', exchangeOrderId: '7001', filledQty: 0 });
    const r1 = await applySlotEvent(db as any, ack, args({ eventId: 'ev-ack' }));
    // 부분 체결 기록 — 상태는 그대로다
    const partial: any = { kind: 'PARTIAL_FILL', evidence: 'VENUE_ORDER',
      reason: '부분 체결', exchangeOrderId: '7001', filledQty: 0.004, avgPrice: 100000 };
    const r2 = await applySlotEvent(db as any, partial, args({ eventId: 'ev-part', expectedVersion: 2 }));
    // 닫겠다 → 포지션 0 확인 → 닫힘
    const r3 = await applySlotEvent(db as any, slotEventForCloseRequest(), args({ eventId: 'ev-close', expectedVersion: 3 }));
    const closed: any = slotEventForCloseConfirm({ ok: true, remainingQty: 0, openEntryOrders: 0 });
    const r4 = await applySlotEvent(db as any, closed, args({ eventId: 'ev-closed', expectedVersion: 4 }));

    test('★★ 한 슬롯이 ACK → 부분체결 → 닫기요청 → 닫힘확인 순서로 적힌다', () => {
      eq(seq.length, 4, `사건이 ${seq.length}건 적혔다`);
      eq(seq[0].kind, 'ACK'); eq(seq[0].evidence, 'VENUE_ORDER');
      eq(seq[1].kind, 'PARTIAL_FILL'); eq(seq[1].evidence, 'VENUE_ORDER');
      eq(seq[2].kind, 'CLOSE_REQUEST'); eq(seq[2].evidence, 'NONE');
      eq(seq[3].kind, 'CLOSED'); eq(seq[3].evidence, 'VENUE_POSITION');
      // 네 사건 전부 커밋으로 읽혔다.
      for (const [i, r] of [r1, r2, r3, r4].entries()) {
        eq(r.ok, true, `${i + 1}번째 사건이 커밋되지 않았다`);
      }
      // **사건 id가 전부 다르다.** 같으면 멱등으로 묻혀 순서가 사라진다.
      eq(new Set(db.rpcCalls.map(c => c.args.p_event_id)).size, 4, '사건 id가 겹쳤다');
    });

    test('★★ `OPEN`을 체결·보호 완료로 적지 않는다', () => {
      // 098에는 FILL도 SL_ATTACHED도 없다. `OPEN`은 "주문이 접수된 것을
      // 조회로 확인했다"는 뜻뿐이다. 이 시험은 그 말이 코드에 그대로
      // 남아 있는지 본다 — 사건 종류가 다섯 가지를 넘지 않는지.
      const kinds = new Set(db.rpcCalls.map(c => c.args.p_kind));
      for (const k of kinds) {
        assert(['ACK', 'PARTIAL_FILL', 'CLOSE_REQUEST', 'CLOSED', 'UNKNOWN_RESPONSE'].includes(k),
          `098에 없는 사건을 적었다: ${k}`);
      }
    });
  }
}

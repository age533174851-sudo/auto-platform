// src/lib/engine/paperOrderTelemetry.test.ts
//
// **적어도 되는 것만 적는가.** 이 파일이 지키는 것은 두 가지다 —
// 실패 단계를 셀 수 있는가, 그리고 **주문 내용이 새지 않는가.**
import { test, eq, assert } from '../../test/harness';
import {
  paperOrderTelemetry, paperOrderAuditEvent, openFailureCode, planRejectionCode, resultOf,
  type PaperOrderCode,
} from './paperOrderTelemetry';

/** 기록에 절대 들어가면 안 되는 것들 */
const FORBIDDEN_KEYS = [
  'userId', 'user_id', 'email', 'symbol', 'quantity', 'qty', 'notional', 'price',
  'fillPrice', 'margin', 'leverage', 'positionId', 'position_id', 'orderId',
  'body', 'query', 'headers', 'authorization', 'cookie', 'jwt', 'token', 'ip',
  'stack', 'message', 'reason',
];

export function runPaperOrderTelemetryTests() {
  console.log('\n🧾 모의 주문 실패 계수 (내용은 적지 않는다)');

  // ══ 새지 않는가 ══
  test('기록에는 code·http·route 세 칸뿐이다', () => {
    const t = paperOrderTelemetry('AUTH_REQUIRED', 401);
    eq(Object.keys(t).sort().join(','), 'code,http,route');
  });

  test('감사 한 줄에 금지된 칸이 하나도 없다', () => {
    const ev = paperOrderAuditEvent(paperOrderTelemetry('OPEN_RPC_ERROR', 500));
    const flat = JSON.stringify(ev);
    for (const k of FORBIDDEN_KEYS) {
      // userId는 칸 자체는 있지만 **값이 null이어야 한다** (아래에서 따로 본다)
      if (k === 'userId') continue;
      assert(!flat.includes(`"${k}"`), `금지된 칸이 들어갔다: ${k}`);
    }
  });

  test('user_id는 언제나 null이다 — 누가 막혔는지는 묻지 않는다', () => {
    for (const c of ['OPENED', 'AUTH_REQUIRED', 'OPEN_NO_ACCOUNT'] as PaperOrderCode[]) {
      eq(paperOrderAuditEvent(paperOrderTelemetry(c, 200)).userId, null, c);
    }
  });

  test('detail은 code와 http뿐이다', () => {
    const d = paperOrderAuditEvent(paperOrderTelemetry('DAILY_LIMIT', 429)).detail;
    eq(Object.keys(d).sort().join(','), 'code,http');
    eq(d.code, 'DAILY_LIMIT');
    eq(d.http, 429);
  });

  test('http가 이상한 값이어도 숫자로 고정된다', () => {
    eq(paperOrderTelemetry('OPENED', NaN as any).http, 0);
    eq(paperOrderTelemetry('OPENED', '200' as any).http, 200);
    eq(paperOrderTelemetry('OPENED', 200.7).http, 200);
  });

  // ══ 실제 분기에서 뽑은 taxonomy ══
  test('진입 함수의 status 열거가 그대로 대응한다', () => {
    eq(openFailureCode('DUPLICATE'), 'DUPLICATE');
    eq(openFailureCode('NO_ACCOUNT'), 'OPEN_NO_ACCOUNT');
    eq(openFailureCode('INSUFFICIENT_MARGIN'), 'OPEN_INSUFFICIENT_MARGIN');
    eq(openFailureCode('CHALLENGE_NOT_RUNNING'), 'OPEN_CHALLENGE_NOT_RUNNING');
    eq(openFailureCode('ERROR'), 'OPEN_RPC_ERROR');
  });

  test('모르는 status는 추측하지 않고 OPEN_RPC_ERROR다', () => {
    eq(openFailureCode('WAT'), 'OPEN_RPC_ERROR');
    eq(openFailureCode(null), 'OPEN_RPC_ERROR');
    eq(openFailureCode(undefined), 'OPEN_RPC_ERROR');
  });

  test('계획 거부는 경로가 아는 사실로만 가른다 — 사유 문구를 보지 않는다', () => {
    eq(planRejectionCode({ markPrice: null, available: 100 }), 'PLAN_NO_MARK_PRICE');
    eq(planRejectionCode({ markPrice: 0, available: 100 }), 'PLAN_NO_MARK_PRICE');
    eq(planRejectionCode({ markPrice: 50000, available: null }), 'PLAN_BALANCE_UNKNOWN');
    eq(planRejectionCode({ markPrice: 50000, available: 100 }), 'PLAN_REJECTED');
  });

  test('시세를 못 읽은 것이 잔고를 못 읽은 것보다 먼저다', () => {
    eq(planRejectionCode({ markPrice: null, available: null }), 'PLAN_NO_MARK_PRICE');
  });

  // ══ 막은 것과 터진 것을 구분한다 ══
  test('일부러 막은 것을 실패로 적지 않는다', () => {
    for (const c of ['DAILY_LIMIT', 'DAILY_LIMIT_UNKNOWN', 'DUPLICATE',
      'OPEN_INSUFFICIENT_MARGIN', 'OPEN_CHALLENGE_NOT_RUNNING', 'OPEN_NO_ACCOUNT',
      'AUTH_REQUIRED', 'MISSING_PARAMS', 'UNSUPPORTED_MARKET', 'INVALID_JSON',
      'PLAN_REJECTED', 'PLAN_NO_MARK_PRICE', 'PLAN_BALANCE_UNKNOWN'] as PaperOrderCode[]) {
      eq(resultOf(c), 'blocked', c);
    }
  });

  test('터진 것은 failed다', () => {
    eq(resultOf('OPEN_RPC_ERROR'), 'failed');
    eq(resultOf('SUPABASE_NOT_CONFIGURED'), 'failed');
  });

  test('성공은 success다 — 분모가 있어야 실패율을 읽는다', () => {
    eq(resultOf('OPENED'), 'success');
    eq(paperOrderAuditEvent(paperOrderTelemetry('OPENED', 200)).result, 'success');
  });

  test('action·resource는 고정 문자열이다', () => {
    const ev = paperOrderAuditEvent(paperOrderTelemetry('OPENED', 200));
    eq(ev.action, 'PAPER_ORDER_RESULT');
    eq(ev.resource, 'paper_order');
  });
}

// src/test/integration/gateCloseIntegration.test.ts
//
// **Gate 포지션 종료가 "닫았다"를 거짓으로 적지 않는가.**
//
// 실제로 도는 것: `getPositionsGateFutures` · `closePositionGateFutures` ·
//   `closeAllPositionsGateFutures` → `gateReq`(서명 생성 · 질의 조립 ·
//   응답 파싱). 가짜는 `fetch` 한 겹뿐이다.
//
// 이 경로가 지켜야 하는 한 가지
// ─────────────────────────────
// **못 읽은 것을 "포지션 없음"으로 적지 않는다.** 그 거짓말의 끝은
// 하나뿐이다 — 사람이 "전부 정리됐다"를 읽고 손을 떼는데 포지션은
// 그대로 열려 있다.
//
// 상위 함수는 이미 그것을 막으려고 만들어져 있다:
//
//     try { positions = await getPositionsGateFutures(...) }
//     catch { return { success:false, remaining:null, ... } }
//
// 그런데 조회가 **던지지 않고 빈 배열을 돌려주면** 그 보호가 지나간다.
// `positions.length === 0` → `success: true, '포지션 전체 종료 완료'`.
// 주문은 한 건도 나가지 않았는데 전체 종료가 완료로 적힌다.

import { test, eq, assert } from '../harness';
import { FakeVenue } from './venueHarness';
// 정적 import — 러너가 이 사슬을 컴파일 대상에 넣어야 한다.
import {
  getPositionsGateFutures, closePositionGateFutures, closeAllPositionsGateFutures,
} from '../../lib/exchanges/gateFutures';

const POSITIONS = '/api/v4/futures/usdt/positions';
const ORDERS = '/api/v4/futures/usdt/orders';
const KEY = 'K'.repeat(32);
const SECRET = 'S'.repeat(64);
const C = 'BTC_USDT';

function pos(size: unknown, over: Record<string, unknown> = {}) {
  return {
    contract: C, size, entry_price: '100000', leverage: '10',
    unrealised_pnl: '0', liq_price: '90000', ...over,
  };
}

async function on<T>(v: FakeVenue, fn: () => Promise<T>): Promise<T> {
  const restore = v.install();
  try { return await fn(); } finally { restore(); }
}

/** 던졌는가 */
async function threwOn<T>(v: FakeVenue, fn: () => Promise<T>): Promise<boolean> {
  try { await on(v, fn); return false; } catch { return true; }
}

export async function runGateCloseTests() {
  console.log('[통합 — Gate 포지션 종료]');

  // ══════════ ① 정상 목록은 그대로 읽힌다 ══════════
  {
    const v = new FakeVenue().on(POSITIONS, { json: [pos('5'), pos('0', { contract: 'ETH_USDT' })] });
    const r: any = await on(v, () => getPositionsGateFutures(KEY, SECRET, true));

    test('★ ① 수량 0은 걸러내고 열린 것만 돌려준다', () => {
      eq(r.length, 1);
      eq(r[0].contract, C);
    });
  }

  // ══════════ ② 200인데 배열이 아니면 "포지션 없음"이 아니다 ══════════
  {
    const v = new FakeVenue().on(POSITIONS, { json: { label: 'OK', message: 'fine' } });
    const threw = await threwOn(v, () => getPositionsGateFutures(KEY, SECRET, true));

    test('★ ② 배열이 아닌 200 응답을 빈 목록으로 접지 않는다', () => {
      assert(threw, '빈 배열로 접으면 상위의 try/catch 보호가 그냥 지나간다');
    });
  }

  // ══════════ ③ 수량을 못 읽은 줄은 "평탄"이 아니다 ══════════
  //
  // `Number(null)`도 `Number('')`도 **0**이다. 그 0은 `size !== 0`
  // 필터에서 걸러져 **열린 포지션이 목록에서 사라진다.**
  for (const [label, bad] of [
    ['③ null', null], ['④ 빈 문자열', ''], ['⑤ 문자열 쓰레기', 'abc'],
  ] as Array<[string, any]>) {
    const v = new FakeVenue().on(POSITIONS, { json: [pos(bad)] });
    const threw = await threwOn(v, () => getPositionsGateFutures(KEY, SECRET, true));

    test(`★ ${label} 수량은 0이 아니라 "못 읽음"이다`, () => {
      assert(threw, '못 읽은 수량이 0으로 접히면 열린 포지션이 사라진다');
    });
  }

  // ══════════ ⑥ 전체 종료가 "완료"를 거짓으로 적지 않는다 ══════════
  //
  // 이 묶음의 핵심이다. 응답 하나가 읽히지 않았을 뿐인데 예전에는
  // `success: true · remaining: 0 · '포지션 전체 종료 완료'`가 나왔다.
  {
    const v = new FakeVenue()
      .on(POSITIONS, { json: { label: 'OK' } })
      .on(ORDERS, { json: { id: 1, status: 'finished' } }, 'POST');
    const r: any = await on(v, () => closeAllPositionsGateFutures(KEY, SECRET, true, 1));

    test('★ ⑥ 포지션을 못 읽으면 "전체 종료 완료"라고 하지 않는다', () => {
      eq(r.success, false, '주문 0건인데 전체 종료가 완료로 적혔다');
      eq(r.remaining, null, '못 읽은 잔여를 0으로 적으면 전부 닫힌 것이 된다');
      eq(v.orderSends().length, 0, '무엇을 닫는지 모르는 채로 주문이 나갔다');
    });
  }

  // ══════════ ⑦ 정말 비어 있으면 완료가 맞다 (⑥이 공허하지 않다) ══════════
  {
    const v = new FakeVenue().on(POSITIONS, { json: [] });
    const r: any = await on(v, () => closeAllPositionsGateFutures(KEY, SECRET, true, 1));

    test('★ ⑦ 빈 배열이면 전체 종료 완료가 맞다', () => {
      eq(r.success, true);
      eq(r.remaining, 0);
    });
  }

  // ══════════ ⑧ 개별 종료 — 못 읽은 것을 "이미 없음"으로 적지 않는다 ══════════
  //
  // `getPositionGateFutures`는 못 읽으면 **null**이다(문서화돼 있다).
  // 그런데 `Number(pos?.size ?? 0)`이 그 null을 0으로 바꿔
  // `success: true · '이미 포지션이 없습니다'`가 됐다.
  {
    const v = new FakeVenue()
      .on(`${POSITIONS}/${C}`, { status: 500, json: { label: 'SERVER_ERROR' } })
      .on(ORDERS, { json: { id: 1 } }, 'POST');
    const r: any = await on(v, () => closePositionGateFutures(KEY, SECRET, C, true));

    test('★ ⑧ 포지션을 못 읽으면 "이미 없습니다"가 아니다', () => {
      eq(r.success, false, '조회 실패가 "이미 닫혀 있다"로 적혔다');
      eq(v.orderSends().length, 0);
    });
  }

  // ══════════ ⑨ 수량을 못 읽어도 같다 ══════════
  {
    const v = new FakeVenue()
      .on(`${POSITIONS}/${C}`, { json: pos(null) })
      .on(ORDERS, { json: { id: 1 } }, 'POST');
    const r: any = await on(v, () => closePositionGateFutures(KEY, SECRET, C, true));

    test('★ ⑨ 수량을 못 읽은 포지션을 "이미 없음"으로 적지 않는다', () => {
      eq(r.success, false);
      eq(v.orderSends().length, 0);
    });
  }

  // ══════════ ⑩ 진짜 0이면 "이미 없음"이 맞다 (⑧⑨가 공허하지 않다) ══════════
  {
    const v = new FakeVenue().on(`${POSITIONS}/${C}`, { json: pos('0') });
    const r: any = await on(v, () => closePositionGateFutures(KEY, SECRET, C, true));

    test('★ ⑩ 수량이 진짜 0이면 이미 없는 것이 맞다', () => {
      eq(r.success, true);
      eq(v.orderSends().length, 0);
    });
  }

  // ══════════ ⑪ IOC가 하나도 안 붙었으면 "전량 종료"가 아니다 ══════════
  //
  // `GateOrderResult.left`의 주석이 그대로 적고 있다:
  // "미체결 수량. ioc 주문이 하나도 못 붙으면 size와 같다."
  // 그 칸을 읽지 않고 HTTP 2xx만으로 '전량 종료'라고 적으면,
  // 포지션이 그대로인데 닫혔다고 기록된다.
  //
  // **다시 보내지 않는다.** 사실만 정확히 적는다.
  {
    const v = new FakeVenue()
      .on(`${POSITIONS}/${C}`, { json: pos('5') })
      .on(ORDERS, { json: { id: 7, contract: C, size: -5, left: -5, status: 'finished',
        finish_as: 'ioc' } }, 'POST');
    const r: any = await on(v, () => closePositionGateFutures(KEY, SECRET, C, true));

    test('★ ⑪ 한 계약도 못 붙은 IOC를 "전량 종료"로 적지 않는다', () => {
      eq(r.success, false, 'IOC가 전부 취소됐는데 종료 완료로 적혔다');
      eq(v.orderSends().length, 1, '다시 보내지 않는다');
    });
  }

  // ══════════ ⑫ 전량 체결되면 종료가 맞다 (⑪이 공허하지 않다) ══════════
  {
    const v = new FakeVenue()
      .on(`${POSITIONS}/${C}`, { json: pos('5') })
      .on(ORDERS, { json: { id: 8, contract: C, size: -5, left: 0, status: 'finished',
        finish_as: 'filled' } }, 'POST');
    const r: any = await on(v, () => closePositionGateFutures(KEY, SECRET, C, true));

    test('★ ⑫ 잔량 0으로 체결되면 전량 종료가 맞다', () => {
      eq(r.success, true, String(r.message));
      eq(v.orderSends().length, 1);
    });
  }
}

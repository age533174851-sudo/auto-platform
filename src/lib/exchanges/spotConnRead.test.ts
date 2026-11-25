// src/lib/exchanges/spotConnRead.test.ts
//
// **현물 주문 경로에서 연결 조회 실패를 "연결이 없다"로 답하지 않는다.**
//
// 조회가 실패하면 `data`가 null이다. 그 null을 "행이 없음"과 같이 읽으면
// 사용자는 **「거래소 연결을 찾을 수 없거나 본인의 연결이 아닙니다」**를
// 받는다 — 연결은 있고 DB를 못 읽었을 뿐인데.
//
// 주문이 안 나가는 쪽이라 안전 구멍은 아니다. 대신 **거짓말**이고,
// 그 말을 믿은 사용자는 API 키를 다시 발급하거나 연결을 다시 만든다.
// 이 저장소가 #718·#719·#720·#742에서 네 번 고친 바로 그 모양이다.

import { test, eq, assert } from '../../test/harness';
import { placeSpotOrder } from './spotOrderExecutor';

/** `exchange_connections` 조회 한 번만 답하는 최소 가짜 */
function sbWithConnRead(res: { data: any; error: any }) {
  const q: any = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => res,
  };
  return { from: () => q };
}

const ARGS = {
  userId: 'u1', connectionId: 'c1',
  symbol: 'BTCUSDT', side: 'BUY' as const, type: 'MARKET' as const,
  quantity: 0.001,
};

export function runSpotConnReadTests() {
  console.log('[현물 주문 — 연결 조회 실패를 "없음"으로 적지 않는다]');

  test('★ 조회가 실패하면 "찾을 수 없다"로 답하지 않는다', async () => {
    const sb = sbWithConnRead({ data: null, error: { message: 'timeout' } });
    const r = await placeSpotOrder(sb, ARGS);
    eq(r.ok, false);
    assert(r.code !== 'connection_not_found',
      `조회 실패를 연결 없음으로 적었다: code=${r.code}`);
    assert(!/찾을 수 없|본인의 연결이 아닙니다/.test(r.message),
      `읽지 못한 것을 "없다"고 말했다: ${r.message}`);
  });

  test('★ 조회 실패의 사유가 "읽지 못했다"로 남는다', async () => {
    const sb = sbWithConnRead({ data: null, error: { message: 'timeout' } });
    const r = await placeSpotOrder(sb, ARGS);
    assert(/읽지 못/.test(r.message), `사유가 읽기 실패를 말하지 않는다: ${r.message}`);
  });

  test('행이 정말 없으면 그대로 "찾을 수 없다"다', async () => {
    const sb = sbWithConnRead({ data: null, error: null });
    const r = await placeSpotOrder(sb, ARGS);
    eq(r.ok, false);
    eq(r.code, 'connection_not_found');
  });

  // 라우트가 그 코드를 503으로 옮기는지. 실행부만 고치면 사용자는 여전히
  // 400("당신 요청이 틀렸다")을 받는다 — 배선이 빠지면 반쪽이다.
  test('★ 라우트가 connection_unreadable을 503으로 옮긴다', () => {
    const src = require('node:fs').readFileSync(
      'src/app/api/binance/spot/order/route.ts', 'utf8') as string;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, (m: string) => m.replace(/[^\n]/g, ' '))
      .split('\n').map((l: string) => l.replace(/\/\/.*$/, '')).join('\n');
    assert(/connection_unreadable[\s\S]{0,40}503/.test(code),
      '라우트가 connection_unreadable을 503으로 옮기지 않는다');
  });

  test('주문은 어느 쪽에서도 나가지 않는다 (BLOCKED)', async () => {
    for (const res of [{ data: null, error: { message: 'x' } }, { data: null, error: null }]) {
      const r = await placeSpotOrder(sbWithConnRead(res), ARGS);
      eq(r.status, 'BLOCKED', `주문이 막히지 않았다: ${r.status}`);
    }
  });
}

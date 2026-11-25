// src/lib/strategies/watchCloseRetry.test.ts
//
// **감시를 닫지 못한 것을 닫았다고 넘기지 않는다.**
//
// `/api/watch/tick`의 `fire()`는 주문을 보낸 뒤 `closeWatch`로 감시를
// 끝낸다. 그 자리 주석이 이렇게 적혀 있다:
//
//     // 실패해도 되살리지 않는다. 되살리면 다음 주기에 또 시도하고,
//     // 그 사이 가격이 더 내려가 훨씬 나쁜 값에 팔린다.
//
// 그런데 `closeWatch`는 UPDATE의 `error`를 버리고 `void`를 돌려줬다.
// 쓰기가 실패하면 행은 `status: 'ACTIVE'`로 **남는다** — 주석이 막으려던
// 바로 그 상태다. `listActiveWatches`는 `status='ACTIVE'`를 고르므로
// 다음 주기에 **같은 감시가 다시 발동한다.**
//
// 아래쪽에서 막아 주지도 않는다. `clientOrderId`가
// `SP${Date.now()...}${symbol}`로 **매 호출마다 다르다** — 바이낸스
// 멱등성이 걸리지 않고, Gate는 그 번호로만 중복을 찾는다.
// 즉 **실제 시장가 주문이 한 번 더 나갈 수 있다.**

import { test, eq, assert } from '../../test/harness';
import { closeWatch, closeWatchWithRetry } from './watchStore';

/** `update().eq()` 결과를 차례로 돌려주는 최소 가짜 */
function sbUpdating(results: Array<{ error: any }>) {
  let i = 0;
  const q: any = {
    update: () => q,
    eq: () => Promise.resolve(results[Math.min(i++, results.length - 1)]),
  };
  return { sb: { from: () => q }, tries: () => i };
}

export function runWatchCloseTests() {
  console.log('[감시 닫기 — 못 닫은 것을 닫았다고 적지 않는다]');

  test('★ 쓰기가 실패하면 ok:false와 사유를 돌려준다', async () => {
    const { sb } = sbUpdating([{ error: { message: 'timeout' } }]);
    const r = await closeWatch(sb, 'w1', 'TRIGGERED', '발동');
    assert(r != null, 'closeWatch가 아무것도 돌려주지 않는다 — 실패를 알 수 없다');
    eq(r.ok, false);
    assert(/timeout/.test(String((r as any).reason ?? '')), `사유가 비었다: ${JSON.stringify(r)}`);
  });

  test('쓰기가 성공하면 ok:true다', async () => {
    const { sb } = sbUpdating([{ error: null }]);
    const r = await closeWatch(sb, 'w1', 'TRIGGERED', '발동');
    eq(r?.ok, true);
  });

  test('★ 한 번 실패하면 다시 시도한다 (두 번째에 성공)', async () => {
    const { sb, tries } = sbUpdating([{ error: { message: 'timeout' } }, { error: null }]);
    const r = await closeWatchWithRetry(sb, 'w1', 'TRIGGERED', '발동');
    eq(r.ok, true);
    eq(tries(), 2, `재시도하지 않았다 (시도 ${tries()}회)`);
  });

  test('★ 두 번 다 실패하면 ok:false로 남긴다 — 세 번은 안 한다', async () => {
    const { sb, tries } = sbUpdating([{ error: { message: 'down' } }]);
    const r = await closeWatchWithRetry(sb, 'w1', 'FAILED', '주문 실패');
    eq(r.ok, false);
    eq(tries(), 2, `시도 횟수가 2가 아니다 (${tries()}회)`);
    assert(/down/.test(String((r as any).reason ?? '')), '사유가 없다');
  });

  test('예외가 나도 ok:false다 (throw하지 않는다)', async () => {
    const sb: any = { from: () => ({ update: () => ({ eq: () => { throw new Error('boom'); } }) }) };
    const r = await closeWatchWithRetry(sb, 'w1', 'CANCELED', '취소');
    eq(r.ok, false);
    assert(/boom/.test(String((r as any).reason ?? '')), '예외 사유가 없다');
  });

  // 배선 — 실행부만 고치면 tick은 여전히 모른 채 넘어간다.
  test('★ tick이 닫기 실패를 결과에 적는다', () => {
    const src = require('node:fs').readFileSync(
      'src/app/api/watch/tick/route.ts', 'utf8') as string;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, (m: string) => m.replace(/[^\n]/g, ' '))
      .split('\n').map((l: string) => l.replace(/\/\/.*$/, '')).join('\n');
    assert(/closeWatchWithRetry/.test(code), 'tick이 재시도 버전을 쓰지 않는다');
    assert(/WATCH_NOT_CLOSED/.test(code), 'tick이 닫기 실패를 결과에 적지 않는다');
  });
}

// src/test/netStub.ts
//
// **네트워크를 가로채는 테스트를 안전하게 쓰는 유일한 길.**
//
// 하네스는 async 테스트를 **동시에** 시작한다 (`test()`가 `fn()`을 즉시
// 부르고 프라미스만 모아 뒀다가 나중에 기다린다). 그래서 전역 `fetch`를
// 갈아 끼우는 테스트를 그냥 쓰면 서로의 스텁을 덮어쓴다 — 복원할 때
// 남의 스텁을 원본으로 착각해서 되돌려 놓기도 한다.
//
// 2026-11-14에 이걸 또 밟았다. `binanceTpSlFallback.test.ts`를 처음 쓸 때
// 전역 fetch를 갈아 끼웠더니 **같이 돌던 24개가 같이 붉어졌다.**
// `futuresExec.test.ts`는 이미 같은 함정을 밟고 파일 안에 해법을 두고
// 있었다 — 그런데 그 파일 안에만 있었다.
//
// 같은 판단이 두 곳에 있으면 언젠가 갈린다. 그래서 꺼내서 한 곳에 둔다.
//
// 두 가지로 막는다
// ────────────────
//   1. `netTest`가 네트워크 테스트를 **한 줄로 세운다.** 체인은 이 모듈에
//      있으므로 **파일을 넘어서도** 겹치지 않는다.
//   2. 스텁이 모르는 주소는 **원래 fetch로 넘긴다.** 같이 도는 다른
//      파일의 요청을 이 스텁이 가로채지 않게.
import { test } from './harness';

/** 모든 파일이 공유하는 하나의 줄. 네트워크 테스트는 겹치지 않는다. */
let chain: Promise<void> = Promise.resolve();

/**
 * 네트워크를 가로채는 테스트. 앞의 네트워크 테스트가 끝난 뒤에 시작한다.
 *
 * 앞 테스트가 실패해도 뒤를 멈추지 않는다 — 한 번 붉어졌다고 나머지가
 * 통째로 안 돌면 무엇이 깨졌는지 알 수 없다.
 */
export function netTest(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const p = chain.then(fn, () => fn());
    chain = p.then(() => undefined, () => undefined);
    return p;
  });
}

export interface StubReply { status?: number; body?: any }

/**
 * `fn`이 도는 동안만 `fetch`를 가로챈다.
 *
 * `handler`가 `null`을 돌려주면 **원래 fetch**가 처리한다. 가로챈 주소만
 * 반환 목록에 쌓이므로, "실제로 어디로 몇 번 나갔는가"를 그대로 볼 수 있다.
 */
export async function withFetch(
  handler: (url: string, init: any) => StubReply | null,
  fn: () => Promise<void>,
): Promise<string[]> {
  const urls: string[] = [];
  const real = (globalThis as any).fetch;
  (globalThis as any).fetch = async (u: any, init: any) => {
    const url = String(u);
    const r = handler(url, init);
    if (!r) return real(u, init);
    urls.push(url);
    const text = JSON.stringify(r.body ?? {});
    return {
      ok: (r.status ?? 200) < 400, status: r.status ?? 200,
      text: async () => text, json: async () => JSON.parse(text),
    } as any;
  };
  try { await fn(); } finally { (globalThis as any).fetch = real; }
  return urls;
}

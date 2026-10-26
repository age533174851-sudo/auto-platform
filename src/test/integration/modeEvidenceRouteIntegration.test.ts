// src/test/integration/modeEvidenceRouteIntegration.test.ts
//
// **승급 증거를 실제 라우트 핸들러로 두드린다.**
//
// 왜 순수 함수 시험으로 부족한가
// ──────────────────────────────
// `canChangeMode`를 직접 부르는 시험은 "못 센 것을 막는가"를 확인한다.
// 그런데 이 결함은 **라우트가 그 사실을 전달하지 않는** 것이었다:
//
//     const { count: unresolved } = await sb.from('live_orders')…
//     ev.unresolvedOrders = unresolved ?? 0;
//
// `error`를 받지 않으니 조회 실패가 `undefined`가 되고, `?? 0`이 그것을
// **0건**으로 바꾼다. 미확정 주문 수는 승급을 막는 증거라서, 0건으로
// 적히면 막아야 할 상태에서 관문이 열린 것으로 **화면에 보인다.**
//
// 판정 함수를 고쳐도 라우트가 `unresolvedKnown`을 안 넘기면 아무것도
// 바뀌지 않는다 — 이 저장소가 반복한 "만들어 놓고 배선을 안 함"이다.
// 그래서 핸들러를 불러 응답 본문을 본다.
//
// 거래소를 부르지 않는다. 주문도 없다.

import { test, eq, assert } from '../harness';

/** 조회 하나의 결과. `error`가 있으면 **못 읽은 것**이다 */
interface Reply { data?: any; count?: any; error?: any }

/**
 * 라우트가 실제로 쓰는 체인만 흉내 낸다.
 *
 * `select(cols, opts)`의 `opts.count`를 보고 **개수 조회와 목록 조회를
 * 구분**한다 — 라우트는 미확정 주문을 `head: true`로 센다.
 */
function stubDb(replies: {
  orders?: Reply; unresolvedCount?: Reply; connections?: Reply;
}): any {
  return {
    from(table: string) {
      let counting = false;
      const chain: any = {
        select(_cols?: string, opts?: any) { counting = opts?.count != null; return chain; },
        eq() { return chain; },
        in() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        then(resolve: any, reject?: any) {
          const pick = (): Reply => {
            if (table === 'exchange_connections') {
              return replies.connections ?? { data: [], error: null };
            }
            if (counting) return replies.unresolvedCount ?? { count: 0, error: null };
            return replies.orders ?? { data: [], error: null };
          };
          return Promise.resolve(pick()).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

/** 완주가 증명된 주문 한 줄. 날짜를 달리해 기간 조건을 채운다 */
function filled(day: number) {
  return {
    created_at: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`,
    status: 'FILLED', filled_qty: 0.01,
  };
}

const PROVEN = Array.from({ length: 12 }, (_, i) => filled(i + 1));

export async function runModeEvidenceRouteTests() {
  console.log('[통합 — 승급 증거 (실제 핸들러)]');

  const adminPath = require.resolve('../../lib/supabase/admin');
  const routePath = require.resolve('../../app/api/autotrade/mode/route');

  /**
   * 관리자 모듈을 **해석기 수준에서** 바꿔 끼운다.
   *
   * `require.cache`에 직접 넣는 방법은 앞선 통합 시험이 같은 칸을
   * 지웠다 되돌리는 사이에 뒤집힌다 — 실제로 첫 두 회차가 진짜 모듈을
   * 받아 401로 끝났다. 시험 결과가 **실행 순서**에 달리면 그 시험은
   * 아무것도 고정하지 못한다. 그래서 이 suite가 도는 동안에는 적재
   * 자체를 가로채고, 끝나면 되돌린다.
   */
  const Module = require('module');
  const origLoad = Module._load;
  let current: any = null;
  /**
   * ★ **이 라우트가 직접 부르는 적재만** 가로챈다.
   *
   *   한때 요청 이름만 보고 가로챘더니, 그 사이에 적재된 **다른
   *   모듈**이 이 가짜를 제 모듈 범위에 넣고 캐시에 남았다. 뒤에 도는
   *   스모크 시험이 그 가짜 DB를 받아 엉뚱한 곳에서 깨졌다 —
   *   시험이 시험을 오염시키는 모양이다. 부모를 보고 좁힌다.
   */
  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (current && parent && parent.filename === routePath
        && /(^@\/|\/)lib\/supabase\/admin$/.test(request)) {
      return current;
    }
    return origLoad.apply(this, arguments as any);
  };
  const restoreLoader = () => { Module._load = origLoad; };

  function loadRoute(db: any) {
    current = {
      getSupabaseAdmin: () => db,
      getUserIdFromRequest: async () => 'u-1',
      resolveUserId: async () => 'u-1',
      serviceRoleKeyRole: () => 'service_role',
    };
    delete require.cache[routePath];
    const mod = require(routePath);
    return {
      GET: mod.GET as (r: any) => Promise<any>,
      restore: () => { delete require.cache[routePath]; current = null; },
    };
  }

  const req = (): any => ({
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? 'Bearer t' : null) },
    nextUrl: new URL('https://x.test/api/autotrade/mode'),
    url: 'https://x.test/api/autotrade/mode',
  });

  const prevMode = process.env.LADDER_MODE;
  process.env.LADDER_MODE = 'TESTNET';

  /** 라우트를 한 번 불러 본문을 돌려준다 */
  const call = async (db: any) => {
    const r = loadRoute(db);
    try {
      const res = await r.GET(req());
      return await res.json();
    } finally { r.restore(); }
  };

  // ① 전부 읽혔고 증거가 깨끗하다 — 기준선
  {
    const body = await call(stubDb({
      orders: { data: PROVEN, error: null },
      unresolvedCount: { count: 0, error: null },
      // SHADOW_LIVE는 실계좌 키를 요구한다 — 기준선이 그것까지 갖춘다.
      connections: { data: [{ is_testnet: false }], error: null },
    }));
    test('① 증거를 다 읽었고 미확정이 0이면 다음 단계가 열린다 (기준선)', () => {
      eq(body.ok, true);
      eq(body.evidence.completedTrades, 12);
      eq(body.evidence.unresolvedKnown, undefined, '읽었으면 플래그를 건드리지 않는다');
      eq(body.next?.mode, 'SHADOW_LIVE');
      eq(body.next?.allowed, true, `열려야 한다: ${JSON.stringify(body.next?.reasons)}`);
    });
  }

  // ② 미확정 주문 **개수 조회가 실패했다** — 0건으로 적지 않는다
  {
    const body = await call(stubDb({
      orders: { data: PROVEN, error: null },
      unresolvedCount: { count: null, error: { message: '개수 조회 실패' } },
      connections: { data: [{ is_testnet: false }], error: null },
    }));
    test('★ ② 미확정 주문 수를 못 세었으면 관문이 열리지 않는다', () => {
      eq(body.evidence.unresolvedKnown, false, '★ 못 센 사실이 증거에 실리지 않았다');
      eq(body.evidence.unresolvedOrders, 0, '값 자체는 0이다 — 그래서 플래그가 필요하다');
      eq(body.next?.allowed, false, '★ 못 센 미확정 주문을 0건으로 읽어 승급이 열렸다');
      assert((body.next?.reasons ?? []).some((x: string) => x.includes('확인하지 못')),
        `이유가 "확인 못 함"이어야 한다: ${JSON.stringify(body.next?.reasons)}`);
    });
  }

  // ③ 완주 표본 조회가 실패했다 — "부족"이 아니라 "확인 못 함"이다
  {
    const body = await call(stubDb({
      orders: { data: null, error: { message: '장부 조회 실패' } },
      unresolvedCount: { count: 0, error: null },
      connections: { data: [{ is_testnet: false }], error: null },
    }));
    test('★ ③ 표본을 못 읽었으면 "표본 부족"이라고 적지 않는다', () => {
      eq(body.evidence.samplesKnown, false);
      eq(body.next?.allowed, false);
      const reasons: string[] = body.next?.reasons ?? [];
      assert(reasons.some(x => x.includes('확인하지 못')), JSON.stringify(reasons));
      assert(!reasons.some(x => x.startsWith('표본 부족')),
        `못 읽은 것을 숫자로 적었다: ${JSON.stringify(reasons)}`);
    });
  }

  // ④ 연결 목록 조회가 실패했다 — "키가 없다"고 단정하지 않는다
  {
    process.env.LADDER_MODE = 'SHADOW_LIVE';
    const body = await call(stubDb({
      orders: { data: PROVEN, error: null },
      unresolvedCount: { count: 0, error: null },
      connections: { data: null, error: { message: '연결 조회 실패' } },
    }));
    process.env.LADDER_MODE = 'TESTNET';
    test('★ ④ 연결 목록을 못 읽었으면 "실계좌 키 없음"으로 적지 않는다', () => {
      eq(body.evidence.liveKeyKnown, false);
      eq(body.evidence.hasLiveKey, false, '값은 false다 — 막는 방향은 그대로다');
      eq(body.next?.allowed, false);
      const reasons: string[] = body.next?.reasons ?? [];
      assert(!reasons.some(x => x === '실계좌 API 키가 등록돼 있지 않습니다'),
        `없다고 단정했다: ${JSON.stringify(reasons)}`);
      assert(reasons.some(x => x.includes('확인하지 못')), JSON.stringify(reasons));
    });
  }

  // ⑤ 조회가 **던졌다** — 그래도 증거가 "0건·없음"으로 적히지 않는다
  {
    const thrower: any = { from: () => { throw new Error('연결 끊김'); } };
    const body = await call(thrower);
    test('★ ⑤ 조회가 예외로 끝나도 "0건"으로 적지 않는다', () => {
      eq(body.evidence.unresolvedKnown, false);
      eq(body.evidence.samplesKnown, false);
      eq(body.next?.allowed, false);
      assert(typeof body.evidenceError === 'string' && body.evidenceError.length > 0,
        '못 읽은 사유가 응답에 남아야 한다');
    });
  }

  // ⑥ 어떤 실패에서도 **쓰기는 0건**이다 (이 라우트는 읽기 전용이다)
  {
    const writes: string[] = [];
    const watched: any = {
      from(table: string) {
        const chain: any = {
          select() { return chain; }, eq() { return chain; }, in() { return chain; },
          order() { return chain; }, limit() { return chain; },
          insert() { writes.push(`insert:${table}`); return chain; },
          update() { writes.push(`update:${table}`); return chain; },
          delete() { writes.push(`delete:${table}`); return chain; },
          then(resolve: any) { return Promise.resolve({ data: [], count: 0, error: null }).then(resolve); },
        };
        return chain;
      },
    };
    await call(watched);
    test('⑥ 승급 증거 조회는 장부에 아무것도 쓰지 않는다', () => {
      eq(writes.length, 0, `쓰기가 있었다: ${writes.join(', ')}`);
    });
  }

  restoreLoader();
  if (prevMode === undefined) delete process.env.LADDER_MODE;
  else process.env.LADDER_MODE = prevMode;
}

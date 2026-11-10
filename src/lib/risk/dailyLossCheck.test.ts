// src/lib/risk/dailyLossCheck.test.ts
//
// `collectPaperDailyLoss`는 **모의 주문·실행 경로 전부**가 부른다
// (`/api/paper/order` · `/api/paper/run` · `collectAllLimits` ·
// `preflight` · TradingView 웹훅 · 일일 사다리). 그런데 시험이 0건이었다.
//
// 막으려는 것 — 전부 이 파일이 자기 주석에 적어 둔 약속이다
// ─────────────────────────────────────────────────────────
//  1. **조회 실패를 "오늘 손실 0"으로 적는 것.** 0이면 한도가 통과다.
//     못 읽었으면 `todayNetUsd: null`로 남아 판정이 unknown이 되어야 한다
//  2. **계좌를 못 정했는데 질의하는 것.** 0건으로 읽으면 "오늘 손실이
//     없다"가 되어 막아야 할 것을 통과시킨다 — 질의 자체를 하지 않는다
//  3. **전용 계좌(챌린지)의 오늘을 기본 계좌로 재는 것.** 계좌를 나눈
//     이유가 사라진다. 준 계좌 id가 그대로 질의에 들어가야 한다
//  4. 숫자가 아닌 값을 0으로 읽는 것
//  5. 잔고를 못 읽었는데 시작 자산을 지어내는 것
//
// 실계좌 쪽(`collectDailyLoss`)은 거래소를 실제로 부르므로 여기서 다루지
// 않는다. **덮지 못한 자리로 적어 둔다.**
import { test, eq, assert } from '../../test/harness';
import { collectPaperDailyLoss } from './dailyLossCheck';

type Call = { kind: 'rpc' | 'from'; name: string; params?: any };

function fakeSb(cfg: {
  accounts?: () => Promise<any>;
  rpc?: () => Promise<any>;
}) {
  const calls: Call[] = [];
  const sb: any = {
    rpc: async (name: string, params: any) => {
      calls.push({ kind: 'rpc', name, params });
      return cfg.rpc ? cfg.rpc() : { data: null, error: null };
    },
    from: (table: string) => {
      calls.push({ kind: 'from', name: table });
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => (cfg.accounts ? cfg.accounts() : { data: null, error: null }),
      };
      return chain;
    },
  };
  return { sb, calls };
}

const NOW = 1_800_000_000_000;
/** 한도를 안 건 상태로 돌리지 않는다 — 그러면 판정이 늘 ok다 */
const noEnv = () => undefined;

export function runPaperDailyLossTests() {
  console.log('[모의 일일 한도 — 조회 실패를 손실 0으로 적지 않는다]');

  test('★★ 계좌를 못 정하면 질의하지 않고 모름으로 남는다', async () => {
    // paper_accounts 조회가 실패 → scope 실패 → 계좌 null
    const { sb, calls } = fakeSb({ accounts: async () => ({ data: null, error: { message: 'DB 끊김' } }) });
    const f = await collectPaperDailyLoss({ sb, userId: 'u1', nowMs: NOW, env: noEnv });
    eq(calls.filter(c => c.kind === 'rpc').length, 0,
      '계좌를 못 정했는데 질의했다 — 0건이 "오늘 손실 없음"으로 읽힌다');
    eq(f.todayNetUsd, null, '오늘 손익을 지어냈다');
    eq(f.incomeCount, 0);
    assert(f.verdict.status !== 'ok', `판정이 ok다 — 확인하지 못한 것은 통과가 아니다 (${f.verdict.status})`);
  });

  test('★★ RPC가 error면 오늘 손실을 0으로 적지 않는다', async () => {
    const { sb } = fakeSb({
      accounts: async () => ({ data: { balance: 1000 }, error: null }),
      rpc: async () => ({ data: null, error: { message: '함수 없음' } }),
    });
    const f = await collectPaperDailyLoss({
      sb, userId: 'u1', nowMs: NOW, env: noEnv, paperAccountId: 'acct-1',
    });
    eq(f.todayNetUsd, null, '조회 실패를 0으로 적었다 — 한도가 통째로 사라진다');
    assert(f.verdict.status !== 'ok', `판정이 ok다 (${f.verdict.status})`);
  });

  // `null`·`undefined`는 **일부러 넣지 않는다.**
  //
  // 구현은 `Number(row?.r_realized)`로 읽으므로 `Number(null) === 0`이고
  // `Number.isFinite(0)`이 참이다 — 즉 NULL이 오면 "오늘 손실 0"으로
  // 읽혀 한도가 통과한다. 처음에 그 입력을 시험에 넣었더니 실패했다.
  //
  // 그런데 그 값은 **실제로 올 수 없다.** 정본인 `088`의
  // `paper_realized_between`은 두 CTE를 각각 `COALESCE(SUM(...), 0)`으로
  // 감싸고, GROUP BY 없는 집계라 언제나 한 줄을 돌려준다. 그래서
  // `r_realized`는 NULL이 되지 않는다.
  //
  // 살아 있는 결함이 아니므로 결함으로 적지 않는다. 다만 그 안전이 **SQL
  // 쪽 약속에 걸려 있다**는 것을 여기 남긴다 — 088에서 COALESCE가 빠지면
  // TS는 그것을 0으로 읽는다.
  test('★★ 숫자가 아닌 값을 0으로 읽지 않는다', async () => {
    for (const bad of ['abc', NaN, Infinity, -Infinity, {}]) {
      const { sb } = fakeSb({
        accounts: async () => ({ data: { balance: 1000 }, error: null }),
        rpc: async () => ({ data: [{ r_realized: bad, r_events: 3 }], error: null }),
      });
      const f = await collectPaperDailyLoss({
        sb, userId: 'u1', nowMs: NOW, env: noEnv, paperAccountId: 'acct-1',
      });
      eq(f.todayNetUsd, null, `r_realized=${String(bad)}를 숫자로 읽었다`);
    }
  });

  test('★★ 전용 계좌를 주면 그 계좌로 질의한다 — 기본 계좌를 보지 않는다', async () => {
    const { sb, calls } = fakeSb({
      accounts: async () => ({ data: { balance: 500 }, error: null }),
      rpc: async () => ({ data: [{ r_realized: -10, r_events: 2 }], error: null }),
    });
    await collectPaperDailyLoss({
      sb, userId: 'u1', nowMs: NOW, env: noEnv, paperAccountId: '  acct-challenge  ',
    });
    const rpc = calls.find(c => c.kind === 'rpc');
    assert(rpc != null, '질의를 하지 않았다');
    eq(rpc!.name, 'paper_realized_between',
      '합산을 SQL 정본이 아닌 다른 경로로 했다 — 분할매도에서 SQL과 갈린다');
    eq(rpc!.params.p_paper_account_id, 'acct-challenge',
      '준 계좌 id가 질의에 안 들어갔다 — 챌린지 손익을 기본 계좌로 잰다');
    eq(rpc!.params.p_user, 'u1', '사용자로 좁히지 않았다');
  });

  test('★ 정상 행은 그대로 싣는다', async () => {
    const { sb } = fakeSb({
      accounts: async () => ({ data: { balance: 1000 }, error: null }),
      rpc: async () => ({ data: [{ r_realized: -12.5, r_events: 4 }], error: null }),
    });
    const f = await collectPaperDailyLoss({
      sb, userId: 'u1', nowMs: NOW, env: noEnv, paperAccountId: 'acct-1',
    });
    eq(f.todayNetUsd, -12.5);
    eq(f.incomeCount, 4);
    eq(f.dayStartEquityUsd, 1012.5, '시작 자산 = 잔고 − 오늘 손익');
  });

  test('★★ 잔고를 못 읽으면 시작 자산을 지어내지 않는다', async () => {
    const { sb } = fakeSb({
      accounts: async () => ({ data: null, error: null }),
      rpc: async () => ({ data: [{ r_realized: -10, r_events: 1 }], error: null }),
    });
    const f = await collectPaperDailyLoss({
      sb, userId: 'u1', nowMs: NOW, env: noEnv, paperAccountId: 'acct-1',
    });
    eq(f.todayNetUsd, -10, '오늘 손익은 읽었어야 한다');
    eq(f.dayStartEquityUsd, null, '잔고를 모르는데 시작 자산을 적었다');
  });

  test('★ 질의 구간은 그날 00:00(UTC)부터 24시간이다', async () => {
    const { sb, calls } = fakeSb({
      accounts: async () => ({ data: { balance: 1 }, error: null }),
      rpc: async () => ({ data: [{ r_realized: 0, r_events: 0 }], error: null }),
    });
    await collectPaperDailyLoss({
      sb, userId: 'u1', nowMs: NOW, env: noEnv, paperAccountId: 'a',
    });
    const p = calls.find(c => c.kind === 'rpc')!.params;
    const from = Date.parse(p.p_from), to = Date.parse(p.p_to);
    eq(to - from, 86_400_000, '구간이 24시간이 아니다');
    assert(from <= NOW && NOW < to, '지금이 구간 안에 없다');
    eq(new Date(from).toISOString().slice(11), '00:00:00.000Z', 'UTC 자정에서 시작하지 않는다');
  });
}

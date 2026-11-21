// src/lib/risk/lossStreakCheck.test.ts
//
// `collectPaperStreakLimits`는 주간 한도와 **연패 잠금**에 넣을 숫자를
// 모은다. 네 곳이 부른다 (TradingView 웹훅 · 일일 사다리 ·
// `collectAllLimits` · `preflight`). 시험은 0건이었다.
//
// `src/lib/risk`의 시험 0건 모듈 다섯 중 **네 번째**다
// (#605 `collectLimits` · #606 `dailyLossCheck` · #607 `regimeCheck`에 이어).
//
// 막으려는 것 — 전부 이 파일이 자기 주석에 적어 둔 약속이다
// ─────────────────────────────────────────────────────────
//  1. **조회 실패를 '거래 없음'으로 적는 것.** `[]`로 두면 "연패 없음"이
//     되어 잠금이 조용히 풀린다. 못 읽었으면 `null`이고 판정은 unknown이다
//  2. **계좌를 못 정했는데 질의하는 것.** 0건으로 읽으면 같은 결과가 된다 —
//     질의 자체를 하지 않고 모름에 남긴다
//  3. 쓸 수 없는 행(숫자 아닌 손익·읽을 수 없는 시각)을 세는 것
//  4. **주간 손익에 지난 주 거래를 섞는 것** — 주가 바뀌면 한도도 풀려야 한다
//  5. 잔고를 못 읽었는데 주 시작 자산을 지어내는 것
import { test, eq, assert } from '../../test/harness';
import { collectPaperStreakLimits } from './lossStreakCheck';
import { utcWeekStart } from './lossStreak';

const NOW = Date.UTC(2026, 10, 10, 8, 0, 0);     // 2026-11-10 08:00 UTC (화)
const WEEK = utcWeekStart(NOW);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function fakeSb(cfg: {
  accountId?: string | null;
  accountsError?: boolean;
  positions?: () => Promise<any>;
  balance?: number | null;
}) {
  const tables: string[] = [];
  const sb: any = {
    from(table: string) {
      tables.push(table);
      let sel = '';
      const chain: any = {
        select(s: string) { sel = String(s); return chain; },
        eq: () => chain,
        order: () => chain,
        limit: async () => (cfg.positions ? cfg.positions() : { data: [], error: null }),
        maybeSingle: async () => {
          if (sel.includes('balance')) {
            return { data: cfg.balance == null ? null : { balance: cfg.balance }, error: null };
          }
          if (cfg.accountsError) return { data: null, error: { message: 'DB 끊김' } };
          const id = cfg.accountId === undefined ? 'acct-default' : cfg.accountId;
          return { data: id == null ? null : { id }, error: null };
        },
      };
      return chain;
    },
  };
  return { sb, tables };
}

const noEnv = () => undefined;

export function runPaperStreakTests() {
  console.log('[모의 주간·연패 — 조회 실패를 "거래 없음"으로 적지 않는다]');

  test('★★ 계좌를 못 정하면 포지션을 질의하지 않고 모름으로 남는다', async () => {
    for (const cfg of [{ accountsError: true }, { accountId: null }]) {
      const { sb, tables } = fakeSb(cfg);
      const f = await collectPaperStreakLimits({ sb, userId: 'u1', nowMs: NOW, env: noEnv });
      assert(!tables.includes('paper_positions'),
        '계좌를 못 정했는데 포지션을 질의했다 — 0건이 "연패 없음"으로 읽힌다');
      eq(f.weekNetUsd, null, '이번 주 손익을 지어냈다');
      eq(f.weekly.status, 'unknown', `주간 판정이 ${f.weekly.status}다`);
      eq(f.streak.status, 'unknown', `연패 판정이 ${f.streak.status}다`);
    }
  });

  test('★★ 포지션 조회가 error면 "거래 없음"이 아니다', async () => {
    const { sb } = fakeSb({
      positions: async () => ({ data: null, error: { message: '권한 없음' } }),
      balance: 1000,
    });
    const f = await collectPaperStreakLimits({ sb, userId: 'u1', nowMs: NOW, env: noEnv });
    eq(f.weekNetUsd, null, '조회 실패를 0으로 적었다 — 주간 잠금이 풀린다');
    eq(f.streak.status, 'unknown', '연패를 "없음"으로 읽었다');
    eq(f.weekly.status, 'unknown');
    eq(f.weekStartEquityUsd, null, '주 손익을 모르는데 시작 자산을 적었다');
  });

  test('★★ 주간 손익에 지난 주 거래를 섞지 않는다', async () => {
    const { sb } = fakeSb({
      positions: async () => ({
        data: [
          { realized_pnl: -10, closed_at: iso(WEEK + DAY) },        // 이번 주
          { realized_pnl: -5, closed_at: iso(WEEK + 2 * DAY) },     // 이번 주
          { realized_pnl: -1000, closed_at: iso(WEEK - DAY) },      // 지난 주
          { realized_pnl: -2000, closed_at: iso(WEEK - 10 * DAY) }, // 더 지난 주
        ],
        error: null,
      }),
      balance: 1000,
    });
    const f = await collectPaperStreakLimits({ sb, userId: 'u1', nowMs: NOW, env: noEnv });
    eq(f.weekNetUsd, -15, '주 경계를 넘은 거래가 이번 주 손익에 섞였다');
    eq(f.weekStartEquityUsd, 1015, '주 시작 자산 = 잔고 − 이번 주 손익');
  });

  test('★★ 쓸 수 없는 행은 버린다 — 0으로 읽지 않는다', async () => {
    const { sb } = fakeSb({
      positions: async () => ({
        data: [
          { realized_pnl: -10, closed_at: iso(WEEK + DAY) },
          { realized_pnl: 'abc', closed_at: iso(WEEK + DAY) },   // 숫자가 아니다
          { realized_pnl: -7, closed_at: null },                  // 시각을 모른다
          { realized_pnl: -3, closed_at: 'not-a-date' },           // 읽을 수 없다
          { realized_pnl: null, closed_at: iso(WEEK + DAY) },
        ],
        error: null,
      }),
      balance: 500,
    });
    const f = await collectPaperStreakLimits({ sb, userId: 'u1', nowMs: NOW, env: noEnv });
    eq(f.weekNetUsd, -10, '쓸 수 없는 행이 손익에 섞였다');
  });

  test('★ 잔고를 못 읽으면 주 시작 자산을 지어내지 않는다', async () => {
    const { sb } = fakeSb({
      positions: async () => ({ data: [{ realized_pnl: -10, closed_at: iso(WEEK + DAY) }], error: null }),
      balance: null,
    });
    const f = await collectPaperStreakLimits({ sb, userId: 'u1', nowMs: NOW, env: noEnv });
    eq(f.weekNetUsd, -10, '이번 주 손익은 읽었어야 한다');
    eq(f.weekStartEquityUsd, null, '잔고를 모르는데 주 시작 자산을 적었다');
  });

  test('★ 거래가 하나도 없으면 0이고, 그건 모름과 다르다', async () => {
    const { sb } = fakeSb({ positions: async () => ({ data: [], error: null }), balance: 1000 });
    const f = await collectPaperStreakLimits({ sb, userId: 'u1', nowMs: NOW, env: noEnv });
    eq(f.weekNetUsd, 0, '거래 0건은 손익 0이다');
    assert(f.streak.status !== 'unknown',
      '거래 0건을 "확인하지 못함"으로 읽었다 — 읽었는데 비어 있는 것과 못 읽은 것은 다르다');
  });

  test('★ 연습 환경 한도라는 사실이 note에 남는다', async () => {
    const { sb } = fakeSb({ positions: async () => ({ data: [], error: null }), balance: 1000 });
    const f = await collectPaperStreakLimits({ sb, userId: 'u1', nowMs: NOW, env: noEnv });
    assert(/연습 환경 한도/.test(f.note),
      `모의인데 연습 한도라는 표시가 없다: '${f.note}' — 실전 한도로 읽히면 연습을 못 한다`);
  });
}

// src/lib/risk/collectLimits.test.ts
//
// `collectAllLimits`는 **주문 라우트 네 곳**이 부르는 손실 잠금 수집기다
// (현물·선물·COIN-M·주식 주문). 그런데 시험이 **한 건도 없었다** —
// `src/lib/risk/`의 23개 파일 중 다섯 개가 그 상태였고, 그중 이 파일이
// 가장 많이 불린다. 100X 변이 카탈로그에도 `src/lib/risk`는 0개다.
//
// 막으려는 것 — 전부 이 파일이 자기 머리말에 적어 둔 약속이다
// ─────────────────────────────────────────────────────────
//  1. **조회 실패가 통과가 되는 것.** 못 읽은 항목은 null로 남아야 하고
//     (체크리스트가 unknown으로 막는다) 절대 'ok'가 되어서는 안 된다
//  2. **모르는 거래소를 바이낸스로 치는 것.** 그러면 남의 키로 바이낸스에
//     서명 요청이 나간다. 셋 다 'unknown'이 되고 이유가 남아야 한다
//  3. **AI 거부권이 켜졌는데 항목이 사라지는 것.** 호출자는
//     `!!limits.aiVeto`로 검사를 목록에 넣을지 정한다 — null이면 검사가
//     있었다는 사실 자체가 화면에서 없어진다
//  4. **서브계좌 한도를 모르는데 통과시키는 것.** 사용자가 정한 바구니
//     상한이 조회 실패 한 번으로 무제한이 되면 안 된다
//  5. 하나가 실패해서 **나머지까지 null**이 되는 것 — 그러면 사용자는
//     무엇을 고쳐야 하는지 알 수 없다
import { test, eq, assert } from '../../test/harness';
import { collectAllLimits } from './collectLimits';

/** 아무것도 못 읽는 sb. 조회가 실패하는 쪽을 고정한다. */
function sbThrows() {
  return { from() { throw new Error('DB 없음'); } } as any;
}

/** 연결 한 줄을 돌려주는 sb. `exchange_id`로 거래소 해석을 몰아 본다. */
function sbWithConnection(exchangeId: string) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({
      data: {
        api_key: 'k', api_secret_enc: 'not:valid:hex',
        exchange_id: exchangeId, is_testnet: true,
      },
    }),
  };
  return { from: () => chain } as any;
}

/** 연결을 못 찾는 sb */
function sbNoConnection() {
  const chain: any = {
    select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data: null }),
  };
  return { from: () => chain } as any;
}

const STATUSES = ['dailyLoss', 'weeklyLoss', 'lossStreak'] as const;

function withEnv(patch: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) { saved[k] = process.env[k]; 
    if (patch[k] === undefined) delete process.env[k]; else process.env[k] = patch[k]; }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
}

export function runCollectLimitsTests() {
  console.log('[손실 잠금 수집 — 조회 실패가 통과가 되지 않는다]');

  test('★★ 연결 id가 없으면 아무 판정도 지어내지 않는다', async () => {
    const r = await collectAllLimits({ sb: sbThrows(), userId: 'u1' });
    for (const k of STATUSES) eq(r[k], null, `${k}가 null이어야 한다 — 모름은 통과가 아니다`);
    eq(r.aiPredictionId, null);
  });

  test('★★ 연결을 못 찾으면 통과시키지 않는다', async () => {
    const r = await collectAllLimits({ sb: sbNoConnection(), userId: 'u1', connectionId: 'c1' });
    for (const k of STATUSES) eq(r[k], null, `${k}를 지어냈다`);
  });

  test('★★ 모르는 거래소를 바이낸스로 치지 않는다 — 셋 다 unknown', async () => {
    const r = await collectAllLimits({ sb: sbWithConnection('upbit'), userId: 'u1', connectionId: 'c1' });
    for (const k of STATUSES) {
      assert(r[k] != null, `${k}가 null이다 — 이유가 남아야 한다`);
      eq(r[k]!.status, 'unknown', `${k}가 unknown이 아니다`);
      assert(/지원하지 않는 거래소/.test(r[k]!.reason),
        `${k}의 이유가 '지원하지 않는 거래소'가 아니다 — 바이낸스로 조회했을 수 있다: ${r[k]!.reason}`);
    }
  });

  test('★★ 어떤 경로에서도 조회 실패가 ok가 되지 않는다', async () => {
    const cases = [
      await collectAllLimits({ sb: sbThrows(), userId: 'u1' }),
      await collectAllLimits({ sb: sbNoConnection(), userId: 'u1', connectionId: 'c1' }),
      await collectAllLimits({ sb: sbWithConnection('upbit'), userId: 'u1', connectionId: 'c1' }),
      await collectAllLimits({ sb: sbThrows(), userId: 'u1', paper: true }),
    ];
    for (const r of cases) {
      for (const k of STATUSES) {
        assert(r[k] == null || r[k]!.status !== 'ok',
          `${k}가 ok다 — 조회가 실패했는데 통과로 적혔다`);
      }
    }
  });

  test('★★ 모의에서 장부를 못 읽으면 null로 남는다', async () => {
    const r = await collectAllLimits({ sb: sbThrows(), userId: 'u1', paper: true });
    for (const k of STATUSES) {
      assert(r[k] == null || r[k]!.status !== 'ok', `${k}가 ok다`);
    }
  });

  test('★★ 서브계좌: 시장·종목을 모르면 통과시키지 않는다', async () => {
    const r = await collectAllLimits({ sb: sbThrows(), userId: 'u1', paper: true });
    assert(r.subAccount != null, 'subAccount가 null이다 — 모르면 막아야 한다');
    eq(r.subAccount!.status, 'unknown', '시장·종목을 몰라도 통과시켰다');
  });

  // ── 환경변수를 만지는 시험은 **한 묶음에서 순차로** 돈다 ──
  // 하네스는 async 시험을 `Promise.all`로 동시에 돌린다. 같은
  // `AI_VETO_*`를 세 시험이 각자 set/restore 하면 한쪽의 finally가
  // 다른 쪽이 await 하는 중에 값을 되돌려 **거짓 실패**가 난다.
  // (처음에 그렇게 썼고, 실제로 그 모양으로 깨졌다.)
  test('★★ AI 거부권: 켜져 있으면 어떤 경우에도 항목이 사라지지 않는다', async () => {
    await withEnv({ AI_VETO_ENABLED: '1', AI_VETO_STRICT: '1' }, async () => {
      const r = await collectAllLimits({ sb: sbThrows(), userId: 'u1', paper: true });
      assert(r.aiVeto != null,
        'strict: aiVeto가 null이다 — 호출자는 !!aiVeto로 목록에 넣을지 정하므로 검사가 통째로 사라진다');
      eq(r.aiVeto!.status, 'unknown', 'strict인데 unknown이 아니다');
    });
    await withEnv({ AI_VETO_ENABLED: '1', AI_VETO_STRICT: '0' }, async () => {
      const r = await collectAllLimits({ sb: sbThrows(), userId: 'u1', paper: true });
      assert(r.aiVeto != null, 'non-strict: aiVeto가 null이다');
      eq(r.aiVeto!.status, 'abstain', 'strict가 아니면 abstain이어야 한다');
    });
    await withEnv({ AI_VETO_ENABLED: '0', AI_VETO_STRICT: undefined }, async () => {
      const r = await collectAllLimits({ sb: sbThrows(), userId: 'u1', paper: true });
      eq(r.aiVeto, null, '꺼졌는데 판정을 지어냈다 — 체크리스트에 없는 항목이 생긴다');
    });
  });

  test('★ 하나가 실패해도 나머지 자리는 채운다', async () => {
    const r = await collectAllLimits({ sb: sbWithConnection('upbit'), userId: 'u1', connectionId: 'c1' });
    // 거래소를 몰라 손실 셋은 unknown이지만, 서브계좌 판정은 그대로 나와야 한다.
    assert(r.subAccount != null, '한 곳이 실패하자 서브계좌 판정까지 사라졌다');
  });
}

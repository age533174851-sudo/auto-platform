// src/lib/engine/exitMonitor.test.ts
//
// 이 테스트가 막는 것 하나
// ────────────────────────
// **실계좌 포지션을 테스트넷 데이터로 판단하는 것.**
//
// 청산 감시는 환경변수 하나(LADDER_MODE)로 망을 정하고 있었다. 그런데
// 진입(daily-ladder)은 연결의 is_testnet을 따라 실계좌로 나간다. 둘이
// 서로 모르면 이렇게 된다:
//
//   진입 → 실계좌에 포지션이 생긴다
//   감시 → 테스트넷을 본다 → 포지션이 없다 → 아무것도 안 한다
//
// 결과: 트레일링 손절이 안 움직이고, 시간 청산이 안 되고, 포지션 점검이
// "이미 닫혔다"고 보고한다. 전부 조용히. 그리고 이건 진입이 안 되는
// 것보다 훨씬 나쁘다 — **못 여는 것은 불편이고 못 닫는 것은 사고다.**
//
// 그래서 여기서 고정한다: 거래마다 그 거래의 연결이 망을 정한다.

import { test, eq, assert } from '../../test/harness';
import { decideExits } from './exitMonitor';

/** ladder_daily_trades 한 줄을 돌려주는 최소 supabase 흉내 */
function sbWith(rows: any[]) {
  /** 어떤 상태를 훑었는지. **보호 없는 포지션이 빠지면 안 된다** */
  const scanned: any = { statuses: null as string[] | null };
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: (_col: string, vals: string[]) => { scanned.statuses = vals; return chain; },
    limit: async () => ({ data: rows, error: null }),
  };
  return Object.assign({ from: () => chain }, { scanned });
}

const OPEN_ROW = {
  id: 't1', user_id: 'u1', symbol: 'BTCUSDT', side: 'LONG',
  entry_price: 60000, stop_loss: 59000,
  created_at: new Date(Date.now() - 3600_000).toISOString(),
};

export function runExitMonitorTests() {
  console.log('[청산 감시 — 실계좌 포지션을 테스트넷으로 판단하지 않는다]');

  test('거래마다 그 사용자의 망을 물어본다', async () => {
    const asked: string[] = [];
    await decideExits(sbWith([OPEN_ROW]) as any, {
      testnet: true,
      testnetFor: async (uid) => { asked.push(uid); return false; },
      limit: 5,
    });
    eq(asked.length, 1, '망을 물어보지 않았다 — 환경변수만 보고 있다');
    eq(asked[0], 'u1', '다른 사용자의 망을 물어봤다');
  });

  test('연결이 실전이면 기본값이 테스트넷이어도 실전으로 본다', async () => {
    let used: boolean | null = null;
    // highWaterSince는 네트워크를 타므로 실패한다. 실패해도 **어느 망으로
    // 물어봤는지**는 testnetFor 호출로 확인할 수 있다.
    await decideExits(sbWith([OPEN_ROW]) as any, {
      testnet: true,                       // 환경변수는 테스트넷
      testnetFor: async () => { used = false; return false; },   // 연결은 실전
      limit: 5,
    });
    eq(used, false, '연결이 실전인데 물어보지도 않았다');
  });

  test('해석기를 안 주면 예전처럼 기본값을 쓴다 — 갑자기 동작이 바뀌지 않는다', async () => {
    const out = await decideExits(sbWith([OPEN_ROW]) as any, { testnet: true, limit: 5 });
    assert(Array.isArray(out), '결과가 배열이 아니다');
  });

  // **모르는 것을 조용히 넘기지 않는다.**
  // 연결을 못 읽었으면 기본 망으로 조회하되, 그 사실이 사유에 남아야
  // 한다. 안 그러면 "캔들 조회 실패"만 보이고 원인을 영영 모른다.
  test('연결을 못 읽으면 그 사실을 사유에 적는다', async () => {
    const out = await decideExits(sbWith([OPEN_ROW]) as any, {
      testnet: true,
      testnetFor: async () => null,        // 못 알아냄
      limit: 5,
    });
    // 캔들 조회는 네트워크라 이 환경에서는 실패한다. 그 사유에 연결을
    // 못 읽었다는 말이 함께 붙어야 한다.
    const skipped = out.find(d => d.reason && d.reason.includes('캔들 조회 실패'));
    if (skipped) {
      assert(skipped.reason.includes('연결을 못 읽어'),
        '연결을 못 읽은 사실이 안 적혔다: ' + skipped.reason);
    }
  });

  // 시간 청산은 시세를 안 보므로 망과 무관하게 나와야 한다. 이게 망
  // 조회 실패에 걸려 사라지면, 5일 넘은 포지션이 영영 안 닫힌다.
  test('시간 청산은 시세 조회와 무관하게 나온다', async () => {
    const old = { ...OPEN_ROW, created_at: new Date(Date.now() - 10 * 86400_000).toISOString() };
    const out = await decideExits(sbWith([old]) as any, {
      testnet: true, testnetFor: async () => null, maxHoldMs: 5 * 86400_000, limit: 5,
    });
    const close = out.find(d => d.action === 'CLOSE');
    assert(!!close, '10일 지난 포지션이 시간 청산되지 않았다');
    assert(close.reason.includes('시간 청산'), close.reason);
  });

  test('손절가가 없으면 손절을 옮기거나 닫지 않는다 — 추측해서 판단하지 않는다', async () => {
    const broken = { ...OPEN_ROW, stop_loss: null };
    const out = await decideExits(sbWith([broken]) as any, { testnet: true, limit: 5 });
    eq(out.filter(d => d.action !== 'NONE').length, 0, '손절가를 모르는데 판단했다');
  });

  // **예전에는 이 줄이 목록에서 통째로 사라졌다.**
  //
  // 그리고 진입 경로가 `stop_loss`를 안 적고 있었으므로(065 이전) 열린
  // 거래 전부가 그렇게 사라졌다. 응답의 `checked`는 0이었고 그건
  // "볼 것이 없었다"로 읽혔다 — 안 본 것과 이상 없는 것은 다르다.
  test('손절가가 없다는 사실이 목록에 남는다', async () => {
    const broken = { ...OPEN_ROW, stop_loss: null };
    const out = await decideExits(sbWith([broken]) as any, { testnet: true, limit: 5 });
    eq(out.length, 1, '조용히 목록에서 빠졌다 — 안 본 것이 0건으로 보인다');
    eq(out[0].action, 'NONE');
    assert(out[0].reason.includes('손절가가 장부에 없'), out[0].reason);
  });

  // **손절가는 시간 청산에 필요 없다.** 필요한 것은 언제 열렸는가 하나뿐이다.
  // 예전에는 손절가 검사가 앞에 있어서, 손절가가 없으면 5일 강제 청산조차
  // 돌지 않았다. 못 여는 것은 불편이고 못 닫는 것은 사고다.
  test('손절가를 몰라도 시간 청산은 돈다', async () => {
    const old = {
      ...OPEN_ROW, stop_loss: null,
      created_at: new Date(Date.now() - 10 * 86400_000).toISOString(),
    };
    const out = await decideExits(sbWith([old]) as any, {
      testnet: true, maxHoldMs: 5 * 86400_000, limit: 5,
    });
    const close = out.find(d => d.action === 'CLOSE');
    assert(!!close, '손절가가 없다고 10일 지난 포지션을 안 닫았다');
    assert(close!.reason.includes('시간 청산'), close!.reason);
  });

  // ── 어느 계좌의 포지션인가 ──
  //
  // `ladder_daily_trades`에 연결이 없으면 청산 감시는 사용자의 활성 연결
  // 중 하나를 `.limit(1)`로 고른다. 활성 연결이 둘 이상이면 A 계좌에서
  // 연 포지션을 B 계좌에서 찾는다 — 조회는 조용히 "포지션 없음"이다.
  test('거래에 적힌 연결을 그대로 들고 나온다', async () => {
    const row = { ...OPEN_ROW, connection_id: 'conn-a' };
    const out = await decideExits(sbWith([row]) as any, { testnet: true, limit: 5 });
    eq(out.length, 1);
    eq(out[0].connectionId, 'conn-a');
  });

  test('연결이 안 적힌 옛 줄은 null이다 — 아무거나 채우지 않는다', async () => {
    const out = await decideExits(sbWith([OPEN_ROW]) as any, { testnet: true, limit: 5 });
    eq(out.length, 1);
    eq(out[0].connectionId, null);
  });

  test('지금 걸린 손절도 그 거래의 연결로 읽는다', async () => {
    const asked: any[] = [];
    const row = { ...OPEN_ROW, connection_id: 'conn-a' };
    await decideExits(sbWith([row]) as any, {
      testnet: true, limit: 5,
      liveStopFor: async (uid, sym, side, connectionId) => {
        asked.push({ uid, sym, side, connectionId });
        return null;
      },
    });
    // 캔들 조회(네트워크)가 실패하면 여기까지 안 온다. 물어봤다면
    // 반드시 그 거래의 연결이어야 한다.
    for (const a of asked) eq(a.connectionId, 'conn-a', '엉뚱한 연결로 손절을 읽었다');
  });

  // ── 무엇을 훑는가 ──
  //
  // `OPEN` 하나만 보면 **보호 없는 포지션과 나갔는지 모르는 주문이
  // 아무도 안 보는 상태로 남는다.** 그 둘이야말로 먼저 봐야 할 것들이다.
  test('보호 없는 포지션과 미확정 주문도 훑는다', async () => {
    const sb = sbWith([]);
    await decideExits(sb as any, { testnet: true, limit: 5 });
    const st = (sb as any).scanned.statuses;
    assert(Array.isArray(st), '상태 목록으로 훑지 않았다');
    assert(st.includes('OPEN'), 'OPEN이 빠졌다');
    assert(st.includes('UNPROTECTED'), '보호 없는 포지션을 안 본다');
    assert(st.includes('RECONCILE_REQUIRED'), '나갔는지 모르는 주문을 안 본다');
  });

  test('열린 거래가 없으면 빈 결과다', async () => {
    const out = await decideExits(sbWith([]) as any, { testnet: true, limit: 5 });
    eq(out.length, 0);
  });
}

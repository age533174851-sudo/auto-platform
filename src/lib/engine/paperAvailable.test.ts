// src/lib/engine/paperAvailable.test.ts
import { test, eq, assert } from '../../test/harness';
import { usedMarginOf, availableBalance, availableView } from './paperAvailable';
import { getPaperAccount } from './paperStore';

export function runPaperAvailableTests() {
  test('열린 포지션의 증거금을 잔고에서 뺀다', () => {
    const v = availableView(1000, [{ margin: 200 }, { margin: 300 }]);
    eq(v.usedMargin, 500);
    eq(v.available, 500);
    eq(v.unknownReason, null);
  });

  test('포지션이 없으면 잔고 전부가 가용이다 — **빈 목록일 때만**', () => {
    eq(availableView(1000, []).available, 1000);
  });

  // ── ★ 목록을 못 받은 것과 0건은 다르다 ──
  //
  // 이 시험은 원래 `availableView(1000, null).available === 1000`이었다.
  // 즉 **버그를 기대값으로 적어 두고 있었다.** 세 라우트가 전부 Supabase
  // `error`를 버리고 `data`만 썼기 때문에, 조회가 실패하면 여기 `null`이
  // 들어오고 화면에는 "열린 포지션 없음 · 가용 1000"이 떴다. 오류도 없고
  // 빈 칸도 없는, 정상으로 보이는 가짜 상태다.
  //
  // 호출부에서 `error`를 보는 것이 1차 방어이고, 이건 한 곳이라도
  // 빠뜨렸을 때 **없는 돈이 생기지 않게** 하는 2차 방어다.
  test('★ 포지션 목록을 못 받으면 0건이 아니라 모름이다', () => {
    for (const bad of [null, undefined, 'x', 0, false, {}]) {
      const v = availableView(1000, bad as any);
      eq(v.available, null, `${String(bad)}에서 가용이 숫자로 나왔습니다`);
      assert(!!v.unknownReason, `${String(bad)}에서 사유가 없습니다`);
    }
    eq(usedMarginOf(null).unreadable, 1);
    eq(usedMarginOf(undefined).unreadable, 1);
  });

  // ── ★ 못 읽은 증거금 ──
  test('★ 증거금을 못 읽으면 0으로 세지 않는다 — 없는 돈이 생긴다', () => {
    const u = usedMarginOf([{ margin: 200 }, { margin: null }, { margin: '' }, { margin: 'x' }]);
    eq(u.used, 200);
    eq(u.unreadable, 3);
    // 예전 코드는 `Number(p.margin) || 0`이라 여기서 가용 1,000이 나왔다
    eq(availableBalance(1000, u), null);
  });

  test('★ 못 읽은 가용 잔고는 0이 아니라 null이다', () => {
    const v = availableView(1000, [{ margin: null }]);
    eq(v.available, null);
    eq(v.usedMargin, null);
    assert(/0이라는 뜻이 아닙니다/.test(v.unknownReason || ''), '사유가 0 오해를 막지 않습니다');
  });

  test('잔고 자체를 못 읽어도 null이다', () => {
    for (const b of [null, undefined, '', 'abc', true]) {
      eq(availableView(b, []).available, null, `${String(b)}가 숫자로 읽혔습니다`);
    }
  });

  test('음수 증거금은 못 읽은 것으로 본다', () => {
    eq(usedMarginOf([{ margin: -5 }]).unreadable, 1);
  });

  test('증거금이 잔고보다 크면 가용은 0이다 — 음수를 적지 않는다', () => {
    eq(availableView(100, [{ margin: 500 }]).available, 0);
  });

  test('잔고 0은 못 읽음이 아니다', () => {
    const v = availableView(0, []);
    eq(v.available, 0);
    eq(v.unknownReason, null);
  });

  test('증거금 0인 줄은 정상이다', () => {
    eq(usedMarginOf([{ margin: 0 }]).unreadable, 0);
  });

  // ══════════════════════════════════════════════════════════
  // ★ 잔고 쪽에 남아 있던 같은 구멍 — 계좌를 **못 읽은** 회차
  // ══════════════════════════════════════════════════════════
  //
  //   위 시험들은 **증거금**(목록) 쪽을 막는다. 가용 잔고는 두 숫자로
  //   만들어진다: `balance - usedMargin`. 그 앞의 `balance`가
  //   `getPaperAccount`에서 오고, 그쪽은 이랬다:
  //
  //     const { data } = await sb.from('paper_accounts')…maybeSingle();
  //     if (data) return data;
  //     // 없으면 10,000 USDT짜리 기본 계좌를 만든다
  //
  //   `error`를 버리므로 **조회 실패가 "계좌 없음"이 된다.** 그러면 잔고
  //   300인 사용자의 예산이 조용히 **10,000**이 되고, 그 상태로 진입이
  //   통과한다. 막는 쪽이 아니라 **여는 쪽으로 틀린** 기본값이다.

  const acctDb = (reply: { data: any; error: any }, writes: string[] = []): any => ({
    from: () => {
      const c: any = {
        select: () => c, eq: () => c,
        maybeSingle: async () => reply,
        insert: async (row: any) => { writes.push(JSON.stringify(row)); return { error: null }; },
      };
      return c;
    },
  });

  test('★ 모의 계좌 조회가 실패하면 10,000짜리 계좌를 만들지 않는다', async () => {
    const writes: string[] = [];
    let threw = '';
    try {
      await getPaperAccount(acctDb({ data: null, error: { message: '조회 실패' } }, writes), 'u-1');
    } catch (e: any) { threw = String(e?.message || e); }
    assert(threw !== '', '★ 못 읽은 회차가 계좌를 들고 돌아왔다');
    assert(threw.includes('없다는 뜻이 아닙니다'), `사유가 사실을 말해야 한다: ${threw}`);
    eq(writes.length, 0, '★ 못 읽은 회차에 계좌가 새로 생겼다');
  });

  test('★ 조회가 던져도 계좌를 만들지 않는다', async () => {
    const writes: string[] = [];
    const thrower: any = { from: () => { throw new Error('연결 끊김'); } };
    let threw = '';
    try { await getPaperAccount(thrower, 'u-1'); } catch (e: any) { threw = String(e?.message || e); }
    assert(threw !== '', '★ 예외가 계좌 생성으로 덮였다');
    eq(writes.length, 0);
  });

  test('줄이 **정말 없으면** 기본 계좌를 만든다 (기존 동작)', async () => {
    const writes: string[] = [];
    const acct = await getPaperAccount(acctDb({ data: null, error: null }, writes), 'u-1');
    eq(acct.balance, 10000);
    eq(acct.is_default, true);
    eq(writes.length, 1, '없으면 만든다 — 이 동작은 그대로다');
  });

  test('줄이 있으면 그 줄을 그대로 쓴다 — 쓰기 0건', async () => {
    const writes: string[] = [];
    const acct = await getPaperAccount(
      acctDb({ data: { id: 'a1', balance: 317.5, is_default: true }, error: null }, writes), 'u-1');
    eq(acct.balance, 317.5);
    eq(writes.length, 0);
  });

  test('★ 못 읽은 잔고는 가용 계산에 들어가지 않는다', () => {
    // 호출부가 `null`을 넘기면 계획 단계가 막는다. 10,000이 흘러 들어오면
    // 그 자리에서는 **정상적인 숫자로 보인다** — 그래서 앞에서 막아야 한다.
    eq(availableBalance(null as any, usedMarginOf([])), null);
    eq(availableView(null as any, []).available, null);
  });
}

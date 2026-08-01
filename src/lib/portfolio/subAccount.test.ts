import { test, eq } from '../../test/harness';
import {
  judgeSubAccount, pickAccount, usedByAccount, normalizeSubAccountInput,
  type SubAccount, type OpenUse,
} from './subAccount';

export function runSubAccountTests() {
  console.log('[가상 서브계좌 — 계산만 하지 않고 실제로 막는다]');

  const A = (o: Partial<SubAccount> & { id: string }): SubAccount => ({
    name: o.id, allocatedUsd: 1000, ...o,
  });
  const pos = (symbol: string, market: string, marginUsd: number | null): OpenUse =>
    ({ symbol, market, marginUsd });

  // ── 바구니 고르기 ────────────────────────────────────────
  test('시장·종목이 안 맞으면 그 바구니는 후보가 아니다', () => {
    const accs = [A({ id: 'spot', markets: ['SPOT'] })];
    eq(pickAccount(accs, 'USDM', 'BTCUSDT'), null);
    eq(pickAccount(accs, 'SPOT', 'BTCUSDT')?.id, 'spot');
  });

  test('종목까지 지정한 바구니가 시장만 지정한 것보다 우선한다', () => {
    const accs = [
      A({ id: 'all-usdm', markets: ['USDM'] }),
      A({ id: 'btc-only', markets: ['USDM'], symbolPrefixes: ['BTC'] }),
    ];
    // 구체적인 규칙이 먼저다. 안 그러면 넓은 바구니 하나가 전부를 삼켜
    // 나머지 규칙이 죽은 설정이 된다.
    eq(pickAccount(accs, 'USDM', 'BTCUSDT')?.id, 'btc-only');
    eq(pickAccount(accs, 'USDM', 'ETHUSDT')?.id, 'all-usdm');
  });

  test('아무 조건도 없는 바구니는 모든 것을 받는다', () => {
    const accs = [A({ id: 'catch-all' })];
    eq(pickAccount(accs, 'COINM', 'ETHUSD_PERP')?.id, 'catch-all');
  });

  test('동점이면 먼저 정의한 것을 쓴다 — 순서가 우선순위다', () => {
    const accs = [A({ id: 'first', markets: ['USDM'] }), A({ id: 'second', markets: ['USDM'] })];
    eq(pickAccount(accs, 'USDM', 'BTCUSDT')?.id, 'first');
  });

  // ── 사용 중 금액 ─────────────────────────────────────────
  test('증거금을 하나라도 못 읽으면 합계를 내지 않는다', () => {
    const acc = A({ id: 'a', markets: ['USDM'] });
    const r = usedByAccount(acc, [
      pos('BTCUSDT', 'USDM', 100),
      pos('ETHUSDT', 'USDM', null),
    ]);
    // 모르는 것을 0으로 더하면 **한도가 실제보다 넉넉해 보인다**
    eq(r.usedUsd, null);
    eq(r.unknownCount, 1);
  });

  test('다른 바구니의 포지션은 세지 않는다', () => {
    const acc = A({ id: 'spot', markets: ['SPOT'] });
    eq(usedByAccount(acc, [pos('BTCUSDT', 'USDM', 500)]).usedUsd, 0);
  });

  // ── 한도 판정 ────────────────────────────────────────────
  test('바구니를 안 만들었으면 이 검사는 통과다 — 안 켠 검사를 경고로 두지 않는다', () => {
    const r = judgeSubAccount({ accounts: [], market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 100, open: [] });
    eq(r.status, 'ok');
  });

  test('한도 안이면 통과하고 남은 자리를 적는다', () => {
    const r = judgeSubAccount({
      accounts: [A({ id: 'growth', name: '성장', allocatedUsd: 1000 })],
      market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 200,
      open: [pos('ETHUSDT', 'USDM', 300)],
    });
    eq(r.status, 'ok');
    eq(r.usedUsd, 300);
    eq(r.remainingUsd, 500);
  });

  test('한도를 넘으면 막는다', () => {
    const r = judgeSubAccount({
      accounts: [A({ id: 'growth', name: '성장', allocatedUsd: 1000 })],
      market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 800,
      open: [pos('ETHUSDT', 'USDM', 300)],
    });
    eq(r.status, 'over');
    eq(r.reason.includes('성장'), true);
  });

  test('딱 한도까지는 통과한다 — 경계에서 새지도, 과하게 막지도 않는다', () => {
    const r = judgeSubAccount({
      accounts: [A({ id: 'g', allocatedUsd: 1000 })],
      market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 700,
      open: [pos('ETHUSDT', 'USDM', 300)],
    });
    eq(r.status, 'ok');
    eq(r.remainingUsd, 0);
  });

  test('1센트만 넘어도 막는다', () => {
    const r = judgeSubAccount({
      accounts: [A({ id: 'g', allocatedUsd: 1000 })],
      market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 700.01,
      open: [pos('ETHUSDT', 'USDM', 300)],
    });
    eq(r.status, 'over');
  });

  test('부동소수점 찌꺼기로 한도가 새지 않는다', () => {
    // 0.1 + 0.2 = 0.30000000000000004
    const r = judgeSubAccount({
      accounts: [A({ id: 'g', allocatedUsd: 0.3 })],
      market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 0.2,
      open: [pos('ETHUSDT', 'USDM', 0.1)],
    });
    eq(r.status, 'ok');
  });

  test('어느 바구니에도 안 맞으면 막는다 — 한도 밖에서 도는 자금을 만들지 않는다', () => {
    const r = judgeSubAccount({
      accounts: [A({ id: 'spot', markets: ['SPOT'] })],
      market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 10, open: [],
    });
    eq(r.status, 'unassigned');
  });

  test('배정 금액이 없으면 확인 불가다 — 한도 없음이 아니다', () => {
    const r = judgeSubAccount({
      accounts: [A({ id: 'g', name: '성장', allocatedUsd: null })],
      market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 10, open: [],
    });
    eq(r.status, 'unknown');
  });

  test('배정 금액이 빈 문자열이어도 0으로 읽지 않는다', () => {
    const r = judgeSubAccount({
      accounts: [A({ id: 'g', allocatedUsd: '' as any })],
      market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 10, open: [],
    });
    eq(r.status, 'unknown');
  });

  test('배정 0은 유효하다 — 0과 미설정은 다르다', () => {
    const r = judgeSubAccount({
      accounts: [A({ id: 'g', name: '중지', allocatedUsd: 0 })],
      market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 10, open: [],
    });
    // 0을 배정한 것은 "이 바구니는 안 쓴다"는 뜻이다. 막혀야 맞다.
    eq(r.status, 'over');
  });

  test('사용 중 금액을 못 읽으면 통과시키지 않는다', () => {
    const r = judgeSubAccount({
      accounts: [A({ id: 'g', allocatedUsd: 1000 })],
      market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 10,
      open: [pos('ETHUSDT', 'USDM', null)],
    });
    eq(r.status, 'unknown');
  });

  test('이 주문의 증거금을 모르면 통과시키지 않는다', () => {
    const r = judgeSubAccount({
      accounts: [A({ id: 'g', allocatedUsd: 1000 })],
      market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: null, open: [],
    });
    eq(r.status, 'unknown');
  });

  test('바구니가 여럿이면 자기 것만 센다', () => {
    const accs = [
      A({ id: 'growth', name: '성장', allocatedUsd: 1000, markets: ['USDM'] }),
      A({ id: 'safe', name: '안정', allocatedUsd: 500, markets: ['SPOT'] }),
    ];
    const open = [pos('BTCUSDT', 'USDM', 900), pos('ETHUSDT', 'SPOT', 400)];
    // 성장은 900을 쓰고 있으니 200을 더하면 넘는다
    eq(judgeSubAccount({ accounts: accs, market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 200, open }).status, 'over');
    // 안정은 400을 쓰고 있으니 50은 들어간다
    eq(judgeSubAccount({ accounts: accs, market: 'SPOT', symbol: 'SOLUSDT', addMarginUsd: 50, open }).status, 'ok');
  });

  // ── 입력 다듬기 ─────────────────────────────────────────
  test('이름 없이 저장하지 않는다', () => {
    eq(!!normalizeSubAccountInput({ name: '   ' }).error, true);
    eq(!!normalizeSubAccountInput({ name: '성장' }).value, true);
  });

  test('배정 금액을 비워 두면 0이 아니라 미설정이다', () => {
    // 0으로 바꾸면 "한도 0인 바구니"가 되어 그 바구니의 주문이 전부 막힌다.
    eq(normalizeSubAccountInput({ name: 'a', allocatedUsd: '' }).value?.allocatedUsd, null);
    eq(normalizeSubAccountInput({ name: 'a', allocatedUsd: null }).value?.allocatedUsd, null);
    eq(normalizeSubAccountInput({ name: 'a', allocatedUsd: 0 }).value?.allocatedUsd, 0);
  });

  test('음수·숫자 아닌 배정 금액은 거절한다', () => {
    eq(!!normalizeSubAccountInput({ name: 'a', allocatedUsd: -1 }).error, true);
    eq(!!normalizeSubAccountInput({ name: 'a', allocatedUsd: 'abc' }).error, true);
    // 센트까지만 남긴다 — 판정도 센트 단위로 자른다
    eq(normalizeSubAccountInput({ name: 'a', allocatedUsd: '1000.567' }).value?.allocatedUsd, 1000.57);
  });

  test('모르는 시장은 조용히 버리지 않고 거절한다', () => {
    // 버리면 목록이 비고, 빈 목록은 '모든 시장'이다 — 오타 하나가 범위를
    // 좁히는 게 아니라 넓혀 버린다.
    eq(!!normalizeSubAccountInput({ name: 'a', markets: ['USDT'] }).error, true);
    eq(normalizeSubAccountInput({ name: 'a', markets: ['usdm', 'USDM'] }).value?.markets.length, 1);
  });

  test('종목 접두사는 대문자로 맞추고 이상한 값은 거절한다', () => {
    eq(normalizeSubAccountInput({ name: 'a', symbolPrefixes: ['btc', ' eth '] }).value?.symbolPrefixes.join(','), 'BTC,ETH');
    eq(!!normalizeSubAccountInput({ name: 'a', symbolPrefixes: ['BTC-USD'] }).error, true);
  });

  test('순서가 숫자가 아니면 0으로 두지 않고 거절한다', () => {
    // 순서는 우선순위다. 못 읽은 값을 0으로 두면 맨 앞으로 올라와
    // 어느 바구니가 먼저인지가 조용히 바뀐다.
    eq(!!normalizeSubAccountInput({ name: 'a', sortOrder: 'x' }).error, true);
    eq(normalizeSubAccountInput({ name: 'a' }).value?.sortOrder, 0);
    eq(normalizeSubAccountInput({ name: 'a', sortOrder: '2.7' }).value?.sortOrder, 2);
  });

  test('다듬은 값은 그대로 판정에 쓸 수 있다', () => {
    // 저장 경로와 판정 경로가 같은 모양을 쓰는지 — 여기가 어긋나면
    // 화면에서 만든 바구니가 주문을 막지 못한다.
    const v = normalizeSubAccountInput({
      name: '성장', allocatedUsd: '1000', markets: ['usdm'], symbolPrefixes: ['btc'],
    }).value!;
    const acc: SubAccount = { id: 'x', name: v.name, allocatedUsd: v.allocatedUsd, markets: v.markets, symbolPrefixes: v.symbolPrefixes };
    eq(judgeSubAccount({ accounts: [acc], market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 1200, open: [] }).status, 'over');
    eq(judgeSubAccount({ accounts: [acc], market: 'USDM', symbol: 'BTCUSDT', addMarginUsd: 900, open: [] }).status, 'ok');
  });
}

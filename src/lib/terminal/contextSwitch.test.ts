// src/lib/terminal/contextSwitch.test.ts
//
// 막으려는 것:
//  1. **앞 종목의 지정가가 남아 새 종목에 나가는 것.** BTC의 64,000이
//     남은 채로 ETH를 사면, 지정가인데 호가를 쓸어 담으며 즉시 체결된다.
//     지정가를 넣었으니 안전하다고 믿는 자리에서 정확히 반대가 일어난다
//  2. 계좌를 바꿨는데 [청산]이 켜진 채로 남아, 없는 포지션을 닫으려다
//     신규 진입이 되는 것
//  3. 첫 렌더를 전환으로 오해해 사용자가 적어 둔 값을 지우는 것
//  4. USDT로 적은 금액까지 지워, 안전이 아니라 성가심이 되는 것
import { test, assert, eq } from '../../test/harness';
import { switchScope, fieldsToClearOnSwitch, clearNotice } from './contextSwitch';

export function runContextSwitchTests() {
  console.log('[맥락 전환 — 무엇이 바뀌었는가]');

  test('종목만 바뀌면 종목 전환이다', () => {
    const v = switchScope({ symbol: 'BTCUSDT', connectionId: 'A' }, { symbol: 'ETHUSDT', connectionId: 'A' });
    eq(v.scope, 'SYMBOL');
    eq(v.changed.join(','), 'symbol');
  });

  test('연결이 바뀌면 계좌 전환이다', () => {
    const v = switchScope({ symbol: 'BTCUSDT', connectionId: 'A' }, { symbol: 'BTCUSDT', connectionId: 'B' });
    eq(v.scope, 'ACCOUNT');
  });

  test('모의↔실계좌도 계좌 전환이다', () => {
    // 연결 id가 둘 다 비어 있어도 그렇다 — 모의는 id가 없다.
    const v = switchScope({ symbol: 'BTCUSDT', paper: true }, { symbol: 'BTCUSDT', paper: false });
    eq(v.scope, 'ACCOUNT');
    assert(v.changed.includes('paper'), v.changed.join(','));
  });

  test('둘 다 바뀌면 계좌 전환으로 본다 — 더 넓은 쪽', () => {
    const v = switchScope({ symbol: 'BTCUSDT', connectionId: 'A' }, { symbol: 'ETHUSDT', connectionId: 'B' });
    eq(v.scope, 'ACCOUNT');
    eq(v.changed.length, 2);
  });

  test('대소문자는 전환이 아니다', () => {
    eq(switchScope({ symbol: 'btcusdt' }, { symbol: 'BTCUSDT' }).scope, 'NONE');
  });

  test('첫 렌더는 전환이 아니다', () => {
    // 이전 값이 없는데 지우면, 새로고침 한 번에 적어 둔 값이 사라진다.
    eq(switchScope(null, { symbol: 'BTCUSDT' }).scope, 'NONE');
    eq(switchScope(undefined, undefined).scope, 'NONE');
  });

  test('안 바뀌었으면 아무 말도 안 한다', () => {
    const v = switchScope({ symbol: 'BTCUSDT', connectionId: 'A' }, { symbol: 'BTCUSDT', connectionId: 'A' });
    eq(v.scope, 'NONE');
    eq(v.notice, '');
  });

  console.log('[맥락 전환 — 무엇을 비우는가]');

  test('종목이 바뀌면 가격을 반드시 비운다', () => {
    // 이 한 줄이 이 파일의 전부다.
    const c = fieldsToClearOnSwitch('SYMBOL', { unit: 'BASE' });
    assert(c.includes('price'), c.join(','));
    assert(c.includes('stopPrice'), c.join(','));
    assert(c.includes('takeProfitPrice'), c.join(','));
  });

  test('코인 개수로 적었으면 수량도 비운다', () => {
    // 0.5 BTC와 0.5 ETH는 전혀 다른 크기다.
    const c = fieldsToClearOnSwitch('SYMBOL', { unit: 'BASE' });
    assert(c.includes('quantity'), c.join(','));
  });

  test('USDT로 적었으면 수량은 남긴다', () => {
    // 100달러는 어느 종목에서든 100달러다. 지우면 성가심일 뿐이다.
    const c = fieldsToClearOnSwitch('SYMBOL', { unit: 'QUOTE' });
    assert(!c.includes('quantity'), c.join(','));
    assert(c.includes('price'), '가격은 그래도 비운다');
  });

  test('계좌가 바뀌면 USDT여도 수량을 비운다', () => {
    // 그 금액은 앞 계좌의 잔고를 보고 정한 것이다.
    const c = fieldsToClearOnSwitch('ACCOUNT', { unit: 'QUOTE' });
    assert(c.includes('quantity'), c.join(','));
    assert(c.includes('riskPick'), c.join(','));
  });

  test('전환이면 [청산]을 끈다', () => {
    // 켜진 채로 두면 '청산'이라고 적힌 버튼이 신규 진입을 낸다.
    for (const s of ['SYMBOL', 'ACCOUNT'] as const) {
      assert(fieldsToClearOnSwitch(s).includes('reduceOnly'), s);
    }
  });

  test('같은 칸을 두 번 적지 않는다', () => {
    for (const s of ['SYMBOL', 'ACCOUNT'] as const) {
      for (const u of ['BASE', 'QUOTE'] as const) {
        const c = fieldsToClearOnSwitch(s, { unit: u });
        eq(new Set(c).size, c.length, `${s}/${u}: ${c.join(',')}`);
      }
    }
  });

  test('안 바뀌었으면 아무것도 안 비운다', () => {
    eq(fieldsToClearOnSwitch('NONE', { unit: 'BASE' }).length, 0);
  });

  console.log('[맥락 전환 — 지운 것을 말한다]');

  test('실제로 비웠을 때만 안내한다', () => {
    const v = switchScope({ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' });
    assert(clearNotice(v, ['price']).includes('앞 종목'), clearNotice(v, ['price']));
    eq(clearNotice(v, []), '', '비운 게 없으면 조용하다');
  });

  test('계좌 전환은 다르게 말한다', () => {
    const v = switchScope({ connectionId: 'A' }, { connectionId: 'B' });
    assert(clearNotice(v, ['price']).includes('앞 계좌'), v.notice);
  });
}

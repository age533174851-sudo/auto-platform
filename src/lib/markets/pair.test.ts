// src/lib/markets/pair.test.ts
//
// 이 테스트가 막는 것: **목록에서 종목이 조용히 사라지는 것.**
//
// 걸러진 종목은 화면에서 '없는 종목'과 똑같이 보인다. 그래서 필터가
// 틀려도 에러가 안 나고, 아무도 모른다. 실제로 SUPER와 JUP이 그렇게
// 사라져 있었다.

import { test, eq, assert } from '../../test/harness';
import {
  QUOTES, isSupportedQuote, isDollarQuote, isLeveragedToken, baseOf, acceptPair,
} from './pair';

export function runPairTests() {
  console.log('[페어 가르기 — 걸러진 것과 없는 것은 화면에서 같아 보인다]');

  test('베이스는 끝에서만 자른다', () => {
    eq(baseOf('BTCUSDT', 'USDT'), 'BTC');
    eq(baseOf('ETHBTC', 'BTC'), 'ETH');
    eq(baseOf('BNBETH', 'ETH'), 'BNB');
  });

  // replace(quote,'')는 첫 번째 자리를 지운다. 베이스 안에 같은 글자가
  // 있으면 엉뚱한 이름이 나온다 — 화면에는 그 엉뚱한 이름이 그냥 뜬다.
  test('베이스 안에 견적통화 글자가 있어도 이름이 안 망가진다', () => {
    eq(baseOf('BTCBTC', 'BTC'), 'BTC');
    eq(baseOf('USDTUSDT', 'USDT'), 'USDT');
    // 옛 코드('BTCBTC'.replace('BTC','')) 는 ''를 만들었다
    assert(baseOf('BTCBTC', 'BTC') !== '', '베이스가 빈 문자열이 됐다');
  });

  test('그 통화로 끝나지 않으면 null — 억지로 자르지 않는다', () => {
    eq(baseOf('BTCUSDT', 'BTC'), null);
    eq(baseOf('ETHBTC', 'USDT'), null);
    eq(baseOf('', 'USDT'), null);
    eq(baseOf('USDT', 'USDT'), null);   // 베이스가 없다
  });

  test('레버리지 토큰은 <상장코인>+접미사 형태다', () => {
    eq(isLeveragedToken('BTCUP'), true);
    eq(isLeveragedToken('ETHDOWN'), true);
    eq(isLeveragedToken('XRPBULL'), true);
    eq(isLeveragedToken('ADABEAR'), true);
  });

  // **이 테스트가 이 파일의 이유다.**
  //
  // 1차: 페어 전체에 includes('UP') → SUPER('S-U-P-E-R')가 사라졌다.
  // 2차: 끝만 보게 고쳤더니 → JUP(Jupiter)이 사라졌다. 이름이 그냥
  //      UP으로 끝나는 실제 코인이다.
  // 둘 다 에러가 안 났다. 걸러진 종목은 없는 종목과 똑같이 보인다.
  test('이름이 UP·DOWN으로 끝나는 멀쩡한 코인은 안 지운다', () => {
    for (const base of ['SUPER', 'JUP', 'BULLET', 'BEARISH']) {
      eq(isLeveragedToken(base), false, `${base}가 레버리지 토큰으로 걸렸다`);
    }
    eq(acceptPair('SUPERUSDT', 'USDT'), 'SUPER');
    eq(acceptPair('JUPUSDT', 'USDT'), 'JUP');
  });

  test('레버리지 토큰 페어는 받지 않는다', () => {
    eq(acceptPair('BTCUPUSDT', 'USDT'), null);
    eq(acceptPair('ETHDOWNUSDT', 'USDT'), null);
  });

  // 목록을 주면 어림잡지 않고 정확히 가른다: BTCUP의 'BTC'는 상장돼
  // 있으므로 레버리지 토큰, JUP의 'J'는 아니므로 그냥 코인.
  test('상장 목록을 주면 정확해진다', () => {
    const known = new Set(['BTC', 'ETH', 'XRP', 'SUPER', 'JUP']);
    eq(isLeveragedToken('BTCUP', known), true);
    eq(isLeveragedToken('JUP', known), false);
    eq(isLeveragedToken('SUPER', known), false);
    // 'SOUL'이 목록에 없으면 SOULUP은 레버리지 토큰이 아니다 —
    // 모르면 **안 지우는 쪽으로** 틀린다
    eq(isLeveragedToken('SOULUP', known), false);
  });

  test('달러 계열만 원화로 환산한다', () => {
    for (const q of ['USDT', 'USDC', 'FDUSD']) eq(isDollarQuote(q), true, q);
    // BTC 페어의 0.00003에 환율을 곱하면 완전히 다른 숫자가 된다
    for (const q of ['BTC', 'BNB', 'ETH']) eq(isDollarQuote(q), false, q);
  });

  test('모르는 견적통화는 받지 않는다', () => {
    eq(isSupportedQuote('USDT'), true);
    eq(isSupportedQuote('usdt'), true);
    eq(isSupportedQuote('BTCUSD'), false);
    eq(isSupportedQuote(''), false);
    eq(isSupportedQuote(null), false);
  });

  test('목록에 중복이 없다', () => {
    eq(new Set(QUOTES).size, QUOTES.length);
  });
}

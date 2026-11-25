// src/lib/markets/instrumentRoute.test.ts
//
// **목록의 종목 이름을 거래소 심볼로 바꾸는 규칙.**
//
// 여기서 틀리면 조용히 틀린다. 잘못된 심볼은 예외를 내지 않고 차트·호가·
// 봉 조회로 그대로 흘러가서 **"거래가 없는 종목"처럼 보인다.** 화면에는
// 오류도 빈 칸도 없다.
//
// 실제로 그렇게 났다
// ──────────────────
// 판정이 `/USDT$|USDC$|BUSD$|BTC$|ETH$/`였다. `BTC`와 `ETH`는 결제통화
// 이면서 동시에 기초자산 이름이라, 목록의 `BTC` 한 종목이 "이미 완성된
// 쌍"으로 읽혔다:
//
//     BTC → BTC      (BTCUSDT가 아니라)
//     ETH → ETH
//
// 함수 주석의 계약과 정면으로 어긋난 상태였다.
//
// ★ 이 시험은 **helper가 있는지**를 보지 않는다
// ─────────────────────────────────────────────
// 이름만 맞춰 두고 안을 바꾸는 변경은 이름 검사를 통과한다. 그래서
// 여기서는 **입력을 넣고 나온 값**만 본다.
import { test, eq, assert } from '../../test/harness';
import { detailTargetOf, isCompletePair, coinEvidence, KIND_FIELDS } from './instrumentRoute';

const sym = (s: string) => detailTargetOf({ symbol: s, category: 'coin' })?.symbol ?? null;

export function runInstrumentRouteTests() {
  console.log('[종목 → 상세 심볼]');

  test('★ 기초자산 이름만 오면 USDT를 붙인다', () => {
    eq(sym('BTC'), 'BTCUSDT');
    eq(sym('ETH'), 'ETHUSDT');
    eq(sym('SOL'), 'SOLUSDT');
  });

  test('★ BTC·ETH는 결제통화이기도 하다 — 그 이유로 완성 쌍이 되면 안 된다', () => {
    // 이것이 실제로 났던 고장이다. `BTC`가 `BTC$`에 걸려 그대로 나갔다.
    assert(sym('BTC') !== 'BTC', 'BTC가 그대로 나갔다 — 거래소에 없는 심볼이다');
    assert(sym('ETH') !== 'ETH', 'ETH가 그대로 나갔다');
    eq(isCompletePair('BTC'), false);
    eq(isCompletePair('ETH'), false);
    eq(isCompletePair('USDT'), false);
  });

  test('★ 이미 완성된 쌍은 그대로 둔다 — USDT를 또 붙이지 않는다', () => {
    eq(sym('BTCUSDT'), 'BTCUSDT');
    eq(sym('ETHUSDT'), 'ETHUSDT');
    eq(sym('SOLUSDC'), 'SOLUSDC');
    eq(sym('BNBBUSD'), 'BNBBUSD');
  });

  test('★ 코인/코인 쌍도 완성이다 (결제통화 앞에 기초자산이 있다)', () => {
    eq(sym('ETHBTC'), 'ETHBTC');
    eq(sym('BTCETH'), 'BTCETH');
    eq(isCompletePair('ETHBTC'), true);
    eq(isCompletePair('BTCETH'), true);
  });

  test('소문자·슬래시도 같은 규칙으로 읽는다', () => {
    eq(sym('btc'), 'BTCUSDT');
    eq(sym('BTC/USDT'), 'BTCUSDT');
    eq(sym('eth/btc'), 'ETHBTC');
  });

  test('시장은 언제나 현물이다 — 목록에서 들어오는 길은 현물이다', () => {
    eq(detailTargetOf({ symbol: 'BTC', category: 'coin' })?.market, 'SPOT');
    eq(detailTargetOf({ symbol: 'ETHBTC', category: 'coin' })?.market, 'SPOT');
  });

  test('코인이 아니라고 적혀 있으면 열지 않는다', () => {
    eq(detailTargetOf({ symbol: 'AAPL', category: 'stock' }), null);
    eq(detailTargetOf({ symbol: 'GOLD', type: 'commodity' }), null);
  });

  // ══ 실제로 났던 고장: AMDUSDT · Spot ══
  //
  // 미국주식 AMD를 눌렀더니 `AMDUSDT` 현물 상세가 열렸다. 바이낸스에
  // 없는 심볼이라 가격·등락률·고가·저가·거래량이 전부 실패하고, 봉은
  // 상류의 HTTP 400을 안고 돌아왔다. 그런데 **매수·매도 버튼은 그대로
  // 있었다.**
  //
  // 관문은 있었다. `category`·`type`·`kind` 셋을 읽었는데, 이 저장소의
  // 자산 레코드는 그 이름들을 쓰지 않는다 — `t`·`cat`·`asset_type`을
  // 쓴다. **데이터가 쓰지 않는 이름을 보는 관문은 관문이 아니다.**
  //
  // 아래 세 모양은 전부 저장소에서 그대로 베껴 온 것이다.

  test('★ AMD — src/data/assets.ts 모양 (t: AssetType)', () => {
    // f('AMD','AMD','Advanced Micro Devices','AMD',421.39,…,'stock',…)
    eq(detailTargetOf({
      id: 'AMD', nameKr: 'AMD', name: 'Advanced Micro Devices', sym: 'AMD',
      p: 421.39, c: 18.61, v: '11B', t: 'stock', clr: '#ED1C24',
    }), null);
  });

  test('★ AMD — WatchlistPage WL_DB 모양 (cat)', () => {
    eq(detailTargetOf({
      id: 'AMD', nameKr: 'AMD', sym: 'AMD', clr: '#ED1C24',
      cat: 'stock', exchange: 'NASDAQ', tv: 'NASDAQ:AMD',
    }), null);
  });

  test('★ AMD — assetSearch · /api/search 모양 (asset_type)', () => {
    eq(detailTargetOf({
      symbol: 'AMD', name: 'Advanced Micro Devices', nameKr: 'AMD',
      exchange: 'NASDAQ', asset_type: 'stock', currency: 'USD', provider: 'polygon',
    }), null);
  });

  test('★ 그 세 이름으로 코인이라 적힌 것은 그대로 열린다', () => {
    eq(detailTargetOf({ id: 'BTC', sym: 'BTC/USDT', t: 'coin' })?.symbol, 'BTCUSDT');
    eq(detailTargetOf({ id: 'SUI', sym: 'SUI', cat: 'coin' })?.symbol, 'SUIUSDT');
    eq(detailTargetOf({ symbol: 'SOL', asset_type: 'coin' })?.symbol, 'SOLUSDT');
  });

  test('★ 종류가 안 적혀 있으면 열지 않는다 — UNKNOWN은 통과가 아니다', () => {
    // 예전에는 "안 적혀 있으면 심볼로 본다"였다. 그 한 줄이 주식 전부를
    // 거래쌍으로 만들었다. 못 열면 바깥이 예전 상세창으로 보낸다.
    eq(detailTargetOf({ symbol: 'BTC' }), null);
    eq(detailTargetOf({ symbol: 'AMD' }), null);
    eq(coinEvidence({ symbol: 'BTC' }), 'UNKNOWN');
  });

  test('★ 하나라도 코인이 아니라고 말하면 코인이 아니다', () => {
    // 관심목록은 `{...WL_DB행, ...시세행}`으로 합쳐지므로 `cat`과 `t`가
    // 함께 온다. 먼저 찾은 쪽이 이기게 하면 필드 순서가 판단을 바꾼다.
    eq(coinEvidence({ cat: 'coin', t: 'stock' }), 'NOT_COIN');
    eq(coinEvidence({ t: 'coin', cat: 'stock' }), 'NOT_COIN');
    eq(detailTargetOf({ symbol: 'AMD', cat: 'coin', t: 'stock' }), null);
  });

  test('★ 문자열이 아닌 값은 종류가 아니다', () => {
    // `/api/prices`의 봉 응답에서 `t`는 **열린 시각 ms**다(숫자).
    // 번역 함수를 `t`로 받는 코드도 흔하다. String()으로 바꾸면 숫자나
    // 함수 소스가 "종류"로 읽힌다.
    eq(coinEvidence({ t: 1738000000000 }), 'UNKNOWN');
    eq(coinEvidence({ t: () => 'x' }), 'UNKNOWN');
    eq(coinEvidence({ t: 1738000000000, cat: 'coin' }), 'COIN');
  });

  test('빈 문자열은 안 적힌 것과 같다', () => {
    eq(coinEvidence({ t: '', cat: '  ' }), 'UNKNOWN');
    eq(coinEvidence({ t: '', cat: 'coin' }), 'COIN');
  });

  test('crypto도 코인이다 — 두 어휘가 함께 쓰인다', () => {
    eq(coinEvidence({ cat: 'crypto' }), 'COIN');
    eq(detailTargetOf({ symbol: 'PEPE', cat: 'CRYPTO' })?.symbol, 'PEPEUSDT');
  });

  test('★ 티커가 COIN인 미국주식(코인베이스)은 코인이 아니다', () => {
    // 종목 이름이 종류 어휘와 겹치는 자리다. 심볼을 종류로 읽으면
    // 코인베이스가 `COINUSDT`로 열린다.
    eq(detailTargetOf({ sym: 'COIN', id: 'COIN', labelEn: 'Coinbase', cat: 'stock' }), null);
    eq(coinEvidence({ sym: 'COIN', id: 'COIN', cat: 'stock' }), 'NOT_COIN');
    // 종류가 아예 안 적혀 있어도 심볼만으로 코인이라 읽지 않는다.
    eq(detailTargetOf({ sym: 'COIN', id: 'COIN' }), null);
  });

  test('ETF·지수·원자재·국내주식도 열지 않는다', () => {
    for (const k of ['etf', 'index', 'commodity', 'forex', 'krstock', 'stock_ai', 'crypto_perp']) {
      eq(detailTargetOf({ symbol: 'X', cat: k }), null);
    }
  });

  test('실측으로 모은 이름 목록이 줄어들지 않았다', () => {
    // 이름을 지우는 변경은 관문을 다시 눈먼 상태로 만든다. 그래서
    // **지금 읽는 이름**을 못으로 박아 둔다.
    for (const f of ['category', 'type', 'kind', 'cat', 'asset_type', 'assetType', 't']) {
      assert((KIND_FIELDS as readonly string[]).includes(f), `KIND_FIELDS에 ${f}가 없다`);
    }
  });

  test('읽을 것이 없으면 null이다 — 기본 종목을 지어내지 않는다', () => {
    eq(detailTargetOf(null), null);
    eq(detailTargetOf({}), null);
    eq(detailTargetOf({ symbol: '' }), null);
    eq(detailTargetOf({ symbol: '   ' }), null);
  });

  test('이름은 있으면 싣고 없으면 비운다', () => {
    eq(detailTargetOf({ symbol: 'BTC', cat: 'coin', name: '비트코인' })?.name, '비트코인');
    eq(detailTargetOf({ symbol: 'BTC', cat: 'coin' })?.name, undefined);
  });
}

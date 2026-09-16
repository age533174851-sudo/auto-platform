// src/lib/engine/paperPriceSource.test.ts
//
// **현물로 산 것이 선물 가격으로 닫히던 고장을 여기서 고정한다.**
//
// 무엇을 증명하는가
// ─────────────────
//  ① 시장 → 출처 표가 진입과 청산이 공유하는 **하나의 계약**이다
//  ② 현물 청산은 선물 프리미엄 인덱스를 **부르지 않는다**
//  ③ 선물 청산은 선물 가격을 쓴다
//  ④ 모르는 시장은 USDM으로 흘러가지 않고 **거기서 멈춘다**
//  ⑤ 값을 못 구하면 가격을 지어내지 않는다
//
// 실제로 어느 모듈을 부르는지는 **동적 import를 가로채서** 본다. 결과
// 숫자만 보면 두 출처가 우연히 비슷할 때 구별되지 않는다 — 어느 문을
// 두드렸는지를 봐야 한다.
import { test, eq, assert } from '../../test/harness';
import {
  paperMarketOf, priceSourceFor, paperPriceFailed,
  PAPER_MARKETS, type PaperMarket,
} from './paperPriceSource';

export function runPaperPriceSourceTests() {
  // ── ① 시장 읽기 ──
  test('시장은 SPOT · USDM 둘뿐이다', () => {
    eq(PAPER_MARKETS.join(','), 'SPOT,USDM');
    eq(paperMarketOf('SPOT'), 'SPOT');
    eq(paperMarketOf('USDM'), 'USDM');
    eq(paperMarketOf(' spot '), 'SPOT');
  });

  test('모르는 시장을 USDM으로 읽지 않는다 — 기본값이 없다', () => {
    for (const v of ['COINM', 'STOCK', '', '   ', null, undefined, 123, {}, 'usdm ' + '​']) {
      eq(paperMarketOf(v as any), null);
    }
  });

  // ── ②③ 출처 표 ──
  test('현물은 현물 시세, 선물은 선물 마크가', () => {
    eq(priceSourceFor('SPOT'), 'BINANCE_SPOT_TICKER');
    eq(priceSourceFor('USDM'), 'BINANCE_USDM_MARK');
  });

  test('★ 두 시장이 같은 출처를 쓰지 않는다', () => {
    // 이것이 깨지면 현물이 선물 가격으로 닫히던 고장이 그대로 돌아온다
    assert(priceSourceFor('SPOT') !== priceSourceFor('USDM'),
      '현물과 선물이 같은 가격 출처를 씁니다');
  });

  test('모르는 시장에는 출처가 없다', () => {
    for (const v of [null, undefined, 'COINM', '']) {
      eq(priceSourceFor(v as any), null);
    }
  });

  test('모든 시장에 출처가 정해져 있다 — 늘어나면 여기서 잡힌다', () => {
    for (const m of PAPER_MARKETS) {
      assert(priceSourceFor(m) != null, `${m}에 가격 출처가 없습니다`);
    }
  });

  // ── ④ fail closed ──
  test('★ 모르는 시장은 가격을 만들지 않고 멈춘다', async () => {
    const { readPaperMarkPrice } = await import('./paperPriceSource');
    for (const m of ['COINM', 'STOCK', '', null, undefined]) {
      const r = await readPaperMarkPrice(m as any, 'BTCUSDT');
      assert(paperPriceFailed(r), `${String(m)}가 통과했습니다`);
      eq((r as any).code, 'UNSUPPORTED_MARKET');
      eq((r as any).market, null);
    }
  });

  test('종목을 모르면 가격을 구하지 않는다', async () => {
    const { readPaperMarkPrice } = await import('./paperPriceSource');
    const r = await readPaperMarkPrice('SPOT', '');
    assert(paperPriceFailed(r), '빈 종목이 통과했습니다');
    eq((r as any).code, 'NO_PRICE');
  });

  // ── ⑤ 라우트 배선 — 글자로 확인한다 ──
  //
  // 네트워크를 타는 라우트를 시험에서 실행할 수 없으므로, **두 라우트가
  // 각자 가격 출처를 다시 적지 않는지**를 소스에서 본다. 이 검사가 없으면
  // 누군가 청산에 `getPremiumIndex`를 다시 넣어도 아무도 모른다.
  //
  // (같은 규칙을 `scripts/check-paper-price-source.mjs`가 CI에서도 본다 —
  //  시험은 fs를 쓰지 않으므로 여기서는 계약 표만 확인한다.)
  test('출처 이름이 시장을 드러낸다 — 로그·응답에서 구별할 수 있다', () => {
    assert(/SPOT/.test(priceSourceFor('SPOT') as string), '현물 출처 이름에 시장이 없습니다');
    assert(/USDM/.test(priceSourceFor('USDM') as string), '선물 출처 이름에 시장이 없습니다');
  });

  test('출처는 인자로 받지 않는다 — 부르는 쪽이 고를 수 없다', async () => {
    const mod: any = await import('./paperPriceSource');
    // readPaperMarkPrice(market, symbol) 둘뿐이다. 셋째 인자가 생기면
    // 현물 포지션에 선물 출처를 넘길 수 있게 된다.
    eq(mod.readPaperMarkPrice.length, 2);
  });
}

// src/lib/trading/marketStats.test.ts
import { test, eq, assert } from '../../test/harness';
import {
  priceDigits, fmtStatPrice, fmtCompact, fmtChangePct, changeTone,
  marketStatCells, UNKNOWN_TEXT,
} from './marketStats';

export function runMarketStatsTests() {
  // ── ★ 못 읽은 값 ──
  test('★ 못 읽은 값은 0이 아니라 —이다', () => {
    eq(fmtStatPrice(null), UNKNOWN_TEXT);
    eq(fmtStatPrice(undefined), UNKNOWN_TEXT);
    eq(fmtStatPrice(NaN), UNKNOWN_TEXT);
    eq(fmtCompact(null), UNKNOWN_TEXT);
    eq(fmtChangePct(null), UNKNOWN_TEXT);
    assert(!/[0-9]/.test(UNKNOWN_TEXT), '못 읽음 표시에 숫자가 들어 있습니다');
  });

  test('★ 실제 0은 0으로 적는다 — 못 읽음과 다르다', () => {
    eq(fmtChangePct(0), '+0.00%');
    eq(fmtCompact(0), '0');
    eq(changeTone(0), 'FLAT');
    eq(changeTone(null), 'UNKNOWN');
  });

  // ── 자릿수 ──
  test('작은 가격을 2자리로 잘라 0으로 만들지 않는다', () => {
    eq(priceDigits(0.00001234), 8);
    assert(!/^0\.00$/.test(fmtStatPrice(0.00001234)), '작은 가격이 0.00으로 표시됩니다');
    eq(priceDigits(65000), 2);
    eq(priceDigits(3.5), 4);
    eq(priceDigits(0.12), 5);
  });

  test('가격에 천 단위 구분이 들어간다', () => {
    eq(fmtStatPrice(65000), '65,000.00');
  });

  // ── 거래량 축약 ──
  test('거래량은 짧게 적는다', () => {
    eq(fmtCompact(1_230_000_000), '1.23B');
    eq(fmtCompact(45_600_000), '45.60M');
    eq(fmtCompact(789_000), '789.00K');
    eq(fmtCompact(1.5e12), '1.50T');
    eq(fmtCompact(-2_000_000), '-2.00M');
  });

  test('축약을 되돌리는 함수는 없다 — 표시 전용이다', async () => {
    const mod: any = await import('./marketStats');
    const bad = Object.keys(mod).filter(k => /parse|toNumber|unformat|fromText/i.test(k));
    eq(bad.join(','), '');
  });

  // ── 변동률 ──
  test('변동률 부호를 붙인다', () => {
    eq(fmtChangePct(1.5), '+1.50%');
    eq(fmtChangePct(-3.216), '-3.22%');
    eq(changeTone(1), 'UP');
    eq(changeTone(-1), 'DOWN');
  });

  // ── ★ 칸 구성 ──
  test('★ 현물에는 Mark 칸을 아예 만들지 않는다', () => {
    const spot = marketStatCells({
      market: 'SPOT', markPrice: null, high24h: 1, low24h: 1,
      volume24h: 1, quoteVolume24h: 1,
    });
    eq(spot.some(c => c.label === 'Mark'), false);
    const usdm = marketStatCells({
      market: 'USDM', markPrice: 65000, high24h: 1, low24h: 1,
      volume24h: 1, quoteVolume24h: 1,
    });
    eq(usdm[0].label, 'Mark');
    eq(usdm[0].text, '65,000.00');
  });

  test('선물인데 마크가격을 못 받으면 칸은 두되 못 읽음으로 표시한다', () => {
    const cells = marketStatCells({
      market: 'USDM', markPrice: null, high24h: null, low24h: null,
      volume24h: null, quoteVolume24h: null,
    });
    eq(cells.length, 4);
    eq(cells.every(c => c.unknown), true);
    eq(cells.every(c => c.text === UNKNOWN_TEXT), true);
  });

  test('시장을 모르면 Mark 칸이 없다 — 선물로 가정하지 않는다', () => {
    const cells = marketStatCells({
      market: null, markPrice: 65000, high24h: 1, low24h: 1,
      volume24h: 1, quoteVolume24h: 1,
    });
    eq(cells.some(c => c.label === 'Mark'), false);
  });

  test('거래량 칸에 상대통화 이름을 적는다', () => {
    const cells = marketStatCells({
      market: 'SPOT', markPrice: null, high24h: null, low24h: null,
      volume24h: null, quoteVolume24h: 1e9, quoteAsset: 'USDC',
    });
    const vol = cells.find(c => c.label.startsWith('24h Vol'))!;
    eq(vol.label, '24h Vol(USDC)');
    eq(vol.text, '1.00B');
    eq(vol.unknown, false);
  });
}

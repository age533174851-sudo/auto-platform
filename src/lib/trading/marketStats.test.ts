// src/lib/trading/marketStats.test.ts
import { readFileSync } from 'fs';
import { resolve } from 'path';
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

  test('반올림이 1000에 닿으면 다음 단위로 올린다 — 1000.00K로 적지 않는다', () => {
    eq(fmtCompact(999_999), '1.00M');
    eq(fmtCompact(999_995), '1.00M');
    eq(fmtCompact(999_994), '999.99K');
    eq(fmtCompact(999_999_999), '1.00B');
    eq(fmtCompact(999_999_999_999), '1.00T');
    eq(fmtCompact(999.999), '1.00K');
    eq(fmtCompact(-999_999), '-1.00M');
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

  // ── ★ 같은 판단을 두 곳에 두지 않는다 ──
  //
  // #642는 `fmtCompact`만 고쳤다. 종목 검색 목록(`SymbolSearch.tsx`)은
  // 자기 `fmtVol`을 따로 갖고 있어서 999,999를 여전히 `1000.00K`로 적었다.
  // .tsx는 시험 러너가 컴파일하지 않으므로, 목록이 **이 함수를 쓰는지**를
  // 원문으로 확인한다 — 자기 사본이 다시 생기면 여기서 갈린다.
  test('★ 종목 검색 목록의 거래량도 fmtCompact 하나로 적는다 — 1000.00K 사본 금지', () => {
    const src = readFileSync(
      resolve(__dirname, '../../components/terminal/SymbolSearch.tsx'), 'utf8');
    assert(/import\s*\{[^}]*\bfmtCompact\b[^}]*\}\s*from\s*'@\/lib\/trading\/marketStats'/.test(src),
      'SymbolSearch가 marketStats의 fmtCompact를 가져와야 한다');
    assert(!/\.toFixed\(\d\)\}[KMB]/.test(src),
      'SymbolSearch에 K/M/B 축약을 직접 만드는 사본이 남아 있으면 안 된다');
  });
}

// src/lib/products/registry.ts
//
// **이 플랫폼이 어떤 제품을 실제로 다룰 수 있는가 — 한 곳에서 답한다.**
//
// 왜 필요한가
// ───────────
// 제품을 늘리려 할 때 가장 쉬운 사고는 **탭부터 만드는 것**이다. 옵션 탭을
// 그려 놓고 "체인은 나중에 붙이지" 하는 순간, 사용자는 **누를 수 있는 것을
// 되는 것으로 읽는다.** 이 저장소에는 그렇게 들어온 값이 이미 여럿 있었다 —
// 손으로 적은 시가총액, 지어낸 뉴스 기사, `AutoBotLabPage`의 ROE 11.2.
//
// `trading/capability.ts`와 무엇이 다른가
// ───────────────────────────────────────
// 그 파일은 **모의 주문 한 건 안에서** 무엇을 고를 수 있는지 답한다 —
// 지정가인가, 배율이 있는가, 부분청산이 되는가. 그 질문은 이미 "이 제품은
// 거래된다"를 전제한다.
//
// 이 파일은 그 앞 질문이다: **이 제품이 이 저장소에 존재하기는 하는가.**
//
//   registry.ts            제품이 거래 가능한가        (SPOT_CRYPTO · OPTIONS …)
//   trading/capability.ts  그 주문에서 무엇이 되는가   (TYPE_LIMIT · LEVERAGE …)
//
// 둘을 합치지 않는다. 합치면 "옵션의 부분청산"처럼 **앞 질문이 거짓인데 뒤
// 질문에 답이 있는** 칸이 생기고, 그 칸은 반드시 언젠가 화면에 나온다.
//
// 판정을 한 칸으로 뭉개지 않는다
// ──────────────────────────────
// "현물 주식 = 지원"은 거짓이다. 시세는 오고(finnhub/eodhd), 실계좌 주문도
// 나가지만(KIS), **모의가 없고 호가단위 검증도 없다.** 한 칸으로 적으면
// 셋 중 무엇이 참인지 알 수 없다. 축마다 따로 적는다.
//
// 근거 없는 판정을 적지 않는다
// ────────────────────────────
// 모든 칸에 **파일:줄** 근거가 붙는다. 사람이 그 줄을 열어 확인할 수 있어야
// 하고, 근거가 없으면 그 칸은 판정이 아니다.

/** 이 저장소가 이름을 아는 제품. **여기 없는 것은 없는 것이다.** */
export type ProductId =
  | 'SPOT_CRYPTO'
  | 'PERP_CRYPTO'
  | 'SPOT_STOCK'
  | 'PERP_STOCK'
  | 'PERP_COMMODITY'
  | 'OPTIONS'
  | 'ONCHAIN'
  | 'CONVERT';

export const PRODUCTS: readonly ProductId[] = [
  'SPOT_CRYPTO', 'PERP_CRYPTO', 'SPOT_STOCK', 'PERP_STOCK',
  'PERP_COMMODITY', 'OPTIONS', 'ONCHAIN', 'CONVERT',
] as const;

/**
 * 무엇을 따로 묻는가.
 *
 * 한 축이 참이어도 나머지가 거짓일 수 있다 — 주식이 정확히 그렇다.
 */
import type { VenueId } from '../markets/venueSpec';

export type CapabilityAxis =
  /** 이 제품의 시세·봉·호가를 **실제 출처**에서 읽는가 */
  | 'MARKET_DATA'
  /** 주문을 실제로 내보내는 경로가 있는가 */
  | 'EXECUTION'
  /** 이 제품의 계좌·잔고 정본이 있는가 */
  | 'ACCOUNT'
  /** 보유·포지션을 읽는 정본이 있는가 */
  | 'HOLDINGS'
  /** 수량·가격 단위(계약 명세)를 읽어 주문에 반영하는가 */
  | 'PRECISION'
  /** 모의로 거래되는가 */
  | 'PAPER'
  /** 실계좌로 거래되는가 */
  | 'LIVE'
  /** 사용자가 화면에서 거기까지 **닿는가** */
  | 'UI_WIRING';

export const AXES: readonly CapabilityAxis[] = [
  'MARKET_DATA', 'EXECUTION', 'ACCOUNT', 'HOLDINGS',
  'PRECISION', 'PAPER', 'LIVE', 'UI_WIRING',
] as const;

/**
 * 판정 어휘. **"미지원" 한 단어로 뭉개지 않는다** — 무엇이 없어서 안 되는지가
 * 다음에 무엇을 만들지를 정한다.
 */
export type Verdict =
  /** 코드 경로가 끝까지 있고 근거로 가리킬 수 있다 */
  | 'SUPPORTED'
  /** 서버 경로·모델이 없다 (라우트·어댑터·장부가 없음) */
  | 'BACKEND_GAP'
  /** 데이터 출처가 없거나 mock이다 */
  | 'DATA_GAP'
  /** 거래소 규격(계약·호가·최소수량)을 읽지 않는다 */
  | 'VENUE_GAP';

export interface Capability {
  verdict: Verdict;
  /** **파일:줄.** 사람이 열어 확인할 수 있어야 한다 */
  evidence: string;
  /** 한 줄 설명. 화면에 그대로 쓸 수 있다 */
  note: string;
}

/** 못 하는가 — 타입 가드 (`strict: false`에서 판별이 안 좁혀진다) */
export function lacking(c: Capability): boolean {
  return c.verdict !== 'SUPPORTED';
}

const cap = (verdict: Verdict, evidence: string, note: string): Capability =>
  ({ verdict, evidence, note });

// ══════════════════════════════════════════════════════════════
//  판정표
//
//  각 칸의 근거는 2026-09-20 main `8019f00e` 기준으로 **파일을 열어
//  확인한 것**이다. 줄이 밀리면 검사기가 잡는다(`check-product-registry`).
// ══════════════════════════════════════════════════════════════

const TABLE: Record<ProductId, Record<CapabilityAxis, Capability>> = {
  // ── 현물 코인 — 이 저장소에서 가장 완성된 제품 ──
  SPOT_CRYPTO: {
    MARKET_DATA: cap('SUPPORTED', 'src/lib/engine/paperPriceSource.ts:44',
      '바이낸스 현물 시세를 읽습니다'),
    EXECUTION: cap('SUPPORTED', 'src/app/api/paper/order/route.ts:16',
      '모의는 paper_open_position, 실계좌는 /api/binance/spot/order로 나갑니다'),
    ACCOUNT: cap('SUPPORTED', 'src/lib/engine/paperScope.ts:111',
      '기본 PAPER 계좌와 챌린지 전용 계좌를 서버가 정합니다'),
    HOLDINGS: cap('SUPPORTED', 'src/app/api/paper/holdings/route.ts:40',
      'paper_holdings가 lot 단위로 집계합니다 (088)'),
    // ★ 여기가 "지원"이라고 적으면 거짓이 되는 자리다.
    PRECISION: cap('VENUE_GAP', 'src/lib/exchanges/gateSpotPlan.ts:168',
      '바이낸스 현물은 닫혔지만(4B-2A) Gate 현물은 지정가를 호가 단위에 '
      + '맞추지 않고 그대로 보냅니다 — 제품 칸은 가장 약한 venue를 따릅니다'),
    PAPER: cap('SUPPORTED', 'src/app/api/paper/sell/route.ts:99',
      '매수·부분매도·전량매도가 모두 모의 장부에 적힙니다'),
    LIVE: cap('SUPPORTED', 'src/app/api/binance/spot/order/route.ts',
      '거래소 연결이 있으면 실제 주문이 나갑니다'),
    UI_WIRING: cap('SUPPORTED', 'src/components/trading/PaperOrderScreen.tsx',
      '종목 상세 → 주문 화면 → 체결 → 보유 → 매도까지 닿습니다'),
  },

  // ── 코인 무기한 — 서버는 되는데 정밀도만 한쪽에 있다 ──
  PERP_CRYPTO: {
    MARKET_DATA: cap('SUPPORTED', 'src/lib/engine/paperPriceSource.ts:44',
      'USDM 마크가를 읽습니다'),
    EXECUTION: cap('SUPPORTED', 'src/app/api/binance/futures/order/route.ts:160',
      '실계좌는 바이낸스 선물, 모의는 paper_open_position입니다'),
    ACCOUNT: cap('SUPPORTED', 'src/app/api/binance/futures/account/route.ts',
      '선물 계좌 잔고·포지션을 읽습니다'),
    HOLDINGS: cap('SUPPORTED', 'src/app/api/paper/positions/route.ts',
      '모의 포지션은 paper_positions, 실계좌는 거래소 포지션입니다'),
    // 실계좌 선물만 규격을 읽는다. 모의는 안 읽는다 — 한 칸으로 못 적는다.
    PRECISION: cap('VENUE_GAP', 'src/app/api/binance/futures/order/route.ts:160',
      '실계좌 선물만 quantizeOrder를 거칩니다 — 모의 경로는 규격을 읽지 않습니다'),
    PAPER: cap('SUPPORTED', 'src/lib/trading/capability.ts:202',
      'USDM 모의 주문이 배선돼 있습니다'),
    LIVE: cap('SUPPORTED', 'src/app/api/binance/futures/order/route.ts',
      '레버리지·마진모드·TP/SL까지 실계좌 경로가 있습니다'),
    UI_WIRING: cap('SUPPORTED', 'src/components/trading/TradingWorkspace.tsx',
      '정본 거래 화면에서 주문할 수 있습니다'),
  },

  // ── 현물 주식 — 축마다 답이 다른 대표 사례 ──
  SPOT_STOCK: {
    MARKET_DATA: cap('SUPPORTED', 'src/app/api/stocks/route.ts:70',
      'finnhub → eodhd 순으로 실제 시세를 읽습니다'),
    EXECUTION: cap('SUPPORTED', 'src/app/api/stock/order/route.ts:57',
      '한국투자증권(KIS) 연결로만 주문이 나갑니다'),
    ACCOUNT: cap('SUPPORTED', 'src/lib/exchanges/kis.ts',
      'KIS 잔고를 읽습니다'),
    HOLDINGS: cap('SUPPORTED', 'src/lib/exchanges/kis.ts',
      'KIS 보유 종목을 읽습니다'),
    PRECISION: cap('VENUE_GAP', 'src/app/api/stock/order/route.ts',
      '호가단위·최소주문수량을 읽지 않습니다'),
    // ★ LIVE와 PAPER를 한 칸으로 뭉개면 이 사실이 사라진다.
    PAPER: cap('BACKEND_GAP', 'src/lib/engine/paperPriceSource.ts:44',
      '모의 장부가 다루는 시장은 SPOT·USDM뿐입니다 — 주식 모의가 없습니다'),
    LIVE: cap('SUPPORTED', 'src/components/terminal/StockOrderPanel.tsx:91',
      '증권사 연결이 있으면 실제 주문이 나갑니다'),
    UI_WIRING: cap('SUPPORTED', 'src/components/terminal/OrderPane.tsx:2616',
      'marketType이 STOCK이면 주식 주문판이 뜹니다'),
  },

  // ── 주식 무기한 — 이름조차 없다 ──
  PERP_STOCK: {
    MARKET_DATA: cap('DATA_GAP', 'src/lib/markets/marketType.ts:22',
      '시장 타입에 주식 무기한이 없습니다'),
    EXECUTION: cap('BACKEND_GAP', 'src/app/api',
      '주식 무기한을 받는 라우트가 없습니다'),
    ACCOUNT: cap('BACKEND_GAP', 'src/lib/exchanges',
      '이 제품을 다루는 어댑터가 없습니다'),
    HOLDINGS: cap('BACKEND_GAP', 'src/app/api',
      '포지션을 읽는 경로가 없습니다'),
    PRECISION: cap('VENUE_GAP', 'src/lib/markets/contractSpec.ts:39',
      '계약 명세를 공급하는 곳이 없습니다'),
    PAPER: cap('BACKEND_GAP', 'src/lib/engine/paperPriceSource.ts:44',
      '모의 시장에 없습니다'),
    LIVE: cap('BACKEND_GAP', 'src/lib/exchanges',
      '실계좌 경로가 없습니다'),
    UI_WIRING: cap('BACKEND_GAP', 'src/app/page.tsx:234',
      '화면에 이 제품으로 가는 길이 없습니다'),
  },

  // ── 원자재 무기한 — 계약 명세 *형식*만 있고 공급자가 없다 ──
  PERP_COMMODITY: {
    MARKET_DATA: cap('DATA_GAP', 'src/lib/markets/marketType.ts:22',
      '시장 타입에 원자재 무기한이 없습니다'),
    EXECUTION: cap('BACKEND_GAP', 'src/app/api',
      '원자재를 받는 주문 라우트가 없습니다'),
    ACCOUNT: cap('BACKEND_GAP', 'src/lib/exchanges',
      '어댑터가 없습니다'),
    HOLDINGS: cap('BACKEND_GAP', 'src/app/api',
      '포지션 경로가 없습니다'),
    // ★ `ContractSpec`이 있다고 지원으로 읽지 않는다. 타입은 **모양**이고,
    //   그 모양을 채울 공급자가 없으면 수량을 만들 수 없다.
    PRECISION: cap('VENUE_GAP', 'src/lib/markets/contractSpec.ts:39',
      'ContractSpec 타입은 있지만 원자재 배수를 주는 공급자가 없습니다'),
    PAPER: cap('BACKEND_GAP', 'src/lib/engine/paperPriceSource.ts:44',
      '모의 시장에 없습니다'),
    LIVE: cap('BACKEND_GAP', 'src/lib/exchanges',
      '실계좌 경로가 없습니다'),
    UI_WIRING: cap('BACKEND_GAP', 'src/app/page.tsx:234',
      '화면에 길이 없습니다'),
  },

  // ── 옵션 — 체인이 없으면 시작할 수 없다 ──
  OPTIONS: {
    // 옵션은 심볼 하나에 가격 하나가 아니다. 만기 × 행사가 × 콜풋이 있어야
    // 비로소 "무엇을 사는지"가 정해진다. 그 표가 없으면 시세도 없다.
    MARKET_DATA: cap('DATA_GAP', 'src/app/api',
      '만기·행사가·콜풋·IV를 주는 옵션 체인 출처가 없습니다'),
    EXECUTION: cap('BACKEND_GAP', 'src/app/api',
      '옵션 주문 라우트가 없습니다'),
    ACCOUNT: cap('BACKEND_GAP', 'src/lib/exchanges',
      '옵션 계좌를 읽는 어댑터가 없습니다'),
    HOLDINGS: cap('BACKEND_GAP', 'src/app/api',
      '옵션 보유를 읽는 경로가 없습니다'),
    PRECISION: cap('VENUE_GAP', 'src/lib/markets/contractSpec.ts:39',
      '계약 배수·틱·결제 방식을 주는 곳이 없습니다'),
    PAPER: cap('BACKEND_GAP', 'src/lib/engine/paperPriceSource.ts:44',
      '모의 시장에 없습니다'),
    LIVE: cap('BACKEND_GAP', 'src/lib/exchanges',
      '실계좌 경로가 없습니다'),
    UI_WIRING: cap('BACKEND_GAP', 'src/app/page.tsx:234',
      '화면에 길이 없습니다'),
  },

  // ── 온체인 — ★ 분석 화면이지 거래 제품이 아니다 ──
  ONCHAIN: {
    // `/api/onchain`은 응답에 `source:'mock'`을 스스로 적는다. 주석도
    // "replace with Glassnode/CryptoQuant"라고 적혀 있다. mock을 시세
    // 권위로 승격하면, 그 위에 올라가는 모든 판단이 지어낸 값이 된다.
    MARKET_DATA: cap('DATA_GAP', 'src/app/api/onchain/route.ts:44',
      '응답이 스스로 source:"mock"이라고 적습니다 — 실제 출처가 아닙니다'),
    EXECUTION: cap('BACKEND_GAP', 'src/app/api/onchain/route.ts:5',
      '체인에 주문을 내보내는 경로가 없습니다 (분석용 읽기 전용)'),
    ACCOUNT: cap('BACKEND_GAP', 'src/lib/exchanges',
      '지갑 서명·잔고 권위가 없습니다'),
    HOLDINGS: cap('BACKEND_GAP', 'src/app/api/onchain/route.ts:5',
      '온체인 보유를 읽는 경로가 없습니다'),
    PRECISION: cap('VENUE_GAP', 'src/app/api/onchain/route.ts:5',
      '토큰 소수·최소 단위 권위가 없습니다'),
    PAPER: cap('BACKEND_GAP', 'src/lib/engine/paperPriceSource.ts:44',
      '모의 시장에 없습니다'),
    LIVE: cap('BACKEND_GAP', 'src/app/api/onchain/route.ts:5',
      '실제 체결 경로가 없습니다'),
    UI_WIRING: cap('BACKEND_GAP', 'src/app/page.tsx:234',
      '거래 화면으로 가는 길이 없습니다 (분석 표시만)'),
  },

  // ── 컨버트 — 호가도 체결도 없다 ──
  CONVERT: {
    MARKET_DATA: cap('BACKEND_GAP', 'src/app/api',
      '전환 견적(quote)을 주는 경로가 없습니다'),
    EXECUTION: cap('BACKEND_GAP', 'src/app/api',
      '전환 체결 경로가 없습니다'),
    ACCOUNT: cap('BACKEND_GAP', 'src/lib/exchanges',
      '전환 계좌 개념이 없습니다'),
    HOLDINGS: cap('BACKEND_GAP', 'src/app/api',
      '전환 결과를 적는 장부가 없습니다'),
    PRECISION: cap('VENUE_GAP', 'src/app/api',
      '최소 전환 수량·단위 권위가 없습니다'),
    PAPER: cap('BACKEND_GAP', 'src/lib/engine/paperPriceSource.ts:44',
      '모의 시장에 없습니다'),
    LIVE: cap('BACKEND_GAP', 'src/lib/exchanges',
      '실계좌 경로가 없습니다'),
    UI_WIRING: cap('BACKEND_GAP', 'src/app/page.tsx:234',
      '화면에 길이 없습니다'),
  },
};

/** 밖에서 온 값을 제품으로 읽는다. **모르면 null** — 기본값을 만들지 않는다. */
export function readProductId(raw: any): ProductId | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toUpperCase();
  return (PRODUCTS as readonly string[]).includes(v) ? v as ProductId : null;
}

/**
 * 이 제품의 이 축은 어떤가.
 *
 * **모르는 제품·모르는 축은 막는다.** 여기서 기본값을 지원 쪽으로 두면
 * 오타 하나가 새 제품을 열어 버린다 — 이 저장소가 마진 모드에서 이미 겪은
 * 고장과 같은 모양이다(`CROSSSED` 오타가 조용히 격리로 바뀌었다).
 */
export function productCapability(product: any, axis: any): Capability {
  const p = readProductId(product);
  if (!p) {
    return cap('BACKEND_GAP', 'src/lib/products/registry.ts',
      `모르는 제품입니다 (${String(product ?? '없음')})`);
  }
  if (!(AXES as readonly string[]).includes(axis)) {
    return cap('BACKEND_GAP', 'src/lib/products/registry.ts',
      `모르는 능력 축입니다 (${String(axis ?? '없음')})`);
  }
  return TABLE[p][axis as CapabilityAxis];
}

/** 한 제품의 전체 표 — 화면·문서가 한 번에 읽는다. */
export function productCapabilities(product: ProductId): Record<CapabilityAxis, Capability> {
  const out = {} as Record<CapabilityAxis, Capability>;
  for (const a of AXES) out[a] = productCapability(product, a);
  return out;
}

// ══════════════ 거래 가능한가 ══════════════

export type Tradability =
  /** 지금 이 제품으로 주문할 수 있다 */
  | 'TRADABLE'
  /** 능력이 모자란다. **화면에 열지 않는다** */
  | 'LOCKED';

export interface TradabilityState {
  state: Tradability;
  /** 사용자에게 보여 줄 한 줄 */
  reason: string;
  /** 무엇이 모자란지 — 다음에 무엇을 만들지를 정한다 */
  missing: CapabilityAxis[];
  /** 모의만 되는가 / 실계좌만 되는가 */
  paper: boolean;
  live: boolean;
}

/**
 * 거래에 **반드시** 있어야 하는 축.
 *
 * `PRECISION`은 여기 없다 — 넣으면 현물 코인까지 LOCKED가 되고, 그건
 * 사실과 다르다(모의 거래는 실제로 된다). 대신 `precisionProven`으로
 * **따로** 말한다. 없는 것을 있다고도, 되는 것을 안 된다고도 적지 않는다.
 */
const REQUIRED: readonly CapabilityAxis[] =
  ['MARKET_DATA', 'EXECUTION', 'ACCOUNT', 'HOLDINGS', 'UI_WIRING'] as const;

/**
 * 이 제품을 화면에 열어도 되는가.
 *
 * **모르는 제품은 LOCKED다.** 기본값이 열림이면, 제품 이름을 잘못 적은
 * 화면이 조용히 거래 가능해진다.
 */
export function productTradability(product: any): TradabilityState {
  const p = readProductId(product);
  if (!p) {
    return {
      state: 'LOCKED', missing: [...AXES], paper: false, live: false,
      reason: `모르는 제품입니다 (${String(product ?? '없음')})`,
    };
  }
  const caps = productCapabilities(p);
  const missing = REQUIRED.filter(a => lacking(caps[a]));
  const paper = caps.PAPER.verdict === 'SUPPORTED';
  const live = caps.LIVE.verdict === 'SUPPORTED';

  if (missing.length > 0) {
    return {
      state: 'LOCKED', missing, paper, live,
      reason: caps[missing[0]].note,
    };
  }
  // 필수 축이 다 있어도 **거래할 장부가 하나도 없으면** 열지 않는다.
  if (!paper && !live) {
    return {
      state: 'LOCKED', missing: ['PAPER', 'LIVE'], paper, live,
      reason: '모의로도 실계좌로도 주문할 수 없습니다',
    };
  }
  return {
    state: 'TRADABLE', missing: [], paper, live,
    reason: paper && live ? '모의·실계좌 모두 주문할 수 있습니다'
      : paper ? '모의로 주문할 수 있습니다' : '실계좌로만 주문할 수 있습니다',
  };
}

/**
 * **거래소 규격까지 증명됐는가.**
 *
 * 거래가 된다는 것과 거래소 규칙을 지킨다는 것은 다른 사실이다. 이것을
 * `TRADABLE`에 섞으면 둘 중 하나가 거짓이 된다 — 섞어서 막으면 되는 것을
 * 안 된다고 적고, 섞어서 열면 "거래소 규칙까지 지원"이라고 과장하게 된다.
 *
 * 화면은 이 값이 false면 **그 사실을 적는다.** 숨기지 않는다.
 */
export function precisionProven(product: any): boolean {
  return productCapability(product, 'PRECISION').verdict === 'SUPPORTED';
}

// ══════════════ 규격은 venue마다 다르다 (Phase 4B-1) ══════════════
//
// 8×8 표의 한계가 여기서 드러났다. "코인 무기한의 규격"은 한 칸으로
// 답할 수 없다 — 바이낸스 USDT-M은 LOT_SIZE·MARKET_LOT_SIZE·PRICE_FILTER·
// MIN_NOTIONAL을 전부 읽고, 같은 제품의 COIN-M은 계약배수만 있고 격자가
// 없다. 한 칸으로 적으면 둘 중 하나가 거짓이 된다.
//
// 그래서 **제품 아래에 venue 층을 둔다.** 그리고 제품 칸은 그 venue들 중
// **가장 약한 것**을 따른다 — 일부만 증명하고 제품 전체를 올리는 일이
// 구조적으로 불가능해진다.

export interface VenuePrecision {
  venue: VenueId;
  verdict: Verdict;
  evidence: string;
  note: string;
}

/**
 * 제품별 venue 규격 판정.
 *
 * **여기 없는 venue는 그 제품에서 다루지 않는다는 뜻이 아니라, 규격을
 * 아직 감사하지 않았다는 뜻이다.** 그 구별이 필요해지면 그때 축을 늘린다.
 */
const VENUE_PRECISION: Partial<Record<ProductId, VenuePrecision[]>> = {
  SPOT_CRYPTO: [
    {
      venue: 'BINANCE_SPOT', verdict: 'SUPPORTED',
      evidence: 'src/lib/exchanges/spotOrderExecutor.ts:188',
      note: '네 필터를 읽어 normalizeForVenue로 맞춥니다 — 주문유형별 격자·'
        + '호가단위·최소명목가까지. 못 읽으면 지어내지 않고 안 맞췄다고 적습니다',
    },
    {
      // ★ **이 줄이 없으면 제품 칸이 거짓이 된다.**
      //
      //   Gate 현물도 `placeSpotOrder`를 지나 실계좌로 나간다
      //   (`spotOrderExecutor.ts`의 `exchange === 'gate'` 갈래). 바이낸스
      //   하나만 적어 두고 그것을 SUPPORTED로 올리면 `allVenuesPrecise`가
      //   참이 되어, **감사한 적 없는 venue가 증명된 것으로 읽힌다.**
      venue: 'GATE_SPOT', verdict: 'VENUE_GAP',
      evidence: 'src/lib/exchanges/gateSpotPlan.ts:149',
      note: '수량 소수자리(amount_precision)와 최소 주문은 어댑터가 적용하지만, '
        + '가격 정밀도 출처가 없고 4B-2A 범위에서 감사하지 않았습니다',
    },
  ],
  PERP_CRYPTO: [
    {
      // ★ 이 저장소에서 유일하게 끝까지 닫힌 경로다.
      venue: 'BINANCE_USDM', verdict: 'SUPPORTED',
      evidence: 'src/app/api/binance/futures/order/route.ts:160',
      note: '네 필터를 각각 읽고 quantizeOrder로 맞춥니다 — 못 읽으면 지어내지 않습니다',
    },
    {
      venue: 'BINANCE_COINM', verdict: 'VENUE_GAP',
      evidence: 'src/lib/markets/coinM.ts:62',
      note: '계약배수만 권위가 있고 수량·가격 격자가 없습니다',
    },
    {
      venue: 'GATE_USDM', verdict: 'VENUE_GAP',
      evidence: 'src/lib/exchanges/gatePlan.ts:279',
      note: '계약 수 격자는 있지만 가격 단위가 없습니다',
    },
  ],
  SPOT_STOCK: [
    {
      venue: 'KIS_KR', verdict: 'VENUE_GAP',
      evidence: 'src/lib/exchanges/kisCore.ts:220',
      note: '수량 1주 단위는 실행 직전에 강제되지만 호가단위 출처가 없습니다',
    },
    {
      venue: 'KIS_US', verdict: 'VENUE_GAP',
      evidence: 'src/app/api/stock/order/route.ts',
      note: '국내/해외 주문 경로가 분리되어 있지 않아 따로 증명할 수 없습니다',
    },
  ],
};

/** 이 제품이 다루는 venue별 규격 판정. 감사하지 않은 제품은 빈 목록이다. */
export function venuePrecisions(product: any): VenuePrecision[] {
  const p = readProductId(product);
  if (!p) return [];
  return VENUE_PRECISION[p] ?? [];
}

/**
 * **제품 규격은 가장 약한 venue를 따른다.**
 *
 * 바이낸스 USDT-M 하나가 닫혔다고 "코인 무기한은 규격까지 지원"이라고
 * 적으면, COIN-M으로 주문하는 사용자에게 거짓말이 된다.
 *
 * venue를 하나도 감사하지 않았으면 `false`다 — 모르는 것을 통과로 읽지
 * 않는다.
 */
export function allVenuesPrecise(product: any): boolean {
  const vs = venuePrecisions(product);
  if (vs.length === 0) return false;
  return vs.every(v => v.verdict === 'SUPPORTED');
}

/** 아직 규격이 닫히지 않은 venue와 그 이유 — 다음에 무엇을 할지 정한다. */
export function precisionGaps(product: any): VenuePrecision[] {
  return venuePrecisions(product).filter(v => v.verdict !== 'SUPPORTED');
}

/** 지금 거래 가능한 제품만. 화면 목록이 손으로 다시 적지 않게 한다. */
export function tradableProducts(): ProductId[] {
  return PRODUCTS.filter(p => productTradability(p).state === 'TRADABLE');
}

/** 잠긴 제품과 그 이유 — 사용자에게 "왜 없는지"를 말할 수 있게. */
export function lockedProducts(): { product: ProductId; reason: string; missing: CapabilityAxis[] }[] {
  return PRODUCTS
    .map(p => ({ product: p, ...productTradability(p) }))
    .filter(r => r.state === 'LOCKED')
    .map(({ product, reason, missing }) => ({ product, reason, missing }));
}

export const PRODUCT_LABEL: Record<ProductId, string> = {
  SPOT_CRYPTO: '코인 현물',
  PERP_CRYPTO: '코인 무기한',
  SPOT_STOCK: '주식 현물',
  PERP_STOCK: '주식 무기한',
  PERP_COMMODITY: '원자재 무기한',
  OPTIONS: '옵션',
  ONCHAIN: '온체인',
  CONVERT: '컨버트',
};

export const AXIS_LABEL: Record<CapabilityAxis, string> = {
  MARKET_DATA: '시세',
  EXECUTION: '주문 경로',
  ACCOUNT: '계좌',
  HOLDINGS: '보유·포지션',
  PRECISION: '거래소 규격',
  PAPER: '모의',
  LIVE: '실계좌',
  UI_WIRING: '화면 배선',
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  SUPPORTED: '됨',
  BACKEND_GAP: '서버 없음',
  DATA_GAP: '데이터 없음',
  VENUE_GAP: '규격 없음',
};

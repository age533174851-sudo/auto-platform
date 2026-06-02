/**
 * TRAIGO Logo Resolver
 * Universal asset logo resolution with multi-source fallback.
 *
 * ⚠️  Legal notice: logos are used solely for asset identification
 *     in an informational context. No endorsement implied.
 *
 * Fallback chain:
 *  1. Curated cryptologos.cc CDN (crypto — no API key)
 *  2. Curated Clearbit CDN   (stocks, ETFs)
 *  3. Financial Modeling Prep image (US stocks)
 *  4. Wikipedia SVG          (when available)
 *  5. Resolved initials      (always works)
 */

export interface LogoDef {
  primary:   string;
  fallbacks: string[];
  initials:  string;
  bg:        string;
}

export type AssetCategory =
  | 'crypto' | 'stock' | 'krstock' | 'etf'
  | 'index'  | 'commodity' | 'forex' | 'unknown';

// ─── Curated logo database ────────────────────────────────────────
const DB: Record<string, LogoDef> = {
  // ── Crypto (cryptologos.cc — no API key, permissive for informational use) ────
  BTC    : { primary:'https://cryptologos.cc/logos/bitcoin-btc-logo.png', fallbacks:[], initials:'BT', bg:'#F7931A' },
  ETH    : { primary:'https://cryptologos.cc/logos/ethereum-eth-logo.png', fallbacks:[], initials:'ET', bg:'#627EEA' },
  SOL    : { primary:'https://cryptologos.cc/logos/solana-sol-logo.png', fallbacks:[], initials:'SO', bg:'#9945FF' },
  BNB    : { primary:'https://cryptologos.cc/logos/bnb-bnb-logo.png', fallbacks:[], initials:'BN', bg:'#F3BA2F' },
  XRP    : { primary:'https://cryptologos.cc/logos/xrp-xrp-logo.png', fallbacks:[], initials:'XR', bg:'#346AA9' },
  DOGE   : { primary:'https://cryptologos.cc/logos/dogecoin-doge-logo.png', fallbacks:[], initials:'DO', bg:'#C2A633' },
  ADA    : { primary:'https://cryptologos.cc/logos/cardano-ada-logo.png', fallbacks:[], initials:'AD', bg:'#0D1E2D' },
  AVAX   : { primary:'https://cryptologos.cc/logos/avalanche-avax-logo.png', fallbacks:[], initials:'AV', bg:'#E84142' },
  TON    : { primary:'https://cryptologos.cc/logos/toncoin-ton-logo.png', fallbacks:[], initials:'TO', bg:'#0088CC' },
  LINK   : { primary:'https://cryptologos.cc/logos/chainlink-link-logo.png', fallbacks:[], initials:'LI', bg:'#2A5ADA' },
  DOT    : { primary:'https://cryptologos.cc/logos/polkadot-new-dot-logo.png', fallbacks:[], initials:'DO', bg:'#E6007A' },
  MATIC  : { primary:'https://cryptologos.cc/logos/polygon-matic-logo.png', fallbacks:[], initials:'MA', bg:'#8247E5' },
  UNI    : { primary:'https://cryptologos.cc/logos/uniswap-uni-logo.png', fallbacks:[], initials:'UN', bg:'#FF007A' },
  ARB    : { primary:'https://cryptologos.cc/logos/arbitrum-arb-logo.png', fallbacks:[], initials:'AR', bg:'#28A0F0' },
  OP     : { primary:'https://cryptologos.cc/logos/optimism-ethereum-op-logo.png', fallbacks:[], initials:'OP', bg:'#FF0420' },
  SUI    : { primary:'https://cryptologos.cc/logos/sui-sui-logo.png', fallbacks:[], initials:'SU', bg:'#4CA3FF' },
  SHIB   : { primary:'https://cryptologos.cc/logos/shiba-inu-shib-logo.png', fallbacks:[], initials:'SH', bg:'#FFA409' },
  PEPE   : { primary:'https://cryptologos.cc/logos/pepe-pepe-logo.png', fallbacks:[], initials:'PE', bg:'#3BA14C' },
  APT    : { primary:'https://cryptologos.cc/logos/aptos-apt-logo.png', fallbacks:[], initials:'AP', bg:'#00C7B2' },
  INJ    : { primary:'https://cryptologos.cc/logos/injective-inj-logo.png', fallbacks:[], initials:'IJ', bg:'#00F2FE' },
  LTC    : { primary:'https://cryptologos.cc/logos/litecoin-ltc-logo.png', fallbacks:[], initials:'LT', bg:'#BFBBBB' },
  BCH    : { primary:'https://cryptologos.cc/logos/bitcoin-cash-bch-logo.png', fallbacks:[], initials:'BC', bg:'#0AC18E' },
  ATOM   : { primary:'https://cryptologos.cc/logos/cosmos-atom-logo.png', fallbacks:[], initials:'AT', bg:'#2E3148' },
  NEAR   : { primary:'https://cryptologos.cc/logos/near-protocol-near-logo.png', fallbacks:[], initials:'NR', bg:'#000000' },
  FIL    : { primary:'https://cryptologos.cc/logos/filecoin-fil-logo.png', fallbacks:[], initials:'FL', bg:'#0090FF' },
    // ── US Stocks (Clearbit → FMP) ──────────────────────────────────
  AAPL:   { primary:'https://logo.clearbit.com/apple.com',             fallbacks:['https://financialmodelingprep.com/image-stock/AAPL.png'],  initials:'AP', bg:'#A0A0A0' },
  MSFT:   { primary:'https://logo.clearbit.com/microsoft.com',         fallbacks:['https://financialmodelingprep.com/image-stock/MSFT.png'],  initials:'MS', bg:'#00A4EF' },
  NVDA:   { primary:'https://logo.clearbit.com/nvidia.com',            fallbacks:['https://financialmodelingprep.com/image-stock/NVDA.png'],  initials:'NV', bg:'#76B900' },
  GOOGL:  { primary:'https://logo.clearbit.com/google.com',            fallbacks:['https://financialmodelingprep.com/image-stock/GOOGL.png'], initials:'GO', bg:'#4285F4' },
  GOOG:   { primary:'https://logo.clearbit.com/google.com',            fallbacks:[],                                                          initials:'GO', bg:'#4285F4' },
  AMZN:   { primary:'https://logo.clearbit.com/amazon.com',            fallbacks:['https://financialmodelingprep.com/image-stock/AMZN.png'],  initials:'AZ', bg:'#FF9900' },
  META:   { primary:'https://logo.clearbit.com/meta.com',              fallbacks:['https://financialmodelingprep.com/image-stock/META.png'],  initials:'MT', bg:'#0082FB' },
  TSLA:   { primary:'https://logo.clearbit.com/tesla.com',             fallbacks:['https://financialmodelingprep.com/image-stock/TSLA.png'],  initials:'TS', bg:'#CC0000' },
  AMD:    { primary:'https://logo.clearbit.com/amd.com',               fallbacks:['https://financialmodelingprep.com/image-stock/AMD.png'],   initials:'AM', bg:'#ED1C24' },
  INTC:   { primary:'https://logo.clearbit.com/intel.com',             fallbacks:['https://financialmodelingprep.com/image-stock/INTC.png'],  initials:'IN', bg:'#0071C5' },
  AVGO:   { primary:'https://logo.clearbit.com/broadcom.com',          fallbacks:['https://financialmodelingprep.com/image-stock/AVGO.png'],  initials:'BC', bg:'#CC0000' },
  QCOM:   { primary:'https://logo.clearbit.com/qualcomm.com',          fallbacks:['https://financialmodelingprep.com/image-stock/QCOM.png'],  initials:'QC', bg:'#3253DC' },
  TSM:    { primary:'https://logo.clearbit.com/tsmc.com',              fallbacks:['https://financialmodelingprep.com/image-stock/TSM.png'],   initials:'TM', bg:'#BB2A35' },
  ARM:    { primary:'https://logo.clearbit.com/arm.com',               fallbacks:[],                                                          initials:'AR', bg:'#00C0C0' },
  SMCI:   { primary:'https://logo.clearbit.com/supermicro.com',        fallbacks:[],                                                          initials:'SM', bg:'#006699' },
  PLTR:   { primary:'https://logo.clearbit.com/palantir.com',          fallbacks:['https://financialmodelingprep.com/image-stock/PLTR.png'],  initials:'PL', bg:'#000000' },
  PL:     { primary:'https://logo.clearbit.com/planet.com',            fallbacks:['https://financialmodelingprep.com/image-stock/PL.png'],    initials:'PL', bg:'#00A3E0' },
  NFLX:   { primary:'https://logo.clearbit.com/netflix.com',           fallbacks:['https://financialmodelingprep.com/image-stock/NFLX.png'],  initials:'NF', bg:'#E50914' },
  DIS:    { primary:'https://logo.clearbit.com/disney.com',            fallbacks:['https://financialmodelingprep.com/image-stock/DIS.png'],   initials:'DI', bg:'#113CCF' },
  JPM:    { primary:'https://logo.clearbit.com/jpmorganchase.com',     fallbacks:['https://financialmodelingprep.com/image-stock/JPM.png'],   initials:'JP', bg:'#006DAE' },
  GS:     { primary:'https://logo.clearbit.com/goldmansachs.com',      fallbacks:[],                                                          initials:'GS', bg:'#6C8EBF' },
  BAC:    { primary:'https://logo.clearbit.com/bankofamerica.com',     fallbacks:['https://financialmodelingprep.com/image-stock/BAC.png'],   initials:'BA', bg:'#E31837' },
  V:      { primary:'https://logo.clearbit.com/visa.com',              fallbacks:['https://financialmodelingprep.com/image-stock/V.png'],     initials:'VI', bg:'#1A1F71' },
  MA:     { primary:'https://logo.clearbit.com/mastercard.com',        fallbacks:['https://financialmodelingprep.com/image-stock/MA.png'],    initials:'MC', bg:'#EB001B' },
  PYPL:   { primary:'https://logo.clearbit.com/paypal.com',            fallbacks:['https://financialmodelingprep.com/image-stock/PYPL.png'],  initials:'PP', bg:'#009CDE' },
  COIN:   { primary:'https://logo.clearbit.com/coinbase.com',          fallbacks:['https://financialmodelingprep.com/image-stock/COIN.png'],  initials:'CB', bg:'#0052FF' },
  HOOD:   { primary:'https://logo.clearbit.com/robinhood.com',         fallbacks:['https://financialmodelingprep.com/image-stock/HOOD.png'],  initials:'RH', bg:'#00C805' },
  SOFI:   { primary:'https://logo.clearbit.com/sofi.com',              fallbacks:['https://financialmodelingprep.com/image-stock/SOFI.png'],  initials:'SF', bg:'#7B40F2' },
  MSTR:   { primary:'https://logo.clearbit.com/microstrategy.com',     fallbacks:[],                                                          initials:'MS', bg:'#E87426' },
  GME:    { primary:'https://logo.clearbit.com/gamestop.com',          fallbacks:[],                                                          initials:'GS', bg:'#E1373B' },
  RIVN:   { primary:'https://logo.clearbit.com/rivian.com',            fallbacks:['https://financialmodelingprep.com/image-stock/RIVN.png'],  initials:'RV', bg:'#3DD286' },
  WMT:    { primary:'https://logo.clearbit.com/walmart.com',           fallbacks:['https://financialmodelingprep.com/image-stock/WMT.png'],   initials:'WM', bg:'#0071CE' },
  COST:   { primary:'https://logo.clearbit.com/costco.com',            fallbacks:['https://financialmodelingprep.com/image-stock/COST.png'],  initials:'CO', bg:'#005DAA' },
  LLY:    { primary:'https://logo.clearbit.com/lilly.com',             fallbacks:['https://financialmodelingprep.com/image-stock/LLY.png'],   initials:'EL', bg:'#D52B1E' },
  JNJ:    { primary:'https://logo.clearbit.com/jnj.com',               fallbacks:['https://financialmodelingprep.com/image-stock/JNJ.png'],   initials:'JJ', bg:'#CC0000' },
  PFE:    { primary:'https://logo.clearbit.com/pfizer.com',            fallbacks:['https://financialmodelingprep.com/image-stock/PFE.png'],   initials:'PF', bg:'#0093D0' },
  UNH:    { primary:'https://logo.clearbit.com/unitedhealthgroup.com', fallbacks:[],                                                          initials:'UH', bg:'#316BBE' },
  BA:     { primary:'https://logo.clearbit.com/boeing.com',            fallbacks:['https://financialmodelingprep.com/image-stock/BA.png'],    initials:'BO', bg:'#1D4289' },
  LMT:    { primary:'https://logo.clearbit.com/lockheedmartin.com',    fallbacks:['https://financialmodelingprep.com/image-stock/LMT.png'],   initials:'LM', bg:'#003087' },
  NIO:    { primary:'https://logo.clearbit.com/nio.com',               fallbacks:['https://financialmodelingprep.com/image-stock/NIO.png'],   initials:'NI', bg:'#2BACE2' },
  NKE:    { primary:'https://logo.clearbit.com/nike.com',              fallbacks:['https://financialmodelingprep.com/image-stock/NKE.png'],   initials:'NK', bg:'#111111' },
  ORCL:   { primary:'https://logo.clearbit.com/oracle.com',            fallbacks:[],                                                          initials:'OR', bg:'#F80000' },
  CRM:    { primary:'https://logo.clearbit.com/salesforce.com',        fallbacks:[],                                                          initials:'SF', bg:'#00A1E0' },
  ADBE:   { primary:'https://logo.clearbit.com/adobe.com',             fallbacks:[],                                                          initials:'AD', bg:'#FF0000' },
  SNOW:   { primary:'https://logo.clearbit.com/snowflake.com',         fallbacks:[],                                                          initials:'SF', bg:'#29B5E8' },
  CRWD:   { primary:'https://logo.clearbit.com/crowdstrike.com',       fallbacks:[],                                                          initials:'CS', bg:'#E01A4F' },
  SHOP:   { primary:'https://logo.clearbit.com/shopify.com',           fallbacks:[],                                                          initials:'SH', bg:'#96BF48' },
  UBER:   { primary:'https://logo.clearbit.com/uber.com',              fallbacks:[],                                                          initials:'UB', bg:'#000000' },
  ABNB:   { primary:'https://logo.clearbit.com/airbnb.com',            fallbacks:[],                                                          initials:'AB', bg:'#FF5A5F' },
  SPOT:   { primary:'https://logo.clearbit.com/spotify.com',           fallbacks:[],                                                          initials:'SP', bg:'#1DB954' },
  PANW:   { primary:'https://logo.clearbit.com/paloaltonetworks.com',  fallbacks:[],                                                          initials:'PA', bg:'#00C0DF' },
  NET:    { primary:'https://logo.clearbit.com/cloudflare.com',        fallbacks:[],                                                          initials:'CF', bg:'#F48120' },
  // ── ETFs ──────────────────────────────────────────────────────────
  SPY:    { primary:'https://logo.clearbit.com/ssga.com',              fallbacks:[],                                                          initials:'SP', bg:'#1D4ED8' },
  QQQ:    { primary:'https://logo.clearbit.com/invesco.com',           fallbacks:[],                                                          initials:'QQ', bg:'#7C3AED' },
  IWM:    { primary:'https://logo.clearbit.com/ishares.com',           fallbacks:[],                                                          initials:'IW', bg:'#059669' },
  TQQQ:   { primary:'https://logo.clearbit.com/proshares.com',         fallbacks:[],                                                          initials:'TQ', bg:'#7C3AED' },
  SQQQ:   { primary:'https://logo.clearbit.com/proshares.com',         fallbacks:[],                                                          initials:'SQ', bg:'#DC2626' },
  SOXL:   { primary:'https://logo.clearbit.com/direxion.com',          fallbacks:[],                                                          initials:'SX', bg:'#EA580C' },
  SOXS:   { primary:'https://logo.clearbit.com/direxion.com',          fallbacks:[],                                                          initials:'SS', bg:'#DC2626' },
  ARKK:   { primary:'https://logo.clearbit.com/ark-invest.com',        fallbacks:[],                                                          initials:'AK', bg:'#7C3AED' },
  GLD:    { primary:'https://logo.clearbit.com/ssga.com',              fallbacks:[],                                                          initials:'GL', bg:'#D97706' },
  TLT:    { primary:'https://logo.clearbit.com/ishares.com',           fallbacks:[],                                                          initials:'TL', bg:'#1D4ED8' },
  IBIT:   { primary:'https://logo.clearbit.com/ishares.com',           fallbacks:[],                                                          initials:'IB', bg:'#F7931A' },
  BITO:   { primary:'https://logo.clearbit.com/proshares.com',         fallbacks:[],                                                          initials:'BI', bg:'#F59E0B' },
  // ── Korean stocks ─────────────────────────────────────────────────
  '005930': { primary:'https://logo.clearbit.com/samsung.com',         fallbacks:[],                                                          initials:'삼성', bg:'#1428A0' },
  '000660': { primary:'https://logo.clearbit.com/skhynix.com',         fallbacks:[],                                                          initials:'SK',   bg:'#EA1917' },
  '035420': { primary:'https://logo.clearbit.com/navercorp.com',       fallbacks:[],                                                          initials:'NV',   bg:'#03C75A' },
  '035720': { primary:'https://logo.clearbit.com/kakao.com',           fallbacks:[],                                                          initials:'KA',   bg:'#FEE500' },
  '005380': { primary:'https://logo.clearbit.com/hyundai.com',         fallbacks:[],                                                          initials:'HD',   bg:'#002C5F' },
  '000270': { primary:'https://logo.clearbit.com/kia.com',             fallbacks:[],                                                          initials:'KI',   bg:'#05141F' },
  '066570': { primary:'https://logo.clearbit.com/lg.com',              fallbacks:[],                                                          initials:'LG',   bg:'#A50034' },
  '051910': { primary:'https://logo.clearbit.com/lgchem.com',          fallbacks:[],                                                          initials:'LG',   bg:'#A50034' },
  '006400': { primary:'https://logo.clearbit.com/samsungsdi.com',      fallbacks:[],                                                          initials:'SDI',  bg:'#1428A0' },
  '207940': { primary:'https://logo.clearbit.com/samsungbiologics.com',fallbacks:[],                                                          initials:'SB',   bg:'#1428A0' },
  '373220': { primary:'https://logo.clearbit.com/lgenergysolution.com',fallbacks:[],                                                          initials:'LGE',  bg:'#A50034' },
  // ── Indices / Macro (no logo — initials only) ─────────────────────
  SPX:     { primary:'', fallbacks:[], initials:'SP',  bg:'#6366F1' },
  NDX:     { primary:'', fallbacks:[], initials:'ND',  bg:'#7C3AED' },
  DJI:     { primary:'', fallbacks:[], initials:'DJ',  bg:'#1D4ED8' },
  VIX:     { primary:'', fallbacks:[], initials:'VX',  bg:'#DC2626' },
  DXY:     { primary:'', fallbacks:[], initials:'DX',  bg:'#10B981' },
  XAUUSD:  { primary:'', fallbacks:[], initials:'AU',  bg:'#D97706' },
  XAGUSD:  { primary:'', fallbacks:[], initials:'AG',  bg:'#9CA3AF' },
  USOIL:   { primary:'', fallbacks:[], initials:'OI',  bg:'#78350F' },
  EURUSD:  { primary:'', fallbacks:[], initials:'EU',  bg:'#3B82F6' },
  USDJPY:  { primary:'', fallbacks:[], initials:'JP',  bg:'#EF4444' },
  USDKRW:  { primary:'', fallbacks:[], initials:'KR',  bg:'#F59E0B' },
};

// ─── Public API ───────────────────────────────────────────────────

/** Get LogoDef from curated DB */
export function getLogoEntry(ticker: string): LogoDef | null {
  const t = (ticker || '').trim();
  return DB[t.toUpperCase()] || DB[t] || null;
}

/** Detect asset category from ticker */
export function detectCategory(ticker: string): AssetCategory {
  const t = (ticker || '').toUpperCase().trim();
  if (/^\d{6}$/.test(t))                              return 'krstock';
  if (/^(BTC|ETH|SOL|BNB|XRP|DOGE|ADA|AVAX|TON|LINK|DOT|MATIC|UNI|ARB|OP|SUI|SHIB|PEPE|APT|INJ|LTC|BCH|ATOM|NEAR|FIL|ALGO|VET|EOS|XLM|TRX|HBAR|ICP|SAND|MANA|AXS|CHZ|GALA)$/.test(t)) return 'crypto';
  if (t.endsWith('USDT') || t.endsWith('USDC'))       return 'crypto';
  if (/^(SPY|QQQ|IWM|DIA|TLT|HYG|GLD|SLV|USO|TQQQ|SQQQ|SOXL|SOXS|ARKK|ARKG|BITO|IBIT)$/.test(t)) return 'etf';
  if (/^(SPX|NDX|DJI|VIX|KOSPI|N225|DAX|FTSE)$/.test(t)) return 'index';
  if (/^(XAUUSD|XAGUSD|USOIL|UKOIL|NATGAS|COPPER)$/.test(t)) return 'commodity';
  if (/^(EURUSD|USDJPY|GBPUSD|USDKRW|AUDUSD|DXY)$/.test(t)) return 'forex';
  if (/^[A-Z]{1,5}$/.test(t))                         return 'stock';
  return 'unknown';
}

/** Build ordered source URL list for a ticker */
export function buildSourceList(ticker: string, extraLogoUrl?: string): string[] {
  const entry = getLogoEntry(ticker);
  const sources: string[] = [];
  if (entry?.primary)        sources.push(entry.primary);
  if (entry?.fallbacks)      sources.push(...entry.fallbacks);
  if (extraLogoUrl)          sources.push(extraLogoUrl);
  // Auto-generate Clearbit for unknown stocks
  if (sources.length === 0) {
    const cat = detectCategory(ticker);
    if (cat === 'stock') {
      // Clearbit generic: try lowercase ticker as domain guess
      sources.push(`https://financialmodelingprep.com/image-stock/${ticker.toUpperCase()}.png`);
    }
  }
  return sources.filter(Boolean);
}

/** Get background color for ticker */
export function getBgColor(ticker: string, fallbackClr?: string): string {
  const entry = getLogoEntry(ticker);
  if (entry) return entry.bg;
  if (fallbackClr) return fallbackClr;
  // Deterministic color from ticker string
  let hash = 0;
  for (const ch of (ticker || '')) hash = ((hash << 5) - hash) + ch.charCodeAt(0);
  const PALETTE = ['#3B82F6','#7C3AED','#10B981','#F59E0B','#EF4444','#0891B2','#D97706','#8B5CF6'];
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** Get initials for ticker */
export function getInitials(ticker: string, koreanName?: string): string {
  const entry = getLogoEntry(ticker);
  if (entry?.initials) return entry.initials;
  if (koreanName) return koreanName.slice(0, 2);
  const t = (ticker || '').replace(/[^A-Z0-9가-힣]/gi, '');
  return t.slice(0, 2).toUpperCase() || '??';
}

// Re-export DB for components that need it
export { DB as LOGO_DB_LIB };

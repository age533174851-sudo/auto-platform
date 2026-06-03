// /api/eodhd/logo — Logo URL resolver (EODHD or static fallback)
import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export const revalidate = 3600; // 1 hour

const CRYPTO_LOGOS: Record<string, string> = {
  BTC:  'https://assets.coingecko.com/coins/images/1/large/bitcoin.png',
  ETH:  'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
  SOL:  'https://assets.coingecko.com/coins/images/4128/large/solana.png',
  XRP:  'https://assets.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png',
  BNB:  'https://assets.coingecko.com/coins/images/825/large/bnb-icon2_2x.png',
  DOGE: 'https://assets.coingecko.com/coins/images/5/large/dogecoin.png',
  ADA:  'https://assets.coingecko.com/coins/images/975/large/cardano.png',
  AVAX: 'https://assets.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png',
  TON:  'https://assets.coingecko.com/coins/images/17980/large/ton_symbol.png',
  LINK: 'https://assets.coingecko.com/coins/images/877/large/chainlink-new-logo.png',
  SHIB: 'https://assets.coingecko.com/coins/images/11939/large/shiba.png',
  SUI:  'https://assets.coingecko.com/coins/images/26375/large/sui_asset.jpeg',
  PEPE: 'https://assets.coingecko.com/coins/images/29850/large/pepe-token.jpeg',
  DOT:  'https://assets.coingecko.com/coins/images/12171/large/polkadot.png',
  LTC:  'https://assets.coingecko.com/coins/images/2/large/litecoin.png',
  MATIC:'https://assets.coingecko.com/coins/images/4713/large/polygon.png',
  ARB:  'https://assets.coingecko.com/coins/images/16547/large/photo_2023-03-29_21.47.00.jpeg',
  OP:   'https://assets.coingecko.com/coins/images/25244/large/Optimism.png',
};

const STOCK_LOGOS_CLEARBIT: Record<string, string> = {
  AAPL: 'apple.com',     MSFT: 'microsoft.com',  NVDA: 'nvidia.com',
  TSLA: 'tesla.com',     GOOGL:'google.com',     GOOG: 'google.com',
  AMZN: 'amazon.com',    META: 'meta.com',       AMD:  'amd.com',
  INTC: 'intel.com',     PLTR: 'palantir.com',   COIN: 'coinbase.com',
  MSTR: 'microstrategy.com', SHOP:'shopify.com', ORCL: 'oracle.com',
  ADBE: 'adobe.com',     NFLX: 'netflix.com',    SMCI: 'supermicro.com',
  PYPL: 'paypal.com',    HOOD: 'robinhood.com',  AVGO: 'broadcom.com',
  QCOM: 'qualcomm.com',  CRWD: 'crowdstrike.com',SNOW: 'snowflake.com',
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol   = (searchParams.get('symbol') || '').toUpperCase().trim();
  const exchange = (searchParams.get('exchange') || 'US').toUpperCase().trim();
  const market   = (searchParams.get('market')   || '').toLowerCase().trim();

  if (!symbol) {
    return NextResponse.json({ ok:false, error:'symbol required', logo:null });
  }

  // Crypto: static map (most reliable)
  if (market === 'crypto' || CRYPTO_LOGOS[symbol]) {
    const logo = CRYPTO_LOGOS[symbol] || null;
    return NextResponse.json({
      ok: !!logo, source: 'coingecko', symbol, market: 'crypto', logo,
    });
  }

  // Korean stock: 6-digit code
  if (/^\d{6}$/.test(symbol)) {
    return NextResponse.json({
      ok: true, source: 'naver', symbol, market: 'kr_stock',
      logo: `https://ssl.pstatic.net/imgfinance/chart/item/area/day/${symbol}.png`,
    });
  }

  // US stock: try EODHD if key present, else Clearbit
  const key = process.env.EODHD_API_KEY || '';
  if (key) {
    try {
      // EODHD provides logos via fundamentals endpoint
      const r = await fetch(
        `https://eodhistoricaldata.com/api/fundamentals/${symbol}.${exchange}?api_token=${key}&filter=General::LogoURL`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (r.ok) {
        const text = await r.text();
        const logo = text.replace(/^"|"$/g, '').trim();
        if (logo && logo.startsWith('http')) {
          return NextResponse.json({ ok:true, source:'eodhd', symbol, market:'us_stock', logo });
        }
      }
    } catch (e) {
      console.error('[eodhd/logo]', e);
    }
  }

  // Fallback: Clearbit
  const domain = STOCK_LOGOS_CLEARBIT[symbol];
  if (domain) {
    return NextResponse.json({
      ok:true, source:'clearbit', symbol, market:'us_stock',
      logo: `https://logo.clearbit.com/${domain}`,
    });
  }

  return NextResponse.json({ ok:false, source:'none', symbol, logo:null });
}

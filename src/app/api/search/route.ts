import { NextRequest, NextResponse } from 'next/server';

// ── Symbol → TradingView format ───────────────────────────────
function toTVSymbol(raw: string): string {
  const u = raw.toUpperCase().trim();
  if (u.includes(':')) return u;
  const CRYPTO = /^(BTC|ETH|SOL|BNB|XRP|DOGE|ADA|AVAX|TON|LINK|DOT|MATIC|ARB|OP|SUI|PEPE|INJ|TIA|WIF|BONK|JTO|PYTH|LTC|BCH|ETC|ATOM|FIL|NEAR|APT|STX|IMX|MANTA|STRK|ALT|DYM|PIXEL|ONDO|WLD|MEME|ORDI|SATS|RATS)$/;
  if (CRYPTO.test(u)) return `BINANCE:${u}USDT`;
  if (u.endsWith('USDT')||u.endsWith('USDC')||u.endsWith('BTC')||u.endsWith('ETH')) return `BINANCE:${u}`;
  if (/^\d{6}$/.test(u)) return `KRX:${u}`;
  if (u==='XAUUSD'||u==='GOLD') return 'OANDA:XAUUSD';
  if (u==='XAGUSD'||u==='SILVER') return 'OANDA:XAGUSD';
  if (u==='WTI'||u==='USOIL') return 'TVC:USOIL';
  if (u==='BRENT') return 'TVC:UKOIL';
  if (u==='SPX'||u==='SP500') return 'SP:SPX';
  if (u==='NDX'||u==='NASDAQ100') return 'NASDAQ:NDX';
  if (u==='DJI'||u==='DOW') return 'DJ:DJI';
  if (u==='KOSPI') return 'KRX:KOSPI';
  if (u==='KOSDAQ') return 'KOSDAQ:KOSDAQ';
  if (u==='N225'||u==='NIKKEI') return 'TVC:NI225';
  if (u==='DXY') return 'TVC:DXY';
  if (u==='EURUSD'||u==='GBPUSD'||u==='USDJPY'||u==='USDKRW'||u==='AUDUSD'||u==='USDCAD') return `FX_IDC:${u}`;
  const NYSE  = ['V','MA','JPM','BAC','GS','MS','WMT','HD','DIS','JNJ','UNH','LLY','PFE','XOM','CVX'];
  const AMEX  = ['SPY','GLD','SLV','USO','GDX','TLT','HYG','EEM','EFA'];
  const ETF   = ['QQQ','TQQQ','SQQQ','SOXL','SOXS','ARKK','ARKG','IWM','VTI','VOO','DIA','FNGU','BOTZ'];
  if (ETF.includes(u)||AMEX.includes(u)) return `AMEX:${u}`;
  if (NYSE.includes(u)) return `NYSE:${u}`;
  return `NASDAQ:${u}`;
}

// ── Featured asset database (compact) ────────────────────────
const FEATURED_ASSETS = [
  // Crypto
  {sym:'BTC', label:'비트코인', labelEn:'Bitcoin',      cat:'crypto',    tv:'BINANCE:BTCUSDT',  clr:'#F7931A'},
  {sym:'ETH', label:'이더리움', labelEn:'Ethereum',     cat:'crypto',    tv:'BINANCE:ETHUSDT',  clr:'#627EEA'},
  {sym:'SOL', label:'솔라나',   labelEn:'Solana',       cat:'crypto',    tv:'BINANCE:SOLUSDT',  clr:'#9945FF'},
  {sym:'BNB', label:'바이낸스', labelEn:'BNB',          cat:'crypto',    tv:'BINANCE:BNBUSDT',  clr:'#F0B90B'},
  {sym:'XRP', label:'리플',     labelEn:'XRP',          cat:'crypto',    tv:'BINANCE:XRPUSDT',  clr:'#00AAE4'},
  {sym:'DOGE',label:'도지코인', labelEn:'Dogecoin',     cat:'crypto',    tv:'BINANCE:DOGEUSDT', clr:'#BA9F33'},
  {sym:'ADA', label:'에이다',   labelEn:'Cardano',      cat:'crypto',    tv:'BINANCE:ADAUSDT',  clr:'#0033AD'},
  {sym:'AVAX',label:'아발란체', labelEn:'Avalanche',    cat:'crypto',    tv:'BINANCE:AVAXUSDT', clr:'#E84142'},
  {sym:'TON', label:'톤',       labelEn:'Toncoin',      cat:'crypto',    tv:'BINANCE:TONUSDT',  clr:'#0098EA'},
  {sym:'LINK',label:'체인링크', labelEn:'Chainlink',    cat:'crypto',    tv:'BINANCE:LINKUSDT', clr:'#2A5ADA'},
  {sym:'ARB', label:'아비트럼', labelEn:'Arbitrum',     cat:'crypto',    tv:'BINANCE:ARBUSDT',  clr:'#28A0F0'},
  {sym:'OP',  label:'옵티미즘', labelEn:'Optimism',     cat:'crypto',    tv:'BINANCE:OPUSDT',   clr:'#FF0420'},
  {sym:'SUI', label:'수이',     labelEn:'Sui',          cat:'crypto',    tv:'BINANCE:SUIUSDT',  clr:'#4DA2FF'},
  // US Stocks
  {sym:'NVDA',label:'엔비디아', labelEn:'NVIDIA',       cat:'stock',     tv:'NASDAQ:NVDA',      clr:'#76B900'},
  {sym:'AAPL',label:'애플',     labelEn:'Apple',        cat:'stock',     tv:'NASDAQ:AAPL',      clr:'#555555'},
  {sym:'MSFT',label:'마이크로소프트',labelEn:'Microsoft',cat:'stock',    tv:'NASDAQ:MSFT',      clr:'#00A4EF'},
  {sym:'AMZN',label:'아마존',   labelEn:'Amazon',       cat:'stock',     tv:'NASDAQ:AMZN',      clr:'#FF9900'},
  {sym:'TSLA',label:'테슬라',   labelEn:'Tesla',        cat:'stock',     tv:'NASDAQ:TSLA',      clr:'#CC0000'},
  {sym:'META',label:'메타',     labelEn:'Meta',         cat:'stock',     tv:'NASDAQ:META',      clr:'#0866FF'},
  {sym:'GOOGL',label:'구글',    labelEn:'Alphabet',     cat:'stock',     tv:'NASDAQ:GOOGL',     clr:'#4285F4'},
  {sym:'AMD', label:'AMD',      labelEn:'AMD',          cat:'stock',     tv:'NASDAQ:AMD',       clr:'#ED1C24'},
  {sym:'PLTR',label:'팔란티어', labelEn:'Palantir',     cat:'stock',     tv:'NASDAQ:PLTR',      clr:'#000000'},
  {sym:'COIN',label:'코인베이스',labelEn:'Coinbase',    cat:'stock',     tv:'NASDAQ:COIN',      clr:'#0052FF'},
  {sym:'SMCI',label:'슈퍼마이크로',labelEn:'SuperMicro',cat:'stock',    tv:'NASDAQ:SMCI',      clr:'#EE2222'},
  {sym:'INTC',label:'인텔',     labelEn:'Intel',        cat:'stock',     tv:'NASDAQ:INTC',      clr:'#0071C5'},
  {sym:'JPM', label:'JP모건',   labelEn:'JPMorgan',     cat:'stock',     tv:'NYSE:JPM',         clr:'#00529B'},
  {sym:'TSM', label:'TSMC',     labelEn:'TSMC',         cat:'stock',     tv:'NYSE:TSM',         clr:'#C60C30'},
  // Korean Stocks
  {sym:'005930',label:'삼성전자', labelEn:'Samsung',    cat:'krstock',   tv:'KRX:005930',       clr:'#1428A0'},
  {sym:'000660',label:'SK하이닉스',labelEn:'SK Hynix',  cat:'krstock',   tv:'KRX:000660',       clr:'#EA5504'},
  {sym:'035420',label:'NAVER',  labelEn:'NAVER',        cat:'krstock',   tv:'KRX:035420',       clr:'#03C75A'},
  {sym:'035720',label:'카카오', labelEn:'Kakao',        cat:'krstock',   tv:'KRX:035720',       clr:'#FFCD00'},
  {sym:'005380',label:'현대차', labelEn:'Hyundai',      cat:'krstock',   tv:'KRX:005380',       clr:'#002C5F'},
  {sym:'006400',label:'삼성SDI',labelEn:'Samsung SDI',  cat:'krstock',   tv:'KRX:006400',       clr:'#1428A0'},
  {sym:'051910',label:'LG화학', labelEn:'LG Chem',      cat:'krstock',   tv:'KRX:051910',       clr:'#A50034'},
  // ETFs
  {sym:'QQQ', label:'나스닥100 ETF',labelEn:'QQQ',      cat:'etf',       tv:'NASDAQ:QQQ',       clr:'#3B82F6'},
  {sym:'SPY', label:'S&P500 ETF',   labelEn:'SPY',       cat:'etf',       tv:'AMEX:SPY',         clr:'#6366F1'},
  {sym:'TQQQ',label:'나스닥3배 ETF',labelEn:'TQQQ',     cat:'etf',       tv:'NASDAQ:TQQQ',      clr:'#EF4444'},
  {sym:'SOXL',label:'반도체3배 ETF',labelEn:'SOXL',     cat:'etf',       tv:'AMEX:SOXL',        clr:'#F59E0B'},
  {sym:'ARKK',label:'ARK 혁신 ETF', labelEn:'ARKK',     cat:'etf',       tv:'NYSE:ARKK',        clr:'#8B5CF6'},
  // Indices
  {sym:'SPX', label:'S&P500',       labelEn:'S&P500',    cat:'index',     tv:'SP:SPX',           clr:'#6366F1'},
  {sym:'NDX', label:'나스닥100',    labelEn:'NASDAQ100', cat:'index',     tv:'NASDAQ:NDX',       clr:'#3B82F6'},
  {sym:'DJI', label:'다우존스',     labelEn:'Dow Jones', cat:'index',     tv:'DJ:DJI',           clr:'#10B981'},
  {sym:'KOSPI',label:'코스피',      labelEn:'KOSPI',     cat:'index',     tv:'KRX:KOSPI',        clr:'#1428A0'},
  {sym:'N225',label:'니케이225',    labelEn:'Nikkei 225',cat:'index',     tv:'TVC:NI225',        clr:'#BC002D'},
  // Commodities
  {sym:'GOLD',label:'금',           labelEn:'Gold',      cat:'commodity', tv:'OANDA:XAUUSD',     clr:'#D97706'},
  {sym:'SILVER',label:'은',         labelEn:'Silver',    cat:'commodity', tv:'OANDA:XAGUSD',     clr:'#9CA3AF'},
  {sym:'OIL', label:'WTI 원유',     labelEn:'WTI Oil',   cat:'commodity', tv:'TVC:USOIL',        clr:'#78350F'},
  {sym:'BRENT',label:'브렌트유',    labelEn:'Brent Oil', cat:'commodity', tv:'TVC:UKOIL',        clr:'#92400E'},
  // Forex
  {sym:'DXY', label:'달러 인덱스',  labelEn:'DXY',       cat:'forex',     tv:'TVC:DXY',          clr:'#10B981'},
  {sym:'EURUSD',label:'유로/달러',  labelEn:'EUR/USD',   cat:'forex',     tv:'FX_IDC:EURUSD',    clr:'#3B82F6'},
  {sym:'USDJPY',label:'달러/엔',    labelEn:'USD/JPY',   cat:'forex',     tv:'FX_IDC:USDJPY',    clr:'#EF4444'},
  {sym:'USDKRW',label:'달러/원',    labelEn:'USD/KRW',   cat:'forex',     tv:'FX_IDC:USDKRW',    clr:'#F59E0B'},
];

// ── Score search results ───────────────────────────────────────
function scoreAsset(asset: (typeof FEATURED_ASSETS)[0], q: string): number {
  const ql = q.toLowerCase();
  const sym = asset.sym.toLowerCase();
  const label = asset.label.toLowerCase();
  const en = asset.labelEn.toLowerCase();
  if (sym === ql) return 100;
  if (sym.startsWith(ql)) return 80;
  if (en.toLowerCase() === ql) return 75;
  if (label.startsWith(ql)) return 70;
  if (sym.includes(ql)) return 60;
  if (en.toLowerCase().includes(ql)) return 50;
  if (label.includes(ql)) return 45;
  return 0;
}

// ── Binance ticker search (for unlisted crypto) ───────────────
async function searchBinanceTickers(query: string) {
  try {
    const res = await fetch('https://api.binance.com/api/v3/exchangeInfo', {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error('binance failed');
    const data = await res.json();
    const q = query.toUpperCase();
    return (data.symbols as any[])
      .filter((s: any) =>
        s.quoteAsset === 'USDT' &&
        s.status === 'TRADING' &&
        s.baseAsset.startsWith(q)
      )
      .slice(0, 5)
      .map((s: any) => ({
        sym: s.baseAsset,
        label: s.baseAsset,
        labelEn: s.baseAsset,
        cat: 'crypto',
        tv: `BINANCE:${s.symbol}`,
        clr: '#F7931A',
        from: 'binance',
      }));
  } catch {
    return [];
  }
}

// ── GET /api/search?q=…&cat=… ─────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q   = (searchParams.get('q') || '').trim();
  const cat = searchParams.get('cat') || 'all';

  // Empty query → return featured by category
  if (!q) {
    const featured = cat === 'all'
      ? FEATURED_ASSETS.slice(0, 20)
      : FEATURED_ASSETS.filter(a => a.cat === cat).slice(0, 20);
    return NextResponse.json({ results: featured, query: '', source: 'featured' });
  }

  // Score and sort featured assets
  const scored = FEATURED_ASSETS
    .map(a => ({ ...a, _score: scoreAsset(a, q) }))
    .filter(a => a._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 10);

  // If few results and looks like crypto query, search Binance
  let extra: any[] = [];
  if (scored.length < 3 && /^[A-Z0-9]{2,10}$/.test(q.toUpperCase())) {
    extra = await searchBinanceTickers(q);
  }

  // Deduplicate
  const seen = new Set(scored.map(a => a.tv));
  const deduped = [...scored, ...extra.filter(a => !seen.has(a.tv))];

  // Manual override — always add the TV-formatted version
  const tvSym = toTVSymbol(q);
  const manualEntry = {
    sym: q.toUpperCase(),
    label: q.toUpperCase(),
    labelEn: q.toUpperCase(),
    cat: tvSym.startsWith('BINANCE') ? 'crypto'
       : tvSym.startsWith('KRX') ? 'krstock'
       : tvSym.startsWith('FX') ? 'forex'
       : 'stock',
    tv: tvSym,
    clr: '#94A3B8',
    isManual: true,
  };

  return NextResponse.json({
    results: deduped.length > 0 ? deduped : [manualEntry],
    manual:  manualEntry,
    query:   q,
    source:  extra.length > 0 ? 'binance+local' : 'local',
  });
}

import { NextRequest, NextResponse } from 'next/server';

// ── TV symbol resolver ─────────────────────────────────────────
function toTVSymbol(raw: string): string {
  const u = raw.toUpperCase().trim();
  if (u.includes(':')) return u;
  const CRYPTO = /^(BTC|ETH|SOL|BNB|XRP|DOGE|ADA|AVAX|TON|LINK|DOT|MATIC|ARB|OP|SUI|PEPE|INJ|TIA|WIF|BONK|JTO|PYTH|LTC|BCH|ETC|ATOM|FIL|NEAR|APT|STX|IMX|UNI|SHIB)$/;
  if (CRYPTO.test(u)) return `BINANCE:${u}USDT`;
  if (u.endsWith('USDT') || u.endsWith('USDC') || u.endsWith('BTC') || u.endsWith('ETH')) return `BINANCE:${u}`;
  if (/^\d{6}$/.test(u)) return `KRX:${u}`;
  if (u === 'XAUUSD' || u === 'GOLD')   return 'OANDA:XAUUSD';
  if (u === 'XAGUSD' || u === 'SILVER') return 'OANDA:XAGUSD';
  if (u === 'WTI' || u === 'USOIL')     return 'TVC:USOIL';
  if (u === 'SPX')  return 'SP:SPX';
  if (u === 'NDX')  return 'NASDAQ:NDX';
  if (u === 'DJI')  return 'DJ:DJI';
  if (u === 'DXY')  return 'TVC:DXY';
  if (/^(EURUSD|GBPUSD|USDJPY|USDKRW|AUDUSD)$/.test(u)) return `FX_IDC:${u}`;
  const AMEX_ETF = ['SPY','GLD','SLV','USO','TLT','HYG','EEM','EFA','IWM','DIA','SOXL','SOXS','TQQQ','SQQQ','ARKK','ARKG','BITO','IBIT'];
  if (AMEX_ETF.includes(u)) return `AMEX:${u}`;
  const NYSE = ['V','MA','JPM','BAC','GS','MS','WMT','HD','DIS','JNJ','UNH','LLY','PFE','XOM','CVX','GM','F','PLTR','NIO','TSM'];
  if (NYSE.includes(u)) return `NYSE:${u}`;
  return `NASDAQ:${u}`;
}

// ── Korean name map ────────────────────────────────────────────
const KR: Record<string,string> = {
  BTC:'비트코인',ETH:'이더리움',SOL:'솔라나',XRP:'리플',BNB:'바이낸스코인',
  DOGE:'도지코인',ADA:'에이다',AVAX:'아발란체',TON:'톤코인',LINK:'체인링크',
  DOT:'폴카닷',MATIC:'폴리곤',UNI:'유니스왑',ARB:'아비트럼',OP:'옵티미즘',
  SUI:'수이',APT:'앱토스',INJ:'인젝티브',PEPE:'페페',SHIB:'시바이누',
  NVDA:'엔비디아',AAPL:'애플',MSFT:'마이크로소프트',TSLA:'테슬라',
  GOOGL:'구글',AMZN:'아마존',META:'메타',AMD:'AMD',INTC:'인텔',
  AVGO:'브로드컴',QCOM:'퀄컴',TSM:'TSMC',ARM:'ARM',SMCI:'슈퍼마이크로',
  PLTR:'팔란티어',PL:'플래닛랩스',COIN:'코인베이스',HOOD:'로빈후드',
  MSTR:'마이크로스트레티지',RIVN:'리비안',NIO:'니오',GME:'게임스탑',
  JPM:'JP모건',GS:'골드만삭스',BAC:'뱅크오브아메리카',V:'비자',MA:'마스터카드',
  PYPL:'페이팔',WMT:'월마트',COST:'코스트코',NFLX:'넷플릭스',
  DIS:'디즈니',BA:'보잉',LMT:'록히드마틴',LLY:'일라이릴리',
  '005930':'삼성전자','000660':'SK하이닉스','035420':'NAVER',
  '035720':'카카오','005380':'현대차','000270':'기아',
  '051910':'LG화학','006400':'삼성SDI',
  SPY:'S&P500 ETF',QQQ:'나스닥100 ETF',TQQQ:'나스닥3배',SQQQ:'나스닥3배인버스',
  SOXL:'반도체3배',SOXS:'반도체3배인버스',ARKK:'ARK이노베이션',
  GLD:'금 ETF',TLT:'20년국채 ETF',IWM:'러셀2000 ETF',
  IBIT:'블랙록비트코인 ETF',BITO:'비트코인선물 ETF',
  SPX:'S&P 500',NDX:'나스닥100',DJI:'다우존스',VIX:'공포지수',
  DXY:'달러인덱스',XAUUSD:'금(Gold)',XAGUSD:'은(Silver)',
  USOIL:'WTI원유',UKOIL:'브렌트유',NATGAS:'천연가스',
  EURUSD:'유로/달러',USDJPY:'달러/엔',USDKRW:'달러/원화',
};

// Alias search (Korean → ticker)
const ALIASES: Record<string,string> = {
  '비트코인':'BTC','이더리움':'ETH','솔라나':'SOL','리플':'XRP','도지코인':'DOGE',
  '바이낸스코인':'BNB','에이다':'ADA','아발란체':'AVAX','톤코인':'TON','체인링크':'LINK',
  '폴카닷':'DOT','폴리곤':'MATIC','유니스왑':'UNI','아비트럼':'ARB','옵티미즘':'OP',
  '수이':'SUI','앱토스':'APT','인젝티브':'INJ','페페':'PEPE','시바이누':'SHIB',
  '엔비디아':'NVDA','애플':'AAPL','마이크로소프트':'MSFT','테슬라':'TSLA',
  '구글':'GOOGL','알파벳':'GOOGL','아마존':'AMZN','메타':'META','페이스북':'META',
  'AMD':'AMD','인텔':'INTC','브로드컴':'AVGO','퀄컴':'QCOM','TSMC':'TSM',
  '팔란티어':'PLTR','플래닛랩스':'PL','코인베이스':'COIN','로빈후드':'HOOD',
  '마이크로스트레티지':'MSTR','리비안':'RIVN','니오':'NIO','게임스탑':'GME',
  'JP모건':'JPM','골드만삭스':'GS','비자':'V','마스터카드':'MA','페이팔':'PYPL',
  '월마트':'WMT','코스트코':'COST','넷플릭스':'NFLX','디즈니':'DIS',
  '보잉':'BA','록히드마틴':'LMT','일라이릴리':'LLY',
  '삼성전자':'005930','SK하이닉스':'000660','카카오':'035720',
  '현대차':'005380','기아':'000270','LG화학':'051910','삼성SDI':'006400',
  '금':'XAUUSD','은':'XAGUSD','원유':'USOIL','달러':'DXY',
  '나스닥':'QQQ','나스닥100':'QQQ','S&P500':'SPY','반도체':'SOXL',
  '공포지수':'VIX','달러인덱스':'DXY',
  'bitcoin':'BTC','ethereum':'ETH','solana':'SOL','nvidia':'NVDA',
  'apple':'AAPL','microsoft':'MSFT','tesla':'TSLA','google':'GOOGL',
  'amazon':'AMZN','meta':'META','palantir':'PLTR','coinbase':'COIN',
  'planet labs':'PL','planetlabs':'PL','samsung':'005930','kakao':'035720',
  'gold':'XAUUSD','silver':'XAGUSD','oil':'USOIL','bitcoin etf':'IBIT',
};

// ── Featured asset DB ──────────────────────────────────────────
const FEATURED = [
  {sym:'BTC', labelEn:'Bitcoin',       cat:'crypto',    clr:'#F7931A'},
  {sym:'ETH', labelEn:'Ethereum',      cat:'crypto',    clr:'#627EEA'},
  {sym:'SOL', labelEn:'Solana',        cat:'crypto',    clr:'#9945FF'},
  {sym:'XRP', labelEn:'XRP',           cat:'crypto',    clr:'#00AAE4'},
  {sym:'BNB', labelEn:'BNB',           cat:'crypto',    clr:'#F0B90B'},
  {sym:'DOGE',labelEn:'Dogecoin',      cat:'crypto',    clr:'#C2A633'},
  {sym:'ADA', labelEn:'Cardano',       cat:'crypto',    clr:'#0033AD'},
  {sym:'AVAX',labelEn:'Avalanche',     cat:'crypto',    clr:'#E84142'},
  {sym:'TON', labelEn:'Toncoin',       cat:'crypto',    clr:'#0088CC'},
  {sym:'LINK',labelEn:'Chainlink',     cat:'crypto',    clr:'#2A5ADA'},
  {sym:'ARB', labelEn:'Arbitrum',      cat:'crypto',    clr:'#28A0F0'},
  {sym:'SUI', labelEn:'Sui',           cat:'crypto',    clr:'#4DA2FF'},
  {sym:'PEPE',labelEn:'Pepe',          cat:'crypto',    clr:'#3BA14C'},
  {sym:'SHIB',labelEn:'Shiba Inu',     cat:'crypto',    clr:'#FFA409'},
  {sym:'UNI', labelEn:'Uniswap',       cat:'crypto',    clr:'#FF007A'},
  {sym:'NVDA',labelEn:'NVIDIA',        cat:'stock',     clr:'#76B900'},
  {sym:'AAPL',labelEn:'Apple',         cat:'stock',     clr:'#555555'},
  {sym:'MSFT',labelEn:'Microsoft',     cat:'stock',     clr:'#00A4EF'},
  {sym:'TSLA',labelEn:'Tesla',         cat:'stock',     clr:'#CC0000'},
  {sym:'GOOGL',labelEn:'Google',       cat:'stock',     clr:'#4285F4'},
  {sym:'AMZN',labelEn:'Amazon',        cat:'stock',     clr:'#FF9900'},
  {sym:'META',labelEn:'Meta',          cat:'stock',     clr:'#0866FF'},
  {sym:'AMD', labelEn:'AMD',           cat:'stock',     clr:'#ED1C24'},
  {sym:'INTC',labelEn:'Intel',         cat:'stock',     clr:'#0071C5'},
  {sym:'AVGO',labelEn:'Broadcom',      cat:'stock',     clr:'#CC0000'},
  {sym:'QCOM',labelEn:'Qualcomm',      cat:'stock',     clr:'#3253DC'},
  {sym:'TSM', labelEn:'TSMC',          cat:'stock',     clr:'#BB2A35'},
  {sym:'ARM', labelEn:'ARM Holdings',  cat:'stock',     clr:'#0091BD'},
  {sym:'PLTR',labelEn:'Palantir',      cat:'stock',     clr:'#1F2937'},
  {sym:'PL',  labelEn:'Planet Labs',   cat:'stock',     clr:'#4287F5'},
  {sym:'COIN',labelEn:'Coinbase',      cat:'stock',     clr:'#0052FF'},
  {sym:'HOOD',labelEn:'Robinhood',     cat:'stock',     clr:'#00C805'},
  {sym:'MSTR',labelEn:'MicroStrategy', cat:'stock',     clr:'#E87426'},
  {sym:'RIVN',labelEn:'Rivian',        cat:'stock',     clr:'#3DD286'},
  {sym:'GME', labelEn:'GameStop',      cat:'stock',     clr:'#E31937'},
  {sym:'JPM', labelEn:'JPMorgan',      cat:'stock',     clr:'#006DAE'},
  {sym:'GS',  labelEn:'Goldman Sachs', cat:'stock',     clr:'#6C8EBF'},
  {sym:'V',   labelEn:'Visa',          cat:'stock',     clr:'#1A1F71'},
  {sym:'MA',  labelEn:'Mastercard',    cat:'stock',     clr:'#EB001B'},
  {sym:'PYPL',labelEn:'PayPal',        cat:'stock',     clr:'#003087'},
  {sym:'WMT', labelEn:'Walmart',       cat:'stock',     clr:'#0071CE'},
  {sym:'NFLX',labelEn:'Netflix',       cat:'stock',     clr:'#E50914'},
  {sym:'DIS', labelEn:'Disney',        cat:'stock',     clr:'#006E99'},
  {sym:'LLY', labelEn:'Eli Lilly',     cat:'stock',     clr:'#D52B1E'},
  {sym:'BA',  labelEn:'Boeing',        cat:'stock',     clr:'#1D428A'},
  {sym:'005930',labelEn:'Samsung Electronics',cat:'krstock',clr:'#1428A0'},
  {sym:'000660',labelEn:'SK Hynix',    cat:'krstock',   clr:'#EA1917'},
  {sym:'035420',labelEn:'NAVER',       cat:'krstock',   clr:'#03C75A'},
  {sym:'035720',labelEn:'Kakao',       cat:'krstock',   clr:'#FEE500'},
  {sym:'005380',labelEn:'Hyundai Motor',cat:'krstock',  clr:'#002C5F'},
  {sym:'000270',labelEn:'Kia',         cat:'krstock',   clr:'#E31F26'},
  {sym:'SPY', labelEn:'SPDR S&P 500',  cat:'etf',       clr:'#1D4ED8'},
  {sym:'QQQ', labelEn:'Invesco QQQ',   cat:'etf',       clr:'#7C3AED'},
  {sym:'TQQQ',labelEn:'ProShares TQQQ',cat:'etf',       clr:'#DC2626'},
  {sym:'SQQQ',labelEn:'ProShares SQQQ',cat:'etf',       clr:'#16A34A'},
  {sym:'SOXL',labelEn:'Direxion SOXL', cat:'etf',       clr:'#EA580C'},
  {sym:'ARKK',labelEn:'ARK Innovation',cat:'etf',       clr:'#7C3AED'},
  {sym:'GLD', labelEn:'SPDR Gold',     cat:'etf',       clr:'#D97706'},
  {sym:'TLT', labelEn:'iShares 20Y Treasury',cat:'etf', clr:'#0369A1'},
  {sym:'IBIT',labelEn:'iShares Bitcoin ETF',cat:'etf',  clr:'#F7931A'},
  {sym:'BITO',labelEn:'Bitcoin Strategy ETF',cat:'etf', clr:'#F59E0B'},
  {sym:'SPX', labelEn:'S&P 500',       cat:'index',     clr:'#6366F1'},
  {sym:'NDX', labelEn:'NASDAQ 100',    cat:'index',     clr:'#3B82F6'},
  {sym:'DJI', labelEn:'Dow Jones',     cat:'index',     clr:'#10B981'},
  {sym:'VIX', labelEn:'VIX',           cat:'index',     clr:'#EF4444'},
  {sym:'DXY', labelEn:'US Dollar Index',cat:'forex',    clr:'#10B981'},
  {sym:'XAUUSD',labelEn:'Gold',        cat:'commodity', clr:'#D97706'},
  {sym:'XAGUSD',labelEn:'Silver',      cat:'commodity', clr:'#9CA3AF'},
  {sym:'USOIL',labelEn:'WTI Crude Oil',cat:'commodity', clr:'#78350F'},
  {sym:'EURUSD',labelEn:'EUR/USD',     cat:'forex',     clr:'#3B82F6'},
  {sym:'USDJPY',labelEn:'USD/JPY',     cat:'forex',     clr:'#EF4444'},
  {sym:'USDKRW',labelEn:'USD/KRW',     cat:'forex',     clr:'#F59E0B'},
].map(a => ({
  ...a,
  label: KR[a.sym] || a.labelEn,
  tv: toTVSymbol(a.sym),
}));

function scoreAsset(a: (typeof FEATURED)[0], q: string): number {
  const ql = q.toLowerCase();
  const sym = a.sym.toLowerCase();
  const lb  = a.label.toLowerCase();
  const en  = a.labelEn.toLowerCase();
  if (sym === ql) return 100;
  if (sym.startsWith(ql)) return 85;
  if (en === ql) return 80;
  if (lb.startsWith(ql)) return 75;
  if (sym.includes(ql)) return 60;
  if (en.includes(ql)) return 55;
  if (lb.includes(ql)) return 50;
  return 0;
}

// ── Polygon search (server-only, key never sent to client) ─────
async function polygonSearch(query: string): Promise<any[]> {
  const key = process.env.POLYGON_API_KEY || '';
  if (!key || !query || query.length < 1) return [];
  try {
    const r = await fetch(
      `https://api.polygon.io/v3/reference/tickers?search=${encodeURIComponent(query)}&market=stocks&active=true&limit=8&sort=ticker&apiKey=${key}`,
      { signal: AbortSignal.timeout(3500) }
    );
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results || []).map((t: any) => {
      const sym = t.ticker;
      return {
        sym,
        label: KR[sym] || t.name?.replace(/ Inc\.?$/i,'').replace(/ Corp\.?$/i,'').replace(/ Corporation$/i,'').replace(/ Ltd\.?$/i,'').trim() || sym,
        labelEn: t.name || sym,
        cat:     'stock',
        tv:      toTVSymbol(sym),
        clr:     '#3B82F6',
        exchange: t.primary_exchange,
        source:  'polygon',
      };
    });
  } catch {
    return [];
  }
}

// ── Binance ticker search (crypto not in featured) ─────────────
async function binanceSearch(query: string): Promise<any[]> {
  try {
    const r = await fetch('https://api.binance.com/api/v3/exchangeInfo', {
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return [];
    const d = await r.json();
    const q = query.toUpperCase();
    return (d.symbols as any[])
      .filter((s: any) => s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.baseAsset.startsWith(q))
      .slice(0, 4)
      .map((s: any) => ({
        sym:     s.baseAsset,
        label:   KR[s.baseAsset] || s.baseAsset,
        labelEn: s.baseAsset,
        cat:     'crypto',
        tv:      `BINANCE:${s.symbol}`,
        clr:     '#F7931A',
        source:  'binance',
      }));
  } catch {
    return [];
  }
}

// ── GET /api/search?q=…&cat=… ─────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawQ = (searchParams.get('q') || '').trim();
  const cat  = searchParams.get('cat') || 'all';

  // Empty → return featured
  if (!rawQ) {
    const list = cat === 'all' ? FEATURED.slice(0,24) : FEATURED.filter(a=>a.cat===cat).slice(0,24);
    return NextResponse.json({ results: list, query: '', source: 'featured' }, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
    });
  }

  // Resolve alias first (Korean → ticker)
  const resolved = ALIASES[rawQ] || ALIASES[rawQ.toLowerCase()] || null;
  const q        = resolved || rawQ;

  // Score featured assets
  const scored = FEATURED
    .map(a => ({ ...a, _score: scoreAsset(a, q) }))
    .filter(a => a._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 8);

  // If resolved alias, return immediately
  if (resolved && scored.length > 0) {
    return NextResponse.json({ results: scored, query: rawQ, resolved, source: 'alias' });
  }

  // Parallel: Polygon (stocks) + Binance (crypto) for unlisted assets
  const [polygonRes, binanceRes] = await Promise.all([
    /^[A-Za-z]/.test(q) ? polygonSearch(q) : Promise.resolve([]),
    /^[A-Z0-9]{2,8}$/i.test(q) ? binanceSearch(q) : Promise.resolve([]),
  ]);

  // Deduplicate
  const seen    = new Set(scored.map(a => a.tv));
  const extras  = [...polygonRes, ...binanceRes].filter(a => !seen.has(a.tv));

  const results = [...scored, ...extras].slice(0, 12);

  // Manual fallback for completely unknown ticker
  const manualTV = toTVSymbol(q);
  if (results.length === 0) {
    results.push({
      sym:     q.toUpperCase(),
      label:   KR[q.toUpperCase()] || q.toUpperCase(),
      labelEn: q.toUpperCase(),
      cat:     manualTV.startsWith('BINANCE') ? 'crypto' : manualTV.startsWith('KRX') ? 'krstock' : 'stock',
      tv:      manualTV,
      clr:     '#94A3B8',
      source:  'manual',
    } as any);
  }

  const source = polygonRes.length > 0 ? 'polygon+local'
               : binanceRes.length > 0  ? 'binance+local'
               : 'local';

  return NextResponse.json({ results, query: rawQ, resolved, source }, {
    headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' },
  });
}

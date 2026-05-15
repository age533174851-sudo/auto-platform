// ─────────────────────────────────────────────────────────────
// TRAIGO Featured Assets (Scalable Architecture)
// ⚠️ 모든 주식을 하드코딩하지 않습니다.
// 전체 검색 → src/lib/assetSearch.ts
// 캐시 시스템 → src/lib/assetCache.ts
// ─────────────────────────────────────────────────────────────

export type AssetType =
  | 'coin' | 'stock' | 'krstock' | 'jpstock'
  | 'cnstock' | 'eustock' | 'etf' | 'index'
  | 'commodity' | 'forex';

export interface Asset {
  id: string; nameKr: string; name: string; sym: string;
  p: number; c: number; v: string; t: AssetType; clr: string;
  cap?: string; sector?: string; isFeatured?: boolean;
}

export const TYPE_LABEL: Record<AssetType, string> = {
  coin:'코인', stock:'미국주식', krstock:'국내주식', jpstock:'일본주식',
  cnstock:'중국주식', eustock:'유럽주식', etf:'ETF', index:'지수',
  commodity:'원자재', forex:'환율',
};

export const TYPE_COLOR: Record<AssetType, string> = {
  coin:'#F7931A', stock:'#3B82F6', krstock:'#EF4444', jpstock:'#DC2626',
  cnstock:'#EF4444', eustock:'#8B5CF6', etf:'#10B981', index:'#8B5CF6',
  commodity:'#D97706', forex:'#0891B2',
};

const f = (id:string,nk:string,ne:string,sym:string,p:number,c:number,v:string,t:AssetType,clr:string,ex:Partial<Asset>={}):Asset =>
  ({id,nameKr:nk,name:ne,sym,p,c,v,t,clr,isFeatured:true,...ex});

// ── Featured Crypto (top 15 by market cap) ───────────────────
const CRYPTO: Asset[] = [
  f('BTC','비트코인','Bitcoin','BTC/USDT',94230000,2.31,'1.24T','coin','#F7931A',{cap:'1,821조'}),
  f('ETH','이더리움','Ethereum','ETH/USDT',5820000,-1.12,'412B','coin','#627EEA',{cap:'700조'}),
  f('SOL','솔라나','Solana','SOL/USDT',210000,2.94,'58B','coin','#9945FF',{cap:'96조'}),
  f('XRP','리플','XRP','XRP/USDT',850,-1.39,'21B','coin','#00AAE4',{cap:'148조'}),
  f('BNB','바이낸스코인','BNB','BNB/USDT',872000,0.88,'15B','coin','#F0B90B',{cap:'134조'}),
  f('DOGE','도지코인','Dogecoin','DOGE/USDT',242,3.41,'8.2B','coin','#C2A633',{cap:'35조'}),
  f('ADA','에이다','Cardano','ADA/USDT',681,1.22,'4.1B','coin','#0033AD',{cap:'24조'}),
  f('AVAX','아발란체','Avalanche','AVAX/USDT',52100,-0.87,'2.8B','coin','#E84142',{cap:'21조'}),
  f('TON','톤코인','Toncoin','TON/USDT',6840,1.88,'3.4B','coin','#0088CC',{cap:'17조'}),
  f('LINK','체인링크','Chainlink','LINK/USDT',19800,2.11,'1.2B','coin','#2A5ADA',{cap:'12조'}),
  f('DOT','폴카닷','Polkadot','DOT/USDT',9820,0.54,'1.9B','coin','#E6007A',{cap:'14조'}),
  f('MATIC','폴리곤','Polygon','MATIC/USDT',1140,-0.32,'0.8B','coin','#8247E5',{cap:'10조'}),
  f('SHIB','시바이누','Shiba Inu','SHIB/USDT',0.0000284,5.21,'3.4B','coin','#FFA409',{cap:'17조'}),
  f('ARB','아비트럼','Arbitrum','ARB/USDT',1840,3.12,'0.8B','coin','#12AAFF',{cap:'5조'}),
  f('SUI','수이','Sui','SUI/USDT',4280,4.21,'0.9B','coin','#4DA2FF',{cap:'5조'}),
];

// ── Featured US Stocks (top by market cap) ───────────────────
const US_STOCKS: Asset[] = [
  f('AAPL','애플','Apple Inc.','AAPL',287.51,1.17,'32B','stock','#555555',{cap:'3,850조',sector:'테크'}),
  f('MSFT','마이크로소프트','Microsoft','MSFT',413.96,0.63,'28B','stock','#00A4EF',{cap:'3,440조',sector:'테크'}),
  f('NVDA','엔비디아','NVIDIA Corp.','NVDA',207.83,5.77,'42B','stock','#76B900',{cap:'2,820조',sector:'반도체'}),
  f('GOOGL','구글','Alphabet Inc.','GOOGL',395.14,2.33,'19B','stock','#4285F4',{cap:'2,240조',sector:'테크'}),
  f('AMZN','아마존','Amazon.com','AMZN',274.99,0.53,'24B','stock','#FF9900',{cap:'2,080조',sector:'테크'}),
  f('META','메타','Meta Platforms','META',528.60,1.43,'22B','stock','#0866FF',{cap:'1,360조',sector:'테크'}),
  f('TSLA','테슬라','Tesla Inc.','TSLA',398.73,2.40,'18B','stock','#CC0000',{cap:'1,120조',sector:'EV'}),
  f('AVGO','브로드컴','Broadcom Inc.','AVGO',1842.30,1.82,'8.4B','stock','#CC0000',{cap:'860조',sector:'반도체'}),
  f('AMD','AMD','Advanced Micro Devices','AMD',421.39,18.61,'11B','stock','#ED1C24',{cap:'280조',sector:'반도체'}),
  f('NFLX','넷플릭스','Netflix Inc.','NFLX',694.20,2.10,'8.4B','stock','#E50914',{cap:'300조',sector:'미디어'}),
  f('PLTR','팔란티어','Palantir Tech','PLTR',24.80,5.21,'4.2B','stock','#6366F1',{cap:'54조',sector:'AI'}),
  f('SMCI','슈퍼마이크로','Super Micro Computer','SMCI',824.60,8.42,'3.8B','stock','#1A1A2E',{cap:'50조',sector:'AI서버'}),
  f('COIN','코인베이스','Coinbase Global','COIN',214.40,3.84,'3.2B','stock','#0052FF',{cap:'50조',sector:'핀테크'}),
  f('JPM','JP모건','JPMorgan Chase','JPM',214.80,0.38,'7.8B','stock','#003A8C',{cap:'620조',sector:'금융'}),
  f('V','비자','Visa Inc.','V',278.50,0.44,'4.1B','stock','#1A1F71',{cap:'520조',sector:'금융'}),
  f('MA','마스터카드','Mastercard','MA',462.80,0.61,'3.8B','stock','#EB001B',{cap:'430조',sector:'금융'}),
  f('XOM','엑슨모빌','ExxonMobil','XOM',114.80,0.42,'3.8B','stock','#FF0000',{cap:'474조',sector:'에너지'}),
  f('LLY','일라이릴리','Eli Lilly','LLY',824.60,2.14,'4.8B','stock','#E41B17',{cap:'784조',sector:'헬스케어'}),
  f('WMT','월마트','Walmart Inc.','WMT',88.40,0.92,'4.8B','stock','#007DC6',{cap:'320조',sector:'유통'}),
  f('TSM','TSMC','Taiwan Semiconductor','TSM',168.40,1.24,'9.2B','stock','#005BAC',{cap:'871조',sector:'반도체'}),
];

// ── Featured Korean Stocks ────────────────────────────────────
const KR_STOCKS: Asset[] = [
  f('SEC','삼성전자','Samsung Electronics','005930',78400,-0.63,'3.2T','krstock','#1428A0',{cap:'468조',sector:'반도체'}),
  f('SKH','SK하이닉스','SK Hynix','000660',198000,1.42,'1.1T','krstock','#EA5504',{cap:'144조',sector:'반도체'}),
  f('NAVER','네이버','NAVER Corp.','035420',218000,0.92,'380B','krstock','#03C75A',{cap:'35조',sector:'인터넷'}),
  f('KAKAO','카카오','Kakao Corp.','035720',44050,-1.45,'210B','krstock','#FFCD00',{cap:'19조',sector:'인터넷'}),
  f('LGE','LG에너지솔루션','LG Energy Solution','373220',382000,2.18,'420B','krstock','#A50034',{cap:'89조',sector:'배터리'}),
  f('HYUN','현대차','Hyundai Motor','005380',248000,0.81,'280B','krstock','#002C5F',{cap:'52조',sector:'자동차'}),
  f('KIA','기아차','Kia Corporation','000270',128000,1.14,'160B','krstock','#05141F',{cap:'52조',sector:'자동차'}),
  f('CEL','셀트리온','Celltrion','068270',172000,1.24,'180B','krstock','#0066CC',{cap:'21조',sector:'바이오'}),
];

// ── Featured ETFs ─────────────────────────────────────────────
const ETFS: Asset[] = [
  f('QQQ','나스닥100 ETF','Invesco QQQ Trust','QQQ',467.80,0.92,'12B','etf','#3B82F6'),
  f('SPY','S&P500 ETF','SPDR S&P 500 ETF','SPY',584.20,0.49,'18B','etf','#6366F1'),
  f('ARKK','ARK 혁신 ETF','ARK Innovation ETF','ARKK',52.40,2.14,'1.8B','etf','#10B981'),
  f('SOXL','반도체 3배 ETF','Direxion SOXL','SOXL',38.60,8.42,'3.2B','etf','#F59E0B'),
  f('TQQQ','나스닥 3배 ETF','ProShares Ultra QQQ','TQQQ',68.40,2.81,'4.1B','etf','#7C3AED'),
  f('SQQQ','나스닥 역3배 ETF','ProShares Short QQQ','SQQQ',12.40,-2.81,'1.8B','etf','#DC2626'),
  f('TLT','미국채 20년 ETF','iShares 20Y Treasury','TLT',88.40,-0.42,'2.4B','etf','#6B7280'),
];

// ── Featured Indices ──────────────────────────────────────────
const INDICES: Asset[] = [
  f('NDX','나스닥100','NASDAQ 100','NASDAQ',21340,0.87,'98T','index','#3B82F6'),
  f('SPX','S&P500','S&P 500','S&P500',5820,0.47,'55T','index','#6366F1'),
  f('DJI','다우존스','Dow Jones','DJI',42840,0.31,'42T','index','#8B5CF6'),
  f('KSP','코스피','KOSPI','KOSPI',2687,-0.22,'12T','index','#EF4444'),
  f('KSD','코스닥','KOSDAQ','KOSDAQ',874,1.51,'7.8T','index','#F59E0B'),
  f('NKY','닛케이225','Nikkei 225','N225',38240,0.64,'32T','index','#DC2626'),
];

// ── Featured Commodities ──────────────────────────────────────
const COMMODITIES: Asset[] = [
  f('GLD','금','Gold Spot','GOLD',3420,0.56,'45B','commodity','#D97706'),
  f('SLV','은','Silver Spot','SILVER',38.50,-1.58,'12B','commodity','#94A3B8'),
  f('WTI','원유 WTI','WTI Crude Oil','WTI',78.40,-0.90,'22B','commodity','#78350F'),
  f('BRENT','브렌트유','Brent Crude Oil','BRENT',82.40,-0.72,'18B','commodity','#92400E'),
  f('NG','천연가스','Natural Gas','NATGAS',2.84,1.24,'8.2B','commodity','#0891B2'),
];

// ── Featured Forex ────────────────────────────────────────────
const FOREX: Asset[] = [
  f('USDKRW','달러/원','USD/KRW','USD/KRW',1378,-0.22,'82B','forex','#10B981'),
  f('USDJPY','달러/엔','USD/JPY','USD/JPY',154.2,0.33,'68B','forex','#F59E0B'),
  f('EURUSD','유로/달러','EUR/USD','EUR/USD',1.0892,0.18,'94B','forex','#3B82F6'),
  f('GBPUSD','파운드/달러','GBP/USD','GBP/USD',1.2734,-0.12,'52B','forex','#7C3AED'),
  f('USDCNY','달러/위안','USD/CNY','USD/CNY',7.241,0.05,'34B','forex','#EF4444'),
];

// ── All featured assets ───────────────────────────────────────
export const ASSETS: Asset[] = [
  ...CRYPTO, ...US_STOCKS, ...KR_STOCKS,
  ...ETFS, ...INDICES, ...COMMODITIES, ...FOREX,
];

// ── Price simulation ──────────────────────────────────────────
export function simulatePriceUpdate(assets: Asset[]): Asset[] {
  return assets.map(a => ({
    ...a,
    p: +(a.p*(1+(Math.random()-0.5)*0.002)).toFixed(a.p>10000?0:a.p>10?2:8),
    c: +(a.c+(Math.random()-0.5)*0.07).toFixed(2),
  }));
}

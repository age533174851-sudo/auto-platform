// ─────────────────────────────────────────────────────────────
// TRAIGO Constants — Theme, Currency, Localization, Market Data
// ─────────────────────────────────────────────────────────────

// ── Dark Theme ──────────────────────────────────────────────
export const T = {
  bg:      '#060B14',   // page background
  card:    '#0A1628',   // card background
  surf:    '#0D1F3C',   // surface / modal
  alt:     '#0F2040',   // alternative bg
  border:  '#1A2D4A',   // border
  border2: '#243A5E',   // border emphasis
  txt:     '#E2E8F0',   // primary text
  sub:     '#94A3B8',   // secondary text
  muted:   '#475569',   // muted text
  grn:     '#10B981',   // green / profit
  red:     '#EF4444',   // red / loss
  ylw:     '#F59E0B',   // yellow / warning
  gld:     '#D97706',   // gold
  acl:     '#60A5FA',   // accent light (blue)
  acc:     '#2563EB',   // accent (blue)
  acg:     '#1E3A5F',   // accent ghost
  prp:     '#7C3AED',   // purple
  cyn:     '#06B6D4',   // cyan
} as const;

// ── Currencies ───────────────────────────────────────────────
export const CURRENCIES: Record<string, { symbol: string; name: string; rate: number }> = {
  KRW: { symbol: '₩',  name: '한국 원화', rate: 1      },
  USD: { symbol: '$',  name: 'US Dollar', rate: 1/1375  },
  JPY: { symbol: '¥',  name: '일본 엔',   rate: 0.149   },
  EUR: { symbol: '€',  name: '유로',       rate: 1/1510  },
  GBP: { symbol: '£',  name: '영국 파운드', rate: 1/1740 },
  BTC: { symbol: '₿',  name: 'Bitcoin',   rate: 1/94230000 },
};

// ── Languages ─────────────────────────────────────────────────
export const LANGS: { id: string; label: string; flag: string }[] = [
  { id: 'ko', label: '한국어', flag: '🇰🇷' },
  { id: 'en', label: 'English', flag: '🇺🇸' },
  { id: 'ja', label: '日本語', flag: '🇯🇵' },
];

// ── i18n strings ─────────────────────────────────────────────
export const I18N: Record<string, Record<string, string>> = {
  ko: {
    market:    '마켓',
    watchlist: '왓치리스트',
    portfolio: '포트폴리오',
    history:   '매매일지',
    analysis:  '분석',
    ai:        'AI',
    news:      '뉴스',
    calendar:  '캘린더',
    settings:  '설정',
    loading:   '로딩 중…',
    error:     '오류 발생',
    buy:       '매수',
    sell:      '매도',
    profit:    '수익',
    loss:      '손실',
    change:    '변동',
    volume:    '거래량',
    high:      '고가',
    low:       '저가',
    open:      '시가',
    close:     '종가',
  },
  en: {
    market:    'Market',
    watchlist: 'Watchlist',
    portfolio: 'Portfolio',
    history:   'Journal',
    analysis:  'Analysis',
    ai:        'AI',
    news:      'News',
    calendar:  'Calendar',
    settings:  'Settings',
    loading:   'Loading…',
    error:     'Error',
    buy:       'Buy',
    sell:      'Sell',
    profit:    'Profit',
    loss:      'Loss',
    change:    'Change',
    volume:    'Volume',
    high:      'High',
    low:       'Low',
    open:      'Open',
    close:     'Close',
  },
  ja: {
    market:    'マーケット',
    watchlist: 'ウォッチリスト',
    portfolio: 'ポートフォリオ',
    history:   '取引日誌',
    analysis:  '分析',
    ai:        'AI',
    news:      'ニュース',
    calendar:  'カレンダー',
    settings:  '設定',
    loading:   '読み込み中…',
    error:     'エラー',
    buy:       '買い',
    sell:      '売り',
    profit:    '利益',
    loss:      '損失',
    change:    '変動',
    volume:    '出来高',
    high:      '高値',
    low:       '安値',
    open:      '始値',
    close:     '終値',
  },
};

// ── World Markets (for MarketPage) ────────────────────────────
export const WORLD_MARKETS: { id: string; name: string; flag: string; sym: string }[] = [
  { id: 'us',   name: '미국 (S&P500)',  flag: '🇺🇸', sym: 'SP:SPX'    },
  { id: 'kr',   name: '한국 (KOSPI)',   flag: '🇰🇷', sym: 'KRX:KOSPI' },
  { id: 'jp',   name: '일본 (닛케이)',  flag: '🇯🇵', sym: 'TVC:NI225' },
  { id: 'cn',   name: '중국 (상해)',    flag: '🇨🇳', sym: 'SSE:000001'},
  { id: 'eu',   name: '유럽 (DAX)',     flag: '🇪🇺', sym: 'XETR:DAX'  },
  { id: 'uk',   name: '영국 (FTSE)',    flag: '🇬🇧', sym: 'UKXGBP:UKX'},
];

// ── Logo sources (for backward compat) ────────────────────────
export const LOGO_SOURCES: Record<string, string> = {
  BTC:    'https://cryptologos.cc/logos/bitcoin-btc-logo.png',
  ETH:    'https://cryptologos.cc/logos/ethereum-eth-logo.png',
  SOL:    'https://cryptologos.cc/logos/solana-sol-logo.png',
  BNB:    'https://cryptologos.cc/logos/bnb-bnb-logo.png',
  XRP:    'https://cryptologos.cc/logos/xrp-xrp-logo.png',
  DOGE:   'https://cryptologos.cc/logos/dogecoin-doge-logo.png',
  ADA:    'https://cryptologos.cc/logos/cardano-ada-logo.png',
  AVAX:   'https://cryptologos.cc/logos/avalanche-avax-logo.png',
  TON:    'https://cryptologos.cc/logos/toncoin-ton-logo.png',
  LINK:   'https://cryptologos.cc/logos/chainlink-link-logo.png',
  AAPL:   'https://logo.clearbit.com/apple.com',
  MSFT:   'https://logo.clearbit.com/microsoft.com',
  NVDA:   'https://logo.clearbit.com/nvidia.com',
  TSLA:   'https://logo.clearbit.com/tesla.com',
  GOOGL:  'https://logo.clearbit.com/google.com',
  AMZN:   'https://logo.clearbit.com/amazon.com',
  META:   'https://logo.clearbit.com/meta.com',
};

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  content?: string;
  source: string;
  category: '코인'|'주식'|'ETF'|'매크로'|'국내'|'AI/테크'|'에너지';
  sentiment: 'bullish'|'bearish'|'neutral';
  time: string;
  publishedAt?: string;
  thumbnail?: string;
  tickers?: string[];
  url?: string;
  aiSummary?: string;
}

export interface EconEvent {
  id: string;
  date: string;
  time: string;
  event: string;
  country: string;
  impact: 'high'|'medium'|'low';
  previous?: string;
  forecast?: string;
  actual?: string;
  affectedAssets?: string[];
  note?: string;
}

export interface WatchlistItem {
  ticker: string;
  tvSymbol: string;
  koreanName: string;
  englishName: string;
  category: string;
  exchange: string;
  logoUrl?: string;
  addedAt: string;
}

// ── News ─────────────────────────────────────────────────────
export const MOCK_NEWS: NewsItem[] = [
  {
    id:'n1',
    title:'비트코인 94,230,000원 돌파… 기관 매수세 강화',
    summary:'미국 현물 ETF에 3.2억 달러 순유입. 기관 매수 지속. 블랙록 IBIT 거래량 신고점 기록.',
    content:'미국 비트코인 현물 ETF 시장에서 기관투자자들의 매수세가 거세지고 있습니다. 블랙록의 IBIT는 하루 거래량 기준 신고점을 기록했으며, 피델리티의 FBTC도 3억 달러 이상의 순유입을 기록했습니다. 전문가들은 이번 상승이 단기 투기가 아닌 구조적 기관 수요에 기반한다고 분석하고 있습니다.',
    source:'CoinDesk',
    category:'코인',
    sentiment:'bullish',
    time:'5분 전',
    publishedAt:'2025-05-16T09:25:00',
    tickers:['BTC','ETH'],
    url:'https://coindesk.com',
  },
  {
    id:'n2',
    title:'엔비디아 실적 어닝서프라이즈… 시간외 +4.1%',
    summary:'분기 매출이 시장 예상을 40% 초과. AI 데이터센터 수요 폭증. H100 공급 부족 지속.',
    content:'엔비디아(NVDA)가 발표한 4분기 실적이 월가 예상치를 대폭 상회했습니다. EPS는 $0.89로 컨센서스 $0.61을 46% 초과했으며, 매출은 $24.6B로 가이던스 $20.0B를 크게 넘어섰습니다. 데이터센터 부문이 전체 매출의 87%를 차지했으며, H100/H200 GPU 수요는 내년까지 공급이 따라가지 못할 것으로 전망됩니다.',
    source:'Reuters',
    category:'주식',
    sentiment:'bullish',
    time:'12분 전',
    publishedAt:'2025-05-16T09:18:00',
    tickers:['NVDA','AMD','INTC'],
    url:'https://reuters.com',
  },
  {
    id:'n3',
    title:'연준 금리 동결 유지… 9월 인하 기대감 상승',
    summary:'파월 의장이 9월 인하 가능성을 시사. 달러 약세 전환. 국채 금리 하락.',
    content:'미 연방준비제도(Fed)는 이번 FOMC에서 기준금리를 4.25~4.50%로 동결했습니다. 제롬 파월 의장은 기자회견에서 "인플레이션이 목표치에 충분히 근접하면 금리 인하를 검토할 것"이라며 9월 인하 가능성을 열어뒀습니다. 시장은 CME FedWatch 기준 9월 25bp 인하 확률을 72%로 보고 있습니다.',
    source:'Bloomberg',
    category:'매크로',
    sentiment:'bullish',
    time:'28분 전',
    publishedAt:'2025-05-16T09:02:00',
    tickers:['DXY','SPX','BTC'],
    url:'https://bloomberg.com',
  },
  {
    id:'n4',
    title:'코스피 외국인 순매도 3,200억… 약세 흐름',
    summary:'원·달러 환율 상승으로 지수 약세. 반도체 업종 하락. 삼성전자 52주 신저가 근접.',
    content:'코스피 지수가 외국인의 대규모 매도세로 0.8% 하락했습니다. 원·달러 환율이 장중 1,380원을 돌파하면서 수출주 중심의 매도세가 이어졌습니다. 삼성전자는 HBM 경쟁력 우려 속에 52주 신저가에 근접했습니다.',
    source:'연합뉴스',
    category:'국내',
    sentiment:'bearish',
    time:'35분 전',
    publishedAt:'2025-05-16T08:55:00',
    tickers:['005930','000660'],
    url:'https://yonhapnews.co.kr',
  },
  {
    id:'n5',
    title:'솔라나 ETF 승인 기대감… SOL +12% 급등',
    summary:'SEC 솔라나 현물 ETF 심사 착수 소식에 급등. 거래량 3배 증가.',
    content:'미국 증권거래위원회(SEC)가 VanEck의 솔라나 현물 ETF 신청을 공식 심사 일정에 포함시키면서 SOL 가격이 급등했습니다. 시장은 비트코인·이더리움 ETF 승인 선례를 고려해 솔라나 ETF 승인 가능성을 낙관적으로 보고 있습니다.',
    source:'CoinTelegraph',
    category:'코인',
    sentiment:'bullish',
    time:'1시간 전',
    publishedAt:'2025-05-16T08:30:00',
    tickers:['SOL','BTC','ETH'],
    url:'https://cointelegraph.com',
  },
  {
    id:'n6',
    title:'SOXL 반도체 ETF +8%… AI 반도체 랠리',
    summary:'NVDA 실적 호조로 반도체 섹터 전반 급등. SOXL 3배 레버리지 ETF 수혜.',
    content:'반도체 레버리지 ETF SOXL이 장 전 거래에서 8% 이상 급등했습니다. 엔비디아 실적 서프라이즈가 AMD, Broadcom 등 AI 반도체 관련주 전반에 긍정적인 영향을 미치고 있습니다. SOXX 반도체 지수도 3.2% 상승하며 52주 신고가에 근접했습니다.',
    source:'MarketWatch',
    category:'ETF',
    sentiment:'bullish',
    time:'2시간 전',
    publishedAt:'2025-05-16T07:30:00',
    tickers:['SOXL','NVDA','AMD','AVGO'],
    url:'https://marketwatch.com',
  },
  {
    id:'n7',
    title:'WTI 원유 85달러 돌파… OPEC+ 감산 연장',
    summary:'OPEC+ 감산 합의 연장 소식에 유가 급등. 에너지 섹터 강세.',
    content:'OPEC+가 2025년 말까지 자발적 감산을 연장하기로 합의했습니다. 이에 WTI 원유 선물이 배럴당 85달러를 돌파했습니다. XOM, CVX 등 에너지 대형주와 관련 ETF XLE가 강세를 보이고 있습니다.',
    source:'CNBC',
    category:'에너지',
    sentiment:'bullish',
    time:'3시간 전',
    publishedAt:'2025-05-16T06:30:00',
    tickers:['USOIL','XOM','CVX'],
    url:'https://cnbc.com',
  },
  {
    id:'n8',
    title:'팔란티어 AI 계약 수주… 국방부 5억달러',
    summary:'미 국방부와 5억 달러 AI 데이터 분석 계약. 주가 시간외 +6%.',
    content:'팔란티어(PLTR)가 미국 국방부와 5억 달러 규모의 AI 데이터 분석 플랫폼 계약을 체결했다고 발표했습니다. 이번 계약으로 팔란티어의 방산 AI 시장 점유율이 더욱 확고해질 전망입니다.',
    source:'Reuters',
    category:'AI/테크',
    sentiment:'bullish',
    time:'4시간 전',
    publishedAt:'2025-05-16T05:30:00',
    tickers:['PLTR','LMT'],
    url:'https://reuters.com',
  },
];

// ── Economic Calendar ─────────────────────────────────────────
export const ECON_EVENTS: EconEvent[] = [
  {id:'e1',date:'05-16',time:'21:30',event:'미국 소매판매 (MoM)',country:'🇺🇸',impact:'medium',previous:'0.7%',forecast:'0.4%',affectedAssets:['SPX','DXY','USD'],note:'소비 동향 지표'},
  {id:'e2',date:'05-16',time:'23:00',event:'미시간 소비자심리 예비치',country:'🇺🇸',impact:'medium',previous:'77.2',forecast:'76.0',affectedAssets:['SPX','NASDAQ']},
  {id:'e3',date:'05-20',time:'22:30',event:'미국 건축허가',country:'🇺🇸',impact:'low',previous:'1.46M',forecast:'1.43M',affectedAssets:['SPX']},
  {id:'e4',date:'05-22',time:'21:30',event:'미국 신규 실업수당 청구',country:'🇺🇸',impact:'medium',previous:'228K',forecast:'220K',affectedAssets:['DXY','SPX']},
  {id:'e5',date:'05-23',time:'03:00',event:'연준 FOMC 회의록',country:'🇺🇸',impact:'high',previous:'-',forecast:'-',affectedAssets:['BTC','SPX','DXY','GOLD'],note:'금리 방향성 단서'},
  {id:'e6',date:'05-28',time:'22:00',event:'FOMC 금리 결정',country:'🇺🇸',impact:'high',previous:'4.50%',forecast:'4.25%',affectedAssets:['BTC','SPX','NDX','DXY','GOLD'],note:'⚠️ 자동매매 일시정지 권장'},
  {id:'e7',date:'06-06',time:'21:30',event:'미국 비농업 고용 (NFP)',country:'🇺🇸',impact:'high',previous:'228K',forecast:'185K',affectedAssets:['DXY','SPX','BTC','GOLD'],note:'⚠️ 변동성 극대화 예상'},
  {id:'e8',date:'06-11',time:'21:30',event:'미국 소비자물가 (CPI)',country:'🇺🇸',impact:'high',previous:'2.4%',forecast:'2.3%',affectedAssets:['BTC','SPX','DXY','GOLD','NASDAQ'],note:'⚠️ 30분 전후 자동매매 주의'},
  {id:'e9',date:'05-28',time:'07:00',event:'한국 기준금리 결정',country:'🇰🇷',impact:'high',previous:'3.50%',forecast:'3.25%',affectedAssets:['USDKRW','005930'],note:'BOK 통화정책위원회'},
  {id:'e10',date:'05-19',time:'장마감',event:'테슬라 주주총회',country:'🇺🇸',impact:'medium',previous:'-',forecast:'-',affectedAssets:['TSLA'],note:'CEO 보수안 투표'},
  {id:'e11',date:'05-21',time:'장마감',event:'엔비디아 실적발표',country:'🇺🇸',impact:'high',previous:'$0.61',forecast:'$0.89',affectedAssets:['NVDA','AMD','SOXL','INTC'],note:'AI 반도체 전체 영향'},
  {id:'e12',date:'06-01',time:'21:30',event:'미국 PCE 가격지수',country:'🇺🇸',impact:'high',previous:'2.7%',forecast:'2.6%',affectedAssets:['SPX','BTC','DXY'],note:'연준 선호 인플레 지표'},
  {id:'e13',date:'06-15',time:'21:30',event:'미국 생산자물가 (PPI)',country:'🇺🇸',impact:'medium',previous:'0.5%',forecast:'0.3%',affectedAssets:['DXY','SPX']},
  {id:'e14',date:'06-27',time:'22:30',event:'미국 GDP 성장률 (확정)',country:'🇺🇸',impact:'medium',previous:'1.6%',forecast:'1.4%',affectedAssets:['DXY','SPX','GOLD']},
];

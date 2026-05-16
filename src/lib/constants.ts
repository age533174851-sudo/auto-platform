// ─────────────────────────────────────────────────────────────
// TRAIGO Constants — News, Events, Watchlist data
// ─────────────────────────────────────────────────────────────

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

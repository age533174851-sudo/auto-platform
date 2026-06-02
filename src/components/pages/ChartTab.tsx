'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Keyboard, Maximize, LayoutGrid } from 'lucide-react';
import { T } from '@/lib/constants';
import { Logo, ChartContainer } from './SharedUI';

// TradingView asset type
interface TVAsset {
  sym: string;
  label: string;
  tv: string;
  cat: string;
  clr: string;
  logo?: string;
  feat?: boolean;
}

// TV_STOCKS_US alias (shares same structure)
const TV_STOCKS_US: TVAsset[] = [];  // populated by SharedUI data

/* ─── Core Drawing Types ─── */
type DrawingToolId = string;
type DrawingPoint  = { x: number; y: number; price?: number; bar?: number };

interface DrawingObject {
  id: string;
  toolId: DrawingToolId;
  toolLabel: string;
  symbol: string;
  timeframe: string;
  points: DrawingPoint[];
  priceLevel?: number;
  priceLevel2?: number;
  text?: string;
  style: {
    color: string;
    width: number;
    dash: 'solid'|'dashed'|'dotted';
    fillColor?: string;
    fillOpacity?: number;
    textSize?: number;
    fontWeight?: 'normal'|'bold';
    opacity?: number;
  };
  locked: boolean;
  hidden: boolean;
  selected?: boolean;
  name?: string;
  createdAt: string;
  updatedAt: string;
  // Risk tool fields
  riskEntry?: number;
  riskSL?: number;
  riskTP?: number;
  // Fib fields
  fibLevels?: { level: number; label: string; color: string }[];
}

interface DrawingAction {
  type: 'add'|'delete'|'update'|'move';
  prev: DrawingObject | null;
  next: DrawingObject | null;
}

interface LayoutData {
  id: string;
  name: string;
  symbol: string;
  interval: string;
  chartType: string;
  indicators: string[];
  drawings: DrawingObject[];
  chartType2?: string;
  symbol2?: string;
  createdAt: string;
  updatedAt: string;
}

/* ─── Drawing Tool Definitions ─── */
type DrawingTool = { id:string; label:string; icon:string; group:string };

const TV_ETFS: TVAsset[] = [
  {sym:'SPY',  label:'S&P500 ETF',    tv:'AMEX:SPY',    cat:'etf', clr:'#1D4ED8',logo:'ssga.com',   featured:true},
  {sym:'QQQ',  label:'나스닥100 ETF', tv:'NASDAQ:QQQ',  cat:'etf', clr:'#7C3AED',                  featured:true},
  {sym:'IWM',  label:'러셀2000 ETF',  tv:'AMEX:IWM',    cat:'etf', clr:'#059669',                  featured:true},
  {sym:'DIA',  label:'다우존스 ETF',  tv:'AMEX:DIA',    cat:'etf', clr:'#D97706',                  featured:true},
  {sym:'VTI',  label:'미국전체시장',  tv:'AMEX:VTI',    cat:'etf', clr:'#1D4ED8'},
  {sym:'VOO',  label:'뱅가드S&P500',  tv:'AMEX:VOO',    cat:'etf', clr:'#1D4ED8'},
  {sym:'GLD',  label:'금 ETF',        tv:'AMEX:GLD',    cat:'etf', clr:'#D97706'},
  {sym:'SLV',  label:'은 ETF',        tv:'AMEX:SLV',    cat:'etf', clr:'#94A3B8'},
  {sym:'USO',  label:'WTI원유 ETF',   tv:'AMEX:USO',    cat:'etf', clr:'#78350F'},
  {sym:'TLT',  label:'20년 국채 ETF', tv:'NASDAQ:TLT',  cat:'etf', clr:'#1D4ED8'},
  {sym:'HYG',  label:'하이일드채권',  tv:'AMEX:HYG',    cat:'etf', clr:'#059669'},
  {sym:'TQQQ', label:'나스닥3배레버리지',tv:'NASDAQ:TQQQ',cat:'etf',clr:'#7C3AED',               featured:true},
  {sym:'SQQQ', label:'나스닥3배인버스',tv:'NASDAQ:SQQQ', cat:'etf',clr:'#DC2626',                  featured:true},
  {sym:'SOXL', label:'반도체3배레버리지',tv:'AMEX:SOXL', cat:'etf', clr:'#7C3AED',                featured:true},
  {sym:'SOXS', label:'반도체3배인버스',tv:'AMEX:SOXS',  cat:'etf', clr:'#DC2626',                  featured:true},
  {sym:'UPRO', label:'S&P3배레버리지', tv:'AMEX:UPRO',  cat:'etf', clr:'#1D4ED8'},
  {sym:'SPXS', label:'S&P3배인버스',  tv:'AMEX:SPXS',   cat:'etf', clr:'#DC2626'},
  {sym:'ARKK', label:'ARK이노베이션', tv:'AMEX:ARKK',   cat:'etf', clr:'#7C3AED',logo:'ark-invest.com',featured:true},
  {sym:'ARKW', label:'ARK넥스트인터넷',tv:'AMEX:ARKW',  cat:'etf', clr:'#7C3AED'},
  {sym:'XLK',  label:'기술섹터 ETF',  tv:'AMEX:XLK',    cat:'etf', clr:'#2563EB'},
  {sym:'XLF',  label:'금융섹터 ETF',  tv:'AMEX:XLF',    cat:'etf', clr:'#059669'},
  {sym:'XLE',  label:'에너지섹터 ETF',tv:'AMEX:XLE',    cat:'etf', clr:'#D97706'},
  {sym:'XLV',  label:'헬스케어섹터',  tv:'AMEX:XLV',    cat:'etf', clr:'#DC2626'},
  {sym:'SOXX', label:'반도체 ETF',    tv:'NASDAQ:SOXX', cat:'etf', clr:'#7C3AED'},
  {sym:'VXX',  label:'VIX ETF(단기)', tv:'AMEX:VXX',    cat:'etf', clr:'#6B7280'},
];

// Indices & Macro
const TV_INDICES: TVAsset[] = [
  {sym:'SPX',  label:'S&P 500',       tv:'SP:SPX',      cat:'index',  clr:'#6366F1',featured:true},
  {sym:'NDX',  label:'나스닥100',      tv:'NASDAQ:NDX',  cat:'index',  clr:'#7C3AED',featured:true},
  {sym:'DJI',  label:'다우존스',       tv:'DJ:DJI',      cat:'index',  clr:'#1D4ED8',featured:true},
  {sym:'RUT',  label:'러셀2000',       tv:'TVC:RUT',     cat:'index',  clr:'#059669'},
  {sym:'VIX',  label:'공포지수 VIX',  tv:'TVC:VIX',     cat:'index',  clr:'#DC2626'},
  {sym:'DXY',  label:'달러인덱스',     tv:'TVC:DXY',     cat:'index',  clr:'#10B981',featured:true},
  {sym:'KOSPI',label:'코스피',         tv:'KRX:KOSPI',   cat:'krstock',clr:'#EF4444'},
  {sym:'N225', label:'닛케이225',      tv:'TVC:NI225',   cat:'index',  clr:'#DC2626'},
  {sym:'HSI',  label:'항셍지수',       tv:'HSI:HSI',     cat:'index',  clr:'#DC2626'},
  {sym:'DAX',  label:'독일DAX',        tv:'XETR:DAX',    cat:'index',  clr:'#1D4ED8'},
  {sym:'FTSE', label:'영국FTSE100',    tv:'INDEX:FTSE',  cat:'index',  clr:'#003087'},
  {sym:'CAC',  label:'프랑스CAC40',    tv:'EURONEXT:CAC',cat:'index',  clr:'#003087'},
];

// Crypto (top 30)
const TV_CRYPTO: TVAsset[] = [
  {sym:'BTC',  label:'비트코인',       tv:'BINANCE:BTCUSDT', cat:'crypto',clr:'#F7931A',featured:true},
  {sym:'ETH',  label:'이더리움',       tv:'BINANCE:ETHUSDT', cat:'crypto',clr:'#627EEA',featured:true},
  {sym:'SOL',  label:'솔라나',         tv:'BINANCE:SOLUSDT', cat:'crypto',clr:'#9945FF',featured:true},
  {sym:'BNB',  label:'바이낸스코인',   tv:'BINANCE:BNBUSDT', cat:'crypto',clr:'#F3BA2F'},
  {sym:'XRP',  label:'리플',           tv:'BINANCE:XRPUSDT', cat:'crypto',clr:'#346AA9'},
  {sym:'DOGE', label:'도지코인',       tv:'BINANCE:DOGEUSDT',cat:'crypto',clr:'#C2A633',featured:true},
  {sym:'ADA',  label:'에이다',         tv:'BINANCE:ADAUSDT', cat:'crypto',clr:'#0D1E2D'},
  {sym:'AVAX', label:'아발란체',       tv:'BINANCE:AVAXUSDT',cat:'crypto',clr:'#E84142'},
  {sym:'LINK', label:'체인링크',       tv:'BINANCE:LINKUSDT',cat:'crypto',clr:'#2A5ADA'},
  {sym:'DOT',  label:'폴카닷',         tv:'BINANCE:DOTUSDT', cat:'crypto',clr:'#E6007A'},
  {sym:'MATIC',label:'폴리곤',         tv:'BINANCE:MATICUSDT',cat:'crypto',clr:'#8247E5'},
  {sym:'UNI',  label:'유니스왑',       tv:'BINANCE:UNIUSDT', cat:'crypto',clr:'#FF007A'},
  {sym:'ARB',  label:'아비트럼',       tv:'BINANCE:ARBUSDT', cat:'crypto',clr:'#28A0F0'},
  {sym:'OP',   label:'옵티미즘',       tv:'BINANCE:OPUSDT',  cat:'crypto',clr:'#FF0420'},
  {sym:'SUI',  label:'수이',           tv:'BINANCE:SUIUSDT', cat:'crypto',clr:'#4CA3FF'},
  {sym:'TON',  label:'톤코인',         tv:'BINANCE:TONUSDT', cat:'crypto',clr:'#0088CC'},
  {sym:'SHIB', label:'시바이누',       tv:'BINANCE:SHIBUSDT',cat:'crypto',clr:'#FFA409'},
  {sym:'PEPE', label:'페페',           tv:'BINANCE:PEPEUSDT',cat:'crypto',clr:'#3BA14C',featured:true},
  {sym:'APT',  label:'앱토스',         tv:'BINANCE:APTUSDT', cat:'crypto',clr:'#00C7B2'},
  {sym:'INJ',  label:'인젝티브',       tv:'BINANCE:INJUSDT', cat:'crypto',clr:'#00F2FE'},
];

// Korean stocks
const TV_KRSTOCKS: TVAsset[] = [
  {sym:'005930',label:'삼성전자',   tv:'KRX:005930',  cat:'krstock',clr:'#1428A0',featured:true},
  {sym:'000660',label:'SK하이닉스', tv:'KRX:000660',  cat:'krstock',clr:'#EA1917',featured:true},
  {sym:'035420',label:'NAVER',      tv:'KRX:035420',  cat:'krstock',clr:'#03C75A'},
  {sym:'035720',label:'카카오',     tv:'KRX:035720',  cat:'krstock',clr:'#FEE500'},
  {sym:'005380',label:'현대차',     tv:'KRX:005380',  cat:'krstock',clr:'#002C5F'},
  {sym:'000270',label:'기아',       tv:'KRX:000270',  cat:'krstock',clr:'#05141F'},
  {sym:'051910',label:'LG화학',     tv:'KRX:051910',  cat:'krstock',clr:'#A50034'},
  {sym:'006400',label:'삼성SDI',    tv:'KRX:006400',  cat:'krstock',clr:'#1428A0'},
  {sym:'207940',label:'삼성바이오로직스',tv:'KRX:207940',cat:'krstock',clr:'#004185'},
  {sym:'003550',label:'LG전자',     tv:'KRX:003550',  cat:'krstock',clr:'#A50034'},
  {sym:'017670',label:'SK텔레콤',   tv:'KRX:017670',  cat:'krstock',clr:'#E2007A'},
  {sym:'055550',label:'신한지주',   tv:'KRX:055550',  cat:'krstock',clr:'#0046FF'},
  {sym:'105560',label:'KB금융',     tv:'KRX:105560',  cat:'krstock',clr:'#FFB300'},
  {sym:'086790',label:'하나금융지주',tv:'KRX:086790', cat:'krstock',clr:'#009F6B'},
];

// Commodities & Forex
const TV_MACRO: TVAsset[] = [
  {sym:'XAUUSD',label:'금(Gold)',    tv:'OANDA:XAUUSD',cat:'commodity',clr:'#FFD700',featured:true},
  {sym:'XAGUSD',label:'은(Silver)',  tv:'OANDA:XAGUSD',cat:'commodity',clr:'#94A3B8'},
  {sym:'USOIL', label:'WTI 원유',    tv:'TVC:USOIL',   cat:'commodity',clr:'#78350F',featured:true},
  {sym:'UKOIL', label:'브렌트유',    tv:'TVC:UKOIL',   cat:'commodity',clr:'#78350F'},
  {sym:'NATGAS',label:'천연가스',    tv:'NYMEX:NG1!',  cat:'commodity',clr:'#2563EB'},
  {sym:'COPPER',label:'구리',        tv:'TVC:COPPER',  cat:'commodity',clr:'#B45309'},
  {sym:'WHEAT', label:'밀',          tv:'CBOT:ZW1!',   cat:'commodity',clr:'#92400E'},
  {sym:'CORN',  label:'옥수수',      tv:'CBOT:ZC1!',   cat:'commodity',clr:'#EAB308'},
  {sym:'EURUSD',label:'유로/달러',   tv:'FX:EURUSD',   cat:'forex',    clr:'#003399',featured:true},
  {sym:'USDJPY',label:'달러/엔',     tv:'FX:USDJPY',   cat:'forex',    clr:'#BC002D',featured:true},
  {sym:'GBPUSD',label:'파운드/달러', tv:'FX:GBPUSD',   cat:'forex',    clr:'#003087'},
  {sym:'USDKRW',label:'달러/원화',   tv:'FX:USDKRW',   cat:'forex',    clr:'#EF4444',featured:true},
  {sym:'BTCUSD',label:'비트코인/달러',tv:'INDEX:BTCUSD',cat:'forex',   clr:'#F7931A'},
];

// Deduplicate and merge all into TV_FEATURED
function dedup<T extends {tv:string}>(arr:T[]): T[] {
  const seen = new Set<string>();
  return arr.filter(x => { if(seen.has(x.tv)) return false; seen.add(x.tv); return true; });
}

const TV_FEATURED: TVAsset[] = dedup([
  ...TV_CRYPTO, ...TV_STOCKS_US, ...TV_ETFS, ...TV_INDICES, ...TV_KRSTOCKS, ...TV_MACRO,
]);

const TV_CAT_COLOR: Record<string,string> = {
  crypto:'#F7931A',stock:'#3B82F6',krstock:'#EF4444',
  etf:'#10B981',index:'#8B5CF6',commodity:'#D97706',forex:'#0891B2',
};

/* ── Inline TradingView Widget ── */
function InlineTVChart({ symbol, chartType='1', interval='60' }: { symbol:string; chartType?:string; interval?:string }) {
  if (!symbol) return (
    <div style={{height:'100%',display:'flex',alignItems:'center',justifyContent:'center',background:T.card,flexDirection:'column',gap:6}}>
      <span style={{fontSize:24}}>📊</span>
      <span style={{color:T.muted,fontSize:12}}>심볼을 선택하세요</span>
    </div>
  );

  const ref = useRef<HTMLDivElement>(null);
  const wid = useRef<any>(null);

  // Map our chart type ids → TradingView style numbers
  const TV_STYLE_MAP: Record<string,number> = {
    '1':1,'9':9,'2':2,'3':3,'0':0,'8':8,'10':10,'15':15,'16':16,
    '6':6,'habikinashi':8,'5':5,'11':11,'4':4,'12':12,'13':13,
    'vol_candle':1,'vol_footprint':1,'tpo':1,'session_vol':1,
  };

  useEffect(() => {
    if (!ref.current || typeof window === 'undefined') return;
    const el = ref.current;

    // Always rebuild widget when dependencies change (most reliable for chartType switching)
    // The key prop on the parent ensures remount when symbol/chartType/interval changes
    try { wid.current?.remove?.(); } catch {}
    wid.current = null;

    // Build a unique container id
    const cid = 'tv_' + Math.random().toString(36).slice(2, 8);
    el.innerHTML = '';
    const inner = document.createElement('div');
    inner.id = cid;
    inner.style.cssText = 'width:100%;height:100%;';
    el.appendChild(inner);

    const initWidget = () => {
      if (!inner || !(window as any).TradingView) return;
      try {
        wid.current = new (window as any).TradingView.widget({
          container_id: cid,
          symbol,
          interval: interval || '60',
          style: TV_STYLE_MAP[chartType] ?? 1,
          timezone: 'Asia/Seoul',
          theme: 'dark',
          locale: 'kr',
          toolbar_bg: '#060B14',
          enable_publishing: false,
          allow_symbol_change: true,
          save_image: false,
          hide_side_toolbar: false,
          withdateranges: true,
          hide_legend: false,
          studies: ['RSI@tv-basicstudies', 'MACD@tv-basicstudies'],
          width: '100%',
          height: '100%',
          backgroundColor: '#060B14',
          gridColor: '#1A2D4A',
          overrides: {
            'paneProperties.background': '#060B14',
            'paneProperties.backgroundType': 'solid',
          },
        });
      } catch {}
    };

    // Load TV script if not already loaded
    if ((window as any).TradingView) {
      initWidget();
    } else {
      const existing = document.getElementById('tv-script');
      if (!existing) {
        const script = document.createElement('script');
        script.id = 'tv-script';
        script.src = 'https://s3.tradingview.com/tv.js';
        script.async = true;
        script.onload = initWidget;
        script.onerror = () => {
          el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:8px;background:#0F1924;color:#475569;font-size:11px;">
            <span style="font-size:24px">📊</span>
            <div>${symbol}</div>
            <div>TradingView 차트 로딩 실패</div>
            <div style="font-size:9px">광고 차단기 확인 또는 새로고침</div>
          </div>`;
        };
        document.head.appendChild(script);
      } else {
        // Script tag exists, wait for it
        const wait = setInterval(() => {
          if ((window as any).TradingView) { clearInterval(wait); initWidget(); }
        }, 200);
        setTimeout(() => clearInterval(wait), 8000);
      }
    }

    return () => {
      try { wid.current?.remove?.(); } catch {}
      wid.current = null;
    };
  }, [symbol, chartType, interval]);

  return (
    <div ref={ref} style={{ width:'100%', height:'100%', borderRadius:'inherit', overflow:'hidden', background:'#060B14' }}/>
  );
}

/* ── Main inline chart tab ── */

const DRAWING_TOOLS: DrawingTool[] = [
  {id:'cursor',   label:'커서',           icon:'↗',  group:'tools'},
  {id:'ruler',    label:'자 (거리측정)',   icon:'📏', group:'tools'},
  {id:'eraser',   label:'지우개',         icon:'🧹', group:'tools'},
  {id:'magnet',   label:'자석 스냅',      icon:'🧲', group:'tools'},
  {id:'lock',     label:'모두 잠금',      icon:'🔒', group:'tools'},
  {id:'hide_all', label:'모두 숨기기',    icon:'👁', group:'tools'},
  {id:'trendline',label:'추세선',         icon:'/',  group:'trend'},
  {id:'hline',    label:'수평선',         icon:'—',  group:'trend'},
  {id:'vline',    label:'수직선',         icon:'|',  group:'trend'},
  {id:'cross',    label:'크로스선',       icon:'+',  group:'trend'},
  {id:'channel',  label:'채널',           icon:'⫿', group:'trend'},
  {id:'ray',      label:'레이',           icon:'→',  group:'trend'},
  {id:'regression',label:'회귀채널',      icon:'≈',  group:'trend'},
  {id:'fib_ret',  label:'피보나치 되돌림',icon:'🌀', group:'fib'},
  {id:'fib_ext',  label:'피보나치 확장',  icon:'↔', group:'fib'},
  {id:'fib_chan', label:'피보나치 채널',  icon:'🔀', group:'fib'},
  {id:'fib_time', label:'피보나치 타임존',icon:'⏱', group:'fib'},
  {id:'fib_fan',  label:'피보나치 팬',    icon:'🌈', group:'fib'},
  {id:'gann_fan', label:'갠 팬',          icon:'⚡', group:'fib'},
  {id:'gann_sq',  label:'갠 사각형',      icon:'⊞',  group:'fib'},
  {id:'xabcd',    label:'XABCD 패턴',    icon:'⛤',  group:'patterns'},
  {id:'abcd',     label:'ABCD 패턴',     icon:'◈',  group:'patterns'},
  {id:'triangle', label:'삼각형 패턴',   icon:'△',  group:'patterns'},
  {id:'hs',       label:'머리어깨',       icon:'⛰',  group:'patterns'},
  {id:'wave',     label:'엘리어트 파동', icon:'〜', group:'patterns'},
  {id:'wedge',    label:'웨지',           icon:'◁',  group:'patterns'},
  {id:'long_pos', label:'롱 포지션',      icon:'📈', group:'predict'},
  {id:'short_pos',label:'숏 포지션',      icon:'📉', group:'predict'},
  {id:'forecast', label:'예측 범위',      icon:'🔮', group:'predict'},
  {id:'vwap',     label:'앵커 VWAP',      icon:'⚓', group:'predict'},
  {id:'pricelvl', label:'가격 레벨',      icon:'━',  group:'predict'},
  {id:'brush',    label:'브러시',         icon:'🖌', group:'geo'},
  {id:'highlight',label:'하이라이터',     icon:'🖍', group:'geo'},
  {id:'arrow',    label:'화살표',         icon:'➤',  group:'geo'},
  {id:'rect',     label:'사각형',         icon:'□',  group:'geo'},
  {id:'ellipse',  label:'타원',           icon:'○',  group:'geo'},
  {id:'triangle2',label:'삼각형',         icon:'△',  group:'geo'},
  {id:'path',     label:'경로',           icon:'✏', group:'geo'},
  {id:'text',     label:'텍스트',         icon:'T',  group:'geo'},
  {id:'price_note',label:'가격 메모',     icon:'💬', group:'geo'},
  {id:'balloon',  label:'풍선',           icon:'💭', group:'geo'},
];

/* ─── Intervals ─── */
type Interval = { id:string; label:string; group:string };
const INTERVALS: Interval[] = [
  {id:'1T',  label:'1틱',   group:'tick'},  {id:'10T', label:'10틱',  group:'tick'},
  {id:'100T',label:'100틱', group:'tick'},  {id:'1000T',label:'1000틱',group:'tick'},
  {id:'1s',  label:'1초',   group:'seconds'},{id:'5s',  label:'5초',   group:'seconds'},
  {id:'10s', label:'10초',  group:'seconds'},{id:'15s', label:'15초',  group:'seconds'},
  {id:'30s', label:'30초',  group:'seconds'},
  {id:'1',   label:'1분',   group:'minutes'},{id:'2',   label:'2분',   group:'minutes'},
  {id:'3',   label:'3분',   group:'minutes'},{id:'5',   label:'5분',   group:'minutes'},
  {id:'10',  label:'10분',  group:'minutes'},{id:'15',  label:'15분',  group:'minutes'},
  {id:'30',  label:'30분',  group:'minutes'},{id:'45',  label:'45분',  group:'minutes'},
  {id:'60',  label:'1시간', group:'hours'},  {id:'120', label:'2시간', group:'hours'},
  {id:'180', label:'3시간', group:'hours'},  {id:'240', label:'4시간', group:'hours'},
  {id:'D',   label:'1일',   group:'days'},   {id:'W',   label:'1주',   group:'days'},
  {id:'M',   label:'1월',   group:'days'},   {id:'3M',  label:'3월',   group:'days'},
  {id:'6M',  label:'6월',   group:'days'},   {id:'12M', label:'1년',   group:'days'},
];

/* ─── Chart Types ─── */
type ChartType = { id:string; label:string; icon:string };
const CHART_TYPES: ChartType[] = [
  {id:'1',  label:'캔들스틱',      icon:'🕯'},{id:'9',  label:'속빈 캔들',  icon:'◻'},
  {id:'2',  label:'바',            icon:'⊟'},{id:'3',  label:'색상 바',    icon:'🎨'},
  {id:'0',  label:'선',            icon:'〰'},{id:'8',  label:'영역',       icon:'▽'},
  {id:'10', label:'기준선',        icon:'↕'},{id:'15', label:'스텝 라인',  icon:'⌐'},
  {id:'16', label:'HLC 영역',      icon:'≋'},{id:'6',  label:'고-저',      icon:'|'},
  {id:'habikinashi',label:'헤이킨 아시',icon:'🕯'},
  {id:'5',  label:'렌코',          icon:'🧱'},{id:'11', label:'카기',       icon:'⋮'},
  {id:'4',  label:'라인 브레이크', icon:'📉'},{id:'12', label:'포인트&피겨',icon:'✕'},
  {id:'13', label:'레인지 바',     icon:'📊'},
  {id:'vol_candle',label:'볼륨 캔들',icon:'📊'},
  {id:'vol_footprint',label:'볼륨 풋프린트',icon:'👣'},
  {id:'tpo',label:'TPO 차트',      icon:'⬡'},
  {id:'session_vol',label:'세션 볼륨',icon:'📈'},
];

const CHART_TYPE_DESC: Record<string,string> = {
  '1':'표준 캔들','9':'속빈 캔들','2':'OHLC 바','3':'색상 바','0':'선형',
  '8':'영역','10':'기준선','15':'스텝','16':'HLC 영역','6':'고가-저가',
  'habikinashi':'헤이킨 아시 평균 캔들','5':'렌코 벽돌','11':'카기','4':'라인 브레이크',
  '12':'포인트 & 피겨','13':'레인지 바','vol_candle':'볼륨 캔들',
  'vol_footprint':'볼륨 풋프린트','tpo':'TPO(시간·가격)','session_vol':'세션 볼륨 프로파일',
};

/* ─── Analysis Tab ─── */
type AnalysisTab = 'hub'|'layout'|'tools'|'drawing'|'interval'|'indicators'|'info'|'paper'|'pine'|'more';
type ObjectTree  = { id:string; type:string; symbol:string; color:string; visible:boolean; locked?:boolean; name?:string };
type ChartLayout = { id:string; name:string; symbols:string[]; intervals:string[]; createdAt:string };

/* ─── Indicator List ─── */
const INDICATORS_LIST = [
  {id:'RSI',    label:'RSI',                  category:'momentum',  key:'RSI@tv-basicstudies'},
  {id:'MACD',   label:'MACD',                 category:'momentum',  key:'MACD@tv-basicstudies'},
  {id:'BOLL',   label:'볼린저 밴드',           category:'volatility',key:'BB@tv-basicstudies'},
  {id:'EMA',    label:'지수이동평균 (EMA)',     category:'trend',     key:'EMA@tv-basicstudies'},
  {id:'SMA',    label:'단순이동평균 (SMA)',     category:'trend',     key:'SMA@tv-basicstudies'},
  {id:'VWAP',   label:'VWAP',                 category:'volume',    key:'VWAP@tv-basicstudies'},
  {id:'OBV',    label:'OBV',                  category:'volume',    key:'OBV@tv-basicstudies'},
  {id:'STOCH',  label:'스토캐스틱',            category:'momentum',  key:'Stochastic@tv-basicstudies'},
  {id:'ATR',    label:'ATR',                  category:'volatility',key:'ATR@tv-basicstudies'},
  {id:'ADX',    label:'ADX',                  category:'trend',     key:'DMI@tv-basicstudies'},
  {id:'CCI',    label:'CCI',                  category:'momentum',  key:'CCI@tv-basicstudies'},
  {id:'MFI',    label:'머니플로우',            category:'volume',    key:'MFI@tv-basicstudies'},
  {id:'WR',     label:'윌리엄스 %R',           category:'momentum',  key:'WilliamsR@tv-basicstudies'},
  {id:'ICHIMOKU',label:'일목균형표',           category:'trend',     key:'IchimokuCloud@tv-basicstudies'},
  {id:'PSAR',   label:'파라볼릭 SAR',          category:'trend',     key:'Parabolic SAR@tv-basicstudies'},
  {id:'PIVOT',  label:'피봇 포인트',           category:'trend',     key:'Pivot Points Standard@tv-basicstudies'},
  {id:'SUPER',  label:'슈퍼트렌드',            category:'trend',     key:'Supertrend@tv-basicstudies'},
  {id:'VOL',    label:'거래량',                category:'volume',    key:'Volume@tv-basicstudies'},
  {id:'RVOL',   label:'상대 거래량',           category:'volume',    key:'Relative Volume at Time@tv-basicstudies'},
  {id:'ACCUM',  label:'축적/분산',             category:'volume',    key:'Accumulation Distribution@tv-basicstudies'},
];

/* ─── Korean Search Map ─── */
const KR_SEARCH_MAP: Record<string,string> = {
  '비트코인':'BTC','이더리움':'ETH','솔라나':'SOL','엔비디아':'NVDA',
  '애플':'AAPL','테슬라':'TSLA','구글':'GOOGL','플래닛랩스':'PL',
};

/* ── Storage helpers ── */
const STORAGE_KEY_DRAWINGS = 'tg_drawings_v2';
const STORAGE_KEY_LAYOUTS  = 'tg_layouts_v2';

function loadDrawings(): DrawingObject[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_DRAWINGS) || '[]'); } catch { return []; }
}
function saveDrawings(drawings: DrawingObject[]): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY_DRAWINGS, JSON.stringify(drawings)); } catch {}
}
function loadLayouts(): LayoutData[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_LAYOUTS) || '[]'); } catch { return []; }
}
function saveLayouts(layouts: LayoutData[]): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY_LAYOUTS, JSON.stringify(layouts)); } catch {}
}

/* ── Default fib levels ── */
const DEFAULT_FIB_LEVELS = [
  { level: 0,     label: '0',     color: '#94A3B8' },
  { level: 0.236, label: '0.236', color: '#3B82F6' },
  { level: 0.382, label: '0.382', color: '#10B981' },
  { level: 0.5,   label: '0.5',   color: '#F59E0B' },
  { level: 0.618, label: '0.618', color: '#EF4444' },
  { level: 0.786, label: '0.786', color: '#7C3AED' },
  { level: 1,     label: '1',     color: '#94A3B8' },
  { level: 1.272, label: '1.272', color: '#0891B2' },
  { level: 1.618, label: '1.618', color: '#EF4444' },
];

/* ══════════════════════════════════════════════════════════════════
   AnalysisHubPage
   ══════════════════════════════════════════════════════════════════ */

function ChartTab() {
  const [sel,setSel]=useState<TVAsset>({sym:'BTC',label:'비트코인',tv:'BINANCE:BTCUSDT',cat:'crypto',clr:'#F7931A',featured:true});
  const [sel2,setSel2]=useState<TVAsset>({sym:'NVDA',label:'엔비디아',tv:'NASDAQ:NVDA',cat:'stock_ai',clr:'#76B900',featured:true});
  const [query,setQuery]=useState('');
  const [catFilt,setCatFilt]=useState<string>('featured');
  const [subCat,setSubCat]=useState<string>('all');
  const [layout,setLayout]=useState<'1'|'2h'>('1');
  const [manualSym,setManualSym]=useState('');
  const [showManual,setShowManual]=useState(false);
  const [liveData,setLiveData]=useState<Record<string,{price:number;change:number}>>({});
  const [provStatus,setProvStatus]=useState<{source:string;latency:number;status:string}|null>(null);
  const [recent,setRecent]=useState<TVAsset[]>(()=>{
    if(typeof window==='undefined') return [];
    try{return JSON.parse(localStorage.getItem('tg_tv_recent')||'[]');}catch{return [];}
  });
  const [watchlist,setWatchlist]=useState<TVAsset[]>(()=>{
    if(typeof window==='undefined') return [];
    try{return JSON.parse(localStorage.getItem('tg_tv_watchlist')||'[]');}catch{return [];}
  });

  useEffect(()=>{
    let cancelled=false;
    async function fetchData(){
      try{
        const res=await fetch('/api/prices');
        const json=await res.json();
        if(cancelled) return;
        setProvStatus({source:json.source,latency:json.latency,status:json.status});
        const map:Record<string,{price:number;change:number}>={};
        for(const item of (json.data||[])) map[item.symbol]={price:item.price,change:item.change24h};
        setLiveData(map);
      }catch{}
    }
    fetchData();
    const iv=setInterval(fetchData,15000);
    return()=>{cancelled=true;clearInterval(iv);};
  },[]);

  const pickAsset=(f:TVAsset)=>{
    setSel(f);setQuery('');
    const next=[f,...recent.filter(r=>r.tv!==f.tv)].slice(0,12);
    setRecent(next);
    if(typeof window!=='undefined') localStorage.setItem('tg_tv_recent',JSON.stringify(next));
  };

  const addWatchlist=(f:TVAsset)=>{
    const next=[f,...watchlist.filter(w=>w.tv!==f.tv)].slice(0,50);
    setWatchlist(next);
    if(typeof window!=='undefined') localStorage.setItem('tg_tv_watchlist',JSON.stringify(next));
  };

  const applyManual=()=>{
    if(!manualSym.trim()) return;
    const tv=tvSymbol(manualSym);
    const f:TVAsset={sym:manualSym.toUpperCase(),label:manualSym.toUpperCase(),tv,cat:'stock',clr:T.acl};
    pickAsset(f);setManualSym('');setShowManual(false);
  };

  // Category system
  const CAT_TABS=[
    {id:'featured',l:'인기',icon:'⭐'},
    {id:'crypto',l:'코인',icon:'₿'},
    {id:'stock',l:'미국주식',icon:'🇺🇸'},
    {id:'etf',l:'ETF',icon:'📦'},
    {id:'krstock',l:'한국',icon:'🇰🇷'},
    {id:'index',l:'지수',icon:'📊'},
    {id:'commodity',l:'원자재',icon:'🛢'},
    {id:'forex',l:'환율',icon:'💱'},
    {id:'watchlist',l:'관심',icon:'💜'},
    {id:'recent',l:'최근',icon:'🕐'},
  ];

  const STOCK_SUB=[
    {id:'all',l:'전체'},
    {id:'stock_tech',l:'테크'},
    {id:'stock_ai',l:'AI/반도체'},
    {id:'stock_finance',l:'금융'},
    {id:'stock_energy',l:'에너지'},
    {id:'stock_health',l:'헬스케어'},
    {id:'stock_consumer',l:'소비재'},
    {id:'stock_defense',l:'방산'},
    {id:'stock_meme',l:'밈주식'},
  ];

  // Get display list
  let displayList: TVAsset[];
  if(catFilt==='watchlist') displayList=watchlist;
  else if(catFilt==='recent') displayList=recent;
  else if(catFilt==='featured') displayList=TV_FEATURED.filter(f=>f.featured);
  else if(catFilt==='stock'){
    displayList = subCat==='all'
      ? TV_FEATURED.filter(f=>f.cat.startsWith('stock'))
      : TV_FEATURED.filter(f=>f.cat===subCat);
  }
  else if(catFilt==='crypto') displayList=TV_FEATURED.filter(f=>f.cat==='crypto');
  else if(catFilt==='etf')    displayList=TV_FEATURED.filter(f=>f.cat==='etf');
  else if(catFilt==='krstock') displayList=TV_FEATURED.filter(f=>f.cat==='krstock');
  else if(catFilt==='index')  displayList=TV_FEATURED.filter(f=>f.cat==='index'||f.cat==='krstock');
  else if(catFilt==='commodity') displayList=TV_FEATURED.filter(f=>f.cat==='commodity');
  else if(catFilt==='forex')  displayList=TV_FEATURED.filter(f=>f.cat==='forex');
  else displayList=TV_FEATURED;

  // Apply search
  if(query.trim()){
    const q=query.trim().toLowerCase();
    displayList=TV_FEATURED.filter(f=>
      f.sym.toLowerCase().includes(q)||
      f.label.includes(q)||
      f.tv.toLowerCase().includes(q)
    );
  }

  const selBase=sel.sym.replace('USDT','').replace('USD','');
  const selLive=liveData[selBase]||liveData[sel.sym];

  // Logo helper
  const Logo=({asset,size=22}:{asset:TVAsset;size?:number})=>(
    <div style={{width:size,height:size,borderRadius:size*0.3,background:`${asset.clr}20`,border:`1px solid ${asset.clr}40`,display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden',flexShrink:0}}>
      {asset.logo
        ? <img src={`https://logo.clearbit.com/${asset.logo}`} alt="" width={size} height={size}
            onError={e=>{try{(e.target as HTMLImageElement).style.display='none';}catch{}}}
            style={{objectFit:'contain',borderRadius:size*0.3}}/>
        : <span style={{fontSize:size*0.5,fontWeight:900,color:asset.clr}}>{asset.sym.slice(0,2)}</span>
      }
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div style={{background:'linear-gradient(135deg,#060B14,#0A0F1E)',border:`1px solid ${sel.clr}40`,borderRadius:18,padding:'14px 16px',marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
          <div style={{display:'flex',gap:8,alignItems:'center',flex:1}}>
            <Logo asset={sel} size={32}/>
            <div>
              <div style={{display:'flex',gap:5,alignItems:'center',flexWrap:'wrap'}}>
                <span style={{color:T.txt,fontWeight:800,fontSize:14}}>{sel.label}</span>
                <span style={{background:`${sel.clr}20`,color:sel.clr,fontSize:9,fontWeight:700,padding:'2px 6px',borderRadius:99}}>{sel.sym}</span>
                {provStatus&&<span style={{background:provStatus.status==='live'?T.grn+'20':T.ylw+'20',color:provStatus.status==='live'?T.grn:T.ylw,fontSize:8,fontWeight:700,padding:'1px 6px',borderRadius:99}}>{provStatus.status==='live'?'● LIVE':'● MOCK'} {provStatus.source}</span>}
              </div>
              <div style={{color:T.muted,fontSize:10,fontFamily:'monospace',marginTop:1}}>{sel.tv}</div>
            </div>
          </div>
          <div style={{textAlign:'right',flexShrink:0}}>
            {selLive?(
              <div>
                <div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>
                  {selLive.price>=1000?selLive.price.toLocaleString('ko-KR',{maximumFractionDigits:0})+'원':selLive.price.toFixed(4)}
                </div>
                <div style={{color:selLive.change>=0?T.grn:T.red,fontSize:11,fontWeight:700,textAlign:'right'}}>
                  {selLive.change>=0?'+':''}{selLive.change.toFixed(2)}%
                </div>
              </div>
            ):<div style={{color:T.muted,fontSize:10}}>가격 로딩 중…</div>}
          </div>
        </div>
        <div style={{display:'flex',gap:5,alignItems:'center',flexWrap:'wrap'}}>
          {(['1','2h'] as const).map(l=>(
            <button key={l} onClick={()=>setLayout(l)} style={{padding:'4px 9px',background:layout===l?T.acg:'transparent',color:layout===l?T.acl:T.muted,border:`1px solid ${layout===l?T.acl:T.border}`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>
              {l==='1'?'▣ 1':'⬒ 2분할'}
            </button>
          ))}
          <button onClick={()=>addWatchlist(sel)} style={{padding:'4px 9px',background:watchlist.some(w=>w.tv===sel.tv)?T.ylw+'20':'transparent',color:watchlist.some(w=>w.tv===sel.tv)?T.ylw:T.muted,border:`1px solid ${watchlist.some(w=>w.tv===sel.tv)?T.ylw:T.border}`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>
            {watchlist.some(w=>w.tv===sel.tv)?'★ 저장됨':'☆ 관심'}
          </button>
          <a href="/chart" target="_blank" style={{marginLeft:'auto',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'6px 12px',minHeight:30,fontSize:10,fontWeight:700,textDecoration:'none',display:'inline-flex',alignItems:'center',gap:4}}>
            <Maximize size={11} strokeWidth={2.4}/>전체 ↗
          </a>
        </div>
      </div>

      {/* Chart */}
      {layout==='1'&&(
        <ChartContainer storageKey="tg_chart_height_single" title={`${sel.sym} · ${sel.label}`}>
          <InlineTVChart symbol={sel.tv}/>
        </ChartContainer>
      )}
      {layout==='2h'&&(
        <div>
          <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:8}}>
            <ChartContainer storageKey="tg_chart_height_dual_a" defaultLevel="compact" title={`${sel.sym} · ${sel.label}`}>
              <InlineTVChart symbol={sel.tv}/>
            </ChartContainer>
            <ChartContainer storageKey="tg_chart_height_dual_b" defaultLevel="compact" title={`${sel2.sym} · ${sel2.label}`}>
              <InlineTVChart symbol={sel2.tv}/>
            </ChartContainer>
          </div>
          {/* Chart 2 selector - horizontal scroll of featured */}
          <div style={{display:'flex',gap:5,overflowX:'auto',marginBottom:8,paddingBottom:2}}>
            {TV_FEATURED.filter(f=>f.featured).slice(0,12).map(f=>(
              <button key={f.tv} onClick={()=>setSel2(f)} style={{flexShrink:0,background:sel2.tv===f.tv?f.clr+'20':T.card,border:`1px solid ${sel2.tv===f.tv?f.clr:T.border}`,borderRadius:8,padding:'4px 8px',cursor:'pointer',display:'flex',gap:4,alignItems:'center'}}>
                <Logo asset={f} size={14}/>
                <span style={{color:sel2.tv===f.tv?f.clr:T.txt,fontSize:9,fontWeight:700}}>{f.sym}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Search */}
      <div style={{display:'flex',gap:6,marginBottom:8}}>
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="검색: BTC, 애플, AAPL, 삼성, 005930…"
          style={{flex:1,background:T.card,border:`1px solid ${query?T.acl:T.border}`,borderRadius:10,padding:'9px 12px',color:T.txt,fontSize:12,outline:'none'}}/>
        <button onClick={()=>setShowManual(v=>!v)}
          aria-label="수동 심볼 입력"
          style={{background:showManual?T.acg:'transparent',color:showManual?T.acl:T.muted,border:`1px solid ${showManual?T.acl:T.border}`,borderRadius:10,padding:'9px 12px',minHeight:36,fontSize:11,fontWeight:700,cursor:'pointer',display:'inline-flex',alignItems:'center'}}>
          <Keyboard size={13} strokeWidth={2.4}/>
        </button>
      </div>

      {/* Manual input */}
      {showManual&&(
        <div style={{marginBottom:8}}>
          <div style={{display:'flex',gap:6,marginBottom:5}}>
            <input value={manualSym} onChange={e=>setManualSym(e.target.value.toUpperCase())} onKeyDown={e=>e.key==='Enter'&&applyManual()}
              placeholder="NASDAQ:AAPL, KRX:005930, BINANCE:BTCUSDT…"
              style={{flex:1,background:T.card,border:`1px solid ${T.acl}`,borderRadius:10,padding:'9px 12px',color:T.acl,fontSize:12,fontFamily:'monospace',fontWeight:700,outline:'none',letterSpacing:.5}}/>
            <button onClick={applyManual} style={{background:T.acc,color:'#fff',border:'none',borderRadius:10,padding:'9px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>차트</button>
          </div>
          {/* Symbol format hints */}
          <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
            {['NASDAQ:AAPL','NYSE:KO','AMEX:SPY','KRX:005930','BINANCE:BTCUSDT','OANDA:XAUUSD'].map(ex=>(
              <button key={ex} onClick={()=>setManualSym(ex)} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:6,padding:'3px 8px',color:T.muted,fontSize:9,fontFamily:'monospace',cursor:'pointer'}}>{ex}</button>
            ))}
          </div>
        </div>
      )}

      {/* Category tabs */}
      <div style={{display:'flex',gap:4,overflowX:'auto',paddingBottom:3,marginBottom:6}}>
        {CAT_TABS.map(c=>(
          <button key={c.id} onClick={()=>{setCatFilt(c.id);setSubCat('all');setQuery('');}} style={{flexShrink:0,padding:'5px 9px',background:catFilt===c.id?T.acg:'transparent',color:catFilt===c.id?T.acl:T.muted,border:`1px solid ${catFilt===c.id?T.acl:T.border}`,borderRadius:20,fontSize:10,fontWeight:700,cursor:'pointer'}}>
            {c.icon} {c.l}
            {c.id==='watchlist'&&watchlist.length>0&&<span style={{marginLeft:3,background:T.ylw+'20',color:T.ylw,borderRadius:99,padding:'0 4px',fontSize:8}}>{watchlist.length}</span>}
          </button>
        ))}
      </div>

      {/* Stock sub-category tabs */}
      {catFilt==='stock'&&!query&&(
        <div style={{display:'flex',gap:3,overflowX:'auto',paddingBottom:3,marginBottom:6}}>
          {STOCK_SUB.map(s=>(
            <button key={s.id} onClick={()=>setSubCat(s.id)} style={{flexShrink:0,padding:'3px 8px',background:subCat===s.id?T.prp+'20':'transparent',color:subCat===s.id?T.prp:T.muted,border:`1px solid ${subCat===s.id?T.prp:T.border}`,borderRadius:20,fontSize:9,fontWeight:700,cursor:'pointer'}}>
              {s.l}
            </button>
          ))}
        </div>
      )}

      {/* Stats row */}
      {!query&&(
        <div style={{color:T.muted,fontSize:9,marginBottom:6}}>
          {catFilt==='featured'?`인기 ${displayList.length}개`:
           catFilt==='watchlist'?`💜 관심종목 ${displayList.length}개`:
           catFilt==='recent'?`최근 ${displayList.length}개`:
           `${displayList.length}개 종목`}
          {catFilt==='stock'&&subCat==='all'&&` · 전 섹터 ${TV_FEATURED.filter(f=>f.cat.startsWith('stock')).length}개`}
        </div>
      )}
      {query&&<div style={{color:T.acl,fontSize:9,marginBottom:6}}>"{query}" 검색 결과: {displayList.length}개</div>}

      {/* Empty states */}
      {catFilt==='watchlist'&&watchlist.length===0&&(
        <div style={{textAlign:'center',padding:'30px 0'}}>
          <div style={{fontSize:28,marginBottom:6}}>💜</div>
          <div style={{color:T.muted,fontSize:12}}>관심 종목이 없습니다</div>
          <div style={{color:T.muted,fontSize:10,marginTop:3}}>종목 선택 후 ☆ 관심 버튼으로 추가하세요</div>
        </div>
      )}
      {catFilt==='recent'&&recent.length===0&&(
        <div style={{textAlign:'center',padding:'30px 0'}}>
          <div style={{color:T.muted,fontSize:12}}>최근 본 종목이 없습니다</div>
        </div>
      )}

      {/* Asset grid */}
      {displayList.length>0&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:5,marginBottom:12}}>
          {displayList.slice(0,80).map(f=>{
            const base=f.sym.replace('USDT','').replace('USD','');
            const live=liveData[base]||liveData[f.sym];
            const isActive=sel.tv===f.tv;
            const inWL=watchlist.some(w=>w.tv===f.tv);
            return (
              <button key={f.tv} onClick={()=>pickAsset(f)}
                style={{background:isActive?f.clr+'20':T.card,border:`2px solid ${isActive?f.clr:T.border}`,borderRadius:11,padding:'8px 5px',cursor:'pointer',textAlign:'center',position:'relative'}}>
                {inWL&&<div style={{position:'absolute',top:2,right:3,color:T.ylw,fontSize:7,fontWeight:900}}>★</div>}
                <Logo asset={f} size={24}/>
                <div style={{color:isActive?f.clr:T.txt,fontWeight:700,fontSize:9,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginTop:3}}>{f.sym.slice(0,7)}</div>
                {live?(
                  <div style={{color:live.change>=0?T.grn:T.red,fontSize:7,marginTop:1,fontWeight:700}}>{live.change>=0?'+':''}{live.change.toFixed(1)}%</div>
                ):(
                  <div style={{color:T.muted,fontSize:7,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{f.label.slice(0,5)}</div>
                )}
              </button>
            );
          })}
        </div>
      )}
      {displayList.length>80&&<div style={{color:T.muted,fontSize:10,textAlign:'center',marginBottom:8}}>표시: 80/{displayList.length}개 · 검색으로 종목을 찾아보세요</div>}

      {/* Provider & search hint */}
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 14px',marginBottom:8}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:5}}>
          <div style={{color:T.muted,fontSize:10,fontWeight:700}}>데이터 소스</div>
          <div style={{display:'flex',gap:6}}>
            {[{n:'Binance',s:'live'},{n:'Polygon',s:'live'}].map(p=>(
              <div key={p.n} style={{display:'flex',gap:2,alignItems:'center'}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:p.s==='live'?T.grn:T.muted}}/>
                <span style={{color:T.muted,fontSize:8}}>{p.n}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{color:T.muted,fontSize:9,lineHeight:1.5}}>
          🇺🇸 미국주식 전체: ⌨️ 직접 입력으로 TradingView 심볼 검색 (NASDAQ:AAPL, NYSE:KO)<br/>
          🔍 원하는 종목이 없으면 ⌨️ 직접 입력 → 관심 ☆ 저장
        </div>
      </div>

      <div style={{textAlign:'center'}}>
        <a href="/chart" target="_blank" style={{color:T.acl,fontSize:11,fontWeight:700,textDecoration:'none',display:'inline-flex',alignItems:'center',gap:5}}>
          <LayoutGrid size={11} strokeWidth={2.4}/>4분할 + 전체화면 전용 차트 ↗
        </a>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   TRAIGO DRAWING SYSTEM — 완전한 드로잉 엔진
   저장·복원·편집·실행취소·스타일·위험도구·피보나치
   ══════════════════════════════════════════════════════════════════ */

export default ChartTab;

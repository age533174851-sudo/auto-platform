'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { BarChart3, TrendingUp, TrendingDown, Radio, ArrowLeftRight, FlaskConical } from 'lucide-react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS, LOGO_SOURCES } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR, simulatePriceUpdate } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Dot, Spark, Pill, Bdg, Toggle, AreaChart, WorldClock, Heatmap,
         TradingChart, Logo, getBgColor, resolveLogoUrl, getKrName, cleanName, resolveTVSym,
         DonutChart, MiniBar, GlobalSearch, getLeverageRec,
         LiquidationCalc, PositionSizer, RiskDashboard,
         InlineTVChart } from './SharedUI';


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

function AnalysisHubPage() {
  /* ── Core state ── */
  const [tab,setTab]                 = useState<AnalysisTab>('hub');
  const [activeTool,setActiveTool]   = useState('cursor');
  const [activeInterval,setActiveInterval] = useState('60');
  const [chartType,setChartType]     = useState(()=>{ if(typeof window==='undefined') return '1'; try{return localStorage.getItem('tg_charttype')||'1';}catch{return '1';} });
  const [activeIndicators,setActiveIndicators] = useState<string[]>(['RSI','MACD']);
  const [indFilter,setIndFilter]     = useState('all');
  const [indSearch,setIndSearch]     = useState('');
  const [drawingGroup,setDrawingGroup] = useState('tools');
  const [showSheet,setShowSheet]     = useState(false);
  const [sheetContent,setSheetContent] = useState<'drawing'|'interval'|'charttype'|'objecttree'|'style'|'risk'|'fib'|'indicators'|'compare'|'alerts'|'replay'|'templates'|'symbol_info'|'financials'|'forecasts'|'technicals'|'idea'|'pine'|'help'|'paper_order'>('drawing');
  const [magnetMode,setMagnetMode]   = useState(false);
  const [customInterval,setCustomInterval] = useState('');

  /* ── Drawing state ── */
  const [drawings,setDrawings]       = useState<DrawingObject[]>(loadDrawings);
  const [selectedId,setSelectedId]   = useState<string|null>(null);
  const [undoStack,setUndoStack]     = useState<DrawingAction[]>([]);
  const [redoStack,setRedoStack]     = useState<DrawingAction[]>([]);
  const [editingDrawing,setEditingDrawing] = useState<DrawingObject|null>(null);
  const [showStyleEditor,setShowStyleEditor] = useState(false);

  /* ── Layout state ── */
  const [layouts,setLayouts]         = useState<LayoutData[]>(loadLayouts);
  const [activeLayout,setActiveLayout] = useState<string|null>(null);
  const [showSaveLayout,setShowSaveLayout] = useState(false);
  const [newLayoutName,setNewLayoutName] = useState('');
  const [symbol,setSymbol]           = useState('BINANCE:BTCUSDT');
  const [symbol2,setSymbol2]         = useState('NASDAQ:NVDA');

  /* ── Risk tool state ── */
  const [riskEntry,setRiskEntry]     = useState(94230000);
  const [riskSL,setRiskSL]           = useState(91200000);
  const [riskTP,setRiskTP]           = useState(99000000);
  const [riskSize,setRiskSize]       = useState(1000000);
  const [riskLeverage,setRiskLeverage] = useState(3);

  /* ── Fib state ── */
  const [fibLevels,setFibLevels]     = useState(DEFAULT_FIB_LEVELS);
  const [fibShowLabels,setFibShowLabels] = useState(true);
  const [fibReverse,setFibReverse]   = useState(false);

  /* ── Paper trading ── */
  const [paperSize]  = useState(1000000);
  const [paperPnl]   = useState(87400);
  const [paperTrades]= useState(12);

  /* ── Persist chartType ── */
  useEffect(()=>{ try{localStorage.setItem('tg_charttype',chartType);}catch{} },[chartType]);
  useEffect(()=>{ saveDrawings(drawings); },[drawings]);

  /* ── Drawing helpers ── */
  const pushUndo=(action:DrawingAction)=>{
    setUndoStack(s=>[action,...s].slice(0,50));
    setRedoStack([]);
  };

  const undo=()=>{
    if(!undoStack.length) return;
    const [action,...rest]=undoStack;
    setUndoStack(rest);
    setRedoStack(s=>[action,...s].slice(0,50));
    if(action.type==='add'&&action.next)     setDrawings(d=>d.filter(x=>x.id!==action.next!.id));
    if(action.type==='delete'&&action.prev)  setDrawings(d=>[...d,action.prev!]);
    if((action.type==='update'||action.type==='move')&&action.prev)
      setDrawings(d=>d.map(x=>x.id===action.prev!.id?action.prev!:x));
  };

  const redo=()=>{
    if(!redoStack.length) return;
    const [action,...rest]=redoStack;
    setRedoStack(rest);
    setUndoStack(s=>[action,...s].slice(0,50));
    if(action.type==='add'&&action.next)     setDrawings(d=>[...d,action.next!]);
    if(action.type==='delete'&&action.next)  setDrawings(d=>d.filter(x=>x.id!==action.next!.id));
    if((action.type==='update'||action.type==='move')&&action.next)
      setDrawings(d=>d.map(x=>x.id===action.next!.id?action.next!:x));
  };

  const addDrawing=(toolId:string,priceLevel?:number,priceLevel2?:number)=>{
    const tool=DRAWING_TOOLS.find(d=>d.id===toolId);
    if(!tool) return;
    const newD:DrawingObject={
      id:'d_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
      toolId, toolLabel:tool.label,
      symbol, timeframe:activeInterval,
      points:[], priceLevel, priceLevel2,
      style:{
        color: toolId==='long_pos'?'#10B981':toolId==='short_pos'?'#EF4444':'#3B82F6',
        width:2, dash:'solid', opacity:1, textSize:12, fontWeight:'normal',
        ...(toolId.includes('fib')?{fillColor:'#3B82F620',fillOpacity:0.1}:{}),
      },
      locked:false, hidden:false, selected:true,
      fibLevels: toolId.includes('fib')?[...DEFAULT_FIB_LEVELS]:undefined,
      riskEntry:  toolId==='long_pos'||toolId==='short_pos'?riskEntry:undefined,
      riskSL:     toolId==='long_pos'||toolId==='short_pos'?riskSL:undefined,
      riskTP:     toolId==='long_pos'||toolId==='short_pos'?riskTP:undefined,
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString(),
    };
    pushUndo({type:'add',prev:null,next:newD});
    setDrawings(d=>[newD,...d.map(x=>({...x,selected:false}))]);
    setSelectedId(newD.id);
    setActiveTool('cursor');
  };

  const deleteDrawing=(id:string)=>{
    const d=drawings.find(x=>x.id===id);
    if(!d) return;
    pushUndo({type:'delete',prev:d,next:null});
    setDrawings(prev=>prev.filter(x=>x.id!==id));
    if(selectedId===id) setSelectedId(null);
  };

  const duplicateDrawing=(id:string)=>{
    const d=drawings.find(x=>x.id===id);
    if(!d) return;
    const copy={...d,id:'d_'+Date.now().toString(36),name:(d.name||d.toolLabel)+' 복사',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),selected:true};
    pushUndo({type:'add',prev:null,next:copy});
    setDrawings(prev=>[copy,...prev.map(x=>({...x,selected:false}))]);
    setSelectedId(copy.id);
  };

  const updateDrawingStyle=(id:string,style:Partial<DrawingObject['style']>)=>{
    const prev=drawings.find(x=>x.id===id);
    if(!prev) return;
    const next={...prev,style:{...prev.style,...style},updatedAt:new Date().toISOString()};
    pushUndo({type:'update',prev,next});
    setDrawings(d=>d.map(x=>x.id===id?next:x));
  };

  const toggleLock=(id:string)=>setDrawings(d=>d.map(x=>x.id===id?{...x,locked:!x.locked,updatedAt:new Date().toISOString()}:x));
  const toggleVisible=(id:string)=>setDrawings(d=>d.map(x=>x.id===id?{...x,hidden:!x.hidden,updatedAt:new Date().toISOString()}:x));
  const renameDrawing=(id:string,name:string)=>setDrawings(d=>d.map(x=>x.id===id?{...x,name,updatedAt:new Date().toISOString()}:x));
  const clearAllDrawings=()=>{ setDrawings([]); setSelectedId(null); setUndoStack([]); setRedoStack([]); };

  /* ── Layout helpers ── */
  const saveCurrentLayout=()=>{
    if(!newLayoutName.trim()) return;
    const layout:LayoutData={
      id:'lay_'+Date.now().toString(36),
      name:newLayoutName.trim(),
      symbol, interval:activeInterval, chartType,
      indicators:activeIndicators,
      drawings:[...drawings],
      symbol2, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    };
    const next=[layout,...layouts].slice(0,20);
    setLayouts(next); saveLayouts(next);
    setActiveLayout(layout.id);
    setShowSaveLayout(false); setNewLayoutName('');
  };

  const loadLayout=(layout:LayoutData)=>{
    setSymbol(layout.symbol);
    setActiveInterval(layout.interval);
    setChartType(layout.chartType);
    setActiveIndicators(layout.indicators||[]);
    setDrawings(layout.drawings||[]);
    if(layout.symbol2) setSymbol2(layout.symbol2);
    setActiveLayout(layout.id);
  };

  const deleteLayout=(id:string)=>{
    const next=layouts.filter(l=>l.id!==id);
    setLayouts(next); saveLayouts(next);
    if(activeLayout===id) setActiveLayout(null);
  };

  const exportLayout=()=>{
    const layout:LayoutData={
      id:'export_'+Date.now().toString(36),
      name:'내보내기',
      symbol, interval:activeInterval, chartType,
      indicators:activeIndicators, drawings,
      symbol2, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    };
    const blob=new Blob([JSON.stringify(layout,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download=`traigo_layout_${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const importLayout=(e:React.ChangeEvent<HTMLInputElement>)=>{
    const file=e.target.files?.[0];
    if(!file) return;
    const reader=new FileReader();
    reader.onload=(ev)=>{
      try{
        const layout:LayoutData=JSON.parse(ev.target?.result as string);
        loadLayout(layout);
      }catch{}
    };
    reader.readAsText(file);
  };

  /* ── Risk calculations ── */
  const riskReward    = riskEntry > 0 ? Math.abs(riskTP-riskEntry)/Math.abs(riskEntry-riskSL) : 0;
  const expectedProfit= riskSize*riskLeverage*(Math.abs(riskTP-riskEntry)/riskEntry);
  const expectedLoss  = riskSize*riskLeverage*(Math.abs(riskEntry-riskSL)/riskEntry);
  const liqPct        = 100/riskLeverage*0.9;
  const liqPrice      = activeTool==='long_pos'? riskEntry*(1-liqPct/100) : riskEntry*(1+liqPct/100);

  /* ── Computed ── */
  const selectedDrawing = drawings.find(d=>d.id===selectedId)||null;
  const visibleDrawings = drawings.filter(d=>!d.hidden);
  const DRAWING_GROUPS=[
    {id:'tools',l:'도구'},{id:'trend',l:'추세'},{id:'fib',l:'피보/갠'},
    {id:'patterns',l:'패턴'},{id:'predict',l:'예측'},{id:'geo',l:'도형'},
  ];
  const INTERVAL_GROUPS=[
    {id:'tick',l:'틱'},{id:'seconds',l:'초'},{id:'minutes',l:'분'},
    {id:'hours',l:'시간'},{id:'days',l:'일/주/월'},
  ];
  const IND_CATS=['all','trend','momentum','volatility','volume'];
  const filteredInds=INDICATORS_LIST.filter(i=>
    (indFilter==='all'||i.category===indFilter)&&
    (indSearch===''||i.label.includes(indSearch)||i.id.toLowerCase().includes(indSearch.toLowerCase()))
  );
  const openSheet=(c:'drawing'|'interval'|'charttype'|'objecttree'|'style'|'risk'|'fib')=>{setSheetContent(c);setShowSheet(true);};
  const toggleIndicator=(id:string)=>setActiveIndicators(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);

  /* ── Style editor values ── */
  const selStyle=selectedDrawing?.style||{color:'#3B82F6',width:2,dash:'solid',opacity:1,textSize:12,fontWeight:'normal'};

  /* ── Bottom sheet ── */
  const BottomSheet=({title,children}:{title:string;children:React.ReactNode})=>(
    <>
      <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200,touchAction:'none'}} onClick={()=>setShowSheet(false)}/>
      <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',maxHeight:'85vh',overflowY:'auto',border:`1px solid ${T.border}`,WebkitOverflowScrolling:'touch' as any}} onClick={e=>e.stopPropagation()}>
        <div style={{position:'sticky',top:0,background:T.surf,padding:'16px 16px 10px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center',zIndex:1}}>
          <div style={{color:T.txt,fontWeight:800,fontSize:14}}>{title}</div>
          <button onClick={()=>setShowSheet(false)} style={{background:'transparent',border:'none',color:T.muted,cursor:'pointer',fontSize:20,lineHeight:1}}>✕</button>
        </div>
        <div style={{padding:'12px 16px calc(44px + env(safe-area-inset-bottom, 0px))'}}>{children}</div>
      </div>
    </>
  );

  return (
    <div>
      {/* ── Top toolbar ── */}
      <div style={{background:'linear-gradient(135deg,#04060F,#080D1A)',border:`1px solid ${T.acl}30`,borderRadius:18,padding:'12px 14px',marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
          <div style={{display:'flex',gap:5,alignItems:'center'}}>
            <span style={{fontSize:16}}>🔬</span>
            <span style={{color:T.txt,fontWeight:800,fontSize:14}}>Analysis Hub</span>
            {undoStack.length>0&&<span style={{background:T.prp+'20',color:T.prp,fontSize:9,padding:'1px 6px',borderRadius:99,fontWeight:700}}>{undoStack.length} 기록</span>}
          </div>
          <div style={{display:'flex',gap:5}}>
            <button onClick={undo} disabled={!undoStack.length} style={{background:undoStack.length?T.alt:'transparent',color:undoStack.length?T.txt:T.muted,border:`1px solid ${T.border}`,borderRadius:7,padding:'4px 8px',fontSize:11,cursor:undoStack.length?'pointer':'default'}}>↩ 실행취소</button>
            <button onClick={redo} disabled={!redoStack.length} style={{background:redoStack.length?T.alt:'transparent',color:redoStack.length?T.txt:T.muted,border:`1px solid ${T.border}`,borderRadius:7,padding:'4px 8px',fontSize:11,cursor:redoStack.length?'pointer':'default'}}>↪ 다시실행</button>
            <a href="/chart" target="_blank" style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,textDecoration:'none'}}>⛶</a>
          </div>
        </div>
        {/* Quick tool bar */}
        <div style={{display:'flex',gap:4,overflowX:'auto'}}>
          <button onClick={()=>openSheet('interval')} style={{flexShrink:0,background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:7,padding:'5px 10px',fontSize:11,fontWeight:800,cursor:'pointer',fontFamily:'monospace'}}>
            {INTERVALS.find(i=>i.id===activeInterval)?.label||activeInterval}
          </button>
          <button onClick={()=>openSheet('charttype')} style={{flexShrink:0,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 10px',fontSize:13,cursor:'pointer'}}>
            {CHART_TYPES.find(c=>c.id===chartType)?.icon||'🕯'}
          </button>
          <button onClick={()=>setTab('indicators')} style={{flexShrink:0,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 9px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
            🔬{activeIndicators.length>0&&<span style={{background:T.acl,color:'#fff',borderRadius:99,padding:'0 3px',fontSize:8,marginLeft:2}}>{activeIndicators.length}</span>}
          </button>
          <button onClick={()=>openSheet('drawing')} style={{flexShrink:0,background:activeTool!=='cursor'?T.prp+'15':T.alt,color:activeTool!=='cursor'?T.prp:T.sub,border:`1px solid ${activeTool!=='cursor'?T.prp:T.border}`,borderRadius:7,padding:'5px 9px',fontSize:13,cursor:'pointer'}}>
            {DRAWING_TOOLS.find(d=>d.id===activeTool)?.icon||'↗'}
          </button>
          <button onClick={()=>setMagnetMode(v=>!v)} style={{flexShrink:0,background:magnetMode?T.ylw+'20':T.alt,color:magnetMode?T.ylw:T.muted,border:`1px solid ${magnetMode?T.ylw:T.border}`,borderRadius:7,padding:'5px 9px',fontSize:12,cursor:'pointer'}} title="자석 스냅 모드">🧲</button>
          <button onClick={()=>openSheet('objecttree')} style={{flexShrink:0,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 9px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
            📋{drawings.length>0&&<span style={{background:T.muted+'80',color:T.txt,borderRadius:99,padding:'0 3px',fontSize:8,marginLeft:2}}>{drawings.length}</span>}
          </button>
          {selectedDrawing&&(
            <>
              <button onClick={()=>openSheet('style')} style={{flexShrink:0,background:T.alt,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 9px',cursor:'pointer'}}>
                <div style={{width:12,height:12,borderRadius:'50%',background:selectedDrawing.style.color,display:'inline-block'}}/>
              </button>
              {(selectedDrawing.toolId==='long_pos'||selectedDrawing.toolId==='short_pos')&&(
                <button onClick={()=>openSheet('risk')} style={{flexShrink:0,background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:7,padding:'5px 9px',fontSize:10,fontWeight:700,cursor:'pointer'}}>위험</button>
              )}
              {selectedDrawing.toolId.includes('fib')&&(
                <button onClick={()=>openSheet('fib')} style={{flexShrink:0,background:T.ylw+'15',color:T.ylw,border:`1px solid ${T.ylw}30`,borderRadius:7,padding:'5px 9px',fontSize:10,fontWeight:700,cursor:'pointer'}}>피보</button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Active tool indicator */}
      {activeTool!=='cursor'&&(
        <div style={{background:T.prp+'12',border:`1px solid ${T.prp}30`,borderRadius:10,padding:'8px 12px',marginBottom:10,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{color:T.prp,fontWeight:700,fontSize:12}}>
            {DRAWING_TOOLS.find(d=>d.id===activeTool)?.icon} {DRAWING_TOOLS.find(d=>d.id===activeTool)?.label} 도구 활성
            {magnetMode&&' · 🧲 스냅'}
          </div>
          <div style={{display:'flex',gap:5}}>
            <button onClick={()=>addDrawing(activeTool,riskEntry,riskTP)} style={{background:T.prp,color:'#fff',border:'none',borderRadius:7,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>추가</button>
            <button onClick={()=>setActiveTool('cursor')} style={{background:T.prp+'20',color:T.prp,border:'none',borderRadius:7,padding:'4px 8px',fontSize:10,cursor:'pointer'}}>해제</button>
          </div>
        </div>
      )}

      {/* Main tabs */}
      <div style={{display:'flex',gap:4,marginBottom:12,overflowX:'auto'}}>
        {([['hub','🏠 허브'],['layout','📐 레이아웃'],['tools','🔧 도구'],['drawing','✏️ 드로잉'],['interval','⏱ 인터벌'],['indicators','🔬 지표'],['info','ℹ️ 정보'],['paper','🎮 모의'],['more','⋯ 더보기']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'7px 10px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* ── HUB ── */}
      {tab==='hub'&&(
        <div>
          {/* Chart preview */}
          <div style={{height:'min(340px,48vw)',borderRadius:14,overflow:'hidden',border:`1px solid ${T.border}`,marginBottom:12,background:T.card,position:'relative'}}>
            <InlineTVChart key={`${symbol}-${chartType}-${activeInterval}`} symbol={symbol} chartType={chartType} interval={activeInterval}/>
            <div style={{position:'absolute',top:8,right:8,display:'flex',flexDirection:'column',gap:3,zIndex:10}}>
              {DRAWING_TOOLS.filter(d=>['cursor','trendline','hline','fib_ret','long_pos','short_pos','rect','text'].includes(d.id)).map(d=>(
                <button key={d.id} onClick={()=>setActiveTool(d.id)} style={{width:30,height:30,background:activeTool===d.id?T.prp+'CC':T.card+'CC',color:activeTool===d.id?'#fff':T.sub,border:`1px solid ${activeTool===d.id?T.prp:T.border}`,borderRadius:7,cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',justifyContent:'center',backdropFilter:'blur(4px)',WebkitBackdropFilter:'blur(4px)'}}>
                  {d.icon}
                </button>
              ))}
            </div>
          </div>

          {/* ── TOOLS SECTION ── */}
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🔧 도구</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
              {[
                {icon:'🔬',label:'인디케이터',sheet:'indicators'},
                {icon:'🔀',label:'비교',sheet:'compare'},
                {icon:'🔔',label:'알림',sheet:'alerts'},
                {icon:'⏮',label:'바 리플레이',sheet:'replay'},
                {icon:'📋',label:'템플릿',sheet:'templates'},
                {icon:'📊',label:'차트 유형',sheet:'charttype'},
                {icon:'🌳',label:'오브젝트 트리',sheet:'objecttree'},
                {icon:'✏️',label:'드로잉',action:'drawing'},
              ].map(item=>(
                <button key={item.label} onClick={()=>{ if('sheet' in item && item.sheet) { openSheet(item.sheet as any); } else if('action' in item && item.action) setTab(item.action as any); }} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 6px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{fontSize:20,marginBottom:4}}>{item.icon}</div>
                  <div style={{color:T.muted,fontSize:9,fontWeight:600,lineHeight:1.2}}>{item.label}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* ── INFO SECTION ── */}
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>ℹ️ 정보</div>
            <div style={{display:'flex',flexDirection:'column',gap:0}}>
              {[
                {icon:'📋',label:'심볼 정보',desc:'거래소 · 자산 유형 · 시가총액',sheet:'symbol_info'},
                {icon:'💰',label:'재무제표',desc:'매출 · EPS · PER (준비중)',sheet:'financials'},
                {icon:'🔮',label:'애널리스트 예측',desc:'목표가 · 추천 (준비중)',sheet:'forecasts'},
                {icon:'📊',label:'기술적 분석',desc:'매수/매도 신호 종합',sheet:'technicals'},
              ].map((item,i,arr)=>(
                <button key={item.label} onClick={()=>openSheet(item.sheet as any)} style={{display:'flex',gap:10,alignItems:'center',padding:'10px 0',background:'transparent',border:'none',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none',cursor:'pointer',textAlign:'left',width:'100%'}}>
                  <span style={{fontSize:20,flexShrink:0}}>{item.icon}</span>
                  <div style={{flex:1}}>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{item.label}</div>
                    <div style={{color:T.muted,fontSize:10,marginTop:1}}>{item.desc}</div>
                  </div>
                  <span style={{color:T.muted,fontSize:14}}>›</span>
                </button>
              ))}
            </div>
          </Card>

          {/* ── MORE SECTION ── */}
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>⋯ 더보기</div>
            <div style={{display:'flex',flexDirection:'column',gap:0}}>
              {[
                {icon:'💡',label:'아이디어 작성',desc:'트레이딩 아이디어 공유',sheet:'idea'},
                {icon:'🌲',label:'파인 에디터',desc:'Pine Script 작성/편집',sheet:'pine'},
                {icon:'❓',label:'도움말',desc:'차트 도구 사용 가이드',sheet:'help'},
              ].map((item,i,arr)=>(
                <button key={item.label} onClick={()=>openSheet(item.sheet as any)} style={{display:'flex',gap:10,alignItems:'center',padding:'10px 0',background:'transparent',border:'none',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none',cursor:'pointer',textAlign:'left',width:'100%'}}>
                  <span style={{fontSize:20,flexShrink:0}}>{item.icon}</span>
                  <div style={{flex:1}}>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{item.label}</div>
                    <div style={{color:T.muted,fontSize:10,marginTop:1}}>{item.desc}</div>
                  </div>
                  <span style={{color:T.muted,fontSize:14}}>›</span>
                </button>
              ))}
            </div>
          </Card>

          {/* ── PAPER TRADING PREVIEW ── */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.prp}30`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{color:T.prp,fontWeight:700}}>🎮 모의매매</div>
              <button onClick={()=>setTab('paper')} style={{background:T.prp+'20',color:T.prp,border:`1px solid ${T.prp}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>열기</button>
            </div>
            <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}25`,borderRadius:8,padding:'8px 10px',marginBottom:8}}>
              <div style={{color:T.ylw,fontSize:10,fontWeight:700}}>⚠️ 모의투자입니다. 실제 주문이 아닙니다.</div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6}}>
              <div style={{background:T.alt,borderRadius:8,padding:'7px',textAlign:'center'}}>
                <div style={{color:T.txt,fontSize:11,fontWeight:700,fontFamily:'monospace'}}>₩1,000,000</div>
                <div style={{color:T.muted,fontSize:8,marginTop:1}}>잔고</div>
              </div>
              <div style={{background:T.alt,borderRadius:8,padding:'7px',textAlign:'center'}}>
                <div style={{color:T.grn,fontSize:11,fontWeight:700}}>+₩87,400</div>
                <div style={{color:T.muted,fontSize:8,marginTop:1}}>모의 PnL</div>
              </div>
              <div style={{background:T.alt,borderRadius:8,padding:'7px',textAlign:'center'}}>
                <div style={{color:T.acl,fontSize:11,fontWeight:700}}>12건</div>
                <div style={{color:T.muted,fontSize:8,marginTop:1}}>거래</div>
              </div>
            </div>
          </Card>
        </div>
      )}
            {tab==='layout'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{color:T.txt,fontWeight:700}}>📐 레이아웃 저장</div>
              <div style={{display:'flex',gap:5}}>
                <button onClick={()=>setShowSaveLayout(v=>!v)} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 저장</button>
                <button onClick={exportLayout} style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'4px 10px',fontSize:11,cursor:'pointer'}}>↓ 내보내기</button>
                <label style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'4px 10px',fontSize:11,cursor:'pointer'}}>
                  ↑ 가져오기<input type="file" accept=".json" style={{display:'none'}} onChange={importLayout}/>
                </label>
              </div>
            </div>
            {showSaveLayout&&(
              <div style={{display:'flex',gap:6,marginBottom:10}}>
                <input value={newLayoutName} onChange={e=>setNewLayoutName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&saveCurrentLayout()} placeholder="레이아웃 이름" style={{flex:1,background:T.bg,border:`1px solid ${T.acl}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:16,outline:'none'}}/>
                <button onClick={saveCurrentLayout} disabled={!newLayoutName.trim()} style={{background:newLayoutName.trim()?T.acc:'#243A5E',color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>저장</button>
              </div>
            )}
            {layouts.length===0?(
              <div style={{color:T.muted,fontSize:11,textAlign:'center',padding:'16px 0'}}>저장된 레이아웃 없음 · 위에서 저장하세요</div>
            ):(
              <div style={{display:'flex',flexDirection:'column',gap:5}}>
                {layouts.map(l=>(
                  <div key={l.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:activeLayout===l.id?T.acg:T.alt,border:`1px solid ${activeLayout===l.id?T.acl:T.border}`,borderRadius:9,padding:'8px 12px',cursor:'pointer'}} onClick={()=>loadLayout(l)}>
                    <div>
                      <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{l.name}</div>
                      <div style={{color:T.muted,fontSize:9,marginTop:1}}>{l.symbol} · {l.interval} · {l.drawings?.length||0}개 드로잉 · {l.updatedAt?.split('T')[0]}</div>
                    </div>
                    <div style={{display:'flex',gap:4}}>
                      {activeLayout===l.id&&<Bdg c={T.grn} ch="활성"/>}
                      <button onClick={e=>{e.stopPropagation();deleteLayout(l.id);}} style={{background:T.red+'15',color:T.red,border:'none',borderRadius:6,padding:'2px 7px',fontSize:9,cursor:'pointer'}}>삭제</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10,display:'flex',alignItems:'center',gap:5}}>
              <BarChart3 size={13} strokeWidth={2.2} color={T.acl}/>
              <span>현재 설정</span>
            </div>
            {[
              {l:'심볼',v:symbol},{l:'인터벌',v:INTERVALS.find(i=>i.id===activeInterval)?.label||activeInterval},
              {l:'차트 유형',v:CHART_TYPES.find(c=>c.id===chartType)?.label||chartType},
              {l:'인디케이터',v:activeIndicators.join(', ')||'없음'},
              {l:'드로잉 수',v:`${drawings.length}개`},
            ].map((r,i)=>(
              <div key={r.l} style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:`1px solid ${T.border}`}}>
                <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
                <span style={{color:T.txt,fontSize:11,fontWeight:600,maxWidth:'60%',textAlign:'right',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.v}</span>
              </div>
            ))}
          </Card>
        </div>
      )}

      {tab==='tools'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔧 차트 도구</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {[
                {icon:'🔬',label:'인디케이터',desc:'기술적 지표 추가',action:()=>openSheet('indicators')},
                {icon:'🔀',label:'비교',desc:'종목 오버레이',action:()=>openSheet('compare')},
                {icon:'🔔',label:'알림',desc:'가격/지표 알림',action:()=>openSheet('alerts')},
                {icon:'⏮',label:'바 리플레이',desc:'과거 재생',action:()=>openSheet('replay')},
                {icon:'📋',label:'템플릿',desc:'인디케이터 묶음',action:()=>openSheet('templates')},
                {icon:'📊',label:'차트 유형',desc:'캔들·선·영역…',action:()=>openSheet('charttype')},
                {icon:'🌳',label:'오브젝트 트리',desc:'드로잉 목록',action:()=>openSheet('objecttree')},
                {icon:'✏️',label:'드로잉 도구',desc:'추세선·피보…',action:()=>setTab('drawing')},
                {icon:'⏱',label:'인터벌',desc:'1m·5m·1h·1D…',action:()=>setTab('interval')},
              ].map(item=>(
                <button key={item.label} onClick={item.action} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:11,padding:'12px 8px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{fontSize:24,marginBottom:5}}>{item.icon}</div>
                  <div style={{color:T.txt,fontSize:10,fontWeight:700,marginBottom:2}}>{item.label}</div>
                  <div style={{color:T.muted,fontSize:8,lineHeight:1.3}}>{item.desc}</div>
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab==='more'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>⋯ 더보기</div>
            {[
              {icon:'💡',label:'아이디어 작성',desc:'트레이딩 아이디어 공유',action:()=>openSheet('idea')},
              {icon:'🌲',label:'파인 에디터',desc:'Pine Script 작성/편집',action:()=>openSheet('pine')},
              {icon:'❓',label:'도움말',desc:'차트 도구 사용 가이드',action:()=>openSheet('help')},
              {icon:'🤖',label:'WUNDER 봇',desc:'Pine Script 자동매매',action:()=>setTab('wunder' as any)},
              {icon:'⛶',label:'전용 차트 열기',desc:'4분할·전체화면 지원',action:()=>{ if(typeof window!=='undefined') window.open('/chart','_blank'); }},
            ].map((item,i,arr)=>(
              <button key={item.label} onClick={item.action} style={{display:'flex',gap:12,alignItems:'center',padding:'11px 0',background:'transparent',border:'none',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none',cursor:'pointer',textAlign:'left',width:'100%'}}>
                <span style={{fontSize:22,flexShrink:0}}>{item.icon}</span>
                <div style={{flex:1}}>
                  <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{item.label}</div>
                  <div style={{color:T.muted,fontSize:10,marginTop:1}}>{item.desc}</div>
                </div>
                <span style={{color:T.muted,fontSize:16}}>›</span>
              </button>
            ))}
          </Card>
        </div>
      )}

{tab==='drawing'&&(
        <div>
          {/* Group tabs */}
          <div style={{display:'flex',gap:4,marginBottom:10,overflowX:'auto'}}>
            {DRAWING_GROUPS.map(g=>(
              <button key={g.id} onClick={()=>setDrawingGroup(g.id)} style={{flexShrink:0,padding:'5px 10px',background:drawingGroup===g.id?T.prp+'20':'transparent',color:drawingGroup===g.id?T.prp:T.muted,border:`1px solid ${drawingGroup===g.id?T.prp:T.border}`,borderRadius:20,fontSize:10,fontWeight:700,cursor:'pointer'}}>{g.l}</button>
            ))}
          </div>

          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,marginBottom:12}}>
            {DRAWING_TOOLS.filter(d=>d.group===drawingGroup).map(d=>(
              <button key={d.id} onClick={()=>{ if(activeTool===d.id){ addDrawing(d.id); } else { setActiveTool(d.id); }}} style={{background:activeTool===d.id?T.prp+'20':T.card,border:`2px solid ${activeTool===d.id?T.prp:T.border}`,borderRadius:12,padding:'12px 6px',cursor:'pointer',textAlign:'center',position:'relative'}}>
                {activeTool===d.id&&<div style={{position:'absolute',top:3,right:3,width:6,height:6,borderRadius:'50%',background:T.prp}}/>}
                <div style={{fontSize:20,marginBottom:4}}>{d.icon}</div>
                <div style={{color:activeTool===d.id?T.prp:T.txt,fontSize:9,fontWeight:700,lineHeight:1.3}}>{d.label}</div>
              </button>
            ))}
          </div>

          <div style={{color:T.muted,fontSize:10,textAlign:'center',marginBottom:12}}>
            도구 선택 후 <strong style={{color:T.txt}}>한 번 더 클릭</strong>하면 현재 심볼에 드로잉이 추가됩니다
          </div>

          {/* Object tree */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{color:T.txt,fontWeight:700}}>📋 오브젝트 트리 ({drawings.length}개)</div>
              {drawings.length>0&&<button onClick={clearAllDrawings} style={{background:T.red+'15',color:T.red,border:'none',borderRadius:7,padding:'3px 8px',fontSize:9,cursor:'pointer'}}>전체삭제</button>}
            </div>
            {drawings.length===0?(
              <div style={{color:T.muted,fontSize:11,textAlign:'center',padding:'16px 0'}}>드로잉이 없습니다<br/><span style={{fontSize:10}}>위 도구로 추가하세요</span></div>
            ):(
              drawings.map(d=>(
                <div key={d.id} onClick={()=>setSelectedId(d.id===selectedId?null:d.id)} style={{display:'flex',alignItems:'center',gap:6,padding:'8px 0',borderBottom:`1px solid ${T.border}`,opacity:d.hidden?0.4:1,background:selectedId===d.id?T.acg:'transparent',cursor:'pointer',borderRadius:selectedId===d.id?6:0,paddingLeft:selectedId===d.id?4:0}}>
                  <div style={{width:10,height:10,borderRadius:2,background:d.style.color,flexShrink:0}}/>
                  <div style={{flex:1}}>
                    <div style={{color:T.txt,fontSize:11,fontWeight:selectedId===d.id?700:400}}>{d.name||d.toolLabel}</div>
                    <div style={{color:T.muted,fontSize:9}}>{d.symbol} · {d.timeframe} · {d.createdAt.split('T')[0]}</div>
                  </div>
                  <div style={{display:'flex',gap:3,flexShrink:0}}>
                    <button onClick={e=>{e.stopPropagation();toggleLock(d.id);}} style={{background:'transparent',border:'none',color:d.locked?T.ylw:T.muted,cursor:'pointer',fontSize:11}}>{d.locked?'🔒':'🔓'}</button>
                    <button onClick={e=>{e.stopPropagation();toggleVisible(d.id);}} style={{background:'transparent',border:'none',color:d.hidden?T.muted:T.sub,cursor:'pointer',fontSize:11}}>{d.hidden?'🙈':'👁'}</button>
                    <button onClick={e=>{e.stopPropagation();duplicateDrawing(d.id);}} style={{background:'transparent',border:'none',color:T.acl,cursor:'pointer',fontSize:11}}>⎘</button>
                    <button onClick={e=>{e.stopPropagation();deleteDrawing(d.id);}} style={{background:'transparent',border:'none',color:T.red,cursor:'pointer',fontSize:11}}>✕</button>
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      )}

      {/* ── INTERVAL ── */}
      {tab==='interval'&&(
        <div>
          <div style={{background:T.acg,border:`1px solid ${T.acl}30`,borderRadius:10,padding:'9px 13px',marginBottom:12}}>
            <div style={{color:T.acl,fontWeight:700,fontSize:12}}>현재: <span style={{fontFamily:'monospace'}}>{INTERVALS.find(i=>i.id===activeInterval)?.label||activeInterval}</span></div>
          </div>
          {INTERVAL_GROUPS.map(grp=>(
            <div key={grp.id} style={{marginBottom:14}}>
              <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>{grp.l}</div>
              <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                {INTERVALS.filter(i=>i.group===grp.id).map(iv=>(
                  <button key={iv.id} onClick={()=>setActiveInterval(iv.id)} style={{background:activeInterval===iv.id?T.acg:T.card,border:`2px solid ${activeInterval===iv.id?T.acl:T.border}`,borderRadius:9,padding:'7px 13px',cursor:'pointer',minWidth:48,textAlign:'center'}}>
                    <span style={{color:activeInterval===iv.id?T.acl:T.txt,fontSize:12,fontWeight:700,fontFamily:'monospace'}}>{iv.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div style={{display:'flex',gap:6}}>
            <input value={customInterval} onChange={e=>setCustomInterval(e.target.value)} placeholder="직접 입력 (예: 75)" style={{flex:1,background:T.card,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 12px',color:T.txt,fontSize:12,fontFamily:'monospace',outline:'none'}}/>
            <button onClick={()=>{if(customInterval.trim()){setActiveInterval(customInterval.trim());setCustomInterval('');}}} style={{background:T.acc,color:'#fff',border:'none',borderRadius:9,padding:'9px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>적용</button>
          </div>
        </div>
      )}

      {/* ── INDICATORS ── */}
      {tab==='indicators'&&(
        <div>
          <input value={indSearch} onChange={e=>setIndSearch(e.target.value)} placeholder="인디케이터 검색…" style={{width:'100%',background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 14px',color:T.txt,fontSize:12,outline:'none',marginBottom:8}}/>
          <div style={{display:'flex',gap:4,marginBottom:10,overflowX:'auto'}}>
            {IND_CATS.map(c=>(
              <button key={c} onClick={()=>setIndFilter(c)} style={{flexShrink:0,padding:'4px 10px',background:indFilter===c?T.acg:'transparent',color:indFilter===c?T.acl:T.muted,border:`1px solid ${indFilter===c?T.acl:T.border}`,borderRadius:20,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                {c==='all'?'전체':c==='trend'?'추세':c==='momentum'?'모멘텀':c==='volatility'?'변동성':'거래량'}
              </button>
            ))}
          </div>
          {filteredInds.map(ind=>{
            const active=activeIndicators.includes(ind.id);
            return (
              <div key={ind.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <div style={{width:32,height:32,borderRadius:8,background:active?T.acg:T.alt,border:`1px solid ${active?T.acl:T.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:900,color:active?T.acl:T.muted,fontFamily:'monospace'}}>{ind.id.slice(0,4)}</div>
                  <div>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{ind.label}</div>
                    <div style={{color:T.muted,fontSize:9}}>{ind.category==='trend'?'추세':ind.category==='momentum'?'모멘텀':ind.category==='volatility'?'변동성':'거래량'}</div>
                  </div>
                </div>
                <button onClick={()=>toggleIndicator(ind.id)} style={{background:active?T.red+'15':T.acg,color:active?T.red:T.acl,border:`1px solid ${active?T.red:T.acl}40`,borderRadius:9,padding:'5px 12px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  {active?'제거':'추가'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── INFO ── */}
      {tab==='info'&&(
        <div>
          {[
            {icon:'📋',title:'종목 상세',desc:'심볼 정보, 거래소, 섹터',available:true},
            {icon:'💰',title:'재무제표',desc:'매출, EPS, PER (준비중)',available:false},
            {icon:'🔮',title:'애널리스트 예측',desc:'목표가, 추천 (준비중)',available:false},
            {icon:'📊',title:'기술적 분석 요약',desc:'매수/매도/중립 종합',available:true},
            {icon:'🌲',title:'파인 에디터',desc:'Pine Script → TradingView 열기',available:true},
            {icon:'❓',title:'도움말',desc:'차트 도구 사용 가이드',available:true},
          ].map((item,i)=>(
            <div key={item.title} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'11px 0',borderBottom:`1px solid ${T.border}`}}>
              <div style={{display:'flex',gap:10,alignItems:'center'}}>
                <span style={{fontSize:20}}>{item.icon}</span>
                <div>
                  <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{item.title}</div>
                  <div style={{color:T.muted,fontSize:10}}>{item.desc}</div>
                </div>
              </div>
              <button style={{background:item.available?T.acg:T.alt,color:item.available?T.acl:T.muted,border:`1px solid ${item.available?T.acl:T.border}`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:item.available?'pointer':'default'}}>
                {item.available?'보기':'준비중'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── PAPER ── */}
      {tab==='paper'&&(
        <div>
          <div style={{background:'linear-gradient(135deg,#060B14,#0A0F1E)',border:`1px solid ${T.prp}40`,borderRadius:18,padding:'16px',marginBottom:12}}>
            <div style={{color:T.muted,fontSize:11,marginBottom:2}}>모의매매 계좌</div>
            <div style={{color:T.txt,fontSize:26,fontWeight:900,fontFamily:'monospace'}}>{cvt(paperSize,'KRW')}</div>
            <div style={{display:'flex',gap:12,marginTop:6}}>
              <div><div style={{color:T.muted,fontSize:9}}>실현손익</div><div style={{color:T.grn,fontWeight:700,fontSize:12}}>+{cvt(paperPnl,'KRW')}</div></div>
              <div><div style={{color:T.muted,fontSize:9}}>수익률</div><div style={{color:T.grn,fontWeight:700,fontSize:12}}>+{(paperPnl/paperSize*100).toFixed(2)}%</div></div>
              <div><div style={{color:T.muted,fontSize:9}}>거래</div><div style={{color:T.acl,fontWeight:700,fontSize:12}}>{paperTrades}건</div></div>
            </div>
          </div>
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🎮 모의 주문</div>
            <div style={{display:'flex',gap:6,marginBottom:10}}>
              {['매수','매도'].map(s=>(
                <button key={s} style={{flex:1,padding:'10px',background:s==='매수'?T.grn+'15':T.red+'15',color:s==='매수'?T.grn:T.red,border:`1px solid ${s==='매수'?T.grn:T.red}40`,borderRadius:10,fontWeight:700,fontSize:13,cursor:'pointer'}}>{s}</button>
              ))}
            </div>
            {[{l:'심볼',v:symbol.split(':')[1]||symbol},{l:'차트 유형',v:CHART_TYPES.find(c=>c.id===chartType)?.label||chartType},{l:'인터벌',v:INTERVALS.find(i=>i.id===activeInterval)?.label||activeInterval},{l:'드로잉',v:`${drawings.length}개`}].map((r,i)=>(
              <div key={r.l} style={{display:'flex',justifyContent:'space-between',padding:'6px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
                <span style={{color:T.txt,fontSize:11,fontWeight:600}}>{r.v}</span>
              </div>
            ))}
            <button type="button"
              onClick={() => alert('모의 주문은 더보기 → 모의매매 페이지에서 실행할 수 있습니다.')}
              style={{width:'100%',padding:'12px',minHeight:46,background:'linear-gradient(135deg,#2563EB,#7C3AED)',color:'#fff',border:'none',borderRadius:11,fontWeight:800,fontSize:13,cursor:'pointer',marginTop:10}}>모의 주문</button>
            <div style={{color:T.muted,fontSize:9,textAlign:'center',marginTop:5}}>모의매매 전용 · 실제 자금 없음 · 수익 보장 없음</div>
          </Card>
        </div>
      )}

      {/* ══ BOTTOM SHEETS ══ */}
      {showSheet&&sheetContent==='drawing'&&(
        <BottomSheet title="✏️ 드로잉 도구 선택">
          <div style={{display:'flex',gap:4,marginBottom:10,overflowX:'auto'}}>
            {DRAWING_GROUPS.map(g=>(
              <button key={g.id} onClick={()=>setDrawingGroup(g.id)} style={{flexShrink:0,padding:'4px 9px',background:drawingGroup===g.id?T.prp+'20':'transparent',color:drawingGroup===g.id?T.prp:T.muted,border:`1px solid ${drawingGroup===g.id?T.prp:T.border}`,borderRadius:20,fontSize:10,fontWeight:700,cursor:'pointer'}}>{g.l}</button>
            ))}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:6}}>
            {DRAWING_TOOLS.filter(d=>d.group===drawingGroup).map(d=>(
              <button key={d.id} onClick={()=>{setActiveTool(d.id);setShowSheet(false);setTab('drawing');}} style={{background:activeTool===d.id?T.prp+'20':T.card,border:`2px solid ${activeTool===d.id?T.prp:T.border}`,borderRadius:10,padding:'10px 4px',cursor:'pointer',textAlign:'center'}}>
                <div style={{fontSize:20,marginBottom:3}}>{d.icon}</div>
                <div style={{color:activeTool===d.id?T.prp:T.muted,fontSize:8,fontWeight:700,lineHeight:1.2}}>{d.label.slice(0,6)}</div>
              </button>
            ))}
          </div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='interval'&&(
        <BottomSheet title="⏱ 인터벌 선택">
          {INTERVAL_GROUPS.map(grp=>(
            <div key={grp.id} style={{marginBottom:12}}>
              <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>{grp.l}</div>
              <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                {INTERVALS.filter(i=>i.group===grp.id).map(iv=>(
                  <button key={iv.id} onClick={()=>{setActiveInterval(iv.id);setShowSheet(false);}} style={{background:activeInterval===iv.id?T.acg:T.card,border:`2px solid ${activeInterval===iv.id?T.acl:T.border}`,borderRadius:9,padding:'7px 12px',cursor:'pointer'}}>
                    <span style={{color:activeInterval===iv.id?T.acl:T.txt,fontSize:12,fontWeight:700,fontFamily:'monospace'}}>{iv.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='charttype'&&(
        <BottomSheet title="차트 유형 선택">
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
            {CHART_TYPES.map(ct=>(
              <button key={ct.id} onClick={()=>{setChartType(ct.id);setShowSheet(false);}} style={{background:chartType===ct.id?T.acg:T.card,border:`2px solid ${chartType===ct.id?T.acl:T.border}`,borderRadius:12,padding:'12px 6px',cursor:'pointer',textAlign:'center'}}>
                <div style={{fontSize:22,marginBottom:4}}>{ct.icon}</div>
                <div style={{color:chartType===ct.id?T.acl:T.txt,fontSize:9,fontWeight:700,lineHeight:1.2}}>{ct.label}</div>
                {CHART_TYPE_DESC[ct.id]&&<div style={{color:T.muted,fontSize:7,marginTop:2,lineHeight:1.3}}>{CHART_TYPE_DESC[ct.id].slice(0,12)}</div>}
              </button>
            ))}
          </div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='objecttree'&&(
        <BottomSheet title={`📋 오브젝트 트리 (${drawings.length}개)`}>
          {drawings.length===0?(
            <div style={{textAlign:'center',padding:'24px 0',color:T.muted,fontSize:12}}>드로잉이 없습니다</div>
          ):(
            <>
              <div style={{display:'flex',gap:6,marginBottom:10}}>
                <button onClick={clearAllDrawings} style={{flex:1,padding:'8px',background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:9,fontSize:11,fontWeight:700,cursor:'pointer'}}>전체 삭제</button>
                <button onClick={()=>setDrawings(d=>d.map(x=>({...x,visible:true,hidden:false})))} style={{flex:1,padding:'8px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}30`,borderRadius:9,fontSize:11,fontWeight:700,cursor:'pointer'}}>모두 표시</button>
              </div>
              {drawings.map(d=>(
                <div key={d.id} style={{display:'flex',alignItems:'center',gap:8,padding:'10px 0',borderBottom:`1px solid ${T.border}`,opacity:d.hidden?0.4:1}}>
                  <div style={{width:12,height:12,borderRadius:3,background:d.style.color,flexShrink:0}}/>
                  <div style={{flex:1}}>
                    <input value={d.name||d.toolLabel} onChange={e=>renameDrawing(d.id,e.target.value)} style={{background:'transparent',border:'none',color:T.txt,fontSize:12,fontWeight:600,width:'100%',outline:'none',cursor:'text'}}/>
                    <div style={{color:T.muted,fontSize:9}}>{d.symbol} · {d.timeframe} · {d.toolLabel}</div>
                  </div>
                  <div style={{display:'flex',gap:5,flexShrink:0}}>
                    <button onClick={()=>toggleLock(d.id)} style={{background:'transparent',border:'none',color:d.locked?T.ylw:T.muted,cursor:'pointer',fontSize:12}}>{d.locked?'🔒':'🔓'}</button>
                    <button onClick={()=>toggleVisible(d.id)} style={{background:'transparent',border:'none',color:d.hidden?T.muted:T.sub,cursor:'pointer',fontSize:12}}>{d.hidden?'🙈':'👁'}</button>
                    <button onClick={()=>duplicateDrawing(d.id)} style={{background:'transparent',border:'none',color:T.acl,cursor:'pointer',fontSize:12}}>⎘</button>
                    <button onClick={()=>deleteDrawing(d.id)} style={{background:'transparent',border:'none',color:T.red,cursor:'pointer',fontSize:12}}>✕</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='style'&&selectedDrawing&&(
        <BottomSheet title="🎨 스타일 편집">
          <div style={{display:'flex',gap:6,marginBottom:14,alignItems:'center'}}>
            <div style={{width:24,height:24,borderRadius:6,background:selectedDrawing.style.color,flexShrink:0}}/>
            <span style={{color:T.txt,fontSize:13,fontWeight:700}}>{selectedDrawing.name||selectedDrawing.toolLabel}</span>
          </div>
          {/* Color presets */}
          <div style={{marginBottom:12}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>색상</div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              {['#3B82F6','#10B981','#EF4444','#F59E0B','#7C3AED','#0891B2','#EC4899','#F97316','#14B8A6','#94A3B8','#FFFFFF','#000000'].map(clr=>(
                <button key={clr} onClick={()=>updateDrawingStyle(selectedDrawing.id,{color:clr})} style={{width:28,height:28,borderRadius:6,background:clr,border:`3px solid ${selectedDrawing.style.color===clr?'#fff':'transparent'}`,cursor:'pointer'}}/>
              ))}
            </div>
          </div>
          {/* Width */}
          <div style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
              <span style={{color:T.muted,fontSize:10,fontWeight:700}}>선 두께</span>
              <span style={{color:T.acl,fontSize:10,fontWeight:700}}>{selectedDrawing.style.width}px</span>
            </div>
            <input type="range" min={1} max={8} step={1} value={selectedDrawing.style.width} onChange={e=>updateDrawingStyle(selectedDrawing.id,{width:+e.target.value})} style={{width:'100%',accentColor:T.acl}}/>
          </div>
          {/* Opacity */}
          <div style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
              <span style={{color:T.muted,fontSize:10,fontWeight:700}}>불투명도</span>
              <span style={{color:T.acl,fontSize:10,fontWeight:700}}>{Math.round((selectedDrawing.style.opacity||1)*100)}%</span>
            </div>
            <input type="range" min={10} max={100} step={5} value={Math.round((selectedDrawing.style.opacity||1)*100)} onChange={e=>updateDrawingStyle(selectedDrawing.id,{opacity:+e.target.value/100})} style={{width:'100%',accentColor:T.acl}}/>
          </div>
          {/* Line style */}
          <div style={{marginBottom:12}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>선 스타일</div>
            <div style={{display:'flex',gap:6}}>
              {(['solid','dashed','dotted'] as const).map(ds=>(
                <button key={ds} onClick={()=>updateDrawingStyle(selectedDrawing.id,{dash:ds})} style={{flex:1,padding:'8px',background:selectedDrawing.style.dash===ds?T.acg:T.alt,color:selectedDrawing.style.dash===ds?T.acl:T.muted,border:`1px solid ${selectedDrawing.style.dash===ds?T.acl:T.border}`,borderRadius:8,fontSize:11,fontWeight:700,cursor:'pointer'}}>
                  {ds==='solid'?'━━━':ds==='dashed'?'┅┅┅':'···'}
                </button>
              ))}
            </div>
          </div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={()=>toggleLock(selectedDrawing.id)} style={{flex:1,padding:'10px',background:selectedDrawing.locked?T.ylw+'15':T.alt,color:selectedDrawing.locked?T.ylw:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer'}}>
              {selectedDrawing.locked?'🔒 잠금됨':'🔓 잠금'}
            </button>
            <button onClick={()=>deleteDrawing(selectedDrawing.id)} style={{flex:1,padding:'10px',background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer'}}>🗑 삭제</button>
          </div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='risk'&&(
        <BottomSheet title={`위험 도구 — ${activeTool==='long_pos'?'롱':'숏'} 포지션`}>
          <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
            {[{l:'진입가',key:'entry',val:riskEntry,set:setRiskEntry},{l:'손절가',key:'sl',val:riskSL,set:setRiskSL},{l:'목표가',key:'tp',val:riskTP,set:setRiskTP},{l:'투자금',key:'size',val:riskSize,set:setRiskSize}].map(f=>(
              <div key={f.key}>
                <div style={{color:T.muted,fontSize:10,marginBottom:3}}>{f.l}</div>
                <input type="number" value={f.val} onChange={e=>f.set(+e.target.value)} style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:11,fontFamily:'monospace',outline:'none'}}/>
              </div>
            ))}
          </div>
          <div style={{marginBottom:12}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>레버리지: {riskLeverage}x</div>
            <input type="range" min={1} max={20} step={1} value={riskLeverage} onChange={e=>setRiskLeverage(+e.target.value)} style={{width:'100%',accentColor:T.acl}}/>
          </div>
          <Card style={{padding:'12px 14px',marginBottom:10,border:`1px solid ${T.grn}30`}}>
            <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              {[
                {l:'리스크/리워드',v:`1 : ${riskReward.toFixed(2)}`,c:riskReward>=2?T.grn:riskReward>=1?T.ylw:T.red},
                {l:'예상 수익',v:'+'+cvt(Math.round(expectedProfit),'KRW'),c:T.grn},
                {l:'예상 손실',v:'-'+cvt(Math.round(expectedLoss),'KRW'),c:T.red},
                {l:'청산가 (추정)',v:cvt(Math.round(liqPrice),'KRW'),c:T.red},
              ].map(r=>(
                <div key={r.l} style={{background:T.alt,borderRadius:8,padding:'8px 9px'}}>
                  <div style={{color:T.muted,fontSize:9,marginBottom:2}}>{r.l}</div>
                  <div style={{color:r.c,fontSize:11,fontWeight:700,fontFamily:'monospace'}}>{r.v}</div>
                </div>
              ))}
            </div>
          </Card>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:8,padding:'8px 12px',marginBottom:10}}>
            <div style={{color:T.ylw,fontSize:10,fontWeight:700}}>⚠️ 교육 목적 계산 · 실제 거래에 사용하지 마세요</div>
          </div>
          <button onClick={()=>addDrawing(activeTool,riskEntry,riskTP)} style={{width:'100%',padding:'12px',background:`linear-gradient(135deg,${activeTool==='long_pos'?T.grn:T.red},${activeTool==='long_pos'?T.acl:T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:'pointer'}}>
            {activeTool==='long_pos'
              ? <span style={{display:'inline-flex',alignItems:'center',gap:5}}><TrendingUp size={13} strokeWidth={2.4}/>롱 포지션 추가</span>
              : <span style={{display:'inline-flex',alignItems:'center',gap:5}}><TrendingDown size={13} strokeWidth={2.4}/>숏 포지션 추가</span>}
          </button>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='fib'&&(
        <BottomSheet title="🌀 피보나치 설정">
          <div style={{display:'flex',gap:8,marginBottom:12}}>
            <button onClick={()=>setFibShowLabels(v=>!v)} style={{flex:1,padding:'9px',background:fibShowLabels?T.acg:T.alt,color:fibShowLabels?T.acl:T.muted,border:`1px solid ${fibShowLabels?T.acl:T.border}`,borderRadius:9,fontSize:11,fontWeight:700,cursor:'pointer'}}>
              {fibShowLabels?'레이블 ON':'레이블 OFF'}
            </button>
            <button onClick={()=>setFibReverse(v=>!v)} style={{flex:1,padding:'9px',background:fibReverse?T.prp+'20':T.alt,color:fibReverse?T.prp:T.muted,border:`1px solid ${fibReverse?T.prp:T.border}`,borderRadius:9,fontSize:11,fontWeight:700,cursor:'pointer'}}>
              {fibReverse?'역방향 ON':'역방향 OFF'}
            </button>
          </div>
          <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:8}}>레벨 편집</div>
          {fibLevels.map((fib,i)=>(
            <div key={i} style={{display:'flex',gap:8,alignItems:'center',marginBottom:6}}>
              <input type="number" step={0.001} value={fib.level} onChange={e=>setFibLevels(prev=>prev.map((f,j)=>j===i?{...f,level:+e.target.value}:f))} style={{width:70,background:T.bg,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 8px',color:T.txt,fontSize:11,fontFamily:'monospace',outline:'none'}}/>
              <input value={fib.label} onChange={e=>setFibLevels(prev=>prev.map((f,j)=>j===i?{...f,label:e.target.value}:f))} style={{flex:1,background:T.bg,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 8px',color:T.txt,fontSize:11,outline:'none'}}/>
              <div style={{width:24,height:24,borderRadius:5,background:fib.color,flexShrink:0}}/>
            </div>
          ))}
          <button onClick={()=>setFibLevels(DEFAULT_FIB_LEVELS)} style={{width:'100%',marginTop:8,padding:'9px',background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:9,fontSize:11,cursor:'pointer'}}>기본값 복원</button>
        </BottomSheet>
      )}
    </div>
  );


      {/* ── TOOLS BOTTOM SHEETS ── */}
      {showSheet&&sheetContent==='indicators'&&(
        <BottomSheet title="🔬 인디케이터">
          <input value={indSearch} onChange={e=>setIndSearch(e.target.value)} placeholder="인디케이터 검색…" style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 12px',color:T.txt,fontSize:16,outline:'none',marginBottom:8}}/>
          <div style={{display:'flex',gap:4,marginBottom:10,overflowX:'auto'}}>
            {['all','trend','momentum','volatility','volume'].map(c=>(
              <button key={c} onClick={()=>setIndFilter(c)} style={{flexShrink:0,padding:'4px 9px',background:indFilter===c?T.acg:'transparent',color:indFilter===c?T.acl:T.muted,border:`1px solid ${indFilter===c?T.acl:T.border}`,borderRadius:20,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                {c==='all'?'전체':c==='trend'?'추세':c==='momentum'?'모멘텀':c==='volatility'?'변동성':'거래량'}
              </button>
            ))}
          </div>
          {INDICATORS_LIST.filter(i=>(indFilter==='all'||i.category===indFilter)&&(indSearch===''||i.label.includes(indSearch)||i.id.toLowerCase().includes(indSearch.toLowerCase()))).map(ind=>{
            const active=activeIndicators.includes(ind.id);
            return (
              <div key={ind.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <div style={{width:32,height:32,borderRadius:8,background:active?T.acg:T.alt,border:`1px solid ${active?T.acl:T.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:900,color:active?T.acl:T.muted,fontFamily:'monospace'}}>{ind.id.slice(0,4)}</div>
                  <div>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{ind.label}</div>
                    <div style={{color:T.muted,fontSize:9}}>{ind.category}</div>
                  </div>
                </div>
                <button onClick={()=>{activeIndicators.includes(ind.id)?setActiveIndicators(p=>p.filter(x=>x!==ind.id)):setActiveIndicators(p=>[...p,ind.id]);}} style={{background:active?T.red+'15':T.acg,color:active?T.red:T.acl,border:`1px solid ${active?T.red:T.acl}40`,borderRadius:9,padding:'5px 12px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  {active?'제거':'추가'}
                </button>
              </div>
            );
          })}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='compare'&&(
        <BottomSheet title="🔀 비교 차트">
          <div style={{color:T.muted,fontSize:11,marginBottom:10}}>다른 종목을 오버레이하여 상관관계를 분석합니다.</div>
          {['NASDAQ:NDX','OANDA:XAUUSD','TVC:DXY','SP:SPX','BINANCE:ETHUSDT'].map(s=>(
            <div key={s} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
              <span style={{color:T.txt,fontSize:12,fontFamily:'monospace'}}>{s}</span>
              <button type="button"
                onClick={() => alert(`${s}는 TradingView 차트의 비교 기능에서 추가할 수 있습니다`)}
                style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'6px 12px',minHeight:32,fontSize:10,fontWeight:700,cursor:'pointer'}}>+ 추가</button>
            </div>
          ))}
          <div style={{marginTop:10,color:T.muted,fontSize:9}}>* TradingView 차트에서 비교 기능이 활성화됩니다</div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='alerts'&&(
        <BottomSheet title="🔔 알림 설정">
          <div style={{background:T.acg,border:`1px solid ${T.acl}30`,borderRadius:10,padding:'10px 12px',marginBottom:12}}>
            <div style={{color:T.acl,fontWeight:700,fontSize:11}}>현재 심볼: {symbol}</div>
          </div>
          {[{l:'가격 도달',d:'특정 가격 도달 시 알림'},{l:'% 변동',d:'일정 % 이상 변동 시 알림'},{l:'거래량 급증',d:'평균 대비 거래량 급증 시'},{l:'지표 조건',d:'RSI 과매수/과매도 등'}].map((a,i)=>(
            <div key={a.l} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:`1px solid ${T.border}`}}>
              <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{a.l}</div><div style={{color:T.muted,fontSize:9,marginTop:1}}>{a.d}</div></div>
              <button type="button"
                onClick={() => alert(`"${a.l}" 알림은 더보기 → 알림 페이지에서 설정할 수 있습니다`)}
                style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'6px 12px',minHeight:32,fontSize:10,cursor:'pointer'}}>준비중</button>
            </div>
          ))}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='replay'&&(
        <BottomSheet title="⏮ 바 리플레이">
          <div style={{textAlign:'center',padding:'20px 0'}}>
            <div style={{fontSize:40,marginBottom:10}}>⏮</div>
            <div style={{color:T.txt,fontWeight:700,fontSize:14,marginBottom:6}}>바 리플레이</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6,marginBottom:14}}>과거 특정 시점부터 차트를 재생합니다. TradingView 위젯에서 직접 실행하세요.</div>
            <a href="/chart" target="_blank" style={{display:'inline-block',padding:'10px 20px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,fontSize:12,fontWeight:700,textDecoration:'none'}}>전용 차트에서 열기 ↗</a>
          </div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='templates'&&(
        <BottomSheet title="📋 인디케이터 템플릿">
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {[{n:'트렌드 팩',inds:['EMA','SMA','ADX'],desc:'추세 추종용'},
              {n:'RSI 전략',inds:['RSI','MACD','BOLL'],desc:'모멘텀 분석'},
              {n:'거래량 분석',inds:['VOL','OBV','VWAP','MFI'],desc:'유동성 확인'},
              {n:'BTC WUNDER',inds:['EMA','RSI','ADX','ATR'],desc:'WUNDER 봇 전략'},
            ].map(t=>(
              <div key={t.n} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'11px 13px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div>
                  <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{t.n}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:1}}>{t.inds.join(' · ')} · {t.desc}</div>
                </div>
                <button onClick={()=>setActiveIndicators(t.inds)} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'5px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>적용</button>
              </div>
            ))}
          </div>
        </BottomSheet>
      )}

      {/* ── INFO BOTTOM SHEETS ── */}
      {showSheet&&sheetContent==='symbol_info'&&(
        <BottomSheet title="📋 심볼 정보">
          <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:14}}>
            <div style={{width:44,height:44,borderRadius:12,background:T.acg,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>₿</div>
            <div>
              <div style={{color:T.txt,fontWeight:800,fontSize:15}}>{symbol.split(':')[1]||symbol}</div>
              <div style={{color:T.muted,fontSize:11}}>{symbol}</div>
            </div>
          </div>
          {[
            {l:'거래소',v:symbol.split(':')[0]||'BINANCE'},
            {l:'자산 유형',v:symbol.includes('BINANCE')?'암호화폐':symbol.includes('KRX')?'한국주식':symbol.includes('NYSE')||symbol.includes('NASDAQ')?'미국주식':'기타'},
            {l:'인터벌',v:INTERVALS.find(i=>i.id===activeInterval)?.label||activeInterval},
            {l:'차트 유형',v:CHART_TYPES.find(c=>c.id===chartType)?.label||chartType},
            {l:'활성 인디케이터',v:activeIndicators.join(', ')||'없음'},
            {l:'드로잉 수',v:`${drawings.length}개`},
          ].map((r,i)=>(
            <div key={r.l} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
              <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
              <span style={{color:T.txt,fontSize:11,fontWeight:600,textAlign:'right',maxWidth:'60%'}}>{r.v}</span>
            </div>
          ))}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='financials'&&(
        <BottomSheet title="💰 재무제표">
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}25`,borderRadius:10,padding:'10px 12px',marginBottom:12}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11,display:'inline-flex',alignItems:'center',gap:5}}>
              <Radio size={11} strokeWidth={2.4}/>재무 데이터 준비중
            </div>
            <div style={{color:T.muted,fontSize:10,marginTop:3}}>Finnhub / FMP API 연동 예정</div>
          </div>
          {[{l:'매출 (TTM)',v:'준비중'},{l:'영업이익률',v:'준비중'},{l:'EPS',v:'준비중'},{l:'PER',v:'준비중'},{l:'PBR',v:'준비중'},{l:'시가총액',v:'준비중'}].map((r,i)=>(
            <div key={r.l} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
              <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
              <span style={{color:T.muted,fontSize:11}}>{r.v}</span>
            </div>
          ))}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='forecasts'&&(
        <BottomSheet title="🔮 애널리스트 예측">
          <div style={{background:T.acl+'12',border:`1px solid ${T.acl}25`,borderRadius:10,padding:'10px 12px',marginBottom:12}}>
            <div style={{color:T.acl,fontWeight:700,fontSize:11,display:'inline-flex',alignItems:'center',gap:5}}>
              <Radio size={11} strokeWidth={2.4}/>예측 데이터 준비중
            </div>
            <div style={{color:T.muted,fontSize:10,marginTop:3}}>TipRanks / Wall Street Horizon API 연동 예정</div>
          </div>
          {[{l:'컨센서스',v:'준비중',c:T.muted},{l:'목표주가',v:'준비중',c:T.muted},{l:'매수 추천',v:'준비중',c:T.grn},{l:'중립',v:'준비중',c:T.ylw},{l:'매도 추천',v:'준비중',c:T.red}].map((r,i)=>(
            <div key={r.l} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
              <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
              <span style={{color:r.c,fontSize:11,fontWeight:600}}>{r.v}</span>
            </div>
          ))}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='technicals'&&(
        <BottomSheet title="기술적 분석">
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:14}}>
            {[{l:'이동평균',v:'매수',c:T.grn},{l:'오실레이터',v:'중립',c:T.ylw},{l:'종합',v:'강한매수',c:T.grn}].map(s=>(
              <div key={s.l} style={{background:`${s.c}12`,border:`1px solid ${s.c}30`,borderRadius:10,padding:'10px 8px',textAlign:'center'}}>
                <div style={{color:s.c,fontWeight:800,fontSize:12,marginBottom:2}}>{s.v}</div>
                <div style={{color:T.muted,fontSize:9}}>{s.l}</div>
              </div>
            ))}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6}}>
            {[{l:'RSI(14)',v:'52.4 — 중립'},{l:'MACD',v:'골든크로스'},{l:'볼린저',v:'중간밴드 위'},{l:'ADX',v:'28.1 — 추세'},{l:'스토캐스틱',v:'46 — 중립'},{l:'CCI',v:'42 — 매수'}].map(r=>(
              <div key={r.l} style={{background:T.alt,borderRadius:8,padding:'7px 9px'}}>
                <div style={{color:T.muted,fontSize:9}}>{r.l}</div>
                <div style={{color:T.txt,fontSize:10,fontWeight:700,marginTop:1}}>{r.v}</div>
              </div>
            ))}
          </div>
          <div style={{marginTop:10,color:T.muted,fontSize:9}}>⚠️ 기술적 분석은 참고용이며 투자 조언이 아닙니다.</div>
        </BottomSheet>
      )}

      {/* ── MORE BOTTOM SHEETS ── */}
      {showSheet&&sheetContent==='idea'&&(
        <BottomSheet title="💡 아이디어 작성">
          <div style={{marginBottom:10}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:5}}>제목</div>
            <input placeholder="트레이딩 아이디어 제목…" style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 12px',color:T.txt,fontSize:16,outline:'none'}}/>
          </div>
          <div style={{marginBottom:10}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:5}}>방향</div>
            <div style={{display:'flex',gap:6}}>
              {([
                { id:'long',   label:'롱',   Icon: TrendingUp,    color: T.grn },
                { id:'short',  label:'숏',   Icon: TrendingDown,  color: T.red },
                { id:'neutral',label:'중립', Icon: ArrowLeftRight,color: T.muted },
              ] as const).map(d => {
                const Ic = d.Icon;
                return (
                  <button key={d.id}
                    style={{flex:1,padding:'9px',minHeight:38,background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,fontSize:11,fontWeight:700,cursor:'pointer',display:'inline-flex',alignItems:'center',justifyContent:'center',gap:4}}>
                    <Ic size={12} strokeWidth={2.4} color={d.color}/>{d.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{marginBottom:12}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:5}}>내용</div>
            <textarea placeholder="분석 내용을 작성하세요…" rows={4} style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 12px',color:T.txt,fontSize:14,outline:'none',resize:'none',fontFamily:'inherit'}}/>
          </div>
          <button style={{width:'100%',padding:'12px',background:'linear-gradient(135deg,#2563EB,#7C3AED)',color:'#fff',border:'none',borderRadius:11,fontWeight:800,fontSize:13,cursor:'pointer'}}>아이디어 게시 (준비중)</button>
          <div style={{color:T.muted,fontSize:9,textAlign:'center',marginTop:6}}>커뮤니티 아이디어 공유 기능 준비 중</div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='pine'&&(
        <BottomSheet title="🌲 파인 에디터">
          <div style={{background:'#030610',borderRadius:10,padding:'12px',marginBottom:10,fontFamily:'monospace',fontSize:11,color:'#50FA7B',lineHeight:1.7}}>
            <div style={{color:'#8BE9FD'}}>//@version=5</div>
            <div style={{color:'#FF79C6'}}>indicator<span style={{color:'#F8F8F2'}}>(<span style={{color:'#F1FA8C'}}>"My Script"</span>, overlay=<span style={{color:'#BD93F9'}}>true</span>)</span></div>
            <div style={{color:'#F8F8F2',marginTop:4}}>plot(close, <span style={{color:'#F1FA8C'}}>"Close"</span>, color=color.blue)</div>
          </div>
          <div style={{color:T.muted,fontSize:11,lineHeight:1.5,marginBottom:12}}>
            Pine Script를 작성하고 TradingView에서 적용하세요.<br/>
            WUNDER 자동매매 전략도 Pine Script로 작성됩니다.
          </div>
          <div style={{display:'flex',gap:6}}>
            <a href="/chart" target="_blank" style={{flex:1,display:'block',padding:'10px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,fontSize:11,fontWeight:700,textDecoration:'none',textAlign:'center'}}>TradingView에서 열기 ↗</a>
            <button onClick={()=>setTab('wunder' as any)} style={{flex:1,padding:'10px',background:T.prp+'15',color:T.prp,border:`1px solid ${T.prp}30`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>WUNDER 봇 Pine Script</button>
          </div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='help'&&(
        <BottomSheet title="❓ 도움말">
          {[
            {icon:'📈',t:'차트 기본 조작',d:'핀치 줌 · 스크롤 · 클릭으로 심볼 변경'},
            {icon:'✏️',t:'드로잉 도구 사용법',d:'도구 탭에서 선택 → 한 번 더 클릭으로 추가'},
            {icon:'⏱',t:'인터벌 변경',d:'상단 인터벌 버튼 탭 또는 인터벌 탭 이동'},
            {icon:'💾',t:'레이아웃 저장',d:'레이아웃 탭 → + 저장 → 이름 입력'},
            {icon:'🔗',t:'TradingView 연동',d:'웹훅 탭에서 TradingView Alert 설정'},
            {icon:'🤖',t:'자동매매 봇',d:'WUNDER봇 탭에서 Pine Script 설정'},
          ].map((h,i)=>(
            <div key={h.t} style={{display:'flex',gap:10,padding:'10px 0',borderBottom:`1px solid ${T.border}`}}>
              <span style={{fontSize:20,flexShrink:0}}>{h.icon}</span>
              <div>
                <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{h.t}</div>
                <div style={{color:T.muted,fontSize:10,marginTop:2,lineHeight:1.4}}>{h.d}</div>
              </div>
            </div>
          ))}
          <div style={{marginTop:10,color:T.muted,fontSize:9,textAlign:'center'}}>TRAIGO v8 · 모의투자 전용</div>
        </BottomSheet>
      )}

}


/* ── Navigation tabs ── */
const BTABS=[
  {id:'home',label:'홈',icon:'🏠'},{id:'watchlist',label:'왓치',icon:'⭐'},
  {id:'market',label:'시장',icon:'📊'},{id:'trading',label:'매매',icon:'⚡'},
  {id:'auto',label:'자동',icon:'🤖'},{id:'season',label:'시즌전략',icon:'🌱'},
];
const MTABS=[
  {id:'portfolio',label:'포트폴리오',icon:'💼'},{id:'history',label:'매매일지',icon:'📝'},
  {id:'backtest',label:'백테스트',icon:'🧪'},{id:'ai',label:'AI채팅',icon:'💬'},
  {id:'academy',label:'아카데미',icon:'📚'},{id:'news',label:'뉴스',icon:'📰'},
  {id:'alerts',label:'알림',icon:'🔔'},{id:'social',label:'소셜',icon:'👥'},
  {id:'accounts',label:'거래소연결',icon:'🔗'},{id:'funding',label:'입출금',icon:'💸'},{id:'pnl',label:'수익계산',icon:'💹'},
  {id:'analysis',label:'분석허브',icon:'🔬'},{id:'hedgeos',label:'Hedge OS',icon:'🏦'},{id:'intelligence',label:'인텔리전스',icon:'🧠'},{id:'chart',label:'차트',icon:'📈'},{id:'wunder',label:'WUNDER봇',icon:'🤖'},{id:'tradfi',label:'TradFi',icon:'📊'},{id:'realtime',label:'실시간',icon:'📡'},
  {id:'analytics',label:'분석',icon:'📈'},{id:'calendar',label:'경제캘린더',icon:'📅'},
  {id:'briefing',label:'AI브리핑',icon:'🤖'},{id:'tax',label:'손익·세금',icon:'💼'},
  {id:'growth',label:'성장',icon:'🏆'},{id:'heatmap',label:'히트맵',icon:'🌈'},
  {id:'scanner',label:'스캐너',icon:'🔍'},{id:'clock',label:'세계시장',icon:'🌐'},
  {id:'settings',label:'설정',icon:'⚙️'},
  {id:'subscription',label:'구독',icon:'💳'},
  {id:'posters',label:'강의',icon:'🎓'},{id:'safety',label:'안전제어',icon:'🛡️'},{id:'hub',label:'허브',icon:'🌐'},
];

// ══════════════════════════════════════════════════════════════
// ADMIN PAGE — only rendered when isAdminUser === true
// Role is verified server-side on every /api/admin call.
// To promote a user to admin, run in Supabase SQL:
//   UPDATE profiles SET role = 'admin' WHERE email = 'your@email.com';
// ══════════════════════════════════════════════════════════════


export default AnalysisHubPage;
'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, LOGO_SOURCES } from '@/lib/constants';
import { toTradingViewSymbol } from '@/lib/tvSymbol';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR } from '@/data/assets';
import type { Asset } from '@/types';

export interface LogoDef {
  primary?: string;
  fallbacks?: string[];
  url?: string;
  fallback?: string;
}



export const KR_NAMES: Record<string,string> = {
  // Crypto
  BTC:'비트코인',ETH:'이더리움',SOL:'솔라나',XRP:'리플',BNB:'바이낸스코인',
  DOGE:'도지코인',ADA:'에이다',AVAX:'아발란체',TON:'톤코인',LINK:'체인링크',
  DOT:'폴카닷',MATIC:'폴리곤',UNI:'유니스왑',ARB:'아비트럼',OP:'옵티미즘',
  SUI:'수이',APT:'앱토스',INJ:'인젝티브',PEPE:'페페',SHIB:'시바이누',
  NEAR:'니어',ICP:'인터넷컴퓨터',FIL:'파일코인',LTC:'라이트코인',
  ATOM:'코스모스',VET:'비체인',ALGO:'알고랜드',THETA:'쎄타',EOS:'이오스',
  // US Stocks
  AAPL:'애플',MSFT:'마이크로소프트',NVDA:'엔비디아',TSLA:'테슬라',
  GOOGL:'구글',GOOG:'구글',AMZN:'아마존',META:'메타',AMD:'AMD',
  INTC:'인텔',AVGO:'브로드컴',QCOM:'퀄컴',TSM:'TSMC',ARM:'ARM',
  SMCI:'슈퍼마이크로',PLTR:'팔란티어',PL:'플래닛랩스',
  JPM:'JP모건',GS:'골드만삭스',BAC:'뱅크오브아메리카',MS:'모건스탠리',
  C:'씨티그룹',WFC:'웰스파고',V:'비자',MA:'마스터카드',
  PYPL:'페이팔',COIN:'코인베이스',HOOD:'로빈후드',SOFI:'소파이',
  SQ:'블록',MSTR:'마이크로스트레티지',
  XOM:'엑슨모빌',CVX:'셰브론',LLY:'일라이릴리',UNH:'유나이티드헬스',
  JNJ:'존슨앤존슨',PFE:'화이자',MRNA:'모더나',ABBV:'애브비',
  WMT:'월마트',COST:'코스트코',MCD:'맥도날드',SBUX:'스타벅스',
  KO:'코카콜라',PEP:'펩시코',NKE:'나이키',NFLX:'넷플릭스',
  DIS:'디즈니',BA:'보잉',LMT:'록히드마틴',RTX:'레이시온',NOC:'노스롭',
  RIVN:'리비안',NIO:'니오',GME:'게임스탑',AMC:'AMC',
  SHOP:'쇼피파이',SNOW:'스노우플레이크',CRWD:'크라우드스트라이크',
  UBER:'우버',LYFT:'리프트',ABNB:'에어비앤비',DASH:'도어대시',
  SPOT:'스포티파이',RBLX:'로블록스',U:'유니티',DKNG:'드래프트킹스',
  ORCL:'오라클',IBM:'IBM',CRM:'세일즈포스',NOW:'서비스나우',
  ADBE:'어도비',INTU:'인튜이트',PANW:'팔로알토',ZS:'지스케일러',
  OKTA:'옥타',TWLO:'트윌리오',DDOG:'데이터독',NET:'클라우드플레어',
  // Korean Stocks
  '005930':'삼성전자','000660':'SK하이닉스','035420':'NAVER',
  '035720':'카카오','005380':'현대차','000270':'기아','051910':'LG화학',
  '006400':'삼성SDI','068270':'셀트리온','028260':'삼성물산',
  '105560':'KB금융','055550':'신한지주','086790':'하나금융','316140':'우리금융',
  '032830':'삼성생명','018260':'삼성SDS','207940':'삼성바이오로직스',
  '000100':'유한양행','096770':'SK이노베이션','267250':'현대중공업',
  // ETFs
  SPY:'S&P500 ETF',QQQ:'나스닥100 ETF',IWM:'러셀2000 ETF',DIA:'다우존스 ETF',
  TQQQ:'나스닥3배',SQQQ:'나스닥3배인버스',SOXL:'반도체3배',SOXS:'반도체3배인버스',
  ARKK:'ARK이노베이션',GLD:'금 ETF',TLT:'20년국채 ETF',HYG:'하이일드채권 ETF',
  XLE:'에너지 ETF',XLF:'금융 ETF',XLK:'테크 ETF',XLV:'헬스케어 ETF',
  USO:'원유 ETF',BITO:'비트코인선물 ETF',IBIT:'블랙록비트코인 ETF',
  // Indices / Macro
  SPX:'S&P 500',NDX:'나스닥100',DJI:'다우존스',VIX:'공포지수',
  RUT:'러셀2000',FTSE:'영국 FTSE',DAX:'독일 DAX',N225:'일본 닛케이',
  DXY:'달러인덱스',USDKRW:'달러/원화',EURUSD:'유로/달러',
  USDJPY:'달러/엔',GBPUSD:'파운드/달러',USDCNH:'달러/위안',
  // Commodities
  XAUUSD:'금(Gold)',XAGUSD:'은(Silver)',USOIL:'WTI원유',UKOIL:'브렌트원유',
  NATGAS:'천연가스',COPPER:'구리',WHEAT:'밀',CORN:'옥수수',SOYB:'대두',
};

// ── TradingView symbol resolver ──
export const TV_SYM_MAP: Record<string,string> = {
  BTC:'BINANCE:BTCUSDT',ETH:'BINANCE:ETHUSDT',SOL:'BINANCE:SOLUSDT',
  XRP:'BINANCE:XRPUSDT',BNB:'BINANCE:BNBUSDT',DOGE:'BINANCE:DOGEUSDT',
  ADA:'BINANCE:ADAUSDT',AVAX:'BINANCE:AVAXUSDT',TON:'BINANCE:TONUSDT',
  LINK:'BINANCE:LINKUSDT',DOT:'BINANCE:DOTUSDT',MATIC:'BINANCE:MATICUSDT',
  UNI:'BINANCE:UNIUSDT',ARB:'BINANCE:ARBUSDT',OP:'BINANCE:OPUSDT',
  SUI:'BINANCE:SUIUSDT',APT:'BINANCE:APTUSDT',PEPE:'BINANCE:PEPEUSDT',
  SHIB:'BINANCE:SHIBUSDT',
  AAPL:'NASDAQ:AAPL',MSFT:'NASDAQ:MSFT',NVDA:'NASDAQ:NVDA',
  TSLA:'NASDAQ:TSLA',GOOGL:'NASDAQ:GOOGL',GOOG:'NASDAQ:GOOG',
  AMZN:'NASDAQ:AMZN',META:'NASDAQ:META',AMD:'NASDAQ:AMD',
  INTC:'NASDAQ:INTC',AVGO:'NASDAQ:AVGO',QCOM:'NASDAQ:QCOM',
  ARM:'NASDAQ:ARM',SMCI:'NASDAQ:SMCI',PLTR:'NYSE:PLTR',
  PL:'NYSE:PL',COIN:'NASDAQ:COIN',HOOD:'NASDAQ:HOOD',SOFI:'NASDAQ:SOFI',
  MSTR:'NASDAQ:MSTR',JPM:'NYSE:JPM',GS:'NYSE:GS',BAC:'NYSE:BAC',
  V:'NYSE:V',MA:'NYSE:MA',PYPL:'NASDAQ:PYPL',
  XOM:'NYSE:XOM',CVX:'NYSE:CVX',LLY:'NYSE:LLY',UNH:'NYSE:UNH',
  WMT:'NYSE:WMT',COST:'NASDAQ:COST',NFLX:'NASDAQ:NFLX',
  DIS:'NYSE:DIS',RIVN:'NASDAQ:RIVN',GME:'NYSE:GME',
  SHOP:'NYSE:SHOP',SNOW:'NYSE:SNOW',CRWD:'NASDAQ:CRWD',
  TSM:'NYSE:TSM',ORCL:'NYSE:ORCL',CRM:'NYSE:CRM',ADBE:'NASDAQ:ADBE',
  '005930':'KRX:005930','000660':'KRX:000660','035420':'KRX:035420',
  '035720':'KRX:035720','005380':'KRX:005380','000270':'KRX:000270',
  SPY:'AMEX:SPY',QQQ:'NASDAQ:QQQ',TQQQ:'NASDAQ:TQQQ',SQQQ:'NASDAQ:SQQQ',
  SOXL:'AMEX:SOXL',ARKK:'AMEX:ARKK',GLD:'AMEX:GLD',TLT:'NASDAQ:TLT',
  IBIT:'NASDAQ:IBIT',BITO:'AMEX:BITO',
  DXY:'TVC:DXY',SPX:'SP:SPX',NDX:'NASDAQ:NDX',VIX:'TVC:VIX',
  XAUUSD:'OANDA:XAUUSD',XAGUSD:'OANDA:XAGUSD',USOIL:'TVC:USOIL',
  UKOIL:'TVC:UKOIL',NATGAS:'NYMEX:NG1!',COPPER:'COMEX:HG1!',
};

// ── Resolve TV symbol from ticker ──
export const resolveTVSym = (ticker: string): string => toTradingViewSymbol(ticker);

// ── Get Korean display name ──
export const getKrName = (ticker: string, fallback = ''): string => {
  const t = ticker?.toUpperCase?.()?.trim?.() || '';
  return KR_NAMES[t] || fallback || ticker;
};

// ── Clean English name (remove corporate suffixes) ──
export const cleanName = (name: string): string => {
  if (!name) return '';
  return name
    .replace(/ Inc\.?$/i,'').replace(/ Corp\.?$/i,'').replace(/ Corporation$/i,'')
    .replace(/ Ltd\.?$/i,'').replace(/ Limited$/i,'').replace(/ Holdings?$/i,'')
    .replace(/ Group$/i,'').replace(/ 주식회사$/,'').replace(/ Co\.?$/i,'')
    .replace(/,? LLC$/i,'').replace(/,? PLC$/i,'').replace(/ Technologies$/i,'')
    .replace(/ International$/i,'').replace(/ Capital$/i,'')
    .trim();
};

// ── Logo URL resolver ──
export const resolveLogoUrl = (ticker: string, assetType = ''): string | null => {
  const t = ticker?.toUpperCase?.()?.trim?.() || '';
  // Crypto logos via cryptologos.cc
  const cryptoIds: Record<string,string> = {
    BTC:'bitcoin',ETH:'ethereum',SOL:'solana',XRP:'ripple',BNB:'binancecoin',
    DOGE:'dogecoin',ADA:'cardano',AVAX:'avalanche-2',TON:'the-open-network',
    LINK:'chainlink',DOT:'polkadot',MATIC:'matic-network',ARB:'arbitrum',SUI:'sui',
  };
  if (cryptoIds[t]) return `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons/128/color/${cryptoIds[t].toLowerCase()}.png`;
  // Stocks — Clearbit
  const domainMap: Record<string,string> = {
    AAPL:'apple.com',MSFT:'microsoft.com',NVDA:'nvidia.com',TSLA:'tesla.com',
    GOOGL:'google.com',GOOG:'google.com',AMZN:'amazon.com',META:'meta.com',
    AMD:'amd.com',INTC:'intel.com',AVGO:'broadcom.com',QCOM:'qualcomm.com',
    TSM:'tsmc.com',PLTR:'palantir.com',PL:'planet.com',
    COIN:'coinbase.com',HOOD:'robinhood.com',SOFI:'sofi.com',
    JPM:'jpmorganchase.com',GS:'goldmansachs.com',BAC:'bankofamerica.com',
    V:'visa.com',MA:'mastercard.com',PYPL:'paypal.com',
    WMT:'walmart.com',COST:'costco.com',NFLX:'netflix.com',
    DIS:'thewaltdisneycompany.com',RIVN:'rivian.com',
    SHOP:'shopify.com',SNOW:'snowflake.com',CRWD:'crowdstrike.com',
    ORCL:'oracle.com',CRM:'salesforce.com',ADBE:'adobe.com',
  };
  if (domainMap[t]) return `https://logo.clearbit.com/${domainMap[t]}`;
  return null;
};

export const getBgColor = (ticker: string): string => {
  let hash = 0;
  for (const ch of (ticker || '')) hash = ((hash << 5) - hash) + ch.charCodeAt(0);
  const P = ['#3B82F6','#7C3AED','#10B981','#F59E0B','#EF4444','#0891B2','#D97706','#8B5CF6'];
  return P[Math.abs(hash) % P.length];
};




export function Bdg({c,ch,sm}:{c:string;ch:string;sm?:boolean;[key:string]:any}) {
  return <span style={{background:c+'20',color:c,fontSize:sm?9:10,fontWeight:700,padding:sm?'1px 5px':'2px 8px',borderRadius:99,border:`1px solid ${c}30`,whiteSpace:'nowrap',display:'inline-block'}}>{ch}</span>;
}
export function Pill({ch,active,color,onClick}:{ch:string;active:boolean;color?:string;onClick:()=>void;[key:string]:any}) {
  const col=color||T.acl;
  return <button onClick={onClick} style={{background:active?col+'20':'transparent',color:active?col:T.muted,border:`1px solid ${active?col:T.border}`,borderRadius:20,padding:'5px 13px',fontSize:12,fontWeight:600,cursor:'pointer',whiteSpace:'nowrap'}}>{ch}</button>;
}
export function Toggle({on,onChange}:{on:boolean;onChange:(v:boolean)=>void}) {
  return <div onClick={()=>onChange(!on)} style={{width:44,height:24,borderRadius:12,background:on?T.acl:'#243A5E',cursor:'pointer',position:'relative',flexShrink:0,transition:'background .2s'}}><div style={{position:'absolute',top:3,left:on?23:3,width:18,height:18,borderRadius:9,background:'#fff',transition:'left .2s',boxShadow:'0 1px 4px rgba(0,0,0,.4)'}}/></div>;
}
export function Card({children,style,glow}:{children?:React.ReactNode;style?:React.CSSProperties;glow?:boolean;[key:string]:any}) {
  return <div style={{background:T.card,border:`1px solid ${glow?T.acl:T.border}`,borderRadius:18,boxShadow:glow?`0 0 20px ${T.acg}`:'none',...style}}>{children}</div>;
}
export function Dot({c}:{c?:string}) {
  return <span style={{display:'inline-block',width:7,height:7,borderRadius:'50%',background:c||T.grn,animation:'pulse 1.5s ease-in-out infinite'}}/>;
}
export function Spark({pos,w,h}:{pos:boolean;w?:number;h?:number}) {
  const W=w||70,H=h||28;
  // Deterministic seeded random — no hydration mismatch
  const seed = pos ? 0.42 : 0.58;
  const pts=useMemo(()=>{const a=[];let y=H/2;let r=seed*1000;
    for(let i=0;i<14;i++){r=(r*1664525+1013904223)%4294967296;const rv=(r/4294967296-seed)*5.5;y+=rv;y=clamp(y,3,H-3);a.push({x:(i/13)*W,y});}return a;},[pos,W,H,seed]);
  const d=pts.map((p,i)=>(i===0?'M':'L')+p.x.toFixed(1)+','+p.y.toFixed(1)).join(' ');
  const col=pos?T.grn:T.red;const uid2=pos?'sp':'sn';
  return <svg width={W} height={H} style={{display:'block',flexShrink:0}}><defs><linearGradient id={uid2} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.3"/><stop offset="100%" stopColor={col} stopOpacity="0"/></linearGradient></defs><path d={d+' L'+W+','+H+' L0,'+H+' Z'} fill={'url(#'+uid2+')'}/><path d={d} stroke={col} strokeWidth="1.8" fill="none" strokeLinecap="round"/></svg>;
}
export function AreaChart({color,h,up}:{color?:string;h?:number;up?:boolean}) {
  const col=color||T.acl,H=h||120,W=320;
  // Deterministic seeded random — no hydration mismatch
  const seed = up!==false ? 0.43 : 0.57;
  const pts=useMemo(()=>{const a=[];let y=H*0.65;let r=seed*9999;
    for(let i=0;i<40;i++){r=(r*1664525+1013904223)%4294967296;const rv=(r/4294967296-seed)*11;y+=rv;y=clamp(y,H*0.08,H*0.92);a.push({x:(i/39)*W,y});}return a;},[up,H,seed]);
  const d=pts.map((p,i)=>(i===0?'M':'L')+p.x.toFixed(1)+','+p.y.toFixed(1)).join(' ');
  const uid2=up!==false?'au':'ad';
  return <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:H,display:'block'}} preserveAspectRatio="none"><defs><linearGradient id={uid2} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.22"/><stop offset="100%" stopColor={col} stopOpacity="0"/></linearGradient></defs><path d={d+' L'+W+','+H+' L0,'+H+' Z'} fill={'url(#'+uid2+')'}/><path d={d} stroke={col} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

/* ── Onboarding ── */

export const LOGO_DB: Record<string, LogoDef> = {
  /* ── Mega-cap Tech ── */
  'AAPL': { primary:'https://logo.clearbit.com/apple.com',              fallbacks:['https://site.financialmodelingprep.com/image-stock/AAPL.png'],           initials:'AP', bg:'#A0A0A0' },
  'MSFT': { primary:'https://logo.clearbit.com/microsoft.com',          fallbacks:['https://site.financialmodelingprep.com/image-stock/MSFT.png'],           initials:'MS', bg:'#00A4EF' },
  'NVDA': { primary:'https://logo.clearbit.com/nvidia.com',             fallbacks:['https://site.financialmodelingprep.com/image-stock/NVDA.png'],           initials:'NV', bg:'#76B900' },
  'GOOGL': { primary:'https://logo.clearbit.com/google.com',            fallbacks:['https://site.financialmodelingprep.com/image-stock/GOOGL.png'],          initials:'GO', bg:'#4285F4' },
  'GOOG':  { primary:'https://logo.clearbit.com/google.com',            fallbacks:[],                                                                   initials:'GO', bg:'#4285F4' },
  'AMZN': { primary:'https://logo.clearbit.com/amazon.com',             fallbacks:['https://site.financialmodelingprep.com/image-stock/AMZN.png'],           initials:'AZ', bg:'#FF9900' },
  'META': { primary:'https://logo.clearbit.com/meta.com',               fallbacks:['https://site.financialmodelingprep.com/image-stock/META.png'],           initials:'MT', bg:'#0082FB' },
  'TSLA': { primary:'https://logo.clearbit.com/tesla.com',              fallbacks:['https://site.financialmodelingprep.com/image-stock/TSLA.png'],           initials:'TS', bg:'#CC0000' },
  'NFLX': { primary:'https://logo.clearbit.com/netflix.com',            fallbacks:['https://site.financialmodelingprep.com/image-stock/NFLX.png'],           initials:'NF', bg:'#E50914' },
  'DIS':  { primary:'https://logo.clearbit.com/disney.com',             fallbacks:['https://site.financialmodelingprep.com/image-stock/DIS.png'],            initials:'DI', bg:'#113CCF' },
  'ORCL': { primary:'https://logo.clearbit.com/oracle.com',             fallbacks:[],                                                                   initials:'OR', bg:'#F80000' },
  'CRM':  { primary:'https://logo.clearbit.com/salesforce.com',         fallbacks:[],                                                                   initials:'SF', bg:'#00A1E0' },
  'ADBE': { primary:'https://logo.clearbit.com/adobe.com',              fallbacks:[],                                                                   initials:'AD', bg:'#FF0000' },
  'CSCO': { primary:'https://logo.clearbit.com/cisco.com',              fallbacks:[],                                                                   initials:'CS', bg:'#1BA0D7' },
  'SHOP': { primary:'https://logo.clearbit.com/shopify.com',            fallbacks:[],                                                                   initials:'SH', bg:'#96BF48' },
  'NET':  { primary:'https://logo.clearbit.com/cloudflare.com',         fallbacks:[],                                                                   initials:'CF', bg:'#F48120' },
  'SPOT': { primary:'https://logo.clearbit.com/spotify.com',            fallbacks:[],                                                                   initials:'SP', bg:'#1DB954' },
  'UBER': { primary:'https://logo.clearbit.com/uber.com',               fallbacks:[],                                                                   initials:'UB', bg:'#000000' },
  'ABNB': { primary:'https://logo.clearbit.com/airbnb.com',             fallbacks:[],                                                                   initials:'AB', bg:'#FF5A5F' },
  'SNAP': { primary:'https://logo.clearbit.com/snap.com',               fallbacks:[],                                                                   initials:'SN', bg:'#FFFC00' },
  /* ── AI / Semiconductors ── */
  'AMD':  { primary:'https://logo.clearbit.com/amd.com',                fallbacks:['https://site.financialmodelingprep.com/image-stock/AMD.png'],            initials:'AM', bg:'#ED1C24' },
  'INTC': { primary:'https://logo.clearbit.com/intel.com',              fallbacks:['https://site.financialmodelingprep.com/image-stock/INTC.png'],           initials:'IN', bg:'#0071C5' },
  'AVGO': { primary:'https://logo.clearbit.com/broadcom.com',           fallbacks:['https://site.financialmodelingprep.com/image-stock/AVGO.png'],           initials:'BC', bg:'#CC0000' },
  'QCOM': { primary:'https://logo.clearbit.com/qualcomm.com',           fallbacks:['https://site.financialmodelingprep.com/image-stock/QCOM.png'],           initials:'QC', bg:'#3253DC' },
  'TSM':  { primary:'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/TSMC.svg/480px-TSMC.svg.png', fallbacks:['https://site.financialmodelingprep.com/image-stock/TSM.png'], initials:'TM', bg:'#BB2A35' },
  'ASML': { primary:'https://logo.clearbit.com/asml.com',               fallbacks:[],                                                                   initials:'AS', bg:'#0072CE' },
  'MU':   { primary:'https://logo.clearbit.com/micron.com',             fallbacks:[],                                                                   initials:'MI', bg:'#1C4F8C' },
  'PLTR': { primary:'https://logo.clearbit.com/palantir.com',           fallbacks:['https://site.financialmodelingprep.com/image-stock/PLTR.png'],           initials:'PL', bg:'#000000' },
  'SMCI': { primary:'https://logo.clearbit.com/supermicro.com',         fallbacks:[],                                                                   initials:'SM', bg:'#006699' },
  'ARM':  { primary:'https://logo.clearbit.com/arm.com',                fallbacks:[],                                                                   initials:'AR', bg:'#00C0C0' },
  'PL':   { primary:'https://logo.clearbit.com/planet.com',             fallbacks:['https://site.financialmodelingprep.com/image-stock/PL.png'],             initials:'PL', bg:'#00A3E0' },
  /* ── Finance ── */
  'JPM':  { primary:'https://logo.clearbit.com/jpmorganchase.com',      fallbacks:['https://site.financialmodelingprep.com/image-stock/JPM.png'],            initials:'JP', bg:'#006DAE' },
  'BAC':  { primary:'https://logo.clearbit.com/bankofamerica.com',      fallbacks:['https://site.financialmodelingprep.com/image-stock/BAC.png'],            initials:'BA', bg:'#E31837' },
  'GS':   { primary:'https://logo.clearbit.com/goldmansachs.com',       fallbacks:[],                                                                   initials:'GS', bg:'#6C8EBF' },
  'MS':   { primary:'https://logo.clearbit.com/morganstanley.com',      fallbacks:[],                                                                   initials:'MS', bg:'#003087' },
  'V':    { primary:'https://logo.clearbit.com/visa.com',               fallbacks:['https://site.financialmodelingprep.com/image-stock/V.png'],              initials:'VI', bg:'#1A1F71' },
  'MA':   { primary:'https://logo.clearbit.com/mastercard.com',         fallbacks:['https://site.financialmodelingprep.com/image-stock/MA.png'],             initials:'MC', bg:'#EB001B' },
  'PYPL': { primary:'https://logo.clearbit.com/paypal.com',             fallbacks:['https://site.financialmodelingprep.com/image-stock/PYPL.png'],           initials:'PP', bg:'#009CDE' },
  'COIN': { primary:'https://logo.clearbit.com/coinbase.com',           fallbacks:['https://site.financialmodelingprep.com/image-stock/COIN.png'],           initials:'CB', bg:'#0052FF' },
  'HOOD': { primary:'https://logo.clearbit.com/robinhood.com',          fallbacks:['https://site.financialmodelingprep.com/image-stock/HOOD.png'],           initials:'RH', bg:'#00C805' },
  'SOFI': { primary:'https://logo.clearbit.com/sofi.com',               fallbacks:['https://site.financialmodelingprep.com/image-stock/SOFI.png'],           initials:'SF', bg:'#7B40F2' },
  'SQ':   { primary:'https://logo.clearbit.com/block.xyz',              fallbacks:[],                                                                   initials:'BL', bg:'#006AFF' },
  'MSTR': { primary:'https://logo.clearbit.com/microstrategy.com',      fallbacks:[],                                                                   initials:'MS', bg:'#E87426' },
  /* ── EV / Consumer ── */
  'RIVN': { primary:'https://logo.clearbit.com/rivian.com',             fallbacks:['https://site.financialmodelingprep.com/image-stock/RIVN.png'],           initials:'RV', bg:'#3DD286' },
  'NIO':  { primary:'https://logo.clearbit.com/nio.com',                fallbacks:['https://site.financialmodelingprep.com/image-stock/NIO.png'],            initials:'NI', bg:'#2BACE2' },
  'GM':   { primary:'https://logo.clearbit.com/gm.com',                 fallbacks:[],                                                                   initials:'GM', bg:'#0170CE' },
  'F':    { primary:'https://logo.clearbit.com/ford.com',               fallbacks:[],                                                                   initials:'FD', bg:'#003499' },
  'BABA': { primary:'https://logo.clearbit.com/alibaba.com',            fallbacks:[],                                                                   initials:'AL', bg:'#FF6A00' },
  'GME':  { primary:'https://logo.clearbit.com/gamestop.com',           fallbacks:[],                                                                   initials:'GS', bg:'#E1373B' },
  /* ── Healthcare ── */
  'LLY':  { primary:'https://logo.clearbit.com/lilly.com',              fallbacks:['https://site.financialmodelingprep.com/image-stock/LLY.png'],            initials:'EL', bg:'#D52B1E' },
  'PFE':  { primary:'https://logo.clearbit.com/pfizer.com',             fallbacks:['https://site.financialmodelingprep.com/image-stock/PFE.png'],            initials:'PF', bg:'#0093D0' },
  'JNJ':  { primary:'https://logo.clearbit.com/jnj.com',               fallbacks:['https://site.financialmodelingprep.com/image-stock/JNJ.png'],            initials:'JJ', bg:'#CC0000' },
  'MRK':  { primary:'https://logo.clearbit.com/merck.com',              fallbacks:[],                                                                   initials:'MK', bg:'#0071A9' },
  'UNH':  { primary:'https://logo.clearbit.com/unitedhealthgroup.com',  fallbacks:[],                                                                   initials:'UH', bg:'#316BBE' },
  'MRNA': { primary:'https://logo.clearbit.com/modernatx.com',          fallbacks:[],                                                                   initials:'MR', bg:'#0040C9' },
  /* ── Consumer / Retail ── */
  'WMT':  { primary:'https://logo.clearbit.com/walmart.com',            fallbacks:['https://site.financialmodelingprep.com/image-stock/WMT.png'],            initials:'WM', bg:'#0071CE' },
  'COST': { primary:'https://logo.clearbit.com/costco.com',             fallbacks:['https://site.financialmodelingprep.com/image-stock/COST.png'],           initials:'CO', bg:'#005DAA' },
  'MCD':  { primary:'https://logo.clearbit.com/mcdonalds.com',          fallbacks:['https://site.financialmodelingprep.com/image-stock/MCD.png'],            initials:'MC', bg:'#DA291C' },
  'SBUX': { primary:'https://logo.clearbit.com/starbucks.com',          fallbacks:['https://site.financialmodelingprep.com/image-stock/SBUX.png'],           initials:'SB', bg:'#00704A' },
  'KO':   { primary:'https://logo.clearbit.com/coca-cola.com',          fallbacks:['https://site.financialmodelingprep.com/image-stock/KO.png'],             initials:'CC', bg:'#F40000' },
  'PEP':  { primary:'https://logo.clearbit.com/pepsico.com',            fallbacks:['https://site.financialmodelingprep.com/image-stock/PEP.png'],            initials:'PE', bg:'#004B93' },
  'NKE':  { primary:'https://logo.clearbit.com/nike.com',               fallbacks:['https://site.financialmodelingprep.com/image-stock/NKE.png'],            initials:'NK', bg:'#111111' },
  /* ── Defense ── */
  'BA':   { primary:'https://logo.clearbit.com/boeing.com',             fallbacks:['https://site.financialmodelingprep.com/image-stock/BA.png'],             initials:'BO', bg:'#1D4289' },
  'LMT':  { primary:'https://logo.clearbit.com/lockheedmartin.com',     fallbacks:['https://site.financialmodelingprep.com/image-stock/LMT.png'],            initials:'LM', bg:'#003087' },
  'RTX':  { primary:'https://logo.clearbit.com/rtx.com',               fallbacks:['https://site.financialmodelingprep.com/image-stock/RTX.png'],            initials:'RT', bg:'#003087' },
  'NOC':  { primary:'https://logo.clearbit.com/northropgrumman.com',    fallbacks:[],                                                                   initials:'NG', bg:'#003087' },
  /* ── ETFs ── */
  'SPY':  { primary:'https://logo.clearbit.com/ssga.com',               fallbacks:[],                                                                   initials:'SP', bg:'#1D4ED8' },
  'QQQ':  { primary:'https://logo.clearbit.com/invesco.com',            fallbacks:[],                                                                   initials:'QQ', bg:'#7C3AED' },
  'IWM':  { primary:'https://logo.clearbit.com/ishares.com',            fallbacks:[],                                                                   initials:'IW', bg:'#059669' },
  'DIA':  { primary:'https://logo.clearbit.com/ssga.com',               fallbacks:[],                                                                   initials:'DI', bg:'#D97706' },
  'TQQQ': { primary:'https://logo.clearbit.com/proshares.com',          fallbacks:[],                                                                   initials:'TQ', bg:'#7C3AED' },
  'SQQQ': { primary:'https://logo.clearbit.com/proshares.com',          fallbacks:[],                                                                   initials:'SQ', bg:'#DC2626' },
  'SOXL': { primary:'https://logo.clearbit.com/direxion.com',           fallbacks:[],                                                                   initials:'SX', bg:'#7C3AED' },
  'SOXS': { primary:'https://logo.clearbit.com/direxion.com',           fallbacks:[],                                                                   initials:'SS', bg:'#DC2626' },
  'ARKK': { primary:'https://logo.clearbit.com/ark-invest.com',         fallbacks:[],                                                                   initials:'AK', bg:'#7C3AED' },
  'GLD':  { primary:'https://logo.clearbit.com/ssga.com',               fallbacks:[],                                                                   initials:'GL', bg:'#D97706' },
  'TLT':  { primary:'https://logo.clearbit.com/ishares.com',            fallbacks:[],                                                                   initials:'TL', bg:'#1D4ED8' },
  /* ── Korean stocks ── */
  '005930': { primary:'https://logo.clearbit.com/samsung.com',          fallbacks:[],                                                                   initials:'삼성', bg:'#1428A0' },
  '000660': { primary:'https://logo.clearbit.com/skhynix.com',          fallbacks:[],                                                                   initials:'SK', bg:'#EA1917' },
  '035420': { primary:'https://logo.clearbit.com/navercorp.com',        fallbacks:[],                                                                   initials:'NV', bg:'#03C75A' },
  '035720': { primary:'https://logo.clearbit.com/kakao.com',            fallbacks:[],                                                                   initials:'KA', bg:'#FEE500' },
  '005380': { primary:'https://logo.clearbit.com/hyundai.com',          fallbacks:[],                                                                   initials:'HD', bg:'#002C5F' },
  '000270': { primary:'https://logo.clearbit.com/kia.com',              fallbacks:[],                                                                   initials:'KI', bg:'#05141F' },
  /* ── Crypto (cryptologos.cc) ── */
  'BTC':  { primary:'https://cryptologos.cc/logos/bitcoin-btc-logo.png',            fallbacks:['https://cryptologos.cc/logos/bitcoin-btc-logo.png'],     initials:'BT', bg:'#F7931A' },
  'ETH':  { primary:'https://cryptologos.cc/logos/ethereum-eth-logo.png',         fallbacks:['https://cryptologos.cc/logos/ethereum-eth-logo.png'],     initials:'ET', bg:'#627EEA' },
  'SOL':  { primary:'https://cryptologos.cc/logos/solana-sol-logo.png',          fallbacks:[],                                                          initials:'SO', bg:'#9945FF' },
  'BNB':  { primary:'https://cryptologos.cc/logos/bnb-bnb-logo.png',     fallbacks:[],                                                          initials:'BN', bg:'#F3BA2F' },
  'XRP':  { primary:'https://cryptologos.cc/logos/xrp-xrp-logo.png', fallbacks:[],                                                      initials:'XR', bg:'#346AA9' },
  'DOGE': { primary:'https://cryptologos.cc/logos/dogecoin-doge-logo.png',           fallbacks:[],                                                          initials:'DO', bg:'#C2A633' },
  'ADA':  { primary:'https://cryptologos.cc/logos/cardano-ada-logo.png',          fallbacks:[],                                                          initials:'AD', bg:'#0D1E2D' },
  'AVAX': { primary:'https://cryptologos.cc/logos/avalanche-avax-logo.png', fallbacks:[], initials:'AV', bg:'#E84142' },
  'LINK': { primary:'https://cryptologos.cc/logos/chainlink-link-logo.png', fallbacks:[],                                                        initials:'LI', bg:'#2A5ADA' },
  'DOT':  { primary:'https://cryptologos.cc/logos/polkadot-new-dot-logo.png',       fallbacks:[],                                                          initials:'DO', bg:'#E6007A' },
  'MATIC':{ primary:'https://cryptologos.cc/logos/polygon-matic-logo.png', fallbacks:[],                                                         initials:'MA', bg:'#8247E5' },
  'UNI':  { primary:'https://cryptologos.cc/logos/uniswap-uni-logo.png',    fallbacks:[],                                                          initials:'UN', bg:'#FF007A' },
  'ARB':  { primary:'https://cryptologos.cc/logos/arbitrum-arb-logo.png', fallbacks:[],                                              initials:'AR', bg:'#28A0F0' },
  'OP':   { primary:'https://cryptologos.cc/logos/optimism-ethereum-op-logo.png',       fallbacks:[],                                                          initials:'OP', bg:'#FF0420' },
  'SUI':  { primary:'https://cryptologos.cc/logos/sui-sui-logo.png',     fallbacks:[],                                                          initials:'SU', bg:'#4CA3FF' },
  'TON':  { primary:'https://cryptologos.cc/logos/toncoin-ton-logo.png',     fallbacks:[],                                                          initials:'TO', bg:'#0088CC' },
  'SHIB': { primary:'https://cryptologos.cc/logos/shiba-inu-shib-logo.png',          fallbacks:[],                                                          initials:'SH', bg:'#FFA409' },
  'PEPE': { primary:'https://cryptologos.cc/logos/pepe-pepe-logo.png',    fallbacks:[],                                                          initials:'PE', bg:'#3BA14C' },
  'APT':  { primary:'https://cryptologos.cc/logos/aptos-apt-logo.png',    fallbacks:[],                                                          initials:'AP', bg:'#00C7B2' },
  'INJ':  { primary:'https://cryptologos.cc/logos/injective-inj-logo.png', fallbacks:[],                                                        initials:'IJ', bg:'#00F2FE' },
  /* ── Indices / Macro ── */
  'SPX':  { primary:'',  fallbacks:[], initials:'SP', bg:'#6366F1' },
  'NDX':  { primary:'',  fallbacks:[], initials:'ND', bg:'#7C3AED' },
  'DJI':  { primary:'',  fallbacks:[], initials:'DJ', bg:'#1D4ED8' },
  'VIX':  { primary:'',  fallbacks:[], initials:'VX', bg:'#DC2626' },
  'DXY':  { primary:'',  fallbacks:[], initials:'DX', bg:'#10B981' },
  'XAUUSD':{ primary:'', fallbacks:[], initials:'AU', bg:'#D97706' },
  'USOIL': { primary:'', fallbacks:[], initials:'OI', bg:'#78350F' },
};

/* ── Logo component with multi-source fallback ── */

export function Logo({ id, size=36, clr, name, logoUrl }: {
  id: string; size?: number; clr?: string; name?: string; logoUrl?: string;
}) {
  const t   = (id || '').toUpperCase().trim();
  const def = LOGO_DB[t] || LOGO_DB[id] || null;
  const bg  = clr || (def as any)?.bg || getBgColor(t) || '#1A2D4A';

  // Smart initials
  const inits = (def as any)?.initials
    || (name && /[\uAC00-\uD7AF]/.test(name) ? name.slice(0, 2) : null)
    || t.replace(/[^A-Z0-9가-힣]/gi, '').slice(0, 2).toUpperCase()
    || '??';

  const r = Math.round(size * 0.5);
  const base: React.CSSProperties = {
    width: size, height: size, borderRadius: r, flexShrink: 0, overflow: 'hidden',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
  };

  const [srcIdx,    setSrcIdx]    = useState(0);
  const [loaded,    setLoaded]    = useState(false);
  const [allFailed, setAllFailed] = useState(false);

  useEffect(() => { setSrcIdx(0); setLoaded(false); setAllFailed(false); }, [id]);

  // Priority: logoUrl prop → LOGO_SOURCES[id] → LOGO_DB → resolveLogoUrl
  const fromSources: string[] = [];
  if ((LOGO_SOURCES as any)[t]) {
    const src = (LOGO_SOURCES as any)[t];
    if (typeof src === 'string') {
      fromSources.push(src);
    } else if (src?.primary) {
      fromSources.push(src.primary);
      if (src.fallbacks) fromSources.push(...src.fallbacks);
    }
  }

  const resolvedLogo = !def && fromSources.length === 0 ? resolveLogoUrl(id) : null;
  const sources = [
    ...(logoUrl ? [logoUrl] : []),
    ...fromSources,
    ...((def as any)?.primary && (def as any).primary !== '' ? [(def as any).primary] : []),
    ...((def as any)?.fallbacks || []),
    ...(resolvedLogo ? [resolvedLogo] : []),
  ].filter(Boolean) as string[];

  const handleError = () => {
    if (srcIdx + 1 < sources.length) { setSrcIdx(i => i + 1); setLoaded(false); }
    else setAllFailed(true);
  };

  // Initials fallback
  if (allFailed || sources.length === 0) {
    return (
      <div style={{ ...base, background: `linear-gradient(135deg,${bg}CC,${bg}66)`, border: `1px solid ${bg}30` }}>
        <span style={{ color: '#fff', fontWeight: 900, fontSize: Math.round(size * 0.34) }}>
          {inits}
        </span>
      </div>
    );
  }

  // Image with skeleton + initials while loading
  return (
    <div style={{ ...base, background: `${bg}18`, border: `1px solid ${bg}30` }}>
      {!loaded && (
        <div style={{ position: 'absolute', inset: 0, borderRadius: r, background: `${bg}18` }} className="skeleton" />
      )}
      {!loaded && (
        <span style={{ position: 'absolute', color: `${bg}80`, fontWeight: 900, fontSize: Math.round(size * 0.34) }}>
          {inits}
        </span>
      )}
      <img
        key={`${id}-${srcIdx}`}
        src={sources[srcIdx]}
        alt={id}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        style={{
          width: size * 0.74,
          height: size * 0.74,
          objectFit: 'contain',
          opacity: loaded ? 1 : 0,
          transition: 'opacity .15s',
        }}
        onLoad={() => setLoaded(true)}
        onError={handleError}
      />
    </div>
  );
}

// LOGO_SOURCES exported from @/lib/constants

export function WorldClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!now) return null;

  const numToTime = (v: number | string | undefined): string => {
    if (typeof v === 'number') {
      const h = Math.floor(v / 100);
      const m = v % 100;
      return String(h) + ':' + String(m).padStart(2, '0');
    }
    if (typeof v === 'string') return v;
    return '';
  };

  const numToMins = (v: number | string | undefined): number => {
    if (typeof v === 'number') return Math.floor(v / 100) * 60 + (v % 100);
    if (typeof v === 'string') {
      const parts = v.split(':').map(Number);
      return (parts[0] || 0) * 60 + (parts[1] || 0);
    }
    return 0;
  };

  const isOpen = (mk: typeof WORLD_MARKETS[0]): boolean => {
    if (mk.name === '코인') return true;
    if (!mk.tz) return false;
    try {
      const day = now.toLocaleString('en-US', { timeZone: mk.tz, weekday: 'short' });
      if (day === 'Sat' || day === 'Sun') return false;
      const tm = now.toLocaleTimeString('en-US', {
        timeZone: mk.tz, hour12: false, hour: '2-digit', minute: '2-digit',
      });
      const parts = tm.split(':').map(Number);
      const mins = (parts[0] || 0) * 60 + (parts[1] || 0);
      return mins >= numToMins(mk.open) && mins < numToMins(mk.close);
    } catch {
      return false;
    }
  };

  const getTime = (tz: string | undefined): string => {
    if (!tz) return '--:--';
    try {
      return now.toLocaleTimeString('ko-KR', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      });
    } catch {
      return '--:--';
    }
  };

  return (
    <div>
      <div style={{ color: T.txt, fontWeight: 800, fontSize: 13, marginBottom: 10 }}>
        🌐 세계 시장 시계
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {WORLD_MARKETS.map((mk) => {
          const open = isOpen(mk);
          const accent: string = (mk as any).color || T.acl;
          const bg      = open ? accent + '15' : T.alt;
          const bdClr   = open ? accent        : T.border;
          const txtClr  = open ? accent        : T.muted;
          const badgeBg = open ? accent + '25' : 'rgba(71,85,105,.3)';
          const timeStr = mk.name === '코인' ? '24/7' : getTime(mk.tz);

          return (
            <div
              key={mk.name}
              style={{ background: bg, border: '1px solid ' + bdClr, borderRadius: 12, padding: '10px 12px' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ color: T.txt, fontWeight: 700, fontSize: 11 }}>
                  {mk.flag} {mk.name}
                </span>
                <span style={{ background: badgeBg, color: txtClr, fontSize: 9, fontWeight: 700, borderRadius: 99, padding: '1px 6px' }}>
                  {open ? '개장' : '폐장'}
                </span>
              </div>
              <div style={{ color: txtClr, fontFamily: 'monospace', fontSize: 13, fontWeight: 800 }}>
                {timeStr}
              </div>
              <div style={{ color: T.muted, fontSize: 9, marginTop: 2 }}>
                {numToTime(mk.open)}–{numToTime(mk.close)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Heatmap ── */
/* ── GlobalSearch (전체 시장 검색) ── */
type SearchResultLocal = {
  symbol: string; name: string; nameKr?: string;
  exchange: string; asset_type: string;
  currency: string; provider: string;
  logo_url?: string; isWatchOnly?: boolean;
};



// ── ProviderStatusPanel — 실제 호출 헬스체크 (4단계 상태) ──
type ProviderHealth = {
  id: string; name: string; nameKr: string; type: string;
  status: 'ok' | 'limited' | 'error' | 'unconfigured';
  latencyMs: number | null; detail: string; sample?: string;
};

const STATUS_META: Record<string, { dot: string; label: string; color: string }> = {
  ok:           { dot: '🟢', label: '정상',   color: '#10B981' },
  limited:      { dot: '🟡', label: '제한',   color: '#F59E0B' },
  error:        { dot: '🔴', label: '오류',   color: '#EF4444' },
  unconfigured: { dot: '⚪', label: '미설정', color: '#94A3B8' },
};

function ProviderStatusPanel() {
  const [providers, setProviders] = React.useState<ProviderHealth[] | null>(null);
  const [summary, setSummary] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const [checkedAt, setCheckedAt] = React.useState<number | null>(null);

  const runCheck = React.useCallback(() => {
    setLoading(true);
    fetch('/api/providers/healthcheck')
      .then(r => r.json())
      .then(d => {
        setProviders(Array.isArray(d.providers) ? d.providers : null);
        setSummary(d.summary || null);
        setCheckedAt(d.checkedAt || Date.now());
      })
      .catch(() => setProviders(null))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { runCheck(); }, [runCheck]);

  if (loading && !providers) {
    return (
      <div style={{ padding: '14px 16px' }}>
        <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>데이터 제공사 확인 중…</div>
        {[0,1,2,3].map(i => (
          <div key={i} className="skeleton" style={{ height: 52, borderRadius: 8, marginBottom: 6 }}/>
        ))}
      </div>
    );
  }

  const list = providers || [];

  return (
    <div style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 6 }}>
        <span style={{ color: T.muted, fontSize: 11, fontWeight: 700 }}>데이터 제공사 상태</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {summary && (
            <span style={{ fontSize: 9, color: T.muted }}>
              🟢{summary.ok} 🟡{summary.limited} 🔴{summary.error} ⚪{summary.unconfigured}
            </span>
          )}
          <button onClick={runCheck} disabled={loading}
            style={{ background: T.alt, color: T.muted, border: `1px solid ${T.border}`, borderRadius: 6, padding: '4px 10px', minHeight: 28, fontSize: 9, fontWeight: 700, cursor: loading ? 'wait' : 'pointer' }}>
            {loading ? '확인 중…' : '실제 데이터 조회'}
          </button>
        </div>
      </div>

      <div className="mobile-1col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {list.map((p, i) => {
          const sm = STATUS_META[p.status] || STATUS_META.error;
          return (
            <div key={i} style={{
              background: T.alt, borderRadius: 8, padding: '9px 11px',
              borderLeft: `3px solid ${sm.color}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                <span style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{p.nameKr || p.name}</span>
                <span style={{ fontSize: 10 }}>{sm.dot}</span>
              </div>
              <div style={{ color: T.muted, fontSize: 9, marginTop: 1 }}>{p.type}</div>
              <div style={{ color: sm.color, fontSize: 9, marginTop: 3, fontWeight: 700 }}>
                {sm.label}
                {p.latencyMs != null && p.status === 'ok' && <span style={{ color: T.muted, fontWeight: 400 }}> · {p.latencyMs}ms</span>}
              </div>
              {p.sample && (
                <div style={{ color: T.txt, fontSize: 9, marginTop: 2, fontFamily: 'monospace' }}>{p.sample}</div>
              )}
              {p.status !== 'ok' && (
                <div style={{ color: T.muted, fontSize: 8, marginTop: 2, lineHeight: 1.4 }}>{p.detail}</div>
              )}
            </div>
          );
        })}
      </div>

      {checkedAt && (
        <div style={{ color: T.muted, fontSize: 9, marginTop: 8, textAlign: 'center' }}>
          마지막 확인: {new Date(checkedAt).toLocaleTimeString('ko-KR')}
        </div>
      )}
      <div style={{ color: T.muted, fontSize: 10, marginTop: 6, lineHeight: 1.5 }}>
        💡 Vercel 환경변수에 API 키 추가 시 실시간 데이터가 활성화됩니다.
        FMP 403은 보통 무료 플랜 제한입니다.
      </div>

      {/* 바이낸스 서버 도달성 진단 */}
      <BinanceReachPanel />
    </div>
  );
}

// 바이낸스 도달성 — 서버에서 각 도메인 닿는지 (451 지역차단 확인)
function BinanceReachPanel() {
  const [data, setData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);

  const run = () => {
    setLoading(true);
    fetch('/api/binance/reach')
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => setData({ error: '진단 실패' }))
      .finally(() => setLoading(false));
  };

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
      <button onClick={run} disabled={loading}
        style={{ width: '100%', padding: '9px', background: T.acg, border: `1px solid ${T.acl}40`, borderRadius: 8, color: T.acl, fontWeight: 700, fontSize: 11, cursor: loading ? 'wait' : 'pointer' }}>
        {loading ? '진단 중…' : '바이낸스 서버 도달성 진단'}
      </button>
      {data && !data.error && (
        <div style={{ marginTop: 8, background: T.alt, borderRadius: 8, padding: '10px 12px' }}>
          {(data.results || []).map((r: any, i: number) => {
            const c = r.status === 'ok' ? T.grn : r.status === 'geo_blocked' ? T.red : T.ylw;
            const icon = r.status === 'ok' ? '✅' : r.status === 'geo_blocked' ? '🚫' : '⚠️';
            return (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: i < data.results.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                <span style={{ color: T.txt, fontSize: 10 }}>{icon} {r.desc}</span>
                <span style={{ color: c, fontSize: 9, fontWeight: 700 }}>{r.detail} · {r.ms}ms</span>
              </div>
            );
          })}
          <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 6, fontSize: 10, lineHeight: 1.4,
            background: data.testnetOk ? T.grn + '12' : T.red + '12',
            color: data.testnetOk ? T.grn : T.red }}>
            {data.verdict}
          </div>
        </div>
      )}
      {data?.error && (
        <div style={{ marginTop: 8, color: T.red, fontSize: 10 }}>진단 실패: {data.error}</div>
      )}
    </div>
  );
}

export function GlobalSearch({onSelect,currency}:{onSelect:(id:string,nameKr:string,clr:string)=>void;currency:string}) {
  const [query,setQuery]=useState('');
  const [results,setResults]=useState<SearchResultLocal[]>([]);
  const [loading,setLoading]=useState(false);
  const [source,setSource]=useState('');
  const [open,setOpen]=useState(false);
  const debounceRef=useRef<ReturnType<typeof setTimeout>|null>(null);

  const TYPE_CLR:Record<string,string>={
    coin:'#F7931A',stock:'#3B82F6',krstock:'#EF4444',jpstock:'#DC2626',
    cnstock:'#EF4444',eustock:'#8B5CF6',etf:'#10B981',index:'#8B5CF6',
    commodity:'#D97706',forex:'#0891B2',
  };

  const TYPE_LBL:Record<string,string>={
    coin:'코인',stock:'미국주식',krstock:'국내주식',jpstock:'일본주식',
    cnstock:'중국주식',eustock:'유럽주식',etf:'ETF',index:'지수',
    commodity:'원자재',forex:'환율',
  };

  const PROVIDER_LBL:Record<string,string>={
    binance:'Binance',polygon:'Polygon.io',
    finnhub:'Finnhub',kis:'KIS OpenAPI',naver_finance:'Naver Finance',
    exchangerate:'ExchangeRate',commodity_api:'Commodity API',mock:'Mock (오프라인)',
  };

  // Mock search DB inline (subset for offline)
  const ALIASES: Record<string, string> = {
    '비트코인':'BTC','이더리움':'ETH','솔라나':'SOL','리플':'XRP','도지코인':'DOGE',
    '바이낸스코인':'BNB','에이다':'ADA','아발란체':'AVAX','톤코인':'TON','체인링크':'LINK',
    '폴카닷':'DOT','폴리곤':'MATIC','유니스왑':'UNI','아비트럼':'ARB','옵티미즘':'OP',
    '수이':'SUI','앱토스':'APT','인젝티브':'INJ','페페':'PEPE','시바이누':'SHIB',
    '엔비디아':'NVDA','애플':'AAPL','마이크로소프트':'MSFT','테슬라':'TSLA',
    '구글':'GOOGL','알파벳':'GOOGL','아마존':'AMZN','메타':'META','AMD':'AMD',
    '인텔':'INTC','퀄컴':'QCOM','TSMC':'TSM','브로드컴':'AVGO','ARM':'ARM',
    '슈퍼마이크로':'SMCI','팔란티어':'PLTR','플래닛랩스':'PL','JP모건':'JPM',
    '골드만삭스':'GS','뱅크오브아메리카':'BAC','모건스탠리':'MS','비자':'V',
    '마스터카드':'MA','페이팔':'PYPL','코인베이스':'COIN','로빈후드':'HOOD',
    '소파이':'SOFI','블록':'SQ','엑슨모빌':'XOM','셰브론':'CVX',
    '일라이릴리':'LLY','유나이티드헬스':'UNH','존슨앤존슨':'JNJ','화이자':'PFE',
    '모더나':'MRNA','월마트':'WMT','코스트코':'COST','맥도날드':'MCD',
    '스타벅스':'SBUX','코카콜라':'KO','펩시':'PEP','나이키':'NKE',
    '넷플릭스':'NFLX','디즈니':'DIS','보잉':'BA','록히드마틴':'LMT',
    '레이시온':'RTX','노스롭그루만':'NOC','리비안':'RIVN','니오':'NIO',
    '게임스탑':'GME','마이크로스트레티지':'MSTR',
    '삼성전자':'005930','SK하이닉스':'000660','NAVER':'035420','카카오':'035720',
    '현대차':'005380','기아':'000270',
    '금':'XAUUSD','은':'XAGUSD','원유':'USOIL','유가':'USOIL','천연가스':'NATGAS',
    '달러':'DXY','달러인덱스':'DXY','유로':'EURUSD','엔':'USDJPY','원화':'USDKRW',
    'S&P500':'SPX','나스닥':'NDX','다우존스':'DJI','공포지수':'VIX',
    'bitcoin':'BTC','btc':'BTC','ethereum':'ETH','eth':'ETH','solana':'SOL','sol':'SOL',
    'ripple':'XRP','xrp':'XRP','dogecoin':'DOGE','doge':'DOGE','bnb':'BNB',
    'cardano':'ADA','ada':'ADA','avalanche':'AVAX','avax':'AVAX',
    'toncoin':'TON','ton':'TON','chainlink':'LINK','link':'LINK',
    'polkadot':'DOT','dot':'DOT','polygon':'MATIC','matic':'MATIC',
    'uniswap':'UNI','uni':'UNI','arbitrum':'ARB','arb':'ARB',
    'optimism':'OP','op':'OP','sui':'SUI','aptos':'APT','apt':'APT',
    'injective':'INJ','inj':'INJ','pepe':'PEPE','shib':'SHIB',
    'nvidia':'NVDA','nvda':'NVDA','apple':'AAPL','aapl':'AAPL',
    'microsoft':'MSFT','msft':'MSFT','tesla':'TSLA','tsla':'TSLA',
    'google':'GOOGL','alphabet':'GOOGL','googl':'GOOGL','goog':'GOOG',
    'amazon':'AMZN','amzn':'AMZN','meta':'META','facebook':'META',
    'amd':'AMD','intel':'INTC','intc':'INTC','qualcomm':'QCOM','qcom':'QCOM',
    'tsmc':'TSM','tsm':'TSM','broadcom':'AVGO','avgo':'AVGO',
    'arm':'ARM','supermicro':'SMCI','smci':'SMCI',
    'palantir':'PLTR','pltr':'PLTR','planet labs':'PL','planetlabs':'PL','pl':'PL',
    'jpmorgan':'JPM','jp morgan':'JPM','jpm':'JPM',
    'goldman sachs':'GS','gs':'GS','bank of america':'BAC','bac':'BAC',
    'morgan stanley':'MS','ms':'MS','visa':'V','mastercard':'MA',
    'paypal':'PYPL','pypl':'PYPL','coinbase':'COIN','coin':'COIN',
    'robinhood':'HOOD','hood':'HOOD','sofi':'SOFI','square':'SQ','block':'SQ',
    'exxon':'XOM','xom':'XOM','chevron':'CVX','cvx':'CVX',
    'eli lilly':'LLY','lly':'LLY','unitedhealthcare':'UNH','unh':'UNH',
    'johnson':'JNJ','jnj':'JNJ','pfizer':'PFE','pfe':'PFE','moderna':'MRNA','mrna':'MRNA',
    'walmart':'WMT','wmt':'WMT','costco':'COST','cost':'COST',
    'mcdonalds':'MCD','mcd':'MCD','starbucks':'SBUX','sbux':'SBUX',
    'coca cola':'KO','cocacola':'KO','ko':'KO','pepsi':'PEP','pep':'PEP',
    'nike':'NKE','nke':'NKE','netflix':'NFLX','nflx':'NFLX',
    'disney':'DIS','dis':'DIS','boeing':'BA','ba':'BA',
    'lockheed':'LMT','lmt':'LMT','raytheon':'RTX','rtx':'RTX',
    'northrop':'NOC','noc':'NOC','rivian':'RIVN','rivn':'RIVN',
    'nio':'NIO','gamestop':'GME','gme':'GME',
    'microstrategy':'MSTR','mstr':'MSTR',
    'samsung':'005930','sk hynix':'000660','hynix':'000660',
    'naver':'035420','kakao':'035720','hyundai':'005380','kia':'000270',
    'gold':'XAUUSD','xau':'XAUUSD','silver':'XAGUSD','xag':'XAGUSD',
    'oil':'USOIL','crude oil':'USOIL','wti':'USOIL','brent':'UKOIL',
    'natural gas':'NATGAS','natgas':'NATGAS','copper':'COPPER',
    'dxy':'DXY','dollar index':'DXY','euro':'EURUSD','eur':'EURUSD',
    'yen':'USDJPY','jpy':'USDJPY','pound':'GBPUSD','gbp':'GBPUSD',
    'sp500':'SPX','s&p':'SPX','s&p500':'SPX',
    'nasdaq':'NDX','nasdaq100':'NDX','dow':'DJI','dow jones':'DJI',
    'vix':'VIX','fear greed':'VIX',
    'spy':'SPY','qqq':'QQQ','iwm':'IWM','dia':'DIA',
    'tqqq':'TQQQ','sqqq':'SQQQ','soxl':'SOXL','soxs':'SOXS','arkk':'ARKK',
    'gld':'GLD','tlt':'TLT',
  };

  const resolveAlias=(q:string):string=>{
    const lq=q.toLowerCase().trim();
    if(ALIASES[lq]) return ALIASES[lq];
    const krMatch=Object.entries(ALIASES).find(([k])=>k.includes(q)&&/[\uAC00-\uD7AF]/.test(k));
    if(krMatch) return krMatch[1];
    const enMatch=Object.entries(ALIASES).find(([k])=>lq.length>=3&&k.startsWith(lq)&&!/[\uAC00-\uD7AF]/.test(k));
    if(enMatch) return enMatch[1];
    return q.toUpperCase().trim();
  };

  const MOCK_DB: SearchResultLocal[] = [
    {symbol:'BTC', name:'Bitcoin',          nameKr:'비트코인',  exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'ETH', name:'Ethereum',         nameKr:'이더리움',  exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'SOL', name:'Solana',           nameKr:'솔라나',    exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'XRP', name:'XRP',              nameKr:'리플',      exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'BNB', name:'BNB',              nameKr:'바이낸스코인',exchange:'BINANCE',asset_type:'coin',   currency:'USDT',provider:'binance'},
    {symbol:'DOGE',name:'Dogecoin',         nameKr:'도지코인',  exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'ADA', name:'Cardano',          nameKr:'에이다',    exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'AVAX',name:'Avalanche',        nameKr:'아발란체',  exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'TON', name:'Toncoin',          nameKr:'톤코인',    exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'LINK',name:'Chainlink',        nameKr:'체인링크',  exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'DOT', name:'Polkadot',         nameKr:'폴카닷',    exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'MATIC',name:'Polygon',         nameKr:'폴리곤',    exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'UNI', name:'Uniswap',          nameKr:'유니스왑',  exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'ARB', name:'Arbitrum',         nameKr:'아비트럼',  exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'OP',  name:'Optimism',         nameKr:'옵티미즘',  exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'SUI', name:'Sui',              nameKr:'수이',      exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'APT', name:'Aptos',            nameKr:'앱토스',    exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'INJ', name:'Injective',        nameKr:'인젝티브',  exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'PEPE',name:'Pepe',             nameKr:'페페',      exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'SHIB',name:'Shiba Inu',        nameKr:'시바이누',  exchange:'BINANCE', asset_type:'coin',    currency:'USDT',provider:'binance'},
    {symbol:'NVDA',name:'NVIDIA',     nameKr:'엔비디아',  exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon',logo_url:'https://logo.clearbit.com/nvidia.com'},
    {symbol:'AAPL',name:'Apple',       nameKr:'애플',      exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon',logo_url:'https://logo.clearbit.com/apple.com'},
    {symbol:'MSFT',name:'Microsoft',  nameKr:'마이크로소프트',exchange:'NASDAQ',asset_type:'stock', currency:'USD', provider:'polygon',logo_url:'https://logo.clearbit.com/microsoft.com'},
    {symbol:'TSLA',name:'Tesla',       nameKr:'테슬라',    exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon',logo_url:'https://logo.clearbit.com/tesla.com'},
    {symbol:'GOOGL',name:'Google',   nameKr:'구글',      exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon',logo_url:'https://logo.clearbit.com/google.com'},
    {symbol:'AMZN',name:'Amazon',       nameKr:'아마존',    exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon',logo_url:'https://logo.clearbit.com/amazon.com'},
    {symbol:'META',name:'Meta',   nameKr:'메타',      exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon',logo_url:'https://logo.clearbit.com/meta.com'},
    {symbol:'AMD', name:'AMD',nameKr:'AMD',  exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon',logo_url:'https://logo.clearbit.com/amd.com'},
    {symbol:'INTC',name:'Intel',      nameKr:'인텔',      exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'AVGO',name:'Broadcom',    nameKr:'브로드컴',  exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'QCOM',name:'Qualcomm',         nameKr:'퀄컴',      exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'TSM', name:'TSMC',nameKr:'TSMC',   exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'ARM', name:'ARM',     nameKr:'ARM',       exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'SMCI',name:'Supermicro',nameKr:'슈퍼마이크로',exchange:'NASDAQ',asset_type:'stock',currency:'USD', provider:'polygon'},
    {symbol:'PLTR',name:'Palantir',nameKr:'팔란티어',exchange:'NYSE',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'PL',  name:'Planet Labs', nameKr:'플래닛랩스', exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'JPM', name:'JP모건',   nameKr:'JP모건',    exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon',logo_url:'https://logo.clearbit.com/jpmorganchase.com'},
    {symbol:'GS',  name:'Goldman Sachs',    nameKr:'골드만삭스', exchange:'NYSE',   asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'BAC', name:'Bank of America',  nameKr:'뱅크오브아메리카',exchange:'NYSE',asset_type:'stock', currency:'USD', provider:'polygon'},
    {symbol:'V',   name:'Visa',        nameKr:'비자',      exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon',logo_url:'https://logo.clearbit.com/visa.com'},
    {symbol:'MA',  name:'Mastercard',       nameKr:'마스터카드', exchange:'NYSE',   asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'PYPL',name:'PayPal',  nameKr:'페이팔',    exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'COIN',name:'Coinbase',  nameKr:'코인베이스', exchange:'NASDAQ', asset_type:'stock',   currency:'USD', provider:'polygon',logo_url:'https://logo.clearbit.com/coinbase.com'},
    {symbol:'HOOD',name:'Robinhood',nameKr:'로빈후드',  exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'SOFI',name:'SoFi',nameKr:'소파이',    exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'SQ',  name:'Block',       nameKr:'블록',      exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'LLY', name:'Eli Lilly',        nameKr:'일라이릴리', exchange:'NYSE',   asset_type:'stock',   currency:'USD', provider:'polygon',logo_url:'https://logo.clearbit.com/lilly.com'},
    {symbol:'UNH', name:'UnitedHealth',nameKr:'유나이티드헬스',exchange:'NYSE',asset_type:'stock',  currency:'USD', provider:'polygon'},
    {symbol:'JNJ', name:'J&J',nameKr:'존슨앤존슨', exchange:'NYSE',   asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'PFE', name:'Pfizer',      nameKr:'화이자',    exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'MRNA',name:'Moderna',     nameKr:'모더나',    exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'WMT', name:'Walmart',     nameKr:'월마트',    exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'COST',name:'Costco', nameKr:'코스트코',  exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'MCD', name:'맥도날드', nameKr:'맥도날드',  exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'SBUX',name:'Starbucks',  nameKr:'스타벅스',  exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'KO',  name:'Coca-Cola',    nameKr:'코카콜라',  exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'PEP', name:'PepsiCo',     nameKr:'펩시코',    exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'NKE', name:'Nike',        nameKr:'나이키',    exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'NFLX',name:'Netflix',     nameKr:'넷플릭스',  exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'DIS', name:'Disney',  nameKr:'디즈니',    exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'BA',  name:'Boeing',       nameKr:'보잉',      exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'LMT', name:'Lockheed Martin',  nameKr:'록히드마틴', exchange:'NYSE',   asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'RTX', name:'RTX',  nameKr:'레이시온',  exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'RIVN',name:'Rivian',nameKr:'리비안',    exchange:'NASDAQ',  asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'NIO', name:'NIO Inc.',         nameKr:'니오',      exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'GME', name:'GameStop',   nameKr:'게임스탑',  exchange:'NYSE',    asset_type:'stock',   currency:'USD', provider:'polygon'},
    {symbol:'MSTR',name:'MicroStrategy',nameKr:'마이크로스트레티지',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon'},
    {symbol:'SPY', name:'S&P500 ETF', nameKr:'S&P500 ETF',exchange:'AMEX',   asset_type:'etf',     currency:'USD', provider:'polygon'},
    {symbol:'QQQ', name:'나스닥100 ETF',nameKr:'나스닥100 ETF',exchange:'NASDAQ',asset_type:'etf',   currency:'USD', provider:'polygon'},
    {symbol:'IWM', name:'러셀2000 ETF',nameKr:'러셀2000 ETF',exchange:'AMEX',asset_type:'etf',   currency:'USD', provider:'polygon'},
    {symbol:'DIA', name:'다우존스 ETF',nameKr:'다우존스 ETF',exchange:'AMEX', asset_type:'etf',    currency:'USD', provider:'polygon'},
    {symbol:'TQQQ',name:'나스닥3배 ETF',nameKr:'나스닥3배',exchange:'NASDAQ',asset_type:'etf', currency:'USD', provider:'polygon'},
    {symbol:'SQQQ',name:'ProShares UltraPro Short QQQ',nameKr:'나스닥3배인버스',exchange:'NASDAQ',asset_type:'etf',currency:'USD',provider:'polygon'},
    {symbol:'SOXL',name:'반도체3배',nameKr:'반도체3배',exchange:'AMEX',asset_type:'etf',currency:'USD',provider:'polygon'},
    {symbol:'SOXS',name:'Direxion Daily Semiconductors -3x',nameKr:'반도체3배인버스',exchange:'AMEX',asset_type:'etf',currency:'USD',provider:'polygon'},
    {symbol:'ARKK',name:'ARK이노베이션',nameKr:'ARK이노베이션',exchange:'AMEX',asset_type:'etf',    currency:'USD', provider:'polygon'},
    {symbol:'GLD', name:'금 ETF', nameKr:'금 ETF',    exchange:'AMEX',    asset_type:'etf',     currency:'USD', provider:'polygon'},
    {symbol:'TLT', name:'iShares 20+ Year Treasury Bond',nameKr:'20년국채 ETF',exchange:'NASDAQ',asset_type:'etf',currency:'USD',provider:'polygon'},
    {symbol:'005930',name:'삼성전자',nameKr:'삼성전자',exchange:'KRX',   asset_type:'krstock', currency:'KRW', provider:'kis'},
    {symbol:'000660',name:'SK하이닉스',       nameKr:'SK하이닉스', exchange:'KRX',    asset_type:'krstock', currency:'KRW', provider:'kis'},
    {symbol:'035420',name:'NAVER',    nameKr:'NAVER',     exchange:'KRX',     asset_type:'krstock', currency:'KRW', provider:'kis'},
    {symbol:'035720',name:'카카오',    nameKr:'카카오',    exchange:'KRX',     asset_type:'krstock', currency:'KRW', provider:'kis'},
    {symbol:'005380',name:'현대차', nameKr:'현대차',     exchange:'KRX',     asset_type:'krstock', currency:'KRW', provider:'kis'},
    {symbol:'000270',name:'기아',      nameKr:'기아',      exchange:'KRX',     asset_type:'krstock', currency:'KRW', provider:'kis'},
    {symbol:'XAUUSD',name:'Gold',           nameKr:'금',        exchange:'FOREX',   asset_type:'commodity',currency:'USD',provider:'commodity_api'},
    {symbol:'XAGUSD',name:'Silver',         nameKr:'은',        exchange:'FOREX',   asset_type:'commodity',currency:'USD',provider:'commodity_api'},
    {symbol:'USOIL', name:'WTI 원유',  nameKr:'WTI 원유',  exchange:'NYMEX',   asset_type:'commodity',currency:'USD',provider:'commodity_api'},
    {symbol:'EURUSD',name:'유로/달러', nameKr:'유로/달러', exchange:'FOREX',   asset_type:'forex',   currency:'USD', provider:'exchangerate'},
    {symbol:'USDJPY',name:'달러/엔',  nameKr:'달러/엔',   exchange:'FOREX',   asset_type:'forex',   currency:'JPY', provider:'exchangerate'},
    {symbol:'USDKRW',name:'달러/원화',  nameKr:'달러/원화', exchange:'FOREX',   asset_type:'forex',   currency:'KRW', provider:'exchangerate'},
    {symbol:'GBPUSD',name:'파운드/달러',nameKr:'파운드/달러',exchange:'FOREX', asset_type:'forex',  currency:'USD', provider:'exchangerate'},
    {symbol:'DXY',   name:'달러인덱스',nameKr:'달러인덱스', exchange:'TVC',    asset_type:'index',   currency:'USD', provider:'mock'},
    {symbol:'SPX',   name:'S&P 500',  nameKr:'S&P 500',  exchange:'SP',      asset_type:'index',   currency:'USD', provider:'mock'},
    {symbol:'NDX',   name:'나스닥100',     nameKr:'나스닥100', exchange:'NASDAQ',  asset_type:'index',   currency:'USD', provider:'mock'},
    {symbol:'DJI',   name:'다우존스',      nameKr:'다우존스',  exchange:'DJ',      asset_type:'index',   currency:'USD', provider:'mock'},
    {symbol:'VIX',   name:'공포지수',nameKr:'공포지수',  exchange:'TVC',     asset_type:'index',   currency:'USD', provider:'mock'},
  ];

  const searchLocal=(q:string)=>{
    if(!q.trim()) return [];
    const lq=q.toLowerCase().trim();
    // 1. Try alias resolution first
    const resolved=resolveAlias(q);
    const resolvedLow=resolved.toLowerCase();
    // 2. Full search including aliases
    const scored=MOCK_DB.map(a=>{
      let score=0;
      const sym=a.symbol.toLowerCase();
      const name=a.name.toLowerCase();
      const kr=(a.nameKr||'').toLowerCase();
      if(sym===resolvedLow||sym===lq) score=100;
      else if(sym.startsWith(resolvedLow)||sym.startsWith(lq)) score=80;
      else if(sym.includes(lq)) score=60;
      else if(name.startsWith(lq)) score=50;
      else if(name.includes(lq)) score=40;
      else if(kr.includes(q)) score=45;
      else if(a.nameKr?.includes(q)) score=45;
      return {...a,_score:score};
    }).filter(a=>a._score>0)
      .sort((a,b)=>(b as any)._score-(a as any)._score)
      .slice(0,20);
    return scored;
  };

  const doSearch=useCallback(async(q:string)=>{
    if(!q.trim()){setResults([]);setSource('');return;}
    setLoading(true);
    // 1. Instant local results (no latency)
    const local=searchLocal(q);
    setResults(local);setSource('local');
    // 2. Server-side search (/api/search) — uses Polygon for stocks + Binance for crypto
    try{
      const r=await fetch(`/api/search?q=${encodeURIComponent(q)}`,{signal:AbortSignal.timeout(5000)});
      if(r.ok){
        const data=await r.json();
        const apiResults=(data.results||[]).map((a:any):SearchResultLocal=>({
          symbol:   a.sym,
          name:     a.labelEn||a.sym,
          nameKr:   a.label||a.labelEn||a.sym,
          exchange: a.exchange||a.cat||'',
          asset_type: a.cat==='crypto'?'coin':a.cat==='krstock'?'krstock':a.cat==='etf'?'etf':a.cat==='commodity'?'commodity':a.cat==='forex'?'forex':'stock',
          currency: a.cat==='crypto'?'USDT':'USD',
          provider: a.source||'local',
          logo_url: undefined,
        }));
        if(apiResults.length>0){
          const seen=new Set(local.map(r=>r.symbol));
          const merged=[...local,...apiResults.filter(m=>!seen.has(m.symbol))].slice(0,15);
          setResults(merged);
          setSource(data.source==='polygon+local'?'polygon':data.source||'api');
        }
      }
    }catch{}
    setLoading(false);
  },[]);

  useEffect(()=>{
    if(debounceRef.current)clearTimeout(debounceRef.current);
    debounceRef.current=setTimeout(()=>doSearch(query),300);
    return()=>{if(debounceRef.current)clearTimeout(debounceRef.current);};
  },[query,doSearch]);

  const getLogoUrl=(r:SearchResultLocal)=>{
    const CRYPTO_LOGOS:Record<string,string>={
      BTC:'https://cryptologos.cc/logos/bitcoin-btc-logo.png',
      ETH:'https://cryptologos.cc/logos/ethereum-eth-logo.png',
      SOL:'https://cryptologos.cc/logos/solana-sol-logo.png',
      BNB:'https://cryptologos.cc/logos/bnb-bnb-logo.png',
      XRP:'https://cryptologos.cc/logos/xrp-xrp-logo.png',
      DOGE:'https://cryptologos.cc/logos/dogecoin-doge-logo.png',
      ADA:'https://cryptologos.cc/logos/cardano-ada-logo.png',
      AVAX:'https://cryptologos.cc/logos/avalanche-avax-logo.png',
      TON:'https://cryptologos.cc/logos/toncoin-ton-logo.png',
      LINK:'https://cryptologos.cc/logos/chainlink-link-logo.png',
      DOT:'https://cryptologos.cc/logos/polkadot-new-dot-logo.png',
      MATIC:'https://cryptologos.cc/logos/polygon-matic-logo.png',
      UNI:'https://cryptologos.cc/logos/uniswap-uni-logo.png',
      ARB:'https://cryptologos.cc/logos/arbitrum-arb-logo.png',
      SUI:'https://cryptologos.cc/logos/sui-sui-logo.png',
      SHIB:'https://cryptologos.cc/logos/shiba-inu-shib-logo.png',
      PEPE:'https://cryptologos.cc/logos/pepe-pepe-logo.png',
      APT:'https://cryptologos.cc/logos/aptos-apt-logo.png',
    };
    const CLEARBIT_MAP:Record<string,string>={
      AAPL:'apple.com',MSFT:'microsoft.com',NVDA:'nvidia.com',TSLA:'tesla.com',
      AMZN:'amazon.com',GOOGL:'google.com',META:'meta.com',NFLX:'netflix.com',
      AMD:'amd.com',PLTR:'palantir.com',COIN:'coinbase.com',JPM:'jpmorganchase.com',
      V:'visa.com',MA:'mastercard.com',QQQ:'invesco.com',SPY:'ssga.com',ARKK:'ark-invest.com',
    };
    if(r.asset_type==='coin'&&CRYPTO_LOGOS[r.symbol]) return CRYPTO_LOGOS[r.symbol];
    if(CLEARBIT_MAP[r.symbol]) return `https://logo.clearbit.com/${CLEARBIT_MAP[r.symbol]}`;
    if(r.asset_type==='krstock'||r.exchange==='KRX') return `https://logo.clearbit.com/samsung.com`;
    return null;
  };

  if(!open) return (
    <button onClick={()=>setOpen(true)} style={{width:'100%',display:'flex',alignItems:'center',gap:10,background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:'12px 16px',cursor:'pointer',marginBottom:12}}>
      <span style={{fontSize:16}}>🔍</span>
      <span style={{color:T.muted,fontSize:13,flex:1,textAlign:'left'}}>전체 시장 검색 (미국·한국·코인·ETF…)</span>
      <span style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}30`,borderRadius:8,padding:'2px 8px',fontSize:10,fontWeight:700}}>전체</span>
    </button>
  );

  return (
    <div style={{marginBottom:12}}>
      <div style={{background:T.card,border:`1px solid ${T.acl}40`,borderRadius:14,overflow:'hidden'}}>
        {/* Search input */}
        <div style={{display:'flex',alignItems:'center',gap:10,padding:'12px 14px',borderBottom:`1px solid ${T.border}`}}>
          <span style={{fontSize:16}}>{loading?'⏳':'🔍'}</span>
          <input
            autoFocus value={query} onChange={e=>setQuery(e.target.value)}
            placeholder="티커, 회사명, 한글명으로 검색 (AAPL, 삼성, Bitcoin…)"
            style={{flex:1,background:'transparent',border:'none',outline:'none',color:T.txt,fontSize:13}}
          />
          {query&&<button onClick={()=>{setQuery('');setResults([]);}} style={{background:'transparent',border:'none',color:T.muted,cursor:'pointer',fontSize:16}}>✕</button>}
          <button onClick={()=>{setOpen(false);setQuery('');setResults([]);}} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,color:T.muted,padding:'4px 8px',cursor:'pointer',fontSize:11}}>닫기</button>
        </div>

        {/* Provider info */}
        {source&&(
          <div style={{padding:'6px 14px',background:T.alt,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',gap:6}}>
            <Dot c={source==='binance'?T.ylw:source==='polygon'?T.acl:T.muted}/>
            <span style={{color:T.muted,fontSize:10}}>데이터 출처: {source==='binance'?'Binance API (실시간)':source==='polygon'?'Polygon.io':source==='mock'?'로컬 데이터 (오프라인)':source}</span>
            <span style={{marginLeft:'auto',color:T.muted,fontSize:10}}>{results.length}개 결과</span>
          </div>
        )}

        {/* Results */}
        {results.length>0&&(
          <div style={{maxHeight:340,overflowY:'auto'}}>
            {results.map((r,i)=>{
              const logoUrl=getLogoUrl(r);
              const typeClr=TYPE_CLR[r.asset_type]||'#94A3B8';
              return (
                <div key={r.symbol+i} onClick={()=>{
                  // Cache the selected asset
                  try{
                    const cache=JSON.parse(localStorage.getItem('tg_asset_cache_v2')||'{}');
                    cache[r.symbol]={symbol:r.symbol,name:r.name,nameKr:r.nameKr,exchange:r.exchange,asset_type:r.asset_type,currency:r.currency,logo_url:logoUrl||undefined,updated_at:new Date().toISOString(),source:r.provider};
                    localStorage.setItem('tg_asset_cache_v2',JSON.stringify(cache));
                  }catch{}
                  onSelect(r.symbol, r.nameKr||r.name, typeClr);
                  setOpen(false);setQuery('');setResults([]);
                }} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'11px 14px',borderBottom:i<results.length-1?`1px solid ${T.border}`:'none',cursor:'pointer'}}>
                  <div style={{display:'flex',alignItems:'center',gap:10}}>
                    {/* Logo */}
                    {logoUrl?(
                      <div style={{width:32,height:32,borderRadius:8,overflow:'hidden',background:typeClr+'20',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                        <img src={logoUrl} alt={r.symbol} width={24} height={24} style={{objectFit:'contain'}} onError={(e)=>{(e.target as HTMLImageElement).style.display='none';}}/>
                      </div>
                    ):(
                      <div style={{width:32,height:32,borderRadius:8,background:`linear-gradient(135deg,${typeClr}CC,${typeClr}66)`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                        <span style={{color:'#fff',fontWeight:900,fontSize:10,fontFamily:'monospace'}}>{r.symbol.slice(0,2)}</span>
                      </div>
                    )}
                    <div>
                      <div style={{display:'flex',gap:5,alignItems:'center'}}>
                        <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{r.nameKr||r.name}</span>
                        <Bdg c={typeClr} ch={TYPE_LBL[r.asset_type]||r.asset_type} sm/>
                        {r.isWatchOnly&&<Bdg c={T.muted} ch="관찰만" sm/>}
                      </div>
                      <div style={{color:T.muted,fontSize:10,marginTop:1,fontFamily:'monospace'}}>{r.symbol} · {r.exchange}</div>
                    </div>
                  </div>
                  <div style={{textAlign:'right',flexShrink:0}}>
                    <div style={{color:T.muted,fontSize:9}}>{PROVIDER_LBL[r.provider]||r.provider}</div>
                    <div style={{color:T.muted,fontSize:10}}>{r.currency}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {query&&!loading&&results.length===0&&(
          <div style={{padding:'24px 0',textAlign:'center'}}>
            <div style={{fontSize:28,marginBottom:6}}>🔍</div>
            <div style={{color:T.muted,fontSize:12}}>'{query}' 검색 결과 없음</div>
            <div style={{color:T.muted,fontSize:10,marginTop:4}}>API 키 설정 시 더 많은 종목 검색 가능</div>
          </div>
        )}

        {/* No query — show dynamic provider status from server */}
        {!query&&<ProviderStatusPanel/>}
      </div>
    </div>
  );
}

export function Heatmap({ prices }: { prices: Asset[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4 }}>
      {prices.slice(0, 24).map((a) => {
        const intensity = clamp(Math.abs(a.c) / 5, 0, 1);
        const isUp = a.c >= 0;
        const bg     = isUp
          ? 'rgba(16,185,129,' + (0.1 + intensity * 0.5) + ')'
          : 'rgba(239,68,68,'  + (0.1 + intensity * 0.5) + ')';
        const bdClr  = isUp ? 'rgba(16,185,129,.3)' : 'rgba(239,68,68,.3)';
        const txtClr = isUp ? T.grn : T.red;

        return (
          <div
            key={a.id}
            style={{ background: bg, border: '1px solid ' + bdClr, borderRadius: 10, padding: '8px 4px', textAlign: 'center' }}
          >
            <Logo id={a.id} size={20} clr={txtClr} />
            <div style={{ color: T.txt, fontSize: 9, fontWeight: 700, marginTop: 3 }}>{a.id}</div>
            <div style={{ color: txtClr, fontSize: 8, fontWeight: 800, fontFamily: 'monospace' }}>
              {a.c >= 0 ? '+' : ''}{a.c.toFixed(2)}%
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── TradingChart ── */
export const TOOL_GROUPS=[
  {name:'추세',icon:'↗',tools:[{id:'trendline',label:'추세선',icon:'↗'},{id:'hline',label:'수평선',icon:'—'},{id:'vline',label:'수직선',icon:'|'}]},
  {name:'피보',icon:'𝜑',tools:[{id:'fib_ret',label:'피보나치 되돌림',icon:'𝜑'},{id:'ruler',label:'자 (퍼센트)',icon:'📏'}]},
  {name:'도형',icon:'□',tools:[{id:'rect',label:'사각형',icon:'□'},{id:'circle',label:'원',icon:'○'}]},
  {name:'주석',icon:'✏',tools:[{id:'text',label:'텍스트',icon:'T'},{id:'brush',label:'브러시',icon:'✏'},{id:'eraser',label:'지우개',icon:'⬜'}]},
];
export const PALETTE=['#3B82F6','#10B981','#EF4444','#F59E0B','#7C3AED','#EC4899','#FFFFFF','#94A3B8'];


export function TradingChart({ asset }: { asset?: Asset }) {
  const [ct, setCt]           = useState('line');
  const [tf, setTf]           = useState('1H');
  const [tool, setTool]       = useState('cursor');
  const [openGrp, setOpenGrp] = useState<string | null>(null);
  const [drawColor, setDrawColor]     = useState('#3B82F6');
  const [showPalette, setShowPalette] = useState(false);
  const [shapes, setShapes]   = useState<any[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [curPts, setCurPts]   = useState<{ x: number; y: number }[]>([]);
  const [textPos, setTextPos] = useState<{ x: number; y: number } | null>(null);
  const [textVal, setTextVal] = useState('');
  const [historyStack, setHistoryStack] = useState<any[][]>([[]]);
  const [histIdx, setHistIdx] = useState(0);
  const [chartMode, setChartMode] = useState<'custom' | 'tv'>('custom');
  const [indicators, setIndicators] = useState<Record<string, boolean>>({
    EMA: false, RSI: false, MACD: false, BB: false, VOL: false, VWAP: false,
  });

  const svgRef = useRef<SVGSVGElement>(null);
  const TFS    = ['1m', '5m', '15m', '1H', '4H', '1D', '1W'];
  const CTYPES = [
    { id: 'line', label: '라인' },
    { id: 'area', label: '영역' },
    { id: 'candle', label: '캔들' },
  ];

  const toggleIndicator = (k: string) => setIndicators(p => ({ ...p, [k]: !p[k] }));

  const getSVGPt = (e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const pushH = (s: any[]) => {
    const h = historyStack.slice(0, histIdx + 1);
    setHistoryStack([...h, s]);
    setHistIdx(h.length);
  };

  const onMD = (e: React.MouseEvent) => {
    if (tool === 'cursor') return;
    const pt = getSVGPt(e);
    if (tool === 'eraser') {
      if (shapes.length > 0) {
        const n = shapes.slice(0, -1);
        setShapes(n);
        pushH(n);
      }
      return;
    }
    if (tool === 'text') { setTextPos(pt); return; }
    if (tool === 'hline' || tool === 'vline') {
      const s = { id: Date.now(), tool, pts: [pt, pt], color: drawColor };
      const n = [...shapes, s];
      setShapes(n);
      pushH(n);
      return;
    }
    setDrawing(true);
    setCurPts([pt]);
  };

  const onMM = (e: React.MouseEvent) => {
    if (!drawing) return;
    const pt = getSVGPt(e);
    if (tool === 'brush') setCurPts(p => [...p, pt]);
    else setCurPts(p => [p[0], pt]);
  };

  const onMU = () => {
    if (!drawing || curPts.length < 1) { setDrawing(false); return; }
    const s = { id: Date.now(), tool, pts: curPts, color: drawColor };
    const n = [...shapes, s];
    setShapes(n);
    pushH(n);
    setCurPts([]);
    setDrawing(false);
  };

  const addText = () => {
    if (!textPos || !textVal.trim()) { setTextPos(null); return; }
    const s = { id: Date.now(), tool: 'text', pts: [textPos], color: drawColor, text: textVal };
    const n = [...shapes, s];
    setShapes(n);
    pushH(n);
    setTextPos(null);
    setTextVal('');
  };

  const renderShape = (s: any, preview?: boolean) => {
    const [p1, p2] = s.pts;
    const key = s.id || 'pr';
    const op  = preview ? 0.65 : 1;

    if (s.tool === 'trendline') {
      if (!p1 || !p2) return null;
      return (
        <line key={key} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
          stroke={s.color} strokeWidth="1.8" strokeLinecap="round" opacity={op} />
      );
    }
    if (s.tool === 'hline') {
      return (
        <line key={key} x1="0" y1={p1.y} x2="100%" y2={p1.y}
          stroke={s.color} strokeWidth="1.5" strokeDasharray="6 3" opacity={op} />
      );
    }
    if (s.tool === 'vline') {
      return (
        <line key={key} x1={p1.x} y1="0" x2={p1.x} y2="100%"
          stroke={s.color} strokeWidth="1.5" strokeDasharray="6 3" opacity={op} />
      );
    }
    if (s.tool === 'rect') {
      if (!p1 || !p2) return null;
      return (
        <rect key={key}
          x={Math.min(p1.x, p2.x)} y={Math.min(p1.y, p2.y)}
          width={Math.abs(p2.x - p1.x)} height={Math.abs(p2.y - p1.y)}
          fill={s.color + '18'} stroke={s.color} strokeWidth="1.5" opacity={op} />
      );
    }
    if (s.tool === 'circle') {
      if (!p1 || !p2) return null;
      return (
        <ellipse key={key}
          cx={(p1.x + p2.x) / 2} cy={(p1.y + p2.y) / 2}
          rx={Math.abs(p2.x - p1.x) / 2} ry={Math.abs(p2.y - p1.y) / 2}
          fill={s.color + '18'} stroke={s.color} strokeWidth="1.5" opacity={op} />
      );
    }
    if (s.tool === 'fib_ret') {
      if (!p1 || !p2) return null;
      const fibs = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      return (
        <g key={key} opacity={op}>
          {fibs.map((lv) => {
            const y = p1.y + (p2.y - p1.y) * lv;
            return (
              <g key={lv}>
                <line x1={p1.x} y1={y} x2={p2.x} y2={y}
                  stroke={s.color} strokeWidth="1" strokeDasharray="4 2" opacity="0.7" />
                <text x={Math.max(p1.x, p2.x) + 3} y={y + 4}
                  fill={s.color} fontSize="9" fontFamily="monospace">
                  {(lv * 100).toFixed(1) + '%'}
                </text>
              </g>
            );
          })}
        </g>
      );
    }
    if (s.tool === 'ruler') {
      if (!p1 || !p2) return null;
      const pct = p1.y > 0 ? ((p1.y - p2.y) / p1.y * 100).toFixed(2) : '0';
      return (
        <g key={key} opacity={op}>
          <rect
            x={Math.min(p1.x, p2.x)} y={Math.min(p1.y, p2.y)}
            width={Math.abs(p2.x - p1.x)} height={Math.abs(p2.y - p1.y)}
            fill={s.color + '15'} stroke={s.color} strokeWidth="1" />
          <text
            x={(p1.x + p2.x) / 2} y={(p1.y + p2.y) / 2}
            textAnchor="middle" fill={s.color} fontSize="11" fontWeight="700" fontFamily="monospace">
            {pct + '%'}
          </text>
        </g>
      );
    }
    if (s.tool === 'brush') {
      if (s.pts.length < 2) return null;
      const pd = s.pts
        .map((pt: any, i: number) => (i === 0 ? 'M' : 'L') + pt.x.toFixed(1) + ',' + pt.y.toFixed(1))
        .join(' ');
      return (
        <path key={key} d={pd} stroke={s.color} strokeWidth="2"
          fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={op} />
      );
    }
    if (s.tool === 'text') {
      return (
        <text key={key} x={p1.x} y={p1.y} fill={s.color} fontSize="13" fontWeight="600">
          {s.text}
        </text>
      );
    }
    return null;
  };

  const cursorStyle =
    tool === 'cursor' ? 'default'    :
    tool === 'eraser' ? 'cell'       :
    tool === 'text'   ? 'text'       : 'crosshair';

  const tvInterval =
    tf === '1m'  ? '1'   :
    tf === '5m'  ? '5'   :
    tf === '15m' ? '15'  :
    tf === '1H'  ? '60'  :
    tf === '4H'  ? '240' :
    tf === '1D'  ? 'D'   : 'W';

  const tvChartType =
    ct === 'candle' ? '1' :
    ct === 'area'   ? '8' : '0';

  const tvSymbol = (asset?.sym || 'BTCUSDT')
    .replace('/', '').replace(' ', '').replace('-USDT', 'USDT');

  return (
    <div style={{ background: T.bg, borderRadius: 14, border: '1px solid ' + T.border, overflow: 'hidden' }}>

      {/* Mode + chart-type toolbar */}
      <div style={{ borderBottom: '1px solid ' + T.border, padding: '7px 10px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 3 }}>
          {(['custom', 'tv'] as const).map((mode) => {
            const active = chartMode === mode;
            return (
              <button key={mode} onClick={() => setChartMode(mode)} style={{
                background: active ? T.acg : 'transparent',
                color:      active ? T.acl : T.muted,
                border:     '1px solid ' + (active ? T.acl : T.border),
                borderRadius: 7, padding: '3px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
              }}>
                {mode === 'custom' ? '커스텀' : 'TradingView'}
              </button>
            );
          })}
        </div>

        {chartMode === 'custom' && (
          <>
            <div style={{ width: 1, height: 14, background: T.border }} />
            <div style={{ display: 'flex', gap: 3 }}>
              {CTYPES.map((c) => {
                const active = ct === c.id;
                return (
                  <button key={c.id} onClick={() => setCt(c.id)} style={{
                    background: active ? T.acg : 'transparent',
                    color:      active ? T.acl : T.muted,
                    border:     '1px solid ' + (active ? T.acl : T.border),
                    borderRadius: 7, padding: '3px 7px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                  }}>
                    {c.label}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 3, overflowX: 'auto' }}>
              {TFS.map((t) => {
                const active = tf === t;
                return (
                  <button key={t} onClick={() => setTf(t)} style={{
                    background: active ? T.acg : 'transparent',
                    color:      active ? T.acl : T.muted,
                    border:     '1px solid ' + (active ? T.acl : 'transparent'),
                    borderRadius: 6, padding: '2px 6px', fontSize: 10,
                    fontWeight: 700, cursor: 'pointer', flexShrink: 0,
                  }}>
                    {t}
                  </button>
                );
              })}
            </div>
            <div style={{ width: 1, height: 14, background: T.border }} />
            <div style={{ display: 'flex', gap: 2, overflowX: 'auto' }}>
              {Object.entries(indicators).map(([k, on]) => (
                <button key={k} onClick={() => toggleIndicator(k)} style={{
                  background: on ? T.ylw + '20' : 'transparent',
                  color:      on ? T.ylw : T.muted,
                  border:     '1px solid ' + (on ? T.ylw : T.border),
                  borderRadius: 5, padding: '1px 5px', fontSize: 9,
                  fontWeight: 700, cursor: 'pointer', flexShrink: 0,
                }}>
                  {k}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Chart body */}
      {chartMode === 'tv' ? (
        <div style={{
          padding: 20, textAlign: 'center', minHeight: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 8,
        }}>
          <div style={{ fontSize: 32 }}>📊</div>
          <div style={{ color: T.txt, fontWeight: 700, fontSize: 14 }}>TradingView 위젯</div>
          <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.6 }}>
            실제 프로젝트에서는 TradingView 위젯으로 교체하세요.
          </div>
          <a
            href={'https://www.tradingview.com/chart/?symbol=' + (asset?.sym || 'BTCUSDT')}
            target="_blank" rel="noopener noreferrer"
            style={{
              background: T.acg, color: T.acl,
              border: '1px solid ' + T.acl + '40',
              borderRadius: 10, padding: '8px 16px',
              fontSize: 12, fontWeight: 700, textDecoration: 'none', marginTop: 8,
            }}
          >
            TradingView에서 보기 →
          </a>
        </div>
      ) : (
        <>
          {/* Drawing toolbar */}
          <div style={{
            borderBottom: '1px solid ' + T.border,
            padding: '5px 8px', display: 'flex', gap: 3,
            alignItems: 'center', flexWrap: 'wrap',
          }}>
            <button
              onClick={() => { setTool('cursor'); setOpenGrp(null); }}
              style={{
                width: 28, height: 28,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: tool === 'cursor' ? T.acg : 'transparent',
                color:      tool === 'cursor' ? T.acl : T.muted,
                border:     '1px solid ' + (tool === 'cursor' ? T.acl : 'transparent'),
                borderRadius: 7, cursor: 'pointer', fontSize: 14,
              }}
            >
              ↖
            </button>
            <div style={{ width: 1, height: 18, background: T.border }} />

            {TOOL_GROUPS.map((grp) => {
              const grpOpen = openGrp === grp.name;
              return (
                <div key={grp.name} style={{ position: 'relative' }}>
                  <button
                    onClick={() => setOpenGrp(grpOpen ? null : grp.name)}
                    style={{
                      width: 28, height: 28,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: grpOpen ? T.acg : 'transparent',
                      color:      grpOpen ? T.acl : T.muted,
                      border:     '1px solid ' + (grpOpen ? T.acl : 'transparent'),
                      borderRadius: 7, cursor: 'pointer', fontSize: 13,
                    }}
                  >
                    {grp.icon}
                  </button>
                  {grpOpen && (
                    <div style={{
                      position: 'absolute', top: 32, left: 0, zIndex: 50,
                      background: T.surf, border: '1px solid ' + T.border,
                      borderRadius: 12, padding: 6, minWidth: 170,
                      boxShadow: '0 8px 24px rgba(0,0,0,.6)',
                    }}>
                      {grp.tools.map((t2) => {
                        const toolOn = tool === t2.id;
                        return (
                          <button
                            key={t2.id}
                            onClick={() => { setTool(t2.id); setOpenGrp(null); }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              width: '100%',
                              background: toolOn ? T.acg : 'transparent',
                              color:      toolOn ? T.acl : T.txt,
                              border: 'none', borderRadius: 8,
                              padding: '7px 10px', cursor: 'pointer', textAlign: 'left',
                            }}
                          >
                            <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>{t2.icon}</span>
                            <span style={{ fontSize: 12, fontWeight: 600 }}>{t2.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            <div style={{ width: 1, height: 18, background: T.border }} />
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setShowPalette(v => !v)}
                style={{
                  width: 22, height: 22, borderRadius: 6,
                  background: drawColor,
                  border: '2px solid rgba(255,255,255,.3)', cursor: 'pointer',
                }}
              />
              {showPalette && (
                <div style={{
                  position: 'absolute', top: 28, left: 0, zIndex: 50,
                  background: T.surf, border: '1px solid ' + T.border,
                  borderRadius: 10, padding: 8,
                  display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4,
                  boxShadow: '0 8px 24px rgba(0,0,0,.5)',
                }}>
                  {PALETTE.map((col) => (
                    <button
                      key={col}
                      onClick={() => { setDrawColor(col); setShowPalette(false); }}
                      style={{
                        width: 22, height: 22, borderRadius: 5,
                        background: col,
                        border: '2px solid ' + (drawColor === col ? '#fff' : 'transparent'),
                        cursor: 'pointer',
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
              <button
                onClick={() => {
                  if (histIdx > 0) {
                    const ni = histIdx - 1;
                    setShapes(historyStack[ni] || []);
                    setHistIdx(ni);
                  }
                }}
                disabled={histIdx <= 0}
                style={{
                  width: 26, height: 26,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'transparent',
                  border: '1px solid ' + T.border,
                  borderRadius: 6,
                  color: histIdx <= 0 ? T.muted : T.sub,
                  cursor: 'pointer', fontSize: 13,
                }}
              >
                ↺
              </button>
              {shapes.length > 0 && (
                <button
                  onClick={() => { setShapes([]); pushH([]); }}
                  style={{
                    padding: '0 8px', height: 26,
                    background: T.red + '15', color: T.red,
                    border: '1px solid ' + T.red + '30',
                    borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  삭제
                </button>
              )}
            </div>
          </div>

          {/* SVG canvas */}
          <div style={{ position: 'relative', height: 220 }}>
            <InlineTVChart
              symbol={tvSymbol}
              chartType={tvChartType}
              interval={tvInterval}
            />
            {tool !== 'cursor' && (
              <svg
                ref={svgRef}
                style={{
                  position: 'absolute', inset: 0,
                  width: '100%', height: '100%',
                  cursor: cursorStyle, zIndex: 10,
                }}
                onMouseDown={onMD}
                onMouseMove={onMM}
                onMouseUp={onMU}
                onMouseLeave={onMU}
              >
                {shapes.map(s => renderShape(s, false))}
                {drawing && curPts.length >= 1 && renderShape({ id: 'pr', tool, pts: curPts, color: drawColor }, true)}
              </svg>
            )}
            {textPos && (
              <div style={{
                position: 'absolute', zIndex: 20,
                left: textPos.x + 6, top: textPos.y - 20,
                display: 'flex', gap: 5,
              }}>
                <input
                  autoFocus
                  value={textVal}
                  onChange={e => setTextVal(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') addText();
                    if (e.key === 'Escape') { setTextPos(null); setTextVal(''); }
                  }}
                  style={{
                    background: T.surf, border: '1px solid ' + T.acl,
                    borderRadius: 8, padding: '5px 10px',
                    color: T.txt, fontSize: 12, outline: 'none', width: 140,
                  }}
                  placeholder="텍스트 입력…"
                />
                <button
                  onClick={addText}
                  style={{
                    background: T.acc, color: '#fff',
                    border: 'none', borderRadius: 8,
                    padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  확인
                </button>
              </div>
            )}
          </div>

          {/* Status bar */}
          <div style={{ padding: '6px 10px', borderTop: '1px solid ' + T.border, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Dot c={T.grn} />
            <span style={{ color: T.muted, fontSize: 10 }}>
              {tool === 'cursor' ? '도구를 선택하여 드로잉' : '클릭하거나 드래그하세요'}
            </span>
            {shapes.length > 0 && (
              <span style={{ marginLeft: 'auto', color: T.muted, fontSize: 10 }}>
                {shapes.length}개
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ── HomePage ── */

export function DonutChart({ slices, size = 110 }: {
  slices: { pct: number; color: string; label: string }[];
  size?: number;
}) {
  const r = 38, cx = 55, cy = 55, circ = 2 * Math.PI * r;
  const safeSlices = (slices || []).map(s => ({
    ...s,
    pct: (isNaN(s.pct) || s.pct == null) ? 0 : s.pct,
  }));
  const total = safeSlices.reduce((a, s) => a + s.pct, 0) || 100;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox="0 0 110 110">
      {safeSlices.map((s, i) => {
        const dash  = (s.pct / total) * circ;
        const gap   = circ - dash;
        const el = (
          <circle
            key={i}
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke={s.color}
            strokeWidth="14"
            strokeDasharray={String(dash.toFixed(4)) + ' ' + String(gap.toFixed(4))}
            strokeDashoffset={-offset}
            style={{ transform: 'rotate(-90deg)', transformOrigin: '55px 55px' }}
          />
        );
        offset += dash;
        return el;
      })}
      <circle cx={cx} cy={cy} r={28} fill={T.bg} />
    </svg>
  );
}

/* ── MiniBar ── */
export function MiniBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ height: 6, background: '#1A2D4A', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: Math.min(100, Math.max(0, pct)) + '%', background: color, borderRadius: 3, transition: 'width .4s' }} />
    </div>
  );
}

/* ── PortfolioPage (full dual system) ── */
/* ─── Error Boundary ─── */

export function getLeverageRec(asset: Asset, riskProfile: 'conservative' | 'balanced' | 'aggressive' = 'balanced') {
  const vol  = Math.abs(asset.c);
  const base = riskProfile === 'conservative' ? 1 : riskProfile === 'balanced' ? 5 : 10;
  if (vol > 6) return { rec: Math.max(1, Math.floor(base * 0.4)), level: '위험', color: '#EF4444', score: 25 };
  if (vol > 3) return { rec: Math.max(2, Math.floor(base * 0.7)), level: '주의', color: '#F59E0B', score: 55 };
  return { rec: base, level: '안전', color: '#10B981', score: 85 };
}

export function LiquidationCalc({ entryPrice, leverage, side, currency }: {
  entryPrice: number; leverage: number; side: string; currency: string;
}) {
  const liqPct   = side === '매수' ? -(100 / leverage) * 0.9 : (100 / leverage) * 0.9;
  const liqPrice = entryPrice * (1 + liqPct / 100);
  const dist     = Math.abs(liqPct);
  const danger   = dist < 10;

  return (
    <div style={{ background: T.alt, borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ color: T.muted, fontSize: 11 }}>청산가</span>
        <span style={{ color: danger ? T.red : T.ylw, fontWeight: 800, fontSize: 13 }}>
          {liqPrice.toLocaleString()} {currency}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ color: T.muted, fontSize: 11 }}>청산까지</span>
        <span style={{ color: danger ? T.red : T.grn, fontWeight: 700, fontSize: 12 }}>
          {dist.toFixed(1)}%
        </span>
      </div>
      <div style={{ height: 6, background: '#1A2D4A', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: Math.min(100, dist * 3) + '%', background: danger ? T.red : T.ylw, borderRadius: 3 }} />
      </div>
    </div>
  );
}

export function PositionSizer({ balance, currency }: { balance: number; currency: string }) {
  const [riskPct, setRiskPct]   = useState(2);
  const [slPct, setSlPct]       = useState(5);
  const [mode, setMode]         = useState<'conservative' | 'balanced' | 'aggressive'>('balanced');
  const modeMulti = mode === 'conservative' ? 0.5 : mode === 'balanced' ? 1 : 2;
  const riskAmt   = balance * (riskPct / 100) * modeMulti;
  const posSize   = slPct > 0 ? riskAmt / (slPct / 100) : 0;
  const MODES     = ['conservative', 'balanced', 'aggressive'] as const;
  const modeColor: Record<string, string> = { conservative: T.grn, balanced: T.ylw, aggressive: T.red };

  return (
    <div style={{ background: T.alt, borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ color: T.txt, fontWeight: 700, fontSize: 12, marginBottom: 8 }}>포지션 사이징</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {MODES.map((m) => (
          <button key={m} onClick={() => setMode(m)} style={{
            flex: 1, padding: '4px', fontSize: 9, fontWeight: 700, borderRadius: 6, cursor: 'pointer',
            background: mode === m ? modeColor[m] + '20' : 'transparent',
            color:      mode === m ? modeColor[m] : T.muted,
            border:     '1px solid ' + (mode === m ? modeColor[m] : T.border),
          }}>
            {m === 'conservative' ? '보수' : m === 'balanced' ? '균형' : '공격'}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ color: T.muted, fontSize: 11 }}>리스크 %</span>
        <input type="number" value={riskPct} min={0.1} max={10} step={0.1}
          onChange={e => setRiskPct(Number(e.target.value))}
          style={{ width: 60, background: T.surf, border: '1px solid ' + T.border, borderRadius: 6, color: T.txt, fontSize: 11, padding: '2px 6px', textAlign: 'right' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ color: T.muted, fontSize: 11 }}>손절 %</span>
        <input type="number" value={slPct} min={0.1} max={50} step={0.5}
          onChange={e => setSlPct(Number(e.target.value))}
          style={{ width: 60, background: T.surf, border: '1px solid ' + T.border, borderRadius: 6, color: T.txt, fontSize: 11, padding: '2px 6px', textAlign: 'right' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ color: T.muted, fontSize: 11 }}>최대 포지션</span>
        <span style={{ color: T.acl, fontWeight: 800, fontSize: 13 }}>
          {posSize.toLocaleString(undefined, { maximumFractionDigits: 0 })} {currency}
        </span>
      </div>
    </div>
  );
}

export function RiskDashboard({ positions, prices }: { positions: any[]; prices: Asset[] }) {
  const [stressMode, setStressMode] = useState('-20%');
  const stressPcts: Record<string, number> = { '-10%': -10, '-20%': -20, '-40%': -40, '크래시': -60 };

  // 포지션의 투자금액 계산 (invested 없으면 entryPrice×qty로 역산)
  const investedOf = (p: any): number => {
    if (typeof p.invested === 'number' && isFinite(p.invested)) return p.invested;
    const ep = Number(p.entryPrice) || 0;
    const q = Number(p.qty) || 0;
    const v = ep * q;
    return isFinite(v) ? v : 0;
  };
  const isShort = (p: any) => p.type === 'short' || p.side === 'short';

  const stressedPnl = positions.reduce((s, p) => {
    const priceDrop = (stressPcts[stressMode] ?? 0) / 100;
    const inv = investedOf(p);
    const pnl = inv * priceDrop * (isShort(p) ? -1 : 1);
    return s + (isFinite(pnl) ? pnl : 0);
  }, 0);
  const totalInvested = positions.reduce((s, p) => s + investedOf(p), 0);
  const safePnl = isFinite(stressedPnl) ? stressedPnl : 0;
  const hasData = positions.length > 0 && totalInvested > 0;

  return (
    <div style={{ background: T.alt, borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ color: T.txt, fontWeight: 700, fontSize: 12, marginBottom: 8 }}>스트레스 테스트</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {Object.keys(stressPcts).map(k => (
          <button key={k} onClick={() => setStressMode(k)} style={{
            flex: 1, padding: '4px 2px', fontSize: 9, fontWeight: 700, borderRadius: 6, cursor: 'pointer',
            background: stressMode === k ? T.red + '20' : 'transparent',
            color:      stressMode === k ? T.red : T.muted,
            border:     '1px solid ' + (stressMode === k ? T.red : T.border),
          }}>
            {k}
          </button>
        ))}
      </div>
      {hasData ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: T.muted, fontSize: 11 }}>예상 손실</span>
            <span style={{ color: T.red, fontWeight: 800, fontSize: 13 }}>
              {Math.round(safePnl).toLocaleString('ko-KR')}원
            </span>
          </div>
          <div style={{ color: T.muted, fontSize: 10, marginTop: 4, textAlign: 'right' }}>
            ({((safePnl / totalInvested) * 100).toFixed(1)}% of portfolio)
          </div>
        </>
      ) : (
        <div style={{ color: T.muted, fontSize: 11, textAlign: 'center', padding: '12px 0' }}>
          보유 포지션이 없습니다<br/>
          <span style={{ fontSize: 9 }}>매수하면 스트레스 테스트가 표시됩니다</span>
        </div>
      )}
    </div>
  );
}

export type ChartLayoutMode = 'default' | 'minimal' | 'pro';

export function InlineTVChart({ symbol, chartType = '1', interval = '60', mode = 'default', studies }: {
  symbol: string; chartType?: string; interval?: string;
  mode?: ChartLayoutMode;
  studies?: string[];   // ['RSI','MACD'] 등 (pro 모드 보조지표)
}) {
  // Use central resolver (idempotent — safe to pass already-prefixed symbols)
  const tvSymbol = toTradingViewSymbol(symbol);

  if (!symbol) {
    return (
      <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8, color:'#64748B' }}>
        <span style={{ fontSize:32 }}>📊</span>
        <span style={{ fontSize:12 }}>종목을 선택하세요</span>
      </div>
    );
  }

  // 모드별 URL 파라미터
  // minimal: 툴바/범례 숨김 — 차트 자체에 집중
  // pro: 보조지표 추가 + 모든 UI 보임
  // default: 기본 (툴바 + 범례 보임)
  const hideTopToolbar = mode === 'minimal' ? '1' : '0';
  const hideLegend     = mode === 'minimal' ? '1' : '0';
  const studiesParam = mode === 'pro' && studies && studies.length > 0
    ? `&studies=${encodeURIComponent(JSON.stringify(studies))}`
    : '&studies=[]';

  const src = `https://s.tradingview.com/widgetembed/?frameElementId=tv_embed&symbol=${encodeURIComponent(tvSymbol)}&interval=${interval}&theme=dark&style=${chartType}&locale=ko&hide_top_toolbar=${hideTopToolbar}&hide_legend=${hideLegend}&save_image=0&toolbarbg=060B14${studiesParam}&show_popup_button=0`;

  return (
    <iframe
      src={src}
      style={{ width:'100%', height:'100%', border:'none', display:'block', borderRadius:8 }}
      allow="clipboard-write"
      title={`${symbol} chart`}
    />
  );
}

// ─────────────────────────────────────────────────────────────
// ChartContainer — 4단계 높이 + 풀스크린 + localStorage 저장
// children 슬롯에 InlineTVChart 등을 넣어 사용.
// 어떤 페이지에서든 차트 영역을 감싸 사용자 조절 가능하게 만듦.
// ─────────────────────────────────────────────────────────────
export type ChartHeightLevel = 'compact' | 'normal' | 'large' | 'full';
const CHART_HEIGHT_PX_MAP: Record<Exclude<ChartHeightLevel, 'full'>, number> = {
  compact: 320,
  normal:  480,
  large:   680,
};
const CHART_HEIGHT_LABEL_MAP: Record<ChartHeightLevel, string> = {
  compact: 'S', normal: 'M', large: 'L', full: 'XL',
};

export function ChartContainer({
  storageKey = 'tg_chart_height_v1',
  defaultLevel = 'normal',
  children,
  title = '차트',
  showLayoutModes = true,        // 레이아웃 모드 토글 표시 여부
  showResizeHandle = true,       // 하단 드래그 손잡이
}: {
  storageKey?: string;
  defaultLevel?: ChartHeightLevel;
  children: React.ReactNode;
  title?: string;
  showLayoutModes?: boolean;
  showResizeHandle?: boolean;
}) {
  const [level, setLevel]   = useState<ChartHeightLevel>(defaultLevel);
  const [layoutMode, setLayoutMode] = useState<ChartLayoutMode>('default');
  const [fullscreen, setFullscreen] = useState(false);
  const [customHeight, setCustomHeight] = useState<number | null>(null);  // 드래그 리사이즈 값
  const [isLandscape, setIsLandscape] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  // ── 저장값 복원 ──────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved && ['compact','normal','large','full'].includes(saved)) {
        setLevel(saved as ChartHeightLevel);
      }
      const savedMode = window.localStorage.getItem(`${storageKey}_mode`);
      if (savedMode && ['default','minimal','pro'].includes(savedMode)) {
        setLayoutMode(savedMode as ChartLayoutMode);
      }
      const savedH = window.localStorage.getItem(`${storageKey}_h`);
      const hn = savedH ? parseInt(savedH, 10) : NaN;
      if (Number.isFinite(hn) && hn >= 200 && hn <= 1200) setCustomHeight(hn);
    } catch {}
  }, [storageKey]);

  const changeLevel = (next: ChartHeightLevel) => {
    setLevel(next);
    setCustomHeight(null);   // 단계 클릭 시 드래그 값 리셋
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(storageKey, next);
        window.localStorage.removeItem(`${storageKey}_h`);
      }
    } catch {}
  };

  const changeMode = (next: ChartLayoutMode) => {
    setLayoutMode(next);
    try { if (typeof window !== 'undefined') window.localStorage.setItem(`${storageKey}_mode`, next); } catch {}
  };

  // ── ESC 키 + body 스크롤 잠금 ─────────────────────────────
  useEffect(() => {
    if (!fullscreen) return;
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [fullscreen]);

  // ── 가로모드 감지 (풀스크린 안에서 더 넓게) ─────────────
  useEffect(() => {
    if (!fullscreen || typeof window === 'undefined') return;
    const mq = window.matchMedia('(orientation: landscape)');
    setIsLandscape(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsLandscape(e.matches);
    try { mq.addEventListener('change', onChange); } catch { mq.addListener(onChange); }
    return () => {
      try { mq.removeEventListener('change', onChange); } catch { mq.removeListener(onChange); }
    };
  }, [fullscreen]);

  // ── 드래그 리사이즈 (mouse + touch) ─────────────────────
  const onResizeStart = useCallback((startY: number, startH: number) => {
    setIsResizing(true);
    const onMove = (clientY: number) => {
      const newH = Math.max(200, Math.min(1200, startH + (clientY - startY)));
      setCustomHeight(newH);
    };
    const onMouseMove = (e: MouseEvent) => onMove(e.clientY);
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches[0]) onMove(e.touches[0].clientY);
    };
    const onEnd = () => {
      setIsResizing(false);
      try {
        if (typeof window !== 'undefined') {
          const h = (window as any).__tgLastDragHeight;
          if (Number.isFinite(h)) window.localStorage.setItem(`${storageKey}_h`, String(h));
        }
      } catch {}
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onEnd);
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    document.body.style.userSelect = 'none';
  }, [storageKey]);

  // 드래그 중 마지막 높이값을 ref-like global에 저장 (saveAt end)
  useEffect(() => {
    if (customHeight != null) (window as any).__tgLastDragHeight = customHeight;
  }, [customHeight]);

  // ── 컨테이너 높이 계산 ───────────────────────────────────
  const containerHeight = customHeight != null
    ? `${customHeight}px`
    : level === 'full' ? '85vh'
    : `${CHART_HEIGHT_PX_MAP[level]}px`;

  // ── 자식에 layoutMode 주입 (cloneElement) ────────────────
  // InlineTVChart 또는 mode prop을 받는 컴포넌트가 자동으로 모드 반영
  const enhancedChildren = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<any>, { mode: layoutMode })
    : children;

  return (
    <>
      {/* 컨트롤 바 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        marginBottom: 6,
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: 10, padding: '6px 8px',
      }}>
        {/* 높이 단계 */}
        <div style={{ display: 'flex', gap: 3 }}>
          {(['compact','normal','large','full'] as const).map(lv => {
            const active = customHeight == null && level === lv;
            return (
              <button key={lv} type="button" onClick={() => changeLevel(lv)}
                aria-label={`높이 ${CHART_HEIGHT_LABEL_MAP[lv]}`}
                title={lv === 'full' ? '풀 (85vh)'
                  : lv === 'large' ? '큰 차트 (680px)'
                  : lv === 'normal' ? '기본 (480px)'
                  : '작은 차트 (320px)'}
                style={{
                  minWidth: 32, minHeight: 32, padding: '4px 8px',
                  background: active ? '#1E3A5F' : 'transparent',
                  color: active ? '#60A5FA' : '#94A3B8',
                  border: `1px solid ${active ? '#60A5FA' : '#1A2D4A'}`,
                  borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: 'pointer',
                  touchAction: 'manipulation',
                }}>
                {CHART_HEIGHT_LABEL_MAP[lv]}
              </button>
            );
          })}
        </div>

        {/* 레이아웃 모드 */}
        {showLayoutModes && (
          <div style={{ display: 'flex', gap: 3, marginLeft: 4 }}>
            {([
              { id: 'default' as const, label: '기본' },
              { id: 'minimal' as const, label: '미니' },
              { id: 'pro'     as const, label: '프로' },
            ]).map(m => {
              const active = layoutMode === m.id;
              return (
                <button key={m.id} type="button" onClick={() => changeMode(m.id)}
                  aria-label={`레이아웃 ${m.label}`}
                  title={m.id === 'minimal' ? '툴바 숨김' : m.id === 'pro' ? '보조지표' : '기본'}
                  style={{
                    minWidth: 38, minHeight: 32, padding: '4px 8px',
                    background: active ? '#7C3AED22' : 'transparent',
                    color: active ? '#A78BFA' : '#94A3B8',
                    border: `1px solid ${active ? '#7C3AED' : '#1A2D4A'}`,
                    borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer',
                    touchAction: 'manipulation',
                  }}>
                  {m.label}
                </button>
              );
            })}
          </div>
        )}

        {/* 풀스크린 */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button type="button" onClick={() => setFullscreen(true)}
            aria-label="전체화면"
            title="전체화면 모드"
            style={{
              minWidth: 38, minHeight: 32, padding: '4px 10px',
              background: '#1E3A5F', color: '#60A5FA',
              border: `1px solid #60A5FA40`, borderRadius: 6,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              fontSize: 11, fontWeight: 700,
              touchAction: 'manipulation',
            }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>
            </svg>
            <span>풀</span>
          </button>
        </div>
      </div>

      {/* 차트 본문 */}
      <div style={{
        height: containerHeight,
        borderRadius: 12, overflow: 'hidden',
        border: `1px solid ${T.border}`,
        marginBottom: showResizeHandle ? 0 : 12,
        background: T.card,
        transition: isResizing ? 'none' : 'height 200ms',
      }}>
        {enhancedChildren}
      </div>

      {/* 드래그 리사이즈 핸들 (풀스크린 아닐 때만) */}
      {showResizeHandle && (
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startH = customHeight ?? (level === 'full' ? Math.round(window.innerHeight * 0.85) : CHART_HEIGHT_PX_MAP[level]);
            onResizeStart(startY, startH);
          }}
          onTouchStart={(e) => {
            const startY = e.touches[0]?.clientY ?? 0;
            const startH = customHeight ?? (level === 'full' ? Math.round(window.innerHeight * 0.85) : CHART_HEIGHT_PX_MAP[level]);
            onResizeStart(startY, startH);
          }}
          aria-label="차트 높이 드래그"
          role="separator"
          aria-orientation="horizontal"
          style={{
            height: 10,
            marginBottom: 12,
            cursor: 'ns-resize',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: isResizing ? '#7C3AED22' : 'transparent',
            borderRadius: 4,
            touchAction: 'none',
          }}>
          <div style={{
            width: 40, height: 4,
            background: isResizing ? '#A78BFA' : '#1A2D4A',
            borderRadius: 2,
          }}/>
        </div>
      )}

      {/* 풀스크린 모달 */}
      {fullscreen && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000,
          background: '#060B14',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', background: T.card, borderBottom: `1px solid ${T.border}`,
            flexShrink: 0,
          }}>
            <div style={{ color: T.txt, fontWeight: 800, fontSize: 13, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {title}
              {isLandscape && (
                <span style={{
                  marginLeft: 8, fontSize: 9, fontWeight: 700,
                  color: '#10B981', background: '#10B98115',
                  padding: '2px 7px', borderRadius: 4,
                }}>가로 모드</span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {!isLandscape && (
                <span style={{ color: '#94A3B8', fontSize: 9 }}>가로로 돌리면 더 넓게</span>
              )}
              {/* 풀스크린 안에서도 레이아웃 모드 토글 */}
              {showLayoutModes && (
                <div style={{ display: 'flex', gap: 3 }}>
                  {(['default','minimal','pro'] as const).map(m => {
                    const active = layoutMode === m;
                    return (
                      <button key={m} type="button" onClick={() => changeMode(m)}
                        style={{
                          minWidth: 34, minHeight: 30, padding: '3px 7px',
                          background: active ? '#7C3AED22' : '#0F2040',
                          color: active ? '#A78BFA' : '#94A3B8',
                          border: `1px solid ${active ? '#7C3AED' : '#1A2D4A'}`,
                          borderRadius: 5, fontSize: 9, fontWeight: 700, cursor: 'pointer',
                        }}>
                        {m === 'default' ? '기본' : m === 'minimal' ? '미니' : '프로'}
                      </button>
                    );
                  })}
                </div>
              )}
              <button type="button" onClick={() => setFullscreen(false)}
                aria-label="닫기"
                style={{
                  minWidth: 38, minHeight: 38,
                  background: '#0F2040', color: T.txt,
                  border: `1px solid ${T.border}`, borderRadius: 8,
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  touchAction: 'manipulation',
                }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6"  x2="6"  y2="18"/>
                  <line x1="6"  y1="6"  x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, padding: isLandscape ? 2 : 8 }}>
            <div style={{
              width: '100%', height: '100%',
              borderRadius: isLandscape ? 4 : 8, overflow: 'hidden',
              background: T.card,
              border: `1px solid ${T.border}`,
            }}>
              {enhancedChildren}
            </div>
          </div>
        </div>
      )}
    </>
  );
}



/* ─── FinancialJuice Widget — iframe embed (no API key) ─────── */
export function FinancialJuiceWidget({ height = 360 }: { height?: number }) {
  const src = 'https://www.financialjuice.com/widgets/news-feed?theme=dark&height=400';
  return (
    <div style={{ width: '100%', height, borderRadius: 12, overflow: 'hidden',
      background: '#0A1628', border: '1px solid #1A2D4A' }}>
      <iframe
        src={src}
        title="FinancialJuice News"
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
        sandbox="allow-scripts allow-same-origin allow-popups"
        loading="lazy"
      />
    </div>
  );
}

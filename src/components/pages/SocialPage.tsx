'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS, LOGO_SOURCES } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR, simulatePriceUpdate } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Dot, Spark, Pill, Bdg, Toggle, AreaChart, WorldClock, Heatmap,
         TradingChart, Logo, getBgColor, resolveLogoUrl, getKrName, cleanName, resolveTVSym,
         DonutChart, MiniBar, GlobalSearch, getLeverageRec,
         LiquidationCalc, PositionSizer, RiskDashboard,
         InlineTVChart } from './SharedUI';


function SocialPage() {
  const [tab,setTab] = useState<'feed'|'strategy'|'board'|'qa'|'journal'|'profit'|'notice'>('feed');

  const TABS = [
    {id:'feed',      icon:'📱', label:'피드'},
    {id:'strategy',  icon:'🤖', label:'전략 공유'},
    {id:'board',     icon:'💬', label:'자유게시판'},
    {id:'qa',        icon:'❓', label:'질문/답변'},
    {id:'journal',   icon:'📝', label:'일지 공유'},
    {id:'profit',    icon:'💰', label:'수익 인증'},
    {id:'notice',    icon:'📢', label:'공지'},
  ] as const;

  const FEED_POSTS = [
    {id:'f1',user:'@cryptoking',badge:'👑',time:'5분 전',text:'BTC 9400만 돌파! 반감기 이후 상승세 지속. 장투 홀더 수고하셨어요 💪',likes:142,comments:28,tags:['BTC','장투']},
    {id:'f2',user:'@wallst_pro',badge:'🥈',time:'12분 전',text:'NVDA 실적 내일. AI 수요 지속으로 어닝서프라이즈 예상. ⚠️ 투자 조언 아님.',likes:89,comments:15,tags:['NVDA','주식']},
    {id:'f3',user:'@dca_master',badge:'',time:'30분 전',text:'ETH 주간 DCA 완료. 평단 420만원. DCA는 감정 없이 실행이 핵심!',likes:201,comments:44,tags:['ETH','DCA']},
    {id:'f4',user:'@scalper_kr',badge:'',time:'1시간 전',text:'SOL 단타 +3.2% 성공. 지지선 반등 포착. 모의매매 연습 덕분에 타이밍 잡았습니다.',likes:67,comments:12,tags:['SOL','단타']},
  ];

  const STRATEGIES = [
    {id:'s1',user:'@cryptoking',badge:'👑',name:'BTC EMA Pro',pnl:'+24.8%',winRate:'67%',subs:1842,desc:'EMA20/50/200 다중 타임프레임 추세 추종 전략. BTC 5분봉 최적화.',tags:['BTC','추세'],verified:true},
    {id:'s2',user:'@dca_master',badge:'',name:'ETH DCA Master',pnl:'+38.1%',winRate:'83%',subs:987,desc:'월 4회 ETH DCA + RSI 30 이하 추가매수 전략.',tags:['ETH','DCA'],verified:true},
    {id:'s3',user:'@ai_trader',badge:'🤖',name:'AI Regime Strategy',pnl:'+42.1%',winRate:'52%',subs:444,desc:'시장 국면 AI 분류 + 자동 레버리지 조정 전략.',tags:['AI','자동'],verified:false},
  ];

  const BOARD_POSTS = [
    {id:'b1',user:'@newbie_kr',time:'2시간 전',title:'초보자도 TRAIGO 사용할 수 있나요?',views:342,likes:28,comments:15,category:'질문'},
    {id:'b2',user:'@chart_pro',time:'3시간 전',title:'TradingView 웹훅 설정 완전 가이드',views:1204,likes:94,comments:31,category:'가이드'},
    {id:'b3',user:'@btcmaxi',time:'5시간 전',title:'비트코인 반감기 이후 역대 수익률 분석',views:2847,likes:213,comments:87,category:'분석'},
  ];

  const QA_POSTS = [
    {id:'q1',user:'@learner_kr',time:'1시간 전',title:'손절 라인을 어떻게 설정해야 하나요?',solved:true,answers:8,likes:34},
    {id:'q2',user:'@trader_new',time:'4시간 전',title:'RSI와 MACD 함께 사용하는 방법?',solved:false,answers:3,likes:19},
    {id:'q3',user:'@beginner_sol',time:'어제',title:'DCA 투자 금액은 어떻게 정하나요?',solved:true,answers:12,likes:56},
  ];

  const PROFIT_POSTS = [
    {id:'p1',user:'@cryptoking',badge:'👑',time:'오전',asset:'BTC',pnl:'+₩1,240,000',pct:'+8.3%',side:'롱',mode:'모의'},
    {id:'p2',user:'@nvda_trader',badge:'',time:'어제',asset:'NVDA',pnl:'+₩380,000',pct:'+5.7%',side:'매수',mode:'모의'},
    {id:'p3',user:'@eth_dca',badge:'',time:'어제',asset:'ETH',pnl:'+₩680,000',pct:'+3.2%',side:'롱',mode:'모의'},
  ];

  const NOTICES = [
    {id:'n1',time:'2025-05-16',title:'TRAIGO v8 업데이트 — Analysis Hub · PWA · 드로잉 시스템 대폭 강화',important:true},
    {id:'n2',time:'2025-05-10',title:'WUNDER 자동매매 봇 베타 출시 — Pine Script 연동 지원',important:true},
    {id:'n3',time:'2025-05-01',title:'신규 기능: 경제 캘린더 · 뉴스 상세 · 왓치리스트 추가/제거',important:false},
  ];

  const PostCard = ({p, children}:{p:any; children?: React.ReactNode}) => (
    <Card style={{padding:'14px 16px',marginBottom:8}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
        <div style={{display:'flex',gap:6,alignItems:'center'}}>
          <div style={{width:28,height:28,borderRadius:8,background:T.acg,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:900,color:T.acl}}>{(p.user||'?')[1]?.toUpperCase()||'?'}</div>
          <div>
            <div style={{display:'flex',gap:4,alignItems:'center'}}>
              <span style={{color:T.txt,fontSize:12,fontWeight:700}}>{p.user}</span>
              {p.badge&&<span style={{fontSize:12}}>{p.badge}</span>}
              {p.verified&&<span style={{color:T.acl,fontSize:11}}>✓</span>}
            </div>
            <div style={{color:T.muted,fontSize:9,marginTop:1}}>{p.time}</div>
          </div>
        </div>
        {children}
      </div>
      {p.title&&<div style={{color:T.txt,fontSize:13,fontWeight:700,marginBottom:4}}>{p.title}</div>}
      {p.text&&<div style={{color:T.sub,fontSize:12,lineHeight:1.6,marginBottom:8}}>{p.text}</div>}
      {(p.tags||[]).length>0&&(
        <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:8}}>
          {p.tags.map((t:string)=><span key={t} style={{background:T.alt,color:T.muted,fontSize:9,padding:'1px 6px',borderRadius:5}}>#{t}</span>)}
        </div>
      )}
    </Card>
  );

  return (
    <div>
      <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'8px 12px',marginBottom:10}}>
        <div style={{color:T.ylw,fontWeight:700,fontSize:10}}>⚠️ 모든 성과는 모의투자 기준 · 실제 수익 보장 없음</div>
      </div>

      {/* Tabs */}
      <div style={{display:'flex',gap:4,overflowX:'auto',paddingBottom:4,marginBottom:12}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{flexShrink:0,padding:'5px 10px',background:tab===t.id?T.acg:'transparent',color:tab===t.id?T.acl:T.muted,border:`1px solid ${tab===t.id?T.acl:T.border}`,borderRadius:20,fontSize:10,fontWeight:700,cursor:'pointer'}}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab==='feed'&&(
        <div>
          {FEED_POSTS.map(p=>(
            <PostCard key={p.id} p={p}>
              <div style={{display:'flex',gap:8,color:T.muted,fontSize:10}}>
                <span>❤️ {p.likes}</span><span>💬 {p.comments}</span>
              </div>
            </PostCard>
          ))}
        </div>
      )}

      {tab==='strategy'&&(
        <div>
          {STRATEGIES.map(s=>(
            <Card key={s.id} style={{padding:'14px 16px',marginBottom:8}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                <div><div style={{color:T.txt,fontWeight:700,fontSize:13}}>{s.name}{s.verified&&<span style={{color:T.acl,fontSize:11,marginLeft:4}}>✓</span>}</div><div style={{color:T.muted,fontSize:10}}>{s.user} {s.badge} · 구독 {s.subs.toLocaleString()}명</div></div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.grn,fontWeight:800,fontSize:13}}>{s.pnl}</div>
                  <div style={{color:T.muted,fontSize:9}}>승률 {s.winRate}</div>
                </div>
              </div>
              <div style={{color:T.sub,fontSize:11,marginBottom:8,lineHeight:1.5}}>{s.desc}</div>
              <div style={{display:'flex',gap:4,marginBottom:8}}>
                {s.tags.map((t:string)=><span key={t} style={{background:T.alt,color:T.muted,fontSize:9,padding:'1px 6px',borderRadius:5}}>#{t}</span>)}
              </div>
              <button style={{width:'100%',padding:'8px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:9,fontSize:11,fontWeight:700,cursor:'pointer'}}>⭐ 전략 구독 (모의)</button>
            </Card>
          ))}
        </div>
      )}

      {tab==='board'&&(
        <div>
          {BOARD_POSTS.map(p=>(
            <Card key={p.id} style={{padding:'12px 14px',marginBottom:6,cursor:'pointer'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:4}}>
                <span style={{background:T.acl+'20',color:T.acl,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:5}}>{p.category}</span>
                <div style={{display:'flex',gap:8,color:T.muted,fontSize:9}}>
                  <span>👁 {p.views}</span><span>❤️ {p.likes}</span><span>💬 {p.comments}</span>
                </div>
              </div>
              <div style={{color:T.txt,fontSize:12,fontWeight:600,marginBottom:3}}>{p.title}</div>
              <div style={{color:T.muted,fontSize:9}}>{p.user} · {p.time}</div>
            </Card>
          ))}
        </div>
      )}

      {tab==='qa'&&(
        <div>
          {QA_POSTS.map(p=>(
            <Card key={p.id} style={{padding:'12px 14px',marginBottom:6,cursor:'pointer'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:4}}>
                <span style={{background:p.solved?T.grn+'20':T.ylw+'20',color:p.solved?T.grn:T.ylw,fontSize:9,fontWeight:700,padding:'1px 7px',borderRadius:5}}>{p.solved?'✅ 해결됨':'미해결'}</span>
                <div style={{display:'flex',gap:8,color:T.muted,fontSize:9}}><span>💬 {p.answers}</span><span>❤️ {p.likes}</span></div>
              </div>
              <div style={{color:T.txt,fontSize:12,fontWeight:600,marginBottom:3}}>{p.title}</div>
              <div style={{color:T.muted,fontSize:9}}>{p.user} · {p.time}</div>
            </Card>
          ))}
        </div>
      )}

      {tab==='journal'&&(
        <div style={{textAlign:'center',padding:'30px 0'}}>
          <div style={{fontSize:32,marginBottom:8}}>📝</div>
          <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:6}}>공유된 매매일지</div>
          <div style={{color:T.muted,fontSize:11}}>커뮤니티 일지 공유 기능 준비 중</div>
        </div>
      )}

      {tab==='profit'&&(
        <div>
          {PROFIT_POSTS.map(p=>(
            <Card key={p.id} style={{padding:'14px 16px',marginBottom:8,border:`1px solid ${T.grn}20`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <div style={{width:28,height:28,borderRadius:8,background:T.grn+'20',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:900,color:T.grn}}>{(p.user||'?')[1]?.toUpperCase()||'?'}</div>
                  <div><div style={{color:T.txt,fontSize:12,fontWeight:700}}>{p.user} {p.badge}</div><div style={{color:T.muted,fontSize:9}}>{p.time} · {p.asset} {p.side}</div></div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.grn,fontWeight:900,fontSize:14}}>{p.pnl}</div>
                  <div style={{color:T.grn,fontSize:10}}>{p.pct}</div>
                  <div style={{color:T.muted,fontSize:8}}>{p.mode}</div>
                </div>
              </div>
            </Card>
          ))}
          <div style={{marginTop:8,color:T.muted,fontSize:9,textAlign:'center'}}>모든 수익은 모의투자 기준 · 실제 수익 보장 없음</div>
        </div>
      )}

      {tab==='notice'&&(
        <div>
          {NOTICES.map(n=>(
            <Card key={n.id} style={{padding:'12px 14px',marginBottom:6,border:`1px solid ${n.important?T.acl:T.border}20`}}>
              <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:3}}>
                {n.important&&<span style={{background:T.red+'20',color:T.red,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:5}}>중요</span>}
                <span style={{color:T.muted,fontSize:9}}>{n.time}</span>
              </div>
              <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{n.title}</div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── AccountsPage (멀티 계좌 + API 연결) ── */
type ExchangeType = 'binance'|'gateio'|'upbit'|'bithumb'|'kr_broker'|'us_broker';
type AccountGroup = 'longterm'|'shortterm'|'auto'|'cash'|'custom';
interface ConnectedAccount {
  id:string; exchange:ExchangeType; nickname:string; group:AccountGroup;
  status:'connected'|'error'|'pending'; balance:number; available:number;
  openPositions:number; todayPnl:number; todayPnlPct:number;
  apiKeyMasked:string; permissions:{trading:boolean;withdrawal:boolean;read:boolean};
  autoTrading:boolean; maxDailyLoss:number; maxPositionSize:number;
  lastSync:string; isPaper:boolean; emergencyStop:boolean;
}
interface BulkOrder {
  assetId:string; nameKr:string; side:'buy'|'sell'; totalAmount:number;
  selectedAccounts:string[]; allocationMethod:'equal'|'percent'|'weighted'|'custom';
  allocations:Record<string,number>; leverage:number;
}

const EXCHANGE_INFO:Record<ExchangeType,{name:string;icon:string;color:string;url:string}> = {
  binance:  {name:'Binance',icon:'🟡',color:'#F0B90B',url:'https://www.binance.com/api'},
  gateio:   {name:'Gate.io',icon:'🔵',color:'#3B82F6',url:'https://www.gate.io/api'},
  upbit:    {name:'Upbit',icon:'🔵',color:'#2563EB',url:'https://upbit.com/open_api'},
  bithumb:  {name:'Bithumb',icon:'🟢',color:'#10B981',url:'https://apidocs.bithumb.com'},
  kr_broker:{name:'국내 증권사',icon:'🇰🇷',color:'#EF4444',url:'#'},
  us_broker:{name:'해외 브로커',icon:'🇺🇸',color:'#6366F1',url:'#'},
};

const GROUP_INFO:Record<AccountGroup,{name:string;color:string;icon:string}> = {
  longterm: {name:'장투 계좌',color:'#3B82F6',icon:'📈'},
  shortterm:{name:'단타 계좌',color:'#F59E0B',icon:'⚡'},
  auto:     {name:'자동매매 계좌',color:'#10B981',icon:'🤖'},
  cash:     {name:'현금 대기 계좌',color:'#94A3B8',icon:'💵'},
  custom:   {name:'커스텀 그룹',color:'#7C3AED',icon:'⚙️'},
};

const MOCK_ACCOUNTS:ConnectedAccount[] = [
  {id:'acc1',exchange:'binance',nickname:'바이낸스 메인',group:'shortterm',status:'connected',balance:15420000,available:8200000,openPositions:3,todayPnl:87000,todayPnlPct:0.57,apiKeyMasked:'BNBX****...****KMN2',permissions:{trading:true,withdrawal:false,read:true},autoTrading:true,maxDailyLoss:500000,maxPositionSize:5000000,lastSync:'방금',isPaper:true,emergencyStop:false},
  {id:'acc2',exchange:'upbit',nickname:'업비트 장투',group:'longterm',status:'connected',balance:32100000,available:5000000,openPositions:5,todayPnl:124000,todayPnlPct:0.39,apiKeyMasked:'UPX****...****A92F',permissions:{trading:true,withdrawal:false,read:true},autoTrading:false,maxDailyLoss:1000000,maxPositionSize:10000000,lastSync:'3분 전',isPaper:true,emergencyStop:false},
  {id:'acc3',exchange:'gateio',nickname:'Gate.io 알트',group:'auto',status:'connected',balance:4800000,available:4800000,openPositions:0,todayPnl:-12000,todayPnlPct:-0.25,apiKeyMasked:'GTX****...****BB1C',permissions:{trading:true,withdrawal:false,read:true},autoTrading:true,maxDailyLoss:200000,maxPositionSize:2000000,lastSync:'1분 전',isPaper:true,emergencyStop:false},
  {id:'acc4',exchange:'kr_broker',nickname:'미래에셋 장투',group:'longterm',status:'pending',balance:0,available:0,openPositions:0,todayPnl:0,todayPnlPct:0,apiKeyMasked:'',permissions:{trading:false,withdrawal:false,read:false},autoTrading:false,maxDailyLoss:0,maxPositionSize:0,lastSync:'미연결',isPaper:true,emergencyStop:false},
];



export default SocialPage;
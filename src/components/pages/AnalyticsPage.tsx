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


function AnalyticsPage({prices,currency}:{prices:Asset[];currency:string}) {
  const [tab,setTab]=useState<'analytics'|'sync'|'export'>('analytics');

  const riskScore=72;
  const sectorAlloc=[
    {name:'반도체',pct:35,color:'#3B82F6'},
    {name:'코인',pct:25,color:'#F7931A'},
    {name:'테크',pct:20,color:'#7C3AED'},
    {name:'에너지',pct:10,color:'#D97706'},
    {name:'기타',pct:10,color:'#94A3B8'},
  ];

  return (
    <div>
      <div style={{display:'flex',gap:6,marginBottom:14,overflowX:'auto'}}>
        {(['analytics','sync','export'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flexShrink:0,padding:'8px 12px',background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {t==='analytics'?'📊 고급 분석':t==='sync'?'☁️ 클라우드 동기화':'📥 내보내기'}
          </button>
        ))}
      </div>

      {tab==='analytics'&&(
        <div>
          {/* Risk Score */}
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${riskScore>70?T.grn:riskScore>40?T.ylw:T.red}30`}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🎯 종합 리스크 점수</div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
              <div style={{color:riskScore>70?T.grn:riskScore>40?T.ylw:T.red,fontSize:32,fontWeight:900,fontFamily:'monospace'}}>{riskScore}</div>
              <div style={{textAlign:'right'}}>
                <Bdg c={T.grn} ch={riskScore>70?'건강':'보통'}/>
                <div style={{color:T.muted,fontSize:10,marginTop:3}}>100점 만점</div>
              </div>
            </div>
            <div style={{height:8,background:'#1A2D4A',borderRadius:4,overflow:'hidden',marginBottom:6}}>
              <div style={{height:'100%',width:riskScore+'%',background:riskScore>70?T.grn:riskScore>40?T.ylw:T.red,borderRadius:4,transition:'width .8s'}}/>
            </div>
          </Card>

          {/* Sector allocation */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🏭 섹터 배분</div>
            {(Array.isArray(sectorAlloc)?sectorAlloc:[]).map(s=>(
              <div key={s.name} style={{marginBottom:8}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{color:T.txt,fontSize:12}}>{s.name}</span>
                  <span style={{color:s.color,fontSize:12,fontWeight:700}}>{s.pct}%</span>
                </div>
                <div style={{height:6,background:'#1A2D4A',borderRadius:3,overflow:'hidden'}}>
                  <div style={{height:'100%',width:s.pct+'%',background:s.color,borderRadius:3}}/>
                </div>
              </div>
            ))}
          </Card>

          {/* Performance metrics */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📈 성과 지표</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8}}>
              {[
                {l:'샤프지수',v:'1.82',c:T.grn,sub:'위험대비 수익'},
                {l:'최대낙폭(MDD)',v:'-12.4%',c:T.red,sub:'최대 손실 구간'},
                {l:'변동성 (30D)',v:'18.2%',c:T.ylw,sub:'일간 수익 표준편차'},
                {l:'승률 (30D)',v:'67%',c:T.grn,sub:'수익 거래 비율'},
                {l:'수익팩터',v:'2.1',c:T.acl,sub:'총수익/총손실'},
                {l:'평균 보유기간',v:'3.2일',c:T.txt,sub:'포지션 평균 유지'},
              ].map(m=>(
                <div key={m.l} style={{background:T.alt,borderRadius:10,padding:'12px 12px'}}>
                  <div style={{color:T.muted,fontSize:9,marginBottom:3}}>{m.l}</div>
                  <div style={{color:m.c,fontSize:16,fontWeight:900,fontFamily:'monospace'}}>{m.v}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:2}}>{m.sub}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Correlation heatmap placeholder */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:4}}>🌡️ 자산 상관관계 히트맵</div>
            <div style={{color:T.muted,fontSize:10,marginBottom:10}}>상관계수 -1 (역상관) ~ +1 (정상관)</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:3}}>
              {['BTC','ETH','AAPL','NDX','GLD'].map(r=>['BTC','ETH','AAPL','NDX','GLD'].map(c=>{
                const CORR_MATRIX:Record<string,Record<string,number>>={BTC:{BTC:1,ETH:.85,AAPL:.42,NDX:.38,GLD:.15},ETH:{BTC:.85,ETH:1,AAPL:.39,NDX:.35,GLD:.12},AAPL:{BTC:.42,ETH:.39,AAPL:1,NDX:.91,GLD:-.08},NDX:{BTC:.38,ETH:.35,AAPL:.91,NDX:1,GLD:-.12},GLD:{BTC:.15,ETH:.12,AAPL:-.08,NDX:-.12,GLD:1}};
                const corr=(CORR_MATRIX[r]?.[c]??0);
                const bg=corr>0.7?`rgba(16,185,129,${corr*0.7})`:corr<-0.3?`rgba(239,68,68,${Math.abs(corr)*0.7})`:'rgba(71,85,105,0.3)';
                return <div key={r+c} title={`${r}-${c}: ${corr.toFixed(2)}`} style={{background:bg,borderRadius:3,height:24,display:'flex',alignItems:'center',justifyContent:'center'}}><span style={{fontSize:8,color:'#fff',fontWeight:700}}>{corr.toFixed(1)}</span></div>;
              }))}
            </div>
            <div style={{display:'flex',justifyContent:'center',gap:16,marginTop:8}}>
              {['BTC','ETH','AAPL','NDX','GLD'].map(l=><span key={l} style={{color:T.muted,fontSize:9}}>{l}</span>)}
            </div>
          </Card>
        </div>
      )}

      {tab==='sync'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.grn}30`}}>
            <div style={{color:T.grn,fontWeight:700,marginBottom:10}}>☁️ 클라우드 동기화</div>
            {[
              {l:'포트폴리오',v:'동기화됨',t:'방금',c:T.grn},
              {l:'매매 기록',v:'동기화됨',t:'2분 전',c:T.grn},
              {l:'설정',v:'동기화됨',t:'5분 전',c:T.grn},
              {l:'왓치리스트',v:'미동기화',t:'-',c:T.ylw},
            ].map((s,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{s.l}</span>
                <div style={{display:'flex',gap:6,alignItems:'center'}}><span style={{color:T.muted,fontSize:10}}>{s.t}</span><Bdg c={s.c} ch={s.v} sm/></div>
              </div>
            ))}
            <button style={{width:'100%',marginTop:12,padding:'10px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer'}}>🔄 전체 동기화</button>
          </Card>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📱 연결 기기</div>
            {['iPhone 15 Pro · 현재 기기','MacBook Pro · 2시간 전'].map((d,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<1?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{d}</span>
                {i===0?<Bdg c={T.grn} ch="현재" sm/>:<button style={{background:T.red+'15',color:T.red,border:'none',borderRadius:6,padding:'3px 8px',fontSize:10,cursor:'pointer'}}>해제</button>}
              </div>
            ))}
          </Card>
        </div>
      )}

      {tab==='export'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📥 데이터 내보내기</div>
            {[
              {l:'포트폴리오 현황',f:'portfolio.json',icon:'💼'},
              {l:'매매 기록 (CSV)',f:'trades.csv',icon:'📋'},
              {l:'전략 설정',f:'strategies.json',icon:'🤖'},
              {l:'백테스트 결과',f:'backtests.json',icon:'🧪'},
              {l:'설정 백업',f:'settings.json',icon:'⚙️'},
            ].map((e,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<4?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}><span style={{fontSize:18}}>{e.icon}</span><div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{e.l}</div><div style={{color:T.muted,fontSize:10}}>{e.f}</div></div></div>
                <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>↓ 다운로드</button>
              </div>
            ))}
          </Card>
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📤 백업 복원</div>
            <div style={{border:`2px dashed ${T.border}`,borderRadius:10,padding:'24px',textAlign:'center',cursor:'pointer'}}>
              <div style={{fontSize:28,marginBottom:6}}>📁</div>
              <div style={{color:T.muted,fontSize:12}}>백업 파일을 드래그하거나 클릭하여 업로드</div>
              <div style={{color:T.muted,fontSize:10,marginTop:3}}>JSON, CSV 파일 지원</div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   TRAIGO SUBSCRIPTION SYSTEM
   Plans: Free · Pro · Premium · Lifetime · Founder · Admin
   ══════════════════════════════════════════════════════════════ */

type PlanType = 'free'|'pro'|'premium'|'lifetime'|'founder'|'admin';
type PlanStatus = 'active'|'expired'|'suspended'|'trialing';
type BadgeType = 'vip'|'founder'|'supporter'|'lifetime'|'admin'|'early_bird';

interface UserSubscription {
  userId: string;
  planType: PlanType;
  status: PlanStatus;
  expiresAt: string|null;   // null = never (lifetime/admin)
  grantedBy: string|null;   // admin userId who granted
  createdAt: string;
  inviteCode?: string;
  badges: BadgeType[];
}

interface InviteCode {
  id: string;
  code: string;
  planType: PlanType;
  usesMax: number|null;     // null = unlimited
  usesCount: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string|null;
  note: string;
  active: boolean;
}

const PLAN_INFO: Record<PlanType,{label:string;color:string;icon:string;price:string;features:string[]}> = {
  free:     {label:'무료',     color:'#94A3B8',icon:'🆓',price:'₩0',         features:['모의매매','기본 차트','15개 종목 왓치']},
  pro:      {label:'Pro',     color:'#3B82F6',icon:'⚡',price:'₩9,900/월',   features:['모든 무료 기능','무제한 왓치리스트','AI 분석 50회/월','실시간 알림']},
  premium:  {label:'Premium', color:'#7C3AED',icon:'💎',price:'₩29,900/월',  features:['모든 Pro 기능','AI 무제한','TradFi CFD','고급 백테스트']},
  lifetime: {label:'평생회원', color:'#F59E0B',icon:'♾️',price:'₩299,000 1회',features:['모든 Premium 기능','평생 이용','업그레이드 무료','우선 지원']},
  founder:  {label:'창업멤버', color:'#EF4444',icon:'🚀',price:'초대 전용',   features:['모든 기능','창업멤버 배지','영구 Premium','운영 참여']},
  admin:    {label:'관리자',   color:'#10B981',icon:'🛡️',price:'내부',        features:['전체 권한','사용자 관리','시스템 접근','코드 생성']},
};

const BADGE_INFO: Record<BadgeType,{label:string;color:string;icon:string}> = {
  vip:       {label:'VIP',     color:'#F59E0B',icon:'⭐'},
  founder:   {label:'창업멤버',color:'#EF4444',icon:'🚀'},
  supporter: {label:'서포터',  color:'#7C3AED',icon:'💜'},
  lifetime:  {label:'평생회원',color:'#F59E0B',icon:'♾️'},
  admin:     {label:'관리자',  color:'#10B981',icon:'🛡️'},
  early_bird:{label:'얼리버드',color:'#0891B2',icon:'🐦'},
};

// ── Mock data ─────────────────────────────────────────────────
const MOCK_CURRENT_USER: UserSubscription = {
  userId: 'usr_me',
  planType: 'pro',
  status: 'active',
  expiresAt: '2025-12-31',
  grantedBy: null,
  createdAt: '2025-01-15',
  badges: ['early_bird'],
};

const MOCK_USERS_ADMIN: (UserSubscription & {email:string;name:string})[] = [
  {userId:'usr_1',email:'kim@test.com',name:'김민준',planType:'lifetime',status:'active',expiresAt:null,grantedBy:'admin',createdAt:'2024-12-01',badges:['lifetime','vip']},
  {userId:'usr_2',email:'lee@test.com',name:'이서연',planType:'founder',status:'active',expiresAt:null,grantedBy:'admin',createdAt:'2024-11-15',badges:['founder','vip']},
  {userId:'usr_3',email:'park@test.com',name:'박지호',planType:'pro',status:'active',expiresAt:'2025-08-30',grantedBy:null,createdAt:'2025-02-01',badges:[]},
  {userId:'usr_4',email:'choi@test.com',name:'최유진',planType:'free',status:'active',expiresAt:null,grantedBy:null,createdAt:'2025-03-10',badges:['early_bird']},
  {userId:'usr_5',email:'jung@test.com',name:'정수민',planType:'premium',status:'active',expiresAt:'2025-07-31',grantedBy:null,createdAt:'2025-01-20',badges:['supporter']},
];

const MOCK_INVITE_CODES: InviteCode[] = [
  {id:'ic1',code:'TRAIGO-FOUNDER-2025',planType:'founder',usesMax:10,usesCount:2,createdBy:'admin',createdAt:'2024-11-01',expiresAt:null,note:'창업멤버 코드',active:true},
  {id:'ic2',code:'LIFETIME-VIP-AAA',planType:'lifetime',usesMax:1,usesCount:0,createdBy:'admin',createdAt:'2025-01-10',expiresAt:'2025-12-31',note:'개인 발급',active:true},
  {id:'ic3',code:'PRO-FRIEND-XYZ',planType:'pro',usesMax:null,usesCount:14,createdBy:'admin',createdAt:'2025-02-01',expiresAt:null,note:'친구 초대 - 무제한',active:true},
  {id:'ic4',code:'BETA-TESTER-001',planType:'pro',usesMax:50,usesCount:50,createdBy:'admin',createdAt:'2024-10-01',expiresAt:'2025-01-01',note:'베타 테스터용 (만료)',active:false},
];

/* ── Badge component ── */


export default AnalyticsPage;
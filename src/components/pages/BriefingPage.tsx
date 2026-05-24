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


function BriefingPage({prices}:{prices:Asset[]}) {
  const [tab,setTab]=useState<'market'|'portfolio'|'risk'|'watchlist'>('market');
  const now=new Date();
  const hour=now.getHours();
  const timeLabel=hour<12?'오전 브리핑':hour<18?'오후 브리핑':'야간 브리핑';

  const MARKET_ITEMS=[
    {icon:'₿',title:'BTC 모멘텀',body:'비트코인이 9,400만원 저항선에서 조정 중입니다. 단기 변동성이 확대되고 있으며, 반감기 이후 공급 감소 효과가 시장에 반영되고 있습니다.',sentiment:'neutral',tag:'변동성 주의'},
    {icon:'📊',title:'나스닥 기술주',body:'나스닥이 +0.87% 상승하며 AI 섹터 강세가 지속되고 있습니다. NVDA, MSFT 중심의 상승세로 반도체 ETF가 선도하고 있습니다.',sentiment:'bullish',tag:'강세'},
    {icon:'🛢️',title:'원유·인플레이션',body:'WTI 원유가 소폭 하락(-0.9%)하며 에너지 비용 압력이 줄어들고 있습니다. 이는 CPI 발표에 긍정적 영향을 줄 수 있습니다.',sentiment:'neutral',tag:'관찰'},
    {icon:'💱',title:'달러·환율',body:'달러 인덱스가 소폭 약세(-0.22%)를 보이며 원화가 강세입니다. 수출주에 단기 부정적 요인이 될 수 있습니다.',sentiment:'bearish',tag:'주의'},
    {icon:'🥇',title:'금·안전자산',body:'금이 +0.56% 상승하며 지정학적 리스크에 대한 헤지 수요가 지속되고 있습니다. 포트폴리오 안정성 역할을 수행 중입니다.',sentiment:'bullish',tag:'안전'},
  ];

  const PORTFOLIO_ITEMS=[
    {icon:'📈',title:'장투 포트폴리오 건강',body:'BTC·ETH 장기 포지션이 안정적입니다. 목표가 대비 진행률이 62%로 순조롭게 진행 중이며, DCA 계획이 정상 실행되고 있습니다.',sentiment:'bullish'},
    {icon:'⚡',title:'단타 주의 신호',body:'SOL 단기 포지션이 목표가의 85%에 도달했습니다. 부분 익절을 고려해볼 수 있습니다.',sentiment:'neutral'},
    {icon:'💵',title:'현금 비중',body:'현금 비중 10%가 유지되고 있습니다. CPI 발표 후 매수 기회를 노리는 전략이 유효합니다.',sentiment:'neutral'},
  ];

  const RISK_ITEMS=[
    {icon:'⚠️',title:'집중도 경고',body:'NVDA 단일 종목 비중이 35%를 초과했습니다. 분산 투자를 권장합니다.',level:'warning'},
    {icon:'✅',title:'레버리지 정상',body:'현재 사용 중인 레버리지가 권장 범위 내에 있습니다. 단타 계좌 최대 레버리지: 3배.',level:'ok'},
    {icon:'📡',title:'펀딩비 정상',body:'BTC 선물 펀딩비 0.01%로 정상 범위입니다. 과열 신호 없음.',level:'ok'},
    {icon:'⚠️',title:'유동성 주의',body:'일부 알트코인 포지션의 슬리피지가 높을 수 있습니다. 큰 규모 거래 시 주의하세요.',level:'warning'},
  ];

  const sentimentColor=(s:string)=>s==='bullish'?T.grn:s==='bearish'?T.red:T.ylw;

  return (
    <div>
      {/* Header */}
      <div style={{background:'linear-gradient(135deg,#0A1628,#0D1F3C)',border:`1px solid ${T.border2}`,borderRadius:18,padding:'16px 18px',marginBottom:14}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
          <span style={{fontSize:20}}>🤖</span>
          <div>
            <div style={{color:T.txt,fontWeight:800,fontSize:15}}>AI {timeLabel}</div>
            <div style={{color:T.muted,fontSize:10}}>{now.toLocaleDateString('ko-KR',{month:'long',day:'numeric',weekday:'long'})} · 교육 목적 · 수익 보장 없음</div>
          </div>
        </div>
        <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:8,padding:'6px 10px',marginTop:8}}>
          <div style={{color:T.ylw,fontSize:10,fontWeight:600}}>⚠️ AI 브리핑은 교육·참고 목적이며 투자 조언이 아닙니다. 수익을 보장하지 않습니다.</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:'flex',gap:6,marginBottom:14,overflowX:'auto'}}>
        {([['market','🌐 시장'],['portfolio','💼 포트폴리오'],['risk','🛡️ 리스크'],['watchlist','👁 왓치리스트']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'8px 12px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {tab==='market'&&(
        <div>
          <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>오늘의 시장 브리핑</div>
          {MARKET_ITEMS.map((item,i)=>(
            <Card key={i} style={{padding:'14px 16px',marginBottom:10,border:`1px solid ${sentimentColor(item.sentiment)}15`}}>
              <div style={{display:'flex',gap:10,alignItems:'flex-start'}}>
                <div style={{width:36,height:36,borderRadius:10,background:sentimentColor(item.sentiment)+'15',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>{item.icon}</div>
                <div style={{flex:1}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:5}}>
                    <div style={{color:T.txt,fontWeight:700,fontSize:13}}>{item.title}</div>
                    <span style={{background:sentimentColor(item.sentiment)+'20',color:sentimentColor(item.sentiment),fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:99}}>{item.tag}</span>
                  </div>
                  <div style={{color:T.sub,fontSize:11,lineHeight:1.6}}>{item.body}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab==='portfolio'&&(
        <div>
          <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>포트폴리오 요약</div>
          {PORTFOLIO_ITEMS.map((item,i)=>(
            <Card key={i} style={{padding:'14px 16px',marginBottom:10,border:`1px solid ${sentimentColor(item.sentiment)}15`}}>
              <div style={{display:'flex',gap:10}}>
                <span style={{fontSize:22,flexShrink:0}}>{item.icon}</span>
                <div>
                  <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:4}}>{item.title}</div>
                  <div style={{color:T.sub,fontSize:11,lineHeight:1.6}}>{item.body}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab==='risk'&&(
        <div>
          <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>리스크 요약</div>
          {RISK_ITEMS.map((item,i)=>(
            <Card key={i} style={{padding:'14px 16px',marginBottom:10,border:`1px solid ${item.level==='warning'?T.ylw:T.grn}20`}}>
              <div style={{display:'flex',gap:10}}>
                <span style={{fontSize:20,flexShrink:0}}>{item.icon}</span>
                <div>
                  <div style={{color:item.level==='warning'?T.ylw:T.grn,fontWeight:700,fontSize:13,marginBottom:4}}>{item.title}</div>
                  <div style={{color:T.sub,fontSize:11,lineHeight:1.6}}>{item.body}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab==='watchlist'&&(
        <div>
          <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>왓치리스트 하이라이트</div>
          {(prices||[]).slice(0,6).map((a,i)=>(
            <Card key={a.id} style={{padding:'12px 14px',marginBottom:8}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <Logo id={a.id} size={32} clr={a.clr}/>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:12}}>{a.nameKr}</div>
                    <div style={{color:T.muted,fontSize:10}}>{a.sym}</div>
                  </div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>{cvt(a.p,'KRW')}</div>
                  <div style={{color:a.c>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{(a.c??0)>=0?'+':''}{(a.c??0).toFixed(2)}%</div>
                </div>
              </div>
              <div style={{marginTop:8,color:T.muted,fontSize:10,lineHeight:1.5}}>
                {Math.abs(a.c??0)>5?`⚠️ 변동성 높음 — 레버리지 주의`:Math.abs(a.c??0)>2?`📊 보통 변동성 — 전략적 접근`:`✅ 안정적 움직임`}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   TAX / PROFIT TRACKING PAGE
   ══════════════════════════════════════════════════════════════ */


export default BriefingPage;
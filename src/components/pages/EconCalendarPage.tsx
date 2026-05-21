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


function EconCalendarPage() {
  const [filter,setFilter]   = useState<'all'|'high'|'medium'|'low'>('all');
  const [country,setCountry] = useState('전체');
  const [selected,setSelected] = useState<any>(null);
  const [events,setEvents]   = useState<any[]>([]);
  const [loading,setLoading] = useState(true);

  const impactC:Record<string,string> = { high:T.red, medium:T.ylw, low:T.grn };
  const COUNTRIES = ['전체','US','EU','KR','JP','CN','UK'];

  // Fetch from Finnhub (server-side) or mock
  useEffect(()=>{
    setLoading(true);
    fetch('/api/finnhub?action=calendar')
      .then(r=>r.json())
      .then(d=>{ setEvents(Array.isArray(d.events) ? d.events : []); })
      .catch(()=>setEvents([]))
      .finally(()=>setLoading(false));
  },[]);

  const filtered = events.filter(e=>{
    const matchImpact  = filter==='all' || e.impact===filter;
    const matchCountry = country==='전체' || e.country===country;
    return matchImpact && matchCountry;
  });

  const eventDescriptions: Record<string,string> = {
    'CPI':'소비자물가지수 — 인플레이션의 핵심 지표. 예상 상회 시 긴축 가능성 ↑ (주식 하락 압력)',
    'FOMC':'연방공개시장위원회 — Fed 금리 결정. 시장 방향성에 가장 큰 영향',
    'NFP':'비농업고용 — 고용시장 강도 지표. 강한 고용 → 금리 인상 우려',
    'GDP':'국내총생산 성장률 — 경기 상태 척도',
    'PPI':'생산자물가지수 — 기업의 생산 비용 변화',
    'PMI':'구매관리자지수 — 50 이상 경기 확장, 50 이하 수축',
    'ECB':'유럽중앙은행 금리 결정',
    '금통위':'한국은행 기준금리 결정',
  };

  if(selected) return (
    <div>
      <button onClick={()=>setSelected(null)} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,color:T.muted,padding:'5px 12px',fontSize:12,cursor:'pointer',marginBottom:12}}>← 목록으로</button>
      <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:6}}>{selected.event}</div>
      <div style={{display:'flex',gap:8,marginBottom:10}}>
        <span style={{background:impactC[selected.impact]+'20',color:impactC[selected.impact],fontSize:10,fontWeight:700,padding:'3px 8px',borderRadius:6}}>{selected.impact==='high'?'🔴 고영향':selected.impact==='medium'?'🟡 중영향':'🟢 저영향'}</span>
        <span style={{color:T.muted,fontSize:10}}>{selected.country} · {selected.date} {selected.time}</span>
      </div>
      {[...Object.entries(eventDescriptions)].filter(([k])=>selected.event?.includes(k)).map(([k,desc])=>(
        <Card key={k} style={{padding:'12px 14px',marginBottom:8,background:T.acl+'08',border:`1px solid ${T.acl}20`}}>
          <div style={{color:T.acl,fontSize:10,fontWeight:700,marginBottom:4}}>📘 이벤트 설명</div>
          <div style={{color:T.sub,fontSize:12,lineHeight:1.65}}>{desc}</div>
        </Card>
      ))}
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:10}}>
        {[{l:'예측',v:selected.forecast},{l:'이전',v:selected.previous},{l:'실제',v:selected.actual}].map(d=>(
          d.v&&<Card key={d.l} style={{padding:'10px 8px',textAlign:'center'}}>
            <div style={{color:T.muted,fontSize:9}}>{d.l}</div>
            <div style={{color:T.txt,fontWeight:700,fontSize:14,marginTop:3}}>{d.v}{selected.unit||''}</div>
          </Card>
        ))}
      </div>
      <Card style={{padding:'12px 14px',background:'#0A1628',border:`1px solid ${T.red}30`}}>
        <div style={{color:T.red,fontWeight:700,fontSize:10,marginBottom:4}}>⚠️ 트레이딩 주의</div>
        <div style={{color:T.muted,fontSize:11,lineHeight:1.6}}>고영향 이벤트 발표 30분 전후에는 변동성이 급격히 증가합니다. 기존 포지션 리스크를 점검하고 무리한 레버리지 사용을 피하세요.</div>
      </Card>
    </div>
  );

  return (
    <div>
      {/* Filters */}
      <div style={{display:'flex',gap:6,marginBottom:8}}>
        {([['all','전체'],['high','고영향'],['medium','중영향'],['low','저영향']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setFilter(id)} style={{flex:1,padding:'6px',background:filter===id?impactC[id==='all'?'high':id]+'20':T.alt,color:filter===id?(id==='all'?T.acl:impactC[id]):T.muted,border:`1px solid ${filter===id?(id==='all'?T.acl:impactC[id]):T.border}`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>
      <div style={{display:'flex',gap:5,overflowX:'auto',paddingBottom:4,marginBottom:10}}>
        {COUNTRIES.map(c=>(
          <button key={c} onClick={()=>setCountry(c)} style={{flexShrink:0,padding:'4px 10px',background:country===c?T.acg:'transparent',color:country===c?T.acl:T.muted,border:`1px solid ${country===c?T.acl:T.border}`,borderRadius:16,fontSize:10,fontWeight:700,cursor:'pointer'}}>{c}</button>
        ))}
      </div>

      {loading?(
        <div>{[0,1,2,3].map(i=>(
          <div key={i} style={{background:T.card,borderRadius:12,padding:'14px',marginBottom:8}}>
            <div style={{height:12,background:'linear-gradient(90deg,#1A2D4A 25%,#243A5E 50%,#1A2D4A 75%)',backgroundSize:'200% 100%',animation:'shimmer 1.2s infinite',borderRadius:4,marginBottom:6,width:'70%'}}/>
            <div style={{height:10,background:'linear-gradient(90deg,#1A2D4A 25%,#243A5E 50%,#1A2D4A 75%)',backgroundSize:'200% 100%',animation:'shimmer 1.2s infinite',borderRadius:4,width:'40%'}}/>
          </div>
        ))}</div>
      ):filtered.length===0?(
        <div style={{textAlign:'center',padding:'40px 0'}}>
          <div style={{fontSize:32,marginBottom:8}}>📅</div>
          <div style={{color:T.muted,fontSize:13}}>해당 조건의 경제 이벤트가 없습니다</div>
        </div>
      ):filtered.map(e=>(
        <Card key={e.id} style={{padding:'12px 14px',marginBottom:8,cursor:'pointer',borderLeft:`3px solid ${impactC[e.impact]||T.border}`}} onClick={()=>setSelected(e)}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:3}}>{e.event}</div>
              <div style={{display:'flex',gap:8,color:T.muted,fontSize:10}}>
                <span>{e.country}</span><span>{e.date}</span><span>{e.time}</span>
              </div>
            </div>
            <div style={{textAlign:'right',flexShrink:0,marginLeft:8}}>
              <div style={{color:impactC[e.impact],fontWeight:700,fontSize:10}}>{e.impact==='high'?'🔴':e.impact==='medium'?'🟡':'🟢'} {e.impact}</div>
              {e.forecast&&<div style={{color:T.muted,fontSize:9,marginTop:2}}>예측 {e.forecast}{e.unit||''}</div>}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}



export default EconCalendarPage;
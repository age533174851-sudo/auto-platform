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


function RealtimePage({prices}:{prices:Asset[]}) {
  const [config,setConfig]=useState<RealtimeConfig>({freq:'balanced',wsEnabled:true,pollingInterval:3000});
  const [wsStatus,setWsStatus]=useState<'connected'|'polling'|'error'>('connected');
  const [notifSettings,setNotifSettings]=useState({tpHit:true,slHit:true,liqWarning:true,volWarning:true,stratAlert:true,rebalance:false,marketOpen:true});
  const [channels,setChannels]=useState({push:true,telegram:false,discord:false,email:false});
  const [tab,setTab]=useState<'status'|'alerts'|'channels'>('status');

  const FREQ_OPTIONS:Record<DataFreq,{label:string;interval:number;desc:string;color:string}> = {
    low:      {label:'저주파',interval:10000,desc:'10초마다 업데이트 · 배터리 절약',color:T.grn},
    balanced: {label:'균형',interval:3000,desc:'3초마다 업데이트 · 권장',color:T.ylw},
    high:     {label:'고주파',interval:500,desc:'0.5초마다 업데이트 · 배터리 소모',color:T.red},
  };

  useEffect(()=>{
    // Simulate WS status check
    const t=setTimeout(()=>setWsStatus(config.wsEnabled?'connected':'polling'),500);
    return()=>clearTimeout(t);
  },[config.wsEnabled]);

  return (
    <div>
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {(['status','alerts','channels'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:'8px',background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {t==='status'?'📡 실시간 엔진':t==='alerts'?'🔔 알림 설정':'📤 알림 채널'}
          </button>
        ))}
      </div>

      {tab==='status'&&(
        <div>
          {/* WS Status */}
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${wsStatus==='connected'?T.grn:T.ylw}30`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <Dot c={wsStatus==='connected'?T.grn:T.ylw}/>
                <div><div style={{color:T.txt,fontWeight:700,fontSize:13}}>실시간 데이터 엔진</div><div style={{color:T.muted,fontSize:10}}>{wsStatus==='connected'?'WebSocket 연결됨':'폴링 모드 (WS 실패 시 자동 전환)'}</div></div>
              </div>
              <Toggle on={config.wsEnabled} onChange={v=>setConfig(p=>({...p,wsEnabled:v}))}/>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6}}>
              {[{l:'업데이트',v:FREQ_OPTIONS[config.freq].label},{l:'지연',v:`~${config.freq==='high'?500:config.freq==='balanced'?3000:10000}ms`},{l:'모드',v:config.wsEnabled?'WebSocket':'HTTP Polling'}].map(r=>(
                <div key={r.l} style={{background:T.alt,borderRadius:8,padding:'8px 10px',textAlign:'center'}}>
                  <div style={{color:T.muted,fontSize:9}}>{r.l}</div>
                  <div style={{color:T.txt,fontSize:11,fontWeight:700,marginTop:1}}>{r.v}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Frequency selector */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>⚡ 업데이트 주파수</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {(Object.entries(FREQ_OPTIONS) as [DataFreq,any][]).map(([key,opt])=>(
                <button key={key} onClick={()=>setConfig(p=>({...p,freq:key,pollingInterval:opt.interval}))} style={{background:config.freq===key?opt.color+'20':T.alt,border:`2px solid ${config.freq===key?opt.color:T.border}`,borderRadius:12,padding:'12px 6px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{color:config.freq===key?opt.color:T.txt,fontWeight:800,fontSize:14,marginBottom:4}}>{opt.label}</div>
                  <div style={{color:T.muted,fontSize:9,lineHeight:1.5}}>{opt.desc}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* Architecture info */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🏗️ 백엔드 아키텍처</div>
            {[
              {name:'WebSocket',status:'활성',desc:'Binance WS · 코인 실시간',color:T.grn,icon:'🔌'},
              {name:'HTTP Polling',status:'폴백',desc:'API 실패 시 자동 전환',color:T.ylw,icon:'🔄'},
              {name:'Supabase',status:'연동 대기',desc:'유저 데이터 · 포트폴리오',color:T.acl,icon:'🗄️'},
              {name:'Redis Cache',status:'플레이스홀더',desc:'고속 캐시 · 세션',color:T.prp,icon:'⚡'},
              {name:'PostgreSQL',status:'플레이스홀더',desc:'주문·거래 이력',color:T.cyn,icon:'💾'},
            ].map((s,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<4?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <span style={{fontSize:14}}>{s.icon}</span>
                  <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{s.name}</div><div style={{color:T.muted,fontSize:10}}>{s.desc}</div></div>
                </div>
                <Bdg c={s.color} ch={s.status} sm/>
              </div>
            ))}
          </Card>

          {/* DB Schema */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🗂️ DB 테이블 구조</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:5}}>
              {['users','portfolios','positions','orders','transactions','watchlists','alerts','strategies','backtests','api_connections','cached_assets','notifications','audit_logs','tradfi_orders'].map((t,i)=>(
                <div key={i} style={{background:T.alt,borderRadius:7,padding:'5px 9px',display:'flex',alignItems:'center',gap:5}}>
                  <span style={{color:T.acl,fontSize:10}}>📋</span><span style={{color:T.txt,fontSize:10,fontFamily:'monospace'}}>{t}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab==='alerts'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔔 알림 종류 설정</div>
            {[
              {k:'tpHit',l:'익절(TP) 도달',d:'목표가 달성 시 알림'},
              {k:'slHit',l:'손절(SL) 발동',d:'손절가 도달 시 알림'},
              {k:'liqWarning',l:'청산 위험 경고',d:'청산가 10% 이내 접근'},
              {k:'volWarning',l:'변동성 급등 경고',d:'24h 변동성 비정상'},
              {k:'stratAlert',l:'전략 알림',d:'자동매매 조건 충족'},
              {k:'rebalance',l:'리밸런싱 알림',d:'포트폴리오 비중 이탈'},
              {k:'marketOpen',l:'시장 개장/폐장',d:'주요 시장 개폐장 알림'},
            ].map((n,i,arr)=>(
              <div key={n.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{n.l}</div><div style={{color:T.muted,fontSize:10}}>{n.d}</div></div>
                <Toggle on={notifSettings[n.k as keyof typeof notifSettings]} onChange={v=>setNotifSettings(p=>({...p,[n.k]:v}))}/>
              </div>
            ))}
          </Card>
        </div>
      )}

      {tab==='channels'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📤 알림 채널</div>
            {[
              {k:'push',l:'앱 푸시 알림',d:'브라우저/PWA 푸시',status:'활성',c:T.grn},
              {k:'telegram',l:'텔레그램',d:'Bot 연동 필요',status:'준비중',c:T.acl},
              {k:'discord',l:'디스코드',d:'Webhook 연동 필요',status:'준비중',c:T.prp},
              {k:'email',l:'이메일',d:'계정 이메일로 발송',status:'준비중',c:T.ylw},
            ].map((ch,i,arr)=>(
              <div key={ch.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <div>
                  <div style={{display:'flex',gap:5,alignItems:'center'}}><span style={{color:T.txt,fontSize:12,fontWeight:600}}>{ch.l}</span><Bdg c={ch.c} ch={ch.status} sm/></div>
                  <div style={{color:T.muted,fontSize:10,marginTop:2}}>{ch.d}</div>
                </div>
                <Toggle on={channels[ch.k as keyof typeof channels]} onChange={v=>setChannels(p=>({...p,[ch.k]:v}))}/>
              </div>
            ))}
          </Card>

          {/* Telegram setup */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.acl}30`}}>
            <div style={{color:T.acl,fontWeight:700,fontSize:12,marginBottom:8}}>📱 텔레그램 연동 (준비중)</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.7,marginBottom:10}}>1. @TRAIGO_Bot 검색<br/>2. /start 입력<br/>3. 인증 코드 입력</div>
            <div style={{display:'flex',gap:8}}>
              <input placeholder="인증 코드 입력" style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:11,outline:'none'}}/>
              <button type="button"
                onClick={() => alert('텔레그램 연동은 곧 출시됩니다. @TRAIGO_Bot은 아직 활성화되지 않았습니다.')}
                style={{background:T.acl+'20',color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'9px 14px',minHeight:36,fontSize:11,fontWeight:700,cursor:'pointer'}}>연동</button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ── AnalyticsPage (고급 분석 + 클라우드 동기화) ── */


export default RealtimePage;
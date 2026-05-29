'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T } from '@/lib/constants';
import type { Asset } from '@/types';
import { Card, Logo } from './SharedUI';

const AI_INSIGHTS = [
  {type:'warning',icon:'⚡',title:'BTC 변동성 경고',body:'현재 BTC 24h 변동성이 5.2%로 평상시보다 높습니다. 레버리지를 3배 이하로 낮추는 것을 권장합니다.',time:'방금',color:'#F59E0B'},
  {type:'danger',icon:'🔥',title:'펀딩비 과열',body:'BTC 무기한 선물 펀딩비가 0.08%로 상승했습니다. 롱 포지션 보유 시 펀딩비 비용이 증가합니다.',time:'5분 전',color:'#EF4444'},
  {type:'safe',icon:'✅',title:'장투 포트폴리오 건강',body:'장기 보유 포트폴리오는 안정적입니다. BTC/ETH 비중이 균형 잡혀 있으며 청산 리스크가 없습니다.',time:'10분 전',color:'#10B981'},
  {type:'warning',icon:'⚠️',title:'포지션 집중도 경고',body:'단일 자산(SOL) 비중이 포트폴리오의 35%를 초과했습니다. 분산 투자를 권장합니다.',time:'15분 전',color:'#F59E0B'},
  {type:'info',icon:'📊',title:'시장 요약',body:'나스닥 +0.87%, 코스피 -0.22%. 연준 금리 동결로 위험자산 소폭 강세. 암호화폐 시장 전반적 상승.',time:'20분 전',color:'#3B82F6'},
  {type:'info',icon:'💡',title:'DCA 기회',body:'BTC가 단기 지지선인 9,000만원에 근접했습니다. DCA 매수 전략을 고려해볼 좋은 시점입니다.',time:'30분 전',color:'#3B82F6'},
];


function AIPage({prices,currency,onOpenAsset}:{prices:Asset[];currency:string;onOpenAsset?:(a:any,dest?:string)=>void}) {
  const [msgs,setMsgs]   = useState<{role:string;text:string;source?:string}[]>([{
    role:'ai',
    text:'안녕하세요! TRAIGO AI 코파일럿입니다 🤖\n\n어떤 도움이 필요하신가요?\n• 시장 분석 요청\n• 전략 설명 (EMA, RSI, MACD…)\n• 레버리지 리스크 계산\n• 뉴스 요약\n\n⚠️ 교육·참고 목적 전용 · 수익 보장 없음',
  }]);
  const [input,  setInput]   = useState('');
  const [loading, setLoading] = useState(false);
  const [tab,    setTab]     = useState<'chat'|'insights'|'signals'>('insights');
  const [insight, setInsight] = useState<{text:string;source:string}|null>(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(()=>{ endRef.current?.scrollIntoView({behavior:'smooth'}); },[msgs]);

  // ── Fetch AI market insight on load ──
  useEffect(()=>{
    if(tab!=='insights') return;
    if(insight) return;
    setInsightLoading(true);
    const assetStr=(Array.isArray(prices)?prices:[]).slice(0,5).map(a=>`${a.nameKr} ${(a.c??0)>=0?'+':''}${(a.c??0).toFixed(2)}%`).join(', ');
    fetch(`/api/ai?action=summary&assets=${encodeURIComponent(assetStr)}`)
      .then(r=>r.json())
      .then(d=>setInsight({text:d.result||'',source:d.source||''}))
      .catch(()=>setInsight({text:'시장 요약을 불러올 수 없습니다.',source:'error'}))
      .finally(()=>setInsightLoading(false));
  },[tab, prices]);

  // ── Send chat message ──
  const sendMsg = async() => {
    if(!input.trim()||loading) return;
    const userMsg = input.trim();
    setInput('');
    setMsgs(p=>[...p,{role:'user',text:userMsg}]);
    setLoading(true);
    try {
      const r = await fetch('/api/ai',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({action:'chat', message:userMsg}),
      });
      const d = await r.json();
      setMsgs(p=>[...p,{role:'ai',text:d.result||'응답 없음',source:d.source}]);
    } catch {
      setMsgs(p=>[...p,{role:'ai',text:'오류가 발생했습니다. 다시 시도해주세요.⚠️',source:'error'}]);
    } finally { setLoading(false); }
  };

  // ── Quick action chips ──
  const QUICK_ACTIONS = [
    {label:'📊 시장 요약',  msg:'현재 비트코인과 주요 주식 시장 상황을 요약해줘'},
    {label:'📈 RSI 설명',  msg:'RSI 지표가 뭐야? 어떻게 활용해?'},
    {label:'⚠️ 레버리지 위험',msg:'레버리지 10배 사용 시 청산 위험은?'},
    {label:'🌐 FOMC란?',   msg:'FOMC 회의가 비트코인에 미치는 영향은?'},
  ];

  // ── Signals tab ──
  const SIGNALS = [
    {sym:'BTC',   signal:'매수 관망', reason:'RSI 48 · EMA20 > EMA50 · 저항선 근접', conf:62, color:'#F7931A'},
    {sym:'ETH',   signal:'중립',      reason:'RSI 55 · 박스권 횡보 중 · 거래량 감소',  conf:48, color:'#627EEA'},
    {sym:'NVDA',  signal:'매수',      reason:'AI 모멘텀 · RSI 63 · 신고가 돌파 시도',  conf:71, color:'#76B900'},
    {sym:'SOL',   signal:'매도 관망', reason:'RSI 72 과매수 · 단기 과열 신호',          conf:58, color:'#9945FF'},
    {sym:'SPY',   signal:'중립',      reason:'Fed 불확실성 · 박스권 · 옵션 만기 주',    conf:44, color:'#6366F1'},
  ];

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100%'}}>
      {/* Tabs */}
      <div style={{display:'flex',gap:6,marginBottom:12}}>
        {([['insights','💡 인사이트'],['chat','💬 AI 채팅'],['signals','📡 신호']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:'7px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* ── Insights tab ── */}
      {tab==='insights'&&(
        <div>
          {/* AI Market Summary */}
          <Card style={{padding:'14px 16px',marginBottom:12,background:'linear-gradient(135deg,#0D1A35,#091228)',border:`1px solid ${T.acl}30`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
              <div style={{color:T.acl,fontSize:12,fontWeight:700}}>🤖 AI 시장 요약</div>
              {insightLoading&&<div style={{color:T.muted,fontSize:10}}>분석 중…</div>}
              {insight&&!insightLoading&&<div style={{color:T.muted,fontSize:9}}>{insight.source==='openai'?'✅ GPT-4o':'📚 기본'}</div>}
            </div>
            {insightLoading?(
              <div style={{height:60,background:'linear-gradient(90deg,#1A2D4A 25%,#243A5E 50%,#1A2D4A 75%)',backgroundSize:'200% 100%',animation:'shimmer 1.2s infinite',borderRadius:8}}/>
            ):(
              <div style={{color:T.sub,fontSize:12,lineHeight:1.7,whiteSpace:'pre-wrap'}}>{insight?.text||'AI 분석을 불러오는 중…'}</div>
            )}
            <button onClick={()=>{setInsight(null);}} style={{marginTop:8,background:'none',border:`1px solid ${T.acl}40`,borderRadius:7,padding:'3px 10px',color:T.acl,fontSize:10,cursor:'pointer'}}>🔄 새로 분석</button>
          </Card>

          {/* Strategy explanations */}
          {[
            {strat:'EMA Cross',  emoji:'📈',desc:'20일·50일 이동평균선 교차 전략'},
            {strat:'RSI Oversold',emoji:'📊',desc:'RSI 30 이하 과매도 반등 전략'},
            {strat:'DCA',        emoji:'🔄',desc:'분할 매수 적립 전략'},
          ].map(s=>(
            <Card key={s.strat} style={{padding:'12px 14px',marginBottom:8,cursor:'pointer'}} onClick={()=>{
              setTab('chat');
              setTimeout(()=>{
                setInput(`${s.strat} 전략을 초보자도 이해하기 쉽게 한국어로 설명해줘`);
              },100);
            }}>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <span style={{fontSize:20}}>{s.emoji}</span>
                <div>
                  <div style={{color:T.txt,fontWeight:700,fontSize:12}}>{s.strat}</div>
                  <div style={{color:T.muted,fontSize:10}}>{s.desc} · AI 설명 받기 →</div>
                </div>
              </div>
            </Card>
          ))}

          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'8px 12px',marginTop:4}}>
            <div style={{color:T.ylw,fontSize:10}}>⚠️ AI 분석은 교육 목적입니다. 실제 투자 결정은 공인 투자 전문가와 상담하세요.</div>
          </div>
        </div>
      )}

      {/* ── Chat tab ── */}
      {tab==='chat'&&(
        <div style={{display:'flex',flexDirection:'column',flex:1}}>
          {/* Quick chips */}
          <div style={{display:'flex',gap:5,flexWrap:'wrap',marginBottom:10}}>
            {QUICK_ACTIONS.map(a=>(
              <button key={a.label} onClick={()=>{ setInput(a.msg); }} style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:16,padding:'4px 10px',fontSize:10,cursor:'pointer',fontWeight:600}}>{a.label}</button>
            ))}
          </div>

          {/* Messages */}
          <div style={{flex:1,overflowY:'auto',WebkitOverflowScrolling:'touch' as any,display:'flex',flexDirection:'column',gap:8,marginBottom:10,maxHeight:'55vh'}}>
            {(Array.isArray(msgs)?msgs:[]).map((m,i)=>(
              <div key={i} style={{display:'flex',justifyContent:m.role==='user'?'flex-end':'flex-start'}}>
                <div style={{maxWidth:'85%',background:m.role==='user'?T.acg:T.card,border:`1px solid ${m.role==='user'?T.acl:T.border}`,borderRadius:12,padding:'9px 12px'}}>
                  <div style={{color:m.role==='user'?T.acl:T.txt,fontSize:12,lineHeight:1.65,whiteSpace:'pre-wrap'}}>{m.text}</div>
                  {m.source&&m.source!=='openai'&&<div style={{color:T.muted,fontSize:8,marginTop:3}}>📚 폴백 응답</div>}
                  {m.source==='openai'&&<div style={{color:T.acl,fontSize:8,marginTop:3}}>✅ GPT-4o</div>}
                </div>
              </div>
            ))}
            {loading&&<div style={{display:'flex',justifyContent:'flex-start'}}><div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:'9px 14px',color:T.muted,fontSize:12}}>🤖 분석 중…</div></div>}
            <div ref={endRef}/>
          </div>

          {/* Input */}
          <div style={{display:'flex',gap:8,paddingBottom:'env(safe-area-inset-bottom,0px)'}}>
            <input value={input} onChange={e=>setInput(e.target.value)}
              onKeyDown={e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();} }}
              placeholder="시장 분석, 전략 설명, 레버리지 위험 등 질문하세요…"
              style={{flex:1,background:T.bg,border:`1px solid ${loading?T.border:T.acl}`,borderRadius:12,padding:'10px 14px',color:T.txt,fontSize:14,outline:'none'}}
            />
            <button onClick={sendMsg} disabled={loading||!input.trim()} style={{padding:'10px 14px',background:loading||!input.trim()?'#243A5E':'linear-gradient(135deg,#2563EB,#7C3AED)',color:'#fff',border:'none',borderRadius:12,fontWeight:700,fontSize:13,cursor:loading||!input.trim()?'not-allowed':'pointer',flexShrink:0}}>
              {loading?'…':'전송'}
            </button>
          </div>
          <div style={{color:T.muted,fontSize:9,textAlign:'center',marginTop:5}}>⚠️ 교육 목적 AI · 수익 보장 없음 · 투자 손실은 본인 책임</div>
        </div>
      )}

      {/* ── Signals tab ── */}
      {tab==='signals'&&(
        <div>
          <div style={{color:T.muted,fontSize:10,marginBottom:8,textAlign:'center'}}>⚠️ AI 신호 참고용 · 수익 보장 없음 · 모의투자 전용</div>
          {SIGNALS.map(s=>{
            const clickable = !!onOpenAsset;
            const asAsset = {
              id: s.sym, sym: s.sym, nameKr: s.sym, name: s.sym,
              clr: s.color, p: 0, c: 0, t: 'crypto',
            };
            return (
              <Card key={s.sym} style={{padding:'12px 14px',marginBottom:8,cursor:clickable?'pointer':'default'}}>
                <div
                  onClick={() => { if (onOpenAsset) onOpenAsset(asAsset, 'trading'); }}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onKeyDown={(e) => { if (clickable && (e.key==='Enter'||e.key===' ')) { e.preventDefault(); onOpenAsset?.(asAsset, 'trading'); } }}
                  style={{display:'flex',justifyContent:'space-between',alignItems:'center',minHeight:clickable?40:'auto'}}>
                  <div style={{display:'flex',gap:8,alignItems:'center'}}>
                    <Logo id={s.sym} size={30} clr={s.color} name={s.sym}/>
                    <div>
                      <div style={{color:T.txt,fontWeight:700,fontSize:13}}>{s.sym}</div>
                      <div style={{color:T.muted,fontSize:10}}>{s.reason}</div>
                    </div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div style={{color:s.signal==='매수'?T.grn:s.signal==='매도 관망'?T.red:T.ylw,fontWeight:800,fontSize:12,padding:'3px 10px',background:`${s.signal==='매수'?T.grn:s.signal==='매도 관망'?T.red:T.ylw}15`,borderRadius:8}}>
                      {s.signal}
                    </div>
                    <div style={{color:T.muted,fontSize:9,marginTop:3}}>신뢰도 {s.conf}%</div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
/* ── BacktestPage ── */

export default AIPage;

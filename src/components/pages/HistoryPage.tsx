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


function HistoryPage() {
  const STORE = 'tg_journal_v1';
  const EMOTIONS = ['😊','😔','😤','😰','🤔','😎','🙁','😡'];
  const AI_REVIEWS = [
    '손절 규칙을 잘 지켰습니다. 계획대로 실행하는 것이 중요합니다.',
    '진입 타이밍이 좋았습니다. 지지선에서의 매수는 좋은 전략입니다.',
    'FOMO 진입 가능성이 있습니다. 다음에는 신호를 기다리세요.',
    '목표가 도달 전 조기 청산은 아쉽습니다. 계획을 지켜보세요.',
    '추세 방향과 일치한 거래입니다. 흐름을 읽는 눈이 좋습니다.',
    '손절이 너무 타이트했습니다. ATR 기반 손절을 고려해보세요.',
    '수익 실현 타이밍이 훌륭했습니다. 고점 근처에서 잘 나왔습니다.',
    '거래 횟수가 많습니다. 과거래는 수수료 손실로 이어질 수 있습니다.',
    '포지션 크기가 적절했습니다. 리스크 관리가 잘 되었습니다.',
  ];

  const loadEntries = (): any[] => {
    if (typeof window === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem(STORE) || '[]'); }
    catch { return []; }
  };
  const saveEntries = (arr: any[]) => {
    try { localStorage.setItem(STORE, JSON.stringify(arr)); } catch {}
  };

  const [entries, setEntries] = useState<any[]>(loadEntries);
  const [showAdd, setShowAdd]   = useState(false);
  const [editId, setEditId]     = useState<string|null>(null);
  const [saving, setSaving]     = useState(false);
  const [toast, setToast]       = useState<string|null>(null);
  const [deleteId, setDeleteId] = useState<string|null>(null);

  const EMPTY_FORM = {
    sym:'BTC', side:'매수', entryPrice:'', exitPrice:'', size:'',
    pnl:'', pnlPct:'', date:new Date().toISOString().split('T')[0],
    memo:'', emotion:'😊', rating:3, tags:''
  };
  const [form, setForm] = useState<any>(EMPTY_FORM);

  const showTst = (msg: string) => { setToast(msg); setTimeout(()=>setToast(null), 2500); };

  const computePnl = (f: any) => {
    const entry = parseFloat(f.entryPrice) || 0;
    const exit  = parseFloat(f.exitPrice)  || 0;
    const size  = parseFloat(f.size)       || 0;
    if (!entry || !exit || !size) return { pnl: 0, pnlPct: 0 };
    const raw = f.side === '매수' ? (exit - entry) * size : (entry - exit) * size;
    const pct = entry > 0 ? ((exit - entry) / entry * (f.side === '매수' ? 1 : -1) * 100) : 0;
    return { pnl: Math.round(raw), pnlPct: Math.round(pct * 100) / 100 };
  };

  const openAdd = () => {
    setForm(EMPTY_FORM); setEditId(null); setShowAdd(true);
  };
  const openEdit = (e: any) => {
    setForm({ ...e, entryPrice: e.entryPrice||'', exitPrice: e.exitPrice||'', size: e.size||'', tags: (e.tags||[]).join(',') });
    setEditId(e.id); setShowAdd(true);
  };

  const handleSave = async () => {
    if (!form.sym?.trim()) { showTst('종목을 입력하세요'); return; }
    setSaving(true);
    await new Promise(r => setTimeout(r, 500));
    const computed = computePnl(form);
    const aiReview = AI_REVIEWS[Math.floor(Math.random() * AI_REVIEWS.length)];
    const entry = {
      id: editId || ('j_' + Date.now().toString(36)),
      sym: form.sym.toUpperCase().trim(),
      side: form.side,
      entryPrice: parseFloat(form.entryPrice) || 0,
      exitPrice:  parseFloat(form.exitPrice)  || 0,
      size:       parseFloat(form.size)       || 0,
      pnl:        computed.pnl,
      pnlPct:     computed.pnlPct,
      date:       form.date || new Date().toISOString().split('T')[0],
      memo:       form.memo || '',
      emotion:    form.emotion || '😊',
      rating:     form.rating || 3,
      tags:       form.tags ? form.tags.split(',').map((t:string)=>t.trim()).filter(Boolean) : [],
      aiReview,
      createdAt: new Date().toISOString(),
    };
    const next = editId
      ? entries.map(e => e.id === editId ? entry : e)
      : [entry, ...entries];
    setEntries(next);
    saveEntries(next);
    setSaving(false);
    setShowAdd(false);
    showTst(editId ? '수정되었습니다.' : '매매일지가 저장되었습니다. ✅');
  };

  const handleDelete = (id: string) => {
    const next = entries.filter(e => e.id !== id);
    setEntries(next); saveEntries(next);
    setDeleteId(null); showTst('삭제되었습니다.');
  };

  // Stats
  const total    = entries.length;
  const wins     = entries.filter(e => (e.pnl||0) > 0).length;
  const winRate  = total > 0 ? Math.round(wins / total * 100) : 0;
  const totalPnl = entries.reduce((s, e) => s + (e.pnl||0), 0);

  return (
    <div>
      {/* Toast */}
      {toast && (
        <div style={{position:'fixed',top:16,left:'50%',transform:'translateX(-50%)',zIndex:999,background:T.surf,border:`1px solid ${T.grn}40`,borderRadius:12,padding:'10px 16px',fontSize:12,color:T.txt,fontWeight:700,boxShadow:'0 4px 20px rgba(0,0,0,.4)',whiteSpace:'nowrap',zIndex:999}}>
          {toast}
        </div>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200}} onClick={()=>setDeleteId(null)}/>
          <div style={{position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:201,background:T.surf,borderRadius:18,padding:'22px 20px',width:300,border:`1px solid ${T.red}40`}}>
            <div style={{color:T.red,fontWeight:700,fontSize:15,marginBottom:8}}>🗑 삭제 확인</div>
            <div style={{color:T.muted,fontSize:12,marginBottom:16}}>이 일지를 삭제하시겠습니까?</div>
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>setDeleteId(null)} style={{flex:1,padding:'10px',background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={()=>handleDelete(deleteId)} style={{flex:1,padding:'10px',background:T.red,color:'#fff',border:'none',borderRadius:10,fontWeight:700,cursor:'pointer'}}>삭제</button>
            </div>
          </div>
        </>
      )}

      {/* Add/Edit sheet */}
      {showAdd && (
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200,backdropFilter:'blur(4px)'}} onClick={()=>setShowAdd(false)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',maxHeight:'90vh',overflowY:'auto',WebkitOverflowScrolling:'touch' as any,border:`1px solid ${T.border}`}}>
            <div style={{width:36,height:4,borderRadius:2,background:T.border,margin:'10px auto 12px'}}/>
            <div style={{padding:'0 16px 16px'}}>
              <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:14}}>{editId?'✏️ 수정':'+ 새 매매일지'}</div>

              {/* Symbol + Side */}
              <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
                <div>
                  <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>종목</div>
                  <input value={form.sym} onChange={e=>setForm((p:any)=>({...p,sym:e.target.value.toUpperCase()}))} placeholder="BTC, NVDA, SPY…" style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 11px',color:T.txt,fontSize:16,outline:'none',fontWeight:700}}/>
                </div>
                <div>
                  <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>방향</div>
                  <div style={{display:'flex',gap:5}}>
                    {['매수','매도'].map(s=>(
                      <button key={s} onClick={()=>setForm((p:any)=>({...p,side:s}))} style={{flex:1,padding:'9px',background:form.side===s?(s==='매수'?T.grn:T.red)+'20':T.alt,color:form.side===s?(s==='매수'?T.grn:T.red):T.muted,border:`1px solid ${form.side===s?(s==='매수'?T.grn:T.red):T.border}`,borderRadius:9,fontWeight:700,fontSize:12,cursor:'pointer'}}>{s}</button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Prices */}
              <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginBottom:10}}>
                {[{l:'진입가',k:'entryPrice'},{l:'청산가',k:'exitPrice'},{l:'수량',k:'size'}].map(f=>(
                  <div key={f.k}>
                    <div style={{color:T.muted,fontSize:9,fontWeight:700,marginBottom:3}}>{f.l}</div>
                    <input type="number" inputMode="decimal" value={form[f.k]} onChange={e=>setForm((p:any)=>({...p,[f.k]:e.target.value}))} placeholder="0" style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 9px',color:T.txt,fontSize:16,outline:'none'}}/>
                  </div>
                ))}
              </div>

              {/* Auto PnL preview */}
              {form.entryPrice && form.exitPrice && form.size && (()=>{
                const {pnl, pnlPct} = computePnl(form);
                return (
                  <div style={{background:pnl>=0?T.grn+'12':T.red+'12',border:`1px solid ${pnl>=0?T.grn:T.red}30`,borderRadius:8,padding:'7px 10px',marginBottom:10,display:'flex',gap:10}}>
                    <div><div style={{color:T.muted,fontSize:9}}>예상 PnL</div><div style={{color:pnl>=0?T.grn:T.red,fontWeight:700,fontSize:12,fontFamily:'monospace'}}>{pnl>=0?'+':''}₩{Math.abs(pnl).toLocaleString()}</div></div>
                    <div><div style={{color:T.muted,fontSize:9}}>수익률</div><div style={{color:pnl>=0?T.grn:T.red,fontWeight:700,fontSize:12}}>{pnlPct>=0?'+':''}{pnlPct}%</div></div>
                  </div>
                );
              })()}

              {/* Date */}
              <div style={{marginBottom:10}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>날짜</div>
                <input type="date" value={form.date} onChange={e=>setForm((p:any)=>({...p,date:e.target.value}))} style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 11px',color:T.txt,fontSize:16,outline:'none'}}/>
              </div>

              {/* Memo */}
              <div style={{marginBottom:10}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>메모</div>
                <textarea value={form.memo} onChange={e=>setForm((p:any)=>({...p,memo:e.target.value}))} placeholder="진입 이유, 결과, 배운 점…" rows={3} style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 11px',color:T.txt,fontSize:14,outline:'none',resize:'none',fontFamily:'inherit'}}/>
              </div>

              {/* Emotion */}
              <div style={{marginBottom:10}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>감정</div>
                <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                  {EMOTIONS.map(e=>(
                    <button key={e} onClick={()=>setForm((p:any)=>({...p,emotion:e}))} style={{width:36,height:36,borderRadius:9,background:form.emotion===e?T.acg:T.alt,border:`2px solid ${form.emotion===e?T.acl:T.border}`,cursor:'pointer',fontSize:18}}>{e}</button>
                  ))}
                </div>
              </div>

              {/* Rating */}
              <div style={{marginBottom:10}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>자체 평가</div>
                <div style={{display:'flex',gap:4}}>
                  {[1,2,3,4,5].map(r=>(
                    <button key={r} onClick={()=>setForm((p:any)=>({...p,rating:r}))} style={{fontSize:22,background:'none',border:'none',cursor:'pointer',opacity:r<=form.rating?1:0.25}}>⭐</button>
                  ))}
                </div>
              </div>

              {/* Tags */}
              <div style={{marginBottom:14}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>태그 (쉼표 구분)</div>
                <input value={form.tags} onChange={e=>setForm((p:any)=>({...p,tags:e.target.value}))} placeholder="RSI, 돌파, 손절, DCA…" style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 11px',color:T.txt,fontSize:16,outline:'none'}}/>
              </div>

              {/* Save */}
              <button onClick={handleSave} disabled={saving} style={{width:'100%',padding:'13px',background:saving?'#243A5E':'linear-gradient(135deg,#2563EB,#7C3AED)',color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:saving?'not-allowed':'pointer',marginBottom:6}}>
                {saving?'저장 중…':(editId?'수정 저장':'저장 ✅')}
              </button>
              <div style={{color:T.muted,fontSize:9,textAlign:'center'}}>⚠️ 모의투자 전용 · AI 리뷰 자동 생성</div>
            </div>
          </div>
        </>
      )}

      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div style={{fontWeight:800,fontSize:15,color:T.txt}}>📝 매매일지</div>
        <button onClick={openAdd} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,padding:'6px 14px',fontSize:12,fontWeight:700,cursor:'pointer',minHeight:36}}>+ 추가</button>
      </div>

      {/* Stats */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,marginBottom:14}}>
        {[{l:'총 거래',v:`${total}건`},{l:'수익 거래',v:`${wins}건`},{l:'승률',v:`${winRate}%`},{l:'총 PnL',v:totalPnl>=0?`+₩${Math.abs(totalPnl).toLocaleString()}`:`-₩${Math.abs(totalPnl).toLocaleString()}`,c:totalPnl>=0?T.grn:T.red}].map(x=>(
          <Card key={x.l} style={{padding:'10px 8px',textAlign:'center'}}>
            <div style={{color:T.muted,fontSize:9,marginBottom:3}}>{x.l}</div>
            <div style={{color:(x as any).c||T.txt,fontWeight:800,fontSize:13}}>{x.v}</div>
          </Card>
        ))}
      </div>

      {/* Empty state */}
      {entries.length === 0 ? (
        <div style={{textAlign:'center',padding:'50px 0'}}>
          <div style={{fontSize:40,marginBottom:10}}>📝</div>
          <div style={{color:T.txt,fontWeight:700,fontSize:14,marginBottom:6}}>아직 기록된 매매일지가 없습니다.</div>
          <div style={{color:T.muted,fontSize:11,marginBottom:16}}>첫 거래를 기록해보세요.</div>
          <button onClick={openAdd} style={{padding:'11px 24px',background:'linear-gradient(135deg,#2563EB,#7C3AED)',color:'#fff',border:'none',borderRadius:12,fontWeight:700,fontSize:13,cursor:'pointer'}}>+ 첫 일지 작성</button>
        </div>
      ) : (
        entries.map(e => {
          const pos = (e.pnl||0) >= 0;
          return (
            <Card key={e.id} style={{padding:'14px 16px',marginBottom:10}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <Logo id={e.sym||'BTC'} size={30} clr={pos?T.grn:T.red}/>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:13}}>{e.sym} {e.side}</div>
                    <div style={{color:T.muted,fontSize:10}}>{e.date}</div>
                  </div>
                </div>
                <div style={{display:'flex',gap:5,alignItems:'center'}}>
                  <div style={{textAlign:'right'}}>
                    <div style={{color:pos?T.grn:T.red,fontWeight:800,fontSize:13}}>{pos?'+':''}{e.pnl!=null?`₩${Math.abs(e.pnl).toLocaleString()}`:'—'}</div>
                    <div style={{color:pos?T.grn:T.red,fontSize:10}}>{e.pnlPct!=null?`${e.pnlPct>=0?'+':''}${e.pnlPct}%`:'—'}</div>
                  </div>
                  <div style={{display:'flex',flexDirection:'column',gap:3}}>
                    <button onClick={()=>openEdit(e)} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:6,padding:'3px 7px',fontSize:10,cursor:'pointer',color:T.muted}}>편집</button>
                    <button onClick={()=>setDeleteId(e.id)} style={{background:T.red+'15',border:'none',borderRadius:6,padding:'3px 7px',fontSize:10,cursor:'pointer',color:T.red}}>삭제</button>
                  </div>
                </div>
              </div>
              <div style={{display:'flex',gap:4,alignItems:'center',marginBottom:6}}>
                {Array.from({length:5},(_,i)=><span key={i} style={{fontSize:12,opacity:i<(e.rating||0)?1:0.2}}>⭐</span>)}
                <span style={{marginLeft:4,fontSize:16}}>{e.emotion||'😊'}</span>
                {(e.tags||[]).map((t:string)=>(
                  <span key={t} style={{background:T.alt,color:T.muted,fontSize:8,padding:'1px 5px',borderRadius:4}}>{t}</span>
                ))}
              </div>
              {e.memo && <div style={{color:T.muted,fontSize:11,marginBottom:6,lineHeight:1.5}}>{e.memo}</div>}
              {e.aiReview && (
                <div style={{background:T.acl+'12',border:`1px solid ${T.acl}25`,borderRadius:8,padding:'7px 10px'}}>
                  <div style={{color:T.acl,fontSize:9,fontWeight:700,marginBottom:2}}>🤖 AI 리뷰</div>
                  <div style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{e.aiReview}</div>
                </div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}

/* ── AcademyPage ── */


export default HistoryPage;
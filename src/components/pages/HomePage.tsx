'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR, simulatePriceUpdate } from '@/data/assets';
import type { Asset } from '@/types';
import NewsDetailModal from '@/components/NewsDetailModal';
import { Card, Dot, Spark, Pill, Bdg, Toggle, AreaChart, WorldClock, Heatmap,
         TradingChart, Logo, getBgColor, resolveLogoUrl, getKrName, cleanName, resolveTVSym,
         DonutChart, MiniBar, GlobalSearch, getLeverageRec,
         LiquidationCalc, PositionSizer, RiskDashboard } from './SharedUI';
import { useLogoMap } from '@/lib/hooks/useLogoMap';
import { getFavorites, subscribeFavorites } from '@/lib/favorites';
import { menuById } from '@/lib/menuItems';
import { TrendingUp, Bot, PieChart, GraduationCap, ChevronRight, Wallet } from 'lucide-react';


// 첫 진입 1분 시작 가이드 (한 번만 표시)
function WelcomeGuide({ onNav }: { onNav: (t: string) => void }) {
  const [show, setShow] = React.useState(false);
  React.useEffect(() => {
    try { if (localStorage.getItem('tg_welcome_seen') !== 'true') setShow(true); } catch {}
  }, []);
  if (!show) return null;
  const dismiss = () => { try { localStorage.setItem('tg_welcome_seen', 'true'); } catch {}; setShow(false); };
  const steps = [
    { n: '1', t: '거래소 연결', d: '바이낸스 테스트넷으로 안전하게 시작', dest: 'accounts' },
    { n: '2', t: '전략 선택', d: '공포 DCA·전략빌더로 자동매매 설정', dest: 'strategies' },
    { n: '3', t: '모의매매 실행', d: '가짜 돈으로 먼저 검증 (기본 모드)', dest: 'auto' },
    { n: '4', t: '결과 확인', d: '승률·손익비로 성과 모니터링', dest: 'auto' },
  ];
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={dismiss}>
      <div onClick={e => e.stopPropagation()} className="kb-shrink" style={{ width: '100%', maxWidth: 380, background: T.surf, border: `1px solid ${T.border2}`, borderRadius: 22, padding: '22px 20px', maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ color: T.txt, fontWeight: 900, fontSize: 19, marginBottom: 3 }}>TRAIGO 시작하기</div>
        <div style={{ color: T.muted, fontSize: 12, marginBottom: 18 }}>1분이면 충분해요. 4단계로 시작합니다.</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          {steps.map(s => (
            <button key={s.n} onClick={() => { dismiss(); onNav(s.dest); }}
              style={{ display: 'flex', alignItems: 'center', gap: 12, background: T.alt, border: `1px solid ${T.border}`, borderRadius: 13, padding: '13px 14px', cursor: 'pointer', textAlign: 'left', width: '100%' }}>
              <span style={{ flexShrink: 0, width: 30, height: 30, borderRadius: '50%', background: T.acc, color: '#fff', fontWeight: 800, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{s.n}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: T.txt, fontWeight: 700, fontSize: 13 }}>{s.t}</div>
                <div style={{ color: T.muted, fontSize: 10, marginTop: 1 }}>{s.d}</div>
              </div>
            </button>
          ))}
        </div>
        <div style={{ background: T.ylw + '12', border: `1px solid ${T.ylw}30`, borderRadius: 10, padding: '9px 12px', marginBottom: 14 }}>
          <span style={{ color: T.ylw, fontSize: 10, lineHeight: 1.5 }}>기본은 모의매매예요. 실제 거래는 직접 켜야 작동하니 안심하고 둘러보세요.</span>
        </div>
        <button onClick={dismiss} style={{ width: '100%', padding: '13px', background: T.acc, color: '#fff', border: 'none', borderRadius: 12, fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
          시작하기
        </button>
      </div>
    </div>
  );
}

function HomePage({onNav,prices,currency,lang,onOpenAsset}:{onNav:(t:string)=>void;prices:Asset[];currency:string;lang:string;onOpenAsset?:(a:any,dest?:string)=>void}) {
  const [selectedNews, setSelectedNews] = useState<any>(null);
  const [favs, setFavs] = useState<string[]>([]);
  useEffect(() => { setFavs(getFavorites()); return subscribeFavorites(() => setFavs(getFavorites())); }, []);
  const top5=useMemo(()=>[...prices].sort((a,b)=>b.c-a.c).slice(0,5),[prices]);
  const [autoAll,setAutoAll]=useState(true);

  // top5 자산의 로고 batch 로드
  const logoSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const a of top5) {
      if (a.sym) set.add(String(a.sym).toUpperCase());
      if (a.id)  set.add(String(a.id).toUpperCase());
    }
    return Array.from(set);
  }, [top5]);
  const logoMap = useLogoMap(logoSymbols);

  const LONG_VALUE  = 48500000;
  const SHORT_VALUE = 1230000;
  const CASH_VALUE  = 5000000;
  const TOTAL = LONG_VALUE + SHORT_VALUE + CASH_VALUE;
  const TOTAL_PNL   = 2870000;

  return (
    <div>
      {/* ── 총자산 히어로 ── */}
      <div style={{background:'linear-gradient(145deg,#0D1A35,#091228)',border:`1px solid ${T.border2}`,borderRadius:22,padding:'22px 20px',marginBottom:14,position:'relative',overflow:'hidden'}}>
        <div style={{position:'absolute',right:-40,top:-40,width:200,height:200,background:`radial-gradient(circle,${T.acg} 0%,transparent 70%)`,pointerEvents:'none'}}/>
        <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:6}}><Dot/><span style={{color:T.muted,fontSize:11,fontWeight:600}}>내 총자산 · {tr(lang,'mock')}</span></div>
        <div style={{color:T.txt,fontSize:32,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',letterSpacing:-1.5}}>{cvt(TOTAL,currency)}</div>
        <div style={{display:'flex',alignItems:'center',gap:8,marginTop:8}}>
          <span style={{color:T.muted,fontSize:12}}>오늘 손익</span>
          <span style={{color:TOTAL_PNL>=0?T.grn:T.red,fontWeight:800,fontSize:14}}>{TOTAL_PNL>=0?'+':''}{cvt(Math.abs(TOTAL_PNL),currency)}</span>
          <Bdg c={TOTAL_PNL>=0?T.grn:T.red} ch={fmtPct(TOTAL_PNL/TOTAL*100)}/>
        </div>
      </div>

      {/* ── 자동매매 상태 ── */}
      <button onClick={()=>onNav('auto')} style={{width:'100%',display:'flex',alignItems:'center',gap:12,background:T.card,border:`1px solid ${autoAll?T.grn+'40':T.border}`,borderRadius:16,padding:'14px 16px',marginBottom:16,cursor:'pointer',textAlign:'left'}}>
        <div style={{flexShrink:0,width:40,height:40,borderRadius:11,background:(autoAll?T.grn:T.muted)+'1F',display:'flex',alignItems:'center',justifyContent:'center'}}>
          <Bot size={20} color={autoAll?T.grn:T.muted}/>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:T.txt,fontWeight:800,fontSize:14,display:'flex',alignItems:'center',gap:6}}>자동매매 <span style={{width:7,height:7,borderRadius:'50%',background:autoAll?T.grn:T.muted,display:'inline-block'}}/><span style={{color:autoAll?T.grn:T.muted,fontSize:11,fontWeight:700}}>{autoAll?'실행중':'정지'}</span></div>
          <div style={{color:T.muted,fontSize:11,marginTop:1}}>{autoAll?'EMA 추세 + DCA 실행 중':'탭하여 자동매매 시작'}</div>
        </div>
        <ChevronRight size={18} color={T.muted}/>
      </button>

      {/* ── 핵심 4버튼 (2×2) ── */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:18}}>
        {[
          { t:'매매하기',  d:'직접 사고팔기',   dest:'trading',   Icon:TrendingUp,    c:'#3B82F6' },
          { t:'자동매매',  d:'AI 자동 투자',    dest:'auto',      Icon:Bot,           c:'#8B5CF6' },
          { t:'포트폴리오',d:'내 자산 현황',    dest:'portfolio', Icon:PieChart,      c:'#10B981' },
          { t:'아카데미',  d:'투자 배우기',     dest:'academy',   Icon:GraduationCap, c:'#F59E0B' },
        ].map(a=>(
          <button key={a.dest} onClick={()=>onNav(a.dest)}
            style={{display:'flex',flexDirection:'column',gap:10,background:T.card,border:`1px solid ${T.border}`,borderRadius:18,padding:'18px 16px',cursor:'pointer',textAlign:'left',minHeight:104}}>
            <div style={{width:46,height:46,borderRadius:13,background:a.c+'1F',display:'flex',alignItems:'center',justifyContent:'center'}}>
              <a.Icon size={23} strokeWidth={2.2} color={a.c}/>
            </div>
            <div>
              <div style={{color:T.txt,fontWeight:800,fontSize:15}}>{a.t}</div>
              <div style={{color:T.muted,fontSize:11,marginTop:2}}>{a.d}</div>
            </div>
          </button>
        ))}
      </div>

      {/* ── 즐겨찾기 (홈에 고정한 기능) ── */}
      {favs.length > 0 && (
        <div style={{marginBottom:18}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
            <span style={{color:T.txt,fontWeight:700,fontSize:13}}>즐겨찾기</span>
            <span onClick={()=>onNav('menu_hub')} style={{color:T.acl,fontSize:11,fontWeight:700,cursor:'pointer'}}>편집 ›</span>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10}}>
            {favs.map(id=>{
              const m = menuById(id);
              if (!m) return null;
              const { Icon } = m;
              return (
                <button key={id} onClick={()=>onNav(id)} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:7,background:'transparent',border:'none',cursor:'pointer',padding:'4px 0'}}>
                  <div style={{width:52,height:52,borderRadius:16,background:m.color+'1F',display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <Icon size={24} color={m.color}/>
                  </div>
                  <span style={{color:T.txt,fontSize:10.5,fontWeight:600,textAlign:'center',lineHeight:1.2,wordBreak:'keep-all'}}>{m.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 상위 상승 종목 (가볍게) ── */}
      <Card style={{padding:'14px 16px',marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
          <span style={{color:T.txt,fontWeight:700,fontSize:13}}>상위 상승 종목</span>
          <span onClick={()=>onNav('market')} style={{color:T.acl,fontSize:11,fontWeight:700,cursor:'pointer'}}>더보기 ›</span>
        </div>
        {(Array.isArray(top5)?top5:[]).slice(0,4).map((a,i)=>(
          <div key={a.id} onClick={()=>onOpenAsset && onOpenAsset(a,'trading')} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<3?`1px solid ${T.border}`:'none',cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <Logo id={a.id} size={30} clr={a.clr} name={a.nameKr} logoUrl={logoMap[String(a.sym || a.id).toUpperCase()] || logoMap[String(a.id).toUpperCase()]}/>
              <div><div style={{color:T.txt,fontWeight:600,fontSize:12}}>{a.nameKr}</div><div style={{color:T.muted,fontSize:10}}>{a.sym}</div></div>
            </div>
            <div style={{textAlign:'right'}}>
              <div style={{color:T.txt,fontWeight:700,fontSize:11,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{cvt(a.p,currency)}</div>
              <div style={{color:a.c>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{fmtPct(a.c)}</div>
            </div>
          </div>
        ))}
      </Card>

      {/* ── 최신 뉴스 (가볍게) ── */}
      <Card style={{padding:'14px 16px',marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
          <span style={{color:T.txt,fontWeight:700,fontSize:13}}>최신 뉴스</span>
          <span onClick={()=>onNav('news')} style={{color:T.acl,fontSize:11,fontWeight:700,cursor:'pointer'}}>더보기 ›</span>
        </div>
        {MOCK_NEWS.slice(0,3).map((n,i)=>(
          <div key={n.id} role="button" tabIndex={0}
            onClick={()=>setSelectedNews({...n,publishedAt:n.time,summary:(n as any).summary||n.title,content:(n as any).content||(n as any).summary||n.title,tickers:Array.isArray((n as any).tickers)?(n as any).tickers:[]})}
            style={{padding:'10px 8px',margin:'0 -8px',borderRadius:8,borderBottom:i<2?`1px solid ${T.border}`:'none',cursor:'pointer',display:'flex',alignItems:'center',gap:8}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
                <Bdg c={n.sentiment==='bullish'?T.grn:T.red} ch={n.category}/>
                <span style={{color:T.muted,fontSize:10}}>{n.time}</span>
              </div>
              <div style={{color:T.txt,fontSize:12,fontWeight:600,lineHeight:1.4}}>{n.title}</div>
            </div>
            <ChevronRight size={16} color={T.muted} style={{flexShrink:0}}/>
          </div>
        ))}
      </Card>

      <NewsDetailModal
        news={selectedNews}
        onClose={() => setSelectedNews(null)}
        onTickerClick={(t) => {
          setSelectedNews(null);
          if (onOpenAsset) onOpenAsset({ id: t, sym: t, nameKr: t, name: t, p: 0, c: 0, v:'-', t:'coin', clr:'#3B82F6' }, 'trading');
          else onNav('market');
        }}
      />
    </div>
  );
}


export default HomePage;

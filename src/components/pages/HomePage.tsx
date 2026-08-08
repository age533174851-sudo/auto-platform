'use client';
import { A } from '@/lib/theme/colors';
import type { ScheduleDisplay } from '@/lib/engine/decisionTrace';
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
import { TrendingUp, Bot, PieChart, GraduationCap, ChevronRight, Wallet, LogIn, Sparkles } from 'lucide-react';


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
        <div style={{ background: A(T.ylw,'12'), border: `1px solid ${A(T.ylw,'30')}`, borderRadius: 10, padding: '9px 12px', marginBottom: 14 }}>
          <span style={{ color: T.ylw, fontSize: 10, lineHeight: 1.5 }}>기본은 모의매매예요. 실제 거래는 직접 켜야 작동하니 안심하고 둘러보세요.</span>
        </div>
        <button onClick={dismiss} style={{ width: '100%', padding: '13px', background: T.acc, color: '#fff', border: 'none', borderRadius: 12, fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
          시작하기
        </button>
      </div>
    </div>
  );
}

function HomePage({onNav,prices,currency,lang,onOpenAsset,authUser,onLogin}:{onNav:(t:string)=>void;prices:Asset[];currency:string;lang:string;onOpenAsset?:(a:any,dest?:string)=>void;authUser?:any;onLogin?:()=>void}) {
  const [selectedNews, setSelectedNews] = useState<any>(null);
  const [favs, setFavs] = useState<string[]>([]);
  useEffect(() => { setFavs(getFavorites()); return subscribeFavorites(() => setFavs(getFavorites())); }, []);
  const top5=useMemo(()=>[...prices].sort((a,b)=>b.c-a.c).slice(0,5),[prices]);
  // ── 자동매매 상태는 지어내지 않는다 ──
  //
  // **`useState(true)`였다.** 그래서 홈은 화면을 열자마자 "자동매매
  // 실행중 · EMA 추세 + DCA 실행 중"이라고 적었다. 실행기를 물어본
  // 적도 없고, 그 두 전략이 실제로 돌고 있는지도 확인한 적이 없다.
  //
  // 사용자는 그 문장을 보고 앱을 닫는다. 그리고 아무것도 돌지 않는다.
  const [autoState, setAutoState] = useState<ScheduleDisplay | null>(null);

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

  // ── 총자산도 지어내지 않는다 ──
  //
  // 여기에 이런 값이 박혀 있었다:
  //
  //   LONG_VALUE  = 48500000
  //   SHORT_VALUE = 1230000
  //   CASH_VALUE  = 5000000
  //   TOTAL_PNL   = 2870000
  //
  // 4,850만원이 실제 총자산처럼, 287만원이 오늘 손익처럼 떴다.
  // **이건 예시라고 어디에도 안 적혀 있었다.** 사용자는 자기 계좌를
  // 보고 있다고 믿는다 — 그 숫자를 근거로 자금을 더 넣거나 뺀다.
  //
  // 홈은 계좌를 직접 조회하지 않는다(홈이 무거워지면 첫 화면이 늦다).
  // 대신 **모른다고 적고 지갑으로 보낸다.** 그게 그럴듯한 숫자보다 낫다.
  const [equity, setEquity] = useState<{ total: number | null; note: string }>(
    { total: null, note: '' });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [{ loadExchangeConnectionsResult }, wa, dt] = await Promise.all([
          import('@/lib/supabase/hooks'),
          import('@/lib/portfolio/walletAccounts'),
          import('@/lib/engine/decisionTrace'),
        ]);
        if (!alive) return;

        // 자동매매: 예약이 있는지 / 켜져 있는지 / 마지막에 언제 돌았는지.
        // 셋은 서로 다른 사실이고, 하나로 뭉개면 "실행중"이 거짓이 된다.
        setAutoState(dt.scheduleDisplay({ scheduleCount: 0, enabledCount: null }));

        const r = await loadExchangeConnectionsResult();
        if (!alive) return;
        if (!r.ok) {
          setEquity({ total: null, note: '계좌 목록을 확인하지 못했습니다 — 자산이 없다는 뜻이 아닙니다' });
          return;
        }
        const accts = wa.accountsFromConnections(r.connections);
        if (accts.length === 0) {
          setEquity({ total: null, note: '연결된 거래소 계좌가 없습니다' });
          return;
        }
        // 계좌가 있다는 것까지만 안다. 잔고는 지갑에서 읽는다 —
        // 여기서 또 조회하면 지갑과 홈이 서로 다른 순간의 값을 보여 준다.
        setEquity({ total: null, note: `연결된 계좌 ${accts.length}개 · 잔고는 지갑에서 확인하세요` });
      } catch {
        if (alive) setEquity({ total: null, note: '자산을 확인하지 못했습니다' });
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div>
      {/* ── 비로그인 로그인 유도 카드 (설정 안 들어가도 홈에서 바로) ── */}
      {!authUser && onLogin && (
        <button onClick={onLogin} aria-label="로그인하기" style={{width:'100%',minHeight:44,textAlign:'left',display:'flex',alignItems:'center',gap:12,background:`linear-gradient(135deg,${T.acc},${T.prp})`,border:'none',borderRadius:18,padding:'16px 18px',marginBottom:14,cursor:'pointer'}}>
          <div style={{width:40,height:40,borderRadius:12,background:'rgba(255,255,255,0.18)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
            <LogIn size={20} color="#fff"/>
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{color:'#fff',fontWeight:800,fontSize:14,display:'flex',alignItems:'center',gap:5}}>TRAIGO 시작하기 <Sparkles size={13} color="#fff"/></div>
            <div style={{color:'rgba(255,255,255,0.85)',fontSize:11,marginTop:2}}>로그인하면 포트폴리오 저장·자동매매·실전 연결까지</div>
          </div>
          <ChevronRight size={20} color="#fff" style={{flexShrink:0}}/>
        </button>
      )}
      {/* ── 총자산 히어로 ── */}
      <div style={{background:'linear-gradient(145deg,var(--t-card),var(--t-bg))',border:`1px solid ${T.border2}`,borderRadius:22,padding:'22px 20px',marginBottom:14,position:'relative',overflow:'hidden'}}>
        <div style={{position:'absolute',right:-40,top:-40,width:200,height:200,background:`radial-gradient(circle,${T.acg} 0%,transparent 70%)`,pointerEvents:'none'}}/>
        <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:6}}><Dot/><span style={{color:T.muted,fontSize:11,fontWeight:600}}>내 총자산</span></div>
        {/* **못 읽은 것을 숫자로 그리지 않는다.** 0도 아니고 예시도 아니다. */}
        <div style={{color:equity.total==null?T.muted:T.txt,fontSize:equity.total==null?20:32,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',letterSpacing:equity.total==null?0:-1.5}}>
          {equity.total==null?'확인 불가':cvt(equity.total,currency)}
        </div>
        <div style={{color:T.muted,fontSize:10.5,marginTop:6,lineHeight:1.55}}>
          {equity.note || '자산을 읽는 중…'}
        </div>
        <button onClick={()=>onNav('wallet')} style={{marginTop:10,minHeight:34,padding:'6px 12px',borderRadius:9,background:T.acg,color:T.acl,border:`1px solid ${T.acl}`,fontSize:11,fontWeight:800,cursor:'pointer'}}>
          지갑에서 자산 보기
        </button>
      </div>

      {/* ── 자동매매 상태 ── */}
      {/* **켜짐과 돌고 있음은 다른 사실이다.**
          예전에는 useState(true)로 시작해 무조건 "실행중 · EMA 추세 + DCA
          실행 중"이라고 적었다. 실행기를 물어본 적이 없다. 사용자는 그
          문장을 보고 앱을 닫고, 아무것도 돌지 않는다. */}
      {(() => {
        const running = autoState?.running === true;
        const c = running ? T.grn : T.muted;
        return (
          <button onClick={()=>onNav('auto')} style={{width:'100%',display:'flex',alignItems:'center',gap:12,background:T.card,border:`1px solid ${running?A(T.grn,'40'):T.border}`,borderRadius:16,padding:'14px 16px',marginBottom:16,cursor:'pointer',textAlign:'left'}}>
            <div style={{flexShrink:0,width:40,height:40,borderRadius:11,background:c+'1F',display:'flex',alignItems:'center',justifyContent:'center'}}>
              <Bot size={20} color={c}/>
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{color:T.txt,fontWeight:800,fontSize:14,display:'flex',alignItems:'center',gap:6}}>
                자동매매
                <span style={{width:7,height:7,borderRadius:'50%',background:c,display:'inline-block'}}/>
                <span style={{color:c,fontSize:11,fontWeight:700}}>
                  {autoState==null?'확인 중':running?'실행 중':'정지'}
                </span>
              </div>
              <div style={{color:T.muted,fontSize:10.5,marginTop:2,lineHeight:1.5}}>
                {autoState?.text ?? '실행기 상태를 확인하고 있습니다'}
              </div>
            </div>
            <ChevronRight size={18} color={T.muted}/>
          </button>
        );
      })()}

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

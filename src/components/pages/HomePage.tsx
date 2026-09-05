'use client';
import { A } from '@/lib/theme/colors';
import { probeAuthToken } from '@/lib/auth/authToken';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, ECON_EVENTS } from '@/lib/constants';
import {
  toFeed, errorFeed, feedTitle, feedBadge, itemTime, itemSource,
  LOADING_FEED, type NewsFeed,
} from '@/lib/news/feed';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
// 지갑 숫자는 **USD 기준**이다. cvt()는 입력이 KRW라고 가정하므로
// 여기 쓰면 원화 기호만 붙거나 환율로 나눠 버린다 — 둘 다 몇 배 틀린다.
import { moneyView } from '@/lib/portfolio/walletMoney';
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
  // ── 자동매매가 실제로 돌고 있는가 ──
  //
  // **예전에는 `useState(true)`였다.** 예약이 전부 꺼져 있어도 홈은
  // "실행중"이라고 적었다. 켜져 있다는 사실조차 아닌, 그냥 화면의 기본값이다.
  //
  // 판정은 서버가 한다(`workerPlan`) — 화면이 배지를 합산하면 관제판과
  // 다른 말을 하게 된다. **못 읽으면 '확인 못 함'이지 '실행중'이 아니다.**
  const [autoPlan,setAutoPlan]=useState<any>(null);
  const [autoErr,setAutoErr]=useState(false);
  /** 확실히 로그아웃. '확인 못 함'과 다른 말이므로 따로 둔다 */
  const [autoOut,setAutoOut]=useState(false);
  useEffect(()=>{
    let alive=true;
    (async()=>{
      try{
        // 예전에는 legacy `localStorage.sb_access_token`을 읽고, 비면
        // **아무 상태도 세우지 않고 그냥 반환**했다. 그러면 autoPlan도
        // autoErr도 그대로라 라벨이 영구히 '읽는 중…'에 멈춘다 — 실패를
        // 실패로 적지 않고 아직 읽는 중인 척한다. 정본 경로로 바꾸면서
        // 그 조용한 반환도 없앤다.
        const auth = await probeAuthToken();
        if(!alive) return;
        if(auth===null){ setAutoErr(true); return; }   // 확인하지 못했다
        if(!auth){ setAutoOut(true); return; }         // 확실히 로그아웃
        const r = await fetch('/api/autotrade/schedule',{headers:{Authorization:auth}});
        const j = await r.json();
        if(!alive) return;
        if(j?.ok && j.plan) setAutoPlan(j.plan); else setAutoErr(true);
      }catch{ if(alive) setAutoErr(true); }
    })();
    return()=>{alive=false;};
  },[]);
  const autoOn = autoPlan?.code === 'HEALTHY';
  const autoLabel = autoPlan
    ? (autoPlan.code==='IDLE' ? '정지' : autoPlan.code==='HEALTHY' ? '실행중' : '확인 필요')
    : (autoOut ? '로그인 필요' : autoErr ? '확인 못 함' : '읽는 중…');
  const autoNote = autoPlan?.headline
    ?? (autoOut ? '로그인하면 자동매매 상태를 읽습니다'
      : autoErr ? '자동매매 상태를 읽지 못했습니다' : '');

  /* ── 뉴스는 서버에서 읽는다 ──
     예전에는 `MOCK_NEWS` 상수를 그대로 그리면서 제목을 '최신 뉴스'라고
     적었다. 그 안에는 실제 매체명(CoinDesk·Reuters)과 실제 주소, 구체적인
     가격, 그리고 언제 열어도 "5분 전"인 시각이 들어 있었다. 예시라는
     표시는 어디에도 없었다.

     라우트는 이미 출처를 알려 준다 — 공급자에서 못 받으면
     `source: 'mock'`으로 답한다. 그동안 화면이 그 필드를 안 봤을 뿐이다.
     판정과 문구는 lib/news/feed에 있고 테스트가 붙어 있다. */
  const [feed,setFeed]=useState<NewsFeed>(LOADING_FEED);
  useEffect(()=>{
    let alive=true;
    (async()=>{
      try{
        const r=await fetch('/api/news?action=latest&cat=general',{signal:AbortSignal.timeout(12000)});
        const j=await r.json().catch(()=>null);
        if(!alive) return;
        setFeed(r.ok ? toFeed(j) : errorFeed(`뉴스를 읽지 못했습니다 (HTTP ${r.status})`));
      }catch{
        if(alive) setFeed(errorFeed());
      }
    })();
    return()=>{alive=false;};
  },[]);

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

  // ── 총자산 ──
  //
  // **예전에는 여기에 4,850만 원이 적혀 있었다.** 하드코딩이다.
  // 로그인하지 않아도, 계좌를 붙이지 않아도 같은 숫자가 나왔다.
  //
  // 지금은 지갑과 **같은 곳**에서 읽는다(`/api/wallets/overview`).
  // 홈이 자기 숫자를 따로 계산하면 지갑과 홈이 다른 총자산을 보여준다.
  // **못 읽으면 숫자를 만들지 않는다** — '확인하지 못했습니다'라고 적는다.
  const [wallet,setWallet]=useState<any>(null);
  const [walletErr,setWalletErr]=useState('');
  useEffect(()=>{
    let alive=true;
    (async()=>{
      try{
        // 정본 경로 하나만 쓴다. '로그인 안 됨'과 '확인 못 함'을 가른다 —
        // 세션이 멀쩡한데 잠깐 못 읽은 것을 "로그인하세요"라고 적으면,
        // 이미 로그인한 사용자가 자기 계정을 의심한다.
        const auth = await probeAuthToken();
        if(!alive) return;
        if(auth===null){ setWalletErr('로그인 상태를 확인하지 못했습니다'); return; }
        if(!auth){ setWalletErr('로그인하면 실제 자산을 읽습니다'); return; }
        const r = await fetch('/api/wallets/overview',{headers:{Authorization:auth}});
        const j = await r.json();
        if(!alive) return;
        if(j?.ok) setWallet(j);
        else setWalletErr(String(j?.message||j?.error||'자산을 읽지 못했습니다'));
      }catch(e:any){ if(alive) setWalletErr(`자산을 읽지 못했습니다 (${e?.message||e})`); }
    })();
    return()=>{alive=false;};
  },[]);

  // **환경을 합치지 않는다.** 실전이 있으면 실전을, 없으면 테스트넷을
  // 보여주고 어느 환경인지 라벨로 밝힌다. 둘을 더한 숫자는 뜻이 없다.
  const shownEnv = (()=>{
    const envs:any[] = Array.isArray(wallet?.envs)?wallet.envs:[];
    const live = envs.find((e:any)=>e.env==='LIVE' && e.connections>0);
    return live ?? envs.find((e:any)=>e.connections>0) ?? null;
  })();
  // **총자산은 서버가 만든 canonical 값 하나만 쓴다.**
  //
  // 예전에는 `shownEnv.futures`(선물 **지갑잔고**)를 '내 총자산'이라고
  // 적었다. 현물도, 미실현손익도 빠진 값이다 — 현물에 BTC가 있어도
  // 홈에서는 없는 돈이었고, 같은 계좌가 지갑 화면과 다른 총자산을
  // 보였다. 화면이 자기 방식으로 합치면 언제나 이렇게 갈린다.
  const totalCell = shownEnv?.total ?? null;

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
        <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:6}}><Dot/><span style={{color:T.muted,fontSize:11,fontWeight:600}}>
          내 총자산{shownEnv? ` · ${shownEnv.env}`:''}
        </span></div>
        {/* **못 읽으면 숫자를 만들지 않는다.** 0을 그리면 사용자는 돈이
            사라졌다고 믿고, 하드코딩을 그리면 없는 돈을 셈한다. */}
        <div style={{color:totalCell?.value==null?T.muted:T.txt,fontSize:totalCell?.value==null?15:32,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',letterSpacing:totalCell?.value==null?0:-1.5,overflowWrap:'anywhere'}}>
          {totalCell?.value==null
            ? (walletErr || totalCell?.text || '확인하지 못했습니다')
            : moneyView(totalCell.value,currency as any).text}
        </div>
        {shownEnv?.unrealizedPnl?.value!=null && (
          <div style={{display:'flex',alignItems:'center',gap:8,marginTop:8}}>
            <span style={{color:T.muted,fontSize:12}}>미실현 손익</span>
            <span style={{color:shownEnv.unrealizedPnl.value>=0?T.grn:T.red,fontWeight:800,fontSize:14}}>
              {shownEnv.unrealizedPnl.value>=0?'+':''}{moneyView(Math.abs(shownEnv.unrealizedPnl.value),currency as any).text}
            </span>
          </div>
        )}
        {shownEnv?.note && (
          <div style={{color:T.muted,fontSize:10,marginTop:6,overflowWrap:'anywhere'}}>{shownEnv.note}</div>
        )}
      </div>

      {/* ── 자동매매 상태 ── */}
      <button onClick={()=>onNav('auto')} style={{width:'100%',display:'flex',alignItems:'center',gap:12,background:T.card,border:`1px solid ${autoOn?A(T.grn,'40'):T.border}`,borderRadius:16,padding:'14px 16px',marginBottom:16,cursor:'pointer',textAlign:'left'}}>
        <div style={{flexShrink:0,width:40,height:40,borderRadius:11,background:(autoOn?T.grn:T.muted)+'1F',display:'flex',alignItems:'center',justifyContent:'center'}}>
          <Bot size={20} color={autoOn?T.grn:T.muted}/>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:T.txt,fontWeight:800,fontSize:14,display:'flex',alignItems:'center',gap:6}}>자동매매 <span style={{width:7,height:7,borderRadius:'50%',background:autoOn?T.grn:T.muted,display:'inline-block'}}/><span style={{color:autoOn?T.grn:T.muted,fontSize:11,fontWeight:700}}>{autoLabel}</span></div>
          <div style={{color:T.muted,fontSize:11,marginTop:1,overflowWrap:'anywhere'}}>{autoNote||'탭하여 자동매매 시작'}</div>
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

      {/* ── 뉴스 ──
          제목이 출처를 따라간다. 실물일 때만 '최신 뉴스'다. */}
      <Card style={{padding:'14px 16px',marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,gap:8}}>
          <span style={{display:'flex',alignItems:'center',gap:6,minWidth:0}}>
            <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{feedTitle(feed.provenance)}</span>
            {feedBadge(feed.provenance)&&(
              <span style={{background:A(T.ylw,'20'),color:T.ylw,border:`1px solid ${A(T.ylw,'40')}`,fontSize:9,fontWeight:800,padding:'1px 6px',borderRadius:99}}>
                {feedBadge(feed.provenance)}
              </span>
            )}
          </span>
          <span onClick={()=>onNav('news')} style={{color:T.acl,fontSize:11,fontWeight:700,cursor:'pointer',flexShrink:0}}>더보기 ›</span>
        </div>
        {feed.note&&(
          <div style={{color:T.muted,fontSize:10,marginBottom:8,lineHeight:1.45,overflowWrap:'anywhere'}}>{feed.note}</div>
        )}
        {feed.items.slice(0,3).map((n,i)=>(
          <div key={n.id} role="button" tabIndex={0}
            onClick={()=>setSelectedNews({...(n as any),publishedAt:n.time,summary:n.summary||n.title,content:n.content||n.summary||n.title,tickers:n.tickers||[]})}
            style={{padding:'10px 8px',margin:'0 -8px',borderRadius:8,borderBottom:i<Math.min(feed.items.length,3)-1?`1px solid ${T.border}`:'none',cursor:'pointer',display:'flex',alignItems:'center',gap:8}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
                <Bdg c={n.sentiment==='bullish'?T.grn:T.red} ch={n.category}/>
                {/* 예시 기사에는 시각·매체를 적지 않는다 — 방금 들어온
                    기사처럼 보이고, 그 매체가 낸 것처럼 읽힌다. */}
                {itemTime(feed.provenance,n.time)&&<span style={{color:T.muted,fontSize:10}}>{itemTime(feed.provenance,n.time)}</span>}
                {itemSource(feed.provenance,n.source)&&<span style={{color:T.muted,fontSize:10}}>· {itemSource(feed.provenance,n.source)}</span>}
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

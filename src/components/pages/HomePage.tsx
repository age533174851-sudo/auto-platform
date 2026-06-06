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
import { BarChart3, Bot, Wallet, ChevronRight } from 'lucide-react';


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
      <WelcomeGuide onNav={onNav} />

      {/* 베타 상태 배지 */}
      <div style={{background:'linear-gradient(135deg,#0D1A35,#0A1428)',border:`1px solid ${T.border2}`,borderRadius:14,padding:'12px 14px',marginBottom:12}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
          <span style={{width:7,height:7,borderRadius:'50%',background:T.grn,display:'inline-block'}}/>
          <span style={{color:T.txt,fontWeight:800,fontSize:13}}>TRAIGO 베타</span>
          <span style={{marginLeft:'auto',color:T.muted,fontSize:9}}>투자 시뮬레이션 플랫폼</span>
        </div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          <span style={{fontSize:9,color:T.grn,background:T.grn+'15',padding:'2px 8px',borderRadius:5,fontWeight:700}}>✓ 실시간 데이터</span>
          <span style={{fontSize:9,color:T.acl,background:T.acl+'15',padding:'2px 8px',borderRadius:5,fontWeight:700}}>✓ 모의매매</span>
          <span style={{fontSize:9,color:T.ylw,background:T.ylw+'15',padding:'2px 8px',borderRadius:5,fontWeight:700}}>△ 실거래 연결 (테스트넷)</span>
        </div>
      </div>

      {/* 3개 핵심 액션 — 뭐부터 할지 */}
      <div style={{marginBottom:14}}>
        <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:8,paddingLeft:2}}>무엇을 하고 싶으세요?</div>
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {[
            { ic: BarChart3, t: '시장 보기', d: '실시간 코인·주식 가격 확인', dest: 'market', c: T.acl },
            { ic: Bot,       t: '자동매매 시작', d: 'AI·전략으로 자동 투자', dest: 'auto', c: T.prp },
            { ic: Wallet,    t: '포트폴리오 관리', d: '보유 자산 추적·분석', dest: 'portfolio', c: T.grn },
          ].map(a => (
            <button key={a.dest} onClick={() => onNav(a.dest)}
              style={{display:'flex',alignItems:'center',gap:12,background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:'14px 16px',cursor:'pointer',textAlign:'left',width:'100%'}}>
              <div style={{flexShrink:0,width:42,height:42,borderRadius:11,background:a.c+'18',display:'flex',alignItems:'center',justifyContent:'center'}}>
                <a.ic size={20} strokeWidth={2.2} color={a.c}/>
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{color:T.txt,fontWeight:800,fontSize:14}}>{a.t}</div>
                <div style={{color:T.muted,fontSize:11,marginTop:1}}>{a.d}</div>
              </div>
              <ChevronRight size={18} color={T.muted}/>
            </button>
          ))}
        </div>
      </div>

      {/* Risk warning */}
      <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:12,padding:'9px 13px',marginBottom:12,display:'flex',gap:8,alignItems:'flex-start'}}>
        <span style={{flexShrink:0}}>⚠️</span>
        <span style={{color:T.ylw,fontSize:11,fontWeight:600,lineHeight:1.5}}>{tr(lang,'warning')}</span>
      </div>

      {/* Total asset banner */}
      <div style={{background:'linear-gradient(145deg,#0D1A35,#091228)',border:`1px solid ${T.border2}`,borderRadius:22,padding:'22px 20px',marginBottom:14,position:'relative',overflow:'hidden'}}>
        <div style={{position:'absolute',right:-40,top:-40,width:200,height:200,background:`radial-gradient(circle,${T.acg} 0%,transparent 70%)`,pointerEvents:'none'}}/>
        <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:4}}><Dot/><span style={{color:T.muted,fontSize:11,fontWeight:600}}>헤지펀드 포트폴리오 · {tr(lang,'mock')}</span></div>
        <div style={{color:T.muted,fontSize:12,marginBottom:2}}>총 평가 자산</div>
        <div style={{color:T.txt,fontSize:30,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',letterSpacing:-1.5}}>{cvt(TOTAL,currency)}</div>
        <div style={{display:'flex',alignItems:'center',gap:10,marginTop:6}}>
          <span style={{color:T.grn,fontWeight:700,fontSize:13}}>▲ +{cvt(TOTAL_PNL,currency)}</span>
          <Bdg c={T.grn} ch={"+"+fmtPct(TOTAL_PNL/TOTAL*100)+" 총수익"}/>
        </div>
        <div style={{display:'flex',gap:8,marginTop:16,flexWrap:'wrap'}}>
          <button onClick={()=>onNav('portfolio')} style={{background:T.acc,color:'#fff',border:'none',borderRadius:12,padding:'11px 18px',fontWeight:800,fontSize:13,cursor:'pointer'}}>포트폴리오</button>
          <button onClick={()=>onNav('trading')} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:12,padding:'11px 18px',fontWeight:700,fontSize:13,cursor:'pointer'}}>매매하기</button>
        </div>
      </div>

      {/* Dual portfolio cards */}
      <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
        <Card style={{padding:'14px 16px',cursor:'pointer'}} glow={false}>
          <div onClick={()=>onNav('portfolio')} style={{cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:6}}>
              <span style={{fontSize:14}}>📈</span>
              <span style={{color:T.muted,fontSize:10,fontWeight:700}}>장투 포트폴리오</span>
            </div>
            <div style={{color:T.txt,fontSize:15,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{cvt(LONG_VALUE,currency)}</div>
            <div style={{color:T.grn,fontSize:11,fontWeight:700,marginTop:2}}>+{cvt(1820000,currency)}</div>
            <div style={{marginTop:8,height:4,background:'#1A2D4A',borderRadius:2}}><div style={{height:'100%',width:'60%',background:T.acl,borderRadius:2}}/></div>
            <div style={{color:T.muted,fontSize:9,marginTop:3}}>배분 60% · 레버 없음</div>
          </div>
        </Card>
        <Card style={{padding:'14px 16px',cursor:'pointer'}}>
          <div onClick={()=>onNav('portfolio')} style={{cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:6}}>
              <span style={{fontSize:14}}>⚡</span>
              <span style={{color:T.muted,fontSize:10,fontWeight:700}}>단타 포트폴리오</span>
            </div>
            <div style={{color:T.txt,fontSize:15,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{cvt(SHORT_VALUE,currency)}</div>
            <div style={{color:T.grn,fontSize:11,fontWeight:700,marginTop:2}}>+{cvt(87000,currency)}</div>
            <div style={{marginTop:8,height:4,background:'#1A2D4A',borderRadius:2}}><div style={{height:'100%',width:'30%',background:T.ylw,borderRadius:2}}/></div>
            <div style={{color:T.muted,fontSize:9,marginTop:3}}>배분 30% · 최대 10배</div>
          </div>
        </Card>
      </div>

      {/* Status cards */}
      <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
        {[
          {icon:'',l:'DCA 적립',v:'주 3회 실행',sub:'다음 매수 내일',c:T.acl},
          {icon:'',l:'오늘 단타',v:'+₩87,000',sub:'승률 67% (2/3)',c:T.grn},
        ].map(x=>(
          <Card key={x.l} style={{padding:'14px 16px'}}>
            <div style={{display:'flex',alignItems:'center',gap:4,marginBottom:6}}><span style={{fontSize:14}}>{x.icon}</span><div style={{color:T.muted,fontSize:10,fontWeight:600}}>{x.l}</div></div>
            <div style={{color:x.c,fontSize:14,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{x.v}</div>
            <div style={{color:T.muted,fontSize:10,marginTop:3}}>{x.sub}</div>
          </Card>
        ))}
      </div>

      {/* Auto trading */}
      <Card style={{padding:'14px 18px',marginBottom:12}} glow={autoAll}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:2}}>자동매매 <Bdg c={autoAll?T.grn:T.muted} ch={autoAll?'실행중':'정지'}/></div>
            <div style={{color:T.muted,fontSize:11}}>{autoAll?'EMA 추세 + DCA 실행 중':'정지됨'}</div>
          </div>
          <Toggle on={autoAll} onChange={setAutoAll}/>
        </div>
      </Card>

      {/* Risk status */}
      <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.grn}20`}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:10}}>리스크 현황</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
          {[{l:'전체 리스크',v:'낮음',c:T.grn},{l:'장투 건전성',v:'우수',c:T.grn},{l:'단타 손실',v:'0%',c:T.grn}].map(r=>(
            <div key={r.l} style={{textAlign:'center'}}>
              <div style={{color:T.muted,fontSize:9,marginBottom:3}}>{r.l}</div>
              <Bdg c={r.c} ch={r.v}/>
            </div>
          ))}
        </div>
      </Card>

      {/* Top movers */}
      <Card style={{padding:'14px 16px',marginBottom:12}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:10}}>상위 상승 종목</div>
        {(Array.isArray(top5)?top5:[]).map((a,i)=>(
          <div key={a.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'7px 0',borderBottom:i<4?`1px solid ${T.border}`:'none'}}>
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

      {/* News */}
      <Card style={{padding:'14px 16px',marginBottom:12}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:10}}>최신 뉴스</div>
        {MOCK_NEWS.slice(0,3).map((n,i)=>(
          <div key={n.id} role="button" tabIndex={0}
            onClick={()=>setSelectedNews({
            ...n,
            publishedAt: n.time,
            summary: (n as any).summary || n.title,
            content: (n as any).content || (n as any).summary || n.title,
            tickers: Array.isArray((n as any).tickers) ? (n as any).tickers : [],
          })}
            onKeyDown={(e)=>{ if(e.key==='Enter'){ setSelectedNews({...n,publishedAt:n.time,summary:(n as any).summary||n.title,content:(n as any).content||(n as any).summary||n.title,tickers:Array.isArray((n as any).tickers)?(n as any).tickers:[]}); } }}
            style={{padding:'10px 8px',margin:'0 -8px',borderRadius:8,borderBottom:i<2?`1px solid ${T.border}`:'none',cursor:'pointer',display:'flex',alignItems:'center',gap:8,WebkitTapHighlightColor:'transparent',transition:'background .12s'}}
            onTouchStart={(e)=>{(e.currentTarget as HTMLElement).style.background=T.alt;}}
            onTouchEnd={(e)=>{(e.currentTarget as HTMLElement).style.background='transparent';}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
                <Bdg c={n.sentiment==='bullish'?T.grn:T.red} ch={n.category}/>
                <span style={{color:T.muted,fontSize:10}}>{n.time}</span>
              </div>
              <div style={{color:T.txt,fontSize:12,fontWeight:600,lineHeight:1.4}}>{n.title}</div>
            </div>
            <span style={{color:T.muted,fontSize:14,flexShrink:0}}>›</span>
          </div>
        ))}
        <div onClick={()=>onNav('news')} style={{textAlign:'center',color:T.acl,fontSize:11,fontWeight:700,padding:'10px 0 0',cursor:'pointer',borderTop:`1px solid ${T.border}`}}>
          전체 뉴스 보기 →
        </div>
      </Card>

      {/* Quick access to new features */}
      <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        {[
          {tab:'calendar',icon:'',l:'경제 캘린더',d:'오늘 FOMC·CPI 확인',c:T.red},
          {tab:'briefing',icon:'',l:'AI 브리핑',d:'오늘의 시장 요약',c:T.prp},
          {tab:'tax',icon:'',l:'손익 추적',d:'2025년 실현손익',c:T.ylw},
          {tab:'growth',icon:'',l:'성장 현황',d:'배지·XP·친구초대',c:T.grn},
        ].map(x=>(
          <button key={x.tab} onClick={()=>onNav(x.tab)} style={{background:T.card,border:`1px solid ${x.c}20`,borderRadius:14,padding:'12px 12px',textAlign:'left',cursor:'pointer'}}>
            <div style={{fontSize:18,marginBottom:5}}>{x.icon}</div>
            <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{x.l}</div>
            <div style={{color:T.muted,fontSize:10,marginTop:2}}>{x.d}</div>
          </button>
        ))}
      </div>

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

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


function BriefingPage({prices, onOpenAsset}:{prices:Asset[]; onOpenAsset?: (a: any, dest?: string) => void}) {
  const [tab,setTab]=useState<'market'|'portfolio'|'risk'|'watchlist'>('market');
  const now=new Date();
  const hour=now.getHours();
  const timeLabel=hour<12?'오전 브리핑':hour<18?'오후 브리핑':'야간 브리핑';

  const MARKET_ITEMS=[
    {icon:'₿',title:'BTC 모멘텀',body:'비트코인이 9,400만원 저항선에서 조정 중입니다. 단기 변동성이 확대되고 있으며, 반감기 이후 공급 감소 효과가 시장에 반영되고 있습니다.',sentiment:'neutral',tag:'변동성 주의'},
    {icon:'',title:'나스닥 기술주',body:'나스닥이 +0.87% 상승하며 AI 섹터 강세가 지속되고 있습니다. NVDA, MSFT 중심의 상승세로 반도체 ETF가 선도하고 있습니다.',sentiment:'bullish',tag:'강세'},
    {icon:'🛢️',title:'원유·인플레이션',body:'WTI 원유가 소폭 하락(-0.9%)하며 에너지 비용 압력이 줄어들고 있습니다. 이는 CPI 발표에 긍정적 영향을 줄 수 있습니다.',sentiment:'neutral',tag:'관찰'},
    {icon:'',title:'달러·환율',body:'달러 인덱스가 소폭 약세(-0.22%)를 보이며 원화가 강세입니다. 수출주에 단기 부정적 요인이 될 수 있습니다.',sentiment:'bearish',tag:'주의'},
    {icon:'🥇',title:'금·안전자산',body:'금이 +0.56% 상승하며 지정학적 리스크에 대한 헤지 수요가 지속되고 있습니다. 포트폴리오 안정성 역할을 수행 중입니다.',sentiment:'bullish',tag:'안전'},
  ];

  const PORTFOLIO_ITEMS=[
    {icon:'',title:'장투 포트폴리오 건강',body:'BTC·ETH 장기 포지션이 안정적입니다. 목표가 대비 진행률이 62%로 순조롭게 진행 중이며, DCA 계획이 정상 실행되고 있습니다.',sentiment:'bullish'},
    {icon:'',title:'단타 주의 신호',body:'SOL 단기 포지션이 목표가의 85%에 도달했습니다. 부분 익절을 고려해볼 수 있습니다.',sentiment:'neutral'},
    {icon:'💵',title:'현금 비중',body:'현금 비중 10%가 유지되고 있습니다. CPI 발표 후 매수 기회를 노리는 전략이 유효합니다.',sentiment:'neutral'},
  ];

  const RISK_ITEMS=[
    {icon:'⚠️',title:'집중도 경고',body:'NVDA 단일 종목 비중이 35%를 초과했습니다. 분산 투자를 권장합니다.',level:'warning'},
    {icon:'✅',title:'레버리지 정상',body:'현재 사용 중인 레버리지가 권장 범위 내에 있습니다. 단타 계좌 최대 레버리지: 3배.',level:'ok'},
    {icon:'',title:'펀딩비 정상',body:'BTC 선물 펀딩비 0.01%로 정상 범위입니다. 과열 신호 없음.',level:'ok'},
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
        {([['market','시장'],['portfolio','포트폴리오'],['risk','리스크'],['watchlist','👁 왓치리스트']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'8px 12px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {tab==='market'&&(
        <div>
          {/* 실시간 시장 스냅샷 */}
          <MarketSnapshotCard/>

          {/* 뉴스 영향 분석기 */}
          <NewsImpactAnalyzer/>

          <div style={{color:T.txt,fontWeight:700,marginBottom:10,marginTop:14}}>오늘의 시장 브리핑</div>
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
            <Card key={a.id} style={{padding:'12px 14px',marginBottom:8,
              cursor: onOpenAsset ? 'pointer' : 'default'}}>
              <div onClick={() => { if (onOpenAsset) onOpenAsset(a, 'trading'); }}
                role={onOpenAsset ? 'button' : undefined}
                tabIndex={onOpenAsset ? 0 : undefined}
                onKeyDown={(e) => {
                  if (onOpenAsset && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    onOpenAsset(a, 'trading');
                  }
                }}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div style={{display:'flex',gap:8,alignItems:'center'}}>
                    <Logo id={a.id} size={32} clr={a.clr} name={a.nameKr}/>
                    <div>
                      <div style={{color:T.txt,fontWeight:700,fontSize:12}}>{a.nameKr}</div>
                      <div style={{color:T.muted,fontSize:10}}>{a.sym}</div>
                    </div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{cvt(a.p,'KRW')}</div>
                    <div style={{color:(a.c??0)>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{(a.c??0)>=0?'+':''}{(a.c??0).toFixed(2)}%</div>
                  </div>
                </div>
                <div style={{marginTop:8,color:T.muted,fontSize:10,lineHeight:1.5}}>
                  {Math.abs(a.c??0)>5?`⚠️ 변동성 높음 — 레버리지 주의`:Math.abs(a.c??0)>2?`보통 변동성 — 전략적 접근`:`✅ 안정적 움직임`}
                </div>
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


// ─────────────────────────────────────────────────────────────
// MarketSnapshotCard — 실시간 BTC/ETH/F&G/펀딩비 + 시장 점수 게이지
// ─────────────────────────────────────────────────────────────
import { Activity, Gauge, TrendingUp, TrendingDown, Minus,
         Newspaper as NewspaperIc, Sparkles, RefreshCw, Send,
         AlertTriangle as AlertTriangleIc } from 'lucide-react';

interface SnapshotData {
  btc: { price: number; change24h: number; volume24h: number } | null;
  eth: { price: number; change24h: number; volume24h: number } | null;
  fearGreed: { value: number; classification: string; updatedAt: string } | null;
  funding: { btc: number; eth: number } | null;
  marketScore: number;
  scoreLabel: string;
  signals: string[];
  updatedAt: number;
  partial: boolean;
}

function MarketSnapshotCard() {
  const [data, setData]    = useState<SnapshotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]  = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/briefing/snapshot', { signal: AbortSignal.timeout(15000) });
      if (!r.ok) { setError(`status_${r.status}`); setLoading(false); return; }
      const d = await r.json();
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);   // 1분마다 자동 갱신
    return () => clearInterval(t);
  }, [load]);

  // 게이지 색상
  const scoreColor = data
    ? data.marketScore < 25 ? T.red
    : data.marketScore < 45 ? '#FB923C'
    : data.marketScore < 55 ? T.ylw
    : data.marketScore < 75 ? '#84CC16'
    :                         T.grn
    : T.muted;

  const scoreLabel = data
    ? data.marketScore < 25 ? '극도의 공포'
    : data.marketScore < 45 ? '공포'
    : data.marketScore < 55 ? '중립'
    : data.marketScore < 75 ? '탐욕'
    :                         '극도의 탐욕'
    : '—';

  if (loading && !data) {
    // 스켈레톤
    return (
      <Card style={{padding:'14px 16px', marginBottom:10}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10}}>
          <Activity size={14} strokeWidth={2.2} color={T.muted}/>
          <span style={{color:T.muted,fontWeight:700,fontSize:13}}>실시간 시장 스냅샷 로딩 중...</span>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:8}}>
          {[1,2,3,4].map(i => (
            <div key={i} style={{background:T.alt,height:48,borderRadius:8,
              opacity:0.5,
              animation:'tgPulse 1.4s ease-in-out infinite'}}/>
          ))}
        </div>
        <div style={{background:T.alt,height:60,borderRadius:8,opacity:0.5,animation:'tgPulse 1.4s ease-in-out infinite'}}/>
        <style jsx>{`@keyframes tgPulse { 0%,100% { opacity:0.3; } 50% { opacity:0.6; } }`}</style>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card style={{padding:'14px 16px',marginBottom:10}}>
        <div style={{color:T.red,fontSize:11,marginBottom:6}}>스냅샷 로드 실패</div>
        <button onClick={load} style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,padding:'5px 10px',fontSize:10,cursor:'pointer'}}>다시 시도</button>
      </Card>
    );
  }

  return (
    <Card style={{padding:'14px 16px',marginBottom:10,borderLeft:`3px solid ${scoreColor}`}}>
      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10}}>
        <Activity size={14} strokeWidth={2.2} color={T.acl}/>
        <span style={{color:T.txt,fontWeight:800,fontSize:13}}>실시간 시장 스냅샷</span>
        {data.partial && (
          <span style={{padding:'1px 6px',background:T.ylw+'20',color:T.ylw,fontSize:9,fontWeight:700,borderRadius:4}}>부분</span>
        )}
        <span style={{marginLeft:'auto',color:T.muted,fontSize:9}}>
          {new Date(data.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
        </span>
        <button onClick={load} aria-label="새로고침"
          style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,padding:4,marginLeft:4,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>
          <RefreshCw size={10} strokeWidth={2.4}/>
        </button>
      </div>

      {/* 시장 점수 게이지 */}
      <div style={{marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:4}}>
          <span style={{color:T.muted,fontSize:10,fontWeight:700,display:'inline-flex',alignItems:'center',gap:4}}>
            <Gauge size={10} strokeWidth={2.4}/>시장 점수
          </span>
          <span style={{color:scoreColor,fontWeight:900,fontSize:15}}>{data.marketScore} <span style={{fontSize:10,fontWeight:700}}>{scoreLabel}</span></span>
        </div>
        <div style={{height:8,background:T.alt,borderRadius:4,overflow:'hidden',position:'relative'}}>
          {/* Background gradient */}
          <div style={{position:'absolute',inset:0,background:'linear-gradient(90deg, #EF4444 0%, #FB923C 25%, #F59E0B 45%, #84CC16 55%, #10B981 100%)',opacity:0.18}}/>
          <div style={{width:`${data.marketScore}%`,height:'100%',background:scoreColor,transition:'width 400ms'}}/>
          {/* 마커 (현재 위치) */}
          <div style={{position:'absolute',top:-2,left:`calc(${data.marketScore}% - 6px)`,width:12,height:12,background:'#fff',border:`2px solid ${scoreColor}`,borderRadius:6,transition:'left 400ms'}}/>
        </div>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:4}}>
          <span style={{color:T.muted,fontSize:8}}>0</span>
          <span style={{color:T.muted,fontSize:8}}>50</span>
          <span style={{color:T.muted,fontSize:8}}>100</span>
        </div>
      </div>

      {/* 4개 지표 그리드 */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:8}}>
        {data.btc && (
          <div style={{background:T.alt,padding:'8px 10px',borderRadius:8,border:`1px solid ${T.border}`}}>
            <div style={{color:T.muted,fontSize:9,marginBottom:2,display:'flex',alignItems:'center',gap:3}}>
              <span style={{color:'#F7931A',fontWeight:900}}>₿</span> BTC 24시간
            </div>
            <div style={{color:T.txt,fontWeight:800,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>${data.btc.price.toLocaleString('en-US',{maximumFractionDigits:0})}</div>
            <div style={{color:data.btc.change24h>=0?T.grn:T.red,fontSize:10,fontWeight:700}}>
              {data.btc.change24h>=0?'▲':'▼'} {Math.abs(data.btc.change24h).toFixed(2)}%
            </div>
          </div>
        )}
        {data.eth && (
          <div style={{background:T.alt,padding:'8px 10px',borderRadius:8,border:`1px solid ${T.border}`}}>
            <div style={{color:T.muted,fontSize:9,marginBottom:2,display:'flex',alignItems:'center',gap:3}}>
              <span style={{color:'#627EEA',fontWeight:900}}>Ξ</span> ETH 24시간
            </div>
            <div style={{color:T.txt,fontWeight:800,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>${data.eth.price.toLocaleString('en-US',{maximumFractionDigits:0})}</div>
            <div style={{color:data.eth.change24h>=0?T.grn:T.red,fontSize:10,fontWeight:700}}>
              {data.eth.change24h>=0?'▲':'▼'} {Math.abs(data.eth.change24h).toFixed(2)}%
            </div>
          </div>
        )}
        {data.fearGreed && (
          <div style={{background:T.alt,padding:'8px 10px',borderRadius:8,border:`1px solid ${T.border}`}}>
            <div style={{color:T.muted,fontSize:9,marginBottom:2}}>공포·탐욕 (Crypto)</div>
            <div style={{color:T.txt,fontWeight:800,fontSize:13}}>{data.fearGreed.value}</div>
            <div style={{color:T.muted,fontSize:9}}>{data.fearGreed.classification}</div>
          </div>
        )}
        {data.funding && (
          <div style={{background:T.alt,padding:'8px 10px',borderRadius:8,border:`1px solid ${T.border}`}}>
            <div style={{color:T.muted,fontSize:9,marginBottom:2}}>BTC 펀딩비 (실시간)</div>
            <div style={{color:Math.abs(data.funding.btc)>0.03?T.ylw:T.txt,fontWeight:800,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>
              {data.funding.btc>=0?'+':''}{data.funding.btc.toFixed(4)}%
            </div>
            <div style={{color:T.muted,fontSize:9}}>ETH: {data.funding.eth>=0?'+':''}{data.funding.eth.toFixed(4)}%</div>
          </div>
        )}
      </div>

      {/* 자동 추론 시그널 */}
      {data.signals.length > 0 && (
        <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px'}}>
          <div style={{color:T.muted,fontSize:9,fontWeight:700,marginBottom:5,display:'inline-flex',alignItems:'center',gap:4}}>
            <Sparkles size={10} strokeWidth={2.4} color={T.acl}/>자동 시그널
          </div>
          {data.signals.map((s, i) => (
            <div key={i} style={{color:T.sub,fontSize:11,lineHeight:1.6,paddingLeft:6,borderLeft:`2px solid ${T.acl}`,marginBottom:4}}>
              {s}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}


// ─────────────────────────────────────────────────────────────
// NewsImpactAnalyzer — 뉴스 텍스트 입력 → 자산별 영향 분석
// ─────────────────────────────────────────────────────────────
const QUICK_NEWS_TEMPLATES = [
  { tag: 'FOMC', text: '미 연준 FOMC 회의에서 금리 0.25%p 인하 결정. 파월 의장 추가 완화 시그널' },
  { tag: 'CPI', text: '미국 6월 CPI 전년 대비 2.9% 상승, 시장 예상 부합. 근원 CPI 3.3%' },
  { tag: 'NFP', text: '미국 비농업 고용 18만명 증가. 실업률 4.1%로 안정' },
  { tag: 'ETF',  text: '비트코인 현물 ETF에 하루 5억 달러 신규 자금 유입' },
  { tag: 'SEC',  text: 'SEC가 주요 거래소의 등록 신청을 거부하고 규제 강화 시사' },
];

interface ImpactItem {
  asset: string;
  direction: 'up' | 'down' | 'neutral';
  strength: number;
  reason: string;
}

interface AnalysisResult {
  summary: string;
  impacts: ImpactItem[];
  sentiment: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  source: string;
  warnings?: string[];
}

function NewsImpactAnalyzer() {
  const [text, setText]       = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState<AnalysisResult | null>(null);
  const [error, setError]     = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!text.trim() || loading) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const r = await fetch('/api/briefing/analyze-news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) { setError(`status_${r.status}`); setLoading(false); return; }
      const d = await r.json();
      if (d.error) { setError(d.error); return; }
      setResult(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
    } finally {
      setLoading(false);
    }
  }, [text, loading]);

  return (
    <Card style={{padding:'14px 16px',marginBottom:10}}>
      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
        <NewspaperIc size={14} strokeWidth={2.2} color={T.acl}/>
        <span style={{color:T.txt,fontWeight:800,fontSize:13}}>뉴스 영향 분석기</span>
      </div>
      <div style={{color:T.muted,fontSize:10,marginBottom:8}}>
        뉴스 텍스트를 입력하면 BTC/ETH/달러/주식에 미칠 단기 영향을 분석합니다.
      </div>

      <textarea
        value={text}
        onChange={e => setText(e.target.value.slice(0, 1500))}
        placeholder="예: 비트코인 ETF에 큰 자금 유입... 또는 뉴스 헤드라인 붙여넣기"
        rows={3}
        style={{width:'100%',boxSizing:'border-box',background:T.bg,color:T.txt,
          border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',
          fontSize:12,lineHeight:1.5,outline:'none',fontFamily:'inherit',
          resize:'vertical'}}/>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:5}}>
        <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
          {QUICK_NEWS_TEMPLATES.map(t => (
            <button key={t.tag} type="button"
              onClick={() => setText(t.text)}
              style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,
                borderRadius:6,padding:'3px 8px',fontSize:9,fontWeight:700,cursor:'pointer'}}>
              {t.tag}
            </button>
          ))}
        </div>
        <span style={{color:T.muted,fontSize:9}}>{text.length}/1500</span>
      </div>

      <button onClick={submit} disabled={!text.trim() || loading}
        style={{
          marginTop:8,width:'100%',padding:'10px',minHeight:42,
          background:!text.trim()||loading ? T.border : `linear-gradient(135deg,${T.acc},${T.prp})`,
          color:'#fff',border:'none',borderRadius:10,
          fontWeight:800,fontSize:12,
          cursor:!text.trim()||loading ? 'not-allowed' : 'pointer',
          display:'flex',alignItems:'center',justifyContent:'center',gap:5,
        }}>
        <Send size={12} strokeWidth={2.4}/>
        {loading ? '분석 중...' : 'AI 영향 분석'}
      </button>

      {error && (
        <div style={{marginTop:8,padding:'6px 10px',background:T.red+'10',border:`1px solid ${T.red}30`,borderRadius:6,color:T.red,fontSize:10}}>
          오류: {error}
        </div>
      )}

      {result && (
        <div style={{marginTop:10,padding:'10px 12px',background:T.bg,border:`1px solid ${T.border}`,borderRadius:10}}>
          <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6,flexWrap:'wrap'}}>
            <span style={{
              padding:'2px 7px',
              background: result.sentiment==='bullish' ? T.grn+'22' : result.sentiment==='bearish' ? T.red+'22' : T.ylw+'22',
              color: result.sentiment==='bullish' ? T.grn : result.sentiment==='bearish' ? T.red : T.ylw,
              fontSize:9,fontWeight:800,borderRadius:4,
            }}>
              {result.sentiment === 'bullish' ? '강세' : result.sentiment === 'bearish' ? '약세' : '중립'}
            </span>
            <span style={{color:T.muted,fontSize:9}}>
              신뢰도 {Math.round(result.confidence * 100)}% · {result.source}
            </span>
          </div>
          <div style={{color:T.txt,fontSize:11,lineHeight:1.5,marginBottom:8}}>{result.summary}</div>

          {/* 자산별 영향 */}
          {result.impacts.length > 0 && (
            <div style={{display:'flex',flexDirection:'column',gap:6,marginTop:6}}>
              {result.impacts.map((imp, i) => {
                const color = imp.direction === 'up' ? T.grn : imp.direction === 'down' ? T.red : T.muted;
                const Ic = imp.direction === 'up' ? TrendingUp : imp.direction === 'down' ? TrendingDown : Minus;
                return (
                  <div key={i} style={{display:'flex',gap:8,alignItems:'flex-start',padding:'6px 8px',background:T.alt,borderRadius:6,borderLeft:`2px solid ${color}`}}>
                    <Ic size={13} strokeWidth={2.4} color={color} style={{flexShrink:0,marginTop:1}}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:'flex',alignItems:'baseline',gap:6,marginBottom:2}}>
                        <span style={{color:T.txt,fontWeight:800,fontSize:11}}>{imp.asset}</span>
                        <span style={{color,fontSize:9,fontWeight:700}}>
                          {imp.direction === 'up' ? '상승 압력' : imp.direction === 'down' ? '하락 압력' : '중립'}
                        </span>
                        <span style={{color:T.muted,fontSize:9,marginLeft:'auto'}}>강도 {Math.round(imp.strength)}/100</span>
                      </div>
                      {/* 강도 바 */}
                      <div style={{height:3,background:T.bg,borderRadius:2,overflow:'hidden',marginBottom:3}}>
                        <div style={{width:`${imp.strength}%`,height:'100%',background:color}}/>
                      </div>
                      <div style={{color:T.muted,fontSize:10,lineHeight:1.4}}>{imp.reason}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 경고 */}
          {result.warnings && result.warnings.length > 0 && (
            <div style={{marginTop:6,padding:'5px 8px',background:T.ylw+'10',border:`1px solid ${T.ylw}30`,borderRadius:6,display:'flex',gap:5,alignItems:'flex-start'}}>
              <AlertTriangleIc size={11} strokeWidth={2.4} color={T.ylw} style={{flexShrink:0,marginTop:1}}/>
              <div style={{color:T.ylw,fontSize:9,lineHeight:1.4}}>{result.warnings.join(' · ')}</div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}


export default BriefingPage;
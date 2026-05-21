'use client';
import React, { useState, useEffect, useCallback, useMemo } from 'react';

const T = {
  bg:'#060B14', card:'#0A1628', surf:'#0D1F3C', alt:'#0F2040',
  border:'#1A2D4A', border2:'#243A5E',
  txt:'#E2E8F0', sub:'#94A3B8', muted:'#475569',
  grn:'#10B981', red:'#EF4444', ylw:'#F59E0B',
  acl:'#60A5FA', acc:'#2563EB', acg:'#1E3A5F', prp:'#7C3AED',
} as const;

type TabId = 'onchain'|'calendar'|'voice'|'accounts'|'tax'|'simulator'|'community'|'assistant';

const TABS: { id:TabId; label:string; emoji:string }[] = [
  { id:'onchain',   label:'온체인',     emoji:'⛓️'  },
  { id:'calendar',  label:'경제캘린더', emoji:'📅'  },
  { id:'voice',     label:'AI 브리핑',  emoji:'🎙️'  },
  { id:'accounts',  label:'계좌관리',   emoji:'🏦'  },
  { id:'tax',       label:'손익리포트', emoji:'📊'  },
  { id:'simulator', label:'시뮬레이터', emoji:'🎲'  },
  { id:'community', label:'커뮤니티',   emoji:'👥'  },
  { id:'assistant', label:'AI 비서',    emoji:'🤖'  },
];

function Card({ c, style }: { c: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:14, padding:'14px 16px', ...style }}>{c}</div>;
}
function SHead({ emoji, title, sub }: { emoji:string; title:string; sub?:string }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
      <div style={{ width:32, height:32, borderRadius:10, background:`linear-gradient(135deg,${T.acc},${T.prp})`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:16 }}>{emoji}</div>
      <div>
        <div style={{ fontWeight:900, fontSize:15, color:T.txt }}>{title}</div>
        {sub && <div style={{ color:T.muted, fontSize:10 }}>{sub}</div>}
      </div>
    </div>
  );
}
function Skeleton({ h=14 }: { h?: number }) {
  return <div style={{ height:h, borderRadius:6, background:'linear-gradient(90deg,#1A2D4A 25%,#243A5E 50%,#1A2D4A 75%)', backgroundSize:'200% 100%', animation:'shimmer 1.2s infinite' }}/>;
}
function Badge({ label, color }: { label:string; color:string }) {
  return <span style={{ background:color+'20', color, fontSize:9, padding:'1px 5px', borderRadius:4, fontWeight:700, flexShrink:0 }}>{label}</span>;
}

// ─── 1. On-Chain Data ──────────────────────────────────────────
function OnChainTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/onchain').then(r => r.json()).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ display:'flex', flexDirection:'column', gap:8 }}>{[0,1,2].map(i=><Skeleton key={i} h={60}/>)}</div>;
  if (!data)   return <Card c={<div style={{ color:T.muted, textAlign:'center', padding:'20px 0' }}>데이터 제공사 연결 필요</div>}/>;

  const riskColor = data.riskScore > 60 ? T.red : data.riskScore > 40 ? T.ylw : T.grn;
  const fmtB = (n: number) => n >= 1e9 ? `$${(n/1e9).toFixed(1)}B` : `$${(n/1e6).toFixed(0)}M`;

  return (
    <div>
      <SHead emoji="⛓️" title="온체인 데이터" sub={`${data.source === 'mock' ? '모의 데이터 · ' : ''}${new Date(data.timestamp).toLocaleTimeString('ko-KR')}`}/>

      {/* Risk score */}
      <Card c={<>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
          <div style={{ color:T.txt, fontWeight:700 }}>온체인 리스크 지수</div>
          <div style={{ color:riskColor, fontWeight:900, fontSize:24 }}>{data.riskScore}</div>
        </div>
        <div style={{ height:8, background:T.alt, borderRadius:4, overflow:'hidden', marginBottom:6 }}>
          <div style={{ height:'100%', width:`${data.riskScore}%`, background:`linear-gradient(90deg,${T.grn},${T.ylw},${T.red})`, borderRadius:4, transition:'width .5s' }}/>
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', color:T.muted, fontSize:9 }}>
          <span>안전 (0)</span><span>위험 (100)</span>
        </div>
        {data.note && <div style={{ marginTop:8, color:T.muted, fontSize:9 }}>⚠️ {data.note}</div>}
      </>} style={{ marginBottom:8 }}/>

      {/* Exchange Flow */}
      <Card c={<>
        <div style={{ color:T.txt, fontWeight:700, marginBottom:8 }}>📤 거래소 입출금</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6 }}>
          {[['입금', data.exchangeFlow.btcInflow + ' BTC', T.red], ['출금', data.exchangeFlow.btcOutflow + ' BTC', T.grn], ['순유입', (data.exchangeFlow.netFlow > 0 ? '+' : '') + data.exchangeFlow.netFlow + ' BTC', data.exchangeFlow.netFlow > 0 ? T.red : T.grn]].map(([l,v,c]) => (
            <div key={l as string} style={{ background:T.alt, borderRadius:8, padding:'7px', textAlign:'center' }}>
              <div style={{ color:T.muted, fontSize:8 }}>{l as string}</div>
              <div style={{ color:c as string, fontWeight:700, fontSize:10 }}>{v as string}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop:6 }}>
          <Badge label={data.exchangeFlow.trend === 'OUTFLOW' ? '✅ 출금 우세 (강세 신호)' : '⚠️ 입금 우세 (매도 압력)'} color={data.exchangeFlow.trend === 'OUTFLOW' ? T.grn : T.red}/>
        </div>
      </>} style={{ marginBottom:8 }}/>

      {/* Stablecoin */}
      <Card c={<>
        <div style={{ color:T.txt, fontWeight:700, marginBottom:8 }}>💵 스테이블코인 유입</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:6 }}>
          {[['USDT', fmtB(data.stablecoin.usdtInflow)], ['USDC', fmtB(data.stablecoin.usdcInflow)]].map(([l,v]) => (
            <div key={l as string} style={{ background:T.alt, borderRadius:8, padding:'7px', textAlign:'center' }}>
              <div style={{ color:T.muted, fontSize:9 }}>{l as string} 24h 유입</div>
              <div style={{ color:T.grn, fontWeight:700, fontSize:11 }}>{v as string}</div>
            </div>
          ))}
        </div>
        <Badge label={data.stablecoin.trend === 'BULLISH' ? '🟢 스테이블코인 유입 증가 → 매수 대기 자금↑' : '🔴 스테이블코인 유출 → 위험자산 회피'} color={data.stablecoin.trend === 'BULLISH' ? T.grn : T.red}/>
      </>} style={{ marginBottom:8 }}/>

      {/* Whale Activity */}
      <Card c={<>
        <div style={{ color:T.txt, fontWeight:700, marginBottom:8 }}>🐋 고래 활동</div>
        {data.whales.map((w: any, i: number) => (
          <div key={i} style={{ display:'flex', gap:8, padding:'7px 0', borderBottom: i < data.whales.length-1 ? `1px solid ${T.border}` : 'none', alignItems:'center' }}>
            <div style={{ width:24, textAlign:'center', fontSize:12 }}>{w.type === 'whale' ? '🐋' : '🦈'}</div>
            <div style={{ flex:1 }}>
              <div style={{ color:T.txt, fontSize:10 }}><span style={{ color:T.acl, fontFamily:'monospace' }}>{w.address}</span></div>
              <div style={{ color:T.muted, fontSize:9 }}>{w.action} {w.amount} · {w.time}</div>
            </div>
            <Badge label={w.action} color={w.action === '매수' ? T.grn : w.action === '매도' ? T.red : T.ylw}/>
          </div>
        ))}
      </>} style={{ marginBottom:8 }}/>

      {/* ETF Flow */}
      <Card c={<>
        <div style={{ color:T.txt, fontWeight:700, marginBottom:8 }}>🏦 ETF 자금 흐름</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
          {[
            ['BTC ETF', (data.etfFlow.btcEtfInflow >= 0 ? '+' : '') + fmtB(data.etfFlow.btcEtfInflow), data.etfFlow.btcEtfInflow >= 0 ? T.grn : T.red],
            ['ETH ETF', (data.etfFlow.ethEtfInflow >= 0 ? '+' : '') + fmtB(data.etfFlow.ethEtfInflow), data.etfFlow.ethEtfInflow >= 0 ? T.grn : T.red],
          ].map(([l,v,c]) => (
            <div key={l as string} style={{ background:T.alt, borderRadius:8, padding:'7px', textAlign:'center' }}>
              <div style={{ color:T.muted, fontSize:8 }}>{l as string} 일일</div>
              <div style={{ color:c as string, fontWeight:700, fontSize:11 }}>{v as string}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop:6, color:T.muted, fontSize:9 }}>출처: {data.etfFlow.source}</div>
      </>}/>
    </div>
  );
}

// ─── 2. Economic Calendar ──────────────────────────────────────
function CalendarTab() {
  const [events, setEvents] = useState<any[]>([]);
  const [filter, setFilter] = useState<'ALL'|'HIGH'|'MEDIUM'>('ALL');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/intel?action=calendar').then(r => r.json()).then(d => setEvents(d.events || [])).finally(() => setLoading(false));
  }, []);

  const filtered = events.filter(e => filter === 'ALL' || e.importance === filter);
  const impColor = (imp: string) => imp === 'HIGH' ? T.red : imp === 'MEDIUM' ? T.ylw : T.muted;
  const impLabel = (imp: string) => imp === 'HIGH' ? '🔴 HIGH' : imp === 'MEDIUM' ? '🟡 MID' : '🟢 LOW';

  return (
    <div>
      <SHead emoji="📅" title="경제 캘린더" sub="CPI · FOMC · NFP · 옵션 만기"/>
      <div style={{ display:'flex', gap:5, marginBottom:10 }}>
        {['ALL','HIGH','MEDIUM'].map(f => (
          <button key={f} onClick={() => setFilter(f as any)}
            style={{ padding:'4px 12px', background:filter===f?T.acg:'transparent', color:filter===f?T.acl:T.muted,
              border:`1px solid ${filter===f?T.acl:T.border}`, borderRadius:8, fontSize:10, fontWeight:700, cursor:'pointer' }}>
            {f === 'ALL' ? '전체' : f === 'HIGH' ? '🔴 주요' : '🟡 보통'}
          </button>
        ))}
      </div>
      {loading ? <Skeleton h={200}/> : filtered.map(ev => (
        <Card key={ev.id} c={<>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
            <div>
              <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:3 }}>
                <span style={{ fontSize:14 }}>{ev.country}</span>
                <div style={{ color:T.txt, fontWeight:800, fontSize:12 }}>{ev.event}</div>
                {ev.botPause && <Badge label="🤖 봇 일시정지 권장" color={T.ylw}/>}
              </div>
              <div style={{ color:T.muted, fontSize:9 }}>{ev.date} {ev.time} KST</div>
            </div>
            <div style={{ textAlign:'right', flexShrink:0 }}>
              <Badge label={impLabel(ev.importance)} color={impColor(ev.importance)}/>
              <div style={{ color:T.acl, fontSize:9, marginTop:3 }}>{ev.isPast ? '완료' : ev.countdown}</div>
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:4, marginBottom:6 }}>
            {[['예상', ev.expected, T.acl], ['이전', ev.prev, T.muted], ['변동성', ev.impact.replace('_VOLATILITY',''), T.ylw]].map(([l,v,c]) => (
              <div key={l as string} style={{ background:T.alt, borderRadius:6, padding:'5px', textAlign:'center' }}>
                <div style={{ color:T.muted, fontSize:7 }}>{l as string}</div>
                <div style={{ color:c as string, fontSize:9, fontWeight:700 }}>{v as string}</div>
              </div>
            ))}
          </div>
          <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
            {ev.assets.map((a: string) => <Badge key={a} label={a} color={T.acl}/>)}
          </div>
        </>} style={{ marginBottom:6 }}/>
      ))}
    </div>
  );
}

// ─── 3. AI Voice Briefing ──────────────────────────────────────
function VoiceTab() {
  const [briefing, setBriefing] = useState('');
  const [loading, setLoading]   = useState(false);
  const [playing, setPlaying]   = useState(false);

  const loadBriefing = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/hub?action=briefing');
      const d = await r.json();
      setBriefing(d.aiSummary || '시장 데이터 로딩 실패');
    } catch { setBriefing('브리핑 로딩 실패'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadBriefing(); }, [loadBriefing]);

  const speak = useCallback(() => {
    if (typeof window === 'undefined' || !briefing) return;
    if (typeof window === 'undefined') return;
    const synth = window.speechSynthesis;
    if (!synth) { alert('이 브라우저는 TTS를 지원하지 않습니다.'); return; }
    const utter = new SpeechSynthesisUtterance(briefing);
    utter.lang = 'ko-KR';
    utter.rate = 0.9;
    utter.onend  = () => setPlaying(false);
    utter.onerror= () => setPlaying(false);
    if (playing) { synth.cancel(); setPlaying(false); return; }
    setPlaying(true);
    synth.speak(utter);
  }, [briefing, playing]);

  const QUICK = ['BTC 오늘 시장 분석', 'ETH 기술적 분석 요약', '알트코인 시즌 여부 판단'];

  return (
    <div>
      <SHead emoji="🎙️" title="AI 음성 브리핑" sub="오늘 시장 요약 · TTS 자동 읽기"/>
      <Card c={<>
        <div style={{ textAlign:'center', padding:'16px 0' }}>
          <button onClick={speak} disabled={loading||!briefing}
            style={{ width:80, height:80, borderRadius:'50%', cursor:'pointer', border:'none',
              background: playing ? `radial-gradient(circle,${T.red}40,${T.red}20)` : `radial-gradient(circle,${T.acl}40,${T.acc}20)`,
              boxShadow: playing ? `0 0 20px ${T.red}60` : `0 0 20px ${T.acl}40`,
              fontSize:32, transition:'all .3s' }}>
            {playing ? '⏸️' : '▶️'}
          </button>
          <div style={{ color:T.acl, fontSize:12, marginTop:8, fontWeight:700 }}>
            {loading ? '생성 중…' : playing ? '재생 중 (탭하면 정지)' : '탭하여 브리핑 듣기'}
          </div>
          {false && <div style={{ color:T.muted, fontSize:10, marginTop:4 }}>이 브라우저는 TTS 미지원</div>}
        </div>
        {briefing && (
          <div style={{ background:T.alt, borderRadius:10, padding:'12px', marginTop:8, color:T.txt, fontSize:12, lineHeight:1.7 }}>
            {briefing}
          </div>
        )}
        <button onClick={loadBriefing} disabled={loading}
          style={{ marginTop:10, width:'100%', padding:'8px', background:T.alt, border:`1px solid ${T.border}`, borderRadius:10, color:T.muted, fontSize:11, cursor:'pointer' }}>
          🔄 새 브리핑 생성
        </button>
      </>} style={{ marginBottom:10 }}/>
      <Card c={<>
        <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:8 }}>빠른 브리핑</div>
        {QUICK.map(q => (
          <button key={q} style={{ display:'block', width:'100%', textAlign:'left', padding:'9px 12px', marginBottom:5, background:T.alt, border:`1px solid ${T.border}`, borderRadius:8, color:T.sub, fontSize:11, cursor:'pointer' }}>
            🎙️ {q}
          </button>
        ))}
      </>}/>
    </div>
  );
}

// ─── 4. Multi-Account Management ──────────────────────────────
function AccountsTab({ prices }: { prices?: any[] }) {
  const MOCK_ACCOUNTS = [
    { id:'a1', exchange:'binance', nickname:'바이낸스 장투 계좌', balance:15420000, pnl:+324000, pnlPct:+2.1, risk:'low',    strategy:'DCA 장기', autoEnabled:false, isPaper:true  },
    { id:'a2', exchange:'bybit',   nickname:'바이비트 단타 계좌', balance:8750000,  pnl:-85000,  pnlPct:-1.0, risk:'high',   strategy:'스캘핑',   autoEnabled:false, isPaper:true  },
    { id:'a3', exchange:'gate',    nickname:'Gate 테스트 계좌',   balance:3200000,  pnl:+42000,  pnlPct:+1.3, risk:'medium', strategy:'EMA 크로스', autoEnabled:false, isPaper:true  },
  ];

  const totalBalance = MOCK_ACCOUNTS.reduce((a, acc) => a + acc.balance, 0);
  const totalPnL     = MOCK_ACCOUNTS.reduce((a, acc) => a + acc.pnl, 0);

  return (
    <div>
      <SHead emoji="🏦" title="멀티 계좌 관리" sub="여러 거래소 통합 관리"/>
      <Card c={<>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          <div style={{ textAlign:'center' }}>
            <div style={{ color:T.muted, fontSize:9 }}>총 자산</div>
            <div style={{ color:T.txt, fontWeight:900, fontSize:18 }}>₩{(totalBalance/1e6).toFixed(1)}M</div>
          </div>
          <div style={{ textAlign:'center' }}>
            <div style={{ color:T.muted, fontSize:9 }}>오늘 P&L</div>
            <div style={{ color:totalPnL>=0?T.grn:T.red, fontWeight:900, fontSize:18 }}>
              {totalPnL>=0?'+':''}{(totalPnL/1000).toFixed(0)}K
            </div>
          </div>
        </div>
      </>} style={{ marginBottom:10 }}/>
      {MOCK_ACCOUNTS.map(acc => (
        <Card key={acc.id} c={<>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
            <div style={{ width:28, height:28, borderRadius:8, background:T.acg, border:`1px solid ${T.acl}40`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:12 }}>
              {acc.exchange === 'binance' ? '🟡' : acc.exchange === 'bybit' ? '🟠' : '🔵'}
            </div>
            <div style={{ flex:1 }}>
              <div style={{ color:T.txt, fontWeight:700, fontSize:12 }}>{acc.nickname}</div>
              <div style={{ color:T.muted, fontSize:9 }}>{acc.exchange} · {acc.strategy} {acc.isPaper && '· 모의'}</div>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ color:T.txt, fontSize:11, fontWeight:700 }}>₩{(acc.balance/1e6).toFixed(2)}M</div>
              <div style={{ color:acc.pnl>=0?T.grn:T.red, fontSize:9 }}>{acc.pnl>=0?'+':''}{(acc.pnl/1000).toFixed(0)}K ({acc.pnlPct>=0?'+':''}{acc.pnlPct}%)</div>
            </div>
          </div>
          <div style={{ height:4, background:T.alt, borderRadius:2 }}>
            <div style={{ height:'100%', width:`${(acc.balance/totalBalance)*100}%`, background:T.acl, borderRadius:2 }}/>
          </div>
        </>} style={{ marginBottom:6 }}/>
      ))}
      <div style={{ background:'#60A5FA0A', border:`1px solid ${T.acl}25`, borderRadius:10, padding:'10px 12px', marginTop:6, color:T.acl, fontSize:10 }}>
        💡 실제 거래소 연결은 "거래소연결" 탭에서 API 키를 등록하세요.
      </div>
    </div>
  );
}

// ─── 5. Tax / P&L Report ──────────────────────────────────────
function TaxTab({ currency }: { currency?: string }) {
  const [data, setData] = useState<any>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/intel?action=tax&year=${year}`).then(r => r.json()).then(setData).finally(() => setLoading(false));
  }, [year]);

  if (loading) return <div style={{ display:'flex', flexDirection:'column', gap:6 }}>{[0,1,2].map(i=><Skeleton key={i} h={50}/>)}</div>;

  const fmt = (v: number) => `₩${Math.abs(v).toLocaleString('ko-KR')}`;

  return (
    <div>
      <SHead emoji="📊" title="손익 · 세금 리포트" sub="월별 P&L · 수수료 · 예상 세금"/>
      {/* Year picker */}
      <div style={{ display:'flex', gap:6, marginBottom:10 }}>
        {[2023,2024,2025].map(y => (
          <button key={y} onClick={() => setYear(y)}
            style={{ flex:1, padding:'6px', background:year===y?T.acg:'transparent', color:year===y?T.acl:T.muted,
              border:`1px solid ${year===y?T.acl:T.border}`, borderRadius:8, fontSize:11, fontWeight:700, cursor:'pointer' }}>
            {y}년
          </button>
        ))}
      </div>
      {data && <>
        {/* Summary */}
        <Card c={<>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8, marginBottom:8 }}>
            {[['총 손익', data.totalPnL, data.totalPnL>=0?T.grn:T.red],
              ['총 수수료', -data.totalFees, T.red],
              ['총 거래', data.totalTrades + '회', T.acl],
              ['예상 세금', data.estimatedTax, T.ylw],
            ].map(([l,v,c]) => (
              <div key={l as string} style={{ background:T.alt, borderRadius:8, padding:'8px', textAlign:'center' }}>
                <div style={{ color:T.muted, fontSize:9 }}>{l as string}</div>
                <div style={{ color:c as string, fontWeight:700, fontSize:12 }}>
                  {typeof v === 'number' ? (v >= 0 ? '' : '-') + '₩' + Math.abs(v as number).toLocaleString() : v as string}
                </div>
              </div>
            ))}
          </div>
          <div style={{ background:'#F59E0B0A', border:`1px solid ${T.ylw}25`, borderRadius:8, padding:'8px 10px', color:T.ylw, fontSize:9 }}>
            {data.note}
          </div>
        </>} style={{ marginBottom:8 }}/>
        {/* Monthly breakdown */}
        <Card c={<>
          <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:8 }}>월별 손익</div>
          <div style={{ overflowX:'auto' }}>
            {data.monthlyData.map((m: any) => (
              <div key={m.month} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'6px 0', borderBottom:`1px solid ${T.border}` }}>
                <span style={{ color:T.muted, fontSize:10, width:32, flexShrink:0 }}>{m.month}</span>
                <div style={{ flex:1, height:6, background:T.alt, borderRadius:3, margin:'0 8px', overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${Math.min(100, Math.abs(m.pnl)/50000)}%`, background:m.pnl>=0?T.grn:T.red, borderRadius:3 }}/>
                </div>
                <span style={{ color:m.pnl>=0?T.grn:T.red, fontSize:10, fontFamily:'monospace', width:70, textAlign:'right', flexShrink:0 }}>
                  {m.pnl>=0?'+':''}{(m.pnl/1000).toFixed(0)}K
                </span>
              </div>
            ))}
          </div>
        </>} style={{ marginBottom:8 }}/>
        {/* Export buttons */}
        <div style={{ display:'flex', gap:6 }}>
          <button style={{ flex:1, padding:'10px', background:T.alt, border:`1px solid ${T.border}`, borderRadius:10, color:T.muted, fontSize:11, cursor:'pointer' }}>
            📄 CSV 내보내기
          </button>
          <button style={{ flex:1, padding:'10px', background:T.alt, border:`1px solid ${T.border}`, borderRadius:10, color:T.muted, fontSize:11, cursor:'pointer' }}>
            📑 PDF 리포트
          </button>
        </div>
      </>}
    </div>
  );
}

// ─── 6. Strategy Simulator ────────────────────────────────────
function SimulatorTab() {
  const [winRate,  setWinRate]  = useState(55);
  const [avgWin,   setAvgWin]   = useState(3);
  const [avgLoss,  setAvgLoss]  = useState(2);
  const [capital,  setCapital]  = useState(10000000);
  const [trades,   setTrades]   = useState(100);
  const [result,   setResult]   = useState<any>(null);
  const [loading,  setLoading]  = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/intel?action=simulator&wr=${winRate/100}&aw=${avgWin/100}&al=${avgLoss/100}&cap=${capital}&n=${trades}`);
      setResult(await r.json());
    } catch {} finally { setLoading(false); }
  };

  return (
    <div>
      <SHead emoji="🎲" title="전략 시뮬레이터" sub="몬테카를로 · 1년 전에 이 전략 사용했다면?"/>
      <Card c={<>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
          {[
            ['승률 (%)', winRate, setWinRate, 1, 99],
            ['평균 수익 (%)', avgWin, setAvgWin, 0.1, 20],
            ['평균 손실 (%)', avgLoss, setAvgLoss, 0.1, 20],
            ['거래 횟수', trades, setTrades, 10, 500],
          ].map(([l, v, s, min, max]) => (
            <div key={l as string}>
              <div style={{ color:T.muted, fontSize:9, marginBottom:3 }}>{l as string}: <span style={{ color:T.txt, fontWeight:700 }}>{v as number}</span></div>
              <input type="range" min={min as number} max={max as number} step={(l as string).includes('%') && !(l as string).includes('횟') ? 0.1 : 1}
                value={v as number} onChange={e => (s as any)(parseFloat(e.target.value))}
                style={{ width:'100%', accentColor:T.acl }}/>
            </div>
          ))}
        </div>
        <button onClick={run} disabled={loading}
          style={{ width:'100%', padding:'11px', background:loading?T.alt:'linear-gradient(135deg,#2563EB,#7C3AED)', color:loading?T.muted:'#fff', border:'none', borderRadius:10, fontWeight:800, fontSize:13, cursor:loading?'not-allowed':'pointer' }}>
          {loading ? '🎲 시뮬레이션 실행 중…' : '🚀 1000회 시뮬레이션 실행'}
        </button>
      </>} style={{ marginBottom:10 }}/>
      {result && (
        <Card c={<>
          <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:10 }}>📈 시뮬레이션 결과 (1000회)</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:6, marginBottom:10 }}>
            {[
              ['수익 가능성', result.profitProbability + '%', T.grn],
              ['파산 확률',  result.ruinProbability + '%',   T.red],
              ['중앙값 결과', '₩'+(result.p50/1e6).toFixed(1)+'M', T.acl],
              ['최대 잠재', '₩'+(result.maxPotential/1e6).toFixed(1)+'M', T.ylw],
              ['하위 10%', '₩'+(result.p10/1e6).toFixed(1)+'M', T.red],
              ['상위 90%', '₩'+(result.p90/1e6).toFixed(1)+'M', T.grn],
            ].map(([l,v,c]) => (
              <div key={l as string} style={{ background:T.alt, borderRadius:8, padding:'8px', textAlign:'center' }}>
                <div style={{ color:T.muted, fontSize:8 }}>{l as string}</div>
                <div style={{ color:c as string, fontWeight:800, fontSize:13 }}>{v as string}</div>
              </div>
            ))}
          </div>
          {/* Equity paths visualization */}
          <div style={{ color:T.muted, fontSize:9, marginBottom:4 }}>샘플 자산곡선 (20개 경로)</div>
          <svg width="100%" height="80" viewBox={`0 0 ${result.trades} 100`} preserveAspectRatio="none" style={{ borderRadius:8, background:T.alt }}>
            {result.paths.slice(0,20).map((path: number[], i: number) => {
              const maxV = Math.max(...result.paths.flat().filter((v: number) => v > 0)) || 1;
              const pts  = path.map((v: number, j: number) => `${j},${100 - (v / maxV * 90)}`).join(' ');
              const isPositive = (path[path.length-1] || 0) > result.initialCapital;
              return <polyline key={i} points={pts} fill="none" stroke={isPositive?'#10B98120':'#EF444420'} strokeWidth="1"/>;
            })}
          </svg>
          <div style={{ marginTop:8, background:'#F59E0B0A', border:`1px solid ${T.ylw}25`, borderRadius:8, padding:'8px', color:T.ylw, fontSize:9 }}>
            ⚠️ 시뮬레이션은 과거 통계 기반입니다. 실제 시장은 다를 수 있습니다.
          </div>
        </>}/>
      )}
    </div>
  );
}

// ─── 7. Community ─────────────────────────────────────────────
function CommunityTab() {
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/intel?action=community').then(r => r.json()).then(d => setPosts(d.posts || [])).finally(() => setLoading(false));
  }, []);

  const typeColor = (t: string) => ({ analysis:T.acl, warning:T.red, strategy:T.grn, trade:T.ylw }[t] || T.muted);
  const typeLabel = (t: string) => ({ analysis:'분석', warning:'경고', strategy:'전략', trade:'거래' }[t] || t);

  return (
    <div>
      <SHead emoji="👥" title="커뮤니티" sub="전략 공유 · 수익 인증 · 매매일지"/>
      <div style={{ background:'#EF444408', border:`1px solid ${T.red}20`, borderRadius:10, padding:'8px 12px', marginBottom:10, color:'#FCA5A5', fontSize:10 }}>
        🚫 투자 판단은 본인 책임. 타인 전략의 맹목적 추종은 큰 손실로 이어질 수 있습니다.
      </div>
      {loading ? <Skeleton h={200}/> : posts.map(p => (
        <Card key={p.id} c={<>
          <div style={{ display:'flex', gap:8, marginBottom:8 }}>
            <div style={{ width:32, height:32, borderRadius:10, background:T.alt, display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, flexShrink:0 }}>{p.avatar}</div>
            <div style={{ flex:1 }}>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <div style={{ color:T.txt, fontWeight:700, fontSize:11 }}>{p.author}</div>
                <div style={{ color:T.muted, fontSize:9 }}>{p.time}</div>
              </div>
              <div style={{ display:'flex', gap:4, marginTop:2 }}>
                <Badge label={typeLabel(p.type)} color={typeColor(p.type)}/>
                {p.pnlVerified && <Badge label={`✅ ${p.pnlVerified}`} color={T.grn}/>}
              </div>
            </div>
          </div>
          <div style={{ color:T.sub, fontSize:11, lineHeight:1.6, marginBottom:8 }}>{p.content}</div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={() => setLiked(s => { const n=new Set(s); n.has(p.id)?n.delete(p.id):n.add(p.id); return n; })}
              style={{ background:'transparent', border:'none', color:liked.has(p.id)?T.red:T.muted, cursor:'pointer', fontSize:10, padding:0 }}>
              {liked.has(p.id)?'❤️':' 🤍'} {p.likes + (liked.has(p.id)?1:0)}
            </button>
            <button style={{ background:'transparent', border:'none', color:T.muted, cursor:'pointer', fontSize:10, padding:0 }}>💬 {p.comments}</button>
            <button onClick={() => setSaved(s => { const n=new Set(s); n.has(p.id)?n.delete(p.id):n.add(p.id); return n; })}
              style={{ background:'transparent', border:'none', color:saved.has(p.id)?T.ylw:T.muted, cursor:'pointer', fontSize:10, padding:0 }}>
              {saved.has(p.id)?'🔖':'📌'}
            </button>
          </div>
        </>} style={{ marginBottom:6 }}/>
      ))}
    </div>
  );
}

// ─── 8. AI Assistant ──────────────────────────────────────────
function AssistantTab() {
  const [input,    setInput]    = useState('');
  const [messages, setMessages] = useState<{ q:string; a:string; src:string }[]>([]);
  const [loading,  setLoading]  = useState(false);

  const QUICK_Q = [
    '왜 손실이 났는지 분석해줘',
    '지금 시장에 맞는 전략 추천해줘',
    '내 레버리지가 너무 높은지 확인해줘',
    '진입 전 체크리스트 만들어줘',
    '변동성 높을 때 전략은?',
  ];

  const ask = async (q: string) => {
    if (!q.trim() || loading) return;
    setLoading(true);
    setInput('');
    try {
      const r = await fetch('/api/intel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action:'assistant', question:q }),
      });
      const d = await r.json();
      setMessages(prev => [{ q, a: d.answer || '응답 없음', src: d.source || 'fallback' }, ...prev.slice(0, 9)]);
    } catch { setMessages(prev => [{ q, a:'오류 발생. 다시 시도해주세요.', src:'error' }, ...prev]); }
    finally { setLoading(false); }
  };

  return (
    <div>
      <SHead emoji="🤖" title="AI 트레이딩 비서" sub="손실 분석 · 전략 추천 · 리스크 진단"/>
      <Card c={<>
        <div style={{ display:'flex', gap:6, marginBottom:8 }}>
          <input value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && ask(input)}
            placeholder="무엇이든 물어보세요… (예: 왜 손실났는지 분석해줘)"
            style={{ flex:1, background:T.bg, border:`1px solid ${T.border}`, borderRadius:10, padding:'10px 14px', color:T.txt, fontSize:12, outline:'none' }}/>
          <button onClick={() => ask(input)} disabled={loading||!input.trim()}
            style={{ padding:'10px 16px', background:T.acg, border:`1px solid ${T.acl}40`, borderRadius:10, color:T.acl, fontWeight:700, fontSize:12, cursor:'pointer', flexShrink:0 }}>
            {loading ? '…' : '전송'}
          </button>
        </div>
        <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
          {QUICK_Q.map(q => (
            <button key={q} onClick={() => ask(q)} disabled={loading}
              style={{ background:T.alt, border:`1px solid ${T.border}`, borderRadius:8, color:T.muted, fontSize:9, padding:'3px 8px', cursor:'pointer' }}>
              {q.slice(0,14)}…
            </button>
          ))}
        </div>
      </>} style={{ marginBottom:10 }}/>
      {loading && (
        <Card c={<div style={{ display:'flex', gap:8, alignItems:'center', color:T.muted, fontSize:11 }}>
          <span>🤖</span> AI 분석 중…
        </div>}/>
      )}
      {messages.map((m, i) => (
        <div key={i} style={{ marginBottom:8 }}>
          <div style={{ color:T.muted, fontSize:10, textAlign:'right', marginBottom:3 }}>🙋 {m.q}</div>
          <Card c={<>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
              <span style={{ color:T.acl, fontSize:10, fontWeight:700 }}>🤖 AI 비서</span>
              <Badge label={m.src === 'openai' ? 'GPT-4o' : '기본 응답'} color={m.src === 'openai' ? T.grn : T.ylw}/>
            </div>
            <div style={{ color:T.txt, fontSize:11, lineHeight:1.7 }}>{m.a}</div>
          </>}/>
        </div>
      ))}
      <div style={{ color:T.muted, fontSize:9, textAlign:'center', marginTop:10 }}>
        ⚠️ AI 답변은 참고용입니다. 투자 손실에 대한 책임을 지지 않습니다.
      </div>
    </div>
  );
}

// ─── MAIN PAGE ─────────────────────────────────────────────────
export default function IntelligencePage({ prices, currency = 'KRW' }: { prices?: any[]; currency?: string }) {
  const [activeTab, setActiveTab] = useState<TabId>('onchain');

  return (
    <div style={{ color: T.txt }}>
      {/* Tab scroller */}
      <div style={{ display:'flex', gap:5, overflowX:'auto', paddingBottom:4, marginBottom:14 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            style={{ flexShrink:0, display:'flex', alignItems:'center', gap:4, padding:'6px 12px',
              background: activeTab === t.id ? T.acg : 'transparent',
              color: activeTab === t.id ? T.acl : T.muted,
              border: `1px solid ${activeTab === t.id ? T.acl : T.border}`,
              borderRadius:10, fontSize:10, fontWeight:700, cursor:'pointer', whiteSpace:'nowrap' }}>
            <span>{t.emoji}</span>{t.label}
          </button>
        ))}
      </div>

      {activeTab === 'onchain'   && <OnChainTab/>}
      {activeTab === 'calendar'  && <CalendarTab/>}
      {activeTab === 'voice'     && <VoiceTab/>}
      {activeTab === 'accounts'  && <AccountsTab prices={prices}/>}
      {activeTab === 'tax'       && <TaxTab currency={currency}/>}
      {activeTab === 'simulator' && <SimulatorTab/>}
      {activeTab === 'community' && <CommunityTab/>}
      {activeTab === 'assistant' && <AssistantTab/>}
    </div>
  );
}

'use client';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Trophy, Crown, Sparkles, Radio, Thermometer, Scale,
} from 'lucide-react';

const T = {
  bg:'#060B14', card:'#0A1628', surf:'#0D1F3C', alt:'#0F2040',
  border:'#1A2D4A', border2:'#243A5E',
  txt:'#E2E8F0', sub:'#94A3B8', muted:'#475569',
  grn:'#10B981', red:'#EF4444', ylw:'#F59E0B', gld:'#D97706',
  acl:'#60A5FA', acc:'#2563EB', acg:'#1E3A5F', prp:'#7C3AED',
} as const;

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:14, padding:'14px 16px', ...style }}>{children}</div>;
}
function SectionTitle({ emoji, icon: IconComp, title, sub }: { emoji?:string; icon?:LucideIcon; title:string; sub?:string }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
      <div style={{ width:32, height:32, borderRadius:10, background:`linear-gradient(135deg,${T.acc},${T.prp})`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, color:'#fff' }}>
        {IconComp ? <IconComp size={16} strokeWidth={2.2} color="#fff"/> : emoji}
      </div>
      <div>
        <div style={{ fontWeight:900, fontSize:15, color:T.txt }}>{title}</div>
        {sub && <div style={{ color:T.muted, fontSize:10 }}>{sub}</div>}
      </div>
    </div>
  );
}

// ─── Market Cap Widget ───────────────────────────────────────────
function MarketCapWidget({ currency, onOpenAsset }: { currency: string; onOpenAsset?: (a: any, dest?: string) => void }) {
  const [cat, setCat] = useState('글로벌');
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const CATS = ['글로벌','미국','한국','기술주','AI/반도체'];

  const load = useCallback(async (c: string) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/mcap?cat=${encodeURIComponent(c)}&limit=10`);
      const d = await r.json();
      setData(d.data || []);
    } catch { setData([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(cat); }, [cat, load]);

  const fmtMcap = (t: number) =>
    t >= 1 ? `$${t.toFixed(2)}T` : t >= 0.1 ? `$${(t*1000).toFixed(0)}B` : `$${(t*1000).toFixed(1)}B`;
  const fmtPx = (px: number, isKRW: boolean) =>
    isKRW ? `₩${px.toLocaleString('ko-KR')}` : `$${px.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div>
      <SectionTitle icon={Trophy} title="시가총액 TOP 10" sub="글로벌 메가캡 기업"/>
      <div style={{ display:'flex', gap:5, overflowX:'auto', paddingBottom:4, marginBottom:10 }}>
        {CATS.map(c => (
          <button key={c} onClick={() => setCat(c)}
            style={{ flexShrink:0, padding:'5px 12px', background:cat===c?T.acg:'transparent',
              color:cat===c?T.acl:T.muted, border:`1px solid ${cat===c?T.acl:T.border}`,
              borderRadius:20, fontSize:11, fontWeight:700, cursor:'pointer' }}>
            {c}
          </button>
        ))}
      </div>
      {loading ? (
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          {[0,1,2,3,4].map(i => (
            <div key={i} style={{ height:60, background:T.card, borderRadius:12, animation:'shimmer 1.2s infinite', backgroundImage:'linear-gradient(90deg,#1A2D4A 25%,#243A5E 50%,#1A2D4A 75%)', backgroundSize:'200% 100%' }}/>
          ))}
        </div>
      ) : data.length === 0 ? (
        <Card style={{ textAlign:'center', padding:'32px 0', color:T.muted }}>데이터 없음</Card>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          {data.map((item, i) => {
            const clickable = !!onOpenAsset;
            // mcap API의 item 구조 → 자산 객체로 변환
            const asAsset = {
              id:     item.ticker,
              sym:    item.ticker,
              nameKr: item.name,
              name:   item.name,
              clr:    T.acl,
              p:      item.price,
              c:      item.change,
              t:      item.country === 'KR' ? 'krstock' : item.country === 'US' ? 'stock' : 'stock',
              category: item.category,
            };
            return (
              <Card key={item.ticker} style={{
                padding:'12px 14px',
                cursor: clickable ? 'pointer' : 'default',
                transition: 'background 120ms',
              }}>
                <div onClick={() => { if (onOpenAsset) onOpenAsset(asAsset, 'trading'); }}
                  style={{ display:'flex', alignItems:'center', gap:10, minHeight: clickable ? 40 : 'auto' }}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (clickable && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      onOpenAsset?.(asAsset, 'trading');
                    }
                  }}>
                  {/* Rank */}
                  <div style={{ width:28, height:28, borderRadius:8, flexShrink:0,
                    background: i===0?T.gld+'30':i===1?'#C0C0C020':i===2?'#CD7F3220':'transparent',
                    border:`1px solid ${i===0?T.gld:i===1?'#C0C0C0':i===2?'#CD7F32':T.border}`,
                    display:'flex', alignItems:'center', justifyContent:'center',
                    color:i===0?T.gld:i===1?'#C0C0C0':i===2?'#CD7F32':T.muted,
                    fontWeight:900, fontSize:11 }}>
                    {item.rank}
                  </div>
                  {/* Logo placeholder */}
                  <div style={{ width:32, height:32, borderRadius:8, flexShrink:0,
                    background:`linear-gradient(135deg,${T.acg},${T.surf})`,
                    border:`1px solid ${T.border}`,
                    display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:12, fontWeight:900, color:T.acl }}>
                    {item.ticker.slice(0,2)}
                  </div>
                  {/* Info */}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                      <div style={{ color:T.txt, fontWeight:800, fontSize:12, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {item.name}
                      </div>
                      <span style={{ color:T.muted, fontSize:9 }}>{item.country}</span>
                    </div>
                    <div style={{ color:T.muted, fontSize:9 }}>
                      {item.ticker} · 시총 {fmtMcap(item.mcapT)}
                      {item.isLive && <span style={{ color:T.grn, marginLeft:4 }}>● 실시간</span>}
                    </div>
                  </div>
                  {/* Price & Change */}
                  <div style={{ textAlign:'right', flexShrink:0 }}>
                    <div style={{ color:T.txt, fontWeight:700, fontSize:11, fontFamily:'monospace' }}>
                      {fmtPx(item.price, item.isKRW)}
                    </div>
                    <div style={{ color: item.change >= 0 ? T.grn : T.red, fontSize:10, fontWeight:700 }}>
                      {item.change >= 0 ? '▲' : '▼'}{Math.abs(item.change).toFixed(2)}%
                    </div>
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

// ─── Copy Trading / Leaderboard ──────────────────────────────────
function CopyTradingWidget() {
  const [traders, setTraders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('roi30d');
  const [following, setFollowing] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLoading(true);
    fetch(`/api/hub?action=leaderboard&sort=${sort}`)
      .then(r => r.json())
      .then(d => setTraders(d.traders || []))
      .catch(() => setTraders([]))
      .finally(() => setLoading(false));
  }, [sort]);

  const riskColor = (r: string) => r === 'low' ? T.grn : r === 'medium' ? T.ylw : T.red;
  const riskLabel = (r: string) => r === 'low' ? '저위험' : r === 'medium' ? '중위험' : '고위험';

  return (
    <div>
      <SectionTitle icon={Crown} title="수익률 리더보드" sub="고수 전략 따라하기 · 복사 거래"/>
      <div style={{ display:'flex', gap:5, marginBottom:10 }}>
        {[['roi30d','30일'],['roi7d','7일'],['winRate','승률'],['followers','팔로워']].map(([k,l]) => (
          <button key={k} onClick={() => setSort(k)}
            style={{ padding:'4px 10px', background:sort===k?T.acg:'transparent',
              color:sort===k?T.acl:T.muted, border:`1px solid ${sort===k?T.acl:T.border}`,
              borderRadius:8, fontSize:10, fontWeight:700, cursor:'pointer' }}>
            {l}
          </button>
        ))}
      </div>
      <div style={{ background:'#F59E0B0A', border:`1px solid ${T.ylw}25`, borderRadius:10, padding:'8px 12px', marginBottom:10, color:T.ylw, fontSize:10 }}>
        ⚠️ 복사 거래는 교육 목적입니다. 과거 수익이 미래를 보장하지 않습니다.
      </div>
      {loading ? (
        <div style={{ color:T.muted, textAlign:'center', padding:'20px 0' }}>로딩 중…</div>
      ) : traders.map(t => (
        <Card key={t.id} style={{ marginBottom:8, padding:'12px 14px' }}>
          <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
            <div style={{ width:38, height:38, borderRadius:12, background:`linear-gradient(135deg,${T.acg},${T.prp+'40'})`,
              border:`1px solid ${T.border}`, display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:14, fontWeight:900, color:T.acl, flexShrink:0 }}>
              {t.name.slice(0,1)}
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:2 }}>
                <div style={{ color:T.txt, fontWeight:800, fontSize:12 }}>{t.name}</div>
                {t.verified && <span style={{ color:T.acl, fontSize:9 }}>✓ 인증</span>}
                <span style={{ background:riskColor(t.risk)+'20', color:riskColor(t.risk), fontSize:8, padding:'1px 5px', borderRadius:4, fontWeight:700 }}>{riskLabel(t.risk)}</span>
              </div>
              <div style={{ color:T.muted, fontSize:9, marginBottom:6 }}>{t.strategy}</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:4 }}>
                {[['30일', t.roi30d + '%', t.roi30d > 0], ['7일', t.roi7d + '%', t.roi7d > 0],
                  ['승률', t.winRate + '%', t.winRate > 50], ['MDD', t.maxDD + '%', false]].map(([l, v, pos]) => (
                  <div key={l as string} style={{ background:T.alt, borderRadius:6, padding:'4px 6px', textAlign:'center' }}>
                    <div style={{ color:T.muted, fontSize:7 }}>{l as string}</div>
                    <div style={{ color:pos ? T.grn : T.red, fontSize:10, fontWeight:700 }}>{v as string}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ flexShrink:0, display:'flex', flexDirection:'column', gap:4 }}>
              <button onClick={() => setFollowing(f => { const s=new Set(f); s.has(t.id)?s.delete(t.id):s.add(t.id); return s; })}
                style={{ padding:'6px 12px', background:following.has(t.id)?T.grn+'20':T.acg,
                  border:`1px solid ${following.has(t.id)?T.grn:T.acl}40`, borderRadius:8,
                  color:following.has(t.id)?T.grn:T.acl, fontSize:10, fontWeight:700, cursor:'pointer', whiteSpace:'nowrap' }}>
                {following.has(t.id) ? '✓ 팔로잉' : '+ 팔로우'}
              </button>
              <div style={{ color:T.muted, fontSize:8, textAlign:'center' }}>
                {t.followers.toLocaleString()}명
              </div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─── AI Strategy Builder ───────────────────────────────────────────
function AIStrategyBuilder() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const EXAMPLES = [
    'RSI + EMA + 거래량 기반 BTC 15분봉 롱 전략',
    '볼린저밴드 하단 터치 후 반등 현물 매매',
    '일목구름 위 + EMA 골든크로스 스윙 전략',
  ];

  const build = async () => {
    if (!input.trim()) return;
    setLoading(true); setResult(null);
    try {
      const r = await fetch('/api/hub', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'build-strategy', description:input }),
      });
      setResult(await r.json());
    } catch { setResult({ error:'오류 발생' }); }
    finally { setLoading(false); }
  };

  return (
    <div>
      <SectionTitle icon={Sparkles} title="AI 전략 빌더" sub="자연어로 전략 설명 → 자동 생성"/>
      <Card style={{ marginBottom:10 }}>
        <textarea value={input} onChange={e => setInput(e.target.value)}
          placeholder="예: RSI + EMA 기반 BTC 15분봉 매수 전략. RSI 30 이하 과매도 + EMA20이 EMA50 위에 있을 때 진입"
          style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:10,
            padding:'10px 14px', color:T.txt, fontSize:12, lineHeight:1.6, outline:'none', resize:'vertical',
            minHeight:70, boxSizing:'border-box' }}/>
        <div style={{ display:'flex', gap:5, flexWrap:'wrap', margin:'8px 0' }}>
          {EXAMPLES.map(e => (
            <button key={e} onClick={() => setInput(e)}
              style={{ background:T.alt, border:`1px solid ${T.border}`, borderRadius:8,
                color:T.muted, fontSize:9, padding:'3px 8px', cursor:'pointer' }}>
              {e.slice(0,20)}…
            </button>
          ))}
        </div>
        <button onClick={build} disabled={loading||!input.trim()}
          style={{ width:'100%', padding:'11px', background:loading||!input.trim()?T.alt:'linear-gradient(135deg,#2563EB,#7C3AED)',
            color:loading||!input.trim()?T.muted:'#fff', border:'none', borderRadius:10, fontWeight:800, fontSize:13, cursor:loading||!input.trim()?'not-allowed':'pointer' }}>
          {loading ? '🤖 AI 생성 중…' : '🚀 전략 생성'}
        </button>
      </Card>
      {result?.strategy && (
        <Card>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:10 }}>
            <div style={{ color:T.txt, fontWeight:800, fontSize:13 }}>{result.strategy.name}</div>
            <span style={{ background:result.source==='openai'?T.grn+'20':T.ylw+'20',
              color:result.source==='openai'?T.grn:T.ylw, fontSize:9, padding:'2px 7px', borderRadius:6 }}>
              {result.source==='openai'?'✅ GPT-4o':'📚 기본'}
            </span>
          </div>
          {[
            ['타임프레임', result.strategy.timeframe],
            ['종목', result.strategy.symbol],
            ['방향', result.strategy.direction],
            ['위험도', result.strategy.risk],
          ].map(([l, v]) => (
            <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:`1px solid ${T.border}` }}>
              <span style={{ color:T.muted, fontSize:11 }}>{l}</span>
              <span style={{ color:T.txt, fontSize:11, fontWeight:600 }}>{v}</span>
            </div>
          ))}
          <div style={{ marginTop:8 }}>
            <div style={{ color:T.sub, fontSize:11, fontWeight:700, marginBottom:4 }}>진입 조건</div>
            {(result.strategy.entryConditions||[]).map((c: string, i: number) => (
              <div key={i} style={{ color:T.grn, fontSize:10, padding:'2px 0' }}>✓ {c}</div>
            ))}
          </div>
          <div style={{ marginTop:8 }}>
            <div style={{ color:T.sub, fontSize:11, fontWeight:700, marginBottom:4 }}>청산 조건</div>
            {(result.strategy.exitConditions||[]).map((c: string, i: number) => (
              <div key={i} style={{ color:T.red, fontSize:10, padding:'2px 0' }}>✗ {c}</div>
            ))}
          </div>
          {result.strategy.webhook && (
            <div style={{ marginTop:8, background:T.alt, borderRadius:8, padding:'8px 10px' }}>
              <div style={{ color:T.acl, fontSize:10, fontWeight:700, marginBottom:3 }}>📡 웹훅 알림</div>
              <div style={{ color:T.sub, fontSize:9, fontFamily:'monospace', lineHeight:1.5 }}>
                {result.strategy.webhook.alert}
              </div>
            </div>
          )}
          <div style={{ marginTop:8, background:'#EF444408', border:`1px solid ${T.red}20`, borderRadius:8, padding:'7px 10px', color:T.muted, fontSize:9 }}>
            ⚠️ AI 생성 전략은 교육 목적입니다. 실제 투자 전 충분한 검토가 필요합니다.
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Market Briefing ──────────────────────────────────────────────
function MarketBriefing() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [headline, setHeadline] = useState('');
  const [impact, setImpact] = useState<any>(null);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    fetch('/api/hub?action=briefing')
      .then(r => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const analyzeNews = async () => {
    if (!headline.trim()) return;
    setAnalyzing(true); setImpact(null);
    try {
      const r = await fetch('/api/hub', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'news-impact', headline }),
      });
      setImpact(await r.json());
    } catch {} finally { setAnalyzing(false); }
  };

  const impactColor = (v: string) => v === 'BULLISH' ? T.grn : v === 'BEARISH' ? T.red : T.ylw;
  const NEWS_EXAMPLES = ['FOMC 금리 동결 결정','비트코인 ETF 승인 가능성 상승','CPI 예상치 상회'];

  return (
    <div>
      <SectionTitle icon={Radio} title="AI 시장 브리핑" sub="일일 시장 요약 · 이벤트 영향 분석"/>
      {loading ? (
        <div style={{ height:80, background:T.card, borderRadius:12, marginBottom:10 }}/>
      ) : data && (
        <Card style={{ marginBottom:10, background:'linear-gradient(135deg,#0D1A35,#091228)', border:`1px solid ${T.acl}30` }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
            <div style={{ color:T.acl, fontWeight:700, fontSize:11 }}>📊 오늘의 시장</div>
            <span style={{ background:data.source==='openai'?T.grn+'20':T.ylw+'20', color:data.source==='openai'?T.grn:T.ylw, fontSize:8, padding:'1px 6px', borderRadius:5 }}>
              {data.source==='openai'?'GPT-4o':'기본'}
            </span>
          </div>
          <div style={{ color:T.txt, fontSize:12, lineHeight:1.7, marginBottom:10, whiteSpace:'pre-wrap' }}>{data.aiSummary}</div>
          <div className="mobile-1col" style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6 }}>
            {(() => {
              const p = Number(data.btcPrice);
              const c = Number(data.btcChg);
              const priceLabel = Number.isFinite(p) && p > 0
                ? `₩${Math.round(p/10000).toLocaleString('ko-KR')}만`
                : '데이터 로딩 중';
              const chgColor = Number.isFinite(c) ? (c >= 0 ? T.grn : T.red) : T.muted;
              return [
                { label:'BTC',       value: priceLabel,                color: chgColor },
                { label:'펀딩 편향', value: data.fundBias || '중립',    color: T.ylw },
                { label:'시장 감성', value: data.sentiment || '분석중',  color: T.acl },
              ];
            })().map(m => (
              <div key={m.label} style={{ background:T.alt, borderRadius:8, padding:'6px', textAlign:'center' }}>
                <div style={{ color:T.muted, fontSize:8 }}>{m.label}</div>
                <div style={{ color:m.color, fontSize:10, fontWeight:700 }}>{m.value}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:8 }}>🔍 뉴스 영향 분석</div>
        <div style={{ display:'flex', gap:6, marginBottom:6 }}>
          <input value={headline} onChange={e => setHeadline(e.target.value)}
            placeholder="뉴스 헤드라인 입력 (FOMC, CPI, ETF…)"
            style={{ flex:1, background:T.bg, border:`1px solid ${T.border}`, borderRadius:8, padding:'8px 12px', color:T.txt, fontSize:12, outline:'none' }}/>
          <button onClick={analyzeNews} disabled={analyzing||!headline.trim()}
            style={{ padding:'8px 14px', background:T.acg, border:`1px solid ${T.acl}40`, borderRadius:8, color:T.acl, fontWeight:700, fontSize:11, cursor:'pointer', flexShrink:0 }}>
            {analyzing?'분석 중':'분석'}
          </button>
        </div>
        <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom:8 }}>
          {NEWS_EXAMPLES.map(e => (
            <button key={e} onClick={() => setHeadline(e)}
              style={{ background:T.alt, border:`1px solid ${T.border}`, borderRadius:6, color:T.muted, fontSize:9, padding:'2px 8px', cursor:'pointer' }}>
              {e}
            </button>
          ))}
        </div>
        {impact && (
          <div style={{ background:impactColor(impact.impact)+'10', border:`1px solid ${impactColor(impact.impact)}30`, borderRadius:10, padding:'10px 12px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
              <span style={{ color:impactColor(impact.impact), fontWeight:800, fontSize:13 }}>
                {impact.impact==='BULLISH'?'🟢 상승 압력':impact.impact==='BEARISH'?'🔴 하락 압력':'🟡 중립'}
              </span>
              <span style={{ color:impactColor(impact.impact), fontSize:12, fontWeight:700 }}>
                점수: {impact.score > 0 ? '+' : ''}{impact.score}
              </span>
            </div>
            <div style={{ color:T.sub, fontSize:11 }}>{impact.reason}</div>
            <div style={{ marginTop:4, color:T.muted, fontSize:10 }}>변동성: {impact.volatility}</div>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Liquidation Heatmap ─────────────────────────────────────────
function LiquidationMap() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/hub?action=liquidation&symbol=BTCUSDT')
      .then(r => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div>
      <SectionTitle icon={Thermometer} title="청산 히트맵" sub="롱/숏 청산 구간 분석"/>
      <div style={{ height:200, background:T.card, borderRadius:12, display:'flex', alignItems:'center', justifyContent:'center', color:T.muted }}>데이터 로딩 중…</div>
    </div>
  );

  const levels = data?.levels || [];
  const majorLevels = levels.filter((l: any) => l.size === 'MAJOR');
  const maxVol = Math.max(...levels.map((l: any) => l.volume), 1);

  return (
    <div>
      <SectionTitle icon={Thermometer} title="청산 히트맵" sub="롱/숏 청산 구간 분석"/>
      {data && (
        <>
          <Card style={{ marginBottom:10 }}>
            <div className="mobile-1col" style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:10 }}>
              <div style={{ background:T.alt, borderRadius:8, padding:'8px', textAlign:'center' }}>
                <div style={{ color:T.muted, fontSize:8 }}>현재가</div>
                <div style={{ color:T.txt, fontWeight:700, fontSize:11 }}>
                  {(() => {
                    const p = Number(data.currentPriceKRW);
                    return Number.isFinite(p) && p > 0
                      ? `₩${Math.round(p/10000).toLocaleString('ko-KR')}만`
                      : '—';
                  })()}
                </div>
              </div>
              <div style={{ background:T.grn+'15', borderRadius:8, padding:'8px', textAlign:'center' }}>
                <div style={{ color:T.muted, fontSize:8 }}>롱 비중</div>
                <div style={{ color:T.grn, fontWeight:800, fontSize:14 }}>
                  {Number.isFinite(Number(data.longRatio)) ? `${data.longRatio}%` : '—'}
                </div>
              </div>
              <div style={{ background:T.red+'15', borderRadius:8, padding:'8px', textAlign:'center' }}>
                <div style={{ color:T.muted, fontSize:8 }}>숏 비중</div>
                <div style={{ color:T.red, fontWeight:800, fontSize:14 }}>
                  {Number.isFinite(Number(data.shortRatio)) ? `${data.shortRatio}%` : '—'}
                </div>
              </div>
            </div>
            {/* Visual heatmap bars */}
            <div style={{ position:'relative', marginBottom:8 }}>
              {levels.map((l: any, i: number) => {
                const barW = (l.volume / maxVol) * 100;
                const isLong = l.side === 'LONG_LIQ';
                const pct = Math.abs(l.pct);
                return (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                    <div style={{ width:35, textAlign:'right', color:T.muted, fontSize:8, flexShrink:0 }}>
                      {l.pct > 0 ? '+' : ''}{l.pct}%
                    </div>
                    <div style={{ flex:1, height:8, background:T.alt, borderRadius:4, overflow:'hidden', position:'relative' }}>
                      <div style={{
                        position:'absolute', top:0, height:'100%',
                        left: isLong ? 0 : 'auto', right: isLong ? 'auto' : 0,
                        width:`${barW}%`,
                        background: isLong
                          ? `rgba(239,68,68,${0.4 + barW/200})`
                          : `rgba(16,185,129,${0.4 + barW/200})`,
                        borderRadius:4,
                      }}/>
                    </div>
                    <div style={{ width:20, color:T.muted, fontSize:7, flexShrink:0, textAlign:'right' }}>
                      {l.size === 'MAJOR' ? '🔴' : l.size === 'MEDIUM' ? '🟡' : '⚪'}
                    </div>
                  </div>
                );
              })}
              {/* Center line marker */}
              <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                <div style={{ width:35, textAlign:'right', color:T.acl, fontSize:8, fontWeight:700, flexShrink:0 }}>현재가</div>
                <div style={{ flex:1, height:2, background:T.acl, borderRadius:2 }}/>
                <div style={{ width:20 }}/>
              </div>
            </div>
            <div style={{ color:T.muted, fontSize:9, textAlign:'center' }}>
              🔴 롱 청산 구간 | 🟢 숏 청산 구간 · 크기 = 예상 청산 물량
            </div>
          </Card>
          {majorLevels.length > 0 && (
            <Card>
              <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:8 }}>⚡ 주요 청산 구간</div>
              {majorLevels.map((l: any, i: number) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:`1px solid ${T.border}` }}>
                  <div style={{ color: l.side==='LONG_LIQ' ? T.red : T.grn, fontSize:11 }}>
                    {l.side==='LONG_LIQ' ? '🔴 롱 청산' : '🟢 숏 청산'} {l.pct > 0 ? '+' : ''}{l.pct}%
                  </div>
                  <div style={{ color:T.txt, fontSize:11, fontFamily:'monospace' }}>₩{Math.round(l.priceKRW/10000)}만</div>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ─── Portfolio Rebalance ─────────────────────────────────────────
function PortfolioRebalance({ currency }: { currency: string }) {
  const [profile, setProfile] = useState('balanced');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const calc = async (p: string) => {
    setLoading(true);
    try {
      const r = await fetch('/api/hub', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'rebalance', holdings:[], riskProfile:p }),
      });
      setData(await r.json());
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { calc(profile); }, [profile]);

  return (
    <div>
      <SectionTitle icon={Scale} title="AI 포트폴리오 리밸런싱" sub="동적 자산 배분 최적화"/>
      <div style={{ display:'flex', gap:6, marginBottom:10 }}>
        {[['conservative','안전형'],['balanced','균형형'],['aggressive','공격형']].map(([k,l]) => (
          <button key={k} onClick={() => { setProfile(k); calc(k); }}
            style={{ flex:1, padding:'7px', background:profile===k?T.acg:'transparent',
              color:profile===k?T.acl:T.muted, border:`1px solid ${profile===k?T.acl:T.border}`,
              borderRadius:8, fontSize:11, fontWeight:700, cursor:'pointer' }}>
            {l}
          </button>
        ))}
      </div>
      {data && (
        <Card>
          {(Array.isArray(data.allocations) ? data.allocations : []).map((a: any) => (
            <div key={a.type} style={{ marginBottom:12 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                <span style={{ color:T.txt, fontSize:11, fontWeight:700 }}>{a.type}</span>
                <span style={{ color:T.acl, fontSize:11 }}>목표 {a.target}% / 현재 {a.current}%</span>
              </div>
              <div style={{ height:6, background:T.alt, borderRadius:3, overflow:'hidden', marginBottom:3 }}>
                <div style={{ height:'100%', width:`${a.current}%`, background:T.acl, borderRadius:3, transition:'width .5s' }}/>
              </div>
              <div style={{ height:6, background:T.alt, borderRadius:3, overflow:'hidden', marginBottom:4 }}>
                <div style={{ height:'100%', width:`${a.target}%`, background:T.grn, borderRadius:3, transition:'width .5s' }}/>
              </div>
              <div style={{ color: a.current < a.target ? T.grn : T.red, fontSize:10 }}>
                → {a.action}: ₩{Math.round(a.amount).toLocaleString()}
              </div>
            </div>
          ))}
          <div style={{ marginTop:8, background:T.alt, borderRadius:8, padding:'8px 10px' }}>
            <div style={{ color:T.muted, fontSize:10 }}>권장 최대 레버리지: <strong style={{ color:T.ylw }}>{data.maxLeverage}x</strong></div>
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── MAIN HUB PAGE ───────────────────────────────────────────────
const SECTIONS = [
  { id:'mcap',      label:'시총 TOP10', emoji:'🏆' },
  { id:'copy',      label:'복사 거래',  emoji:'👑' },
  { id:'ai-build',  label:'AI 전략',   emoji:'🤖' },
  { id:'briefing',  label:'시장 브리핑',emoji:'📡' },
  { id:'liq',       label:'청산 맵',   emoji:'🌡️' },
  { id:'rebalance', label:'리밸런싱',   emoji:'⚖️' },
];

export default function HubDashboard({ currency = 'KRW', onOpenAsset }: { currency?: string; onOpenAsset?: (a: any, dest?: string) => void }) {
  const [section, setSection] = useState('mcap');

  return (
    <div style={{ color: T.txt }}>
      {/* Section tabs */}
      <div style={{ display:'flex', gap:5, overflowX:'auto', paddingBottom:4, marginBottom:14 }}>
        {SECTIONS.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            style={{ flexShrink:0, display:'flex', alignItems:'center', gap:5, padding:'6px 12px',
              background: section===s.id ? T.acg : 'transparent',
              color: section===s.id ? T.acl : T.muted,
              border:`1px solid ${section===s.id ? T.acl : T.border}`,
              borderRadius:10, fontSize:11, fontWeight:700, cursor:'pointer', whiteSpace:'nowrap' }}>
            <span>{s.emoji}</span>{s.label}
          </button>
        ))}
      </div>

      {section === 'mcap'     && <MarketCapWidget currency={currency} onOpenAsset={onOpenAsset}/>}
      {section === 'copy'     && <CopyTradingWidget/>}
      {section === 'ai-build' && <AIStrategyBuilder/>}
      {section === 'briefing' && <MarketBriefing/>}
      {section === 'liq'      && <LiquidationMap/>}
      {section === 'rebalance'&& <PortfolioRebalance currency={currency}/>}
    </div>
  );
}

'use client';
import React, { useState, useEffect, useRef } from 'react';

const T = {
  bg:'#060B14', card:'#0F1924', border:'#1A2D4A', border2:'#243A5E',
  acc:'#2563EB', acl:'#3B82F6', acg:'rgba(37,99,235,.15)',
  grn:'#10B981', red:'#EF4444', ylw:'#F59E0B', prp:'#7C3AED',
  txt:'#F0F6FF', sub:'#94A3B8', muted:'#475569', surf:'#0D1626',
};

type Layout = '1'|'2h'|'2v'|'4';

const FEATURED = [
  { sym:'BTCUSDT', label:'비트코인',  tv:'BINANCE:BTCUSDT', cat:'crypto', clr:'#F7931A' },
  { sym:'ETHUSDT', label:'이더리움',  tv:'BINANCE:ETHUSDT', cat:'crypto', clr:'#627EEA' },
  { sym:'SOLUSDT', label:'솔라나',    tv:'BINANCE:SOLUSDT', cat:'crypto', clr:'#9945FF' },
  { sym:'AAPL',    label:'애플',      tv:'NASDAQ:AAPL',     cat:'stock',  clr:'#A0A0A0' },
  { sym:'NVDA',    label:'엔비디아',  tv:'NASDAQ:NVDA',     cat:'stock',  clr:'#76B900' },
  { sym:'TSLA',    label:'테슬라',    tv:'NASDAQ:TSLA',     cat:'stock',  clr:'#CC0000' },
  { sym:'MSFT',    label:'마이크로소프트',tv:'NASDAQ:MSFT', cat:'stock',  clr:'#00A4EF' },
  { sym:'SPX',     label:'S&P 500',   tv:'SP:SPX',          cat:'index',  clr:'#3B82F6' },
  { sym:'NDX',     label:'나스닥100', tv:'NASDAQ:NDX',      cat:'index',  clr:'#7C3AED' },
  { sym:'005930',  label:'삼성전자',  tv:'KRX:005930',      cat:'krstock',clr:'#1428A0' },
  { sym:'000660',  label:'SK하이닉스',tv:'KRX:000660',      cat:'krstock',clr:'#EA1917' },
  { sym:'XAUUSD',  label:'금(Gold)',  tv:'OANDA:XAUUSD',    cat:'commodity',clr:'#FFD700'},
  { sym:'USOIL',   label:'WTI 원유',  tv:'TVC:USOIL',       cat:'commodity',clr:'#8B4513'},
  { sym:'EURUSD',  label:'유로/달러', tv:'FX:EURUSD',       cat:'forex',  clr:'#003399' },
  { sym:'DXY',     label:'달러 인덱스',tv:'TVC:DXY',        cat:'index',  clr:'#10B981' },
];

const CAT_LABELS: Record<string,string> = {
  all:'전체',crypto:'코인',stock:'미국주식',krstock:'한국주식',
  index:'지수',commodity:'원자재',forex:'환율',
};
const CAT_COLORS: Record<string,string> = {
  crypto:'#F7931A',stock:'#3B82F6',krstock:'#EF4444',
  index:'#7C3AED',commodity:'#F59E0B',forex:'#10B981',
};

function toTVSymbol(input: string): string {
  const q = input.trim().toUpperCase();
  if (q.includes(':')) return q;
  // Korean stock codes
  if (/^\d{6}$/.test(q)) return `KRX:${q}`;
  // Crypto pairs
  const cryptos = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','TON','LINK','DOT','MATIC','ARB','OP','SUI','PEPE','SHIB','UNI'];
  if (cryptos.includes(q) || q.endsWith('USDT') || q.endsWith('BTC')) {
    const base = q.replace('USDT','').replace('BTC','');
    return `BINANCE:${base}USDT`;
  }
  // Known tickers
  const map: Record<string,string> = {
    GOLD:'OANDA:XAUUSD', XAU:'OANDA:XAUUSD', OIL:'TVC:USOIL',
    DXY:'TVC:DXY', SPX:'SP:SPX', NDX:'NASDAQ:NDX', VIX:'TVC:VIX',
    EURUSD:'FX:EURUSD', USDJPY:'FX:USDJPY', GBPUSD:'FX:GBPUSD',
  };
  if (map[q]) return map[q];
  // Default: NASDAQ
  return `NASDAQ:${q}`;
}

function TVWidget({ symbol, height = 480 }: { symbol: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const wsRef = useRef<any>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = '';
    wsRef.current?.remove?.();

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.async = true;
    script.onload = () => {
      if (!ref.current || !(window as any).TradingView) return;
      wsRef.current = new (window as any).TradingView.widget({
        container_id: ref.current.id,
        symbol,
        interval: '60',
        timezone: 'Asia/Seoul',
        theme: 'dark',
        style: '1',
        locale: 'kr',
        toolbar_bg: T.bg,
        enable_publishing: false,
        allow_symbol_change: true,
        save_image: false,
        hide_side_toolbar: false,
        withdateranges: true,
        hide_legend: false,
        studies: ['RSI@tv-basicstudies', 'MACD@tv-basicstudies'],
        width: '100%',
        height,
        backgroundColor: T.bg,
        gridColor: T.border,
        overrides: {
          'paneProperties.background': T.bg,
          'paneProperties.backgroundType': 'solid',
        },
      });
    };
    script.onerror = () => {
      if (ref.current) {
        ref.current.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:8px;background:${T.card}">
          <div style="font-size:24px">📊</div>
          <div style="color:${T.txt};font-weight:700;font-size:13px">${symbol}</div>
          <div style="color:${T.muted};font-size:11px">TradingView 차트 로딩 중...</div>
          <div style="color:${T.muted};font-size:10px">광고 차단기를 비활성화하면 차트가 표시됩니다</div>
        </div>`;
      }
    };
    const id = 'tv_' + symbol.replace(/[^a-zA-Z0-9]/g,'_') + '_' + Date.now();
    ref.current.id = id;
    document.head.appendChild(script);

    return () => {
      script.remove();
      wsRef.current?.remove?.();
    };
  }, [symbol, height]);

  return (
    <div
      ref={ref}
      style={{ width:'100%', height, borderRadius:12, overflow:'hidden', background:T.card }}
    />
  );
}

export default function ChartPage() {
  const [layout, setLayout] = useState<Layout>('1');
  const [symbols, setSymbols] = useState(['BINANCE:BTCUSDT','NASDAQ:NVDA','SP:SPX','FX:EURUSD']);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('all');
  const [manualInput, setManualInput] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem('tg_chart_recent') || '[]'); } catch { return []; }
  });
  const [liveData, setLiveData] = useState<Record<string,{price:number;change:number;source:string}>>({});
  const [provStatus, setProvStatus] = useState<'live'|'mock'|null>(null);

  // Fetch live prices
  useEffect(() => {
    let cancelled = false;
    async function fetchPrices() {
      try {
        const res = await fetch('/api/prices');
        const json = await res.json();
        if (cancelled) return;
        setProvStatus(json.status as 'live'|'mock');
        const map: Record<string,{price:number;change:number;source:string}> = {};
        for (const item of (json.data || [])) {
          map[item.symbol] = { price: item.price, change: item.change24h, source: json.status };
        }
        setLiveData(map);
      } catch {}
    }
    fetchPrices();
    const iv = setInterval(fetchPrices, 15000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  const setSymbol = (idx: number, tv: string) => {
    setSymbols(prev => { const next = [...prev]; next[idx] = tv; return next; });
    setRecent(prev => {
      const next = [tv, ...prev.filter(s => s !== tv)].slice(0, 10);
      if (typeof window !== 'undefined') localStorage.setItem('tg_chart_recent', JSON.stringify(next));
      return next;
    });
    setQuery('');
  };

  const applyManual = () => {
    if (!manualInput.trim()) return;
    const tv = toTVSymbol(manualInput);
    setSymbol(0, tv);
    setManualInput('');
    setShowManual(false);
  };

  const filtered = FEATURED.filter(f =>
    (cat === 'all' || f.cat === cat) &&
    (!query || f.sym.toLowerCase().includes(query.toLowerCase()) || f.label.includes(query))
  );

  const CHART_HEIGHTS: Record<Layout, number> = { '1': 520, '2h': 380, '2v': 460, '4': 320 };
  const h = CHART_HEIGHTS[layout];

  // Get price info for current main symbol
  const mainSymBase = symbols[0].split(':')[1]?.replace('USDT','') || 'BTC';
  const mainLive = liveData[mainSymBase];

  return (
    <div style={{ minHeight:'100vh', background:T.bg, fontFamily:"'Sora',sans-serif", color:T.txt }}>
      {/* Top bar */}
      <div style={{ background:T.surf, borderBottom:`1px solid ${T.border}`, padding:'10px 14px', display:'flex', justifyContent:'space-between', alignItems:'center', position:'sticky', top:0, zIndex:50 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <a href="/" style={{ color:T.acl, fontWeight:800, fontSize:14, textDecoration:'none' }}>← TRAIGO</a>
          <div style={{ color:T.txt, fontWeight:700, fontSize:13 }}>📊 차트</div>
          <div style={{ background:T.card, borderRadius:8, padding:'3px 10px', fontSize:10, fontFamily:'monospace', color:T.acl }}>{symbols[0]}</div>
        </div>
        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
          {provStatus && (
            <span style={{ background:provStatus==='live'?T.grn+'20':T.ylw+'20', color:provStatus==='live'?T.grn:T.ylw, fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:99 }}>
              {provStatus==='live'?'● LIVE':'● MOCK'}
            </span>
          )}
          <button onClick={() => document.documentElement.requestFullscreen?.()} style={{ background:T.acg, color:T.acl, border:`1px solid ${T.acl}40`, borderRadius:8, padding:'4px 10px', fontSize:10, fontWeight:700, cursor:'pointer' }}>⛶ 전체화면</button>
        </div>
      </div>

      <div style={{ padding:`12px 12px calc(100px + env(safe-area-inset-bottom, 0px))` }}>
        {/* Live price bar */}
        {mainLive && (
          <div style={{ background:`linear-gradient(135deg,${T.card},${T.surf})`, border:`1px solid ${T.border2}`, borderRadius:12, padding:'10px 14px', marginBottom:10, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={{ fontFamily:'monospace', fontSize:11, color:T.muted }}>{symbols[0]}</div>
            <div style={{ display:'flex', gap:10, alignItems:'center' }}>
              <span style={{ color:T.txt, fontWeight:700, fontSize:15, fontFamily:'monospace' }}>
                {mainLive.price >= 1000 ? mainLive.price.toLocaleString('ko-KR',{maximumFractionDigits:0})+'원' : mainLive.price.toFixed(4)}
              </span>
              <span style={{ color:mainLive.change>=0?T.grn:T.red, fontWeight:700, fontSize:12 }}>
                {mainLive.change>=0?'+':''}{mainLive.change.toFixed(2)}%
              </span>
            </div>
          </div>
        )}

        {/* Layout selector */}
        <div style={{ display:'flex', gap:5, marginBottom:10 }}>
          {([['1','▣ 1분할'],['2h','⬒ 2×가로'],['2v','⬓ 2×세로'],['4','⊞ 4분할']] as [Layout,string][]).map(([id,l]) => (
            <button key={id} onClick={() => setLayout(id)} style={{ flex:1, padding:'7px', background:layout===id?T.acg:'transparent', color:layout===id?T.acl:T.muted, border:`1px solid ${layout===id?T.acl:T.border}`, borderRadius:9, fontSize:10, fontWeight:700, cursor:'pointer' }}>{l}</button>
          ))}
        </div>

        {/* Chart panels */}
        {layout === '1' && (
          <div style={{ marginBottom:12, borderRadius:12, overflow:'hidden', border:`1px solid ${T.border}` }}>
            <TVWidget symbol={symbols[0]} height={h}/>
          </div>
        )}
        {layout === '2h' && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:12 }}>
            {[0,1].map(i => (
              <div key={i} style={{ borderRadius:10, overflow:'hidden', border:`1px solid ${T.border}` }}>
                <TVWidget symbol={symbols[i]} height={h}/>
              </div>
            ))}
          </div>
        )}
        {layout === '2v' && (
          <div style={{ display:'grid', gridTemplateRows:'auto auto', gap:6, marginBottom:12 }}>
            {[0,1].map(i => (
              <div key={i} style={{ borderRadius:10, overflow:'hidden', border:`1px solid ${T.border}` }}>
                <TVWidget symbol={symbols[i]} height={h}/>
              </div>
            ))}
          </div>
        )}
        {layout === '4' && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5, marginBottom:12 }}>
            {[0,1,2,3].map(i => (
              <div key={i} style={{ borderRadius:9, overflow:'hidden', border:`1px solid ${T.border}` }}>
                <TVWidget symbol={symbols[i]} height={h}/>
              </div>
            ))}
          </div>
        )}

        {/* Search & filter */}
        <div style={{ display:'flex', gap:6, marginBottom:8 }}>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="검색 (BTC, AAPL, 005930, OANDA:XAUUSD…)"
            style={{ flex:1, background:T.card, border:`1px solid ${T.border}`, borderRadius:9, padding:'9px 12px', color:T.txt, fontSize:12, outline:'none' }}/>
          <button onClick={() => setShowManual(v => !v)} style={{ background:showManual?T.acg:'transparent', color:showManual?T.acl:T.muted, border:`1px solid ${showManual?T.acl:T.border}`, borderRadius:9, padding:'9px 12px', fontSize:11, fontWeight:700, cursor:'pointer' }}>⌨️</button>
        </div>

        {showManual && (
          <div style={{ display:'flex', gap:6, marginBottom:8 }}>
            <input value={manualInput} onChange={e => setManualInput(e.target.value.toUpperCase())} onKeyDown={e => e.key==='Enter' && applyManual()}
              placeholder="NASDAQ:AAPL, KRX:005930, BINANCE:BTCUSDT…"
              style={{ flex:1, background:T.card, border:`1px solid ${T.acl}`, borderRadius:9, padding:'9px 12px', color:T.acl, fontSize:12, fontFamily:'monospace', fontWeight:700, outline:'none', letterSpacing:.5 }}/>
            <button onClick={applyManual} style={{ background:T.acc, color:'#fff', border:'none', borderRadius:9, padding:'9px 14px', fontSize:11, fontWeight:700, cursor:'pointer' }}>차트</button>
          </div>
        )}

        {/* Category filter */}
        <div style={{ display:'flex', gap:4, overflowX:'auto', paddingBottom:4, marginBottom:8 }}>
          {Object.entries(CAT_LABELS).map(([id,l]) => (
            <button key={id} onClick={() => setCat(id)} style={{ flexShrink:0, padding:'3px 10px', background:cat===id?T.acg:'transparent', color:cat===id?T.acl:T.muted, border:`1px solid ${cat===id?T.acl:T.border}`, borderRadius:20, fontSize:10, fontWeight:700, cursor:'pointer' }}>{l}</button>
          ))}
        </div>

        {/* Asset grid */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:5, marginBottom:12 }}>
          {filtered.map(f => {
            const base = f.sym.replace('USDT','').replace(/^0+/,'');
            const live = liveData[base] || liveData[f.sym];
            return (
              <button key={f.tv} onClick={() => setSymbol(0, f.tv)} style={{ background:symbols[0]===f.tv?f.clr+'20':T.card, border:`2px solid ${symbols[0]===f.tv?f.clr:T.border}`, borderRadius:10, padding:'8px 5px', cursor:'pointer', textAlign:'center' }}>
                <div style={{ width:24, height:24, borderRadius:6, background:`${f.clr}20`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:8, fontWeight:900, color:f.clr, margin:'0 auto 3px' }}>{f.sym.slice(0,3)}</div>
                <div style={{ color:symbols[0]===f.tv?f.clr:T.txt, fontWeight:700, fontSize:9, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.sym.slice(0,6)}</div>
                {live ? (
                  <div style={{ color:live.change>=0?T.grn:T.red, fontSize:7, marginTop:1, fontWeight:700 }}>{live.change>=0?'+':''}{live.change.toFixed(1)}%</div>
                ) : (
                  <div style={{ color:T.muted, fontSize:7, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.label.slice(0,4)}</div>
                )}
              </button>
            );
          })}
        </div>

        {/* Recent */}
        {recent.length > 0 && (
          <div>
            <div style={{ color:T.muted, fontSize:10, fontWeight:700, marginBottom:6 }}>최근 검색</div>
            <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
              {recent.map(r => (
                <button key={r} onClick={() => setSymbol(0, r)} style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:7, padding:'4px 10px', color:T.sub, fontSize:10, fontFamily:'monospace', cursor:'pointer' }}>{r}</button>
              ))}
            </div>
          </div>
        )}

        {/* Symbol format guide */}
        <div style={{ marginTop:14, background:T.card, border:`1px solid ${T.border2}`, borderRadius:12, padding:'12px 14px' }}>
          <div style={{ color:T.muted, fontSize:10, fontWeight:700, marginBottom:8 }}>💡 TradingView 심볼 형식</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4 }}>
            {[
              ['미국 주식','NASDAQ:AAPL'],['한국 주식','KRX:005930'],
              ['암호화폐','BINANCE:BTCUSDT'],['지수','SP:SPX'],
              ['금','OANDA:XAUUSD'],['원유','TVC:USOIL'],
              ['환율','FX:EURUSD'],['달러지수','TVC:DXY'],
            ].map(([l,ex]) => (
              <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'3px 0' }}>
                <span style={{ color:T.muted, fontSize:9 }}>{l}</span>
                <button onClick={() => setManualInput(ex)} style={{ color:T.acl, fontSize:9, fontFamily:'monospace', background:'none', border:'none', cursor:'pointer' }}>{ex}</button>
              </div>
            ))}
          </div>
          <div style={{ color:T.muted, fontSize:9, marginTop:6 }}>⌨️ 직접 입력에 위 형식을 그대로 붙여넣으세요</div>
        </div>
      </div>
    </div>
  );
}

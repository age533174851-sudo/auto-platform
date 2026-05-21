'use client';
import React, { useState, useEffect, useCallback } from 'react';

// ─── Poster Data ────────────────────────────────────────────────
const POSTER_DATA = [
  { id:1,  title:'일목구름표 기본 보는법',          category:'기본기',     available:true  },
  { id:2,  title:'롱(매수) 진입 전략',             category:'진입 전략',   available:false },
  { id:3,  title:'숏(매도) 진입 전략',             category:'진입 전략',   available:true  },
  { id:4,  title:'손절·익절 원칙',                 category:'리스크 관리', available:false },
  { id:5,  title:'레버리지 리스크',                category:'리스크 관리', available:false },
  { id:6,  title:'EMA 배열 전략',                 category:'보조지표',    available:true  },
  { id:7,  title:'추세 전환 포착 전략',             category:'고급 전략',   available:true  },
  { id:8,  title:'피보나치 되돌림',                category:'보조지표',    available:false },
  { id:9,  title:'캔들 패턴 읽기',                 category:'기본기',     available:false },
  { id:10, title:'지지·저항 핵심',                 category:'기본기',     available:false },
  { id:11, title:'추세선 기초',                    category:'기본기',     available:false },
  { id:12, title:'포지션 사이징 기초',              category:'리스크 관리', available:false },
  { id:13, title:'심리·감정 관리',                 category:'시장 심리',   available:false },
  { id:14, title:'매매 계획 수립',                  category:'리스크 관리', available:false },
  { id:15, title:'포지션 사이징(자금 관리)',          category:'리스크 관리', available:true  },
  { id:16, title:'손익비(Risk:Reward) 설정',        category:'리스크 관리', available:true  },
  { id:17, title:'목표가 설정 방법',                category:'진입 전략',   available:true  },
  { id:18, title:'익절(수익 실현) 전략',             category:'리스크 관리', available:true  },
  { id:19, title:'손절(손실 제한) 전략',             category:'리스크 관리', available:true  },
  { id:20, title:'시장 상황별 대응 전략',            category:'고급 전략',   available:true  },
  { id:21, title:'복기 & 기록 관리',               category:'리스크 관리', available:true  },
  { id:22, title:'멘탈 관리(심리 관리)',             category:'시장 심리',   available:true  },
  { id:23, title:'매매 루틴 만들기',                category:'리스크 관리', available:true  },
  { id:24, title:'장기적으로 성공하는 마인드셋',       category:'시장 심리',   available:true  },
  { id:25, title:'핵심 체크리스트(매매 전 최종 점검)', category:'고급 전략',   available:true  },
  { id:26, title:'거래량 보는법',                   category:'보조지표',    available:false },
  { id:27, title:'거래량 다이버전스',               category:'보조지표',    available:false },
  { id:28, title:'RSI 실전 활용',                  category:'보조지표',    available:false },
  { id:29, title:'MACD 실전 활용',                 category:'보조지표',    available:false },
  { id:30, title:'볼린저밴드 전략',                 category:'보조지표',    available:false },
  { id:31, title:'지지·저항 실전',                  category:'기본기',     available:false },
  { id:32, title:'추세선 매매법',                   category:'진입 전략',   available:false },
  { id:33, title:'브레이크아웃 전략',               category:'진입 전략',   available:false },
  { id:34, title:'가짜 돌파 구별법',               category:'고급 전략',   available:false },
  { id:35, title:'비트코인 사이클 분석',             category:'시장 심리',   available:false },
  { id:36, title:'알트코인 순환매',                 category:'고급 전략',   available:false },
  { id:37, title:'시장 심리 읽는법',               category:'시장 심리',   available:false },
  { id:38, title:'세력 흔들기 패턴',               category:'시장 심리',   available:false },
  { id:39, title:'청산맵 활용법',                  category:'고급 전략',   available:false },
  { id:40, title:'종합 실전 매매 시나리오',          category:'고급 전략',   available:false },
] as const;

type Poster = typeof POSTER_DATA[number];

// ─── Category config ─────────────────────────────────────────────
const CATEGORIES = ['전체','기본기','진입 전략','리스크 관리','보조지표','시장 심리','고급 전략'] as const;
const CAT_COLORS: Record<string,string> = {
  '전체':     '#60A5FA',
  '기본기':   '#34D399',
  '진입 전략': '#F59E0B',
  '리스크 관리':'#EF4444',
  '보조지표':  '#A78BFA',
  '시장 심리': '#FB923C',
  '고급 전략': '#F472B6',
};
const CAT_ICONS: Record<string,string> = {
  '전체':'📚','기본기':'📖','진입 전략':'🎯','리스크 관리':'🛡️',
  '보조지표':'📊','시장 심리':'🧠','고급 전략':'🏆',
};

// ─── Poster number badge ─────────────────────────────────────────
const numColor = (n:number) =>
  n<=10?'#34D399':n<=20?'#60A5FA':n<=30?'#F59E0B':n<=35?'#A78BFA':'#F472B6';

// ─── Placeholder SVG card ─────────────────────────────────────────
function PosterPlaceholder({ poster }: { poster: Poster }) {
  const col = CAT_COLORS[poster.category] || '#60A5FA';
  const nc  = numColor(poster.id);
  return (
    <svg viewBox="0 0 400 560" width="100%" height="100%"
      style={{ position:'absolute', inset:0, borderRadius:12 }}>
      <defs>
        <linearGradient id={`g${poster.id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#060B14"/>
          <stop offset="100%" stopColor="#0D1F3C"/>
        </linearGradient>
        <filter id={`glow${poster.id}`}>
          <feGaussianBlur stdDeviation="3" result="blur"/>
          <feComposite in="SourceGraphic" in2="blur" operator="over"/>
        </filter>
      </defs>
      <rect width="400" height="560" rx="12" fill={`url(#g${poster.id})`}/>
      {/* Grid lines */}
      {[80,160,240,320,400,480].map(y=>(
        <line key={y} x1="0" y1={y} x2="400" y2={y} stroke={col} strokeOpacity="0.06" strokeWidth="1"/>
      ))}
      {/* Top border accent */}
      <rect width="400" height="4" rx="2" fill={col}/>
      {/* Number circle */}
      <circle cx="50" cy="60" r="28" fill={nc} fillOpacity="0.15" stroke={nc} strokeWidth="2"/>
      <text x="50" y="67" textAnchor="middle" fill={nc}
        style={{ fontSize:18, fontWeight:900, fontFamily:'monospace' }}>{poster.id.toString().padStart(2,'0')}</text>
      {/* Category badge */}
      <rect x="88" y="44" width={poster.category.length*12+20} height="22" rx="11"
        fill={col} fillOpacity="0.15" stroke={col} strokeWidth="1" strokeOpacity="0.4"/>
      <text x={98+poster.category.length*6} y="59" textAnchor="middle" fill={col}
        style={{ fontSize:10, fontFamily:'sans-serif' }}>{CAT_ICONS[poster.category]} {poster.category}</text>
      {/* Title */}
      {/* Title - split across 2 SVG text lines */}
      <text x="24" y="115" fill="#E2E8F0"
        style={{ fontSize:14, fontWeight:900, fontFamily:'sans-serif' }}>
        {poster.title.slice(0, 18)}
      </text>
      {poster.title.length > 18 && (
        <text x="24" y="135" fill="#CBD5E1"
          style={{ fontSize:13, fontFamily:'sans-serif' }}>
          {poster.title.slice(18, 36)}
        </text>
      )}
      {poster.title.length > 36 && (
        <text x="24" y="153" fill="#94A3B8"
          style={{ fontSize:11, fontFamily:'sans-serif' }}>
          {poster.title.slice(36, 52)}…
        </text>
      )}
      {/* Decorative chart bars */}
      {[0,1,2,3,4,5,6,7,8,9].map(i=>{
        const h = [60,80,45,95,70,55,85,40,75,65][i];
        return <rect key={i} x={24+i*37} y={230-(h*0.6)} width="22" height={h*0.6}
          rx="3" fill={i%3===0?col:'#1E3A5F'} fillOpacity="0.8"/>;
      })}
      {/* Line chart */}
      <polyline points="20,320 60,300 100,310 140,280 180,260 220,270 260,240 300,250 340,220 380,200"
        fill="none" stroke={col} strokeWidth="2" strokeOpacity="0.6"/>
      <circle cx="380" cy="200" r="4" fill={col}/>
      {/* Coming soon / available label */}
      {!poster.available && (
        <>
          <rect x="20" y="360" width="360" height="40" rx="8"
            fill="#1A2D4A" stroke="#EF4444" strokeWidth="1" strokeOpacity="0.4"/>
          <text x="200" y="385" textAnchor="middle" fill="#EF4444" fillOpacity="0.8"
            style={{ fontSize:12, fontFamily:'sans-serif' }}>⏳ 업로드 예정</text>
        </>
      )}
      {poster.available && (
        <>
          <rect x="20" y="360" width="360" height="40" rx="8"
            fill={col} fillOpacity="0.12" stroke={col} strokeWidth="1" strokeOpacity="0.5"/>
          <text x="200" y="385" textAnchor="middle" fill={col}
            style={{ fontSize:12, fontFamily:'sans-serif', fontWeight:700 }}>🖼️ 포스터 보기</text>
        </>
      )}
      {/* Bottom motto */}
      <text x="200" y="530" textAnchor="middle" fill="#475569"
        style={{ fontSize:9, fontFamily:'sans-serif' }}>TRAIGO 투자 강의 시리즈</text>
      <text x="200" y="548" textAnchor="middle" fill="#243A5E"
        style={{ fontSize:9, fontFamily:'sans-serif' }}>© 2025 TRAIGO Academy</text>
    </svg>
  );
}

// ─── Main component ───────────────────────────────────────────────
export default function PosterLibrary() {
  const [cat,    setCat]    = useState<string>('전체');
  const [search, setSearch] = useState('');
  const [sel,    setSel]    = useState<Poster|null>(null);
  const [imgErr, setImgErr] = useState<Set<number>>(new Set());
  const [loaded, setLoaded] = useState<Set<number>>(new Set());

  // Close modal on Escape
  useEffect(() => {
    if (!sel) return;
    const fn = (e:KeyboardEvent) => { if(e.key==='Escape') setSel(null); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [sel]);

  // Prevent body scroll when modal open
  useEffect(() => {
    document.body.style.overflow = sel ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [sel]);

  const filtered = POSTER_DATA.filter(p => {
    const matchCat  = cat === '전체' || p.category === cat;
    const matchSrch = !search || p.title.includes(search) ||
      p.category.includes(search) || String(p.id) === search;
    return matchCat && matchSrch;
  });

  const handleDownload = useCallback((p: Poster) => {
    const link = document.createElement('a');
    link.href  = `/posters/poster-${p.id.toString().padStart(2,'0')}.png`;
    link.download = `TRAIGO-강의-${p.id.toString().padStart(2,'0')}-${p.title}.png`;
    link.click();
  }, []);

  const imgSrc = (p: Poster) => `/posters/poster-${p.id.toString().padStart(2,'0')}.png`;

  return (
    <div style={{ color:'#E2E8F0', userSelect:'none' }}>

      {/* ── Header ── */}
      <div style={{ marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
          <div style={{
            width:32, height:32, borderRadius:10,
            background:'linear-gradient(135deg,#2563EB,#7C3AED)',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:16, fontWeight:900,
          }}>📚</div>
          <div>
            <div style={{ fontWeight:900, fontSize:16, letterSpacing:-0.5 }}>TRAIGO 투자 강의</div>
            <div style={{ color:'#475569', fontSize:10 }}>1~40번 실전 투자 포스터 라이브러리</div>
          </div>
          <div style={{
            marginLeft:'auto', background:'#1A2D4A',
            border:'1px solid #243A5E', borderRadius:8,
            padding:'3px 10px', fontSize:10, color:'#60A5FA',
          }}>
            총 {POSTER_DATA.length}강 · {POSTER_DATA.filter(p=>p.available).length}개 등록
          </div>
        </div>

        {/* Search */}
        <div style={{
          display:'flex', gap:8, alignItems:'center',
          background:'#0A1628', border:'1px solid #1A2D4A',
          borderRadius:12, padding:'8px 14px', marginBottom:10,
        }}>
          <span style={{ color:'#475569' }}>🔍</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="강의 제목, 번호, 카테고리 검색…"
            style={{
              background:'transparent', border:'none', outline:'none',
              color:'#E2E8F0', fontSize:13, flex:1,
            }}
          />
          {search && (
            <button onClick={() => setSearch('')}
              style={{ background:'none', border:'none', color:'#475569', cursor:'pointer', fontSize:16 }}>✕</button>
          )}
        </div>

        {/* Category tabs */}
        <div style={{ display:'flex', gap:5, overflowX:'auto', paddingBottom:4 }}>
          {CATEGORIES.map(c => {
            const col = CAT_COLORS[c] || '#60A5FA';
            const active = cat === c;
            return (
              <button key={c}
                onClick={() => setCat(c)}
                style={{
                  flexShrink:0, padding:'5px 12px',
                  background: active ? col+'22' : 'transparent',
                  color: active ? col : '#475569',
                  border: `1px solid ${active ? col : '#1A2D4A'}`,
                  borderRadius:20, fontSize:11, fontWeight:700, cursor:'pointer',
                  whiteSpace:'nowrap',
                }}>
                {CAT_ICONS[c]} {c}
                {c !== '전체' && (
                  <span style={{ marginLeft:4, opacity:0.6 }}>
                    ({POSTER_DATA.filter(p=>p.category===c).length})
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Grid ── */}
      {filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:'40px 0', color:'#475569' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>🔍</div>
          <div>"{search}" 검색 결과 없음</div>
        </div>
      ) : (
        <div style={{
          display:'grid',
          gridTemplateColumns:'repeat(2, 1fr)',
          gap:10,
        }}>
          {filtered.map(p => {
            const col = CAT_COLORS[p.category] || '#60A5FA';
            const nc  = numColor(p.id);
            const hasErr = imgErr.has(p.id);
            const isLoaded = loaded.has(p.id);
            return (
              <div
                key={p.id}
                onClick={() => setSel(p)}
                style={{
                  position:'relative',
                  background:'#0A1628',
                  border:`1px solid ${p.available ? col+'40' : '#1A2D4A'}`,
                  borderRadius:12, overflow:'hidden', cursor:'pointer',
                  aspectRatio:'5/7',
                  transition:'transform .15s, border-color .15s, box-shadow .15s',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)';
                  (e.currentTarget as HTMLElement).style.boxShadow = `0 8px 24px ${col}30`;
                  (e.currentTarget as HTMLElement).style.borderColor = col+'80';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.transform = '';
                  (e.currentTarget as HTMLElement).style.boxShadow = '';
                  (e.currentTarget as HTMLElement).style.borderColor = p.available ? col+'40' : '#1A2D4A';
                }}
              >
                {/* Real image (hidden until loaded) */}
                {!hasErr && (
                  <img
                    src={imgSrc(p)}
                    alt={p.title}
                    onLoad={() => setLoaded(prev => { const s=new Set(prev); s.add(p.id); return s; })}
                    onError={() => setImgErr(prev => { const s=new Set(prev); s.add(p.id); return s; })}
                    style={{
                      position:'absolute', inset:0,
                      width:'100%', height:'100%',
                      objectFit:'cover', borderRadius:12,
                      opacity: isLoaded ? 1 : 0,
                      transition:'opacity .3s',
                    }}
                  />
                )}
                {/* Placeholder (always render, hidden when image loaded) */}
                {(hasErr || !isLoaded) && <PosterPlaceholder poster={p}/>}

                {/* Number badge overlay */}
                <div style={{
                  position:'absolute', top:8, left:8,
                  background:'rgba(0,0,0,.75)', borderRadius:8,
                  padding:'2px 8px', fontSize:11, fontWeight:900,
                  color: nc, border:`1px solid ${nc}40`,
                  backdropFilter:'blur(4px)',
                }}>
                  {p.id.toString().padStart(2,'0')}
                </div>

                {/* Available badge */}
                {!p.available && (
                  <div style={{
                    position:'absolute', top:8, right:8,
                    background:'rgba(0,0,0,.75)', borderRadius:8,
                    padding:'2px 7px', fontSize:9,
                    color:'#EF4444', border:'1px solid #EF444430',
                    backdropFilter:'blur(4px)',
                  }}>
                    예정
                  </div>
                )}

                {/* Bottom label */}
                <div style={{
                  position:'absolute', bottom:0, left:0, right:0,
                  background:'linear-gradient(transparent, rgba(0,0,0,.9))',
                  padding:'24px 8px 8px',
                  fontSize:10, fontWeight:700, color:'#E2E8F0',
                  lineHeight:1.3,
                }}>
                  {p.title}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Modal ── */}
      {sel && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setSel(null)}
            style={{
              position:'fixed', inset:0, zIndex:500,
              background:'rgba(0,0,0,.88)',
              backdropFilter:'blur(8px)',
            }}
          />
          {/* Panel */}
          <div style={{
            position:'fixed', inset:'env(safe-area-inset-top,0px) 0 0',
            zIndex:501, overflowY:'auto', WebkitOverflowScrolling:'touch' as any,
            display:'flex', flexDirection:'column', alignItems:'center',
            padding:'16px 16px 32px',
          }}>
            {/* Header */}
            <div style={{
              width:'100%', maxWidth:500,
              display:'flex', justifyContent:'space-between', alignItems:'center',
              marginBottom:12,
            }}>
              <div>
                <div style={{ fontWeight:900, fontSize:14, color:'#E2E8F0' }}>{sel.title}</div>
                <div style={{ color:'#475569', fontSize:10 }}>
                  #{sel.id.toString().padStart(2,'0')} · {sel.category}
                </div>
              </div>
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                {sel.available && (
                  <button
                    onClick={() => handleDownload(sel)}
                    style={{
                      padding:'7px 14px', fontSize:11, fontWeight:700,
                      background:'linear-gradient(135deg,#2563EB,#7C3AED)',
                      color:'#fff', border:'none', borderRadius:10, cursor:'pointer',
                    }}>
                    ⬇️ 저장
                  </button>
                )}
                <button
                  onClick={() => setSel(null)}
                  style={{
                    width:34, height:34, display:'flex', alignItems:'center', justifyContent:'center',
                    background:'#1A2D4A', border:'1px solid #243A5E',
                    borderRadius:10, color:'#94A3B8', cursor:'pointer', fontSize:18,
                  }}>
                  ✕
                </button>
              </div>
            </div>

            {/* Image or placeholder */}
            <div style={{
              width:'100%', maxWidth:500,
              borderRadius:16, overflow:'hidden',
              border:`1px solid ${CAT_COLORS[sel.category]||'#60A5FA'}40`,
              boxShadow:`0 20px 60px ${CAT_COLORS[sel.category]||'#60A5FA'}20`,
              aspectRatio:'5/7', position:'relative', background:'#0A1628',
            }}>
              {!imgErr.has(sel.id) ? (
                <img
                  src={imgSrc(sel)}
                  alt={sel.title}
                  onError={() => setImgErr(prev => { const s=new Set(prev); s.add(sel.id); return s; })}
                  style={{ width:'100%', height:'100%', objectFit:'contain', display:'block' }}
                />
              ) : (
                <PosterPlaceholder poster={sel}/>
              )}
              {!sel.available && !imgErr.has(sel.id) && (
                <div style={{
                  position:'absolute', inset:0, background:'rgba(0,0,0,.7)',
                  display:'flex', flexDirection:'column',
                  alignItems:'center', justifyContent:'center',
                  borderRadius:16,
                }}>
                  <div style={{ fontSize:40, marginBottom:12 }}>⏳</div>
                  <div style={{ color:'#E2E8F0', fontWeight:800, fontSize:16, marginBottom:6 }}>
                    업로드 예정
                  </div>
                  <div style={{ color:'#475569', fontSize:12 }}>
                    /public/posters/poster-{sel.id.toString().padStart(2,'0')}.png
                  </div>
                </div>
              )}
            </div>

            {/* Nav arrows */}
            <div style={{ display:'flex', gap:10, marginTop:14 }}>
              {sel.id > 1 && (
                <button
                  onClick={() => setSel(POSTER_DATA.find(p=>p.id===sel.id-1)||null)}
                  style={{
                    padding:'8px 18px', background:'#1A2D4A',
                    border:'1px solid #243A5E', borderRadius:10,
                    color:'#94A3B8', cursor:'pointer', fontSize:12, fontWeight:700,
                  }}>
                  ← 이전
                </button>
              )}
              <div style={{
                padding:'8px 16px', background:'#0A1628',
                border:'1px solid #1A2D4A', borderRadius:10,
                color:'#475569', fontSize:11, textAlign:'center',
              }}>
                {sel.id} / {POSTER_DATA.length}
              </div>
              {sel.id < POSTER_DATA.length && (
                <button
                  onClick={() => setSel(POSTER_DATA.find(p=>p.id===sel.id+1)||null)}
                  style={{
                    padding:'8px 18px', background:'#1A2D4A',
                    border:'1px solid #243A5E', borderRadius:10,
                    color:'#94A3B8', cursor:'pointer', fontSize:12, fontWeight:700,
                  }}>
                  다음 →
                </button>
              )}
            </div>

            {/* Warning */}
            <div style={{
              marginTop:16, width:'100%', maxWidth:500,
              background:'#F59E0B12', border:'1px solid #F59E0B30',
              borderRadius:10, padding:'8px 12px',
              color:'#F59E0B', fontSize:10, textAlign:'center',
            }}>
              ⚠️ 교육 목적 자료입니다. 실제 투자 판단은 본인 책임이며 수익을 보장하지 않습니다.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

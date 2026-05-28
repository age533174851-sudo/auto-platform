'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { PosterIndicator } from '@/lib/posters/indicators';
import { getPosterMeta, DIFFICULTY_LABEL, DIFFICULTY_COLOR } from '@/lib/posters/meta';
import {
  BookOpen, Target, Shield, BarChart3, Brain, Trophy,
  Search, Download, X, ChevronLeft, ChevronRight, CheckCircle2, Circle,
  Bookmark, BookmarkCheck, Maximize, ZoomIn, ZoomOut, RotateCcw,
} from 'lucide-react';

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

// ─── PosterZoomViewer — 풀스크린 + 핀치줌 ────────────────────
// 모바일: 핀치 두 손가락 zoom + 드래그 pan
// 데스크탑: 마우스 휠 zoom, 드래그 pan, 더블클릭 리셋
function PosterZoomViewer({
  poster, hasErr, imgSrc, onClose,
}: {
  poster: Poster;
  hasErr: boolean;
  imgSrc: string;
  onClose: () => void;
}) {
  const [scale, setScale]   = useState(1);
  const [tx, setTx]         = useState(0);
  const [ty, setTy]         = useState(0);
  const stateRef = React.useRef({ scale: 1, tx: 0, ty: 0, lastTouchDist: 0, startX: 0, startY: 0, startTx: 0, startTy: 0, dragging: false });

  const MIN_SCALE = 1;
  const MAX_SCALE = 5;

  const reset = useCallback(() => {
    setScale(1); setTx(0); setTy(0);
    stateRef.current = { ...stateRef.current, scale: 1, tx: 0, ty: 0 };
  }, []);

  const applyScale = useCallback((next: number, cx?: number, cy?: number) => {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    setScale(clamped);
    stateRef.current.scale = clamped;
    if (clamped === 1) { setTx(0); setTy(0); stateRef.current.tx = 0; stateRef.current.ty = 0; }
  }, []);

  // ESC 닫기 + body 스크롤 잠금
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') applyScale(stateRef.current.scale * 1.4);
      if (e.key === '-') applyScale(stateRef.current.scale / 1.4);
      if (e.key === '0') reset();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, applyScale, reset]);

  // 휠 줌
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    applyScale(stateRef.current.scale * factor);
  }, [applyScale]);

  // 드래그 (마우스)
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (stateRef.current.scale <= 1) return;
    stateRef.current.dragging = true;
    stateRef.current.startX = e.clientX;
    stateRef.current.startY = e.clientY;
    stateRef.current.startTx = stateRef.current.tx;
    stateRef.current.startTy = stateRef.current.ty;
  }, []);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!stateRef.current.dragging) return;
    const dx = e.clientX - stateRef.current.startX;
    const dy = e.clientY - stateRef.current.startY;
    const newTx = stateRef.current.startTx + dx;
    const newTy = stateRef.current.startTy + dy;
    stateRef.current.tx = newTx;
    stateRef.current.ty = newTy;
    setTx(newTx); setTy(newTy);
  }, []);
  const onMouseUp = useCallback(() => { stateRef.current.dragging = false; }, []);

  // 터치 (핀치 + 드래그)
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      stateRef.current.lastTouchDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    } else if (e.touches.length === 1 && stateRef.current.scale > 1) {
      stateRef.current.dragging = true;
      stateRef.current.startX = e.touches[0].clientX;
      stateRef.current.startY = e.touches[0].clientY;
      stateRef.current.startTx = stateRef.current.tx;
      stateRef.current.startTy = stateRef.current.ty;
    }
  }, []);
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      if (stateRef.current.lastTouchDist > 0) {
        const factor = dist / stateRef.current.lastTouchDist;
        applyScale(stateRef.current.scale * factor);
      }
      stateRef.current.lastTouchDist = dist;
    } else if (e.touches.length === 1 && stateRef.current.dragging) {
      const dx = e.touches[0].clientX - stateRef.current.startX;
      const dy = e.touches[0].clientY - stateRef.current.startY;
      const newTx = stateRef.current.startTx + dx;
      const newTy = stateRef.current.startTy + dy;
      stateRef.current.tx = newTx;
      stateRef.current.ty = newTy;
      setTx(newTx); setTy(newTy);
    }
  }, [applyScale]);
  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length < 2) stateRef.current.lastTouchDist = 0;
    if (e.touches.length === 0) stateRef.current.dragging = false;
  }, []);

  // 더블클릭 리셋
  const onDoubleClick = useCallback(() => {
    if (stateRef.current.scale > 1) reset();
    else applyScale(2);
  }, [reset, applyScale]);

  return (
    <div style={{
      position:'fixed', inset:0, zIndex:600,
      background:'#000',
      display:'flex', alignItems:'center', justifyContent:'center',
      overflow:'hidden',
      touchAction: 'none',
    }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onDoubleClick={onDoubleClick}>

      {/* 이미지 */}
      <div style={{
        transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
        transformOrigin: 'center center',
        transition: stateRef.current.dragging ? 'none' : 'transform 200ms',
        maxWidth: '95vw', maxHeight: '95vh',
        cursor: scale > 1 ? 'grab' : 'zoom-in',
      }}>
        {!hasErr ? (
          <img src={imgSrc} alt={poster.title}
            draggable={false}
            style={{ maxWidth: '95vw', maxHeight: '95vh', display: 'block', userSelect: 'none' }}/>
        ) : (
          <div style={{ width: 'min(95vw, 500px)', aspectRatio: '5/7' }}>
            <PosterPlaceholder poster={poster}/>
          </div>
        )}
      </div>

      {/* 컨트롤 바 */}
      <div style={{
        position:'absolute', top:'env(safe-area-inset-top, 16px)', right:16,
        display:'flex', gap:8, alignItems:'center',
        background:'rgba(0,0,0,.5)', backdropFilter:'blur(8px)',
        borderRadius:12, padding:6,
      }}>
        <button onClick={() => applyScale(stateRef.current.scale / 1.4)}
          aria-label="축소" disabled={scale <= MIN_SCALE}
          style={{ minWidth:36, minHeight:36, background:'transparent', border:'none', color: scale > MIN_SCALE ? '#fff' : '#666', cursor: scale > MIN_SCALE ? 'pointer' : 'not-allowed', display:'flex', alignItems:'center', justifyContent:'center', borderRadius:8 }}>
          <ZoomOut size={16} strokeWidth={2.4}/>
        </button>
        <span style={{ color:'#fff', fontSize:11, fontFamily:'monospace', minWidth:38, textAlign:'center' }}>
          {Math.round(scale * 100)}%
        </span>
        <button onClick={() => applyScale(stateRef.current.scale * 1.4)}
          aria-label="확대" disabled={scale >= MAX_SCALE}
          style={{ minWidth:36, minHeight:36, background:'transparent', border:'none', color: scale < MAX_SCALE ? '#fff' : '#666', cursor: scale < MAX_SCALE ? 'pointer' : 'not-allowed', display:'flex', alignItems:'center', justifyContent:'center', borderRadius:8 }}>
          <ZoomIn size={16} strokeWidth={2.4}/>
        </button>
        <button onClick={reset} aria-label="원본 크기"
          style={{ minWidth:36, minHeight:36, background:'transparent', border:'none', color:'#fff', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', borderRadius:8 }}>
          <RotateCcw size={14} strokeWidth={2.4}/>
        </button>
        <button onClick={onClose} aria-label="닫기"
          style={{ minWidth:36, minHeight:36, background:'rgba(239,68,68,0.2)', color:'#fff', border:'none', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', borderRadius:8, fontSize:18, fontWeight:700 }}>
          <X size={16} strokeWidth={2.4}/>
        </button>
      </div>

      {/* 안내 텍스트 */}
      <div style={{
        position:'absolute', bottom:'env(safe-area-inset-bottom, 16px)', left:'50%',
        transform:'translateX(-50%)',
        background:'rgba(0,0,0,.5)', backdropFilter:'blur(8px)',
        borderRadius:8, padding:'5px 12px',
        color:'#94A3B8', fontSize:10, fontWeight:600,
        whiteSpace:'nowrap',
      }}>
        핀치 / 휠 = 확대 · 드래그 = 이동 · 더블클릭 = 리셋
      </div>
    </div>
  );
}


// ─── Placeholder SVG card ─────────────────────────────────────────
function PosterPlaceholder({ poster }: { poster: Poster }) {
  const col = CAT_COLORS[poster.category] || '#60A5FA';
  const nc  = numColor(poster.id);
  const meta = getPosterMeta(poster.id);
  const diffColor = DIFFICULTY_COLOR[meta.difficulty];
  return (
    <svg viewBox="0 0 400 560" width="100%" height="100%"
      style={{ position:'absolute', inset:0, borderRadius:12 }}>
      <defs>
        <linearGradient id={`g${poster.id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#060B14"/>
          <stop offset="100%" stopColor="#0D1F3C"/>
        </linearGradient>
      </defs>
      <rect width="400" height="560" rx="12" fill={`url(#g${poster.id})`}/>
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
      {/* Difficulty badge (top-right) */}
      <rect x="324" y="44" width="56" height="22" rx="11"
        fill={diffColor} fillOpacity="0.15" stroke={diffColor} strokeWidth="1" strokeOpacity="0.5"/>
      <text x="352" y="59" textAnchor="middle" fill={diffColor}
        style={{ fontSize:10, fontFamily:'sans-serif', fontWeight:800 }}>
        {DIFFICULTY_LABEL[meta.difficulty]}
      </text>
      {/* Title */}
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
      {/* 타입별 인디케이터 차트 */}
      <PosterIndicator type={meta.type} x={0} y={180} width={400} height={220} primaryColor={col}/>
      {/* 한 줄 요약 */}
      {meta.summary && (
        <foreignObject x="20" y="420" width="360" height="60">
          <div
            style={{ color:'#CBD5E1', fontSize:11, fontFamily:'sans-serif', lineHeight:1.5, textAlign:'left' }}>
            {meta.summary.slice(0, 80)}
          </div>
        </foreignObject>
      )}
      {/* Coming soon / available label */}
      {!poster.available && (
        <>
          <rect x="20" y="490" width="360" height="40" rx="8"
            fill="#1A2D4A" stroke="#EF4444" strokeWidth="1" strokeOpacity="0.4"/>
          <text x="200" y="515" textAnchor="middle" fill="#EF4444" fillOpacity="0.8"
            style={{ fontSize:12, fontFamily:'sans-serif' }}>업로드 예정</text>
        </>
      )}
      {poster.available && (
        <>
          <rect x="20" y="490" width="360" height="40" rx="8"
            fill={col} fillOpacity="0.12" stroke={col} strokeWidth="1" strokeOpacity="0.5"/>
          <text x="200" y="515" textAnchor="middle" fill={col}
            style={{ fontSize:12, fontFamily:'sans-serif', fontWeight:700 }}>강의 보기 →</text>
        </>
      )}
      {/* Bottom motto */}
      <text x="200" y="552" textAnchor="middle" fill="#475569"
        style={{ fontSize:9, fontFamily:'sans-serif' }}>TRAIGO 투자 강의 시리즈</text>
    </svg>
  );
}

// ─── Main component ───────────────────────────────────────────────
const COMPLETED_KEY  = 'tg_completed_posters_v1';
const BOOKMARK_KEY   = 'tg_bookmarked_posters_v1';

function loadIdSet(key: string): Set<number> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter(x => typeof x === 'number') : []);
  } catch { return new Set(); }
}
function saveIdSet(key: string, s: Set<number>): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, JSON.stringify(Array.from(s))); } catch {}
}

export default function PosterLibrary() {
  const [cat,    setCat]    = useState<string>('전체');
  const [search, setSearch] = useState('');
  const [sel,    setSel]    = useState<Poster|null>(null);
  const [imgErr, setImgErr] = useState<Set<number>>(new Set());
  const [loaded, setLoaded] = useState<Set<number>>(new Set());
  const [completed, setCompleted] = useState<Set<number>>(() => loadIdSet(COMPLETED_KEY));
  const [bookmarked, setBookmarked] = useState<Set<number>>(() => loadIdSet(BOOKMARK_KEY));
  const [zoomed, setZoomed] = useState(false);   // 풀스크린 이미지 뷰

  const toggleCompleted = useCallback((id: number) => {
    setCompleted(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveIdSet(COMPLETED_KEY, next);
      return next;
    });
  }, []);
  const toggleBookmark = useCallback((id: number) => {
    setBookmarked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveIdSet(BOOKMARK_KEY, next);
      return next;
    });
  }, []);

  // 이전/다음 (filtered 배열 기준이 더 자연스럽지만 전체 기준이 학습 추적엔 더 적합)
  const navAdjacent = useCallback((dir: -1 | 1) => {
    if (!sel) return;
    const idx = POSTER_DATA.findIndex(p => p.id === sel.id);
    if (idx < 0) return;
    const next = idx + dir;
    if (next < 0 || next >= POSTER_DATA.length) return;
    setSel(POSTER_DATA[next]);
  }, [sel]);

  // Close modal on Escape / arrow keys
  useEffect(() => {
    if (!sel) return;
    const fn = (e:KeyboardEvent) => {
      if (e.key === 'Escape')          setSel(null);
      else if (e.key === 'ArrowLeft')  navAdjacent(-1);
      else if (e.key === 'ArrowRight') navAdjacent(1);
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [sel, navAdjacent]);

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
          <div style={{ marginLeft:'auto', textAlign:'right' }}>
            <div style={{
              background:'#1A2D4A',
              border:'1px solid #243A5E', borderRadius:8,
              padding:'3px 10px', fontSize:10, color:'#60A5FA',
              marginBottom:4,
            }}>
              총 {POSTER_DATA.length}강
            </div>
            <div style={{ fontSize:9, color:'#94A3B8' }}>
              {completed.size} / {POSTER_DATA.length} 완료 ({Math.round((completed.size / POSTER_DATA.length) * 100)}%)
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div style={{
          height:5, background:'#1A2D4A', borderRadius:3, overflow:'hidden',
          marginBottom:10,
        }}>
          <div style={{
            height:'100%',
            width: `${(completed.size / POSTER_DATA.length) * 100}%`,
            background: 'linear-gradient(90deg, #10B981, #60A5FA)',
            transition: 'width 300ms',
          }}/>
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
          {(Array.isArray(filtered)?filtered:[]).map(p => {
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

                {/* 완료 체크 표시 (우상단) */}
                {completed.has(p.id) && (
                  <div style={{
                    position:'absolute', top: p.available ? 8 : 32, right: 8,
                    width: 24, height: 24, borderRadius: 12,
                    background: '#10B981', display:'flex', alignItems:'center', justifyContent:'center',
                    boxShadow: '0 2px 8px #10B98180',
                  }}>
                    <CheckCircle2 size={14} strokeWidth={2.4} color="#fff"/>
                  </div>
                )}

                {/* 북마크 표시 (좌하단) */}
                {bookmarked.has(p.id) && (
                  <div style={{
                    position:'absolute', bottom:42, right:8,
                    width: 22, height: 22, borderRadius: 11,
                    background:'#F59E0BCC', display:'flex', alignItems:'center', justifyContent:'center',
                  }}>
                    <BookmarkCheck size={11} strokeWidth={2.6} color="#fff"/>
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

            {/* Image or placeholder — 클릭 시 풀스크린 */}
            <div
              onClick={() => setZoomed(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setZoomed(true); } }}
              style={{
                width:'100%', maxWidth:500,
                borderRadius:16, overflow:'hidden',
                border:`1px solid ${CAT_COLORS[sel.category]||'#60A5FA'}40`,
                boxShadow:`0 20px 60px ${CAT_COLORS[sel.category]||'#60A5FA'}20`,
                aspectRatio:'5/7', position:'relative', background:'#0A1628',
                cursor: 'zoom-in',
              }}>
              {!imgErr.has(sel.id) ? (
                <img
                  src={imgSrc(sel)}
                  alt={sel.title}
                  onError={() => setImgErr(prev => { const s=new Set(prev); s.add(sel.id); return s; })}
                  style={{ width:'100%', height:'100%', objectFit:'contain', display:'block', pointerEvents:'none' }}
                />
              ) : (
                <PosterPlaceholder poster={sel}/>
              )}
              {/* 줌 힌트 */}
              <div style={{
                position:'absolute', top:8, right:8,
                background:'rgba(0,0,0,.7)', backdropFilter:'blur(4px)',
                borderRadius:8, padding:'4px 10px',
                color:'#E2E8F0', fontSize:9, fontWeight:700,
                display:'inline-flex', alignItems:'center', gap:4,
              }}>
                <Maximize size={10} strokeWidth={2.4}/>크게 보기
              </div>
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

            {/* Nav arrows + 완료/북마크 */}
            <div style={{ display:'flex', gap:6, marginTop:14, width:'100%', maxWidth:500, flexWrap:'wrap' }}>
              <button
                onClick={() => navAdjacent(-1)}
                disabled={sel.id <= 1}
                style={{
                  padding:'9px 14px', minHeight:38,
                  background: sel.id > 1 ? '#1A2D4A' : '#0A1628',
                  border: `1px solid ${sel.id > 1 ? '#243A5E' : '#1A2D4A'}`, borderRadius:10,
                  color: sel.id > 1 ? '#94A3B8' : '#475569',
                  cursor: sel.id > 1 ? 'pointer' : 'not-allowed',
                  fontSize:12, fontWeight:700,
                  display:'inline-flex', alignItems:'center', gap:4,
                }}>
                <ChevronLeft size={13} strokeWidth={2.4}/>
                이전
              </button>
              <div style={{
                flex:1, padding:'9px 12px', minHeight:38,
                background:'#0A1628', border:'1px solid #1A2D4A', borderRadius:10,
                color:'#94A3B8', fontSize:11, textAlign:'center',
                display:'flex', alignItems:'center', justifyContent:'center', gap:6,
              }}>
                <span>{sel.id} / {POSTER_DATA.length}</span>
                <span style={{ color:'#475569' }}>·</span>
                <span style={{ color: completed.has(sel.id) ? '#10B981' : '#475569' }}>
                  {completed.has(sel.id) ? '완료' : '미완료'}
                </span>
              </div>
              <button
                onClick={() => navAdjacent(1)}
                disabled={sel.id >= POSTER_DATA.length}
                style={{
                  padding:'9px 14px', minHeight:38,
                  background: sel.id < POSTER_DATA.length ? '#1A2D4A' : '#0A1628',
                  border: `1px solid ${sel.id < POSTER_DATA.length ? '#243A5E' : '#1A2D4A'}`, borderRadius:10,
                  color: sel.id < POSTER_DATA.length ? '#94A3B8' : '#475569',
                  cursor: sel.id < POSTER_DATA.length ? 'pointer' : 'not-allowed',
                  fontSize:12, fontWeight:700,
                  display:'inline-flex', alignItems:'center', gap:4,
                }}>
                다음
                <ChevronRight size={13} strokeWidth={2.4}/>
              </button>
            </div>

            {/* 완료/북마크 액션 */}
            <div style={{ display:'flex', gap:8, marginTop:8, width:'100%', maxWidth:500 }}>
              <button onClick={() => toggleCompleted(sel.id)}
                style={{
                  flex:1, padding:'10px', minHeight:42,
                  background: completed.has(sel.id) ? '#10B98122' : '#1A2D4A',
                  color:      completed.has(sel.id) ? '#10B981' : '#94A3B8',
                  border: `1px solid ${completed.has(sel.id) ? '#10B981' : '#243A5E'}`,
                  borderRadius:10, fontSize:12, fontWeight:700, cursor:'pointer',
                  display:'inline-flex', alignItems:'center', justifyContent:'center', gap:5,
                }}>
                {completed.has(sel.id)
                  ? <><CheckCircle2 size={14} strokeWidth={2.4}/>학습 완료</>
                  : <><Circle size={14} strokeWidth={2.4}/>학습 완료 표시</>}
              </button>
              <button onClick={() => toggleBookmark(sel.id)}
                aria-label={bookmarked.has(sel.id) ? '북마크 해제' : '북마크'}
                style={{
                  padding:'10px 14px', minHeight:42,
                  background: bookmarked.has(sel.id) ? '#F59E0B22' : '#1A2D4A',
                  color:      bookmarked.has(sel.id) ? '#F59E0B' : '#94A3B8',
                  border: `1px solid ${bookmarked.has(sel.id) ? '#F59E0B' : '#243A5E'}`,
                  borderRadius:10, cursor:'pointer',
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>
                {bookmarked.has(sel.id) ? <BookmarkCheck size={15} strokeWidth={2.4}/> : <Bookmark size={15} strokeWidth={2.4}/>}
              </button>
            </div>

            {/* 메타 카드들 */}
            {(() => {
              const meta = getPosterMeta(sel.id);
              const diffColor = DIFFICULTY_COLOR[meta.difficulty];
              return (
                <div style={{ marginTop:16, width:'100%', maxWidth:500, display:'flex', flexDirection:'column', gap:10 }}>
                  {/* 난이도 + 카테고리 */}
                  <div style={{ display:'flex', gap:6 }}>
                    <div style={{
                      padding:'8px 12px',
                      background: diffColor + '15', border: `1px solid ${diffColor}40`,
                      borderRadius:10, fontSize:11, fontWeight:800, color: diffColor,
                      display:'inline-flex', alignItems:'center', gap:4,
                    }}>
                      난이도 · {DIFFICULTY_LABEL[meta.difficulty]}
                    </div>
                    <div style={{
                      padding:'8px 12px',
                      background:`${CAT_COLORS[sel.category]}15`, border:`1px solid ${CAT_COLORS[sel.category]}40`,
                      borderRadius:10, fontSize:11, fontWeight:800, color: CAT_COLORS[sel.category],
                    }}>
                      {sel.category}
                    </div>
                  </div>

                  {/* 한 줄 요약 */}
                  {meta.summary && (
                    <div style={{
                      padding:'12px 14px',
                      background:'#0A1628', border:'1px solid #1A2D4A',
                      borderRadius:12,
                    }}>
                      <div style={{ color:'#94A3B8', fontSize:10, fontWeight:700, marginBottom:4 }}>
                        한 줄 요약
                      </div>
                      <div style={{ color:'#E2E8F0', fontSize:13, lineHeight:1.6 }}>
                        {meta.summary}
                      </div>
                    </div>
                  )}

                  {/* 핵심 포인트 */}
                  {meta.keypoints && meta.keypoints.length > 0 && (
                    <div style={{
                      padding:'12px 14px',
                      background:'#0A1628', border:'1px solid #1A2D4A',
                      borderRadius:12,
                    }}>
                      <div style={{ color:'#60A5FA', fontSize:10, fontWeight:700, marginBottom:8,
                        display:'inline-flex', alignItems:'center', gap:5 }}>
                        <Target size={11} strokeWidth={2.4}/>오늘 배울 내용
                      </div>
                      {meta.keypoints.map((k, i) => (
                        <div key={i} style={{ display:'flex', gap:8, marginBottom: i === meta.keypoints!.length - 1 ? 0 : 6 }}>
                          <div style={{ color:'#60A5FA', fontSize:11, fontWeight:800, minWidth:14 }}>
                            {i + 1}.
                          </div>
                          <div style={{ color:'#CBD5E1', fontSize:12, lineHeight:1.5, flex:1 }}>{k}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 매수/매도 타이밍 (있을 때만) */}
                  {(meta.buyTiming || meta.sellTiming) && (
                    <div style={{ display:'grid', gridTemplateColumns: meta.buyTiming && meta.sellTiming ? '1fr 1fr' : '1fr', gap:8 }}>
                      {meta.buyTiming && (
                        <div style={{
                          padding:'10px 12px',
                          background:'#10B98110', border:'1px solid #10B98140',
                          borderRadius:10,
                        }}>
                          <div style={{ color:'#10B981', fontSize:10, fontWeight:800, marginBottom:4 }}>
                            매수 타이밍
                          </div>
                          <div style={{ color:'#CBD5E1', fontSize:11, lineHeight:1.5 }}>{meta.buyTiming}</div>
                        </div>
                      )}
                      {meta.sellTiming && (
                        <div style={{
                          padding:'10px 12px',
                          background:'#EF444410', border:'1px solid #EF444440',
                          borderRadius:10,
                        }}>
                          <div style={{ color:'#EF4444', fontSize:10, fontWeight:800, marginBottom:4 }}>
                            매도 타이밍
                          </div>
                          <div style={{ color:'#CBD5E1', fontSize:11, lineHeight:1.5 }}>{meta.sellTiming}</div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 실전 팁 */}
                  {meta.tip && (
                    <div style={{
                      padding:'10px 12px',
                      background:'#F59E0B10', border:'1px solid #F59E0B40',
                      borderRadius:10,
                      display:'flex', gap:8,
                    }}>
                      <div style={{ color:'#F59E0B', fontSize:11, fontWeight:800, flexShrink:0 }}>💡 팁</div>
                      <div style={{ color:'#CBD5E1', fontSize:11, lineHeight:1.6 }}>{meta.tip}</div>
                    </div>
                  )}
                </div>
              );
            })()}

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

      {/* ── 풀스크린 줌 모달 ── */}
      {sel && zoomed && (
        <PosterZoomViewer
          poster={sel}
          hasErr={imgErr.has(sel.id)}
          imgSrc={imgSrc(sel)}
          onClose={() => setZoomed(false)}
        />
      )}
    </div>
  );
}

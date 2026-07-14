'use client';
import React, { useState } from 'react';
import { T } from '@/lib/constants';
import { Card } from './SharedUI';
import { GraduationCap, Clock, CheckCircle2, PlayCircle } from 'lucide-react';

const LESSONS = [
  { id:1, title:'투자 기초: 주식 vs 코인', desc:'두 자산의 핵심 차이점', duration:'15분', level:'입문', done:true, banner:'stocks_vs_coins',
    content:'주식은 기업의 소유권이고 코인은 블록체인 네트워크의 토큰입니다. 주식은 규제된 시장에서, 코인은 24/7 글로벌 시장에서 거래됩니다.' },
  { id:2, title:'기술적 분석 기초', desc:'차트 읽는 법, 지지/저항', duration:'25분', level:'초급', done:true, banner:'chart',
    content:'지지선은 가격이 반등하는 구간, 저항선은 가격이 막히는 구간입니다. 캔들 패턴과 거래량을 함께 분석하세요.' },
  { id:3, title:'이동평균선(MA) 완전정복', desc:'SMA, EMA, MACD 활용법', duration:'20분', level:'초급', done:false, banner:'ma',
    content:'SMA는 단순 이동평균, EMA는 지수 이동평균입니다. 골든크로스(단기MA > 장기MA)는 매수 시그널입니다.' },
  { id:4, title:'레버리지와 청산 이해', desc:'마진 거래의 위험성', duration:'30분', level:'중급', done:false, banner:'leverage',
    content:'레버리지는 자본을 증폭시키지만 손실도 그만큼 커집니다. 청산가 = 진입가 ÷ (1 + 레버리지). 반드시 손절가를 설정하세요.' },
  { id:5, title:'포트폴리오 분산 투자', desc:'위험 관리와 자산 배분', duration:'20분', level:'중급', done:false, banner:'portfolio',
    content:'달걀을 한 바구니에 담지 마세요. 코인 50%, 주식 30%, 현금 20% 같은 분산 전략이 리스크를 낮춥니다.' },
  { id:6, title:'스윙 트레이딩 전략', desc:'단기 추세 매매 방법', duration:'35분', level:'고급', done:false, banner:'swing',
    content:'수일~수주 단위의 스윙 트레이딩은 일봉 차트를 기준으로 추세를 잡습니다. RSI, MACD, 볼린저밴드를 활용하세요.' },
];

// ── 레슨별 테마 SVG 일러스트 배너 (외부 이미지 없이 항상 로드) ──
function LessonBanner({ kind, color, h = 120 }: { kind: string; color: string; h?: number }) {
  const bg = `linear-gradient(135deg, ${color}22, ${color}08)`;
  return (
    <div style={{ width: '100%', height: h, background: bg, borderRadius: 12, overflow: 'hidden', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width="100%" height={h} viewBox="0 0 320 120" preserveAspectRatio="xMidYMid slice" style={{ position: 'absolute', inset: 0 }}>
        {kind === 'stocks_vs_coins' && (<g>
          {/* 좌: 주식 캔들 */}
          <rect x="40" y="45" width="10" height="45" rx="2" fill={color} opacity="0.9"/>
          <line x1="45" y1="35" x2="45" y2="95" stroke={color} strokeWidth="2"/>
          <rect x="62" y="55" width="10" height="30" rx="2" fill={color} opacity="0.6"/>
          <line x1="67" y1="48" x2="67" y2="90" stroke={color} strokeWidth="2"/>
          <rect x="84" y="38" width="10" height="52" rx="2" fill={color} opacity="0.9"/>
          <line x1="89" y1="30" x2="89" y2="94" stroke={color} strokeWidth="2"/>
          {/* 우: 코인 */}
          <circle cx="235" cy="60" r="30" fill={color} opacity="0.18"/>
          <circle cx="235" cy="60" r="30" fill="none" stroke={color} strokeWidth="2.5"/>
          <text x="235" y="70" textAnchor="middle" fill={color} fontSize="28" fontWeight="900">₿</text>
          <line x1="150" y1="20" x2="150" y2="100" stroke={color} strokeWidth="1" strokeDasharray="4 4" opacity="0.4"/>
        </g>)}
        {kind === 'chart' && (<g>
          <line x1="20" y1="40" x2="300" y2="40" stroke={color} strokeWidth="1" strokeDasharray="5 4" opacity="0.5"/>
          <line x1="20" y1="85" x2="300" y2="85" stroke={color} strokeWidth="1" strokeDasharray="5 4" opacity="0.5"/>
          {[0,1,2,3,4,5,6].map(i=>{const x=45+i*35;const up=i%2===0;const top=up?45:55;const hgt=up?30:25;return(<g key={i}><rect x={x} y={top} width="12" height={hgt} rx="2" fill={color} opacity={up?0.9:0.5}/><line x1={x+6} y1={top-8} x2={x+6} y2={top+hgt+8} stroke={color} strokeWidth="2"/></g>);})}
          <text x="24" y="36" fill={color} fontSize="8" fontWeight="700">저항</text>
          <text x="24" y="98" fill={color} fontSize="8" fontWeight="700">지지</text>
        </g>)}
        {kind === 'ma' && (<g>
          <polyline points="20,80 60,70 100,75 140,55 180,60 220,40 260,45 300,30" fill="none" stroke={color} strokeWidth="3" opacity="0.9"/>
          <polyline points="20,70 60,68 100,66 140,62 180,58 220,52 260,48 300,44" fill="none" stroke={color} strokeWidth="2" strokeDasharray="6 4" opacity="0.5"/>
          <circle cx="200" cy="52" r="7" fill="none" stroke={color} strokeWidth="2.5"/>
          <text x="200" y="30" textAnchor="middle" fill={color} fontSize="9" fontWeight="800">골든크로스</text>
        </g>)}
        {kind === 'leverage' && (<g>
          <rect x="40" y="55" width="240" height="10" rx="5" fill={color} opacity="0.25"/>
          <circle cx="90" cy="60" r="14" fill={color} opacity="0.9"/>
          <text x="90" y="65" textAnchor="middle" fill="#fff" fontSize="12" fontWeight="900">1x</text>
          <path d="M120 60 L180 60" stroke={color} strokeWidth="2" markerEnd="url(#arr)"/>
          <circle cx="230" cy="60" r="22" fill={color}/>
          <text x="230" y="66" textAnchor="middle" fill="#fff" fontSize="16" fontWeight="900">10x</text>
          <text x="160" y="95" textAnchor="middle" fill={color} fontSize="9" fontWeight="700">수익도 손실도 10배</text>
          <defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill={color}/></marker></defs>
        </g>)}
        {kind === 'portfolio' && (<g transform="translate(160,60)">
          <circle r="38" fill="none" stroke={color} strokeWidth="20" strokeDasharray="119 120" opacity="0.9" transform="rotate(-90)"/>
          <circle r="38" fill="none" stroke={color} strokeWidth="20" strokeDasharray="72 167" opacity="0.55" transform="rotate(90)"/>
          <circle r="38" fill="none" stroke={color} strokeWidth="20" strokeDasharray="48 191" opacity="0.3" transform="rotate(220)"/>
          <text y="5" textAnchor="middle" fill={color} fontSize="11" fontWeight="800">분산</text>
        </g>)}
        {kind === 'swing' && (<g>
          <polyline points="20,80 55,60 90,72 130,45 165,65 200,35 240,55 280,25 300,40" fill="none" stroke={color} strokeWidth="3"/>
          <circle cx="55" cy="60" r="6" fill={color}/><text x="55" y="50" textAnchor="middle" fill={color} fontSize="8" fontWeight="800">매수</text>
          <circle cx="130" cy="45" r="6" fill="none" stroke={color} strokeWidth="2.5"/><text x="130" y="35" textAnchor="middle" fill={color} fontSize="8" fontWeight="800">매도</text>
          <circle cx="200" cy="35" r="6" fill={color}/>
          <circle cx="280" cy="25" r="6" fill="none" stroke={color} strokeWidth="2.5"/>
        </g>)}
      </svg>
    </div>
  );
}

const LEVEL_COLOR: Record<string,string> = { '입문':'#10B981','초급':'#3B82F6','중급':'#F59E0B','고급':'#EF4444' };
const STORE_KEY = 'tg_academy_v1';

export default function AcademyPage({ onHome }: { onHome?: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const [done, setDone] = useState<Set<number>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(STORE_KEY) || '[]')); } catch { return new Set([1,2]); }
  });
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  const markDone = (id: number) => {
    const next = new Set(done);
    next.add(id);
    setDone(next);
    try { localStorage.setItem(STORE_KEY, JSON.stringify([...next])); } catch {}
    showToast('✅ 학습 완료로 저장됐습니다!');
  };

  const lesson = LESSONS.find(l => l.id === open);

  // Detail view
  if (lesson) {
    const idx   = LESSONS.indexOf(lesson);
    const isDone = done.has(lesson.id);
    return (
      <div>
        {/* Toast */}
        {toast && (
          <div style={{ position:'fixed', top:16, left:'50%', transform:'translateX(-50%)',
            background:T.grn, color:'#fff', padding:'10px 20px', borderRadius:12,
            fontSize:13, fontWeight:700, zIndex:999, boxShadow:'0 4px 20px rgba(0,0,0,.3)' }}>
            {toast}
          </div>
        )}
        <div style={{ display:'flex', gap:8, marginBottom:14 }}>
          <button type="button" onClick={() => setOpen(null)}
            style={{ padding:'8px 14px', borderRadius:10, background:'transparent',
              color:T.muted, border:`1px solid ${T.border}`, fontWeight:700, fontSize:12, cursor:'pointer', minHeight:36 }}>
            ← 목록
          </button>
          {onHome && (
            <button type="button" onClick={onHome}
              style={{ padding:'8px 14px', borderRadius:10, background:'transparent',
                color:T.muted, border:`1px solid ${T.border}`, fontWeight:700, fontSize:12, cursor:'pointer', minHeight:36 }}>
              홈
            </button>
          )}
        </div>
        <div style={{ color:T.muted, fontSize:11, marginBottom:8, display:'flex', alignItems:'center', gap:6 }}>
          <span style={{ color:LEVEL_COLOR[lesson.level]||T.muted, fontWeight:800 }}>{lesson.level}</span>
          <span style={{ display:'inline-flex', alignItems:'center', gap:3 }}><Clock size={11}/> {lesson.duration}</span>
        </div>
        <div style={{ marginBottom:14 }}>
          <LessonBanner kind={(lesson as any).banner} color={LEVEL_COLOR[lesson.level]||T.acl} h={150}/>
        </div>
        <div style={{ color:T.txt, fontWeight:800, fontSize:17, marginBottom:14 }}>
          {lesson.title}
        </div>
        <Card style={{ padding:'16px', marginBottom:14 }}>
          <div style={{ color:T.sub, fontSize:14, lineHeight:1.8 }}>
            {lesson.content}
          </div>
        </Card>
        <div style={{ display:'flex', gap:8 }}>
          {idx > 0 && (
            <button type="button" onClick={() => setOpen(LESSONS[idx-1].id)}
              style={{ flex:1, padding:'12px', borderRadius:12, background:'transparent',
                color:T.muted, border:`1px solid ${T.border}`, fontWeight:700, fontSize:13, cursor:'pointer', minHeight:44 }}>
              ← 이전
            </button>
          )}
          {!isDone && (
            <button type="button" onClick={() => markDone(lesson.id)}
              style={{ flex:2, padding:'12px', borderRadius:12, background:T.grn,
                color:'#fff', border:'none', fontWeight:800, fontSize:13, cursor:'pointer', minHeight:44 }}>
              ✅ 학습 완료 저장
            </button>
          )}
          {isDone && <div style={{ flex:2, display:'flex', alignItems:'center', justifyContent:'center', gap:5, color:T.grn, fontWeight:700, padding:'12px' }}><CheckCircle2 size={15}/> 완료됨</div>}
          {idx < LESSONS.length - 1 && (
            <button type="button" onClick={() => setOpen(LESSONS[idx+1].id)}
              style={{ flex:1, padding:'12px', borderRadius:12, background:T.acg,
                color:T.acl, border:`1px solid ${T.acl}40`, fontWeight:700, fontSize:13, cursor:'pointer', minHeight:44 }}>
              다음 →
            </button>
          )}
        </div>
      </div>
    );
  }

  // List view
  return (
    <div>
      {toast && (
        <div style={{ position:'fixed', top:16, left:'50%', transform:'translateX(-50%)',
          background:T.grn, color:'#fff', padding:'10px 20px', borderRadius:12,
          fontSize:13, fontWeight:700, zIndex:999 }}>
          {toast}
        </div>
      )}
      <div style={{ display:'flex', alignItems:'center', gap:6, fontWeight:800, fontSize:15, color:T.txt, marginBottom:4 }}>
        <GraduationCap size={18} color={T.acl}/> 투자 아카데미
      </div>
      <div style={{ color:T.muted, fontSize:10, marginBottom:14 }}>
        {done.size}/{LESSONS.length}개 완료 · 그림으로 쉽게 배우기
      </div>
      {LESSONS.map(l => (
        <Card key={l.id} style={{ padding:0, marginBottom:12, overflow:'hidden', opacity: done.has(l.id) ? 0.85 : 1 }}>
          <LessonBanner kind={l.banner} color={LEVEL_COLOR[l.level]||T.acl} h={120}/>
          <div style={{ padding:'12px 14px', display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                {done.has(l.id) && <CheckCircle2 size={14} color={T.grn}/>}
                <span style={{ color:T.txt, fontSize:13, fontWeight:700 }}>{l.title}</span>
              </div>
              <div style={{ color:T.muted, fontSize:10 }}>{l.desc}</div>
              <div style={{ display:'flex', gap:8, marginTop:5, alignItems:'center' }}>
                <span style={{ display:'inline-flex', alignItems:'center', gap:3, color:T.muted, fontSize:9 }}><Clock size={10}/> {l.duration}</span>
                <span style={{ color:LEVEL_COLOR[l.level]||T.muted, fontSize:9, fontWeight:800, background:(LEVEL_COLOR[l.level]||T.muted)+'1A', padding:'2px 7px', borderRadius:5 }}>{l.level}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(l.id)}
              style={{ display:'flex', alignItems:'center', gap:4, background: done.has(l.id) ? T.alt : T.acg,
                border:`1px solid ${done.has(l.id) ? T.border : T.acl}`,
                borderRadius:8, color: done.has(l.id) ? T.muted : T.acl,
                padding:'6px 14px', fontSize:10, fontWeight:700,
                cursor:'pointer', flexShrink:0, minHeight:34 }}>
              <PlayCircle size={12}/> {done.has(l.id) ? '복습' : '시작'}
            </button>
          </div>
        </Card>
      ))}
    </div>
  );
}

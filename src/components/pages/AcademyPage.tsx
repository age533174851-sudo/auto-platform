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
//
// 이전 버전은 레슨의 난이도 색 하나(color)만으로 전부 그려서, 상승/하락
// 캔들이 투명도로만 구분되고 파이 조각도 같은 색의 농담 차이뿐이었다.
// 무엇을 설명하는 그림인지 읽히지 않아, 의미가 있는 색과 라벨을 넣었다.
// color는 이제 배경 그라데이션과 강조 요소에만 쓴다.
const ILL = {
  up:   '#10B981',  // 상승·매수·이익
  down: '#EF4444',  // 하락·매도·손실·위험
  neut: '#94A3B8',  // 축·보조선
  ink:  '#E2E8F0',  // 본문 텍스트
  a:    '#3B82F6',  // 분류 A (주식)
  b:    '#F59E0B',  // 분류 B (코인)
  c:    '#8B5CF6',  // 분류 C (현금)
};

/** 캔들 하나 — 상승이면 초록, 하락이면 빨강 */
function Candle({ x, open, close, high, low }: { x: number; open: number; close: number; high: number; low: number }) {
  const up = close < open;               // SVG는 y가 아래로 증가 → close가 작으면 상승
  const c  = up ? ILL.up : ILL.down;
  const top = Math.min(open, close);
  const hgt = Math.max(3, Math.abs(close - open));
  return (
    <g>
      <line x1={x + 5} y1={high} x2={x + 5} y2={low} stroke={c} strokeWidth="1.5" />
      <rect x={x} y={top} width="10" height={hgt} rx="1.5" fill={c} />
    </g>
  );
}

function LessonBanner({ kind, color, h = 120 }: { kind: string; color: string; h?: number }) {
  const bg = `linear-gradient(135deg, ${color}22, ${color}08)`;
  return (
    <div style={{ width: '100%', height: h, background: bg, borderRadius: 12, overflow: 'hidden', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width="100%" height={h} viewBox="0 0 320 120" preserveAspectRatio="xMidYMid slice" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <marker id="ab-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6" fill={ILL.neut} />
          </marker>
        </defs>

        {/* 1. 주식 vs 코인 — 거래 시간과 소유 대상의 차이를 나란히 */}
        {kind === 'stocks_vs_coins' && (<g>
          <line x1="160" y1="14" x2="160" y2="106" stroke={ILL.neut} strokeWidth="1" strokeDasharray="3 4" opacity="0.5" />

          {/* 좌: 주식 = 기업 건물 */}
          <rect x="46" y="46" width="14" height="40" fill={ILL.a} opacity="0.55" />
          <rect x="64" y="34" width="18" height="52" fill={ILL.a} />
          <rect x="86" y="52" width="14" height="34" fill={ILL.a} opacity="0.55" />
          <rect x="68" y="42" width="4" height="4" fill="#0B1220" />
          <rect x="76" y="42" width="4" height="4" fill="#0B1220" />
          <rect x="68" y="52" width="4" height="4" fill="#0B1220" />
          <rect x="76" y="52" width="4" height="4" fill="#0B1220" />
          <line x1="38" y1="86" x2="108" y2="86" stroke={ILL.neut} strokeWidth="1.5" />
          <text x="73" y="26" textAnchor="middle" fill={ILL.a} fontSize="11" fontWeight="800">주식</text>
          <text x="73" y="100" textAnchor="middle" fill={ILL.ink} fontSize="8.5">기업 소유권</text>
          <text x="73" y="111" textAnchor="middle" fill={ILL.neut} fontSize="8">평일 09:00–15:30</text>

          {/* 우: 코인 = 연결된 네트워크 노드 */}
          <g stroke={ILL.b} strokeWidth="1.5" opacity="0.75">
            <line x1="212" y1="44" x2="247" y2="60" /><line x1="247" y1="60" x2="282" y2="44" />
            <line x1="212" y1="44" x2="212" y2="76" /><line x1="282" y1="44" x2="282" y2="76" />
            <line x1="212" y1="76" x2="247" y2="60" /><line x1="247" y1="60" x2="282" y2="76" />
          </g>
          <circle cx="247" cy="60" r="12" fill={ILL.b} />
          <text x="247" y="65" textAnchor="middle" fill="#0B1220" fontSize="13" fontWeight="900">₿</text>
          {[[212,44],[282,44],[212,76],[282,76]].map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r="5.5" fill={ILL.b} opacity="0.8" />
          ))}
          <text x="247" y="26" textAnchor="middle" fill={ILL.b} fontSize="11" fontWeight="800">코인</text>
          <text x="247" y="100" textAnchor="middle" fill={ILL.ink} fontSize="8.5">네트워크 토큰</text>
          <text x="247" y="111" textAnchor="middle" fill={ILL.neut} fontSize="8">24시간 · 연중무휴</text>
        </g>)}

        {/* 2. 차트 기초 — 지지/저항 "구간"을 띠로, 캔들은 상승·하락 색 구분 */}
        {kind === 'chart' && (<g>
          <rect x="18" y="30" width="284" height="9" fill={ILL.down} opacity="0.14" />
          <rect x="18" y="86" width="284" height="9" fill={ILL.up} opacity="0.14" />
          <line x1="18" y1="34" x2="302" y2="34" stroke={ILL.down} strokeWidth="1.5" strokeDasharray="6 4" />
          <line x1="18" y1="90" x2="302" y2="90" stroke={ILL.up} strokeWidth="1.5" strokeDasharray="6 4" />

          {/* 저항에서 눌리고 지지에서 튀는 흐름 */}
          <Candle x={46}  open={78} close={64} high={58} low={84} />
          <Candle x={80}  open={64} close={46} high={40} low={68} />
          <Candle x={114} open={46} close={56} high={40} low={62} />
          <Candle x={148} open={56} close={80} high={52} low={86} />
          <Candle x={182} open={80} close={70} high={64} low={87} />
          <Candle x={216} open={70} close={48} high={41} low={74} />
          <Candle x={250} open={48} close={60} high={40} low={66} />

          <text x="22" y="27" fill={ILL.down} fontSize="9" fontWeight="800">저항 — 잘 못 뚫는 구간</text>
          <text x="22" y="106" fill={ILL.up} fontSize="9" fontWeight="800">지지 — 잘 튀어오르는 구간</text>
        </g>)}

        {/* 3. 이동평균선 — 두 선을 다른 색으로, 교차점을 실제로 표시 */}
        {kind === 'ma' && (<g>
          <line x1="18" y1="98" x2="302" y2="98" stroke={ILL.neut} strokeWidth="1" opacity="0.35" />
          {/* 장기선: 완만 */}
          <polyline points="20,74 60,72 100,70 140,66 180,61 220,56 260,51 300,47"
                    fill="none" stroke={ILL.a} strokeWidth="2.5" />
          {/* 단기선: 민감 — 아래에서 위로 뚫고 올라감 */}
          <polyline points="20,88 60,80 100,78 140,68 165,63 190,52 230,42 265,38 300,30"
                    fill="none" stroke={ILL.b} strokeWidth="3" />
          {/* 교차점 */}
          <circle cx="176" cy="58" r="9" fill="none" stroke={ILL.up} strokeWidth="2.5" />
          <circle cx="176" cy="58" r="3" fill={ILL.up} />
          <line x1="176" y1="49" x2="176" y2="30" stroke={ILL.up} strokeWidth="1" strokeDasharray="3 3" />
          <text x="176" y="25" textAnchor="middle" fill={ILL.up} fontSize="9.5" fontWeight="800">골든크로스</text>

          <rect x="20" y="103" width="9" height="3" rx="1.5" fill={ILL.b} />
          <text x="34" y="107" fill={ILL.ink} fontSize="8">단기 이동평균 (빠름)</text>
          <rect x="160" y="103" width="9" height="3" rx="1.5" fill={ILL.a} />
          <text x="174" y="107" fill={ILL.ink} fontSize="8">장기 이동평균 (느림)</text>
        </g>)}

        {/* 4. 레버리지 — 같은 10% 변동이 배율에 따라 얼마나 커지는지 막대로 */}
        {kind === 'leverage' && (<g>
          <line x1="160" y1="20" x2="160" y2="96" stroke={ILL.neut} strokeWidth="1" opacity="0.45" />
          <text x="14" y="20" fill={ILL.neut} fontSize="8">가격이 10% 움직였을 때 내 돈은</text>

          {/* 1배 */}
          <text x="42" y="42" fill={ILL.ink} fontSize="11" fontWeight="900">1배</text>
          <rect x="70" y="32" width="26" height="12" rx="2" fill={ILL.up} />
          <text x="102" y="42" fill={ILL.up} fontSize="9" fontWeight="700">+10%</text>
          <rect x="70" y="50" width="26" height="12" rx="2" fill={ILL.down} />
          <text x="102" y="60" fill={ILL.down} fontSize="9" fontWeight="700">−10%</text>

          {/* 10배 */}
          <text x="36" y="82" fill={ILL.ink} fontSize="11" fontWeight="900">10배</text>
          <rect x="70" y="72" width="78" height="12" rx="2" fill={ILL.up} />
          <text x="154" y="82" fill={ILL.up} fontSize="9" fontWeight="700">+100%</text>
          <rect x="70" y="90" width="78" height="12" rx="2" fill={ILL.down} />
          <text x="154" y="100" fill={ILL.down} fontSize="9" fontWeight="700">−100%</text>

          {/* 청산 경고 */}
          <rect x="178" y="34" width="126" height="52" rx="8" fill={ILL.down} opacity="0.14" />
          <rect x="178" y="34" width="126" height="52" rx="8" fill="none" stroke={ILL.down} strokeWidth="1.5" />
          <text x="241" y="52" textAnchor="middle" fill={ILL.down} fontSize="11" fontWeight="900">청산</text>
          <text x="241" y="66" textAnchor="middle" fill={ILL.ink} fontSize="8.5">−100%가 되면</text>
          <text x="241" y="78" textAnchor="middle" fill={ILL.ink} fontSize="8.5">원금이 모두 사라집니다</text>
        </g>)}

        {/* 5. 분산 투자 — 조각마다 다른 색 + 범례로 비중을 읽을 수 있게 */}
        {kind === 'portfolio' && (<g>
          <g transform="translate(78,60)">
            {/* 둘레 2πr = 213.6 (r=34) — 50% / 30% / 20% */}
            <circle r="34" fill="none" stroke={ILL.b} strokeWidth="19"
                    strokeDasharray="106.8 213.6" strokeDashoffset="0" transform="rotate(-90)" />
            <circle r="34" fill="none" stroke={ILL.a} strokeWidth="19"
                    strokeDasharray="64.1 213.6" strokeDashoffset="-106.8" transform="rotate(-90)" />
            <circle r="34" fill="none" stroke={ILL.c} strokeWidth="19"
                    strokeDasharray="42.7 213.6" strokeDashoffset="-170.9" transform="rotate(-90)" />
            <text y="4" textAnchor="middle" fill={ILL.ink} fontSize="10" fontWeight="800">내 자산</text>
          </g>

          <g fontSize="9.5">
            <rect x="150" y="30" width="11" height="11" rx="2.5" fill={ILL.b} />
            <text x="167" y="39" fill={ILL.ink} fontWeight="700">코인 50%</text>
            <rect x="150" y="53" width="11" height="11" rx="2.5" fill={ILL.a} />
            <text x="167" y="62" fill={ILL.ink} fontWeight="700">주식 30%</text>
            <rect x="150" y="76" width="11" height="11" rx="2.5" fill={ILL.c} />
            <text x="167" y="85" fill={ILL.ink} fontWeight="700">현금 20%</text>
          </g>
          <text x="150" y="104" fill={ILL.neut} fontSize="8">하나가 무너져도 전부를 잃지 않습니다</text>
        </g>)}

        {/* 6. 스윙 트레이딩 — 매수/매도를 색으로 구분하고 보유 구간을 표시 */}
        {kind === 'swing' && (<g>
          <rect x="58" y="22" width="76" height="72" fill={ILL.up} opacity="0.10" />
          <rect x="200" y="22" width="82" height="72" fill={ILL.up} opacity="0.10" />

          <polyline points="20,84 58,68 82,76 110,52 134,44 165,64 182,72 200,58 228,44 255,50 282,28 302,36"
                    fill="none" stroke={ILL.neut} strokeWidth="2.5" />

          {/* 매수 */}
          <circle cx="58" cy="68" r="6.5" fill={ILL.up} />
          <text x="58" y="107" textAnchor="middle" fill={ILL.up} fontSize="8.5" fontWeight="800">매수</text>
          <circle cx="200" cy="58" r="6.5" fill={ILL.up} />
          <text x="200" y="107" textAnchor="middle" fill={ILL.up} fontSize="8.5" fontWeight="800">매수</text>

          {/* 매도 */}
          <circle cx="134" cy="44" r="6.5" fill={ILL.down} />
          <text x="134" y="107" textAnchor="middle" fill={ILL.down} fontSize="8.5" fontWeight="800">매도</text>
          <circle cx="282" cy="28" r="6.5" fill={ILL.down} />
          <text x="282" y="107" textAnchor="middle" fill={ILL.down} fontSize="8.5" fontWeight="800">매도</text>

          <line x1="64" y1="16" x2="128" y2="16" stroke={ILL.neut} strokeWidth="1.2" markerEnd="url(#ab-arrow)" />
          <text x="96" y="13" textAnchor="middle" fill={ILL.neut} fontSize="7.5">며칠~몇 주 보유</text>
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

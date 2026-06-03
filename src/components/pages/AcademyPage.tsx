'use client';
import React, { useState } from 'react';
import { T } from '@/lib/constants';
import { Card } from './SharedUI';

const LESSONS = [
  { id:1, title:'투자 기초: 주식 vs 코인', desc:'두 자산의 핵심 차이점', duration:'15분', level:'입문', done:true,
    content:'주식은 기업의 소유권이고 코인은 블록체인 네트워크의 토큰입니다. 주식은 규제된 시장에서, 코인은 24/7 글로벌 시장에서 거래됩니다.' },
  { id:2, title:'기술적 분석 기초', desc:'차트 읽는 법, 지지/저항', duration:'25분', level:'초급', done:true,
    content:'지지선은 가격이 반등하는 구간, 저항선은 가격이 막히는 구간입니다. 캔들 패턴과 거래량을 함께 분석하세요.' },
  { id:3, title:'이동평균선(MA) 완전정복', desc:'SMA, EMA, MACD 활용법', duration:'20분', level:'초급', done:false,
    content:'SMA는 단순 이동평균, EMA는 지수 이동평균입니다. 골든크로스(단기MA > 장기MA)는 매수 시그널입니다.' },
  { id:4, title:'레버리지와 청산 이해', desc:'마진 거래의 위험성', duration:'30분', level:'중급', done:false,
    content:'레버리지는 자본을 증폭시키지만 손실도 그만큼 커집니다. 청산가 = 진입가 ÷ (1 + 레버리지). 반드시 손절가를 설정하세요.' },
  { id:5, title:'포트폴리오 분산 투자', desc:'위험 관리와 자산 배분', duration:'20분', level:'중급', done:false,
    content:'달걀을 한 바구니에 담지 마세요. 코인 50%, 주식 30%, 현금 20% 같은 분산 전략이 리스크를 낮춥니다.' },
  { id:6, title:'스윙 트레이딩 전략', desc:'단기 추세 매매 방법', duration:'35분', level:'고급', done:false,
    content:'수일~수주 단위의 스윙 트레이딩은 일봉 차트를 기준으로 추세를 잡습니다. RSI, MACD, 볼린저밴드를 활용하세요.' },
];

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
              🏠 홈
            </button>
          )}
        </div>
        <div style={{ color:T.muted, fontSize:11, marginBottom:4 }}>
          {lesson.level} · ⏱ {lesson.duration}
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
          {isDone && <div style={{ flex:2, textAlign:'center', color:T.grn, fontWeight:700, padding:'12px' }}>✓ 완료됨</div>}
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
      <div style={{ fontWeight:800, fontSize:15, color:T.txt, marginBottom:4 }}>📚 투자 아카데미</div>
      <div style={{ color:T.muted, fontSize:10, marginBottom:14 }}>
        {done.size}/{LESSONS.length}개 완료 · 탭하여 학습 시작
      </div>
      {LESSONS.map(l => (
        <Card key={l.id} style={{ padding:'12px 14px', marginBottom:8, opacity: done.has(l.id) ? 0.8 : 1 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                {done.has(l.id) && <span style={{ color:T.grn, fontSize:12 }}>✓</span>}
                <span style={{ color:T.txt, fontSize:12, fontWeight:700 }}>{l.title}</span>
              </div>
              <div style={{ color:T.muted, fontSize:10 }}>{l.desc}</div>
              <div style={{ display:'flex', gap:8, marginTop:4 }}>
                <span style={{ color:T.muted, fontSize:9 }}>⏱ {l.duration}</span>
                <span style={{ color:LEVEL_COLOR[l.level]||T.muted, fontSize:9, fontWeight:700 }}>{l.level}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(l.id)}
              style={{ background: done.has(l.id) ? T.alt : T.acg,
                border:`1px solid ${done.has(l.id) ? T.border : T.acl}`,
                borderRadius:8, color: done.has(l.id) ? T.muted : T.acl,
                padding:'6px 14px', fontSize:10, fontWeight:700,
                cursor:'pointer', flexShrink:0, minHeight:34 }}>
              {done.has(l.id) ? '복습' : '시작'}
            </button>
          </div>
        </Card>
      ))}
    </div>
  );
}

'use client';
// ChandelierPanel — 고정 익절 vs Chandelier Exit 비교. "추세를 끝까지 먹는다".
import React, { useState, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Anchor, TrendingUp, Check } from 'lucide-react';
import { compareExits } from '@/lib/autotrade/chandelier';

// 시나리오: 상승 추세(+대략 scale%) 후 반전. 눌림목 포함 → 트레일링의 가치를 보여줌.
function trendPrices(scale: number, seed = 7): number[] {
  const out: number[] = []; let p = 100;
  const n = 60;
  for (let i = 0; i < n; i++) {
    const phase = i / n;
    const up = phase < 0.75 ? scale / (n * 0.75) : -scale / (n * 0.5);  // 75%까지 상승 후 하락 반전
    const pullback = Math.sin(i * 1.3 + seed) * (scale * 0.012);         // 눌림목
    p = Math.max(10, p + up + pullback);
    out.push(p);
  }
  return out;
}

const SCENARIOS = [
  { label: '+30% 추세', scale: 30 },
  { label: '+80% 추세', scale: 80 },
  { label: '+120% 추세', scale: 120 },
];

export default function ChandelierPanel() {
  const [scenario, setScenario] = useState(1);
  const [atrMult, setAtrMult] = useState(3);
  const [fixedTp, setFixedTp] = useState(5);

  const prices = useMemo(() => trendPrices(SCENARIOS[scenario].scale), [scenario]);
  const cmp = useMemo(() => compareExits(prices, { fixedTpPct: fixedTp, atrMult }), [prices, fixedTp, atrMult]);

  // 차트 좌표
  const W = 300, H = 110;
  const maxP = Math.max(...prices), minP = Math.min(...prices);
  const x = (i: number) => (i / (prices.length - 1)) * W;
  const y = (v: number) => H - ((v - minP) / (maxP - minP || 1)) * (H - 12) - 6;
  const priceLine = prices.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join(' ');
  const stopLine = cmp.stops.map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(i + 1).toFixed(1)} ${y(Math.max(minP, s)).toFixed(1)}`).join(' ');
  const exitX = x(cmp.chandelierExitIndex);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#F59E0B20', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Anchor size={18} color="#F59E0B" />
        </div>
        <div>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>Chandelier Exit (트레일링)</div>
          <div style={{ color: T.muted, fontSize: 11 }}>고정 익절이 놓치는 추세를 끝까지 먹기</div>
        </div>
      </div>

      {/* 시나리오 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {SCENARIOS.map((s, i) => (
          <button key={s.label} onClick={() => setScenario(i)}
            style={{ flex: 1, background: scenario === i ? '#F59E0B' : T.alt, color: scenario === i ? '#fff' : T.muted, border: 'none', borderRadius: 8, padding: '8px 4px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* 비교 결과 */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1, background: T.alt, borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>고정 +{fixedTp}% 익절</div>
          <div style={{ color: T.sub, fontSize: 19, fontWeight: 900 }}>+{cmp.fixedExitPct.toFixed(1)}%</div>
          <div style={{ color: T.muted, fontSize: 9.5 }}>추세 초반에 청산</div>
        </div>
        <div style={{ flex: 1, background: '#F59E0B14', border: `1px solid #F59E0B40`, borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>Chandelier (ATR×{atrMult})</div>
          <div style={{ color: '#F59E0B', fontSize: 19, fontWeight: 900 }}>+{cmp.chandelierExitPct.toFixed(1)}%</div>
          <div style={{ color: T.muted, fontSize: 9.5 }}>최고 +{cmp.peakPct.toFixed(0)}%의 {cmp.captured.toFixed(0)}% 확보</div>
        </div>
      </div>

      {/* 우위 강조 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#F59E0B12', borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
        <TrendingUp size={16} color="#F59E0B" />
        <span style={{ color: T.txt, fontSize: 12 }}>같은 추세에서 <b style={{ color: '#F59E0B' }}>+{cmp.advantage.toFixed(1)}%p 더</b> 확보 (고정 익절 대비 {cmp.fixedExitPct > 0 ? (cmp.chandelierExitPct / cmp.fixedExitPct).toFixed(1) : '—'}배)</span>
      </div>

      {/* 차트: 가격 + 트레일링 손절선 */}
      <div style={{ background: T.alt, borderRadius: 12, padding: '12px', marginBottom: 14 }}>
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <path d={priceLine} fill="none" stroke={T.grn} strokeWidth="2" />
          <path d={stopLine} fill="none" stroke="#F59E0B" strokeWidth="1.8" strokeDasharray="5 3" />
          <line x1={exitX} y1="0" x2={exitX} y2={H} stroke={T.red} strokeWidth="1" strokeDasharray="3 3" />
        </svg>
        <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: T.muted, fontSize: 10 }}><span style={{ width: 12, height: 2, background: T.grn, display: 'inline-block' }} />가격</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: T.muted, fontSize: 10 }}><span style={{ width: 12, height: 2, background: '#F59E0B', display: 'inline-block' }} />트레일링 손절선</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: T.muted, fontSize: 10 }}><span style={{ width: 12, height: 2, background: T.red, display: 'inline-block' }} />청산 시점</span>
        </div>
      </div>

      {/* 설정 */}
      <div style={{ background: T.alt, borderRadius: 10, padding: '10px 12px', marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: T.muted, fontSize: 11 }}>ATR 배수 (클수록 여유있게 추적)</span>
          <span style={{ color: '#F59E0B', fontSize: 12, fontWeight: 800 }}>×{atrMult}</span>
        </div>
        <input type="range" min={1.5} max={5} step={0.5} value={atrMult} onChange={e => setAtrMult(Number(e.target.value))} style={{ width: '100%', accentColor: '#F59E0B' }} />
      </div>
      <div style={{ background: T.alt, borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: T.muted, fontSize: 11 }}>비교용 고정 익절</span>
          <span style={{ color: T.sub, fontSize: 12, fontWeight: 800 }}>+{fixedTp}%</span>
        </div>
        <input type="range" min={2} max={20} step={1} value={fixedTp} onChange={e => setFixedTp(Number(e.target.value))} style={{ width: '100%', accentColor: '#64748B' }} />
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <Check size={13} color={T.muted} style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ color: T.muted, fontSize: 10, lineHeight: 1.5 }}>
          손절선(최고가 − ATR×배수)은 절대 내려가지 않아요. 손실은 초기 손절로 제한되고, 수익은 추세가 꺾일 때까지 열려있는 "손실 제한 · 수익 무한" 구조입니다.
        </span>
      </div>
    </div>
  );
}

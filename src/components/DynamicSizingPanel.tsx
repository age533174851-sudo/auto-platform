'use client';
// DynamicSizingPanel — ATR 변동성에 따라 포지션 크기를 자동 조정.
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { cvt } from '@/lib/utils';
import { Gauge, TrendingDown, Check } from 'lucide-react';
import { planPositionSize, DEFAULT_VOL_TIERS } from '@/lib/autotrade/dynamicSizing';

// 종목별 데모 가격 시계열 (실배포 시 라이브 종가 배열로 대체)
function demoPrices(symbol: string, volMult: number): number[] {
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const out: number[] = []; let p = 100;
  for (let i = 0; i < 30; i++) {
    const noise = Math.sin(seed + i * 1.9) * volMult + Math.cos(seed * 0.4 + i * 1.3) * volMult;
    p += noise;
    out.push(Math.max(1, p));
  }
  return out;
}

export default function DynamicSizingPanel({ currency = 'KRW', symbols = ['BTC', 'ETH', 'SOL'] }: { currency?: string; symbols?: string[] }) {
  const [equity, setEquity] = useState(10000000);
  const [sel, setSel] = useState(symbols[0] || 'BTC');
  // 변동성 시뮬 슬라이더 (데모: 실제로는 종목의 실 변동성)
  const [volMult, setVolMult] = useState(1.5);

  const prices = useMemo(() => demoPrices(sel, volMult), [sel, volMult]);
  const plan = useMemo(() => planPositionSize(equity, prices), [equity, prices]);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#10B98120', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Gauge size={18} color="#10B981" />
        </div>
        <div>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>ATR 동적 포지션</div>
          <div style={{ color: T.muted, fontSize: 11 }}>변동성 낮으면 크게, 높으면 작게</div>
        </div>
      </div>

      {/* 종목 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {symbols.slice(0, 5).map(sym => (
          <button key={sym} onClick={() => setSel(sym)}
            style={{ flex: 1, background: sel === sym ? '#10B981' : T.alt, color: sel === sym ? '#fff' : T.muted, border: 'none', borderRadius: 8, padding: '7px 4px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            {sym}
          </button>
        ))}
      </div>

      {/* 현재 변동성 + 추천 포지션 */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1, background: plan.tier.color + '14', border: `1px solid ${plan.tier.color}40`, borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>변동성 (ATR%)</div>
          <div style={{ color: plan.tier.color, fontSize: 20, fontWeight: 900 }}>{plan.atrPct.toFixed(2)}%</div>
          <div style={{ color: plan.tier.color, fontSize: 11, fontWeight: 700 }}>{plan.tier.label}</div>
        </div>
        <div style={{ flex: 1, background: T.alt, borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>추천 진입 금액</div>
          <div style={{ color: T.txt, fontSize: 18, fontWeight: 900, fontFamily: 'Inter,monospace' }}>{cvt(plan.positionAmount, currency)}</div>
          <div style={{ color: T.muted, fontSize: 10 }}>시드의 {plan.posPct}% · 고정 대비 {plan.vsBaseline.toFixed(1)}배</div>
        </div>
      </div>

      {/* 변동성 시뮬 슬라이더 */}
      <div style={{ background: T.alt, borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: T.muted, fontSize: 11 }}>변동성 시뮬 (테스트용)</span>
          <span style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{volMult.toFixed(1)}</span>
        </div>
        <input type="range" min={0.3} max={6} step={0.1} value={volMult} onChange={e => setVolMult(Number(e.target.value))} style={{ width: '100%', accentColor: '#10B981' }} />
      </div>

      {/* 시드 */}
      <div style={{ background: T.alt, borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: T.muted, fontSize: 11 }}>시드 (총 자본)</span>
          <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{cvt(equity, currency)}</span>
        </div>
        <input type="range" min={1000000} max={100000000} step={1000000} value={equity} onChange={e => setEquity(Number(e.target.value))} style={{ width: '100%', accentColor: '#10B981' }} />
      </div>

      {/* 티어 표 */}
      <div style={{ background: T.alt, borderRadius: 12, padding: '12px 14px', marginBottom: 12 }}>
        <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>변동성별 포지션 비중</div>
        {DEFAULT_VOL_TIERS.map((t, i) => {
          const active = plan.tier.label === t.label;
          const lo = i === 0 ? 0 : DEFAULT_VOL_TIERS[i - 1].max;
          return (
            <div key={t.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', opacity: active ? 1 : 0.55 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, flexShrink: 0 }} />
              <span style={{ color: T.txt, fontSize: 12, fontWeight: active ? 800 : 500, width: 76, flexShrink: 0 }}>{t.label}</span>
              <span style={{ color: T.muted, fontSize: 10, width: 74, flexShrink: 0 }}>ATR {lo}~{t.max === 100 ? '∞' : t.max}%</span>
              <div style={{ flex: 1, height: 6, background: T.card, borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(t.posPct / 25) * 100}%`, background: t.color }} />
              </div>
              <span style={{ color: t.color, fontSize: 12, fontWeight: 800, width: 36, textAlign: 'right' }}>{t.posPct}%</span>
              {active && <Check size={14} color={t.color} style={{ flexShrink: 0 }} />}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <TrendingDown size={13} color={T.muted} style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ color: T.muted, fontSize: 10, lineHeight: 1.5 }}>{plan.note} ATR%는 가격 대비 변동폭으로, 종목이 달라도 위험을 균등하게 맞춰줍니다.</span>
      </div>
    </div>
  );
}

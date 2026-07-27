'use client';
// CompoundAnalysis — 백테스트 복리 분석. CAGR·누적·복리 성장 그래프·ON/OFF 비교.
import React, { useMemo } from 'react';
import { T } from '@/lib/constants';
import { cvt } from '@/lib/utils';
import { TrendingUp, Repeat } from 'lucide-react';
import { analyzeCompound, compoundCurve } from '@/lib/backtest/compound';

export default function CompoundAnalysisView({
  totalReturnPct, periodDays, currency = 'KRW', initialCapital = 10000000,
}: { totalReturnPct: number; periodDays: number; currency?: string; initialCapital?: number }) {
  const a = useMemo(() => analyzeCompound(totalReturnPct, periodDays, initialCapital), [totalReturnPct, periodDays, initialCapital]);
  const curve = useMemo(() => compoundCurve(a.cagr, 10, initialCapital), [a.cagr, initialCapital]);

  // SVG 그래프 좌표
  const W = 300, H = 120, pad = 4;
  const allVals = [...curve.compound, ...curve.simple];
  const maxV = Math.max(...allVals, initialCapital * 1.1);
  const minV = Math.min(...allVals, initialCapital * 0.9);
  const x = (i: number) => pad + (i / (curve.compound.length - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - ((v - minV) / (maxV - minV || 1)) * (H - pad * 2);
  const path = (arr: number[]) => arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: '16px', marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Repeat size={16} color="#0EA5E9" />
        <span style={{ color: T.txt, fontWeight: 800, fontSize: 14 }}>복리 성장 분석</span>
      </div>

      {/* CAGR + 누적 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '11px 13px' }}>
          <div style={{ color: T.muted, fontSize: 10 }}>연평균 수익률 (CAGR)</div>
          <div style={{ color: a.cagr >= 0 ? T.grn : T.red, fontSize: 18, fontWeight: 900 }}>{a.cagr >= 0 ? '+' : ''}{a.cagr.toFixed(1)}%</div>
        </div>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '11px 13px' }}>
          <div style={{ color: T.muted, fontSize: 10 }}>누적 수익률 ({a.periodYears.toFixed(1)}년)</div>
          <div style={{ color: a.totalReturnPct >= 0 ? T.grn : T.red, fontSize: 18, fontWeight: 900 }}>{a.totalReturnPct >= 0 ? '+' : ''}{a.totalReturnPct.toFixed(1)}%</div>
        </div>
      </div>

      {/* 복리 성장 그래프 */}
      <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>복리 기준 자산 성장 (초기 {cvt(initialCapital, currency)})</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', marginBottom: 8 }}>
        {/* 초기자본 기준선 */}
        <line x1={pad} y1={y(initialCapital)} x2={W - pad} y2={y(initialCapital)} stroke={T.border} strokeWidth="1" strokeDasharray="3,3" />
        <path d={path(curve.simple)} fill="none" stroke="#64748B" strokeWidth="1.5" strokeDasharray="4,3" />
        <path d={path(curve.compound)} fill="none" stroke="#0EA5E9" strokeWidth="2.5" />
      </svg>
      <div style={{ display: 'flex', gap: 14, marginBottom: 14, fontSize: 10.5 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 14, height: 2.5, background: '#0EA5E9', display: 'inline-block' }} /><span style={{ color: T.sub }}>복리 ON (재투자)</span></span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 14, height: 2, background: '#64748B', display: 'inline-block' }} /><span style={{ color: T.muted }}>복리 OFF (단리)</span></span>
      </div>

      {/* 다년 비교 표 */}
      <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>복리 ON/OFF 비교</div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', fontSize: 9.5, color: T.muted, padding: '0 2px 5px', borderBottom: `1px solid ${T.border}` }}>
          <span style={{ flex: 1 }}>기간</span>
          <span style={{ width: 100, textAlign: 'right' }}>복리 ON</span>
          <span style={{ width: 100, textAlign: 'right' }}>복리 OFF</span>
        </div>
        {a.years.map((yr, i) => (
          <div key={yr} style={{ display: 'flex', fontSize: 11.5, padding: '7px 2px', borderBottom: `1px solid ${T.border}` }}>
            <span style={{ flex: 1, color: T.sub, fontWeight: 600 }}>{yr}년</span>
            <span style={{ width: 100, textAlign: 'right', color: T.txt, fontWeight: 700 }}>{cvt(a.compoundValues[i], currency)}</span>
            <span style={{ width: 100, textAlign: 'right', color: T.muted }}>{cvt(a.simpleValues[i], currency)}</span>
          </div>
        ))}
      </div>

      <div style={{ background: '#0EA5E910', borderRadius: 10, padding: '11px 13px' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <TrendingUp size={13} color="#0EA5E9" style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ color: T.sub, fontSize: 11.5, lineHeight: 1.5 }}>{a.projectionNote}</span>
        </div>
      </div>

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 10 }}>
        1년만 보면 복리 ON/OFF 차이가 없습니다. CAGR({a.cagr.toFixed(1)}%)을 유지한다는 가정의 추정이며, 실제 수익률은 매년 달라집니다.
      </div>
    </div>
  );
}

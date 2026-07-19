'use client';
// AdaptiveLeveragePanel — AI 레버리지 자동조절. 위원회+국면+변동성으로 0~5배 결정.
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Gauge, ShieldAlert, AlertTriangle, Check } from 'lucide-react';
import { computeAdaptiveLeverage, leverageScenarios } from '@/lib/autotrade/adaptiveLeverage';
import { convene } from '@/lib/autotrade/committee';

function demoPrices(symbol: string, vol = 1): number[] {
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const trend = (seed % 3) - 1;
  const out: number[] = []; let p = 100;
  for (let i = 0; i < 40; i++) { p += trend * 0.5 + Math.sin(seed + i * 1.6) * 1.1 * vol; out.push(Math.max(1, p)); }
  return out;
}

export default function AdaptiveLeveragePanel({ symbols = ['BTC', 'ETH', 'SOL'], strategyScore }: { symbols?: string[]; strategyScore?: number }) {
  const [sel, setSel] = useState(symbols[0] || 'BTC');
  const [maxLev, setMaxLev] = useState(5);
  const [fg, setFg] = useState<number>(50);

  useEffect(() => {
    let alive = true;
    (async () => { try { const r = await fetch('/api/feargreed', { cache: 'no-store' }); const d = await r.json(); if (alive) setFg(d?.crypto?.value ?? d?.value ?? 50); } catch {} })();
    return () => { alive = false; };
  }, []);

  const prices = useMemo(() => demoPrices(sel), [sel]);
  const committee = useMemo(() => convene({ prices, fearGreed: fg, strategyScore }), [prices, fg, strategyScore]);
  const result = useMemo(() => computeAdaptiveLeverage({ prices, committeeBias: committee.finalBias, consensus: committee.consensusStrength, maxLeverage: maxLev }), [prices, committee, maxLev]);
  const scenarios = useMemo(() => leverageScenarios(30, result.estMddPct > 0 ? result.estMddPct / result.leverage : 10), [result]);

  const gaugePct = (result.leverage / maxLev) * 100;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#F59E0B20', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Gauge size={18} color="#F59E0B" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>AI 레버리지 자동조절</div>
          <div style={{ color: T.muted, fontSize: 11 }}>시장 상황에 따라 0~{maxLev}배 자동 조절</div>
        </div>
        <span style={{ background: result.gradeColor + '20', color: result.gradeColor, fontSize: 11, fontWeight: 800, padding: '4px 10px', borderRadius: 7 }}>{result.marketGrade}</span>
      </div>

      {/* 종목 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {symbols.slice(0, 5).map(sym => (
          <button key={sym} onClick={() => setSel(sym)}
            style={{ flex: 1, background: sel === sym ? '#F59E0B' : T.alt, color: sel === sym ? '#fff' : T.muted, border: 'none', borderRadius: 8, padding: '7px 4px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            {sym}
          </button>
        ))}
      </div>

      {/* 배율 게이지 */}
      <div style={{ textAlign: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 40, fontWeight: 900, color: result.leverage === 0 ? T.red : result.gradeColor, lineHeight: 1 }}>
          {result.leverage === 0 ? '진입 안 함' : `${result.leverage}×`}
        </div>
        <div style={{ height: 8, background: T.alt, borderRadius: 4, overflow: 'hidden', margin: '10px 0 4px' }}>
          <div style={{ height: '100%', width: `${gaugePct}%`, background: result.gradeColor, transition: 'width .3s' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: T.muted }}>
          <span>0배 (진입 안 함)</span><span>{maxLev}배 (상한)</span>
        </div>
      </div>

      {/* 리스크 지표 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '9px 11px' }}>
          <div style={{ color: T.muted, fontSize: 9.5 }}>예상 MDD</div>
          <div style={{ color: result.estMddPct >= 30 ? T.red : result.estMddPct >= 20 ? T.ylw : T.grn, fontSize: 14, fontWeight: 800 }}>-{result.estMddPct}%</div>
        </div>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '9px 11px' }}>
          <div style={{ color: T.muted, fontSize: 9.5 }}>청산까지 여유</div>
          <div style={{ color: result.liquidationRiskPct <= 25 ? T.red : T.txt, fontSize: 14, fontWeight: 800 }}>{result.leverage > 0 ? `~${result.liquidationRiskPct}%` : '—'}</div>
        </div>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '9px 11px' }}>
          <div style={{ color: T.muted, fontSize: 9.5 }}>변동성 ATR</div>
          <div style={{ color: result.atrPct >= 4 ? T.red : T.txt, fontSize: 14, fontWeight: 800 }}>{result.atrPct.toFixed(1)}%</div>
        </div>
      </div>

      {/* 판단 근거 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>조절 근거</div>
        {result.reasons.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', padding: '3px 0' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.acl, flexShrink: 0, marginTop: 6 }} />
            <span style={{ color: T.sub, fontSize: 11.5, lineHeight: 1.4 }}>{r}</span>
          </div>
        ))}
      </div>

      {/* 배율별 시나리오 — "왜 낮은 배율" */}
      <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>배율별 시나리오 (연 30% 전략 가정)</div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', fontSize: 9.5, color: T.muted, padding: '0 2px 5px', borderBottom: `1px solid ${T.border}` }}>
          <span style={{ width: 50 }}>배율</span>
          <span style={{ flex: 1, textAlign: 'right' }}>연수익</span>
          <span style={{ flex: 1, textAlign: 'right' }}>MDD</span>
          <span style={{ width: 60, textAlign: 'right' }}>생존</span>
        </div>
        {scenarios.map(s => (
          <div key={s.lev} style={{ display: 'flex', fontSize: 11.5, padding: '6px 2px', borderBottom: `1px solid ${T.border}`, opacity: s.survives ? 1 : 0.5 }}>
            <span style={{ width: 50, color: s.lev === result.leverage ? result.gradeColor : T.sub, fontWeight: s.lev === result.leverage ? 800 : 600 }}>{s.lev}×{s.lev === result.leverage ? ' ◄' : ''}</span>
            <span style={{ flex: 1, textAlign: 'right', color: T.grn }}>+{s.cagr}%</span>
            <span style={{ flex: 1, textAlign: 'right', color: T.red }}>-{s.mdd}%</span>
            <span style={{ width: 60, textAlign: 'right' }}>
              {s.survives ? <Check size={13} color={T.grn} style={{ display: 'inline' }} /> : <span style={{ color: T.red, fontSize: 10, fontWeight: 700 }}>청산위험</span>}
            </span>
          </div>
        ))}
      </div>

      {/* 상한 조절 */}
      <div style={{ background: T.alt, borderRadius: 10, padding: '10px 12px', marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: T.muted, fontSize: 11 }}>레버리지 상한 (내가 정한 최대)</span>
          <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{maxLev}배</span>
        </div>
        <input type="range" min={1} max={10} step={1} value={maxLev} onChange={e => setMaxLev(Number(e.target.value))} style={{ width: '100%', accentColor: '#F59E0B' }} />
      </div>

      <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', background: '#F59E0B10', borderRadius: 10, padding: '11px 13px' }}>
        <ShieldAlert size={14} color="#F59E0B" style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ color: T.sub, fontSize: 11, lineHeight: 1.5 }}>배율을 높이면 수익도 커지지만 MDD·청산 위험도 같이 커집니다. 청산당하면 복리가 끊깁니다 — 오래 살아남는 것이 장기 복리의 핵심입니다.</span>
      </div>
    </div>
  );
}

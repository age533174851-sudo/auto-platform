'use client';
// AllocationPanel — AI 자산배분. 투자위원회 bias로 장기/단기/현금 자동 조정.
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { cvt } from '@/lib/utils';
import { PieChart, TrendingUp, TrendingDown, ArrowRight, AlertTriangle } from 'lucide-react';
import { computeAllocation, planRebalance } from '@/lib/autotrade/allocation';
import { convene } from '@/lib/autotrade/committee';

function demoPrices(symbol: string): number[] {
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const trend = (seed % 3) - 1;
  const out: number[] = []; let p = 100;
  for (let i = 0; i < 40; i++) { p += trend * 0.5 + Math.sin(seed + i * 1.6) * 1.1; out.push(Math.max(1, p)); }
  return out;
}

export default function AllocationPanel({ currency = 'KRW', strategyScore }: { currency?: string; strategyScore?: number }) {
  const [totalAsset, setTotalAsset] = useState(100000000);
  const [fg, setFg] = useState<number>(50);
  const [crashRisk, setCrashRisk] = useState(false);
  // 현재 배분 (사용자 실제 상태 가정 — 기본 기준값)
  const current = { long: 60, short: 30, cash: 10 };

  useEffect(() => {
    let alive = true;
    (async () => {
      try { const r = await fetch('/api/feargreed', { cache: 'no-store' }); const d = await r.json(); if (alive) setFg(d?.crypto?.value ?? d?.value ?? 50); }
      catch { }
    })();
    return () => { alive = false; };
  }, []);

  // BTC 기준 위원회 소집 → bias 추출 (전체 시장 대표)
  const committee = useMemo(() => convene({ prices: demoPrices('BTC'), fearGreed: fg, strategyScore }), [fg, strategyScore]);
  const alloc = useMemo(() => computeAllocation({
    totalAsset, committeeBias: committee.finalBias, consensus: committee.consensusStrength, crashRisk,
  }), [totalAsset, committee, crashRisk]);
  const moves = useMemo(() => planRebalance(current, alloc, totalAsset), [alloc, totalAsset]);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#0EA5E920', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <PieChart size={18} color="#0EA5E9" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>AI 자산배분</div>
          <div style={{ color: T.muted, fontSize: 11 }}>위원회 판단으로 장기·단기·현금 자동 조정</div>
        </div>
        <span style={{ background: alloc.stanceColor + '20', color: alloc.stanceColor, fontSize: 11, fontWeight: 800, padding: '4px 10px', borderRadius: 7 }}>{alloc.stance}</span>
      </div>

      {/* 위원회 연동 표시 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.alt, borderRadius: 10, padding: '9px 12px', marginBottom: 14 }}>
        {committee.finalBias >= 0 ? <TrendingUp size={14} color={T.grn} /> : <TrendingDown size={14} color={T.red} />}
        <span style={{ color: T.sub, fontSize: 11.5, flex: 1 }}>투자위원회 bias</span>
        <span style={{ color: committee.finalBias >= 0 ? T.grn : T.red, fontSize: 13, fontWeight: 800 }}>{committee.finalBias >= 0 ? '+' : ''}{committee.finalBias}</span>
        <span style={{ color: T.muted, fontSize: 10 }}>합의 {committee.consensusStrength}%</span>
      </div>

      {/* 배분 도넛 대체 — 스택 바 */}
      <div style={{ display: 'flex', height: 18, borderRadius: 9, overflow: 'hidden', marginBottom: 12 }}>
        {alloc.buckets.map(b => <div key={b.key} style={{ width: `${b.pct}%`, background: b.color }} />)}
      </div>
      {alloc.buckets.map(b => (
        <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${T.border}` }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: b.color, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: T.txt, fontSize: 12.5, fontWeight: 700 }}>{b.label}</div>
            <div style={{ color: T.muted, fontSize: 10 }}>{b.desc}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ color: b.color, fontSize: 15, fontWeight: 900 }}>{b.pct}%</div>
            <div style={{ color: T.muted, fontSize: 10 }}>{cvt(b.amount, currency)}</div>
          </div>
        </div>
      ))}

      {/* 근거 + 변화 */}
      <div style={{ background: alloc.stanceColor + '10', borderRadius: 10, padding: '11px 13px', margin: '12px 0' }}>
        <div style={{ color: T.txt, fontSize: 12, lineHeight: 1.5, marginBottom: 5 }}>{alloc.rationale}</div>
        <div style={{ color: T.muted, fontSize: 10.5 }}>{alloc.shift}</div>
      </div>

      {/* 리밸런싱 제안 */}
      {moves.some(m => m.action !== 'hold') && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>리밸런싱 제안</div>
          {moves.filter(m => m.action !== 'hold').map(m => (
            <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.alt, borderRadius: 9, padding: '9px 12px', marginBottom: 6 }}>
              <span style={{ color: T.txt, fontSize: 12, fontWeight: 700, flex: 1 }}>{m.label}</span>
              <span style={{ color: T.muted, fontSize: 11 }}>{m.from}%</span>
              <ArrowRight size={13} color={T.muted} />
              <span style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{m.to}%</span>
              <span style={{ color: m.action === 'buy' ? T.grn : T.red, fontSize: 11, fontWeight: 800, width: 90, textAlign: 'right' }}>
                {m.action === 'buy' ? '+' : ''}{cvt(m.deltaAmount, currency)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 컨트롤 */}
      <div style={{ background: T.alt, borderRadius: 10, padding: '10px 12px', marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: T.muted, fontSize: 11 }}>총 자산</span>
          <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{cvt(totalAsset, currency)}</span>
        </div>
        <input type="range" min={10000000} max={1000000000} step={10000000} value={totalAsset} onChange={e => setTotalAsset(Number(e.target.value))} style={{ width: '100%', accentColor: '#0EA5E9' }} />
      </div>

      <button onClick={() => setCrashRisk(v => !v)}
        style={{ width: '100%', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: crashRisk ? T.red + '20' : T.alt, color: crashRisk ? T.red : T.muted, border: `1px solid ${crashRisk ? T.red + '40' : T.border}`, borderRadius: 10, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
        <AlertTriangle size={14} /> 폭락 위험 모드 {crashRisk ? 'ON' : 'OFF'}
      </button>

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 10 }}>
        위원회 bias와 합의 강도로 배분을 조정합니다(기준 60/30/10). AI는 목표만 제시하며, 실제 자금 이동은 사용자·검증된 전략이 수행합니다.
      </div>
    </div>
  );
}

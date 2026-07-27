'use client';
// TacticalPanel — AI Tactical. 국면 + 위원회 bias로 전략 비중 자동 조정.
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Zap, TrendingUp, TrendingDown } from 'lucide-react';
import { computeTactical } from '@/lib/autotrade/tactical';
import { convene } from '@/lib/autotrade/committee';

function demoPrices(symbol: string): number[] {
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const trend = (seed % 3) - 1;
  const out: number[] = []; let p = 100;
  for (let i = 0; i < 40; i++) { p += trend * 0.5 + Math.sin(seed + i * 1.6) * 1.1; out.push(Math.max(1, p)); }
  return out;
}

export default function TacticalPanel({ symbols = ['BTC', 'ETH', 'SOL'], strategyScore }: { symbols?: string[]; strategyScore?: number }) {
  const [sel, setSel] = useState(symbols[0] || 'BTC');
  const [fg, setFg] = useState<number>(50);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { const r = await fetch('/api/feargreed', { cache: 'no-store' }); const d = await r.json(); if (alive) setFg(d?.crypto?.value ?? d?.value ?? 50); }
      catch { }
    })();
    return () => { alive = false; };
  }, []);

  const prices = useMemo(() => demoPrices(sel), [sel]);
  const committee = useMemo(() => convene({ prices, fearGreed: fg, strategyScore }), [prices, fg, strategyScore]);
  const tac = useMemo(() => computeTactical(prices, committee.finalBias), [prices, committee]);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#EC489920', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Zap size={18} color="#EC4899" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>AI Tactical</div>
          <div style={{ color: T.muted, fontSize: 11 }}>국면·위원회에 따라 전략 비중 자동 배분</div>
        </div>
        <span style={{ background: tac.regimeColor + '20', color: tac.regimeColor, fontSize: 11, fontWeight: 800, padding: '4px 10px', borderRadius: 7 }}>{tac.regimeLabel}</span>
      </div>

      {/* 종목 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {symbols.slice(0, 5).map(sym => (
          <button key={sym} onClick={() => setSel(sym)}
            style={{ flex: 1, background: sel === sym ? '#EC4899' : T.alt, color: sel === sym ? '#fff' : T.muted, border: 'none', borderRadius: 8, padding: '7px 4px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            {sym}
          </button>
        ))}
      </div>

      {/* 입력 상태 (국면 + bias) */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '9px 12px' }}>
          <div style={{ color: T.muted, fontSize: 9.5 }}>시장 국면</div>
          <div style={{ color: tac.regimeColor, fontSize: 13, fontWeight: 800 }}>{tac.regimeLabel}</div>
        </div>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '9px 12px' }}>
          <div style={{ color: T.muted, fontSize: 9.5 }}>위원회 bias</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {committee.finalBias >= 0 ? <TrendingUp size={13} color={T.grn} /> : <TrendingDown size={13} color={T.red} />}
            <span style={{ color: committee.finalBias >= 0 ? T.grn : T.red, fontSize: 13, fontWeight: 800 }}>{committee.finalBias >= 0 ? '+' : ''}{committee.finalBias}</span>
          </div>
        </div>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '9px 12px' }}>
          <div style={{ color: T.muted, fontSize: 9.5 }}>공격성</div>
          <div style={{ color: tac.aggression >= 55 ? T.grn : tac.aggression >= 35 ? T.ylw : T.muted, fontSize: 13, fontWeight: 800 }}>{tac.aggression}%</div>
        </div>
      </div>

      {/* 전략 비중 스택 바 */}
      <div style={{ display: 'flex', height: 16, borderRadius: 8, overflow: 'hidden', marginBottom: 12 }}>
        {tac.weights.map(w => <div key={w.family} style={{ width: `${w.weightPct}%`, background: w.color }} />)}
      </div>

      {/* 전략별 비중 */}
      {tac.weights.map(w => (
        <div key={w.family} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${T.border}` }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: w.color, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: T.txt, fontSize: 12.5, fontWeight: 700 }}>{w.label}</div>
            <div style={{ color: T.muted, fontSize: 10 }}>{w.desc}</div>
          </div>
          <div style={{ width: 90, height: 6, background: T.alt, borderRadius: 3, overflow: 'hidden', marginRight: 8 }}>
            <div style={{ height: '100%', width: `${Math.min(100, w.weightPct * 1.8)}%`, background: w.color }} />
          </div>
          <span style={{ color: w.color, fontSize: 15, fontWeight: 900, width: 38, textAlign: 'right' }}>{w.weightPct}%</span>
        </div>
      ))}

      <div style={{ background: tac.regimeColor + '10', borderRadius: 10, padding: '11px 13px', marginTop: 12 }}>
        <div style={{ color: T.txt, fontSize: 12, lineHeight: 1.5 }}>{tac.rationale}</div>
      </div>

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 10 }}>
        국면(추세/횡보/고변동)에 맞는 전략군에 자금을 배분하고, 위원회 bias로 공격·방어 강도를 조정합니다. AI는 비중만 제시하며 실제 매매는 각 전략이 수행합니다.
      </div>
    </div>
  );
}

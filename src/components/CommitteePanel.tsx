'use client';
// CommitteePanel — AI 투자위원회. 5명의 전문 AI가 점수를 내고 합의로 결정.
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Gavel, LineChart, Users, Globe, Building2, ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react';
import { convene, type CommitteeResult, type MemberOpinion } from '@/lib/autotrade/committee';

const ICONS: Record<string, any> = { LineChart, Users, Globe, Building2, ShieldAlert };

function demoPrices(symbol: string): number[] {
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const trend = (seed % 3) - 1;
  const out: number[] = []; let p = 100;
  for (let i = 0; i < 40; i++) { p += trend * 0.5 + Math.sin(seed + i * 1.6) * 1.1; out.push(Math.max(1, p)); }
  return out;
}

const voteMeta: Record<string, { label: string; color: string }> = {
  buy: { label: '매수', color: '#22C55E' }, hold: { label: '보유', color: '#64748B' }, sell: { label: '매도', color: '#EF4444' },
};

export default function CommitteePanel({ symbols = ['BTC', 'ETH', 'SOL'], strategyScore }: { symbols?: string[]; strategyScore?: number }) {
  const [sel, setSel] = useState(symbols[0] || 'BTC');
  const [fg, setFg] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { const r = await fetch('/api/feargreed', { cache: 'no-store' }); const d = await r.json(); if (alive) setFg(d?.crypto?.value ?? d?.value ?? 50); }
      catch { if (alive) setFg(50); }
    })();
    return () => { alive = false; };
  }, []);

  const prices = useMemo(() => demoPrices(sel), [sel]);
  const result: CommitteeResult = useMemo(() => convene({ prices, fearGreed: fg ?? 50, strategyScore }), [prices, fg, strategyScore]);
  const dm = voteMeta[result.decision];

  return (
    <div style={{ background: 'linear-gradient(145deg,#0D1A35,#091228)', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#8B5CF61F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Gavel size={18} color="#A78BFA" />
        </div>
        <div>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>AI 투자위원회</div>
          <div style={{ color: T.muted, fontSize: 11 }}>5명의 전문 AI가 토론해 합의로 결정</div>
        </div>
      </div>
      <div style={{ color: T.muted, fontSize: 10, marginBottom: 12, lineHeight: 1.4 }}>AI는 매매하지 않습니다 — 검증된 전략에 전달할 방향(bias)을 산출합니다.</div>

      {/* 종목 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {symbols.slice(0, 5).map(sym => (
          <button key={sym} onClick={() => setSel(sym)}
            style={{ flex: 1, background: sel === sym ? '#8B5CF6' : T.card, color: sel === sym ? '#fff' : T.muted, border: 'none', borderRadius: 8, padding: '7px 4px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            {sym}
          </button>
        ))}
      </div>

      {/* 최종 합의 */}
      <div style={{ background: dm.color + '14', border: `1px solid ${dm.color}40`, borderRadius: 14, padding: '14px 16px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ color: T.muted, fontSize: 11 }}>위원회 최종 결정</span>
          <span style={{ color: dm.color, fontSize: 18, fontWeight: 900 }}>{dm.label}</span>
        </div>
        {/* 투표 분포 바 */}
        <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
          <div style={{ width: `${result.buyPct}%`, background: '#22C55E' }} />
          <div style={{ width: `${result.holdPct}%`, background: '#64748B' }} />
          <div style={{ width: `${result.sellPct}%`, background: '#EF4444' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span style={{ color: '#22C55E', fontWeight: 700 }}>매수 {result.buyPct}%</span>
          <span style={{ color: T.muted, fontWeight: 700 }}>보유 {result.holdPct}%</span>
          <span style={{ color: '#EF4444', fontWeight: 700 }}>매도 {result.sellPct}%</span>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${dm.color}22` }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: T.muted, fontSize: 9 }}>합의 강도</div>
            <div style={{ color: T.txt, fontSize: 13, fontWeight: 800 }}>{result.consensusStrength}%</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: T.muted, fontSize: 9 }}>방향 bias</div>
            <div style={{ color: result.finalBias >= 0 ? T.grn : T.red, fontSize: 13, fontWeight: 800 }}>{result.finalBias >= 0 ? '+' : ''}{result.finalBias}</div>
          </div>
        </div>
      </div>

      {/* 위원별 의견 */}
      <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>위원별 의견</div>
      {result.members.map(m => {
        const Icon = ICONS[m.icon] || LineChart;
        const vm = voteMeta[m.vote];
        const open = expanded === m.id;
        return (
          <div key={m.id} style={{ background: T.card, borderRadius: 11, marginBottom: 6, overflow: 'hidden' }}>
            <button onClick={() => setExpanded(open ? null : m.id)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: m.color + '20', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon size={16} color={m.color} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: T.txt, fontSize: 12.5, fontWeight: 700 }}>{m.name}</div>
                <div style={{ color: T.muted, fontSize: 10 }}>{m.role}</div>
              </div>
              <span style={{ background: vm.color + '20', color: vm.color, fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 6, flexShrink: 0 }}>{vm.label} {m.score}</span>
              {open ? <ChevronUp size={14} color={T.muted} /> : <ChevronDown size={14} color={T.muted} />}
            </button>
            {open && (
              <div style={{ padding: '0 12px 11px 52px' }}>
                <div style={{ color: T.sub, fontSize: 11.5, lineHeight: 1.5, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>{m.rationale}</div>
                <div style={{ color: T.muted, fontSize: 9.5, marginTop: 4 }}>위원회 가중치 {(m.weight * 100).toFixed(0)}%</div>
              </div>
            )}
          </div>
        );
      })}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 10 }}>
        {result.summary}. 각 AI의 판단 근거가 기록되어 "왜 이 결정을 했는가"를 추적할 수 있습니다.
      </div>
    </div>
  );
}

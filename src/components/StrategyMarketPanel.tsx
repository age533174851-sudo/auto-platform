'use client';
// StrategyMarketPanel — AI 전략 마켓. 종목마다 시간프레임 자동 배정 + 원하는 전략만 켜기.
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Store, Zap, Rocket, TrendingUp, Gem, Ban, Check } from 'lucide-react';
import { assignPortfolio, TIMEFRAMES, type Timeframe } from '@/lib/autotrade/strategyMarket';
import { notifySuccess } from '@/lib/notify/center';

const TF_ICON: Record<string, any> = { Zap, Rocket, TrendingUp, Gem, Ban };

function demoPrices(symbol: string): number[] {
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const trend = ((seed % 5) - 2) * 0.6;
  const volMul = 0.5 + (seed % 4) * 0.7;
  const out: number[] = []; let p = 100;
  for (let i = 0; i < 40; i++) { p += trend + Math.sin(seed + i * 1.4) * 1.2 * volMul; out.push(Math.max(1, p)); }
  return out;
}

export default function StrategyMarketPanel({ symbols = ['BTC', 'ETH', 'SOL', 'DOGE'] }: { symbols?: string[] }) {
  const [fg, setFg] = useState<number>(50);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    (async () => { try { const r = await fetch('/api/feargreed', { cache: 'no-store' }); const d = await r.json(); if (alive) setFg(d?.crypto?.value ?? d?.value ?? 50); } catch {} })();
    return () => { alive = false; };
  }, []);

  const portfolio = useMemo(() => assignPortfolio(symbols.map(s => ({ symbol: s, prices: demoPrices(s) })), fg, 5), [symbols, fg]);

  // 초기 enabled: 활성 종목만 ON
  useEffect(() => {
    const init: Record<string, boolean> = {};
    portfolio.assignments.forEach(a => { init[a.symbol] = a.timeframe !== 'none'; });
    setEnabled(init);
  }, [portfolio]);

  const toggle = (symbol: string) => {
    setEnabled(prev => { const next = { ...prev, [symbol]: !prev[symbol] }; notifySuccess(next[symbol] ? '전략 켜짐' : '전략 꺼짐', symbol); return next; });
  };

  const activeAlloc = portfolio.allocation.filter(a => enabled[a.symbol]);

  return (
    <div style={{ background: 'linear-gradient(145deg,#0D1A35,#091228)', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#22C55E1F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Store size={18} color="#4ADE80" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>AI 전략 마켓</div>
          <div style={{ color: T.muted, fontSize: 11 }}>종목마다 최적 시간프레임 자동 배정</div>
        </div>
      </div>
      <div style={{ color: T.muted, fontSize: 10.5, marginBottom: 14 }}>{portfolio.summary}</div>

      {/* 종목별 배정 카드 */}
      {portfolio.assignments.map(a => {
        const Icon = TF_ICON[a.tfIcon] || TrendingUp;
        const isNone = a.timeframe === 'none';
        const on = enabled[a.symbol];
        return (
          <div key={a.symbol} style={{ background: T.card, borderRadius: 13, padding: '13px', marginBottom: 8, border: `1px solid ${on && !isNone ? a.tfColor + '40' : T.border}`, opacity: isNone ? 0.7 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: isNone ? 0 : 9 }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: a.tfColor + '20', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon size={18} color={a.tfColor} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ color: T.txt, fontSize: 14, fontWeight: 800 }}>{a.symbol}</span>
                  <span style={{ background: a.tfColor + '20', color: a.tfColor, fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 5 }}>{a.tfLabel}</span>
                  {!isNone && <span style={{ color: T.muted, fontSize: 9.5 }}>{a.horizon}</span>}
                </div>
                <div style={{ color: T.muted, fontSize: 10.5, marginTop: 2 }}>{a.strategy}{!isNone && ` · ${a.leverage}배`}</div>
              </div>
              {/* 토글 */}
              {!isNone ? (
                <button onClick={() => toggle(a.symbol)}
                  style={{ width: 46, height: 26, borderRadius: 13, border: 'none', background: on ? a.tfColor : T.border2, position: 'relative', cursor: 'pointer', flexShrink: 0, transition: 'background .2s' }}>
                  <span style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left .2s' }} />
                </button>
              ) : (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: T.muted, fontSize: 11, fontWeight: 700, flexShrink: 0 }}><Ban size={13} /> 관망</span>
              )}
            </div>
            {!isNone && (
              <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
                <span style={{ color: T.sub, fontSize: 11, lineHeight: 1.4, flex: 1 }}>{a.reason}</span>
                <span style={{ color: a.tfColor, fontSize: 10, fontWeight: 700, flexShrink: 0 }}>확신 {a.confidence}%</span>
              </div>
            )}
            {isNone && <div style={{ color: T.muted, fontSize: 10.5, marginTop: 6, paddingLeft: 46 }}>{a.reason}</div>}
          </div>
        );
      })}

      {/* 켜진 전략 자금 배분 */}
      {activeAlloc.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>켜진 전략 자금 배분</div>
          <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', marginBottom: 8 }}>
            {activeAlloc.map((a, i) => {
              const asg = portfolio.assignments.find(x => x.symbol === a.symbol)!;
              return <div key={a.symbol} style={{ width: `${a.pct}%`, background: asg.tfColor }} />;
            })}
          </div>
          {activeAlloc.map(a => {
            const asg = portfolio.assignments.find(x => x.symbol === a.symbol)!;
            return (
              <div key={a.symbol} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: asg.tfColor, flexShrink: 0 }} />
                <span style={{ color: T.sub, fontSize: 11.5, flex: 1 }}>{a.symbol} <span style={{ color: T.muted, fontSize: 10 }}>({asg.tfLabel})</span></span>
                <span style={{ color: T.txt, fontSize: 12, fontWeight: 800 }}>{a.pct}%</span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 12 }}>
        AI가 종목별 국면·변동성·위원회를 종합해 시간프레임을 배정합니다. 원하는 종목만 켜서 하나의 계좌에서 여러 시간프레임을 동시에 운용할 수 있습니다.
      </div>
    </div>
  );
}

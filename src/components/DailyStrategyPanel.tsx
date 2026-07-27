'use client';
// DailyStrategyPanel — 1D 5v5 통합 백테스트 결과.
// 실전 규칙(하루 1회·계단식·비대칭 청산·사이클)을 그대로 반영한 결과를 보여준다.
import React, { useState, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Swords, Target, Layers3, Gauge } from 'lucide-react';
import { runDailyStrategyBacktest, type DailyBar } from '@/lib/backtest/dailyStrategyBacktest';

function makeDaily(n: number, seed = 42): DailyBar[] {
  const out: DailyBar[] = []; let p = 65000; let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = 0; i < n; i++) {
    const regime = Math.floor(i / 200) % 3;
    const drift = regime === 0 ? 0.004 : regime === 1 ? -0.003 : 0.0002;
    const vol = 0.025;
    const r = drift + (rnd() - 0.5) * 2 * vol;
    const open = p, close = p * (1 + r);
    out.push({
      t: i, open, close,
      high: Math.max(open, close) * (1 + vol * 0.5 * rnd()),
      low: Math.min(open, close) * (1 - vol * 0.5 * rnd()),
      volume: 1000 + rnd() * 800,
    });
    p = close;
  }
  return out;
}

function intradayFor(daily: DailyBar[]) {
  return (di: number) => {
    const b = daily[di]; if (!b) return null;
    const bars = []; let s = di * 7 + 1;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    for (let i = 0; i < 24; i++) {
      const t = i / 23;
      const target = b.open + (b.close - b.open) * t;
      const noise = (rnd() - 0.5) * (b.high - b.low) * 0.4;
      const c = Math.max(b.low, Math.min(b.high, target + noise));
      bars.push({ high: Math.min(b.high, c * (1 + 0.003 * rnd())), low: Math.max(b.low, c * (1 - 0.003 * rnd())), close: c });
    }
    return bars;
  };
}

export default function DailyStrategyPanel() {
  const [years, setYears] = useState(3);
  const [minMargin, setMinMargin] = useState(12);
  const [maxLev, setMaxLev] = useState(100);

  const result = useMemo(() => {
    const daily = makeDaily(years * 365);
    return runDailyStrategyBacktest(daily, { startCapital: 100, minMargin, maxLeverage: maxLev }, intradayFor(daily));
  }, [years, minMargin, maxLev]);

  const levDist = useMemo(() => {
    const m: Record<number, number> = {};
    result.trades.forEach(t => { m[t.leverage] = (m[t.leverage] || 0) + 1; });
    return Object.entries(m).map(([l, c]) => ({ lev: Number(l), count: c }))
      .sort((a, b) => b.count - a.count).slice(0, 5);
  }, [result]);

  const actualMaxLev = result.trades.length ? Math.max(...result.trades.map(t => t.leverage)) : 0;
  const evColor = result.expectancyR >= 0 ? T.grn : T.red;

  return (
    <div style={{ background: 'linear-gradient(145deg,#0D1A35,#091228)', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#8B5CF61F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Swords size={18} color="#A78BFA" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>1D 5v5 통합 백테스트</div>
          <div style={{ color: T.muted, fontSize: 11 }}>하루 1회 · 계단식 증거금 · 비대칭 청산 · 사이클 락</div>
        </div>
      </div>
      <div style={{ color: T.muted, fontSize: 10, marginBottom: 14, lineHeight: 1.4 }}>
        실전 규칙을 그대로 반영합니다. 캔들 내부 청산도 판정하므로 일반 백테스트보다 결과가 보수적입니다.
      </div>

      {/* 핵심 결과 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginBottom: 12 }}>
        {[
          ['진입 / 관망', `${result.tradingDays} / ${result.noTradeDays}일`, T.sub],
          ['승률', `${result.winRate.toFixed(1)}%`, T.sub],
          ['평균 이익 / 손실', `+${result.avgWinR.toFixed(2)}R / ${result.avgLossR.toFixed(2)}R`, T.sub],
          ['기대값', `${result.expectancyR >= 0 ? '+' : ''}${result.expectancyR.toFixed(3)}R`, evColor],
          ['청산', `${result.liquidationCount}회`, result.liquidationCount > 5 ? T.red : T.grn],
          ['최대 연속손실', `${result.maxConsecutiveLosses}회`, result.maxConsecutiveLosses >= 8 ? T.ylw : T.sub],
        ].map(([l, v, c]) => (
          <div key={l as string} style={{ background: T.card, borderRadius: 9, padding: '9px 11px' }}>
            <div style={{ color: T.muted, fontSize: 9 }}>{l}</div>
            <div style={{ color: c as string, fontSize: 13.5, fontWeight: 800 }}>{v}</div>
          </div>
        ))}
      </div>

      {/* 배율 실측 — 핵심 인사이트 */}
      <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <Gauge size={13} color="#FBBF24" />
          <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>실제로 선택된 배율</span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <div style={{ flex: 1, background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ color: T.muted, fontSize: 9 }}>허용 상한</div>
            <div style={{ color: T.sub, fontSize: 14, fontWeight: 800 }}>{maxLev}배</div>
          </div>
          <div style={{ flex: 1, background: T.grn + '14', borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ color: T.muted, fontSize: 9 }}>실제 최대</div>
            <div style={{ color: T.grn, fontSize: 14, fontWeight: 800 }}>{actualMaxLev}배</div>
          </div>
        </div>
        {levDist.map(d => (
          <div key={d.lev} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
            <span style={{ color: T.sub, fontSize: 11, width: 38 }}>{d.lev}배</span>
            <div style={{ flex: 1, height: 5, background: T.alt, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(d.count / (result.trades.length || 1)) * 100 * 4}%`, maxWidth: '100%', background: '#FBBF24' }} />
            </div>
            <span style={{ color: T.muted, fontSize: 9.5, width: 34, textAlign: 'right' }}>{((d.count / (result.trades.length || 1)) * 100).toFixed(0)}%</span>
          </div>
        ))}
        <div style={{ color: T.muted, fontSize: 10, marginTop: 8, lineHeight: 1.4 }}>
          상한 {maxLev}배를 줘도 손절 폭에서 역산하면 {actualMaxLev}배가 최대입니다. 배율은 목표가 아니라 결과입니다.
        </div>
      </div>

      {/* 사이클 */}
      <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <Layers3 size={13} color="#A78BFA" />
          <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>사이클 ($100 → $100,000)</span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1, background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ color: T.muted, fontSize: 9 }}>완료</div>
            <div style={{ color: T.grn, fontSize: 14, fontWeight: 800 }}>{result.cyclesCompleted}회</div>
          </div>
          <div style={{ flex: 1, background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ color: T.muted, fontSize: 9 }}>실패</div>
            <div style={{ color: T.red, fontSize: 14, fontWeight: 800 }}>{result.cyclesFailed}회</div>
          </div>
          <div style={{ flex: 1, background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ color: T.muted, fontSize: 9 }}>최종 자본</div>
            <div style={{ color: T.txt, fontSize: 14, fontWeight: 800 }}>${result.finalCapital.toFixed(0)}</div>
          </div>
        </div>
        {result.cycles.slice(0, 4).map(c => (
          <div key={c.cycleNumber} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 10.5 }}>
            <span style={{ color: T.muted, width: 52 }}>사이클{c.cycleNumber}</span>
            <span style={{ color: c.completed ? T.grn : c.failed ? T.red : T.muted, width: 46 }}>
              {c.completed ? '완료' : c.failed ? '실패' : '진행중'}
            </span>
            <span style={{ color: T.sub, flex: 1 }}>${c.startCapital.toFixed(0)} → ${c.endCapital.toFixed(0)}</span>
            <span style={{ color: T.muted }}>{c.tradeCount}거래</span>
          </div>
        ))}
      </div>

      {/* 컨트롤 */}
      <div style={{ background: T.card, borderRadius: 10, padding: '11px 13px', marginBottom: 10 }}>
        {[
          ['기간', years, 1, 10, 1, (v: number) => setYears(v), `${years}년`],
          ['최소 우위', minMargin, 5, 30, 1, (v: number) => setMinMargin(v), `${minMargin}점`],
          ['배율 상한', maxLev, 5, 125, 5, (v: number) => setMaxLev(v), `${maxLev}배`],
        ].map(([label, val, min, max, step, setter, display]: any) => (
          <div key={label} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ color: T.muted, fontSize: 10 }}>{label}</span>
              <span style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{display}</span>
            </div>
            <input type="range" min={min} max={max} step={step} value={val}
              onChange={e => setter(Number(e.target.value))} style={{ width: '100%', accentColor: '#A78BFA' }} />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', background: evColor + '10', borderRadius: 10, padding: '11px 13px' }}>
        <Target size={14} color={evColor} style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ color: T.sub, fontSize: 10.5, lineHeight: 1.5 }}>{result.verdict}</span>
      </div>
    </div>
  );
}

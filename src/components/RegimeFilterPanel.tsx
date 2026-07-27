'use client';
// RegimeFilterPanel — 종목별 시장 국면 + 전략 적합도 표시.
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Compass, Check, AlertTriangle, TrendingUp, TrendingDown, Activity, Minus } from 'lucide-react';
import { detectRegime, strategyFitsRegime, type RegimeResult } from '@/lib/autotrade/regime';

const STRAT_LABEL: Record<string, string> = {
  ema_cross: 'EMA 추세', breakout: '브레이크아웃', rsi_reversal: 'RSI 역추세',
  funding_rate: '펀딩 모멘텀', ai_strategy: 'AI 국면', dca: '정기적립',
};

// 종목 최근 가격 배열을 받아 국면 판정. prices가 없으면 데모용 시뮬 시계열 생성.
function usePrices(symbol: string, live?: number[]): number[] {
  return useMemo(() => {
    if (live && live.length >= 10) return live;
    // 데모: 종목명 해시로 결정적 시계열 (추세/횡보 다양하게)
    const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const trend = (seed % 3) - 1;  // -1,0,1
    const out: number[] = []; let p = 100;
    for (let i = 0; i < 40; i++) {
      const noise = (Math.sin(seed + i * 1.7) * 0.5 + Math.cos(seed * 0.3 + i) * 0.5);
      p += trend * 0.4 + noise * (0.8 + (seed % 5) * 0.3);
      out.push(p);
    }
    return out;
  }, [symbol, live]);
}

function RegimeIcon({ r }: { r: RegimeResult }) {
  if (r.regime === 'TREND_UP') return <TrendingUp size={18} color={r.color} />;
  if (r.regime === 'TREND_DOWN') return <TrendingDown size={18} color={r.color} />;
  if (r.regime === 'VOLATILE') return <Activity size={18} color={r.color} />;
  return <Minus size={18} color={r.color} />;
}

export default function RegimeFilterPanel({ strategies = [] }: { strategies?: { id: string; name: string; type: string; asset: string }[] }) {
  // 전략에 등장하는 종목들 + 기본 BTC/ETH
  const symbols = useMemo(() => {
    const s = new Set<string>(['BTC', 'ETH']);
    strategies.forEach(st => st.asset && s.add(st.asset));
    return Array.from(s).slice(0, 5);
  }, [strategies]);

  const [sel, setSel] = useState(symbols[0] || 'BTC');
  useEffect(() => { if (!symbols.includes(sel)) setSel(symbols[0] || 'BTC'); }, [symbols, sel]);

  const prices = usePrices(sel);
  const regime = useMemo(() => detectRegime(prices), [prices]);
  const stratsForAsset = strategies.filter(s => s.asset === sel);

  return (
    <div style={{ background: 'linear-gradient(145deg,#0D1A35,#091228)', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#0EA5E91F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Compass size={18} color="#0EA5E9" />
        </div>
        <div>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>시장 국면 필터</div>
          <div style={{ color: T.muted, fontSize: 11 }}>국면에 맞는 전략만 활성화하세요</div>
        </div>
      </div>

      {/* 종목 선택 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, overflowX: 'auto' }}>
        {symbols.map(sym => (
          <button key={sym} onClick={() => setSel(sym)}
            style={{ background: sel === sym ? '#0EA5E9' : T.card, color: sel === sym ? '#fff' : T.muted, border: 'none', borderRadius: 8, padding: '7px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {sym}
          </button>
        ))}
      </div>

      {/* 현재 국면 */}
      <div style={{ background: regime.color + '14', border: `1px solid ${regime.color}40`, borderRadius: 14, padding: '14px 16px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <RegimeIcon r={regime} />
          <span style={{ color: regime.color, fontWeight: 900, fontSize: 17 }}>{regime.label}</span>
          <span style={{ marginLeft: 'auto', color: T.muted, fontSize: 11 }}>{sel}</span>
        </div>
        <div style={{ color: T.sub, fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}>{regime.description}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: T.muted, fontSize: 10 }}>추세 강도 (ER)</div>
            <div style={{ height: 6, background: T.card, borderRadius: 3, overflow: 'hidden', margin: '4px 0' }}>
              <div style={{ height: '100%', width: `${regime.efficiency * 100}%`, background: regime.color }} />
            </div>
            <div style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{(regime.efficiency * 100).toFixed(0)}%</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: T.muted, fontSize: 10 }}>변동성</div>
            <div style={{ height: 6, background: T.card, borderRadius: 3, overflow: 'hidden', margin: '4px 0' }}>
              <div style={{ height: '100%', width: `${Math.min(100, regime.volatility * 12)}%`, background: T.ylw }} />
            </div>
            <div style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{regime.volatility.toFixed(2)}%</div>
          </div>
        </div>
      </div>

      {/* 적합 전략 */}
      <div style={{ marginBottom: stratsForAsset.length ? 14 : 0 }}>
        <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>이 국면에 적합한 전략</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {regime.suitableStrategies.map(t => (
            <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: T.grn + '18', color: T.grn, fontSize: 11, fontWeight: 700, padding: '5px 10px', borderRadius: 7 }}>
              <Check size={12} /> {STRAT_LABEL[t] || t}
            </span>
          ))}
        </div>
      </div>

      {/* 내 전략 적합도 (해당 종목 전략이 있으면) */}
      {stratsForAsset.length > 0 && (
        <div>
          <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>내 {sel} 전략 적합도</div>
          {stratsForAsset.map(s => {
            const fit = strategyFitsRegime(s.type, regime.regime);
            return (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.card, borderRadius: 10, padding: '10px 12px', marginBottom: 6, border: `1px solid ${fit.fits ? T.grn + '30' : T.red + '30'}` }}>
                {fit.fits ? <Check size={15} color={T.grn} /> : <AlertTriangle size={15} color={T.red} />}
                <div style={{ flex: 1 }}>
                  <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{s.name}</div>
                  <div style={{ color: T.muted, fontSize: 10 }}>{fit.reason}</div>
                </div>
                <span style={{ color: fit.fits ? T.grn : T.red, fontSize: 13, fontWeight: 800 }}>{fit.score}</span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 10 }}>
        효율성 비율(ER)로 추세/횡보를 판별합니다. 국면과 맞지 않는 전략은 신호를 보류하는 것이 안전합니다.
      </div>
    </div>
  );
}

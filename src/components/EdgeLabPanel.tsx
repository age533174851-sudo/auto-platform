'use client';
import { A } from '@/lib/theme/colors';
// EdgeLabPanel — MAE/MFE 경로 분석 + Expansion Mode.
// "최종 방향을 맞혀도 경로에서 청산된다"를 숫자로 보여준다.
import React, { useState, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Microscope, TrendingUp, Skull, Zap } from 'lucide-react';
import { measureExcursion, analyzeExcursions, survivalAt, maxLeverageForSurvivalRate, type Excursion } from '@/lib/backtest/excursion';
import { evaluateExpansion } from '@/lib/strategies/expansionMode';

function intraday(driftPct: number, volPct: number, seed: number, bars = 480) {
  const out: { high: number; low: number; close: number }[] = [];
  let p = 65000, s = seed >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return (s % 2147483648) / 2147483648; };
  const d = driftPct / 100 / bars, v = volPct / 100 / Math.sqrt(bars);
  for (let i = 0; i < bars; i++) {
    const r = d + (rnd() - 0.5) * 2 * v;
    const c = p * (1 + r);
    out.push({ high: Math.max(p, c) * (1 + v * 0.5 * rnd()), low: Math.min(p, c) * (1 - v * 0.5 * rnd()), close: c });
    p = c;
  }
  return out;
}

export default function EdgeLabPanel() {
  const [minMove, setMinMove] = useState(3);
  const [sampleSize, setSampleSize] = useState(200);

  const { cases, stats } = useMemo(() => {
    const c: Excursion[] = [];
    for (let s = 1; s <= sampleSize; s++) {
      const bars = intraday(minMove + (s % 7), 3 + ((s % 5) * 1.5), s * 7);
      const ex = measureExcursion('LONG', 65000, bars);
      if (ex.closePct > minMove * 0.6) c.push(ex);
    }
    return { cases: c, stats: analyzeExcursions(c) };
  }, [minMove, sampleSize]);

  const safe90 = useMemo(() => maxLeverageForSurvivalRate(cases, 90), [cases]);

  const expansionDemo = useMemo(() => evaluateExpansion({
    currentAtrPct: 1.2, baselineAtrPct: 2.0,
    bbWidthPct: 2.5, bbWidthBaseline: 4.0,
    volumeRatio: 1.8, oiChangePct: 5, fundingRate: 0.06,
    historicalMaeP90: stats.maeP90,
  }, { userMaxLeverage: 100, normalMaxLeverage: 10 }), [stats.maeP90]);

  const samples = cases.slice(0, 6).map(ex => ({ ex, s: survivalAt(ex, 100) }));

  return (
    <div style={{ background: 'linear-gradient(145deg,var(--t-card),var(--t-bg))', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#06B6D41F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Microscope size={18} color="#22D3EE" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>Edge Lab — 경로 분석</div>
          <div style={{ color: T.muted, fontSize: 11 }}>최종 방향이 아니라 MAE가 결정한다</div>
        </div>
      </div>
      <div style={{ color: T.muted, fontSize: 10, marginBottom: 14, lineHeight: 1.45 }}>
        종가 수익률만 보면 "+5% 오른 날 = 100배로 +500%"입니다. 하지만 진입 후 -0.5%만 흔들려도 청산됩니다.
        MAE(최대 불리 이동)를 보면 실제로 먹을 수 있었는지 알 수 있습니다.
      </div>

      {/* 샘플: 방향은 맞았는데 청산된 케이스 */}
      <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
        <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, marginBottom: 9 }}>
          최종 +{minMove}% 이상 오른 날 — 100배로 먹을 수 있었나
        </div>
        <div style={{ display: 'flex', fontSize: 9, color: T.muted, padding: '0 2px 5px', borderBottom: `1px solid ${T.border}` }}>
          <span style={{ flex: 1 }}>MAE</span>
          <span style={{ flex: 1 }}>MFE</span>
          <span style={{ flex: 1 }}>종가</span>
          <span style={{ width: 90, textAlign: 'right' }}>100배 상한</span>
        </div>
        {samples.map((x, i) => (
          <div key={i} style={{ display: 'flex', fontSize: 11, padding: '6px 2px', borderBottom: `1px solid ${T.border}` }}>
            <span style={{ flex: 1, color: x.ex.maePct > 0.5 ? T.red : T.sub }}>-{x.ex.maePct.toFixed(2)}%</span>
            <span style={{ flex: 1, color: T.grn }}>+{x.ex.mfePct.toFixed(2)}%</span>
            <span style={{ flex: 1, color: T.sub }}>+{x.ex.closePct.toFixed(1)}%</span>
            <span style={{ width: 90, textAlign: 'right', color: x.s.survived ? T.grn : T.red, fontWeight: 700 }}>
              {x.s.survived ? `≤ +${x.s.mfeUpperBoundPct!.toFixed(0)}%` : '💀 청산'}
            </span>
          </div>
        ))}
        <div style={{ color: T.muted, fontSize: 10, marginTop: 8, lineHeight: 1.4 }}>
          MAE가 0.50%를 넘으면 최종 방향이 맞아도 청산됩니다 (100배 청산거리 = 0.50%)
        </div>
        <div style={{ color: T.ylw, fontSize: 10, marginTop: 6, lineHeight: 1.4, background: A(T.ylw,'12'), borderRadius: 8, padding: '7px 9px' }}>
          ⚠️ 「100배 상한」은 MFE 최고점에서 전량 청산했다고 가정한 <b>천장값</b>입니다.
          실제 봇은 그 지점을 알 수 없으므로 이만큼 먹지 못합니다.
          실현 수익은 손절·분할익절·트레일링을 적용해 계산해야 합니다.
        </div>
      </div>

      {/* MAE 분포 */}
      <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
        <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, marginBottom: 9 }}>MAE 분포 ({stats.sampleSize}건)</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6 }}>
          {[['중앙값', stats.maeP50], ['75분위', stats.maeP75], ['90분위', stats.maeP90], ['최대', stats.maeMax]].map(([l, v]) => (
            <div key={l as string} style={{ background: T.alt, borderRadius: 8, padding: '7px 9px' }}>
              <div style={{ color: T.muted, fontSize: 8.5 }}>{l}</div>
              <div style={{ color: (v as number) > 0.5 ? T.red : T.grn, fontSize: 12.5, fontWeight: 800 }}>{(v as number).toFixed(2)}%</div>
            </div>
          ))}
        </div>
      </div>

      {/* 배율별 생존률 — 핵심 */}
      <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9 }}>
          <Skull size={13} color={T.red} />
          <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>배율별 생존률</span>
        </div>
        <div style={{ display: 'flex', fontSize: 9, color: T.muted, padding: '0 2px 5px', borderBottom: `1px solid ${T.border}` }}>
          <span style={{ width: 42 }}>배율</span>
          <span style={{ flex: 1 }}>생존률</span>
          <span style={{ flex: 1, textAlign: 'right' }}>생존시 평균</span>
          <span style={{ width: 56, textAlign: 'right' }}>+300%↑</span>
        </div>
        {stats.survivalByLeverage.map(s => (
          <div key={s.leverage} style={{ display: 'flex', alignItems: 'center', fontSize: 11, padding: '6px 2px', borderBottom: `1px solid ${T.border}` }}>
            <span style={{ width: 42, color: T.sub, fontWeight: 700 }}>{s.leverage}배</span>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ flex: 1, height: 5, background: T.alt, borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${s.survivalRate}%`, background: s.survivalRate >= 90 ? T.grn : s.survivalRate >= 60 ? T.ylw : T.red }} />
              </div>
              <span style={{ color: T.muted, fontSize: 9.5, width: 34 }}>{s.survivalRate.toFixed(0)}%</span>
            </div>
            <span style={{ flex: 1, textAlign: 'right', color: T.grn }}>+{s.avgReturnIfSurvived.toFixed(0)}%</span>
            <span style={{ width: 56, textAlign: 'right', color: s.bigWinCount > 0 ? T.acl : T.muted }}>{s.bigWinCount}회</span>
          </div>
        ))}
        <div style={{ background: T.acg, borderRadius: 8, padding: '9px 11px', marginTop: 9 }}>
          <span style={{ color: T.sub, fontSize: 11, lineHeight: 1.45 }}>{safe90.note}</span>
        </div>
      </div>

      {/* Expansion Mode */}
      <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <Zap size={13} color="#FBBF24" />
          <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>Expansion Mode</span>
          <span style={{ marginLeft: 'auto', background: expansionDemo.mode === 'EXPANSION' ? A(T.grn,'20') : T.border2,
            color: expansionDemo.mode === 'EXPANSION' ? T.grn : T.muted, fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 5 }}>
            {expansionDemo.mode}
          </span>
        </div>
        <div style={{ color: T.muted, fontSize: 10, marginBottom: 9 }}>
          고배율은 평소가 아니라 대변동성이 예상되는 날에만 허용합니다
        </div>
        {expansionDemo.signals.map((sig, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: sig.hit ? T.grn : T.border2, flexShrink: 0 }} />
            <span style={{ color: sig.hit ? T.sub : T.muted, fontSize: 10.5, flex: 1 }}>{sig.name}</span>
            <span style={{ color: T.muted, fontSize: 9.5 }}>{sig.detail}</span>
          </div>
        ))}
        <div style={{ background: T.alt, borderRadius: 8, padding: '9px 11px', marginTop: 9 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: T.muted, fontSize: 10 }}>허용 최대 배율</span>
            <span style={{ color: T.acl, fontSize: 14, fontWeight: 900 }}>{expansionDemo.maxLeverageAllowed}배</span>
          </div>
          <span style={{ color: T.sub, fontSize: 10.5, lineHeight: 1.4 }}>{expansionDemo.reason}</span>
        </div>
      </div>

      {/* 컨트롤 */}
      <div style={{ background: T.card, borderRadius: 10, padding: '11px 13px', marginBottom: 10 }}>
        {[['최소 상승폭', minMove, 2, 10, 1, setMinMove, `${minMove}%`],
          ['표본 수', sampleSize, 50, 500, 50, setSampleSize, `${sampleSize}개`]].map(([l, v, min, max, st, setter, disp]: any) => (
          <div key={l} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ color: T.muted, fontSize: 10 }}>{l}</span>
              <span style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{disp}</span>
            </div>
            <input type="range" min={min} max={max} step={st} value={v}
              onChange={e => setter(Number(e.target.value))} style={{ width: '100%', accentColor: '#22D3EE' }} />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', background: '#06B6D410', borderRadius: 10, padding: '11px 13px' }}>
        <TrendingUp size={14} color="#22D3EE" style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ color: T.sub, fontSize: 10.5, lineHeight: 1.5 }}>
          이 결과는 생성된 경로 기준입니다. 실제 검증은 거래소 1분봉 히스토리로 해야 합니다.
          슬롯 $100에서 +500%는 <b style={{ color: T.txt }}>+$500</b>이지 계좌 전체가 5배 되는 게 아닙니다.
        </span>
      </div>
    </div>
  );
}

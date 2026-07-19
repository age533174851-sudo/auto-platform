'use client';
// PortfolioBacktestView — 다중 전략 포트폴리오 백테스트. 합산 성과 + 분산 효과 + 상관관계.
import React, { useMemo } from 'react';
import { T } from '@/lib/constants';
import { formatKRW, safePercent } from '@/lib/format';
import { Layers, TrendingDown, Shield } from 'lucide-react';
import { runPortfolioBacktest, type StrategyLeg } from '@/lib/backtest/portfolio';

export default function PortfolioBacktestView({ legs, initialCapital = 10000000 }: { legs: StrategyLeg[]; initialCapital?: number }) {
  const result = useMemo(() => runPortfolioBacktest(legs, initialCapital), [legs, initialCapital]);
  if (!result.combined.length) return null;

  // SVG 합산 곡선
  const W = 300, H = 110, pad = 4;
  const eq = result.combined.map(p => p.equity);
  const maxV = Math.max(...eq), minV = Math.min(...eq);
  const x = (i: number) => pad + (i / (eq.length - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - ((v - minV) / (maxV - minV || 1)) * (H - pad * 2);
  const path = eq.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const corrColor = (c: number) => c >= 0.5 ? T.red : c >= 0 ? T.ylw : T.grn;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: '16px', marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Layers size={16} color="#8B5CF6" />
        <span style={{ color: T.txt, fontWeight: 800, fontSize: 14 }}>포트폴리오 합산 성과</span>
        <span style={{ color: T.muted, fontSize: 10.5, marginLeft: 'auto' }}>{result.legStats.length}개 전략 동시 운용</span>
      </div>

      {/* 합산 지표 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ color: T.muted, fontSize: 10 }}>합산 수익률</div>
          <div style={{ color: result.totalReturnPct >= 0 ? T.grn : T.red, fontSize: 17, fontWeight: 900 }}>{safePercent(result.totalReturnPct)}</div>
        </div>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ color: T.muted, fontSize: 10 }}>포트폴리오 MDD</div>
          <div style={{ color: T.red, fontSize: 17, fontWeight: 900 }}>-{result.maxDrawdownPct.toFixed(1)}%</div>
        </div>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ color: T.muted, fontSize: 10 }}>샤프</div>
          <div style={{ color: result.sharpe >= 1 ? T.grn : T.muted, fontSize: 17, fontWeight: 900 }}>{result.sharpe.toFixed(2)}</div>
        </div>
      </div>

      {/* 합산 곡선 */}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', marginBottom: 8 }}>
        <line x1={pad} y1={y(initialCapital)} x2={W - pad} y2={y(initialCapital)} stroke={T.border} strokeWidth="1" strokeDasharray="3,3" />
        <path d={path} fill="none" stroke="#8B5CF6" strokeWidth="2.5" />
      </svg>

      {/* 분산 효과 (핵심) */}
      <div style={{ background: result.diversificationBenefit > 0 ? T.grn + '12' : T.alt, border: `1px solid ${result.diversificationBenefit > 0 ? T.grn + '30' : T.border}`, borderRadius: 12, padding: '13px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
          <Shield size={15} color={result.diversificationBenefit > 0 ? T.grn : T.muted} />
          <span style={{ color: T.txt, fontSize: 12.5, fontWeight: 800 }}>분산 효과</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ color: T.muted, fontSize: 9.5 }}>안 섞었을 때 (가중평균)</div>
            <div style={{ color: T.sub, fontSize: 15, fontWeight: 800 }}>-{result.weightedAvgMdd.toFixed(1)}%</div>
          </div>
          <TrendingDown size={16} color={T.grn} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ color: T.muted, fontSize: 9.5 }}>섞었을 때 (포트폴리오)</div>
            <div style={{ color: T.grn, fontSize: 15, fontWeight: 800 }}>-{result.maxDrawdownPct.toFixed(1)}%</div>
          </div>
        </div>
        {result.diversificationBenefit > 0.5 && (
          <div style={{ color: T.grn, fontSize: 11, fontWeight: 700, textAlign: 'center', marginTop: 8 }}>
            전략을 섞어 최대 낙폭을 {result.diversificationBenefit.toFixed(1)}%p 줄였습니다
          </div>
        )}
        {result.diversificationBenefit <= 0.5 && (
          <div style={{ color: T.muted, fontSize: 10.5, textAlign: 'center', marginTop: 8 }}>
            전략들의 상관관계가 높아 분산 효과가 크지 않습니다
          </div>
        )}
      </div>

      {/* 전략별 기여 */}
      <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>전략별 기여</div>
      {result.legStats.map(s => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: `1px solid ${T.border}` }}>
          <span style={{ color: T.txt, fontSize: 12, fontWeight: 600, flex: 1 }}>{s.name}</span>
          <span style={{ color: T.muted, fontSize: 10, width: 44, textAlign: 'right' }}>{s.weightPct.toFixed(0)}%</span>
          <span style={{ color: s.returnPct >= 0 ? T.grn : T.red, fontSize: 11.5, fontWeight: 700, width: 60, textAlign: 'right' }}>{safePercent(s.returnPct)}</span>
          <span style={{ color: T.red, fontSize: 10.5, width: 54, textAlign: 'right' }}>-{s.mddPct.toFixed(1)}%</span>
        </div>
      ))}

      {/* 상관관계 매트릭스 */}
      {result.legStats.length >= 2 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>전략 간 상관관계 <span style={{ fontWeight: 400 }}>(낮을수록 분산 효과 큼)</span></div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ padding: '3px 5px' }}></th>
                  {result.legStats.map((s, i) => <th key={i} style={{ padding: '3px 5px', color: T.muted, fontSize: 9, fontWeight: 700 }}>{s.name.slice(0, 4)}</th>)}
                </tr>
              </thead>
              <tbody>
                {result.correlationMatrix.map((row, i) => (
                  <tr key={i}>
                    <td style={{ padding: '3px 5px', color: T.muted, fontSize: 9, fontWeight: 700, whiteSpace: 'nowrap' }}>{result.legStats[i].name.slice(0, 4)}</td>
                    {row.map((c, k) => (
                      <td key={k} style={{ padding: '3px 4px', textAlign: 'center' }}>
                        <span style={{ display: 'inline-block', minWidth: 34, background: i === k ? T.border2 : corrColor(c) + '22', color: i === k ? T.muted : corrColor(c), borderRadius: 5, padding: '3px 4px', fontSize: 10, fontWeight: 700 }}>{c.toFixed(2)}</span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 12 }}>
        여러 전략을 함께 운용하면 개별 전략보다 낙폭이 줄어들 수 있습니다. 상관관계가 낮은(또는 음수) 전략을 조합할수록 분산 효과가 커집니다.
      </div>
    </div>
  );
}

'use client';
// StrategyScorePanel — 기관급 전략 점수. 승률·PF·MDD·샤프·최근 성과 합산 + AI 추천.
import React, { useState, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Star, Award, ChevronDown, ChevronUp } from 'lucide-react';
import { scoreStrategy, tradesFromSummary, recommendStrategy, type StrategyScore } from '@/lib/autotrade/strategyScore';

function Stars({ v, color }: { v: number; color: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: 1 }}>
      {[1, 2, 3, 4, 5].map(i => {
        const fill = v >= i ? 1 : v >= i - 0.5 ? 0.5 : 0;
        return (
          <span key={i} style={{ position: 'relative', width: 13, height: 13, display: 'inline-block' }}>
            <Star size={13} color={T.border2} fill={T.border2} style={{ position: 'absolute' }} />
            {fill > 0 && (
              <span style={{ position: 'absolute', overflow: 'hidden', width: fill === 1 ? 13 : 6.5 }}>
                <Star size={13} color={color} fill={color} />
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

export default function StrategyScorePanel({ strategies = [] }: { strategies?: { id: string; name: string; winRate: number; totalPnl: number; trades: number }[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const scored = useMemo(() => strategies.map(s => ({
    id: s.id, name: s.name,
    score: scoreStrategy(tradesFromSummary(s)),
  })).sort((a, b) => b.score.score - a.score.score), [strategies]);

  const reco = useMemo(() => recommendStrategy(scored), [scored]);

  return (
    <div style={{ background: 'linear-gradient(145deg,#0D1A35,#091228)', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#F59E0B20', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Award size={18} color="#F59E0B" />
        </div>
        <div>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>AI 전략 점수</div>
          <div style={{ color: T.muted, fontSize: 11 }}>승률 · Profit Factor · MDD · Sharpe · 최근 성과</div>
        </div>
      </div>

      {/* AI 추천 */}
      {reco && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: reco.score.gradeColor + '14', border: `1px solid ${reco.score.gradeColor}40`, borderRadius: 12, padding: '12px 14px', marginBottom: 14 }}>
          <Award size={17} color={reco.score.gradeColor} />
          <div style={{ flex: 1 }}>
            <div style={{ color: T.muted, fontSize: 10 }}>AI 현재 추천 전략</div>
            <div style={{ color: T.txt, fontSize: 13.5, fontWeight: 800 }}>{reco.name}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ color: reco.score.gradeColor, fontSize: 20, fontWeight: 900 }}>{reco.score.score}점</div>
            <Stars v={reco.score.stars} color={reco.score.gradeColor} />
          </div>
        </div>
      )}

      {/* 전략별 점수 */}
      {scored.map(({ id, name, score }) => {
        const open = expanded === id;
        return (
          <div key={id} style={{ background: T.card, borderRadius: 12, marginBottom: 8, overflow: 'hidden', border: `1px solid ${open ? score.gradeColor + '40' : T.border}` }}>
            <button onClick={() => setExpanded(open ? null : id)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ width: 26, height: 26, borderRadius: 7, background: score.gradeColor + '22', color: score.gradeColor, fontSize: 13, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{score.grade}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: T.txt, fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                <Stars v={score.stars} color={score.gradeColor} />
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ color: score.gradeColor, fontSize: 16, fontWeight: 900 }}>{score.score}</div>
                <div style={{ color: T.muted, fontSize: 9 }}>신뢰도 {score.confidence}%</div>
              </div>
              {open ? <ChevronUp size={15} color={T.muted} /> : <ChevronDown size={15} color={T.muted} />}
            </button>
            {open && (
              <div style={{ padding: '0 13px 12px', borderTop: `1px solid ${T.border}` }}>
                <div style={{ color: T.muted, fontSize: 10.5, margin: '10px 0' }}>{score.summary}</div>
                {score.breakdown.map(b => (
                  <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '4px 0' }}>
                    <span style={{ color: T.sub, fontSize: 11, width: 96, flexShrink: 0 }}>{b.label}</span>
                    <div style={{ flex: 1, height: 6, background: T.alt, borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${b.sub}%`, background: b.sub >= 60 ? T.grn : b.sub >= 35 ? T.ylw : T.red }} />
                    </div>
                    <span style={{ color: T.txt, fontSize: 11, fontWeight: 700, width: 74, textAlign: 'right', flexShrink: 0 }}>{b.value}</span>
                    <span style={{ color: T.muted, fontSize: 9, width: 30, textAlign: 'right', flexShrink: 0 }}>{b.weight}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 8 }}>
        5개 지표를 가중 합산합니다 (PF 25% · 승률/MDD/최근 20% · Sharpe 15%). 표본 20회 미만은 신뢰도만큼 중립(50점)으로 수렴해 과신을 방지합니다.
      </div>
    </div>
  );
}

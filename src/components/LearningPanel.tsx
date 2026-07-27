'use client';
// LearningPanel — AI 자기학습. 국면×전략 성과를 분석해 비중을 스스로 교정.
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Brain, TrendingUp, TrendingDown, Check, RefreshCw } from 'lucide-react';
import { buildLearningMatrix, saveLearning, extractInsights, auditToLearnedTrades, type LearnedTrade } from '@/lib/autotrade/learning';
import { loadAudit } from '@/lib/autotrade/auditLog';
import { ordersToClosedTrades } from '@/lib/autotrade/retrospect';
import { notifySuccess } from '@/lib/notify/center';

const REGIMES = [
  { key: 'TREND_UP', label: '상승 추세', color: '#22C55E' },
  { key: 'TREND_DOWN', label: '하락 추세', color: '#EF4444' },
  { key: 'RANGE', label: '횡보', color: '#F59E0B' },
  { key: 'VOLATILE', label: '고변동성', color: '#8B5CF6' },
] as const;
const FAMS = [
  { key: 'trend', label: 'Trend' }, { key: 'breakout', label: 'Breakout' },
  { key: 'meanrev', label: 'MeanRev' }, { key: 'grid', label: 'Grid' },
  { key: 'scalp', label: 'Scalp' }, { key: 'dca', label: 'DCA' },
] as const;

// 데모 학습 데이터: 횡보장 Trend 손실, 상승장 Trend 성공 등 (실배포 시 감사로그로 대체)
function demoTrades(): LearnedTrade[] {
  const out: LearnedTrade[] = [];
  const add = (regime: any, family: any, wins: number, losses: number, avgWin: number, avgLoss: number) => {
    for (let i = 0; i < wins; i++) out.push({ regime, family, win: true, pnl: avgWin });
    for (let i = 0; i < losses; i++) out.push({ regime, family, win: false, pnl: -avgLoss });
  };
  add('RANGE', 'trend', 2, 6, 80000, 100000);      // 횡보 Trend 실패 (승률 25%)
  add('RANGE', 'grid', 7, 3, 60000, 50000);        // 횡보 Grid 성공 (70%)
  add('TREND_UP', 'trend', 8, 2, 150000, 80000);   // 상승 Trend 성공 (80%)
  add('TREND_UP', 'meanrev', 3, 5, 50000, 90000);  // 상승 MeanRev 실패 (37%)
  return out;
}

export default function LearningPanel() {
  const [matrix, setMatrix] = useState<any>({});
  const [applied, setApplied] = useState(false);

  const trades = useMemo(() => {
    // 실제 감사로그+주문 우선, 없으면 데모
    try {
      const raw = localStorage.getItem('tg_paper_account_v1');
      const orders = raw ? JSON.parse(raw)?.orders : null;
      if (Array.isArray(orders) && orders.length >= 5) {
        const learned = auditToLearnedTrades(loadAudit() as any, ordersToClosedTrades(orders));
        if (learned.length >= 5) return learned;
      }
    } catch {}
    return demoTrades();
  }, []);

  useEffect(() => { setMatrix(buildLearningMatrix(trades)); }, [trades]);

  const insights = useMemo(() => extractInsights(matrix), [matrix]);

  const apply = () => {
    saveLearning(matrix);
    setApplied(true);
    notifySuccess('학습 적용됨', 'AI Tactical 비중에 반영되었어요');
    setTimeout(() => setApplied(false), 2000);
  };

  const cell = (reg: string, fam: string) => matrix?.[reg]?.[fam];

  return (
    <div style={{ background: 'linear-gradient(145deg,#0D1A35,#091228)', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#8B5CF61F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Brain size={18} color="#A78BFA" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>AI 자기학습</div>
          <div style={{ color: T.muted, fontSize: 11 }}>국면별 전략 성과로 비중을 스스로 교정</div>
        </div>
      </div>

      {/* 인사이트 */}
      {insights.length > 0 ? (
        <div style={{ marginBottom: 14 }}>
          <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>학습 인사이트</div>
          {insights.map((ins, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: (ins.direction === 'up' ? T.grn : T.red) + '10', border: `1px solid ${(ins.direction === 'up' ? T.grn : T.red)}30`, borderRadius: 10, padding: '10px 12px', marginBottom: 6 }}>
              {ins.direction === 'up' ? <TrendingUp size={15} color={T.grn} /> : <TrendingDown size={15} color={T.red} />}
              <span style={{ color: T.sub, fontSize: 11.5, lineHeight: 1.4, flex: 1 }}>{ins.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ color: T.muted, fontSize: 12, textAlign: 'center', padding: '16px 0' }}>매매가 쌓이면 국면별 학습 인사이트가 나타나요.</div>
      )}

      {/* 국면×전략 승률 매트릭스 */}
      <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>국면 × 전략 승률</div>
      <div style={{ overflowX: 'auto', marginBottom: 14 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 340 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 6px', color: T.muted, fontSize: 9.5, fontWeight: 700 }}>국면\전략</th>
              {FAMS.map(f => <th key={f.key} style={{ padding: '4px 3px', color: T.muted, fontSize: 9, fontWeight: 700 }}>{f.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {REGIMES.map(reg => (
              <tr key={reg.key}>
                <td style={{ padding: '5px 6px', color: reg.color, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>{reg.label}</td>
                {FAMS.map(f => {
                  const c = cell(reg.key, f.key);
                  if (!c || c.trades === 0) return <td key={f.key} style={{ padding: '5px 3px', textAlign: 'center', color: T.border2, fontSize: 10 }}>·</td>;
                  const wr = c.winRate;
                  const col = wr >= 60 ? T.grn : wr >= 45 ? T.ylw : T.red;
                  return (
                    <td key={f.key} style={{ padding: '4px 3px', textAlign: 'center' }}>
                      <div style={{ background: col + '22', color: col, borderRadius: 5, padding: '3px 2px', fontSize: 9.5, fontWeight: 800 }}>{wr.toFixed(0)}%</div>
                      <div style={{ color: T.muted, fontSize: 7.5, marginTop: 1 }}>{c.trades}회</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button onClick={apply}
        style={{ width: '100%', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: `linear-gradient(135deg,#8B5CF6,#6D28D9)`, color: '#fff', border: 'none', borderRadius: 12, fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>
        {applied ? <><Check size={15} /> 적용됨</> : <><RefreshCw size={15} /> 학습을 Tactical에 반영</>}
      </button>

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 10 }}>
        국면별 전략 승률·손익을 학습해 AI Tactical의 비중을 자동 교정합니다(조정계수 0.5~1.5, 표본 3회 이상). 반영하면 다음 배분부터 적용됩니다.
      </div>
    </div>
  );
}

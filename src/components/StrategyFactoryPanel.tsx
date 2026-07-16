'use client';
// StrategyFactoryPanel — AI 전략 생성기. 개선안 제안 → Shadow Trading 검증 → 승격.
import React, { useState, useMemo } from 'react';
import { T } from '@/lib/constants';
import { FlaskConical, Lightbulb, Play, Check, X, TrendingUp, ArrowRight } from 'lucide-react';
import { diagnoseAndPropose, updateShadow, type StrategyProposal } from '@/lib/autotrade/strategyFactory';
import { notifySuccess, notifyInfo } from '@/lib/notify/center';

// 데모 국면별 성과 (횡보장 Trend 약점 내장 — 실배포 시 learning matrix로 대체)
const DEMO_STATS: any = {
  RANGE: { trend: { trades: 8, wins: 2, winRate: 25, totalPnl: -180000, adjust: 0.68 } },
  TREND_UP: { trend: { trades: 10, wins: 8, winRate: 80, totalPnl: 620000, adjust: 1.45 } },
};

function pnlSeries(n: number, wr: number, seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(((i * 31 + seed) % 100) < wr ? 120000 : -95000);
  return out;
}

export default function StrategyFactoryPanel({ strategies = [] }: { strategies?: { id: string; name: string; type: string; params?: any }[] }) {
  const [proposals, setProposals] = useState<StrategyProposal[]>([]);

  // AI 진단: 약점 있는 전략에 개선안 생성
  const generate = () => {
    const base = strategies.length ? strategies : [{ id: 's1', name: 'BTC EMA 추세 추종', type: 'ema_cross', params: {} }];
    const found: StrategyProposal[] = [];
    for (const s of base) {
      const p = diagnoseAndPropose({ strategyId: s.id, name: s.name, type: s.type, params: s.params || {}, regimeStats: DEMO_STATS });
      if (p && !proposals.some(x => x.baseName === p.baseName)) found.push(p);
    }
    if (found.length) { setProposals(prev => [...found, ...prev]); notifySuccess('AI 개선안 생성', `${found.length}개 전략의 개선안을 제안했어요`); }
    else notifyInfo('개선안 없음', '현재 뚜렷한 약점이 발견되지 않았어요');
  };

  const startShadow = (id: string) => {
    setProposals(prev => prev.map(p => p.id === id ? { ...p, status: 'shadow', shadowDays: 1 } : p));
    notifyInfo('Shadow Trading 시작', '2주간 실시간 병렬 검증을 시작해요 (실주문 없음)');
  };

  // 데모: 검증 완료 시뮬 (실배포 시 실제 섀도우 성과 누적)
  const simulateComplete = (id: string) => {
    setProposals(prev => prev.map(p => {
      if (p.id !== id) return p;
      // 개선안이 원본보다 나은 케이스 (거래량 필터로 승률↑)
      const base = pnlSeries(20, 45, 3);
      const shadow = pnlSeries(20, 63, 7);
      return updateShadow(p, base, shadow, p.shadowTarget);
    }));
  };

  const promote = (id: string) => {
    setProposals(prev => prev.map(p => p.id === id ? { ...p, status: 'promoted' } : p));
    notifySuccess('전략 승격', '검증을 통과한 개선안이 실전에 투입됩니다');
  };

  const statusMeta: Record<string, { label: string; color: string }> = {
    proposed: { label: '제안됨', color: '#0EA5E9' },
    shadow: { label: 'Shadow 검증중', color: '#F59E0B' },
    promoted: { label: '승격됨', color: '#22C55E' },
    rejected: { label: '기각됨', color: '#64748B' },
  };

  return (
    <div style={{ background: 'linear-gradient(145deg,#0D1A35,#091228)', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#06B6D41F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <FlaskConical size={18} color="#22D3EE" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>AI 전략 생성기</div>
          <div style={{ color: T.muted, fontSize: 11 }}>개선안 제안 → Shadow 검증 → 우위일 때만 승격</div>
        </div>
      </div>
      <div style={{ color: T.muted, fontSize: 10, marginBottom: 12, lineHeight: 1.4 }}>AI가 만든 전략도 반드시 2주 실시간 검증을 거쳐야 실전에 투입됩니다.</div>

      <button onClick={generate}
        style={{ width: '100%', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: 'linear-gradient(135deg,#06B6D4,#0891B2)', color: '#fff', border: 'none', borderRadius: 12, fontWeight: 800, fontSize: 13, cursor: 'pointer', marginBottom: 14 }}>
        <Lightbulb size={16} /> AI 개선안 생성
      </button>

      {proposals.length === 0 ? (
        <div style={{ color: T.muted, fontSize: 12, textAlign: 'center', padding: '10px 0' }}>버튼을 눌러 AI에게 전략 개선안을 요청하세요.</div>
      ) : proposals.map(p => {
        const sm = statusMeta[p.status];
        return (
          <div key={p.id} style={{ background: T.card, borderRadius: 13, padding: '13px', marginBottom: 10, border: `1px solid ${sm.color}30` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ color: T.txt, fontSize: 13, fontWeight: 800, flex: 1 }}>{p.title}</span>
              <span style={{ background: sm.color + '20', color: sm.color, fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 6 }}>{sm.label}</span>
            </div>

            {/* AI 가설 */}
            <div style={{ background: T.alt, borderRadius: 9, padding: '10px 12px', marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <Lightbulb size={13} color="#22D3EE" style={{ flexShrink: 0, marginTop: 1 }} />
                <span style={{ color: T.sub, fontSize: 11.5, lineHeight: 1.5 }}>{p.hypothesis}</span>
              </div>
            </div>

            {/* 변경 내용 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, marginBottom: 10 }}>
              <span style={{ color: T.muted }}>{p.change.param}:</span>
              <span style={{ color: T.sub }}>{String(p.change.from)}</span>
              <ArrowRight size={12} color={T.muted} />
              <span style={{ color: T.grn, fontWeight: 700 }}>{String(p.change.to)}</span>
            </div>

            {/* 섀도우 성과 비교 */}
            {p.baseMetrics && p.shadowMetrics && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <div style={{ flex: 1, background: T.alt, borderRadius: 9, padding: '9px 11px' }}>
                  <div style={{ color: T.muted, fontSize: 9.5 }}>기존</div>
                  <div style={{ color: T.sub, fontSize: 14, fontWeight: 800 }}>{p.baseMetrics.score}점</div>
                  <div style={{ color: T.muted, fontSize: 9 }}>승률 {p.baseMetrics.winRate.toFixed(0)}% · PF {p.baseMetrics.profitFactor.toFixed(2)}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}><ArrowRight size={14} color={T.muted} /></div>
                <div style={{ flex: 1, background: '#22C55E14', border: `1px solid ${T.grn}30`, borderRadius: 9, padding: '9px 11px' }}>
                  <div style={{ color: T.muted, fontSize: 9.5 }}>개선안 (Shadow)</div>
                  <div style={{ color: T.grn, fontSize: 14, fontWeight: 800 }}>{p.shadowMetrics.score}점</div>
                  <div style={{ color: T.muted, fontSize: 9 }}>승률 {p.shadowMetrics.winRate.toFixed(0)}% · PF {p.shadowMetrics.profitFactor.toFixed(2)}</div>
                </div>
              </div>
            )}

            {/* 섀도우 진행 바 */}
            {p.status === 'shadow' && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.muted, marginBottom: 4 }}>
                  <span>Shadow Trading 검증</span><span>{p.shadowDays}/{p.shadowTarget}일</span>
                </div>
                <div style={{ height: 6, background: T.alt, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(p.shadowDays / p.shadowTarget) * 100}%`, background: '#F59E0B' }} />
                </div>
              </div>
            )}

            {p.verdict && <div style={{ color: p.status === 'promoted' ? T.grn : p.status === 'rejected' ? T.muted : T.sub, fontSize: 11, marginBottom: 10, fontWeight: 600 }}>{p.verdict}</div>}

            {/* 액션 */}
            <div style={{ display: 'flex', gap: 6 }}>
              {p.status === 'proposed' && (
                <button onClick={() => startShadow(p.id)} style={{ flex: 1, minHeight: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: '#F59E0B', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 800, fontSize: 11.5, cursor: 'pointer' }}>
                  <Play size={13} /> Shadow 검증 시작
                </button>
              )}
              {p.status === 'shadow' && (
                <button onClick={() => simulateComplete(p.id)} style={{ flex: 1, minHeight: 38, background: T.alt, color: T.sub, border: `1px solid ${T.border}`, borderRadius: 9, fontWeight: 700, fontSize: 11.5, cursor: 'pointer' }}>
                  검증 결과 확인 (2주 경과 시뮬)
                </button>
              )}
              {p.status === 'rejected' && p.verdict?.includes('부족') && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, color: T.muted, fontSize: 11.5, padding: '8px' }}>
                  <X size={13} /> 기존 전략 유지
                </div>
              )}
              {(p.status === 'promoted' || (p.shadowMetrics && p.verdict?.includes('승격'))) && p.status !== 'rejected' && (
                <button onClick={() => promote(p.id)} disabled={p.status === 'promoted'} style={{ flex: 1, minHeight: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: p.status === 'promoted' ? T.grn + '30' : T.grn, color: p.status === 'promoted' ? T.grn : '#fff', border: 'none', borderRadius: 9, fontWeight: 800, fontSize: 11.5, cursor: p.status === 'promoted' ? 'default' : 'pointer' }}>
                  {p.status === 'promoted' ? <><Check size={13} /> 승격됨</> : <><TrendingUp size={13} /> 실전 승격</>}
                </button>
              )}
            </div>
          </div>
        );
      })}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 8 }}>
        AI는 개선안을 제안만 하고, Shadow Trading(실주문 없는 병렬 검증)에서 기존보다 우위일 때만 승격됩니다. 검증 없이 실전 투입되지 않습니다.
      </div>
    </div>
  );
}

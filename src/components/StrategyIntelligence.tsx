'use client';
// StrategyIntelligence — 전략 건강도 + 우선순위 충돌 해결 시각화.
import React, { useMemo } from 'react';
import { T } from '@/lib/constants';
import { Activity, AlertTriangle, GitBranch, Power } from 'lucide-react';
import { strategyHealth, resolveConflicts, TYPE_PRIORITY, TYPE_LABEL, type StrategyLike, type Signal } from '@/lib/autotrade/intelligence';

export default function StrategyIntelligence({
  strategies = [], signals = [], onDisable,
}: {
  strategies?: StrategyLike[];
  signals?: Signal[];
  onDisable?: (id: string) => void;
}) {
  const healthList = useMemo(() => strategies.map(s => ({ s, h: strategyHealth(s) })), [strategies]);
  const conflicts = useMemo(() => resolveConflicts(signals), [signals]);
  const dangerCount = healthList.filter(x => x.h.shouldDisable).length;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#8B5CF61F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Activity size={18} color="#A78BFA" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>전략 지능</div>
          <div style={{ color: T.muted, fontSize: 11 }}>건강도 모니터링 · 신호 충돌 자동 해결</div>
        </div>
        {dangerCount > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: T.red + '20', color: T.red, fontSize: 10, fontWeight: 800, padding: '4px 8px', borderRadius: 6 }}>
            <AlertTriangle size={12} /> {dangerCount}
          </span>
        )}
      </div>

      {/* ── 충돌 해결 ── */}
      {conflicts.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>
            <GitBranch size={13} /> 신호 충돌 해결 ({conflicts.length})
          </div>
          {conflicts.map(c => (
            <div key={c.asset} style={{ background: T.alt, borderRadius: 12, padding: '12px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <span style={{ color: T.txt, fontWeight: 800, fontSize: 13 }}>{c.asset}</span>
                <span style={{ color: T.muted, fontSize: 10 }}>{c.signals.length}개 전략 신호 충돌</span>
              </div>
              {/* 신호들 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                {[...c.signals].sort((a, b) => (TYPE_PRIORITY[b.type] || 0) - (TYPE_PRIORITY[a.type] || 0)).map((s, i) => {
                  const isWinner = s.stratId === c.winner.stratId;
                  return (
                    <div key={s.stratId + i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: isWinner ? '#10B98115' : 'transparent', borderRadius: 8, border: isWinner ? `1px solid #10B98140` : `1px solid ${T.border}`, opacity: isWinner ? 1 : 0.55 }}>
                      <span style={{ background: (TYPE_PRIORITY[s.type] || 0) >= 4 ? '#8B5CF6' : T.muted, color: '#fff', fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4 }}>P{TYPE_PRIORITY[s.type] || 0}</span>
                      <span style={{ color: T.txt, fontSize: 11, fontWeight: 600, flex: 1 }}>{TYPE_LABEL[s.type] || s.type}</span>
                      <span style={{ color: s.side === 'buy' ? T.grn : T.red, fontSize: 11, fontWeight: 800 }}>{s.side === 'buy' ? '매수' : '매도'}</span>
                      {isWinner && <span style={{ color: '#10B981', fontSize: 10, fontWeight: 800 }}>✓ 채택</span>}
                    </div>
                  );
                })}
              </div>
              <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5 }}>{c.explanation}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── 건강도 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>
        <Activity size={13} /> 전략 건강도
      </div>
      {healthList.length === 0 && <div style={{ color: T.muted, fontSize: 12, padding: '8px 0' }}>등록된 전략이 없습니다.</div>}
      {healthList.map(({ s, h }) => (
        <div key={s.id} style={{ background: T.alt, borderRadius: 12, padding: '11px 13px', marginBottom: 8, border: h.shouldDisable ? `1px solid ${T.red}40` : `1px solid transparent` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
            <span style={{ color: T.txt, fontSize: 12, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
            <span style={{ background: h.color + '20', color: h.color, fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 5 }}>{h.label} {h.tier !== 'unknown' ? h.score : ''}</span>
          </div>
          {/* 건강도 바 */}
          <div style={{ height: 6, background: T.card, borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
            <div style={{ height: '100%', width: `${h.score}%`, background: h.color, transition: 'width .3s' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: T.muted, fontSize: 9.5, flex: 1 }}>{h.reasons[0]}{h.reasons.length > 1 ? ` · ${h.reasons[1]}` : ''}</span>
            {h.shouldDisable && onDisable && (
              <button onClick={() => onDisable(s.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, background: T.red + '18', color: T.red, border: `1px solid ${T.red}40`, borderRadius: 7, padding: '5px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>
                <Power size={11} /> 자동 정지
              </button>
            )}
          </div>
        </div>
      ))}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 8 }}>
        건강도는 승률·누적손익·표본수로 산출됩니다. 우선순위: 추세추종 &gt; 브레이크아웃/AI &gt; 모멘텀 &gt; 역추세 &gt; 정기적립.
      </div>
    </div>
  );
}

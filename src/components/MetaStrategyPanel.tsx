'use client';
// MetaStrategyPanel — AI가 전략을 자동 교체(OFF/ON)하고 자금을 배분.
import React, { useMemo } from 'react';
import { T } from '@/lib/constants';
import { Shuffle, Power, PlayCircle, Check, PieChart } from 'lucide-react';
import { evaluateMeta, allocateCapital, type MetaInput } from '@/lib/autotrade/metaStrategy';
import { notifySuccess } from '@/lib/notify/center';

const ALLOC_COLORS = ['#F59E0B', '#22C55E', '#0EA5E9', '#8B5CF6', '#EC4899', '#64748B'];

export default function MetaStrategyPanel({
  strategies = [], onApply,
}: {
  strategies?: MetaInput[];
  onApply?: (id: string, enable: boolean) => void;
}) {
  const meta = useMemo(() => evaluateMeta(strategies), [strategies]);
  const allocs = useMemo(() => allocateCapital(meta.decisions), [meta]);
  const switches = meta.decisions.filter(d => d.action !== 'keep');

  const apply = (id: string, name: string, enable: boolean) => {
    onApply?.(id, enable);
    notifySuccess(enable ? '전략 자동 ON' : '전략 자동 OFF', name);
  };

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#8B5CF61F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Shuffle size={18} color="#A78BFA" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>AI Meta Strategy</div>
          <div style={{ color: T.muted, fontSize: 11 }}>성과 떨어지면 OFF, 좋아지면 ON — 자금도 재배분</div>
        </div>
        {switches.length > 0 && (
          <span style={{ background: '#8B5CF622', color: '#A78BFA', fontSize: 10, fontWeight: 800, padding: '4px 8px', borderRadius: 6 }}>{meta.summary}</span>
        )}
      </div>

      {/* 교체 제안 */}
      {switches.length > 0 ? (
        <div style={{ marginBottom: 14 }}>
          {switches.map(d => {
            const off = d.action === 'auto_off';
            const c = off ? T.red : T.grn;
            return (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: c + '10', border: `1px solid ${c}30`, borderRadius: 12, padding: '11px 13px', marginBottom: 8 }}>
                {off ? <Power size={16} color={c} /> : <PlayCircle size={16} color={c} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: T.txt, fontSize: 12.5, fontWeight: 800 }}>{d.name}</div>
                  <div style={{ color: T.muted, fontSize: 10.5, lineHeight: 1.4 }}>{d.reason}</div>
                </div>
                <button onClick={() => apply(d.id, d.name, !off)}
                  style={{ minHeight: 36, background: c, color: '#fff', border: 'none', borderRadius: 9, padding: '8px 14px', fontWeight: 800, fontSize: 11, cursor: 'pointer', flexShrink: 0 }}>
                  {off ? 'OFF 적용' : 'ON 적용'}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: T.grn + '12', borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
          <Check size={15} color={T.grn} />
          <span style={{ color: T.txt, fontSize: 12 }}>{meta.summary}</span>
        </div>
      )}

      {/* 유지 전략 상태 (간단) */}
      {meta.decisions.filter(d => d.action === 'keep').map(d => (
        <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: d.score.gradeColor, flexShrink: 0 }} />
          <span style={{ color: T.sub, fontSize: 11.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
          <span style={{ color: T.muted, fontSize: 10 }}>{d.reason}</span>
        </div>
      ))}

      {/* 전략 포트폴리오 (자금 배분) */}
      {allocs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>
            <PieChart size={13} /> 오늘의 자금 배분 (전략 포트폴리오)
          </div>
          {/* 스택 바 */}
          <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', marginBottom: 10 }}>
            {allocs.map((a, i) => (
              <div key={a.id} style={{ width: `${a.weightPct}%`, background: ALLOC_COLORS[i % ALLOC_COLORS.length] }} />
            ))}
          </div>
          {allocs.map((a, i) => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: ALLOC_COLORS[i % ALLOC_COLORS.length], flexShrink: 0 }} />
              <span style={{ color: T.txt, fontSize: 12, fontWeight: 600, flex: 1 }}>{a.name}</span>
              <span style={{ color: T.muted, fontSize: 10 }}>{a.score}점</span>
              <span style={{ color: T.txt, fontSize: 13, fontWeight: 900, width: 44, textAlign: 'right' }}>{a.weightPct}%</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 12 }}>
        기준: 최근 승률 42% 미만 또는 점수 40 미만 → OFF · 점수 65+ &amp; 최근 승률 55%+ → ON. 배분은 점수 비례(5~60% 캡). 표본 부족 전략은 자동 전환하지 않습니다.
      </div>
    </div>
  );
}

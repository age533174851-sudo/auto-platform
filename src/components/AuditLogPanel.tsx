'use client';
// AuditLogPanel — AI 판단 감사 로그. 모든 결정을 이유·신뢰도와 함께 추적.
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { cvt } from '@/lib/utils';
import { ScrollText, Trash2, ChevronDown, ChevronUp, Check, X } from 'lucide-react';
import { loadAudit, clearAudit, subscribeAudit, type AuditEntry } from '@/lib/autotrade/auditLog';
import { confirmDialog } from '@/lib/confirm/dialog';

const ACTION_COLOR: Record<string, string> = {
  enter_long: '#22C55E', enter_short: '#EF4444', exit_tp: '#10B981',
  exit_sl: '#EF4444', hold: '#64748B', wait: '#64748B', exit: '#F59E0B',
};

const FILTERS = [
  { id: 'all', label: '전체' },
  { id: 'executed', label: '실행됨' },
  { id: 'enter', label: '진입' },
  { id: 'exit', label: '청산' },
  { id: 'wait', label: '대기' },
];

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export default function AuditLogPanel({ currency = 'KRW' }: { currency?: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => { setEntries(loadAudit()); return subscribeAudit(() => setEntries(loadAudit())); }, []);

  const filtered = useMemo(() => entries.filter(e => {
    if (filter === 'all') return true;
    if (filter === 'executed') return e.executed;
    if (filter === 'enter') return e.action.startsWith('enter');
    if (filter === 'exit') return e.action.startsWith('exit');
    if (filter === 'wait') return e.action === 'wait' || e.action === 'hold';
    return true;
  }), [entries, filter]);

  const executedCount = entries.filter(e => e.executed).length;

  const onClear = async () => {
    if (await confirmDialog('AI 감사 로그를 모두 삭제할까요?', { danger: true })) { clearAudit(); setEntries([]); }
  };

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#0EA5E91F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ScrollText size={18} color="#0EA5E9" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>AI 판단 감사 로그</div>
          <div style={{ color: T.muted, fontSize: 11 }}>전체 {entries.length}건 · 실행 {executedCount}건 · 100% 추적</div>
        </div>
        {entries.length > 0 && (
          <button onClick={onClear} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, display: 'flex' }}>
            <Trash2 size={15} color={T.muted} />
          </button>
        )}
      </div>

      {/* 필터 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto' }}>
        {FILTERS.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            style={{ background: filter === f.id ? '#0EA5E9' : T.alt, color: filter === f.id ? '#fff' : T.muted, border: 'none', borderRadius: 7, padding: '6px 12px', fontWeight: 700, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{ color: T.muted, fontSize: 12, textAlign: 'center', padding: '24px 0', lineHeight: 1.6 }}>
          {entries.length === 0 ? <>아직 AI 판단 기록이 없어요.<br />모의매매에서 자동매매를 시작하면 모든 판단이 기록돼요.</> : '이 필터에 해당하는 기록이 없어요.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.slice(0, 60).map(e => {
            const color = ACTION_COLOR[e.action] || T.muted;
            const open = expanded === e.id;
            return (
              <div key={e.id} style={{ background: T.alt, borderRadius: 10, border: `1px solid ${e.executed ? color + '40' : T.border}`, overflow: 'hidden' }}>
                <button onClick={() => setExpanded(open ? null : e.id)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                  <span style={{ background: color + '22', color, fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 5, flexShrink: 0, minWidth: 56, textAlign: 'center' }}>{e.actionLabel}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: T.txt, fontSize: 11.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.summary}</div>
                    <div style={{ color: T.muted, fontSize: 9.5, marginTop: 1 }}>{fmtTime(e.ts)} · {e.marketState} · 신뢰도 {e.confidence}%{e.executed ? ' · 실행됨' : ''}</div>
                  </div>
                  {open ? <ChevronUp size={15} color={T.muted} /> : <ChevronDown size={15} color={T.muted} />}
                </button>
                {open && (
                  <div style={{ padding: '0 12px 12px', borderTop: `1px solid ${T.border}` }}>
                    <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
                      <Stat label="신뢰도" val={`${e.confidence}%`} />
                      <Stat label="시장상태" val={e.marketState} />
                      {e.price ? <Stat label="가격" val={cvt(e.price, currency)} /> : null}
                    </div>
                    {e.reasons.length > 0 && (
                      <div>
                        <div style={{ color: T.muted, fontSize: 10, fontWeight: 700, marginBottom: 6 }}>판단 근거</div>
                        {e.reasons.map((r, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0' }}>
                            {r.met ? <Check size={13} color={T.grn} /> : <X size={13} color={T.muted} />}
                            <span style={{ color: r.met ? T.sub : T.muted, fontSize: 11, flex: 1 }}>{r.label}</span>
                            <span style={{ color: T.muted, fontSize: 10 }}>{r.value}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 10 }}>
        모든 AI 판단이 이유·신뢰도와 함께 기록됩니다. 최근 200건 보관 · 이 기기에만 저장(localStorage).
      </div>
    </div>
  );
}

function Stat({ label, val }: { label: string; val: string }) {
  return (
    <div style={{ flex: 1, background: T.card, borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ color: T.muted, fontSize: 9 }}>{label}</div>
      <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{val}</div>
    </div>
  );
}

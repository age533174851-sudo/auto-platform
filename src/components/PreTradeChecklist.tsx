'use client';
//
// 거래 전 점검 목록.
//
// 이 화면이 지켜야 하는 것: **확인하지 못한 항목이 통과처럼 보이지 않게.**
//
// 그래서 네 상태를 색이 아니라 **모양**으로도 구분한다. 색만 다르면 빠르게
// 훑을 때 안 보이고, 색맹인 사용자에게는 아예 구분이 없다. 이 프로젝트의
// dataQuality가 같은 이유로 모양을 쓴다 — 같은 규칙을 따른다.
//
//   ✓ 확인·문제없음   ✕ 확인·문제있음   ! 알아둘 것   ? 확인 못 함
//
// '?'가 이 화면의 존재 이유다. 거래소 조회가 실패해서 마진 모드를 못 읽었는데
// 초록 체크가 뜨면, 사용자는 점검이 끝났다고 믿고 주문을 넣는다.
import React from 'react';
import type { ChecklistVerdict, CheckStatus } from '@/lib/engine/preTradeChecklist';

const MARK: Record<CheckStatus, { glyph: string; color: string; label: string }> = {
  pass:    { glyph: '✓', color: '#22C55E', label: '확인' },
  fail:    { glyph: '✕', color: '#EF4444', label: '문제' },
  warn:    { glyph: '!', color: '#F59E0B', label: '알아둘 것' },
  // 회색이다. 확인 못 한 것을 주의(노랑)로 그리면 '문제가 있다'로 읽히고,
  // 초록으로 그리면 '괜찮다'로 읽힌다. 둘 다 아니라 '모른다'다.
  unknown: { glyph: '?', color: '#94A3B8', label: '확인 못 함' },
};

export interface PreTradeChecklistProps {
  verdict: ChecklistVerdict | null;
  /** 점검 중 */
  loading?: boolean;
  /** 다시 점검 */
  onRecheck?: () => void;
  /** 점검을 통과했을 때만 눌리는 주문 버튼 */
  onConfirm?: () => void;
  confirmLabel?: string;
  compact?: boolean;
}

export default function PreTradeChecklist({
  verdict, loading, onRecheck, onConfirm, confirmLabel = '주문 보내기', compact,
}: PreTradeChecklistProps) {
  if (loading) {
    return (
      <div style={{ padding: 16, color: 'var(--t-muted)', fontSize: 12, fontFamily: "'Sora',sans-serif" }}>
        점검 중…
      </div>
    );
  }

  if (!verdict) {
    // 점검을 아직 안 돌린 것과 통과한 것은 완전히 다르다. 빈 상태에서
    // 주문 버튼이 눌리면 체크리스트가 있는 의미가 없다.
    return (
      <div style={{
        padding: 14, borderRadius: 12, border: '1px solid var(--t-border)',
        background: 'var(--t-card)', fontFamily: "'Sora',sans-serif",
      }}>
        <div style={{ color: 'var(--t-txt)', fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>
          점검하지 않았습니다
        </div>
        <div style={{ color: 'var(--t-muted)', fontSize: 11, lineHeight: 1.6, marginBottom: 10 }}>
          주문 전 점검을 실행해야 합니다. 점검하지 않은 상태는 통과가 아닙니다.
        </div>
        {onRecheck && (
          <button onClick={onRecheck} style={btnStyle('#3B82F6')}>점검 실행</button>
        )}
      </div>
    );
  }

  const blocked = !verdict.allowed;

  return (
    <div style={{
      borderRadius: 12, border: `1px solid ${blocked ? '#EF444455' : 'var(--t-border)'}`,
      background: 'var(--t-card)', overflow: 'hidden', fontFamily: "'Sora',sans-serif",
    }}>
      {/* 요약 */}
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid var(--t-border)',
        background: blocked ? 'rgba(239,68,68,.10)' : 'transparent',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 13 }}>{blocked ? '🚫' : verdict.unknownCount > 0 ? '⚠️' : '✅'}</span>
        <span style={{
          flex: 1, fontSize: 12, fontWeight: 700,
          color: blocked ? '#EF4444' : 'var(--t-txt)',
        }}>
          {verdict.summary}
        </span>
        {onRecheck && (
          <button onClick={onRecheck} style={{
            background: 'none', border: '1px solid var(--t-border)', borderRadius: 6,
            color: 'var(--t-muted)', fontSize: 10, fontWeight: 700, padding: '3px 7px', cursor: 'pointer',
          }}>다시 점검</button>
        )}
      </div>

      {/* 항목 */}
      <div>
        {verdict.results.map(r => {
          const m = MARK[r.status];
          return (
            <div key={r.id} style={{
              display: 'flex', gap: 9, padding: compact ? '6px 14px' : '9px 14px',
              borderBottom: '1px solid var(--t-border)', alignItems: 'flex-start',
            }}>
              <span
                aria-label={m.label}
                title={m.label}
                style={{
                  color: m.color, fontWeight: 900, fontSize: 12,
                  width: 14, textAlign: 'center', flexShrink: 0, lineHeight: 1.5,
                }}>
                {m.glyph}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 11.5, fontWeight: 700,
                  color: r.blocks ? '#EF4444' : 'var(--t-txt)',
                }}>
                  {r.label}
                  {r.blocks && (
                    <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 800, color: '#EF4444' }}>
                      주문 차단
                    </span>
                  )}
                </div>
                {!compact && (
                  <div style={{ fontSize: 10.5, color: 'var(--t-muted)', marginTop: 2, lineHeight: 1.5 }}>
                    {r.detail}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 주문 버튼 */}
      {onConfirm && (
        <div style={{ padding: 12 }}>
          <button
            onClick={blocked ? undefined : onConfirm}
            disabled={blocked}
            style={{
              ...btnStyle(blocked ? '#64748B' : '#22C55E'),
              width: '100%',
              // 주문 버튼은 작게 만들지 않는다 — 터미널 규칙과 같다(최소 46px)
              minHeight: 46,
              cursor: blocked ? 'not-allowed' : 'pointer',
              opacity: blocked ? .55 : 1,
            }}>
            {blocked ? '점검을 통과하지 못했습니다' : confirmLabel}
          </button>
          {blocked && (
            // 왜 못 누르는지 버튼 아래에 그대로 적는다. 회색 버튼만 두면
            // 사용자는 화면이 고장 났다고 생각한다.
            <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--t-muted)', lineHeight: 1.6 }}>
              {verdict.blockers.map(b => (
                <div key={b.id}>· {b.detail}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function btnStyle(color: string): React.CSSProperties {
  return {
    background: color, color: '#fff', border: 'none', borderRadius: 10,
    padding: '10px 14px', fontSize: 12.5, fontWeight: 800, cursor: 'pointer',
  };
}

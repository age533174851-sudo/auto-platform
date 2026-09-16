'use client';
// src/components/trading/PaperChallengePanel.tsx
//
// **챌린지를 만들고 · 보고 · 그만두는 화면. 돈은 여기서 움직이지 않는다.**
//
// 무엇이 없었나
// ─────────────
// `083`이 표를, `085`가 회계를, `086`이 만료·마감을, `087`이 취소를 만들었다.
// 그런데 사용자가 챌린지를 **시작하거나 그만둘 화면이 없었다.** 만들어 놓고
// 배선을 안 한 그대로다.
//
// 이 화면이 하지 않는 것
// ──────────────────────
//  · 잔고를 고치지 않는다
//  · 포지션을 청산하지 않는다
//  · 사건 시각을 만들지 않는다 (서버가 만든다)
//  · 계좌 id를 받지도 보내지도 않는다 — `challengeId` 하나만 오간다
//
// 취소는 `087`의 `paper_challenge_cancel`을 부르는 것이 전부다. 사유를
// `CANCELLED`로 얼리고 `CLOSING`으로 밀면, 남은 포지션 정리와 마감은 워커의
// 스윕이 이어받는다. 화면이 직접 정산하면 정산 경로가 둘이 된다.
//
// 끝난 이유를 다시 판단하지 않는다
// ────────────────────────────────
// 목표에 닿는 순간 사유가 얼어붙는다. 그 뒤 강제청산 손실로 최종 잔고가
// 목표 아래로 내려가도 **달성은 달성이다.** 색과 문구는
// `lib/trading/challengeDisplay`가 정하고, 그 함수는 잔고를 받지 않는다.
import React, { useCallback, useEffect, useState } from 'react';
import { watchAuthToken } from '@/lib/auth/authToken';
import { notify } from '@/lib/notify/center';
import { errorTextOf } from '@/lib/http/errorText';
import {
  challengeStatusView, challengeProgressPct, challengeDaysLeft,
} from '@/lib/trading/challengeDisplay';
import { selectChallenge, selectDefault, type PaperTarget } from '@/lib/trading/paperTarget';
import {
  MIN_DURATION_DAYS, MAX_DURATION_DAYS, parseChallengeCreate, challengeCreateRejected,
} from '@/lib/engine/paperChallengeApi';

const TONE_COLOR: Record<string, string> = {
  RUNNING: '#3B82F6', WIN: '#10B981', LOSS: '#EF4444',
  NEUTRAL: 'var(--t-muted)', UNKNOWN: '#F59E0B',
};

interface ChallengeRow {
  id: string; status: string; closeIntent: string | null; terminalStatus: string | null;
  initialEquity: number; targetEquity: number; failureEquity: number | null;
  startsAt: string | null; endsAt: string | null; closedAt: string | null;
  balance: number | null; returnPct: number | null; ordersAllowed: boolean;
}

export function PaperChallengePanel({ selected, onSelect }: {
  /** 지금 고른 장부. 챌린지면 그 줄이 강조된다 */
  selected?: PaperTarget;
  /** 장부를 바꾼다. 없으면 선택 버튼을 그리지 않는다 */
  onSelect?: (t: PaperTarget) => void;
}) {
  const [auth, setAuth] = useState<string | null>(null);
  useEffect(() => watchAuthToken(setAuth), []);

  const [rows, setRows] = useState<ChallengeRow[] | null>(null);
  // **못 읽은 것과 없는 것을 구별한다.** 빈 배열을 "챌린지 없음"으로 적으면
  // 조회 실패가 사실로 둔갑한다.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openForm, setOpenForm] = useState(false);

  const [initial, setInitial] = useState('10000');
  const [target, setTarget] = useState('12000');
  const [failure, setFailure] = useState('8000');
  const [days, setDays] = useState('30');

  const load = useCallback(async () => {
    if (!auth) return;
    try {
      const r = await fetch('/api/paper/challenge', { headers: { Authorization: auth } });
      const j = await r.json().catch(() => null);
      if (j?.ok && Array.isArray(j.challenges)) { setRows(j.challenges); setLoadError(null); }
      else { setRows(null); setLoadError(errorTextOf(j, '챌린지를 조회하지 못했습니다')); }
    } catch (e: any) {
      setRows(null);
      setLoadError(`챌린지를 조회하지 못했습니다 — ${String(e?.message || e).slice(0, 120)}`);
    }
  }, [auth]);

  useEffect(() => { load(); }, [load]);

  const create = useCallback(async () => {
    if (!auth || busy) return;
    // **서버가 거부할 값을 미리 거른다.** 같은 규칙을 순수 함수 한 곳에서
    // 읽으므로 화면과 서버가 갈리지 않는다.
    const parsed = parseChallengeCreate({
      initialEquity: initial, targetEquity: target,
      failureEquity: failure, durationDays: Number(days),
    });
    if (challengeCreateRejected(parsed)) {
      notify('error', '챌린지를 만들지 않았습니다', parsed.reason);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/paper/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        // **시작·종료 시각을 보내지 않는다.** 기간의 길이만 보낸다.
        body: JSON.stringify(parsed.params),
      });
      const j = await r.json().catch(() => null);
      if (j?.ok) {
        notify(j.created ? 'info' : 'error', j.created ? '챌린지 시작' : '이미 진행 중', String(j.message ?? ''));
        setOpenForm(false);
        const t = selectChallenge(j.challengeId);
        if (t && onSelect) onSelect(t);
        await load();
      } else {
        notify('error', '챌린지를 만들지 못했습니다', errorTextOf(j, '알 수 없는 오류'));
      }
    } catch (e: any) {
      notify('error', '챌린지를 만들지 못했습니다', String(e?.message || e).slice(0, 160));
    } finally { setBusy(false); }
  }, [auth, busy, initial, target, failure, days, onSelect, load]);

  const cancel = useCallback(async (id: string) => {
    if (!auth || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/paper/challenge/${encodeURIComponent(id)}/cancel`, {
        method: 'POST', headers: { Authorization: auth },
      });
      const j = await r.json().catch(() => null);
      // **`ok:false`를 성공으로 적지 않는다.** 목표 달성·만료가 먼저
      // 정해졌으면 취소되지 않았고, 그 사실을 그대로 보여 준다.
      notify(j?.ok ? 'info' : 'error',
        j?.ok ? '챌린지 취소' : '취소하지 않았습니다',
        String(j?.message ?? '결과를 읽지 못했습니다'));
      // 고른 장부가 방금 닫혔으면 기본 계좌로 돌린다 — **주문 경로의
      // 폴백이 아니라**, 사용자가 방금 스스로 그만둔 것에 대한 화면 반응이다.
      if (j?.ok && onSelect && selected?.kind === 'CHALLENGE' && selected.challengeId === id) {
        onSelect(selectDefault());
      }
      await load();
    } catch (e: any) {
      notify('error', '취소하지 못했습니다', String(e?.message || e).slice(0, 160));
    } finally { setBusy(false); }
  }, [auth, busy, onSelect, selected, load]);

  if (!auth) {
    return <Box><Dim>로그인하면 챌린지를 만들 수 있습니다</Dim></Box>;
  }

  return (
    <Box>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t-txt)' }}>모의 챌린지</div>
        <button onClick={() => setOpenForm(v => !v)} disabled={busy} style={btn(openForm)}>
          {openForm ? '닫기' : '새 챌린지'}
        </button>
      </div>

      {openForm && (
        <div style={{
          border: '1px solid var(--t-border)', borderRadius: 10, padding: 12, marginBottom: 12,
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <Field label="시작 자본 (USDT)" value={initial} onChange={setInitial}/>
          <Field label="목표 자본 (USDT)" value={target} onChange={setTarget}/>
          <Field label="실패 기준 (USDT · 비우면 없음)" value={failure} onChange={setFailure}/>
          <Field label={`기간 (${MIN_DURATION_DAYS}~${MAX_DURATION_DAYS}일)`} value={days} onChange={setDays}/>
          {/* 시작 시각을 받지 않는 이유를 화면에도 적는다 */}
          <Dim>시작은 지금입니다. 기간의 시작·종료 시각은 서버가 정합니다.</Dim>
          <button onClick={create} disabled={busy} style={{ ...btn(true), marginTop: 2 }}>
            {busy ? '만드는 중…' : '챌린지 시작'}
          </button>
        </div>
      )}

      {loadError && <Warn>{loadError} — 챌린지가 없다는 뜻이 아닙니다</Warn>}

      {rows == null && !loadError && <Dim>불러오는 중…</Dim>}
      {rows != null && rows.length === 0 && <Dim>아직 챌린지가 없습니다</Dim>}

      {(rows ?? []).map(c => {
        const v = challengeStatusView(c);
        const pct = challengeProgressPct(c);
        const left = challengeDaysLeft(c.endsAt);
        const isSel = selected?.kind === 'CHALLENGE' && selected.challengeId === c.id;
        const cancellable = c.status === 'READY' || c.status === 'RUNNING';
        return (
          <div key={c.id} style={{
            border: `1px solid ${isSel ? TONE_COLOR.RUNNING : 'var(--t-border)'}`,
            borderRadius: 10, padding: 10, marginBottom: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: TONE_COLOR[v.tone] ?? TONE_COLOR.UNKNOWN }}>
                {v.label}
              </span>
              {v.intentLabel && (
                <span style={{ fontSize: 10, color: TONE_COLOR[v.tone] ?? TONE_COLOR.UNKNOWN }}>
                  · {v.intentLabel}
                </span>
              )}
              <span style={{ flex: 1 }}/>
              {/* 잔고를 못 읽으면 0이 아니라 '—'다 */}
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-txt)' }}>
                {c.balance == null ? '—' : `${c.balance.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT`}
              </span>
            </div>

            <div style={{ fontSize: 10, color: 'var(--t-muted)', marginTop: 4 }}>{v.detail}</div>

            <div style={{ fontSize: 10, color: 'var(--t-muted)', marginTop: 4 }}>
              시작 {c.initialEquity} → 목표 {c.targetEquity}
              {c.failureEquity != null ? ` · 실패선 ${c.failureEquity}` : ' · 실패선 없음'}
              {left != null ? ` · ${left}일 남음` : ''}
            </div>

            {pct != null && (
              <div style={{ height: 3, background: 'var(--t-border)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: TONE_COLOR.RUNNING }}/>
              </div>
            )}

            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              {onSelect && v.ordersAllowed && !isSel && (
                <button onClick={() => { const t = selectChallenge(c.id); if (t) onSelect(t); }}
                  style={btn(false)}>이 챌린지로 거래</button>
              )}
              {onSelect && isSel && (
                <button onClick={() => onSelect(selectDefault())} style={btn(false)}>
                  기본 계좌로 돌아가기
                </button>
              )}
              {cancellable && (
                <button onClick={() => cancel(c.id)} disabled={busy} style={btn(false, true)}>
                  그만두기
                </button>
              )}
            </div>
          </div>
        );
      })}
    </Box>
  );
}

// ── 작은 조각들 ──
const Box = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    border: '1px solid var(--t-border)', borderRadius: 12,
    padding: 12, background: 'var(--t-card)',
  }}>{children}</div>
);
const Dim = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 10, color: 'var(--t-muted)', lineHeight: 1.6 }}>{children}</div>
);
const Warn = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    fontSize: 10, color: '#F59E0B', border: '1px solid rgba(245,158,11,0.35)',
    background: 'rgba(245,158,11,0.08)', borderRadius: 8, padding: '8px 10px', marginBottom: 8,
  }}>{children}</div>
);
function Field({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10, color: 'var(--t-muted)' }}>{label}</span>
      <input value={value} onChange={e => onChange(e.target.value)} inputMode="decimal"
        style={{
          padding: '7px 9px', borderRadius: 8, border: '1px solid var(--t-border)',
          background: 'var(--t-bg)', color: 'var(--t-txt)', fontSize: 12,
        }}/>
    </label>
  );
}
function btn(active: boolean, danger = false): React.CSSProperties {
  return {
    padding: '6px 11px', borderRadius: 8, fontSize: 10, fontWeight: 700, cursor: 'pointer',
    border: `1px solid ${danger ? 'rgba(239,68,68,0.45)' : 'var(--t-border)'}`,
    background: active ? 'rgba(59,130,246,0.15)' : 'transparent',
    color: danger ? '#EF4444' : active ? '#3B82F6' : 'var(--t-txt)',
  };
}

export default PaperChallengePanel;

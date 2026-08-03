'use client';
// src/components/terminal/CombinedPanel.tsx
//
// 현물+선물 결합 전략.
//
// 이 화면이 맨 위에 두는 것
// ─────────────────────────
// **지금 헤지가 살아 있는가.** 전략 목록보다 먼저다. 사용자는 걸어둔 것을
// 기억하지, 깨진 것은 모른다. 반쪽 실행·강제 청산·수동 매도로 한쪽이
// 사라지면 헤지된 줄 알고 전액 노출 상태로 지낸다.
//
// 그다음이 순노출과 펀딩 비용이다. 헤지는 공짜가 아니다 — 몇 달 유지하면
// 펀딩이 피하려던 하락폭보다 클 수 있다.
import React, { memo, useCallback, useEffect, useState } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { C, FS, NUM, chip, ghostBtn, fmtPrice, pnlColor } from './theme';
import { useTerminal } from './TerminalContext';

interface Leg {
  market: string; side: 'BUY' | 'SELL'; qty: number;
  leverage?: number; order: number; ifThisFails: string; label: string;
}
interface Plan {
  id: string; label: string; ok: boolean; reason: string;
  legs: Leg[]; warnings: string[]; targetNetExposure: number;
}
interface Data {
  symbol: string; price: number | null;
  spotQty: number | null; spotAvgPrice: number | null;
  futuresQty: number | null; futuresPnlUsd: number | null;
  futuresMarginUsd: number | null;
  fundingPct: number | null; overheatScore: number | null;
  positionsReadable: boolean;
  netExposure: number | null;
  hedgeHealth: { status: string; message: string; netExposure: number; drift: number };
  fundingCost30d: { totalUsd: number; note: string; receiving: boolean } | null;
  plans: Plan[];
  note: string;
}

const HEALTH_TONE: Record<string, string> = {
  INTACT: C.up, DRIFTED: C.warn, BROKEN: C.down, UNKNOWN: C.warn,
};
const HEALTH_LABEL: Record<string, string> = {
  INTACT: '헤지 유지 중', DRIFTED: '헤지 어긋남', BROKEN: '헤지 깨짐', UNKNOWN: '확인 불가',
};

export const CombinedPanel = memo(function CombinedPanel() {
  const { symbol, auth, connId } = useTerminal();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [exposure, setExposure] = useState('0');

  const load = useCallback(async () => {
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    setBusy(true);
    try {
      const q = new URLSearchParams({ symbol: symbol.id, exposure: exposure || '0' });
      if (connId) q.set('connectionId', connId);
      const r = await fetch(`/api/strategies/combined?${q}`, { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setErr(errorTextOf(j, `평가 실패 (${r.status})`)); return; }
      setErr(''); setD(j);
    } catch (e: any) { setErr(`평가 실패 (${e?.message || e})`); }
    finally { setBusy(false); }
  }, [auth, connId, symbol.id, exposure]);

  useEffect(() => { load(); }, [load]);

  if (err) {
    return (
      <div style={{ padding: 14 }}>
        <div style={{
          padding: '10px 12px', borderRadius: 8, background: C.warnBg,
          color: C.warn, fontSize: FS.small, lineHeight: 1.55,
        }}>{err}</div>
      </div>
    );
  }
  if (!d) {
    return <div style={{ padding: 24, textAlign: 'center', color: C.faint, fontSize: FS.small }}>
      결합 전략을 평가하는 중
    </div>;
  }

  const tone = HEALTH_TONE[d.hedgeHealth.status] ?? C.dim;
  const acting = d.plans.filter(p => p.ok);

  return (
    <div style={{ padding: 14, maxWidth: 760 }}>
      {/* ── 헤지가 살아 있는가 — 전략 목록보다 먼저 ── */}
      <div style={{
        padding: '11px 13px', borderRadius: 9, marginBottom: 10,
        background: d.hedgeHealth.status === 'INTACT' ? C.raised : C.warnBg,
        borderLeft: `2px solid ${tone}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ color: tone, fontSize: FS.small, fontWeight: 700 }}>
            {HEALTH_LABEL[d.hedgeHealth.status] ?? d.hedgeHealth.status}
          </span>
          <span style={{ ...NUM, color: C.dim, fontSize: FS.micro }}>
            순노출 {d.netExposure == null ? '확인 불가' : `${d.netExposure >= 0 ? '+' : ''}${fmtPrice(d.netExposure, 6)}`}
          </span>
        </div>
        <div style={{ color: C.dim, fontSize: FS.micro, lineHeight: 1.55 }}>
          {d.hedgeHealth.message}
        </div>
      </div>

      {/* ── 현재 상태 ── */}
      <div style={{
        display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10,
        padding: '9px 12px', background: C.raised, borderRadius: 8, fontSize: FS.micro,
      }}>
        <KV k="현물" v={d.spotQty == null ? '확인 불가' : fmtPrice(d.spotQty, 6)} warn={d.spotQty == null}/>
        <KV k="선물"
            v={d.futuresQty == null ? '확인 불가'
              : d.futuresQty === 0 ? '없음'
              : `${d.futuresQty > 0 ? 'LONG' : 'SHORT'} ${fmtPrice(Math.abs(d.futuresQty), 6)}`}
            warn={d.futuresQty == null}
            color={d.futuresQty ? pnlColor(d.futuresQty) : undefined}/>
        <KV k="펀딩" v={d.fundingPct == null ? '—' : `${d.fundingPct >= 0 ? '+' : ''}${d.fundingPct.toFixed(4)}%`}/>
        <KV k="과열(RSI)" v={d.overheatScore == null ? '—' : d.overheatScore.toFixed(1)}/>
        <KV k="선물 증거금"
            v={d.futuresMarginUsd == null ? '확인 불가' : `$${fmtPrice(d.futuresMarginUsd)}`}
            warn={d.futuresMarginUsd == null}/>
      </div>

      {/* ── 헤지 비용 ── 공짜가 아니라는 것을 숫자로 ── */}
      {d.fundingCost30d && (
        <div style={{
          padding: '9px 12px', borderRadius: 8, marginBottom: 10,
          background: d.fundingCost30d.receiving ? C.upBg : C.warnBg,
          color: d.fundingCost30d.receiving ? C.up : C.warn,
          fontSize: FS.micro, lineHeight: 1.55,
        }}>
          30일 헤지 유지 시 — {d.fundingCost30d.note}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ color: C.faint, fontSize: FS.micro }}>목표 노출 비율</span>
        {(['0', '0.5', '1'] as const).map(v => (
          <button key={v} onClick={() => setExposure(v)} style={ghostBtn(exposure === v)}>
            {v === '0' ? '완전 헤지' : v === '0.5' ? '절반' : '노출 유지'}
          </button>
        ))}
        <div style={{ flex: 1 }}/>
        <button onClick={load} disabled={busy} style={ghostBtn()}>
          {busy ? '평가 중…' : '다시 평가'}
        </button>
      </div>

      {acting.length === 0 && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, background: C.raised,
          color: C.dim, fontSize: FS.small, marginBottom: 8,
        }}>
          지금 실행할 결합 전략이 없습니다 — 6개 모두 대기 중입니다.
        </div>
      )}

      {d.plans.map(p => (
        <div key={p.id} style={{
          padding: '10px 12px', marginBottom: 5, borderRadius: 9,
          background: p.ok ? C.raised : 'transparent',
          borderLeft: `2px solid ${p.ok ? C.accent : 'transparent'}`,
          opacity: p.ok ? 1 : 0.6,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span style={{ color: C.text, fontSize: FS.small, fontWeight: 600 }}>{p.label}</span>
            <span style={p.ok ? chip(C.accent, C.accentBg) : chip(C.faint)}>
              {p.ok ? '실행 가능' : '대기'}
            </span>
            {p.ok && (
              <span style={{ ...NUM, color: C.faint, fontSize: FS.micro }}>
                목표 순노출 {fmtPrice(p.targetNetExposure, 6)}
              </span>
            )}
          </div>
          <div style={{ color: C.dim, fontSize: FS.micro, lineHeight: 1.55 }}>{p.reason}</div>

          {/* 다리 — 순서와 실패 시 상태를 함께 */}
          {p.legs.map((l, i) => (
            <div key={i} style={{
              marginTop: 6, padding: '8px 10px', borderRadius: 7,
              background: C.panel, border: `1px solid ${C.hair}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={chip(C.dim)}>{l.order}단계</span>
                <span style={chip(l.market === 'SPOT' ? C.dim : C.accent)}>
                  {l.market === 'SPOT' ? '현물' : 'USDT-M'}
                </span>
                <span style={{
                  ...NUM, color: l.side === 'BUY' ? C.up : C.down,
                  fontSize: FS.small, fontWeight: 700,
                }}>{l.label}</span>
                {l.leverage && (
                  <span style={{ ...NUM, color: C.faint, fontSize: FS.micro }}>{l.leverage}×</span>
                )}
              </div>
              {/* 이 줄이 이 화면의 핵심이다 */}
              <div style={{ color: C.warn, fontSize: FS.micro, marginTop: 4, lineHeight: 1.5 }}>
                실패 시: {l.ifThisFails}
              </div>
            </div>
          ))}

          {p.warnings.map((w, i) => (
            <div key={i} style={{
              marginTop: 5, padding: '7px 10px', borderRadius: 7,
              background: C.warnBg, color: C.warn, fontSize: FS.micro, lineHeight: 1.5,
            }}>{w}</div>
          ))}
        </div>
      ))}

      <div style={{
        marginTop: 10, padding: '9px 11px', borderRadius: 8,
        background: C.raised, color: C.dim, fontSize: FS.micro, lineHeight: 1.6,
      }}>
        {d.note} 다리가 두 시장에 걸쳐 있어 원자적으로 묶을 수 없습니다 —
        한쪽만 체결되면 위 &lsquo;실패 시&rsquo; 상태가 됩니다.
      </div>
    </div>
  );
});

function KV({ k, v, color, warn }: { k: string; v: string; color?: string; warn?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', gap: 5, alignItems: 'baseline' }}>
      <span style={{ color: C.faint }}>{k}</span>
      <span style={{ ...NUM, color: color ?? (warn ? C.warn : C.text), fontWeight: 600 }}>{v}</span>
    </span>
  );
}

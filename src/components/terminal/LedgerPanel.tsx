'use client';
// src/components/terminal/LedgerPanel.tsx
//
// 전략별 장부.
//
// 화면에서 가장 중요한 줄
// ───────────────────────
// '미귀속' 수량이다. 거래소에는 있는데 어느 전략의 것도 아닌 물량은
// 수동 주문이나 강제 청산이 있었다는 뜻이고, 그 상태에서 전략을 돌리면
// 전략이 자기 것이 아닌 물량을 자기 것처럼 다룬다.
//
// 그래서 미귀속을 작게 각주로 두지 않고 종목 줄에 바로 붙인다.
import React, { memo, useCallback, useEffect, useState } from 'react';
import { C, FS, NUM, tabStyle, chip, fmtPrice, pnlColor } from './theme';
import { useTerminal } from './TerminalContext';
import type { StrategyHolding, AttributionResult, Conflict } from '@/lib/strategies/ledger';

interface LedgerData {
  holdings: StrategyHolding[];
  strategies: string[];
  attribution: AttributionResult[];
  conflicts: Conflict[];
  exchangeReadable: boolean;
  unownedCount: number;
  note: string;
}

export const LedgerPanel = memo(function LedgerPanel() {
  const { auth, connId } = useTerminal();
  const [d, setD] = useState<LedgerData | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<string>('전체');

  const load = useCallback(async () => {
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    try {
      const q = connId ? `?connectionId=${connId}` : '';
      const r = await fetch(`/api/strategies/ledger${q}`, { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setErr(j?.message || j?.error || `조회 실패 (${r.status})`); return; }
      setErr(''); setD(j);
    } catch (e: any) {
      setErr(`장부 조회 실패 — 포지션 없음이 아니라 확인 불가입니다 (${e?.message || e})`);
    }
  }, [auth, connId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

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
      장부를 만드는 중
    </div>;
  }

  const shown = filter === '전체'
    ? d.holdings
    : d.holdings.filter(h => h.strategyId === filter);

  const blockers = d.conflicts.filter(c => c.severity === 'block');
  const mismatched = d.attribution.filter(a => !a.matched);

  return (
    <div style={{ padding: 14, maxWidth: 760 }}>
      {/* ── 충돌 ── 막아야 하는 것을 맨 위에 ── */}
      {blockers.length > 0 && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, marginBottom: 10,
          background: C.downBg, borderLeft: `2px solid ${C.down}`,
        }}>
          <div style={{ color: C.down, fontWeight: 700, fontSize: FS.small, marginBottom: 4 }}>
            전략 충돌 {blockers.length}건 — 실행하면 서로를 지웁니다
          </div>
          {blockers.map((c, i) => (
            <div key={i} style={{ color: C.dim, fontSize: FS.micro, lineHeight: 1.55 }}>
              {c.detail}
            </div>
          ))}
        </div>
      )}

      {/* ── 귀속 대조 ── */}
      <div style={{ marginBottom: 12 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: FS.micro, color: C.faint, marginBottom: 6,
        }}>
          <span>장부 ↔ 거래소 대조</span>
          {!d.exchangeReadable && (
            <span style={chip(C.warn, C.warnBg)}>거래소 확인 불가</span>
          )}
        </div>

        {d.attribution.length === 0 ? (
          <div style={{ color: C.faint, fontSize: FS.small, padding: '8px 0' }}>
            대조할 포지션이 없습니다
          </div>
        ) : d.attribution.map((a, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px', marginBottom: 4, borderRadius: 8,
            background: C.raised,
            borderLeft: `2px solid ${a.matched ? C.up : C.warn}`,
          }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ color: C.text, fontSize: FS.small, fontWeight: 600 }}>
                {a.symbol}
                <span style={{ color: C.faint, fontSize: FS.micro, fontWeight: 400, marginLeft: 6 }}>
                  {a.market === 'SPOT' ? '현물' : a.market === 'USDT_FUTURES' ? 'USDT-M' : 'COIN-M'}
                </span>
              </div>
              <div style={{ color: a.matched ? C.faint : C.warn, fontSize: FS.micro, lineHeight: 1.5 }}>
                {a.note}
              </div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ ...NUM, color: C.dim, fontSize: FS.micro }}>
                장부 {fmtPrice(a.attributed, 6)}
              </div>
              <div style={{ ...NUM, color: C.text, fontSize: FS.small, fontWeight: 600 }}>
                거래소 {a.exchangeQty == null ? '—' : fmtPrice(a.exchangeQty, 6)}
              </div>
              {/* 미귀속은 각주가 아니라 값 옆에 둔다 */}
              {a.unattributed != null && Math.abs(a.unattributed) > 1e-9 && (
                <div style={{ ...NUM, color: C.warn, fontSize: FS.micro, fontWeight: 700 }}>
                  미귀속 {a.unattributed > 0 ? '+' : ''}{fmtPrice(a.unattributed, 6)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ── 전략별 보유 ── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        <button onClick={() => setFilter('전체')} style={tabStyle(filter === '전체')}>전체</button>
        {d.strategies.map(s => (
          <button key={s} onClick={() => setFilter(s)} style={tabStyle(filter === s)}>{s}</button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div style={{ padding: '20px 0', textAlign: 'center', color: C.faint, fontSize: FS.small }}>
          귀속된 포지션이 없습니다
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.small }}>
          <thead>
            <tr>
              {['전략', '종목', '시장', '수량', '평균가'].map(h => (
                <th key={h} style={{
                  textAlign: 'left', padding: '7px 10px', color: C.faint,
                  fontSize: FS.micro, fontWeight: 500, borderBottom: `1px solid ${C.hair}`,
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((h, i) => (
              <tr key={i}>
                <td style={cell}>
                  <span style={{ color: C.text, fontWeight: 600 }}>{h.strategyId}</span>
                </td>
                <td style={cell}>{h.symbol}</td>
                <td style={cell}>
                  <span style={{ color: C.faint }}>
                    {h.market === 'SPOT' ? '현물' : h.market === 'USDT_FUTURES' ? 'USDT-M' : 'COIN-M'}
                  </span>
                </td>
                <td style={cell}>
                  {/* 현물의 음수와 선물의 음수는 뜻이 다르다. 현물엔 방향 표시를 안 붙인다. */}
                  <span style={{ color: h.market === 'SPOT' ? C.text : pnlColor(h.qty), fontWeight: 600 }}>
                    {h.market !== 'SPOT' && h.qty !== 0 && (h.qty > 0 ? 'LONG ' : 'SHORT ')}
                    {fmtPrice(Math.abs(h.qty), 6)}
                  </span>
                </td>
                <td style={cell}>{h.avgPrice == null ? '—' : fmtPrice(h.avgPrice)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {d.unownedCount > 0 && (
        <div style={{
          marginTop: 10, padding: '8px 10px', borderRadius: 8,
          background: C.warnBg, color: C.warn, fontSize: FS.micro, lineHeight: 1.55,
        }}>
          소유 전략이 기록되지 않은 주문 {d.unownedCount}건이 &lsquo;주인 미상&rsquo;으로 묶였습니다.
          아무 전략에나 붙이면 그 전략의 손익이 틀어지므로 따로 둡니다.
        </div>
      )}

      <div style={{
        marginTop: 10, padding: '9px 11px', borderRadius: 8,
        background: C.raised, color: C.dim, fontSize: FS.micro, lineHeight: 1.6,
      }}>{d.note}</div>
    </div>
  );
});

const cell: React.CSSProperties = {
  padding: '8px 10px', color: C.dim, whiteSpace: 'nowrap',
  borderBottom: `1px solid ${C.hair}`, ...NUM,
};

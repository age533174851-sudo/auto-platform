'use client';
// src/components/terminal/WatchPanel.tsx
//
// 트레일링·예약 감시 목록.
//
// 이 화면이 반드시 말해야 하는 것
// ───────────────────────────────
// **확인 주기.** 15분마다 보는 트레일링 스톱은 15분치 갭을 그대로 맞는다.
// 손절선이 100이어도 다음 확인 때 92면 92에 팔린다.
//
// 사용자는 "손절 걸어놨다"고 기억하지 "그 손절이 15분마다 확인된다"까지는
// 기억하지 않는다. 그래서 목록 맨 위에 주기를 크게 적고, 각 항목에
// 마지막으로 확인한 시각을 붙인다. 그 시각이 오래됐으면 감시가 멈춘 것이다.
import React, { memo, useCallback, useEffect, useState } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { C, FS, NUM, chip, ghostBtn, fmtPrice } from './theme';
import { useTerminal } from './TerminalContext';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';
import { formatAge } from '@/lib/engine/dataQuality';

interface WatchRow {
  id: string; symbol: string; strategyId: string;
  kind: 'TRAILING' | 'RESERVED';
  side: 'BUY' | 'SELL';
  stopPrice: number | null; entryPrice: number | null;
  highWater: number | null; trailPct: number | null;
  triggerPrice: number | null; direction: 'above' | 'below' | null;
  qty: number | null; quoteUsd: number | null;
  lastCheckedAt: number | null;
}

export const WatchPanel = memo(function WatchPanel() {
  const { symbol, auth, connId } = useTerminal();
  const stream = useBinanceStream(symbol.id, true);
  const [rows, setRows] = useState<WatchRow[] | null>(null);
  const [interval, setIntervalMin] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // 등록 폼
  const [kind, setKind] = useState<'TRAILING' | 'RESERVED'>('TRAILING');
  const [trailPct, setTrailPct] = useState('5');
  const [qty, setQty] = useState('');
  const [triggerPrice, setTriggerPrice] = useState('');
  const [direction, setDirection] = useState<'above' | 'below'>('below');
  const [side, setSide] = useState<'BUY' | 'SELL'>('SELL');
  const [quoteUsd, setQuoteUsd] = useState('');

  const load = useCallback(async () => {
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    try {
      const r = await fetch('/api/watch', { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setErr(errorTextOf(j, `조회 실패 (${r.status})`)); return; }
      setErr(''); setRows(j.watches); setIntervalMin(j.checkIntervalMin); setNote(j.note);
    } catch (e: any) { setErr(`감시 조회 실패 (${e?.message || e})`); }
  }, [auth]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const register = async () => {
    if (!auth || !connId) { setErr('로그인·거래소 연결이 필요합니다'); return; }
    setBusy(true); setErr('');
    try {
      const body: any = {
        kind, symbol: symbol.id, connectionId: connId, side,
        qty: qty ? Number(qty) : undefined,
        quoteUsd: quoteUsd ? Number(quoteUsd) : undefined,
      };
      if (kind === 'TRAILING') {
        Object.assign(body, { entryPrice: stream.lastPrice, trailPct: Number(trailPct), side: 'SELL' });
      } else {
        Object.assign(body, { triggerPrice: Number(triggerPrice), direction });
      }
      const r = await fetch('/api/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setErr(errorTextOf(j, `등록 실패 (${r.status})`)); return; }
      setQty(''); setQuoteUsd(''); setTriggerPrice('');
      await load();
    } catch (e: any) { setErr(`등록 실패 (${e?.message || e})`); }
    finally { setBusy(false); }
  };

  const cancel = async (id: string) => {
    if (!auth) return;
    if (!window.confirm('이 감시를 취소합니다. 진행할까요?')) return;
    try {
      await fetch(`/api/watch?id=${id}`, { method: 'DELETE', headers: { Authorization: auth } });
      await load();
    } catch { /* 목록 새로고침으로 확인 */ }
  };

  const now = Date.now();

  return (
    <div style={{ padding: 14, maxWidth: 680 }}>
      {/* 확인 주기 — 이 값이 곧 보호 수준이다 */}
      <div style={{
        padding: '10px 12px', borderRadius: 9, marginBottom: 12,
        background: C.warnBg, borderLeft: `2px solid ${C.warn}`,
      }}>
        <div style={{ color: C.warn, fontSize: FS.small, fontWeight: 700, marginBottom: 3 }}>
          {interval == null ? '확인 주기 미상' : `${interval}분마다 확인 · 앱 감시`}
        </div>
        <div style={{ color: C.dim, fontSize: FS.micro, lineHeight: 1.55 }}>
          {note || '서버가 주기적으로 확인합니다. 그 사이 가격이 손절선을 지나가면 지나간 값에 체결됩니다.'}
        </div>
      </div>

      {/* 등록 */}
      <div style={{
        padding: 12, borderRadius: 9, marginBottom: 12,
        background: C.raised, border: `1px solid ${C.hair}`,
      }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          {(['TRAILING', 'RESERVED'] as const).map(k => (
            <button key={k} onClick={() => setKind(k)} style={{ ...ghostBtn(kind === k), flex: 1 }}>
              {k === 'TRAILING' ? '트레일링 매도' : '예약 주문'}
            </button>
          ))}
        </div>

        {kind === 'TRAILING' ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <Field label="고점 대비 (%)" style={{ flex: 1 }}>
              <input value={trailPct} onChange={e => setTrailPct(e.target.value)} inputMode="decimal" style={inp}/>
            </Field>
            <Field label={`수량 (${symbol.id.replace(/USDT$/, '')})`} style={{ flex: 1 }}>
              <input value={qty} onChange={e => setQty(e.target.value)} inputMode="decimal" style={inp}/>
            </Field>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
              {(['BUY', 'SELL'] as const).map(s => (
                <button key={s} onClick={() => setSide(s)} style={{
                  flex: 1, minHeight: 30, border: 'none', borderRadius: 7, cursor: 'pointer',
                  background: side === s ? (s === 'BUY' ? C.up : C.down) : C.panel,
                  color: side === s ? '#fff' : (s === 'BUY' ? C.up : C.down),
                  fontSize: FS.micro, fontWeight: 700,
                }}>{s === 'BUY' ? '매수' : '매도'}</button>
              ))}
              {(['below', 'above'] as const).map(d => (
                <button key={d} onClick={() => setDirection(d)}
                  style={{ ...ghostBtn(direction === d), flex: 1, fontSize: FS.micro }}>
                  {d === 'below' ? '이하일 때' : '이상일 때'}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Field label="기준 가격" style={{ flex: 1 }}>
                <input value={triggerPrice} onChange={e => setTriggerPrice(e.target.value)}
                  placeholder={stream.lastPrice ? fmtPrice(stream.lastPrice) : ''}
                  inputMode="decimal" style={inp}/>
              </Field>
              <Field label={side === 'BUY' ? '금액 (USDT)' : `수량 (${symbol.id.replace(/USDT$/, '')})`} style={{ flex: 1 }}>
                <input
                  value={side === 'BUY' ? quoteUsd : qty}
                  onChange={e => side === 'BUY' ? setQuoteUsd(e.target.value) : setQty(e.target.value)}
                  inputMode="decimal" style={inp}/>
              </Field>
            </div>
          </>
        )}

        <button onClick={register} disabled={busy || !connId}
          style={{ ...ghostBtn(), width: '100%', marginTop: 8, minHeight: 34 }}>
          {busy ? '등록 중…' : '감시 등록'}
        </button>
        {!connId && (
          <div style={{ textAlign: 'center', color: C.faint, fontSize: FS.micro, marginTop: 5 }}>
            거래소 연결이 없어 등록할 수 없습니다
          </div>
        )}
      </div>

      {err && (
        <div style={{
          padding: '9px 11px', borderRadius: 8, marginBottom: 10,
          background: C.downBg, color: C.down, fontSize: FS.micro, lineHeight: 1.55,
        }}>{err}</div>
      )}

      {/* 목록 */}
      {rows == null ? (
        <div style={{ padding: 20, textAlign: 'center', color: C.faint, fontSize: FS.small }}>
          감시 목록을 받아오는 중
        </div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: C.faint, fontSize: FS.small }}>
          걸린 감시가 없습니다
        </div>
      ) : rows.map(w => {
        const age = w.lastCheckedAt ? now - w.lastCheckedAt : null;
        // 확인 주기의 3배를 넘겼으면 감시가 멈춘 것이다
        const stale = interval != null && age != null && age > interval * 60_000 * 3;
        return (
          <div key={w.id} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '10px 12px', marginBottom: 5, borderRadius: 9,
            background: C.raised,
            borderLeft: `2px solid ${w.side === 'BUY' ? C.up : C.down}`,
          }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ color: C.text, fontSize: FS.small, fontWeight: 700 }}>{w.symbol}</span>
                <span style={chip(w.kind === 'TRAILING' ? C.warn : C.accent)}>
                  {w.kind === 'TRAILING' ? '트레일링' : '예약'}
                </span>
                <span style={chip(w.side === 'BUY' ? C.up : C.down,
                                  w.side === 'BUY' ? C.upBg : C.downBg)}>
                  {w.side === 'BUY' ? '매수' : '매도'}
                </span>
              </div>
              <div style={{ ...NUM, color: C.dim, fontSize: FS.micro, lineHeight: 1.55 }}>
                {w.kind === 'TRAILING'
                  ? `손절선 ${fmtPrice(w.stopPrice ?? 0)} · 최고 ${fmtPrice(w.highWater ?? 0)} · −${w.trailPct}%`
                  : `${fmtPrice(w.triggerPrice ?? 0)} ${w.direction === 'above' ? '이상' : '이하'}일 때`}
                {w.qty != null && ` · ${fmtPrice(w.qty, 6)}`}
                {w.quoteUsd != null && ` · $${fmtPrice(w.quoteUsd)}`}
              </div>
              {/* 마지막 확인 시각. 오래됐으면 감시가 멈춘 것이다 */}
              <div style={{
                color: stale ? C.down : C.faint, fontSize: FS.micro, marginTop: 3,
                fontWeight: stale ? 700 : 400,
              }}>
                {age == null
                  ? '아직 확인되지 않음'
                  : stale
                    ? `마지막 확인 ${formatAge(age)} — 감시가 멈춰 있을 수 있습니다`
                    : `마지막 확인 ${formatAge(age)}`}
              </div>
            </div>
            <button onClick={() => cancel(w.id)} style={{
              ...ghostBtn(), color: C.dim, flexShrink: 0, fontSize: FS.micro, padding: '5px 9px',
            }}>취소</button>
          </div>
        );
      })}
    </div>
  );
});

const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: C.panel, color: C.text,
  border: `1px solid ${C.hair}`, borderRadius: 7,
  padding: '7px 9px', fontSize: FS.small, outline: 'none',
  fontFamily: '"SF Mono","JetBrains Mono",ui-monospace,monospace',
  fontVariantNumeric: 'tabular-nums',
};

function Field({ label, children, style }: {
  label: string; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div style={style}>
      <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

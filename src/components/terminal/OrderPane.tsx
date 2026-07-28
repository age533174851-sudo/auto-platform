'use client';
// src/components/terminal/OrderPane.tsx
//
// 호가판과 주문판. **따로 export한다.**
//
// PC는 우측 열에 둘을 세로로 쌓고, 모바일은 하단 탭에서 각각 따로 연다.
// 같은 화면을 줄여 쓰는 게 아니라 같은 조각을 다르게 배치하는 것이라,
// 조각 단위로 나뉘어 있어야 한다.
//
// 이 파일이 다른 패널과 반대 방향인 이유
// ──────────────────────────────────────
// 화면에서 유일하게 되돌릴 수 없는 일이 여기서 일어난다.
//  - 뉴스·표는 촘촘하게. 주문 버튼과 입력창은 **크게**.
//  - 배율은 숫자만 쓰지 않고 그 배율의 청산 거리를 함께 보여준다.
//    100배가 위험한 이유는 숫자가 커서가 아니라 청산 거리가 0.5%라서다.
import React, { memo, useMemo, useState } from 'react';
import { C, FS, NUM, fmtPrice, pnlColor, input, primaryBtn, ghostBtn, chip } from './theme';
import { DataBadge } from '@/components/ui/DataBadge';
import { useBinanceStream, bookImbalance, type StreamState } from '@/lib/hooks/useBinanceStream';
import { useTerminal } from './TerminalContext';

const LEVERAGES = [1, 3, 5, 10, 20, 50, 75, 100];
const LEV_KEY = 'tg_terminal_leverage';

/**
 * 이 배율에서 청산까지의 대략 거리(%).
 * 정확한 값은 유지증거금 구간에 따라 달라지므로 이 값은 **상한**에 가깝다.
 * 실제 청산은 이보다 가깝다. 화면에도 그렇게 적는다.
 */
export function roughLiqDistancePct(leverage: number): number {
  if (leverage <= 1) return 100;
  return 100 / leverage;
}

// ══ 호가판 ══════════════════════════════════════════════
export const OrderBookPanel = memo(function OrderBookPanel({
  rows = 9, onPickPrice,
}: { rows?: number; onPickPrice?: (p: number) => void }) {
  const { symbol } = useTerminal();
  const stream = useBinanceStream(symbol.id, true);
  const live = stream.status === 'live' && !stream.stale;

  const asks = useMemo(() => stream.asks.slice(0, rows).reverse(), [stream.asks, rows]);
  const bids = useMemo(() => stream.bids.slice(0, rows), [stream.bids, rows]);
  const maxQty = Math.max(1e-9, ...asks.map(l => l.qty), ...bids.map(l => l.qty));
  const mid = stream.lastPrice ?? bids[0]?.price ?? null;
  const imbalance = bookImbalance(stream);

  const Row = ({ p, q, buy }: { p: number; q: number; buy: boolean }) => (
    <button
      onClick={() => onPickPrice?.(p)}
      style={{
        position: 'relative', display: 'flex', justifyContent: 'space-between',
        width: '100%', background: 'none', border: 'none',
        padding: '1px 12px', cursor: onPickPrice ? 'pointer' : 'default',
        overflow: 'hidden', ...NUM, fontSize: FS.small, lineHeight: 1.75,
      }}
    >
      {/* 깊이 막대는 배경으로만. 숫자를 가리면 읽는 속도가 떨어진다 */}
      <span style={{
        position: 'absolute', top: 1, bottom: 1, right: 0,
        width: `${(q / maxQty) * 100}%`, borderRadius: '2px 0 0 2px',
        background: buy ? C.upBg : C.downBg,
      }}/>
      <span style={{ color: buy ? C.up : C.down, zIndex: 1, fontWeight: 500 }}>{fmtPrice(p)}</span>
      <span style={{ color: C.dim, zIndex: 1 }}>{q.toFixed(3)}</span>
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '7px 12px 5px', fontSize: FS.micro, color: C.faint,
      }}>
        <span>가격 · USDT</span>
        <DataBadge compact source={{
          kind: live ? 'REALTIME' : 'UNAVAILABLE',
          origin: 'Binance', asOf: stream.depthAt, expectedIntervalMs: 100,
        }}/>
        <span>수량</span>
      </div>

      {asks.length === 0 && bids.length === 0 ? (
        <div style={{ padding: '28px 12px', textAlign: 'center', color: C.faint, fontSize: FS.small }}>
          {stream.status === 'live' ? '호가 수신 대기 중' : '호가를 받아오는 중'}
        </div>
      ) : (
        <>
          {asks.map((l, i) => <Row key={'a' + i} p={l.price} q={l.qty} buy={false}/>)}

          <div style={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 8,
            padding: '7px 12px', margin: '2px 0',
            borderTop: `1px solid ${C.hair}`, borderBottom: `1px solid ${C.hair}`,
          }}>
            <span style={{ ...NUM, color: pnlColor(stream.changePct), fontSize: 19, fontWeight: 700 }}>
              {fmtPrice(mid)}
            </span>
            {stream.changePct != null && (
              <span style={{ ...NUM, color: pnlColor(stream.changePct), fontSize: FS.small, fontWeight: 600 }}>
                {stream.changePct >= 0 ? '+' : ''}{stream.changePct.toFixed(2)}%
              </span>
            )}
          </div>

          {bids.map((l, i) => <Row key={'b' + i} p={l.price} q={l.qty} buy={true}/>)}
        </>
      )}

      {imbalance != null && (
        <div style={{ padding: '10px 12px 12px' }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontSize: FS.micro, marginBottom: 5, ...NUM,
          }}>
            <span style={{ color: C.up }}>{imbalance.toFixed(1)}%</span>
            <span style={{ color: C.faint, fontFamily: 'inherit' }}>호가 잔량</span>
            <span style={{ color: C.down }}>{(100 - imbalance).toFixed(1)}%</span>
          </div>
          <div style={{ display: 'flex', height: 3, borderRadius: 2, overflow: 'hidden', background: C.hair }}>
            <div style={{ width: `${imbalance}%`, background: C.up }}/>
            <div style={{ width: `${100 - imbalance}%`, background: C.down }}/>
          </div>
          {/* 체결 강도가 아니라 호가 잔량이다. 같은 것으로 읽히면 안 된다. */}
          <div style={{ marginTop: 6 }}>
            <DataBadge compact source={{
              kind: live ? 'DERIVED' : 'UNAVAILABLE',
              origin: '호가 잔량 계산', asOf: stream.depthAt, expectedIntervalMs: 100,
            }}/>
          </div>
        </div>
      )}
    </div>
  );
});

// ══ 주문판 ══════════════════════════════════════════════
export const OrderFormPanel = memo(function OrderFormPanel({
  presetPrice,
}: { presetPrice?: number | null }) {
  const { symbol, auth, connId, connections, mode } = useTerminal();
  const stream = useBinanceStream(symbol.id, true);

  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');
  const [leverage, setLeverage] = useState(() => {
    try { const v = +(localStorage.getItem(LEV_KEY) || '5'); return v >= 1 && v <= 125 ? v : 5; }
    catch { return 5; }
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 호가를 눌러 들어온 가격
  React.useEffect(() => {
    if (presetPrice != null) { setOrderType('LIMIT'); setPrice(String(presetPrice)); }
  }, [presetPrice]);

  const mid = stream.lastPrice;
  const notional = (Number(qty) || 0) * (Number(price) || mid || 0);
  const margin = leverage > 0 ? notional / leverage : 0;
  const liqPct = roughLiqDistancePct(leverage);
  const liqTone = liqPct < 1 ? C.down : liqPct < 3 ? C.warn : C.dim;

  const pickLev = (v: number) => {
    setLeverage(v);
    try { localStorage.setItem(LEV_KEY, String(v)); } catch {}
  };

  const submit = async () => {
    setMsg(null);
    if (!auth) { setMsg({ ok: false, text: '로그인이 필요합니다' }); return; }
    if (!connId) { setMsg({ ok: false, text: '거래소 연결을 먼저 등록하세요' }); return; }
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) { setMsg({ ok: false, text: '수량을 입력하세요' }); return; }

    setBusy(true);
    try {
      const r = await fetch('/api/binance/futures/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          connectionId: connId, confirmToken: 'LIVE_ORDER_CONFIRMED',
          symbol: symbol.id, side, type: orderType, quantity: q, leverage,
          price: orderType === 'LIMIT' ? Number(price) || undefined : undefined,
        }),
      });
      const j = await r.json();
      if (r.ok && j?.ok) setMsg({ ok: true, text: `주문 접수됨 · 작업 ${String(j.jobId).slice(0, 8)}` });
      else setMsg({ ok: false, text: j?.message || j?.error || `실패 (${r.status})` });
    } catch (e: any) {
      // 응답을 못 받았다. 나갔는지 안 나갔는지 모르는 상태다.
      setMsg({ ok: false, text: `응답 없음 — 재시도하지 말고 포지션을 먼저 확인하세요 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  const base = symbol.id.replace(/USDT$/, '');

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 방향 — 가장 먼저 정하는 것을 가장 위에 */}
      <div style={{ display: 'flex', gap: 6, background: C.raised, padding: 3, borderRadius: 10 }}>
        {(['BUY', 'SELL'] as const).map(s => (
          <button key={s} onClick={() => setSide(s)} style={{
            flex: 1, minHeight: 38, border: 'none', borderRadius: 8, cursor: 'pointer',
            background: side === s ? (s === 'BUY' ? C.up : C.down) : 'transparent',
            color: side === s ? '#fff' : (s === 'BUY' ? C.up : C.down),
            fontSize: FS.body, fontWeight: 700, transition: 'background .12s',
          }}>{s === 'BUY' ? '롱 · 매수' : '숏 · 매도'}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        {(['MARKET', 'LIMIT'] as const).map(t => (
          <button key={t} onClick={() => setOrderType(t)} style={{ ...ghostBtn(orderType === t), flex: 1 }}>
            {t === 'MARKET' ? '시장가' : '지정가'}
          </button>
        ))}
      </div>

      {orderType === 'LIMIT' && (
        <Field label="가격" unit="USDT">
          <input value={price} onChange={e => setPrice(e.target.value)}
            placeholder={mid ? fmtPrice(mid) : '0.00'} inputMode="decimal" style={input}/>
        </Field>
      )}

      <Field label="수량" unit={base}>
        <input value={qty} onChange={e => setQty(e.target.value)}
          placeholder="0.000" inputMode="decimal" style={input}/>
      </Field>

      {/* 배율 — 숫자와 그 결과를 함께 */}
      <div>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          marginBottom: 7, fontSize: FS.micro,
        }}>
          <span style={{ color: C.faint }}>레버리지</span>
          <span style={{ ...NUM, color: liqTone, fontWeight: 700, fontSize: FS.small }}>
            청산 약 {liqPct.toFixed(2)}% 이내
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5 }}>
          {LEVERAGES.map(v => {
            const on = leverage === v;
            const risky = v >= 50;
            return (
              <button key={v} onClick={() => pickLev(v)} style={{
                minHeight: 34, borderRadius: 8, cursor: 'pointer',
                background: on ? (risky ? C.down : C.accent) : C.raised,
                color: on ? '#fff' : risky ? C.warn : C.dim,
                border: `1px solid ${on ? 'transparent' : C.hair}`,
                fontSize: FS.small, fontWeight: 700, ...NUM,
                transition: 'background .12s, color .12s',
              }}>{v}×</button>
            );
          })}
        </div>
        <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 6, lineHeight: 1.5 }}>
          유지증거금을 뺀 근사치입니다. 실제 청산은 이보다 가깝습니다.
        </div>
      </div>

      <div style={{
        background: C.raised, borderRadius: 10, padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 5, fontSize: FS.small,
      }}>
        <KV k="명목가" v={notional > 0 ? `$${fmtPrice(notional)}` : '—'}/>
        <KV k="필요 증거금" v={margin > 0 ? `$${fmtPrice(margin)}` : '—'}/>
      </div>

      <button onClick={submit} disabled={busy}
        style={primaryBtn(side === 'BUY' ? C.up : C.down, busy)}>
        {busy ? '전송 중…' : `${base} ${side === 'BUY' ? '롱' : '숏'} ${leverage}× 주문`}
      </button>

      {/* 실자금 여부는 버튼 바로 아래에. 상단 배지만으로는 부족하다. */}
      <div style={{
        textAlign: 'center', fontSize: FS.micro, lineHeight: 1.5,
        color: mode.unknown ? C.warn : mode.realMoney ? C.down : C.faint,
      }}>
        {mode.unknown
          ? '운영 모드를 확인하지 못했습니다 — 실자금 여부 불명'
          : mode.realMoney
            ? '실제 자금이 사용됩니다'
            : `${mode.label} · 실제 자금이 아닙니다`}
      </div>

      {msg && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, fontSize: FS.small, lineHeight: 1.55,
          color: msg.ok ? C.up : C.down,
          background: msg.ok ? C.upBg : C.downBg,
        }}>{msg.text}</div>
      )}

      {!connections.length && (
        <div style={{ textAlign: 'center', fontSize: FS.micro, color: C.faint }}>
          거래소 연결이 없어 주문할 수 없습니다
        </div>
      )}
    </div>
  );
});

function Field({ label, unit, children }: { label: string; unit: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: FS.micro, color: C.faint, marginBottom: 5,
      }}>
        <span>{label}</span><span>{unit}</span>
      </div>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: C.faint }}>{k}</span>
      <span style={{ ...NUM, color: C.text, fontWeight: 600 }}>{v}</span>
    </div>
  );
}

// ══ PC 우측 열 — 둘을 쌓는다 ═══════════════════════════
export const OrderPane = memo(function OrderPane() {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      <OrderBookPanel onPickPrice={setPicked}/>
      <div style={{ borderTop: `1px solid ${C.hair}` }}/>
      <OrderFormPanel presetPrice={picked}/>
    </div>
  );
});

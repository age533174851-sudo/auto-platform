'use client';
// src/components/terminal/OrderPane.tsx
//
// 우측 — 호가 · 주문 · 레버리지.
//
// 이 화면에서 유일하게 되돌릴 수 없는 일이 여기서 일어난다. 그래서
// 다른 패널과 반대 방향으로 설계했다.
//
//  - 뉴스·로그·통계는 고밀도로 촘촘하게. 주문 버튼은 **크게**.
//  - 배율은 숫자만 쓰지 않고 그 배율에서의 청산 거리를 함께 보여준다.
//    100배가 위험한 이유는 숫자가 커서가 아니라 청산 거리가 0.5%라서다.
//  - 모드가 실자금이면 버튼 색과 문구가 바뀐다.
import React, { memo, useMemo, useState } from 'react';
import { T } from '@/lib/constants';
import { DataBadge } from '@/components/ui/DataBadge';
import { useBinanceStream, bookImbalance } from '@/lib/hooks/useBinanceStream';
import { useTerminal } from './TerminalContext';

const LEVERAGES = [1, 3, 5, 10, 20, 50, 75, 100];
const LEV_KEY = 'tg_terminal_leverage';

/**
 * 이 배율에서 청산까지의 대략 거리(%).
 *
 * 정확한 값은 유지증거금 구간에 따라 달라지므로 여기 값은 **상한**에 가깝다.
 * 실제 청산은 이보다 가깝다. 화면에도 그렇게 적는다.
 */
export function roughLiqDistancePct(leverage: number): number {
  if (leverage <= 1) return 100;
  return 100 / leverage;
}

function OrderPaneInner() {
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

  const connected = stream.status === 'live' && !stream.stale;
  const asks = useMemo(() => stream.asks.slice(0, 9).reverse(), [stream.asks]);
  const bids = useMemo(() => stream.bids.slice(0, 9), [stream.bids]);
  const maxQty = Math.max(1e-9, ...asks.map(l => l.qty), ...bids.map(l => l.qty));
  const mid = stream.lastPrice ?? bids[0]?.price ?? null;
  const imbalance = bookImbalance(stream);

  const pickLev = (v: number) => {
    setLeverage(v);
    try { localStorage.setItem(LEV_KEY, String(v)); } catch {}
  };

  const notional = (Number(qty) || 0) * (mid || 0);
  const margin = leverage > 0 ? notional / leverage : 0;
  const liqPct = roughLiqDistancePct(leverage);

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
          connectionId: connId,
          confirmToken: 'LIVE_ORDER_CONFIRMED',
          symbol: symbol.id, side, type: orderType,
          quantity: q, leverage,
          price: orderType === 'LIMIT' ? Number(price) || undefined : undefined,
        }),
      });
      const j = await r.json();
      if (r.ok && j?.ok) setMsg({ ok: true, text: `주문 접수 — 작업 ${String(j.jobId).slice(0, 8)}` });
      else setMsg({ ok: false, text: j?.message || j?.error || `실패 (${r.status})` });
    } catch (e: any) {
      // 응답을 못 받았다. 나갔는지 안 나갔는지 모르는 상태다.
      setMsg({ ok: false, text: `응답 없음 — 재시도하지 말고 포지션을 먼저 확인하세요: ${e?.message || e}` });
    } finally { setBusy(false); }
  };

  const Row = ({ p, q, buy }: { p: number; q: number; buy: boolean }) => (
    <div onClick={() => { setOrderType('LIMIT'); setPrice(String(p)); }} style={{
      position: 'relative', display: 'flex', justifyContent: 'space-between',
      padding: '1px 7px', fontSize: 10, cursor: 'pointer', overflow: 'hidden',
      fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums', lineHeight: 1.6,
    }}>
      <div style={{
        position: 'absolute', top: 0, bottom: 0, right: 0,
        width: `${(q / maxQty) * 100}%`, background: buy ? T.grn + '1A' : T.red + '1A',
      }}/>
      <span style={{ color: buy ? T.grn : T.red, zIndex: 1 }}>
        {p.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </span>
      <span style={{ color: T.sub, zIndex: 1, fontSize: 9 }}>{q.toFixed(3)}</span>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, overflowY: 'auto' }}>
      {/* ── 호가 ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '4px 7px', borderBottom: `1px solid ${T.border}`, fontSize: 8, color: T.muted,
      }}>
        <span>가격 (USDT)</span>
        <DataBadge compact source={{
          kind: connected ? 'REALTIME' : 'UNAVAILABLE',
          origin: 'Binance 선물', asOf: stream.depthAt, expectedIntervalMs: 100,
        }}/>
        <span>수량</span>
      </div>

      {asks.length === 0 && bids.length === 0 ? (
        <div style={{ padding: '20px 6px', textAlign: 'center', color: T.muted, fontSize: 10 }}>
          {stream.status === 'live' ? '호가 수신 대기 중…' : '호가를 받아오는 중…'}
        </div>
      ) : (
        <>
          {asks.map((l, i) => <Row key={'a' + i} p={l.price} q={l.qty} buy={false}/>)}
          <div style={{
            padding: '4px 7px', textAlign: 'center',
            borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, margin: '1px 0',
          }}>
            <span style={{
              color: (stream.changePct ?? 0) >= 0 ? T.grn : T.red, fontWeight: 900, fontSize: 15,
              fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums',
            }}>
              {mid != null ? mid.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
            </span>
          </div>
          {bids.map((l, i) => <Row key={'b' + i} p={l.price} q={l.qty} buy={true}/>)}
        </>
      )}

      {imbalance != null && (
        <div style={{ padding: '5px 7px', borderTop: `1px solid ${T.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, marginBottom: 3 }}>
            <span style={{ color: T.grn }}>호가 잔량 매수 {imbalance.toFixed(1)}%</span>
            <span style={{ color: T.red }}>{(100 - imbalance).toFixed(1)}% 매도</span>
          </div>
          <div style={{ display: 'flex', height: 3, borderRadius: 2, overflow: 'hidden', background: T.border }}>
            <div style={{ width: `${imbalance}%`, background: T.grn }}/>
            <div style={{ width: `${100 - imbalance}%`, background: T.red }}/>
          </div>
          {/* 체결 강도가 아니라 호가 잔량이다. 같은 것으로 읽히면 안 된다. */}
          <div style={{ marginTop: 3 }}>
            <DataBadge compact source={{
              kind: connected ? 'DERIVED' : 'UNAVAILABLE',
              origin: '호가 잔량 계산', asOf: stream.depthAt, expectedIntervalMs: 100,
            }}/>
          </div>
        </div>
      )}

      {/* ── 배율 ── */}
      <div style={{ padding: '8px 7px', borderTop: `1px solid ${T.border2}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: T.muted, marginBottom: 5 }}>
          <span>레버리지</span>
          <span style={{ color: liqPct < 1 ? T.red : liqPct < 3 ? T.ylw : T.sub, fontWeight: 800 }}>
            청산 약 {liqPct.toFixed(2)}% 이내
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 3 }}>
          {LEVERAGES.map(v => (
            <button key={v} onClick={() => pickLev(v)} style={{
              background: leverage === v ? (v >= 50 ? T.red : T.acc) : T.alt,
              color: leverage === v ? '#fff' : T.sub,
              border: `1px solid ${leverage === v ? (v >= 50 ? T.red : T.acc) : T.border}`,
              borderRadius: 5, padding: '4px 0', fontSize: 10, fontWeight: 800, cursor: 'pointer',
            }}>{v}x</button>
          ))}
        </div>
        {/* 값이 근사임을 숨기지 않는다. 실제 청산은 이보다 가깝다. */}
        <div style={{ color: T.muted, fontSize: 8, marginTop: 4, lineHeight: 1.4 }}>
          유지증거금을 뺀 근사치입니다. 실제 청산은 이보다 <b style={{ color: T.sub }}>가깝습니다</b>.
        </div>
      </div>

      {/* ── 주문 ── */}
      <div style={{ padding: '8px 7px', borderTop: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', gap: 3, marginBottom: 6 }}>
          {(['MARKET', 'LIMIT'] as const).map(t => (
            <button key={t} onClick={() => setOrderType(t)} style={{
              flex: 1, background: orderType === t ? T.alt : 'transparent',
              color: orderType === t ? T.txt : T.muted,
              border: `1px solid ${orderType === t ? T.border2 : T.border}`,
              borderRadius: 5, padding: '4px 0', fontSize: 10, fontWeight: 700, cursor: 'pointer',
            }}>{t === 'MARKET' ? '시장가' : '지정가'}</button>
          ))}
        </div>

        {orderType === 'LIMIT' && (
          <input value={price} onChange={e => setPrice(e.target.value)} placeholder="가격 (USDT)"
            inputMode="decimal" style={inputStyle}/>
        )}
        <input value={qty} onChange={e => setQty(e.target.value)}
          placeholder={`수량 (${symbol.id.replace(/USDT$/, '')})`} inputMode="decimal" style={inputStyle}/>

        <div style={{ fontSize: 9, color: T.muted, lineHeight: 1.6, margin: '4px 0 8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>명목가</span>
            <span style={{ color: T.sub, fontFamily: 'Inter,monospace' }}>
              {notional > 0 ? `$${notional.toFixed(2)}` : '—'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>필요 증거금</span>
            <span style={{ color: T.sub, fontFamily: 'Inter,monospace' }}>
              {margin > 0 ? `$${margin.toFixed(2)}` : '—'}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 5 }}>
          {(['BUY', 'SELL'] as const).map(s => (
            <button key={s} onClick={() => { setSide(s); }} style={{
              flex: 1, background: side === s ? (s === 'BUY' ? T.grn : T.red) : 'transparent',
              color: side === s ? '#fff' : (s === 'BUY' ? T.grn : T.red),
              border: `1px solid ${s === 'BUY' ? T.grn : T.red}`,
              borderRadius: 6, padding: '6px 0', fontSize: 11, fontWeight: 800, cursor: 'pointer',
            }}>{s === 'BUY' ? '매수 / 롱' : '매도 / 숏'}</button>
          ))}
        </div>

        {/* 주문 버튼은 크게. 고밀도는 뉴스·로그에만 쓴다. */}
        <button onClick={submit} disabled={busy} style={{
          width: '100%', marginTop: 7,
          background: side === 'BUY' ? T.grn : T.red, color: '#fff',
          border: 'none', borderRadius: 7, padding: '13px 0',
          fontSize: 13, fontWeight: 900, cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1, letterSpacing: -0.3,
        }}>
          {busy ? '전송 중…'
            : `${symbol.id.replace(/USDT$/, '')} ${side === 'BUY' ? '롱' : '숏'} ${leverage}x 주문`}
        </button>

        {/* 실자금 여부를 버튼 바로 아래에 적는다. 상단 배지만으로는 부족하다. */}
        <div style={{
          marginTop: 5, fontSize: 9, textAlign: 'center', lineHeight: 1.5,
          color: mode.unknown ? T.ylw : mode.realMoney ? T.red : T.muted,
        }}>
          {mode.unknown
            ? '⚠ 운영 모드를 확인하지 못했습니다 — 실자금 여부 불명'
            : mode.realMoney
              ? '⚠ 실제 자금이 사용됩니다'
              : `${mode.label} — 실제 자금이 아닙니다`}
        </div>

        {msg && (
          <div style={{
            marginTop: 6, padding: '6px 7px', borderRadius: 5, fontSize: 9, lineHeight: 1.5,
            color: msg.ok ? T.grn : T.red,
            background: (msg.ok ? T.grn : T.red) + '14',
            border: `1px solid ${(msg.ok ? T.grn : T.red)}40`,
          }}>{msg.text}</div>
        )}

        {!connections.length && (
          <div style={{ marginTop: 6, fontSize: 9, color: T.muted, textAlign: 'center' }}>
            거래소 연결이 없어 주문할 수 없습니다
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', background: T.bg, color: T.txt,
  border: `1px solid ${T.border2}`, borderRadius: 5,
  padding: '6px 8px', fontSize: 11, marginBottom: 4,
  fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums',
};

export const OrderPane = memo(OrderPaneInner);

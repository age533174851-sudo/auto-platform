'use client';
// src/components/terminal/SpotOrderTools.tsx
//
// 현물 주문 도구 — 분할 · 익절/손절 · 트레일링.
//
// 화면에서 반드시 지키는 것
// ─────────────────────────
// 계획을 먼저 보여주고, 사용자가 확인한 뒤에만 보낸다. 여러 건이 한 번에
// 나가는 기능이라 "눌렀더니 5건이 나갔다"가 되면 안 된다.
//
// 그리고 **앱 보호와 거래소 보호를 다른 색으로 표시한다.** 트레일링은
// 서버가 멈추면 사라지는데, 지정가 손절과 같은 모양으로 보이면
// 사용자는 둘 다 걸어놨다고 믿는다.
//
// 실행은 기존 현물 주문 라우트로 한 건씩 보낸다. 중간에 실패하면
// 멈추고 어디까지 나갔는지 보여준다 — 계속 보내면 의도하지 않은
// 반쪽 사다리가 남는다.
import React, { memo, useState } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { C, FS, NUM, chip, ghostBtn, primaryBtn, input, fmtPrice } from './theme';
import { useTerminal } from './TerminalContext';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';

type Kind = 'split' | 'bracket' | 'trailing';

interface PlannedOrder {
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quoteUsd?: number; qty?: number; price?: number;
  label: string;
  guardedBy: 'EXCHANGE' | 'APP';
}

interface Plan {
  ok: boolean;
  orders: PlannedOrder[];
  warnings: string[];
  guards: { exchange: number; app: number; warning: string | null };
  heldQty: number | null;
  avgPrice: number | null;
  minNotional: number | null;
}

export const SpotOrderTools = memo(function SpotOrderTools() {
  const { symbol, auth, connId, marketType, setMarketType } = useTerminal();
  const stream = useBinanceStream(symbol.id, true);
  const mid = stream.lastPrice;

  const [kind, setKind] = useState<Kind>('split');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string[]>([]);

  // 분할
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [total, setTotal] = useState('300');
  const [tranches, setTranches] = useState('3');
  const [fromPrice, setFromPrice] = useState('');
  const [toPrice, setToPrice] = useState('');
  // 익절/손절
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [coverPct, setCoverPct] = useState('100');
  // 트레일링
  const [trailPct, setTrailPct] = useState('5');

  const base = symbol.id.replace(/USDT$/, '');

  const makePlan = async () => {
    setErr(''); setPlan(null); setSent([]);
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    setBusy(true);
    try {
      const body: any = { symbol: symbol.id, kind, connectionId: connId || undefined };
      if (kind === 'split') {
        Object.assign(body, {
          side, total: Number(total), tranches: Number(tranches),
          fromPrice: Number(fromPrice) || mid, toPrice: Number(toPrice) || mid,
        });
      } else if (kind === 'bracket') {
        Object.assign(body, {
          takeProfit: tp ? Number(tp) : null,
          stopLoss: sl ? Number(sl) : null,
          coverPct: Number(coverPct) || 100,
        });
      } else {
        Object.assign(body, { entryPrice: mid, trailPct: Number(trailPct) });
      }

      const r = await fetch('/api/strategies/spot/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) { setErr(errorTextOf(j, `계획 실패 (${r.status})`)); return; }
      setPlan(j);
      if (!j.ok) setErr(j.warnings?.[0] || '계획을 만들 수 없습니다');
    } catch (e: any) {
      setErr(`계획 실패 (${e?.message || e})`);
    } finally { setBusy(false); }
  };

  const execute = async () => {
    if (!plan?.ok || plan.orders.length === 0 || !auth || !connId) return;
    if (!window.confirm(
      `${plan.orders.length}건의 현물 주문을 보냅니다.\n한 건이라도 실패하면 거기서 멈춥니다. 진행할까요?`)) return;

    setBusy(true); setSent([]); setErr('');
    const done: string[] = [];
    try {
      for (const o of plan.orders) {
        const r = await fetch('/api/binance/spot/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({
            connectionId: connId,
            confirmToken: 'SPOT_ORDER_CONFIRMED',
            symbol: symbol.id, side: o.side, type: o.type,
            quantity: o.qty, price: o.price,
          }),
        });
        const j = await r.json();
        if (!r.ok || !j?.ok) {
          // 여기서 멈춘다. 계속 보내면 의도하지 않은 반쪽 사다리가 남는다.
          setErr(`${o.label}에서 실패해 중단했습니다: ${errorTextOf(j)}`);
          break;
        }
        done.push(o.label);
        setSent([...done]);
      }
    } catch (e: any) {
      setErr(`${done.length}건까지 보낸 뒤 응답이 끊겼습니다 — 현물 내역을 확인하세요 (${e?.message || e})`);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ padding: 14, maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ color: C.text, fontSize: FS.body, fontWeight: 700 }}>
          {symbol.id} 현물 주문 도구
        </span>
        {marketType !== 'SPOT' && (
          <button onClick={() => setMarketType('SPOT')} style={{ ...ghostBtn(), color: C.warn }}>
            주문창이 선물입니다 — 현물로 전환
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {([['split', '분할'], ['bracket', '익절·손절'], ['trailing', '트레일링']] as const).map(([k, l]) => (
          <button key={k} onClick={() => { setKind(k); setPlan(null); setErr(''); }}
            style={{ ...ghostBtn(kind === k), flex: 1 }}>{l}</button>
        ))}
      </div>

      {kind === 'split' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['BUY', 'SELL'] as const).map(s => (
              <button key={s} onClick={() => setSide(s)} style={{
                flex: 1, minHeight: 34, border: 'none', borderRadius: 8, cursor: 'pointer',
                background: side === s ? (s === 'BUY' ? C.up : C.down) : C.raised,
                color: side === s ? '#fff' : (s === 'BUY' ? C.up : C.down),
                fontSize: FS.small, fontWeight: 700,
              }}>{s === 'BUY' ? '분할 매수' : '분할 매도'}</button>
            ))}
          </div>
          <Field label={side === 'BUY' ? '총 금액 (USDT)' : `총 수량 (${base})`}>
            <input value={total} onChange={e => setTotal(e.target.value)} inputMode="decimal" style={input}/>
          </Field>
          <Field label="분할 횟수">
            <input value={tranches} onChange={e => setTranches(e.target.value)} inputMode="numeric" style={input}/>
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <Field label="시작가" style={{ flex: 1 }}>
              <input value={fromPrice} onChange={e => setFromPrice(e.target.value)}
                placeholder={mid ? fmtPrice(mid) : '현재가'} inputMode="decimal" style={input}/>
            </Field>
            <Field label="끝가" style={{ flex: 1 }}>
              <input value={toPrice} onChange={e => setToPrice(e.target.value)}
                placeholder={mid ? fmtPrice(mid) : '현재가'} inputMode="decimal" style={input}/>
            </Field>
          </div>
        </div>
      )}

      {kind === 'bracket' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <Field label="익절가 (비우면 안 걺)">
            <input value={tp} onChange={e => setTp(e.target.value)} inputMode="decimal" style={input}/>
          </Field>
          <Field label="손절가 (비우면 안 걺)">
            <input value={sl} onChange={e => setSl(e.target.value)} inputMode="decimal" style={input}/>
          </Field>
          <Field label="보호할 비율 (%)">
            <input value={coverPct} onChange={e => setCoverPct(e.target.value)} inputMode="numeric" style={input}/>
          </Field>
        </div>
      )}

      {kind === 'trailing' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <Field label="최고가 대비 (%)">
            <input value={trailPct} onChange={e => setTrailPct(e.target.value)} inputMode="decimal" style={input}/>
          </Field>
          <div style={{
            padding: '9px 11px', borderRadius: 8, background: C.warnBg,
            color: C.warn, fontSize: FS.micro, lineHeight: 1.55,
          }}>
            트레일링 스톱은 거래소에 올라가지 않습니다. 서버가 가격을 보며 손절선을 옮기므로,
            서버가 멈추면 이 보호는 동작하지 않습니다.
          </div>
        </div>
      )}

      <button onClick={makePlan} disabled={busy} style={{ ...ghostBtn(), width: '100%', minHeight: 36 }}>
        {busy ? '계획 만드는 중…' : '계획 만들기 (주문 안 나감)'}
      </button>

      {err && (
        <div style={{
          marginTop: 10, padding: '9px 11px', borderRadius: 8,
          background: C.downBg, color: C.down, fontSize: FS.micro, lineHeight: 1.55,
        }}>{err}</div>
      )}

      {plan && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 12, fontSize: FS.micro, color: C.faint, marginBottom: 8 }}>
            <span>보유 <b style={{ ...NUM, color: plan.heldQty == null ? C.warn : C.text }}>
              {plan.heldQty == null ? '확인 불가' : fmtPrice(plan.heldQty, 6)}</b></span>
            <span>평균가 <b style={{ ...NUM, color: C.text }}>
              {plan.avgPrice == null ? '—' : fmtPrice(plan.avgPrice)}</b></span>
            {plan.minNotional != null && (
              <span>최소주문 <b style={{ ...NUM, color: C.text }}>${plan.minNotional}</b></span>
            )}
          </div>

          {/* 보호 위치를 색으로 가른다 */}
          {plan.guards.warning && (
            <div style={{
              padding: '9px 11px', borderRadius: 8, marginBottom: 8,
              background: C.warnBg, color: C.warn, fontSize: FS.micro, lineHeight: 1.55,
            }}>{plan.guards.warning}</div>
          )}

          {plan.warnings.map((w, i) => (
            <div key={i} style={{
              padding: '8px 11px', borderRadius: 8, marginBottom: 5,
              background: C.raised, color: C.dim, fontSize: FS.micro, lineHeight: 1.55,
            }}>{w}</div>
          ))}

          {plan.orders.map((o, i) => {
            const done = sent.includes(o.label);
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 11px', marginBottom: 4, borderRadius: 8,
                background: C.raised,
                borderLeft: `2px solid ${o.side === 'BUY' ? C.up : C.down}`,
                opacity: done ? 0.55 : 1,
              }}>
                <span style={{ color: C.text, fontSize: FS.small, fontWeight: 600, minWidth: 0, flex: 1 }}>
                  {o.label}
                </span>
                <span style={o.guardedBy === 'EXCHANGE'
                  ? chip(C.dim) : chip(C.warn, C.warnBg)}>
                  {o.guardedBy === 'EXCHANGE' ? '거래소 보관' : '앱 감시'}
                </span>
                <span style={{ ...NUM, color: o.side === 'BUY' ? C.up : C.down, fontSize: FS.small, fontWeight: 700 }}>
                  {o.side === 'BUY' ? `$${fmtPrice(o.quoteUsd ?? 0)}` : `${fmtPrice(o.qty ?? 0, 6)}`}
                </span>
                {done && <span style={{ color: C.up, fontSize: FS.micro }}>전송됨</span>}
              </div>
            );
          })}

          {plan.ok && plan.orders.length > 0 && (
            <button onClick={execute} disabled={busy || !connId}
              style={{ ...primaryBtn(C.accent, busy || !connId), marginTop: 8 }}>
              {busy ? '보내는 중…' : `${plan.orders.length}건 주문 보내기`}
            </button>
          )}
          {!connId && (
            <div style={{ marginTop: 6, textAlign: 'center', color: C.faint, fontSize: FS.micro }}>
              거래소 연결이 없어 실행할 수 없습니다
            </div>
          )}
        </div>
      )}
    </div>
  );
});

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

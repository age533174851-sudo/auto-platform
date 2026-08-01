'use client';
// src/components/terminal/SpotOrderPanel.tsx
//
// 현물 주문판. **선물 주문판(OrderPane)과 별개 파일이다.**
//
// 왜 컴포넌트를 나눴나
// ────────────────────
// 하나의 폼에 `{isSpot ? … : …}`를 흩뿌리면, 그 조건 하나를 빠뜨린
// 자리에 레버리지 입력이 남는다. 사용자는 그것을 보고 10배를 걸었다고
// 믿지만 현물에는 레버리지가 없다. 반대로 선물에서 청산가가 사라지면
// 위험을 못 본다.
//
// 그래서 현물 화면에는 레버리지·청산가·마진모드·펀딩·reduceOnly가
// **존재하지 않는다.** 조건부로 숨기는 것이 아니라 코드에 없다.
//
// 색과 문구도 다르다
// ──────────────────
// 선물은 초록/빨강 'LONG 진입 / SHORT 진입', 현물은 'BTC 매수 / BTC 매도'.
// 두 화면이 같아 보이면 언젠가 현물인 줄 알고 선물 숏을 누른다.
import React, { memo, useEffect, useState } from 'react';
import { C, FS, NUM, fmtPrice, pnlColor, input, primaryBtn, ghostBtn } from './theme';
import { useTerminal } from './TerminalContext';
import { AccountLine } from './AccountLine';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';
import { capability, checkIntent } from '@/lib/markets/marketType';

interface SpotHolding {
  qty: number;
  avgPrice: number | null;
  realizedPnl: number;
  feePaid: number;
}

export const SpotOrderPanel = memo(function SpotOrderPanel({
  presetPrice, presetSeq, dense,
}: { presetPrice?: number | null; presetSeq?: number; dense?: boolean }) {
  const { symbol, auth, connections, mode, tradeMode, modeResolution } = useTerminal();
  const stream = useBinanceStream(symbol.id, true);
  const cap = capability('SPOT');

  // **모드가 정한 계좌를 쓴다.** 예전에는 컨텍스트의 connId를 그대로 썼는데,
  // 그 값은 모드(모의/테스트넷/실전)를 거치지 않은 '마지막에 고른 연결'이다.
  // 그래서 모의나 테스트넷 탭에 서 있어도 실전 키가 골라져 있으면 현물
  // 주문이 그 실계좌로 나갔다 — 화면에는 '모의'라고 적힌 채로.
  //
  // 선물 폼은 이미 modeResolution.connId를 쓰고 있었다. 같은 화면에서 두
  // 규칙이 도는 것이 문제였다.
  const connId = tradeMode === 'PAPER' ? '' : (modeResolution.connId || '');
  // 모의는 이 폼이 아직 못 한다. 조용히 실계좌로 보내지 않는다.
  const paperUnsupported = tradeMode === 'PAPER';

  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  // 현물 매수는 "얼마어치"가 더 자연스럽다. 매도는 "몇 개"다.
  const [unit, setUnit] = useState<'QUOTE' | 'BASE'>('QUOTE');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [usdt, setUsdt] = useState<number | null>(null);
  const [held, setHeld] = useState<SpotHolding | null>(null);

  const base = symbol.id.replace(/USDT$/, '');
  const mid = stream.lastPrice;

  useEffect(() => {
    if (presetPrice != null) { setOrderType('LIMIT'); setPrice(String(presetPrice)); }
    // presetSeq — 같은 가격을 다시 눌렀을 때도 반영한다 (usePickedPrice 주석)
  }, [presetPrice, presetSeq]);

  // 매도로 바꾸면 단위도 코인으로. 매도를 USDT로 받으면 "얼마어치 팔지"를
  // 계산해야 하는데, 그 계산 결과가 보유량을 넘으면 거부된다.
  useEffect(() => { if (side === 'SELL') setUnit('BASE'); }, [side]);

  // 현물 지갑 — 선물 계좌와 다른 엔드포인트다
  useEffect(() => {
    if (!auth || !connId) { setUsdt(null); setHeld(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/binance/spot/balance?connectionId=${connId}`,
          { headers: { Authorization: auth } });
        const j = await r.json();
        if (!alive) return;
        setUsdt(r.ok && j?.ok ? Number(j.availableUsdt) : null);
      } catch { if (alive) setUsdt(null); }

      try {
        const r = await fetch(
          `/api/binance/spot/trades?connectionId=${connId}&symbol=${symbol.id}`,
          { headers: { Authorization: auth } });
        const j = await r.json();
        if (!alive) return;
        setHeld(r.ok && j?.ok ? j.costBasis : null);
      } catch { if (alive) setHeld(null); }
    };
    load();
    const t = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, [auth, connId, symbol.id]);

  const px = Number(price) || mid || 0;
  const amt = Number(amount) || 0;
  const qtyToSend = unit === 'QUOTE' ? (px > 0 ? amt / px : 0) : amt;
  const costUsd = unit === 'QUOTE' ? amt : amt * px;

  // 주문 후 예상 보유량 — 현물에서 가장 알고 싶은 값이다
  const projectedQty = held == null ? null
    : side === 'BUY' ? held.qty + qtyToSend : held.qty - qtyToSend;

  const unrealized = held?.avgPrice != null && mid != null
    ? (mid - held.avgPrice) * held.qty : null;
  const unrealizedPct = held?.avgPrice != null && mid != null && held.avgPrice > 0
    ? ((mid - held.avgPrice) / held.avgPrice) * 100 : null;

  const setPct = (pct: number) => {
    if (side === 'BUY') {
      if (usdt == null) return;
      setUnit('QUOTE');
      setAmount(String(Number((usdt * pct / 100).toFixed(2))));
    } else {
      if (held == null) return;
      setUnit('BASE');
      setAmount(String(Number((held.qty * pct / 100).toFixed(8))));
    }
  };

  const submit = async () => {
    setMsg(null);
    if (!auth) { setMsg({ ok: false, text: '로그인이 필요합니다' }); return; }
    if (paperUnsupported) {
      setMsg({ ok: false, text: '모의 모드에서는 현물 주문을 아직 지원하지 않습니다 — 테스트넷/실전으로 바꾸거나 USDT-M을 쓰세요' });
      return;
    }
    if (!modeResolution.ok) { setMsg({ ok: false, text: modeResolution.reason || '이 모드에서 쓸 계좌가 없습니다' }); return; }
    if (!connId) { setMsg({ ok: false, text: '거래소 연결을 먼저 등록하세요' }); return; }
    if (amt <= 0) { setMsg({ ok: false, text: side === 'BUY' && unit === 'QUOTE' ? '금액을 입력하세요' : '수량을 입력하세요' }); return; }

    // 보내기 전에 같은 규칙으로 한 번 더 본다. 서버도 검사하지만,
    // 여기서 막으면 사용자가 즉시 이유를 안다.
    const pre = checkIntent({
      market: 'SPOT', side, quantity: qtyToSend || 1,
      heldQty: side === 'SELL' ? (held?.qty ?? null) : undefined,
    });
    if (!pre.ok) { setMsg({ ok: false, text: pre.reason! }); return; }

    setBusy(true);
    try {
      const byQuote = side === 'BUY' && orderType === 'MARKET' && unit === 'QUOTE';
      const r = await fetch(cap.orderEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          connectionId: connId,
          // 선물과 다른 토큰이다. 같으면 엔드포인트만 바꿔도 통과한다.
          confirmToken: 'SPOT_ORDER_CONFIRMED',
          symbol: symbol.id, side, type: orderType,
          ...(byQuote ? { quoteOrderQty: amt } : { quantity: qtyToSend }),
          ...(orderType === 'LIMIT' ? { price: px } : {}),
        }),
      });
      const j = await r.json();
      if (r.ok && j?.ok) {
        setMsg({ ok: true, text: `${j.message} · ${fmtPrice(j.filledQty ?? 0, 6)} ${base}` });
        setAmount('');
      } else {
        setMsg({ ok: false, text: j?.message || j?.error || `실패 (${r.status})` });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: `응답 없음 — 재시도 말고 현물 내역을 먼저 확인하세요 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  const pad = dense ? 8 : 12;
  const gap = dense ? 6 : 10;
  const inp: React.CSSProperties = {
    ...input, padding: dense ? '7px 9px' : '10px 12px', fontSize: dense ? FS.small : FS.body,
  };

  return (
    <div style={{ padding: pad, display: 'flex', flexDirection: 'column', gap }}>
      {/* 어느 계좌로 나가는가. 선물 폼과 **같은 줄**을 쓴다 —
          여기만 없으면 현물 탭에서는 계좌를 확인할 수도 바꿀 수도 없다. */}
      <AccountLine/>
      {paperUnsupported && (
        <div style={{
          padding: '6px 8px', borderRadius: 7, background: C.warnBg,
          color: C.warn, fontSize: FS.micro, lineHeight: 1.5,
        }}>
          모의 모드에서는 현물 주문을 아직 지원하지 않습니다. 이 상태로는 주문이 나가지 않습니다.
        </div>
      )}

      {/* 현물임을 화면에서 먼저 말한다. 선물 폼과 착각하면 안 된다. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        minHeight: 26, borderRadius: 7, background: C.raised,
        border: `1px solid ${C.hair}`, color: C.dim, fontSize: FS.micro, fontWeight: 600,
      }}>
        현물 · 레버리지 없음
      </div>

      <div style={{ display: 'flex', gap: 4, background: C.raised, padding: 3, borderRadius: 8 }}>
        {(['BUY', 'SELL'] as const).map(s => (
          <button key={s} onClick={() => setSide(s)} style={{
            flex: 1, minHeight: dense ? 32 : 38, border: 'none', borderRadius: 6, cursor: 'pointer',
            background: side === s ? (s === 'BUY' ? C.up : C.down) : 'transparent',
            color: side === s ? '#fff' : (s === 'BUY' ? C.up : C.down),
            fontSize: dense ? FS.small : FS.body, fontWeight: 700,
          }}>{s === 'BUY' ? '매수' : '매도'}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        {(['MARKET', 'LIMIT'] as const).map(t => (
          <button key={t} onClick={() => setOrderType(t)} style={{
            ...ghostBtn(orderType === t), flex: 1,
            padding: dense ? '5px 8px' : '6px 10px', fontSize: FS.micro,
          }}>{t === 'MARKET' ? '시장가' : '지정가'}</button>
        ))}
      </div>

      {orderType === 'LIMIT' && (
        <input value={price} onChange={e => setPrice(e.target.value)}
          placeholder={mid ? `가격 ${fmtPrice(mid)}` : '가격'} inputMode="decimal" style={inp}/>
      )}

      {/* 매수는 USDT 금액이 자연스럽고, 매도는 코인 수량이 자연스럽다 */}
      {side === 'BUY' && orderType === 'MARKET' && (
        <div style={{ display: 'flex', gap: 4 }}>
          {(['QUOTE', 'BASE'] as const).map(u => (
            <button key={u} onClick={() => setUnit(u)} style={{
              ...ghostBtn(unit === u), flex: 1, padding: '4px 8px', fontSize: FS.micro,
            }}>{u === 'QUOTE' ? 'USDT 금액' : `${base} 수량`}</button>
          ))}
        </div>
      )}

      <input value={amount} onChange={e => setAmount(e.target.value)}
        placeholder={unit === 'QUOTE' ? '금액 (USDT)' : `수량 (${base})`}
        inputMode="decimal" style={inp}/>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4 }}>
        {[25, 50, 75, 100].map(pct => {
          const disabled = side === 'BUY' ? usdt == null : held == null;
          return (
            <button key={pct} onClick={() => setPct(pct)} disabled={disabled}
              title={disabled ? (side === 'BUY' ? '현물 USDT 잔고를 받지 못했습니다' : '보유 수량을 받지 못했습니다') : undefined}
              style={{
                minHeight: 26, borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
                background: C.raised, color: disabled ? C.faint : C.dim,
                border: `1px solid ${C.hair}`, fontSize: FS.micro, fontWeight: 600,
                opacity: disabled ? 0.5 : 1, ...NUM,
              }}>{pct}%</button>
          );
        })}
      </div>

      {/* 현물에서 봐야 하는 값들. 청산가·증거금이 아니다. */}
      <div style={{
        background: C.raised, borderRadius: 8, padding: dense ? '8px 10px' : '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 4, fontSize: FS.micro,
      }}>
        <KV k="사용 가능 USDT" v={usdt == null ? '확인 불가' : `$${fmtPrice(usdt)}`}
            warn={usdt == null}/>
        <KV k={`보유 ${base}`} v={held == null ? '확인 불가' : fmtPrice(held.qty, 6)}
            warn={held == null}/>
        <KV k="평균 매수가"
            v={held?.avgPrice == null ? '—' : fmtPrice(held.avgPrice)}/>
        <KV k="평가 손익"
            v={unrealized == null ? '—'
              : `${unrealized >= 0 ? '+' : ''}$${fmtPrice(unrealized)}` +
                (unrealizedPct != null ? ` (${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(2)}%)` : '')}
            color={pnlColor(unrealized)}/>
        <div style={{ height: 1, background: C.hair, margin: '2px 0' }}/>
        <KV k="주문 금액" v={costUsd > 0 ? `$${fmtPrice(costUsd)}` : '—'}/>
        <KV k="주문 후 보유"
            v={projectedQty == null ? '—' : `${fmtPrice(projectedQty, 6)} ${base}`}
            color={projectedQty != null && projectedQty < 0 ? C.down : undefined}/>
      </div>

      <button onClick={submit} disabled={busy}
        style={{ ...primaryBtn(side === 'BUY' ? C.up : C.down, busy), minHeight: 44 }}>
        {busy ? '전송 중…' : (side === 'BUY' ? cap.buyLabel(base) : cap.sellLabel(base))}
      </button>

      <div style={{
        textAlign: 'center', fontSize: FS.micro, lineHeight: 1.45,
        color: mode.unknown ? C.warn : mode.realMoney ? C.down : C.faint,
      }}>
        {mode.unknown ? '운영 모드 확인 불가'
          : mode.realMoney ? '실제 자금이 사용됩니다'
          : '모의 · 실제 자금 아님'}
      </div>

      {msg && (
        <div style={{
          padding: '8px 10px', borderRadius: 8, fontSize: FS.micro, lineHeight: 1.5,
          color: msg.ok ? C.up : C.down, background: msg.ok ? C.upBg : C.downBg,
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

function KV({ k, v, color, warn }: { k: string; v: string; color?: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: C.faint, whiteSpace: 'nowrap' }}>{k}</span>
      <span style={{
        ...NUM, color: color ?? (warn ? C.warn : C.text),
        fontWeight: 600, whiteSpace: 'nowrap',
      }}>{v}</span>
    </div>
  );
}

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
import React, { memo, useEffect, useMemo, useState } from 'react';
import { C, FS, NUM, fmtPrice, pnlColor, input, primaryBtn, ghostBtn, chip } from './theme';
import { DataBadge } from '@/components/ui/DataBadge';
import { useBinanceStream, bookImbalance, type StreamState } from '@/lib/hooks/useBinanceStream';
import { useTerminal } from './TerminalContext';
import { SpotOrderPanel } from './SpotOrderPanel';
import { canOpenFutures, type WalletTree } from '@/lib/markets/wallets';

const LEVERAGES = [1, 3, 5, 10, 20, 50, 75, 100];

/**
 * 펀딩비와 다음 정산까지 남은 시간.
 *
 * 23시간 30분을 들고 있는 전략이라 펀딩을 세 번 낸다. 진입 전에
 * 이 값을 못 보면 수수료를 모르고 들어가는 것과 같다.
 * 30초 주기면 충분하다 — 8시간마다 바뀌는 값이다.
 */
export function useFunding(symbol: string) {
  const [d, setD] = React.useState<{ rate: number | null; nextAt: number | null }>({
    rate: null, nextAt: null,
  });
  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
        if (!r.ok || !alive) return;
        const j = await r.json();
        const rate = parseFloat(j?.lastFundingRate);
        const nextAt = Number(j?.nextFundingTime);
        setD({
          rate: Number.isFinite(rate) ? rate * 100 : null,
          nextAt: Number.isFinite(nextAt) && nextAt > 0 ? nextAt : null,
        });
      } catch { /* 다음 주기에 다시 */ }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [symbol]);
  return d;
}

/** 다음 정산까지 남은 시간을 1초마다 다시 센다 */
export function useCountdown(nextAt: number | null): string {
  const [txt, setTxt] = React.useState('—');
  React.useEffect(() => {
    if (!nextAt) { setTxt('—'); return; }
    const tick = () => {
      const ms = nextAt - Date.now();
      if (ms <= 0) { setTxt('00:00:00'); return; }
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      const sec = Math.floor((ms % 60_000) / 1000);
      setTxt(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [nextAt]);
  return txt;
}
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
  rows = 9, onPickPrice, showFunding, dense,
}: {
  rows?: number;
  onPickPrice?: (p: number) => void;
  /** 펀딩비·다음 정산 카운트다운을 위에 붙인다 */
  showFunding?: boolean;
  /** 좁은 열에 들어갈 때 — 글자와 여백을 줄인다 */
  dense?: boolean;
}) {
  const { symbol } = useTerminal();
  const stream = useBinanceStream(symbol.id, true);
  const live = stream.status === 'live' && !stream.stale;
  const funding = useFunding(showFunding ? symbol.id : '');
  const countdown = useCountdown(funding.nextAt);

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
        padding: dense ? '1px 8px' : '1px 12px', cursor: onPickPrice ? 'pointer' : 'default',
        overflow: 'hidden', ...NUM, fontSize: dense ? FS.micro : FS.small,
        lineHeight: dense ? 1.85 : 1.75,
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
      {showFunding && (
        <div style={{
          padding: dense ? '6px 8px' : '8px 12px',
          borderBottom: `1px solid ${C.hair}`,
        }}>
          <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 2 }}>
            펀딩 (8h) · 다음 정산
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
            {/* 펀딩은 못 받으면 '—'다. 0%로 적으면 "무료"로 읽힌다. */}
            <span style={{
              ...NUM, fontSize: FS.small, fontWeight: 700,
              color: funding.rate == null ? C.faint : funding.rate >= 0 ? C.down : C.up,
            }}>{funding.rate == null ? '—' : `${funding.rate.toFixed(4)}%`}</span>
            <span style={{ ...NUM, color: C.dim, fontSize: FS.micro }}>{countdown}</span>
          </div>
        </div>
      )}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: dense ? '6px 8px 4px' : '7px 12px 5px', fontSize: FS.micro, color: C.faint,
      }}>
        <span>가격</span>
        <DataBadge compact source={{
          kind: live ? 'REALTIME' : 'UNAVAILABLE',
          origin: dense ? '' : 'Binance', asOf: stream.depthAt, expectedIntervalMs: 100,
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
            padding: dense ? '6px 8px' : '7px 12px', margin: '2px 0',
            borderTop: `1px solid ${C.hair}`, borderBottom: `1px solid ${C.hair}`,
          }}>
            <span style={{
              ...NUM, color: pnlColor(stream.changePct),
              fontSize: dense ? 15 : 19, fontWeight: 700,
            }}>{fmtPrice(mid)}</span>
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
        <div style={{ padding: dense ? '8px 8px 10px' : '10px 12px 12px' }}>
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
//
// 좁은 칸(dense)에서는 구성을 바꾼다. 줄이는 것이 아니라 빼는 것이다.
//  - 배율 8개 격자(두 줄) → 칩 하나 + 시트. 배율은 자주 안 바꾼다.
//  - 명목가·증거금 상자 → 한 줄
//  - 주문 버튼은 그대로 크게. 여기서 아낀 자리를 그쪽에 쓴다.
// 목표는 375×812에서 **스크롤 없이** 주문까지 닿는 것이다.
export const OrderFormPanel = memo(function OrderFormPanel({
  presetPrice, dense,
}: {
  presetPrice?: number | null;
  /** 모바일 2열의 좁은 칸에 들어갈 때 */
  dense?: boolean;
}) {
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
  const [levOpen, setLevOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [wallet, setWallet] = useState<WalletTree | null>(null);

  // 호가를 눌러 들어온 가격
  useEffect(() => {
    if (presetPrice != null) { setOrderType('LIMIT'); setPrice(String(presetPrice)); }
  }, [presetPrice]);

  // ── 지갑 ──
  // 선물 계좌만 따로 부르지 않고 통합 트리를 받는다. 그래야 증거금이
  // 모자랄 때 "현물에 얼마 있으니 이체하라"까지 말해줄 수 있다.
  // 물론 현물 잔고가 가용 증거금에 더해지지는 않는다 (lib/markets/wallets.ts).
  useEffect(() => {
    if (!auth || !connId) { setWallet(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/wallets?connectionId=${connId}`, { headers: { Authorization: auth } });
        const j = await r.json();
        if (!alive) return;
        setWallet(r.ok && j?.ok ? j.tree : null);
      } catch { if (alive) setWallet(null); }
    };
    load();
    const t = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, [auth, connId]);

  // 비율 버튼은 **선물 가용 증거금**만 쓴다. 현물 USDT를 쓰면 없는 돈으로
  // 수량을 계산하게 되고, 그 수량이 그대로 주문이 된다.
  const balanceUsd = wallet?.futuresUsableMargin ?? null;

  const mid = stream.lastPrice;
  const notional = (Number(qty) || 0) * (Number(price) || mid || 0);
  const margin = leverage > 0 ? notional / leverage : 0;
  const liqPct = roughLiqDistancePct(leverage);
  const liqTone = liqPct < 1 ? C.down : liqPct < 3 ? C.warn : C.dim;
  const base = symbol.id.replace(/USDT$/, '');

  const pickLev = (v: number) => {
    setLeverage(v);
    setLevOpen(false);
    try { localStorage.setItem(LEV_KEY, String(v)); } catch {}
  };

  const setPct = (pct: number) => {
    const px = Number(price) || mid || 0;
    // 잔고를 모르면 비율 계산이 불가능하다. 임의 값으로 채우지 않는다.
    if (px <= 0 || balanceUsd == null) return;
    const q = (balanceUsd * (pct / 100) * leverage) / px;
    setQty(q > 0 ? String(Number(q.toFixed(6))) : '');
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
      if (r.ok && j?.ok) setMsg({ ok: true, text: `주문 접수됨 · ${String(j.jobId).slice(0, 8)}` });
      else setMsg({ ok: false, text: j?.message || j?.error || `실패 (${r.status})` });
    } catch (e: any) {
      // 응답을 못 받았다. 나갔는지 안 나갔는지 모르는 상태다.
      setMsg({ ok: false, text: `응답 없음 — 재시도 말고 포지션 먼저 확인 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  const pad = dense ? 8 : 12;
  const gap = dense ? 6 : 12;
  const inputStyle: React.CSSProperties = {
    ...input, padding: dense ? '7px 9px' : '10px 12px', fontSize: dense ? FS.small : FS.body,
  };

  return (
    <div style={{ padding: pad, display: 'flex', flexDirection: 'column', gap, position: 'relative' }}>
      {/* 격리·배율 — 자주 안 바꾸는 값이라 칩 하나로 접는다 */}
      <div style={{ display: 'flex', gap: 5 }}>
        <span style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          minHeight: 30, borderRadius: 7, background: C.raised,
          border: `1px solid ${C.hair}`, color: C.dim,
          fontSize: FS.micro, fontWeight: 600,
        }}>격리</span>
        <button onClick={() => setLevOpen(v => !v)} style={{
          flex: 1, minHeight: 30, borderRadius: 7, cursor: 'pointer',
          background: leverage >= 50 ? C.downBg : C.raised,
          border: `1px solid ${leverage >= 50 ? C.down + '55' : C.hair}`,
          color: leverage >= 50 ? C.down : C.text,
          fontSize: FS.small, fontWeight: 700, ...NUM,
        }}>{leverage}×</button>
      </div>

      {/* 이 배율에서 청산까지 얼마나 가까운지. 배율 숫자만으로는 위험이 안 읽힌다. */}
      <div style={{ ...NUM, color: liqTone, fontSize: FS.micro, fontWeight: 600, marginTop: -2 }}>
        청산 약 {liqPct.toFixed(2)}% 이내
      </div>

      <div style={{ display: 'flex', gap: 4, background: C.raised, padding: 3, borderRadius: 8 }}>
        {(['BUY', 'SELL'] as const).map(s => (
          <button key={s} onClick={() => setSide(s)} style={{
            flex: 1, minHeight: dense ? 32 : 38, border: 'none', borderRadius: 6, cursor: 'pointer',
            background: side === s ? (s === 'BUY' ? C.up : C.down) : 'transparent',
            color: side === s ? '#fff' : (s === 'BUY' ? C.up : C.down),
            fontSize: dense ? FS.small : FS.body, fontWeight: 700, transition: 'background .12s',
          }}>{s === 'BUY' ? '롱' : '숏'}</button>
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
          placeholder={mid ? `가격 ${fmtPrice(mid)}` : '가격'} inputMode="decimal" style={inputStyle}/>
      )}

      <input value={qty} onChange={e => setQty(e.target.value)}
        placeholder={`수량 (${base})`} inputMode="decimal" style={inputStyle}/>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4 }}>
        {[25, 50, 75, 100].map(pct => (
          <button key={pct} onClick={() => setPct(pct)}
            disabled={balanceUsd == null}
            title={balanceUsd == null ? '잔고를 받지 못해 비율 계산을 할 수 없습니다' : undefined}
            style={{
              minHeight: 26, borderRadius: 6, cursor: balanceUsd == null ? 'default' : 'pointer',
              background: C.raised, color: balanceUsd == null ? C.faint : C.dim,
              border: `1px solid ${C.hair}`, fontSize: FS.micro, fontWeight: 600,
              opacity: balanceUsd == null ? 0.5 : 1, ...NUM,
            }}>{pct}%</button>
        ))}
      </div>

      {/* 증거금이 모자라면 주문 전에 말한다. 거래소가 거부한 뒤에
          알려주면 사용자는 이미 그 크기를 믿고 계획을 세운 뒤다. */}
      {(() => {
        if (!wallet || margin <= 0) return null;
        const chk = canOpenFutures(wallet, margin);
        if (chk.ok) return null;
        return (
          <div style={{
            padding: '7px 9px', borderRadius: 7, background: C.warnBg,
            color: C.warn, fontSize: FS.micro, lineHeight: 1.5,
          }}>{chk.reason}</div>
        );
      })()}

      {/* 상자 대신 한 줄. 두 값 다 보이되 자리는 한 줄만 먹는다. */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', gap: 4,
        fontSize: FS.micro, color: C.faint, whiteSpace: 'nowrap', ...NUM,
      }}>
        <span>증거금 <b style={{ color: C.dim, fontWeight: 600 }}>
          {margin > 0 ? `$${fmtPrice(margin)}` : '—'}</b></span>
        <span>명목 <b style={{ color: C.dim, fontWeight: 600 }}>
          {notional > 0 ? `$${fmtPrice(notional)}` : '—'}</b></span>
      </div>

      {/* 여기서 아낀 자리를 주문 버튼에 쓴다 */}
      <button onClick={submit} disabled={busy}
        style={{ ...primaryBtn(side === 'BUY' ? C.up : C.down, busy), minHeight: 44 }}>
        {busy ? '전송 중…' : `${base} ${side === 'BUY' ? '롱' : '숏'} ${leverage}× 주문`}
      </button>

      {/* 실자금 여부는 버튼 바로 아래에. 상단 점만으로는 부족하다. */}
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

      {/* 배율 선택 — 칩을 누르면 그 자리에 덮는다 */}
      {levOpen && (
        <>
          <div onClick={() => setLevOpen(false)}
               style={{ position: 'fixed', inset: 0, zIndex: 40 }}/>
          <div style={{
            position: 'absolute', top: pad + 34, left: pad, right: pad, zIndex: 41,
            background: C.raised, border: `1px solid ${C.hair2}`, borderRadius: 10,
            boxShadow: '0 12px 32px rgba(0,0,0,.6)', padding: 10,
          }}>
            <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 7 }}>레버리지</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5 }}>
              {LEVERAGES.map(v => {
                const on = leverage === v;
                const risky = v >= 50;
                return (
                  <button key={v} onClick={() => pickLev(v)} style={{
                    minHeight: 34, borderRadius: 7, cursor: 'pointer',
                    background: on ? (risky ? C.down : C.accent) : C.panel,
                    color: on ? '#fff' : risky ? C.warn : C.dim,
                    border: `1px solid ${on ? 'transparent' : C.hair}`,
                    fontSize: FS.small, fontWeight: 700, ...NUM,
                  }}>{v}×</button>
                );
              })}
            </div>
            <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 8, lineHeight: 1.5 }}>
              청산 거리는 유지증거금을 뺀 근사치입니다. 실제 청산은 이보다 가깝습니다.
            </div>
          </div>
        </>
      )}
    </div>
  );
});

/**
 * 시장 유형에 맞는 주문판을 고른다.
 *
 * 조건부 렌더가 아니라 **컴포넌트 교체**다. 현물이 선택되면 선물 폼은
 * 아예 마운트되지 않으므로, 레버리지 입력이 화면 어딘가에 남아 있을
 * 가능성 자체가 없다.
 */
export const MarketOrderPanel = memo(function MarketOrderPanel(
  props: { presetPrice?: number | null; dense?: boolean },
) {
  const { marketType } = useTerminal();
  if (marketType === 'SPOT') return <SpotOrderPanel {...props}/>;
  // COIN-M은 아직 주문 경로가 없다. 없는 것을 있는 것처럼 보여주지 않는다.
  if (marketType === 'COIN_FUTURES') {
    return (
      <div style={{ padding: 16, color: C.warn, fontSize: FS.small, lineHeight: 1.6 }}>
        COIN-M 선물은 아직 주문을 지원하지 않습니다.
        <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 6 }}>
          USDⓈ-M 선물이나 현물로 전환하세요.
        </div>
      </div>
    );
  }
  return <OrderFormPanel {...props}/>;
});

// ══ PC 우측 열 — 둘을 쌓는다 ═══════════════════════════
export const OrderPane = memo(function OrderPane() {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      <OrderBookPanel onPickPrice={setPicked}/>
      <div style={{ borderTop: `1px solid ${C.hair}` }}/>
      <MarketOrderPanel presetPrice={picked}/>
    </div>
  );
});

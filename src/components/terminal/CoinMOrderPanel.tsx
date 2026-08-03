'use client';
import { A } from '@/lib/theme/colors';
import { errorTextOf } from '@/lib/http/errorText';
// src/components/terminal/CoinMOrderPanel.tsx
//
// COIN-M 주문판. 현물·USDⓈ-M과 별개 파일이다.
//
// 이 화면이 반드시 해야 하는 일
// ─────────────────────────────
// **수량이 계약이라는 것을 숨기지 않는다.** 다른 시장에서 온 사용자는
// 0.5를 넣으며 "0.5 BTC"를 생각한다. COIN-M에서 그건 0.5계약이고,
// 소수 계약은 거부된다. 운이 나쁘면 3을 넣고 "0.003 BTC"를 생각했는데
// 300 USD가 나간다.
//
// 그래서
//  - 입력 단위를 '계약'과 'USD 금액' 중에 고르게 하고
//  - 고른 즉시 "= 몇 계약 = 몇 USD = 몇 BTC"를 전부 보여주고
//  - 증거금은 **코인 단위**로 적는다 (COIN-M 지갑에는 USDT가 없다)
import React, { memo, useEffect, useState } from 'react';
import { C, FS, NUM, chip, ghostBtn, primaryBtn, input, fmtPrice, pnlColor } from './theme';
import { useTerminal } from './TerminalContext';
import { AccountLine } from './AccountLine';
import {
  isCoinMSymbol, baseAssetOf, resolveContractSize, notionalToContracts,
  contractsToCoin, requiredMarginCoin, inverseLiquidationPrice,
  TYPICAL_ALT_CONTRACT_USD,
} from '@/lib/markets/coinM';

const LEVERAGES = [1, 3, 5, 10, 20, 50, 75, 100];

// 손절 폭 후보. 역방향 계약이라 **가격 기준 퍼센트**다 (코인 수량이 아니다).
//
// 기본값을 두는 이유: 예전 이 화면은 손절을 아예 보내지 않았고, 서버도 붙이지
// 않았다. 이제 서버가 손절 없는 진입을 거부하므로, 값이 없으면 버튼이 죽는다.
// 기본값을 두더라도 **결과 가격을 화면에 적기** 때문에 숨겨지지 않는다.
const SL_PCTS = [1, 2, 3, 5, 10];

/** USDⓈ-M 심볼을 COIN-M 무기한으로 바꾼다. BTCUSDT → BTCUSD_PERP */
function toCoinMSymbol(usdtSymbol: string): string {
  const base = usdtSymbol.replace(/USDT$/, '');
  return `${base}USD_PERP`;
}

export const CoinMOrderPanel = memo(function CoinMOrderPanel({ dense }: { dense?: boolean }) {
  const { symbol, auth, connections, mode, tradeMode, modeResolution } = useTerminal();

  // 선물 폼과 **같은 규칙**으로 계좌를 정한다. 예전에는 컨텍스트의 connId를
  // 그대로 썼는데 그 값은 모드를 거치지 않은 '마지막에 고른 연결'이라,
  // 모의·테스트넷 탭에 서 있어도 실전 키가 골라져 있으면 COIN-M 주문이
  // 그 실계좌로 나갔다.
  const connId = tradeMode === 'PAPER' ? '' : (modeResolution.connId || '');
  const paperUnsupported = tradeMode === 'PAPER';
  const cmSymbol = toCoinMSymbol(symbol.id);
  const base = baseAssetOf(cmSymbol) ?? symbol.id.replace(/USDT$/, '');

  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [unit, setUnit] = useState<'CONTRACTS' | 'USD'>('USD');
  const [amount, setAmount] = useState('');
  const [leverage, setLeverage] = useState(5);
  const [levOpen, setLevOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [slPct, setSlPct] = useState(2);
  const [contractUsd, setContractUsd] = useState<number | null>(null);
  const [contractSource, setContractSource] = useState<'exchange' | 'known' | null>(null);
  const [markPrice, setMarkPrice] = useState<number | null>(null);

  // 계약 크기와 Mark Price. 둘 다 없으면 계산을 하지 않는다.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`https://dapi.binance.com/dapi/v1/exchangeInfo`);
        if (r.ok && alive) {
          const d = await r.json();
          const s = (d.symbols || []).find((x: any) => String(x.symbol) === cmSymbol);
          const spec = resolveContractSize(cmSymbol, Number(s?.contractSize));
          setContractUsd(spec?.contractUsd ?? null);
          setContractSource(spec?.source ?? null);
        }
      } catch { if (alive) { setContractUsd(null); setContractSource(null); } }

      try {
        const r = await fetch(`https://dapi.binance.com/dapi/v1/premiumIndex?symbol=${cmSymbol}`);
        if (r.ok && alive) {
          const d = await r.json();
          const row = Array.isArray(d) ? d[0] : d;
          const v = parseFloat(row?.markPrice);
          setMarkPrice(Number.isFinite(v) ? v : null);
        }
      } catch { if (alive) setMarkPrice(null); }
    })();
    return () => { alive = false; };
  }, [cmSymbol]);

  const amt = Number(amount) || 0;
  const conv = contractUsd != null && unit === 'USD' && amt > 0
    ? notionalToContracts(amt, contractUsd) : null;
  const contracts = unit === 'CONTRACTS' ? Math.floor(amt) : (conv?.contracts ?? 0);
  const notionalUsd = contractUsd != null ? contracts * contractUsd : null;
  const coinQty = contractUsd != null && markPrice != null
    ? contractsToCoin(contracts, contractUsd, markPrice) : null;
  const margin = contractUsd != null && markPrice != null && contracts > 0
    ? requiredMarginCoin(contracts, contractUsd, markPrice, leverage) : null;
  const liq = markPrice != null
    ? inverseLiquidationPrice(markPrice, leverage, side === 'BUY' ? 'LONG' : 'SHORT') : null;

  // 손절가. 마크가를 모르면 만들지 않는다 — 그러면 주문할 수 없고, 그게 맞다.
  const stopPrice = markPrice != null
    ? (side === 'BUY' ? markPrice * (1 - slPct / 100) : markPrice * (1 + slPct / 100))
    : null;

  // 손절이 청산 너머면 그 손절은 작동할 기회가 없다. 배율이 높을수록 청산이
  // 가까워지므로(100배면 1% 남짓) 이 조합이 실제로 자주 나온다.
  // 서버도 같은 것을 막지만, 보내기 전에 여기서 알려주는 편이 낫다.
  const stopBeyondLiq = stopPrice != null && liq != null
    && (side === 'BUY' ? stopPrice <= liq : stopPrice >= liq);

  const blocked = contracts <= 0 || stopPrice == null || stopBeyondLiq;

  const submit = async () => {
    setMsg(null);
    if (!auth) { setMsg({ ok: false, text: '로그인이 필요합니다' }); return; }
    if (paperUnsupported) {
      setMsg({ ok: false, text: '모의 모드에서는 COIN-M 주문을 아직 지원하지 않습니다 — 테스트넷/실전으로 바꾸거나 USDT-M을 쓰세요' });
      return;
    }
    if (!modeResolution.ok) { setMsg({ ok: false, text: modeResolution.reason || '이 모드에서 쓸 계좌가 없습니다' }); return; }
    if (!connId) { setMsg({ ok: false, text: '거래소 연결을 먼저 등록하세요' }); return; }
    if (contracts <= 0) { setMsg({ ok: false, text: '계약 수가 0입니다' }); return; }
    if (stopPrice == null) {
      setMsg({ ok: false, text: '마크가를 읽지 못해 손절가를 만들 수 없습니다 — 손절 없이 진입하지 않습니다' });
      return;
    }
    if (stopBeyondLiq) {
      setMsg({ ok: false, text: '손절이 청산가 너머입니다. 배율을 낮추거나 손절 폭을 줄이세요' });
      return;
    }

    setBusy(true);
    try {
      const r = await fetch('/api/binance/coinm/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          connectionId: connId,
          // 현물·USDⓈ-M과 다른 토큰이다
          confirmToken: 'COINM_ORDER_CONFIRMED',
          symbol: cmSymbol, side, type: 'MARKET',
          contracts, leverage,
          // 퍼센트가 아니라 **가격**을 보낸다. 서버가 자기 마크가로 다시
          // 계산하면 화면에 보여준 값과 다른 손절이 걸린다.
          stopPrice,
        }),
      });
      const j = await r.json();
      if (r.ok && j?.ok) {
        setMsg({ ok: true, text: `${j.message}${j.conversionNote ? ` · ${j.conversionNote}` : ''}` });
        setAmount('');
      } else {
        setMsg({ ok: false, text: errorTextOf(j, `실패 (${r.status})`) });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: `응답 없음 — 재시도 말고 COIN-M 내역을 먼저 확인하세요 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  const pad = dense ? 8 : 12;
  const inp: React.CSSProperties = {
    ...input, padding: dense ? '7px 9px' : '10px 12px', fontSize: dense ? FS.small : FS.body,
  };

  // 계약 크기를 모르면 아무 계산도 못 한다 — 추측해서 주문하지 않는다
  if (contractUsd == null) {
    return (
      <div style={{ padding: pad }}>
        <div style={{
          padding: '11px 13px', borderRadius: 9, background: C.warnBg,
          color: C.warn, fontSize: FS.small, lineHeight: 1.6,
        }}>
          {cmSymbol}의 계약 크기를 확인하지 못했습니다.
          <div style={{ color: C.dim, fontSize: FS.micro, marginTop: 5 }}>
            COIN-M은 1계약이 몇 USD인지 모르면 주문 크기를 계산할 수 없습니다
            (BTC는 100 USD, 알트는 대개 {TYPICAL_ALT_CONTRACT_USD} USD).
            추측해서 주문하지 않습니다.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: pad, display: 'flex', flexDirection: 'column', gap: dense ? 6 : 10, position: 'relative' }}>
      {/* 어느 계좌로 나가는가 — 세 주문판이 같은 줄을 쓴다 */}
      <AccountLine/>
      {paperUnsupported && (
        <div style={{
          padding: '6px 8px', borderRadius: 7, background: C.warnBg,
          color: C.warn, fontSize: FS.micro, lineHeight: 1.5,
        }}>
          모의 모드에서는 COIN-M 주문을 아직 지원하지 않습니다. 이 상태로는 주문이 나가지 않습니다.
        </div>
      )}

      {/* 이 시장이 무엇인지, 단위가 무엇인지 먼저 말한다 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        minHeight: 26, borderRadius: 7, background: C.raised,
        border: `1px solid ${C.hair}`, color: C.dim, fontSize: FS.micro, fontWeight: 600,
      }}>
        {cmSymbol} · 1계약 = {contractUsd} USD
        {contractSource === 'known' && (
          <span style={{ color: C.faint }}>(내장값)</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 5 }}>
        <span style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          minHeight: 30, borderRadius: 7, background: C.raised,
          border: `1px solid ${C.hair}`, color: C.dim, fontSize: FS.micro, fontWeight: 600,
        }}>격리</span>
        <button onClick={() => setLevOpen(v => !v)} style={{
          flex: 1, minHeight: 30, borderRadius: 7, cursor: 'pointer',
          background: leverage >= 50 ? C.downBg : C.raised,
          border: `1px solid ${leverage >= 50 ? A(C.down,'55') : C.hair}`,
          color: leverage >= 50 ? C.down : C.text,
          fontSize: FS.small, fontWeight: 700, ...NUM,
        }}>{leverage}×</button>
      </div>

      <div style={{ display: 'flex', gap: 4, background: C.raised, padding: 3, borderRadius: 8 }}>
        {(['BUY', 'SELL'] as const).map(s => (
          <button key={s} onClick={() => setSide(s)} style={{
            flex: 1, minHeight: dense ? 32 : 38, border: 'none', borderRadius: 6, cursor: 'pointer',
            background: side === s ? (s === 'BUY' ? C.up : C.down) : 'transparent',
            color: side === s ? '#fff' : (s === 'BUY' ? C.up : C.down),
            fontSize: dense ? FS.small : FS.body, fontWeight: 700,
          }}>{s === 'BUY' ? 'LONG 진입' : 'SHORT 진입'}</button>
        ))}
      </div>

      {/* 입력 단위를 명시적으로 고르게 한다. 이게 이 화면의 핵심이다. */}
      <div style={{ display: 'flex', gap: 4 }}>
        {([['USD', 'USD 금액'], ['CONTRACTS', '계약 수']] as const).map(([u, l]) => (
          <button key={u} onClick={() => { setUnit(u); setAmount(''); }}
            style={{ ...ghostBtn(unit === u), flex: 1, fontSize: FS.micro }}>{l}</button>
        ))}
      </div>

      <input value={amount} onChange={e => setAmount(e.target.value)}
        placeholder={unit === 'USD' ? '금액 (USD)' : '계약 수 (정수)'}
        inputMode={unit === 'USD' ? 'decimal' : 'numeric'} style={inp}/>

      {/* 손절. 이 화면에서 뺄 수 없는 항목이다 — 서버가 손절 없는 진입을 거부한다 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ color: C.faint, fontSize: FS.micro, minWidth: 26 }}>손절</span>
        {SL_PCTS.map(p => (
          <button key={p} onClick={() => setSlPct(p)}
            style={{ ...ghostBtn(slPct === p), flex: 1, fontSize: FS.micro, ...NUM }}>
            {p}%
          </button>
        ))}
      </div>

      {/* 세 단위를 동시에 보여준다. 하나만 보이면 착각이 안 잡힌다. */}
      <div style={{
        background: C.raised, borderRadius: 8, padding: dense ? '8px 10px' : '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 4, fontSize: FS.micro,
      }}>
        <KV k="계약 수" v={contracts > 0 ? `${contracts}계약` : '—'}
            warn={unit === 'CONTRACTS' && amt > 0 && !Number.isInteger(amt)}/>
        <KV k="명목가" v={notionalUsd ? `$${fmtPrice(notionalUsd)}` : '—'}/>
        <KV k={`≈ ${base}`} v={coinQty != null ? fmtPrice(coinQty, 6) : '—'}/>
        <div style={{ height: 1, background: C.hair, margin: '2px 0' }}/>
        {/* 증거금은 코인 단위다. COIN-M 지갑에는 USDT가 없다. */}
        <KV k="필요 증거금"
            v={margin?.ok ? `${fmtPrice(margin.marginCoin, 6)} ${base}` : '—'}/>
        <KV k={`손절가 (−${slPct}%)`}
            v={stopPrice != null ? fmtPrice(stopPrice) : '읽지 못했습니다'}
            color={stopBeyondLiq ? C.down : undefined}/>
        <KV k="청산가(근사)" v={liq != null ? fmtPrice(liq) : '—'}
            color={C.warn}/>
      </div>

      {stopBeyondLiq && (
        <div style={{
          padding: '8px 10px', borderRadius: 7, background: C.downBg,
          color: C.down, fontSize: FS.micro, lineHeight: 1.5,
        }}>
          손절({stopPrice != null ? fmtPrice(stopPrice) : '—'})이 청산가
          ({liq != null ? fmtPrice(liq) : '—'}) 너머입니다. 청산이 먼저 닿으므로
          손절은 작동할 기회가 없습니다 — 배율을 낮추거나 손절 폭을 줄이세요.
          <div style={{ color: C.dim, marginTop: 4 }}>
            {leverage}배에서는 청산가가 약 {liq != null && markPrice != null
              ? `${Math.abs((liq - markPrice) / markPrice * 100).toFixed(2)}%`
              : '—'} 거리입니다. 실제 청산은 이보다 더 가깝습니다.
          </div>
        </div>
      )}

      {stopPrice == null && (
        <div style={{
          padding: '8px 10px', borderRadius: 7, background: C.warnBg,
          color: C.warn, fontSize: FS.micro, lineHeight: 1.5,
        }}>
          마크가를 읽지 못해 손절가를 계산할 수 없습니다. 손절 없이 진입하지 않습니다.
        </div>
      )}

      {unit === 'CONTRACTS' && amt > 0 && !Number.isInteger(amt) && (
        <div style={{
          padding: '8px 10px', borderRadius: 7, background: C.downBg,
          color: C.down, fontSize: FS.micro, lineHeight: 1.5,
        }}>
          계약 수는 정수여야 합니다. COIN-M의 수량 단위는 코인이 아니라 계약입니다 —
          {base} 개수를 넣으려던 것이라면 &lsquo;USD 금액&rsquo;으로 바꾸세요.
        </div>
      )}

      {conv && conv.shortfallUsd > 0 && (
        <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.5 }}>
          1계약이 {contractUsd} USD라 ${conv.shortfallUsd.toFixed(2)}는 주문되지 않습니다.
        </div>
      )}

      <button onClick={submit} disabled={busy || blocked}
        style={{ ...primaryBtn(side === 'BUY' ? C.up : C.down, busy || blocked), minHeight: 44 }}>
        {busy ? '전송 중…'
          : `${base} ${side === 'BUY' ? 'LONG' : 'SHORT'} ${contracts}계약 ${leverage}×`
            + (stopPrice != null && !stopBeyondLiq ? ` · 손절 ${fmtPrice(stopPrice)}` : '')}
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

      {levOpen && (
        <>
          <div onClick={() => setLevOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }}/>
          <div style={{
            position: 'absolute', top: pad + 60, left: pad, right: pad, zIndex: 41,
            background: C.raised, border: `1px solid ${C.hair2}`, borderRadius: 10,
            boxShadow: '0 12px 32px rgba(0,0,0,.6)', padding: 10,
          }}>
            <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 7 }}>레버리지</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5 }}>
              {LEVERAGES.map(v => {
                const on = leverage === v, risky = v >= 50;
                return (
                  <button key={v} onClick={() => { setLeverage(v); setLevOpen(false); }} style={{
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
              COIN-M은 역방향 계약이라 손익이 가격에 선형이 아닙니다. 청산가는 근사치이며
              실제 청산은 이보다 가깝습니다.
            </div>
          </div>
        </>
      )}
    </div>
  );
});

function KV({ k, v, color, warn }: { k: string; v: string; color?: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: C.faint, whiteSpace: 'nowrap' }}>{k}</span>
      <span style={{
        ...NUM, color: color ?? (warn ? C.down : C.text),
        fontWeight: 600, whiteSpace: 'nowrap',
      }}>{v}</span>
    </div>
  );
}

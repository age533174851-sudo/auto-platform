'use client';
// src/components/terminal/SpotStrategyPanel.tsx
//
// 현물 전략 10종의 지금 판단.
//
// 이 화면은 주문하지 않는다
// ─────────────────────────
// 각 전략이 "지금 무엇을 하겠다"만 보여준다. 실행은 현물 주문창에서
// 한다. 여기에 실행 버튼을 달면 주문 경로가 둘이 되고, 현물 검사
// (공매도 차단·보유 확인)를 두 곳에서 관리하게 된다.
//
// 그래서 각 줄에 '주문창에 채우기'만 둔다 — 값을 옮겨줄 뿐 나가지 않는다.
import React, { memo, useCallback, useEffect, useState } from 'react';
import { C, FS, NUM, chip, ghostBtn, fmtPrice } from './theme';
import { useTerminal } from './TerminalContext';

interface Row {
  id: string; label: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  quoteUsd: number | null;
  qty: number | null;
  reason: string;
  clamped: boolean;
  note: string | null;
}

interface Data {
  symbol: string;
  price: number | null;
  heldQty: number | null;
  avgPrice: number | null;
  holdingsReadable: boolean;
  portfolioValueUsd: number | null;
  results: Row[];
  note: string;
}

export const SpotStrategyPanel = memo(function SpotStrategyPanel() {
  const { symbol, auth, connId, marketType, setMarketType } = useTerminal();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [budget, setBudget] = useState('1000');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    setBusy(true);
    try {
      const q = new URLSearchParams({ symbol: symbol.id, budget: budget || '1000' });
      if (connId) q.set('connectionId', connId);
      const r = await fetch(`/api/strategies/spot?${q}`, { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setErr(j?.message || j?.error || `평가 실패 (${r.status})`); return; }
      setErr(''); setD(j);
    } catch (e: any) {
      setErr(`전략 평가 실패 (${e?.message || e})`);
    } finally { setBusy(false); }
  }, [auth, connId, symbol.id, budget]);

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

  const acting = d?.results.filter(r => r.action !== 'HOLD') ?? [];

  return (
    <div style={{ padding: 14, maxWidth: 720 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap',
      }}>
        <span style={{ color: C.text, fontSize: FS.body, fontWeight: 700 }}>
          {symbol.id} 현물 전략
        </span>
        {marketType !== 'SPOT' && (
          // 선물 화면에서 보고 있으면 그 사실을 알린다. 여기 판단은
          // 전부 현물 기준인데 주문창은 선물이면 그대로 옮길 수 없다.
          <button onClick={() => setMarketType('SPOT')} style={{ ...ghostBtn(), color: C.warn }}>
            지금 주문창은 선물입니다 — 현물로 전환
          </button>
        )}
        <div style={{ flex: 1 }}/>
        <span style={{ color: C.faint, fontSize: FS.micro }}>예산</span>
        <input value={budget} onChange={e => setBudget(e.target.value)} inputMode="decimal"
          style={{
            width: 90, background: C.raised, color: C.text, ...NUM,
            border: `1px solid ${C.hair}`, borderRadius: 7,
            padding: '6px 9px', fontSize: FS.small, outline: 'none',
          }}/>
        <button onClick={load} disabled={busy} style={ghostBtn()}>
          {busy ? '평가 중…' : '다시 평가'}
        </button>
      </div>

      {d && (
        <div style={{
          display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10,
          padding: '8px 12px', background: C.raised, borderRadius: 8, fontSize: FS.micro,
        }}>
          <KV k="현물가" v={d.price == null ? '확인 불가' : `$${fmtPrice(d.price)}`} warn={d.price == null}/>
          <KV k="보유" v={d.heldQty == null ? '확인 불가' : fmtPrice(d.heldQty, 6)}
              warn={d.heldQty == null}/>
          <KV k="평균가" v={d.avgPrice == null ? '—' : `$${fmtPrice(d.avgPrice)}`}/>
          <KV k="포트폴리오"
              v={d.portfolioValueUsd == null ? '확인 불가' : `$${fmtPrice(d.portfolioValueUsd)}`}
              warn={d.portfolioValueUsd == null}/>
        </div>
      )}

      {!d ? (
        <div style={{ padding: 24, textAlign: 'center', color: C.faint, fontSize: FS.small }}>
          전략을 평가하는 중
        </div>
      ) : (
        <>
          {acting.length === 0 && (
            <div style={{
              padding: '10px 12px', borderRadius: 8, background: C.raised,
              color: C.dim, fontSize: FS.small, marginBottom: 8,
            }}>
              지금 행동할 전략이 없습니다 — 열 개 모두 대기 중입니다.
            </div>
          )}

          {d.results.map(r => {
            const on = r.action !== 'HOLD';
            const tone = r.action === 'BUY' ? C.up : r.action === 'SELL' ? C.down : C.faint;
            return (
              <div key={r.id} style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '9px 12px', marginBottom: 4, borderRadius: 8,
                background: on ? C.raised : 'transparent',
                borderLeft: `2px solid ${on ? tone : 'transparent'}`,
                opacity: on ? 1 : 0.65,
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ color: C.text, fontSize: FS.small, fontWeight: 600 }}>{r.label}</span>
                    <span style={chip(tone, on ? (r.action === 'BUY' ? C.upBg : C.downBg) : undefined)}>
                      {r.action === 'BUY' ? '매수' : r.action === 'SELL' ? '매도' : '대기'}
                    </span>
                  </div>
                  <div style={{ color: C.dim, fontSize: FS.micro, lineHeight: 1.5 }}>{r.reason}</div>
                  {/* 잘렸으면 그 사실을 반드시 보여준다. 조용히 줄이면
                      왜 적게 샀는지 알 수 없다. */}
                  {r.note && (
                    <div style={{ color: C.warn, fontSize: FS.micro, marginTop: 3, lineHeight: 1.45 }}>
                      {r.note}
                    </div>
                  )}
                </div>

                {on && (
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ ...NUM, color: tone, fontSize: FS.small, fontWeight: 700 }}>
                      {r.action === 'BUY'
                        ? `$${fmtPrice(r.quoteUsd ?? 0)}`
                        : `${fmtPrice(r.qty ?? 0, 6)}`}
                    </div>
                    <div style={{ color: C.faint, fontSize: FS.micro }}>
                      {r.action === 'BUY' ? 'USDT' : symbol.id.replace(/USDT$/, '')}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      <div style={{
        marginTop: 10, padding: '9px 11px', borderRadius: 8,
        background: C.raised, color: C.dim, fontSize: FS.micro, lineHeight: 1.6,
      }}>
        {d?.note ?? '평가 결과입니다. 주문은 나가지 않습니다.'}
        {' '}현물 전략에는 레버리지가 없습니다 — 판단도 주문도 보유 자금 안에서만 이루어집니다.
      </div>
    </div>
  );
});

function KV({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', gap: 5, alignItems: 'baseline' }}>
      <span style={{ color: C.faint }}>{k}</span>
      <span style={{ ...NUM, color: warn ? C.warn : C.text, fontWeight: 600 }}>{v}</span>
    </span>
  );
}

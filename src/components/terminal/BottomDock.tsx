'use client';
// src/components/terminal/BottomDock.tsx
//
// 하단 — 포지션 · 미체결 · 상태대조 · 전략 · Kill Switch.
//
// 여기 있는 값은 전부 **거래소가 말한 것**이다. 앱이 기억하는 것이 아니다.
// 둘이 다를 수 있고, 다르면 그 사실 자체가 가장 중요한 정보다.
// 그래서 '상태대조' 탭을 따로 뒀다.
//
// Kill Switch는 탭 안에 숨기지 않는다. 필요한 순간에 두 번 누르게 하면 안 된다.
import React, { memo, useCallback, useEffect, useState } from 'react';
import { C, FS, NUM, tabStyle, chip, ghostBtn, fmtPrice, pnlColor } from './theme';
import { useTerminal } from './TerminalContext';

type Tab = '포지션' | '미체결' | '상태대조' | '전략';
const TABS: Tab[] = ['포지션', '미체결', '상태대조', '전략'];

function BottomDockInner({ onBalance }: { onBalance?: (v: number | null) => void }) {
  const { auth, connId, setSymbol, symbols } = useTerminal();
  const [tab, setTab] = useState<Tab>('포지션');
  const [acct, setAcct] = useState<any>(null);
  const [err, setErr] = useState('');
  const [recon, setRecon] = useState<any>(null);
  const [killing, setKilling] = useState(false);
  const [killMsg, setKillMsg] = useState('');

  const load = useCallback(async () => {
    if (!auth || !connId) return;
    try {
      const r = await fetch(`/api/binance/futures/account?connectionId=${connId}`,
        { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok) { setErr(j?.message || j?.error || `조회 실패 (${r.status})`); return; }
      setErr('');
      setAcct(j);
      const b = Number(j?.balance?.available ?? j?.balance?.total ?? j?.availableBalance);
      onBalance?.(Number.isFinite(b) ? b : null);
    } catch (e: any) {
      // 조회 실패를 "포지션 없음"으로 보여주면 안 된다. 있는데 못 본 것일 수 있다.
      setErr(`거래소 조회 실패 — 포지션 없음이 아니라 확인 불가입니다 (${e?.message || e})`);
    }
  }, [auth, connId, onBalance]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const loadRecon = useCallback(async () => {
    if (!auth) return;
    try {
      const r = await fetch('/api/reconcile/state', { headers: { Authorization: auth } });
      setRecon(await r.json());
    } catch (e: any) { setRecon({ ok: false, error: e?.message || '대조 실패' }); }
  }, [auth]);

  useEffect(() => { if (tab === '상태대조') loadRecon(); }, [tab, loadRecon]);

  const kill = async () => {
    if (!auth || !connId) { setKillMsg('로그인·연결이 필요합니다'); return; }
    if (!window.confirm('킬스위치를 발동합니다.\n신규 진입이 차단됩니다. 진행할까요?')) return;
    setKilling(true); setKillMsg('');
    try {
      const r = await fetch('/api/risk/kill-switch/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ connectionId: connId, reason: '터미널에서 수동 발동' }),
      });
      const j = await r.json();
      setKillMsg(r.ok ? '발동됨 — 신규 진입 차단' : (j?.message || j?.error || '발동 실패'));
    } catch (e: any) { setKillMsg(`실패: ${e?.message || e}`); }
    finally { setKilling(false); }
  };

  const positions: any[] = Array.isArray(acct?.positions) ? acct.positions : [];
  const open: any[] = Array.isArray(acct?.openOrders) ? acct.openOrders
    : Array.isArray(acct?.orders) ? acct.orders : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
        padding: '7px 10px', borderBottom: `1px solid ${C.hair}`,
      }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={tabStyle(tab === t)}>
            {t}
            {t === '포지션' && positions.length > 0 && (
              <span style={{ ...NUM, color: C.accent, marginLeft: 5, fontWeight: 700 }}>
                {positions.length}
              </span>
            )}
          </button>
        ))}
        <div style={{ flex: 1 }}/>
        {killMsg && (
          <span style={{ fontSize: FS.micro, color: C.warn, marginRight: 8 }}>{killMsg}</span>
        )}
        <button onClick={kill} disabled={killing} style={{
          minHeight: 34, padding: '0 16px', borderRadius: 8, cursor: killing ? 'default' : 'pointer',
          background: C.downBg, color: C.down, border: `1px solid ${C.down}55`,
          fontSize: FS.small, fontWeight: 700, letterSpacing: '0.02em',
        }}>{killing ? '발동 중…' : 'KILL SWITCH'}</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {err && (
          <div style={{
            margin: 10, padding: '10px 12px', borderRadius: 8,
            background: C.warnBg, color: C.warn, fontSize: FS.small, lineHeight: 1.55,
          }}>{err}</div>
        )}

        {tab === '포지션' && (
          positions.length === 0
            ? <Empty t={acct ? '열린 포지션이 없습니다' : '거래소 연결을 선택하면 표시됩니다'}/>
            : <Table
                head={['종목', '방향', '수량', '진입가', 'Mark', '청산가', '미실현', '배율', '마진']}
                rows={positions.map((p: any) => {
                  const long = Number(p.amount) > 0;
                  const pnl = Number(p.unrealizedPnl ?? p.unRealizedProfit);
                  const iso = p.marginType === 'isolated';
                  return {
                    key: p.symbol,
                    onClick: () => {
                      const s = symbols.find(x => x.id === p.symbol);
                      if (s) setSymbol(s);
                    },
                    cells: [
                      <span key="s" style={{ color: C.text, fontWeight: 600 }}>{p.symbol}</span>,
                      <span key="d" style={chip(long ? C.up : C.down, long ? C.upBg : C.downBg)}>
                        {long ? 'LONG' : 'SHORT'}
                      </span>,
                      fmtPrice(Math.abs(Number(p.amount)), 4),
                      fmtPrice(p.entryPrice),
                      fmtPrice(p.markPrice),
                      <span key="l" style={{ color: C.warn }}>{fmtPrice(p.liquidationPrice)}</span>,
                      <span key="p" style={{ color: pnlColor(pnl), fontWeight: 700 }}>
                        {pnl >= 0 ? '+' : ''}{fmtPrice(pnl)}
                      </span>,
                      `${fmtPrice(p.leverage, 0)}×`,
                      // 교차는 격리 전제(청산가·증거금 상한)를 깨므로 눈에 띄어야 한다
                      <span key="m" style={{ color: iso ? C.dim : C.warn, fontWeight: iso ? 400 : 700 }}>
                        {iso ? '격리' : '교차'}
                      </span>,
                    ],
                  };
                })}
              />
        )}

        {tab === '미체결' && (
          open.length === 0
            ? <Empty t="미체결 주문이 없습니다"/>
            : <Table
                head={['종목', '종류', '방향', '수량', '가격', 'Stop']}
                rows={open.map((o: any, i: number) => ({
                  key: String(o.orderId ?? i),
                  cells: [
                    <span key="s" style={{ color: C.text, fontWeight: 600 }}>{o.symbol}</span>,
                    <span key="t" style={{ color: C.dim }}>{o.type}</span>,
                    <span key="d" style={{ color: o.side === 'BUY' ? C.up : C.down }}>{o.side}</span>,
                    fmtPrice(o.origQty, 4),
                    fmtPrice(o.price),
                    fmtPrice(o.stopPrice),
                  ],
                }))}
              />
        )}

        {tab === '상태대조' && (
          <div style={{ padding: 14, lineHeight: 1.6, fontSize: FS.small }}>
            {!recon ? <Empty t="대조 중"/> : !recon.ok ? (
              <div style={{ padding: '12px 14px', borderRadius: 8, background: C.warnBg }}>
                <div style={{ color: C.warn, fontWeight: 700, marginBottom: 4 }}>
                  대조할 수 없습니다 — {recon.error || '사유 미상'}
                </div>
                <div style={{ color: C.dim, fontSize: FS.micro }}>
                  확인 불가는 &lsquo;문제 없음&rsquo;이 아닙니다. 이 상태에서는 신규 주문이 막힙니다.
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={recon.verdict?.blockNewOrders
                    ? chip(C.down, C.downBg) : chip(C.up, C.upBg)}>
                    {recon.verdict?.blockNewOrders ? '신규 주문 차단 중' : '앱 · 거래소 일치'}
                  </span>
                  <span style={{ color: C.dim }}>{recon.verdict?.summary}</span>
                  <div style={{ flex: 1 }}/>
                  <button onClick={loadRecon} style={ghostBtn()}>다시 대조</button>
                </div>
                {(recon.verdict?.mismatches ?? []).map((m: any, i: number) => {
                  const tone = m.severity === 'critical' ? C.down : m.severity === 'warn' ? C.warn : C.faint;
                  return (
                    <div key={i} style={{
                      display: 'flex', gap: 10, alignItems: 'baseline',
                      padding: '8px 12px', marginBottom: 5, borderRadius: 8,
                      background: C.raised, borderLeft: `2px solid ${tone}`,
                    }}>
                      <span style={{ color: tone, fontWeight: 700, fontSize: FS.micro }}>{m.code}</span>
                      <span style={{ color: C.dim }}>
                        {m.symbol ? `${m.symbol} · ` : ''}{m.detail}
                      </span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {tab === '전략' && <StrategyTab/>}
      </div>
    </div>
  );
}

function StrategyTab() {
  const { mode } = useTerminal();
  return (
    <div style={{ padding: 14, color: C.dim, fontSize: FS.small, lineHeight: 1.7, maxWidth: 640 }}>
      <div style={{ color: C.text, fontSize: FS.lead, fontWeight: 700, marginBottom: 4 }}>
        BTC 09:00 KST 일봉 전략
      </div>
      <div style={{ color: C.faint, marginBottom: 14 }}>
        09:00 전환 → 10~30분 관찰 → 한 방향 1회 진입 → 다음 09:00 청산
      </div>

      <div style={{
        background: C.raised, borderRadius: 10, padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14,
      }}>
        <div style={{ color: C.text, fontWeight: 600 }}>
          {mode.unknown ? '운영 단계 확인 불가' : mode.label}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={chip(mode.unknown ? C.warn : mode.sendsOrders ? C.accent : C.dim)}>
            주문 전송 {mode.unknown ? '?' : mode.sendsOrders ? '함' : '안 함'}
          </span>
          <span style={mode.realMoney ? chip(C.down, C.downBg) : chip(C.dim)}>
            실제 자금 {mode.unknown ? '?' : mode.realMoney ? '사용' : '미사용'}
          </span>
        </div>
      </div>

      <div style={{ color: C.faint, lineHeight: 1.65 }}>
        실데이터 검증 결과 100배는 이 전략에서 구조적으로 생존이 어렵습니다 —
        MAE 중앙값이 100배 청산거리의 2.6~4배입니다. 배율은 그 사실을 알고 고르세요.
      </div>
    </div>
  );
}

function Empty({ t }: { t: string }) {
  return (
    <div style={{ padding: '32px 16px', textAlign: 'center', color: C.faint, fontSize: FS.small }}>
      {t}
    </div>
  );
}

function Table({ head, rows }: {
  head: string[];
  rows: { key: string; cells: React.ReactNode[]; onClick?: () => void }[];
}) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.small }}>
      <thead>
        <tr>
          {head.map(h => (
            <th key={h} style={{
              textAlign: 'left', padding: '8px 14px', color: C.faint,
              fontSize: FS.micro, fontWeight: 500, whiteSpace: 'nowrap',
              borderBottom: `1px solid ${C.hair}`, letterSpacing: '0.03em',
            }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.key} onClick={r.onClick} style={{ cursor: r.onClick ? 'pointer' : 'default' }}>
            {r.cells.map((c, i) => (
              <td key={i} style={{
                padding: '9px 14px', color: C.dim, whiteSpace: 'nowrap',
                borderBottom: `1px solid ${C.hair}`, ...NUM,
              }}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const BottomDock = memo(BottomDockInner);

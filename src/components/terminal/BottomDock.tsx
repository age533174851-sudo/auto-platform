'use client';
// src/components/terminal/BottomDock.tsx
//
// 하단 — 포지션 · 미체결 · 상태대조 · 전략 · Kill Switch.
//
// 여기 있는 값은 전부 **거래소가 말한 것**이다. 앱이 기억하는 것이 아니다.
// 둘이 다를 수 있고, 다르면 그 사실 자체가 가장 중요한 정보다.
// 그래서 '상태대조' 탭을 따로 뒀다.
//
// Kill Switch는 항상 보이는 자리에 크게 둔다. 탭 안에 숨기면 필요한 순간에
// 두 번 클릭해야 하고, 그 순간에는 한 번도 길다.
import React, { memo, useCallback, useEffect, useState } from 'react';
import { T } from '@/lib/constants';
import { useTerminal } from './TerminalContext';

type Tab = '포지션' | '미체결' | '상태대조' | '전략';
const TABS: Tab[] = ['포지션', '미체결', '상태대조', '전략'];

function fmtNum(v: any, d = 2): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : '—';
}

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
      setErr(`거래소 조회 실패 — 포지션 없음이 아니라 확인 불가입니다: ${e?.message || e}`);
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
      setKillMsg(r.ok ? '킬스위치 발동됨 — 신규 진입 차단' : (j?.message || j?.error || '발동 실패'));
    } catch (e: any) { setKillMsg(`실패: ${e?.message || e}`); }
    finally { setKilling(false); }
  };

  const positions: any[] = Array.isArray(acct?.positions) ? acct.positions : [];
  const open: any[] = Array.isArray(acct?.openOrders) ? acct.openOrders
    : Array.isArray(acct?.orders) ? acct.orders : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 2,
        borderBottom: `1px solid ${T.border}`, padding: '0 6px', flexShrink: 0,
      }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: 'transparent', border: 'none',
            borderBottom: `2px solid ${tab === t ? T.acl : 'transparent'}`,
            color: tab === t ? T.txt : T.muted,
            padding: '7px 12px', fontSize: 10, fontWeight: 800, cursor: 'pointer',
          }}>
            {t}
            {t === '포지션' && positions.length > 0 && (
              <span style={{ color: T.acl, marginLeft: 4 }}>{positions.length}</span>
            )}
          </button>
        ))}
        <div style={{ flex: 1 }}/>
        {killMsg && <span style={{ fontSize: 9, color: T.ylw, marginRight: 8 }}>{killMsg}</span>}
        <button onClick={kill} disabled={killing} style={{
          background: T.red, color: '#fff', border: 'none', borderRadius: 6,
          padding: '6px 16px', fontSize: 11, fontWeight: 900,
          cursor: killing ? 'default' : 'pointer', opacity: killing ? 0.6 : 1,
        }}>
          {killing ? '발동 중…' : '🛑 Kill Switch'}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', fontSize: 10 }}>
        {err && (
          <div style={{ padding: '8px 10px', color: T.ylw, fontSize: 10, lineHeight: 1.5 }}>{err}</div>
        )}

        {tab === '포지션' && (
          positions.length === 0
            ? <Empty t={acct ? '열린 포지션이 없습니다' : '연결을 선택하면 표시됩니다'}/>
            : <Table
                head={['종목', '방향', '수량', '진입가', 'Mark', '청산가', '미실현', '배율', '마진']}
                rows={positions.map((p: any) => {
                  const long = Number(p.amount) > 0;
                  const pnl = Number(p.unrealizedPnl ?? p.unRealizedProfit);
                  return {
                    key: p.symbol,
                    onClick: () => {
                      const s = symbols.find(x => x.id === p.symbol);
                      if (s) setSymbol(s);
                    },
                    cells: [
                      <b key="s" style={{ color: T.txt }}>{p.symbol}</b>,
                      <span key="d" style={{ color: long ? T.grn : T.red, fontWeight: 800 }}>
                        {long ? 'LONG' : 'SHORT'}
                      </span>,
                      fmtNum(Math.abs(Number(p.amount)), 4),
                      fmtNum(p.entryPrice),
                      fmtNum(p.markPrice),
                      <span key="l" style={{ color: T.ylw }}>{fmtNum(p.liquidationPrice)}</span>,
                      <span key="p" style={{ color: pnl >= 0 ? T.grn : T.red, fontWeight: 800 }}>
                        {fmtNum(pnl)}
                      </span>,
                      `${fmtNum(p.leverage, 0)}x`,
                      <span key="m" style={{ color: p.marginType === 'isolated' ? T.sub : T.ylw }}>
                        {p.marginType === 'isolated' ? '격리' : '교차'}
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
                    <b key="s" style={{ color: T.txt }}>{o.symbol}</b>,
                    o.type,
                    <span key="d" style={{ color: o.side === 'BUY' ? T.grn : T.red }}>{o.side}</span>,
                    fmtNum(o.origQty, 4),
                    fmtNum(o.price),
                    fmtNum(o.stopPrice),
                  ],
                }))}
              />
        )}

        {tab === '상태대조' && (
          <div style={{ padding: 10, lineHeight: 1.6 }}>
            {!recon ? <Empty t="대조 중…"/> : !recon.ok ? (
              <div style={{ color: T.ylw }}>
                대조할 수 없습니다: {recon.error || '사유 미상'}
                <div style={{ color: T.muted, fontSize: 9, marginTop: 4 }}>
                  확인 불가는 &quot;문제 없음&quot;이 아닙니다. 이 상태에서는 신규 주문이 막힙니다.
                </div>
              </div>
            ) : (
              <>
                <div style={{
                  color: recon.verdict?.blockNewOrders ? T.red : T.grn,
                  fontWeight: 800, marginBottom: 6,
                }}>
                  {recon.verdict?.blockNewOrders ? '⚠ 신규 주문 차단 중' : '앱과 거래소 상태 일치'}
                </div>
                <div style={{ color: T.sub, marginBottom: 8 }}>{recon.verdict?.summary}</div>
                {(recon.verdict?.mismatches ?? []).map((m: any, i: number) => (
                  <div key={i} style={{
                    padding: '4px 7px', marginBottom: 3, borderRadius: 4,
                    borderLeft: `2px solid ${m.severity === 'critical' ? T.red : m.severity === 'warn' ? T.ylw : T.muted}`,
                    background: T.alt, fontSize: 9,
                  }}>
                    <b style={{
                      color: m.severity === 'critical' ? T.red : m.severity === 'warn' ? T.ylw : T.sub,
                    }}>{m.code}</b>
                    <span style={{ color: T.sub }}> {m.symbol ? `· ${m.symbol}` : ''} — {m.detail}</span>
                  </div>
                ))}
                <button onClick={loadRecon} style={{
                  marginTop: 6, background: T.alt, color: T.acl,
                  border: `1px solid ${T.border2}`, borderRadius: 5,
                  padding: '4px 12px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                }}>다시 대조</button>
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
    <div style={{ padding: 10, color: T.sub, lineHeight: 1.7 }}>
      <div style={{ color: T.txt, fontWeight: 800, marginBottom: 6 }}>
        BTC 09:00 KST 일봉 전략
      </div>
      <div style={{ color: T.muted, fontSize: 9, marginBottom: 10 }}>
        09:00 전환 → 10~30분 관찰 → 한 방향 1회 진입 → 다음 09:00 청산
      </div>
      <div style={{
        padding: '7px 9px', borderRadius: 5, background: T.alt,
        border: `1px solid ${T.border}`, fontSize: 9, lineHeight: 1.6,
      }}>
        <div style={{ color: T.txt, fontWeight: 700, marginBottom: 3 }}>운영 단계</div>
        <div>{mode.unknown ? '확인 불가' : mode.label}</div>
        <div style={{ color: T.muted, marginTop: 4 }}>
          주문 전송 {mode.unknown ? '?' : mode.sendsOrders ? '함' : '안 함'} ·
          실제 자금 {mode.unknown ? '?' : mode.realMoney ? '사용' : '미사용'}
        </div>
      </div>
      <div style={{ color: T.muted, fontSize: 9, marginTop: 10, lineHeight: 1.6 }}>
        실데이터 검증 결과 100배는 이 전략에서 구조적으로 생존이 어렵습니다
        (MAE 중앙값이 100배 청산거리의 2.6~4배). 배율은 그 사실을 알고 고르세요.
      </div>
    </div>
  );
}

function Empty({ t }: { t: string }) {
  return <div style={{ padding: 20, textAlign: 'center', color: T.muted, fontSize: 10 }}>{t}</div>;
}

function Table({ head, rows }: {
  head: string[];
  rows: { key: string; cells: React.ReactNode[]; onClick?: () => void }[];
}) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
      <thead>
        <tr>
          {head.map(h => (
            <th key={h} style={{
              textAlign: 'left', padding: '5px 10px', color: T.muted, fontSize: 9,
              fontWeight: 600, borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap',
            }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.key} onClick={r.onClick} style={{ cursor: r.onClick ? 'pointer' : 'default' }}>
            {r.cells.map((c, i) => (
              <td key={i} style={{
                padding: '5px 10px', color: T.sub, borderBottom: `1px solid ${T.border}`,
                fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
              }}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const BottomDock = memo(BottomDockInner);

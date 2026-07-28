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
import { A } from '@/lib/theme/colors';
import { useTerminal } from './TerminalContext';
import { MarketCompare } from './MarketSwitch';
import { WalletTreePanel } from './WalletTree';
import { LedgerPanel } from './LedgerPanel';
import { derivePosition, closeSideFor } from '@/lib/markets/positionView';
import { SpotStrategyPanel } from './SpotStrategyPanel';
import { CombinedPanel } from './CombinedPanel';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';

type Tab = '포지션' | '미체결' | '자산' | '전략장부' | '현물전략' | '현물·선물' | '상태대조' | '전략';
const TABS: Tab[] = ['포지션', '미체결', '자산', '전략장부', '현물전략', '현물·선물', '상태대조', '전략'];

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
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        padding: '7px 10px', borderBottom: `1px solid ${C.hair}`,
      }}>
        {/* 탭은 넘치면 가로로 스크롤한다. Kill Switch를 밀어내면 안 된다. */}
        <div style={{
          display: 'flex', gap: 4, minWidth: 0, flex: 1,
          overflowX: 'auto', scrollbarWidth: 'none',
        }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{ ...tabStyle(tab === t), flexShrink: 0 }}>
              {t}
              {t === '포지션' && positions.length > 0 && (
                <span style={{ ...NUM, color: C.accent, marginLeft: 5, fontWeight: 700 }}>
                  {positions.length}
                </span>
              )}
            </button>
          ))}
        </div>
        {killMsg && (
          <span style={{ fontSize: FS.micro, color: C.warn, whiteSpace: 'nowrap' }}>{killMsg}</span>
        )}
        <button onClick={kill} disabled={killing} style={{
          minHeight: 34, padding: '0 14px', borderRadius: 8, flexShrink: 0,
          cursor: killing ? 'default' : 'pointer',
          background: C.downBg, color: C.down, border: `1px solid ${C.down}55`,
          fontSize: FS.small, fontWeight: 700, letterSpacing: '0.02em', whiteSpace: 'nowrap',
        }}>{killing ? '발동 중…' : 'KILL'}</button>
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
            : <div>
                {positions.map((p: any) => (
                  <PositionCard key={p.symbol} p={p}
                    auth={auth} connId={connId} onClosed={load}
                    onPick={() => {
                      const s = symbols.find(x => x.id === p.symbol);
                      if (s) setSymbol(s);
                    }}/>
                ))}
              </div>
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

        {tab === '자산' && <WalletTreePanel/>}

        {tab === '전략장부' && <LedgerPanel/>}

        {tab === '현물전략' && <SpotStrategyPanel/>}

        {tab === '현물·선물' && <SpotFuturesTab acct={acct}/>}

        {tab === '전략' && <StrategyTab/>}
      </div>
    </div>
  );
}

/**
 * 현물과 선물을 나란히 본다.
 *
 * 따로 보면 현물 0.15 BTC와 선물 SHORT 0.10 BTC가 둘 다 크게 느껴진다.
 * 실제 방향 노출은 +0.05다. 그 숫자를 직접 보여준다.
 */
/**
 * 현물·선물 탭 — 비교판과 결합 전략.
 *
 * 탭을 하나 더 늘리지 않는다. 하단 탭이 이미 8개라 좁은 화면에서
 * Kill Switch를 밀어낸다. 둘은 같은 맥락이므로 서브탭이 맞다.
 */
function SpotFuturesTab({ acct }: { acct: any }) {
  const [view, setView] = useState<'비교' | '결합전략'>('비교');
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, padding: '10px 14px 0' }}>
        {(['비교', '결합전략'] as const).map(v => (
          <button key={v} onClick={() => setView(v)} style={tabStyle(view === v)}>{v}</button>
        ))}
      </div>
      {view === '비교' ? <CombinedTab acct={acct}/> : <CombinedPanel/>}
    </div>
  );
}

function CombinedTab({ acct }: { acct: any }) {
  const { symbol, auth, connId } = useTerminal();
  const stream = useBinanceStream(symbol.id, true);
  const [spotQty, setSpotQty] = useState<number | null>(null);
  const [spotPrice, setSpotPrice] = useState<number | null>(null);
  const [funding, setFunding] = useState<number | null>(null);
  const base = symbol.id.replace(/USDT$/, '');

  // 현물 가격은 현물 시장에서 받아야 한다. 선물 호가를 현물 가격으로
  // 쓰면 Basis가 항상 0이 되어 두 시장이 같다는 거짓말이 된다.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol.id}`);
        if (r.ok && alive) {
          const j = await r.json();
          const v = parseFloat(j?.price);
          setSpotPrice(Number.isFinite(v) ? v : null);
        }
      } catch { if (alive) setSpotPrice(null); }
      try {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol.id}`);
        if (r.ok && alive) {
          const j = await r.json();
          const v = parseFloat(j?.lastFundingRate);
          setFunding(Number.isFinite(v) ? v * 100 : null);
        }
      } catch { if (alive) setFunding(null); }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [symbol.id]);

  // 현물 보유는 현물 지갑에서만 읽는다. 선물 계좌와 섞지 않는다.
  useEffect(() => {
    if (!auth || !connId) { setSpotQty(null); return; }
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/binance/spot/balance?connectionId=${connId}`,
          { headers: { Authorization: auth } });
        const j = await r.json();
        if (!alive) return;
        if (!r.ok || !j?.ok) { setSpotQty(null); return; }
        const hit = (j.balances || []).find((b: any) => b.asset === base);
        setSpotQty(hit ? Number(hit.free) + Number(hit.locked) : 0);
      } catch { if (alive) setSpotQty(null); }
    })();
    return () => { alive = false; };
  }, [auth, connId, base]);

  // 선물 순수량 — 조회를 못 했으면 0이 아니라 null이다
  const positions: any[] = Array.isArray(acct?.positions) ? acct.positions : [];
  const futuresQty = acct == null ? null
    : positions
        .filter((p: any) => String(p.symbol) === symbol.id)
        .reduce((sum: number, p: any) => sum + (Number(p.amount) || 0), 0);

  return (
    <div style={{ padding: 14, maxWidth: 420 }}>
      <div style={{ color: C.text, fontSize: FS.body, fontWeight: 700, marginBottom: 8 }}>
        {symbol.id} · 현물 vs 선물
      </div>
      <MarketCompare
        spotPrice={spotPrice}
        markPrice={stream.lastPrice}
        fundingPct={funding}
        spotQty={spotQty}
        futuresQty={futuresQty}
      />
      <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 10, lineHeight: 1.6 }}>
        현물 보유와 선물 포지션을 따로 보면 둘 다 크게 느껴집니다.
        총 순노출이 실제 방향입니다 — 현물 0.15 + 선물 SHORT 0.10이면 실질 +0.05입니다.
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

/**
 * 포지션 카드.
 *
 * 표를 쓰지 않는 이유: 열이 아홉 개였다. 375px에서 그 표는 읽는 게 아니라
 * 훑는 것이 되고, 청산가처럼 놓치면 안 되는 값이 가로 스크롤 밖으로 나간다.
 *
 * 값이 없을 때 0을 적지 않는다. 청산가 0은 '0달러에 청산'이 아니라
 * '청산가를 못 받았다'인데, 화면만 봐서는 둘이 같아 보인다.
 */
function PositionCard({ p, onPick, auth, connId, onClosed }: {
  p: any;
  onPick: () => void;
  auth: string;
  connId: string;
  /** 청산이 접수되면 목록을 다시 읽는다 */
  onClosed: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const [closeMsg, setCloseMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 값 해석은 테스트가 있는 순수 함수가 한다. 청산가 0·증거금 추정·
  // 0으로 나누기 셋 다 화면에서는 그럴듯해 보여서 눈으로 못 잡는다.
  const v = derivePosition(p);
  const { side, qty, isolated: iso, leverage: lev, entry, mark, liq,
          pnl, notional, margin, marginEstimated: marginIsEst, roi } = v;
  const long = side === 'LONG';

  /**
   * 시장가 전량 청산.
   *
   * reduceOnly로 보낸다. 이게 빠지면 청산이 아니라 **반대 방향 신규 진입**이
   * 된다 — 롱을 닫으려다 숏을 여는 것이고, 화면에는 둘 다 '매도 주문'으로
   * 보인다. 이 화면에서 가장 조용한 사고다.
   *
   * 방향은 포지션의 반대다. 롱이면 팔고, 숏이면 산다.
   */
  const closeNow = async () => {
    if (!auth || !connId) { setCloseMsg({ ok: false, text: '로그인·연결이 필요합니다' }); return; }
    if (qty <= 0) return;

    const closeSide = closeSideFor(side);
    // 확인 문구에 숫자를 적는다. '청산하시겠습니까?'만 물으면 사람은
    // 읽지 않고 예를 누른다. 무엇이 얼마나 나가는지 보여야 한다.
    const lines = [
      `${v.symbol} ${side} 포지션을 시장가로 전량 청산합니다.`,
      '',
      `수량      ${fmtPrice(qty, 4)}`,
      `방향      ${closeSide} (reduce-only)`,
      mark != null ? `현재 Mark ${fmtPrice(mark)}` : '현재 Mark 확인 불가',
      pnl != null ? `미실현    ${pnl >= 0 ? '+' : ''}${fmtPrice(pnl)} USDT` : '미실현    확인 불가',
      '',
      '시장가라 체결가는 위 Mark와 다를 수 있습니다.',
      '되돌릴 수 없습니다.',
    ];
    const { confirmDialog } = await import('@/lib/confirm/dialog');
    if (!(await confirmDialog(lines.join('\n'), { danger: true }))) return;

    setClosing(true); setCloseMsg(null);
    try {
      const r = await fetch('/api/binance/futures/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          connectionId: connId, confirmToken: 'LIVE_ORDER_CONFIRMED',
          symbol: v.symbol, side: closeSide, type: 'MARKET',
          quantity: qty, reduceOnly: true,
        }),
      });
      const j = await r.json();
      if (r.ok && j?.ok) {
        setCloseMsg({ ok: true, text: `청산 주문 접수됨 · ${String(j.jobId ?? '').slice(0, 8)}` });
        // 대기열을 거치므로 즉시 반영되지 않는다. 잠시 뒤 다시 읽는다.
        setTimeout(onClosed, 2500);
      } else {
        setCloseMsg({ ok: false, text: j?.message || j?.error || `실패 (${r.status})` });
      }
    } catch (e: any) {
      // 응답을 못 받았다. 나갔는지 안 나갔는지 모른다 — 다시 누르면
      // 두 번 청산될 수 있다. 재시도하지 말라고 분명히 말한다.
      setCloseMsg({
        ok: false,
        text: `응답 없음 — 다시 누르지 말고 포지션을 먼저 확인하세요 (${e?.message || e})`,
      });
    } finally { setClosing(false); }
  };

  const Cell = ({ k, v, tone }: { k: string; v: string; tone?: string }) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 2 }}>{k}</div>
      <div style={{ ...NUM, color: tone ?? C.text, fontSize: FS.small, fontWeight: 600 }}>{v}</div>
    </div>
  );
  const money = (v: number | null, d = 2) => (v == null ? '확인 불가' : fmtPrice(v, d));

  return (
    <div style={{
      padding: '11px 12px', borderBottom: `1px solid ${C.hair}`,
    }}>
      {/* 종목 · 방향 · 마진 모드 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9, flexWrap: 'wrap' }}>
        <span style={chip(long ? C.up : C.down, long ? C.upBg : C.downBg)}>
          {long ? 'LONG' : 'SHORT'}
        </span>
        <button onClick={onPick} style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          color: C.text, fontSize: FS.body, fontWeight: 700,
        }}>{p.symbol}</button>
        {/* 교차는 격리 전제(청산가·손실 상한)를 깬다. 눈에 띄어야 한다. */}
        <span style={chip(iso ? C.dim : C.warn)}>
          {iso ? '격리' : '교차'} {lev == null ? '' : `${fmtPrice(lev, 0)}×`}
        </span>
      </div>

      {/* 미실현 손익 · 수익률 — 카드에서 가장 먼저 읽히는 줄 */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 2 }}>미실현 손익 (USDT)</div>
          <div style={{ ...NUM, color: pnlColor(pnl), fontSize: 20, fontWeight: 700 }}>
            {pnl == null ? '확인 불가' : `${pnl >= 0 ? '+' : ''}${fmtPrice(pnl)}`}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 2 }}>수익률</div>
          <div style={{ ...NUM, color: pnlColor(roi), fontSize: FS.num, fontWeight: 700 }}>
            {roi == null ? '—' : `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Cell k="수량" v={money(qty, 4)}/>
        <Cell k={marginIsEst ? '증거금 ≈' : '증거금'} v={money(margin)}/>
        <Cell k="명목가" v={money(notional)}/>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <Cell k="진입가" v={money(entry)}/>
        <Cell k="Mark" v={money(mark)}/>
        {/* 청산가는 이 카드에서 가장 위험한 숫자다 */}
        <Cell k="청산가" v={liq == null ? '없음' : fmtPrice(liq)} tone={liq == null ? C.dim : C.warn}/>
      </div>

      {closeMsg && (
        <div style={{
          padding: '7px 9px', borderRadius: 7, marginBottom: 6,
          background: closeMsg.ok ? C.upBg : C.downBg,
          color: closeMsg.ok ? C.up : C.down, fontSize: FS.micro, lineHeight: 1.5,
        }}>{closeMsg.text}</div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onPick} style={{ ...ghostBtn(), flex: 1, minHeight: 36 }}>
          주문판으로
        </button>
        {/* 시장가 청산. 되돌릴 수 없으므로 확인을 받고, 확인 문구에
            무엇이 얼마나 나가는지 숫자로 적는다. '청산하시겠습니까?'만
            물으면 사람은 읽지 않고 예를 누른다. */}
        <button onClick={closeNow} disabled={closing || qty <= 0}
          style={{
            flex: 1, minHeight: 36, borderRadius: 7,
            cursor: closing || qty <= 0 ? 'default' : 'pointer',
            background: C.downBg, color: C.down,
            border: `1px solid ${A(C.down, '55')}`,
            fontSize: FS.small, fontWeight: 700,
            opacity: closing || qty <= 0 ? 0.5 : 1,
          }}>{closing ? '청산 중…' : '시장가 청산'}</button>
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

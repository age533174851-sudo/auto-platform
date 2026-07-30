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
import { C, FS, NUM, tabStyle, chip, ghostBtn, input, fmtPrice, pnlColor } from './theme';
import { A } from '@/lib/theme/colors';
import { useTerminal } from './TerminalContext';
import { MarketCompare } from './MarketSwitch';
import { WalletTreePanel } from './WalletTree';
import { LedgerPanel } from './LedgerPanel';
import { derivePosition, closeSideFor } from '@/lib/markets/positionView';
import { SpotStrategyPanel } from './SpotStrategyPanel';
import { CombinedPanel } from './CombinedPanel';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';
import { usePaperAccount } from './PaperWallet';

type Tab = '포지션' | '미체결' | '자산' | '전략장부' | '현물전략' | '현물·선물' | '상태대조' | '전략';
const TABS: Tab[] = ['포지션', '미체결', '자산', '전략장부', '현물전략', '현물·선물', '상태대조', '전략'];

/**
 * `flow` — 스크롤을 자기가 갖지 않는다.
 *
 * 기본(false)은 고정 높이 칸 안에서 **자기 안에서** 스크롤한다. PC 하단 독은
 * 그게 맞다 — 칸 크기가 정해져 있다.
 *
 * 모바일에서는 그게 문제였다. 포지션 칸이 27vh로 잠겨 있어서 카드 하나가
 * 다 안 보이고, 화면 스크롤과 칸 안 스크롤이 겹쳐 손가락이 어디에 닿았는지에
 * 따라 다르게 움직인다. `flow`면 높이를 내용에 맡기고 스크롤은 페이지가
 * 가져간다 — 끌어내리면 포지션이 화면을 채운다.
 *
 * 탭 줄은 그때 `sticky`가 된다. 카드 사이를 지나가는 동안 어느 탭인지
 * 사라지면 안 되기 때문이다. 붙는 위치(`stickyTop`)는 헤더 높이라서
 * 바깥에서 받는다 — 여기서 추측하면 헤더가 두 줄일 때 겹친다.
 */
function BottomDockInner({ onBalance, flow, stickyTop }: {
  onBalance?: (v: number | null) => void;
  flow?: boolean;
  stickyTop?: number | string;
}) {
  const { auth, connId, setSymbol, symbols, tradeMode } = useTerminal();
  const isPaper = tradeMode === 'PAPER';
  const paper = usePaperAccount(isPaper);
  const [tab, setTab] = useState<Tab>('포지션');
  const [acct, setAcct] = useState<any>(null);
  const [err, setErr] = useState('');
  const [recon, setRecon] = useState<any>(null);
  const [killing, setKilling] = useState(false);
  const [killMsg, setKillMsg] = useState('');

  const load = useCallback(async () => {
    // 모의에서는 거래소를 부르지 않는다. 부르면 '연결 없음' 오류가 뜨는데
    // 모의는 연결이 없는 것이 정상이다 — 정상 상태를 오류로 그리면 안 된다.
    if (isPaper) return;
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
  }, [auth, connId, onBalance, isPaper]);

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
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: flow ? 'auto' : '100%', minHeight: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        padding: '7px 10px', borderBottom: `1px solid ${C.hair}`,
        // 페이지 스크롤에 얹혀 있을 때는 탭 줄이 헤더 밑에 붙어 있어야 한다.
        // 배경을 깔지 않으면 카드가 탭 줄 뒤로 지나가며 글자가 겹친다.
        ...(flow ? {
          position: 'sticky' as const, top: stickyTop ?? 0, zIndex: 5, background: C.panel,
        } : null),
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

      <div style={flow
        ? { flex: 'none', minHeight: 0 }
        : { flex: 1, minHeight: 0, overflow: 'auto' }}>
        {err && (
          <div style={{
            margin: 10, padding: '10px 12px', borderRadius: 8,
            background: C.warnBg, color: C.warn, fontSize: FS.small, lineHeight: 1.55,
          }}>{err}</div>
        )}

        {tab === '포지션' && (isPaper ? (
          paper.positions.length === 0
            ? <Empty t={paper.err || '열린 모의 포지션이 없습니다'}/>
            : <div>
                {paper.positions.map((p: any) => (
                  <PaperPositionCard key={p.id} p={p} auth={auth} onClosed={paper.reload}
                    onPick={() => {
                      const s = symbols.find(x => x.id === p.symbol);
                      if (s) setSymbol(s);
                    }}/>
                ))}
              </div>
        ) : (
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
        ))}

        {tab === '미체결' && isPaper && (
          <Empty t="모의에는 미체결 주문이 없습니다 — 시장가로만 체결됩니다"/>
        )}

        {tab === '미체결' && !isPaper && (
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
  // 카드 안에서 펼치는 판. 한 번에 하나만 — 둘을 같이 열면 카드가 화면보다 길어지고,
  // 뒤집기와 TP/SL을 동시에 만지는 것은 서로 다른 결과를 기대하는 조작이다.
  const [panel, setPanel] = useState<'reverse' | 'tpsl' | null>(null);
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
        {/* 뒤집기 — 청산 + 반대 진입. 진입이 섞여 있으므로 손절을 받아야
            하고, 그래서 바로 실행하지 않고 판을 편다. */}
        <button onClick={() => { setPanel(p => p === 'reverse' ? null : 'reverse'); }}
          disabled={qty <= 0}
          style={{ ...ghostBtn(panel === 'reverse'), flex: 1, minHeight: 36,
                   opacity: qty <= 0 ? 0.5 : 1 }}>
          뒤집기
        </button>
        <button onClick={() => { setPanel(p => p === 'tpsl' ? null : 'tpsl'); }}
          disabled={qty <= 0}
          style={{ ...ghostBtn(panel === 'tpsl'), flex: 1, minHeight: 36,
                   opacity: qty <= 0 ? 0.5 : 1 }}>
          TP/SL
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
          }}>{closing ? '청산 중…' : '청산'}</button>
      </div>

      {panel === 'reverse' && (
        <ReversePanel v={v} auth={auth} connId={connId}
          onDone={(text, delay) => {
            // 결과 문구를 **카드로 올린다.** 판 안에 두면 판이 닫히는 순간
            // 같이 사라져서, 방금 무슨 일이 일어났는지 화면에 아무것도
            // 남지 않는다 — 뒤집기는 그걸 모르면 안 되는 동작이다.
            setCloseMsg({ ok: true, text });
            setPanel(null);
            setTimeout(onClosed, delay);
          }}/>
      )}
      {panel === 'tpsl' && (
        <TpSlPanel v={v} auth={auth} connId={connId}
          onDone={(text, delay) => {
            setCloseMsg({ ok: true, text });
            setPanel(null);
            setTimeout(onClosed, delay);
          }}/>
      )}

      <button onClick={onPick} style={{
        width: '100%', marginTop: 6, minHeight: 30, background: 'none',
        border: 'none', color: C.faint, fontSize: FS.micro, cursor: 'pointer',
      }}>주문판에서 이 종목 보기</button>
    </div>
  );
}

/**
 * 뒤집기 판.
 *
 * 손절 폭을 먼저 받는다. 없으면 서버가 청산 전에 거부하는데(그쪽에서도 막는다),
 * **청산이 끝난 뒤에 진입이 거부되면 포지션이 사라진 채로 끝난다.** 그러니
 * 화면에서도 값 없이는 누를 수 없어야 한다.
 *
 * 결과 손절가를 숫자로 보여준다. %만 보여주면 그게 청산가 안쪽인지 밖인지
 * 알 수 없고, 배율이 높을수록 그 둘이 가까워진다.
 */
function ReversePanel({ v, auth, connId, onDone }: {
  v: ReturnType<typeof derivePosition>; auth: string; connId: string;
  /** 성공했을 때만 부른다. 문구는 카드가 들고 있어야 판이 닫혀도 남는다 */
  onDone: (text: string, refreshDelayMs: number) => void;
}) {
  const [pct, setPct] = useState(2);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const newSide: 'LONG' | 'SHORT' = v.side === 'LONG' ? 'SHORT' : 'LONG';
  const ref = v.mark ?? v.entry;
  // 새 포지션 기준의 손절이다. 뒤집힌 방향으로 계산해야 한다 —
  // 지금 방향으로 계산하면 걸자마자 발동하는 값이 나온다.
  const stopPrice = ref != null
    ? (newSide === 'LONG' ? ref * (1 - pct / 100) : ref * (1 + pct / 100))
    : null;

  const go = async () => {
    if (!auth || !connId) { setMsg({ ok: false, text: '로그인·연결이 필요합니다' }); return; }
    const lines = [
      `${v.symbol} ${v.side} ${fmtPrice(v.qty, 4)} 를 청산하고`,
      `반대로 ${newSide} ${fmtPrice(v.qty, 4)} 진입합니다.`,
      '',
      `손절      ${stopPrice == null ? '기준가를 몰라 계산 불가' : `${fmtPrice(stopPrice)} (${pct}%)`}`,
      `배율      ${v.leverage == null ? '거래소 설정값' : `${fmtPrice(v.leverage, 0)}×`}`,
      '',
      '청산이 끝난 것을 확인한 뒤에만 반대 진입을 보냅니다.',
      '확인하지 못하면 진입하지 않고 멈춥니다 — 그때는 포지션이 없는 상태입니다.',
      '되돌릴 수 없습니다.',
    ];
    const { confirmDialog } = await import('@/lib/confirm/dialog');
    if (!(await confirmDialog(lines.join('\n'), { danger: true }))) return;

    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/binance/futures/reverse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          connectionId: connId, confirmToken: 'LIVE_ORDER_CONFIRMED',
          symbol: v.symbol, expectedSide: v.side, expectedQty: v.qty,
          leverage: v.leverage ?? undefined, stopLossPct: pct,
        }),
      });
      const j = await r.json();
      const text = j?.message || j?.error || `실패 (${r.status})`;
      if (j?.ok) onDone(text, 2500);
      else setMsg({ ok: false, text });
    } catch (e: any) {
      // 어느 단계에서 끊겼는지 모른다. 다시 누르면 이미 뒤집힌 것을 또 뒤집는다.
      setMsg({ ok: false,
        text: `응답 없음 — 다시 누르지 말고 포지션을 먼저 확인하세요 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 8, padding: '10px 11px', borderRadius: 8, background: C.raised }}>
      <div style={{ color: C.dim, fontSize: FS.micro, marginBottom: 8 }}>
        {v.side} {fmtPrice(v.qty, 4)} → <b style={{ color: newSide === 'LONG' ? C.up : C.down }}>
          {newSide} {fmtPrice(v.qty, 4)}
        </b>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
        <span style={{ color: C.faint, fontSize: FS.micro, minWidth: 26 }}>손절</span>
        {[1, 2, 3, 5, 10].map(p => (
          <button key={p} onClick={() => setPct(p)}
            style={{ ...ghostBtn(pct === p), flex: 1, fontSize: FS.micro, ...NUM }}>{p}%</button>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: FS.micro, marginBottom: 9 }}>
        <span style={{ color: C.faint }}>새 손절가</span>
        <span style={{ ...NUM, color: stopPrice == null ? C.warn : C.text, fontWeight: 600 }}>
          {stopPrice == null ? '기준가 확인 불가' : fmtPrice(stopPrice)}
        </span>
      </div>

      {msg && (
        <div style={{
          padding: '7px 9px', borderRadius: 7, marginBottom: 7,
          background: msg.ok ? C.upBg : C.downBg, color: msg.ok ? C.up : C.down,
          fontSize: FS.micro, lineHeight: 1.5,
        }}>{msg.text}</div>
      )}

      <button onClick={go} disabled={busy || v.qty <= 0}
        style={{
          width: '100%', minHeight: 38, borderRadius: 7,
          cursor: busy ? 'default' : 'pointer',
          background: newSide === 'LONG' ? C.upBg : C.downBg,
          color: newSide === 'LONG' ? C.up : C.down,
          border: `1px solid ${A(newSide === 'LONG' ? C.up : C.down, '55')}`,
          fontSize: FS.small, fontWeight: 700, opacity: busy ? 0.6 : 1,
        }}>
        {busy ? '뒤집는 중…' : `${newSide}으로 뒤집기`}
      </button>
    </div>
  );
}

/**
 * 가격 한 칸 + % 단추들.
 *
 * **컴포넌트 밖에 둔다.** 안에 두면 부모가 다시 그려질 때마다 이것도
 * 새로운 타입이 되어 React가 input을 통째로 갈아 끼운다 — 한 글자 칠 때마다
 * 포커스가 빠져서 사실상 입력을 못 한다. (자동 조작으로는 값을 한 번에
 * 넣으니 안 보이고, 손으로 칠 때만 드러난다.)
 */
function PriceField({ label, value, onChange, presets, onPreset, refPrice, wrong }: {
  label: string; value: string; onChange: (s: string) => void;
  presets: number[]; onPreset: (p: number) => void;
  refPrice: number | null; wrong: boolean;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{ color: C.faint, fontSize: FS.micro, minWidth: 30 }}>{label}</span>
        <input value={value} onChange={e => onChange(e.target.value)}
          inputMode="decimal" placeholder={refPrice != null ? fmtPrice(refPrice) : '가격'}
          style={{ ...input, flex: 1, minHeight: 32, fontSize: FS.small,
                   borderColor: wrong ? C.down : undefined }}/>
      </div>
      <div style={{ display: 'flex', gap: 4, paddingLeft: 36 }}>
        {presets.map(p => (
          <button key={p} onClick={() => onPreset(p)} disabled={refPrice == null}
            style={{ ...ghostBtn(), flex: 1, fontSize: FS.micro, minHeight: 26, ...NUM }}>
            {p}%
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * TP/SL 판.
 *
 * 값을 **가격으로** 보낸다. %로 보내고 서버가 다시 계산하면 화면에 보여준
 * 값과 다른 주문이 걸린다. %는 입력을 돕는 수단일 뿐이다.
 *
 * 방향 검사를 여기서 한 번 한다. LONG의 익절이 현재가 아래면 걸자마자
 * 체결되고, 손절이 위면 걸자마자 발동한다 — 둘 다 화면에서는 '설정됨'이다.
 */
function TpSlPanel({ v, auth, connId, onDone }: {
  v: ReturnType<typeof derivePosition>; auth: string; connId: string;
  onDone: (text: string, refreshDelayMs: number) => void;
}) {
  const ref = v.mark ?? v.entry;
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const long = v.side === 'LONG';
  const fromPct = (pct: number, profit: boolean) => {
    if (ref == null) return '';
    const up = profit ? long : !long;          // 이익 방향인가
    return String(Number((ref * (1 + (up ? pct : -pct) / 100)).toFixed(6)));
  };

  const tpNum = Number(tp), slNum = Number(sl);
  const tpOk = !tp || (Number.isFinite(tpNum) && tpNum > 0);
  const slOk = !sl || (Number.isFinite(slNum) && slNum > 0);
  // 방향이 틀리면 거는 즉시 터진다
  const tpWrong = !!tp && tpOk && ref != null && (long ? tpNum <= ref : tpNum >= ref);
  const slWrong = !!sl && slOk && ref != null && (long ? slNum >= ref : slNum <= ref);
  const blocked = (!tp && !sl) || !tpOk || !slOk || tpWrong || slWrong;

  const go = async () => {
    if (!auth || !connId) { setMsg({ ok: false, text: '로그인·연결이 필요합니다' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/binance/futures/tpsl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          connectionId: connId, symbol: v.symbol, positionSide: v.side,
          tpPrice: tp ? tpNum : undefined,
          slPrice: sl ? slNum : undefined,
        }),
      });
      const j = await r.json();
      const text = j?.message || j?.error || `실패 (${r.status})`;
      if (j?.ok) onDone(`${text} — 익절/손절은 '미체결' 탭에서 확인하세요`, 2000);
      else setMsg({ ok: false, text });
    } catch (e: any) {
      setMsg({ ok: false, text: `응답 없음 — 거래소에서 직접 확인하세요 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 8, padding: '10px 11px', borderRadius: 8, background: C.raised }}>
      <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 8, lineHeight: 1.5 }}>
        전량 청산용 TP/SL을 새로 겁니다. 기존 <b>전량 청산용</b> 주문만 지우고
        분할 익절 사다리는 남깁니다.
      </div>

      <PriceField label="익절" value={tp} onChange={setTp} presets={[1, 2, 5, 10]}
        refPrice={ref} onPreset={p => setTp(fromPct(p, true))} wrong={tpWrong}/>
      <PriceField label="손절" value={sl} onChange={setSl} presets={[1, 2, 3, 5]}
        refPrice={ref} onPreset={p => setSl(fromPct(p, false))} wrong={slWrong}/>

      {(tpWrong || slWrong) && (
        <div style={{
          padding: '7px 9px', borderRadius: 7, marginBottom: 7,
          background: C.downBg, color: C.down, fontSize: FS.micro, lineHeight: 1.5,
        }}>
          {tpWrong && `${v.side} 익절이 현재가(${ref != null ? fmtPrice(ref) : '?'}) ${long ? '아래' : '위'}입니다 — 걸자마자 체결됩니다. `}
          {slWrong && `${v.side} 손절이 현재가 ${long ? '위' : '아래'}입니다 — 걸자마자 발동합니다.`}
        </div>
      )}

      {msg && (
        <div style={{
          padding: '7px 9px', borderRadius: 7, marginBottom: 7,
          background: msg.ok ? C.upBg : C.downBg, color: msg.ok ? C.up : C.down,
          fontSize: FS.micro, lineHeight: 1.5,
        }}>{msg.text}</div>
      )}

      <button onClick={go} disabled={busy || blocked}
        style={{
          width: '100%', minHeight: 38, borderRadius: 7,
          cursor: busy || blocked ? 'default' : 'pointer',
          background: C.accentBg, color: C.accent,
          border: `1px solid ${A(C.accent, '55')}`,
          fontSize: FS.small, fontWeight: 700, opacity: busy || blocked ? 0.5 : 1,
        }}>
        {busy ? '거는 중…' : !tp && !sl ? '익절 또는 손절을 입력하세요' : 'TP/SL 걸기'}
      </button>
    </div>
  );
}

/**
 * 모의 포지션 카드.
 *
 * 실계좌 카드와 **따로 둔다.** 같은 컴포넌트에 조건을 붙이면 언젠가
 * 모의 카드의 청산 버튼이 실계좌 라우트를 부른다 — 그게 이 화면에서
 * 가장 조용한 사고다. 생긴 것은 비슷해도 부르는 곳이 다르다.
 *
 * 가상이라는 사실을 카드에 적는다. 화면만 보고 실계좌와 구분할 수 없으면
 * 모의로 연습하는 의미가 반쯤 사라진다.
 */
function PaperPositionCard({ p, auth, onClosed, onPick }: {
  p: any; auth: string; onClosed: () => void; onPick: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const long = p.side === 'LONG';

  const close = async () => {
    const { confirmDialog } = await import('@/lib/confirm/dialog');
    const okToGo = await confirmDialog([
      `모의 ${p.symbol} ${p.side} ${fmtPrice(p.quantity, 6)}를 청산합니다.`,
      '',
      p.markPrice != null ? `현재가   ${fmtPrice(p.markPrice)}` : '현재가   확인 불가',
      p.unrealizedPnl != null
        ? `평가손익 ${p.unrealizedPnl >= 0 ? '+' : ''}${fmtPrice(p.unrealizedPnl)} USDT`
        : '평가손익 확인 불가',
      '',
      '가상 자금입니다.',
    ].join('\n'));
    if (!okToGo) return;

    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/paper/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ positionId: p.id }),
      });
      const j = await r.json();
      setMsg({ ok: !!j?.ok, text: j?.message || j?.error || `실패 (${r.status})` });
      if (j?.ok) setTimeout(onClosed, 600);
    } catch (e: any) {
      setMsg({ ok: false, text: `실패 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  const Cell = ({ k, v, tone }: { k: string; v: string; tone?: string }) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 2 }}>{k}</div>
      <div style={{ ...NUM, color: tone ?? C.text, fontSize: FS.small, fontWeight: 600 }}>{v}</div>
    </div>
  );

  return (
    <div style={{ padding: '11px 12px', borderBottom: `1px solid ${C.hair}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9, flexWrap: 'wrap' }}>
        <span style={chip(long ? C.up : C.down, long ? C.upBg : C.downBg)}>
          {long ? 'LONG' : 'SHORT'}
        </span>
        <button onClick={onPick} style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          color: C.text, fontSize: FS.body, fontWeight: 700,
        }}>{p.symbol}</button>
        <span style={chip(C.dim)}>격리 {fmtPrice(p.leverage, 0)}×</span>
        {/* 이 칩이 실계좌 카드와의 유일한 구분이다 */}
        <span style={chip(C.accent, C.accentBg)}>모의</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 2 }}>평가손익 (가상 USDT)</div>
          <div style={{ ...NUM, color: pnlColor(p.unrealizedPnl), fontSize: 20, fontWeight: 700 }}>
            {p.unrealizedPnl == null ? '확인 불가'
              : `${p.unrealizedPnl >= 0 ? '+' : ''}${fmtPrice(p.unrealizedPnl)}`}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 2 }}>수익률</div>
          <div style={{ ...NUM, color: pnlColor(p.roiPct), fontSize: FS.num, fontWeight: 700 }}>
            {p.roiPct == null ? '—' : `${p.roiPct >= 0 ? '+' : ''}${p.roiPct.toFixed(2)}%`}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Cell k="수량" v={fmtPrice(p.quantity, 6)}/>
        <Cell k="증거금" v={fmtPrice(p.margin)}/>
        <Cell k="명목가" v={fmtPrice(p.notional)}/>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <Cell k="체결가" v={fmtPrice(p.fillPrice)}/>
        <Cell k="현재가" v={p.markPrice == null ? '확인 불가' : fmtPrice(p.markPrice)}/>
        <Cell k="손절" v={p.stopLoss == null ? '없음' : fmtPrice(p.stopLoss)}
          tone={p.stopLoss == null ? C.down : C.dim}/>
      </div>

      {msg && (
        <div style={{
          padding: '7px 9px', borderRadius: 7, marginBottom: 6,
          background: msg.ok ? C.upBg : C.downBg, color: msg.ok ? C.up : C.down,
          fontSize: FS.micro, lineHeight: 1.5,
        }}>{msg.text}</div>
      )}

      <button onClick={close} disabled={busy}
        style={{
          width: '100%', minHeight: 36, borderRadius: 7,
          cursor: busy ? 'default' : 'pointer',
          background: C.downBg, color: C.down,
          border: `1px solid ${A(C.down, '55')}`,
          fontSize: FS.small, fontWeight: 700, opacity: busy ? 0.6 : 1,
        }}>{busy ? '청산 중…' : '모의 청산'}</button>
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

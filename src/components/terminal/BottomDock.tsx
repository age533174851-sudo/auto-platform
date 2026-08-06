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
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { C, FS, NUM, tabStyle, chip, ghostBtn, input, fmtPrice, pnlColor } from './theme';
import { A } from '@/lib/theme/colors';
import { useTerminal } from './TerminalContext';
import { MarketCompare } from './MarketSwitch';
import { WalletTreePanel } from './WalletTree';
import { LedgerPanel } from './LedgerPanel';
import { derivePosition, closeSideFor } from '@/lib/markets/positionView';
import { splitOrders } from '@/lib/markets/orderView';
import { findAnyStop } from '@/lib/engine/stopVerify';
import { linearLiquidationPrice } from '@/lib/engine/paperPlan';
import { SpotStrategyPanel } from './SpotStrategyPanel';
import { CombinedPanel } from './CombinedPanel';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';
import { usePaperAccount } from './PaperWallet';
import { AllocationPanel } from './AllocationPanel';
import { SafetyLogPanel } from './SafetyLogPanel';
import { TrailPanel } from './TrailPanel';
import { ScheduledExitPanel } from './ScheduledExitPanel';
import { PreferencesPanel } from './PreferencesPanel';
import { loadPrefs } from '@/lib/ui/preferences';
import { KisConnectPanel } from './KisConnectPanel';
import { SystemStatusPanel } from './SystemStatusPanel';
import { TraderSignalPanel } from './TraderSignalPanel';
import { CreatorLedgerPanel } from './CreatorLedgerPanel';
import { LoginDiagnosticPanel } from './LoginDiagnosticPanel';
import { DemoRunner } from './DemoRunner';

type Tab = '포지션' | '데모' | '미체결' | '자산' | '자금배분' | '안전장치' | '손절이동' | '시간예약' | '설정' | '증권사' | '상태' | '방송자' | '로그인' | '전략장부' | '방송장부' | '현물전략' | '현물·선물' | '상태대조' | '전략';
const ALL_TABS: Tab[] = ['포지션', '데모', '미체결', '자산', '자금배분', '안전장치', '손절이동', '시간예약', '설정', '증권사', '상태', '방송자', '로그인', '전략장부', '방송장부', '현물전략', '현물·선물', '상태대조', '전략'];

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
  const { auth, connId, setSymbol, symbols, tradeMode, symbol } = useTerminal();
  const isPaper = tradeMode === 'PAPER';
  const paper = usePaperAccount(isPaper);
  const [tab, setTab] = useState<Tab>('포지션');
  // '데모'는 모의일 때만 나온다. 실전 화면에 '데모 자동매매' 탭이 떠 있으면
  // 그게 지금 도는 것인지 헷갈린다 — 모드가 다르면 아예 안 보이는 편이 낫다.
  const TABS = isPaper ? ALL_TABS : ALL_TABS.filter(t => t !== '데모');
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
      if (!r.ok) { setErr(errorTextOf(j, `조회 실패 (${r.status})`)); return; }
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
      // **지금 화면이 보고 있는 연결로 대조한다.**
      //
      // 예전에는 아무 인자도 안 보냈다. 그러면 서버가 활성 연결 중 하나를
      // 임의로 집고, 연결이 여럿이면 **다른 거래소 상태로 판정**한다.
      // Gate 키가 죽었다는 이유로 바이낸스 주문이 막히는 식이다.
      const q = new URLSearchParams();
      q.set('mode', tradeMode === 'LIVE' ? 'LIVE' : 'TESTNET');
      if (connId) q.set('connectionId', connId);
      const r = await fetch(`/api/reconcile/state?${q}`, { headers: { Authorization: auth } });
      setRecon(await r.json());
    } catch (e: any) { setRecon({ ok: false, error: e?.message || '대조 실패' }); }
  }, [auth, connId, tradeMode]);

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
      setKillMsg(r.ok ? '발동됨 — 신규 진입 차단' : (errorTextOf(j, '발동 실패')));
    } catch (e: any) { setKillMsg(`실패: ${e?.message || e}`); }
    finally { setKilling(false); }
  };

  const positions: any[] = Array.isArray(acct?.positions) ? acct.positions : [];
  // **못 읽었으면 null이다.** 예전에는 `: []`로 떨어졌다 — 조회 실패가
  // "미체결 주문이 없습니다"로 그려졌고, 그건 확인한 적 없는 사실이다.
  // 못 여는 것은 불편이고 못 닫는 것은 사고다: 손절이 있는데 없다고 하면
  // 사용자는 없는 위험을 감수한다.
  const open: any[] | null = Array.isArray(acct?.openOrders) ? acct.openOrders
    : Array.isArray(acct?.orders) ? acct.orders : null;

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
                    // 미체결 주문을 그대로 넘긴다. **못 읽었으면 null이다** —
                    // 빈 배열로 바꾸면 조회 실패가 '손절 없음'으로 읽힌다.
                    openOrders={Array.isArray(acct?.openOrders) ? acct.openOrders
                      : Array.isArray(acct?.orders) ? acct.orders : null}
                    stopWhy={acct?.openOrdersMsg ?? null}
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
          <OpenOrdersPanel orders={open} why={acct?.openOrdersMsg ?? null}
            auth={auth} connId={connId} onChanged={load}/>
        )}

        {tab === '상태대조' && (
          <div style={{ padding: 14, lineHeight: 1.6, fontSize: FS.small }}>
            {!recon ? <Empty t="대조 중"/> : !recon.ok ? (
              <div style={{ padding: '12px 14px', borderRadius: 8, background: C.warnBg }}>
                <div style={{ color: C.warn, fontWeight: 700, marginBottom: 4 }}>
                  대조할 수 없습니다 — {errorTextOf(recon, '사유 미상')}
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

        {tab === '자금배분' && <AllocationPanel/>}
        {/* 설정값이 아니라 **실제로 막은 기록**을 본다.
            켜졌다고 믿는 안전장치가 안 도는 것이 이 저장소에서 가장 자주
            나온 사고라, 그 사실이 한 화면에 드러나야 한다. */}
        {tab === '안전장치' && <SafetyLogPanel/>}
        {/* 트레일링은 **이미 돌고 있는데** 화면이 없었다. 손절이 자기도
            모르게 움직이면, 그 손절에 걸려 나갔을 때 이유를 알 수 없다. */}
        {tab === '손절이동' && <TrailPanel/>}

        {/* 시간 예약 청산. 이 판은 예약과 함께 **실행기 상태**를 늘 띄운다 —
            크론이 하루 1회뿐이라 '예약됨'만 적으면 거짓말이 된다. */}
        {tab === '시간예약' && <ScheduledExitPanel/>}

        {/* 화면 기본값. 여기 있는 스위치는 전부 실제로 무언가를 바꾼다 —
            눌러도 아무 일 안 하는 스위치를 두면 화면 전체를 못 믿게 된다. */}
        {tab === '설정' && <PreferencesPanel/>}
        {tab === '증권사' && <KisConnectPanel/>}
        {tab === '상태' && <SystemStatusPanel/>}
        {tab === '방송자' && <TraderSignalPanel/>}
        {/* 검수 → 장부 → 판정. 방송자 탭과 나눈 이유는 하는 일이 다르기
            때문이다 — 저쪽은 기록이고 여기는 **그 기록으로 판정**한다. */}
        {tab === '방송장부' && <CreatorLedgerPanel/>}
        {tab === '로그인' && <LoginDiagnosticPanel/>}
        {tab === '데모' && (
          <div style={{ padding: 12 }}>
            <DemoRunner symbol={symbol.id} onChanged={paper.reload}/>
          </div>
        )}


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
function PositionCard({ p, onPick, auth, connId, onClosed, openOrders, stopWhy }: {
  p: any;
  onPick: () => void;
  auth: string;
  connId: string;
  /** 청산이 접수되면 목록을 다시 읽는다 */
  onClosed: () => void;
  /** 거래소 미체결 주문. **못 읽었으면 null** — 빈 배열과 다르다 */
  openOrders?: any[] | null;
  /** 미체결 주문을 못 읽었을 때의 거래소 원문. 없으면 표시하지 않는다 */
  stopWhy?: string | null;
}) {
  const [closing, setClosing] = useState(false);
  const [closeMsg, setCloseMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 버튼 구성·표시 밀도는 설정이 정한다. 한 번 읽는다 — 설정을 바꾸면
  // 그 탭에서 저장되고, 포지션 탭으로 돌아오면 새로 마운트된다.
  const [prefs] = useState(() => loadPrefs());
  // 카드 안에서 펼치는 판. 한 번에 하나만 — 둘을 같이 열면 카드가 화면보다 길어지고,
  // 뒤집기와 TP/SL을 동시에 만지는 것은 서로 다른 결과를 기대하는 조작이다.
  const [panel, setPanel] = useState<'reverse' | 'tpsl' | 'lev' | null>(null);
  // 값 해석은 테스트가 있는 순수 함수가 한다. 청산가 0·증거금 추정·
  // 0으로 나누기 셋 다 화면에서는 그럴듯해 보여서 눈으로 못 잡는다.
  const v = derivePosition(p);
  const { side, qty, isolated: iso, leverage: lev, entry, mark, liq,
          pnl, notional, margin, marginEstimated: marginIsEst, roi } = v;
  const long = side === 'LONG';

  // ── 이 포지션에 손절이 걸려 있는가 ──
  //
  // 이 줄이 없어서, 테스트넷에 5배 포지션이 열렸는데 거래소에는
  // Open Orders(0)인 상태를 **사람이 거래소에 직접 들어가서** 확인해야 했다.
  // 손절 없는 레버리지 포지션은 이 화면에서 가장 급한 사실인데 어디에도
  // 안 적혀 있었다.
  const stopCheck = useMemo(
    () => findAnyStop(openOrders, {
      symbol: String(p?.symbol || ''),
      positionSide: side === 'LONG' ? 'LONG' : 'SHORT',
      // **방향을 모르면 조회하지 않는다.** 반대편을 뒤지면 멀쩡히 걸려 있는
      // 손절이 '없음'으로 나온다. 실제로 그랬다 — Gate가 수량을 절대값으로
      // 보내 숏이 롱으로 읽혔고, 숏의 손절(BUY)을 롱의 손절(SELL)로
      // 찾다가 못 찾아 "손절 없음"이라고 적었다.
      sideKnown: v.sideKnown,
      refPrice: mark,
    }),
    [openOrders, p?.symbol, side, v.sideKnown, mark]);

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
    // **조용히 돌아가지 않는다.** 예전에는 그냥 return이라, 청산을 눌러도
    // 아무 일도 안 일어나고 이유도 없었다. 닫으려는 사람에게 침묵은
    // 최악의 응답이다 — 버튼이 고장 났는지 조건이 안 맞는지 알 수 없다.
    if (!Number.isFinite(qty) || qty <= 0) {
      setCloseMsg({ ok: false, text:
        `청산할 수량을 읽지 못했습니다 (${qty}) — 거래소에서 직접 닫으세요` });
      return;
    }

    // **방향을 모르면 청산하지 않는다.**
    //
    // 청산은 포지션의 반대 방향으로 나간다. 방향이 틀리면 reduceOnly가
    // 거래소에서 거절되거나(아무 일도 안 일어남) — 더 나쁘게는 —
    // reduceOnly가 안 붙은 경로에서 **포지션이 두 배가 된다.**
    // 여기서 막지 않으면 그 판단을 거래소에 떠넘기는 셈이다.
    if (!v.sideKnown) {
      setCloseMsg({ ok: false, text:
        `포지션 방향을 확인하지 못해 청산하지 않았습니다`
        + `${v.sideConflict ? ` — ${v.sideConflict}` : ''}. 거래소 앱에서 직접 닫으세요.` });
      return;
    }

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
          // 아는 값이면 실어 보낸다. 서버가 못 읽었을 때 0으로 떨어지는
          // 것을 막는다 — 청산은 이제 배율 없이도 통과하지만, 기록에는
          // 실제 배율이 남는 편이 낫다.
          leverage: v.leverage != null && v.leverage >= 1 ? Math.round(v.leverage) : undefined,
        }),
      });
      const j = await r.json();
      if (r.ok && j?.ok) {
        setCloseMsg({ ok: true, text: `청산 주문 접수됨 · ${String(j.jobId ?? '').slice(0, 8)}` });
        // 대기열을 거치므로 즉시 반영되지 않는다. 잠시 뒤 다시 읽는다.
        setTimeout(onClosed, 2500);
      } else {
        setCloseMsg({ ok: false, text: errorTextOf(j, `실패 (${r.status})`) });
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
        {/* 손절이 걸려 있는가. **세 상태를 구분한다** — 있음 / 없음 /
            확인 못 함. 못 읽은 것을 '없음'으로 그리면 조회가 한 번 실패할
            때마다 멀쩡한 포지션이 위험해 보이고, 곧 아무도 안 믿는다. */}
        <span style={chip(
          stopCheck.status === 'attached' ? C.up
            : stopCheck.status === 'missing' ? C.down : C.warn,
          stopCheck.status === 'attached' ? C.upBg
            : stopCheck.status === 'missing' ? C.downBg : undefined,
        )} title={stopCheck.reason}>
          {/* '확인 못 함'을 '없음'처럼 읽히게 두지 않는다. `손절 ?`는
              물음표 하나라 지나쳤다 — 조회에 실패했다고 글자로 적는다. */}
          {stopCheck.status === 'attached'
            ? (stopCheck.foundStopPrice != null
                ? `손절 ${fmtPrice(stopCheck.foundStopPrice)}`
                : '손절 있음')
            : stopCheck.status === 'missing' ? '손절 없음' : '손절 조회 실패'}
        </span>
      </div>

      {/* ── 방향을 확인하지 못했다 ──
          방향이 틀리면 이 카드의 **전부**가 틀린다: 손절 조회가 반대편을
          뒤지고, 청산 버튼이 반대로 나가고, 경고문이 반대로 계산된다.
          그래서 숫자를 그리기 전에 이 사실을 먼저 적는다. */}
      {!v.sideKnown && (
        <div style={{
          padding: '8px 10px', borderRadius: 7, marginBottom: 9,
          background: C.warnBg, color: C.warn, fontSize: FS.micro, lineHeight: 1.6,
        }}>
          <b>포지션 방향을 확인하지 못했습니다.</b>{' '}
          {v.sideConflict
            ? `${v.sideConflict}. `
            : '거래소가 방향도 수량 부호도 주지 않았습니다. '}
          화면의 롱/숏 표시와 아래 경고는 <b>믿을 수 없습니다</b> —
          거래소 앱에서 방향을 확인한 뒤 조작하세요.
        </div>
      )}

      {/* 손절은 있는데 방향이 이상하다. '있음'과 '쓸모 있음'은 다르다 —
          롱의 손절이 현재가 위에 있으면 걸자마자 발동한다. */}
      {stopCheck.status === 'attached' && stopCheck.warning && (
        <div style={{
          padding: '7px 9px', borderRadius: 7, marginBottom: 9,
          background: C.warnBg, color: C.warn, fontSize: FS.micro, lineHeight: 1.55,
        }}>{stopCheck.warning}</div>
      )}

      {/* 손절 없는 레버리지 포지션은 이 화면에서 가장 급한 사실이다.
          칩 하나로는 지나친다 — 무엇을 하라는 말까지 적는다. */}
      {stopCheck.status === 'missing' && (
        <div style={{
          padding: '8px 10px', borderRadius: 7, marginBottom: 9,
          background: C.downBg, color: C.down, fontSize: FS.micro, lineHeight: 1.6,
        }}>
          <b>손절이 걸려 있지 않습니다.</b>{' '}
          {lev != null && lev > 1
            ? `${fmtPrice(lev, 0)}배에서는 가격이 약 ${(100 / lev).toFixed(1)}%만 반대로 가도 청산됩니다. `
            : ''}
          아래 <b>TP/SL</b>에서 손절을 걸거나 포지션을 닫으세요.
        </div>
      )}
      {stopCheck.status === 'unknown' && (
        <div style={{
          padding: '7px 9px', borderRadius: 7, marginBottom: 9,
          background: C.raised, color: C.warn, fontSize: FS.micro, lineHeight: 1.5,
        }}>
          {/* 사유를 그대로 적는다. 예전에는 원인이 무엇이든 "미체결 주문을
              읽지 못했습니다"로 고정이라, 방향을 못 읽어서 못 찾은 경우까지
              조회 실패로 보였다. */}
          손절이 걸렸는지 확인하지 못했습니다 — {stopCheck.reason}
          <b> 없다는 뜻이 아닙니다.</b>
          {/* **왜 못 읽었는지를 적는다.**

              이 문구만 있을 때는 원인이 네트워크인지·인증인지·연결
              불일치인지 알 방법이 없었다. 실제 원인은 그중 아무것도
              아니었고 — 서버가 읽어 놓고 응답에 안 실은 것이었다.
              거래소 오류 원문과 어느 연결로 물어봤는지를 같이 적으면
              그런 것을 화면에서 바로 가른다. */}
          {stopWhy && (
            <div style={{ color: C.dim, marginTop: 4 }}>
              거래소 응답: {stopWhy}
            </div>
          )}
          <div style={{ color: C.faint, marginTop: 3 }}>
            연결 {String(connId || '').slice(0, 8) || '알 수 없음'}
            {' · '}거래소에서 직접 확인하는 것이 가장 확실합니다.
          </div>
        </div>
      )}

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

      {/* 어떤 버튼을 어느 순서로 놓을지는 **설정**이 정한다(화면 탭).
          예전에는 넷이 고정이라 좁은 화면에서 글자가 잘렸고, 안 쓰는
          버튼이 자리를 차지했다. 설정에서 최소 하나는 남게 막아 뒀다 —
          다 끄면 여기서 청산조차 못 한다. */}
      <div style={{ display: 'flex', gap: 6 }}>
        {prefs.positionButtons.map(b => {
          const off = qty <= 0;
          if (b === 'REVERSE') return (
            // 뒤집기 — 청산 + 반대 진입. 진입이 섞여 있으므로 손절을 받아야
            // 하고, 그래서 바로 실행하지 않고 판을 편다.
            <button key={b} onClick={() => { setPanel(x => x === 'reverse' ? null : 'reverse'); }}
              disabled={off}
              style={{ ...ghostBtn(panel === 'reverse'), flex: 1, minHeight: 36, opacity: off ? 0.5 : 1 }}>
              뒤집기
            </button>
          );
          if (b === 'TPSL') return (
            <button key={b} onClick={() => { setPanel(x => x === 'tpsl' ? null : 'tpsl'); }}
              disabled={off}
              style={{ ...ghostBtn(panel === 'tpsl'), flex: 1, minHeight: 36, opacity: off ? 0.5 : 1 }}>
              TP/SL
            </button>
          );
          if (b === 'LEVERAGE') return (
            // 배율은 '얼마나 벌 수 있나'의 손잡이처럼 보이지만 실제로 바뀌는
            // 것은 **청산가**다. 그래서 포지션 카드에 둔다 — 청산가 바로 옆.
            <button key={b} onClick={() => { setPanel(x => x === 'lev' ? null : 'lev'); }}
              disabled={off}
              style={{ ...ghostBtn(panel === 'lev'), flex: 1, minHeight: 36, opacity: off ? 0.5 : 1 }}>
              배율
            </button>
          );
          // 시장가 청산. 되돌릴 수 없으므로 확인을 받고, 확인 문구에
          // 무엇이 얼마나 나가는지 숫자로 적는다. '청산하시겠습니까?'만
          // 물으면 사람은 읽지 않고 예를 누른다.
          return (
            <button key={b} onClick={closeNow} disabled={closing || off}
              style={{
                flex: 1, minHeight: 36, borderRadius: 7,
                cursor: closing || off ? 'default' : 'pointer',
                background: C.downBg, color: C.down,
                border: `1px solid ${A(C.down, '55')}`,
                fontSize: FS.small, fontWeight: 700,
                opacity: closing || off ? 0.5 : 1,
              }}>{closing ? '청산 중…' : '청산'}</button>
          );
        })}
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
      {panel === 'lev' && (
        <LeveragePanel v={v} auth={auth} connId={connId}
          onDone={(text, delay) => {
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
      const text = errorTextOf(j, `실패 (${r.status})`);
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
 * 배율 변경 판.
 *
 * 이 화면에서 가장 오해하기 쉬운 조작이다. 배율은 "얼마나 벌 수 있나"의
 * 손잡이처럼 보이지만, 들고 있는 포지션에서 실제로 바뀌는 것은 **청산가**다.
 * 100 → 50으로 내리면 청산가가 멀어지고, 올리면 **현재가 쪽으로 다가온다.**
 *
 * 그래서 고르는 즉시 바뀔 청산가를 계산해 보여주고, 현재가를 이미 넘는
 * 값은 누르지 못하게 한다. 서버도 같은 검사를 한 번 더 한다 — 화면 계산은
 * 추정이고, 되돌릴 수 없는 판단을 화면 계산 하나에 맡기지 않는다.
 */
function LeveragePanel({ v, auth, connId, onDone }: {
  v: ReturnType<typeof derivePosition>; auth: string; connId: string;
  onDone: (text: string, refreshDelayMs: number) => void;
}) {
  const cur = v.leverage == null ? null : Math.round(v.leverage);
  const [next, setNext] = useState<number>(cur ?? 5);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const entry = v.entry;
  const mark = v.mark;
  // 화면 추정도 서버와 **같은 규칙**으로 계산한다(유지증거금 1%). 둘이 다르면
  // 화면에서 통과한 값이 서버에서 막히고, 사용자는 이유를 알 수 없다.
  const projected = (entry != null && entry > 0)
    ? linearLiquidationPrice(entry, next, v.side === 'LONG' ? 'LONG' : 'SHORT', 1.0)
    : null;
  const wouldLiq = projected != null && mark != null && mark > 0
    && (v.side === 'LONG' ? mark <= projected : mark >= projected);
  const distPct = projected != null && mark != null && mark > 0
    ? Math.abs((mark - projected) / mark) * 100 : null;

  const go = async () => {
    if (!auth || !connId) { setMsg({ ok: false, text: '로그인·연결이 필요합니다' }); return; }
    const { confirmDialog } = await import('@/lib/confirm/dialog');
    const okToGo = await confirmDialog([
      `${v.symbol} 배율을 ${cur ?? '?'}배 → ${next}배로 바꿉니다.`,
      '',
      '들고 있는 포지션의 **청산가가 함께 움직입니다.**',
      projected != null ? `바뀐 뒤 청산가  약 ${fmtPrice(projected)}` : '바뀐 뒤 청산가  계산 불가',
      mark != null ? `현재 Mark      ${fmtPrice(mark)}` : '현재 Mark      확인 불가',
      distPct != null ? `청산까지        약 ${distPct.toFixed(2)}%` : '',
      '',
      '청산가는 추정치입니다. 실제 값은 바꾼 뒤 포지션에서 확인하세요.',
    ].filter(Boolean).join('\n'), { danger: (distPct ?? 99) < 3 });
    if (!okToGo) return;

    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/binance/futures/leverage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ connectionId: connId, symbol: v.symbol, leverage: next }),
      });
      const j = await r.json();
      const text = errorTextOf(j, `실패 (${r.status})`);
      if (r.ok && j?.ok) onDone(j.warning ? `${text} — ${j.warning}` : text, 2000);
      else setMsg({ ok: false, text });
    } catch (e: any) {
      // 응답을 못 받았다. 바뀌었는지 아닌지 모른다.
      setMsg({ ok: false, text: `응답 없음 — 다시 누르지 말고 포지션의 배율을 먼저 확인하세요 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  // 눌러서 고르는 값과 끌어서 고르는 값을 같은 범위 안에 둔다. 눈금은
  // 거래소(Adjust Leverage)와 같은 자리에 찍는다 — 다른 자리에 찍으면
  // 같은 화면을 보고 다른 배율을 기억하게 된다.
  const MAX_LEV = 125;
  const clampLev = (n: number) => Math.min(MAX_LEV, Math.max(1, Math.round(n)));
  const TICKS = [1, 25, 50, 75, 100, 125];
  const risky = next >= 50;
  const stepBtn = (label: string, to: number, off: boolean) => (
    <button type="button" onClick={() => setNext(clampLev(to))} disabled={off}
      style={{
        width: 38, minHeight: 34, borderRadius: 6, border: 'none',
        cursor: off ? 'default' : 'pointer',
        background: C.panel, color: off ? C.faint : C.text,
        fontSize: FS.lead, fontWeight: 800,
      }}>{label}</button>
  );

  return (
    <div style={{ marginTop: 8, padding: '10px 11px', borderRadius: 8, background: C.raised }}>
      <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 8, lineHeight: 1.5 }}>
        지금 <b style={{ color: C.text }}>{cur == null ? '확인 불가' : `${cur}배`}</b>.
        배율을 바꾸면 <b style={{ color: C.warn }}>이 포지션의 청산가도 함께 움직입니다.</b>
      </div>

      {/* − 5× + . 한 배씩 고르는 길이 없으면 눈금 사이 값은 못 고른다 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
        padding: '4px 5px', borderRadius: 8, background: C.panel,
        border: `1px solid ${C.hair}`,
      }}>
        {stepBtn('−', next - 1, next <= 1)}
        <input
          value={String(next)}
          inputMode="numeric"
          onChange={e => {
            // 지우는 중일 수 있다. 빈 칸을 1로 바꾸면 숫자를 못 지운다.
            const raw = e.target.value.replace(/[^0-9]/g, '');
            if (raw === '') return;
            setNext(clampLev(Number(raw)));
          }}
          style={{
            flex: 1, minWidth: 0, textAlign: 'center',
            background: 'transparent', border: 'none', outline: 'none',
            color: risky ? C.warn : C.text,
            fontSize: FS.lead, fontWeight: 800, ...NUM,
          }}/>
        <span style={{ color: C.dim, fontSize: FS.small, fontWeight: 700 }}>×</span>
        {stepBtn('+', next + 1, next >= MAX_LEV)}
      </div>

      {/* 끌어서 고르기. 50배부터는 손잡이 색이 바뀐다 */}
      <input
        type="range" min={1} max={MAX_LEV} step={1} value={next}
        onChange={e => setNext(clampLev(Number(e.target.value)))}
        style={{
          width: '100%', minHeight: 0, height: 26, margin: 0,
          accentColor: risky ? C.down : C.accent, cursor: 'pointer',
        }}/>
      {/* 눈금은 누를 수 있다 — 끌기가 어려운 화면에서도 한 번에 간다 */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', marginBottom: 9,
      }}>
        {TICKS.map(L => (
          <button key={L} type="button" onClick={() => setNext(L)} style={{
            minHeight: 22, padding: '0 2px', border: 'none', background: 'transparent',
            cursor: 'pointer', ...NUM, fontSize: FS.micro, fontWeight: 700,
            color: next === L ? (L >= 50 ? C.down : C.accent) : C.faint,
          }}>{L}×</button>
        ))}
      </div>

      {/* 바뀐 뒤 청산가. 이 판의 핵심 숫자다 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: FS.micro, marginBottom: 4 }}>
        <span style={{ color: C.faint }}>바뀐 뒤 청산가 (추정)</span>
        <span style={{ ...NUM, color: projected == null ? C.warn : wouldLiq ? C.down : C.text, fontWeight: 700 }}>
          {projected == null ? '계산 불가' : fmtPrice(projected)}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: FS.micro, marginBottom: 9 }}>
        <span style={{ color: C.faint }}>청산까지</span>
        <span style={{ ...NUM, color: distPct == null ? C.warn : distPct < 3 ? C.down : C.dim, fontWeight: 700 }}>
          {distPct == null ? '확인 불가' : `${distPct.toFixed(2)}%`}
        </span>
      </div>

      {wouldLiq && (
        <div style={{
          padding: '7px 9px', borderRadius: 7, marginBottom: 7,
          background: C.downBg, color: C.down, fontSize: FS.micro, lineHeight: 1.5,
        }}>
          이 배율이면 청산가가 현재가를 이미 넘습니다 — <b>바꾸는 즉시 청산됩니다.</b>
        </div>
      )}

      {msg && (
        <div style={{
          padding: '7px 9px', borderRadius: 7, marginBottom: 7,
          background: msg.ok ? C.upBg : C.downBg, color: msg.ok ? C.up : C.down,
          fontSize: FS.micro, lineHeight: 1.5,
        }}>{msg.text}</div>
      )}

      <button onClick={go} disabled={busy || wouldLiq || next === cur || v.qty <= 0}
        style={{
          width: '100%', minHeight: 38, borderRadius: 7,
          cursor: busy || wouldLiq || next === cur ? 'default' : 'pointer',
          background: C.accentBg, color: C.accent,
          border: `1px solid ${A(C.accent, '55')}`,
          fontSize: FS.small, fontWeight: 700,
          opacity: busy || wouldLiq || next === cur ? 0.5 : 1,
        }}>
        {busy ? '바꾸는 중…'
          : next === cur ? '지금과 같은 배율입니다'
          : wouldLiq ? '이 배율로는 바꿀 수 없습니다'
          : `${next}배로 바꾸기`}
      </button>

      <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 7, lineHeight: 1.5 }}>
        청산가는 유지증거금 구간을 넉넉히 잡은 <b>추정치</b>입니다 — 실제 청산은
        이보다 가까울 수 있습니다. 바꾼 뒤 포지션에서 거래소 값을 확인하세요.
      </div>
    </div>
  );
}

/**
 * 이 가격에 닿으면 손익이 얼마인가.
 *
 * 두 가지를 같이 적는다:
 *   · **금액**(USDT) — 실제로 계좌에서 늘거나 줄어드는 값
 *   · **수익률**(ROI) — 증거금 대비. 가격이 1% 움직여도 10배면 10%다
 *
 * 수량이나 진입가를 모르면 **계산하지 않는다.** 0으로 적으면 '손익 없음'이
 * 되는데, 그건 이 화면에서 가장 위험한 거짓말이다.
 */
function PnlPreview({ label, price, v, ok }: {
  label: string;
  price: number;
  v: ReturnType<typeof derivePosition>;
  /** 입력이 유효한가. 아니면 아무것도 안 그린다 */
  ok: boolean;
}) {
  if (!ok || !Number.isFinite(price) || price <= 0) return null;
  const entry = v.entry;
  const qty = v.qty;
  if (entry == null || !(entry > 0) || !(qty > 0)) {
    return (
      <div style={{ color: C.warn, fontSize: FS.micro, margin: '-4px 0 8px 36px', lineHeight: 1.5 }}>
        {label} 손익을 계산할 수 없습니다 — 진입가·수량을 확인하지 못했습니다
      </div>
    );
  }
  const dir = v.side === 'LONG' ? 1 : -1;
  const pnl = (price - entry) * qty * dir;
  // 증거금을 모르면 수익률은 내지 않는다. 명목가로 대신 계산하면 레버리지가
  // 빠져서 실제보다 훨씬 작은 숫자가 나온다.
  const roi = v.margin != null && v.margin > 0 ? (pnl / v.margin) * 100 : null;
  const tone = pnl >= 0 ? C.up : C.down;
  return (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
      margin: '-4px 0 8px 36px', fontSize: FS.micro, ...NUM,
    }}>
      <span style={{ color: C.faint, fontFamily: 'inherit' }}>이 가격이면</span>
      <span style={{ color: tone, fontWeight: 700 }}>
        {pnl >= 0 ? '+' : ''}{fmtPrice(pnl)} USDT
      </span>
      <span style={{ color: roi == null ? C.warn : tone }}>
        {roi == null ? '수익률 계산 불가(증거금 모름)'
          : `(${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%)`}
      </span>
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

  // ── 세 갈래 ──
  //
  // 거래소 시트도 이렇게 나눠 둔다(TP/SL · Position TP/SL · Trailing Stop).
  // 한 폼에 다 넣으면 '전량인 줄 알고 걸었는데 30%만 걸린' 같은 일이 난다 —
  // 걸린 뒤에는 미체결 탭을 봐야 알 수 있고, 그때는 이미 늦다.
  const [mode, setMode] = useState<'PARTIAL' | 'POSITION' | 'TRAIL'>('POSITION');

  // 트리거 기준. 기본은 Mark — 얇은 호가의 한 틱 꼬리에 손절이 털리는 것을
  // 줄인다. 거래소도 Last/Mark를 고르게 해 둔다.
  // 설정에서 고른 기본값으로 시작한다. 매번 같은 값을 다시 고르지 않게.
  const [trigger, setTrigger] = useState<'MARK' | 'LAST'>(() => loadPrefs().trigger);

  // 몇 %를 닫을 것인가. **POSITION 탭에서는 쓰지 않는다**(항상 전량).
  const [portion, setPortion] = useState(100);

  // 트레일링
  const [callback, setCallback] = useState('1');
  const [activation, setActivation] = useState('');

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

  // **손절이 청산가 너머면 손절은 작동할 기회가 없다.**
  // 거래소도 경고만 하고 받는다 — 그러면 청산이 먼저 닿는다.
  const slBeyondLiq = !!sl && slOk && !slWrong && v.liq != null && v.liq > 0
    && (long ? slNum <= v.liq : slNum >= v.liq);

  const cbNum = Number(callback);
  const cbOk = Number.isFinite(cbNum) && cbNum >= 0.1 && cbNum <= 10;
  const actNum = activation ? Number(activation) : null;
  const actWrong = actNum != null && ref != null
    && (long ? actNum <= ref : actNum >= ref);

  const blocked = mode === 'TRAIL'
    ? (!cbOk || actWrong)
    : ((!tp && !sl) || !tpOk || !slOk || tpWrong || slWrong || slBeyondLiq);

  const go = async () => {
    if (!auth || !connId) { setMsg({ ok: false, text: '로그인·연결이 필요합니다' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/binance/futures/tpsl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          connectionId: connId, symbol: v.symbol, positionSide: v.side,
          trigger,
          // POSITION 탭은 **항상 전량**이다. 여기서 portion을 같이 보내면
          // 탭을 바꾸고 남은 값이 조용히 따라간다.
          portionPct: mode === 'POSITION' ? undefined : portion,
          ...(mode === 'TRAIL'
            ? { trailing: { callbackRate: cbNum, activationPrice: actNum ?? undefined } }
            : { tpPrice: tp ? tpNum : undefined, slPrice: sl ? slNum : undefined }),
        }),
      });
      const j = await r.json();
      const text = errorTextOf(j, `실패 (${r.status})`);
      if (j?.ok) onDone(`${text} — 익절/손절은 '미체결' 탭에서 확인하세요`, 2000);
      else setMsg({ ok: false, text });
    } catch (e: any) {
      setMsg({ ok: false, text: `응답 없음 — 거래소에서 직접 확인하세요 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 8, padding: '10px 11px', borderRadius: 8, background: C.raised }}>

      {/* 세 갈래. 거래소 시트와 같은 순서로 둔다 — 두 화면을 오가는 사람이
          같은 자리에서 같은 것을 찾을 수 있어야 한다. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4, marginBottom: 9 }}>
        {([['POSITION', '전량'], ['PARTIAL', '부분'], ['TRAIL', '트레일링']] as const).map(([m, label]) => (
          <button key={m} onClick={() => setMode(m)} style={{
            minHeight: 30, borderRadius: 7, cursor: 'pointer',
            background: mode === m ? C.accent : C.panel,
            color: mode === m ? '#fff' : C.dim,
            border: `1px solid ${mode === m ? 'transparent' : C.hair}`,
            fontSize: FS.micro, fontWeight: 700,
          }}>{label}</button>
        ))}
      </div>

      {/* 트리거 기준. 예전에는 코드에 Mark로 박혀 있어서 고를 수 없었다. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ color: C.faint, fontSize: FS.micro, flexShrink: 0 }}>트리거</span>
        {([['MARK', 'Mark'], ['LAST', 'Last']] as const).map(([t, label]) => (
          <button key={t} onClick={() => setTrigger(t)} style={{
            flex: 1, minHeight: 26, borderRadius: 6, cursor: 'pointer',
            background: trigger === t ? C.raised : 'transparent',
            color: trigger === t ? C.text : C.dim,
            border: `1px solid ${trigger === t ? C.hair2 : C.hair}`,
            fontSize: FS.micro, fontWeight: 700,
          }}>{label}</button>
        ))}
      </div>
      <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 8, lineHeight: 1.5 }}>
        {trigger === 'MARK'
          ? 'Mark(지수 기반) — 순간적인 꼬리에 덜 걸립니다.'
          : 'Last(최종 체결가) — 얇은 호가에서는 한 틱 꼬리에도 발동할 수 있습니다.'}
      </div>

      {/* 몇 %를 닫는가. 전량 탭에서는 묻지 않는다 */}
      {mode !== 'POSITION' && (
        <div style={{ marginBottom: 9 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: C.faint, fontSize: FS.micro }}>청산 비율</span>
            <span style={{ ...NUM, color: C.text, fontSize: FS.micro, fontWeight: 700 }}>
              {portion}%{v.qty > 0 ? ` · ${fmtPrice(v.qty * portion / 100, 6)}` : ''}
            </span>
          </div>
          <input type="range" min={1} max={100} step={1} value={portion}
            onChange={e => setPortion(Number(e.target.value))}
            style={{ width: '100%', minHeight: 0, height: 24, margin: 0, accentColor: C.accent }}/>
          <div style={{ display: 'flex', gap: 4 }}>
            {[25, 50, 75, 100].map(p => (
              <button key={p} onClick={() => setPortion(p)} style={{
                flex: 1, minHeight: 24, borderRadius: 6, cursor: 'pointer',
                background: portion === p ? C.accentBg : C.panel,
                color: portion === p ? C.accent : C.dim,
                border: `1px solid ${portion === p ? C.accent : C.hair}`,
                fontSize: FS.micro, fontWeight: 700, ...NUM,
              }}>{p}%</button>
            ))}
          </div>
        </div>
      )}

      {mode === 'TRAIL' ? (
        <>
          {/* 콜백 비율 — 거래소가 0.1~10%만 받는다 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ color: C.faint, fontSize: FS.micro, width: 46, flexShrink: 0 }}>콜백</span>
            <input value={callback} inputMode="decimal"
              onChange={e => setCallback(e.target.value.replace(/[^0-9.]/g, ''))}
              style={{ ...input, flex: 1, padding: '8px 10px', ...NUM }}/>
            <span style={{ color: C.dim, fontSize: FS.micro, fontWeight: 700 }}>%</span>
            {[1, 5, 10].map(p => (
              <button key={p} onClick={() => setCallback(String(p))} style={{
                minHeight: 26, padding: '0 9px', borderRadius: 6, cursor: 'pointer',
                background: callback === String(p) ? C.accentBg : C.panel,
                color: callback === String(p) ? C.accent : C.dim,
                border: `1px solid ${callback === String(p) ? C.accent : C.hair}`,
                fontSize: FS.micro, fontWeight: 700, ...NUM,
              }}>{p}%</button>
            ))}
          </div>
          {!cbOk && (
            <div style={{ color: C.down, fontSize: FS.micro, marginBottom: 6, lineHeight: 1.5 }}>
              콜백 비율은 0.1~10% 사이여야 합니다 (거래소 제한).
            </div>
          )}

          {/* 발동가는 선택. 비우면 지금 마크가에서 바로 추적을 시작한다 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ color: C.faint, fontSize: FS.micro, width: 46, flexShrink: 0 }}>발동가</span>
            <input value={activation} inputMode="decimal" placeholder="비우면 즉시 추적 시작"
              onChange={e => setActivation(e.target.value.replace(/[^0-9.]/g, ''))}
              style={{ ...input, flex: 1, padding: '8px 10px', ...NUM }}/>
          </div>
          {actWrong && (
            <div style={{
              padding: '7px 9px', borderRadius: 7, marginBottom: 7,
              background: C.downBg, color: C.down, fontSize: FS.micro, lineHeight: 1.5,
            }}>
              {v.side} 발동가가 현재가({ref != null ? fmtPrice(ref) : '?'}) {long ? '아래' : '위'}입니다 —
              즉시 발동해서 추적을 쓰는 의미가 없습니다.
            </div>
          )}
          <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 8, lineHeight: 1.6 }}>
            가격이 유리한 쪽으로 갈 때 손절이 따라가고, <b>{cbOk ? cbNum : '?'}%</b> 되돌리면
            시장가로 닫습니다. 발동가를 넣으면 그 가격에 닿아야 추적이 시작됩니다.
          </div>
        </>
      ) : (
      <>
      <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 8, lineHeight: 1.5 }}>
        {mode === 'POSITION'
          ? '포지션 전량을 닫는 TP/SL을 새로 겁니다. 기존 전량 청산용 주문만 지우고 분할 익절 사다리는 남깁니다.'
          : '고른 비율만큼만 닫습니다. 나머지는 그대로 남습니다.'}
      </div>

      <PriceField label="익절" value={tp} onChange={setTp} presets={[1, 2, 5, 10]}
        refPrice={ref} onPreset={p => setTp(fromPct(p, true))} wrong={tpWrong}/>
      {/* **이 가격이면 얼마인가.**
          지금까지 가격만 받고 결과를 안 보여줬다. 그런데 사람이 정하고 싶은
          것은 보통 가격이 아니라 금액이다 — "6만3천에 익절"이 아니라
          "20달러 벌면 나간다". 가격만 보이면 그 둘을 머리로 환산해야 하고,
          레버리지가 끼면 그 계산이 틀린다(수익률은 증거금 대비다).
          바이낸스가 ROI·PnL 칸을 따로 두는 이유가 이것이다. */}
      <PnlPreview label="익절" price={tpNum} v={v} ok={!!tp && tpOk && !tpWrong}/>

      <PriceField label="손절" value={sl} onChange={setSl} presets={[1, 2, 3, 5]}
        refPrice={ref} onPreset={p => setSl(fromPct(p, false))} wrong={slWrong}/>
      <PnlPreview label="손절" price={slNum} v={v} ok={!!sl && slOk && !slWrong}/>

      {(tpWrong || slWrong) && (
        <div style={{
          padding: '7px 9px', borderRadius: 7, marginBottom: 7,
          background: C.downBg, color: C.down, fontSize: FS.micro, lineHeight: 1.5,
        }}>
          {tpWrong && `${v.side} 익절이 현재가(${ref != null ? fmtPrice(ref) : '?'}) ${long ? '아래' : '위'}입니다 — 걸자마자 체결됩니다. `}
          {slWrong && `${v.side} 손절이 현재가 ${long ? '위' : '아래'}입니다 — 걸자마자 발동합니다.`}
        </div>
      )}

      {/* **손절이 청산가 너머면 손절은 작동할 기회가 없다.**
          거래소도 이걸 경고만 하고 받아 준다. 그러면 청산이 먼저 닿고,
          화면에는 그때까지 '설정됨'으로 떠 있다. */}
      {slBeyondLiq && (
        <div style={{
          padding: '7px 9px', borderRadius: 7, marginBottom: 7,
          background: C.downBg, color: C.down, fontSize: FS.micro, lineHeight: 1.5,
        }}>
          손절 {fmtPrice(slNum)}이 청산가 {v.liq != null ? fmtPrice(v.liq) : '?'} 너머입니다 —
          <b> 청산이 먼저 닿아 손절은 작동하지 못합니다.</b> 손절을 진입가 쪽으로 당기거나
          배율을 낮추세요.
        </div>
      )}
      </>
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
        {busy ? '거는 중…'
          : mode === 'TRAIL'
            ? (!cbOk ? '콜백 비율을 0.1~10%로 입력하세요' : `트레일링 걸기 (${cbNum}%${portion < 100 ? ` · ${portion}%` : ''})`)
          : !tp && !sl ? '익절 또는 손절을 입력하세요'
          : slBeyondLiq ? '손절이 청산가 너머입니다'
          : `${mode === 'POSITION' ? '전량' : `${portion}%`} TP/SL 걸기`}
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
  const [tpslOpen, setTpslOpen] = useState(false);
  const [slIn, setSlIn] = useState('');
  const [tpIn, setTpIn] = useState('');
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
      setMsg({ ok: !!j?.ok, text: errorTextOf(j, `실패 (${r.status})`) });
      if (j?.ok) setTimeout(onClosed, 600);
    } catch (e: any) {
      setMsg({ ok: false, text: `실패 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  /** 손절·익절을 고친다. 빈 칸은 **'그대로'가 아니라 '지우기'**다 — 둘을
      섞으면 지우려던 손절이 남거나, 남기려던 값이 사라진다. */
  const saveTpsl = async () => {
    if (!auth) { setMsg({ ok: false, text: '로그인이 필요합니다' }); return; }
    const body: any = { positionId: p.id };
    if (slIn.trim() !== '') body.stopLoss = Number(slIn);
    if (tpIn.trim() !== '') body.takeProfit = Number(tpIn);
    if (body.stopLoss === undefined && body.takeProfit === undefined) {
      setMsg({ ok: false, text: '손절 또는 익절 값을 입력하세요' }); return;
    }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/paper/modify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      setMsg({ ok: !!j?.ok, text: errorTextOf(j, `실패 (${r.status})`) });
      if (j?.ok) { setSlIn(''); setTpIn(''); setTpslOpen(false); setTimeout(onClosed, 400); }
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
        {/* 손절 칩을 실계좌 카드와 **같은 자리·같은 문구**로 둔다.
            모의에서는 손절이 장부에 있고(거래소 주문이 아니다) 값이
            없으면 없는 것이라 '확인 못 함'이 나올 수 없다. 그래도 칩을
            생략하면, 두 화면을 오가는 사람이 '모의에는 원래 이 칩이
            없나' 아니면 '내 화면이 옛날 것인가'를 구분할 수 없다. */}
        <span style={chip(
          p.stopLoss == null ? C.down : C.up,
          p.stopLoss == null ? C.downBg : C.upBg,
        )}>{p.stopLoss == null ? '손절 없음' : '손절 있음'}</span>
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

      {/* 포지션 아래 조작 줄 — 실계좌 카드·거래소 앱과 **같은 자리**에 둔다.
          예전에는 여기에 '모의 청산' 하나뿐이었다. 연습으로 쓰라고 만든
          화면에서 정작 손절을 옮기는 연습을 할 수 없었다. */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => setTpslOpen(v => !v)} disabled={busy}
          style={{
            flex: 1, minHeight: 36, borderRadius: 7, cursor: busy ? 'default' : 'pointer',
            background: C.raised, color: C.text, border: `1px solid ${C.hair}`,
            fontSize: FS.small, fontWeight: 700, opacity: busy ? 0.6 : 1,
          }}>{tpslOpen ? 'TP/SL 접기' : 'TP/SL'}</button>
        <button onClick={close} disabled={busy}
          style={{
            flex: 1, minHeight: 36, borderRadius: 7,
            cursor: busy ? 'default' : 'pointer',
            background: C.downBg, color: C.down,
            border: `1px solid ${A(C.down, '55')}`,
            fontSize: FS.small, fontWeight: 700, opacity: busy ? 0.6 : 1,
          }}>{busy ? '청산 중…' : '모의 청산'}</button>
      </div>

      {tpslOpen && (
        <div style={{ marginTop: 8, padding: '10px 11px', borderRadius: 8, background: C.raised, display: 'grid', gap: 7 }}>
          <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.5 }}>
            비우면 그 값을 지웁니다. 방향이 틀리면(롱 손절이 현재가 위 등)
            서버가 거부합니다 — 걸자마자 발동하는 값이기 때문입니다.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={slIn} onChange={e => setSlIn(e.target.value)} inputMode="decimal"
              placeholder={`손절 ${p.stopLoss == null ? '(없음)' : fmtPrice(p.stopLoss)}`}
              style={{ ...input, flex: 1, padding: '8px 10px', ...NUM }}/>
            <input value={tpIn} onChange={e => setTpIn(e.target.value)} inputMode="decimal"
              placeholder={`익절 ${p.takeProfit == null ? '(없음)' : fmtPrice(p.takeProfit)}`}
              style={{ ...input, flex: 1, padding: '8px 10px', ...NUM }}/>
          </div>
          <button onClick={saveTpsl} disabled={busy}
            style={{
              minHeight: 34, borderRadius: 7, cursor: busy ? 'default' : 'pointer',
              background: C.accentBg, color: C.accent, border: `1px solid ${C.accent}`,
              fontSize: FS.micro, fontWeight: 700, opacity: busy ? 0.6 : 1,
            }}>{busy ? '저장 중…' : '저장'}</button>
        </div>
      )}
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

/**
 * 미체결 주문 — **표가 아니라 카드다.**
 *
 * 표였을 때 375px 화면에 이렇게 떴다:
 *
 *   BTCUSDT | STOP_MARKET | BUY | — | Stop 65,352.50
 *
 * 여섯 열이 가로 스크롤 안으로 들어가 글자가 잘렸고, 남은 글자는 거래소
 * 원문이라 뜻이 안 보였다. `BUY`는 사는 것이니 신규 롱처럼 읽히는데
 * 실제로는 **숏을 닫는 손절**이다 — 정확히 반대로 읽힌다. 그리고 그
 * 오독은 위험한 쪽으로 기운다: "롱 예약이 걸려 있네, 지워야지" 하고
 * 자기 포지션의 유일한 보호 장치를 취소한다.
 *
 * 그래서 셋을 바꾼다.
 *  · 한 열 카드 — 가로 스크롤이 없으면 잘릴 것도 없다
 *  · 거래소 원문 대신 뜻 — '숏 포지션 종료용 매수', '조건부 시장가'
 *  · 보호 주문과 일반 주문을 **갈라 놓는다** — 섞어 두면 [전체 취소]를
 *    누르는 사람이 자기가 손절까지 지우는 줄 모른다
 *
 * 판단(용도·방향·부등호)은 전부 orderView가 한다. 화면에서 계산하면
 * 테스트가 안 붙고, 이 화면에서 조용히 틀리면 사고가 된다.
 */
function OpenOrdersPanel({ orders, why, auth, connId, onChanged }: {
  /** **못 읽었으면 null.** 빈 배열(진짜로 없음)과 다르다 */
  orders: any[] | null;
  /** 못 읽었을 때의 거래소 원문 */
  why?: string | null;
  auth: string;
  connId: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const split = useMemo(() => splitOrders(orders), [orders]);

  const cancelOne = async (v: any) => {
    if (!auth || !connId) { setMsg({ ok: false, text: '로그인·연결이 필요합니다' }); return; }
    if (!v.orderId) { setMsg({ ok: false, text: '주문 번호를 읽지 못해 취소할 수 없습니다' }); return; }
    // 보호 주문을 지우는 것은 **포지션을 벗기는 일**이다. 한 번 더 묻는다.
    const warn = v.protection === 'PROTECTIVE'
      ? `${v.symbol} ${v.purposeLabel}을 취소합니다.\n\n이 주문이 사라지면 포지션을 지키는 것이 없어집니다.`
      : `${v.symbol} ${v.purposeLabel}을 취소합니다.`;
    if (!window.confirm(warn)) return;
    setBusy(v.orderId); setMsg(null);
    try {
      const r = await fetch('/api/binance/futures/cancel-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          connectionId: connId, orderId: v.orderId, symbol: v.symbol, bucket: v.bucket,
        }),
      });
      const j = await r.json();
      setMsg({ ok: r.ok, text: r.ok ? (j?.message || '취소했습니다') : errorTextOf(j, '취소 실패') });
      if (r.ok) onChanged();
    } catch (e: any) {
      setMsg({ ok: false, text: `취소 실패: ${e?.message || e}` });
    } finally { setBusy(null); }
  };

  const cancelAll = async () => {
    if (!auth || !connId) { setMsg({ ok: false, text: '로그인·연결이 필요합니다' }); return; }
    // 보호 주문이 섞여 있으면 그 숫자를 **먼저** 말한다. '전체'가 무엇을
    // 포함하는지 모르고 누르면 손절이 조용히 사라진다.
    const p = split.protective.length;
    const warn = p > 0
      ? `미체결 ${split.total}건을 모두 취소합니다.\n\n이 중 ${p}건은 포지션을 지키는 보호 주문입니다 — 취소하면 손절 없는 포지션이 남습니다.`
      : `미체결 ${split.total}건을 모두 취소합니다.`;
    if (!window.confirm(warn)) return;
    setBusy('ALL'); setMsg(null);
    try {
      const r = await fetch('/api/binance/futures/cancel-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ connectionId: connId }),
      });
      const j = await r.json();
      setMsg({ ok: r.ok, text: r.ok ? (j?.message || '전체 취소했습니다') : errorTextOf(j, '취소 실패') });
      if (r.ok) onChanged();
    } catch (e: any) {
      setMsg({ ok: false, text: `취소 실패: ${e?.message || e}` });
    } finally { setBusy(null); }
  };

  // **못 읽은 것은 '없음'이 아니다.** 여기서 빈 화면을 그리면 손절이
  // 걸려 있는데도 사용자는 없다고 믿는다.
  if (orders == null) {
    return (
      <div style={{ padding: 14 }}>
        <div style={{
          padding: '12px 14px', borderRadius: 10, background: C.warnBg,
          color: C.warn, fontSize: FS.small, lineHeight: 1.6,
        }}>
          <b>미체결 주문 조회 실패</b>
          <div style={{ color: C.dim, marginTop: 4 }}>
            {why || '거래소가 주문 목록을 주지 않았습니다'}
          </div>
          <div style={{ color: C.faint, marginTop: 6, fontSize: FS.micro }}>
            &lsquo;주문 없음&rsquo;이 아닙니다 — 걸려 있는 손절이 여기 안 보일 수 있습니다.
            거래소 앱에서 직접 확인하세요.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 10 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '0 4px 10px',
      }}>
        <span style={{ color: C.text, fontWeight: 700, fontSize: FS.small }}>
          미체결 주문 <span style={{ ...NUM, color: C.accent }}>{split.total}</span>
        </span>
        {split.protective.length > 0 && (
          <span style={chip(C.up, C.upBg)}>보호 {split.protective.length}</span>
        )}
        {split.normal.length > 0 && (
          <span style={chip(C.dim)}>일반 {split.normal.length}</span>
        )}
        <div style={{ flex: 1 }}/>
        {split.total > 0 && (
          <button onClick={cancelAll} disabled={busy != null} style={{
            ...ghostBtn(), color: C.down, borderColor: `${C.down}55`,
            cursor: busy != null ? 'default' : 'pointer',
          }}>{busy === 'ALL' ? '취소 중…' : '전체 취소'}</button>
        )}
      </div>

      {msg && (
        <div style={{
          margin: '0 4px 10px', padding: '9px 12px', borderRadius: 8,
          background: msg.ok ? C.upBg : C.warnBg, color: msg.ok ? C.up : C.warn,
          fontSize: FS.micro, lineHeight: 1.55,
        }}>{msg.text}</div>
      )}

      {split.total === 0 && <Empty t="미체결 주문이 없습니다"/>}

      {split.protective.length > 0 && (
        <Section title="보호 주문" note="포지션을 지키는 주문입니다 — 지우면 보호가 사라집니다">
          {split.protective.map((v, i) => (
            <OrderCard key={v.orderId ?? `p${i}`} v={v}
              busy={busy === v.orderId} onCancel={() => cancelOne(v)}/>
          ))}
        </Section>
      )}
      {split.normal.length > 0 && (
        <Section title="일반 주문" note="아직 체결되지 않은 진입 예약입니다">
          {split.normal.map((v, i) => (
            <OrderCard key={v.orderId ?? `n${i}`} v={v}
              busy={busy === v.orderId} onCancel={() => cancelOne(v)}/>
          ))}
        </Section>
      )}
      {split.unknown.length > 0 && (
        // 보호인지 신규인지 못 가른 주문. **어느 칸에도 넣지 않는다** —
        // 보호로 세면 없는 안전을 믿고, 신규로 두면 취소 대상으로 보인다.
        <Section title="용도 확인 불가" note="보호 주문인지 신규 주문인지 거래소 응답만으로는 가리지 못했습니다">
          {split.unknown.map((v, i) => (
            <OrderCard key={v.orderId ?? `u${i}`} v={v}
              busy={busy === v.orderId} onCancel={() => cancelOne(v)}/>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, note, children }: {
  title: string; note: string; children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ padding: '0 4px 6px' }}>
        <div style={{ color: C.dim, fontSize: FS.micro, fontWeight: 700, letterSpacing: '0.03em' }}>
          {title}
        </div>
        <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 2 }}>{note}</div>
      </div>
      {children}
    </div>
  );
}

/** 주문 한 장. 한 열이다 — 가로로 넘치는 것이 없어야 잘리지 않는다 */
function OrderCard({ v, busy, onCancel }: {
  v: any; busy: boolean; onCancel: () => void;
}) {
  const tone = v.purpose === 'STOP' ? C.down
    : v.purpose === 'TAKE_PROFIT' ? C.up
    : v.protection === 'UNKNOWN' ? C.warn : C.dim;

  // **기본은 쉬운 말, 자세한 건 접어 둔다.**
  //
  // 한 화면에 열두 줄을 다 펴 놓으면 카드가 표로 되돌아간다. 늘 필요한
  // 것은 "언제 발동하는가 · 얼마나 나가는가" 둘뿐이고, 나머지(원문 타입·
  // 주문 번호·생성 시각)는 거래소와 대조할 때만 본다.
  const [more, setMore] = useState(false);

  const detail: Array<[string, React.ReactNode]> = [];
  detail.push(['방향', v.sideLabel]);
  detail.push(['상태', v.statusLabel]);
  if (v.triggerBasisLabel) detail.push(['발동 기준', v.triggerBasisLabel]);
  if (v.createdAt) {
    detail.push(['주문 시각', new Date(v.createdAt).toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })]);
  }
  detail.push(['거래소 원문', `${v.rawType} · ${v.rawSide}${v.orderId ? ` · #${v.orderId}` : ''}`]);

  return (
    <div style={{
      background: C.raised, borderRadius: 10, padding: '12px 14px',
      marginBottom: 8, borderLeft: `2px solid ${tone}`,
      // 카드 안에서도 넘치지 않게. 긴 값이 카드를 밀면 다시 가로 스크롤이 생긴다.
      minWidth: 0, overflowWrap: 'anywhere',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: C.text, fontWeight: 700 }}>{v.symbol}</span>
        <span style={{ color: tone, fontSize: FS.micro, fontWeight: 700 }}>{v.purposeLabel}</span>
        <span style={{ color: C.faint, fontSize: FS.micro }}>· {v.kindLabel}</span>
      </div>

      {/* 늘 보이는 두 줄. 이것만으로 "언제 · 얼마나"가 읽혀야 한다. */}
      <div style={{ marginTop: 7, color: C.text, fontSize: FS.small, lineHeight: 1.6 }}>
        {v.triggerLabel && <div>{v.triggerLabel}</div>}
        <div style={{ color: C.dim }}>{v.execLabel} · {v.qtyLabel}</div>
      </div>

      {more && (
        <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {detail.map(([k, val]) => (
            <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'baseline', minWidth: 0 }}>
              <span style={{
                color: C.faint, fontSize: FS.micro, flexShrink: 0, width: 68,
              }}>{k}</span>
              <span style={{ color: C.dim, fontSize: FS.micro, minWidth: 0 }}>{val}</span>
            </div>
          ))}
        </div>
      )}

      {/* 터치 영역을 키운다. 44px 아래로 내려가면 좁은 화면에서 옆 버튼이
          같이 눌리고, 여기서 잘못 눌리는 버튼은 [취소]다. */}
      <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
        <button onClick={() => setMore(m => !m)} style={{
          ...ghostBtn(), flex: 1, minHeight: 44, cursor: 'pointer',
        }}>{more ? '접기' : '자세히'}</button>
        <button onClick={onCancel} disabled={busy || !v.orderId} style={{
          ...ghostBtn(), flex: 1, minHeight: 44,
          color: busy || !v.orderId ? C.faint : C.down,
          borderColor: busy || !v.orderId ? C.hair : `${C.down}55`,
          cursor: busy || !v.orderId ? 'default' : 'pointer',
        }}>
          {busy ? '취소 중…' : !v.orderId ? '취소 불가' : '주문 취소'}
        </button>
      </div>
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

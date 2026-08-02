'use client';
import { A } from '@/lib/theme/colors';
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
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { C, FS, NUM, fmtPrice, pnlColor, input, primaryBtn, ghostBtn, chip } from './theme';
import { DataBadge } from '@/components/ui/DataBadge';
import { useBinanceStream, bookImbalance, type StreamState } from '@/lib/hooks/useBinanceStream';
import { useTerminal } from './TerminalContext';
import { notifyError, notifySuccess } from '@/lib/notify/center';
import { SpotOrderPanel } from './SpotOrderPanel';
import { CoinMOrderPanel } from './CoinMOrderPanel';
import { canOpenFutures, type WalletTree } from '@/lib/markets/wallets';
import { MODE_INFO, orderEndpointFor } from '@/lib/markets/tradeMode';
import { PaperWallet, usePaperAccount } from './PaperWallet';
import { AccountLine } from './AccountLine';

const LEVERAGES = [1, 3, 5, 10, 20, 50, 75, 100];
/** 슬라이더·숫자 입력의 상한. 칩 목록의 마지막 값과 같아야 한다 */
const MAX_LEVERAGE = 100;

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

  // 호가 한 줄.
  //
  // 높이를 **명시한다.** globals.css에 `button { min-height: 44px }`가 있어서
  // (터치 목표 최소 크기) 호가 줄도 44px이 됐다. 위아래 7줄이면 616px —
  // 세로 화면 하나가 호가판 하나로 다 찬다. 그러면 호가·주문폼·포지션을 한
  // 화면에서 같이 보는 것이 불가능해지고, 깊이를 보려고 또 스크롤해야 한다.
  //
  // 44px 규칙을 여기서 깨는 이유: 이건 낱개 버튼이 아니라 **사다리**다.
  // 줄 하나를 크게 만드는 대신 줄이 여러 개 보이는 것이 이 판의 목적이고,
  // 실제 거래소 앱들도 20px 안팎을 쓴다. 숫자 크기는 그대로 둔다.
  const rowH = dense ? 21 : 24;
  const Row = ({ p, q, buy }: { p: number; q: number; buy: boolean }) => (
    <button
      onClick={() => onPickPrice?.(p)}
      style={{
        position: 'relative', display: 'flex', justifyContent: 'space-between',
        alignItems: 'center',
        width: '100%', background: 'none', border: 'none',
        minHeight: 0, height: rowH, flexShrink: 0,
        padding: dense ? '0 8px' : '0 12px', cursor: onPickPrice ? 'pointer' : 'default',
        overflow: 'hidden', ...NUM, fontSize: dense ? FS.micro : FS.small,
        lineHeight: 1,
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

          {/* 가운데 현재가도 누르면 그 가격이 주문폼에 들어간다.
              호가 줄만 눌리던 때는 **가장 크게 떠 있는 숫자가 유일하게 안
              눌리는 것**이었다. 지정가를 넣을 때 제일 자주 쓰는 값이 현재가라
              그게 제일 이상했다. 버튼으로 바꾸고, 눌린다는 것을 밑줄로 알린다. */}
          <button
            onClick={() => { if (mid != null) onPickPrice?.(mid); }}
            disabled={mid == null || !onPickPrice}
            title={onPickPrice ? '이 가격으로 지정가 주문' : undefined}
            style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 8,
              width: '100%', background: 'none',
              padding: dense ? '6px 8px' : '7px 12px', margin: '2px 0',
              border: 'none', minHeight: 0,
              borderTop: `1px solid ${C.hair}`, borderBottom: `1px solid ${C.hair}`,
              cursor: mid != null && onPickPrice ? 'pointer' : 'default',
            }}>
            <span style={{
              ...NUM, color: pnlColor(stream.changePct),
              fontSize: dense ? 15 : 19, fontWeight: 700,
              textDecoration: mid != null && onPickPrice ? 'underline' : 'none',
              textDecorationColor: C.hair3,
              textDecorationThickness: 1,
              textUnderlineOffset: 3,
            }}>{fmtPrice(mid)}</span>
            {stream.changePct != null && (
              <span style={{ ...NUM, color: pnlColor(stream.changePct), fontSize: FS.small, fontWeight: 600 }}>
                {stream.changePct >= 0 ? '+' : ''}{stream.changePct.toFixed(2)}%
              </span>
            )}
          </button>

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

/**
 * 눌러서 고른 가격.
 *
 * 왜 `number` 하나로 두지 않는가: 주문폼은 `useEffect([presetPrice])`로 값을
 * 받는다. 같은 가격을 두 번 누르면 값이 안 바뀌므로 effect가 다시 돌지 않고,
 * **아무 일도 일어나지 않는다.** 그 사이에 가격을 직접 고쳐 놨다면 되돌릴
 * 방법이 그 줄을 누르는 것뿐인데 그게 안 듣는다.
 *
 * 그래서 누른 **횟수**를 같이 들고 다닌다. 같은 값이어도 seq가 바뀌므로
 * 매번 반영된다.
 */
export function usePickedPrice() {
  const [picked, setPicked] = useState<{ price: number; seq: number } | null>(null);
  const pick = useCallback((p: number) => {
    if (!Number.isFinite(p) || p <= 0) return;   // 0을 지정가로 넣지 않는다
    setPicked(prev => ({ price: p, seq: (prev?.seq ?? 0) + 1 }));
  }, []);
  return {
    pick,
    presetPrice: picked?.price ?? null,
    presetSeq: picked?.seq ?? 0,
  };
}

/** 스테퍼 버튼 — 가격을 한 눈금씩 */
function Step({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      width: 32, minHeight: 34, background: 'transparent', border: 'none',
      color: C.dim, fontSize: 16, lineHeight: 1, cursor: 'pointer', flexShrink: 0,
    }}>{children}</button>
  );
}

/** 라벨 + 값 한 줄 */
function Kv({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: C.faint, fontFamily: 'inherit' }}>{k}</span>
      <span style={{ color: warn ? C.warn : C.dim, fontWeight: 600 }}>{v}</span>
    </div>
  );
}

// ══ 주문판 ══════════════════════════════════════════════
//
// 좁은 칸(dense)에서는 구성을 바꾼다. 줄이는 것이 아니라 빼는 것이다.
//  - 배율 8개 격자(두 줄) → 칩 하나 + 시트. 배율은 자주 안 바꾼다.
//  - 명목가·증거금 상자 → 한 줄
//  - 주문 버튼은 그대로 크게. 여기서 아낀 자리를 그쪽에 쓴다.
// 목표는 375×812에서 **스크롤 없이** 주문까지 닿는 것이다.
export const OrderFormPanel = memo(function OrderFormPanel({
  presetPrice, presetSeq, dense,
}: {
  presetPrice?: number | null;
  /** 누른 횟수. 같은 가격을 다시 눌렀을 때도 반영되게 (usePickedPrice 주석) */
  presetSeq?: number;
  /** 모바일 2열의 좁은 칸에 들어갈 때 */
  dense?: boolean;
}) {
  const { symbol, auth, connId, connections, mode, tradeMode, modeResolution } = useTerminal();
  const stream = useBinanceStream(symbol.id, true);
  const isPaper = tradeMode === 'PAPER';
  const paper = usePaperAccount(isPaper);

  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');
  const [leverage, setLeverage] = useState(() => {
    try { const v = +(localStorage.getItem(LEV_KEY) || '5'); return v >= 1 && v <= 125 ? v : 5; }
    catch { return 5; }
  });
  const [levOpen, setLevOpen] = useState(false);
  // 손절 폭(%). **이 칸이 없어서 신규 진입이 전부 거부되고 있었다** —
  // 서버(manualPlan)가 손절 없는 진입을 막는데 화면이 값을 보내지 않았다.
  // 화면에서 못 넣는 값을 서버가 요구하면 그 기능은 죽은 것이다.
  const [slPct, setSlPct] = useState(2);
  // 오늘 손실 한도. **보이지 않으면 없는 것과 같다** — 주문 버튼을 눌렀을
  // 때 처음 알게 되면 그 시점까지 한도를 모른 채로 계획을 세운 것이다.
  const [dailyLimit, setDailyLimit] = useState<any>(null);
  // 지금 시장 국면. **필터를 켜지 않아도 보여준다** — 필터가 꺼져 있어도
  // "지금 고변동장"이라는 사실은 알아야 한다.
  const [regime, setRegime] = useState<any>(null);
  // 청산 전용. 켜면 보유분을 줄이는 주문만 나간다 — 반대로 새 포지션이
  // 열리는 사고를 막는다.
  const [reduceOnly, setReduceOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // **왜 막혔는지**를 따로 들고 있는다.
  //
  // 예전에는 "7개 항목이 주문을 막습니다: 운영 모드가 주문을 허용,
  // 마진 모드 ISOLATED, …" 처럼 **항목 이름만** 보여줬다. 이름만 보면
  // 무엇을 고쳐야 하는지 알 수 없다 — '마진 모드 ISOLATED'가 막는다는
  // 것이 "ISOLATED가 아니다"인지 "확인을 못 했다"인지 구분이 안 된다.
  // 둘은 고치는 방법이 완전히 다르다.
  const [blockers, setBlockers] = useState<any[]>([]);
  const [riskError, setRiskError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<WalletTree | null>(null);
  const [walletErr, setWalletErr] = useState('');

  // 호가·현재가를 눌러 들어온 가격.
  //
  // presetSeq가 의존성에 있는 이유: 같은 가격을 두 번 누르면 presetPrice가
  // 안 바뀌어 effect가 돌지 않는다. 그 사이 가격을 직접 고쳐 놨다면 되돌릴
  // 방법이 그 줄을 누르는 것뿐인데 그게 안 듣는다.
  useEffect(() => {
    if (presetPrice != null) { setOrderType('LIMIT'); setPrice(String(presetPrice)); }
  }, [presetPrice, presetSeq]);

  // ── 지갑 ──
  // 선물 계좌만 따로 부르지 않고 통합 트리를 받는다. 그래야 증거금이
  // 모자랄 때 "현물에 얼마 있으니 이체하라"까지 말해줄 수 있다.
  // 물론 현물 잔고가 가용 증거금에 더해지지는 않는다 (lib/markets/wallets.ts).
  useEffect(() => {
    // **주문이 나가는 계좌와 같은 계좌를 본다.**
    //
    // 예전에는 컨텍스트의 connId(모드를 안 거친 '마지막에 고른 연결')를
    // 썼다. 주문은 modeResolution.connId로 나가므로, 둘이 다르면 화면에
    // 뜬 잔고와 실제로 주문이 깎는 잔고가 다른 계좌의 것이 된다.
    const wid = isPaper ? '' : (modeResolution.connId || '');
    if (!auth || !wid) { setWallet(null); setWalletErr(''); return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/wallets?connectionId=${wid}`, { headers: { Authorization: auth } });
        const j = await r.json();
        if (!alive) return;
        if (r.ok && j?.ok) {
          setWallet(j.tree);
          // **라우트가 ok여도 지갑 한쪽은 실패했을 수 있다.**
          //
          // 현물과 선물을 따로 부르고 하나가 죽어도 나머지를 돌려주기
          // 때문이다(그래야 실패한 쪽을 0으로 채워 총자산이 줄어 보이는
          // 일이 없다). 그래서 이유는 `tree.futures.error`에 들어 있는데,
          // 화면은 그걸 안 읽고 '확인 불가'만 그리고 있었다 — 사용자는
          // 키가 문제인지 자금이 없는 건지 알 방법이 없다.
          const fe = j.tree?.futures;
          setWalletErr(fe && fe.ok === false ? String(fe.error || '선물 지갑을 읽지 못했습니다') : '');
          return;
        }
        // **왜 못 읽었는지를 버리지 않는다.** 지금까지 이유를 통째로
        // 지우고 '확인 불가'만 남겼는데, 그러면 테스트 자금을 받으러 갈지
        // 키를 고칠지 사용자가 알 수 없다.
        setWallet(null);
        setWalletErr(String(j?.message || j?.error || `조회 실패 (${r.status})`));
      } catch (e: any) {
        if (alive) { setWallet(null); setWalletErr(`지갑을 읽지 못했습니다 (${e?.message || e})`); }
      }
    };
    load();
    const t = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, [auth, isPaper, modeResolution.connId]);

  // 한도 현황은 주기적으로 다시 읽는다. 판정은 서버가 하고 화면은 같은
  // 답을 보여줄 뿐이다 — 각자 계산하면 서로 다른 숫자를 말하게 된다.
  useEffect(() => {
    if (!auth) { setDailyLimit(null); return; }
    if (!isPaper && !modeResolution.connId) { setDailyLimit(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const q = isPaper ? 'paper=1' : `connectionId=${modeResolution.connId}`;
        const r = await fetch(`/api/risk/daily-limit?${q}`, { headers: { Authorization: auth } });
        const j = await r.json();
        if (alive) setDailyLimit(j?.ok ? j : { status: 'unknown', reason: j?.message || '확인 불가' });
      } catch { if (alive) setDailyLimit({ status: 'unknown', reason: '확인 불가' }); }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [auth, isPaper, modeResolution.connId]);

  // 국면은 주문 방향에 따라 판정이 달라진다(상승장 숏 등). 롱 기준으로
  // 받아 두고, 막히는 경우에만 방향을 따로 표시한다.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/regime?symbol=${symbol.id}&side=LONG`);
        const j = await r.json();
        if (alive) setRegime(j?.regime ? j : null);
      } catch { if (alive) setRegime(null); }
    };
    load();
    const t = setInterval(load, 120_000);   // 일봉이라 자주 볼 이유가 없다
    return () => { alive = false; clearInterval(t); };
  }, [symbol.id]);

  // 비율 버튼은 **선물 가용 증거금**만 쓴다. 현물 USDT를 쓰면 없는 돈으로
  // 수량을 계산하게 되고, 그 수량이 그대로 주문이 된다.
  //
  // 모의에서는 가상 계좌의 가용이 그 자리다. 거래소 잔고를 쓰면 모의인데
  // 실계좌 잔고로 수량이 계산된다 — 연습이 되지 않는다.
  const balanceUsd = isPaper
    ? (paper.acct ? paper.acct.available : null)
    : (wallet?.futuresUsableMargin ?? null);

  const mid = stream.lastPrice;
  const notional = (Number(qty) || 0) * (Number(price) || mid || 0);
  const margin = leverage > 0 ? notional / leverage : 0;
  const liqPct = roughLiqDistancePct(leverage);
  // 이 잔고와 배율로 열 수 있는 최대 명목가. 잔고를 모르면 null이다 —
  // 0으로 적으면 '주문 불가'로 읽히고, 큰 수를 임의로 넣으면 더 나쁘다.
  const maxOpenUsd = balanceUsd == null ? null : balanceUsd * leverage;
  const liqTone = liqPct < 1 ? C.down : liqPct < 3 ? C.warn : C.dim;
  const base = symbol.id.replace(/USDT$/, '');

  /** 배율을 1~MAX_LEVERAGE로 자른다. 범위 밖을 조용히 통과시키지 않는다 */
  const clampLev = (v: any): number => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return leverage;
    return Math.min(MAX_LEVERAGE, Math.max(1, n));
  };

  /** 값만 바꾼다 — 슬라이더·숫자 입력처럼 **연속으로** 움직이는 조작용 */
  const setLev = (v: any) => {
    const n = clampLev(v);
    setLeverage(n);
    try { localStorage.setItem(LEV_KEY, String(n)); } catch {}
  };

  /** 고르고 닫는다 — 빠른 선택 칩용 */
  const pickLev = (v: number) => {
    setLev(v);
    setLevOpen(false);
  };

  // 한 눈금 = 표시 자릿수의 최소 단위. 가격이 없으면 움직이지 않는다 —
  // 0에서 시작하면 엉뚱한 지정가가 만들어진다.
  const nudgePrice = (dir: 1 | -1) => {
    const cur = Number(price) || mid;
    if (!Number.isFinite(cur as number) || (cur as number) <= 0) return;
    const step = (cur as number) >= 1000 ? 0.1 : (cur as number) >= 1 ? 0.001 : 0.00001;
    const next = Math.max(0, (cur as number) + dir * step);
    setPrice(String(Number(next.toFixed(8))));
  };

  const setPct = (pct: number) => {
    const px = Number(price) || mid || 0;
    // 잔고를 모르면 비율 계산이 불가능하다. 임의 값으로 채우지 않는다.
    if (px <= 0 || balanceUsd == null) return;
    const q = (balanceUsd * (pct / 100) * leverage) / px;
    setQty(q > 0 ? String(Number(q.toFixed(6))) : '');
  };

  // 방향을 인자로 받는다. 바이낸스처럼 롱·숏 버튼을 동시에 두면
  // 누른 버튼이 곧 방향이다 — 토글 상태를 따로 기억하지 않는다.
  // 토글이 있으면 '숏으로 맞춰놨는데 롱이 나갔다'가 가능해진다.
  const submit = async (orderSide: 'BUY' | 'SELL') => {
    setMsg(null);
    setBlockers([]);
    setRiskError(null);
    setSide(orderSide);
    if (!auth) { setMsg({ ok: false, text: '로그인이 필요합니다' }); return; }
    // 모의는 연결이 필요 없다. 나머지는 이 모드에서 쓸 연결이 있어야 한다.
    if (!modeResolution.ok) { setMsg({ ok: false, text: modeResolution.reason }); return; }
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) { setMsg({ ok: false, text: '수량을 입력하세요' }); return; }
    if (!reduceOnly && !(slPct > 0)) {
      setMsg({ ok: false, text: '손절 폭을 고르세요 — 손절 없는 진입은 받지 않습니다' });
      return;
    }

    // 실전은 누를 때마다 확인한다. 모드 전환에서 한 번 확인했지만, 그건
    // 몇 분 전 일이고 그 사이 화면을 여러 번 만졌다.
    if (modeResolution.realMoney) {
      const { confirmDialog } = await import('@/lib/confirm/dialog');
      const okToGo = await confirmDialog([
        `실전 ${orderSide === 'BUY' ? 'LONG' : 'SHORT'} ${q} ${base} · ${leverage}배`,
        '',
        `기준가   ${orderType === 'LIMIT' ? fmtPrice(Number(price)) : (mid != null ? fmtPrice(mid) : '시장가')}`,
        `손절     ${slPct}%`,
        `증거금   약 ${fmtPrice(margin)} USDT`,
        '',
        '실제 자금이 사용됩니다. 되돌릴 수 없습니다.',
      ].join('\n'), { danger: true });
      if (!okToGo) return;
    }

    setBusy(true);
    try {
      const endpoint = orderEndpointFor(tradeMode, 'USDM');
      // 점검이 막았을 때 사용자가 "네"를 누른 항목을 실어서 **한 번만** 다시
      // 보낸다. overrideChecks는 항목 id 목록이다 — 통짜 우회를 두지 않는
      // 이유는 물어본 사이에 새로 막힌 항목이 그대로 막혀야 하기 때문이다.
      const send = (overrideChecks?: string[]) => {
        const body = isPaper
          ? {
              // 가상 장부는 방향을 LONG/SHORT로 적는다 (거래소의 BUY/SELL과 다르다)
              symbol: symbol.id, side: orderSide === 'BUY' ? 'LONG' : 'SHORT',
              quantity: q, leverage, stopLossPct: slPct,
            }
          : {
              connectionId: modeResolution.connId, confirmToken: 'LIVE_ORDER_CONFIRMED',
              symbol: symbol.id, side: orderSide, type: orderType, quantity: q, leverage,
              price: orderType === 'LIMIT' ? Number(price) || undefined : undefined,
              reduceOnly: reduceOnly || undefined,
              // 이 값이 빠져서 신규 진입이 전부 거부되고 있었다
              stopLossPct: reduceOnly ? undefined : slPct,
              overrideChecks,
            };
        return fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify(body),
        });
      };

      let r = await send();
      let j = await r.json();

      // 점검이 막았다 — 무엇이 막았는지 보여주고 "네/아니요"를 묻는다.
      // 예전에는 여기서 빨간 글씨만 뜨고 끝이라 사용자가 할 수 있는 일이
      // 없었다. 막아서 앱을 떠나게 만드는 것은 안전이 아니다.
      if (r.status === 409 && j?.error === 'checklist_blocked') {
        setBlockers(Array.isArray(j?.checklist?.blockers) ? j.checklist.blockers : []);
        setRiskError(j?.riskError ?? null);
        const { overridePrompt } = await import('@/lib/engine/checkOverride');
        const p = overridePrompt(j?.checklist?.blockers, { realMoney: modeResolution.realMoney });
        if (p.canAsk) {
          const { confirmDialog } = await import('@/lib/confirm/dialog');
          const yes = await confirmDialog(p.text, {
            title: '이대로 주문할까요?',
            confirmText: '네', cancelText: '아니요',
            danger: modeResolution.realMoney,
          });
          if (yes) {
            r = await send(p.askable.map((b: any) => String(b.id)));
            j = await r.json();
          }
        }
      }

      if (r.ok && j?.ok) {
        // 넘겨서 나간 것을 '통과'로 적지 않는다.
        const okText = (j?.message || '주문 접수됨')
          + (j?.checklist?.overridden ? ` · ${j.checklist.overrideNote}` : '');
        setMsg({ ok: true, text: okText });
        // 토스트로도 띄운다 — 4초 뒤 저절로 사라지고, 탭하면 바로 닫히고,
        // 알림 센터에 남아서 나중에 다시 볼 수 있다.
        notifySuccess('주문 접수됨', okText);
        setQty('');
        if (isPaper) paper.reload();
      } else {
        const failText = (j?.message || j?.error || `실패 (${r.status})`)
          + (j?.refusedOverrides?.length ? ' — 이 항목은 눌러서 넘길 수 없습니다' : '');
        setMsg({ ok: false, text: failText });
        // **막힌 이유의 첫 줄까지 토스트에 싣는다.** 항목 이름만 있으면
        // 무엇을 고쳐야 하는지 알 수 없다.
        const first = Array.isArray(j?.checklist?.blockers) ? j.checklist.blockers[0] : null;
        notifyError(
          r.status === 409 ? '점검이 주문을 막았습니다' : '주문 실패',
          first?.detail ? `${first.label}: ${first.detail}` : failText);
      }
    } catch (e: any) {
      // 응답을 못 받았다. 나갔는지 안 나갔는지 모르는 상태다.
      const noRes = `응답 없음 — 재시도 말고 포지션 먼저 확인 (${e?.message || e})`;
      setMsg({ ok: false, text: noRes });
      notifyError('응답을 못 받았습니다', noRes);
    } finally { setBusy(false); }
  };

  const pad = dense ? 7 : 12;
  // 줄 사이 간격. dense에서 1px을 줄이면 줄이 여덟이라 8px이 생기고,
  // 그 8px이 25%·50% 줄이 진입 버튼 뒤로 밀리느냐 마느냐를 가른다.
  const gap = dense ? 4 : 12;
  const inputStyle: React.CSSProperties = {
    ...input, padding: dense ? '7px 9px' : '10px 12px', fontSize: dense ? FS.small : FS.body,
  };

  return (
    <div style={{ padding: pad, display: 'flex', flexDirection: 'column', gap, position: 'relative', minHeight: '100%' }}>
      {/* 이 주문이 **어느 계좌로 나가는가.**
          지금까지 화면에 없던 값이다. 연결을 여러 개 등록해 두면(테스트넷
          하나 + 실전 하나가 정상이다) 모드만 보고는 어느 키로 나가는지 알
          방법이 없었다 — 그런데 그게 이 화면에서 되돌릴 수 없는 유일한
          질문의 절반이다(나머지 절반은 '진짜 돈인가'). 좁아도 지우지 않는다. */}
      <AccountLine/>

      {/* 격리 · 배율 · 청산거리 — **한 줄**.
          예전에는 세 줄이었다(격리/배율 한 줄 + 청산거리 한 줄 + 사이 여백).
          셋 다 '자주 안 바꾸지만 늘 보여야 하는' 값이라 한 줄에 나란히 둔다.
          여기서 아낀 자리는 아래 포지션 칸으로 간다.

          청산거리를 지우지 않는 이유: 배율 숫자만으로는 위험이 안 읽힌다.
          5×와 50×의 차이는 '10배'가 아니라 '20% 여유'와 '2% 여유'다. */}
      <div style={{ display: 'flex', gap: 5, alignItems: 'stretch' }}>
        <span style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          minHeight: dense ? 28 : 30, borderRadius: 7, background: C.raised,
          border: `1px solid ${C.hair}`, color: C.dim,
          fontSize: FS.micro, fontWeight: 600,
        }}>격리</span>
        <button onClick={() => setLevOpen(v => !v)} style={{
          flex: 1, minHeight: dense ? 28 : 30, borderRadius: 7, cursor: 'pointer',
          background: leverage >= 50 ? C.downBg : C.raised,
          border: `1px solid ${leverage >= 50 ? A(C.down,'55') : C.hair}`,
          color: leverage >= 50 ? C.down : C.text,
          fontSize: FS.small, fontWeight: 700, ...NUM,
        }}>{leverage}×</button>
        <span title="이 배율에서 청산까지의 대략적인 거리" style={{
          flex: 1.15, display: 'flex', alignItems: 'center', justifyContent: 'center',
          minHeight: dense ? 28 : 30, borderRadius: 7, background: C.raised,
          border: `1px solid ${liqPct < 3 ? A(liqTone, '55') : C.hair}`,
          color: liqTone, fontSize: FS.micro, fontWeight: 700, ...NUM,
          whiteSpace: 'nowrap',
        }}>청산 {liqPct.toFixed(1)}%</span>
      </div>

      {/* 모의면 가상 지갑을 여기 둔다. 잔고와 충전이 주문 바로 위에 있어야
          "돈이 없어서 못 넣는다"와 "충전하면 된다"가 한눈에 이어진다. */}
      {isPaper && (
        <PaperWallet dense={dense} acct={paper.acct} err={paper.err} onChanged={paper.reload}/>
      )}

      {/* 데모 자동매매 카드는 여기 있었는데 하단 독의 '데모' 탭으로 옮겼다.
          두 가지 이유다:
           · 이건 주문 입력란이 아니라 **조종 장치**다. 수량·손절과 같은
             줄에 두면 주문 한 건을 넣는 흐름에 끼어든다
           · 좁은 화면에서 이 카드 40px 때문에 주문폼이 한 화면에 안
             들어갔다. 롱/숏 버튼이 손절·수량 줄을 덮는 상태가 됐다 */}

      {/* 신규/청산 (바이낸스의 Open/Close) + 주문 유형.
          좁은 화면에서는 **한 줄**에 넣는다. 두 줄로 두면 68px인데, 그만큼이
          아래 포지션 칸에서 빠진다. 둘은 다른 축이므로 사이에 칸막이를 둔다 —
          붙여 놓으면 네 칸짜리 하나로 보인다. */}
      <div style={{ display: 'flex', gap: dense ? 6 : 4, flexDirection: dense ? 'row' : 'column' }}>
        <div style={{
          display: 'flex', gap: 3, background: C.raised, padding: 3, borderRadius: 8,
          flex: 1, minWidth: 0,
        }}>
          {([['OPEN', '신규'], ['CLOSE', '청산']] as const).map(([v, label]) => (
            <button key={v} onClick={() => setReduceOnly(v === 'CLOSE')} style={{
              flex: 1, minWidth: 0,
              minHeight: dense ? 28 : 34, border: 'none', borderRadius: 6, cursor: 'pointer',
              background: (v === 'CLOSE') === reduceOnly ? C.panel : 'transparent',
              color: (v === 'CLOSE') === reduceOnly ? C.text : C.dim,
              fontSize: dense ? FS.micro : FS.body, fontWeight: 700,
              boxShadow: (v === 'CLOSE') === reduceOnly ? `0 1px 2px ${C.hair2}` : 'none',
            }}>{label}</button>
          ))}
        </div>
        <div style={{
          display: 'flex', gap: 3, background: C.raised, padding: 3, borderRadius: 8,
          flex: 1, minWidth: 0,
        }}>
          {(['MARKET', 'LIMIT'] as const).map(t => (
            <button key={t} onClick={() => setOrderType(t)} style={{
              flex: 1, minWidth: 0,
              minHeight: dense ? 28 : 34, border: 'none', borderRadius: 6, cursor: 'pointer',
              background: orderType === t ? C.panel : 'transparent',
              color: orderType === t ? C.text : C.dim,
              fontSize: dense ? FS.micro : FS.body, fontWeight: 700,
              boxShadow: orderType === t ? `0 1px 2px ${C.hair2}` : 'none',
            }}>{t === 'MARKET' ? '시장가' : '지정가'}</button>
          ))}
        </div>
      </div>

      {/* 가격 — 스테퍼 + BBO. 호가를 눌러도 여기로 들어온다 */}
      {orderType === 'LIMIT' && (
        <div style={{ display: 'flex', gap: 5 }}>
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', background: C.raised,
            border: `1px solid ${C.hair}`, borderRadius: 8, overflow: 'hidden',
          }}>
            <Step onClick={() => nudgePrice(-1)}>−</Step>
            <input value={price} onChange={e => setPrice(e.target.value)}
              placeholder={mid ? fmtPrice(mid) : '가격'} inputMode="decimal"
              style={{
                flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
                color: C.text, textAlign: 'center', padding: '9px 2px',
                fontSize: dense ? FS.small : FS.body, ...NUM,
              }}/>
            <Step onClick={() => nudgePrice(1)}>+</Step>
          </div>
          {/* 최우선 호가로 바로 채운다. 값을 모르면 누를 수 없다. */}
          <button onClick={() => { if (mid != null) setPrice(String(mid)); }}
            disabled={mid == null}
            title={mid == null ? '시세를 받지 못해 채울 수 없습니다' : '최우선 호가로'}
            style={{ ...ghostBtn(), minWidth: 46, opacity: mid == null ? 0.5 : 1 }}>BBO</button>
        </div>
      )}

      {/* 수량 */}
      <div style={{
        display: 'flex', alignItems: 'center', background: C.raised,
        border: `1px solid ${C.hair}`, borderRadius: 8, overflow: 'hidden',
      }}>
        <input value={qty} onChange={e => setQty(e.target.value)}
          placeholder="수량" inputMode="decimal"
          style={{
            flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
            color: C.text, padding: '9px 11px', fontSize: dense ? FS.small : FS.body, ...NUM,
          }}/>
        <span style={{
          padding: '0 10px', color: C.dim, fontSize: FS.micro, fontWeight: 600,
          borderLeft: `1px solid ${C.hair}`, lineHeight: '34px',
        }}>{base}</span>
      </div>

      {/* 손절 — **이 줄이 없어서 신규 진입이 전부 거부되고 있었다.**
          서버(manualPlan)는 손절 없는 진입을 막는데 화면에 넣을 칸이
          없었다. 화면에서 못 넣는 값을 서버가 요구하면 그 기능은 죽은 것이다.

          청산(reduceOnly)에는 붙이지 않는다 — 나가는 주문에 손절을 요구하면
          나갈 수 없게 된다. */}
      {!reduceOnly && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: C.faint, fontSize: FS.micro, minWidth: 26 }}>손절</span>
            {[1, 2, 3, 5, 10].map(p => (
              <button key={p} onClick={() => setSlPct(p)}
                style={{
                  flex: 1, minHeight: 26, borderRadius: 6, cursor: 'pointer',
                  background: slPct === p ? C.accentBg : C.raised,
                  color: slPct === p ? C.accent : C.dim,
                  border: `1px solid ${slPct === p ? A(C.accent, '55') : C.hair}`,
                  fontSize: FS.micro, fontWeight: 700, ...NUM,
                }}>{p}%</button>
            ))}
          </div>
          {(() => {
            // 결과 손절가와, 그게 청산 안쪽인지. %만 보면 배율이 높을 때
            // 손절이 청산 너머라는 것을 알 수 없다.
            const ref = orderType === 'LIMIT' ? (Number(price) || mid) : mid;
            if (ref == null || !(ref > 0)) return null;
            const buyStop = ref * (1 - slPct / 100);
            const sellStop = ref * (1 + slPct / 100);
            const beyond = slPct >= liqPct;
            // 좁은 화면에서는 **위험할 때만** 적는다.
            // '롱 61,676 · 숏 64,193'은 알면 좋은 값이지만 손절 %와 현재가에서
            // 바로 나오는 값이다. 반면 '손절이 청산 너머'는 그 줄이 없으면
            // 알 방법이 없다 — 둘을 같은 규칙으로 두면 자리를 아끼려다
            // 중요한 쪽까지 같이 사라진다.
            if (dense && !beyond) return null;
            return (
              <div style={{
                marginTop: 4, fontSize: FS.micro, lineHeight: 1.5,
                color: beyond ? C.down : C.faint,
              }}>
                {beyond
                  ? `손절 ${slPct}%가 청산 거리(약 ${liqPct.toFixed(2)}%)보다 멉니다 — `
                    + '청산이 먼저 닿아 손절이 작동하지 못합니다'
                  : `롱 ${fmtPrice(buyStop)} · 숏 ${fmtPrice(sellStop)}`}
              </div>
            );
          })()}
        </div>
      )}

      {/* 비율 슬라이더 — 바이낸스의 눈금 슬라이더 자리.
          잔고를 모르면 비율을 계산할 수 없다. 그때는 눈금만 두고 막는다. */}
      <div style={{ padding: dense ? 0 : '2px 2px 0' }}>
        <div style={{ display: 'flex', gap: 3 }}>
          {[25, 50, 75, 100].map(pct => (
            <button key={pct} onClick={() => setPct(pct)}
              disabled={balanceUsd == null}
              title={balanceUsd == null ? '잔고를 받지 못해 비율 계산을 할 수 없습니다' : undefined}
              style={{
                flex: 1, minHeight: 26, borderRadius: 6,
                cursor: balanceUsd == null ? 'default' : 'pointer',
                background: C.raised, color: balanceUsd == null ? C.faint : C.dim,
                border: `1px solid ${C.hair}`, fontSize: FS.micro, fontWeight: 600,
                opacity: balanceUsd == null ? 0.5 : 1, ...NUM,
              }}>{pct}%</button>
          ))}
        </div>
      </div>

      {/* 가용 증거금 — 바이낸스의 Avbl.
          모의에서는 바로 위 PaperWallet이 **같은 값**을 이미 보여준다.
          좁은 화면에서 같은 숫자를 두 줄에 적는 것은 자리를 두 배로 쓰면서
          정보를 하나도 더 주지 않는다. */}
      {!(dense && isPaper) && (
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        fontSize: FS.micro, ...NUM,
      }}>
        <span style={{ color: C.faint, fontFamily: 'inherit' }}>
          {isPaper ? '가용 (모의)' : '가용'}
        </span>
        <span style={{ color: balanceUsd == null ? C.warn : C.dim, fontWeight: 600 }}>
          {balanceUsd == null ? '확인 불가' : `${fmtPrice(balanceUsd)} USDT`}
        </span>
      </div>
      )}

      {/* 못 읽었으면 **왜**. '확인 불가'만으로는 무엇을 고쳐야 할지 알 수 없다 */}
      {!isPaper && balanceUsd == null && walletErr && (
        <div style={{ color: C.warn, fontSize: FS.micro, lineHeight: 1.5 }}>{walletErr}</div>
      )}

      {/* 읽었는데 0이면 그것도 말해 준다. 0과 '못 읽음'은 다른 문제이고,
          고칠 방법도 다르다 — 하나는 자금을 받아야 하고 하나는 키를 고쳐야 한다. */}
      {!isPaper && balanceUsd === 0 && (
        <div style={{ color: C.warn, fontSize: FS.micro, lineHeight: 1.5 }}>
          잔고가 0입니다 — 조회는 됐습니다. 테스트넷이면 거래소에서 테스트 자금을 받으세요.
        </div>
      )}

      {/* 지금 국면. 필터를 켜지 않아도 보여준다 — 고변동장인지 아닌지는
          필터와 무관하게 알아야 하는 사실이다. */}
      {regime?.regime && (!dense
        || !regime.regime.dataOk
        || regime.gate?.blockEntries
        || regime.regime.volatility === 'high_vol') && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          fontSize: FS.micro,
        }}>
          <span style={{ color: C.faint }}>시장 국면</span>
          <span style={{
            color: !regime.regime.dataOk ? C.warn
              : regime.gate?.blockEntries ? C.down
              : regime.regime.volatility === 'high_vol' ? C.warn : C.dim,
            fontWeight: 600, textAlign: 'right', maxWidth: '72%',
          }}>
            {regime.regime.label}
            {regime.gate?.enabled && regime.gate?.blockEntries ? ' · 진입 차단' : ''}
            {regime.gate?.enabled === false ? ' (필터 꺼짐)' : ''}
          </span>
        </div>
      )}

      {/* 오늘 손실 한도. 남은 여유를 미리 보여주면 마지막 한 번을 넣기 전에
          스스로 멈출 수 있다. 막힌 상태는 붉게, 확인 불가는 노랗게 —
          '여유 있음'과 '모름'이 같아 보이면 안 된다. */}
      {/* 좁은 화면에서는 **막혔거나 모를 때만** 보여준다.
          '여유 400 USDT'는 알면 좋은 값이지만, 잠겼거나 확인 못 한 것은
          **반드시** 보여야 하는 값이다. 둘을 같은 규칙으로 두면 자리를
          아끼려다 중요한 쪽까지 같이 사라진다. */}
      {dailyLimit && (!dense || dailyLimit.status !== 'ok') && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          fontSize: FS.micro, ...NUM,
        }}>
          <span style={{ color: C.faint, fontFamily: 'inherit' }}>오늘 한도</span>
          <span style={{
            color: dailyLimit.status === 'locked' ? C.down
              : dailyLimit.status === 'unknown' ? C.warn : C.dim,
            fontWeight: 600, textAlign: 'right', maxWidth: '72%',
            fontFamily: dailyLimit.status === 'ok' && dailyLimit.remainingUsd != null
              ? undefined : 'inherit',
          }}>
            {dailyLimit.status === 'locked' ? '잠김 — 신규 진입 불가'
              : dailyLimit.status === 'unknown' ? '확인 불가'
              : dailyLimit.remainingUsd != null
                ? `여유 ${fmtPrice(dailyLimit.remainingUsd)} USDT`
                : '한도 없음'}
          </span>
        </div>
      )}

      {dailyLimit?.blockEntries && (
        <div style={{
          padding: '8px 10px', borderRadius: 7,
          background: dailyLimit.status === 'locked' ? C.downBg : C.warnBg,
          color: dailyLimit.status === 'locked' ? C.down : C.warn,
          fontSize: FS.micro, lineHeight: 1.5,
        }}>
          {dailyLimit.reason}
        </div>
      )}

      {/* 증거금이 모자라면 주문 전에 말한다. 거래소가 거부한 뒤에
          알려주면 사용자는 이미 그 크기를 믿고 계획을 세운 뒤다. */}
      {(() => {
        if (isPaper || !wallet || margin <= 0) return null;
        const chk = canOpenFutures(wallet, margin);
        if (chk.ok) return null;
        return (
          <div style={{
            padding: '7px 9px', borderRadius: 7, background: C.warnBg,
            color: C.warn, fontSize: FS.micro, lineHeight: 1.5,
          }}>{chk.reason}</div>
        );
      })()}

      {/* 최대 주문 가능 · 비용 — 바이낸스의 Max Open / Cost.
          두 버튼 위에 각각 두지 않고 한 번만 둔다. 같은 값이 두 번 나오면
          서로 다른 값이라고 오해한다. */}
      {/* 최대 주문 · 비용. 좁은 화면에서는 **한 줄**에 붙인다.
          명목가는 뺀다 — 비용 × 배율이라 계산되는 값이고, 이걸 몰라서
          잘못 누르는 일은 없다. */}
      {dense ? (
        <div style={{
          display: 'flex', justifyContent: 'space-between', gap: 8,
          ...NUM, fontSize: FS.micro,
        }}>
          <span style={{ color: maxOpenUsd == null ? C.warn : C.faint }}>
            최대 {maxOpenUsd == null ? '확인 불가' : fmtPrice(maxOpenUsd)}
          </span>
          <span style={{ color: C.dim }}>
            비용 {margin > 0 ? fmtPrice(margin) : '0.00'}
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, ...NUM, fontSize: FS.micro }}>
          <Kv k="최대 주문" v={maxOpenUsd == null ? '확인 불가' : `${fmtPrice(maxOpenUsd)} USDT`}
              warn={maxOpenUsd == null}/>
          <Kv k="비용(증거금)" v={margin > 0 ? `${fmtPrice(margin)} USDT` : '0.00 USDT'}/>
          <Kv k="명목가" v={notional > 0 ? `${fmtPrice(notional)} USDT` : '—'}/>
        </div>
      )}

      {/* **막는 이유는 버튼 위에 둔다.**
          예전에는 버튼 아래에 있었다. 그런데 이 폼은 길어서 버튼이
          화면 바닥에 붙고, 그 아래 내용은 **화면 밖으로 밀린다.**
          사용자는 "6개가 막습니다"만 보고 이유는 영영 못 본다 —
          스크롤해야 보이는 안내는 없는 것과 같다. */}
      {/* **막은 이유를 항목마다 적는다.**
          이름만 보여주면 무엇을 고쳐야 하는지 알 수 없다. 그리고
          '확인 못 함'과 '조건에 안 맞음'을 구분해서 그린다 — 앞은
          조회가 실패한 것이고 뒤는 실제로 걸린 것이라, 고치는 방법이
          완전히 다르다. */}
      {blockers.length > 0 && (
        <div style={{
          padding: '9px 10px', borderRadius: 8, background: C.downBg,
          display: 'flex', flexDirection: 'column', gap: 7,
        }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -3, marginBottom: -3 }}>
            <button onClick={() => setBlockers([])} aria-label="닫기"
              style={{ background: 'none', border: 'none', color: C.faint,
                       cursor: 'pointer', padding: '0 2px', fontSize: FS.body, lineHeight: 1 }}>×</button>
          </div>
          {blockers.map((b: any, i: number) => (
            <div key={b?.id ?? i} style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
              <span style={{
                color: b?.status === 'unknown' ? C.faint : C.down,
                fontWeight: 900, fontSize: FS.micro, width: 10, flexShrink: 0, lineHeight: 1.5,
              }}>{b?.status === 'unknown' ? '?' : '✕'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: C.text, fontSize: FS.micro, fontWeight: 700 }}>
                  {b?.label}
                  <span style={{ marginLeft: 5, color: b?.status === 'unknown' ? C.faint : C.down, fontWeight: 600 }}>
                    {b?.status === 'unknown' ? '확인 못 함' : '조건 불일치'}
                  </span>
                </div>
                <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 2, lineHeight: 1.5 }}>
                  {b?.detail}
                </div>
              </div>
            </div>
          ))}
          {/* 조회가 왜 실패했는지. 점검 항목은 '확인 못 함'까지만 말할 수
              있으므로 그 뒤의 이유를 여기 붙인다 — 이게 없으면 무엇을
              고쳐야 하는지 알 수 없다. */}
          {riskError && (
            <div style={{ color: C.warn, fontSize: FS.micro, lineHeight: 1.5, marginTop: 2 }}>
              거래소 조회 오류: {riskError}
            </div>
          )}
          <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.5, marginTop: 2 }}>
            <b style={{ color: C.dim }}>?</b> 는 조회가 실패한 것이고, <b style={{ color: C.down }}>✕</b> 는 실제로 조건에 걸린 것입니다.
          </div>
        </div>
      )}

      {/* 롱·숏을 동시에 둔다. 방향 토글을 없앤 이유는 그 토글이 조용히
          틀릴 수 있기 때문이다 — 숏에 맞춰뒀다고 믿고 눌렀는데 롱이
          나가는 사고는 화면만 봐서는 예방되지 않는다. 누른 버튼이 방향이다.

          한동안 `position: sticky; bottom: 0`으로 바닥에 붙여 뒀다. 폼이
          길어져도 버튼은 늘 보이게 하려던 것이다. 그런데 좁은 화면에서
          폼이 칸보다 길어지면 이 블록(약 96px)이 **위 내용을 덮는다.**
          덮인 것이 25%·50%·75%·100% 줄이었고, 그 자리를 누르면 탭이
          진입 버튼으로 들어갔다 — 사용자에게는 "비율 버튼이 안 눌린다"로
          보인다. elementFromPoint로 재 보면 네 개 전부 '롱 진입'이 받는다.
          모의라 '수량을 입력하세요'로 끝났을 뿐, 실전이라면 의도하지 않은
          방향의 주문 확인창이 뜬다.

          그래서 dense에서는 고정을 뺀다. 두 실패를 비교하면:
            · 고정: 버튼은 늘 보이지만 **다른 조작을 조용히 삼킨다**
            · 흐름: 폼이 길면 버튼까지 스크롤해야 한다 — 눈에 보이는 불편
          이 저장소에서 조용히 틀리는 쪽은 언제나 더 나쁘다.

          `marginTop: 'auto'`는 남긴다. 폼이 다 들어가는 보통의 경우에는
          지금까지처럼 버튼이 칸 바닥에 붙는다. 넓은 화면(dense 아님)은
          그대로 고정을 쓴다 — 거기서는 덮일 만큼 좁아지지 않는다. */}
      <div style={{
        ...(dense ? null : { position: 'sticky' as const, bottom: 0, zIndex: 2 }),
        display: 'flex', flexDirection: 'column', gap: 6,
        paddingTop: 6, marginTop: 'auto',
        background: C.panel, boxShadow: `0 -8px 12px -6px ${C.bg}`,
      }}>
      <button onClick={() => submit('BUY')} disabled={busy}
        style={{ ...primaryBtn(C.up, busy), minHeight: dense ? 42 : 46, display: 'flex',
                 alignItems: 'center', justifyContent: 'space-between', padding: '0 16px' }}>
        <span>{busy && side === 'BUY' ? '전송 중…' : reduceOnly ? '롱 청산' : '롱 진입'}</span>
        <span style={{ fontSize: FS.small, fontWeight: 600, opacity: 0.85 }}>
          {reduceOnly ? 'Sell' : `Buy · ${leverage}×`}
        </span>
      </button>

      <button onClick={() => submit('SELL')} disabled={busy}
        style={{ ...primaryBtn(C.down, busy), minHeight: dense ? 42 : 46, display: 'flex',
                 alignItems: 'center', justifyContent: 'space-between', padding: '0 16px' }}>
        <span>{busy && side === 'SELL' ? '전송 중…' : reduceOnly ? '숏 청산' : '숏 진입'}</span>
        <span style={{ fontSize: FS.small, fontWeight: 600, opacity: 0.85 }}>
          {reduceOnly ? 'Buy' : `Sell · ${leverage}×`}
        </span>
      </button>
      </div>

      {/* 실자금 여부는 버튼 바로 아래에. 상단 점만으로는 부족하다.
          다만 좁은 화면에서 **모의일 때는 뺀다** — 헤더의 모드 전환줄이
          '모의'라고 글자로 적고 바로 밑에 설명까지 붙어 있다. 같은 말을
          세 번 하느라 주문 버튼을 화면 밖으로 밀어내는 것은 안전이 아니다.
          **실자금과 확인 불가는 좁아도 남긴다.** 그쪽은 한 번 더 말해야 한다. */}
      {(!dense || mode.unknown || mode.realMoney) && (
        <div style={{
          textAlign: 'center', fontSize: FS.micro, lineHeight: 1.45,
          color: mode.unknown ? C.warn : mode.realMoney ? C.down : C.faint,
        }}>
          {mode.unknown ? '운영 모드 확인 불가'
            : mode.realMoney ? '실제 자금이 사용됩니다'
            : '모의 · 실제 자금 아님'}
        </div>
      )}

      {msg && (
        <div style={{
          padding: '8px 10px', borderRadius: 8, fontSize: FS.micro, lineHeight: 1.5,
          color: msg.ok ? C.up : C.down, background: msg.ok ? C.upBg : C.downBg,
          display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          <span style={{ flex: 1, minWidth: 0 }}>{msg.text}</span>
          {/* 끌 수 있게. 고칠 때까지 계속 남아 있어야 하는 안내와,
              읽고 나면 치우고 싶은 안내는 다르다 — 치우는 쪽은 사용자가 정한다 */}
          <button onClick={() => setMsg(null)} aria-label="닫기"
            style={{ background: 'none', border: 'none', color: 'inherit',
                     cursor: 'pointer', padding: '0 2px', fontSize: FS.body, lineHeight: 1, opacity: .7 }}>×</button>
        </div>
      )}


      {/* 모의에는 거래소 연결이 필요 없다. 여기서 이 문구를 띄우면
          **사실이 아닌 것을 경고로 적는 것**이고, 사용자는 있지도 않은
          문제를 고치려 한다. */}
      {!connections.length && !isPaper && (
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

            {/* − / 숫자 / + 한 줄.
                칩만 있으면 **칩에 없는 배율은 아예 고를 수가 없다**(7배·33배).
                거래소는 다 되는데 이 화면만 못 하는 것이라, 사용자는 앱을
                나가서 거래소 앱으로 바꾸고 돌아온다. */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 8,
              padding: 4, marginBottom: 8,
            }}>
              <button type="button" onClick={() => setLev(leverage - 1)}
                disabled={leverage <= 1}
                style={{
                  width: 38, minHeight: 34, borderRadius: 6, border: 'none', cursor: 'pointer',
                  background: C.raised, color: leverage <= 1 ? C.faint : C.text,
                  fontSize: FS.lead, fontWeight: 800,
                }}>−</button>
              <input
                value={leverage}
                inputMode="numeric"
                onChange={e => {
                  // 지우는 중일 수 있다. 빈 칸을 1로 바꾸면 숫자를 못 지운다.
                  const raw = e.target.value.replace(/[^0-9]/g, '');
                  if (raw === '') return;
                  setLev(raw);
                }}
                style={{
                  flex: 1, minWidth: 0, textAlign: 'center',
                  background: 'transparent', border: 'none', outline: 'none',
                  color: leverage >= 50 ? C.warn : C.text,
                  fontSize: FS.num, fontWeight: 800, ...NUM,
                }}/>
              <span style={{ color: C.dim, fontSize: FS.small, fontWeight: 700 }}>×</span>
              <button type="button" onClick={() => setLev(leverage + 1)}
                disabled={leverage >= MAX_LEVERAGE}
                style={{
                  width: 38, minHeight: 34, borderRadius: 6, border: 'none', cursor: 'pointer',
                  background: C.raised, color: leverage >= MAX_LEVERAGE ? C.faint : C.text,
                  fontSize: FS.lead, fontWeight: 800,
                }}>+</button>
            </div>

            {/* 끌어서 고르기 */}
            <input
              type="range" min={1} max={MAX_LEVERAGE} step={1} value={leverage}
              onChange={e => setLev(e.target.value)}
              className="switch"
              style={{
                width: '100%', minHeight: 0, height: 26, margin: 0,
                accentColor: leverage >= 50 ? C.down : C.accent, cursor: 'pointer',
              }}/>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              color: C.faint, fontSize: FS.micro, ...NUM, marginBottom: 8,
            }}>
              {[1, 25, 50, 75, 100].map(v => <span key={v}>{v}×</span>)}
            </div>

            {/* 빠른 선택. 슬라이더가 있어도 자주 쓰는 값은 한 번에 가야 한다 */}
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

            {/* **이 배율이 무엇을 뜻하는지**를 숫자 옆에 붙인다.
                100×가 위험한 이유는 숫자가 커서가 아니라 청산까지 1%라서다.
                슬라이더를 끄는 동안 이 값이 같이 움직여야 의미가 있다. */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              marginTop: 8, fontSize: FS.micro, ...NUM,
            }}>
              <span style={{ color: C.faint }}>청산까지</span>
              <span style={{ color: leverage >= 50 ? C.down : leverage >= 20 ? C.warn : C.dim, fontWeight: 700 }}>
                약 {roughLiqDistancePct(leverage).toFixed(leverage >= 20 ? 2 : 1)}%
              </span>
            </div>
            <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 4, lineHeight: 1.5 }}>
              청산 거리는 유지증거금을 뺀 근사치입니다. 실제 청산은 이보다 가깝습니다.
            </div>

            <button type="button" onClick={() => setLevOpen(false)} style={{
              width: '100%', minHeight: 36, marginTop: 9, borderRadius: 8,
              background: C.accent, color: '#fff', border: 'none',
              fontSize: FS.small, fontWeight: 700, cursor: 'pointer',
            }}>{leverage}× 적용</button>
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
  props: { presetPrice?: number | null; presetSeq?: number; dense?: boolean },
) {
  const { marketType } = useTerminal();
  if (marketType === 'SPOT') return <SpotOrderPanel {...props}/>;
  // COIN-M은 수량 단위가 계약이고 증거금이 코인이라 폼 자체가 다르다.
  if (marketType === 'COIN_FUTURES') return <CoinMOrderPanel dense={props.dense}/>;
  return <OrderFormPanel {...props}/>;
});

// ══ PC 우측 열 — 둘을 쌓는다 ═══════════════════════════
export const OrderPane = memo(function OrderPane() {
  const { pick, presetPrice, presetSeq } = usePickedPrice();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      <OrderBookPanel onPickPrice={pick}/>
      <div style={{ borderTop: `1px solid ${C.hair}` }}/>
      <MarketOrderPanel presetPrice={presetPrice} presetSeq={presetSeq}/>
    </div>
  );
});

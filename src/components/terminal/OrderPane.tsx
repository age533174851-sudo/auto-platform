'use client';
import { A } from '@/lib/theme/colors';
import { errorTextOf } from '@/lib/http/errorText';
import { lossPreview } from '@/lib/engine/orderSizing';
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
import { StockOrderPanel } from './StockOrderPanel';
import { canOpenFutures, type WalletTree } from '@/lib/markets/wallets';
import { MODE_INFO, orderEndpointFor, marketSupportsExchange } from '@/lib/markets/tradeMode';
import { liquidationDistancePct } from '@/lib/engine/leverageMath';
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
/** 수량 단위(코인 개수 / USDT 금액) 기억용 */
const UNIT_KEY = 'tg_terminal_unit';
/** 모의에서 마지막으로 고른 마진 모드 */
const PAPER_MARGIN_KEY = 'tg_paper_margin_mode';

/**
 * 이 배율에서 청산까지의 대략 거리(%).
 * 정확한 값은 유지증거금 구간에 따라 달라지므로 이 값은 **상한**에 가깝다.
 * 실제 청산은 이보다 가깝다. 화면에도 그렇게 적는다.
 */
/**
 * 배율만 보고 어림잡은 청산 거리(%).
 *
 * ⚠ **포지션이 있으면 이 값을 쓰지 않는다.** 거래소가 계산한 실제
 * 청산가가 있으면 그걸 써야 한다 — 이 식은 유지증거금도, 이미 열린
 * 포지션의 평균가도, 추가 증거금도 모르기 때문이다.
 *
 * 그리고 이 식은 `100 / leverage`라 **유지증거금을 빼지 않는다.**
 * 5배에서 정확히 20.0%가 나오는데 실제로는 19.6%쯤이다. 그래서
 * 판정에는 `lib/engine/leverageMath.ts`의 `liquidationDistancePct`를
 * 쓴다 — 그쪽은 MMR을 빼고, 성립하지 않으면 null을 준다.
 *
 * 여기 남겨 둔 것은 **포지션이 아직 없을 때의 눈금**뿐이다.
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
    try {
      const raw = localStorage.getItem(LEV_KEY);
      if (raw) { const v = +raw; if (v >= 1 && v <= 125) return v; }
    } catch { /* 설정으로 */ }
    // 저장된 값이 없으면 설정의 기본 배율을 쓴다
    try {
      const { loadPrefs } = require('@/lib/ui/preferences');
      return loadPrefs().leverage;
    } catch { return 5; }
  });
  const [levOpen, setLevOpen] = useState(false);
  // 손절 폭(%). **이 칸이 없어서 신규 진입이 전부 거부되고 있었다** —
  // 서버(manualPlan)가 손절 없는 진입을 막는데 화면이 값을 보내지 않았다.
  // 화면에서 못 넣는 값을 서버가 요구하면 그 기능은 죽은 것이다.
  const [slPct, setSlPct] = useState(2);
  /** 마지막으로 고른 계좌 위험 %. 버튼을 칠해 두기 위한 것 */
  const [riskPick, setRiskPick] = useState<number | null>(null);
  // 직접 입력 중인 문자열. 숫자 상태와 따로 두는 이유: '1.'이나 '0.'처럼
  // **아직 숫자가 아닌 중간 상태**를 그대로 보여줘야 지우고 다시 쓸 수 있다.
  // 숫자만 들고 있으면 '10'에서 한 글자 지운 '1'이 곧바로 확정돼 버린다.
  const [slText, setSlText] = useState('');
  /** 손절을 가격으로 적을 때의 입력 문자열. 값은 %로 환산해 slPct에 저장한다 */
  const [slPriceText, setSlPriceText] = useState('');
  // 오늘 손실 한도. **보이지 않으면 없는 것과 같다** — 주문 버튼을 눌렀을
  // 때 처음 알게 되면 그 시점까지 한도를 모른 채로 계획을 세운 것이다.
  const [dailyLimit, setDailyLimit] = useState<any>(null);
  // 지금 시장 국면. **필터를 켜지 않아도 보여준다** — 필터가 꺼져 있어도
  // "지금 고변동장"이라는 사실은 알아야 한다.
  const [regime, setRegime] = useState<any>(null);
  // 청산 전용. 켜면 보유분을 줄이는 주문만 나간다 — 반대로 새 포지션이
  // 열리는 사고를 막는다.
  const [reduceOnly, setReduceOnly] = useState(false);
  /**
   * 지금 들고 있는 수량 (부호 있음, 롱 양수). 못 읽으면 null.
   *
   * 청산 탭이 이걸 쓴다. 없으면 사용자가 이미 가진 것을 닫으려는데 얼마를
   * 닫을지 다시 적어야 하고, 0.976을 0.97로 잘못 적으면 일부만 닫힌다.
   */
  const [posAmt, setPosAmt] = useState<number | null>(null);
  /** 거래소가 계산한 실제 청산가. 못 읽으면 null — 추정치로 채우지 않는다 */
  const [posLiq, setPosLiq] = useState<number | null>(null);
  /** 청산 거리를 재는 기준가(마크가). 못 읽으면 null */
  const [posMark, setPosMark] = useState<number | null>(null);
  /**
   * 지금 들고 있는 방향. 없으면 null.
   *
   * 버튼 라벨이 이걸 본다 — 롱을 들고 있는데 '숏 진입'이라고만 적혀 있으면
   * 사람은 그걸 파는 버튼으로 읽는다.
   */
  const holding: 'LONG' | 'SHORT' | null =
    posAmt == null || !(Math.abs(posAmt) > 0) ? null : (posAmt > 0 ? 'LONG' : 'SHORT');
  /**
   * 화면에 적을 수량. **부동소수 꼬리를 보여주지 않는다.**
   *
   * 거래소가 0.976을 주면 자바스크립트 안에서 0.9760000000000001이 되고,
   * 그대로 그리면 사용자는 그게 진짜 보유량이라고 읽는다. 그리고 그 숫자를
   * 다른 곳에 옮겨 적으면 거래소가 -1111로 거부한다.
   *
   * 자릿수를 **만들어내지는 않는다** — 8자리에서 잘라 꼬리만 지우고,
   * 실제로 다른 값이 되지는 않는다. 보내는 수량은 서버가 거래소 규격에
   * 맞춰 다시 자른다(quantizeOrder).
   */
  const showQty = (n: number) => String(Number(n.toFixed(8)));
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
  // 접힌 채로 시작한다 — 펼쳐 두면 진입 버튼이 화면 밖으로 밀린다
  const [blockOpen, setBlockOpen] = useState(false);
  // 확인창("네/아니요")을 못 띄운 이유. 비어 있지 않으면 화면에 적는다.
  const [reconciling, setReconciling] = useState(false);
  const [noAskWhy, setNoAskWhy] = useState('');

  // 이 심볼의 마진 모드. **null은 '격리'가 아니라 '모른다'다.**
  //
  // 예전에는 화면에 '격리'라는 글자만 박혀 있었다 — 거래소에서 읽지도 않고,
  // 누를 수도 없었다. 그래서 같은 화면 아래쪽에서 점검이 "마진 모드를 읽지
  // 못했습니다 — CROSS인지 확인할 수 없습니다"라고 말하는 동안, 위쪽은
  // '격리'라고 단정하고 있었다. 둘 중 하나는 거짓이고 사용자는 큰 글씨를 믿는다.
  const [marginType, setMarginType] = useState<'ISOLATED' | 'CROSSED' | null>(null);
  const [marginErr, setMarginErr] = useState('');
  const [marginBusy, setMarginBusy] = useState(false);
  const [marginOpen, setMarginOpen] = useState(false);

  // 주문 수량을 무엇으로 세는가 — 코인 개수(BTC)인가 금액(USDT)인가.
  //
  // 거래소는 늘 코인 개수로 받는다. USDT로 적으면 화면이 나눠서 개수를
  // 만든다. **환산은 화면에서 하고, 서버로는 개수만 보낸다** — 두 곳에서
  // 나누기 시작하면 어느 쪽이 실제로 나간 수량인지 알 수 없다.
  const [unit, setUnit] = useState<'BASE' | 'QUOTE'>(() => {
    // 마지막에 쓰던 값이 먼저다. 없으면 **설정의 기본값**을 쓴다 —
    // 설정을 바꿔 놓고 매번 다시 고르게 하면 그 설정은 없는 것과 같다.
    try {
      const last = localStorage.getItem(UNIT_KEY);
      if (last === 'QUOTE' || last === 'BASE') return last;
    } catch { /* 설정으로 */ }
    try {
      const { loadPrefs } = require('@/lib/ui/preferences');
      return loadPrefs().unit;
    } catch { return 'BASE'; }
  });
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
    // ── 계좌가 바뀌면 **먼저 비운다** ──
    //
    // 예전에는 새 잔고가 도착할 때까지 앞 계좌의 값이 화면에 남아 있었다.
    // Gate에서 Binance로 바꾼 직후의 몇 초 동안, 화면은 **Binance 계좌
    // 이름 아래에 Gate의 잔고**를 그린다. 그 사이에 수량을 정하면 없는
    // 돈을 기준으로 주문을 만든다.
    //
    // 비우면 '읽는 중'이 되고, 그건 틀린 숫자보다 언제나 낫다.
    setWallet(null); setWalletErr('');
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
          setWalletErr(fe && fe.ok === false ? String(errorTextOf(fe, '선물 지갑을 읽지 못했습니다')) : '');
          return;
        }
        // **왜 못 읽었는지를 버리지 않는다.** 지금까지 이유를 통째로
        // 지우고 '확인 불가'만 남겼는데, 그러면 테스트 자금을 받으러 갈지
        // 키를 고칠지 사용자가 알 수 없다.
        setWallet(null);
        setWalletErr(String(errorTextOf(j, `조회 실패 (${r.status})`)));
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
    // 한도도 계좌마다 다르다. 앞 계좌의 '오늘 -1.2%'를 새 계좌 아래에
    // 두면, 아직 아무것도 안 한 계좌가 이미 손실 중인 것으로 보인다.
    setDailyLimit(null);
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

  // ── 마진 모드를 실제로 읽어 온다 ──
  //
  // 모의는 거래소에 나가지 않으므로 물어볼 곳이 없다. 그때는 '격리'로
  // **고정**이고, 그건 앱이 정한 규칙이라 단정해도 된다 — 거래소 상태를
  // 모르면서 단정하는 것과 다르다.
  useEffect(() => {
    if (isPaper) {
      // 모의는 거래소에 물어볼 곳이 없다. 대신 **이 화면이 고른 값이
      // 그대로 주문에 실려 나가고**, 모의 엔진이 그 모드로 청산가를
      // 계산한다(paperPlan.liquidationFor). 마지막에 고른 값을 기억한다.
      try {
        const saved = localStorage.getItem(PAPER_MARGIN_KEY);
        // 저장값이 먼저다 — 이 화면에서 마지막에 고른 것.
        // 없으면 설정 화면의 기본값을 쓴다. 예전처럼 무조건 ISOLATED로
        // 떨어뜨리면, 설정에서 교차를 골라 둔 사람이 매번 격리로 시작한다.
        if (saved === 'CROSSED' || saved === 'ISOLATED') setMarginType(saved);
        else {
          const { loadPrefs } = require('@/lib/ui/preferences');
          setMarginType(loadPrefs().paperMargin);
        }
      } catch { setMarginType('ISOLATED'); }
      setMarginErr('');
      return;
    }
    const connId = modeResolution.connId;
    if (!auth || !connId) { setMarginType(null); setMarginErr('연결이 없어 확인하지 못했습니다'); return; }
    // 포지션과 마진 모드도 계좌마다 다르다. 계좌를 바꾼 직후에 앞 계좌의
    // 포지션이 남아 있으면, 화면은 없는 포지션의 청산가를 그리고 주문판은
    // '보유 중'으로 동작한다 — 그 상태에서 [전량청산]이 눌린다.
    setMarginType(null); setMarginErr('');
    setPosAmt(null); setPosLiq(null); setPosMark(null);
    let alive = true;
    (async () => {
      try {
        const r = await fetch(
          `/api/binance/futures/margin-type?connectionId=${encodeURIComponent(connId)}&symbol=${symbol.id}`,
          { headers: { Authorization: auth } });
        const j = await r.json();
        if (!alive) return;
        setMarginType(j?.marginType ?? null);
        setMarginErr(j?.marginType ? '' : (errorTextOf(j, '마진 모드를 읽지 못했습니다')));
        const amt = Number(j?.positionAmt);
        setPosAmt(Number.isFinite(amt) ? amt : null);
        const lq = Number(j?.liquidationPrice);
        setPosLiq(Number.isFinite(lq) && lq > 0 ? lq : null);
        const mk = Number(j?.markPrice);
        setPosMark(Number.isFinite(mk) && mk > 0 ? mk : null);
      } catch (e: any) {
        // **격리로 가정하지 않는다.** 여기서 기본값을 넣으면 화면이 다시
        // 거짓말을 시작한다.
        if (alive) { setMarginType(null); setMarginErr(`조회 실패 (${e?.message || e})`); setPosAmt(null); setPosLiq(null); setPosMark(null); }
      }
    })();
    return () => { alive = false; };
  }, [auth, modeResolution.connId, symbol.id, isPaper]);

  /** 마진 모드를 바꾼다. 교차는 되돌릴 수 없는 성격이라 한 번 묻는다. */
  const switchMargin = async (want: 'ISOLATED' | 'CROSSED') => {
    const connId = modeResolution.connId;

    // 모의는 거래소를 안 탄다. **다음 주문에 실려 나가는 값**이라
    // 여기서 바로 정하면 된다. 이미 열린 포지션의 청산가는 바뀌지 않는다 —
    // 그건 진입할 때의 모드로 계산돼 장부에 박혀 있다.
    if (isPaper) {
      if (want === 'CROSSED') {
        const { confirmDialog } = await import('@/lib/confirm/dialog');
        const ok = await confirmDialog([
          '다음 모의 주문을 교차(CROSS)로 넣습니다.',
          '',
          '교차는 **가상 계좌 잔고 전체가** 포지션을 받칩니다.',
          '잔고가 많을수록 청산가가 멀어지고, 적을수록 가까워집니다.',
          '',
          '이미 열려 있는 포지션에는 적용되지 않습니다 — 그건 진입할 때의',
          '모드로 계산된 청산가를 그대로 씁니다.',
        ].join('\n'), { title: '교차로 넣을까요?', confirmText: '네', cancelText: '아니요' });
        if (!ok) return;
      }
      setMarginType(want);
      setMarginOpen(false);
      setMarginErr('');
      try { localStorage.setItem(PAPER_MARGIN_KEY, want); } catch {}
      return;
    }
    if (!auth || !connId) { setMarginErr('로그인·연결이 필요합니다'); return; }
    if (want === marginType) { setMarginOpen(false); return; }

    if (want === 'CROSSED') {
      const { confirmDialog } = await import('@/lib/confirm/dialog');
      const ok = await confirmDialog([
        `${symbol.id}를 교차(CROSS)로 바꿉니다.`,
        '',
        '교차에서는 손실이 이 포지션의 증거금을 넘어 **계좌 전체로 번집니다.**',
        '이 앱의 청산가 계산과 증거금 상한은 모두 격리를 전제로 합니다.',
      ].join('\n'), { title: '교차로 바꿀까요?', confirmText: '네', cancelText: '아니요', danger: true });
      if (!ok) return;
    }

    setMarginBusy(true); setMarginErr('');
    try {
      const r = await fetch('/api/binance/futures/margin-type', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ connectionId: connId, symbol: symbol.id, marginType: want }),
      });
      const j = await r.json();
      if (r.ok && j?.ok) {
        setMarginType(want); setMarginOpen(false);
        notifySuccess('마진 모드 변경', j.message || `${want}로 바꿨습니다`);
      } else {
        // 실패했으면 **화면 값을 바꾸지 않는다.** 거래소는 그대로다.
        setMarginErr(errorTextOf(j, `실패 (${r.status})`));
      }
    } catch (e: any) {
      setMarginErr(`응답 없음 — 거래소에서 직접 확인하세요 (${e?.message || e})`);
    } finally { setMarginBusy(false); }
  };

  // 비율 버튼은 **선물 가용 증거금**만 쓴다. 현물 USDT를 쓰면 없는 돈으로
  // 수량을 계산하게 되고, 그 수량이 그대로 주문이 된다.
  //
  // 모의에서는 가상 계좌의 가용이 그 자리다. 거래소 잔고를 쓰면 모의인데
  // 실계좌 잔고로 수량이 계산된다 — 연습이 되지 않는다.
  const balanceUsd = isPaper
    ? (paper.acct ? paper.acct.available : null)
    : (wallet?.futuresUsableMargin ?? null);

  const mid = stream.lastPrice;

  // ── 단위 환산은 **여기 한 곳에서만** 한다 ──
  //
  // 거래소는 언제나 코인 개수로 받는다. 사용자가 USDT로 적었으면 화면이
  // 나눠서 개수를 만든다. 그 환산을 서버에도 두면 두 곳이 나누게 되고,
  // 그러면 실제로 나간 수량이 어느 쪽 계산인지 알 수 없다.
  const unitPx = Number(price) || mid || 0;
  /** 사용자가 입력란에 적은 숫자 (단위는 unit) */
  const typedQty = Number(qty);
  /**
   * 실제로 주문에 나갈 코인 개수.
   *
   * USDT로 적었는데 **가격을 모르면 NaN이다.** 0으로 두면 아래 검사에서
   * '수량을 입력하세요'로 끝나 버리는데, 실제 문제는 가격을 못 읽은 것이다.
   */
  const baseQty = unit === 'BASE'
    ? typedQty
    : (unitPx > 0 ? typedQty / unitPx : NaN);
  const notional = (Number.isFinite(baseQty) ? baseQty : 0) * unitPx;
  const margin = leverage > 0 ? notional / leverage : 0;
  // 비용을 **계산할 수 있었는가.** 수량을 못 읽었거나(USDT로 적었는데
  // 가격이 없음) 가격이 0이면 명목가가 0이 되고, 화면에는 '비용 0.00'이
  // 뜬다. 그건 "공짜"로 읽히지만 사실은 **모른다**이다.
  const costKnown = Number.isFinite(baseQty) && unitPx > 0;

  // ── 이 모드로 주문할 연결이 정해졌는가 ──
  //
  // 화면에 이런 상태가 실제로 떴다: 상단은 'USDⓈ-M · 테스트넷'인데
  // "거래소 연결이 없습니다"이고, 잔고는 확인 불가, 포지션 칸은 "연결을
  // 선택하면 표시됩니다" — 그런데 **롱 진입·숏 진입 버튼은 눌렸다.**
  //
  // 공개 시세는 연결 없이도 오므로 차트와 호가는 정상으로 보인다. 그
  // 화면만 보면 주문도 될 것 같다. submit()이 막고는 있었지만, 막는
  // 자리가 클릭 뒤라 사용자는 **누를 수 있는 버튼**을 본다.
  // 누를 수 없는 것은 눌러 보고 알 일이 아니다.
  const noConn = !isPaper && !modeResolution.ok;
  // ── 청산 거리 ──
  //
  // **포지션이 있으면 거래소가 계산한 값을 쓴다.** 예전에는 언제나
  // `100 / leverage`였다 — 5배에서 정확히 20.0%가 나오는데, Gate가 준
  // 실제 값은 19.7%였다. 우연히 비슷해서 안 들켰을 뿐 다른 숫자다.
  //
  // 그 식은 유지증거금도, 이미 열린 포지션의 평균가도, 추가 증거금도
  // 모른다. 그리고 화면에 '청산 20.0%'라고만 적혀 있으면 그게 추정인지
  // 실제인지 알 방법이 없다.
  //
  // 포지션이 없을 때는 판정용 식(leverageMath)을 쓴다 — 그쪽은 유지
  // 증거금을 빼고, 성립하지 않으면 null을 준다.
  const liqActualPct = (posLiq != null && posMark != null && posMark > 0)
    ? Math.abs(posMark - posLiq) / posMark * 100
    : null;
  const liqPlannedPct = liquidationDistancePct(leverage);
  /** 손절이 청산 안쪽인지 판정할 때 쓰는 값. 실제값이 있으면 그것이 우선 */
  const liqPct = liqActualPct ?? liqPlannedPct ?? roughLiqDistancePct(leverage);
  /** 이 숫자가 거래소가 준 것인가, 우리가 계산한 것인가 */
  const liqIsActual = liqActualPct != null;
  // 이 잔고와 배율로 열 수 있는 최대 명목가. 잔고를 모르면 null이다 —
  // 0으로 적으면 '주문 불가'로 읽히고, 큰 수를 임의로 넣으면 더 나쁘다.
  const maxOpenUsd = balanceUsd == null ? null : balanceUsd * leverage;
  /** 청산 거리를 실제로 구했는가. 못 구한 것을 0%로 적으면 '지금 청산'이 된다 */
  const liqOk = Number.isFinite(liqPct);
  const liqTone = !liqOk ? C.warn : liqPct < 1 ? C.down : liqPct < 3 ? C.warn : C.dim;
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
    // ── 청산이면 **보유 수량의 비율**이다 ──
    //
    // 신규는 '잔고의 몇 %를 걸까'이고 청산은 '가진 것의 몇 %를 닫을까'다.
    // 같은 버튼이 두 뜻을 갖는데 예전에는 언제나 잔고 기준이라, 청산 탭에서
    // 50%를 누르면 **가진 것과 무관한 수량**이 들어갔다.
    if (reduceOnly) {
      if (posAmt == null || !(Math.abs(posAmt) > 0)) return;   // 모르면 채우지 않는다
      const base = Math.abs(posAmt) * (pct / 100);
      const v = unit === 'BASE' ? base : base * (unitPx || 0);
      setQty(v > 0 ? String(Number(v.toFixed(unit === 'BASE' ? 6 : 2))) : '');
      return;
    }
    const px = Number(price) || mid || 0;
    // 잔고를 모르면 비율 계산이 불가능하다. 임의 값으로 채우지 않는다.
    if (px <= 0 || balanceUsd == null) return;
    // 이 비율로 열 명목가(USDT). 코인 개수는 여기서 나눠 만든다.
    const notionalUsd = balanceUsd * (pct / 100) * leverage;
    // **고른 단위로 적는다.** 개수 칸에 USDT를, USDT 칸에 개수를 넣으면
    // 사용자가 보는 숫자와 나가는 주문이 어긋난다.
    const v = unit === 'BASE' ? notionalUsd / px : notionalUsd;
    setQty(v > 0 ? String(Number(v.toFixed(unit === 'BASE' ? 6 : 2))) : '');
  };

  /**
   * **위험에서 수량을 낸다.**
   *
   * 위의 setPct(25/50/75/100%)는 잔고의 몇 %를 걸까이고, 그건 위험과
   * 무관한 숫자다. 잔고의 50%를 5배로 열면 계좌의 250%가 노출되는데
   * 잃는 돈은 손절이 어디인지에 따라 완전히 달라진다.
   *
   * 이 버튼은 "이 거래에서 계좌의 몇 %를 잃어도 되는가"만 묻고, 손절
   * 거리로 나눠 수량을 만든다. 계산은 orderSizing 한 곳에서 온다 —
   * 여기서 다시 쓰면 확인창에 적히는 손실과 어긋난다.
   */
  const setByRisk = async (riskPct: number) => {
    const px = orderType === 'LIMIT' ? (Number(price) || mid || 0) : (mid || 0);
    const { planSize } = await import('@/lib/engine/orderSizing');
    const r = planSize({
      equity: balanceUsd, entryPrice: px,
      // 방향은 손절이 위인지 아래인지만 정한다. **거리는 같으므로 수량은
      // 방향과 무관하다** — 아직 롱/숏을 안 눌렀어도 계산할 수 있다.
      side: side === 'BUY' ? 'LONG' : 'SHORT',
      basis: 'ACCOUNT_RISK', pct: riskPct, leverage,
    }, { pricePctForAccountRisk: slPct });

    // **못 냈으면 채우지 않고 이유를 적는다.** 조용히 아무 일도 안
    // 일어나면 사용자는 버튼이 고장 난 줄 안다.
    if (r.qty == null || !(r.qty > 0)) { setMsg({ ok: false, text: r.reason }); return; }
    setQty(unit === 'BASE'
      ? String(Number(r.qty.toFixed(6)))
      : String(Number((r.qty * px).toFixed(2))));
    setRiskPick(riskPct);
    setMsg(r.ok ? null : { ok: false, text: r.reason });
  };

  /** 단위를 바꾼다. **적어 둔 값을 그대로 두지 않고 환산한다** */
  const switchUnit = (next: 'BASE' | 'QUOTE') => {
    if (next === unit) return;
    setUnit(next);
    try { localStorage.setItem(UNIT_KEY, next); } catch {}
    // 값이 없거나 가격을 모르면 환산할 수 없다. 그때는 **비운다** —
    // 숫자를 그대로 두면 0.09 BTC가 0.09 USDT로 읽히고, 그 상태로 눌리면
    // 의도한 것의 70만분의 1이 나간다.
    const cur = Number(qty);
    if (!Number.isFinite(cur) || cur <= 0 || unitPx <= 0) { setQty(''); return; }
    const v = next === 'BASE' ? cur / unitPx : cur * unitPx;
    setQty(String(Number(v.toFixed(next === 'BASE' ? 6 : 2))));
  };

  // 방향을 인자로 받는다. 바이낸스처럼 롱·숏 버튼을 동시에 두면
  // 누른 버튼이 곧 방향이다 — 토글 상태를 따로 기억하지 않는다.
  // 토글이 있으면 '숏으로 맞춰놨는데 롱이 나갔다'가 가능해진다.
  const submit = async (orderSide: 'BUY' | 'SELL') => {
    setMsg(null);
    setBlockers([]);
    setRiskError(null);
    setBlockOpen(false);
    setNoAskWhy('');
    setSide(orderSide);
    if (!auth) { setMsg({ ok: false, text: '로그인이 필요합니다' }); return; }
    // 모의는 연결이 필요 없다. 나머지는 이 모드에서 쓸 연결이 있어야 한다.
    if (!modeResolution.ok) { setMsg({ ok: false, text: modeResolution.reason }); return; }

    // ── 이 연결로 이 시장에 주문할 수 있는가 ──
    //
    // 주문 라우트는 **시장**으로 정해진다(orderEndpointFor). 그런데 연결은
    // 거래소별이다. 게이트아이오 연결을 고른 채 USDⓈ-M을 누르면 바이낸스
    // 라우트로 가고, 서버가 거부한다 — 예전에는 그 응답이 `not_binance`
    // 한 단어로 화면에 떴다.
    //
    // 보내 놓고 거부당하는 것보다 **누르기 전에 말하는 것**이 낫다.
    //
    // 다만 이 검사가 `exchange_id !== 'binance'`로 박혀 있었다. 그래서
    // 서버에서 Gate를 열어 준 뒤에도 **화면이 계속 막았다** — 주문은
    // 나갈 수 있는데 버튼을 누르면 "바이낸스 연결로만 나갑니다"가 떴다.
    // 고쳤는데 다른 곳이 남은 것이고, 이 저장소에서 가장 자주 반복된
    // 실패다. 지원 여부는 이제 marketSupportsExchange 한 곳에 있다.
    if (!isPaper) {
      const chosen = connections.find((c: any) => c.id === modeResolution.connId);
      // 모르면 막지 않는다 — 목록을 못 읽었다는 이유로 주문을 막으면
      // 확인하지 못한 것이 거부가 된다. 서버가 진짜 판정자다.
      const sup = marketSupportsExchange((chosen as any)?.exchange_id, 'USDM');
      if (!sup.ok) { setMsg({ ok: false, text: sup.reason }); return; }
    }
    // USDT로 적었으면 여기서 코인 개수가 된다. **가격을 모르면 환산이
    // 불가능하고, 그건 '수량을 안 적었다'와 다른 문제다** — 다르게 말한다.
    if (unit === 'QUOTE' && unitPx <= 0) {
      setMsg({ ok: false, text: '가격을 확인하지 못해 USDT를 수량으로 바꿀 수 없습니다 — 지정가를 입력하거나 단위를 ' + base + '로 바꾸세요' });
      return;
    }
    const q = Number(baseQty);
    if (!Number.isFinite(q) || q <= 0) { setMsg({ ok: false, text: '수량을 입력하세요' }); return; }
    if (!reduceOnly && !(slPct > 0)) {
      setMsg({ ok: false, text: '손절 폭을 고르세요 — 손절 없는 진입은 받지 않습니다' });
      return;
    }

    // 확인창을 띄우는가.
    //
    // 설정(화면 → 확인창)에서 유형별로 끌 수 있다. 다만 **실전은 설정과
    // 무관하게 항상 묻는다** — 진짜 돈이 나가는 것을 설정 하나로 끌 수
    // 있으면 그건 설정이 아니라 안전장치 제거다. 그 규칙은
    // preferences.shouldConfirm 한 곳에 있고 테스트가 붙어 있다.
    //
    // 실전은 누를 때마다 확인한다. 모드 전환에서 한 번 확인했지만, 그건
    // 몇 분 전 일이고 그 사이 화면을 여러 번 만졌다.
    {
      const { loadPrefs, shouldConfirm } = await import('@/lib/ui/preferences');
      const kind = orderType === 'LIMIT' ? 'LIMIT' : 'MARKET';
      if (shouldConfirm(loadPrefs(), kind, !!modeResolution.realMoney)) {
        const { confirmDialog } = await import('@/lib/confirm/dialog');
        const real = !!modeResolution.realMoney;
        // ── 무엇이 나가는지 숫자로 적는다 ──
        //
        // 예전에는 방향·수량·손절%·증거금까지만 있었다. **정작 가장
        // 알아야 하는 숫자가 없었다** — 이 거래에서 얼마를 잃는가.
        // '손절 2%'만 보고는 그게 계좌의 0.2%인지 20%인지 알 수 없고,
        // 5배와 100배에서 그 답은 쉰 배 차이다.
        //
        // 계산은 orderSizing 한 곳에서 온다. 확인창이 자기 식을 들고
        // 있으면 여기 적힌 손실과 실제로 나가는 수량이 어긋난다.
        const { lossPreview } = await import('@/lib/engine/orderSizing');
        const refPx = orderType === 'LIMIT' ? Number(price) : (mid ?? 0);
        const lp = lossPreview({
          equity: balanceUsd, entryPrice: refPx, qty: q,
          side: orderSide === 'BUY' ? 'LONG' : 'SHORT', pricePct: slPct,
        });
        const acct = connections.find((c: any) => c.id === modeResolution.connId);
        const okToGo = await confirmDialog([
          `${real ? '실전' : tradeMode === 'PAPER' ? '모의' : '테스트넷'} `
            + `${orderSide === 'BUY' ? 'LONG' : 'SHORT'} ${q} ${base} · ${leverage}배`,
          '',
          // **어느 계좌인가.** 이 화면에서 되돌릴 수 없는 질문의 절반이다.
          isPaper ? '계좌      모의 (거래소에 나가지 않음)'
                  : `계좌      ${acct?.label || acct?.exchange_id || '연결'} · ${real ? '실전' : '테스트넷'}`,
          `기준가    ${orderType === 'LIMIT' ? fmtPrice(Number(price)) : (mid != null ? fmtPrice(mid) : '시장가')}`,
          `손절      ${lp.stopPrice != null ? fmtPrice(lp.stopPrice) : '—'} (가격 ${slPct}%)`,
          // 못 구한 것을 0으로 적지 않는다. 0은 '안 잃는다'는 뜻이 된다.
          `예상 최대 손실  ${lp.loss != null ? `${fmtPrice(lp.loss)} USDT` : '계산 불가'}`
            + (lp.lossPctOfEquity != null ? ` · 계좌의 ${lp.lossPctOfEquity.toFixed(2)}%` : ''),
          `증거금    약 ${fmtPrice(margin)} USDT`,
          liqOk ? `청산 거리  약 ${liqPct.toFixed(1)}%${liqIsActual ? ' (거래소 값)' : ''}` : '청산 거리  확인 불가',
          '',
          real ? '실제 자금이 사용됩니다. 되돌릴 수 없습니다.' : '가상 자금입니다.',
        ].join('\n'), { danger: real });
        if (!okToGo) return;
      }
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
              // 모의 엔진이 이 모드로 청산가를 계산한다. 안 보내면 격리다.
              marginMode: marginType === 'CROSSED' ? 'CROSSED' : 'ISOLATED',
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
        } else {
          // **왜 안 물어보는지 적는다.** 예전에는 여기서 아무 일도 안
          // 일어났고, 사용자에게는 '네/아니요가 안 나온다'로만 보였다.
          // 안 뜨는 것과 고장 난 것이 화면에서 똑같았다.
          setNoAskWhy(p.whyNoAsk || '');
        }
      }

      if (r.ok && j?.ok) {
        // 넘겨서 나간 것을 '통과'로 적지 않는다.
        const okText = (j?.message || '주문 접수됨')
          + (j?.checklist?.overridden ? ` · ${j.checklist.overrideNote}` : '')
          // 수량·가격이 거래소 규격에 맞춰 바뀌었거나, 규격을 못 읽어
          // 그대로 보냈다는 사실. 서버는 계속 돌려주고 있었는데 화면이
          // 한 번도 쓰지 않았다 — 100%를 눌렀는데 잔고가 남는 이유가
          // 어디에도 없었다.
          + (j?.quantizeNote ? ` · ${j.quantizeNote}` : '');
        setMsg({ ok: true, text: okText });
        // 토스트로도 띄운다 — 4초 뒤 저절로 사라지고, 탭하면 바로 닫히고,
        // 알림 센터에 남아서 나중에 다시 볼 수 있다.
        notifySuccess('주문 접수됨', okText);
        setQty('');
        if (isPaper) paper.reload();
      } else {
        // ── 인증 오류인데 쓸 수 있는 연결이 여럿이면 그 사실을 함께 적는다 ──
        //
        // 바이낸스 테스트넷은 **두 개**다. 현물은 testnet.binance.vision,
        // 선물은 demo-fapi — 키가 따로 발급된다. 둘 다 앱에서는 그냥
        // '테스트넷 연결'이라 목록에 나란히 서고, 앱이 그중 하나를 골라
        // 주문한다. 현물 테스트넷 키가 뽑히면 선물 주문은 -2015로 막힌다.
        //
        // 그때 사용자가 보는 것은 "API 키가 무효" 한 줄이다. 키는 멀쩡한데
        // **다른 연결을 골랐어야 했다**는 사실이 어디에도 없다.
        const raw = errorTextOf(j, `실패 (${r.status})`)
          // 실패한 이유가 규격 때문일 수 있다. 거래소 오류(-1111 등)만
          // 보여주면 무엇을 고쳐야 하는지 알 수 없다.
          + (j?.quantizeNote ? `\n\n${j.quantizeNote}` : '');
        const authish = /-2015|-2014|-1022|Invalid API|API-key|permissions/i.test(raw);
        const many = (modeResolution.choices ?? 0) > 1;
        const failText = raw
          + (j?.refusedOverrides?.length ? ' — 이 항목은 눌러서 넘길 수 없습니다' : '')
          + (authish && many
            ? `\n\n지금 이 모드에 쓸 수 있는 연결이 ${modeResolution.choices}개이고, `
              + `그중 **${modeResolution.chosenLabel || '첫 번째'}**로 보냈습니다. `
              + '바이낸스는 현물 테스트넷과 선물 데모의 키가 다릅니다 — '
              + '키를 고치기 전에 **다른 연결로 바꿔서** 먼저 시도해 보세요.'
            : '');
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
    // 주문판 안의 어떤 요소도 자기 칸을 넘어 호가창을 침범하지 않는다.
    // 넘치는 것을 고치는 것이 먼저이고 이건 마지막 방어선이다 — 그래도
    // 둔다. 한 줄이 넘치면 그 줄만이 아니라 옆 패널까지 망가진다.
    <div className="order-pane" style={{ padding: pad, display: 'flex', flexDirection: 'column', gap, position: 'relative', minHeight: '100%' }}>
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
      {/* **글자만 줄이면 다음에 또 넘친다.** flex + flex:1 세 칸이었고
          세 번째 칸에 nowrap이 붙어 있었다. flex 아이템의 기본 min-width는
          auto라 내용보다 좁아지지 않으므로, 폰에서 이 줄이 주문판을 뚫고
          나가 오른쪽 호가창 위에 겹쳐 그려졌다.
          배치는 globals.css의 .order-meta-grid가 정한다 — 모바일은 두 줄,
          768px부터 한 줄. 인라인 스타일로는 미디어 쿼리를 쓸 수 없다. */}
      <div className="order-meta-grid">
        {/* **읽어 온 값만 적는다.** 못 읽었으면 '확인 못 함'이다 —
            여기에 '격리'를 박아 두면, 아래 점검이 "CROSS인지 알 수 없다"고
            말하는 동안 위에서는 격리라고 단정하게 된다. 실제로 그랬다. */}
        {/* 모의에서도 **누르면 반응한다.** 예전에는 모의일 때 아무 일도
            안 일어나서, 사용자에게는 '고장난 버튼'으로 보였다.
            모의는 정말로 격리 고정이다 — 모의 엔진에 마진 모드 개념이
            없고(margin_mode 컬럼도 없다), 청산가는 진입가·배율만으로
            내는 순수 격리 공식이다. 그러니 교차를 고르게 하면 눌러도
            계산이 안 바뀌는 가짜 선택지가 된다. 대신 **왜 못 바꾸는지**를
            말한다. */}
        <button onClick={() => setMarginOpen(v => !v)}
          title={marginErr || undefined}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
            minWidth: 0, minHeight: dense ? 28 : 30, borderRadius: 7,
            background: marginType === 'CROSSED' ? C.downBg : C.raised,
            border: `1px solid ${marginType == null ? A(C.warn, '55')
              : marginType === 'CROSSED' ? A(C.down, '55') : C.hair}`,
            color: marginType == null ? C.warn : marginType === 'CROSSED' ? C.down : C.dim,
            fontSize: FS.micro, fontWeight: marginType === 'CROSSED' ? 800 : 600,
            cursor: 'pointer',
          }}>
          {marginType == null ? '모드 ?' : marginType === 'CROSSED' ? '교차' : '격리'}
          <span style={{ opacity: .5, fontSize: FS.micro }}>▾</span>
        </button>
        <button onClick={() => setLevOpen(v => !v)} style={{
          minWidth: 0, minHeight: dense ? 28 : 30, borderRadius: 7, cursor: 'pointer',
          background: leverage >= 50 ? C.downBg : C.raised,
          border: `1px solid ${leverage >= 50 ? A(C.down,'55') : C.hair}`,
          color: leverage >= 50 ? C.down : C.text,
          fontSize: FS.small, fontWeight: 700, ...NUM,
        }}>{leverage}×</button>
        <span className="liquidation-distance-card" style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 1, padding: '2px 4px',
          minHeight: dense ? 28 : 30, borderRadius: 7, background: C.raised,
          border: `1px solid ${liqOk && liqPct < 3 ? A(liqTone, '55') : C.hair}`,
          color: liqTone, fontWeight: 700, ...NUM,
        }} title={!liqOk ? '청산 거리를 계산하지 못했습니다'
            : liqIsActual
              ? `거래소 청산가 ${posLiq} · 마크가 ${posMark} 기준`
              : `배율 ${leverage}배 기준 예상 (유지증거금 반영)`}>
          {/* **짧게 두 줄로 적는다.** '청산가까지 약 19.6%'는 한 줄로는
              폰 폭을 넘고, 넘으면 줄 전체가 밀린다. 라벨과 숫자를 나누면
              칸이 좁아져도 접히기만 한다.
              그리고 **추정인지 실제인지 적는다** — 같은 숫자라도 뜻이 다르다.
              포지션이 없을 때는 '이 배율로 열면 이 정도'이고, 열린 뒤에는
              '거래소가 이 가격에 강제로 닫는다'이다. */}
          <span style={{ opacity: .65, fontWeight: 600 }}>청산 거리</span>
          {/* **계산 못 한 것을 0%로 적지 않는다.** 0%는 '지금 청산'이라는
              뜻이고, 그건 모름과 정반대다. */}
          <span>{liqOk ? `${liqIsActual ? '' : '약 '}${liqPct.toFixed(1)}%` : '확인 불가'}</span>
        </span>
      </div>

      {/* 모의는 왜 못 바꾸는가.
          "안 됩니다"만 적으면 고장으로 읽힌다 — 되는 곳을 같이 알려준다. */}
      {marginOpen && isPaper && (
        <div style={{ padding: '9px 10px', borderRadius: 8, background: C.raised, display: 'grid', gap: 6 }}>
          <div style={{ color: C.text, fontSize: FS.micro, fontWeight: 700 }}>
            모의는 격리로 고정입니다
          </div>
          <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
            모의 계좌는 교차 증거금을 계산하지 않습니다 — 청산가를 진입가와
            배율만으로 냅니다. 여기서 <b>교차</b>를 고를 수 있게 해 두면
            <b> 눌러도 아무것도 안 바뀌는 선택지</b>가 됩니다.
            <br/>
            교차를 연습하시려면 위에서 <b style={{ color: C.text }}>테스트넷</b>으로
            바꾸세요. 거기서는 실제로 거래소 설정이 바뀝니다.
          </div>
        </div>
      )}

      {/* 마진 모드 고르기 */}
      {marginOpen && (
        <div style={{ padding: '9px 10px', borderRadius: 8, background: C.raised, display: 'grid', gap: 7 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
            {(['ISOLATED', 'CROSSED'] as const).map(m => {
              const on = marginType === m;
              return (
                <button key={m} onClick={() => switchMargin(m)} disabled={marginBusy} style={{
                  minHeight: 34, borderRadius: 7, cursor: marginBusy ? 'default' : 'pointer',
                  background: on ? (m === 'CROSSED' ? C.down : C.accent) : C.panel,
                  color: on ? '#fff' : m === 'CROSSED' ? C.down : C.dim,
                  border: `1px solid ${on ? 'transparent' : C.hair}`,
                  fontSize: FS.micro, fontWeight: 700, opacity: marginBusy ? .5 : 1,
                }}>{m === 'CROSSED' ? '교차 CROSS' : '격리 ISOLATED'}</button>
              );
            })}
          </div>
          {/* 모의와 실계좌는 **적용 시점이 다르다.** 모의는 거래소를 안
              타므로 다음 주문에만 실리고, 실계좌는 심볼 설정을 바로 바꾼다.
              같은 문구를 쓰면 모의에서 '이미 열린 포지션도 바뀐 줄' 안다. */}
          <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.5 }}>
            <b style={{ color: C.dim }}>격리</b>는 손실이 이 포지션의 증거금까지만 갑니다.{' '}
            <b style={{ color: C.down }}>교차</b>는 <b style={{ color: C.down }}>계좌 전체</b>로 번지고,
            잔고가 많을수록 청산가가 멀어집니다.
            {isPaper
              ? ' 모의에서는 **다음 주문부터** 적용됩니다 — 이미 열린 포지션의 청산가는 진입할 때의 모드 그대로입니다.'
              : ' 열린 포지션이나 미체결 주문이 있으면 거래소가 변경을 거부합니다.'}
          </div>
          {marginErr && (
            <div style={{ color: C.warn, fontSize: FS.micro, lineHeight: 1.5 }}>{marginErr}</div>
          )}
        </div>
      )}

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
            <button key={v} onClick={() => {
              const close = v === 'CLOSE';
              setReduceOnly(close);
              // ── 청산으로 바꾸면 **보유 수량을 채운다** ──
              //
              // 예전에는 칸이 빈 채로 남았다. 이미 가진 것을 닫으려는데
              // 얼마를 닫을지 다시 적어야 했고, 0.976을 0.97로 잘못 적으면
              // **일부만 닫히고 나머지는 그대로 남는다.** 닫는 동작에서
              // 그건 가장 나쁜 결과다.
              //
              // 못 읽었으면(posAmt null) 채우지 않는다 — 지어낸 수량으로
              // 청산 주문을 내면 안 된다. 신규로 돌아갈 때도 비운다:
              // 청산용으로 채워 둔 전량이 신규 진입 수량이 되면 의도의
              // 몇 배가 열린다.
              if (close && posAmt != null && Math.abs(posAmt) > 0) {
                const base = Math.abs(posAmt);
                setQty(unit === 'BASE'
                  ? showQty(base)
                  : String(Number((base * (unitPx || 0)).toFixed(2))));
              } else {
                setQty('');
              }
            }} style={{
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

      {/* 수량 — 코인 개수(BTC)로도, 금액(USDT)으로도 적을 수 있다.
          단위 칸을 누르면 바뀌고, 적어 둔 값은 그때 환산된다. */}
      <div style={{
        display: 'flex', alignItems: 'center', background: C.raised,
        border: `1px solid ${C.hair}`, borderRadius: 8, overflow: 'hidden',
      }}>
        <input value={qty} onChange={e => setQty(e.target.value)}
          placeholder={unit === 'BASE' ? '수량' : '주문금액'} inputMode="decimal"
          style={{
            flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
            color: C.text, padding: '9px 11px', fontSize: dense ? FS.small : FS.body, ...NUM,
          }}/>
        <button onClick={() => switchUnit(unit === 'BASE' ? 'QUOTE' : 'BASE')}
          title="단위 바꾸기"
          style={{
            padding: '0 10px', minHeight: 34, background: 'transparent', cursor: 'pointer',
            color: C.dim, fontSize: FS.micro, fontWeight: 700,
            border: 'none', borderLeft: `1px solid ${C.hair}`,
            display: 'flex', alignItems: 'center', gap: 3,
          }}>
          {unit === 'BASE' ? base : 'USDT'}
          <span style={{ opacity: .5 }}>⇄</span>
        </button>
      </div>

      {/* **실제로 나갈 개수를 적는다.**
          USDT로 적으면 거래소에 나가는 것은 그 숫자가 아니라 나눈 결과다.
          그 값을 안 보여주면 사용자가 확인할 방법이 없고, 그러면 이 칸은
          '얼마인지 모르는 주문'을 만드는 칸이 된다.
          가격을 못 읽었으면 환산도 못 한다 — 그 사실을 그대로 적는다. */}
      {unit === 'QUOTE' && Number(qty) > 0 && (
        <div style={{
          margin: '-4px 0 0', fontSize: FS.micro, lineHeight: 1.5,
          color: unitPx > 0 ? C.faint : C.warn, ...NUM,
        }}>
          {unitPx > 0
            ? `→ 약 ${Number(baseQty.toFixed(6))} ${base} (${fmtPrice(unitPx)} 기준)`
            : `가격을 확인하지 못해 ${base} 수량으로 바꿀 수 없습니다`}
        </div>
      )}

      {/* ── 위험에서 수량 내기 ──

          위의 25/50/75/100%는 '잔고의 몇 %를 걸까'다. 그건 위험과 무관한
          숫자다 — 잔고의 50%를 5배로 열면 계좌의 250%가 노출되는데, 잃는
          돈은 손절이 어디인지에 따라 완전히 달라진다.

          이 줄은 "이 거래에서 계좌의 몇 %를 잃어도 되는가"만 묻는다.
          그게 실제로 정해야 하는 유일한 값이고, 나머지는 계산이다. */}
      {!reduceOnly && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: C.faint, fontSize: FS.micro, minWidth: 26 }}>위험</span>
          {[0.5, 1, 2].map(p => (
            <button key={p} onClick={() => setByRisk(p)}
              style={{
                flex: 1, minHeight: 26, borderRadius: 6, cursor: 'pointer',
                background: riskPick === p ? C.accentBg : C.raised,
                color: riskPick === p ? C.accent : C.dim,
                border: `1px solid ${riskPick === p ? A(C.accent, '55') : C.hair}`,
                fontSize: FS.micro, fontWeight: 700, ...NUM,
              }}>계좌 {p}%</button>
          ))}
          <button onClick={() => { setRiskPick(null); setQty(''); }}
            style={{
              flex: 1, minHeight: 26, borderRadius: 6, cursor: 'pointer',
              background: riskPick == null ? C.accentBg : C.raised,
              color: riskPick == null ? C.accent : C.dim,
              border: `1px solid ${riskPick == null ? A(C.accent, '55') : C.hair}`,
              fontSize: FS.micro, fontWeight: 700,
            }}>직접</button>
        </div>
      )}

      {/* ── 지금 들고 있는 것 ──

          롱을 들고 있는데 화면에 [숏 진입]만 보이면, 그걸 '파는 버튼'으로
          읽는다. 실제로는 **반대 방향 신규 진입**이고, 눌리면 포지션이
          정리되는 대신 양쪽이 열리거나(헤지) 의도보다 큰 반대 포지션이 된다.

          버튼 이름은 이미 신규/청산에 따라 바뀐다. 그런데 **무엇을 들고
          있는지**가 화면에 없으면 어느 탭에 있어야 하는지를 알 수 없다.
          그래서 여기 한 줄로 적는다. */}
      {posAmt != null && Math.abs(posAmt) > 0 && (
        <div style={{
          padding: '6px 9px', borderRadius: 7,
          background: C.raised, fontSize: FS.micro, lineHeight: 1.5,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
        }}>
          <span style={{ color: C.dim }}>
            보유{' '}
            <b style={{ color: posAmt > 0 ? C.up : C.down }}>
              {posAmt > 0 ? '롱' : '숏'} {showQty(Math.abs(posAmt))}
            </b>
          </span>
        </div>
      )}

      {/* ── 포지션이 있으면 할 일이 다르다 ──

          지금까지 이 화면은 포지션이 있든 없든 같은 모양이었다. 신규
          진입·청산·반전이 한 줄에 섞여 있고, 무엇을 하려는지는 사용자가
          [신규]/[청산] 스위치로 스스로 골라야 했다.

          그런데 포지션을 들고 있을 때 실제로 하는 일은 넷뿐이다 —
          더 넣거나, 일부 닫거나, 전부 닫거나, 뒤집거나. 그 넷을 버튼으로
          두면 스위치를 고르고 수량을 적는 두 단계가 한 번으로 준다.

          **반전은 여기 두지 않는다.** 청산과 신규가 연달아 나가는 것이라
          중간에 실패하면 포지션이 없는 상태로 끝날 수 있고, 그 확인은
          여기 한 줄이 아니라 따로 받아야 한다. */}
      {holding && (
        <div style={{ display: 'flex', gap: 4 }}>
          {([
            ['추가', () => {
              // 같은 방향으로 더 넣는다. 수량은 비운다 — 청산용으로 채워
              // 둔 전량이 신규 수량이 되면 의도의 몇 배가 열린다.
              setReduceOnly(false); setQty(''); setRiskPick(null);
            }],
            ['부분청산 50%', () => {
              setReduceOnly(true);
              const half = Math.abs(posAmt as number) / 2;
              setQty(unit === 'BASE'
                ? showQty(half)
                : String(Number((half * (unitPx || 0)).toFixed(2))));
            }],
            ['전량청산', () => {
              setReduceOnly(true);
              const all = Math.abs(posAmt as number);
              setQty(unit === 'BASE'
                ? showQty(all)
                : String(Number((all * (unitPx || 0)).toFixed(2))));
            }],
          ] as const).map(([label, fn]) => (
            <button key={label} onClick={fn} style={{
              flex: 1, minWidth: 0, minHeight: 30, borderRadius: 7, cursor: 'pointer',
              background: C.raised, color: C.text, border: `1px solid ${C.hair}`,
              fontSize: FS.micro, fontWeight: 700,
            }}>{label}</button>
          ))}
        </div>
      )}

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
              <button key={p} onClick={() => { setSlPct(p); setSlText(''); }}
                style={{
                  flex: 1, minHeight: 26, borderRadius: 6, cursor: 'pointer',
                  background: slPct === p ? C.accentBg : C.raised,
                  color: slPct === p ? C.accent : C.dim,
                  border: `1px solid ${slPct === p ? A(C.accent, '55') : C.hair}`,
                  fontSize: FS.micro, fontWeight: 700, ...NUM,
                }}>{p}%</button>
            ))}
            {/* ── 직접 입력 ──
                버튼 다섯 개는 자주 쓰는 값일 뿐이고, 그 다섯 개만 쓸 수
                있다는 뜻이 아니다. 20%처럼 사이에 없는 값을 쓰려면 넣을
                자리가 있어야 한다 — 화면에서 못 넣는 값을 서버가 받는다면
                그 기능은 반쯤 죽은 것이다(손절 칸 자체가 없어서 신규 진입이
                전부 거부되던 것과 같은 모양이다).

                고른 값이 목록에 없으면 이 칸이 그 값을 들고 있으므로,
                무엇이 걸려 있는지 화면만 보고 알 수 있다. */}
            <input
              inputMode="decimal" placeholder="직접"
              value={slText !== '' ? slText : ([1, 2, 3, 5, 10].includes(slPct) ? '' : String(slPct))}
              onChange={e => {
                const t = e.target.value.replace(/[^0-9.]/g, '');
                setSlText(t);
                const n = Number(t);
                // 빈 칸이나 0은 **적용하지 않는다.** 지우는 도중에 손절이
                // 0으로 바뀌면, 그 순간 진입 버튼을 누른 주문이 손절 없이
                // 나가려 한다(서버가 막지만 이유가 엉뚱해진다).
                if (Number.isFinite(n) && n > 0 && n < 100) setSlPct(n);
              }}
              onBlur={() => setSlText('')}
              style={{
                width: 48, minHeight: 26, borderRadius: 6, textAlign: 'center',
                background: [1, 2, 3, 5, 10].includes(slPct) ? C.raised : C.accentBg,
                color: [1, 2, 3, 5, 10].includes(slPct) ? C.dim : C.accent,
                border: `1px solid ${[1, 2, 3, 5, 10].includes(slPct) ? C.hair : A(C.accent, '55')}`,
                fontSize: FS.micro, fontWeight: 700, outline: 'none', ...NUM,
              }}/>
          </div>
          {/* ── **2%가 무엇의 2%인가** ──

              버튼에 `2%`만 적혀 있으면 넷 다 말이 된다: 가격이 2% /
              증거금의 2% / 계좌의 2% / ROI −2%. 5배에서 전부 다른 가격이고
              100배에서는 쉰 배 차이가 난다. "2%면 안전하지"라고 생각한
              것이 실제로는 계좌의 20%일 수 있다.

              그래서 **기준을 적고 결과를 숫자로 보여준다.** 계산은
              orderSizing에서 온다 — 확인창과 같은 함수다. */}
          {(() => {
            const refPx = orderType === 'LIMIT' ? (Number(price) || mid) : mid;
            const lp = lossPreview({
              equity: balanceUsd, entryPrice: refPx, qty: baseQty,
              side: side === 'BUY' ? 'LONG' : 'SHORT', pricePct: slPct,
            });
            return (
              <div style={{
                marginTop: 4, padding: '5px 7px', borderRadius: 6,
                background: C.raised, fontSize: FS.micro, lineHeight: 1.5, ...NUM,
              }}>
                <span style={{ color: C.faint }}>기준 </span>
                <b style={{ color: C.text }}>가격 변동률</b>
                <span style={{ color: C.faint }}> · 손절 </span>
                <b style={{ color: C.text }}>
                  {lp.stopPrice != null ? fmtPrice(lp.stopPrice) : '—'}
                </b>
                <br/>
                <span style={{ color: C.faint }}>계좌 예상 손실 </span>
                {/* **못 구한 것을 0으로 적지 않는다.** 0은 '안 잃는다'는 뜻이다. */}
                {lp.loss != null ? (
                  <>
                    <b style={{ color: C.down }}>−{fmtPrice(lp.loss)} USDT</b>
                    {lp.lossPctOfEquity != null && (
                      <span style={{ color: C.faint }}> · 계좌의 {lp.lossPctOfEquity.toFixed(2)}%</span>
                    )}
                  </>
                ) : (
                  <span style={{ color: C.warn }}>{lp.reason || '수량을 넣으면 계산합니다'}</span>
                )}
              </div>
            );
          })()}

          {/* ── 손절을 **가격으로** 정하고 싶을 때 ──

              %는 계산의 단위이지 사람이 보는 단위가 아니다. 차트에서
              "62,400 밑으로 깨지면 나간다"를 정해 놓고 온 사람에게
              "그게 몇 %인지 계산해서 넣으세요"라고 하면, 반올림 한 번에
              의도한 자리가 아닌 곳에 손절이 걸린다.

              값은 %로 되돌려 저장한다. 서버·점검·주문이 전부 %를 쓰므로
              여기서만 환산하면 나머지는 손댈 필요가 없다 — 단위를 두 벌로
              들고 다니면 한쪽만 갱신되는 순간 손절가가 조용히 달라진다. */}
          {(() => {
            const ref0 = orderType === 'LIMIT' ? (Number(price) || mid) : mid;
            if (ref0 == null || !(ref0 > 0)) return null;
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                <span style={{ color: C.faint, fontSize: FS.micro, minWidth: 26 }}>가격</span>
                <input
                  inputMode="decimal"
                  placeholder={`롱 ${fmtPrice(ref0 * (1 - slPct / 100))}`}
                  value={slPriceText}
                  onChange={e => {
                    const t = e.target.value.replace(/[^0-9.]/g, '');
                    setSlPriceText(t);
                    const v = Number(t);
                    // 기준가와 같거나 반대편이면 **적용하지 않는다.** 거리가
                    // 0이면 손절이 즉시 발동하고, 그건 사용자가 원한 것이 아니다.
                    if (!Number.isFinite(v) || v <= 0) return;
                    const pct = (Math.abs(ref0 - v) / ref0) * 100;
                    if (pct > 0 && pct < 100) { setSlPct(Number(pct.toFixed(4))); setSlText(''); }
                  }}
                  onBlur={() => setSlPriceText('')}
                  style={{
                    flex: 1, minWidth: 0, minHeight: 26, borderRadius: 6, padding: '0 8px',
                    background: C.raised, color: C.text, border: `1px solid ${C.hair}`,
                    fontSize: FS.micro, fontWeight: 700, outline: 'none', ...NUM,
                  }}/>
              </div>
            );
          })()}
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
          {/* **못 읽은 것을 0으로 적지 않는다.** '비용 0.00'은 공짜로
              읽히지만 실제로는 가격이나 수량을 못 읽은 상태다. */}
          <span style={{ color: costKnown ? C.dim : C.warn }}>
            비용 {!costKnown ? '확인 불가' : margin > 0 ? fmtPrice(margin) : '—'}
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, ...NUM, fontSize: FS.micro }}>
          <Kv k="최대 주문" v={maxOpenUsd == null ? '확인 불가' : `${fmtPrice(maxOpenUsd)} USDT`}
              warn={maxOpenUsd == null}/>
          <Kv k="비용(증거금)"
              v={!costKnown ? '확인 불가' : margin > 0 ? `${fmtPrice(margin)} USDT` : '—'}
              warn={!costKnown}/>
          <Kv k="명목가" v={notional > 0 ? `${fmtPrice(notional)} USDT` : '—'}/>
        </div>
      )}

      {/* **막는 이유는 버튼 위에 둔다.**
          예전에는 버튼 아래에 있었다. 그런데 이 폼은 길어서 버튼이
          화면 바닥에 붙고, 그 아래 내용은 **화면 밖으로 밀린다.**
          사용자는 "6개가 막습니다"만 보고 이유는 영영 못 본다 —
          스크롤해야 보이는 안내는 없는 것과 같다. */}
      {/* **막는 이유 — 접힌 채로 시작한다.**
          펼쳐 두면 항목이 여섯일 때 세로로 길어져서 진입 버튼을 화면
          밖으로 밀어낸다. 그러면 이유는 보이는데 주문을 못 누른다.

          한 줄 요약(개수 + 첫 항목)만 먼저 보이고, 눌러야 펼쳐진다.
          펼쳐도 높이를 40vh로 묶고 안에서 스크롤한다 — 화면을 밀어내지
          않는다. */}
      {blockers.length > 0 && (
        <div style={{ borderRadius: 8, background: C.downBg, overflow: 'hidden' }}>
          <button onClick={() => setBlockOpen(v => !v)}
            style={{
              width: '100%', background: 'none', border: 'none', cursor: 'pointer',
              padding: '9px 10px', display: 'flex', gap: 8, alignItems: 'center',
              textAlign: 'left', color: 'inherit',
            }}>
            <span style={{ color: C.down, fontWeight: 900, fontSize: FS.micro, flexShrink: 0 }}>✕</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: FS.micro, lineHeight: 1.45 }}>
              <b style={{ color: C.down }}>{blockers.length}개가 막고 있습니다</b>
              <span style={{
                display: 'block', color: C.faint, marginTop: 2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {blockers[0]?.label} — {blockers[0]?.status === 'unknown' ? '확인 못 함' : '조건 불일치'}
              </span>
            </span>
            <span style={{ color: C.faint, fontSize: FS.micro, flexShrink: 0 }}>
              {blockOpen ? '접기 ▲' : '자세히 ▼'}
            </span>
            <span onClick={(e) => { e.stopPropagation(); setBlockers([]); setRiskError(null); setNoAskWhy(''); }}
              role="button" aria-label="닫기"
              style={{ color: C.faint, fontSize: FS.body, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}>×</span>
          </button>

          {/* ── 미확정 주문 확정 버튼 ──
              결과를 모르는 주문이 남아 있으면 신규 진입이 막힌다. 그건
              맞는 동작이다 — 나갔는지 모르는 주문 위에 또 얹으면 두 배로
              들어간다.
              문제는 **푸는 방법이 화면에 없었다**는 것이다. 안내가
              "/api/orders/reconcile로 확정하세요"였는데, 휴대폰으로 보는
              사람에게 API 주소는 막다른 길이다. */}
          {blockers.some(b => /미확정|확정되지 않은/.test(`${b.label} ${b.detail || ''}`)) && !isPaper && (
            <div style={{ padding: '0 10px 9px' }}>
              <button
                onClick={async () => {
                  if (!auth || !modeResolution.connId) return;
                  setReconciling(true);
                  try {
                    const r = await fetch(
                      `/api/orders/reconcile?connectionId=${encodeURIComponent(modeResolution.connId)}`,
                      { headers: { Authorization: auth } });
                    const j = await r.json();
                    // 결과를 그대로 보여준다. 몇 건을 어떻게 확정했는지
                    // 모르면 다시 눌러야 하는지 알 수 없다.
                    setMsg({ ok: !!j?.ok, text: j?.ok
                      ? `대조 완료 — ${j?.resolved ?? 0}건 확정${j?.stillUnknown ? ` · ${j.stillUnknown}건은 아직 모름` : ''}`
                      : errorTextOf(j, `대조 실패 (${r.status})`) });
                    if (j?.ok) { setBlockers([]); setRiskError(null); }
                  } catch (e: any) {
                    setMsg({ ok: false, text: `대조 요청이 응답하지 않았습니다 (${e?.message || e})` });
                  } finally { setReconciling(false); }
                }}
                disabled={reconciling}
                style={{
                  width: '100%', minHeight: 34, borderRadius: 8,
                  background: C.raised, color: C.text,
                  border: `1px solid ${A(C.down, '55')}`,
                  fontSize: FS.micro, fontWeight: 700,
                  cursor: reconciling ? 'default' : 'pointer', opacity: reconciling ? 0.6 : 1,
                }}>
                {reconciling ? '거래소와 대조 중…' : '미확정 주문 확정 (거래소와 대조)'}
              </button>
            </div>
          )}

          {/* **왜 "네/아니요"가 안 떴는가.** 접혀 있어도 보인다 — 이걸
              펼쳐야만 보이게 하면 사용자는 확인창이 고장 났다고 생각한다. */}
          {noAskWhy && (
            <div style={{
              margin: '0 10px 9px', padding: '7px 9px', borderRadius: 7,
              background: A(C.warn, '18'), color: C.warn,
              fontSize: FS.micro, lineHeight: 1.5,
            }}>
              확인창을 띄우지 않았습니다 — {noAskWhy}
            </div>
          )}

          {blockOpen && (
            <div style={{
              padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 7,
              // 화면을 밀어내지 않는다 — 길면 이 안에서 스크롤한다
              maxHeight: '40vh', overflowY: 'auto',
            }}>
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
              {riskError && (
                <div style={{ color: C.warn, fontSize: FS.micro, lineHeight: 1.5 }}>
                  거래소 조회 오류: {riskError}
                </div>
              )}
              <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.5 }}>
                <b style={{ color: C.dim }}>?</b> 는 조회가 실패한 것이고, <b style={{ color: C.down }}>✕</b> 는 실제로 조건에 걸린 것입니다.
              </div>
            </div>
          )}
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
      {/* ── 버튼이 **무슨 일이 일어나는지** 말한다 ──

          롱을 들고 있는데 빨간 버튼에 그냥 '숏 진입'이라고 적혀 있으면,
          사람은 그걸 **파는 버튼**으로 읽는다. 실제로는 반대 방향 신규
          진입이고, 눌리면 포지션이 정리되는 대신 양쪽이 열리거나(헤지)
          의도보다 큰 반대 포지션이 된다.

          같은 방향이면 '추가'다 — 그것도 '진입'과는 다른 일이다.
          평균가가 바뀌고 이미 걸어 둔 손절의 의미도 달라진다. */}
      {/* ── 안 들고 있는 방향의 청산은 누를 수 없다 ──
          롱만 있는데 '숏 청산'이 눌리면, 그 주문은 닫을 것이 없으므로
          거래소가 거부하거나 아무 일도 안 일어난다. 사용자는 눌렀는데
          아무 변화가 없는 화면을 보고 "청산이 안 된다"고 읽는다.
          **모르면(posAmt null) 막지 않는다** — 조회 실패가 청산을 막으면
          못 닫는 상황이 된다. 못 여는 것은 불편이고 못 닫는 것은 사고다. */}
      <button onClick={() => submit('BUY')}
        disabled={busy || noConn || (reduceOnly && holding === 'LONG')}
        title={noConn ? modeResolution.reason
          : reduceOnly && holding === 'LONG' ? '숏 포지션이 없습니다' : undefined}
        style={{ ...primaryBtn(C.up, busy || noConn || (reduceOnly && holding === 'LONG')),
                 minHeight: dense ? 42 : 46, display: 'flex',
                 alignItems: 'center', justifyContent: 'space-between', padding: '0 16px' }}>
        <span>{busy && side === 'BUY' ? '전송 중…'
          : noConn ? '계좌 선택 필요'
          : reduceOnly ? '롱 청산'
          : holding === 'LONG' ? '롱 추가'
          : holding === 'SHORT' ? '롱 반전'
          : '롱 진입'}</span>
        <span style={{ fontSize: FS.small, fontWeight: 600, opacity: 0.85 }}>
          {reduceOnly ? 'Sell' : `Buy · ${leverage}×`}
        </span>
      </button>

      <button onClick={() => submit('SELL')} disabled={busy || noConn}
        title={noConn ? modeResolution.reason : undefined}
        style={{ ...primaryBtn(C.down, busy || noConn), minHeight: dense ? 42 : 46, display: 'flex',
                 alignItems: 'center', justifyContent: 'space-between', padding: '0 16px' }}>
        <span>{busy && side === 'SELL' ? '전송 중…'
          : noConn ? '계좌 선택 필요'
          : reduceOnly ? '숏 청산'
          : holding === 'SHORT' ? '숏 추가'
          : holding === 'LONG' ? '숏 반전'
          : '숏 진입'}</span>
        <span style={{ fontSize: FS.small, fontWeight: 600, opacity: 0.85 }}>
          {reduceOnly ? 'Buy' : `Sell · ${leverage}×`}
        </span>
      </button>

      {/* 반대 방향을 누르려는 상태면 그 사실을 버튼 바로 아래에 적는다.
          라벨만으로는 '정리'가 청산인지 반전인지 알 수 없다 — 거래소
          설정(헤지/원웨이)에 따라 결과가 다르므로 단정하지 않고,
          **닫으려는 것이면 청산 탭을 쓰라고** 알려 준다. */}
      {!reduceOnly && holding && (
        <div style={{ color: C.warn, fontSize: FS.micro, lineHeight: 1.45, textAlign: 'center' }}>
          {/* 짧게. 예전 문구는 두 줄이라 좁은 화면에서 주문 버튼을 밀어냈고,
              길어서 아무도 안 읽었다. 말해야 하는 것은 한 가지뿐이다 —
              **반전은 닫는 게 아니다.** */}
          <b>반전</b>은 닫는 것이 아닙니다. 종료는 <b>청산</b> 탭.
        </div>
      )}
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
  // 주식은 거래소가 아니라 증권사를 타고, 장이 열려 있는지를 먼저 본다.
  if (marketType === 'STOCK') return <StockOrderPanel dense={props.dense}/>;
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

'use client';
// src/components/trading/OrderBookView.tsx
//
// **호가창 정본. 거래 화면 둘이 같은 판을 쓴다.**
//
// 무엇이 있었나
// ─────────────
// 호가창이 두 벌이었다. 터미널(`OrderPane.OrderBookPanel`)은 컴포넌트였고,
// `/`의 매매 탭(`TradingPage`)은 **같은 스트림을 import해 인라인으로 다시
// 그렸다.** 같은 판단이 두 곳에 있으면 언젠가 한쪽만 고쳐진다 — 이 저장소가
// 반복해서 겪은 고장이고, 실제로 두 판의 행이 수·정렬·깊이 막대 계산이
// 조금씩 달랐다.
//
// 무엇을 바꿨나
// ─────────────
// **판단과 그리기는 한 글자도 바꾸지 않았다.** 옮기기만 했다. 달라진 것은
// 종목을 어디서 받는가 하나다:
//
//   예전   `useTerminal()`에서 읽는다 → 터미널 밖에서는 쓸 수 없다
//   지금   `symbolId`를 받는다        → 어느 화면에서든 쓴다
//
// 터미널 쪽 `OrderBookPanel`은 이 컴포넌트를 감싸 문맥에서 종목을 읽어
// 넘기는 여섯 줄짜리가 됐다. 모바일(`MobileShell`)도 그 래퍼를 그대로 쓴다.
//
// 보존한 것
// ─────────
// Binance `depth20@100ms` 스트림 · 누적 깊이 막대 · 호가 잔량(imbalance) ·
// 줄을 눌러 가격 채우기 · 가운데 현재가도 눌린다 · `stale`(연결은 살아
// 있는데 데이터가 멈춘 상태) 표시 · 44px 터치 규칙을 사다리에서만 깨는 이유.
import React, { memo, useMemo } from 'react';
import { C, FS, NUM, fmtPrice, pnlColor } from '@/components/terminal/theme';
import { DataBadge } from '@/components/ui/DataBadge';
import { useBinanceStream, bookImbalance, type StreamMarket } from '@/lib/hooks/useBinanceStream';
import { orderBookLadder, orderBookLive } from '@/lib/trading/orderBook';

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

// ══ 호가판 ══════════════════════════════════════════════
export interface OrderBookViewProps {
  /** 어느 종목의 호가인가. **문맥에서 읽지 않고 받는다** */
  symbolId: string;
  rows?: number;
  onPickPrice?: (p: number) => void;
  /** 펀딩비·다음 정산 카운트다운을 위에 붙인다 */
  showFunding?: boolean;
  /** 좁은 열에 들어갈 때 — 글자와 여백을 줄인다 */
  dense?: boolean;
  /**
   * 스트림을 붙일 것인가. 기본은 붙인다.
   *
   * 호가창이 접혀 있는 화면은 `false`로 둔다 — 연결만 받아 두고 데이터가
   * 오지 않는 상태를 만들지 않기 위해서다(`useBinanceStream` 머리말 참고).
   */
  enabled?: boolean;
  /**
   * 어느 시장의 호가인가. 기본은 선물 — 기존 호출부가 전부 선물 화면이다.
   * 현물 화면이 이 값을 안 주면 **선물 호가를 현물 가격 옆에 놓게 된다.**
   */
  market?: StreamMarket;
  /**
   * 모바일 주문 시트용 압축 배치.
   *
   * 줄 수를 줄이는 것만으로는 부족하다. 실기에서 시트를 열면 호가가
   * 높이를 다 먹어서 **주문 버튼이 첫 화면 밖으로** 밀렸다. 그래서 줄
   * 높이를 줄이고 잔량 막대(파생값)를 뺀다.
   *
   * **데이터 배지는 남긴다** — 실시간인지 몇 ms 전 값인지는 주문 직전에
   * 가장 필요한 정보다. 좁다고 지울 것이 아니다.
   *
   * 데스크톱 호가의 정보량은 건드리지 않는다.
   */
  variant?: 'full' | 'compact';
}

export const OrderBookView = memo(function OrderBookView({
  symbolId, rows = 9, onPickPrice, showFunding, dense, enabled = true, market = 'USDM',
  variant = 'full',
}: OrderBookViewProps) {
  const compact = variant === 'compact';
  const stream = useBinanceStream(symbolId, enabled !== false, market);
  const live = orderBookLive(stream);
  const funding = useFunding(showFunding ? symbolId : '');
  const countdown = useCountdown(funding.nextAt);

  // **판단은 `lib/trading/orderBook`에 있다.** 두 화면이 같은 답을 쓰도록
  // 여기서 다시 계산하지 않는다.
  const ladder = useMemo(
    () => orderBookLadder({ asks: stream.asks, bids: stream.bids, rows, lastPrice: stream.lastPrice }),
    [stream.asks, stream.bids, stream.lastPrice, rows]);
  const { asks, bids, maxQty, mid } = ladder;
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
  const rowH = compact ? 15 : dense ? 21 : 24;
  const Row = ({ p, q, buy }: { p: number; q: number; buy: boolean }) => (
    <button
      // 스크린샷 증거가 "호가가 **몇 줄** 실제로 그려졌는가"를 셀 수 있게
      // 한다. 판이 보인다는 것과 값이 들어왔다는 것은 다른 사실이다.
      data-book-row={buy ? 'bid' : 'ask'}
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
    /* **flexShrink:0이 없으면 이 칸이 0이 된다.**
       아래 주문폼이 `minHeight:100%`로 열 전체를 요구하면, 세로 flex에서
       기본 shrink가 1인 이 칸이 0까지 눌린다. 그런데 자식들은 계속 그려져서
       (overflow를 자르지 않으므로) 주문폼 위로 흘러넘쳤다 —
       "호가를 받아오는 중"이 배율·청산거리 글자와 겹친 원인이 이것이다.
       높이를 0으로 만들면서 내용을 지우지 않는 것이 가장 나쁜 조합이다. */
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flexShrink: 0 }}>
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
        padding: compact ? '2px 6px 2px' : dense ? '6px 8px 4px' : '7px 12px 5px',
        fontSize: FS.micro, color: C.faint,
        // 한 화면 배치의 호가 칸은 122px이다. 이 줄이 접히면 그만큼
        // 매도 3줄이 아래로 밀려 나간다 — 접지 말고 한 줄로 둔다.
        ...(compact ? { whiteSpace: 'nowrap' as const, gap: 4, minWidth: 0 } : null),
      }}>
        <span style={{ flexShrink: 0 }}>가격</span>
        {/* 한 화면 배치의 호가 칸은 122px이다. 그대로 두면 이 배지가
            `수량` 글자와 겹쳐 찍혔다(320px 실기 스샷). **줄이는 것은 배지
            쪽이다** — 칸 이름이 무엇인지는 겹쳐서는 안 되고, 배지는 앞이
            신호(● 실시간/멈춤)라 꼬리가 잘려도 뜻이 남는다. 전체 문구는
            `title`에 그대로 있다. */}
        <span style={{
          flex: 1, minWidth: 0, overflow: 'hidden',
          display: 'flex', justifyContent: 'center',
        }}>
          <DataBadge compact source={{
            kind: live ? 'REALTIME' : 'UNAVAILABLE',
            origin: dense ? '' : 'Binance', asOf: stream.depthAt, expectedIntervalMs: 100,
          }}/>
        </span>
        <span style={{ flexShrink: 0 }}>수량</span>
      </div>

      {ladder.empty ? (
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
              padding: compact ? '2px 6px' : dense ? '6px 8px' : '7px 12px',
              margin: compact ? '1px 0' : '2px 0',
              border: 'none', minHeight: 0,
              borderTop: `1px solid ${C.hair}`, borderBottom: `1px solid ${C.hair}`,
              cursor: mid != null && onPickPrice ? 'pointer' : 'default',
            }}>
            <span style={{
              ...NUM, color: pnlColor(stream.changePct),
              fontSize: compact ? 13 : dense ? 15 : 19, fontWeight: 700,
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

      {/* 잔량 막대는 호가에서 **계산한 값**이다. 좁은 시트에서는 원본(호가
          줄)을 남기고 파생값을 뺀다 — 주문 버튼이 화면 밖으로 밀리는 것보다
          낫다. 데스크톱에서는 그대로 보인다. */}
      {imbalance != null && !compact && (
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

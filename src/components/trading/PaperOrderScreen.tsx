// src/components/trading/PaperOrderScreen.tsx
//
// **주문 화면의 문지기.** 어느 모드로, 어느 경로로 갈지 여기서 정한다.
//
// 두 갈래가 있고 서로 독립이다
// ────────────────────────────
//   경로   현물 매도인가(`routeFor`)      → 매도 화면 / 매수 화면
//   밀도   간편인가 프로인가(`useUiLevel`) → 어떻게 그릴 것인가
//
// 둘을 한 조건문에 섞지 않는다. 섞으면 "프로 모드에서만 현물 매도가
// 공매도로 나간다" 같은 조합이 생긴다.
//
// ★ 이 파일이 **유일한** 주문 화면 host다 (Phase UI-IA)
// ──────────────────────────────────────────────────────
// 예전에는 프로를 누르면 원스크린 거래 화면(`TradingWorkspace`)으로 차 냈다.
// 차트·호가·주문·포지션이 한 화면에 들어간 그 배치는 이제 없다 — 모바일에서
// 차트가 96px까지 밀리고 주문 버튼이 슬라이더를 덮던 배치다.
//
// 지금은 밀도만 갈린다:
//   간편  BeginnerBuyScreen / BeginnerSellScreen
//   프로  ProOrderPanel
//
// ★★ **두 밀도가 같은 훅 인스턴스를 받는다.**
//
//   `form`과 `sell`은 밀도 분기보다 **위에서** 한 번 만들어지고, 아래 두
//   갈래는 그것을 그대로 넘겨받는다. 밀도가 판단을 바꾸지 않는다는 것을
//   주석으로 적는 대신 **구조로 만든 것**이다 — 훅을 갈래마다 만들면
//   언젠가 한쪽 인자만 바뀌고, 그때 "프로에서만 수량이 다르게 나가는"
//   고장이 난다.
//
// `uiLevel`은 두 훅에 **들어가지 않는다.** 아래를 보면 `form`/`sell`을 만드는
// 인자에 밀도가 한 번도 등장하지 않는다 — 그게 이 파일의 계약이다.

'use client';

import React, { useEffect } from 'react';
import { C, FS } from '@/components/terminal/theme';
import { usePaperTarget } from '@/lib/trading/usePaperTarget';
import { usePaperLedger } from '@/lib/trading/usePaperLedger';
import { useTradeForm } from '@/lib/trading/useTradeForm';
import { useSellForm } from '@/lib/trading/useSellForm';
import { useUiLevel } from '@/lib/ui/useUiLevel';
import { scopeForTarget } from '@/lib/trading/paperTarget';
import { paperOrderUiWiring } from '@/lib/trading/capability';
import { routeFor, openSideFor, type TradeContext } from '@/lib/trading/tradeContext';
import { BeginnerBuyScreen, LevelSwitch, type BuyUnit } from './BeginnerBuyScreen';
import { BeginnerSellScreen } from './BeginnerSellScreen';
import { SpotTradingScreen } from './markets/SpotTradingScreen';
import { UsdtFuturesTradingScreen } from './markets/UsdtFuturesTradingScreen';
import { CoinMFuturesTradingScreen } from './markets/CoinMFuturesTradingScreen';
import { StockTradingScreen } from './markets/StockTradingScreen';
import { tradingScreenForTab } from '@/lib/trading/tradingScreenRoute';
import { readMarketTab, type TradingMarketId } from '@/lib/trading/marketTabs';
import { instrumentForMarket } from '@/lib/trading/marketInstrument';
import { changeView } from '@/lib/markets/changeBasis';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';

export interface PaperOrderScreenProps {
  ctx: TradeContext;
  name?: string;
  auth?: string;
  onBack: () => void;
  /** 매수/매도가 끝나면 바깥 장부를 다시 읽게 한다 */
  onDone?: () => void;
  unit: BuyUnit;
  onUnit: (u: BuyUnit) => void;
}

export function PaperOrderScreen({
  ctx, name, auth, onBack, onDone, unit, onUnit,
}: PaperOrderScreenProps) {
  const [level, , toggleLevel] = useUiLevel();

  // ── 들고 온 종목이 **어느 시장의 것인가** ──
  //
  // 이 값이 종목 가용성의 출처다. 여기서 다른 시장으로 옮겨 적지 않는다 —
  // 옮기는 순간 그게 추측이다(`marketInstrument` 머리말).
  const entryTab = readMarketTab(ctx.market);
  // 탭 상태. **분기보다 위에서** 만든다 — 아래에서 만들면 밀도마다 다른
  // 탭 상태가 생긴다.
  const [marketTab, setMarketTab] = React.useState<TradingMarketId>(entryTab ?? 'SPOT');
  React.useEffect(() => { if (entryTab) setMarketTab(entryTab); }, [entryTab]);

  // ── 장부는 하나다 ──
  //
  // `challengeId`의 정본은 이 싱글턴이고, 모드를 바꿔도 같은 인스턴스를
  // 본다. 그래서 전환에서 챌린지 문맥이 **저절로** 유지된다 —
  // `TradeContext`에 challengeId를 넣지 않은 이유가 이것이다.
  const [target] = usePaperTarget();
  const ledger = usePaperLedger(target, !!auth);
  const scope = scopeForTarget(target);
  const stream = useBinanceStream(ctx.symbol, true, ctx.market);

  const route = routeFor(ctx);
  const wiring = paperOrderUiWiring(ctx.market);

  // ── 매수 경로의 판단 (한 번만 만든다) ──
  const form = useTradeForm({
    symbol: ctx.symbol,
    market: ctx.market,
    price: stream.lastPrice,
    target,
    availableBalance: ledger.available,
    availableUnknownReason: ledger.availableUnknownReason,
    canOrder: wiring.canOrder,
    blockedReason: wiring.canOrder ? null : wiring.reason,
    onSubmitted: onDone,
  });

  // ── 매도 경로의 판단 ──
  //
  // 간편·프로 **둘 다** 이것을 받는다. 밀도 분기보다 위에서 만들어지므로
  // 두 표현이 다른 매도를 보낼 방법이 없다.
  const sell = useSellForm({
    symbol: ctx.symbol,
    market: ctx.market,
    target,
    enabled: route === 'SELL_HOLDING',
    onSold: onDone,
  });

  // 진입 경로로 들어왔으면 방향을 문맥에서 가져온다. **현물 매도는 여기
  // 오지 않는다** — `routeFor`가 이미 다른 길로 보냈다.
  const openSide = openSideFor(ctx);
  useEffect(() => {
    if (openSide && form.side !== openSide) form.setSide(openSide);
    // 방향을 **고른 것으로 만들지는 않는다**(`chooseSide`가 아니다).
    // 사용자가 확인 버튼을 눌러야 `sideChosen`이 서고, 그때 주문이 나간다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSide]);

  const title = `${name || ctx.symbol} ${ctx.direction === 'BUY' ? '구매' : '판매'}`;

  // ══════════ 프로 ══════════
  //
  // ★ **여기서 훅을 다시 만들지 않는다.** 위에서 만든 `form`/`sell`을
  //   그대로 넘긴다. 간편 갈래가 받는 것과 **같은 인스턴스**다.
  //
  //   예전에는 이 자리에서 원스크린 거래 화면으로 차 냈다. 그 화면은
  //   차트·호가·주문·포지션을 한 번에 들고 있었고, 모바일에서 차트가
  //   96px까지 밀렸다. 이제 프로는 주문 화면 안에 머문다 — 차트를 보려면
  //   뒤로 나가면 종목 상세가 그대로 살아 있다.
  if (level === 'PRO') {
    // ★ 시장 탭이 화면을 정한다. **분기는 정본 한 곳뿐이다**
    //   (`tradingScreenRoute`). 여기서 `if (market === 'SPOT')`을 또 쓰면
    //   같은 판단이 두 곳에 생기고, 언젠가 COIN-M이 USDⓈ-M 화면을 받는다.
    const screen = tradingScreenForTab(marketTab);

    // ★ 시장 정체성과 종목 가용성은 **다른 것**이다.
    //
    //   탭은 넷 다 언제나 들어갈 수 있다. 그런데 그 시장의 종목이 있는지는
    //   별개이고, 없으면 **지어내지 않는다** — 이름이 같아 보여도 같은
    //   상품이라고 단정하지 않는다(`marketInstrument`).
    //
    //       REACHABLE != TRADABLE
    const avail = instrumentForMarket(marketTab, { symbol: ctx.symbol, market: entryTab });
    const change = changeView({
      market: ctx.market, price: stream.lastPrice, changePct: stream.changePct,
    });
    const common = {
      market: marketTab, onMarket: setMarketTab,
      instrument: avail.instrument, instrumentReason: avail.reason,
      name: avail.instrument ? name : undefined, scope,
      price: stream.lastPrice,
      changePct: change.pct, changeLabel: change.label,
      onBack, headerRight: <LevelSwitch to="간편" onClick={toggleLevel}/>,
    };
    return (
      <div data-testid="paper-order-screen" data-level="PRO" data-route={route || 'NONE'}
        data-market={marketTab} data-screen={screen}
        data-tradable={avail.tradable ? '1' : '0'}
        style={{ height: '100%', minHeight: 0, background: C.bg }}>
        {screen === 'SPOT_SCREEN' ? (
          <SpotTradingScreen {...common}
            form={form} sell={sell} ledger={ledger} canOrder={wiring.canOrder}/>
        ) : screen === 'USDM_SCREEN' ? (
          <UsdtFuturesTradingScreen {...common}
            form={form} sell={sell} ledger={ledger} auth={auth}
            markPrice={stream.markPrice} canOrder={wiring.canOrder}/>
        ) : screen === 'COINM_SCREEN' ? (
          <CoinMFuturesTradingScreen {...common} markPrice={stream.markPrice}/>
        ) : (
          <StockTradingScreen {...common}
            orderableCash={null} heldQty={null} avgCost={null}/>
        )}
      </div>
    );
  }

  // ══════════ 간편 ══════════
  if (route === 'SELL_HOLDING') {
    return (
      <div data-testid="paper-order-screen" data-level="BEGINNER" data-route="SELL_HOLDING"
        data-market={ctx.market} style={{ height: '100%', minHeight: 0 }}>
        <BeginnerSellScreen
          symbol={ctx.symbol} name={name} market={ctx.market}
          price={stream.lastPrice} scope={scope} sell={sell}
          onBack={onBack} onPro={toggleLevel}/>
      </div>
    );
  }

  return (
    <div data-testid="paper-order-screen" data-level="BEGINNER" data-route="OPEN_POSITION"
      data-market={ctx.market} style={{ height: '100%', minHeight: 0 }}>
      <BeginnerBuyScreen
        symbol={ctx.symbol} name={name} market={ctx.market}
        price={stream.lastPrice} availableBalance={ledger.available} scope={scope}
        form={form} unit={unit} onUnit={onUnit}
        onBack={onBack} onPro={toggleLevel}/>
    </div>
  );
}

/** 배선이 없을 때의 한 줄. **숨기지 않고 이유를 적는다** */
export function OrderUnavailable({ reason }: { reason: string }) {
  return (
    <div data-testid="order-unavailable"
      style={{ padding: 16, fontSize: FS.body, color: C.faint }}>{reason}</div>
  );
}

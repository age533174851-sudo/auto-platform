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
import {
  instrumentForMarket, instrumentFromCatalog, selectInstrument,
  EMPTY_SELECTION, type SelectedByMarket,
} from '@/lib/trading/marketInstrument';
import { activeIdentity, switchBlockedReason, switchLockState } from '@/lib/trading/tradeIdentity';
import { usePaperOrderReview } from '@/lib/trading/usePaperOrderReview';
import { PAPER_ORDER_TYPE_LABEL } from '@/lib/trading/paperOrderReview';
import { capability } from '@/lib/markets/marketType';
import { useInstrumentCatalog } from '@/lib/trading/useInstrumentCatalog';
import { InstrumentPicker } from './markets/InstrumentPicker';
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
  const [marketTab, setMarketTabRaw] = React.useState<TradingMarketId>(entryTab ?? 'SPOT');
  React.useEffect(() => { if (entryTab) setMarketTabRaw(entryTab); }, [entryTab]);

  // ── 시장마다 고른 종목을 **따로** 기억한다 ──
  //
  // 현물에서 보던 종목과 선물에서 보던 종목은 다른 것이다. 한 칸에 담으면
  // 탭을 옮길 때마다 심볼이 따라다니고, 그게 곧 "이름이 같으니 같은 상품"
  // 이라는 추측이 된다. `selectInstrument`가 다른 시장 종목의 저장을 막는다.
  const [selected, setSelected] = React.useState<SelectedByMarket>(EMPTY_SELECTION);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  // ★ **활성 정체성** — 화면·시세·판정·능력표가 전부 이것 하나를 본다.
  //
  //   예전에는 이 자리에 `ctx.symbol`/`ctx.market`이 들어가 있었다. 시장
  //   탭이 잠겨 있던 동안에는 드러나지 않았지만, 종목 선택을 열면 화면은
  //   USDⓈ-M ETHUSDT를 보여주면서 주문은 현물 BTCUSDT로 나가게 된다.
  const entry = React.useMemo(
    () => (entryTab && ctx.symbol ? { symbol: ctx.symbol, market: entryTab } : null),
    [entryTab, ctx.symbol]);
  const avail = instrumentForMarket(marketTab, entry, selected);
  const active = activeIdentity(marketTab, avail.instrument);

  // 활성 시장/종목. **없으면 조회도 판정도 하지 않는다** — 빈 심볼로
  // 스트림을 열면 연결만 받아 두고 값이 오지 않는 상태가 된다.
  const activeSymbol = active?.symbol ?? '';
  const activeMarket: TradingMarketId = marketTab;
  // 모의 장부가 아는 시장 말인가. COIN-M·주식은 여기서 걸러진다.
  const paperMarket = activeMarket === 'SPOT' ? 'SPOT' : 'USDM';

  // ── 장부는 하나다 ──
  //
  // `challengeId`의 정본은 이 싱글턴이고, 모드를 바꿔도 같은 인스턴스를
  // 본다. 그래서 전환에서 챌린지 문맥이 **저절로** 유지된다 —
  // `TradeContext`에 challengeId를 넣지 않은 이유가 이것이다.
  const [target] = usePaperTarget();
  const ledger = usePaperLedger(target, !!auth);
  const scope = scopeForTarget(target);
  // ★ 시세도 활성 정체성에서 온다. 종목이 없으면 **연결하지 않는다**.
  const stream = useBinanceStream(activeSymbol, !!activeSymbol, paperMarket);

  const route = routeFor(ctx);
  // 능력표도 활성 시장이다. COIN-M·주식은 `UNSUPPORTED`가 돌아온다.
  const wiring = paperOrderUiWiring(
    activeMarket === 'SPOT' ? 'SPOT' : activeMarket === 'USDM' ? 'USDM' : activeMarket);

  // ── 매수 경로의 판단 (한 번만 만든다) ──
  const form = useTradeForm({
    // ★ 활성 정체성. 화면 헤더와 **같은 값**이어야 한다.
    symbol: activeSymbol,
    market: paperMarket,
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
    symbol: activeSymbol,
    market: paperMarket,
    target,
    // 현물 매도는 현물 화면에서만 뜻이 있다
    enabled: route === 'SELL_HOLDING' && activeMarket === 'SPOT' && !!activeSymbol,
    onSold: onDone,
  });

  // 이 시장의 상장 목록. 목록 권위가 없는 시장은 `CLOSED`로 돌아온다.
  // 열려 있을 때만 받아 온다 — 닫힌 시장에 조회를 보내지 않는다.
  const catalog = useInstrumentCatalog(marketTab, level === 'PRO');

  // ── ★ 주문이 날아가는 중에는 시장·종목을 바꾸지 않는다 ──
  //
  //   BTC 주문을 보낸 뒤 응답이 오기 전에 ETH로 바꾸면, BTC의 결과
  //   메시지가 ETH 화면에 뜬다. 사용자는 ETH가 체결된 줄 안다.
  const orderInFlight = form.busy || sell.busy;

  // ── ★ USDⓈ-M 진입/청산 — **정본은 여기 하나다** ──
  //
  //   예전에는 이 상태가 `UsdtFuturesTradingScreen` 안의 지역 상태였고,
  //   확인 창을 만드는 이 자리에서는 값을 받을 수 없어 `intentOpen: true`를
  //   박아 두었다. 그래서 단위시험은 청산 탭을 막는데 **제품의 전이는 그
  //   조건을 한 번도 받지 못했다** — 시험은 안전한데 배선이 안전조건을 못
  //   받는 구멍이다. 화면 쪽 버튼이 우연히 막고 있었을 뿐이다.
  //
  //   그래서 상태를 올린다. 화면은 `intent` · `onIntent`를 받아 그리기만
  //   하고, 판정(CTA · 확인 창)은 전부 이 하나를 본다.
  const [usdmIntent, setUsdmIntent] = React.useState<'OPEN' | 'CLOSE'>('OPEN');
  const usdmIntentOpen = usdmIntent === 'OPEN';

  // ── ★ 주문 확인 시트 ──
  //
  //   `form`과 **같은 자리**에서 한 번 만든다. 화면 안에서 만들면 전환
  //   잠금이 그 상태를 볼 수 없고, 잠금 쪽에 사본을 두면 같은 판단이 두
  //   곳이 된다.
  //
  //   ★ 여기서 `ctaVerdict`를 다시 부르지 않는다. 예전에는 불렀고 입력이
  //     달랐다(`intentOpen: true` · `sameSide: true`) — 버튼은 꺼져 있는데
  //     창은 열릴 수 있는 두 번째 판정이었다. 이제 **실행 버튼이 받은
  //     판정을 `review.open(v.action)`으로 그대로 들고 온다.**
  const review = usePaperOrderReview({
    form,
    marketLabel: capability('USDT_FUTURES').label,
    sideLabel: form.side,
    // 주문 방식 글자를 화면이 지어내지 않는다 — 정본 상수다.
    orderTypeLabel: PAPER_ORDER_TYPE_LABEL,
    intentOpen: usdmIntentOpen,
  });

  // 확인 중과 보내는 중은 **다른 상태**다. 사유를 돌려쓰면 확인 중인데
  // "보내는 중입니다"가 뜨고, 사용자는 주문이 이미 나간 줄 안다.
  const lockState = switchLockState({
    inFlight: orderInFlight, reviewing: review.phase !== 'NONE',
  });
  const switchBlocked = switchBlockedReason(lockState);
  const switchLocked = lockState !== 'NONE';

  const setMarketTab = React.useCallback((m: TradingMarketId) => {
    if (switchLocked) return;
    setPickerOpen(false);
    setMarketTabRaw(m);
  }, [switchLocked]);

  const openPicker = React.useCallback(() => {
    if (switchLocked) return;
    setPickerOpen(true);
  }, [switchLocked]);

  const pickInstrument = React.useCallback((row: any) => {
    if (switchLocked) return;
    // 고른 줄을 **그대로** 담는다. 다듬거나 만들지 않는다.
    // 다른 시장의 줄이면 `selectInstrument`가 거부한다.
    setSelected(prev => selectInstrument(prev, marketTab, instrumentFromCatalog(row)));
    setPickerOpen(false);
  }, [marketTab, switchLocked]);

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

    // 가용성(`avail`)과 활성 정체성(`active`)은 훅보다 **위에서** 이미
    // 계산됐다. 여기서 다시 만들면 화면이 훅과 다른 종목을 볼 수 있다.
    const change = changeView({
      market: paperMarket, price: stream.lastPrice, changePct: stream.changePct,
    });
    const common = {
      market: marketTab, onMarket: setMarketTab,
      instrument: avail.instrument, instrumentReason: avail.reason,
      name: avail.instrument?.source === 'ENTRY' ? name : undefined, scope,
      price: stream.lastPrice,
      changePct: change.pct, changeLabel: change.label,
      onBack, headerRight: <LevelSwitch to="간편" onClick={toggleLevel}/>,
      // 종목 선택 — 목록 권위가 열린 시장에서만 뜻이 있다
      onPickInstrument: openPicker,
      switchBlockedReason: switchBlocked,
    };
    return (
      <div data-testid="paper-order-screen" data-level="PRO" data-route={route || 'NONE'}
        data-market={marketTab} data-screen={screen}
        data-tradable={avail.tradable ? '1' : '0'}
        data-active-symbol={active?.symbol ?? ''}
        data-form-symbol={form.symbol}
        data-form-market={form.market}
        data-in-flight={orderInFlight ? '1' : '0'}
        data-switch-lock={lockState}
        data-review-phase={review.phase}
        data-usdm-intent={usdmIntent}
        style={{ position: 'relative', height: '100%', minHeight: 0, background: C.bg }}>
        {screen === 'SPOT_SCREEN' ? (
          <SpotTradingScreen {...common}
            form={form} sell={sell} ledger={ledger} canOrder={wiring.canOrder}/>
        ) : screen === 'USDM_SCREEN' ? (
          <UsdtFuturesTradingScreen {...common}
            form={form} sell={sell} review={review} ledger={ledger} auth={auth}
            intent={usdmIntent} onIntent={setUsdmIntent}
            markPrice={stream.markPrice} canOrder={wiring.canOrder}/>
        ) : screen === 'COINM_SCREEN' ? (
          <CoinMFuturesTradingScreen {...common} markPrice={stream.markPrice}/>
        ) : (
          <StockTradingScreen {...common}
            orderableCash={null} heldQty={null} avgCost={null}/>
        )}
        <InstrumentPicker
          open={pickerOpen} market={marketTab} catalog={catalog}
          currentSymbol={active?.symbol ?? null}
          onPick={pickInstrument} onClose={() => setPickerOpen(false)}/>
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

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
// ★ 거래 화면을 여기서 다시 그리지 않는다
// ──────────────────────────────────────
// 프로 모드는 **원래 있던 정본 거래 화면**(`TradingWorkspace`)으로 넘긴다.
// 처음에는 이 파일이 그것을 직접 렌더했는데 `check-canonical-trading`이
// "정본 거래 화면을 렌더하는 파일이 2개"라고 빨개졌다. 그 규칙이 맞다 —
// host가 둘이면 두 판이 다른 props로 갈라진다.
//
// 그래서 **판단 코드는 한 벌, host는 화면마다 하나**다:
//   초보 매도  이 파일이 `useSellForm`을 만들어 `BeginnerSellScreen`에 준다
//   프로 매도  `TradingWorkspace`가 같은 훅으로 `ProSellPanel`에 준다
// 둘은 동시에 뜨지 않으므로 같은 매도가 두 요청이 될 수 없다.
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
import { BeginnerBuyScreen, Head, LevelSwitch, type BuyUnit } from './BeginnerBuyScreen';
import { BeginnerSellScreen } from './BeginnerSellScreen';
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
  /** 프로 모드에서 정본 거래 화면으로 넘긴다. 문맥을 들려 보낸다 */
  onOpenWorkspace?: (ctx: TradeContext) => void;
}

export function PaperOrderScreen({
  ctx, name, auth, onBack, onDone, unit, onUnit, onOpenWorkspace,
}: PaperOrderScreenProps) {
  const [level, , toggleLevel] = useUiLevel();

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
  // 초보 매도 화면이 받는 것이 이것이다. 프로 쪽은 정본 거래 화면
  // (`TradingWorkspace`)이 **같은 훅**으로 자기 것을 만든다 — 두 화면이
  // 동시에 떠 있지 않으므로 인스턴스가 겹치지 않고, 판단 코드는 한 벌이다.
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
  // ★ **여기서 거래 화면을 다시 그리지 않는다.**
  //
  //   처음에는 이 파일이 `TradingWorkspace`를 직접 렌더했다. 그랬더니
  //   `check-canonical-trading`이 빨개졌다 — "정본 거래 화면을 렌더하는
  //   파일이 2개입니다". 그 규칙이 맞다. 거래 화면 host가 둘이면 두 판이
  //   서로 다른 props로 갈라지고, 그게 이 저장소가 이름 붙인 2번 고장이다.
  //
  //   그래서 프로는 **원래 있던 정본 화면으로 넘긴다.** 매도 패널도 그
  //   화면 안으로 옮겼으므로(`TradingWorkspace`의 `workspace-sell`),
  //   프로 사용자는 차트·호가·매수·매도를 한 곳에서 다룬다.
  //
  //   넘길 때 문맥을 들려 보낸다 — 종목·시장·방향이 그대로 간다.
  if (level === 'PRO') {
    return (
      <div data-testid="paper-order-screen" data-level="PRO" data-route={route || 'NONE'}
        data-market={ctx.market}
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: C.bg }}>
        <Head title={title} sub={`${ctx.symbol} · ${ctx.market === 'USDM' ? 'Perpetual' : 'Spot'}`}
          onBack={onBack} right={<LevelSwitch to="간편" onClick={toggleLevel}/>}/>
        <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', padding: 24 }}>
          <div style={{ display: 'grid', gap: 12, justifyItems: 'center', textAlign: 'center' }}>
            <div style={{ fontSize: FS.body, color: C.dim, lineHeight: 1.6 }}>
              프로 모드는 차트·호가·주문·보유를 한 화면에서 다룹니다.
            </div>
            <button type="button" data-testid="pro-open-workspace"
              onClick={() => { onOpenWorkspace?.(ctx); }}
              style={{
                padding: '12px 20px', borderRadius: 10, border: 'none',
                background: C.accent, color: '#fff', fontSize: FS.lead, fontWeight: 800,
                cursor: 'pointer',
              }}>{ctx.symbol} 거래 화면 열기</button>
            <button type="button" data-testid="pro-to-beginner" onClick={toggleLevel}
              style={{
                padding: '8px 14px', borderRadius: 8, border: `1px solid ${C.hair}`,
                background: C.raised, color: C.dim, fontSize: FS.body, cursor: 'pointer',
              }}>간편 모드로 주문하기</button>
          </div>
        </div>
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

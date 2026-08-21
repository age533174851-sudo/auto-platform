// src/lib/runtime/executionRuntime.ts
//
// **연구는 전략을 찾는 공장이고, 운용은 검증된 전략을 돌리는 공장이다.**
// 둘은 같이 돌 수 있지만 서로 의존해서는 안 된다.
//
// 전수조사에서 나온 것
// ───────────────────
// 이 저장소에는 실제 주문을 내는 경로가 **둘** 있었다.
//
//   서버   워커 → autotrade_schedules(DB) → my-original-v1 · daily-ladder · scalp
//          → executeOrder. 브라우저와 무관하게 돈다
//
//   브라우저 StrategyBuilder → **localStorage** → `<AutoTradeEngine/>`의
//          60초 setInterval → `/api/binance/futures/order`
//          (`confirmToken: 'LIVE_ORDER_CONFIRMED'`)
//
// 뒤엣것은 이 저장소가 스스로 금지해 둔 것 셋을 한꺼번에 어긴다:
//
//   · localStorage를 권威 있는 저장소로 쓴다
//   · 브라우저가 닫히면 멈추는 자동매매다
//   · 돈이 움직이는 판단이 UI 컴포넌트 안에 있다
//
// 그리고 사용자가 말한 증상이 정확히 여기서 나온다 — **화면을 켜 둬야
// 돈이 되는** 구조. 화면은 연구·설정을 위한 것이어야 하고, 운용은 그것과
// 무관하게 돌아야 한다.
//
// 무엇을 바꾸나
// ─────────────
// 지금 도는 것을 깨뜨리지 않으면서 두 가지를 한다:
//
//   1. **실제 돈은 서버 경로에서만.** 브라우저 경로는 LIVE 주문을 내지
//      않는다. 모의·테스트넷은 그대로 둔다 (그건 연구·연습이다)
//   2. 화면이 **어디서 도는지 사실대로** 말한다. "브라우저가 열려 있을
//      때만 돕니다"를 사용자가 알아야 탭을 닫아도 되는지 판단할 수 있다

export type RuntimeHome =
  /** 서버(워커·크론)가 돌린다. 브라우저를 닫아도 계속된다 */
  | 'SERVER'
  /** 브라우저 탭이 열려 있어야만 돈다 */
  | 'BROWSER_ONLY'
  /** 어디서 도는지 모른다. **'서버'로 치지 않는다** */
  | 'UNKNOWN';

export type MoneyMode = 'LIVE' | 'TESTNET' | 'PAPER' | 'UNKNOWN';

export interface RuntimeVerdict {
  home: RuntimeHome;
  /** 브라우저를 닫아도 계속 도는가 */
  survivesBrowserClose: boolean;
  /** 실제 돈 주문을 내도 되는가 */
  mayPlaceRealOrders: boolean;
  /** 화면에 그대로 쓸 한 줄 */
  label: string;
  reason: string;
}

/**
 * 이 전략이 어디서 도는가.
 *
 * **DB에 예약이 있으면 서버가 돌린다.** 없으면 브라우저 엔진이 도는
 * 것이고, 그건 탭을 닫는 순간 멈춘다.
 */
export function runtimeOf(i: {
  /** autotrade_schedules에 이 전략의 켜진 줄이 있는가. **못 읽었으면 null** */
  hasServerSchedule: boolean | null;
  /** 브라우저 엔진이 이 전략을 평가 대상으로 들고 있는가 */
  inBrowserEngine: boolean;
  mode: MoneyMode;
}): RuntimeVerdict {
  const live = i?.mode === 'LIVE';

  if (i?.hasServerSchedule == null) {
    // **모르는 것을 서버로 치지 않는다.** 서버로 치면 사용자는 탭을 닫고,
    // 그 순간 아무것도 안 돌게 된다.
    return {
      home: 'UNKNOWN', survivesBrowserClose: false,
      // 모르는 상태에서 실제 돈을 내보내지 않는다.
      mayPlaceRealOrders: false,
      label: '실행 위치 확인 불가',
      reason: '서버 예약을 읽지 못했습니다 — 브라우저를 닫아도 도는지 알 수 없습니다',
    };
  }

  if (i.hasServerSchedule) {
    return {
      home: 'SERVER', survivesBrowserClose: true, mayPlaceRealOrders: true,
      label: '서버에서 실행',
      reason: '서버 예약이 켜져 있습니다 — 브라우저를 닫아도 계속 돕니다',
    };
  }

  if (i.inBrowserEngine) {
    return {
      home: 'BROWSER_ONLY', survivesBrowserClose: false,
      // **실제 돈은 서버 경로에서만.** 탭이 닫히면 멈추는 것에 실제
      // 자금을 걸면, 진입은 됐는데 청산은 아무도 안 하는 상태가 된다.
      mayPlaceRealOrders: false,
      label: live ? '브라우저 전용 — 실거래 불가' : '브라우저가 열려 있을 때만',
      reason: live
        ? '이 전략은 브라우저 탭에서 돌고 있습니다 — 탭을 닫으면 진입한 포지션을 '
          + '아무도 청산하지 않습니다. 실거래는 서버 예약으로만 나갑니다'
        : '브라우저 탭이 열려 있는 동안만 평가합니다 — 탭을 닫으면 멈춥니다',
    };
  }

  return {
    home: 'UNKNOWN', survivesBrowserClose: false, mayPlaceRealOrders: false,
    label: '실행되지 않음',
    reason: '서버 예약도, 브라우저 평가 대상도 아닙니다 — 아무도 이 전략을 돌리지 않습니다',
  };
}

// ── 연구와 운용이 서로 붙어 있는가 ──

export interface IndependenceCheck {
  independent: boolean;
  /** 붙어 있는 지점들 */
  couplings: string[];
  reason: string;
}

/**
 * **연구를 꺼도 검증된 전략이 계속 도는가.**
 *
 * 연구 코드 한 곳이 깨졌다고 실제 돈 굴리는 엔진까지 멈추면 안 된다.
 * 이 함수는 그 독립성을 값으로 판정한다 — 화면이 이걸 읽고, CI가
 * 같은 것을 원문에서 확인한다(`check-research-isolation.mjs`).
 */
export function researchIndependence(i: {
  /** 서버 경로가 살아 있는가 (워커 + 예약) */
  serverPathAlive: boolean | null;
  /** 실행 전략이 브라우저 저장소(localStorage)에서 오는가 */
  strategiesFromBrowserStore: boolean;
  /** 실행이 연구 모듈을 읽는가 */
  executionReadsResearch: boolean;
}): IndependenceCheck {
  const couplings: string[] = [];
  if (i?.strategiesFromBrowserStore) {
    couplings.push('실행 전략 목록이 브라우저 저장소에서 옵니다 — 다른 기기·닫힌 탭에서는 존재하지 않습니다');
  }
  if (i?.executionReadsResearch) {
    couplings.push('실행 경로가 연구 모듈을 읽습니다 — 연구가 깨지면 매매도 멈춥니다');
  }
  if (i?.serverPathAlive === false) {
    couplings.push('서버 실행 경로가 살아 있지 않습니다 — 지금은 화면을 켜 둬야 돕니다');
  }
  if (i?.serverPathAlive == null) {
    // **모르는 것을 독립으로 치지 않는다.**
    return { independent: false, couplings: [...couplings, '서버 실행 경로 상태를 읽지 못했습니다'],
      reason: '연구와 운용이 분리돼 있는지 확인하지 못했습니다' };
  }

  if (couplings.length === 0) {
    return { independent: true, couplings: [],
      reason: '연구를 꺼도 승격된 전략은 서버에서 계속 돕니다' };
  }
  return {
    independent: false, couplings,
    reason: `연구와 운용이 ${couplings.length}곳에서 붙어 있습니다 — 연구가 멈추면 매매도 영향을 받습니다`,
  };
}

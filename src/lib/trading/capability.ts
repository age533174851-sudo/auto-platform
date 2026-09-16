// src/lib/trading/capability.ts
//
// **이 모의 경로가 실제로 무엇을 할 수 있는가 — 한 곳에서 답한다.**
//
// 왜 필요한가
// ───────────
// 거래소 화면을 흉내 내다 보면 버튼부터 만들게 된다. Limit · Reduce-Only ·
// 부분청산 칸을 그려 놓고 "나중에 붙이지" 하는 순간, 사용자는 **누를 수
// 있는 것을 지원되는 것으로 읽는다.** 눌러서 아무 일도 안 일어나거나
// 시장가로 대신 나가면, 그건 실패를 성공으로 적는 것과 같다.
//
// 그래서 지원 여부를 화면이 판단하지 않는다. 여기 표가 정본이고, 화면은
// 이 표를 읽어 **끄고 이유를 적는다.**
//
// 두 축을 섞지 않는다
// ───────────────────
// 자주 헷갈리는 것이 이것이다:
//
//   서버가 할 수 있는가   `/api/paper/order`가 그 값을 받아 장부에 적는가
//   화면이 붙어 있는가    사용자가 실제로 거기까지 도달할 수 있는가
//
// USDM 모의 주문이 정확히 그 경우다. **서버는 이미 할 수 있다** — 배율
// 1~100, 격리/교차, 손절 필수, 익절 선택까지 `paperPlan`·`paper_open_position`
// 이 전부 처리한다. 그런데 그 경로를 부르는 화면이 아직 없다(현물
// `SpotOrderPanel` 하나뿐).
//
// 두 축을 한 칸에 합치면 둘 중 하나가 거짓이 된다. "지원 안 함"으로 적으면
// 서버 능력을 부정하는 것이고, "지원함"으로 적으면 닿을 수 없는 길을
// 열어 둔 것이다. 그래서 **따로 적는다.**
import type { PaperMarket } from '../engine/paperPriceSource';
import { PAPER_MAX_LEVERAGE } from '../engine/paperPlan';

export type { PaperMarket };

/** 주문 화면이 물어볼 수 있는 것들. **여기 없는 기능은 없는 것이다.** */
export type OrderFeature =
  | 'SIDE_LONG'
  | 'SIDE_SHORT'
  | 'TYPE_MARKET'
  | 'TYPE_LIMIT'
  /** 사용자가 체결가를 정하는가 */
  | 'PRICE_INPUT'
  | 'QUANTITY_INPUT'
  /** 가용 잔고의 %로 수량을 채우는가 */
  | 'PERCENT_SIZING'
  | 'LEVERAGE'
  | 'MARGIN_MODE'
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'REDUCE_ONLY'
  | 'PARTIAL_CLOSE';

export const PAPER_ORDER_FEATURES: OrderFeature[] = [
  'SIDE_LONG', 'SIDE_SHORT', 'TYPE_MARKET', 'TYPE_LIMIT', 'PRICE_INPUT',
  'QUANTITY_INPUT', 'PERCENT_SIZING', 'LEVERAGE', 'MARGIN_MODE',
  'STOP_LOSS', 'TAKE_PROFIT', 'REDUCE_ONLY', 'PARTIAL_CLOSE',
];

export interface Supported {
  supported: true;
  /** 선택이 아니라 **반드시 있어야 하는가** (선물 손절이 그렇다) */
  required: boolean;
  note: string;
}

export interface Unsupported {
  supported: false;
  /** 화면에 그대로 보여 줄 한 줄. **"준비 중"처럼 얼버무리지 않는다** */
  reason: string;
}

export type Support = Supported | Unsupported;

const yes = (note: string, required = false): Supported => ({ supported: true, required, note });
const no = (reason: string): Unsupported => ({ supported: false, reason });

/** 못 쓰는가 — **타입 가드로 쓴다** (`strict: false`에서 판별이 안 좁혀진다) */
export function unsupported(s: Support): s is Unsupported {
  return !s || s.supported !== true;
}

// ══════════════ 서버가 할 수 있는가 ══════════════

/**
 * 이 시장에서 그 기능을 **서버 모의 경로가 처리하는가.**
 *
 * 근거는 전부 실제 코드다 — `paperPlan.buildPaperPlan`의 검증과
 * `/api/paper/order`가 읽는 본문 칸, `086`의 `paper_open_position` 인자.
 */
export function orderCapability(market: PaperMarket, feature: OrderFeature): Support {
  const spot = market === 'SPOT';

  switch (feature) {
    case 'SIDE_LONG':
      return yes('매수로 새 포지션을 엽니다');

    case 'SIDE_SHORT':
      // 현물 숏은 **없는 개념**이다. 파는 것은 가진 것을 파는 것이고,
      // 그건 새 포지션이 아니라 청산 경로로 간다.
      return spot
        ? no('현물은 숏으로 열 수 없습니다 — 매도는 보유분 청산입니다')
        : yes('매도로 새 포지션을 엽니다');

    case 'TYPE_MARKET':
      return yes('서버가 읽은 시세로 즉시 체결합니다');

    case 'TYPE_LIMIT':
      // 대기 주문을 담을 표가 없다. `paper_positions.status`는 open|closed
      // 둘뿐이고 가격·수량을 들고 기다리는 줄이 만들어지지 않는다.
      return no('모의 장부에 대기 주문이 없습니다 — 지정가는 아직 지원하지 않습니다');

    case 'PRICE_INPUT':
      // 화면이 보낸 가격을 쓰면 유리한 값을 넣어 장부를 만들 수 있다.
      return no('체결가는 서버가 읽습니다 — 화면이 정하면 성적표가 의미를 잃습니다');

    case 'QUANTITY_INPUT':
      return yes('수량으로 주문합니다');

    case 'PERCENT_SIZING':
      // 서버는 수량만 받는다. %는 화면이 **가용 잔고에서 수량으로 바꿔**
      // 보내는 편의이고, 그 가용 잔고의 정본은 서버다.
      return yes('가용 잔고의 비율을 수량으로 바꿔 보냅니다 (잔고 정본은 서버입니다)');

    case 'LEVERAGE':
      return spot
        ? no('현물에는 배율이 없습니다')
        : yes(`1~${PAPER_MAX_LEVERAGE}배`);

    case 'MARGIN_MODE':
      return spot
        ? no('현물에는 마진 모드가 없습니다')
        : yes('격리 · 교차');

    case 'STOP_LOSS':
      // 선물은 **필수**다. 규칙이 실전과 다르면 그 연습은 쓸모가 없다.
      return spot
        ? no('현물에는 손절 주문이 없습니다 — 실전 현물 경로도 받지 않습니다')
        : yes('손절가 또는 손절 %', true);

    case 'TAKE_PROFIT':
      return spot
        ? no('현물에는 익절 주문이 없습니다')
        : yes('선택입니다. 연 뒤에도 고칠 수 있습니다');

    case 'REDUCE_ONLY':
      return no('모의 주문에 감축 전용이 없습니다 — 보낼 칸이 없습니다');

    case 'PARTIAL_CLOSE':
      return no('모의 청산은 전량만 지원합니다');

    default:
      // **모르는 기능을 지원한다고 적지 않는다.**
      return no(`알 수 없는 기능입니다 (${String(feature)})`);
  }
}

/** 한 시장의 전체 표 — 화면이 한 번에 읽는다. */
export function orderCapabilities(market: PaperMarket): Record<OrderFeature, Support> {
  const out = {} as Record<OrderFeature, Support>;
  for (const f of PAPER_ORDER_FEATURES) out[f] = orderCapability(market, f);
  return out;
}

// ══════════════ 화면이 붙어 있는가 ══════════════

export type UiWiring =
  /** 사용자가 지금 여기서 모의 주문을 낼 수 있다 */
  | 'WIRED'
  /** **서버는 할 수 있는데 화면이 아직 없다.** 능력을 부정하지 않는다 */
  | 'SERVER_READY_UI_PENDING'
  /** 모의 장부가 아예 다루지 않는다 */
  | 'UNSUPPORTED';

export interface WiringState {
  state: UiWiring;
  /** 사용자에게 보여 줄 한 줄 */
  reason: string;
  /** 지금 주문을 낼 수 있는가 — **WIRED 하나만 참이다** */
  canOrder: boolean;
}

/**
 * 이 시장의 모의 주문 화면이 실제로 배선돼 있는가.
 *
 * **`SERVER_READY_UI_PENDING`을 주문 가능으로 읽지 않는다.** 서버 능력이
 * 있다는 것과 사용자가 거기 닿을 수 있다는 것은 다른 사실이고, 둘을
 * 합치면 닿을 수 없는 버튼이 활성화된다.
 */
export function paperOrderUiWiring(market: any): WiringState {
  if (market === 'SPOT') {
    return { state: 'WIRED', canOrder: true, reason: '현물 모의 주문을 낼 수 있습니다' };
  }
  if (market === 'USDM') {
    // 서버는 이미 할 수 있다(`paperPlan` · `paper_open_position`). 화면만
    // 없다. 후속 PR에서 **여기 한 줄만** 바뀌면 된다 — 장부·챌린지 선택·
    // 주문 권위를 다시 쓰지 않도록 경계를 이렇게 잡았다.
    return {
      state: 'SERVER_READY_UI_PENDING', canOrder: false,
      reason: '선물 모의 주문은 서버가 이미 지원하지만 주문 화면이 아직 연결되지 않았습니다',
    };
  }
  return {
    state: 'UNSUPPORTED', canOrder: false,
    reason: `모의 장부가 다루지 않는 시장입니다 (${String(market ?? '없음')})`,
  };
}

// ══════════════ 하단 독이 보여 줄 수 있는 것 ══════════════

export type DockTab = 'POSITIONS' | 'ORDERS' | 'HISTORY' | 'ASSETS';
export const DOCK_TABS: DockTab[] = ['POSITIONS', 'ORDERS', 'HISTORY', 'ASSETS'];

/**
 * 이 탭에 **정본 백엔드가 있는가.**
 *
 * 없는데 탭을 그리고 빈 표를 보여 주면 "주문이 없다"로 읽힌다. 그건
 * 확인된 사실이 아니라 **그런 개념이 없다**는 뜻이다 — 두 가지는 다르고,
 * 화면이 그 차이를 말해야 한다.
 */
export function dockTabSupport(tab: DockTab): Support {
  switch (tab) {
    case 'POSITIONS':
      return yes("paper_positions 중 status='open'");
    case 'HISTORY':
      return yes("paper_positions 중 status='closed'");
    case 'ASSETS':
      return yes('paper_accounts (챌린지 전용 계좌 포함)');
    case 'ORDERS':
      // 지어내지 않는다. 체결 이력을 '주문 내역'으로 둔갑시키면 사용자는
      // 내지 않은 주문을 본 것이 된다.
      return no('모의 장부에 대기 주문이 없습니다 — 낼 수 있는 주문은 즉시 체결됩니다');
    default:
      return no(`알 수 없는 탭입니다 (${String(tab)})`);
  }
}

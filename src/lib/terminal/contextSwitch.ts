// src/lib/terminal/contextSwitch.ts
//
// **종목이나 계좌를 바꿨을 때 무엇을 지우는가.**
//
// 실제로 이런 일이 난다
// ─────────────────────
// BTCUSDT에서 지정가 64,000을 적어 둔다. 마음이 바뀌어 ETHUSDT로 종목을
// 바꾼다. **가격 칸에는 여전히 64,000이 적혀 있다.**
//
// 그 상태에서 [롱 진입]을 누르면 ETH를 64,000에 사겠다는 지정가가 나간다.
// ETH는 2,500 근처다 — 이 주문은 지정가지만 **시장가처럼 즉시 체결된다.**
// 호가창 맨 위부터 쓸어 담으면서.
//
// 지정가를 넣었으니 안전하다고 믿는 자리에서 정확히 반대가 일어난다.
// 그리고 화면만 봐서는 아무 문제가 없다 — 숫자가 남아 있는 것이 눈에
// 띄지 않는다. 계좌를 바꾼 뒤에도 같은 일이 난다.
//
// 무엇을 남기고 무엇을 지우는가
// ─────────────────────────────
// 기준은 하나다: **그 값이 새 맥락에서도 같은 뜻인가.**
//
//   지정가 64,000        → 다른 종목에서는 다른 뜻이다. 지운다
//   수량 0.5 BTC         → 0.5 ETH는 전혀 다른 크기다. 지운다
//   수량 100 USDT        → 어느 종목이든 100달러다. **남긴다**
//   [청산] 탭            → 새 종목에는 포지션이 없을 수 있다. 지운다
//   배율 20배            → 지우지 않는다. 다만 거래소의 그 종목 설정과
//                          다를 수 있고, 그건 leverageSync가 주문 직전에
//                          맞춘다 (여기서 0으로 만들면 사용자가 매번
//                          다시 골라야 한다)
//
// 판정을 화면에 두지 않는 이유는 늘 같다: 화면에 두면 테스트가 안 붙고,
// 붙지 않으면 "종목을 바꿨을 때 가격 칸이 비는가"를 아무도 확인할 수 없다.
// 그리고 이 저장소에는 그 화면이 하나가 아니다 — 선물·현물·해외주식
// 주문판이 각각 있고, 규칙을 각자 쓰면 언젠가 한쪽만 고쳐진다.

export type SwitchScope =
  /** 바뀐 것이 없다 */
  | 'NONE'
  /** 종목만 바뀌었다 */
  | 'SYMBOL'
  /** 계좌(연결)나 모의/실계좌가 바뀌었다 — 종목까지 같이 본다 */
  | 'ACCOUNT';

export interface SwitchKey {
  symbol?: string | null;
  connectionId?: string | null;
  /** 모의 계좌인가 */
  paper?: boolean | null;
}

export interface SwitchVerdict {
  scope: SwitchScope;
  /** 무엇이 바뀌었는가 */
  changed: string[];
  /** 화면에 한 줄로 적을 말. 바뀐 게 없으면 빈 문자열 */
  notice: string;
}

const norm = (v: any): string => String(v ?? '').trim().toUpperCase();

/**
 * 두 맥락 사이에 무엇이 바뀌었는가.
 *
 * **첫 렌더는 전환이 아니다.** 이전 값이 아예 없으면(null/undefined)
 * NONE을 준다 — 그러지 않으면 화면이 열리자마자 사용자가 적어 둔 값을
 * 지우고, 새로고침 한 번에 입력이 사라진다.
 */
export function switchScope(
  prev: SwitchKey | null | undefined, next: SwitchKey | null | undefined,
): SwitchVerdict {
  if (!prev || !next) return { scope: 'NONE', changed: [], notice: '' };

  const changed: string[] = [];
  const symbolChanged = norm(prev.symbol) !== norm(next.symbol);
  // **모의↔실계좌도 계좌 전환이다.** 연결 id가 둘 다 비어 있어도 그렇다.
  const paperChanged = !!prev.paper !== !!next.paper;
  const connChanged = String(prev.connectionId ?? '') !== String(next.connectionId ?? '');

  if (symbolChanged) changed.push('symbol');
  if (connChanged) changed.push('connection');
  if (paperChanged) changed.push('paper');

  if (changed.length === 0) return { scope: 'NONE', changed, notice: '' };

  const scope: SwitchScope = (connChanged || paperChanged) ? 'ACCOUNT' : 'SYMBOL';
  return {
    scope, changed,
    notice: scope === 'ACCOUNT'
      ? '계좌가 바뀌어 주문 입력을 비웠습니다 — 앞 계좌 기준으로 적은 값입니다'
      : '종목이 바뀌어 가격과 수량을 비웠습니다 — 앞 종목의 가격입니다',
  };
}

/** 주문판이 들고 있는, 전환에 영향을 받는 칸들 */
export type FormField =
  /** 지정가 */
  | 'price'
  /** 수량 */
  | 'quantity'
  /** 손절가 */
  | 'stopPrice'
  /** 익절가 */
  | 'takeProfitPrice'
  /** [청산] 탭에 있는가 */
  | 'reduceOnly'
  /** 위험 기반 수량 선택 */
  | 'riskPick'
  /** 이 주문에 대한 서버 응답·경고 */
  | 'lastResult';

export interface ClearOptions {
  /**
   * 수량 단위. **'QUOTE'(USDT)면 수량을 남긴다** — 100달러는 어느
   * 종목에서든 100달러다. 'BASE'(코인 개수)면 지운다.
   */
  unit?: 'BASE' | 'QUOTE' | null;
}

/**
 * 이 전환에서 **비워야 하는** 칸.
 *
 * 계좌 전환은 종목 전환이 지우는 것을 모두 지우고, 거기에 계좌에 매인
 * 것을 더한다. 계좌를 바꿨는데 [청산]이 켜진 채로 남으면, 새 계좌에
 * 없는 포지션을 닫으려는 주문이 만들어진다.
 */
export function fieldsToClearOnSwitch(
  scope: SwitchScope, opts: ClearOptions = {},
): FormField[] {
  if (scope === 'NONE') return [];

  const out: FormField[] = ['price', 'stopPrice', 'takeProfitPrice', 'lastResult'];

  // USDT로 적은 금액은 종목이 바뀌어도 같은 뜻이다. 지우면 사용자가
  // 매번 다시 적어야 하고, 그건 안전이 아니라 성가심이다.
  if (opts.unit !== 'QUOTE') {
    out.push('quantity');
    out.push('riskPick');
  }

  // 계좌가 바뀌면 위험 기반 수량도 다시 계산해야 한다 — 그 계산의 재료가
  // 앞 계좌의 잔고다. 단위가 USDT여도 마찬가지다.
  if (scope === 'ACCOUNT') {
    out.push('reduceOnly');
    if (!out.includes('riskPick')) out.push('riskPick');
    if (!out.includes('quantity')) out.push('quantity');
  } else {
    // 종목 전환에서도 [청산]은 끈다 — 새 종목에 포지션이 있는지 아직
    // 모른다. 켜진 채로 두면 '청산'이라고 적힌 버튼이 신규 진입을 낸다.
    out.push('reduceOnly');
  }

  return out;
}

/**
 * 전환 뒤 **한 번만** 띄울 안내.
 *
 * 지운 것을 말 없이 지우면, 사용자는 자기가 적은 값이 어디 갔는지
 * 모른 채 다시 적는다. 반대로 매번 띄우면 그 줄을 안 읽게 된다 —
 * 실제로 비운 칸이 있을 때만 준다.
 */
export function clearNotice(v: SwitchVerdict, cleared: FormField[]): string {
  if (v.scope === 'NONE' || cleared.length === 0) return '';
  return v.notice;
}

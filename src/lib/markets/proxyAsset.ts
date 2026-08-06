// src/lib/markets/proxyAsset.ts
//
// **24시간 거래되지만 기초자산은 24시간이 아닌 것들.**
//
// 무엇이 문제인가
// ───────────────
// 금을 거래소 선물(CME)로 하면 거래시간이 명확하다 — 열려 있을 때만
// 주문이 나간다. 그런데 한투 계좌가 없어 **바이낸스의 금 연동 상품**
// (PAXG, 금 1온스를 담보로 한 토큰)으로 가면 사정이 다르다:
//
//   · PAXGUSDT는 코인이라 **주말에도 24시간 거래된다**
//   · 그런데 그 가격이 따라가는 **현물 금 시장은 주말에 닫혀 있다**
//
// 그래서 이런 일이 난다:
//
//   토요일 새벽 — 금 시장은 닫혀 있고 참조할 가격이 없다.
//   PAXG 호가는 얇아지고, 몇 개의 주문만으로 1~2%가 움직인다.
//   전략은 그걸 '돌파'로 읽고 진입한다.
//   월요일 아침 금 시장이 열리면 실제 금값 근처로 되돌아온다.
//   그 되돌림이 손절 폭보다 크면 갭으로 건너뛴다.
//
// 거래소는 열려 있으므로 `futuresHours`가 막지 않는다. 코인이니까
// 24시간이 맞다. **막을 수 없는 것이 아니라 아무도 안 보고 있는 것이다.**
//
// 이 파일이 하는 일
// ─────────────────
// "거래는 되는데 기초자산 시장이 닫혀 있다"를 **사실로 표시한다.**
// 막지는 않는다 — 금요일 밤에 금을 사는 것이 언제나 틀린 것은 아니다.
// 다만 그 자리에서 얇은 호가와 갭 위험을 지고 있다는 사실이 화면에
// 적혀야 하고, 전략이 그것을 알고 크기를 줄일 수 있어야 한다.

import { futuresPhase, type FuturesVenue } from './futuresHours';

export interface ProxyAsset {
  /** 거래소에서 실제로 거래되는 심볼 */
  symbol: string;
  /** 사람이 읽는 이름 */
  label: string;
  /** 이 가격이 따라가는 것 */
  underlying: string;
  /** 기초자산이 실제로 거래되는 시장. 그 시간표를 참조한다 */
  referenceVenue: FuturesVenue;
  /**
   * 기초자산 시장이 닫혔을 때 위험이 얼마나 커지는가.
   *
   * 화면 문구와 크기 조절에 쓴다. 숫자의 근거는 "얇은 호가에서 같은
   * 손절 폭이 더 자주 닿는다"이지 정밀한 측정이 아니다 — 그래서
   * 배수로 두고, 실제 데이터가 쌓이면 고친다.
   */
  offHoursRiskMultiplier: number;
  note: string;
}

/**
 * 알려진 대리 자산.
 *
 * **여기 없는 심볼은 대리 자산이 아니다.** 이름으로 추측하지 않는다 —
 * 'GOLD'가 들어간 코인이 전부 금을 따라가는 것은 아니고, 추측이 틀리면
 * 없는 시장의 시간표로 경고를 띄우게 된다.
 */
export const PROXY_ASSETS: ProxyAsset[] = [
  {
    symbol: 'PAXGUSDT',
    label: 'PAX Gold (금)',
    underlying: '현물 금 (XAU)',
    // 금 선물 시간표를 기준선으로 쓴다. 런던 현물장과 정확히 같지는
    // 않지만, "지금 금 시장이 도는가"의 근사로는 충분하다 — 우리가
    // 알고 싶은 것은 분 단위 개장 시각이 아니라 **주말인가**이다.
    referenceVenue: 'CME',
    offHoursRiskMultiplier: 2,
    note: '금 1온스를 담보로 한 토큰입니다. 거래는 24시간이지만 금 시장이 '
        + '닫히면 참조 가격이 없어 호가가 얇아집니다.',
  },
];

const BY_SYMBOL = new Map(PROXY_ASSETS.map(a => [a.symbol.toUpperCase(), a]));

export function proxyAssetOf(symbol: string | null | undefined): ProxyAsset | null {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s) return null;
  return BY_SYMBOL.get(s) ?? null;
}

export interface ProxyVerdict {
  /** 대리 자산인가. false면 나머지 값은 뜻이 없다 */
  isProxy: boolean;
  /** 기초자산 시장이 열려 있는가. 못 판단하면 null */
  underlyingOpen: boolean | null;
  /**
   * 지금 들어가도 되는가.
   *
   * **언제나 true다.** 이 판정은 막는 것이 아니라 알리는 것이다 —
   * 금요일 밤에 금을 사는 것이 언제나 틀린 것은 아니다. 다만 그 사실이
   * 화면에 적혀야 하고 크기가 줄어야 한다.
   */
  allowed: boolean;
  /** 이 상황에서 위험을 몇 배로 볼 것인가. 1이면 평소와 같다 */
  riskMultiplier: number;
  /** 화면에 그대로 띄울 한 줄. 평소에는 빈 문자열 */
  warning: string;
}

/**
 * 지금 이 심볼이 '기초자산 시장이 닫힌 채로' 거래되고 있는가.
 *
 * 순수 함수다 — 네트워크를 안 탄다.
 */
export function proxyCheck(symbol: string | null | undefined, nowMs: number): ProxyVerdict {
  const a = proxyAssetOf(symbol);
  if (!a) {
    return { isProxy: false, underlyingOpen: null, allowed: true, riskMultiplier: 1, warning: '' };
  }

  const ph = futuresPhase(a.referenceVenue, nowMs);
  if (ph.phase === 'UNKNOWN') {
    // 기초자산 시장이 도는지 **모른다.** 여기서 '열려 있다'로 기울면
    // 주말에도 경고가 안 뜬다. 모르면 조심하는 쪽으로 적는다.
    return {
      isProxy: true, underlyingOpen: null, allowed: true,
      riskMultiplier: a.offHoursRiskMultiplier,
      warning: `${a.underlying} 시장이 지금 도는지 확인하지 못했습니다 — `
             + '닫혀 있으면 호가가 얇아 손절이 더 자주 닿습니다',
    };
  }

  if (ph.canOrder) {
    return { isProxy: true, underlyingOpen: true, allowed: true, riskMultiplier: 1, warning: '' };
  }

  // 거래소는 열려 있는데 기초자산 시장은 닫혀 있다. 이 앱에서 이 상태를
  // 말해 주는 곳이 여기밖에 없다 — futuresHours는 코인을 24시간으로
  // 보므로 막지 않고, 막는 것도 맞지 않다.
  const weekend = ph.phase === 'WEEKEND';
  return {
    isProxy: true, underlyingOpen: false, allowed: true,
    riskMultiplier: a.offHoursRiskMultiplier,
    warning: `${a.label}은 지금 거래되지만 ${a.underlying} 시장은 닫혀 있습니다`
      + (weekend ? ' (주말)' : ' (정산 휴식)')
      + ` — 참조 가격이 없어 호가가 얇고, 열릴 때 갭이 날 수 있습니다.`
      + ` 위험을 ${a.offHoursRiskMultiplier}배로 보고 크기를 줄이세요.`,
  };
}

/**
 * 기초자산 시장이 닫혔을 때 줄여야 하는 크기.
 *
 * 위험을 n배로 본다는 것은 **같은 손실 한도를 지키려면 크기를 1/n로
 * 줄인다**는 뜻이다. 배율을 그대로 두고 크기만 키우면 한도를 정한
 * 의미가 없어지는 것과 같은 계산이다.
 *
 * 곱하지 않고 나눈다는 점이 중요하다 — 여기서 곱하면 위험한 시간에
 * 크기가 **커진다.**
 */
export function adjustedRiskBudget(baseBudget: number, v: ProxyVerdict): number {
  const b = Number(baseBudget);
  if (!Number.isFinite(b) || b <= 0) return 0;
  const m = Number(v?.riskMultiplier);
  if (!Number.isFinite(m) || m <= 1) return b;
  return b / m;
}

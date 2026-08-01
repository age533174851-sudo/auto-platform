// src/lib/risk/regimeGate.ts
//
// 시장 국면 필터 — **조건이 맞는 구간에서만 들어간다.**
//
// 왜 서버에 두는가
// ────────────────
// `regimeAllowsEntry`는 이미 있었지만 부르는 곳이 `AutoTradeEngine.tsx`
// **하나뿐**이었다. 브라우저 컴포넌트다. 즉 웹훅·크론·수동 주문 라우트는
// 국면을 보지 않고 나갔다 — 지금 실제로 주문이 나가는 경로가 전부 그쪽이다.
// 일일 손실 한도에서 겪은 것과 같은 모양이다.
//
// 왜 기본값이 '끄기'인가
// ──────────────────────
// 일일 손실 한도는 기본으로 켰다. 그건 전략의 우위를 건드리지 않고 피해
// 크기만 제한하기 때문이다. 국면 필터는 다르다 — **어떤 거래를 할지 자체를
// 바꾼다.** 사용자가 만들어 둔 전략의 신호를 조용히 거부하기 시작하면
// 그건 다른 전략이 된다. 그래서 켜는 것은 명시적 선택이어야 한다.
//
// 대신 꺼져 있어도 **지금 국면이 무엇인지는 항상 보여준다.** 필터를 켜지
// 않아도 "지금 고변동장"이라는 사실은 알아야 한다.

import { detectRegime, regimeAllowsEntry, type MarketRegime } from './regime';

/**
 * 필터 강도.
 *
 *  · off        — 판정만 하고 막지 않는다 (기본)
 *  · any        — 고변동장·역추세 진입을 막는다 (regimeAllowsEntry의 기본 규칙)
 *  · trend_only — 추세장에서만. 횡보장 차단
 *  · range_only — 횡보장에서만. 추세장 차단
 */
export type RegimeFilterMode = 'off' | 'any' | 'trend_only' | 'range_only';

export const REGIME_FILTER_MODES: RegimeFilterMode[] = ['off', 'any', 'trend_only', 'range_only'];

export type RegimeGateStatus = 'ok' | 'blocked' | 'unknown';

export interface RegimeGateVerdict {
  status: RegimeGateStatus;
  /** 신규 진입을 막아야 하는가. 필터가 꺼져 있으면 unknown도 막지 않는다 */
  blockEntries: boolean;
  reason: string;
  mode: RegimeFilterMode;
  /** 화면에 그대로 쓸 국면 요약. 판정 못 했으면 null */
  regime: MarketRegime | null;
}

/**
 * 지금 국면에서 이 방향으로 들어가도 되는가.
 *
 * `closes`는 일봉 종가다. 봉이 모자라면 판정하지 않는다 — `detectRegime`이
 * `dataOk:false`를 돌려주고, 그 상태를 '허용'으로 읽지 않는다.
 *
 * **필터가 꺼져 있으면 막지 않는다.** 그때 unknown은 "못 봤다"는 표시일
 * 뿐이고, 보지 않기로 한 검사가 주문을 막으면 그건 설정을 무시하는 것이다.
 */
export function judgeRegime(
  closes: number[] | null | undefined,
  side: 'LONG' | 'SHORT',
  mode: RegimeFilterMode,
): RegimeGateVerdict {
  const action: 'buy' | 'sell' = side === 'LONG' ? 'buy' : 'sell';

  if (!Array.isArray(closes) || closes.length === 0) {
    return {
      status: 'unknown', blockEntries: mode !== 'off', mode, regime: null,
      reason: mode === 'off'
        ? '시세를 받지 못해 국면을 표시할 수 없습니다'
        : '시세를 받지 못해 국면을 판정할 수 없습니다 — 필터가 켜져 있어 진입하지 않습니다',
    };
  }

  const regime = detectRegime(closes);

  if (!regime.dataOk) {
    return {
      status: 'unknown', blockEntries: mode !== 'off', mode, regime,
      reason: mode === 'off'
        ? regime.recommendation
        : `${regime.recommendation} — 필터가 켜져 있어 진입하지 않습니다`,
    };
  }

  if (mode === 'off') {
    // 판정은 했고 막지는 않는다. 국면은 그대로 알려준다.
    return { status: 'ok', blockEntries: false, mode, regime,
      reason: `${regime.label} (필터 꺼짐 — 참고용)` };
  }

  const marketFilter = mode === 'trend_only' ? 'trend_only'
    : mode === 'range_only' ? 'range_only' : 'any';
  const g = regimeAllowsEntry(regime, action, marketFilter);

  return {
    status: g.allowed ? 'ok' : 'blocked',
    blockEntries: !g.allowed,
    mode, regime,
    reason: g.reason,
  };
}

/**
 * 환경변수에서 필터 강도를 읽는다.
 *
 * 모르는 값은 **끈다.** 오타로 알 수 없는 값이 들어왔을 때 임의의 필터가
 * 켜지면, 사용자는 자기가 설정하지 않은 이유로 주문이 막히는 것을 보게 된다.
 * 다만 그 사실을 reason에 남긴다 — 조용히 무시하면 오타를 영원히 모른다.
 */
export function readRegimeFilter(
  env: (k: string) => string | undefined,
): { mode: RegimeFilterMode; note: string } {
  const raw = String(env('REGIME_FILTER') ?? '').trim().toLowerCase();
  if (!raw) return { mode: 'off', note: '' };
  if ((REGIME_FILTER_MODES as string[]).includes(raw)) {
    return { mode: raw as RegimeFilterMode, note: '' };
  }
  return {
    mode: 'off',
    note: `REGIME_FILTER='${raw}'는 알 수 없는 값이라 필터를 켜지 않았습니다 `
        + `(가능한 값: ${REGIME_FILTER_MODES.join(', ')})`,
  };
}

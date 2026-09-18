// src/lib/markets/intervalCapability.ts
//
// **어떤 봉 주기를 실제로 줄 수 있는가 — 한 곳에서 답한다.**
//
// 왜 필요한가
// ───────────
// 화면에 `1초 · 틱 · 1분 … 월 · 년` 버튼을 늘어놓는 것은 쉽다. 그런데
// 그중 실제로 데이터가 오는 것은 다섯 개뿐이었다. 나머지를 눌러도
// **오류가 나지 않는다** — 요청이 400으로 막히거나, 막히지 않으면 화면이
// 빈 차트를 그리고 사용자는 "이 종목은 거래가 없었나 보다"로 읽는다.
//
// 없는 주기를 누를 수 있게 두는 것은 그 자체로 값을 지어내는 것과 같다.
// 그래서 **버튼을 만들기 전에 능력을 묻는다.**
//
// 세 가지 상태
// ────────────
//   SUPPORTED                   지금 이 경로로 봉이 온다
//   REQUIRES_SOURCE_OR_AGGREGATION
//                               venue에는 있지만 우리 경로가 아직 안 잇거나,
//                               짧은 봉을 합쳐야 한다. **아직 못 준다**
//   UNSUPPORTED                 출처 자체가 없다 (체결 스트림이 필요하다든지)
//
// 뒤 둘은 화면에서 **누를 수 있는 버튼으로 그리지 않는다.** 왜 못 주는지는
// `reason`에 적혀 있으므로 화면이 그대로 보여 줄 수 있다.

export type IntervalSupport =
  | 'SUPPORTED'
  | 'REQUIRES_SOURCE_OR_AGGREGATION'
  | 'UNSUPPORTED';

export interface IntervalCapability {
  /** 화면과 요청이 함께 쓰는 값 */
  id: string;
  /** 사람이 읽을 이름 */
  label: string;
  support: IntervalSupport;
  /** 왜 못 주는가. SUPPORTED면 null */
  reason: string | null;
}

/**
 * **이 표가 근거다.**
 *
 * `SUPPORTED` 다섯은 `/api/market/candles`의 화이트리스트와 같아야 한다 —
 * 시험이 그 둘을 대조한다. 한쪽만 늘리면 화면이 400을 받는 버튼을 그린다.
 *
 * `5m`·`1w`는 바이낸스에 있고 `intervalMs`도 파싱하지만 라우트가 아직
 * 받지 않는다. **venue가 준다는 것과 우리가 준다는 것은 다르다.**
 *
 * `1s`·`tick`은 다르다. 선물 klines에 `1s`가 없고, 틱은 봉이 아니라 체결
 * 하나하나다. 지금 우리가 받는 실시간 값은 최우선 호가의 **중간값**이라
 * 체결가가 아니다(`useBinanceStream.lastPriceKind`) — 그걸로 틱 차트를
 * 그리면 일어나지 않은 거래를 그리는 것이다.
 *
 * `month`·`year`는 `intervalMs`의 문법(`^(\d+)([mhdw])$`)에 아예 없다.
 * 달과 해는 길이가 일정하지 않아서 ms 하나로 잘리지 않는다 — 합치는
 * 규칙을 먼저 정해야 한다.
 */
export const INTERVAL_CAPABILITIES: IntervalCapability[] = [
  { id: '1s', label: '1초', support: 'UNSUPPORTED',
    reason: '체결 스트림이 없습니다 — 지금 받는 실시간 값은 호가 중간값이라 체결가가 아닙니다' },
  { id: 'tick', label: '틱', support: 'UNSUPPORTED',
    reason: '체결 단위 데이터가 없습니다 — 봉이 아니라 체결 하나하나가 필요합니다' },
  { id: '1m', label: '1분', support: 'SUPPORTED', reason: null },
  { id: '5m', label: '5분', support: 'REQUIRES_SOURCE_OR_AGGREGATION',
    reason: 'venue에는 있지만 봉 라우트가 아직 받지 않습니다' },
  { id: '15m', label: '15분', support: 'SUPPORTED', reason: null },
  { id: '1h', label: '1시간', support: 'SUPPORTED', reason: null },
  { id: '4h', label: '4시간', support: 'SUPPORTED', reason: null },
  { id: '1d', label: '일', support: 'SUPPORTED', reason: null },
  { id: '1w', label: '주', support: 'REQUIRES_SOURCE_OR_AGGREGATION',
    reason: 'venue에는 있지만 봉 라우트가 아직 받지 않습니다' },
  { id: 'month', label: '월', support: 'REQUIRES_SOURCE_OR_AGGREGATION',
    reason: '달은 길이가 일정하지 않아 합치는 규칙을 먼저 정해야 합니다' },
  { id: 'year', label: '년', support: 'REQUIRES_SOURCE_OR_AGGREGATION',
    reason: '해는 길이가 일정하지 않아 합치는 규칙을 먼저 정해야 합니다' },
];

/** 모르는 주기는 **지원하지 않는 것**이다. 통과시키지 않는다. */
export function intervalCapability(id: any): IntervalCapability {
  const key = String(id ?? '');
  const hit = INTERVAL_CAPABILITIES.find(c => c.id === key);
  if (hit) return hit;
  return {
    id: key, label: key || '(없음)', support: 'UNSUPPORTED',
    reason: '모르는 주기입니다',
  };
}

/** 지금 실제로 봉이 오는 주기만. 화면의 버튼은 여기서 나온다. */
export function supportedIntervals(): IntervalCapability[] {
  return INTERVAL_CAPABILITIES.filter(c => c.support === 'SUPPORTED');
}

/**
 * 이 주기를 **누를 수 있는 버튼으로 그려도 되는가.**
 *
 * `SUPPORTED`만 참이다. "곧 됩니다"를 눌리는 버튼으로 두면 사용자는
 * 눌러 보고 빈 차트를 본다 — 그건 거래가 없었다는 뜻으로 읽힌다.
 */
export function isIntervalUsable(id: any): boolean {
  return intervalCapability(id).support === 'SUPPORTED';
}

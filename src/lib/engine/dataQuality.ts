// src/lib/engine/dataQuality.ts
//
// 화면에 뜨는 값이 "어디서 왔고 얼마나 오래됐는지"를 규정한다.
//
// 왜 필요한가
// ───────────
// 호가창이 Math.random()으로 만든 숫자를 실시간처럼 보여주고 있었다.
// 화면만 보고는 구분할 방법이 없었고, 그걸 보고 슬리피지를 판단하면
// 그 판단 전체가 틀린 전제 위에 선다.
//
// 문제는 그 한 번의 버그가 아니라 **구조**다. 지금 이 화면에는
//   - 실시간 호가 (WebSocket, 100ms)
//   - 5초마다 REST로 받는 24시간 변동률
//   - 모의매매의 가상 체결가
//   - AI가 추정한 값
// 이 전부 같은 모양으로 섞여 있다. 같은 모양으로 보이면 사용자는
// 구분할 수 없고, 구분할 수 없으면 언젠가 반드시 잘못 읽는다.
//
// 설계 원칙
// ─────────
//  1. 출처를 모르면 실시간이 아니다. 기본값은 항상 안전한 쪽이다.
//  2. 나이는 **데이터 자신의 시각**으로 잰다. 렌더 시각이 아니다.
//  3. "없음"과 "오래됨"은 다른 상태다. 둘 다 "신선함"과 달라야 한다.
//  4. 모의·추정은 실시간과 **다른 모양**이어야 한다. 글자만 다르면
//     빠르게 훑을 때 구분되지 않는다.

/** 값의 성격. 이것이 색·모양을 정한다 */
export type DataKind =
  | 'REALTIME'     // 거래소에서 밀어주는 값 (WebSocket)
  | 'POLLED'       // 주기적으로 당겨오는 값 (REST) — 실시간이 아니다
  | 'DERIVED'      // 받은 값으로 우리가 계산한 값 (예: 호가 잔량 비율)
  | 'SIMULATED'    // 모의매매 — 거래소에 존재하지 않는 값
  | 'ESTIMATED'    // AI·모델 추정
  | 'UNAVAILABLE'; // 받지 못했다

/** 신선도 — 나이를 성격별 기준으로 판정한 결과 */
export type Freshness = 'FRESH' | 'LAGGING' | 'STALE' | 'NONE';

export interface DataSource {
  kind: DataKind;
  /** 'Binance' · 'Yahoo Finance' · '앱 내부' 등. 사용자가 읽을 이름 */
  origin: string;
  /** 'Mark Price' · '최우선 호가' 등 어떤 값인지 */
  label?: string;
  /** 이 값이 만들어진 시각(ms). 모르면 null */
  asOf: number | null;
  /**
   * 이 값이 정상적으로 갱신되는 주기(ms).
   * 100ms로 오는 값과 5초로 오는 값에 같은 기준을 적용하면 안 된다.
   */
  expectedIntervalMs?: number;
}

/**
 * 성격별 기본 갱신 주기. expectedIntervalMs를 안 주면 이걸 쓴다.
 * POLLED는 넉넉하게 잡는다 — 주기적으로 당겨오는 값은 원래 늦다.
 */
const DEFAULT_INTERVAL: Record<DataKind, number> = {
  REALTIME: 1_000,
  POLLED: 10_000,
  DERIVED: 1_000,
  SIMULATED: 60_000,
  ESTIMATED: 300_000,
  UNAVAILABLE: 0,
};

/** 주기의 몇 배까지 봐줄 것인가 */
const LAG_FACTOR = 3;    // 이 배수를 넘으면 '지연'
const STALE_FACTOR = 10; // 이 배수를 넘으면 '멈춤'

export interface Assessment {
  kind: DataKind;
  freshness: Freshness;
  /** 나이(ms). 모르면 null */
  ageMs: number | null;
  /** 화면에 그대로 쓸 수 있는 한 줄 */
  text: string;
  /**
   * 이 값을 근거로 실제 주문을 내도 되는가.
   * 모의·추정·멈춘 값은 false다. 판단은 호출자가 하지만 기준은 한 곳에 둔다.
   */
  tradeable: boolean;
}

/** 나이를 사람이 읽는 형태로. 밀리초 단위까지 보여주는 것은 1초 미만일 때뿐이다 */
export function formatAge(ms: number | null): string {
  if (ms === null) return '시각 미상';
  if (ms < 0) return '방금';
  if (ms < 1000) return `${Math.round(ms)}ms 전`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}초 전`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}분 전`;
  return `${Math.round(ms / 3_600_000)}시간 전`;
}

const KIND_WORD: Record<DataKind, string> = {
  REALTIME: '실시간',
  POLLED: '주기 수신',
  DERIVED: '계산값',
  SIMULATED: '모의',
  ESTIMATED: 'AI 추정',
  UNAVAILABLE: '수신 없음',
};

/**
 * 값의 성격과 나이를 판정한다.
 *
 * @param now 현재 시각. 테스트에서 고정할 수 있도록 인자로 받는다.
 */
export function assess(src: DataSource, now: number): Assessment {
  if (src.kind === 'UNAVAILABLE' || src.asOf === null) {
    return {
      kind: src.kind, freshness: 'NONE', ageMs: null,
      text: `${src.label ? src.label + ' · ' : ''}${src.origin} · ${KIND_WORD[src.kind]}`,
      tradeable: false,
    };
  }

  const ageMs = Math.max(0, now - src.asOf);
  const interval = src.expectedIntervalMs ?? DEFAULT_INTERVAL[src.kind];

  let freshness: Freshness;
  if (interval <= 0) freshness = 'NONE';
  else if (ageMs > interval * STALE_FACTOR) freshness = 'STALE';
  else if (ageMs > interval * LAG_FACTOR) freshness = 'LAGGING';
  else freshness = 'FRESH';

  // 모의·추정은 아무리 새것이어도 실전 판단 근거가 아니다.
  // 나이만 보고 '신선함'으로 넘어가면 그 구분이 사라진다.
  const realWorld = src.kind === 'REALTIME' || src.kind === 'POLLED' || src.kind === 'DERIVED';
  const tradeable = realWorld && freshness === 'FRESH';

  const parts = [
    src.label,
    src.origin,
    KIND_WORD[src.kind],
    formatAge(ageMs),
  ].filter(Boolean);

  return { kind: src.kind, freshness, ageMs, text: parts.join(' · '), tradeable };
}

/**
 * 배지 모양. 성격과 신선도를 **함께** 반영한다.
 *
 * 모의·추정에 별도의 shape을 주는 것이 핵심이다. 색만 다르면
 * 색약이거나 화면을 빠르게 훑을 때 구분되지 않는다.
 */
export type BadgeShape = 'dot' | 'ring' | 'dashed' | 'warning';
export type BadgeTone = 'good' | 'caution' | 'bad' | 'neutral';

export function badgeStyle(a: Assessment): { shape: BadgeShape; tone: BadgeTone } {
  if (a.kind === 'SIMULATED') return { shape: 'dashed', tone: 'neutral' };
  if (a.kind === 'ESTIMATED') return { shape: 'ring', tone: 'neutral' };
  if (a.kind === 'UNAVAILABLE' || a.freshness === 'NONE') return { shape: 'warning', tone: 'bad' };
  if (a.freshness === 'STALE') return { shape: 'warning', tone: 'bad' };
  if (a.freshness === 'LAGGING') return { shape: 'ring', tone: 'caution' };
  if (a.kind === 'POLLED') return { shape: 'ring', tone: 'good' };   // 실시간과 같은 점을 주지 않는다
  if (a.kind === 'DERIVED') return { shape: 'ring', tone: 'good' };
  return { shape: 'dot', tone: 'good' };
}

/**
 * 여러 값 중 가장 나쁜 상태를 고른다. 화면 상단에 하나만 띄울 때 쓴다.
 * "하나라도 문제면 문제"가 맞는 기본값이다.
 */
export function worst(list: Assessment[]): Assessment | null {
  if (!list.length) return null;
  const rank: Record<Freshness, number> = { FRESH: 0, LAGGING: 1, STALE: 2, NONE: 3 };
  return list.reduce((a, b) => (rank[b.freshness] > rank[a.freshness] ? b : a));
}

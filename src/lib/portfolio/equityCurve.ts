// src/lib/portfolio/equityCurve.ts
//
// **자산 그래프에서 제일 위험한 것은 선이 끊기는 게 아니라 이어지는 것이다.**
//
// 과거 총자산을 저장한 적이 없으면, 곡선을 그리는 방법은 하나뿐이다 —
// 현재 잔고에서 거래 내역을 거꾸로 빼면서 과거를 지어내는 것. 그러면:
//
//   · 입출금이 빠지면 곡선이 통째로 어긋난다. 어제 100만원을 넣었으면
//     그래프는 **"어제 100만원 벌었다"**고 그린다
//   · 수수료·펀딩을 못 되돌리면 조금씩 어긋나고, 오래된 구간일수록 더
//     어긋난다. 그런데 그래프는 아무렇지 않게 매끄럽다
//   · 못 되돌린 구간이 있어도 선은 이어진다. **틀렸다는 표시가 없다**
//
// 역산한 곡선은 "대충 맞는 그림"이 아니라 **틀렸는데 그럴듯한 그림**이고,
// 그걸 보고 사용자는 어느 전략이 언제 돈을 벌었는지 판단한다.
//
// 그래서 이 파일의 규칙
// ─────────────────────
//   1. **점이 없으면 선을 안 긋는다.** 빈 그래프는 실패가 아니라 사실이다
//   2. **구멍은 이어 붙이지 않는다.** 크론이 이틀 안 돌았으면 그 이틀은
//      비어 있어야 한다 — 양 끝을 직선으로 이으면 그 이틀 동안 자산이
//      매끄럽게 변한 것처럼 보인다
//   3. **환경을 섞지 않는다.** 실전·테스트넷·모의를 한 곡선에 그리면
//      그 그래프는 아무 뜻이 없다
//   4. **입금으로 오른 것을 수익으로 세지 않는다**

export type RangeId = '1D' | '7D' | '30D' | '90D' | 'YTD' | '1Y' | 'ALL';

export const RANGES: Array<{ id: RangeId; label: string }> = [
  { id: '1D', label: '1일' },
  { id: '7D', label: '7일' },
  { id: '30D', label: '30일' },
  { id: '90D', label: '90일' },
  { id: 'YTD', label: '올해' },
  { id: '1Y', label: '1년' },
  { id: 'ALL', label: '전체' },
];

export function rangeOf(v: any): RangeId {
  const s = String(v ?? '').trim().toUpperCase();
  return RANGES.some(r => r.id === s) ? (s as RangeId) : '30D';
}

const DAY = 86_400_000;

/**
 * 이 구간의 시작 시각.
 *
 * `ALL`은 시작이 없다(null) — 0으로 두면 1970년부터라는 뜻이 되고,
 * 그건 "전체"와 우연히 같아 보이지만 다른 말이다.
 */
export function rangeStartMs(range: RangeId, nowMs: number): number | null {
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return null;
  switch (range) {
    case '1D':  return now - DAY;
    case '7D':  return now - 7 * DAY;
    case '30D': return now - 30 * DAY;
    case '90D': return now - 90 * DAY;
    case '1Y':  return now - 365 * DAY;
    case 'YTD': return Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
    case 'ALL': return null;
  }
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ms(v: any): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

export interface Snapshot {
  takenAtMs: number;
  totalEquity: number | null;
  env?: string;
  realizedPnl?: number | null;
  unrealizedPnl?: number | null;
  deposit?: number | null;
  withdrawal?: number | null;
  transfer?: number | null;
  fees?: number | null;
  funding?: number | null;
  dividend?: number | null;
  interest?: number | null;
}

/** DB 행을 점으로. **못 읽은 칸을 0으로 채우지 않는다** */
export function snapshotFromRow(row: any): Snapshot | null {
  if (!row || typeof row !== 'object') return null;
  const at = ms(row.takenAtMs ?? row.taken_at);
  if (at === null) return null;
  return {
    takenAtMs: at,
    totalEquity: num(row.totalEquity ?? row.total_equity),
    env: String(row.env ?? '').trim().toUpperCase() || undefined,
    realizedPnl: num(row.realizedPnl ?? row.realized_pnl),
    unrealizedPnl: num(row.unrealizedPnl ?? row.unrealized_pnl),
    deposit: num(row.deposit),
    withdrawal: num(row.withdrawal),
    transfer: num(row.transfer),
    fees: num(row.fees),
    funding: num(row.funding),
    dividend: num(row.dividend),
    interest: num(row.interest),
  };
}

export interface CurveSegment {
  points: Array<{ atMs: number; equity: number }>;
}

export interface Curve {
  /**
   * 이어서 그려도 되는 구간들.
   *
   * **한 배열이 아니라 여러 배열이다.** 구멍이 있으면 거기서 끊는다 —
   * 양 끝을 이으면 그 구간 동안 자산이 매끄럽게 변한 것처럼 보인다.
   */
  segments: CurveSegment[];
  /** 그릴 점이 있는가 */
  hasData: boolean;
  /** 값을 못 읽어 뺀 점의 수 */
  droppedUnreadable: number;
  /** 구멍 수 */
  gaps: number;
  min: number | null;
  max: number | null;
  first: Snapshot | null;
  last: Snapshot | null;
  /** 화면에 적을 한 줄. 정상이면 빈 문자열 */
  note: string;
}

/**
 * 한 구간이 끊긴 것으로 볼 시간 간격.
 *
 * 하루에 한 번 찍는다고 보고, 이틀 넘게 비면 구멍으로 본다.
 */
export const GAP_MS = 2 * DAY;

/**
 * 점들을 곡선으로.
 *
 * **없는 점을 만들지 않는다.** 보간도, 역산도, 마지막 값 늘려 긋기도
 * 하지 않는다.
 */
export function curveOf(
  snapshots: Snapshot[] | null | undefined,
  range: RangeId,
  nowMs: number,
  env?: string,
): Curve {
  const empty: Curve = {
    segments: [], hasData: false, droppedUnreadable: 0, gaps: 0,
    min: null, max: null, first: null, last: null, note: '',
  };

  const all = Array.isArray(snapshots) ? snapshots : [];
  if (all.length === 0) {
    return { ...empty,
      note: '아직 기록된 자산 시점이 없습니다 — 그래프를 그리려면 그때그때 찍어 둔 값이'
        + ' 있어야 합니다. **지금 잔고로 과거를 되돌려 그리지 않습니다**:'
        + ' 입출금이 빠지면 넣은 날이 번 날로 그려지고, 그 그림은 틀렸는데 매끄럽습니다' };
  }

  // 환경이 섞이면 곡선이 뜻을 잃는다.
  const wanted = env ? String(env).trim().toUpperCase() : null;
  const inEnv = wanted ? all.filter(s => !s.env || s.env === wanted) : all;

  const startMs = rangeStartMs(range, nowMs);
  const inRange = inEnv
    .filter(s => Number.isFinite(s.takenAtMs) && (startMs === null || s.takenAtMs >= startMs))
    .sort((a, b) => a.takenAtMs - b.takenAtMs);

  if (inRange.length === 0) {
    return { ...empty,
      note: '이 기간에 기록된 시점이 없습니다 — 자산이 0이었다는 뜻이 아니라'
        + ' 그때 찍어 둔 값이 없다는 뜻입니다' };
  }

  const usable = inRange.filter(s => s.totalEquity !== null);
  const dropped = inRange.length - usable.length;

  if (usable.length === 0) {
    return { ...empty, droppedUnreadable: dropped,
      note: `이 기간의 시점 ${dropped}개는 모두 총자산을 읽지 못한 채 기록됐습니다 —`
        + ' 0으로 그리면 그 시각에 전액을 잃은 것처럼 보이므로 그리지 않습니다' };
  }

  // 구멍에서 끊는다.
  const segments: CurveSegment[] = [];
  let cur: Array<{ atMs: number; equity: number }> = [];
  let prevAt: number | null = null;
  let gaps = 0;

  for (const s of usable) {
    if (prevAt !== null && s.takenAtMs - prevAt > GAP_MS) {
      if (cur.length) segments.push({ points: cur });
      cur = [];
      gaps++;
    }
    cur.push({ atMs: s.takenAtMs, equity: s.totalEquity as number });
    prevAt = s.takenAtMs;
  }
  if (cur.length) segments.push({ points: cur });

  const values = usable.map(s => s.totalEquity as number);
  const notes: string[] = [];
  if (gaps > 0) {
    notes.push(`기록이 끊긴 구간이 ${gaps}곳 있어 선을 잇지 않았습니다 —`
      + ' 이으면 그 동안 자산이 매끄럽게 변한 것처럼 보입니다');
  }
  if (dropped > 0) {
    notes.push(`총자산을 읽지 못한 시점 ${dropped}개는 뺐습니다 (0으로 그리지 않습니다)`);
  }

  return {
    segments, hasData: true, droppedUnreadable: dropped, gaps,
    min: Math.min(...values), max: Math.max(...values),
    first: usable[0], last: usable[usable.length - 1],
    note: notes.join(' · '),
  };
}

// ── 그래프를 눌렀을 때 ────────────────────────────────────

export interface PointDetailRow {
  label: string;
  value: number | null;
  /** 읽었는가. false면 화면은 '확인 불가'로 그린다 */
  known: boolean;
}

export interface PointDetail {
  atMs: number;
  totalEquity: number | null;
  rows: PointDetailRow[];
  /** 이 시점의 매매손익 (입출금 제외). 못 쪼개면 null */
  tradingPnl: number | null;
  note: string;
}

/**
 * 한 시점을 눌렀을 때 보여 줄 것.
 *
 * **입금·출금을 손익 줄과 같은 자리에 두지 않는다.** 나란히 두면
 * 사용자는 다 더해서 "오늘 얼마 벌었나"로 읽는다.
 */
export function pointDetailOf(s: Snapshot | null | undefined): PointDetail {
  if (!s) {
    return { atMs: 0, totalEquity: null, rows: [], tradingPnl: null,
      note: '이 시점의 기록을 읽지 못했습니다' };
  }

  const row = (label: string, v: number | null | undefined): PointDetailRow =>
    ({ label, value: v ?? null, known: v !== null && v !== undefined });

  const rows: PointDetailRow[] = [
    row('실현손익', s.realizedPnl),
    row('미실현손익', s.unrealizedPnl),
    row('수수료', s.fees),
    row('펀딩', s.funding),
    row('배당', s.dividend),
    row('이자', s.interest),
    row('입금', s.deposit),
    row('출금', s.withdrawal),
    row('이체', s.transfer),
  ];

  // 매매손익은 실현+미실현−비용이다. **하나라도 모르면 내지 않는다** —
  // 모르는 값을 0으로 더하면 수익이 실제보다 좋게 나온다.
  const r = s.realizedPnl, u = s.unrealizedPnl, f = s.fees, fu = s.funding;
  const tradingPnl = [r, u, f, fu].every(v => v !== null && v !== undefined)
    ? (r as number) + (u as number) - (f as number) - (fu as number)
    : null;

  const flow = [s.deposit, s.withdrawal, s.transfer]
    .filter(v => v !== null && v !== undefined) as number[];
  const hadFlow = flow.some(v => v !== 0);

  return {
    atMs: s.takenAtMs,
    totalEquity: s.totalEquity,
    rows, tradingPnl,
    note: tradingPnl === null
      ? '항목을 다 읽지 못해 매매손익을 쪼개지 않았습니다 — 모르는 값을 0으로 더하면'
        + ' 수익이 실제보다 좋게 나옵니다'
      : hadFlow
        ? '이 시점에 입출금이 있었습니다 — 자산이 변한 것과 번 것은 다릅니다'
        : '',
  };
}

// ── 일별 손익 ─────────────────────────────────────────────

export interface DailyRow {
  /** YYYY-MM-DD (UTC) */
  day: string;
  atMs: number;
  /** 그날의 매매손익. 못 내면 null */
  pnl: number | null;
  /** 그날 자산 변화 (입출금 포함) */
  equityDelta: number | null;
  /** 입출금이 있었는가 */
  hadFlow: boolean;
  note: string;
}

function dayKey(atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 날짜별 손익 목록.
 *
 * **자산 차이를 손익이라고 적지 않는다.** 어제보다 100만원 늘었어도
 * 그게 입금이면 번 것은 0원이다. 그래서 자산 변화(`equityDelta`)와
 * 매매손익(`pnl`)을 따로 낸다.
 */
export function dailyRowsOf(snapshots: Snapshot[] | null | undefined): DailyRow[] {
  const all = (Array.isArray(snapshots) ? snapshots : [])
    .filter(s => s && Number.isFinite(s.takenAtMs))
    .sort((a, b) => a.takenAtMs - b.takenAtMs);
  if (all.length === 0) return [];

  // 하루의 마지막 점을 그날의 값으로 본다.
  const byDay = new Map<string, Snapshot>();
  for (const s of all) byDay.set(dayKey(s.takenAtMs), s);

  const days = [...byDay.keys()].sort();
  const out: DailyRow[] = [];

  for (let i = 0; i < days.length; i++) {
    const s = byDay.get(days[i])!;
    const prev = i > 0 ? byDay.get(days[i - 1])! : null;
    const d = pointDetailOf(s);

    const equityDelta = prev && s.totalEquity !== null && prev.totalEquity !== null
      ? s.totalEquity - prev.totalEquity
      : null;

    const flow = [s.deposit, s.withdrawal, s.transfer]
      .filter(v => v !== null && v !== undefined) as number[];
    const hadFlow = flow.some(v => v !== 0);

    out.push({
      day: days[i], atMs: s.takenAtMs,
      pnl: d.tradingPnl, equityDelta, hadFlow,
      note: d.tradingPnl === null
        ? '항목을 다 읽지 못해 손익을 내지 않았습니다'
        : hadFlow ? '입출금 포함 — 자산 변화와 손익이 다릅니다' : '',
    });
  }
  return out.reverse();   // 최근이 위
}

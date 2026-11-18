// ─────────────────────────────────────────────────────────────
// 봇별 **실제 측정된** 성과.
//
// 지어내지 않는다 — 이 파일은 `paper_positions`에 실재하는 세 칸만
// 읽는다: `strategy_id`(누구의 체결인가) · `realized_pnl`(수수료 후
// 순손익) · `margin`(그 거래에 실제로 넣은 증거금).
//
// 왜 서버가 세는가
// ────────────────
// `/api/paper/automation`은 체결을 `strategy_id`로 **걸러서 읽으면서
// 그 칸을 응답에서 빼고** 보냈다. 그래서 화면은 "이 손익이 어느 봇의
// 것인가"를 알 수 없었고, 봇 카드에 손익을 적을 방법이 없었다.
//
// 세 가지를 절대 하지 않는다
// ──────────────────────────
// ① **못 읽은 것을 0으로 적지 않는다.** 조회가 실패하면 `unreadable`
//    이고 손익은 `null`이다. 0은 "손익이 0이었다"는 뜻이라 거짓이다.
// ② **청산이 없으면 0이 아니라 없음이다.** 아직 닫힌 거래가 하나도
//    없는 봇의 손익은 `null`이다 — "±0"이라고 적으면 본전을 지킨 것처럼
//    보인다.
// ③ **수익률의 분모를 만들어 내지 않는다.** 증거금 합이 0이거나 못
//    읽었으면 `roiPct`는 `null`이다. 계좌 잔고를 분모로 빌려 쓰면 봇
//    여럿이 한 계좌를 쓰는 지금 구조에서 전부 틀린 값이 된다.
//
// 상한에 걸린 집계는 **총계라고 적지 않는다** (`partial`).
// ─────────────────────────────────────────────────────────────

/** 한 번에 읽을 체결 행 수 상한. 넘으면 `partial`로 적고 총계라 하지 않는다 */
export const PERF_ROW_CAP = 1000;

export interface PerfRow {
  strategy_id?: string | null;
  status?: string | null;
  realized_pnl?: number | string | null;
  margin?: number | string | null;
}

export interface BotPerf {
  /** 청산이 끝난 체결 수 */
  closed: number;
  /** 아직 들고 있는 체결 수 */
  open: number;
  /** 실현 손익 합(USDT). **못 읽었거나 청산이 없으면 null** */
  realizedPnl: number | null;
  /** 투입 증거금 합. 수익률의 분모 */
  marginSum: number | null;
  /** 증거금 대비 수익률(%). 분모가 없으면 null */
  roiPct: number | null;
  /** 청산됐는데 손익이 안 적힌 행 수. 0이 아니면 합이 불완전하다 */
  pnlMissing: number;
  /** 행 상한에 걸렸다 — 이 값은 총계가 아니다 */
  partial: boolean;
  /** 조회 자체가 실패했다. **"거래 없음"과 다르다** */
  unreadable: boolean;
}

const UNREADABLE: BotPerf = {
  closed: 0, open: 0, realizedPnl: null, marginSum: null, roiPct: null,
  pnlMissing: 0, partial: false, unreadable: true,
};

/** 숫자로 읽히는 것만 숫자다. 문자열 '12.3'은 Supabase NUMERIC이 흔히 주는 모양이다 */
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 닫힌 체결인가. 대소문자와 이름 흔들림을 여기 한 곳에서 흡수한다 */
export function isClosedStatus(s: unknown): boolean {
  return typeof s === 'string' && ['CLOSED', 'LIQUIDATED', 'STOPPED_OUT', 'TAKE_PROFIT']
    .includes(s.toUpperCase());
}

/** 들고 있는 체결인가 */
export function isOpenStatus(s: unknown): boolean {
  return typeof s === 'string' && ['OPEN', 'FILLED'].includes(s.toUpperCase());
}

/**
 * 봇별 성과표를 만든다.
 *
 * `botIds`에 있는 봇은 **체결이 하나도 없어도 칸이 생긴다** — 칸이 없는
 * 것과 "거래가 없는 것"은 화면에서 다르게 보여야 하기 때문이다.
 */
export function summarizeBotPerf(input: {
  rows: PerfRow[] | null | undefined;
  botIds: string[];
  /** 조회가 실패했는가. true면 전부 `unreadable` */
  unreadable?: boolean;
}): Record<string, BotPerf> {
  const { rows, botIds, unreadable } = input;
  const out: Record<string, BotPerf> = {};
  if (unreadable || !Array.isArray(rows)) {
    for (const id of botIds) out[id] = { ...UNREADABLE };
    return out;
  }
  const partial = rows.length >= PERF_ROW_CAP;
  for (const id of botIds) {
    out[id] = { closed: 0, open: 0, realizedPnl: null, marginSum: null,
      roiPct: null, pnlMissing: 0, partial, unreadable: false };
  }
  // 합은 봇별로 따로 든다. **셋을 절대 섞지 않는다**는 규칙이 여기서는
  // "봇의 장부를 섞지 않는다"로 나타난다.
  const pnl: Record<string, number> = {};
  const mgn: Record<string, number> = {};
  for (const r of rows) {
    const id = typeof r?.strategy_id === 'string' ? r.strategy_id : null;
    if (id == null || out[id] == null) continue;   // 모르는 봇의 행은 아무 봇에도 더하지 않는다
    const b = out[id];
    if (isClosedStatus(r.status)) {
      b.closed += 1;
      const p = num(r.realized_pnl);
      if (p == null) { b.pnlMissing += 1; }
      else { pnl[id] = (pnl[id] ?? 0) + p; }
      const m = num(r.margin);
      if (m != null && m > 0) mgn[id] = (mgn[id] ?? 0) + m;
    } else if (isOpenStatus(r.status)) {
      b.open += 1;
    }
  }
  for (const id of botIds) {
    const b = out[id];
    // 더한 행이 하나도 없으면 **0이 아니라 없음**이다.
    b.realizedPnl = pnl[id] == null ? null : pnl[id];
    b.marginSum = mgn[id] == null ? null : mgn[id];
    b.roiPct = (b.realizedPnl != null && b.marginSum != null && b.marginSum > 0)
      ? (b.realizedPnl / b.marginSum) * 100
      : null;
  }
  return out;
}

// ── 화면에 적을 문장 ──
//
// **여기가 "가짜 수익률 금지"를 실제로 막는 자리다.** 화면이 직접
// `perf.realizedPnl ?? 0`처럼 적으면 규칙은 주석으로만 남는다.

export interface PerfView {
  /** 금액 한 줄. 데이터가 없으면 그 사실을 적는다 */
  amount: string;
  /** 수익률 한 줄. 분모가 없으면 null — 칸을 비운다 */
  rate: string | null;
  /** 덧붙일 단서 (미결제·미기록·부분집계). 없으면 null */
  note: string | null;
  /** 툴팁에 적을 한 줄 — 금액과 수익률을 함께 */
  detailTitle: string;
  /** 실제 측정된 수치인가. false면 색을 입히지 않는다 */
  measured: boolean;
  /** 이익인가 손실인가. measured가 false면 null */
  sign: 'up' | 'down' | 'flat' | null;
}

const fmt = (n: number, d = 2) =>
  `${n >= 0 ? '+' : '−'}${Math.abs(n).toLocaleString('en-US',
    { minimumFractionDigits: d, maximumFractionDigits: d })}`;

export function perfView(p: BotPerf | null | undefined): PerfView {
  const notes: string[] = [];
  if (p == null || p.unreadable) {
    return { amount: '확인 불가', rate: null, measured: false, sign: null,
      note: '성과를 읽지 못했습니다', detailTitle: '성과를 읽지 못했습니다' };
  }
  if (p.open > 0) notes.push(`미결제 ${p.open}건`);
  if (p.pnlMissing > 0) notes.push(`손익 미기록 ${p.pnlMissing}건`);
  if (p.partial) notes.push('최근 분만 집계');
  const note = notes.length ? notes.join(' · ') : null;
  // **청산이 없으면 0이 아니라 없음이다.**
  if (p.realizedPnl == null) {
    return { amount: '성과 데이터 없음', rate: null, measured: false, sign: null,
      note: note ?? (p.closed === 0 ? '청산된 거래 없음' : null),
      detailTitle: `청산 ${p.closed}건 · 미결제 ${p.open}건 — 실현 손익이 아직 없습니다` };
  }
  const v = p.realizedPnl;
  return {
    amount: `${fmt(v)} USDT`,
    // 분모를 빌려 오지 않는다. 없으면 칸이 빈다.
    rate: p.roiPct == null ? null : `${fmt(p.roiPct, 1)}%`,
    note,
    measured: true,
    sign: v > 0 ? 'up' : v < 0 ? 'down' : 'flat',
    detailTitle: `청산 ${p.closed}건 · 실현 ${fmt(v)} USDT`
      + (p.roiPct == null ? ' · 투입 증거금을 못 읽어 수익률 없음'
                          : ` · 투입 증거금 대비 ${fmt(p.roiPct, 1)}%`),
  };
}

// src/lib/signals/creatorIntake.ts
//
// **표에 있는 행 → 장부에 태울 신호.** 그 사이에서 값을 지어내지 않는다.
//
// 왜 이 파일이 따로 있는가
// ────────────────────────
// gateSignal(creatorEdge)은 "이 발언을 태울 수 있는가"를 본다. 그런데 그
// 함수는 이미 잘 만들어진 CreatorSignal을 받는다. 표에서 그 모양을 만드는
// 동안 **없는 값을 채우면** 그 뒤의 모든 검사가 무의미해진다 — 통과할
// 값을 만들어 놓고 통과시키는 것이기 때문이다.
//
// 여기서 가장 조심하는 것
// ───────────────────────
// `said_at`이 없을 때 `detected_at`으로 대신 채우고 싶어진다. 둘 다
// 시각이고, 대개 몇십 초 차이니까. **그러면 안 된다.**
//
// 방송은 늦게 나간다. 발언 시각과 감지 시각의 차이가 곧 지연이고, 지연은
// 이 시스템에서 성과를 가장 크게 가르는 값이다. 감지 시각을 발언 시각으로
// 쓰면 지연이 0초가 되고, 그 신호는 FAST 칸에 앉는다 — **성적이 가장 좋게
// 나오는 칸이다.** 모르는 것이 가장 좋은 칸을 채우면, 표는 "빨리 따라가면
// 돈이 된다"고 말하게 된다. 실제로 확인한 적 없는 사실이다.
//
// 검수를 안 거친 것은 태우지 않는다
// ─────────────────────────────────
// 파서가 뽑은 것을 그대로 판정에 넣으면, 재는 것이 그 사람의 성과가 아니라
// **우리 파서의 성과**가 된다. "여기서 롱도 가능하다"를 진입으로 읽은
// 신호가 섞여 들어가면 그 표는 아무것도 말하지 않는다.

import { gateSignal, type CreatorSignal, type UtteranceKind, type GateOptions } from './creatorEdge';
import type { MarketRegime } from './creatorLedger';

/** trader_signals 한 행 (필요한 것만) */
export interface SignalRow {
  id?: any;
  channel_id?: any;
  /** 화면에 쓸 채널 이름. 조인해서 넣어 준다 */
  creator?: any;
  symbol?: any;
  side?: any;
  action?: any;
  entry_price?: any;
  stop_loss?: any;
  take_profit?: any;
  /** 'confirmed' | 'likely' | 'uncertain' — 등급이다. 확신도 숫자가 아니다 */
  confidence?: any;
  /** 추출기 확신도 0~1 */
  extract_confidence?: any;
  utterance_kind?: any;
  /** **발언한 시각.** 없으면 null — detected_at으로 대신 채우지 않는다 */
  said_at?: any;
  detected_at?: any;
  review_status?: any;
  regime?: any;
  evidence?: any;
}

export interface IntakeResult {
  ok: boolean;
  signal: CreatorSignal | null;
  /** 발언 → 감지 지연(초). 둘 중 하나라도 없으면 null */
  delaySec: number | null;
  regime: MarketRegime;
  reason: string;
  /** 없어서 못 태운 항목 */
  missing: string[];
}

const num = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 시각 문자열 → epoch ms. 못 읽으면 null. **지금 시각으로 대신 채우지 않는다** */
export function msOf(v: any): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) && t > 0 ? t : null;
}

const KINDS: UtteranceKind[] = [
  'EXPLICIT_ENTRY', 'OPINION', 'LONG_TERM', 'RECAP', 'QUESTION', 'AD', 'JOKE', 'UNKNOWN',
];

/** 표의 문자열 → UtteranceKind. **모르는 값은 UNKNOWN이다** */
export function kindOf(v: any): UtteranceKind {
  const s = String(v ?? '').trim().toUpperCase();
  return (KINDS as string[]).includes(s) ? (s as UtteranceKind) : 'UNKNOWN';
}

const REGIMES: MarketRegime[] = ['TREND_UP', 'TREND_DOWN', 'RANGE', 'UNKNOWN'];

export function regimeOf(v: any): MarketRegime {
  const s = String(v ?? '').trim().toUpperCase();
  return (REGIMES as string[]).includes(s) ? (s as MarketRegime) : 'UNKNOWN';
}

/**
 * 발언 → 감지 지연(초).
 *
 * **둘 중 하나라도 없으면 null이다.** 0으로 떨어뜨리면 "즉시 감지했다"가
 * 되고, 그 신호는 FAST 칸에 앉아 성적이 가장 좋게 나오는 자리를 차지한다.
 *
 * 음수도 null이다 — 감지가 발언보다 먼저일 수는 없으므로, 그건 둘 중
 * 하나가 잘못 기록된 것이다. 그걸 0으로 접으면 잘못된 기록이 정상으로
 * 보인다.
 */
export function delaySecOf(saidAt: any, detectedAt: any): number | null {
  const s = msOf(saidAt);
  const d = msOf(detectedAt);
  if (s == null || d == null) return null;
  const sec = (d - s) / 1000;
  return sec >= 0 ? sec : null;
}

/**
 * 표의 행 하나를 장부에 태울 수 있는가.
 *
 * **여기서 통과한 것만 장부에 들어간다.** 순서가 중요하다 — 값을 만들기
 * 전에 없는 것을 먼저 걸러야, 만들어 놓고 통과시키는 일이 없다.
 */
export function intakeSignal(
  row: SignalRow | null | undefined,
  opts: GateOptions & {
    /** 검수를 건너뛴다. **기본은 false다** — 켤 일이 있다면 연구용뿐이다 */
    allowUnreviewed?: boolean;
  } = {},
): IntakeResult {
  const fail = (reason: string, missing: string[] = []): IntakeResult =>
    ({ ok: false, signal: null, delaySec: null, regime: 'UNKNOWN', reason, missing });

  if (!row) return fail('행이 없습니다');

  // ── 검수 ──
  // 파서가 뽑은 것을 그대로 넣으면 그 사람의 성과가 아니라 우리 파서의
  // 성과를 재게 된다.
  const review = String(row.review_status ?? 'pending').trim().toLowerCase();
  if (!opts.allowUnreviewed && review !== 'approved') {
    return fail(
      review === 'rejected'
        ? '검수에서 거부된 신호입니다'
        : '아직 검수하지 않은 신호입니다 — 검수 전 신호를 넣으면 그 사람이 아니라 '
          + '우리 추출기의 성과를 재게 됩니다',
      ['review_status']);
  }

  // ── 발언 시각 ──
  // **detected_at으로 대신 채우지 않는다.** 위 파일 머리말 참고.
  const saidAtMs = msOf(row.said_at);
  if (saidAtMs == null) {
    return fail(
      '발언 시각이 없습니다 — 감지 시각으로 대신 쓰면 지연이 0초가 되고, '
      + '볼 수 없었던 가격에 체결한 성과가 나옵니다',
      ['said_at']);
  }

  const side = String(row.side ?? '').trim().toUpperCase();
  if (side !== 'LONG' && side !== 'SHORT') {
    // 청산 발언에는 방향이 없을 수 있다. 그건 잘못이 아니라 **진입 신호가
    // 아닌 것**이므로 그렇게 말한다.
    return fail(`방향이 ${side || '없음'}입니다 — 진입 신호가 아닙니다`, ['side']);
  }

  const signal: CreatorSignal = {
    creatorId: String(row.creator ?? row.channel_id ?? ''),
    symbol: String(row.symbol ?? ''),
    direction: side as 'LONG' | 'SHORT',
    saidAtMs,
    kind: kindOf(row.utterance_kind),
    entryPrice: num(row.entry_price),
    stopLoss: num(row.stop_loss),
    takeProfits: num(row.take_profit) != null ? [num(row.take_profit) as number] : undefined,
    // **확신도를 없는 채로 넘긴다.** 여기서 1로 채우면 gateSignal의
    // "확신도를 모르는 신호는 태우지 않는다"가 통째로 무력해진다.
    confidence: num(row.extract_confidence) ?? undefined,
  };

  const g = gateSignal(signal, opts);
  if (!g.tradeable) {
    return { ok: false, signal: null, delaySec: null, regime: 'UNKNOWN',
             reason: g.reason, missing: g.missing };
  }

  return {
    ok: true,
    signal,
    delaySec: delaySecOf(row.said_at, row.detected_at),
    regime: regimeOf(row.regime),
    reason: '',
    missing: [],
  };
}

/**
 * 여러 행을 한꺼번에. 통과한 것과 못 한 것을 **둘 다** 돌려준다.
 *
 * 못 한 것을 버리면 화면이 "신호 3건"이라고만 적고, 왜 나머지 40건이
 * 빠졌는지는 아무도 모른다. 그러면 검수해야 할 것이 쌓여 있는데도
 * 표는 조용하다.
 */
export function intakeAll(
  rows: SignalRow[] | null | undefined,
  opts: Parameters<typeof intakeSignal>[1] = {},
): {
  accepted: Array<{ row: SignalRow; intake: IntakeResult }>;
  rejected: Array<{ row: SignalRow; reason: string }>;
  /** 사유별 개수 — 무엇이 가장 많이 막히는지가 다음에 고칠 것이다 */
  reasonCounts: Record<string, number>;
} {
  const accepted: Array<{ row: SignalRow; intake: IntakeResult }> = [];
  const rejected: Array<{ row: SignalRow; reason: string }> = [];
  const reasonCounts: Record<string, number> = {};

  for (const row of Array.isArray(rows) ? rows : []) {
    const r = intakeSignal(row, opts);
    if (r.ok) accepted.push({ row, intake: r });
    else {
      rejected.push({ row, reason: r.reason });
      // 첫 항목으로 묶는다 — 전체 문장을 키로 쓰면 값이 섞인 문장마다
      // 다른 칸이 되어 세는 뜻이 없어진다.
      const key = r.missing[0] ?? 'gate';
      reasonCounts[key] = (reasonCounts[key] ?? 0) + 1;
    }
  }
  return { accepted, rejected, reasonCounts };
}

/**
 * 등급 → 숫자 확신도.
 *
 * **이건 세 칸짜리 사다리이지 연속적인 확신도가 아니다.** 파서는 0~1
 * 사이의 값을 만들지 않는다 — 만들 근거가 없다. 그런데 gateSignal은
 * 숫자를 요구하므로 여기서 한 번만 변환한다.
 *
 * 변환을 두 곳에 적으면 한쪽만 고쳐지고, 그때 넣을 때 통과한 신호가
 * 읽을 때 막히거나 그 반대가 된다. 그래서 이 함수 하나뿐이다.
 *
 * 숫자의 뜻:
 *   confirmed  0.95 — 발언 + **화면의 포지션까지** 확인했다
 *   likely     0.80 — 발언이 명확했다. 화면은 못 봤다
 *   uncertain  0.40 — 기본 문턱(0.7) 아래다. 일부러 막는다
 *
 * uncertain을 0.7 위로 올리고 싶어지면, 그건 문턱을 낮추고 싶은 것이지
 * 그 신호가 확실해진 것이 아니다.
 */
export function confidenceFromTier(tier: any): number | null {
  const t = String(tier ?? '').trim().toLowerCase();
  if (t === 'confirmed') return 0.95;
  if (t === 'likely') return 0.80;
  if (t === 'uncertain') return 0.40;
  // 모르는 등급은 **숫자를 만들지 않는다.** 0.5쯤으로 채우면
  // "확신도를 모르는 신호는 태우지 않는다"가 무력해진다.
  return null;
}

/**
 * 신호의 action → 발언 종류.
 *
 * ENTRY만 진입 발언이다. 나머지(추가·부분청산·청산·수정)는 진입이
 * 아니므로 장부에 안 들어간다 — 장부는 "이 사람 말대로 **들어갔으면**
 * 어땠나"를 재는 것이라 진입이 없으면 잴 것이 없다.
 *
 * 그리고 이건 **추정**이다. 사람이 검수할 때 바꿀 수 있어야 한다 —
 * "여기서 롱도 가능하다"를 파서가 ENTRY로 읽는 경우가 있고, 그건
 * EXPLICIT_ENTRY가 아니라 QUESTION이다.
 */
export function kindFromAction(action: any): UtteranceKind {
  const a = String(action ?? '').trim().toUpperCase();
  return a === 'ENTRY' ? 'EXPLICIT_ENTRY' : 'UNKNOWN';
}

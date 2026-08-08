// src/lib/portfolio/attribution.ts
//
// **+10%라는 숫자는 무엇을 해야 할지 알려주지 않는다.**
//
// 지금 화면은 총손익 하나만 보여준다. 그런데 사용자가 실제로 알고 싶은
// 것은 "왜 +10%인가"다:
//
//   스윙       +$1,400
//   VWAP       +$600
//   수수료     −$210
//   펀딩비     −$90
//   ─────────────────
//   합계       +$1,700
//
// 이렇게 쪼개야 **어떤 시스템이 실제로 돈을 만들었는지** 알 수 있다.
// 전략을 스무 개 돌리면서 총합만 보면, 하나가 벌고 열아홉이 잃는 상황과
// 스물이 조금씩 버는 상황이 화면에서 똑같이 보인다. 그 둘은 다음에 할
// 일이 정반대다.
//
// 이 파일의 규칙 하나
// ───────────────────
// **쪼갠 것의 합이 총합과 안 맞으면 그렇다고 말한다.**
//
// 귀속 분석에서 가장 흔한 거짓말이 이것이다. 항목을 다 더해도 총손익에
// 안 닿으면, 보통 남는 만큼을 아무 항목에나 밀어 넣거나 총합을 항목 합으로
// 바꿔 버린다. 그러면 화면은 언제나 깔끔하고, **설명되지 않은 손익이
// 있다는 사실만 사라진다.** 그게 대개 진짜 문제다 — 안 세고 있는 비용,
// 누락된 전략, 잘못 붙은 태그.
//
// 그래서 여기서는 남는 것을 '설명되지 않음'으로 **따로 세워 둔다.**

export interface Contribution {
  key: string;
  label: string;
  /** 이 항목이 총손익에 기여한 금액. 비용은 음수 */
  amount: number | null;
  /** 비용인가 (수수료·펀딩비·슬리피지) */
  isCost?: boolean;
}

export interface AttributionRow {
  key: string;
  label: string;
  amount: number;
  /** 총 절대 기여도 대비 비중 (%) */
  sharePct: number;
  isCost: boolean;
  /** 실제로 읽은 값인가 */
  known: boolean;
}

export interface Attribution {
  rows: AttributionRow[];
  /** 항목을 다 더한 값 */
  explained: number;
  /** 장부상 총손익. 안 주면 null */
  reported: number | null;
  /** 총손익 − 항목 합. **0이 아니면 어딘가 안 세고 있다** */
  unexplained: number | null;
  /** 합이 맞는가 */
  reconciled: boolean;
  /** 값을 못 읽은 항목 이름들 */
  missing: string[];
  /** 벌어들인 쪽 합계 */
  grossGain: number;
  /** 나간 비용 합계 (양수) */
  grossCost: number;
  reason: string;
}

/**
 * 이 금액 미만의 차이는 반올림으로 본다.
 *
 * 통화 단위가 원이면 1원, 달러면 0.01달러 수준의 차이는 부동소수와
 * 반올림에서 늘 생긴다. 그것까지 '설명되지 않음'으로 띄우면 경고가
 * 배경이 되고, 진짜 누락이 묻힌다.
 */
export const RECONCILE_EPS = 0.01;

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 손익을 항목별로 쪼갠다.
 *
 * `reported`는 장부상 총손익이다. 넣으면 **합이 맞는지 검사한다** —
 * 이게 이 함수의 핵심이고, 안 넣으면 그 검사를 못 한다.
 */
export function attributionOf(
  contributions: Contribution[] | null | undefined,
  reported?: number | null,
): Attribution {
  const list = Array.isArray(contributions) ? contributions : [];
  const missing: string[] = [];

  const parsed = list.map(c => {
    const amt = num(c?.amount);
    const label = String(c?.label ?? c?.key ?? '이름 없는 항목');
    if (amt == null) missing.push(label);
    return {
      key: String(c?.key ?? label), label,
      amount: amt ?? 0, known: amt != null, isCost: c?.isCost === true,
    };
  });

  const explained = parsed.reduce((s, r) => s + (r.known ? r.amount : 0), 0);
  const absTotal = parsed.reduce((s, r) => s + (r.known ? Math.abs(r.amount) : 0), 0);

  const rows: AttributionRow[] = parsed.map(r => ({
    key: r.key, label: r.label, amount: r.amount,
    // 비중은 **절대값 기준**이다. 순합으로 나누면 이익과 손실이 상쇄돼
    // 분모가 0에 가까워지고, 작은 항목이 300%처럼 뜬다.
    sharePct: absTotal > 0 && r.known ? (Math.abs(r.amount) / absTotal) * 100 : 0,
    isCost: r.isCost, known: r.known,
  }));

  const grossGain = parsed.reduce((s, r) => s + (r.known && r.amount > 0 ? r.amount : 0), 0);
  const grossCost = parsed.reduce((s, r) => s + (r.known && r.amount < 0 ? -r.amount : 0), 0);

  const rep = num(reported);
  const unexplained = rep == null ? null : rep - explained;
  const reconciled = unexplained != null && Math.abs(unexplained) < RECONCILE_EPS;

  let reason = '';
  if (missing.length > 0) {
    reason = `${missing.join(' · ')}의 금액을 읽지 못했습니다 — 이 항목들은 합계에서 빠져 있습니다`;
  } else if (rep == null) {
    reason = '장부상 총손익을 안 넣어 합이 맞는지 확인하지 못했습니다';
  } else if (!reconciled) {
    reason = `항목 합 ${explained.toFixed(2)}과 장부 ${rep.toFixed(2)}이 ${Math.abs(unexplained!).toFixed(2)} 다릅니다`
      + ' — 안 세고 있는 비용이나 빠진 전략이 있습니다';
  }

  return {
    rows, explained, reported: rep, unexplained, reconciled, missing,
    grossGain, grossCost, reason,
  };
}

/**
 * 화면에 그릴 줄들 — **설명되지 않은 부분을 마지막 줄로 세운다.**
 *
 * 남는 것을 어느 항목에 슬쩍 얹으면 화면은 깔끔해지지만, 그 순간
 * "설명되지 않은 손익이 있다"는 사실이 사라진다. 그게 대개 진짜 문제다.
 */
export function rowsWithResidual(a: Attribution): AttributionRow[] {
  if (a.unexplained == null || a.reconciled) return a.rows;
  return [
    ...a.rows,
    {
      key: '__unexplained__', label: '설명되지 않음',
      amount: a.unexplained,
      sharePct: 0,
      isCost: false, known: true,
    },
  ];
}

// ── 무엇이 돈을 벌었나 ────────────────────────────────────

export interface TopMovers {
  /** 가장 많이 번 항목 */
  bestGain: AttributionRow | null;
  /** 가장 많이 잃은 항목 */
  worstLoss: AttributionRow | null;
  /** 가장 큰 비용 */
  biggestCost: AttributionRow | null;
  /** 비용이 총 이익의 몇 %를 먹었는가. 이익이 없으면 null */
  costShareOfGainPct: number | null;
  /** 사람이 읽는 한 줄 */
  summary: string;
}

/**
 * 한 줄 요약.
 *
 * **"비용이 이익의 몇 %를 먹었나"를 꼭 넣는다.** 스캘핑처럼 회전이 빠른
 * 전략은 이 값이 조용히 50%를 넘어가고, 총손익만 보면 그 사실이 안 보인다.
 */
export function topMoversOf(a: Attribution): TopMovers {
  const known = a.rows.filter(r => r.known);
  const gains = known.filter(r => r.amount > 0);
  const losses = known.filter(r => r.amount < 0 && !r.isCost);
  const costs = known.filter(r => r.isCost);

  const bestGain = gains.length ? gains.reduce((x, y) => (y.amount > x.amount ? y : x)) : null;
  const worstLoss = losses.length ? losses.reduce((x, y) => (y.amount < x.amount ? y : x)) : null;
  const biggestCost = costs.length
    ? costs.reduce((x, y) => (Math.abs(y.amount) > Math.abs(x.amount) ? y : x)) : null;

  const costTotal = costs.reduce((s, r) => s + Math.abs(r.amount), 0);
  const costShare = a.grossGain > 0 ? (costTotal / a.grossGain) * 100 : null;

  const bits: string[] = [];
  if (bestGain) bits.push(`${bestGain.label}이 가장 많이 벌었습니다`);
  if (worstLoss) bits.push(`${worstLoss.label}이 가장 많이 잃었습니다`);
  if (costShare != null) bits.push(`비용이 총 이익의 ${costShare.toFixed(0)}%를 먹었습니다`);
  if (!a.reconciled && a.unexplained != null) {
    bits.push(`설명되지 않은 손익 ${a.unexplained.toFixed(2)}이 남아 있습니다`);
  }

  return {
    bestGain, worstLoss, biggestCost,
    costShareOfGainPct: costShare,
    summary: bits.length ? bits.join(' · ') : '쪼갤 항목이 없습니다',
  };
}

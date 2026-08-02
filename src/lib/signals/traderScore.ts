// src/lib/signals/traderScore.ts
//
// **방송자별 성과 기록.**
//
// 왜 이것이 알림보다 먼저인가
// ───────────────────────────
// 신호를 그대로 따라 사는 것은 그 사람이 잘하는지 **모르는 채로** 돈을
// 거는 것이다. 그리고 방송을 보는 사람은 기억으로 판단한다 — 크게 맞힌
// 것은 기억하고 조용히 틀린 것은 잊는다. 그래서 실제보다 늘 잘해 보인다.
//
// 이 파일은 그 기억을 숫자로 바꾼다. 성과가 검증된 뒤에야
// 알림 → 반자동 → 제한적 자동 순으로 올린다.
//
// 이 파일이 하지 않는 것
// ──────────────────────
// **없는 결과를 만들지 않는다.** 청산 신호가 없는 진입은 '미결'로 남긴다.
// 지금 가격으로 임의 청산해서 손익을 매기면, 아직 살아 있는 포지션이
// 손실로 확정되어 성적이 실제보다 나쁘거나 좋게 나온다.
//
// 그리고 **표본이 적으면 승률을 말하지 않는다.** 3전 2승은 67%가 아니라
// "아직 모른다"다. 숫자를 보여주면 사람은 그것을 믿는다.

import type { SignalSide, Confidence } from './positionParse';

export interface ScoredSignal {
  trader: string;
  symbol: string;
  side: SignalSide;
  confidence: Confidence;
  /** 신호가 감지된 시각 */
  detectedAtMs: number;
  /** 신호 당시 시장가. **모르면 null** — 추측해서 채우지 않는다 */
  entryPrice: number | null;
  /** 청산 신호가 왔을 때의 시장가. 아직 안 왔으면 null */
  exitPrice: number | null;
  exitAtMs: number | null;
}

export interface TraderStats {
  trader: string;
  /** 결과를 아는 신호 수 (진입·청산이 모두 있는 것) */
  closed: number;
  /** 아직 안 끝난 것 */
  open: number;
  /** 가격을 몰라 채점 자체가 안 되는 것 */
  unscorable: number;
  wins: number;
  losses: number;
  /**
   * 승률(%). **표본이 적으면 null이다.**
   * 3전 2승을 67%로 적으면 사람은 그 숫자를 믿는다.
   */
  winRate: number | null;
  /** 평균 수익 ÷ 평균 손실. 손실이 없으면 null (∞를 숫자로 적지 않는다) */
  profitFactor: number | null;
  /** 누적 수익률(%) — 매번 같은 금액을 걸었다고 가정한 단순 합 */
  totalPct: number;
  /** 최대 낙폭(%) */
  maxDrawdownPct: number;
  /** 롱 비중(%). 한쪽에 치우쳐 있으면 시장이 그 방향일 때만 맞는다 */
  longBiasPct: number | null;
  /** 신호가 뜨고 실제로 따라 살 수 있기까지의 지연 — 알 수 있을 때만 */
  avgHoldHours: number | null;
  /** 이 숫자들을 믿어도 되는가 */
  enough: boolean;
  note: string;
}

/** 이 아래로는 승률을 말하지 않는다 */
export const MIN_SAMPLE = 20;

const pctChange = (entry: number, exit: number, side: SignalSide): number =>
  side === 'LONG'
    ? ((exit - entry) / entry) * 100
    : ((entry - exit) / entry) * 100;

/**
 * 신호 목록 → 방송자별 성적.
 *
 * 순수 함수다. 가격은 호출부가 채워서 넘긴다 — 여기서 시세를 부르면
 * 같은 신호를 두 번 채점할 때 답이 달라진다.
 */
export function scoreTrader(trader: string, signals: ScoredSignal[] | null | undefined): TraderStats {
  const mine = (Array.isArray(signals) ? signals : []).filter(s => s && s.trader === trader);

  let open = 0, unscorable = 0;
  const results: number[] = [];
  const holdHours: number[] = [];
  let longCount = 0, sideKnown = 0;

  for (const s of mine) {
    if (s.side === 'LONG') longCount += 1;
    if (s.side === 'LONG' || s.side === 'SHORT') sideKnown += 1;

    // 진입가를 모르면 **채점하지 않는다.** 지금 가격으로 대신 쓰면
    // 신호가 뜬 뒤 움직인 만큼이 통째로 성적에 들어간다.
    if (!Number.isFinite(s.entryPrice as any) || (s.entryPrice as number) <= 0) {
      unscorable += 1;
      continue;
    }
    // 청산 신호가 없으면 **미결**이다. 지금 가격으로 임의 청산하면
    // 아직 살아 있는 포지션이 손익으로 확정된다.
    if (!Number.isFinite(s.exitPrice as any) || (s.exitPrice as number) <= 0) {
      open += 1;
      continue;
    }
    results.push(pctChange(s.entryPrice as number, s.exitPrice as number, s.side));
    if (Number.isFinite(s.exitAtMs as any) && Number.isFinite(s.detectedAtMs)) {
      const h = ((s.exitAtMs as number) - s.detectedAtMs) / 3_600_000;
      if (h >= 0) holdHours.push(h);
    }
  }

  const wins = results.filter(r => r > 0).length;
  const losses = results.filter(r => r < 0).length;
  const closed = results.length;

  const grossWin = results.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(results.filter(r => r < 0).reduce((a, b) => a + b, 0));

  // 누적과 낙폭은 순서대로 더한다
  let cum = 0, peak = 0, mdd = 0;
  for (const r of results) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > mdd) mdd = dd;
  }

  const enough = closed >= MIN_SAMPLE;

  return {
    trader,
    closed, open, unscorable,
    wins, losses,
    // **표본이 적으면 승률을 안 준다.** 숫자를 보여주면 사람은 믿는다.
    winRate: enough ? Number(((wins / closed) * 100).toFixed(1)) : null,
    // 손실이 하나도 없으면 손익비는 무한대다. 큰 숫자로 적으면
    // "아주 좋다"로 읽히는데 실제로는 표본이 모자란 것이다.
    profitFactor: (enough && grossLoss > 0) ? Number((grossWin / grossLoss).toFixed(2)) : null,
    totalPct: Number(cum.toFixed(2)),
    maxDrawdownPct: Number(mdd.toFixed(2)),
    longBiasPct: sideKnown > 0 ? Number(((longCount / sideKnown) * 100).toFixed(1)) : null,
    avgHoldHours: holdHours.length > 0
      ? Number((holdHours.reduce((a, b) => a + b, 0) / holdHours.length).toFixed(1))
      : null,
    enough,
    note: buildNote({ closed, open, unscorable, enough }),
  };
}

function buildNote(o: { closed: number; open: number; unscorable: number; enough: boolean }): string {
  const parts: string[] = [];
  if (!o.enough) {
    parts.push(`끝난 신호 ${o.closed}건 — ${MIN_SAMPLE}건은 넘어야 승률을 말할 수 있습니다`);
  }
  if (o.open > 0) parts.push(`${o.open}건은 아직 청산 신호가 없어 채점하지 않았습니다`);
  // 이 숫자가 크면 성적 자체를 믿을 수 없다. 조용히 빼면 안 된다.
  if (o.unscorable > 0) parts.push(`${o.unscorable}건은 당시 가격을 몰라 채점하지 못했습니다`);
  return parts.join(' · ') || '충분한 표본으로 계산했습니다';
}

/**
 * 이 방송자의 신호를 어디까지 쓸 수 있는가.
 *
 * 사용자가 직접 올리는 것이 아니라 **성적이 올린다.** 그리고 어느
 * 단계에서도 자동 주문은 아니다 — 이 앱에서 남의 신호로 자동 주문을
 * 내는 경로는 만들지 않는다.
 */
export type TrustTier = 'watch' | 'notify' | 'paper' | 'semi_auto';

export function trustTier(st: TraderStats | null | undefined): { tier: TrustTier; reason: string } {
  if (!st) return { tier: 'watch', reason: '성적이 없습니다' };

  // 채점 못 한 신호가 많으면 나머지 숫자도 못 믿는다.
  const total = st.closed + st.open + st.unscorable;
  if (total > 0 && st.unscorable / total > 0.3) {
    return { tier: 'watch', reason: '당시 가격을 모르는 신호가 너무 많아 성적을 믿을 수 없습니다' };
  }
  if (!st.enough) {
    return { tier: 'notify', reason: `표본이 적습니다 (끝난 신호 ${st.closed}건) — 알림까지만` };
  }
  if (st.winRate == null || st.profitFactor == null) {
    return { tier: 'notify', reason: '승률·손익비를 계산하지 못했습니다' };
  }
  if (st.profitFactor < 1) {
    // 이기는 횟수가 많아도 손익비가 1 미만이면 결국 잃는다.
    return { tier: 'notify', reason: `손익비 ${st.profitFactor} — 따라가면 잃습니다` };
  }
  if (st.maxDrawdownPct > 40) {
    return { tier: 'paper', reason: `최대 낙폭 ${st.maxDrawdownPct}% — 모의로만 따라가세요` };
  }
  if (st.profitFactor >= 1.5 && st.winRate >= 45) {
    return { tier: 'semi_auto', reason: `손익비 ${st.profitFactor} · 승률 ${st.winRate}% — 확인 후 수동 주문까지` };
  }
  return { tier: 'paper', reason: `손익비 ${st.profitFactor} — 모의로 더 지켜보세요` };
}

export const TIER_LABEL: Record<TrustTier, { text: string; note: string }> = {
  watch:     { text: '지켜보기',   note: '기록만 합니다. 알림도 안 보냅니다' },
  notify:    { text: '알림',       note: '알림만 받습니다. 따라 사지 마세요' },
  paper:     { text: '모의매매',   note: '모의로 따라가며 성적을 더 모읍니다' },
  semi_auto: { text: '수동 주문',  note: '알림을 보고 직접 확인한 뒤 주문합니다. 자동은 아닙니다' },
};

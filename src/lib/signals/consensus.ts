// src/lib/signals/consensus.ts
//
// **여러 방송자가 같은 방향을 보고 있는가.**
//
// 먼저 알아야 할 것
// ─────────────────
// 여럿이 같은 말을 한다는 것은 **맞다는 뜻이 아니다.** 방송자들은
// 서로의 방송을 보고, 같은 뉴스를 읽고, 같은 차트를 본다. 그래서
// 의견이 겹치는 것은 자연스럽고, 겹친다고 정확해지지 않는다.
//
// 오히려 **전원이 한 방향이면 그 자리가 이미 붐빈 자리**일 때가 많다.
// 붐빈 자리는 반대로 갈 때 크게 간다 — 다 같이 롱이면 롱 청산이 몰린다.
//
// 그래서 이 파일은 '합의도'를 신호로 주지 않는다. **상태**로 준다:
// 얼마나 쏠려 있는가, 그 판단을 믿을 만한 사람들이 하고 있는가.
//
// 성적으로 가중한다
// ─────────────────
// 한 번도 검증되지 않은 사람 다섯의 일치와, 손익비 2가 넘는 사람
// 하나의 반대 의견은 같은 무게가 아니다. 머릿수만 세면 방송을 많이
// 켜 놓은 쪽이 이긴다.
//
// 오래된 신호는 세지 않는다
// ─────────────────────────
// 두 시간 전 "롱 잡았습니다"는 지금 포지션이라는 보장이 없다. 청산은
// 말 안 하고 넘어가는 일이 흔하다 — 그 발언을 계속 세면 **이미 나간
// 사람이 영원히 롱을 들고 있는 것으로 집계된다.**

import type { SignalSide, Confidence } from './positionParse';
import type { TraderStats } from './traderScore';
import { trustTier } from './traderScore';

export interface ConsensusInput {
  trader: string;
  side: SignalSide;
  confidence: Confidence;
  /** 이 신호가 감지된 시각 */
  atMs: number;
  /** 이 사람의 성적. **없으면 null** — 검증 안 됨 */
  stats: TraderStats | null;
}

export interface ConsensusResult {
  symbol: string;
  /** 우세한 방향. 팽팽하면 null */
  side: SignalSide | null;
  /** 우세 비중(%). 가중치를 반영한 값 */
  leanPct: number | null;
  /** 실제로 센 사람 수 */
  counted: number;
  /** 오래돼서 뺀 수 */
  stale: number;
  /** 성적이 검증 안 돼 가중치가 낮은 사람 수 */
  unproven: number;
  longVoices: string[];
  shortVoices: string[];
  /** 이 숫자를 믿어도 되는가 */
  reliable: boolean;
  /** 한쪽으로 지나치게 쏠렸는가 — 신호가 아니라 경고다 */
  crowded: boolean;
  note: string;
}

/** 이 시간이 지난 신호는 지금 포지션이라고 볼 수 없다 */
export const STALE_MS = 90 * 60_000;

/**
 * 신뢰 단계별 가중치.
 *
 * 검증 안 된 사람을 0으로 두지는 않는다 — 그러면 새로 추가한 채널이
 * 영원히 화면에 안 나타나서 성적을 쌓을 기회 자체가 없다. 대신 확실히
 * 낮춘다.
 */
const TIER_WEIGHT: Record<string, number> = {
  watch: 0.2, notify: 0.4, paper: 0.7, semi_auto: 1,
};

/** 신뢰도별 가중치. 추정을 확정과 같은 무게로 세면 안 된다 */
const CONF_WEIGHT: Record<Confidence, number> = {
  confirmed: 1, likely: 0.7, uncertain: 0.35,
};

export function computeConsensus(
  symbol: string,
  inputs: ConsensusInput[] | null | undefined,
  nowMs: number,
): ConsensusResult {
  const list = (Array.isArray(inputs) ? inputs : []).filter(Boolean);

  let longW = 0, shortW = 0, stale = 0, unproven = 0, counted = 0;
  const longVoices: string[] = [];
  const shortVoices: string[] = [];

  for (const i of list) {
    // 오래된 발언은 지금 포지션이 아니다. 계속 세면 이미 나간 사람이
    // 영원히 그 방향을 들고 있는 것으로 집계된다.
    if (!Number.isFinite(i.atMs) || nowMs - i.atMs > STALE_MS) { stale += 1; continue; }

    const tier = trustTier(i.stats).tier;
    if (tier === 'watch' || tier === 'notify') unproven += 1;

    const w = (TIER_WEIGHT[tier] ?? 0.2) * (CONF_WEIGHT[i.confidence] ?? 0.35);
    counted += 1;
    if (i.side === 'LONG') { longW += w; longVoices.push(i.trader); }
    else if (i.side === 'SHORT') { shortW += w; shortVoices.push(i.trader); }
  }

  const total = longW + shortW;
  if (counted === 0 || total <= 0) {
    return {
      symbol, side: null, leanPct: null, counted, stale, unproven,
      longVoices, shortVoices, reliable: false, crowded: false,
      note: stale > 0
        ? `최근 ${Math.round(STALE_MS / 60_000)}분 안의 발언이 없습니다 (오래된 것 ${stale}건은 세지 않았습니다)`
        : '집계할 발언이 없습니다',
    };
  }

  const leanLong = (longW / total) * 100;
  const side: SignalSide | null =
    leanLong > 55 ? 'LONG' : leanLong < 45 ? 'SHORT' : null;
  const leanPct = Number((side === 'SHORT' ? 100 - leanLong : leanLong).toFixed(1));

  // 셋 미만이면 '합의'라고 부를 수 없다. 한 사람이 바뀌면 결과가 뒤집힌다.
  const reliable = counted >= 3 && unproven < counted;

  // **전원 일치는 강한 신호가 아니라 붐빈 자리라는 신호다.**
  const crowded = counted >= 3 && (longVoices.length === 0 || shortVoices.length === 0);

  const notes: string[] = [];
  if (counted < 3) notes.push(`${counted}명뿐이라 합의라고 보기 어렵습니다`);
  if (unproven > 0) notes.push(`${unproven}명은 성적이 아직 검증되지 않아 비중을 낮췄습니다`);
  if (stale > 0) notes.push(`${stale}건은 오래돼서 뺐습니다 — 지금 포지션이라는 보장이 없습니다`);
  if (crowded) {
    notes.push('전원이 한 방향입니다 — 맞다는 뜻이 아니라 그 자리가 붐볐다는 뜻일 수 있습니다');
  }

  return {
    symbol, side, leanPct, counted, stale, unproven,
    longVoices, shortVoices, reliable, crowded,
    note: notes.join(' · ') || `${counted}명 집계`,
  };
}

/**
 * 이 합의를 주문 근거로 쓸 수 있는가.
 *
 * **언제나 false다.** 값을 돌려주는 함수로 둔 이유는 positionParse의
 * canAutoTrade와 같다 — 나중에 누가 연결하려 할 때 여기 한 곳만 보면
 * 되게 하기 위해서다.
 *
 * 왜 안 되는가: 합의는 정확도의 근거가 아니다. 같은 뉴스를 본 사람들이
 * 같은 말을 하는 것이고, 전원 일치는 오히려 붐빈 자리다. 그리고 이
 * 숫자는 **다른 사람들이 무엇을 했는지에 대한 추측**을 모은 것이라,
 * 추측 위에 추측을 쌓은 값이다.
 */
export function canTradeOnConsensus(): false {
  return false;
}

/** 화면에 쓸 한 줄. 확신을 주는 문장을 쓰지 않는다 */
export function consensusHeadline(r: ConsensusResult | null): string {
  if (!r || r.side == null) return '방향이 갈립니다';
  const dir = r.side === 'LONG' ? '롱' : '숏';
  if (!r.reliable) return `${dir} 쪽이 많지만 표본이 부족합니다`;
  if (r.crowded) return `전원 ${dir} — 붐빈 자리일 수 있습니다`;
  return `${dir} 우세 ${r.leanPct}%`;
}

// src/lib/news/consensus.ts
//
// 여러 AI의 분석을 모아 하나의 판정으로.
//
// 평균을 내지 않는 이유
// ─────────────────────
// 상승 80%와 하락 80%를 평균하면 "80% 확신"이 된다. 실제로는 두 모델이
// 정반대를 말한 것이고, 그건 아무것도 모르는 상태다. 숫자가 나오니까
// 화면에서는 확신 있어 보이는데, 그게 이 기능에서 가장 위험한 실패다.
//
// 의견이 갈린 사실 자체가 결과다
// ──────────────────────────────
// 합의 분석의 값어치는 "셋이 같은 말을 했다"보다 "둘이 반대로 봤다"에
// 있다. 갈린 것을 하나로 뭉개면 그 정보가 사라진다.
//
// 하나만 답한 것은 합의가 아니다
// ──────────────────────────────
// 나머지가 실패했을 때 남은 하나를 '합의'로 부르면, 사용자는 셋이
// 동의한 줄 안다. 몇 개가 답했는지를 결과에 같이 넣는다.

import type { NewsDirection } from './schema';

export interface Opinion {
  provider: string;
  direction: NewsDirection;
  confidence: number;
  reasons?: string[];
  risks?: string[];
}

export type ConsensusLevel =
  | 'UNANIMOUS'      // 전원 같은 방향
  | 'MAJORITY'       // 과반이 같은 방향
  | 'SPLIT'          // 갈렸다 — 방향을 내지 않는다
  | 'INSUFFICIENT';  // 답한 모델이 부족하다

export interface ConsensusResult {
  level: ConsensusLevel;
  /** 합의 방향. SPLIT·INSUFFICIENT면 null — 억지로 고르지 않는다 */
  direction: NewsDirection | null;
  directionKo: string | null;
  /** 종합 신뢰도. 갈릴수록 낮아진다 */
  confidence: number;
  /** 몇 개가 답했는가 */
  responded: number;
  /** 방향별 표 */
  votes: Record<string, number>;
  /** 둘 이상이 든 근거 */
  sharedReasons: string[];
  /** 한 모델만 든 근거 — 버리지 않는다. 남들이 놓친 것일 수 있다 */
  uniqueReasons: { provider: string; reason: string }[];
  /** 사람이 읽을 한 줄 */
  summary: string;
}

const KO: Record<string, string> = {
  bullish: '상승', neutral: '보합', bearish: '하락', uncertain: '판단 보류',
};

/** 최소 몇 개가 답해야 합의라고 부를 수 있는가 */
export const MIN_FOR_CONSENSUS = 2;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,·]+$/, '');

export function aggregate(opinions: Opinion[]): ConsensusResult {
  const valid = opinions.filter(o => o && o.direction && Number.isFinite(o.confidence));
  const responded = valid.length;

  const votes: Record<string, number> = {};
  for (const o of valid) votes[o.direction] = (votes[o.direction] || 0) + 1;

  // ── 근거 모으기 ──
  // 표현이 조금 달라도 같은 근거로 본다. 다만 지나치게 뭉치면 서로 다른
  // 지적이 하나로 합쳐지므로, 정규화는 공백·문장부호까지만 한다.
  const seen = new Map<string, { text: string; providers: Set<string> }>();
  for (const o of valid) {
    for (const r of (o.reasons || [])) {
      const k = norm(String(r));
      if (!k) continue;
      const hit = seen.get(k);
      if (hit) hit.providers.add(o.provider);
      else seen.set(k, { text: String(r).trim(), providers: new Set([o.provider]) });
    }
  }
  const sharedReasons: string[] = [];
  const uniqueReasons: { provider: string; reason: string }[] = [];
  for (const v of seen.values()) {
    if (v.providers.size >= 2) sharedReasons.push(v.text);
    else uniqueReasons.push({ provider: [...v.providers][0], reason: v.text });
  }

  const base = { responded, votes, sharedReasons, uniqueReasons };

  if (responded < MIN_FOR_CONSENSUS) {
    // 하나만 답했으면 그 하나의 의견이지 합의가 아니다.
    return {
      ...base,
      level: 'INSUFFICIENT',
      direction: null, directionKo: null,
      confidence: 0,
      summary: responded === 0
        ? '어떤 AI도 답하지 않았습니다'
        : `${valid[0].provider} 하나만 답했습니다 — 합의가 아니라 단일 의견입니다`,
    };
  }

  // 최다 득표. 동점이면 갈린 것으로 본다.
  const entries = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const [topDir, topCount] = entries[0];
  const tied = entries.length > 1 && entries[1][1] === topCount;

  // 판단 보류가 최다면 방향을 내지 않는다. '보류가 우세'는 방향이 아니다.
  if (tied || topDir === 'uncertain') {
    const conf = Math.round(
      valid.reduce((s, o) => s + o.confidence, 0) / responded * 0.4,
    );
    return {
      ...base,
      level: 'SPLIT',
      direction: null, directionKo: null,
      // 갈렸을 때 평균 확신도를 그대로 쓰면 "80% 확신"처럼 보인다.
      // 실제로는 아무것도 모르는 상태라 크게 깎는다.
      confidence: Math.max(0, Math.min(50, conf)),
      summary: topDir === 'uncertain' && !tied
        ? `${responded}개 중 ${topCount}개가 판단을 보류했습니다 — 방향을 내지 않습니다`
        : `의견이 갈렸습니다 (${entries.map(([d, n]) => `${KO[d] ?? d} ${n}`).join(' · ')}) — 방향을 내지 않습니다`,
    };
  }

  const unanimous = topCount === responded;
  // 같은 방향을 말한 모델들의 확신도만 평균한다. 반대한 모델의 확신도를
  // 섞으면 그 모델이 합의를 뒷받침한 것처럼 계산된다.
  const agreeing = valid.filter(o => o.direction === topDir);
  const rawConf = agreeing.reduce((s, o) => s + o.confidence, 0) / agreeing.length;
  // 만장일치가 아니면 동의 비율만큼 깎는다.
  const ratio = topCount / responded;
  const confidence = Math.max(0, Math.min(100, Math.round(rawConf * (unanimous ? 1 : ratio))));

  return {
    ...base,
    level: unanimous ? 'UNANIMOUS' : 'MAJORITY',
    direction: topDir as NewsDirection,
    directionKo: KO[topDir] ?? topDir,
    confidence,
    summary: unanimous
      ? `${responded}개 AI 모두 ${KO[topDir] ?? topDir}으로 봤습니다`
      : `${responded}개 중 ${topCount}개가 ${KO[topDir] ?? topDir}으로 봤습니다 (나머지는 다르게 봤습니다)`,
  };
}

/**
 * 이 기사에 합의 분석을 돌릴 만한가.
 *
 * 모든 기사에 3개 AI를 부르면 비용이 세 배다. 사양대로 **중요한 뉴스에만**
 * 쓴다. 판단 기준을 코드로 고정해 두는 이유는, '중요하다'가 사람마다
 * 달라서 그때그때 정하면 결국 전부 돌리게 되기 때문이다.
 */
export function worthConsensus(input: {
  /** 단일 분석이 매긴 확신도 */
  confidence: number | null;
  direction: NewsDirection | null;
  /** 영향받는 자산 수 */
  affectedCount: number;
}): { yes: boolean; why: string } {
  // 판단 보류는 오히려 물어볼 값어치가 있다 — 다른 모델은 볼 수도 있다.
  if (input.direction === 'uncertain') {
    return { yes: true, why: '단일 모델이 판단을 보류했습니다' };
  }
  // 확신이 어중간할 때가 갈릴 가능성이 높다. 아주 확신하거나 아주
  // 자신 없으면 더 물어봐도 답이 크게 안 바뀐다.
  const c = input.confidence ?? 0;
  if (c >= 40 && c <= 75) {
    return { yes: true, why: `확신도가 중간입니다 (${c}%)` };
  }
  if (input.affectedCount >= 3) {
    return { yes: true, why: `영향 자산이 ${input.affectedCount}개로 넓습니다` };
  }
  return { yes: false, why: '단일 분석으로 충분합니다' };
}

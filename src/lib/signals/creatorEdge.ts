// src/lib/signals/creatorEdge.ts
//
// **공개 트레이더의 발언에 우위가 있는가 — 순방향인가 역방향인가 없는가.**
//
// 이 파일이 하지 않는 일
// ─────────────────────
// 주문을 내지 않는다. 네트워크를 타지 않는다. 유튜브를 읽지 않는다.
// 여기 있는 것은 전부 순수 함수다 — 신호와 가격 경로를 받아 판정만 한다.
//
// 왜 그렇게 나눴나: "방송을 듣고 주문한다"를 한 번에 만들면 실패 지점이
// 너무 많다(음성 인식·방송 지연·농담·광고·과거 복기·시차). 그중 **판정
// 규칙만** 먼저 못 박아 두면, 나중에 수집기를 붙일 때 그 규칙이 이미
// 테스트로 고정돼 있다.
//
// `traderScore.ts`와 무엇이 다른가 — **판정을 두 벌로 만들지 않는다**
// ─────────────────────────────────────────────────────────────────
// 두 파일은 **서로 다른 질문**에 답한다. 같은 질문에 두 개의 답을 두면
// 한쪽만 고쳐지고, 그건 이 저장소에서 반복된 사고다.
//
//   traderScore.ts : "그 사람 말대로 했으면 어땠나"
//                    진입 신호 ~ 청산 신호 사이의 실제 가격 변화(%).
//                    비용도 지연도 없다 — 그 사람의 판단 자체를 잰다.
//
//   이 파일        : "따라가는 게 나은가, 반대가 나은가, 둘 다 아닌가"
//                    같은 신호를 양방향으로 돌려 **비용·지연을 물린** R
//                    기준으로 비교한다. 실제로 태울 수 있는가를 잰다.
//
// 그래서 승률 같은 이름이 겹쳐도 단위가 다르다(%가 아니라 R). 화면에
// 나란히 놓을 때 반드시 어느 쪽 숫자인지 적어야 한다.
//
// 이 파일이 막는 세 가지 착각
// ───────────────────────────
//
// 1. **"자주 틀리니까 반대로 하면 이긴다"**
//    아니다. 승률 40%의 반대가 승률 60%가 되지 않는다. 익절 +2% /
//    손절 -10%짜리 거래를 뒤집으면 익절 +10% / 손절 -2%가 되는 게 아니라
//    **양쪽 다 수수료와 슬리피지를 낸다.** 그래서 순방향·역방향이 **둘 다
//    마이너스**인 경우가 가장 흔하다. 이 시뮬레이터는 두 다리를 각각 돌려서
//    그 사실이 숫자로 나오게 한다 — 부호만 뒤집지 않는다.
//
// 2. **"결과를 보고 사람을 고르면 된다"**
//    아니다. 과거에 크게 잃은 사람을 먼저 고른 뒤 역매매 백테스트를 하면
//    당연히 좋아 보인다. 그건 예측력이 아니라 선택 편향이다. 그래서
//    `judgeCreator`는 **검증 구간(out-of-sample)에서도 같은 방향으로**
//    우위가 남아야만 판정을 내린다.
//
// 3. **"표본이 적어도 방향은 보인다"**
//    아니다. 표본이 적으면 `INSUFFICIENT_DATA`다. 그건 '우위 없음'과 다른
//    말이고, 다르게 말해야 한다 — 이 저장소의 규칙이 그렇다.
//    **확인하지 못한 것은 통과가 아니다.**

// ── 발언의 성격 ──────────────────────────────────────
//
// "비트는 언젠가 오를 것 같습니다"를 숏 신호로 읽으면 안 된다.
// 매매로 옮길 수 있는 것은 **지금 실제로 들어간다고 말한 것**뿐이다.
export type UtteranceKind =
  | 'EXPLICIT_ENTRY'   // 지금 진입했다/한다
  | 'OPINION'          // 분석 의견
  | 'LONG_TERM'        // 장기 전망
  | 'RECAP'            // 과거 거래 복기
  | 'QUESTION'         // 시청자 질문에 대한 가정
  | 'AD'               // 광고·협찬
  | 'JOKE'
  | 'UNKNOWN';

export interface CreatorSignal {
  creatorId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  /** 발언 시각 (epoch ms) */
  saidAtMs: number;
  kind: UtteranceKind;
  /** 말한 진입가. 없으면 null — 시장가로 본다 */
  entryPrice?: number | null;
  /** 말한 손절가. 없으면 null */
  stopLoss?: number | null;
  takeProfits?: number[];
  /** 추출기의 확신도 0~1 */
  confidence?: number;
}

export interface SignalGateResult {
  /** 모의매매에 태울 수 있는가 */
  tradeable: boolean;
  /** 왜 못 태우는가 / 무엇이 없는가 */
  reason: string;
  /** 없는 항목들 — 화면이 "무엇을 더 들어야 하는지" 말할 수 있게 */
  missing: string[];
}

export interface GateOptions {
  /** 이 값 미만이면 태우지 않는다. 기본 0.7 */
  minConfidence?: number;
  /**
   * 손절을 말하지 않아도 태울 것인가.
   *
   * 기본은 **false**다. 손절 없는 신호를 태우면 그 성과는 우리가 정한
   * 손절 정책의 성과이지 그 사람의 성과가 아니다 — 무엇을 재는지 흐려진다.
   */
  allowMissingStop?: boolean;
}

/**
 * 이 발언을 모의매매에 태울 수 있는가.
 *
 * **모르면 안 태운다.** 애매한 발언을 억지로 신호로 만들면, 그 사람의
 * 성과표가 우리 해석기의 성과표가 된다.
 */
export function gateSignal(s: CreatorSignal, opts: GateOptions = {}): SignalGateResult {
  const missing: string[] = [];

  if (!s || !s.creatorId) missing.push('creatorId');
  if (!s?.symbol) missing.push('symbol');
  if (s?.direction !== 'LONG' && s?.direction !== 'SHORT') missing.push('direction');
  if (!Number.isFinite(Number(s?.saidAtMs)) || Number(s?.saidAtMs) <= 0) missing.push('saidAtMs');

  if (missing.length) {
    return { tradeable: false, missing,
      reason: `신호에 필요한 값이 없습니다: ${missing.join(', ')}` };
  }

  if (s.kind !== 'EXPLICIT_ENTRY') {
    return {
      tradeable: false, missing: [],
      reason: `'${s.kind}'는 실제 진입 발언이 아닙니다 — 의견·전망·복기·광고를 `
            + '매매 신호로 세면 그 사람의 성과가 아니라 우리 해석기의 성과를 재게 됩니다',
    };
  }

  const minConf = opts.minConfidence ?? 0.7;
  const conf = Number(s.confidence);
  // 확신도를 **안 적었으면 모르는 것**이다. 1로 치지 않는다.
  if (!Number.isFinite(conf)) {
    return { tradeable: false, missing: ['confidence'],
      reason: '추출 확신도가 없습니다 — 확신도를 모르는 신호는 태우지 않습니다' };
  }
  if (conf < minConf) {
    return { tradeable: false, missing: [],
      reason: `추출 확신도 ${conf.toFixed(2)}가 기준 ${minConf}에 못 미칩니다` };
  }

  const sl = Number(s.stopLoss);
  if (!(Number.isFinite(sl) && sl > 0) && !opts.allowMissingStop) {
    return { tradeable: false, missing: ['stopLoss'],
      reason: '손절가를 말하지 않았습니다 — 우리가 손절을 정해 주면 그 성과는 '
            + '그 사람의 성과가 아니라 우리 손절 정책의 성과입니다' };
  }

  return { tradeable: true, missing: [], reason: '' };
}

// ── 짝 시뮬레이션 (순방향 · 역방향) ──────────────────

export interface PricePoint { t: number; price: number }

export interface SimConfig {
  /** 한쪽 수수료 %. 진입·청산 두 번 낸다 */
  feePctPerSide: number;
  /** 체결 미끄러짐 %. 양쪽 다 불리한 방향으로 적용한다 */
  slippagePct: number;
  /**
   * 발언에서 체결까지의 지연(초).
   *
   * 방송은 수십 초 늦게 나간다. 이걸 0으로 두면 **볼 수 없었던 가격에
   * 체결한 성과**가 나오고, 그건 언제나 실제보다 좋다.
   */
  delaySec: number;
  /** 최대 보유 시간(초). 넘으면 시장가 청산 */
  maxHoldSec: number;
  /** 손절을 말하지 않은 신호에 쓸 손절 거리 %. gateSignal이 기본적으로 막는다 */
  defaultStopPct?: number;
  /** 익절 거리 %. null이면 손절·시간만으로 끝낸다 */
  takePct?: number | null;
}

export type ExitReason = 'STOP' | 'TAKE' | 'TIME' | 'NO_DATA';

export interface Leg {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  exitReason: ExitReason;
  exitAtMs: number;
  /** 비용 차감 후 R 배수. R = 최초 위험거리 */
  rMultiple: number;
  /** 비용 차감 후 수익률 % (배율 미적용) */
  netPct: number;
}

export interface PairedResult {
  follow: Leg | null;
  inverse: Leg | null;
  /** 못 돌린 이유. 둘 다 null일 때만 채워진다 */
  skipped: string;
}

function firstAtOrAfter(path: PricePoint[], t: number): PricePoint | null {
  for (const p of path) if (p.t >= t) return p;
  return null;
}

function runLeg(
  side: 'LONG' | 'SHORT', entryRaw: number, entryAtMs: number,
  riskDist: number, takeDist: number | null,
  path: PricePoint[], cfg: SimConfig,
): Leg {
  const slipMul = cfg.slippagePct / 100;
  // 미끄러짐은 **언제나 불리한 쪽**이다. 진입은 나쁜 가격에, 청산도 나쁜 가격에.
  const entry = side === 'LONG' ? entryRaw * (1 + slipMul) : entryRaw * (1 - slipMul);
  const stop = side === 'LONG' ? entryRaw - riskDist : entryRaw + riskDist;
  const take = takeDist == null ? null
    : side === 'LONG' ? entryRaw + takeDist : entryRaw - takeDist;

  const deadline = entryAtMs + cfg.maxHoldSec * 1000;
  let exitRaw = entry;
  let exitReason: ExitReason = 'TIME';
  let exitAtMs = deadline;

  for (const p of path) {
    if (p.t < entryAtMs) continue;
    if (p.t > deadline) break;
    const hitStop = side === 'LONG' ? p.price <= stop : p.price >= stop;
    // **손절을 먼저 본다.** 같은 지점에서 둘 다 닿았다면 나쁜 쪽으로 센다 —
    // 어느 쪽이 먼저 닿았는지 모르는데 유리하게 읽으면 성과가 부풀려진다.
    if (hitStop) { exitRaw = stop; exitReason = 'STOP'; exitAtMs = p.t; break; }
    if (take != null) {
      const hitTake = side === 'LONG' ? p.price >= take : p.price <= take;
      if (hitTake) { exitRaw = take; exitReason = 'TAKE'; exitAtMs = p.t; break; }
    }
    exitRaw = p.price;
    exitAtMs = p.t;
  }

  const exit = side === 'LONG' ? exitRaw * (1 - slipMul) : exitRaw * (1 + slipMul);
  const gross = side === 'LONG' ? exit - entry : entry - exit;
  // 수수료는 진입·청산 두 번, 각 명목가에 붙는다.
  const fee = (entry + exit) * (cfg.feePctPerSide / 100);
  const net = gross - fee;

  return {
    side, entryPrice: entry, exitPrice: exit, exitReason, exitAtMs,
    rMultiple: riskDist > 0 ? net / riskDist : 0,
    netPct: entry > 0 ? (net / entry) * 100 : 0,
  };
}

/**
 * 같은 신호를 **순방향과 역방향으로 동시에** 돌린다.
 *
 * 두 다리에 **완전히 같은 조건**을 준다 — 같은 인식 시각, 같은 지연,
 * 같은 수수료, 같은 미끄러짐, 같은 위험거리, 같은 최대 보유시간.
 * 하나라도 다르면 비교가 성립하지 않는다.
 *
 * **역방향은 순방향의 부호 반전이 아니다.** 두 다리 모두 비용을 내고,
 * 각자의 손절·익절에 닿는다. 그래서 순방향이 -0.42R이어도 역방향이
 * +0.42R이 되지 않는다 — 둘 다 마이너스인 경우가 가장 흔하다.
 */
export function simulatePair(
  s: CreatorSignal, path: PricePoint[], cfg: SimConfig,
): PairedResult {
  const rows = (Array.isArray(path) ? path : [])
    .filter(p => p && Number.isFinite(Number(p.t)) && Number(p.price) > 0)
    .slice().sort((a, b) => a.t - b.t);

  if (rows.length === 0) {
    return { follow: null, inverse: null, skipped: '가격 경로가 없습니다' };
  }

  const enterAt = Number(s.saidAtMs) + cfg.delaySec * 1000;
  const first = firstAtOrAfter(rows, enterAt);
  if (!first) {
    // 발언 후 지연을 반영하면 데이터가 끝난 뒤다. 마지막 가격으로 채우면
    // 볼 수 없었던 체결이 된다 — 그냥 못 돌린 것으로 둔다.
    return { follow: null, inverse: null,
      skipped: `발언 ${cfg.delaySec}초 뒤의 가격이 없습니다 — 체결가를 지어내지 않습니다` };
  }
  const entryRaw = first.price;

  // 위험거리: 말한 손절가가 있으면 그걸 쓰고, 없으면 기본 %.
  // **양쪽 다리가 같은 거리를 쓴다.** 다르면 R이 서로 다른 단위가 된다.
  const sl = Number(s.stopLoss);
  let riskDist: number;
  if (Number.isFinite(sl) && sl > 0) {
    riskDist = Math.abs(entryRaw - sl);
  } else {
    const pct = Number(cfg.defaultStopPct);
    if (!(Number.isFinite(pct) && pct > 0)) {
      return { follow: null, inverse: null,
        skipped: '손절가도 기본 손절 %도 없어 위험거리를 정할 수 없습니다' };
    }
    riskDist = entryRaw * (pct / 100);
  }
  if (!(riskDist > 0)) {
    return { follow: null, inverse: null, skipped: '위험거리가 0입니다' };
  }

  const takeDist = cfg.takePct != null && Number(cfg.takePct) > 0
    ? entryRaw * (Number(cfg.takePct) / 100) : null;

  const opposite = s.direction === 'LONG' ? 'SHORT' : 'LONG';
  return {
    follow: runLeg(s.direction, entryRaw, first.t, riskDist, takeDist, rows, cfg),
    inverse: runLeg(opposite, entryRaw, first.t, riskDist, takeDist, rows, cfg),
    skipped: '',
  };
}

// ── 성과 집계 ────────────────────────────────────────

export interface Scored {
  n: number;
  /** 한 거래당 기대 R. 이 숫자 하나가 우위의 크기다 */
  expectancyR: number;
  winRate: number;
  /** 총이익 / 총손실. 손실이 0이면 null — Infinity를 성과로 적지 않는다 */
  profitFactor: number | null;
  /** 누적 R 곡선의 최대 낙폭 (R) */
  maxDrawdownR: number;
  totalR: number;
  /**
   * R의 표준편차. **기대값만으로는 우위를 말할 수 없다.**
   *
   * 기대값 +0.10R은 산포가 0.3R일 때와 3.0R일 때 전혀 다른 얘기다.
   * 앞은 실제 우위일 수 있고 뒤는 그냥 소음이다 — 표본이 20건이면
   * 후자는 우연히 그 값이 나올 확률이 흔하다.
   */
  stdevR: number;
  /**
   * 기대값의 표준오차 = stdevR / √n. null이면 계산할 수 없다(n<2).
   *
   * "이 우위가 우연일 수 있는가"를 재는 자다. 세그먼트를 잘게 쪼갤수록
   * n이 작아지고 이 값이 커진다 — 그게 잘게 쪼개는 일의 대가다.
   */
  stderrR: number | null;
}

export function scoreR(rs: number[]): Scored {
  const xs = (Array.isArray(rs) ? rs : []).filter(r => Number.isFinite(Number(r))).map(Number);
  if (xs.length === 0) {
    return { n: 0, expectancyR: 0, winRate: 0, profitFactor: null,
             maxDrawdownR: 0, totalR: 0, stdevR: 0, stderrR: null };
  }
  let total = 0, wins = 0, gain = 0, loss = 0, peak = 0, mdd = 0;
  for (const r of xs) {
    total += r;
    if (r > 0) { wins++; gain += r; } else { loss += -r; }
    if (total > peak) peak = total;
    const dd = peak - total;
    if (dd > mdd) mdd = dd;
  }
  // 표본표준편차(n-1). 모집단 공식(n)을 쓰면 작은 표본에서 산포를
  // 실제보다 작게 잡고, 그러면 우연한 우위가 통과한다.
  const mean = total / xs.length;
  let ss = 0;
  for (const r of xs) ss += (r - mean) * (r - mean);
  const sd = xs.length >= 2 ? Math.sqrt(ss / (xs.length - 1)) : 0;

  return {
    n: xs.length,
    expectancyR: mean,
    winRate: wins / xs.length,
    // 손실이 하나도 없으면 나눌 수 없다. Infinity를 적으면 화면이 그것을
    // '무한히 좋다'로 그리는데, 실제로는 표본이 부족한 것이다.
    profitFactor: loss > 0 ? gain / loss : null,
    maxDrawdownR: mdd,
    totalR: total,
    stdevR: sd,
    // n=1이면 산포를 말할 수 없다. 0을 적으면 "오차가 없다"가 되고,
    // 그건 한 건짜리 표본을 확실한 우위로 통과시킨다.
    stderrR: xs.length >= 2 ? sd / Math.sqrt(xs.length) : null,
  };
}

// ── 최종 판정 ────────────────────────────────────────

export type CreatorVerdict =
  | 'FOLLOW'
  | 'INVERSE'
  | 'NO_EDGE'
  | 'INSUFFICIENT_DATA';

export interface JudgeWindows {
  /** 규칙을 찾은 구간 */
  inSample: { follow: number[]; inverse: number[] };
  /** 규칙을 고정한 뒤 손대지 않은 구간. 여기서도 살아남아야 한다 */
  outOfSample: { follow: number[]; inverse: number[] };
}

export interface JudgeOptions {
  /** 학습 구간 최소 표본. 기본 100 */
  minInSample?: number;
  /** 검증 구간 최소 표본. 기본 30 */
  minOutOfSample?: number;
  /** 이 기대값(R)을 넘어야 우위로 본다. 기본 0.05 */
  minExpectancyR?: number;
}

export interface CreatorJudgement {
  verdict: CreatorVerdict;
  /** 사람이 읽는 근거 한 줄 */
  reason: string;
  inSample: { follow: Scored; inverse: Scored };
  outOfSample: { follow: Scored; inverse: Scored };
}

/**
 * 이 사람의 발언에 쓸 만한 우위가 있는가.
 *
 * **표본이 모자라면 '우위 없음'이 아니라 '모른다'다.** 둘을 같은 칸에
 * 넣으면, 아직 안 본 사람과 봤는데 우위가 없던 사람이 구별되지 않는다.
 *
 * **검증 구간에서 방향이 뒤집히면 판정하지 않는다.** 학습 구간에서만 좋은
 * 것은 그 구간을 보고 고른 결과일 수 있다 — 그게 이 방식의 가장 큰 함정이다.
 */
export function judgeCreator(w: JudgeWindows, opts: JudgeOptions = {}): CreatorJudgement {
  const minIn = opts.minInSample ?? 100;
  const minOut = opts.minOutOfSample ?? 30;
  const minE = opts.minExpectancyR ?? 0.05;

  const inS = { follow: scoreR(w?.inSample?.follow ?? []), inverse: scoreR(w?.inSample?.inverse ?? []) };
  const outS = { follow: scoreR(w?.outOfSample?.follow ?? []), inverse: scoreR(w?.outOfSample?.inverse ?? []) };
  const base = { inSample: inS, outOfSample: outS };

  if (inS.follow.n < minIn) {
    return { ...base, verdict: 'INSUFFICIENT_DATA',
      reason: `학습 구간 표본이 ${inS.follow.n}건입니다 (최소 ${minIn}건) — 아직 판정하지 않습니다` };
  }
  if (outS.follow.n < minOut) {
    return { ...base, verdict: 'INSUFFICIENT_DATA',
      reason: `검증 구간 표본이 ${outS.follow.n}건입니다 (최소 ${minOut}건) — `
            + '학습 구간만 보고 판정하면 그 구간을 보고 고른 결과가 됩니다' };
  }

  const followEdge = inS.follow.expectancyR >= minE && outS.follow.expectancyR >= minE;
  const inverseEdge = inS.inverse.expectancyR >= minE && outS.inverse.expectancyR >= minE;

  // 둘 다 우위로 나오면 무언가 잘못된 것이다 — 같은 신호를 양방향으로
  // 돌렸는데 둘 다 돈을 벌 수는 없다(비용을 내고 나면 더욱). 판정하지 않는다.
  if (followEdge && inverseEdge) {
    return { ...base, verdict: 'NO_EDGE',
      reason: '순방향과 역방향이 둘 다 우위로 나옵니다 — 비용을 반영하면 성립할 수 없는 결과라 '
            + '시뮬레이션 조건(지연·수수료·미끄러짐)을 먼저 확인해야 합니다' };
  }

  if (followEdge) {
    return { ...base, verdict: 'FOLLOW',
      reason: `순방향 기대값 ${inS.follow.expectancyR.toFixed(2)}R (학습) / `
            + `${outS.follow.expectancyR.toFixed(2)}R (검증) — 두 구간 모두 우위` };
  }
  if (inverseEdge) {
    return { ...base, verdict: 'INVERSE',
      reason: `역방향 기대값 ${inS.inverse.expectancyR.toFixed(2)}R (학습) / `
            + `${outS.inverse.expectancyR.toFixed(2)}R (검증) — 두 구간 모두 우위` };
  }

  // 학습에서만 좋았던 경우를 **따로 말한다.** 그냥 '우위 없음'으로 적으면
  // 왜 안 쓰는지가 안 남고, 나중에 같은 사람을 다시 후보로 올리게 된다.
  const flipped =
    (inS.follow.expectancyR >= minE && outS.follow.expectancyR < minE) ? '순방향' :
    (inS.inverse.expectancyR >= minE && outS.inverse.expectancyR < minE) ? '역방향' : '';

  return {
    ...base, verdict: 'NO_EDGE',
    reason: flipped
      ? `${flipped}이 학습 구간에서는 우위였지만 검증 구간에서 사라졌습니다 `
        + `(${(flipped === '순방향' ? outS.follow : outS.inverse).expectancyR.toFixed(2)}R) `
        + '— 구간을 보고 고른 결과였을 가능성이 큽니다'
      : `순방향 ${outS.follow.expectancyR.toFixed(2)}R / 역방향 ${outS.inverse.expectancyR.toFixed(2)}R `
        + '— 어느 쪽도 비용을 넘지 못합니다',
  };
}

/**
 * 화면에 적을 문구.
 *
 * **사람을 단정하지 않는다.** "항상 틀리는 사람", "반대로 하면 돈 버는
 * 사람" 같은 표현은 분쟁 위험이 있고, 무엇보다 **사실이 아니다** — 우리가
 * 가진 것은 특정 기간·특정 종목의 모의매매 표본이다.
 */
export function verdictLabel(v: CreatorVerdict): string {
  switch (v) {
    case 'FOLLOW':  return '관측 구간에서 순방향 우위';
    case 'INVERSE': return '관측 구간에서 역방향 우위';
    case 'NO_EDGE': return '현재 표본에서 통계적 우위 없음';
    default:        return '표본 부족 — 판정 보류';
  }
}

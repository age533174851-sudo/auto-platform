// src/lib/strategies/profileRisk.ts
// 프로필별(스캘핑/스윙/10슬롯) 모의 계좌를 완전히 격리해서 추적.
// 각 전략 계좌의 누적손익·최고자산(peak)·MDD·오늘 손실·킬스위치를 독립 관리.
// 저장 키를 profileId로 네임스페이스 → 서로 간섭 없음.

import type { StrategyType, StrategyProfile } from './profiles';
import { getProfile, simSeedOf } from './profiles';

/**
 * 한 **회차**의 기록.
 *
 * 회차란 "시드에서 시작해 목표에 닿거나 끝날 때까지"의 한 판이다. 목표가
 * 있는 프로필($100,000)은 목표에 닿으면 그 판이 끝나고 다음 판은 다시
 * 시드부터 시작한다. 그래야 "몇 번 만에 됐는가"를 셀 수 있다 — 누적손익
 * 한 줄만 있으면 열 판을 이겼는지 한 판이 길었는지 구분이 안 된다.
 */
export interface CycleRecord {
  n:            number;   // 몇 회차인가 (1부터)
  reached:      boolean;  // 목표에 닿았나
  reason:       string;   // 끝난 이유 (사람이 읽는 문장)
  trades:       number;
  wins:         number;
  startEquity:  number;
  endEquity:    number;
  simSeconds:   number;   // 이 판이 잡아먹은 모의 시간
  startedAt?:   number;   // 벽시계 (없을 수 있음)
  endedAt?:     number;
}

export interface ProfileRiskState {
  profileId:    StrategyType;
  realizedPnL:  number;   // 누적 실현손익
  peakEquity:   number;   // 최고 자산 (MDD 계산용)
  equity:       number;   // 현재 자산 (시드 + 실현손익)
  maxDrawdown:  number;   // 최대 낙폭 (%, 양수)
  dayKey:       string;   // 남겨 둔다 — 예전 저장분과의 호환용
  dayStartEquity: number; // 오늘 시작 자산
  dayPnL:       number;   // 오늘 손익
  killed:       boolean;  // 프로필 킬스위치 발동 여부
  killedReason?: string;
  tradeCount:   number;
  winCount:     number;

  // ── 언제 쌓인 표본인가 ──
  //
  // 이게 없어서 화면에 `누적손익 +21,764,179,181 · 표본 1002건`만 떴다.
  // 그 숫자가 **10일치 시뮬인지 반년치인지 알 수 없고**, 그러면 승률도
  // MDD도 해석할 수가 없다. 기간 없는 성적표는 성적표가 아니다.
  //
  // 예전에 저장된 상태에는 이 칸이 없다. **0이 아니라 undefined다** —
  // 0으로 채우면 1970년이 되고 화면이 '1970년부터'라고 적는다.
  firstTradeAt?: number;
  lastTradeAt?:  number;

  // ── 모의 시계 ──
  //
  // 벽시계로는 1000건이 1초다. 그러면 전부 같은 날이 되어 하루 손실
  // 한도가 12건쯤에서 차고 영영 안 풀린다. 실제로는 며칠에 걸쳐 나눠
  // 일어날 일인데도. 그래서 시뮬은 자기 시계를 따로 돌린다.
  //
  // **표본 기간도 이 시계로 적는다.** 벽시계로 적으면 시작과 끝이 같은
  // 시각이 되어 "26. 8. 3. 오후 10:05 ~ 26. 8. 3. 오후 10:05"가 나온다.
  // 그건 기간이 아니다.
  simSeconds:   number;   // 이 회차가 지금까지 잡아먹은 모의 시간
  simDay:       number;   // floor(simSeconds / 86400)

  // ── 회차 ──
  cycleNo:      number;   // 지금 돌고 있는 회차 (1부터)
  /**
   * 계좌가 스스로 들고 있는 회차 기록.
   *
   * **화면이 읽는 성적표는 이쪽이 아니라 roundLedger다.** 장부는 회차
   * 모드(독립/연속 복리)별로 나뉘어 있고 투입한 돈을 세는데, 이 칸은
   * 그 구분이 없다. 여기를 화면에 그리면 두 모드의 결과가 한 줄에
   * 섞인다.
   *
   * 그래도 남겨 두는 이유는 예전 저장분과 계좌 자체의 이력 때문이고,
   * 두 곳이 갈리지 않도록 roundLedger.test에서 개수를 맞춰 본다.
   */
  cycles:       CycleRecord[];

  /**
   * 이 회차를 **얼마에서 시작했나.**
   *
   * 없으면 시드다. 연속 복리 모드에서는 이전 회차가 끝난 잔고에서
   * 이어 시작하므로 시드와 다르다. 이 칸이 없으면 `equity = 시드 +
   * 누적손익`이 되어, 이어받은 잔고가 조용히 시드로 되감긴다 —
   * 화면에는 '연속 복리'라고 적힌 채로.
   *
   * **없는 것을 0으로 읽지 않는다.** 0으로 채우면 계좌가 0에서
   * 시작한 것이 된다.
   */
  roundStartEquity?: number;
}

const DAY_SEC = 86_400;
const key = (id: StrategyType) => `tg_profile_risk_${id}_v2`;
const todayKey = () => new Date().toISOString().slice(0, 10);

/**
 * 저장소.
 *
 * 브라우저에서는 localStorage, 그 밖(테스트·서버 렌더)에서는 메모리.
 * 예전에는 window가 없으면 저장이 통째로 사라져서 **테스트가 아무것도
 * 확인할 수 없었다** — 무엇을 넣든 다음 읽기가 fresh()를 돌려줬으니까.
 * 검증할 수 없는 코드는 검증되지 않은 코드다.
 */
const mem = new Map<string, string>();
function store(): { get(k: string): string | null; set(k: string, v: string): void } {
  if (typeof window !== 'undefined' && window.localStorage) {
    return {
      get: k => { try { return window.localStorage.getItem(k); } catch { return mem.get(k) ?? null; } },
      set: (k, v) => { try { window.localStorage.setItem(k, v); } catch { mem.set(k, v); } },
    };
  }
  return { get: k => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v); } };
}

/** 테스트에서 계좌를 깨끗하게 만들기 위한 것. 브라우저 동작에는 영향 없음. */
export function __clearProfileRiskMemory() { mem.clear(); }

function seedOf(id: StrategyType): number {
  return simSeedOf(getProfile(id));
}

function fresh(
  id: StrategyType, cycleNo = 1, cycles: CycleRecord[] = [], startEquity?: number,
): ProfileRiskState {
  const seed = Number.isFinite(startEquity as number) && (startEquity as number) > 0
    ? (startEquity as number)
    : seedOf(id);
  return {
    profileId: id, realizedPnL: 0, peakEquity: seed, equity: seed,
    maxDrawdown: 0, dayKey: todayKey(), dayStartEquity: seed, dayPnL: 0,
    killed: false, tradeCount: 0, winCount: 0,
    simSeconds: 0, simDay: 0,
    cycleNo, cycles,
    roundStartEquity: seed,
  };
}

/**
 * 이 회차의 시작 잔고. 예전 저장분에는 이 칸이 없으므로 시드로 본다.
 *
 * **0을 유효한 값으로 받지 않는다** — 0에서 시작한 회차라는 것은
 * 없고, 있으면 그건 칸이 비었다는 뜻이다.
 */
function baseOf(s: ProfileRiskState, id: StrategyType): number {
  const v = Number(s?.roundStartEquity);
  return Number.isFinite(v) && v > 0 ? v : seedOf(id);
}

/** 예전 저장분에는 없던 칸을 채운다. **없는 것을 0으로 읽지 않는다** — 시각은
 *  undefined로 두고, 배열·카운터만 안전한 기본값을 준다. */
function normalize(s: ProfileRiskState, id: StrategyType): ProfileRiskState {
  s.profileId = id;
  if (!Number.isFinite(s.simSeconds)) s.simSeconds = 0;
  if (!Number.isFinite(s.simDay)) s.simDay = Math.floor(s.simSeconds / DAY_SEC);
  if (!Number.isFinite(s.cycleNo) || s.cycleNo < 1) s.cycleNo = 1;
  if (!Array.isArray(s.cycles)) s.cycles = [];
  return s;
}

export function loadProfileRisk(id: StrategyType): ProfileRiskState {
  try {
    const raw = store().get(key(id));
    if (!raw) return fresh(id);
    return normalize(JSON.parse(raw) as ProfileRiskState, id);
  } catch { return fresh(id); }
}

function save(s: ProfileRiskState) {
  try { store().set(key(s.profileId), JSON.stringify(s)); } catch {}
}

/**
 * 트레이드 청산 결과를 프로필 계좌에 반영 → 모의 시계·MDD·일손실·킬스위치 갱신.
 *
 * `holdSec`은 이 거래가 잡아먹은 **모의 시간**이다. 0을 주면 시계가 안
 * 돌고, 그러면 하루 손실 한도가 영영 안 풀린다.
 */
export interface TradeLimits {
  /**
   * 하루 손실 한도(%). 없으면 프로필 표의 값.
   *
   * 프리셋이 이 값을 좁힌다. 여기로 안 넘기면 화면에는 '하루 -5%'라고
   * 적혀 있는데 실제로는 -30%까지 돈다.
   */
  dailyLossLimitPct?: number;
  /**
   * 낙폭 중단선(%). 없으면 중단하지 않는다.
   *
   * 하루 한도는 '오늘'만 막는다. 며칠에 걸쳐 천천히 무너지는 것은
   * 하루 한도에 안 걸린다 — 그래서 축이 하나 더 있어야 한다.
   */
  mddStopPct?: number | null;
}

export function recordProfileTrade(
  id: StrategyType, pnl: number, holdSec = 0, limits: TradeLimits = {},
): ProfileRiskState {
  const s = loadProfileRisk(id);

  // 1) 모의 시계를 먼저 돌린다. 날이 바뀌었으면 **이 거래의 손익을 반영하기
  //    전에** 하루를 리셋해야 한다 — 반영한 뒤에 리셋하면 오늘 첫 거래의
  //    손익이 어제 것으로 들어간다.
  if (holdSec > 0) {
    s.simSeconds += holdSec;
    const day = Math.floor(s.simSeconds / DAY_SEC);
    if (day !== s.simDay) {
      s.simDay = day;
      s.dayStartEquity = s.equity;
      s.dayPnL = 0;
      if (s.killed && s.killedReason && s.killedReason.includes('일손실')) {
        s.killed = false; s.killedReason = undefined;
      }
    }
  }

  // 2) 손익 반영
  s.realizedPnL += pnl;
  s.equity = baseOf(s, id) + s.realizedPnL;
  s.dayPnL = s.equity - s.dayStartEquity;
  s.tradeCount += 1;
  if (pnl > 0) s.winCount += 1;

  const nowMs = Date.now();
  if (s.firstTradeAt == null) s.firstTradeAt = nowMs;
  s.lastTradeAt = nowMs;

  if (s.equity > s.peakEquity) s.peakEquity = s.equity;
  const dd = s.peakEquity > 0 ? (s.peakEquity - s.equity) / s.peakEquity * 100 : 0;
  if (dd > s.maxDrawdown) s.maxDrawdown = dd;

  // 3) 일손실 한도 초과 → 이 프로필만 킬스위치 (다른 프로필은 영향 없음)
  const prof = getProfile(id);
  const dayLimit = Number.isFinite(limits.dailyLossLimitPct as number) && (limits.dailyLossLimitPct as number) > 0
    ? (limits.dailyLossLimitPct as number)
    : prof.dailyLossLimitPct;
  const dayLossPct = s.dayStartEquity > 0 ? (s.dayStartEquity - s.equity) / s.dayStartEquity * 100 : 0;
  if (dayLossPct >= dayLimit) {
    s.killed = true;
    s.killedReason = `일손실 한도 초과 (-${dayLossPct.toFixed(1)}% ≥ ${dayLimit}%)`;
  }

  // 4) 낙폭 중단선. **사유에 '일손실'이 안 들어간다** — 들어가면 다음
  //    모의 하루에 자동으로 풀린다. 낙폭은 날이 바뀐다고 회복되지 않는다.
  const mddStop = Number(limits.mddStopPct);
  if (Number.isFinite(mddStop) && mddStop > 0 && s.maxDrawdown >= mddStop) {
    s.killed = true;
    s.killedReason = `낙폭 중단선 도달 (-${s.maxDrawdown.toFixed(1)}% ≥ ${mddStop}%)`;
  }
  save(s);
  return s;
}

/**
 * 모의 시계를 다음 날 0시로 넘긴다.
 *
 * 하루 한도에 걸려 멈췄을 때 실제로 일어나는 일이다 — 그날은 쉬고 다음
 * 날 다시 시작한다. 이걸 안 하면 시뮬이 첫날 한도에서 영영 멈춘 채로
 * "이 전략은 12건밖에 못 돈다"는 틀린 결론을 준다.
 */
export function skipToNextSimDay(id: StrategyType): ProfileRiskState {
  const s = loadProfileRisk(id);
  const day = Math.floor(s.simSeconds / DAY_SEC);
  s.simSeconds = (day + 1) * DAY_SEC;
  s.simDay = day + 1;
  s.dayStartEquity = s.equity;
  s.dayPnL = 0;
  if (s.killed && s.killedReason && s.killedReason.includes('일손실')) {
    s.killed = false; s.killedReason = undefined;
  }
  save(s);
  return s;
}

/** 이 프로필에 목표 금액이 있나. 없으면 null. */
export function simTargetOf(p: StrategyProfile): number | null {
  return p.simTargetEquity > 0 ? p.simTargetEquity : null;
}

/** 목표에 닿았나. 목표가 없으면 언제나 false. */
export function targetReached(s: ProfileRiskState, p: StrategyProfile): boolean {
  const t = simTargetOf(p);
  return t != null && s.equity >= t;
}

/**
 * 한 회차를 끝내고 기록한다. 계좌는 시드로 돌아가고 회차 번호가 하나 오른다.
 *
 * 기록이 남는다는 게 핵심이다. 계좌만 리셋하면 "몇 번 만에 됐는지"가
 * 사라진다 — 그게 이 시뮬에서 알고 싶은 거의 유일한 것인데도.
 */
export function completeCycle(
  id: StrategyType, reason: string, reached: boolean, nextStartEquity?: number,
): ProfileRiskState {
  const s = loadProfileRisk(id);
  const rec: CycleRecord = {
    n: s.cycleNo,
    reached,
    reason,
    trades: s.tradeCount,
    wins: s.winCount,
    // **시드가 아니라 이 회차가 실제로 시작한 금액이다.** 연속 복리에서
    // 시드를 적으면 이어받은 판이 전부 "1,000에서 시작했다"고 남는다.
    startEquity: baseOf(s, id),
    endEquity: s.equity,
    simSeconds: s.simSeconds,
    startedAt: s.firstTradeAt,
    endedAt: s.lastTradeAt,
  };
  const next = fresh(id, s.cycleNo + 1, [...s.cycles, rec], nextStartEquity);
  save(next);
  return next;
}

/** 이 회차의 시작 잔고 (읽기용) */
export function roundStartEquityOf(s: ProfileRiskState, id: StrategyType): number {
  return baseOf(s, id);
}

/** 이 회차의 손익 = 지금 잔고 − 이 회차가 시작한 금액 */
export function roundPnlOf(s: ProfileRiskState, id: StrategyType): number {
  return s.equity - baseOf(s, id);
}

/** 지정한 금액에서 새 회차를 시작한다 (연속 복리에서 이어받을 때) */
export function startRoundAt(id: StrategyType, startEquity: number): ProfileRiskState {
  const cur = loadProfileRisk(id);
  const s = fresh(id, cur.cycleNo, cur.cycles, startEquity);
  save(s);
  return s;
}

// 신규 진입 가능 여부 (프로필 킬스위치 확인) — 다른 프로필과 독립
export function canProfileEnter(id: StrategyType): { allowed: boolean; reason?: string } {
  const s = loadProfileRisk(id);
  if (s.killed) return { allowed: false, reason: s.killedReason || '프로필 킬스위치 발동' };
  return { allowed: true };
}

export function resetProfileKill(id: StrategyType): ProfileRiskState {
  const s = loadProfileRisk(id);
  s.killed = false; s.killedReason = undefined;
  save(s);
  return s;
}

/**
 * 지금 회차의 계좌만 처음으로. **회차 기록은 남긴다** — 지우려면 clearCycles.
 *
 * `startEquity`를 주면 거기서 다시 시작한다. 연속 복리에서 이 값을 안
 * 주면 이어받은 잔고가 시드로 되감기고, 그러면 '현재 회차 초기화'가
 * 조용히 '독립 회차로 바꾸기'가 된다.
 */
export function resetProfileRisk(id: StrategyType, startEquity?: number): ProfileRiskState {
  const cur = loadProfileRisk(id);
  const s = fresh(id, cur.cycleNo, cur.cycles, startEquity);
  save(s);
  return s;
}

/** 회차 기록까지 통째로 지운다. 1회차부터 다시 센다. */
export function clearCycles(id: StrategyType): ProfileRiskState {
  const s = fresh(id, 1, []);
  save(s);
  return s;
}

export function winRate(s: ProfileRiskState): number {
  return s.tradeCount > 0 ? (s.winCount / s.tradeCount) * 100 : 0;
}

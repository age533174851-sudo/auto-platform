// src/lib/engine/exitCoverage.ts
//
// **어느 전략의 포지션을 청산 감시가 실제로 보는가.**
//
// 왜 이 파일이 필요한가
// ─────────────────────
// `/api/autotrade/exit-monitor`는 `decideExits`가 준 목록만 본다.
// 그 함수가 읽는 표는 `ladder_daily_trades` 하나이고, 그건 계단식
// 전용 표다(`ladderGate.ts` 말고는 아무도 안 쓴다).
//
// 그래서 트레일링 · 본전 이동 · 시간 청산 · 포지션 점검은 **계단식에만**
// 붙어 있다. 그런데 응답에는 `checked` · `actionable` 숫자만 있어서,
// 다른 전략이 아예 목록에 오르지 않은 것과 **볼 것이 없었던 것**이
// 구분되지 않았다. 화면에는 "청산 감시 정상"이 떠 있었다.
//
// **UNKNOWN을 0으로 적지 않는다**는 이 저장소의 규칙이 여기에도 그대로
// 적용된다. 안 보는 것은 "이상 없음"이 아니다.
//
// 이 표는 지우기 위한 것이다
// ──────────────────────────
// 목표는 모든 칸이 true가 되어 이 파일이 사라지는 것이다. 그때까지는
// **비어 있는 칸이 응답과 화면에 그대로 보여야** 한다.

import { STRATEGIES, type StrategyId } from '../strategies/registry';
import { lifecyclePolicyOf } from '../strategies/lifecyclePolicy';
import type { SeatExitCapabilities } from './managedPosition';
import { managedCandidates, type OrderRowLike } from './managedPosition';
import { OPEN_COMBOS, type OpenCombo } from '../execution/dormantGate';
import { resolveExecutionProfile } from '../execution/profile';
import { exact100xExitVenueCapability } from './exitAuthority';
import type { StopPolicy } from '../strategies/profiles';

/** 청산 감시가 열린 포지션 목록을 읽는 표 */
export const EXIT_MONITOR_SOURCE_TABLE = 'ladder_daily_trades';

export interface ExitCoverage {
  strategyId: StrategyId | string;
  name: string;
  /**
   * 이 줄이 말하는 **손절 계약**.
   *
   * `null`은 실행 계약을 쓰지 않는 기존 예약이다(장부의 `stop_policy`가
   * 비어 있는 옛 줄). `NO_FIXED_SL`과 null은 다르다 — 앞은 "안 걸기로
   * 정한 것"이고 뒤는 "정책을 적지 않던 시절"이다.
   */
  stopPolicy: StopPolicy | null;
  /** 실행 계약으로만 열리는 조합이면 그 신원. 기본 계약이면 null */
  contract: { profileId: string; presetId: string; contractVersion: number } | null;
  /** 사람이 읽는 계약 이름 */
  contractLabel: string;
  /** 진입 시점에 거래소 손절·익절을 거는가 (orderExecutor 공통 경로) */
  protectiveOrdersAtEntry: boolean;
  /** 트레일링 손절 */
  trailing: boolean;
  /** 본전 이동 */
  breakEven: boolean;
  /** 최대 보유 기간 초과 시 시간 청산 */
  timeExit: boolean;
  /** 청산가 근접 · 손절 소실 · 마진 모드 변경 감시 */
  positionGuard: boolean;
  /** 포지션 0 확인 뒤 남은 보호주문 제거 — 감시 주기마다 */
  orphanSweep: boolean;
  /** 빈 칸의 이유. 전부 채워졌으면 null */
  gap: string | null;
}

/**
 * 지금 코드가 실제로 하는 일.
 *
 * **여기에 희망을 적지 않는다.** 이 값은 `/api/autotrade/exit-monitor`와
 * `/api/system/runtime-health` 응답에 그대로 실린다 — 적어 놓은 것과
 * 코드가 갈리면 그 화면이 거짓말을 한다.
 */
/** 계약 축(stopPolicy·contract·contractLabel)을 뺀 감시 깃발만 */
type MonitorFlags = Omit<ExitCoverage, 'strategyId' | 'name' | 'stopPolicy' | 'contract' | 'contractLabel'>;

const BY_MONITOR: Record<string, MonitorFlags> = {
  'daily-ladder': {
    protectiveOrdersAtEntry: true,
    trailing: true, breakEven: true, timeExit: true, positionGuard: true,
    orphanSweep: true,
    gap: null,
  },
  // ── 아래 둘은 `live_orders`를 원천으로 하는 생명주기 경로가 담당한다 ──
  //
  // managedPosition → 거래소 readback → 소유권 → lifecyclePolicy →
  // lifecycleDecide. 계단식 표에 줄이 없어도 감시된다.
  //
  // **표를 손으로 true로 바꾸지 않는다.** 정책이 선언돼 있는지를 코드에
  // 물어서 정한다 — 정책을 지우면 이 칸도 같이 false가 된다.
  scalp: lifecycleBacked('scalp'),
  'my-original-v1': lifecycleBacked('my-original-v1'),
};

/**
 * 생명주기 경로가 담당하는 전략의 커버리지.
 *
 * **희망을 적지 않는다.** `lifecyclePolicyOf`가 실제로 값을 갖고 있을
 * 때만 true다. 정책이 없으면 `lifecycleDecide`가 `NO_POLICY`로 아무것도
 * 하지 않으므로, 표도 그대로 false여야 한다.
 */
function lifecycleBacked(id: string): MonitorFlags {
  const p = lifecyclePolicyOf(id);
  const trailing = !!(p && p.trailStartR != null && p.trailDistanceR != null);
  const breakEven = !!(p && p.breakEvenR != null);
  const timeExit = !!(p && p.maxHoldMs != null);
  const missing: string[] = [];
  if (!trailing) missing.push('트레일링');
  if (!breakEven) missing.push('본전이동');
  if (!timeExit) missing.push('시간청산');
  return {
    protectiveOrdersAtEntry: true,
    trailing, breakEven, timeExit,
    // 포지션 확인(열림/닫힘·소유권)은 생명주기 경로가 매 주기 한다.
    positionGuard: !!p,
    orphanSweep: true,
    gap: missing.length
      ? `생명주기 정책에 ${missing.join('·')} 값이 없어 그 항목은 돌지 않습니다`
      : null,
  };
}

/**
 * 모르는 전략은 **덮이는 것으로 치지 않는다.**
 *
 * 새 전략을 레지스트리에 넣고 이 표를 안 고치면, 조용히 "전부 true"가
 * 되는 대신 전부 false로 보이고 이유가 남는다. 그게 이 저장소가 반복해서
 * 당한 "만들어 놓고 배선을 안 함"을 눈에 보이게 하는 유일한 방법이다.
 */
const UNDECLARED: MonitorFlags = {
  protectiveOrdersAtEntry: false,
  trailing: false, breakEven: false, timeExit: false, positionGuard: false,
  orphanSweep: false,
  gap: '청산 감시 표(exitCoverage.ts)에 이 전략이 없습니다 — 무엇이 도는지 아무도 적지 않았습니다',
};

// ── 계약 축 ───────────────────────────────────────────────
//
// **전략 하나에 계약이 둘일 수 있다.**
//
// `scalp`은 기본 예약으로도 돌고, 실행 계약(`MAX_LEV_100X`/`EXACT_100X`)
// 으로도 돈다. 그런데 이 표는 전략 단위라 `scalp` 한 줄만 있었고, 그 줄은
// `lifecyclePolicyOf('scalp')`가 값을 가졌다는 이유로 트레일링·본전이동·
// 시간청산을 **전부 true**로 적었다.
//
// `NO_FIXED_SL` 계약의 포지션에는 그 중 **하나도 돌지 않는다.** 자리 전체가
// 유예되어 `exit-monitor`의 관리 관문에서 회차가 끊기기 때문이다. 표는
// 초록인데 실제로는 사람이 손으로 닫는 것 말고 종료 수단이 없었다 —
// 이 파일 머리말의 "여기에 희망을 적지 않는다"를 그대로 어기고 있었다.
//
// **판단을 여기에 다시 적지 않는다**
// ─────────────────────────────────
// "NO_FIXED_SL이면 유예"라고 이 표에 적으면 `managedPosition`과 두 벌이
// 되고, 언젠가 한쪽만 고쳐진다. 그래서 **분류기에게 직접 묻는다** —
// 탐침 줄 하나를 `managedCandidates`에 넣고 어디로 가는지 본다.
// 분류 규칙이 바뀌면 이 표도 자동으로 따라간다.
//
// 탐침이 분류되지 않으면 **true로 넘기지 않는다.** 모르는 것은 통과가
// 아니므로 커버리지 0으로 적고 이유를 남긴다.

/** 탐침 줄이 실재하는 노출로 읽히도록 채우는 최소 칸 */
const PROBE_ROW = {
  id: '(probe)',
  status: 'FILLED',
  connection_id: '(probe-connection)',
  exchange: 'binance',
  symbol: 'PROBEUSDT',
  side: 'BUY',
  avg_price: 100,
  acked_at: '1970-01-01T00:00:00.000Z',
  strategy_id: '(probe-strategy)',
} as const;

/**
 * 이 계약의 노출에 **전용 종료 권한이 무엇을 열어 두었는가.**
 *
 * **표에 손으로 적지 않는다.** `managedCandidates`에 탐침 줄을 넣고
 * 분류기가 실제로 올려 주는 후보의 `capabilities`를 그대로 읽는다.
 * 배선을 끊으면 이 값도 같이 false가 된다 — 표가 거짓말하지 않는다.
 */
export function authorityCapabilitiesOf(
  stopPolicy: StopPolicy | null,
  identity: { profileId: string; presetId: string; contractVersion: number } | null,
): { admitted: boolean; capabilities: SeatExitCapabilities } {
  const row: OrderRowLike = {
    ...PROBE_ROW,
    stop_policy: stopPolicy,
    stop_loss: stopPolicy === 'NO_FIXED_SL' ? null : 99,
    ...(identity ? {
      execution_profile_id: identity.profileId,
      execution_preset_id: identity.presetId,
      execution_contract_version: identity.contractVersion,
    } : {}),
  };
  const r = managedCandidates([row]);
  const c = (r.authorityCandidates ?? [])[0];
  if (!c) {
    return {
      admitted: false,
      capabilities: { fixedStopAtEntry: false, breakEven: false, trailing: false,
                      timeExit: false, emergency: false },
    };
  }
  return { admitted: true, capabilities: c.capabilities };
}

export interface LifecycleAdmission {
  admitted: boolean;
  /** 분류기가 돌려준 코드. 통과면 'MANAGED' */
  code: string;
  reason: string;
}

/**
 * 이 손절 계약의 포지션이 **일반 생명주기에 들어가는가.**
 *
 * `managedCandidates`가 정본이고 여기서는 묻기만 한다.
 */
export function genericLifecycleAdmission(stopPolicy: StopPolicy | null): LifecycleAdmission {
  const row: OrderRowLike = {
    ...PROBE_ROW,
    // `stop_policy`를 **안 적는 것**과 `null`로 적는 것은 분류기에게 같다
    // (옛 줄). 계약이 있으면 그 이름을 그대로 넘긴다.
    stop_policy: stopPolicy,
    // `NO_FIXED_SL`은 **손절 값이 없는 것이 계약**이다. 나머지 계약에는
    // 계약이 약속한 손절이 들어 있는 상태를 넣는다 — 값이 빠진 경우는
    // 계약의 성질이 아니라 고쳐야 할 사고이고, 그건 다른 줄이 말한다.
    stop_loss: stopPolicy === 'NO_FIXED_SL' ? null : 99,
  };

  const r = managedCandidates([row]);
  if (r.positions.length === 1) {
    return { admitted: true, code: 'MANAGED', reason: '' };
  }
  const d = r.deferred[0];
  if (d) return { admitted: false, code: d.code, reason: d.reason };
  const sk = r.skipped[0];
  if (sk) return { admitted: false, code: sk.code, reason: sk.reason };
  // **모르는 것을 통과로 적지 않는다.**
  return {
    admitted: false, code: 'UNCLASSIFIED',
    reason: '분류기가 이 계약의 탐침 줄을 관리·유예·건너뜀 어디에도 넣지 않았습니다'
      + ' — 표가 무엇을 말해야 할지 알 수 없습니다',
  };
}

/**
 * 실행 계약으로만 열리는 조합의 커버리지 줄.
 *
 * **조합 목록은 `dormantGate`가 정본이다.** 여기에 손으로 적으면 조합을
 * 하나 더 열었을 때 이 표가 조용히 그 조합을 빠뜨린다 — 지금 고치는
 * 고장이 정확히 그 형태다.
 */
function contractRows(baseStrategyIds: Set<string>, open: readonly OpenCombo[]): ExitCoverage[] {
  const out: ExitCoverage[] = [];
  for (const c of open) {
    if (!baseStrategyIds.has(c.strategyId)) continue;
    const r = resolveExecutionProfile(c.profileId, c.presetId, c.contractVersion);
    if (!r.ok || !r.contract) continue;
    const policy = r.contract.stopPolicy;
    // 기본 계약과 같은 거동이면 줄을 늘릴 이유가 없다.
    if (policy !== 'NO_FIXED_SL') continue;

    const adm = genericLifecycleAdmission(policy);
    // ★ **전용 종료 권한이 실제로 무엇을 여는지 분류기에게 묻는다.**
    //   표에 손으로 `true`를 적으면 배선을 끊어도 화면은 초록으로 남는다.
    const auth = authorityCapabilitiesOf(policy, {
      profileId: c.profileId, presetId: c.presetId, contractVersion: c.contractVersion,
    });
    // ★ **거래소 범위를 문장으로 적되, 목록을 손으로 적지 않는다.**
    //   표는 거래소 칸이 없어서 "어디서나 시간 청산이 된다"로 읽힌다.
    //   그건 사실이 아니다 — 전용 권한은 지금 binance에서만 돈다.
    //   목록은 정본(`exact100xExitVenueCapability`)에서 derive한다. 여기에
    //   'binance'라고 적으면 Gate를 열 때 이 줄만 옛말로 남는다.
    const venues = (['binance', 'gate'] as const)
      .filter(x => exact100xExitVenueCapability(x).timeExit);
    const venueNote = venues.length
      ? `전용 종료 권한은 ${venues.join('·')} 실행 venue에서만 돕니다`
      : '전용 종료 권한을 지원하는 실행 venue가 없습니다';
    const strat = STRATEGIES.find(s => s.id === c.strategyId);
    const label = `${c.profileId} · ${c.presetId} v${c.contractVersion}`;
    // 계약이 선언한 보유 한도와, 그 값을 **실제로 읽는 경로가 있는가.**
    const holdH = Number(r.contract.maxHoldSec) > 0
      ? Math.round(Number(r.contract.maxHoldSec) / 3600) : null;
    const declaredHold = holdH == null
      ? '계약에 최대 보유 한도가 없습니다'
      : auth.capabilities.timeExit
        ? `계약이 선언한 최대 보유 ${holdH}시간을 전용 종료 권한이 읽어 시간 청산을 돌립니다`
        : `계약은 최대 보유 ${holdH}시간을 선언하지만 청산 경로가 그 값을 읽지 않습니다`;

    out.push({
      strategyId: c.strategyId,
      name: strat?.name ?? c.strategyId,
      stopPolicy: policy,
      contract: { profileId: c.profileId, presetId: c.presetId, contractVersion: c.contractVersion },
      contractLabel: label,
      // **계약상 안 거는 것**이다. 고쳐야 할 빈 칸이 아니다.
      protectiveOrdersAtEntry: auth.capabilities.fixedStopAtEntry,
      // ★ 셋 다 **분류기에서 derive한다.** 손으로 적지 않는다.
      trailing: auth.capabilities.trailing,
      breakEven: auth.capabilities.breakEven,
      timeExit: auth.capabilities.timeExit,
      // 전용 권한이 매 회차 거래소 노출을 다시 읽는다.
      positionGuard: adm.admitted || auth.capabilities.timeExit,
      // 고아 보호주문 정리는 적어 둔 번호로만 하므로 자리 유예와 무관하게 돈다.
      orphanSweep: true,
      gap: adm.admitted
        // 분류기가 통과시키는데 표가 false면 둘이 갈린 것이다. 숨기지 않는다.
        ? '분류기는 이 계약을 일반 생명주기에 넣는데 이 표는 아니라고 적고 있습니다'
          + ' — 둘 중 하나가 틀렸습니다'
        : auth.capabilities.timeExit
          // 전용 권한이 **시간 청산 하나만** 연 상태. 나머지가 없다는 것을
          // 그대로 적는다 — 하나가 열렸다고 "종료가 된다"로 적지 않는다.
          ? `고정 손절을 걸지 않는 계약입니다(의도). 일반 생명주기는 ${adm.code}로`
            + ` 유예되고, 전용 종료 권한이 **시간 청산만** 돌립니다.`
            + ` ${declaredHold}. 트레일링·본전이동·adverse/청산여유 비상 종료는`
            + ` 아직 없습니다 — 보유 한도 전에 불리하게 움직이면 자동으로 닫히지`
            + ` 않습니다. ${venueNote}.`
          : `고정 손절을 걸지 않는 계약입니다(의도). 그리고 ${adm.code}로 자리 전체가`
            + ` 일반 생명주기에서 유예되어 트레일링·본전이동·시간청산이 하나도 돌지`
            + ` 않습니다 — 지금 이 계약의 종료 수단은 사람이 직접 닫는 것뿐입니다.`
            + ` ${declaredHold}. (${adm.reason})`,
    });
  }
  return out;
}

/**
 * 실행 경로가 있는 전략의 청산 감시 커버리지.
 *
 * @param open 열린 조합. **시험·검사기가 주입한다.** 안 주면 정본을 쓴다 —
 *   `executionGateVerdict`가 쓰는 것과 같은 관용구다. 주입을 받아야
 *   "표를 정말 읽는가"를 바깥에서 확인할 수 있다. 이름만 보는 검사는
 *   손으로 적은 목록을 잡지 못한다(실제로 그 변이가 새 나갔다).
 */
export function exitCoverage(open: readonly OpenCombo[] = OPEN_COMBOS): ExitCoverage[] {
  const base = STRATEGIES
    .filter(s => s.executionReady)
    .map(s => ({
      strategyId: s.id,
      name: s.name,
      // 기본 예약의 줄에는 `stop_policy`가 비어 있다 — `FIXED_SL`이라고
      // 적으면 "안 적던 시절의 줄"을 "고정 손절을 쓰기로 정한 줄"로
      // 바꿔 읽게 된다.
      stopPolicy: null as StopPolicy | null,
      contract: null,
      contractLabel: '기본 예약 (실행 계약 없음)',
      ...(BY_MONITOR[s.id] ?? UNDECLARED),
    }));
  return [...base, ...contractRows(new Set(base.map(b => b.strategyId)), open)];
}

/** 빈 칸이 있는 전략만 */
export function exitCoverageGaps(open?: readonly OpenCombo[]): ExitCoverage[] {
  return exitCoverage(open).filter(c => c.gap != null);
}

/**
 * 사람이 읽는 한 줄.
 *
 * **"정상"이라고 적지 않는다.** 안 보는 전략이 하나라도 있으면 그 수를 적는다.
 */
export function exitCoverageLine(open?: readonly OpenCombo[]): string {
  const all = exitCoverage(open);
  const gaps = all.filter(c => c.gap != null);
  if (all.length === 0) return '실행 경로가 있는 전략이 없습니다';
  // **세는 단위가 전략이 아니라 계약이다.** 같은 전략이 계약에 따라 다른
  // 감시를 받으므로, 전략 수로 세면 빠진 계약이 숨는다.
  if (gaps.length === 0) return `실행 계약 ${all.length}개 전부 청산 감시 대상입니다`;
  return `실행 계약 ${all.length}개 중 ${gaps.length}개가 트레일링·본전이동·시간청산·포지션점검을 받지 않습니다`
    + ` (${gaps.map(nameOfCoverage).join(' · ')})`;
}

/** 전략 하나에 줄이 둘일 수 있으므로 계약까지 적어야 구분된다 */
function nameOfCoverage(c: ExitCoverage): string {
  return c.contract ? `${c.strategyId}/${c.contract.presetId}` : String(c.strategyId);
}

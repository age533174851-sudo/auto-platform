// src/lib/ops/recoveryCenter.ts
//
// **버튼을 매번 누르는 곳이 아니다.**
//
// 복구 화면은 대개 "고칠 것 목록 + 고치기 버튼"으로 만들어진다. 그러면
// 사람이 매번 목록을 읽고 버튼을 누르는 일이 생기고, 그건 자동화가
// 아니라 숙제를 예쁘게 만든 것이다.
//
// 그래서 둘로 가른다:
//
//   시스템이 이미 했다      무엇을 했는지만 보여 준다. 누를 것이 없다
//   사람의 결정이 필요하다  **왜 자동으로 못 하는지**와 필요한 것 하나
//
// 두 번째가 비어 있는 것이 목표다.
//
// 절대 자동으로 하지 않는 것
// ─────────────────────────
// 자동화의 범위를 넓히다 보면 언젠가 이 선을 넘고 싶어진다. 그래서
// 여기 적어 둔다 — **이 셋은 시스템이 절대 스스로 하지 않는다.**
//
//   1. 남의 주문 취소 (FOREIGN)
//   2. Cancel All
//   3. 소유를 판정하지 못한(UNKNOWN) 주문에 대한 파괴적 행동
//
// 셋 다 "지금 맞는 것 같다"로 실행되면 다른 전략의 손절을 지운다.
// 그 한 번이 보호 없는 100배 포지션을 만든다.

export type RecoveryKind =
  /** 시스템이 이미 고쳤다 */
  | 'AUTO_DONE'
  /** 시스템이 지금 고치는 중이다 */
  | 'AUTO_RUNNING'
  /** 자동으로 할 수 있는데 아직 안 했다 */
  | 'AUTO_PENDING'
  /** 사람의 결정이 필요하다 */
  | 'NEEDS_DECISION'
  /** 자동으로 하면 안 되는 종류다 */
  | 'NEVER_AUTO';

export interface RecoveryItem {
  id: string;
  label: string;
  kind: RecoveryKind;
  /** 무슨 일이 있었는가 */
  detail: string;
  /** 시스템이 한 일 */
  did: string[];
  /**
   * 사람이 해야 하는 **딱 하나**. 없으면 null.
   *
   * 여러 개를 적으면 사용자는 목록을 읽게 되고, 목록은 곧 안 읽힌다.
   */
  needed: string | null;
}

export interface RecoveryView {
  /** 사람이 볼 필요가 없는 것들 */
  handled: RecoveryItem[];
  /** 사람의 결정이 필요한 것들. **여기가 비어 있어야 완성이다** */
  decisions: RecoveryItem[];
  summary: string;
  /** 지금 새 주문을 낼 수 있는가 */
  canTrade: boolean;
}

/** 절대 자동으로 하지 않는 것들 — 값으로 박아 둔다 */
export const NEVER_AUTO: Array<{ id: string; label: string; why: string }> = [
  {
    id: 'foreign_cancel', label: '다른 전략의 주문 취소',
    why: '남의 손절을 지우면 그 전략의 포지션이 보호 없이 남습니다',
  },
  {
    id: 'cancel_all', label: 'Cancel All',
    why: '한 번에 전부 지우면 어느 것이 누구 것이었는지 되돌릴 수 없습니다',
  },
  {
    id: 'unknown_destructive', label: '소유를 모르는 주문에 대한 취소·청산',
    why: '"지금 맞는 것 같다"로 실행하면 그 한 번이 보호 없는 포지션을 만듭니다',
  },
];

export interface RecoveryInput {
  /** 마이그레이션 상태 */
  migration?: { code: string; detail: string; blockedReason: string | null; entryAllowed: boolean } | null;
  /** 워커 상태 */
  worker?: { code: string; summary: string; canRun: boolean } | null;
  /** 청산 감시 */
  exitMonitor?: { code: string; reason: string; blockEntry: boolean } | null;
  /** 지문 대조 */
  parity?: { code: string; summary: string; entryAllowed: boolean; entryReason: string } | null;
  /** 권한 연결 */
  bootstrap?: { code: string; summary: string } | null;
  /** 자동 복구 이력 (최신순) */
  heals?: Array<{ trigger: string; action: string; outcome: string; verified: boolean | null; detail: string | null }> | null;
  /** 정리하지 못한 내 보호주문 (번호는 문자열) */
  leftoverProtection?: string[] | null;
  /** 소유를 판정하지 못한 주문 수 */
  unknownOwnership?: number | null;
}

function item(o: RecoveryItem): RecoveryItem { return o; }

/**
 * 지금 무엇이 자동으로 처리됐고 무엇이 남았는가.
 *
 * **"확인하지 못했다"를 handled에 넣지 않는다.** 모르는 것을 처리된
 * 것으로 세면 이 화면이 없애려던 문제가 된다.
 */
export function recoveryView(i: RecoveryInput | null | undefined): RecoveryView {
  const handled: RecoveryItem[] = [];
  const decisions: RecoveryItem[] = [];

  // ── 시스템이 이미 한 일 ──
  for (const h of (i?.heals ?? []).slice(0, 5)) {
    if (!h) continue;
    const ok = h.outcome === 'HEALED' && h.verified === true;
    (ok ? handled : decisions).push(item({
      id: `heal:${h.trigger}`, label: `자동 복구 — ${h.trigger}`,
      kind: ok ? 'AUTO_DONE' : 'NEEDS_DECISION',
      detail: h.detail || (ok ? '복구했습니다' : '복구되지 않았습니다'),
      did: [h.action],
      needed: ok ? null : '자동 복구로 낫지 않았습니다 — 무엇이 막고 있는지 확인이 필요합니다',
    }));
  }

  // ── 마이그레이션 ──
  if (i?.migration) {
    const m = i.migration;
    if (m.code === 'UP_TO_DATE') {
      handled.push(item({ id: 'migration', label: '마이그레이션', kind: 'AUTO_DONE',
        detail: m.detail, did: ['자동 적용'], needed: null }));
    } else if (m.blockedReason) {
      // 권한이 없어 자동으로 못 하는 자리 — **최초 1회짜리다**
      decisions.push(item({ id: 'migration', label: '마이그레이션', kind: 'NEEDS_DECISION',
        detail: m.detail, did: [], needed: m.blockedReason }));
    } else {
      handled.push(item({ id: 'migration', label: '마이그레이션', kind: 'AUTO_RUNNING',
        detail: m.detail, did: ['자동으로 적용하는 중'], needed: null }));
    }
  }

  // ── 워커 ──
  if (i?.worker) {
    const w = i.worker;
    if (w.code === 'HEALTHY') {
      handled.push(item({ id: 'worker', label: '워커', kind: 'AUTO_DONE',
        detail: w.summary, did: [], needed: null }));
    } else if (w.code === 'DIFFERENT_DATABASE' || w.code === 'DIFFERENT_ENCRYPTION_KEY') {
      // **값을 바꿔야 하는 고장.** 재시작으로 안 낫는다.
      decisions.push(item({ id: 'worker', label: '워커', kind: 'NEEDS_DECISION',
        detail: w.summary, did: [],
        needed: '워커와 웹이 다른 값을 들고 있습니다 — 시크릿을 맞춰야 합니다 (지문만 비교했습니다)' }));
    } else if (w.code === 'UNKNOWN') {
      // **모르는 것을 처리됨으로 세지 않는다.**
      decisions.push(item({ id: 'worker', label: '워커', kind: 'NEEDS_DECISION',
        detail: w.summary, did: [], needed: '워커 상태를 읽지 못했습니다 — 정상이라는 뜻이 아닙니다' }));
    } else {
      handled.push(item({ id: 'worker', label: '워커', kind: 'AUTO_PENDING',
        detail: w.summary, did: ['복구해 명령으로 자동 재시작할 수 있습니다'], needed: null }));
    }
  }

  // ── 청산 감시 ──
  if (i?.exitMonitor) {
    const e = i.exitMonitor;
    if (e.code === 'OK') {
      handled.push(item({ id: 'exitMonitor', label: '청산 감시', kind: 'AUTO_DONE',
        detail: e.reason, did: [], needed: null }));
    } else if (e.code === 'NEVER_RAN') {
      handled.push(item({ id: 'exitMonitor', label: '청산 감시', kind: 'AUTO_PENDING',
        detail: e.reason, did: ['워커가 5분마다 부릅니다'], needed: null }));
    } else {
      decisions.push(item({ id: 'exitMonitor', label: '청산 감시', kind: 'NEEDS_DECISION',
        detail: e.reason, did: [],
        needed: e.blockEntry ? '청산 감시가 멈춰 새 진입이 막혀 있습니다' : '청산 감시가 밀리고 있습니다' }));
    }
  }

  // ── 지문 ──
  if (i?.parity && !i.parity.entryAllowed) {
    decisions.push(item({ id: 'parity', label: '시크릿 대조', kind: 'NEEDS_DECISION',
      detail: i.parity.summary, did: [], needed: i.parity.entryReason }));
  }

  // ── 남은 보호주문 ──
  const left = i?.leftoverProtection;
  if (Array.isArray(left) && left.length > 0) {
    // 내 것이므로 정확한 번호로 자동 취소할 수 있다.
    handled.push(item({
      id: 'leftover', label: '남은 보호주문', kind: 'AUTO_PENDING',
      // **번호는 문자열 그대로.** int64를 숫자로 다루면 끝자리가 뭉개진다.
      detail: `내 보호주문 ${left.length}건이 남아 있습니다 (${left.slice(0, 3).join(', ')})`,
      did: ['다음 진입 직전에 정확한 번호로 자동 취소합니다'],
      needed: null,
    }));
  }

  const unknownOwn = i?.unknownOwnership;
  if (typeof unknownOwn === 'number' && unknownOwn > 0) {
    // **여기가 선이다.** 소유를 모르는 주문은 자동으로 손대지 않는다.
    decisions.push(item({
      id: 'unknownOwnership', label: '소유를 모르는 주문', kind: 'NEVER_AUTO',
      detail: `소유를 판정하지 못한 주문이 ${unknownOwn}건 있습니다`,
      did: [],
      needed: '이 주문들은 시스템이 손대지 않습니다 — 어느 전략의 것인지 확인이 필요합니다',
    }));
  }

  const canTrade = !(
    (i?.migration && !i.migration.entryAllowed)
    || (i?.exitMonitor && i.exitMonitor.blockEntry)
    || (i?.parity && !i.parity.entryAllowed)
  );

  const summary = decisions.length === 0
    ? handled.length > 0
      ? `${handled.length}가지를 시스템이 처리했습니다 — 하실 일은 없습니다`
      : '확인한 것이 없습니다'
    : `${decisions.length}가지가 사람의 결정을 기다립니다`;

  return { handled, decisions, summary, canTrade };
}

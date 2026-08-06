// src/lib/risk/emergencyLevel.ts
//
// **비상정지를 단계로 나눈다.**
//
// 지금 무엇이 문제인가
// ────────────────────
// 버튼이 [KILL] 하나다. 그리고 그 하나가 **모든 포지션을 닫는다** —
// 자동매매가 연 것도, 사용자가 손으로 잡아 관리하던 것도 같이.
//
// 그래서 이런 일이 난다: 봇이 이상하게 도는 것 같아 KILL을 누른다.
// 봇 포지션은 정리되는데, 어제부터 들고 있던 손매매 포지션도 같이
// 시장가로 나간다. 급할 때 누르는 버튼이 **의도하지 않은 것까지**
// 정리하면, 다음부터는 그 버튼을 못 누른다.
//
// 그리고 반대 방향의 문제도 있다. "조금 줄이고 싶다"가 안 된다.
// 지금은 전부 닫거나 아무것도 안 하거나 둘 중 하나라, 애매할 때
// 사용자는 아무것도 안 한다.
//
// 무엇을 새로 만들지 않는가
// ─────────────────────────
// killSwitch의 KillAction('A'신규차단 'B'봇정지 'C'주문취소 'D'전량종료)은
// **이미 조합 가능한 구조다.** 여기서 두 번째 체계를 만들면 두 곳의
// 뜻이 갈리고, 갈리면 한쪽만 고쳐진다.
//
// 그래서 이 파일은 **단계를 그 조합으로 번역할 뿐**이고, 새로 더하는
// 능력은 둘뿐이다 — 절반만 줄이기, 봇이 연 것만 닫기.

import type { KillAction } from './killSwitch';

export type EmergencyLevel =
  /** 신규 진입만 막는다. 들고 있는 것은 그대로 */
  | 'PAUSE_ENTRIES'
  /** 포지션을 절반으로 줄인다 */
  | 'REDUCE_RISK'
  /** **자동매매가 연 것만** 닫는다. 손매매는 건드리지 않는다 */
  | 'CLOSE_AUTOMATED'
  /** 전부 닫는다 */
  | 'CLOSE_ALL'
  /** 주문 기능 자체를 잠근다 */
  | 'LOCK_ACCOUNT';

export interface LevelSpec {
  level: EmergencyLevel;
  label: string;
  /** killSwitch의 어느 동작을 켜는가 */
  actions: KillAction[];
  /** 들고 있는 포지션의 몇 %를 닫는가. 0이면 안 닫는다 */
  closePct: number;
  /** 봇이 연 것만 닫는가 */
  automatedOnly: boolean;
  /**
   * 확인을 몇 단계로 받는가.
   *
   * **되돌리기 어려울수록 많이 묻는다.** 신규 차단은 언제든 풀 수 있으니
   * 한 번, 전량 종료는 시장가로 나가 되돌릴 수 없으니 두 번, 계좌 잠금은
   * 실수로 눌리면 급할 때 아무것도 못 하게 되므로 두 번이다.
   *
   * 다 두 번 물으면 급할 때 손이 느려지고, 다 한 번이면 실수로 눌린다.
   */
  confirmSteps: 1 | 2;
  /** 확인 창에 그대로 띄울 문장 */
  confirmText: string;
  /** 되돌릴 수 있는가 */
  reversible: boolean;
}

export const LEVELS: Record<EmergencyLevel, LevelSpec> = {
  PAUSE_ENTRIES: {
    level: 'PAUSE_ENTRIES', label: '신규 진입 중단',
    actions: ['A'], closePct: 0, automatedOnly: false,
    confirmSteps: 1, reversible: true,
    confirmText: '새 진입만 막습니다. 들고 있는 포지션과 걸어 둔 손절은 그대로입니다.',
  },
  REDUCE_RISK: {
    level: 'REDUCE_RISK', label: '위험 절반 축소',
    // 신규도 같이 막는다. 줄이는 동안 새로 들어오면 줄인 뜻이 없다.
    actions: ['A', 'B'], closePct: 50, automatedOnly: false,
    confirmSteps: 2, reversible: false,
    confirmText: '모든 포지션을 절반으로 줄입니다. 시장가로 나가므로 되돌릴 수 없습니다.',
  },
  CLOSE_AUTOMATED: {
    level: 'CLOSE_AUTOMATED', label: '자동매매 포지션만 종료',
    actions: ['A', 'B', 'C'], closePct: 100, automatedOnly: true,
    confirmSteps: 2, reversible: false,
    confirmText: '자동매매가 연 포지션만 닫습니다. 손으로 잡은 포지션은 건드리지 않습니다.',
  },
  CLOSE_ALL: {
    level: 'CLOSE_ALL', label: '전체 종료',
    actions: ['A', 'B', 'C', 'D'], closePct: 100, automatedOnly: false,
    confirmSteps: 2, reversible: false,
    confirmText: '손매매 포지션까지 전부 시장가로 닫습니다. 되돌릴 수 없습니다.',
  },
  LOCK_ACCOUNT: {
    level: 'LOCK_ACCOUNT', label: '계좌 잠금',
    // 닫지는 않는다. 잠그는 것과 정리하는 것은 다른 결정이다 —
    // 섞으면 "잠그려고 눌렀는데 포지션이 나갔다"가 된다.
    actions: ['A', 'B'], closePct: 0, automatedOnly: false,
    confirmSteps: 2, reversible: true,
    confirmText: '주문 기능을 잠급니다. 포지션은 그대로 두므로, 닫으려면 따로 실행해야 합니다.',
  },
};

/** 화면에 그릴 순서. 약한 것부터 */
export const LEVEL_ORDER: EmergencyLevel[] = [
  'PAUSE_ENTRIES', 'REDUCE_RISK', 'CLOSE_AUTOMATED', 'CLOSE_ALL', 'LOCK_ACCOUNT',
];

export function levelOf(raw: any): LevelSpec | null {
  const s = String(raw ?? '').trim().toUpperCase() as EmergencyLevel;
  return LEVELS[s] ?? null;
}

/** killSwitch가 쓰는 actionMode 문자열로 바꾼다 */
export function actionModeOf(spec: LevelSpec | null | undefined): string {
  if (!spec) return '';
  return spec.actions.join('');
}

// ── 봇이 연 포지션 가려내기 ──────────────────────────

export interface OrderRowLike {
  symbol?: any;
  signal_id?: any;
  status?: any;
}

/**
 * 어느 심볼이 **자동매매가 연 것**인가.
 *
 * 판정 근거는 signal_id에 새겨진 전략 태그다(strategies/ledger.tagStrategy).
 * 손으로 낸 주문에는 그 태그가 없다.
 *
 * **못 가리면 빈 집합이다.** 그리고 빈 집합이면 CLOSE_AUTOMATED는
 * 아무것도 안 닫는다 — 여기서 "모르면 전부"로 기울면 손매매 포지션까지
 * 나가고, 그건 이 단계를 만든 이유의 정반대다.
 */
export function automatedSymbols(
  rows: OrderRowLike[] | null | undefined,
  strategyOf: (row: any) => string | null,
): Set<string> {
  const out = new Set<string>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const sym = String(r.symbol ?? '').toUpperCase();
    if (!sym) continue;
    if (strategyOf(r)) out.add(sym);
  }
  return out;
}

export interface CloseTarget {
  symbol: string;
  /** 닫을 수량. null이면 전량 */
  qty: number | null;
  reason: string;
}

/**
 * 이 단계에서 무엇을 얼마나 닫는가.
 *
 * 순수 함수다 — 주문을 내지 않는다. 낼 목록을 만들 뿐이다.
 *
 * **자동매매 것만 닫는 단계에서 목록이 비면 그대로 빈 목록을 돌려준다.**
 * "닫을 것이 없다"와 "전부 닫는다"는 완전히 다른 결과이고, 급할 때
 * 그 둘이 섞이면 사용자는 자기 손매매 포지션이 나간 것을 나중에 안다.
 */
export function closeTargets(
  spec: LevelSpec | null | undefined,
  positions: Array<{ symbol: string; qty: number }> | null | undefined,
  automated: Set<string>,
): { targets: CloseTarget[]; note: string } {
  if (!spec || spec.closePct <= 0) return { targets: [], note: '' };

  const list = (Array.isArray(positions) ? positions : [])
    .filter(p => p && String(p.symbol) && Number(p.qty) > 0);

  const picked = spec.automatedOnly
    ? list.filter(p => automated.has(String(p.symbol).toUpperCase()))
    : list;

  const skipped = list.length - picked.length;
  const targets = picked.map(p => ({
    symbol: String(p.symbol),
    // 100%면 null(전량)이다. 수량을 계산해 넣으면 그 사이 값이 바뀌었을 때
    // 남거나 초과한다 — 전량은 거래소가 "그때 있는 것"으로 처리하게 둔다.
    qty: spec.closePct >= 100 ? null : Number(p.qty) * (spec.closePct / 100),
    reason: `${spec.label} (${spec.closePct}%)`,
  }));

  return {
    targets,
    note: spec.automatedOnly
      ? (targets.length === 0
          ? '자동매매가 연 포지션이 없습니다 — 닫을 것이 없습니다'
          : `자동매매 ${targets.length}개를 닫습니다${skipped > 0 ? ` · 손매매 ${skipped}개는 그대로 둡니다` : ''}`)
      : `${targets.length}개 포지션을 ${spec.closePct}% 닫습니다`,
  };
}

/**
 * 확인 문구.
 *
 * **무엇이 나가는지 숫자로 적는다.** "정말 실행할까요?"만 물으면
 * 사람은 읽지 않고 예를 누른다.
 */
export function confirmLines(
  spec: LevelSpec | null | undefined,
  plan: { targets: CloseTarget[]; note: string },
): string[] {
  if (!spec) return ['알 수 없는 단계입니다'];
  const lines = [spec.label, '', spec.confirmText];
  if (plan.note) lines.push('', plan.note);
  if (plan.targets.length > 0) {
    lines.push('');
    for (const t of plan.targets.slice(0, 8)) {
      lines.push(`  ${t.symbol}  ${t.qty == null ? '전량' : t.qty}`);
    }
    if (plan.targets.length > 8) lines.push(`  … 외 ${plan.targets.length - 8}개`);
  }
  if (!spec.reversible) lines.push('', '되돌릴 수 없습니다.');
  return lines;
}

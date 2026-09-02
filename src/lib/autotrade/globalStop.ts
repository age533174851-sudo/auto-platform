// src/lib/autotrade/globalStop.ts
//
// **"모든 봇이 중단되었습니다"를 서버 확인 없이 적지 않는다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 자동매매 화면의 전체정지는 이렇게 생겼었다:
//
//   const handleGlobalStop = () => {
//     setGlobalStop(true);
//     setStrats(p => p.map(s => ({ ...s, status:'stopped', enabled:false })));
//   };
//
// 서버를 부르지 않는다. 그런데 화면은 그 뒤에
// **"전체 긴급 정지 활성화 — 모든 봇이 중단되었습니다"**를 적었다.
//
// 실제로 도는 것은 `autotrade_schedules`(마이그레이션 031)에 등록된
// 예약이고 크론이 그것을 읽는다. 로컬 React 상태를 바꿔도 크론은 계속
// 돈다. 게다가 저장조차 안 되므로 새로고침하면 "긴급 정지" 표시 자체가
// 사라지고, 사용자는 정지가 풀린 것도 모른다.
//
// 이건 취향 문제가 아니다. 사용자가 위험하다고 판단해 정지를 눌렀는데
// 시스템이 계속 주문을 낼 수 있고, 화면은 멈췄다고 말한다.
//
// 여기서 하는 일
// ──────────────
// 이미 있는 서버 경로만 쓴다 — 워커·스케줄러·리스크 엔진은 건드리지
// 않는다.
//
//   GET   /api/autotrade/schedule            → 지금 켜져 있는 예약
//   PATCH /api/autotrade/schedule {id,false} → 하나씩 끈다
//
// 그리고 **결과를 값으로 돌려준다.** 몇 개를 껐고 몇 개가 실패했는지
// 세어서, 화면이 그 수만큼만 말하게 한다.
//
// 이 파일이 하지 않는 것도 분명히 해 둔다
// ───────────────────────────────────────
// 예약을 끄는 것은 **새 진입을 더 내지 않는다**는 뜻이다. 열린 포지션을
// 청산하지 않고, 거래소에 이미 올라간 주문을 취소하지 않는다. 그건
// 킬 스위치(`/api/risk/kill-switch/trigger`)와 청산 감시의 몫이다.
// 그래서 결과 문장에도 그 경계를 적는다 — 화면이 실제보다 더 센 것을
// 약속하지 않게.

export interface StopTarget {
  id: string;
  /** 화면에 보여 줄 이름. 없으면 id를 쓴다 */
  label?: string;
}

export type StopOutcome =
  /** 서버가 예약을 껐다고 확인해 줬다 */
  | { id: string; label: string; ok: true }
  /** 서버가 거절했거나 응답을 못 읽었다 */
  | { id: string; label: string; ok: false; reason: string };

export type GlobalStopCode =
  /** 아직 눌리지 않았다 */
  | 'IDLE'
  /** 서버 응답을 기다리는 중 */
  | 'STOPPING'
  /** 끌 예약이 애초에 없었다 */
  | 'NOTHING_TO_STOP'
  /** 요청한 것을 전부 껐다 */
  | 'ALL_STOPPED'
  /** 일부만 껐다 — 나머지는 아직 돈다 */
  | 'PARTIAL'
  /** 목록조차 못 읽었다. 무엇이 도는지 모른다 */
  | 'UNKNOWN';

export interface GlobalStopResult {
  code: GlobalStopCode;
  /** 서버가 껐다고 확인해 준 개수 */
  stopped: number;
  /** 실패한 개수 */
  failed: number;
  /** 시도한 총 개수 */
  attempted: number;
  outcomes: StopOutcome[];
  /** 목록을 못 읽었을 때의 사유 */
  error?: string;
}

export const IDLE_RESULT: GlobalStopResult = {
  code: 'IDLE', stopped: 0, failed: 0, attempted: 0, outcomes: [],
};

/**
 * 서버가 준 예약 목록에서 **끌 대상**만 고른다.
 *
 * 이미 꺼져 있는 것을 다시 끄면 "N개를 껐습니다"의 N이 부풀고, 사용자는
 * 실제보다 많은 것이 돌고 있었다고 믿는다. 켜져 있는 것만 센다.
 */
export function stopTargets(rows: unknown): StopTarget[] {
  if (!Array.isArray(rows)) return [];
  const out: StopTarget[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const id = row.id;
    if (typeof id !== 'string' || !id) continue;
    // `enabled`가 명시적으로 false인 것만 뺀다. 값이 없으면 모르는
    // 것이므로 **끄는 쪽에 포함한다** — 모르는 것을 "이미 꺼져 있다"고
    // 넘기면 도는 것을 놓친다.
    if (row.enabled === false) continue;
    const sym = typeof row.symbol === 'string' ? row.symbol : '';
    out.push({ id, label: sym || id });
  }
  return out;
}

/**
 * 하나씩 끈 결과를 모아 판정한다.
 *
 * **부분 성공을 성공이라고 적지 않는다.** 5개 중 3개만 꺼졌으면 2개는
 * 아직 돈다 — 그때 "모두 중단"이라고 쓰면 처음 문제로 돌아간다.
 */
export function summarize(outcomes: StopOutcome[]): GlobalStopResult {
  const stopped = outcomes.filter(o => o.ok).length;
  const failed = outcomes.length - stopped;
  let code: GlobalStopCode;
  if (outcomes.length === 0) code = 'NOTHING_TO_STOP';
  else if (failed === 0) code = 'ALL_STOPPED';
  else code = 'PARTIAL';
  return { code, stopped, failed, attempted: outcomes.length, outcomes };
}

export function unknownResult(error: string): GlobalStopResult {
  return { code: 'UNKNOWN', stopped: 0, failed: 0, attempted: 0, outcomes: [], error };
}

/**
 * 사용자에게 보여 줄 문장.
 *
 * 규칙 하나: **확인한 것만 적는다.** 서버가 껐다고 답한 개수만 세고,
 * 예약을 끈다는 것이 무엇을 뜻하는지(그리고 무엇을 뜻하지 않는지)
 * 같이 적는다.
 */
export function headline(r: GlobalStopResult): string {
  switch (r.code) {
    case 'IDLE':      return '';
    case 'STOPPING':  return '서버에 정지를 요청하는 중입니다 — 아직 멈췄다고 말할 수 없습니다';
    case 'NOTHING_TO_STOP':
      return '켜져 있는 자동매매 예약이 없습니다 — 끌 것이 없었습니다';
    case 'ALL_STOPPED':
      return `자동매매 예약 ${r.stopped}개를 껐습니다 — 새 진입을 더 내지 않습니다`;
    case 'PARTIAL':
      return `예약 ${r.attempted}개 중 ${r.stopped}개만 껐습니다 — ${r.failed}개는 아직 돌고 있습니다`;
    case 'UNKNOWN':
      return `자동매매 예약을 읽지 못했습니다 — 무엇이 돌고 있는지 확인하지 못했습니다`;
  }
}

/**
 * 문장 아래에 붙는 경계 설명.
 *
 * 예약을 끄는 것과 "모든 것이 멈췄다"는 다르다. 그 차이를 화면이
 * 직접 말하지 않으면 사용자가 채워 넣는다 — 보통 유리한 쪽으로.
 */
export function boundaryNote(r: GlobalStopResult): string {
  if (r.code === 'IDLE' || r.code === 'STOPPING') return '';
  const base = '예약을 끄면 새 진입을 내지 않습니다. '
    + '이미 열린 포지션은 그대로 남고, 거래소에 올라간 주문도 취소되지 않습니다.';
  if (r.code === 'PARTIAL' || r.code === 'UNKNOWN') {
    return base + ' 실전 주문을 즉시 막아야 하면 킬 스위치를 쓰세요.';
  }
  return base;
}

/** 화면이 위험 색(빨강)을 켜야 하는 상태인가 */
export function isAlarming(r: GlobalStopResult): boolean {
  return r.code === 'PARTIAL' || r.code === 'UNKNOWN';
}

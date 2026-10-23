// src/lib/ops/autodevSchedule.ts
//
// **무인 회차가 "돌고 있다"를 가정으로 두지 않는다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// `check-claude-hourly`는 두 갈래의 예약 시각이 **같을 때만** 실패했다.
//
//     if (crons[0] && crons[1] && crons[0] === crons[1]) err(...)
//
// 예약이 **아예 없으면** `crons[0]`이 falsy라 그 줄을 건너뛴다. 그래서
// 두 워크플로에서 `schedule:` 블록을 통째로 지워도 검사기는 그대로
// 초록이고, 요약에는 "무인 회차 울타리 2갈래 ✅"가 찍힌다. 울타리는
// 멀쩡한데 **그 울타리 안에서 도는 것이 아무것도 없는 상태**가
// 통과로 보인다.
//
// 한쪽만 지워도 같다. 일반 갈래는 매시 돌고 거래 갈래는 영영 안 도는
// 상태가 조용히 통과한다 — 실제로 거래 갈래는 수동 실행 기록이
// 한 번도 없다.
//
// 이 저장소의 규칙 그대로다: **확인하지 못한 것을 통과로 적지 않는다.**
// 예약이 없는 것은 "문제 없음"이 아니라 **"수동 전용"이라는 사실**이고,
// 그 사실은 요약에 적혀야 한다.
//
// 왜 값으로 빼는가
// ────────────────
// 판정은 한 곳에만 둔다. 검사기(.mjs)는 이 파일을 프로젝트 tsc로
// 컴파일해서 쓰고(`loadSchedule()`), 시험은 같은 함수를 직접 부른다.
// 로직을 복제하면 둘이 언젠가 갈린다.

/** 한 갈래의 예약 상태 */
export type LaneScheduleState =
  /** `on.schedule`에 cron이 있다 — 사람 없이 돈다 */
  | 'SCHEDULED'
  /** `on:`은 읽었고 cron이 없다 — **수동 실행 전용**이다 */
  | 'MANUAL_ONLY'
  /** 워크플로 파일이 없다 */
  | 'WORKFLOW_MISSING'
  /** 파일은 있는데 `on:` 블록을 읽지 못했다. **없는 것과 다르다** */
  | 'UNREADABLE';

export interface LaneSchedule {
  name: string;
  state: LaneScheduleState;
  /** `SCHEDULED`일 때만 값이 있다 */
  cron: string | null;
}

/**
 * 워크플로 본문에서 **`on:` 블록만** 보고 예약을 읽는다.
 *
 * 파일 전체에서 `cron:`을 찾으면 주석이나 프롬프트 본문의 같은 글자가
 * 잡힌다. 예약이 없는데 있다고 읽는 쪽이 더 나쁘다 — 그래야 할 일이
 * 없다고 결론 내리게 된다.
 */
export function laneScheduleOf(name: string, source: string | null | undefined): LaneSchedule {
  if (source == null) return { name, state: 'WORKFLOW_MISSING', cron: null };
  const text = String(source);
  const start = text.search(/^on:\s*$/m);
  if (start < 0) return { name, state: 'UNREADABLE', cron: null };

  // `on:` 다음 최상위 키(들여쓰기 없는 줄)까지가 이 블록이다.
  const rest = text.slice(start + 3);
  const endRel = rest.search(/^[A-Za-z_][\w-]*:/m);
  const block = endRel < 0 ? rest : rest.slice(0, endRel);

  // 주석 줄은 세지 않는다.
  const lines = block.split('\n').filter(l => !/^\s*#/.test(l));
  const m = lines.join('\n').match(/cron:\s*['"]([^'"]+)['"]/);
  if (!m) return { name, state: 'MANUAL_ONLY', cron: null };
  const cron = m[1].trim();
  if (!cron) return { name, state: 'UNREADABLE', cron: null };
  return { name, state: 'SCHEDULED', cron };
}

export type AutodevScheduleCode =
  /** 두 갈래 모두 예약돼 있고 시각이 다르다 */
  | 'SCHEDULED'
  /** 두 갈래 모두 수동 전용이다 — 실패는 아니지만 **초록이 "돈다"는 뜻은 아니다** */
  | 'MANUAL_ONLY'
  /** 한쪽만 예약돼 있다 */
  | 'SPLIT'
  /** 두 갈래가 같은 시각에 깬다 */
  | 'SAME_TIME'
  /** 워크플로를 읽지 못했다 */
  | 'UNREADABLE';

export interface AutodevScheduleVerdict {
  ok: boolean;
  code: AutodevScheduleCode;
  lanes: LaneSchedule[];
  /** 요약 한 줄. **예약 상태를 반드시 말한다** */
  summary: string;
  /** 실패 사유. 통과면 빈 배열 */
  errors: string[];
}

/**
 * 두 갈래의 예약을 함께 본다.
 *
 * 왜 함께 보는가
 * ──────────────
 *   · 같은 시각에 깨면 두 브랜치가 같은 파일을 만진다 (기존 규칙).
 *   · **한쪽만 도는 것**은 더 조용한 고장이다. 화면은 매시 고쳐지는데
 *     엔진은 한 번도 안 돌고, 둘 다 "자동 개발이 돌고 있다"로 보고된다.
 *   · 둘 다 안 돌면 실패는 아니다 — 사람이 끄기로 한 것일 수 있다.
 *     다만 **그렇게 적혀야** 한다. 조용히 통과하면 끈 것을 잊는다.
 */
export function autodevScheduleVerdict(
  lanes: Array<{ name: string; source: string | null | undefined }>,
): AutodevScheduleVerdict {
  const read = lanes.map(l => laneScheduleOf(l.name, l.source));
  const errors: string[] = [];
  const label = (l: LaneSchedule) =>
    l.state === 'SCHEDULED' ? `${l.name}=${l.cron}`
      : l.state === 'MANUAL_ONLY' ? `${l.name}=수동 전용`
        : `${l.name}=${l.state}`;

  const unreadable = read.filter(l => l.state === 'UNREADABLE' || l.state === 'WORKFLOW_MISSING');
  if (unreadable.length) {
    for (const l of unreadable) {
      errors.push(`${l.name}: 예약 설정을 읽지 못했습니다 (${l.state}) — `
        + '읽지 못한 것을 "예약 없음"으로 적지 않습니다');
    }
    return {
      ok: false, code: 'UNREADABLE', lanes: read, errors,
      summary: `무인 회차 예약: 읽지 못함 (${read.map(label).join(' · ')})`,
    };
  }

  const scheduled = read.filter(l => l.state === 'SCHEDULED');

  if (scheduled.length > 0 && scheduled.length < read.length) {
    const off = read.filter(l => l.state !== 'SCHEDULED').map(l => l.name).join(' · ');
    errors.push(`한 갈래만 예약돼 있습니다 — 예약 없는 갈래: ${off}. `
      + '한쪽만 도는 상태는 "자동 개발이 돈다"로 보고되지만 그 갈래는 영영 돌지 않습니다');
    return {
      ok: false, code: 'SPLIT', lanes: read, errors,
      summary: `무인 회차 예약: 갈래 불일치 (${read.map(label).join(' · ')})`,
    };
  }

  if (scheduled.length === 0) {
    // **실패가 아니다.** 다만 초록이 "돌고 있다"는 뜻이 되지 않게 적는다.
    return {
      ok: true, code: 'MANUAL_ONLY', lanes: read, errors,
      summary: '무인 회차 예약: **없음 — 수동 실행 전용** '
        + '(workflow_dispatch로만 돕니다. 예약으로 돌리려면 schedule을 되살리세요)',
    };
  }

  const times = scheduled.map(l => l.cron);
  if (new Set(times).size !== times.length) {
    errors.push(`두 갈래의 예약 시각이 같습니다 (${times[0]}) — `
      + '동시에 깨면 브랜치가 갈립니다');
    return {
      ok: false, code: 'SAME_TIME', lanes: read, errors,
      summary: `무인 회차 예약: 시각 충돌 (${read.map(label).join(' · ')})`,
    };
  }

  return {
    ok: true, code: 'SCHEDULED', lanes: read, errors,
    summary: `무인 회차 예약: ${read.map(label).join(' · ')}`,
  };
}

// src/lib/ops/opsCommand.ts
//
// **사용자는 명령만 한다.**
//
// 지금까지 운영은 이런 모양이었다: Supabase를 열어 SQL을 붙여 넣고,
// Vercel에서 환경변수를 확인하고, Fly 로그를 스크롤하고, 배포 SHA를
// 눈으로 대조하고, heartbeat 표를 조회하고, GitHub Actions에서 빨간불을
// 찾는다. 대시보드 다섯 곳을 돌아다니는 일이고, **그중 무엇 하나를
// 빠뜨리면 조용히 틀린다.**
//
// 남길 것은 이 정도다:
//
//   전체 점검해 · 배포해 · 테스트넷 검증해 · 복구해 · 지금 중지해 ·
//   LIVE_SMALL 승인
//
// 나머지는 시스템이 한다. 이 파일은 **무엇이 명령이고 각 명령이 무엇을
// 보는가**를 값으로 정의한다 — 판정과 실행은 각자의 모듈에 있고,
// 여기서는 이름과 절차만 다룬다.

export type OpsCommand =
  | 'CHECK_ALL'
  | 'DEPLOY'
  | 'VERIFY_TESTNET'
  | 'RECOVER'
  | 'STOP_NOW'
  | 'APPROVE_LIVE_SMALL';

export type OpsStepId =
  | 'migrations' | 'secrets' | 'deployment' | 'worker' | 'exitMonitor'
  | 'exchange' | 'orders' | 'protection' | 'ledger' | 'wallet' | 'strategies';

export interface OpsCommandSpec {
  command: OpsCommand;
  label: string;
  /** 이 명령이 보는 것들 */
  steps: OpsStepId[];
  /** 값을 바꾸는가. 읽기만 하면 false */
  mutates: boolean;
  /** 사람의 명시적 승인이 필요한가 */
  needsApproval: boolean;
}

export const OPS_COMMANDS: OpsCommandSpec[] = [
  {
    command: 'CHECK_ALL', label: '전체 점검',
    steps: ['migrations', 'secrets', 'deployment', 'worker', 'exitMonitor',
      'exchange', 'orders', 'protection', 'ledger', 'wallet', 'strategies'],
    mutates: false, needsApproval: false,
  },
  {
    command: 'DEPLOY', label: '배포',
    steps: ['migrations', 'deployment', 'worker', 'exitMonitor'],
    mutates: true, needsApproval: false,
  },
  {
    command: 'VERIFY_TESTNET', label: '테스트넷 검증',
    steps: ['exchange', 'orders', 'protection', 'ledger'],
    mutates: false, needsApproval: false,
  },
  {
    command: 'RECOVER', label: '복구',
    steps: ['migrations', 'worker', 'exitMonitor', 'orders', 'protection'],
    mutates: true, needsApproval: false,
  },
  {
    command: 'STOP_NOW', label: '지금 중지',
    steps: ['orders', 'protection'],
    mutates: true, needsApproval: false,
  },
  {
    // **실제 자금이 걸린 결정.** 자동화의 예외 세 가지 중 하나다.
    command: 'APPROVE_LIVE_SMALL', label: 'LIVE 소액 승인',
    steps: ['migrations', 'deployment', 'worker', 'exitMonitor', 'exchange', 'orders', 'protection', 'ledger'],
    mutates: true, needsApproval: true,
  },
];

/** 사람이 쓰는 말 → 명령 */
const PHRASES: Array<{ re: RegExp; command: OpsCommand }> = [
  { re: /전체\s*점검|전부\s*점검|다\s*점검|점검해|check\s*all/i, command: 'CHECK_ALL' },
  { re: /테스트넷\s*검증|testnet\s*verify|카나리/i, command: 'VERIFY_TESTNET' },
  { re: /배포해|배포하자|deploy/i, command: 'DEPLOY' },
  { re: /복구해|복구하자|고쳐줘|recover|heal/i, command: 'RECOVER' },
  { re: /지금\s*중지|당장\s*중지|즉시\s*중지|긴급\s*정지|stop\s*now/i, command: 'STOP_NOW' },
  { re: /LIVE[_\s-]?SMALL\s*승인|실전\s*소액\s*승인/i, command: 'APPROVE_LIVE_SMALL' },
];

/**
 * 사람이 쓴 말에서 명령을 읽는다.
 *
 * **모르면 null이다.** 비슷해 보인다고 아무 명령이나 고르면, 점검하려던
 * 사람이 배포를 돌리게 된다.
 */
export function parseOpsCommand(text: string): OpsCommand | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // 위험한 것부터 본다 — '지금 중지'가 '점검'보다 먼저 걸려야 한다.
  const order: OpsCommand[] = ['STOP_NOW', 'APPROVE_LIVE_SMALL', 'VERIFY_TESTNET', 'DEPLOY', 'RECOVER', 'CHECK_ALL'];
  for (const c of order) {
    const p = PHRASES.find(x => x.command === c);
    if (p && p.re.test(t)) return c;
  }
  return null;
}

export function specOf(c: OpsCommand): OpsCommandSpec | null {
  return OPS_COMMANDS.find(x => x.command === c) ?? null;
}

// ── 결과 ──

export type StepState =
  /** 확인했고 문제 없다 */
  | 'PASS'
  /** 문제가 있었는데 **시스템이 스스로 고쳤다** */
  | 'SELF_HEALED'
  /** 자동으로 못 고쳤다 */
  | 'BLOCKED'
  /** 읽지 못했다. **PASS가 아니다** */
  | 'UNKNOWN'
  /** 이 명령에서는 보지 않았다 */
  | 'SKIPPED';

export interface StepResult {
  step: OpsStepId;
  label: string;
  state: StepState;
  detail: string;
  /** 시스템이 한 일 */
  did: string[];
  /** 자동으로 못 한 이유. 없으면 null */
  blockedReason: string | null;
}

/**
 * 최종 보고는 이 넷 중 하나뿐이다.
 *
 *   READY               다 확인했고 다 정상이다
 *   SELF_HEALED         문제가 있었는데 **시스템이 스스로 고쳤다**
 *   BOOTSTRAP_REQUIRED  **최초 1회 권한 연결**만 남았다 (사람이 할 일 하나)
 *   BLOCKED             그 밖의 이유로 막혔다 — 확인 못 한 것도 여기다
 *
 * `UNKNOWN`을 따로 두지 않는다. **확인하지 못한 것은 통과가 아니고**,
 * 사용자가 볼 때 "모름"과 "막힘"의 대응은 같다 — 지금 매매하면 안 된다.
 */
export type OpsVerdict = 'READY' | 'SELF_HEALED' | 'BOOTSTRAP_REQUIRED' | 'BLOCKED';

export interface OpsResult {
  command: OpsCommand;
  label: string;
  verdict: OpsVerdict;
  summary: string;
  steps: StepResult[];
  /** 시스템이 자동으로 처리하지 못한 것들 — 여기가 비어 있어야 완성이다 */
  needsHuman: string[];
}

/**
 * 단계들을 하나의 판정으로.
 *
 * **하나라도 UNKNOWN이면 PASS가 아니다.** 확인하지 못한 것을 통과로
 * 적으면 이 화면 자체가 거짓말이 된다 — 그게 이 저장소에서 가장 자주
 * 고친 고장이다.
 */
export function opsVerdictOf(command: OpsCommand, steps: StepResult[]): OpsResult {
  const spec = specOf(command);
  const seen = (steps || []).filter(s => s && s.state !== 'SKIPPED');
  const blocked = seen.filter(s => s.state === 'BLOCKED');
  const unknown = seen.filter(s => s.state === 'UNKNOWN');
  const healed = seen.filter(s => s.state === 'SELF_HEALED');

  const needsHuman = blocked
    .map(s => s.blockedReason ? `${s.label}: ${s.blockedReason}` : `${s.label}: 자동으로 처리하지 못했습니다`);

  // **최초 1회 권한 연결과 그 밖의 고장을 가른다.**
  //
  // 앞엣것은 사람이 딱 한 번 해야 하는 일이고(그리고 그 뒤로는 영원히
  // 없다), 뒤엣것은 시스템이 고쳐야 하는 것이다. 둘을 한 통에 담으면
  // 사용자는 매번 같은 목록을 보게 되고, 그러면 곧 안 본다.
  const bootstrapOnly = blocked.length > 0
    && unknown.length === 0
    && blocked.every(s => s.step === 'secrets');

  let verdict: OpsVerdict;
  let summary: string;
  if (bootstrapOnly) {
    verdict = 'BOOTSTRAP_REQUIRED';
    summary = blocked[0].blockedReason
      ? `최초 1회 권한 연결이 필요합니다 — ${blocked[0].blockedReason}`
      : '최초 1회 권한 연결이 필요합니다';
  } else if (blocked.length > 0) {
    verdict = 'BLOCKED';
    summary = `${blocked.length}가지를 자동으로 처리하지 못했습니다 — ${blocked[0].label}`;
  } else if (unknown.length > 0) {
    // **확인하지 못한 것은 통과가 아니다.**
    verdict = 'BLOCKED';
    summary = `${unknown.length}가지를 확인하지 못했습니다 (${unknown.map(u => u.label).slice(0, 3).join(' · ')}) — 정상이라는 뜻이 아닙니다`;
  } else if (healed.length > 0) {
    verdict = 'SELF_HEALED';
    summary = `${healed.length}가지를 자동으로 복구했습니다 — ${healed.map(h => h.label).join(' · ')}`;
  } else if (seen.length === 0) {
    verdict = 'BLOCKED';
    summary = '확인한 것이 없습니다 — 정상이라는 뜻이 아닙니다';
  } else {
    verdict = 'READY';
    summary = `${seen.length}가지를 확인했고 모두 정상입니다`;
  }

  return {
    command, label: spec?.label ?? String(command),
    verdict, summary, steps: steps || [], needsHuman,
  };
}

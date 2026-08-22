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
  | 'SYNC_SECRETS'
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
  /**
   * 누가 실행하는가.
   *
   * `IMMEDIATE`  요청을 받은 그 자리에서 끝난다(조회이거나, 늦으면 안 되는 것).
   * `QUEUE`      큐에 넣고 ops-runner가 집어 간다(GitHub·Fly 자격이 필요한 것).
   *
   * **이 칸이 없어서 사고가 났다.** `opsQueue.ts`가 "실행기가 다룰 수 있는
   * 명령" 목록을 **따로 손으로** 들고 있었고, `SYNC_SECRETS`를 여기 정의만
   * 하고 그 목록에 안 넣었다. 그래서 "시크릿 동기화해"는 큐에 들어간 뒤
   * `UNKNOWN_COMMAND`로 만료됐고, 다음부터는 "실행할 요청이 없습니다"만
   * 나왔다 — 화면에도 있고 실행 분기도 있는데 영원히 안 도는 상태다.
   *
   * 이 저장소가 가장 자주 겪은 고장이다: **경로가 둘인데 한쪽만 고침.**
   * 그래서 목록을 지우고 이 칸 하나에서 뽑아 쓴다.
   */
  runBy: 'IMMEDIATE' | 'QUEUE';
}

export const OPS_COMMANDS: OpsCommandSpec[] = [
  {
    command: 'CHECK_ALL', label: '전체 점검',
    steps: ['migrations', 'secrets', 'deployment', 'worker', 'exitMonitor',
      'exchange', 'orders', 'protection', 'ledger', 'wallet', 'strategies'],
    // 조회다. 그 자리에서 답이 나온다.
    mutates: false, needsApproval: false, runBy: 'IMMEDIATE',
  },
  {
    command: 'DEPLOY', label: '배포',
    steps: ['migrations', 'deployment', 'worker', 'exitMonitor'],
    // GitHub 워크플로를 깨워야 한다 — 그 자격은 실행기에만 있다.
    mutates: true, needsApproval: false, runBy: 'QUEUE',
  },
  {
    command: 'VERIFY_TESTNET', label: '테스트넷 검증',
    steps: ['exchange', 'orders', 'protection', 'ledger'],
    // 읽기 전용이다.
    mutates: false, needsApproval: false, runBy: 'IMMEDIATE',
  },
  {
    command: 'RECOVER', label: '복구',
    steps: ['migrations', 'worker', 'exitMonitor', 'orders', 'protection'],
    // flyctl·마이그레이션 자격이 필요하다.
    mutates: true, needsApproval: false, runBy: 'QUEUE',
  },
  {
    command: 'STOP_NOW', label: '지금 중지',
    steps: ['orders', 'protection'],
    // **값을 바꾸지만 큐에 넣지 않는다.** 킬 스위치는 5분 뒤에 켜지면
    // 켜지지 않은 것과 같다. 요청을 받은 그 자리에서 켠다.
    mutates: true, needsApproval: false, runBy: 'IMMEDIATE',
  },
  {
    // **값을 맞추는 일을 사람이 두 대시보드를 오가며 하지 않게 한다.**
    //
    // 기준은 GitHub Secrets 하나다. 세 곳이 서로를 보고 있으면 무엇이
    // 맞는지 아무도 모른다. 그래서 되돌릴 이전 값이라는 것도 없다 —
    // 밀어 넣은 뒤 지문이 안 맞으면 되돌리는 대신 **크게 말하고
    // 신규 진입을 막는다**(이미 열린 포지션의 청산·보호는 계속 돈다).
    //
    // 승인을 요구하지 않는 이유: 값이 한 곳에서만 오고 여러 번 해도
    // 결과가 같다. 승인을 붙이면 그 승인이 곧 사람이 눌러야 할 버튼이 된다.
    command: 'SYNC_SECRETS', label: '시크릿 동기화',
    steps: ['secrets', 'deployment', 'worker'],
    // sync-secrets 워크플로를 깨워야 한다 — 실행기 자격이 필요하다.
    mutates: true, needsApproval: false, runBy: 'QUEUE',
  },
  {
    // **실제 자금이 걸린 결정.** 자동화의 예외 세 가지 중 하나다.
    command: 'APPROVE_LIVE_SMALL', label: 'LIVE 소액 승인',
    steps: ['migrations', 'deployment', 'worker', 'exitMonitor', 'exchange', 'orders', 'protection', 'ledger'],
    mutates: true, needsApproval: true, runBy: 'QUEUE',
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
  { re: /시크릿\s*동기화|비밀값\s*동기화|시크릿\s*맞춰|secret\s*sync|sync\s*secrets?/i, command: 'SYNC_SECRETS' },
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
  const order: OpsCommand[] = ['STOP_NOW', 'APPROVE_LIVE_SMALL', 'SYNC_SECRETS',
    'VERIFY_TESTNET', 'DEPLOY', 'RECOVER', 'CHECK_ALL'];
  for (const c of order) {
    const p = PHRASES.find(x => x.command === c);
    if (p && p.re.test(t)) return c;
  }
  return null;
}

export function specOf(c: OpsCommand): OpsCommandSpec | null {
  return OPS_COMMANDS.find(x => x.command === c) ?? null;
}

/**
 * 실행기가 집어 갈 수 있는 명령.
 *
 * **손으로 적은 목록을 두지 않는다.** `opsQueue.ts`가 그런 목록을 따로
 * 들고 있다가 `SYNC_SECRETS`를 빠뜨렸고, 그 요청은 큐에 들어간 뒤
 * `UNKNOWN_COMMAND`로 만료됐다 — 화면에도 있고 실행 분기도 있는데
 * 영원히 안 도는 상태였다.
 */
export function runnableCommands(): OpsCommand[] {
  return OPS_COMMANDS.filter(s => s.runBy === 'QUEUE').map(s => s.command);
}

/** 사람의 명시적 승인이 있어야 실행하는 명령 */
export function approvalCommands(): OpsCommand[] {
  return OPS_COMMANDS.filter(s => s.needsApproval).map(s => s.command);
}

/**
 * 이 명령을 요청 표(`ops_requests`)에 적을 것인가.
 *
 * **`mutates`로 판단하지 않는다.**
 *
 * 요청을 만드는 쪽은 원래 이렇게 돼 있었다:
 *
 *   if (command === 'STOP_NOW') { …킬 스위치… }
 *   else if (spec.mutates)      { …큐에 적는다… }
 *
 * `runBy`를 만들어 놓고도 삽입 쪽은 여전히 `mutates`로 **독자 판단**을
 * 했다. 지금 명령 구성에서는 우연히 맞는다 — 값을 바꾸면서 즉시
 * 실행되는 명령이 `STOP_NOW` 하나뿐이고 그게 위에서 걸러지기 때문이다.
 *
 * 그런 명령이 하나 더 생기는 순간 조용히 큐로 들어가고, 사용자는
 * "지금" 눌렀는데 5분 뒤에 실행된다. `SYNC_SECRETS`가 목록 하나 때문에
 * 영원히 안 돌던 것과 **같은 종류의 배선 버그**다.
 *
 * 그래서 삽입 여부도 `runBy` 하나에서만 나온다.
 */
export function queueInsertPlan(command: OpsCommand | string | null | undefined): {
  insert: boolean; reason: string;
} {
  const spec = OPS_COMMANDS.find(x => x.command === command) ?? null;
  if (!spec) {
    // **모르는 명령을 큐에 적지 않는다.** 적으면 실행기가 집어 가서
    // UNKNOWN_COMMAND로 만료시키고, 사용자는 왜 아무 일도 없는지 모른다.
    return { insert: false, reason: '모르는 명령입니다' };
  }
  if (spec.runBy === 'QUEUE') {
    return { insert: true, reason: `${spec.label}는 실행 자격이 필요해 요청으로 적습니다` };
  }
  return { insert: false, reason: `${spec.label}는 이 자리에서 끝납니다 — 큐에 적지 않습니다` };
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
  /**
   * 이 막힘이 **최초 1회 권한 연결**로 풀리는가.
   *
   * `BOOTSTRAP` — 토큰을 한 번 연결하면 끝난다
   * `FAULT`     — 연결해도 안 풀린다 (값이 서로 다르다, 워커가 죽었다 …)
   *
   * 이 둘을 섞으면 사용자는 "권한만 연결하면 되는구나"라고 읽고, 연결한
   * 뒤에도 같은 화면을 보게 된다. 기본값은 FAULT다 — **권한 문제라고
   * 말하려면 그렇다고 적어야 한다.**
   */
  kind?: 'BOOTSTRAP' | 'FAULT';
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
    && blocked.every(s => s.step === 'secrets' && s.kind === 'BOOTSTRAP');

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

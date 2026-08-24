// src/lib/ops/workerDiagnosis.ts
//
// **"워커가 왜 조용한가"에 사람이 Fly 대시보드를 열지 않고 답한다.**
//
// 지금까지 이랬다
// ───────────────
// 배포는 success로 끝나고 `flyctl status`는 `started`를 찍는데
// heartbeat는 38시간 전 것이다. 그 상태에서 워크플로가 하는 말은
// 이것뿐이었다:
//
//   "Fly 쪽 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 를 먼저 확인하세요"
//
// **그 문장이 두 번 틀렸다.**
//
//  1. 확인은 사람이 대시보드를 열어야 하는 일이다 — 이 저장소가
//     없애기로 한 바로 그 문장이다.
//  2. 그리고 실제로 그 둘은 맞아 있었다. sync-secrets가
//     `fly/SUPABASE_URL: ALREADY_SAME` · `fly/SUPABASE_SERVICE_ROLE_KEY:
//     ALREADY_SAME`을 찍고 있었는데도 배포는 저 문장으로 끝났다.
//     **추측한 원인을 단정으로 적으면 사람은 엉뚱한 곳을 판다.**
//
// 무엇으로 판단하는가
// ───────────────────
// 워크플로에는 이미 `FLY_API_TOKEN`이 있다. 그러면 사람이 볼 수 있는
// 것은 기계도 볼 수 있다:
//
//   flyctl status         머신이 몇 대, 어떤 상태, 몇 번 재시작했는가
//   flyctl secrets list   **이름과 다이제스트만.** 값은 flyctl도 안 준다
//   flyctl logs           워커가 스스로 남긴 이유
//
// 워커는 이미 자기 상태를 말하고 있다 — `[heartbeat] ok …`,
// `[heartbeat] 실패 …`, `SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정`.
// **그 말이 아무도 안 보는 곳에 쌓이고 있었을 뿐이다.**
//
// 값은 어디에도 남기지 않는다
// ───────────────────────────
// 이름과 다이제스트만 옮긴다. 로그는 긴 토큰처럼 생긴 것을 지우고 옮긴다
// (`scrubLogLine`). 지우지 못할 것 같으면 그 줄을 통째로 버린다 —
// **한 번 새면 기록에 영원히 남는다.**

/** 워커가 돌기 위해 Fly에 반드시 있어야 하는 이름 */
export const REQUIRED_WORKER_SECRETS = [
  // 없으면 sb()가 던진다 (worker/src/supabase.ts)
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

/**
 * 없어도 워커는 뜨지만 **그 기능만 조용히 죽는 이름.**
 *
 * 조용히 죽는 것이 더 나쁘다 — 워커는 살아 있고 heartbeat도 찍히는데
 * 주문만 안 나간다. `EXCHANGE_ENCRYPTION_KEY`가 정확히 그렇다:
 * `decryptSecret`이 빈 문자열을 돌려주고, 그 빈 값으로 거래소에
 * 서명하면 인증 실패가 된다.
 */
export const DEGRADED_WORKER_SECRETS: { name: string; alias?: string; lost: string }[] = [
  { name: 'EXCHANGE_ENCRYPTION_KEY', alias: 'ENCRYPTION_KEY', lost: '거래소 secret 복호화 — 주문이 나가지 않습니다' },
  { name: 'ADMIN_SECRET', lost: '예약 평가 호출 — 자동매매 예약이 돌지 않습니다' },
  { name: 'APP_URL', lost: '예약 평가 호출 대상 — 자동매매 예약이 돌지 않습니다' },
];

export type MachineState = { id: string; state: string; process?: string | null; version?: string | null };

export type DiagnosisCode =
  | 'NO_APP'            // Fly에 앱/머신이 없다 — 배포된 적이 없다
  | 'ALL_STOPPED'       // 머신이 전부 멈춰 있다
  | 'MISSING_SECRET'    // 필수 이름이 Fly에 없다 — 워커가 부팅 즉시 던진다
  | 'CRASH_LOOP'        // 뜨자마자 죽기를 반복한다
  | 'DB_WRITE_FAILED'   // 로그가 heartbeat 쓰기 실패를 말한다
  | 'STARTED_BUT_SILENT'// 떠 있는데 로그에 아무 단서가 없다
  | 'ALIVE'             // heartbeat가 있다 — 진단할 것이 없다
  | 'UNVERIFIED';       // 물어보지 못했다. **없다는 뜻이 아니다**

export interface DiagnosisInput {
  /** flyctl을 부르지 못했으면 false — 조회 실패를 '없음'으로 읽지 않는다 */
  queried: boolean;
  machines: MachineState[] | null;
  /** Fly에 있는 시크릿 **이름**만. null이면 못 읽은 것이다 */
  secretNames: string[] | null;
  /** 최근 로그 줄. null이면 못 읽은 것이다 */
  logLines: string[] | null;
  /** heartbeat를 마지막으로 쓴 지 몇 초 됐나. null이면 한 번도 없거나 모른다 */
  heartbeatAgeSec: number | null;
  /** 살아 있다고 볼 최대 나이 */
  aliveWithinSec?: number;
}

export interface Diagnosis {
  code: DiagnosisCode;
  /** 한 줄 결론 */
  headline: string;
  /** 그렇게 판단한 근거 — 추측과 사실을 섞지 않는다 */
  evidence: string[];
  /** 시스템이 이어서 할 수 있는 일. 사람이 할 일이면 그렇다고 적는다 */
  nextStep: string;
  /** 없어서 기능이 죽는 이름들 (필수는 아님) */
  degraded: string[];
}

const ALIVE_DEFAULT_SEC = 180;

/** 다이제스트/값처럼 생긴 긴 토큰을 지운다 */
export function scrubLogLine(line: string): string {
  let s = String(line ?? '');
  // JWT (Supabase service role 키가 이 모양이다)
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[가림:jwt]');
  // postgres/https URL 안의 자격 정보
  s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[가림]@');
  // 32자 이상 연속된 hex — 파생 키·다이제스트
  s = s.replace(/\b[0-9a-f]{32,}\b/gi, '[가림:hex]');
  // sk-/gh?_/fly 토큰 모양
  s = s.replace(/\b(sk|gh[pousr]|fo|fm)[_-][A-Za-z0-9_-]{16,}\b/g, '[가림:token]');
  return s;
}

/** 로그에서 원인이 될 만한 줄만 고른다. 값이 섞였을 것 같으면 버린다 */
export function interestingLogLines(lines: string[] | null, limit = 12): string[] {
  if (!Array.isArray(lines)) return [];
  const PAT = /(heartbeat|미설정|Error|error|Cannot|ECONN|ENOTFOUND|fetch failed|권한|permission|denied|relation|does not exist|EXCHANGE_ENCRYPTION_KEY|SUPABASE|시작|started|exit|crash)/;
  const out: string[] = [];
  for (const raw of lines) {
    const line = String(raw ?? '').trim();
    if (!line || !PAT.test(line)) continue;
    const safe = scrubLogLine(line);
    out.push(safe.slice(0, 300));
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 판정. **순수 함수** — 여기에 테스트가 붙는다.
 *
 * 확인하지 못한 것은 통과가 아니다. 그리고 **못 물어본 것을 "없다"로
 * 적지 않는다** — 그 둘은 다른 사실이고 고치는 방법도 다르다.
 */
export function diagnoseWorker(i: DiagnosisInput): Diagnosis {
  const within = i.aliveWithinSec ?? ALIVE_DEFAULT_SEC;
  const ev: string[] = [];

  // 살아 있으면 진단할 것이 없다. 먼저 본다.
  if (i.heartbeatAgeSec != null && i.heartbeatAgeSec <= within) {
    return {
      code: 'ALIVE',
      headline: `워커가 ${i.heartbeatAgeSec}초 전에 기록을 남겼습니다`,
      evidence: [`heartbeat ${i.heartbeatAgeSec}초 전 (기준 ${within}초)`],
      nextStep: '진단할 것이 없습니다.',
      degraded: [],
    };
  }

  if (!i.queried) {
    return {
      code: 'UNVERIFIED',
      headline: 'Fly에 물어보지 못했습니다 — 워커가 없다는 뜻이 아닙니다',
      evidence: ['flyctl 호출이 실패했거나 FLY_API_TOKEN이 없습니다'],
      nextStep: 'FLY_API_TOKEN을 한 번 연결하면 그 다음부터는 시스템이 스스로 봅니다.',
      degraded: [],
    };
  }

  const hbNote = i.heartbeatAgeSec == null
    ? 'heartbeat 기록이 없습니다 (한 번도 쓰지 못했거나 읽지 못했습니다)'
    : `heartbeat가 ${i.heartbeatAgeSec}초 전 것입니다 (기준 ${within}초)`;
  ev.push(hbNote);

  // ── 시크릿 이름 대조 ──
  //
  // **못 읽은 것과 없는 것을 가른다.** null이면 판단하지 않는다.
  const degraded: string[] = [];
  let missingRequired: string[] = [];
  if (Array.isArray(i.secretNames)) {
    const have = new Set(i.secretNames.map(n => String(n).trim()).filter(Boolean));
    missingRequired = REQUIRED_WORKER_SECRETS.filter(n => !have.has(n));
    for (const d of DEGRADED_WORKER_SECRETS) {
      if (have.has(d.name)) continue;
      if (d.alias && have.has(d.alias)) continue;
      degraded.push(`${d.name}${d.alias ? `(또는 ${d.alias})` : ''} 없음 — ${d.lost}`);
    }
    ev.push(`Fly 시크릿 이름 ${have.size}개 확인 (값은 읽지 않습니다)`);
  } else {
    ev.push('Fly 시크릿 이름을 읽지 못했습니다 — 없다는 뜻이 아닙니다');
  }

  const machines = Array.isArray(i.machines) ? i.machines : [];
  const started = machines.filter(m => String(m.state).toLowerCase() === 'started');
  if (machines.length) {
    ev.push(`머신 ${machines.length}대 — ${machines.map(m => `${m.id.slice(0, 6)}:${m.state}`).join(' · ')}`);
  }

  const logs = interestingLogLines(i.logLines);
  const logText = logs.join('\n');

  // ── 순서가 중요하다: 원인이 더 아래에 있는 것부터 배제한다 ──

  if (i.machines != null && machines.length === 0) {
    return {
      code: 'NO_APP',
      headline: 'Fly에 워커 머신이 없습니다 — 배포된 적이 없습니다',
      evidence: ev, degraded,
      nextStep: 'fly-deploy 워크플로를 돌리면 시스템이 배포합니다.',
    };
  }

  if (missingRequired.length > 0) {
    return {
      code: 'MISSING_SECRET',
      headline: `Fly에 ${missingRequired.join(' · ')}이(가) 없습니다 — 워커가 부팅하자마자 멈춥니다`,
      evidence: ev, degraded,
      nextStep: 'sync-secrets 워크플로를 apply로 돌리면 시스템이 밀어 넣습니다 (GitHub Secrets에 기준값이 있어야 합니다).',
    };
  }

  if (/미설정|SUPABASE_URL \/ SUPABASE_SERVICE_ROLE_KEY/.test(logText)) {
    return {
      code: 'MISSING_SECRET',
      headline: '워커가 "SUPABASE 미설정"이라고 말하고 있습니다',
      evidence: [...ev, ...logs], degraded,
      nextStep: 'sync-secrets를 apply로 돌려 Fly에 밀어 넣으세요 — 시스템이 합니다.',
    };
  }

  if (machines.length > 0 && started.length === 0) {
    return {
      code: 'ALL_STOPPED',
      headline: '머신이 전부 멈춰 있습니다',
      evidence: [...ev, ...logs], degraded,
      nextStep: 'fly-deploy를 다시 돌리면 시스템이 머신을 띄웁니다.',
    };
  }

  if (/exit|crash|restarting|Restarting/i.test(logText)) {
    return {
      code: 'CRASH_LOOP',
      headline: '워커가 떴다가 죽기를 반복하고 있습니다',
      evidence: [...ev, ...logs], degraded,
      nextStep: '아래 로그 줄이 이유입니다. 코드 문제면 고쳐서 다시 배포합니다.',
    };
  }

  if (/heartbeat.*(실패|failed)/i.test(logText)) {
    return {
      code: 'DB_WRITE_FAILED',
      headline: '워커는 살아 있는데 heartbeat 쓰기가 실패하고 있습니다',
      evidence: [...ev, ...logs], degraded,
      nextStep: '아래 실패 사유가 원인입니다 — 표·칸·권한 중 하나입니다.',
    };
  }

  return {
    code: 'STARTED_BUT_SILENT',
    headline: '머신은 떠 있는데 워커가 한 줄도 쓰지 않았습니다',
    evidence: [...ev, ...(logs.length ? logs : ['로그에서 단서를 찾지 못했습니다'])],
    degraded,
    nextStep: '떠 있는 것과 도는 것은 다릅니다. 위 로그가 비어 있으면 프로세스가 시작 자체를 못 한 것입니다.',
  };
}

/** 사람이 읽을 한 덩어리로 만든다 */
export function diagnosisReport(d: Diagnosis): string {
  const L: string[] = [];
  L.push(`[${d.code}] ${d.headline}`);
  L.push('');
  L.push('근거:');
  for (const e of d.evidence) L.push(`  · ${e}`);
  if (d.degraded.length) {
    L.push('');
    L.push('있어도 뜨지만 그 기능만 조용히 죽는 것:');
    for (const g of d.degraded) L.push(`  · ${g}`);
  }
  L.push('');
  L.push(`다음: ${d.nextStep}`);
  return L.join('\n');
}

// src/lib/ops/selfHeal.ts
//
// **스스로 고치되, 눈감고 고치지 않는다.**
//
// 자동 복구에는 두 가지 위험이 있고 둘 다 실제로 겪을 만한 것이다.
//
//   무한 재시작   고쳐지지 않는 원인을 계속 재시작으로 덮는다. 워커는
//                 죽고 살아나기를 반복하고, 로그는 그 소리로 가득 차고,
//                 진짜 원인은 그 안에 묻힌다.
//   눈감고 재시작 주문이 떠 있는 동안 워커를 갈아 끼우면 **그 사이의
//                 체결을 아무도 안 본다.**
//
// 그래서 규칙이 셋이다:
//
//   1. 열린 주문 수를 **모르면 아무것도 하지 않는다** (0으로 읽지 않는다)
//   2. 열린 주문이 있으면 **대조가 먼저다**
//   3. 같은 원인으로 N번 시도했으면 **멈추고 사람에게 말한다**
//
// 판정만 여기 있다. 실제 재시작은 자격을 가진 쪽(GitHub Actions)이 한다.

import type { RuntimeHealth } from '../runtime/runtimeHealth';

export type HealAction =
  | 'RECONCILE_FIRST'
  | 'RESTART_WORKER'
  | 'REDEPLOY_WORKER'
  | 'APPLY_MIGRATIONS';

export type HealCode =
  /** 할 일이 있고, 해도 된다 */
  | 'HEAL'
  /** 고칠 것이 없다 */
  | 'HEALTHY'
  /** 시도를 너무 많이 했다 — 멈추고 말한다 */
  | 'GIVE_UP'
  /** 지금은 만지면 안 된다 (주문 수 모름 등) */
  | 'HOLD'
  /** 자동으로 고칠 수 있는 종류가 아니다 */
  | 'NEEDS_HUMAN';

export interface HealPlan {
  code: HealCode;
  /** 순서대로 */
  actions: HealAction[];
  /** 무엇을 고치려는가 */
  trigger: string | null;
  /** 같은 원인으로 몇 번째인가 */
  attempt: number;
  reason: string;
  /** 사람이 봐야 하는 것 */
  needsHuman: string[];
}

/** 같은 원인으로 이 횟수를 넘기면 멈춘다 */
export const MAX_ATTEMPTS = 3;

/** 이 시간 안의 시도만 '같은 사건'으로 센다 */
export const ATTEMPT_WINDOW_MS = 60 * 60_000;

export interface HealAttempt {
  trigger: string;
  startedAtMs: number;
  outcome: string;
}

/**
 * 지금 무엇을 해 볼 것인가.
 *
 * **재시작이 먹히지 않는 고장을 재시작으로 덮지 않는다.** 같은 원인으로
 * 세 번 시도했으면 네 번째는 하지 않고, 무엇이 안 되는지 말한다.
 */
export function healPlan(i: {
  health: RuntimeHealth | null | undefined;
  /** 열린 주문 수. **못 읽었으면 null** */
  openOrders: number | null;
  /** 최근 시도 기록 (최신순). **못 읽었으면 undefined** */
  attempts: HealAttempt[] | null | undefined;
  nowMs: number;
}): HealPlan {
  const h = i?.health;
  if (!h) {
    return { code: 'HOLD', actions: [], trigger: null, attempt: 0,
      reason: '상태를 읽지 못했습니다 — 모르는 채로 워커를 만지지 않습니다', needsHuman: [] };
  }
  if (h.code === 'HEALTHY' || h.findings.length === 0) {
    return { code: 'HEALTHY', actions: [], trigger: null, attempt: 0,
      reason: h.summary, needsHuman: [] };
  }

  // 자동으로 손댈 수 있는 것과 없는 것을 가른다.
  const fixable = h.findings.filter(f => !!f.autoFix);
  const human = h.findings.filter(f => !f.autoFix && f.needsHuman)
    .map(f => `${f.code}: ${f.needsHuman}`);

  if (fixable.length === 0) {
    return {
      code: 'NEEDS_HUMAN', actions: [], trigger: h.code, attempt: 0,
      // **값을 바꿔야 하는 고장은 자동으로 하지 않는다.** 다른 DB를 보고
      // 있는 워커를 재시작해 봐야 같은 곳에 다시 붙는다.
      reason: human[0] || '자동으로 고칠 수 있는 종류가 아닙니다',
      needsHuman: human,
    };
  }

  // 가장 나쁜 것부터 고친다.
  const trigger = fixable[0].code;

  // ── 같은 원인으로 몇 번째인가 ──
  if (i?.attempts === undefined) {
    // 기록을 못 읽었다. **0번으로 세지 않는다** — 그러면 무한 재시작이 된다.
    return { code: 'HOLD', actions: [], trigger, attempt: 0,
      reason: '지난 복구 시도 기록을 읽지 못했습니다 — 몇 번째인지 모르는 채로 다시 시도하지 않습니다',
      needsHuman: human };
  }
  const recent = (i.attempts ?? []).filter(a =>
    a && a.trigger === trigger && (i.nowMs - a.startedAtMs) < ATTEMPT_WINDOW_MS);
  const attempt = recent.length + 1;

  if (recent.length >= MAX_ATTEMPTS) {
    return {
      code: 'GIVE_UP', actions: [], trigger, attempt,
      reason: `같은 원인(${trigger})으로 ${recent.length}번 복구를 시도했지만 낫지 않았습니다 — `
        + '더 시도해도 같은 결과일 가능성이 높아 멈춥니다',
      needsHuman: [...human, `${trigger}: 자동 복구로 낫지 않습니다`],
    };
  }

  // ── 주문이 떠 있으면 ──
  if (i.openOrders == null) {
    // **모르면 만지지 않는다.** 열린 주문을 못 읽은 채로 워커를 갈아
    // 끼우면 그 사이 체결을 아무도 안 본다.
    return { code: 'HOLD', actions: [], trigger, attempt,
      reason: '열린 주문 수를 확인하지 못해 워커를 만지지 않았습니다', needsHuman: human };
  }

  const actions: HealAction[] = [];
  if (i.openOrders > 0) actions.push('RECONCILE_FIRST');

  // 세 번째 시도부터는 재시작 대신 재배포로 올린다. 같은 이미지를
  // 다시 띄우는 것으로 안 나으면 이미지가 문제일 수 있다.
  for (const f of fixable) {
    let a = f.autoFix as HealAction;
    if (a === 'RESTART_WORKER' && attempt >= 3) a = 'REDEPLOY_WORKER';
    if (!actions.includes(a)) actions.push(a);
  }

  return {
    code: 'HEAL', actions, trigger, attempt,
    reason: `${trigger}를 고칩니다 (${attempt}번째 시도)`
      + (i.openOrders > 0 ? ` — 열린 주문 ${i.openOrders}건이 있어 대조를 먼저 합니다` : ''),
    needsHuman: human,
  };
}

// ── 고친 뒤에 정말 나았는가 ──

export interface HealVerdict {
  outcome: 'HEALED' | 'FAILED' | 'BLOCKED';
  verified: boolean;
  reason: string;
}

/**
 * **명령이 0으로 끝난 것과 낫는 것은 다른 사실이다.**
 *
 * `flyctl machine restart`는 머신을 재시작했다는 뜻이지 워커가 일을
 * 하고 있다는 뜻이 아니다. 그래서 고친 뒤 상태를 다시 읽어 확인한다.
 */
export function healVerdict(i: {
  /** 실행 자체가 성공했는가 */
  commandOk: boolean;
  /** 고친 뒤 다시 읽은 상태. **못 읽었으면 undefined** */
  after: RuntimeHealth | null | undefined;
  before: string | null;
}): HealVerdict {
  if (!i?.commandOk) {
    return { outcome: 'FAILED', verified: false, reason: '복구 명령 자체가 실패했습니다' };
  }
  if (i?.after === undefined) {
    return { outcome: 'BLOCKED', verified: false,
      reason: '복구 후 상태를 다시 읽지 못했습니다 — 나았다고 적지 않습니다' };
  }
  if (!i.after) {
    return { outcome: 'BLOCKED', verified: false, reason: '복구 후 워커 기록이 없습니다' };
  }
  if (i.after.code === 'HEALTHY') {
    return { outcome: 'HEALED', verified: true, reason: i.after.summary };
  }
  if (i.before && i.after.code !== i.before) {
    // 원인이 바뀌었다. 하나는 나았고 다른 것이 남았다.
    return { outcome: 'FAILED', verified: false,
      reason: `${i.before}는 사라졌지만 ${i.after.code}가 남았습니다 — ${i.after.summary}` };
  }
  return { outcome: 'FAILED', verified: false,
    reason: `복구 후에도 같은 상태입니다 — ${i.after.summary}` };
}

// ── 배포가 정말 끝났는가 ──

export type DeployVerifyCode = 'VERIFIED' | 'MISMATCH' | 'UNKNOWN';

export interface DeployVerification {
  code: DeployVerifyCode;
  reason: string;
  /** 무엇이 확인됐고 무엇이 안 됐는지 */
  checks: Array<{ name: string; ok: boolean | null; detail: string }>;
}

/**
 * **"머지됐다"와 "배포됐다"와 "그 코드가 돌고 있다"는 서로 다른 사실이다.**
 *
 * 이 저장소는 그 셋을 섞어서 두 번 사고를 냈다. 8/13에는 fly-deploy가
 * 안 돌아 워커가 나흘 전 코드로 돌았고, 8/15에는 실행 기록은 남는데 job이
 * 전부 skipped라 **배포가 도는 것처럼 보였다.**
 *
 * 여섯 가지가 전부 확인돼야 VERIFIED다. **하나라도 모르면 UNKNOWN이고,
 * UNKNOWN은 성공이 아니다.**
 */
export function deployVerification(i: {
  mainSha: string | null | undefined;
  vercelSha: string | null | undefined;
  flySha: string | null | undefined;
  /** 워커가 최근에 살아 있다는 신호를 보냈는가. **못 읽었으면 null** */
  workerFresh: boolean | null;
  /** 코드가 요구하는 마이그레이션이 다 들어갔는가. **못 읽었으면 null** */
  migrationsApplied: boolean | null;
}): DeployVerification {
  const norm = (v: any) => String(v ?? '').trim().toLowerCase();
  const main = norm(i?.mainSha), vercel = norm(i?.vercelSha), fly = norm(i?.flySha);
  const same = (a: string, b: string) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

  const checks: DeployVerification['checks'] = [
    { name: 'main SHA', ok: main ? true : null,
      detail: main ? main.slice(0, 7) : '모름 — 어느 커밋이 기준인지 알 수 없습니다' },
    { name: 'Vercel SHA', ok: vercel ? same(main, vercel) : null,
      detail: vercel ? vercel.slice(0, 7) : '모름' },
    { name: 'Fly SHA', ok: fly ? same(main, fly) : null,
      detail: fly ? fly.slice(0, 7) : '모름 — 비어 있는 것은 "같다"가 아닙니다' },
    { name: '워커 생존', ok: i?.workerFresh ?? null,
      detail: i?.workerFresh == null ? '확인하지 못했습니다'
        : i.workerFresh ? '최근 신호 있음' : '신호가 오래됐습니다' },
    { name: '마이그레이션', ok: i?.migrationsApplied ?? null,
      detail: i?.migrationsApplied == null ? '확인하지 못했습니다'
        : i.migrationsApplied ? '코드가 요구하는 것이 모두 적용됨' : '적용되지 않은 것이 있습니다' },
  ];

  const failed = checks.filter(c => c.ok === false);
  const unknown = checks.filter(c => c.ok == null);

  if (failed.length > 0) {
    return { code: 'MISMATCH', checks,
      reason: `${failed.map(f => f.name).join(' · ')}가 맞지 않습니다 — 배포가 끝나지 않았습니다` };
  }
  if (unknown.length > 0) {
    // **모르는 것을 성공으로 적지 않는다.**
    return { code: 'UNKNOWN', checks,
      reason: `${unknown.map(u => u.name).join(' · ')}를 확인하지 못했습니다 — 배포 완료로 적지 않습니다` };
  }
  return { code: 'VERIFIED', checks,
    reason: '코드·워커·스키마가 전부 확인됐습니다 — 배포가 끝났습니다' };
}

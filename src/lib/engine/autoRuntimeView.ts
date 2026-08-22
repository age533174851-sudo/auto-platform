// src/lib/engine/autoRuntimeView.ts
//
// **화면이 운영 사실을 지어내지 못하게 한다.**
//
// 무엇이 있었나
// ─────────────
// 2026-08-19, 실제 운영은 이랬다:
//
//   main = Vercel = Fly = 3c46151 · deployment MATCHED
//   Fly Worker alive · heartbeat 정상
//
// 그런데 자동 화면은 이렇게 말하고 있었다:
//
//   "Worker (Railway) · 없음"
//   "지금은 쓰지 않습니다 — 자동매매는 Vercel 크론이 돌립니다"
//   "Railway 워커는 Binance 지역 차단으로 쓰지 않습니다"
//   "이 판은 브라우저 엔진 상태입니다"
//
// 넷 다 **지금은 사실이 아니다.** 예전에는 사실이었고, 그래서 더
// 위험하다 — 화면이 자신 있게 틀린 말을 한다. 사용자는 워커가 없다고
// 읽고, 정작 살아 있는 워커를 확인하지 않는다.
//
// 이건 디자인 취향이 아니라 **제품이 거짓 상태를 표시하는 오류**다.
//
// 그래서 규칙
// ───────────
// 화면은 운영 사실을 **직접 쓰지 않는다.** 서버가 준 값으로 이 파일이
// 문장을 만들고, 화면은 그것을 그대로 그린다. 공급자 이름("Fly")도
// 서버가 준 값이다 — 화면에 상수로 적어 두면 다음에 옮길 때 또 이
// 고장이 난다.
//
// 그리고 **모르는 것을 정상으로 바꾸지 않는다.** 조회 실패는 '없음'이
// 아니고, 오래된 하트비트는 '정상'이 아니다.

export type RuntimeHealth =
  /** 하트비트가 최근이다 */
  | 'RUNNING'
  /** 느리다. 아직 살아 있을 수 있다 */
  | 'DEGRADED'
  /** 끊겼거나 스스로 중단을 보고했다 */
  | 'STOPPED'
  /** 하트비트 행이 아예 없다 */
  | 'ABSENT'
  /** 조회 자체를 못 했다. **'없음'이 아니다** */
  | 'UNKNOWN'
  /** 아직 안 읽었다 */
  | 'LOADING';

/** 화면이 쓰는 색 이름. 규칙을 화면마다 다시 정하지 않는다 */
export type Tone = 'GREEN' | 'YELLOW' | 'RED' | 'GRAY';

export interface WorkerFacts {
  /** 어디서 도는가. **서버가 준 값이다** — 화면에 적어 두지 않는다 */
  provider?: string | null;
  status?: string | null;
  workerId?: string | null;
  lastSeen?: string | null;
  ageSec?: number | null;
  version?: string | null;
  task?: string | null;
  errorCount?: number | null;
  /** 조회 자체를 못 했는가 */
  readFailed?: boolean;
}

export interface DeploymentFacts {
  /** 'MATCHED' | 'MISMATCH' | 'UNKNOWN' */
  code?: string | null;
  webSha?: string | null;
  workerSha?: string | null;
}

export interface AutoRuntimeView {
  health: RuntimeHealth;
  tone: Tone;
  /** 'Worker · 정상' */
  title: string;
  /** 'Fly · 3c46151 · 방금 확인' */
  detail: string;
  /** 한 줄 더. 없으면 null */
  sub: string | null;
  /** 이 상태에서 자동매매가 실제로 돌 수 있는가 */
  canRun: boolean;
  /** 사람이 지금 해야 할 일. 없으면 null */
  action: string | null;
}

const s = (v: any): string => String(v ?? '').trim();

/** '방금 확인' · '32초 전' · '4분 전' */
export function agoText(ageSec: number | null | undefined): string {
  if (ageSec == null || !Number.isFinite(Number(ageSec))) return '시각 모름';
  const n = Math.max(0, Math.round(Number(ageSec)));
  if (n < 10) return '방금 확인';
  if (n < 60) return `${n}초 전`;
  if (n < 3600) return `${Math.floor(n / 60)}분 전`;
  if (n < 86400) return `${Math.floor(n / 3600)}시간 전`;
  return `${Math.floor(n / 86400)}일 전`;
}

function healthOf(f: WorkerFacts): RuntimeHealth {
  if (f?.readFailed === true) return 'UNKNOWN';
  const raw = s(f?.status).toUpperCase();
  if (raw === 'RUNNING') return 'RUNNING';
  if (raw === 'DEGRADED') return 'DEGRADED';
  if (raw === 'STOPPED') return 'STOPPED';
  if (raw === 'ABSENT') return 'ABSENT';
  if (raw === 'UNKNOWN') return 'UNKNOWN';
  if (raw === 'LOADING' || raw === '') return 'LOADING';
  // 모르는 값을 정상으로 눕히지 않는다.
  return 'UNKNOWN';
}

const TONE: Record<RuntimeHealth, Tone> = {
  RUNNING: 'GREEN', DEGRADED: 'YELLOW', STOPPED: 'RED',
  ABSENT: 'RED', UNKNOWN: 'YELLOW', LOADING: 'GRAY',
};

const HEALTH_LABEL: Record<RuntimeHealth, string> = {
  RUNNING: '정상', DEGRADED: '지연', STOPPED: '중단',
  ABSENT: '없음', UNKNOWN: '확인 불가', LOADING: '확인 중',
};

/**
 * 워커 한 줄.
 *
 * **공급자 이름을 여기서 짓지 않는다.** 서버가 안 주면 '실행기'라고만
 * 적는다 — 'Railway'라고 적어 두면 Fly로 옮긴 뒤에도 그대로 남고,
 * 실제로 그렇게 남아서 화면이 거짓말을 했다.
 */
export function autoRuntimeView(i: {
  worker?: WorkerFacts | null;
  deployment?: DeploymentFacts | null;
  /**
   * **어느 배포에서 보고 있는가.**
   *
   * Preview에는 운영 Worker가 보고하지 않는다 — **그게 정상이다.**
   * 그런데 여기서 그 사실을 모르면 화면에 "Worker · 없음 / 실행기가
   * 한 번도 보고한 적이 없습니다"가 빨갛게 뜨고, 운영이 멀쩡한데
   * 사람이 운영을 고치러 간다.
   *
   * **운영에서는 하나도 안 느슨해진다.** 안 주면 운영과 같은 엄격함이다.
   */
  deployEnv?: import('../system/deployEnv').DeployEnv | null;
}): AutoRuntimeView {
  const f = i?.worker ?? {};
  const health = healthOf(f);
  const provider = s(f.provider) || '실행기';
  const version = s(f.version);
  const dep = s(i?.deployment?.code).toUpperCase();

  const bits: string[] = [provider];
  if (version) bits.push(version.slice(0, 7));
  if (health !== 'LOADING' && health !== 'ABSENT' && health !== 'UNKNOWN') {
    bits.push(agoText(f.ageSec));
  }

  let sub: string | null = null;
  let action: string | null = null;
  let tone = TONE[health];

  if (health === 'RUNNING' || health === 'DEGRADED') {
    const parts: string[] = [];
    if (s(f.task)) parts.push(s(f.task));
    if (f.errorCount != null && Number(f.errorCount) > 0) parts.push(`오류 ${Number(f.errorCount)}건`);
    if (s(f.workerId)) parts.push(s(f.workerId));
    sub = parts.length ? parts.join(' · ') : null;
  }
  if (health === 'DEGRADED') {
    action = '하트비트가 느립니다 — 실행이 밀릴 수 있습니다';
  }
  if (health === 'STOPPED') {
    sub = '자동매매·예약 청산·손절 감시가 함께 멈춥니다';
    action = '워커를 확인하세요';
  }
  if (health === 'ABSENT') {
    sub = '실행기가 한 번도 보고한 적이 없습니다';
    action = '워커 배포를 확인하세요';
    // ── Preview에는 안 오는 것이 정상이다 ──
    //
    // 미리보기 배포에 운영 Worker를 붙이지 않는다. 그 상태를 장애로
    // 그리면 **운영이 멀쩡한데 미리보기를 운영처럼 진단**하게 된다.
    if (i?.deployEnv === 'preview' || i?.deployEnv === 'development') {
      const { envLabel } = require('../system/deployEnv');
      tone = 'GRAY';
      sub = `${envLabel(i.deployEnv)} 배포입니다 — 운영 Worker는 여기에 보고하지 않습니다`;
      action = '자동매매 실행 여부는 운영 배포에서 확인하세요';
    }
  }
  if (health === 'UNKNOWN') {
    // **'없음'과 다르다.** 못 읽은 것을 없다고 적으면 사람이 엉뚱한
    // 곳을 고치러 간다.
    sub = '상태를 읽지 못했습니다 — 없다는 뜻이 아닙니다';
    action = '잠시 뒤 다시 확인하세요';
  }

  // 배포가 어긋나 있으면 워커가 살아 있어도 **다른 코드**가 돌고 있다.
  // 그건 '정상'이라고 적을 수 있는 상태가 아니다.
  if ((health === 'RUNNING' || health === 'DEGRADED') && dep === 'MISMATCH') {
    tone = 'YELLOW';
    sub = '웹과 워커가 다른 코드를 돌리고 있습니다';
    action = '배포 버전 불일치 · 자동매매 확인 필요';
  }

  return {
    health, tone,
    title: `Worker · ${HEALTH_LABEL[health]}`,
    detail: bits.join(' · '),
    sub,
    canRun: health === 'RUNNING' || health === 'DEGRADED',
    action,
  };
}

// ── 화면끼리 모순되지 않는가 ─────────────────────────

export interface Contradiction {
  code: string;
  message: string;
}

/**
 * **한 화면이 서로 다른 말을 하고 있지 않은가.**
 *
 * 실제로 이런 화면이 나왔다: 위에는 자동매매 RUNNING, 아래에는
 * "워커 없음", 예약은 켜짐, 그런데 Fly는 살아 있음. 사람이 무엇을
 * 믿어야 할지 알 수 없다.
 *
 * 값으로 잡아서 테스트가 막는다.
 */
export function runtimeContradictions(i: {
  autoRunning?: boolean | null;
  scheduleEnabled?: boolean | null;
  worker?: WorkerFacts | null;
  deployment?: DeploymentFacts | null;
  deployEnv?: import('../system/deployEnv').DeployEnv | null;
}): Contradiction[] {
  const out: Contradiction[] = [];
  const v = autoRuntimeView({
    worker: i?.worker, deployment: i?.deployment, deployEnv: i?.deployEnv,
  });

  if (i?.autoRunning === true && !v.canRun && i?.deployEnv !== 'preview'
      && i?.deployEnv !== 'development') {
    out.push({ code: 'RUNNING_WITHOUT_WORKER',
      message: `자동매매는 '실행 중'인데 실행기는 ${HEALTH_LABEL[v.health]}입니다 — 둘 중 하나는 틀렸습니다` });
  }
  // **Preview에서는 이 모순이 모순이 아니다.** 운영 Worker가 여기에
  // 보고하지 않는 것뿐이고, 예약은 운영 배포에서 돈다.
  const previewLike = i?.deployEnv === 'preview' || i?.deployEnv === 'development';
  if (i?.scheduleEnabled === true && v.health === 'ABSENT' && !previewLike) {
    out.push({ code: 'SCHEDULE_WITHOUT_WORKER',
      message: '예약은 켜져 있는데 실행기가 없습니다 — 예약 시각에 아무 일도 일어나지 않습니다' });
  }
  if (v.canRun && s(i?.deployment?.code).toUpperCase() === 'MISMATCH') {
    out.push({ code: 'DEPLOY_SKEW',
      message: '실행기는 살아 있지만 웹과 다른 코드를 돌리고 있습니다' });
  }
  return out;
}

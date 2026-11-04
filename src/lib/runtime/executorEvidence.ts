// src/lib/runtime/executorEvidence.ts
//
// **워커가 살아 있는지를 "사람이 열어 보는 곳"이 아니라 "시스템이 저절로
// 남기는 증거"에 싣는다.**
//
// `CLAUDE.md`가 금지한 문장들이 여기서 나왔다:
//
//     "fly logs를 열어 확인해 주세요"
//     "heartbeat를 확인해 주세요"
//     "exit-monitor가 도는지 사람이 봐 주세요"
//
// 없던 것은 데이터도 판정도 아니다. **배선이다.**
//
//   · 데이터는 있다 — 워커가 매 틱 `worker_heartbeat`에 적는다
//     (`worker/src/index.ts`의 `heartbeat(WORKER_ID, ...)`).
//   · 판정도 있다 — `judgeExecutor` 한 곳에 있고 임계값도 거기 있다.
//   · 그런데 그걸 읽는 곳은 `/api/worker/status` 하나였고, 그 라우트는
//     **인증이 필요하고 아무 자동 회차도 부르지 않는다.** 그래서 워커가
//     죽어도 사람이 로그인해서 열어 보기 전에는 아무 데도 안 적혔다.
//
// 청산 감시 라우트는 다르다. 워커가 5분마다 부르고, 백업 회차가 한 시간에
// 한 번 불러서 **응답 본문을 Actions 로그에 그대로 남긴다.** 거기에 이
// 블록을 실으면 워커 생존이 사람 손을 타지 않고 기록된다.
//
// 판정을 여기서 **다시 적지 않는다.** 임계값이 두 곳에 있으면 화면은
// '정상'인데 주문은 막히는 상태가 생긴다 (`/api/worker/status`의 주석이
// 같은 말을 한다). 이 파일이 하는 일은 `judgeExecutor`의 판정에 **그 줄이
// 실제로 적어 둔 값들**을 붙여 모양을 맞추는 것뿐이다.
import { judgeExecutor, type ExecutorStatus, type HeartbeatRow } from '@/lib/jobs/executorHealth';

/** heartbeat 줄에서 읽는, 비밀이 아닌 칸들 */
interface HeartbeatExtras {
  provider?: string | null;
  version?: string | null;
  region?: string | null;
  machine_id?: string | null;
  started_at?: string | null;
  tick_count?: number | null;
  startup_ok?: boolean | null;
}

export type ExecutorEvidenceRow = HeartbeatRow & HeartbeatExtras;

export interface ExecutorEvidence {
  status: ExecutorStatus;
  label: string;
  /** 하트비트가 몇 초 전인가. **모르면 null이다 — 0이 아니다.** */
  ageSec: number | null;
  workerId: string | null;
  canQueue: boolean;
  reason: string | null;
  lastSeen: string | null;
  /** 이 워커가 돌리고 있는 커밋. 비어 있으면 "같다"가 아니라 **"모름"**이다 */
  version: string | null;
  provider: string | null;
  region: string | null;
  machineId: string | null;
  startedAt: string | null;
  tickCount: number | null;
  errorCount: number | null;
  task: string | null;
  startupOk: boolean | null;
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};
const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v)) ? v : null;
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/**
 * 판정 + 그 줄이 적어 둔 값 → 응답에 실을 블록. 순수 함수.
 *
 * **`readFailed`면 줄에서 아무것도 가져오지 않는다.** 조회에 실패했다는
 * 것은 들고 있는 객체가 낡았거나 반쯤 찬 것일 수 있다는 뜻이고, 그걸
 * 그대로 실으면 "확인하지 못한 것"이 "확인한 값"으로 읽힌다.
 */
export function executorEvidenceFrom(
  row: ExecutorEvidenceRow | null | undefined,
  nowMs: number,
  readFailed = false,
): ExecutorEvidence {
  const v = judgeExecutor(readFailed ? null : row, nowMs, readFailed);
  // 못 읽었으면 줄에서 읽는 칸은 전부 null이다.
  const r: ExecutorEvidenceRow | null = readFailed ? null : (row ?? null);
  return {
    status: v.status,
    label: v.label,
    ageSec: v.ageSec,
    workerId: v.workerId,
    canQueue: v.canQueue,
    // `judgeExecutor`는 정상일 때 빈 문자열을 준다. 빈 문자열을 "이유가
    // 있다"로 읽지 않게 null로 맞춘다.
    reason: str(v.reason),
    lastSeen: str(r?.last_seen),
    version: str(r?.version),
    provider: str(r?.provider),
    region: str(r?.region),
    machineId: str(r?.machine_id),
    startedAt: str(r?.started_at),
    tickCount: num(r?.tick_count),
    errorCount: num(r?.error_count),
    task: str(r?.current_task),
    startupOk: bool(r?.startup_ok),
  };
}

/** `select('*')`로 읽은 줄을 **그대로 펼치지 않는다** — 칸을 골라 담는다 */
function pick(raw: unknown): ExecutorEvidenceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  // 나중에 이 표에 칸이 더 생겨도 여기 없는 것은 응답에 실리지 않는다.
  // 펼쳐 담으면 **다음에 추가되는 칸이 뭐든 밖으로 나간다.**
  return {
    worker_id: str(o.worker_id), last_seen: str(o.last_seen), status: str(o.status),
    current_task: str(o.current_task), error_count: num(o.error_count),
    provider: str(o.provider), version: str(o.version), region: str(o.region),
    machine_id: str(o.machine_id), started_at: str(o.started_at),
    tick_count: num(o.tick_count), startup_ok: bool(o.startup_ok),
  };
}

/** heartbeat 한 줄을 읽는 쪽. 조회 자체가 실패하면 `readFailed`다 */
export interface HeartbeatSource {
  from: (table: string) => any;
}

/**
 * 가장 최근 heartbeat 한 줄을 읽어 블록을 만든다.
 *
 * **던지지 않는다.** 이건 관측이고, 관측이 실패해서 청산 감시가 멈추면
 * 바꿔 놓은 것이 더 나쁘다. 실패는 `status: 'unknown'`으로 드러난다 —
 * 조용히 '정상'이 되지 않는다.
 */
export async function readExecutorEvidence(
  sb: HeartbeatSource | null | undefined,
  nowMs: number = Date.now(),
): Promise<ExecutorEvidence> {
  if (!sb) return executorEvidenceFrom(null, nowMs, true);
  try {
    const { data, error } = await (sb.from('worker_heartbeat') as any)
      .select('*').order('last_seen', { ascending: false }).limit(1).maybeSingle();
    if (error) return executorEvidenceFrom(null, nowMs, true);
    return executorEvidenceFrom(pick(data), nowMs, false);
  } catch {
    return executorEvidenceFrom(null, nowMs, true);
  }
}

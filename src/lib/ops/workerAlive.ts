// src/lib/ops/workerAlive.ts
//
// **떠 있는 것과 돌고 있는 것은 다르다.**
//
// 2026-08-21에 fly-deploy가 success로 끝났고 `flyctl status`도 `started`를
// 찍었다. 그런데 워커의 heartbeat는 27.6시간 전 것이었다 — 머신은 새
// 코드로 떠 있는데 프로세스가 DB에 한 줄도 못 쓰고 있었다.
//
// 그 상태에서는 청산 감시도, 원장 수집도, 자산 스냅샷도, 예약 평가도
// 전부 멈춘다. **그런데 배포 로그는 초록이다.**
//
// 왜 판정을 여기로 빼나
// ─────────────────────
// 처음에는 이 판정을 워크플로 YAML 안의 `python3 -c` 여러 줄로 넣었다.
// 그 여러 줄이 `run: |` 블록 스칼라의 들여쓰기를 벗어나면서 `try:`와
// `except Exception:`이 **워크플로의 최상위 키**가 됐고, GitHub은 그
// 파일을 Startup failure로 거절했다. 그때부터 fly-deploy는 아예 실행되지
// 않았고 `workflow_dispatch`는 HTTP 422를 돌려줬다.
//
// 더 나쁜 건 `yaml.safe_load`가 그 파일을 **통과시켰다**는 것이다 —
// 문법상 올바른 YAML이 맞기 때문이다. 유효한 YAML과 유효한 워크플로는
// 다르다.
//
// 그래서 판정을 파일 하나로 옮긴다. YAML에는 `node scripts/...` 한 줄만
// 남는다 — 들여쓰기로 깨질 것이 없고, 테스트가 판정을 지킨다.

export type AliveCode =
  /** 워커가 이번 배포 뒤에 실제로 한 줄 썼다 */
  | 'ALIVE'
  /** 아직이다. 더 기다린다 */
  | 'WAITING'
  /** 끝내 안 썼다. **배포는 됐는데 워커가 안 도는 상태다** */
  | 'TIMEOUT'
  /** 응답을 읽지 못했다. **살아 있다는 뜻이 아니다** */
  | 'UNREADABLE';

export interface AliveVerdict {
  code: AliveCode;
  /** 더 기다릴 필요 없이 결론이 났는가 */
  done: boolean;
  /** 성공으로 끝낼 수 있는가 */
  ok: boolean;
  ageSec: number | null;
  reason: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 배포 뒤 워커가 살아났는가.
 *
 * **못 읽은 것을 살아 있다고 하지 않는다.** 그리고 시간이 남아 있으면
 * 못 읽은 것도 아직 결론이 아니다 — 재배포 직후 몇십 초는 응답이
 * 흔들릴 수 있다.
 */
export function workerAliveVerdict(i: {
  /** `/api/system/deployment` 응답. **못 읽었으면 null** */
  body: any;
  /** 기다리기 시작한 뒤 흐른 시간 */
  elapsedMs: number;
  /** 이만큼 지나면 결론을 낸다 */
  budgetMs: number;
}): AliveVerdict {
  const fly = i?.body?.fly ?? null;
  const ageSec = num(fly?.ageSec);
  const outOfTime = Number(i?.elapsedMs) >= Number(i?.budgetMs);

  if (fly && fly.alive === true) {
    return { code: 'ALIVE', done: true, ok: true, ageSec,
      reason: ageSec == null ? '워커가 살아났습니다' : `워커가 살아났습니다 (마지막 기록 ${ageSec}초 전)` };
  }

  if (!fly) {
    // **살아 있다는 뜻이 아니다.** 시간이 남았으면 다시 본다.
    return outOfTime
      ? { code: 'UNREADABLE', done: true, ok: false, ageSec: null,
          reason: '배포 상태를 끝내 읽지 못했습니다 — 워커가 살아 있다는 뜻이 아닙니다' }
      : { code: 'WAITING', done: false, ok: false, ageSec: null,
          reason: '배포 상태를 아직 읽지 못했습니다' };
  }

  if (outOfTime) {
    return { code: 'TIMEOUT', done: true, ok: false, ageSec,
      reason: `배포는 끝났는데 워커가 한 줄도 쓰지 않았습니다`
        + (ageSec == null ? '' : ` (마지막 기록 ${ageSec}초 전)`)
        + ' — 머신이 started여도 프로세스가 DB에 못 쓰면 '
        + '청산 감시·원장 수집·자산 스냅샷·예약 평가가 전부 멈춥니다' };
  }
  return { code: 'WAITING', done: false, ok: false, ageSec,
    reason: '워커가 아직 새 기록을 쓰지 않았습니다' };
}

/** 몇 번, 얼마 간격으로 볼 것인가. 두 곳에 갈리지 않게 여기 하나만 둔다 */
export const ALIVE_BUDGET_MS = 120_000;
export const ALIVE_INTERVAL_MS = 3_000;

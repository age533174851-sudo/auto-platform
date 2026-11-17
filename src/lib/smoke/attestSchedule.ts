// src/lib/smoke/attestSchedule.ts
//
// **두 번째 관측을 사람이 누르지 않게 한다.**
//
// 무엇이 있었나
// ─────────────
// 레거시 노출 사후 확인은 **간격을 둔 관측 두 번**이 필요하다. 서버는
// 그렇게 설계돼 있고, 그 사실을 스스로 적어 뒀다
// (`exposureAttestation.ts`):
//
//   "지나면 다시 확인한다 — **확인은 자동이므로 사람이 할 일은 늘지
//    않는다**"
//   "사람이 할 일은 '노출 해소해' 한 마디다. 나머지는 이 계획기가 정한다"
//
// 그런데 화면은 이렇게 적고 있었다:
//
//   "첫 확인 후 10분이 지나면 **한 번 더 눌러 주세요**"
//   (`SmokeExposureRecovery.tsx`)
//
// 계획기는 있는데 **화면에 배선이 없었다.** 그래서 테스트넷 실주문 검증은
// 사람이 10분 뒤에 다시 와서 누르지 않으면 영원히 풀리지 않는다. 그리고
// 첫 관측은 6시간 뒤 만료되므로, 잊고 다음 날 누르면 **처음부터 다시**다.
//
// `CLAUDE.md`가 금지한 문장이 바로 그 모양이다 — "…해 주세요"가 보고나
// 화면에 필요해지면, 그 문장을 없애는 코드를 먼저 쓴다.
//
// 무엇을 하지 않는가
// ──────────────────
// ★ **서버의 관문을 건드리지 않는다.** 간격 요구 · 본인만(관리자 우회
//   없음) · 못 읽은 것은 0건이 아님 — 전부 그대로다. 바뀌는 것은
//   "누가 두 번째 요청을 보내는가" 하나뿐이다.
//
// ★ **첫 관측은 자동으로 하지 않는다.** 그것이 사용자의 명령 한 마디다.
//   첫 관측 없이 자동으로 거래소를 읽으면, 사용자가 시키지 않은 조회가
//   계좌에 나간다.
//
// ★ **되풀이하지 않는다.** 한 첫 관측에 대해 자동 관측은 **단 한 번**이다
//   (`tried`가 `${id}@${firstObservedAt}`로 기억한다). 노출이 보이면
//   서버가 기록을 지우므로(`RESET`) `firstObservedAt`이 null이 되고, 이
//   계획기는 아무것도 하지 않는다 — **"비어 있을 때까지 다시 뽑기"가
//   되지 않는다.** 그 금지는 `planAttestation`의 주석이 먼저 적었다.
import { ATTEST_MIN_GAP_MS } from './exposureAttestation';

/**
 * 간격을 넘겨 쏘는 여유.
 *
 * 서버는 `t2 - t1 < ATTEST_MIN_GAP_MS`면 `TOO_CLOSE`로 거절한다. 두 시각은
 * **서버 시계**로 찍히지만 기다리는 쪽은 **브라우저 시계**다. 시계가 조금
 * 빠르면 1초 모자라게 쏘고, 자동 관측은 한 번뿐이므로 그 한 번을 날린다.
 * 10분에 비해 30초는 공짜고, 날린 한 번은 사람이 다시 누르는 일이 된다.
 */
export const ATTEST_SCHEDULE_MARGIN_MS = 30_000;

/** `attest-exposure` GET이 돌려주는 줄 하나 */
export interface AttestCandidate {
  id: string;
  /** 두 관측이 모두 비어 기록이 받아들여졌는가 */
  attested?: boolean;
  /** 기록된 실패가 있어 자동 확인 대상이 아닌가 */
  canObserve?: boolean;
  /** 첫 관측 시각 (ISO). 없으면 null — 아직 아무것도 안 봤다 */
  firstObservedAt?: string | null;
}

export type AutoAttestPlan =
  /** 지금 할 일이 없다 */
  | { action: 'IDLE'; reason: string }
  /** 지금 두 번째 관측을 보낸다 */
  | { action: 'OBSERVE'; testId: string; key: string; reason: string }
  /** 간격이 찰 때까지 기다린다 */
  | { action: 'WAIT'; testId: string; delayMs: number; reason: string };

/**
 * 이 줄의 자동 관측을 기억할 열쇠.
 *
 * **첫 관측 시각을 넣는 이유**: 서버가 기록을 다시 쓰면(새 첫 관측) 그건
 * 다른 상황이므로 자동 관측을 한 번 더 받을 수 있어야 한다. id만 쓰면
 * 영원히 한 번이고, 시각을 빼면 같은 상황을 되풀이한다.
 */
export function autoAttestKey(c: AttestCandidate | null | undefined): string | null {
  const id = typeof c?.id === 'string' ? c.id.trim() : '';
  const at = typeof c?.firstObservedAt === 'string' ? c.firstObservedAt.trim() : '';
  return id && at ? `${id}@${at}` : null;
}

const msOf = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * 지금 자동으로 두 번째 관측을 보낼 것인가, 기다릴 것인가.
 *
 * 순수 함수다 — 시계도 네트워크도 받지 않고 넘겨받는다.
 *
 * 여러 줄이 밀려 있으면 **가장 먼저 찬 것**부터 한다. 한 번에 하나만
 * 보내는 이유: 거래소 조회가 세 번씩 나가므로 동시에 쏘면 한도에 걸린다.
 */
export function planAutoAttest(i: {
  nowMs: number;
  candidates: readonly AttestCandidate[] | null | undefined;
  /** 이미 자동으로 한 번 보낸 열쇠들 */
  tried: ReadonlySet<string>;
  /** 요청이 이미 날아가 있는가 */
  busy: boolean;
}): AutoAttestPlan {
  if (i.busy) return { action: 'IDLE', reason: '확인 요청이 이미 날아가 있습니다' };
  if (!Number.isFinite(i.nowMs)) {
    // **지금을 모르면 쏘지 않는다.** 간격 판정이 시각으로만 되므로,
    // 모르는 시계로 쏘면 TOO_CLOSE 한 번을 날린다.
    return { action: 'IDLE', reason: '현재 시각을 모릅니다' };
  }
  const rows = Array.isArray(i.candidates) ? i.candidates : [];
  if (rows.length === 0) return { action: 'IDLE', reason: '확인할 줄이 없습니다' };

  let best: { testId: string; key: string; dueAt: number; t1: number } | null = null;
  for (const c of rows) {
    if (c?.attested === true) continue;          // 이미 끝난 줄
    if (c?.canObserve === false) continue;       // 기록된 실패 — 별도 복구
    const key = autoAttestKey(c);
    if (!key) continue;                          // 첫 관측이 없다 — 자동으로 하지 않는다
    if (i.tried.has(key)) continue;              // 이 첫 관측에는 이미 한 번 보냈다
    const t1 = msOf(c?.firstObservedAt);
    if (t1 == null) continue;
    // 미래 시각은 시계가 틀렸거나 기록이 이상한 것이다. 서버가 그걸
    // STALE로 거절하므로 여기서 쏴도 한 번을 날린다.
    if (t1 > i.nowMs) continue;
    const dueAt = t1 + ATTEST_MIN_GAP_MS + ATTEST_SCHEDULE_MARGIN_MS;
    if (!best || dueAt < best.dueAt) best = { testId: String(c.id), key, dueAt, t1 };
  }

  if (!best) return { action: 'IDLE', reason: '자동으로 보낼 두 번째 관측이 없습니다' };

  const left = best.dueAt - i.nowMs;
  if (left <= 0) {
    return {
      action: 'OBSERVE', testId: best.testId, key: best.key,
      reason: `첫 관측에서 ${Math.round((i.nowMs - best.t1) / 60_000)}분 지났습니다 — 두 번째 관측을 보냅니다`,
    };
  }
  return {
    action: 'WAIT', testId: best.testId, delayMs: left,
    reason: `약 ${Math.max(1, Math.ceil(left / 60_000))}분 뒤에 두 번째 관측을 보냅니다`,
  };
}

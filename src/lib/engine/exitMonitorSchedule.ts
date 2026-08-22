// src/lib/engine/exitMonitorSchedule.ts
//
// **두 서비스가 같은 비밀을 맞춰야 하는 구조를 없앤다.**
//
// 무엇이 일어났나
// ───────────────
// 청산 감시는 GitHub Actions가 15분마다 Vercel의 exit-monitor를 부르는
// 구조였다. 그러려면 GitHub의 `EXIT_MONITOR_SECRET`과 Vercel의
// `ADMIN_SECRET`이 **같은 값**이어야 했다. 사람이 두 대시보드를 오가며
// 맞추는 일이고, 한 글자만 달라도 401이다.
//
// 실제로 2026-08-03부터 **30번 연속 401**이었다. 그동안 트레일링·본전
// 이동·시간 청산은 한 번도 돌지 않았다. 그런데 워크플로는 매번 빨간불만
// 남겼을 뿐, 아무도 보지 않았다.
//
// 무엇을 하는가
// ─────────────
// 시크릿을 맞추는 일을 자동화하는 것보다 **그 시크릿이 필요 없게 만드는
// 것**이 낫다. Fly Worker는 이미 `ADMIN_SECRET`을 가지고 있고, 그 값으로
// 스모크 청산·중지 이어받기를 매일 성공적으로 부르고 있다. 같은 자격으로
// 청산 감시도 부르면 된다 — **새 비밀이 하나도 필요 없다.**
//
// 왜 Worker가 직접 청산하지 않고 부르기만 하는가
// ─────────────────────────────────────────────
// Binance가 이 서버의 IP 지역을 차단한다(jobs 표에 "Service unavailable
// from a restricted location"이 남아 있다). 주문을 낼 수 있는 곳은
// Vercel(hnd1)뿐이다. 그래서 **판단과 주문은 그대로 Vercel에 두고,
// 깨우는 일만 Worker가 한다.**
//
// 중복 방지
// ─────────
// 워커가 여럿이면 같은 포지션에 손절 이동이 두 번 나갈 수 있다. main 락을
// 쥔 워커만 부른다. GitHub Actions 백업이 함께 돌 수 있으므로 간격도
// 겹치지 않게 벌린다.

export type ExitMonitorSkip =
  /** 부를 주소나 자격이 없다 */
  | 'NO_CREDENTIAL'
  /** 이 워커는 main이 아니다 — 다른 워커가 부른다 */
  | 'NOT_MAIN'
  /** 아직 간격이 안 됐다 */
  | 'TOO_SOON';

export interface ExitMonitorPlan {
  run: boolean;
  skip: ExitMonitorSkip | null;
  reason: string;
}

/** 기본 간격 5분. 트레일링은 초 단위 정밀도가 필요하지 않다 */
export const EXIT_MONITOR_INTERVAL_MS = 5 * 60_000;

/**
 * 지금 청산 감시를 부를 차례인가.
 *
 * **자격이 없으면 부르지 않는다.** 자격 없이 부르면 401이 쌓이고,
 * 401은 "안 도는 것"과 로그에서 구분되지 않는다 — 그게 지난 30번이었다.
 */
export function exitMonitorPlan(i: {
  lastRunMs: number | null;
  nowMs: number;
  intervalMs?: number;
  /** main 락을 쥐고 있는가 */
  isMain: boolean;
  /** APP_URL과 ADMIN_SECRET이 둘 다 있는가 */
  hasCredential: boolean;
}): ExitMonitorPlan {
  const interval = Number.isFinite(i?.intervalMs as number) && (i.intervalMs as number) > 0
    ? (i.intervalMs as number) : EXIT_MONITOR_INTERVAL_MS;

  if (!i?.hasCredential) {
    return { run: false, skip: 'NO_CREDENTIAL',
      reason: 'APP_URL 또는 ADMIN_SECRET이 없어 청산 감시를 부르지 못합니다' };
  }
  if (!i.isMain) {
    return { run: false, skip: 'NOT_MAIN',
      reason: 'main 락을 쥔 워커가 부릅니다 — 같은 포지션에 손절 이동이 두 번 나가지 않게 합니다' };
  }
  // **첫 tick에서는 바로 부른다.** 배포 직후 5분을 비워 두면, 그 사이에
  // 트레일링이 필요한 포지션이 그대로 있는다.
  if (i.lastRunMs == null) {
    return { run: true, skip: null, reason: '기동 후 첫 청산 감시' };
  }
  const since = i.nowMs - i.lastRunMs;
  if (since < interval) {
    return { run: false, skip: 'TOO_SOON',
      reason: `${Math.round(since / 1000)}초 전에 돌았습니다 (간격 ${Math.round(interval / 1000)}초)` };
  }
  return { run: true, skip: null, reason: `${Math.round(since / 1000)}초 만에 다시 봅니다` };
}

// ── 결과 읽기 ──

export interface ExitMonitorOutcome {
  code: 'OK' | 'UNAUTHORIZED' | 'HTTP_ERROR' | 'UNREACHABLE' | 'BAD_BODY';
  checked: number | null;
  actionable: number | null;
  /** 포지션이 0인데 남아 있던 보호주문을 치운 기록 */
  orphanCleanups: number | null;
  message: string;
}

/**
 * 응답을 사실로 옮긴다.
 *
 * **200이 아닌 것을 '처리 0건'으로 적지 않는다.** 401과 '할 일 없음'은
 * 완전히 다른 사실이고, 지난 다섯 달의 사고가 정확히 그 둘을 섞은 것이다.
 */
export function exitMonitorOutcome(i: {
  status: number | null;
  body: any;
  error?: string | null;
}): ExitMonitorOutcome {
  if (i?.status == null) {
    return { code: 'UNREACHABLE', checked: null, actionable: null, orphanCleanups: null,
      message: `청산 감시를 부르지 못했습니다: ${i?.error || '연결 실패'}` };
  }
  if (i.status === 401 || i.status === 403) {
    return { code: 'UNAUTHORIZED', checked: null, actionable: null, orphanCleanups: null,
      message: `청산 감시가 인증을 거부했습니다 (${i.status}) — ADMIN_SECRET이 Vercel과 다릅니다. `
        + '값은 로그에 남기지 않습니다' };
  }
  if (i.status < 200 || i.status >= 300) {
    return { code: 'HTTP_ERROR', checked: null, actionable: null, orphanCleanups: null,
      message: `청산 감시가 ${i.status}로 끝났습니다: ${String(i?.body?.error || i?.error || '').slice(0, 200)}` };
  }
  const b = i.body;
  if (!b || typeof b !== 'object' || b.ok !== true) {
    return { code: 'BAD_BODY', checked: null, actionable: null, orphanCleanups: null,
      message: '청산 감시가 200을 줬지만 결과를 읽지 못했습니다 — 성공으로 적지 않습니다' };
  }
  const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // **두 정리 경로를 함께 센다.**
  //
  // `orphanCleanups`는 계단식 표에 있는 거래에서 치운 것이고, `sweep`은
  // 전략을 가리지 않고 `live_orders`를 훑어 치운 것이다. 앞의 것만 세면
  // scalp·my-original-v1에서 치운 건이 워커 로그에서 사라진다.
  const ladderCleanups = Array.isArray(b.orphanCleanups) ? b.orphanCleanups.length : null;
  const sweepCleaned = num(b?.sweep?.cleaned);
  const cleanups = ladderCleanups == null && sweepCleaned == null
    ? null : (ladderCleanups ?? 0) + (sweepCleaned ?? 0);
  const checked = num(b.checked);
  const actionable = num(b.actionable);
  // 확인조차 못 한 곳이 있으면 **성공 문장 뒤에 숨기지 않는다.**
  const blind = num(b?.sweep?.unreadable);
  return {
    code: 'OK', checked, actionable, orphanCleanups: cleanups,
    message: `${checked ?? '?'}건 확인 · ${actionable ?? '?'}건 처리`
      + (cleanups ? ` · 남은 보호주문 ${cleanups}건 정리` : '')
      + (blind ? ` · 확인 못 한 곳 ${blind}` : ''),
  };
}

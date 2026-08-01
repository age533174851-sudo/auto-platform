// src/lib/engine/trailPlan.ts
//
// 트레일링 · 본전 이동 판정 — **순수 함수**.
//
// 왜 떼어내는가
// ─────────────
// 이 계산은 `exitMonitor.decideExits` 안에 DB 조회·캔들 조회와 섞여 있었고
// **테스트가 하나도 없었다.** 그런데 이 코드가 하는 일은 실제 돈이 걸린
// 손절 주문을 옮기는 것이다. 여기서 부호 하나가 틀리면:
//
//   · LONG인데 손절을 **아래로** 옮긴다 → 손실 한도가 조용히 넓어진다
//   · 이미 지나간 가격으로 옮긴다 → 거래소가 거부하거나 즉시 체결된다
//   · '좁히기만' 규칙이 깨진다 → 이익을 반납하고도 손절이 그대로 남는다
//
// 셋 다 화면에서는 '손절 이동됨'으로 똑같이 보인다.
//
// R이란
// ─────
// 진입가와 손절가의 거리를 1R로 본다. 2R은 그 거리의 두 배만큼 이익이 난
// 상태다. 가격이 아니라 R로 다루는 이유는 종목·배율이 달라도 같은 규칙을
// 쓸 수 있기 때문이다.

export const R_TRAIL_START = 2;   // 이 R을 넘으면 트레일링 시작
export const R_TRAIL_DIST = 1;    // 최고점에서 이만큼 R 물러난 자리로 손절
export const R_BREAK_EVEN = 1;    // 이 R 도달 시 손절을 본전으로

export type TrailAction = 'NONE' | 'MOVE_STOP' | 'CLOSE';

export interface TrailInput {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  /**
   * **진입 시점의** 손절가. 1R을 정의하는 값이라 절대 바뀌지 않는다.
   *
   * 예전 코드는 손절을 옮길 때마다 DB의 stop_loss를 덮어썼고, 다음 주기에
   * 그 값으로 1R을 다시 쟀다. 그러면 손절이 올라갈수록 1R이 커지고
   * highWaterR은 그만큼 작아진다 — 트레일링이 **한 번 움직인 뒤 멈춘다.**
   * 첫 이동은 일어나므로 화면에서는 동작하는 것처럼 보인다.
   */
  initialStop: number;
  /** 지금 거래소에 실제로 걸려 있는 손절가 */
  currentStop: number;
  /** 진입 이후 도달한 최고 R. 못 구했으면 null */
  highWaterR: number | null;
  /** 최근 가격. 못 구했으면 null */
  lastPrice: number | null;
  cfg?: Partial<TrailConfig>;
}

export interface TrailConfig {
  trailStartR: number;
  trailDistanceR: number;
  breakEvenR: number;
  /** 본전 이동을 쓸 것인가 */
  useBreakEven: boolean;
  /** 트레일링을 쓸 것인가 */
  useTrailing: boolean;
}

export const DEFAULT_TRAIL: TrailConfig = {
  trailStartR: R_TRAIL_START,
  trailDistanceR: R_TRAIL_DIST,
  breakEvenR: R_BREAK_EVEN,
  useBreakEven: true,
  useTrailing: true,
};

export interface TrailVerdict {
  action: TrailAction;
  /** MOVE_STOP일 때만 있다 */
  newStop?: number;
  reason: string;
}

const none = (reason: string): TrailVerdict => ({ action: 'NONE', reason });

/**
 * 손절을 옮길 것인가, 지금 닫을 것인가.
 *
 * **좁히기만 한다.** 손절을 진입가에서 멀어지는 방향으로 옮기는 일은
 * 이 함수가 절대 하지 않는다 — 그건 손실 한도를 넓히는 것이고, 트레일링의
 * 목적과 정반대다.
 */
export function planTrail(input: TrailInput): TrailVerdict {
  const cfg: TrailConfig = { ...DEFAULT_TRAIL, ...(input.cfg ?? {}) };
  const { side, entryPrice: entry, currentStop: stop, initialStop: init } = input;

  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stop) || stop <= 0) {
    return none('진입가 또는 손절가를 확인할 수 없습니다');
  }
  if (!Number.isFinite(init) || init <= 0) {
    return none('진입 시점 손절가를 확인할 수 없어 R을 계산할 수 없습니다');
  }
  const isLong = side === 'LONG';

  // **1R은 진입 시점 손절가로만 잰다.** 지금 걸린 손절로 재면 손절이
  // 움직일 때마다 R의 크기가 바뀐다 (위 initialStop 주석 참조).
  const riskDist = Math.abs(entry - init);
  if (riskDist <= 0) return none('진입가와 손절가가 같아 R을 계산할 수 없습니다');

  const hw = input.highWaterR;
  if (hw == null || !Number.isFinite(hw)) {
    // 최고점을 모르면 아무것도 하지 않는다. 0으로 두면 '아직 안 올랐다'가
    // 되어 본전 이동이 영원히 안 걸리고, 그건 조용한 실패다.
    return none('최고 도달 R을 확인하지 못해 이번 주기는 건너뜁니다');
  }

  let desiredStop = stop;
  let reason = '';

  // ── 본전 이동 ──
  if (cfg.useBreakEven && hw >= cfg.breakEvenR) {
    // 손절이 아직 본전보다 불리한 자리에 있을 때만 올린다.
    if (isLong ? entry > desiredStop : entry < desiredStop) {
      desiredStop = entry;
      reason = `${cfg.breakEvenR}R 도달 — 손절을 본전으로`;
    }
  }

  // ── 트레일링 ──
  if (cfg.useTrailing && hw >= cfg.trailStartR) {
    const trailR = hw - cfg.trailDistanceR;
    const trailPrice = isLong ? entry + riskDist * trailR : entry - riskDist * trailR;
    if (isLong ? trailPrice > desiredStop : trailPrice < desiredStop) {
      desiredStop = trailPrice;
      reason = `최고 ${hw.toFixed(2)}R — 트레일링 손절을 ${trailR.toFixed(2)}R로 이동`;
    }
  }

  // **좁히기만 한다.** 이 검사가 이 함수의 핵심이다.
  const improves = isLong ? desiredStop > stop : desiredStop < stop;
  if (!improves) return none('이동 조건 미충족');

  // 현재가가 이미 새 손절선을 지났으면 옮기는 것이 아니라 닫는 것이다.
  // 지나간 자리에 손절을 걸면 거래소가 거부하거나 즉시 체결된다.
  const last = input.lastPrice;
  if (last == null || !Number.isFinite(last)) {
    return none('현재가를 확인하지 못해 이번 주기는 건너뜁니다');
  }
  const passed = isLong ? last <= desiredStop : last >= desiredStop;
  if (passed) {
    return { action: 'CLOSE', reason: `${reason} — 현재가가 이미 그 선을 지나 즉시 청산` };
  }

  return { action: 'MOVE_STOP', newStop: desiredStop, reason };
}

/**
 * 환경변수에서 트레일링 설정을 읽는다.
 *
 * 끄고 싶으면 `TRAILING_STOP=off`. 값이 이상하면 기본값을 쓰되, 이상하다는
 * 사실을 note에 남긴다 — 조용히 무시하면 오타를 영원히 모른다.
 */
export function readTrailConfig(
  env: (k: string) => string | undefined,
): { cfg: TrailConfig; note: string } {
  const notes: string[] = [];
  const num = (k: string, fallback: number): number => {
    const raw = env(k);
    if (raw == null || String(raw).trim() === '') return fallback;
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
    notes.push(`${k}='${raw}'는 쓸 수 없는 값이라 기본값 ${fallback}을 씁니다`);
    return fallback;
  };

  const mode = String(env('TRAILING_STOP') ?? '').trim().toLowerCase();
  const off = mode === 'off' || mode === 'false' || mode === '0';

  return {
    cfg: {
      trailStartR: num('TRAIL_START_R', DEFAULT_TRAIL.trailStartR),
      trailDistanceR: num('TRAIL_DISTANCE_R', DEFAULT_TRAIL.trailDistanceR),
      breakEvenR: num('BREAK_EVEN_R', DEFAULT_TRAIL.breakEvenR),
      useBreakEven: !off,
      useTrailing: !off,
    },
    note: notes.join(' · '),
  };
}

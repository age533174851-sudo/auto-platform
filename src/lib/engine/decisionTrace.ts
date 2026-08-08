// src/lib/engine/decisionTrace.ts
//
// **화면이 서로 다른 이유를 말하고 있었다.**
//
// 실제로 찍힌 화면:
//
//   LONG 58.23 / SHORT 41.77          ← 차이 16.46점
//   "최소차이 12점보다 부족해 관망"     ← 16.46 > 12인데?
//   차단 이유: 전체 위험 한도 초과      ← 진짜 이유는 이것
//
// 신호는 통과했는데 위험엔진에서 막힌 것이다. 그런데 맨 위 문구는
// "신호가 부족하다"고 말한다. **사용자는 신호를 고치려 들 것이고,
// 고쳐도 계속 막힌다.** 고칠 곳이 위험 설정인데 화면이 다른 곳을 가리킨다.
//
// 왜 이런 일이 생기는가
// ─────────────────────
// 단계별로 판정을 하면서 **그때그때 문구를 만들었기** 때문이다. 신호
// 단계는 자기 기준으로 문구를 쓰고, 위험 단계도 자기 기준으로 쓴다.
// 둘이 다른 결론을 내면 화면은 먼저 만난 문구를 띄운다 — 그게 진짜
// 차단 원인이라는 보장은 없다.
//
// 그래서 이 파일이 하는 일
// ────────────────────────
// **네 관문의 결과를 따로 저장하고, 최종 문구를 한 곳에서만 만든다.**
//
//   signal     신호가 조건을 넘었는가
//   risk       위험 한도 안인가
//   runtime    실행기가 살아 있는가
//   execution  주문을 낼 수 있는가 (레버리지·마진·보호주문)
//
// 그리고 **먼저 실패한 관문이 아니라, 실제로 막은 관문**을 가리킨다.
// 신호가 통과했으면 "신호 통과 16.46점 > 12점"이라고 적고, 막은 것이
// 위험이면 그 숫자를 보여 준다.

export type GateName = 'signal' | 'risk' | 'runtime' | 'execution';

export const GATE_LABEL: Record<GateName, string> = {
  signal: '신호', risk: '위험', runtime: '실행기', execution: '주문 실행',
};

/**
 * 관문 하나의 결과.
 *
 * **`UNKNOWN`과 `NOT_APPLICABLE`을 나눈다.** 예전에는 둘 다 '미확정'으로
 * 뭉갰다. 그래서 포지션이 없는데 "손절이 청산보다 먼저?"가 미확정으로
 * 세어졌고, 점검 목록에 실제로는 문제없는 항목이 계속 남았다.
 *
 *   PASS            확인했고 통과
 *   BLOCK           확인했고 막힘
 *   UNKNOWN         확인하지 못했다 — 통과가 아니다
 *   NOT_APPLICABLE  이 상황에 해당하지 않는다 — 문제가 아니다
 */
export type GateStatus = 'PASS' | 'BLOCK' | 'UNKNOWN' | 'NOT_APPLICABLE';

export const STATUS_LABEL: Record<GateStatus, string> = {
  PASS: '통과', BLOCK: '차단', UNKNOWN: '확인 불가', NOT_APPLICABLE: '해당 없음',
};

export interface GateResult {
  gate: GateName;
  status: GateStatus;
  /** 한 줄 요약. 통과해도 근거를 남긴다 — "왜 통과했지"도 알아야 한다 */
  summary: string;
  /** 숫자 근거. 화면이 그대로 쓴다 */
  detail?: string;
}

// ── 위험 단위 ─────────────────────────────────────────────
//
// **이걸 섞으면 조용히 틀린다.**
//
// 명목가치 $5,409와 손실한도 $2,704를 비교하면 "한도 초과"가 뜨는데
// 실제로는 아무 문제가 없을 수도 있다. 반대로 진짜 위험이 한도를 넘어도
// 명목가치가 작아서 통과할 수 있다. 그래서 네 가지를 이름으로 분리한다.

export interface RiskFigures {
  /** 포지션 명목가치. 수량 × 가격 */
  notionalExposure: number | null;
  /** 실제로 잠기는 증거금 */
  marginUsed: number | null;
  /** 손절에 걸렸을 때 잃는 금액. **한도와 비교할 것은 이것이다** */
  maxLossAtStop: number | null;
  /** 그 손실이 계좌의 몇 %인가 */
  accountRiskPct: number | null;
}

export interface RiskLimits {
  /** 1회 허용 위험(%) */
  riskPerTradePct: number | null;
  /** 동시에 열 수 있는 위험 합계(%) */
  maxAccountRiskPct: number | null;
  /** 이미 열려 있는 위험(금액) */
  currentOpenRisk: number | null;
  accountEquity: number | null;
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface ConfigContradiction {
  found: boolean;
  /** 화면에 그대로 적을 문장 */
  message: string;
  /** 무엇을 고쳐야 하는가 */
  fix: string;
}

/**
 * 설정이 스스로 모순인가.
 *
 * **이게 실제로 있었다.** 자산 $54,090에 1회 위험 10%(=$5,409),
 * 전체 동시 위험 상한 5%(=$2,704). 한 번의 거래가 전체 상한의 두 배라서
 * **첫 주문부터 무조건 막힌다.**
 *
 * 그런데 화면은 "위험 한도 초과"라고만 적었다. 사용자는 포지션을 줄이거나
 * 기다려 보지만, 열린 포지션이 0이어도 계속 막힌다 — 설정 자체가
 * 통과 불가능하기 때문이다. 그 사실을 말해 주지 않으면 영원히 못 찾는다.
 */
export function configContradiction(limits: RiskLimits | null | undefined): ConfigContradiction {
  const per = num(limits?.riskPerTradePct);
  const total = num(limits?.maxAccountRiskPct);

  if (per === null || total === null) {
    return { found: false, message: '', fix: '' };
  }
  if (per > total) {
    return {
      found: true,
      message: `1회 위험 ${per}%가 전체 동시 위험 상한 ${total}%보다 큽니다 —`
        + ' 열린 포지션이 하나도 없어도 첫 주문부터 막힙니다',
      fix: `1회 위험을 ${total}% 이하로 낮추거나, 전체 상한을 ${per}% 이상으로 올리세요`,
    };
  }
  return { found: false, message: '', fix: '' };
}

/**
 * 위험 관문 판정.
 *
 * **비교하는 것은 손실 금액이다.** 명목가치가 아니다. 그래서 인자
 * 이름도 `maxLossAtStop`이고, 화면에 낼 문장에도 그렇게 적는다 —
 * "$5,409"만 보여 주면 그게 명목가치인지 손실한도인지 알 수 없다.
 */
export function riskGate(
  figures: RiskFigures | null | undefined,
  limits: RiskLimits | null | undefined,
): GateResult {
  const loss = num(figures?.maxLossAtStop);
  const open = num(limits?.currentOpenRisk);
  const equity = num(limits?.accountEquity);
  const totalPct = num(limits?.maxAccountRiskPct);

  const contra = configContradiction(limits);

  if (loss === null || equity === null || totalPct === null) {
    return { gate: 'risk', status: 'UNKNOWN',
      summary: '위험을 계산하지 못했습니다',
      detail: '손실 금액·계좌 자산·상한 중 하나를 읽지 못했습니다 — 확인하지 못한 것은 통과가 아닙니다' };
  }

  const cap = equity * (totalPct / 100);
  const openSafe = open ?? 0;
  const after = openSafe + loss;

  if (after > cap) {
    return {
      gate: 'risk', status: 'BLOCK',
      // **설정 모순이면 그것이 먼저다.** "한도 초과"라고만 적으면
      // 사용자는 포지션을 줄이려 하는데, 0이어도 안 된다.
      summary: contra.found
        ? `설정이 스스로 모순입니다 — ${contra.message}`
        : '전체 동시 위험 한도를 넘습니다',
      detail: contra.found
        ? contra.fix
        : `손절 시 손실 ${loss.toFixed(0)} + 이미 열린 위험 ${openSafe.toFixed(0)}`
          + ` = ${after.toFixed(0)} > 허용 ${cap.toFixed(0)}`
          + ` (계좌 ${equity.toFixed(0)}의 ${totalPct}%)`,
    };
  }

  return {
    gate: 'risk', status: 'PASS',
    summary: '위험 한도 안입니다',
    detail: `손절 시 손실 ${loss.toFixed(0)} + 열린 위험 ${openSafe.toFixed(0)}`
      + ` = ${after.toFixed(0)} ≤ 허용 ${cap.toFixed(0)}`,
  };
}

/**
 * 신호 관문 판정.
 *
 * **통과했으면 통과했다고 적는다.** 이게 없어서 화면이 "최소차이 12점보다
 * 부족해 관망"이라고 말하면서 실제 차단은 위험엔진에서 났다.
 */
export function signalGate(
  longScore: any, shortScore: any, minGap: any,
): GateResult {
  const l = num(longScore), s = num(shortScore), g = num(minGap);
  if (l === null || s === null || g === null) {
    return { gate: 'signal', status: 'UNKNOWN', summary: '점수를 읽지 못했습니다' };
  }
  const gap = Math.abs(l - s);
  if (gap < g) {
    return { gate: 'signal', status: 'BLOCK',
      summary: '방향이 갈리지 않았습니다',
      detail: `차이 ${gap.toFixed(2)}점 < 최소 ${g}점 — 관망합니다` };
  }
  return { gate: 'signal', status: 'PASS',
    summary: `${l > s ? '롱' : '숏'} 신호가 조건을 넘었습니다`,
    detail: `차이 ${gap.toFixed(2)}점 > 최소 ${g}점` };
}

// ── 최종 판정 ─────────────────────────────────────────────

export interface Trace {
  gates: GateResult[];
  /** 실제로 막은 관문. 아무것도 안 막았으면 null */
  blockedBy: GateName | null;
  /** 화면 맨 위에 크게 띄울 한 줄 */
  headline: string;
  /** 그 아래 근거 줄들 */
  lines: string[];
  /** 주문을 낼 수 있는가 */
  canOrder: boolean;
  /** 확인하지 못한 관문이 있는가 */
  hasUnknown: boolean;
}

/**
 * 네 관문을 모아 하나의 결론으로.
 *
 * **문구를 만드는 곳이 여기 하나다.** 단계마다 문구를 만들면 서로 다른
 * 결론이 화면에 뜬다 — 실제로 그랬다.
 *
 * 순서는 신호 → 위험 → 실행기 → 주문 실행이지만, **먼저 실패한 것을
 * 무조건 원인으로 삼지 않는다.** 통과한 관문의 근거도 같이 적어서
 * "신호는 통과했는데 위험에서 막혔다"가 한눈에 보이게 한다.
 *
 * `NOT_APPLICABLE`은 차단이 아니다. 포지션이 없을 때 "손절이 청산보다
 * 먼저인가"는 문제가 아니라 해당 없음이다 — 그걸 미확정으로 세면
 * 점검 목록에 영원히 안 지워지는 항목이 남는다.
 */
export function traceOf(gates: GateResult[] | null | undefined): Trace {
  const list = (Array.isArray(gates) ? gates : []).filter(g => g && g.gate);

  const blocked = list.filter(g => g.status === 'BLOCK');
  const unknown = list.filter(g => g.status === 'UNKNOWN');
  const passed = list.filter(g => g.status === 'PASS');

  // 막은 것이 있으면 그것이 원인이다. 둘 이상이면 순서대로 첫 번째.
  const order: GateName[] = ['signal', 'risk', 'runtime', 'execution'];
  const blockedBy = blocked.length > 0
    ? (order.find(o => blocked.some(b => b.gate === o)) ?? blocked[0].gate)
    : null;

  const lines: string[] = [];
  // **통과한 관문을 먼저 적는다.** 그래야 "신호는 통과했다"가 보인다.
  for (const g of passed) {
    lines.push(`${GATE_LABEL[g.gate]}: 통과${g.detail ? ` — ${g.detail}` : ''}`);
  }
  for (const g of blocked) {
    lines.push(`${GATE_LABEL[g.gate]}: 차단 — ${g.summary}${g.detail ? ` (${g.detail})` : ''}`);
  }
  for (const g of unknown) {
    lines.push(`${GATE_LABEL[g.gate]}: 확인 불가${g.summary ? ` — ${g.summary}` : ''}`);
  }

  if (blockedBy) {
    const b = blocked.find(g => g.gate === blockedBy)!;
    return {
      gates: list, blockedBy,
      headline: `주문 차단 — ${GATE_LABEL[blockedBy]}: ${b.summary}`,
      lines, canOrder: false, hasUnknown: unknown.length > 0,
    };
  }

  if (unknown.length > 0) {
    return {
      gates: list, blockedBy: null,
      headline: `주문 보류 — ${unknown.map(g => GATE_LABEL[g.gate]).join(', ')}을(를) 확인하지 못했습니다`,
      lines, canOrder: false, hasUnknown: true,
    };
  }

  if (list.length === 0) {
    return { gates: [], blockedBy: null,
      headline: '아직 판정하지 않았습니다', lines: [], canOrder: false, hasUnknown: true };
  }

  return {
    gates: list, blockedBy: null,
    headline: '주문 가능', lines, canOrder: true, hasUnknown: false,
  };
}

// ── 의도 배율 ─────────────────────────────────────────────

export interface LeverageDisplay {
  status: GateStatus;
  /** 화면에 쓸 문자열 */
  text: string;
  note: string;
}

/**
 * 의도한 배율을 화면에 어떻게 적을 것인가.
 *
 * **0배를 의도 배율로 쓰지 않는다.** 화면에 "거래소 5배 / 의도 0배"가
 * 떴다. 0배는 배율이 아니다 — 주문 계획이 없다는 뜻이고, 그러면
 * '설정 없음'이라고 적는 것이 맞다. 0으로 적으면 사용자는 뭔가 잘못
 * 설정된 줄 알고 찾아 헤맨다.
 */
export function leverageDisplay(intended: any, venue: any): LeverageDisplay {
  const i = num(intended), v = num(venue);

  if (i === null || i <= 0) {
    return { status: 'NOT_APPLICABLE', text: '설정 없음',
      note: v !== null
        ? `주문 계획이 없어 의도 배율이 없습니다 (거래소는 ${v}배로 설정돼 있습니다)`
        : '주문 계획이 없습니다' };
  }
  if (v === null) {
    return { status: 'UNKNOWN', text: `의도 ${i}배 · 거래소 확인 불가`,
      note: '거래소 배율을 읽지 못했습니다 — 주문 전에 반드시 확인해야 합니다' };
  }
  if (Math.abs(i - v) > 1e-9) {
    return { status: 'BLOCK', text: `의도 ${i}배 ≠ 거래소 ${v}배`,
      note: '화면의 배율과 거래소의 배율이 다릅니다 — 이 상태로 주문하면'
        + ' 의도한 것과 다른 크기로 나갑니다' };
  }
  return { status: 'PASS', text: `${i}배`, note: '' };
}

// ── 예약 상태 ─────────────────────────────────────────────

export interface ScheduleDisplay {
  /** 화면에 쓸 한 줄 */
  text: string;
  /** 지금 실제로 도는가 */
  running: boolean;
  note: string;
}

/**
 * 예약이 있는데 스위치는 꺼져 있고 과거 실행 기록은 있다.
 *
 * 사용자는 "지금 자동매매가 도는 건지 안 도는 건지" 알 수 없다.
 * **셋은 서로 다른 사실이다:**
 *
 *   예약이 등록돼 있다        — 줄이 표에 있다
 *   사용자가 켜 두었다        — desiredState
 *   실제로 돌고 있다          — observedState
 *
 * 하나로 뭉개면 "예약 1개"만 뜨고, 그게 도는 건지는 아무 데도 없다.
 */
export function scheduleDisplay(input: {
  scheduleCount?: any;
  enabledCount?: any;
  lastRunAtMs?: any;
  nowMs?: any;
} | null | undefined): ScheduleDisplay {
  const i = input ?? {};
  const total = num(i.scheduleCount) ?? 0;
  const on = num(i.enabledCount);
  const last = num(i.lastRunAtMs);
  const now = num(i.nowMs);

  if (total === 0) {
    return { text: '등록된 예약이 없습니다', running: false,
      note: '자동매매를 켜려면 예약을 먼저 만드세요' };
  }
  if (on === null) {
    return { text: `예약 ${total}개 · 켜짐 여부 확인 불가`, running: false,
      note: '켜져 있는지 확인하지 못했습니다 — 꺼져 있다는 뜻이 아닙니다' };
  }

  const ago = last !== null && now !== null ? now - last : null;
  const agoText = ago === null ? '마지막 실행 시각 모름'
    : ago < 60_000 ? `마지막 실행 ${Math.round(ago / 1000)}초 전`
    : ago < 3600_000 ? `마지막 실행 ${Math.floor(ago / 60_000)}분 전`
    : `마지막 실행 ${Math.floor(ago / 3600_000)}시간 전`;

  if (on === 0) {
    return {
      text: `예약 ${total}개 · 현재 비활성 · ${agoText}`,
      running: false,
      note: '예약은 남아 있지만 전부 꺼져 있어 아무것도 돌지 않습니다 —'
        + ' 과거 실행 기록이 있는 것은 예전에 켜져 있었기 때문입니다',
    };
  }

  return {
    text: `예약 ${total}개 · 켜짐 ${on}개 · ${agoText}`,
    running: true, note: '',
  };
}

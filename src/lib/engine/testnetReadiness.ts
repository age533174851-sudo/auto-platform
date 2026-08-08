// src/lib/engine/testnetReadiness.ts
//
// **내일 테스트넷을 켜 놓고 자도 시스템이 안 꼬이는가.**
//
// 첫날의 목표는 수익률이 아니다. 주문 생명주기 무결성이다:
//
//   signal → risk → intent → submit → accepted → fill
//   → position → protection → close → reconcile → ledger
//
// 이 사슬이 한 번이라도 끊기면, 끊긴 자리에 돈이 남거나 포지션이 남거나
// 장부가 어긋난다. 그리고 그걸 자는 동안 알 수 없다.
//
// 그래서 시작 버튼에 관문을 붙인다
// ────────────────────────────────
// **하나라도 BLOCK이나 UNKNOWN이면 시작하지 않는다.**
//
// 이 판정에서 가장 중요한 규칙은 이것이다 — **확인하지 못한 것은 통과가
// 아니다.** "아마 될 것"으로 켜면 안 된다. 테스트넷이라 돈은 안 잃지만,
// 무결성 버그를 발견하는 것이 이 운용의 목적이므로 **켜기 전에 이미
// 깨져 있으면 무엇이 깨졌는지도 알 수 없다.**
//
// 왜 '테스트넷이니까 대충'이 안 되는가
// ────────────────────────────────────
// 테스트넷에서 잡지 못한 무결성 버그는 실전에서 잡힌다. 그때는 돈으로
// 잡는다. 그래서 여기서는 오히려 더 엄격해야 한다.

export type ReadyStatus = 'PASS' | 'BLOCK' | 'UNKNOWN' | 'NOT_APPLICABLE';

export interface ReadyCheck {
  id: string;
  label: string;
  status: ReadyStatus;
  /** 왜 이 상태인가 */
  detail: string;
  /** 통과하려면 무엇이 필요한가. PASS면 빈 문자열 */
  needed: string;
}

/**
 * 켜기 전에 확인할 것.
 *
 * 순서는 의존 순이다 — 연결이 없으면 나머지를 물어볼 수도 없다.
 */
export const READINESS_ITEMS = [
  { id: 'connection', label: '거래소 연결' },
  { id: 'marketData', label: '시세' },
  { id: 'balance', label: '잔고' },
  { id: 'reconcile', label: '주문 대조' },
  { id: 'positionMode', label: '포지션 모드' },
  { id: 'leverage', label: '레버리지 일치' },
  { id: 'riskPolicy', label: '위험 정책' },
  { id: 'worker', label: '서버 실행기' },
  { id: 'idempotency', label: '중복 주문 방지' },
  { id: 'protectiveOrders', label: '보호 주문' },
  { id: 'ledger', label: '통합 장부' },
] as const;

export type ReadinessId = typeof READINESS_ITEMS[number]['id'];

export interface ReadinessInput {
  /** 지갑·매매·자동이 같은 connectionId를 쓰는가 */
  connectionId?: string | null;
  /** 그 연결이 테스트넷인가 */
  isTestnet?: boolean | null;
  /** 시세를 지금 읽고 있는가 */
  marketDataFresh?: boolean | null;
  /** 잔고를 읽었는가 */
  balanceRead?: boolean | null;
  /** 결과를 모르는 주문 수. **0이어야 한다** */
  unresolvedOrders?: number | null;
  /** 앱과 거래소가 어긋난 건수. **0이어야 한다** */
  mismatchCount?: number | null;
  /** 포지션 모드(ISOLATED/CROSS)를 확인했는가 */
  positionModeKnown?: boolean | null;
  /** 의도 배율 */
  intendedLeverage?: number | null;
  /** 거래소가 실제로 설정한 배율 */
  venueLeverage?: number | null;
  /** 거래소가 지금 허용하는 최대 배율 */
  venueMaxLeverage?: number | null;
  /** 위험 정책을 서버에서 읽는가 */
  riskPolicyFromServer?: boolean | null;
  /** 실행기가 브라우저 없이 도는가 */
  workerIndependent?: boolean | null;
  /** 실행기 심장박동을 마지막으로 본 시각 */
  workerHeartbeatAtMs?: number | null;
  /** 주문 열쇠 계층이 붙어 있는가 */
  idempotencyWired?: boolean | null;
  /** 손절이 거래소에 실제로 붙는 것을 확인했는가 */
  protectiveStopConfirmed?: boolean | null;
  /** 모든 화면이 한 장부를 읽는가 */
  unifiedLedger?: boolean | null;
  nowMs?: number | null;
}

function bool(v: any): boolean | null {
  return v === true ? true : v === false ? false : null;
}
function num(v: any): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 심장박동이 이보다 오래되면 죽은 것으로 본다 */
export const WORKER_STALE_MS = 90_000;

/**
 * 하나씩 판정한다.
 *
 * **`true`가 아니면 통과가 아니다.** `undefined`를 통과로 읽으면
 * "아직 안 만든 것"이 전부 초록으로 뜬다 — 그게 이 관문을 무력화하는
 * 가장 쉬운 방법이다.
 */
export function readinessChecks(input: ReadinessInput | null | undefined): ReadyCheck[] {
  const i = input ?? {};
  const out: ReadyCheck[] = [];
  const push = (id: ReadinessId, status: ReadyStatus, detail: string, needed = '') => {
    const item = READINESS_ITEMS.find(x => x.id === id)!;
    out.push({ id, label: item.label, status, detail, needed });
  };

  // ── 연결 ──
  const cid = String(i.connectionId ?? '').trim();
  const testnet = bool(i.isTestnet);
  if (!cid) {
    push('connection', 'BLOCK', '테스트넷 연결이 없습니다',
      'Gate 테스트넷 키를 등록하고, 지갑·매매·자동이 같은 connectionId를 보는지 확인하세요');
  } else if (testnet !== true) {
    push('connection', 'BLOCK', '이 연결이 테스트넷인지 확인하지 못했습니다',
      '실전 연결로 테스트넷 운용을 시작하면 실제 돈이 나갑니다 — 반드시 확인하세요');
  } else {
    push('connection', 'PASS', `연결 확인 (${cid.slice(0, 8)}…)`);
  }

  // ── 시세 ──
  const md = bool(i.marketDataFresh);
  push('marketData',
    md === true ? 'PASS' : md === false ? 'BLOCK' : 'UNKNOWN',
    md === true ? '시세를 읽고 있습니다'
      : md === false ? '시세가 끊겼습니다'
      : '시세 상태를 확인하지 못했습니다',
    md === true ? '' : '시세 없이 시장가를 내면 얼마에 사는지 모르는 채로 주문합니다');

  // ── 잔고 ──
  const bal = bool(i.balanceRead);
  push('balance',
    bal === true ? 'PASS' : 'UNKNOWN',
    bal === true ? '잔고를 읽었습니다' : '잔고를 읽지 못했습니다',
    bal === true ? '' : '잔고를 모르면 주문 크기를 계산할 수 없습니다');

  // ── 대조 ──
  //
  // **0이어야 한다.** 결과를 모르는 주문이 하나라도 있으면 장부가
  // 실제와 다르고, 그 위에 새 주문을 얹으면 같은 자리를 두 번 산다.
  const unresolved = num(i.unresolvedOrders);
  const mismatch = num(i.mismatchCount);
  if (unresolved === null || mismatch === null) {
    push('reconcile', 'UNKNOWN', '미확정 주문·불일치 건수를 세지 못했습니다',
      '대조를 한 번 돌려 두 숫자를 확인하세요');
  } else if (unresolved > 0 || mismatch > 0) {
    push('reconcile', 'BLOCK',
      `미확정 ${unresolved}건 · 불일치 ${mismatch}건`,
      '둘 다 0이어야 합니다 — 결과를 모르는 주문 위에 새 주문을 얹으면'
      + ' 같은 자리를 두 번 삽니다');
  } else {
    push('reconcile', 'PASS', '미확정 0건 · 불일치 0건');
  }

  // ── 포지션 모드 ──
  const pm = bool(i.positionModeKnown);
  push('positionMode',
    pm === true ? 'PASS' : 'UNKNOWN',
    pm === true ? 'ISOLATED/CROSS를 확인했습니다' : '포지션 모드를 확인하지 못했습니다',
    pm === true ? '' : 'CROSS인 줄 모르고 ISOLATED로 계산하면 청산가가 전혀 다릅니다');

  // ── 레버리지 ──
  //
  // **몰래 낮추지 않는다.** 100배를 요구했는데 거래소가 75배만 허용하면
  // 75배로 조용히 내는 것이 아니라 막고 이유를 보여 준다 — 사용자가
  // 의도한 것과 다른 크기로 나가는 것이 더 나쁘다.
  const li = num(i.intendedLeverage);
  const lv = num(i.venueLeverage);
  const lmax = num(i.venueMaxLeverage);
  if (li === null || li <= 0) {
    push('leverage', 'UNKNOWN', '의도 배율이 없습니다',
      '전략이 쓸 배율을 정하세요 (0배는 배율이 아니라 계획 없음입니다)');
  } else if (lv === null) {
    push('leverage', 'UNKNOWN', `의도 ${li}배 · 거래소 배율 확인 불가`,
      '설정 후 다시 조회해서 정확히 일치하는지 확인해야 합니다');
  } else if (Math.abs(li - lv) > 1e-9) {
    push('leverage', 'BLOCK', `의도 ${li}배 ≠ 거래소 ${lv}배`,
      '화면과 거래소가 다르면 의도한 것과 다른 크기로 나갑니다');
  } else if (lmax !== null && li > lmax) {
    push('leverage', 'BLOCK', `요구 ${li}배 · 거래소 현재 최대 ${lmax}배`,
      `거래소가 지금 허용하는 최대가 ${lmax}배입니다 — 몰래 낮춰 내지 않습니다.`
      + ' 포지션 규모에 따라 허용 배율이 달라지므로 주문 직전에 다시 조회합니다');
  } else {
    push('leverage', 'PASS', `${li}배 (거래소 일치${lmax !== null ? ` · 현재 최대 ${lmax}배` : ''})`);
  }

  // ── 위험 정책 ──
  const rp = bool(i.riskPolicyFromServer);
  push('riskPolicy',
    rp === true ? 'PASS' : 'BLOCK',
    rp === true ? '서버 정책을 씁니다'
      : '위험 설정이 브라우저에만 있습니다',
    rp === true ? ''
      : '브라우저 설정은 서버 실행기가 읽을 수 없습니다 — 화면에서 한도를 낮춰도'
        + ' 실행기는 예전 값으로 주문합니다');

  // ── 서버 실행기 ──
  //
  // **여기가 지금 막혀 있는 곳이다.** 브라우저 타이머로 도는 것은
  // 자동매매가 아니다 — 앱을 닫으면 손절 감시도 같이 멈춘다.
  const wi = bool(i.workerIndependent);
  const hb = num(i.workerHeartbeatAtMs);
  const now = num(i.nowMs);
  if (wi !== true) {
    push('worker', 'BLOCK',
      wi === false ? '브라우저 타이머로 돕니다' : '실행기를 확인하지 못했습니다',
      '앱을 닫으면 판단도 주문도 손절 감시도 같이 멈춥니다 —'
      + ' 자고 있는 동안 포지션만 남습니다. runtime_jobs/ticks/leases를 읽는'
      + ' Worker가 필요합니다');
  } else if (hb === null || now === null) {
    push('worker', 'UNKNOWN', '실행기 심장박동을 읽지 못했습니다',
      '살아 있는지 모르면 RUNNING이라고 적을 수 없습니다');
  } else if (now - hb > WORKER_STALE_MS) {
    push('worker', 'BLOCK',
      `실행기 응답 없음 (${Math.round((now - hb) / 1000)}초)`,
      '실행기가 죽어 있으면 켜도 아무것도 돌지 않습니다');
  } else {
    push('worker', 'PASS', `실행기 정상 (${Math.round((now - hb) / 1000)}초 전)`);
  }

  // ── 중복 주문 방지 ──
  const idem = bool(i.idempotencyWired);
  push('idempotency',
    idem === true ? 'PASS' : 'BLOCK',
    idem === true ? 'tick → intent → clientOrderId 계층이 붙어 있습니다'
      : '중복 주문 방지가 붙지 않았습니다',
    idem === true ? ''
      : '타임아웃 재시도 한 번에 같은 주문이 두 번 나갑니다 —'
        + ' 그러면 포지션이 두 배가 되고 장부는 한 건만 압니다');

  // ── 보호 주문 ──
  const prot = bool(i.protectiveStopConfirmed);
  push('protectiveOrders',
    prot === true ? 'PASS' : 'BLOCK',
    prot === true ? '손절이 거래소에 붙는 것을 확인했습니다'
      : '손절이 실제로 붙는지 확인하지 못했습니다',
    prot === true ? ''
      : '체결 접수를 완료로 보면 안 됩니다 — 손절이 안 붙은 포지션 하나에'
        + ' 계좌가 날아갑니다. 붙은 것을 거래소에서 다시 읽어 확인해야 합니다');

  // ── 통합 장부 ──
  const led = bool(i.unifiedLedger);
  push('ledger',
    led === true ? 'PASS' : 'BLOCK',
    led === true ? '모든 화면이 한 장부를 읽습니다'
      : '화면마다 다른 장부를 읽습니다',
    led === true ? ''
      : '거래했는데 다른 화면에 없으면 무엇이 맞는지 알 수 없습니다');

  return out;
}

export interface ReadinessVerdict {
  checks: ReadyCheck[];
  /** 시작해도 되는가 */
  ready: boolean;
  blocked: ReadyCheck[];
  unknown: ReadyCheck[];
  passed: ReadyCheck[];
  /** 화면 맨 위에 크게 */
  headline: string;
  /** 다음에 할 일, 순서대로 */
  nextSteps: string[];
}

/**
 * 켜도 되는가.
 *
 * **BLOCK이 없고 UNKNOWN도 없어야 한다.** UNKNOWN을 통과로 치면 이
 * 관문은 아무것도 막지 못한다 — 확인하지 못한 것은 통과가 아니다.
 */
export function readinessVerdict(input: ReadinessInput | null | undefined): ReadinessVerdict {
  const checks = readinessChecks(input);
  const blocked = checks.filter(c => c.status === 'BLOCK');
  const unknown = checks.filter(c => c.status === 'UNKNOWN');
  const passed = checks.filter(c => c.status === 'PASS');
  const ready = blocked.length === 0 && unknown.length === 0;

  return {
    checks, ready, blocked, unknown, passed,
    headline: ready
      ? '테스트넷 자동매매를 시작할 수 있습니다'
      : `아직 시작할 수 없습니다 — 막힘 ${blocked.length}개 · 확인 불가 ${unknown.length}개`,
    // 순서대로 적는다. 연결이 없으면 나머지를 물어볼 수도 없다.
    nextSteps: [...blocked, ...unknown].map(c => `${c.label}: ${c.needed || c.detail}`),
  };
}

// ── 테스트넷 충전은 수익이 아니다 ─────────────────────────

export interface TestnetPnl {
  /** 처음 넣은 것 + 추가 충전 */
  totalInjected: number | null;
  /** 지금 잔고 */
  currentBalance: number | null;
  /** 전략이 실제로 낸 손익 */
  strategyPnl: number | null;
  note: string;
}

/**
 * 테스트넷 성과.
 *
 * **충전을 수익으로 세지 않는다.**
 *
 * 테스트넷은 돈을 다시 채울 수 있다. 그래서 세 번 파산하고 세 번 충전한
 * 계좌의 마지막 잔고가 처음보다 많을 수 있다 — 그걸 "수익 났다"고 읽으면
 * 100배 전략이 살아남은 것처럼 보인다. 실제로는 세 번 터진 것이다.
 *
 *   초기자금   50,000
 *   추가 충전 100,000
 *   누적 투입 150,000
 *   현재잔고  132,000
 *   전략 손익 -18,000   ← 이것이 진짜 성과다
 */
export function testnetPnlOf(
  initialCapital: any,
  injections: any[] | null | undefined,
  currentBalance: any,
): TestnetPnl {
  const init = num(initialCapital);
  const cur = num(currentBalance);
  const list = Array.isArray(injections) ? injections : [];
  const injected = list.map(num).filter(v => v !== null) as number[];
  const badCount = list.length - injected.length;

  if (init === null || cur === null || badCount > 0) {
    return { totalInjected: null, currentBalance: cur, strategyPnl: null,
      note: '초기자금·충전·현재잔고 중 하나를 읽지 못해 전략 손익을 내지 않습니다 —'
        + ' 충전을 못 세면 파산한 계좌가 수익 난 것처럼 보입니다' };
  }

  const totalInjected = init + injected.reduce((a, b) => a + b, 0);
  return {
    totalInjected, currentBalance: cur,
    strategyPnl: cur - totalInjected,
    note: injected.length > 0
      ? `충전 ${injected.length}회 · 누적 투입 ${totalInjected.toLocaleString('ko-KR')} —`
        + ' 충전은 수익이 아니므로 손익에서 뺐습니다'
      : '',
  };
}

/**
 * 첫날에 켤 전략.
 *
 * **스무 개를 한꺼번에 켜지 않는다.** 오류가 나도 어느 전략 때문인지
 * 못 찾는다. 첫 24시간의 목표는 수익이 아니라 주문 생명주기가 한 번도
 * 꼬이지 않는 것을 보는 것이다.
 */
export const DAY_ONE_STRATEGIES = [
  'VWAP_PULLBACK', 'EMA_PULLBACK', 'BREAKOUT_RETEST',
  'BOLLINGER_SQUEEZE', 'DONCHIAN_ATR',
] as const;

export const DAY_ONE_NOTE =
  '첫날은 5개만 켭니다 — 스무 개를 한꺼번에 켜면 오류가 나도 어느 전략'
  + ' 때문인지 못 찾습니다. 첫 24시간의 목표는 수익률이 아니라'
  + ' signal → risk → intent → submit → fill → position → protection → close'
  + ' → reconcile → ledger가 한 번도 끊기지 않는 것입니다';

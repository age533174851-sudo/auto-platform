// src/lib/strategies/registry.ts
//
// **무엇을 실제로 돌릴 수 있는가 — 한 곳에서 말한다.**
//
// 지금까지 자동매매는 사실상 하나였다
// ───────────────────────────────────
// `autotrade_schedules`는 `(user_id, symbol)`로 한 줄이고, 그 줄을 읽는 것은
// `/api/autotrade/daily-ladder` 하나다. 즉 "BTCUSDT 자동매매를 켠다"는
// **계단식 전략을 켠다**와 같은 말이었는데, 화면 어디에도 그 사실이 없다.
// 다른 전략을 켤 방법도, 같은 종목에 두 전략을 돌릴 방법도 없다.
//
// 조사해서 적은 것이다 — 짐작이 아니다
// ────────────────────────────────────
// 저장소에서 **실제로 주문을 내는 경로**를 세어 보면 둘뿐이다:
//
//   daily-ladder  /api/autotrade/daily-ladder — 일봉 계단식.
//                 GitHub Actions(autotrade-tick.yml)가 15분마다 부른다.
//                 지금 도는 유일한 자동매매다.
//   scalp         /api/autotrade/scalp — 분봉 돌파.
//                 주문 경로(riskManager·executeOrder)는 daily-ladder와 같은
//                 것을 쓴다. **그런데 아무도 안 부른다** — 크론에 없다.
//                 그래서 '만들어 놓고 배선 안 함' 상태다.
//
// 나머지(edgeSweep · monteCarlo · dailyBattle · fearDca · scalpSignal ·
// combined …)는 **연구·백테스트 모듈이다.** 주문 경로가 없다. 이름이
// 그럴듯하다는 이유로 자동매매 목록에 넣으면, 사용자는 켰다고 믿고
// 아무 일도 일어나지 않는다 — 이 저장소에서 가장 자주 난 고장이다.
//
// 그래서 이 파일의 규칙은 하나다:
// **`executionReady: false`인 것은 자동매매로 켤 수 없다.**

export type StrategyId = 'daily-ladder' | 'scalp' | 'my-original-v1';

/** 원본 전략의 id. 문자열을 여기저기 적으면 오타가 조용히 다른 전략이 된다 */
export const STRATEGY_MY_ORIGINAL_V1 = 'my-original-v1';

export type StrategyMarket = 'USDM';

export interface StrategySpec {
  id: StrategyId;
  name: string;
  /**
   * 판정 로직이 바뀌면 올린다.
   *
   * 예약에 저장된 버전과 다르면 **임의로 최신 버전을 돌리지 않는다.**
   * 사용자가 검증한 것은 그때의 규칙이고, 조용히 다른 규칙으로 갈아타면
   * 그건 다른 전략이 도는 것이다.
   */
  version: string;
  description: string;
  supportedMarkets: StrategyMarket[];
  /** 이 전략이 뜻을 갖는 평가 주기(분). 여기 없는 값은 받지 않는다 */
  supportedIntervals: number[];
  /** **주문까지 나가는 경로가 실제로 있는가.** false면 자동매매로 못 켠다 */
  executionReady: boolean;
  /** 테스트넷에서 돌려도 되는가 */
  testnetReady: boolean;
  /** 실전에서 돌려도 되는가 */
  liveReady: boolean;
  /**
   * 이 전략을 실행하는 서버 경로. `runStrategy`가 여기로 보낸다.
   * 연구 전용이면 null.
   */
  route: string | null;
  /**
   * **주문을 내지 말고 판정만 하라는 깃발의 이름.**
   *
   * 전략마다 다르다 — `daily-ladder`·`scalp`은 `checkOnly`, 원본 v1은
   * `dryRun`이다. 부르는 쪽이 이걸 외우면 언젠가 틀리고, **틀리면
   * 점검인 줄 알았던 호출이 진짜 주문을 낸다.** 그래서 명세에 적는다.
   */
  checkFlag: 'checkOnly' | 'dryRun';
  /** 왜 아직 못 켜는가 / 무엇을 알아야 하는가. 사람이 읽는 한 줄 */
  note: string;
}

export const STRATEGIES: StrategySpec[] = [
  {
    id: 'daily-ladder',
    name: '일봉 계단식',
    version: '1',
    description:
      '일봉을 보고 하루 한 번 계단식으로 들어갑니다. 지금 실제로 도는 유일한 자동매매입니다.',
    supportedMarkets: ['USDM'],
    // 하루 1회 전략이라 분 단위 평가는 뜻이 없다. 그래도 '언제 볼 것인가'는
    // 예약마다 다를 수 있어 몇 가지를 연다.
    supportedIntervals: [60, 240, 720, 1440],
    executionReady: true,
    testnetReady: true,
    liveReady: true,
    route: '/api/autotrade/daily-ladder',
    checkFlag: 'checkOnly',
    note: '진입은 하루 한 번으로 제한됩니다 — 평가 주기를 짧게 잡아도 그 규칙은 그대로입니다',
  },
  {
    id: 'scalp',
    name: '분봉 돌파',
    version: '1',
    description:
      '고른 분봉에서 돌파 자리를 보고 들어갑니다. 크기·배율·안전 관문은 계단식과 같은 것을 씁니다.',
    supportedMarkets: ['USDM'],
    supportedIntervals: [1, 5, 15, 60],
    // **주문 경로는 있다.** riskManager·executeOrder를 그대로 쓴다.
    executionReady: true,
    testnetReady: true,
    // 실전은 아직 닫는다. 이 경로는 지금까지 **한 번도 스케줄된 적이 없어서**
    // 실제로 돈 이력이 없다. 검증되지 않은 것을 실계좌에 여는 것이
    // 이 저장소가 반복해서 피해 온 일이다.
    liveReady: false,
    route: '/api/autotrade/scalp',
    checkFlag: 'checkOnly',
    note: '지금까지 스케줄된 적이 없어 실제 실행 이력이 없습니다 — 테스트넷에서 먼저 돌려야 합니다',
  },
  {
    id: 'my-original-v1',
    name: '내 원본 v1',
    version: '1',
    description:
      '한국시간 09:10~09:30 구간을 보고 하루 한 번 판단합니다. 주문 크기는 가상 원장의 '
      + '자릿수 구간이 정합니다($100대→$10 · $1,000대→$100 · $10,000대→$1,000). 100배 요청.',
    supportedMarkets: ['USDM'],
    // **하루 주기(1440)를 열지 않는다.**
    //
    // 판단은 하루 한 번이지만 평가 주기는 그것보다 짧아야 한다. 1440으로
    // 두면 마지막 평가가 오후 2시였을 때 다음 평가도 다음 날 오후 2시가
    // 되어, 09:10~09:30 창을 **매일 놓친다.** 실행기가 15분마다 오므로
    // 그 안에서 창을 만날 수 있는 값만 연다.
    supportedIntervals: [5, 15, 30, 60],
    executionReady: true,
    testnetReady: true,
    // 실전은 닫는다. 진입 규칙이 아직 비어 있고, 검증되지 않은 것을
    // 실계좌에 여는 것이 이 저장소가 반복해서 피해 온 일이다.
    liveReady: false,
    route: '/api/autotrade/my-original-v1',
    checkFlag: 'dryRun',
    note: '진입 방향과 손절·익절 규칙이 아직 입력되지 않았습니다 — 평가·시간창·하루 1회·'
      + '주문 크기 계산·기록은 실제로 돌지만 주문은 나가지 않습니다',
  },
];

const BY_ID = new Map<string, StrategySpec>(STRATEGIES.map(s => [s.id, s]));

/**
 * 자동매매로 **켤 수 있는** 전략만.
 *
 * 화면의 목록은 이것을 쓴다. `executionReady: false`인 것을 섞어 놓고
 * 버튼만 비활성화하면, 언젠가 그 비활성화가 풀린다.
 */
export function runnableStrategies(env: 'TESTNET' | 'LIVE'): StrategySpec[] {
  return STRATEGIES.filter(s =>
    s.executionReady && (env === 'LIVE' ? s.liveReady : s.testnetReady));
}

// ── 실행 전 판정 ─────────────────────────────────────

export type StrategyResolveCode =
  | 'OK'
  | 'UNKNOWN_STRATEGY'     // 모르는 id — 실행하지 않는다
  | 'NOT_EXECUTION_READY'  // 연구 전용
  | 'ENV_NOT_READY'        // 이 환경에서는 아직 안 연다
  | 'VERSION_MISMATCH'     // 저장된 버전과 다르다 — 임의로 최신을 돌리지 않는다
  | 'INTERVAL_UNSUPPORTED';

export interface StrategyResolution {
  ok: boolean;
  code: StrategyResolveCode;
  spec: StrategySpec | null;
  message: string;
}

/**
 * 이 전략을 이 환경에서 이 주기로 돌려도 되는가.
 *
 * **모르는 id는 막는다.** 기본 전략으로 떨어뜨리지 않는다 — 그러면 사용자가
 * 고르지 않은 전략이 그 사람 계좌에서 돈다.
 *
 * **버전이 다르면 막는다.** 저장된 것이 '1'인데 지금 코드가 '2'면, 사용자가
 * 검증한 규칙과 지금 돌 규칙이 다르다. 조용히 최신으로 갈아타지 않는다.
 */
export function resolveStrategy(input: {
  id: any;
  /** 예약에 저장된 버전. 없으면(옛 행) 현재 버전으로 본다 */
  version?: any;
  env: 'TESTNET' | 'LIVE';
  intervalMin?: any;
}): StrategyResolution {
  const rawId = String(input.id ?? '').trim();
  const spec = BY_ID.get(rawId) ?? null;
  if (!spec) {
    return {
      ok: false, code: 'UNKNOWN_STRATEGY', spec: null,
      message: `모르는 전략입니다: ${rawId || '(비어 있음)'} — `
             + '기본 전략으로 대신 돌리지 않습니다. 고르지 않은 전략이 계좌에서 도는 것을 막습니다',
    };
  }

  if (!spec.executionReady) {
    return {
      ok: false, code: 'NOT_EXECUTION_READY', spec,
      message: `'${spec.name}'은 연구 전용입니다 — 주문까지 나가는 경로가 없습니다. ${spec.note}`,
    };
  }

  const envOk = input.env === 'LIVE' ? spec.liveReady : spec.testnetReady;
  if (!envOk) {
    return {
      ok: false, code: 'ENV_NOT_READY', spec,
      message: `'${spec.name}'은 ${input.env}에서 아직 쓸 수 없습니다. ${spec.note}`,
    };
  }

  // 버전. **안 적혀 있으면 지금 버전으로 본다** — 이 칸이 생기기 전에 만든
  // 예약이 그렇다. 적혀 있는데 다르면 막는다.
  const rawVer = input.version == null ? '' : String(input.version).trim();
  if (rawVer && rawVer !== spec.version) {
    return {
      ok: false, code: 'VERSION_MISMATCH', spec,
      message: `이 예약은 '${spec.name}' v${rawVer}로 저장됐는데 지금 코드는 v${spec.version}입니다 — `
             + '판정 규칙이 바뀌었을 수 있어 임의로 최신 버전을 돌리지 않습니다. '
             + '예약을 열어 현재 버전으로 다시 저장하세요',
    };
  }

  if (input.intervalMin != null && input.intervalMin !== '') {
    const n = Number(input.intervalMin);
    if (!Number.isFinite(n) || !spec.supportedIntervals.includes(n)) {
      return {
        ok: false, code: 'INTERVAL_UNSUPPORTED', spec,
        message: `'${spec.name}'은 ${input.intervalMin}분 주기를 지원하지 않습니다 — `
               + `가능: ${spec.supportedIntervals.join(' · ')}분`,
      };
    }
  }

  return { ok: true, code: 'OK', spec, message: spec.name };
}

/**
 * 옛 예약을 어느 전략으로 볼 것인가.
 *
 * `strategy_id` 칸이 생기기 전에 만든 줄은 전부 계단식이다 — 그 줄을 읽는
 * 실행기가 `daily-ladder` 하나뿐이었기 때문이다. **짐작이 아니라 사실이다.**
 * 그래도 값을 조용히 채우지 않고, 부르는 쪽이 이 함수를 통해 명시적으로
 * 정하게 한다.
 */
export const LEGACY_STRATEGY_ID: StrategyId = 'daily-ladder';

export function strategyIdOfRow(row: { strategy_id?: any } | null | undefined): StrategyId {
  const raw = String(row?.strategy_id ?? '').trim();
  return BY_ID.has(raw) ? (raw as StrategyId) : LEGACY_STRATEGY_ID;
}

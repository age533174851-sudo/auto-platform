// src/lib/runtime/dataLocation.ts
//
// **크론을 붙여도 돌릴 것이 없었다.**
//
// 예약 청산을 서버로 옮길 때는 쉬웠다 — 실행 주소가 이미 서버에 있었고,
// 그것을 부르는 크론만 붙이면 됐다.
//
// 전략빌더는 다르다:
//
//   src/lib/strategies/store.ts
//   // 사용자 전략 CRUD (localStorage 기반)
//   window.localStorage.getItem(KEY)
//
// 전략이 **브라우저 안에만** 있다. 서버는 그 전략이 있는지조차 모른다.
// 크론을 아무리 잘 붙여도 읽을 것이 없다.
//
// 이건 실행 문제만이 아니다
// ─────────────────────────
//   · 휴대폰에서 만든 전략이 PC에 없다
//   · 브라우저 데이터를 지우면 전략이 사라진다
//   · 시크릿 모드에서는 아예 안 남는다
//   · 기기를 바꾸면 처음부터 다시 만들어야 한다
//
// 이 파일이 하는 일
// ─────────────────
// **데이터가 어디 사는지를 판정으로 만든다.** 그러면 화면이 사실대로
// 적을 수 있고, "왜 다른 기기에 없지"를 사용자가 혼자 추측하지 않아도 된다.
//
// 그리고 이 구분이 있어야 "서버로 옮겨야 할 것" 목록이 흐려지지 않는다.
// 브라우저 저장은 그 자체로 나쁜 것이 아니다 — 접힘/펼침 상태나 정렬
// 순서는 거기 있는 것이 맞다. **실행에 필요한 것이 거기 있는 것**이 문제다.

export type DataLocation =
  /** 서버 DB. 어느 기기에서든 보이고 서버가 읽을 수 있다 */
  | 'SERVER'
  /** 이 브라우저에만 있다 */
  | 'BROWSER_ONLY'
  /** 확인하지 못했다 */
  | 'UNKNOWN';

/**
 * 이 데이터가 없어지면 무엇이 곤란해지는가.
 *
 * 이 등급이 판정을 가른다 — 실행에 쓰이는 것이 브라우저에만 있으면
 * 그건 고쳐야 할 것이고, 화면 접힘 상태는 아니다.
 */
export type DataKind =
  /** 이것 없이는 자동 실행이 안 된다 */
  | 'EXECUTION'
  /** 잃으면 다시 만들어야 하는 사용자 자산 */
  | 'USER_ASSET'
  /** 편의 설정. 잃어도 다시 고르면 된다 */
  | 'PREFERENCE'
  /** 화면에서만 뜻이 있는 것 */
  | 'EPHEMERAL';

export interface LocationVerdict {
  location: DataLocation;
  kind: DataKind;
  /** 지금 자리가 맞는가 */
  ok: boolean;
  /** 화면에 적을 한 줄. 맞으면 빈 문자열 */
  warning: string;
  /** 무엇을 해야 하는가 */
  nextStep: string;
}

const KIND_LABEL: Record<DataKind, string> = {
  EXECUTION: '자동 실행에 쓰이는 데이터',
  USER_ASSET: '다시 만들어야 하는 데이터',
  PREFERENCE: '편의 설정',
  EPHEMERAL: '화면 상태',
};

/**
 * 이 데이터가 지금 자리에 있어도 되는가.
 *
 * **실행에 쓰이는 것이 브라우저에만 있으면 안 된다.** 서버가 못 읽으면
 * 자동 실행이 원리적으로 불가능하고, 그 사실이 화면에 안 뜨면 사용자는
 * "왜 안 돌지"를 타이머 문제로 오해한다.
 */
export function locationVerdict(kind: DataKind, location: DataLocation): LocationVerdict {
  const base = { location, kind };

  if (location === 'UNKNOWN') {
    return { ...base, ok: false,
      warning: `${KIND_LABEL[kind]}가 어디 저장되는지 확인하지 못했습니다`,
      nextStep: '저장 위치를 확인하세요 — 모르면 잃어도 모릅니다' };
  }

  if (location === 'SERVER') {
    return { ...base, ok: true, warning: '', nextStep: '' };
  }

  // 여기부터 BROWSER_ONLY.
  if (kind === 'EXECUTION') {
    return { ...base, ok: false,
      warning: '이 브라우저에만 저장돼 있습니다 — 서버가 읽을 수 없어 **자동 실행이 되지 않습니다.**'
        + ' 이 화면을 닫으면 아무것도 돌지 않고, 다른 기기에서도 보이지 않습니다.',
      nextStep: '서버에 저장하도록 옮겨야 합니다. 크론을 붙여도 읽을 것이 없어 해결되지 않습니다' };
  }
  if (kind === 'USER_ASSET') {
    return { ...base, ok: false,
      warning: '이 브라우저에만 저장돼 있습니다 — 브라우저 데이터를 지우거나 기기를 바꾸면 사라집니다.',
      nextStep: '서버 저장으로 옮기세요' };
  }
  // 편의 설정과 화면 상태는 브라우저에 있어도 된다.
  return { ...base, ok: true, warning: '', nextStep: '' };
}

// ── 지금 무엇이 어디 있는가 ───────────────────────────────

export interface DataItem {
  id: string;
  label: string;
  kind: DataKind;
  location: DataLocation;
  /** 어디에 저장되는지 */
  where: string;
}

/**
 * 저장소 전수 목록.
 *
 * **이 목록이 비어 있지 않은 동안 "상시 실행"은 절반만 참이다.**
 * 실행에 쓰이는 데이터가 브라우저에 있으면, 서버 실행기를 아무리 잘
 * 만들어도 그것만은 못 돌린다.
 */
export const DATA_ITEMS: DataItem[] = [
  {
    id: 'user_strategies', label: '전략빌더 전략',
    kind: 'EXECUTION', location: 'BROWSER_ONLY',
    where: 'localStorage (src/lib/strategies/store.ts)',
  },
  {
    id: 'autotrade_schedules', label: '자동매매 예약',
    kind: 'EXECUTION', location: 'SERVER',
    where: 'autotrade_schedules 표',
  },
  {
    id: 'scheduled_exits', label: '예약 청산',
    kind: 'EXECUTION', location: 'SERVER',
    where: 'scheduled_exits 표',
  },
  {
    id: 'strategy_accounts', label: '전략 계좌 배정',
    kind: 'EXECUTION', location: 'SERVER',
    where: 'strategy_accounts 표',
  },
  {
    id: 'mock_session', label: 'MOCK 자동매매 세션',
    kind: 'EXECUTION', location: 'BROWSER_ONLY',
    where: '컴포넌트 상태 (MockAutoTrade.tsx) — 새로고침하면 사라진다',
  },
  {
    id: 'paper_balance', label: '모의 잔고·포지션',
    kind: 'USER_ASSET', location: 'BROWSER_ONLY',
    where: 'localStorage (src/lib/autotrade/store.ts)',
  },
  {
    id: 'exec_logs', label: '자동매매 실행 기록',
    kind: 'USER_ASSET', location: 'BROWSER_ONLY',
    where: 'localStorage (src/lib/autotrade/store.ts)',
  },
  {
    id: 'ui_prefs', label: '화면 설정 (정렬·접힘·관심종목)',
    kind: 'PREFERENCE', location: 'BROWSER_ONLY',
    where: 'localStorage — 여기 있어도 됩니다',
  },
];

export interface LocationAudit {
  /** 지금 자리가 잘못된 것들 */
  misplaced: Array<DataItem & { verdict: LocationVerdict }>;
  /** 그중 자동 실행을 막는 것 */
  blocksExecution: number;
  ok: boolean;
  summary: string;
}

/**
 * 전수 판정.
 *
 * **실행에 쓰이는 것이 브라우저에 하나라도 있으면 ok가 아니다.**
 */
export function auditDataLocations(items?: DataItem[] | null): LocationAudit {
  const list = Array.isArray(items) ? items : DATA_ITEMS;
  const misplaced = list
    .map(it => ({ ...it, verdict: locationVerdict(it.kind, it.location) }))
    .filter(it => !it.verdict.ok);
  const blocksExecution = misplaced.filter(it => it.kind === 'EXECUTION').length;

  return {
    misplaced, blocksExecution,
    ok: misplaced.length === 0,
    summary: misplaced.length === 0
      ? '실행에 필요한 데이터가 모두 서버에 있습니다'
      : `브라우저에만 있는 데이터 ${misplaced.length}개`
        + (blocksExecution > 0
          ? ` — 그중 ${blocksExecution}개는 자동 실행을 막습니다 (서버가 읽을 수 없습니다)`
          : ''),
  };
}

// src/lib/ui/inventory.ts
//
// **UI Inventory — 이 파일이 진실이다.**
//
// `docs/ui-inventory.md`는 여기서 굽는 자동 생성물이다. 문서를 손으로
// 고쳐 진실을 관리하지 않는다 — 이 저장소는 그 실패를 이미 겪었다
// (FULL_COMPLETION_STATUS.md · 마이그레이션 목록 054·055·056).
//
// 왜 스캐너가 아니라 손으로 적은 registry인가
// ───────────────────────────────────────────
// 처음엔 코드를 훑어 목록을 만들었다. 그때 실제로 도움이 된 것이 하나
// 있다 — **화면 목록이 세 곳에 따로 있다는 사실**을 찾았고, 그래서
// 지갑 화면을 놓칠 뻔한 것을 알았다.
//
// 그런데 스캐너는 "이 화면의 목적이 무엇이고 어떤 상태를 그리는가"를
// 답할 수 없다. 추측하게 만들면 **틀린 답이 자동으로 갱신되는** 문서가
// 된다. 그래서 의미는 여기에 사람이 적고, 스캐너는 **대조만** 한다:
// 실제 화면을 찾아 여기 등록됐는지 본다(`check-ui-inventory.mjs`).
//
// CURRENT / TARGET / DECISION을 나눈다
// ────────────────────────────────────
// Inventory가 설계안만 적는 문서가 되면 안 된다. **지금 무엇이 있는지**와
// **무엇으로 통일할지**는 다른 사실이고, 후자는 아직 안 정해진 것도 있다.

// ══ 값의 종류 ══

/** 실행 환경. **셋은 절대 같은 것이 아니다** */
export type Environment = 'LIVE' | 'TESTNET' | 'PAPER' | 'NA';
export const ENVIRONMENTS: Environment[] = ['LIVE', 'TESTNET', 'PAPER', 'NA'];

/**
 * 화면이 그릴 수 있는 상태.
 *
 * **UNKNOWN ≠ ERROR.** 못 읽은 것과 막힌 것은 사용자에게 전혀 다른
 * 행동을 요구한다. **DISABLED ≠ ERROR.** 아직 안 켠 것은 고장이 아니다.
 */
export type UiState =
  | 'LOADING' | 'EMPTY' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'UNKNOWN' | 'DISABLED';
export const UI_STATES: UiState[] = [
  'LOADING', 'EMPTY', 'SUCCESS', 'WARNING', 'ERROR', 'UNKNOWN', 'DISABLED',
];

/** 표시 계층으로 얼마나 왔는가 */
export type MigrationStatus = 'LEGACY' | 'PARTIAL' | 'MIGRATED' | 'PENDING_PR';
export const MIGRATION_STATUSES: MigrationStatus[] = ['LEGACY', 'PARTIAL', 'MIGRATED', 'PENDING_PR'];

/** primitive가 지금 어떤 상태인가 */
export type PrimitiveStatus = 'EXISTS' | 'DUPLICATED' | 'MISSING' | 'LEGACY' | 'PROPOSED';
export const PRIMITIVE_STATUSES: PrimitiveStatus[] = [
  'EXISTS', 'DUPLICATED', 'MISSING', 'LEGACY', 'PROPOSED',
];

/**
 * 이 화면을 얼마나 들여다봤는가.
 *
 * **확인하지 못한 것을 통과로 적지 않는다.** 목록에 있다는 것과 상태·
 * 액션까지 확인했다는 것은 다른 사실이다. 안 본 화면에 그럴듯한 상태를
 * 적으면, 그 문서를 보고 내리는 판단이 전부 틀린다.
 */
export type SurveyDepth = 'SURVEYED' | 'LISTED_ONLY';

/** 사용자용인가 개발자용인가 */
export type Audience = 'USER' | 'DIAGNOSTICS' | 'ADMIN';

// ══ 화면 ══

export interface Screen {
  id: string;
  label: string;
  /** 라우트(`/terminal`)이거나 메인 앱 안의 탭(`tab:auto`) */
  routeOrSurface: string;
  purpose: string;
  primaryActions: string[];
  environments: Environment[];
  states: UiState[];
  /** 이 화면이 쓰는 primitive id */
  primitives: string[];
  /** 개발자용 정보가 이 화면 어디에 있는가. 없으면 null */
  diagnostics: string | null;
  migration: MigrationStatus;
  audience: Audience;
  depth: SurveyDepth;
  notes: string;
}

// ── 화면 목록 ──
//
// `depth: 'LISTED_ONLY'`는 **존재를 확인했지만 상태·액션까지는 아직
// 안 본 화면**이다. 지어내지 않는다.

export const SCREENS: Screen[] = [
  {
    id: 'home', label: '홈', routeOrSurface: 'tab:home',
    purpose: '오늘 무슨 일이 있었는지 한 화면에서 본다',
    primaryActions: ['자산 열기', '화면 이동'],
    environments: ['LIVE', 'TESTNET', 'PAPER'],
    states: ['LOADING', 'SUCCESS', 'UNKNOWN'],
    primitives: ['Card', 'Badge'],
    diagnostics: null, migration: 'LEGACY', audience: 'USER', depth: 'SURVEYED',
    notes: "'확인 불가'를 직접 적는 자리가 남아 있다",
  },
  {
    id: 'market', label: '시장 보기', routeOrSurface: 'tab:market',
    purpose: '실시간 코인·주식 시세',
    primaryActions: ['종목 열기', '통화 전환'],
    environments: ['NA'],
    states: ['LOADING', 'SUCCESS', 'UNKNOWN'],
    primitives: ['Card', 'Badge'],
    diagnostics: null, migration: 'LEGACY', audience: 'USER', depth: 'SURVEYED',
    notes: '시세는 환경과 무관하다 — 환경 배지를 붙이지 않는다',
  },
  {
    id: 'trading', label: '매매하기', routeOrSurface: 'tab:trading',
    purpose: '차트·호가·주문 통합 화면',
    primaryActions: ['주문', '수동 연습 매매'],
    environments: ['LIVE', 'TESTNET', 'PAPER'],
    states: ['LOADING', 'SUCCESS', 'WARNING', 'ERROR'],
    primitives: ['Card', 'Button', 'Badge'],
    diagnostics: null, migration: 'LEGACY', audience: 'USER', depth: 'SURVEYED',
    notes: '**로컬 원화 연습 장부가 남아 있다** — canonical PAPER가 아니다. '
      + 'DECISION 참조. 이번 단계에서 바꾸지 않는다',
  },
  {
    id: 'terminal', label: '터미널', routeOrSurface: '/terminal',
    purpose: '주문·호가·차트를 붙인 전문 화면',
    primaryActions: ['주문', '호가 보기'],
    environments: ['LIVE', 'TESTNET'],
    states: ['LOADING', 'SUCCESS', 'ERROR'],
    primitives: ['Card', 'Button'],
    diagnostics: null, migration: 'LEGACY', audience: 'USER', depth: 'LISTED_ONLY',
    notes: 'Inventory 완료 전에는 이관을 시작하지 않는다',
  },
  {
    id: 'auto', label: '자동매매', routeOrSurface: 'tab:auto',
    purpose: 'AI가 대신 자동 거래',
    primaryActions: ['전략 켜기/끄기', '예약 등록', '지금 중지'],
    environments: ['LIVE', 'TESTNET', 'PAPER'],
    states: ['LOADING', 'EMPTY', 'SUCCESS', 'WARNING', 'ERROR', 'UNKNOWN'],
    primitives: ['Card', 'Badge', 'MoneyValue', 'PnlValue'],
    diagnostics: '진단 탭', migration: 'PARTIAL', audience: 'USER', depth: 'SURVEYED',
    notes: '모의 잔고 카드만 표시 계층으로 옮겼다(구간 잠금 AUTOPAGE-PAPER-CARD). '
      + '나머지는 만원 단위 원화 표기 등 legacy',
  },
  {
    id: 'paper', label: '모의매매', routeOrSurface: 'tab:paper',
    purpose: '가짜 돈으로 연습',
    primaryActions: ['모의투자 시작', '초기화'],
    environments: ['PAPER'],
    states: ['LOADING', 'EMPTY', 'SUCCESS', 'UNKNOWN', 'DISABLED'],
    primitives: ['Card', 'ValueRow', 'MoneyValue'],
    diagnostics: null, migration: 'MIGRATED', audience: 'USER', depth: 'SURVEYED',
    notes: 'MockAutoTrade가 이 화면의 본체. 표시 계층 전체 이관 완료(파일 잠금)',
  },
  {
    id: 'strategies', label: '전략빌더', routeOrSurface: 'tab:strategies',
    purpose: '나만의 매매 규칙 만들기',
    primaryActions: ['전략 생성', '전략 저장'],
    environments: ['NA'],
    states: ['LOADING', 'EMPTY', 'SUCCESS', 'ERROR'],
    primitives: ['Card', 'Button', 'Input'],
    diagnostics: null, migration: 'LEGACY', audience: 'USER', depth: 'LISTED_ONLY',
    notes: '`my-original-v1` 원본 전략은 덮어쓰거나 삭제하지 않는다',
  },
  {
    id: 'portfolio', label: '포트폴리오', routeOrSurface: 'tab:portfolio',
    purpose: '내 자산 현황',
    primaryActions: ['자산 열기'],
    environments: ['LIVE', 'TESTNET'],
    states: ['LOADING', 'EMPTY', 'SUCCESS', 'UNKNOWN'],
    primitives: ['Card', 'MoneyValue'],
    diagnostics: null, migration: 'LEGACY', audience: 'USER', depth: 'LISTED_ONLY',
    notes: '',
  },
  {
    id: 'wallet', label: '지갑', routeOrSurface: 'tab:wallet',
    purpose: '환경별 총자산·오늘 손익·모의계좌',
    primaryActions: ['환경 전환', '통화 전환', '모의투자 시작·충전'],
    environments: ['LIVE', 'TESTNET', 'PAPER'],
    states: ['LOADING', 'EMPTY', 'SUCCESS', 'WARNING', 'ERROR', 'UNKNOWN', 'DISABLED'],
    primitives: ['StatusCard', 'EnvBadge', 'Details', 'SafeNote', 'MoneyValue', 'PnlValue'],
    diagnostics: '각 상태 카드의 접히는 "진단 정보"',
    migration: 'MIGRATED', audience: 'USER', depth: 'SURVEYED',
    notes: '#213에서 이관 완료(main). **MENU에 없고 BTABS·MTABS에만 있다** — '
      + '스캐너가 MENU만 읽었을 때 통째로 빠졌던 화면이다',
  },
  {
    id: 'history', label: '실행기록', routeOrSurface: 'tab:history',
    purpose: '자동매매 체결 내역',
    primaryActions: ['기록 보기'],
    environments: ['LIVE', 'TESTNET', 'PAPER'],
    states: ['LOADING', 'EMPTY', 'SUCCESS', 'UNKNOWN'],
    primitives: ['Card', 'ValueRow'],
    diagnostics: null, migration: 'LEGACY', audience: 'USER', depth: 'LISTED_ONLY',
    notes: '',
  },
  {
    id: 'backtest', label: '백테스트', routeOrSurface: 'tab:backtest',
    purpose: '과거 데이터로 전략 검증',
    primaryActions: ['백테스트 실행'],
    environments: ['NA'],
    states: ['LOADING', 'EMPTY', 'SUCCESS', 'ERROR'],
    primitives: ['Card', 'Button'],
    diagnostics: null, migration: 'LEGACY', audience: 'USER', depth: 'LISTED_ONLY',
    notes: '청산 규칙은 실전과 같은 `exitRules`를 쓴다',
  },
  {
    id: 'alerts', label: '알림', routeOrSurface: 'tab:alerts',
    purpose: '가격·체결 알림 설정',
    primaryActions: ['알림 추가', '알림 끄기'],
    environments: ['NA'],
    states: ['LOADING', 'EMPTY', 'SUCCESS', 'ERROR'],
    primitives: ['Card', 'Toast'],
    diagnostics: null, migration: 'LEGACY', audience: 'USER', depth: 'LISTED_ONLY',
    notes: '',
  },
  {
    id: 'diagnostics', label: 'API 진단', routeOrSurface: 'tab:diagnostics',
    purpose: '연결 상태 점검',
    primaryActions: ['점검 실행'],
    environments: ['LIVE', 'TESTNET'],
    states: ['LOADING', 'SUCCESS', 'WARNING', 'ERROR', 'UNKNOWN'],
    primitives: ['Card', 'Badge'],
    diagnostics: '화면 전체가 진단이다',
    migration: 'LEGACY', audience: 'DIAGNOSTICS', depth: 'LISTED_ONLY',
    notes: '',
  },
  {
    id: 'ops', label: '운영', routeOrSurface: 'tab:ops',
    purpose: '점검·배포·복구를 명령 하나로',
    primaryActions: ['전체 점검', '배포', '복구'],
    environments: ['LIVE', 'TESTNET'],
    states: ['LOADING', 'SUCCESS', 'WARNING', 'ERROR', 'UNKNOWN'],
    primitives: ['Card', 'Button'],
    diagnostics: '단계별 결과 로그',
    migration: 'LEGACY', audience: 'DIAGNOSTICS', depth: 'LISTED_ONLY',
    notes: '사용자가 명령 하나로 부르는 자리 — 최상위 규칙의 "사용자는 명령만 한다"',
  },
  {
    id: 'accounts', label: 'API 연결', routeOrSurface: 'tab:accounts',
    purpose: '거래소 API 연결',
    primaryActions: ['거래소 연결', '연결 해제'],
    environments: ['LIVE', 'TESTNET'],
    states: ['LOADING', 'EMPTY', 'SUCCESS', 'ERROR'],
    primitives: ['Card', 'Button', 'Input', 'Toast'],
    diagnostics: null, migration: 'LEGACY', audience: 'USER', depth: 'LISTED_ONLY',
    notes: '**키·시크릿 값은 화면에도 로그에도 남기지 않는다.** 지문만 비교한다',
  },
  {
    id: 'settings', label: '설정', routeOrSurface: 'tab:settings',
    purpose: '통화·언어·알림',
    primaryActions: ['설정 변경'],
    environments: ['NA'],
    states: ['LOADING', 'SUCCESS'],
    primitives: ['Card', 'SettingField'],
    diagnostics: null, migration: 'LEGACY', audience: 'USER', depth: 'LISTED_ONLY',
    notes: '',
  },
  {
    id: 'admin', label: '관리자', routeOrSurface: '/admin',
    purpose: '운영자 전용 관리',
    primaryActions: ['사용자 관리'],
    environments: ['NA'],
    states: ['LOADING', 'SUCCESS', 'ERROR'],
    primitives: ['Card'],
    diagnostics: '화면 전체가 관리자용이다',
    migration: 'LEGACY', audience: 'ADMIN', depth: 'LISTED_ONLY',
    notes: '일반 사용자 화면 목록에 넣지 않는다',
  },
];

// ══ 네비게이션 ══
//
// **화면 목록이 세 곳에 따로 있다.** 이것이 Inventory가 가장 먼저 찾아낸
// 사실이다. 처음에 MENU만 읽었더니 지갑(wallet) 화면이 통째로 빠졌다 —
// 지갑은 MENU에 없고 BTABS·MTABS에만 있다.

export interface NavSource {
  id: string;
  label: string;
  /** 정의가 어디에 있는가 */
  file: string;
  symbol: string;
  /** 몇 개를 담고 있는가 (확인 시점) */
  count: number;
  notes: string;
}

export const NAVIGATION: NavSource[] = [
  {
    id: 'menu', label: '검색·카테고리 메뉴',
    file: 'src/lib/menuItems.tsx', symbol: 'MENU', count: 30,
    notes: '유일하게 목적(desc)과 분류(cat)를 갖고 있다. `check-nav.mjs`가 보는 곳',
  },
  {
    id: 'bottom', label: '하단 탭',
    file: 'src/app/page.tsx', symbol: 'BTABS', count: 5,
    notes: '홈·시장·매매·자동·지갑. 마지막 칸의 더보기는 화면이 아니라 겹치는 층이라 여기 없다',
  },
  {
    id: 'more', label: "'더보기' 시트",
    file: 'src/app/page.tsx', symbol: 'MTABS', count: 53,
    notes: '가장 많은 화면이 여기에만 있다. `check-nav.mjs`의 범위 밖이었다',
  },
];

// ══ 공통 primitive ══

export interface Primitive {
  id: string;
  /** 어디에 있는가. 없으면 null */
  file: string | null;
  status: PrimitiveStatus;
  purpose: string;
  /**
   * **무엇으로 모을 것인가.**
   *
   * "지금 어디에 있는가"(file)만 적으면 Inventory는 파일 목록으로 끝난다.
   * 이관 작업의 지도가 되려면 **각 항목이 어디로 가는지**가 같이 있어야
   * 한다. 아직 안 정한 것은 비워 두지 말고 '미정'이라고 적는다.
   */
  target: string;
  notes: string;
}

export const PRIMITIVES: Primitive[] = [
  // ── 있는 것 (상태 표현, #213으로 main에 들어옴) ──
  {
    id: 'StatusCard', file: 'src/components/ui/Status.tsx', status: 'EXISTS',
    purpose: '짧은 첫 줄 + 접히는 상세·진단',
    target: '그대로 — 모든 화면의 상태 카드가 여기로 모인다',
    notes: '#213에서 지갑이 처음 쓴다. 다른 화면은 아직 인라인 박스를 쓴다',
  },
  {
    id: 'EnvBadge', file: 'src/components/ui/Status.tsx', status: 'EXISTS',
    purpose: 'LIVE·TESTNET·PAPER를 색과 글자 둘 다로 구분',
    target: '그대로 — 환경 표시는 전부 여기로',
    notes: '#213. **색만으로 구분하지 않는다**',
  },
  {
    id: 'Details', file: 'src/components/ui/Status.tsx', status: 'EXISTS',
    purpose: '접히는 상세. 최소 높이 32px(손가락)',
    target: '그대로',
    notes: '#213',
  },
  {
    id: 'SafeNote', file: 'src/components/ui/Status.tsx', status: 'EXISTS',
    purpose: '서버 문장을 본문/진단으로 갈라 그린다',
    target: '그대로',
    notes: '#213. 원문을 버리지 않고 자리만 옮긴다',
  },
  {
    id: 'StatusDot', file: 'src/components/ui/Status.tsx', status: 'EXISTS',
    purpose: '표 안의 가장 작은 상태 표시',
    target: '그대로',
    notes: '#213',
  },

  // ── 있는 것 (main) ──
  {
    id: 'MoneyValue', file: 'src/lib/ui/display.ts', status: 'EXISTS',
    purpose: '금액 문자열 — 자릿수는 값의 크기가 정한다',
    target: '그대로 — 금액 표기는 전부 여기로',
    notes: '`moneyText`. 컴포넌트가 아니라 함수다',
  },
  {
    id: 'PnlValue', file: 'src/lib/ui/display.ts', status: 'EXISTS',
    purpose: '손익 — 부호와 색이 값에서 나온다',
    target: '그대로',
    notes: '`pnlText`. 음수는 하이픈이 아니라 −',
  },
  {
    id: 'DataBadge', file: 'src/components/ui/DataBadge.tsx', status: 'EXISTS',
    purpose: '값이 어디서 왔고 얼마나 오래됐는지',
    target: '그대로',
    notes: '기호로 구분한다 — 색만 쓰지 않는다',
  },
  {
    id: 'SettingField', file: 'src/components/ui/SettingField.tsx', status: 'EXISTS',
    purpose: '설정 한 줄',
    target: '그대로',
    notes: '',
  },
  {
    id: 'Icon', file: 'src/components/ui/Icon.tsx', status: 'EXISTS',
    purpose: '아이콘',
    target: '그대로',
    notes: '',
  },

  // ── 여러 벌인 것 ──
  {
    id: 'Card', file: 'src/components/pages/SharedUI.tsx', status: 'DUPLICATED',
    purpose: '기본 카드',
    target: '`src/components/ui/`의 공통 Card 하나로 (SharedUI에서 옮긴다)',
    notes: 'SharedUI의 `Card`가 있지만 화면마다 인라인 스타일 카드를 따로 만든다. '
      + '**하나로 모을 대상**',
  },
  {
    id: 'Badge', file: 'src/components/pages/SharedUI.tsx', status: 'DUPLICATED',
    purpose: '작은 라벨',
    target: '공통 Badge 하나로 — `Bdg`·`Pill`·`Dot`을 흡수',
    notes: 'SharedUI의 `Bdg`·`Pill`·`Dot`이 겹친다',
  },
  {
    id: 'Button', file: null, status: 'MISSING',
    purpose: '버튼',
    target: '미정 — 몇 종류가 필요한지 먼저 센다 (`button` 결정 참조)',
    notes: '공통 버튼이 없다. 화면마다 인라인 스타일 `<button>`을 만든다. '
      + '누를 수 있는 최소 크기가 화면마다 다르다',
  },
  {
    id: 'Input', file: null, status: 'MISSING',
    purpose: '입력',
    target: '미정 — QuickInput을 일반화할지 새로 만들지',
    notes: '`src/components/inputs/QuickInput.tsx`가 있지만 일부 화면 전용이다',
  },
  {
    id: 'Tabs', file: null, status: 'MISSING',
    purpose: '탭 전환',
    target: '공통 Tabs 하나로',
    notes: '자동매매·지갑·터미널이 각자 탭을 그린다',
  },
  {
    id: 'ValueRow', file: null, status: 'MISSING',
    purpose: '라벨 + 값 한 줄 (모르는 값은 —)',
    target: '공통 ValueRow 하나로 — 모르는 값은 `—`',
    notes: 'MockAutoTrade·WalletPage가 각자 `Row`를 만들었다',
  },
  {
    id: 'EmptyState', file: null, status: 'MISSING',
    purpose: '비어 있음 — **왜 비었는지까지 적는다**',
    target: '공통 EmptyState — WalletPage의 `emptyBox(무엇이, 왜)`를 원형으로',
    notes: 'WalletPage의 `emptyBox`가 그 역할을 한다. 화면 전용이다',
  },
  {
    id: 'LoadingState', file: null, status: 'MISSING',
    purpose: '조회 중',
    target: '공통 LoadingState',
    notes: "'⏳ 로딩 중...' 같은 문자열이 화면마다 흩어져 있다",
  },
  {
    id: 'ErrorState', file: null, status: 'PROPOSED',
    purpose: '막힘',
    target: '미정 — `StatusCard kind="ERROR"`로 덮이는지 먼저 본다',
    notes: '`StatusCard kind="ERROR"`로 덮을 수 있는지 먼저 본다 — '
      + '**컴포넌트를 늘리기 전에 있는 것으로 되는지 확인한다**. '
      + 'ErrorBoundary/PageErrorFallback은 렌더 예외 전용이라 다른 것이다',
  },
  {
    id: 'UnknownState', file: null, status: 'PROPOSED',
    purpose: '못 읽음 (막힌 것이 아니다)',
    target: '미정 — `StatusCard kind="UNKNOWN"`으로 덮이는지 먼저 본다',
    notes: '판정(`unknownSummaryOf`)과 문구(`UNKNOWN_TEXT`·`UNKNOWN_LABEL`)는 '
      + '이미 한 곳에 있다. **없는 것은 그리는 컴포넌트뿐이다** — '
      + '이것을 MISSING이라고 적으면 판정까지 없는 것처럼 읽힌다',
  },

  {
    id: 'Toast', file: 'src/components/notify/NotifyHost.tsx', status: 'DUPLICATED',
    purpose: '잠깐 뜨는 알림',
    target: 'NotifyHost 하나로 — 화면별 toast 문자열을 걷어낸다',
    notes: 'NotifyHost가 있는데 여러 화면이 각자 toast 문자열·표시를 만든다. '
      + 'FEEDBACK 항목과 같은 것을 가리킨다',
  },

  // ── 옛 방식 ──
  {
    id: 'InlineWarningBox', file: null, status: 'LEGACY',
    purpose: '화면마다 직접 만든 경고 박스',
    target: 'StatusCard로 흡수한 뒤 삭제',
    notes: '지갑 한 화면에만 빨강·노랑 색 지정이 23곳 있었다. **StatusCard로 모을 대상**',
  },
  {
    id: 'PrivateFormatter', file: null, status: 'LEGACY',
    purpose: "화면마다 만든 `const fmt = …`",
    target: 'display.ts로 흡수한 뒤 삭제',
    notes: '`toFixed` 144곳 · `toLocaleString` 74곳. **display.ts로 모을 대상**',
  },
];

// ══ 화면 상태별 재고 ══
//
// **상태의 의미와 상태를 그리는 물건은 다른 문제다.**
//
// `status.ts`에 SUCCESS·WARNING·ERROR·UNKNOWN·DISABLED의 *의미*는 한 곳에
// 모았다. 그런데 그 의미를 **실제로 그리는 컴포넌트**가 있는지, 몇 벌
// 있는지는 아직 아무도 세지 않았다. 의미가 한 곳에 있어도 그리는 물건이
// 20곳에 흩어져 있으면 화면은 여전히 제각각이다.
//
// 그래서 상태를 하나씩 놓고 **지금 무엇이 그리고 있고 · 몇 벌이고 ·
// 공통 물건이 있는가**를 센다. 없는 것은 여기에 MISSING으로 남기고
// **이번 단계에서 만들지 않는다.**

export interface UiStateEntry {
  state: UiState;
  /** 지금 이 상태를 그리는 것이 어디에 있는가 */
  existing: string[];
  /** 같은 일을 따로 하는 자리 (여러 벌인 증거) */
  duplicated: string[];
  /**
   * 공통 primitive가 있는가. **없으면 null.**
   *
   * 여기에 그럴듯한 이름을 적어 두면 "있는데 안 쓰는 것"으로 읽히고,
   * 다음 사람은 만드는 대신 찾다가 시간을 쓴다.
   */
  sharedPrimitive: string | null;
  /** 무엇으로 모을 것인가 */
  targetPrimitive: string;
  status: PrimitiveStatus;
  notes: string;
}

export const UI_STATE_INVENTORY: UiStateEntry[] = [
  {
    state: 'LOADING',
    existing: ["'⏳ 로딩 중…' 등 문자열 72곳 / 20개 화면", 'AssetLogo·ChartTab의 자체 자리표시'],
    duplicated: ['화면마다 문구도 위치도 다르다', '스켈레톤과 텍스트가 섞여 있다'],
    sharedPrimitive: null,
    targetPrimitive: 'LoadingState (아직 없음)',
    status: 'MISSING',
    notes: '가장 흔한데 공통 물건이 없다. **조회 중과 비어 있음이 같은 화면으로 보이는 자리가 있다**',
  },
  {
    state: 'EMPTY',
    existing: ['WalletPage `emptyBox(무엇이, 왜)` — 왜 비었는지까지 적는 유일한 자리',
      "'…이 없습니다' 문자열 67곳"],
    duplicated: ['화면마다 직접 만든 안내 박스'],
    sharedPrimitive: null,
    targetPrimitive: 'EmptyState (아직 없음) — WalletPage의 `emptyBox`가 원형',
    status: 'MISSING',
    notes: '**비어 있음과 못 읽음을 같은 문장으로 적으면 안 된다.** '
      + 'emptyBox가 "무엇이 없고 왜 없는지"를 나눠 받는 이유다',
  },
  {
    state: 'SUCCESS',
    existing: ['`StatusCard kind="SUCCESS"`', '`StatusDot`', 'display.ts `tone: good`'],
    duplicated: ['화면마다 초록색을 직접 고른다'],
    sharedPrimitive: 'StatusCard',
    targetPrimitive: 'StatusCard / StatusDot',
    status: 'EXISTS',
    notes: '지갑(#213)만 쓰고 있다. 나머지 화면 이관이 남았다',
  },
  {
    state: 'WARNING',
    existing: ['`StatusCard kind="WARNING"`', '`SafeNote`'],
    duplicated: ['화면마다 만든 노랑 경고 박스 — 지갑 한 화면에만 23곳이었다'],
    sharedPrimitive: 'StatusCard',
    targetPrimitive: 'StatusCard',
    status: 'DUPLICATED',
    notes: '공통 물건은 이미 있다. **남은 일은 만드는 것이 아니라 걷어내는 것이다**',
  },
  {
    state: 'ERROR',
    existing: ['`StatusCard kind="ERROR"`',
      'ErrorBoundary / PageErrorFallback — 렌더 예외 전용이라 다른 것이다'],
    duplicated: ['화면마다 만든 빨강 박스', 'DB 원문을 그대로 띄우던 자리(#213에서 지갑만 정리)'],
    sharedPrimitive: 'StatusCard',
    targetPrimitive: '미정 — ErrorState를 새로 만들지 `StatusCard kind="ERROR"`로 덮을지',
    status: 'PROPOSED',
    notes: '**전부 빨가면 어느 것도 빨갛지 않다.** 막힌 것만 여기 들어온다 — '
      + '못 읽은 것은 UNKNOWN이다',
  },
  {
    state: 'UNKNOWN',
    existing: ['status.ts `unknownSummaryOf`', 'display.ts `UNKNOWN_TEXT`(—) · `UNKNOWN_LABEL`',
      '`StatusCard kind="UNKNOWN"` (회색)'],
    duplicated: ["'확인 불가' 직접 표기 7곳", "'확인하지 못했습니다'·'확인 못 함' 등 표현이 갈림"],
    sharedPrimitive: 'StatusCard',
    targetPrimitive: '미정 — UnknownState를 따로 둘지 `StatusCard kind="UNKNOWN"`으로 덮을지',
    status: 'PROPOSED',
    notes: '**판정과 문구는 이미 한 곳에 있다. 없는 것은 그리는 컴포넌트뿐이다.** '
      + '이것을 MISSING으로 적으면 판정까지 없는 것처럼 읽힌다',
  },
  {
    state: 'DISABLED',
    existing: ['status.ts `STATUS_TONE.DISABLED = muted`',
      '지갑의 모의계좌 미개설 안내(해야 할 일을 알려 주는 자리)'],
    duplicated: ['화면마다 비활성 버튼을 직접 흐리게 만든다 — 공통 Button이 없어서다'],
    sharedPrimitive: 'StatusCard',
    targetPrimitive: 'StatusCard + 공통 Button의 disabled (Button은 아직 없음)',
    status: 'DUPLICATED',
    notes: '**아직 안 켠 것은 고장이 아니다.** 빨간 실패 박스를 띄우면 '
      + '사용자는 자기가 뭘 잘못한 줄 알고 멈춘다',
  },
];

// ══ 겹쳐 뜨는 층 ══

export interface Overlay {
  id: string;
  file: string | null;
  status: PrimitiveStatus;
  purpose: string;
  notes: string;
}

export const OVERLAYS: Overlay[] = [
  { id: 'AssetDetailModal', file: 'src/components/AssetDetailModal.tsx', status: 'EXISTS',
    purpose: '자산 상세', notes: '' },
  { id: 'NewsDetailModal', file: 'src/components/NewsDetailModal.tsx', status: 'EXISTS',
    purpose: '뉴스 상세', notes: '' },
  { id: 'TradeReplayModal', file: 'src/components/TradeReplayModal.tsx', status: 'EXISTS',
    purpose: '매매 복기', notes: '' },
  { id: 'LoginModal', file: 'src/components/LoginModal.tsx', status: 'EXISTS',
    purpose: '로그인', notes: '' },
  { id: 'ConfirmHost', file: 'src/components/ConfirmHost.tsx', status: 'EXISTS',
    purpose: '확인 대화상자',
    notes: '**실전 주문 전 재확인이 여기를 지난다.** 환경별 문구가 다른지 확인 필요' },
  { id: 'BottomSheet', file: 'src/components/terminal/BottomSheet.tsx', status: 'DUPLICATED',
    purpose: '모바일 시트',
    notes: '**하위 폴더에 있어서 처음 등록할 때 위치를 틀리게 적었다.** '
      + '`src/lib/ui/mobileSheet.ts`(높이·키보드 판정)를 컴포넌트로 착각했다 — '
      + '재귀 탐색을 붙이고 나서야 드러났다. 판정은 lib에, 그리기는 여기에 있고, '
      + '터미널 밖 화면들은 이것을 쓰지 않고 각자 시트를 그린다' },
  { id: 'ConfirmDialog', file: 'src/lib/confirm/dialog.ts', status: 'EXISTS',
    purpose: '`confirm()` 대체 — Promise로 답을 기다리는 전역 확인',
    notes: 'ConfirmHost가 이것을 그린다. 판정과 그리기가 나뉜 형태' },
  { id: 'OverlayStack', file: 'src/lib/nav/overlayStack.ts', status: 'EXISTS',
    purpose: '겹침 순서와 뒤로가기',
    notes: '판정만 있다. 그리는 컴포넌트는 없다' },
];

// ══ 피드백 ══

export interface Feedback {
  id: string;
  file: string | null;
  status: PrimitiveStatus;
  purpose: string;
  notes: string;
}

export const FEEDBACK: Feedback[] = [
  { id: 'Toast', file: 'src/components/notify/NotifyHost.tsx', status: 'EXISTS',
    purpose: '잠깐 뜨는 알림',
    notes: '여러 화면이 각자 toast 문자열을 만든다' },
  { id: 'Notice', file: 'src/lib/ui/display.ts', status: 'EXISTS',
    purpose: '알림 한 건 — 짧은 첫 줄 + 접는 상세',
    notes: '`noticeOf`·`splitNotice`·`topNotice`' },
  { id: 'Diagnostics', file: 'src/components/ui/Status.tsx', status: 'EXISTS',
    purpose: '개발자용 원문',
    notes: '#213. `splitDiagnostics`가 본문에서 떼어 낸다' },
];

// ══ 지금 무엇이 있고, 무엇으로 통일할 것인가 ══
//
// **Inventory가 설계안만 적는 문서가 되면 안 된다.**
//
// "지금 무엇이 있는가"와 "무엇으로 통일할까"는 다른 사실이고, 후자는
// 아직 안 정해진 것도 있다. 셋을 한 칸에 적으면 아직 안 정한 것이
// 결정된 것처럼 읽히고, 다음 사람이 그걸 근거로 코드를 바꾼다.

export type DecisionState =
  /** 정했고, 그대로 간다 */
  | 'DECIDED'
  /** 아직 안 정했다. **비워 두지 않고 안 정했다고 적는다** */
  | 'OPEN'
  /** 정했고 이미 그렇게 됐다 */
  | 'DONE';

export interface Convergence {
  id: string;
  /** 지금 실제로 어떤가 */
  current: string;
  /**
   * **이것이 정본(canonical)인가.**
   *
   * 장부처럼 "무엇이 진짜인가"가 걸린 항목에서만 쓴다. 자유문장 메모로
   * 두면 다음 사람이 못 읽고, 두 장부를 같은 것으로 취급한다.
   * 해당 없으면 null.
   */
  canonical: string | null;
  /**
   * **섞이면 안 되는 것.**
   *
   * 최상위 규칙: MOCK / TESTNET / LIVE의 장부와 자산을 절대 합산하지
   * 않는다. 그 규칙이 이 항목에 어떻게 적용되는지 여기에 적는다.
   * 해당 없으면 null.
   */
  isolation: string | null;
  /** 무엇으로 모을 것인가 */
  target: string;
  decision: DecisionState;
  /** 왜 그렇게 정했나 / 왜 아직 못 정했나 */
  why: string;
}

export const CONVERGENCE: Convergence[] = [
  {
    id: 'warning-box',
    current: '화면마다 직접 만든 경고 박스. 지갑 한 화면에만 빨강·노랑 색 지정 23곳',
    canonical: null,
    isolation: null,
    target: 'StatusCard (짧은 첫 줄 + 접히는 상세)',
    decision: 'DECIDED',
    why: '전부 빨가면 어느 것도 빨갛지 않은 것과 같다. 막힌 것만 빨갛게 한다',
  },
  {
    id: 'number-format',
    current: '`toFixed` 144곳 · `toLocaleString` 74곳 · 사설 포매터 8개',
    canonical: null,
    isolation: null,
    target: 'display.ts (자릿수는 값의 크기가 정한다)',
    decision: 'DECIDED',
    why: '8자리 고정이 잔고 0을 `0.00000000`으로 만들었다. 2자리 고정은 반대로 '
      + '작은 코인 수량을 전부 `0.00`으로 만든다',
  },
  {
    id: 'unknown-text',
    current: "'확인 불가' 직접 표기 7곳 + '확인하지 못했습니다'·'확인 못 함' 등 표현이 갈림",
    canonical: null,
    isolation: null,
    target: 'UNKNOWN_LABEL / UNKNOWN_TEXT 한 곳',
    decision: 'DECIDED',
    why: '문구가 바뀌면 한 곳만 고친다',
  },
  {
    id: 'nav-source',
    current: '화면 목록이 세 곳(MENU 30 · BTABS 5 · MTABS 53)에 따로 있다',
    canonical: null,
    isolation: null,
    target: '미정 — 한 곳으로 모을지, 셋을 두고 대조 검사만 둘지',
    decision: 'OPEN',
    why: '하단 탭·더보기·검색 메뉴는 **용도가 다르다.** 기계적으로 합치면 '
      + '하단 탭에 53개가 들어가거나 더보기가 5개로 준다. '
      + '지금은 대조 검사(`check-ui-inventory.mjs`)로 누락만 막는다',
  },
  {
    id: 'trading-local-ledger',
    current: 'TradingPage(`tab:trading`)의 수동 연습 매매가 **브라우저 로컬 '
      + '원화(KRW) 연습 장부**를 쓴다. 잔고·보유·체결이 `localStorage`에 있고, '
      + '체결도 브라우저가 판정한다. 서버에 기록되지 않는다',
    canonical: '**아니다.** 정본 모의 장부는 서버 PAPER(`paper_accounts` · '
      + '`paper_positions`, USDT)뿐이다. 로컬 원화 장부는 정본이 아니며 '
      + '어떤 성과 지표·순위·통계의 근거로도 쓰지 않는다',
    isolation: '**정본 PAPER의 잔고·손익과 합산하지 않고, 대체하지도 않는다.** '
      + '두 장부를 더한 숫자를 어느 화면에도 만들지 않는다. '
      + '통화 단위가 다르므로(KRW vs USDT) 환산해서 합치는 것도 금지한다',
    target: '미정 — ① 별도 연습 모드로 남기되 화면에서 정본 PAPER와 완전히 '
      + '분리해 표시 ② 서버 PAPER로 통합',
    decision: 'OPEN',
    why: '통화(원화 vs USDT)·체결 방식·TP/SL 규칙이 서버 PAPER와 다르다. '
      + '흡수하면 성과 데이터가 오염되고, 남기면 두 모의계좌라는 오해가 남는다. '
      + '**Trading 이관 때 정한다. 이번 단계에서는 기록만 하고 바꾸지 않는다**',
  },
  {
    id: 'terminal-order-path',
    current: '터미널(`/terminal`)은 실전·테스트넷 주문을 직접 낸다. '
      + '연습 장부가 없고, 상태 표시는 화면 안에서 직접 만든 박스다',
    canonical: '주문·체결의 정본은 거래소와 서버 기록이다. '
      + '화면이 자체 장부를 갖지 않는다 — TradingPage와 다른 점이다',
    isolation: '**LIVE와 TESTNET을 한 숫자로 합치지 않는다.** '
      + '주문 버튼 옆의 환경 표시는 색만이 아니라 글자로도 구분한다',
    target: '미정 — 상태 표현만 StatusCard/EnvBadge로 옮길지, '
      + '주문 패널 구조까지 함께 볼지',
    decision: 'OPEN',
    why: '**주문 경로는 이번 UI 작업의 범위 밖이다.** 표시 계층 이관과 '
      + '주문 흐름 변경을 한 PR에 섞으면, 화면이 바뀐 것인지 주문이 바뀐 것인지 '
      + '나중에 구분할 수 없다. Trading 결정 뒤에 따로 본다',
  },
  {
    id: 'button',
    current: '공통 버튼이 없다. 화면마다 인라인 스타일 `<button>`',
    canonical: null,
    isolation: null,
    target: '미정 — 공통 Button 하나로 갈지, primary/danger 등 몇 종류를 둘지. '
      + '실전 주문 버튼을 별도로 둘지도 아직 안 정했다',
    decision: 'OPEN',
    why: '먼저 실제로 몇 종류가 필요한지 세야 한다. 세지 않고 만들면 '
      + '**쓰이지 않는 variant가 생기고, 화면은 여전히 인라인으로 만든다**',
  },
  {
    id: 'date-time',
    current: '`toLocaleString(\'ko-KR\', …)`을 화면마다 다르게 부른다',
    canonical: null,
    isolation: null,
    target: '미정 — display.ts에 date/time kind를 더할지',
    decision: 'OPEN',
    why: '숫자와 달리 "언제인가"는 화면마다 필요한 정밀도가 진짜로 다르다. '
      + '먼저 몇 가지 형태가 실제로 쓰이는지 센다',
  },
  {
    id: 'paper-single-ledger',
    current: '서버 PAPER 하나가 모의 장부다. 브라우저는 체결하지도 청산하지도 않는다',
    canonical: null,
    isolation: null,
    target: '같음',
    decision: 'DONE',
    why: '5A(#210)에서 끝났다. `check-mock-single-source.mjs`가 잠근다',
  },
  {
    id: 'env-wording',
    current: '실전·테스트넷·모의 문구가 ENV_VIEW 한 곳에서 나온다',
    canonical: null,
    isolation: null,
    target: '같음',
    decision: 'DONE',
    why: '예전에는 `portfolio/wallet.ts`와 `ui/autoOverview.ts`에 두 벌이었고 '
      + "한쪽에만 'live' 색조가 있었다",
  },
];

// ══ 이 Inventory가 지키는 의미 ══
//
// 검사가 이 목록을 읽어 "구분이 사라지지 않았는가"를 본다.
// **구분이 사라지는 것은 코드가 깨지는 것보다 조용하다.**

export interface SemanticRule {
  id: string;
  rule: string;
  why: string;
}

export const SEMANTICS: SemanticRule[] = [
  {
    id: 'unknown-vs-error',
    rule: 'UNKNOWN ≠ ERROR',
    why: '못 읽은 것과 막힌 것은 사용자에게 전혀 다른 행동을 요구한다. '
      + '모름을 빨갛게 그리면 진짜 막힌 빨강과 구별되지 않는다',
  },
  {
    id: 'disabled-vs-error',
    rule: 'DISABLED ≠ ERROR',
    why: '아직 안 켠 것은 고장이 아니다. 모의계좌를 안 만든 사용자에게 빨간 '
      + '실패 박스를 띄우면, 자기가 뭘 잘못한 줄 알고 멈춘다. '
      + '해야 할 일(시작하기)을 알려 주는 자리다',
  },
  {
    id: 'no-account-vs-unreadable',
    rule: 'NO_ACCOUNT ≠ UNREADABLE',
    why: '계좌가 없는 것과 계좌를 못 읽은 것은 다르다. '
      + '스크린샷에서 `0.00000000 USDT`와 "계좌가 없습니다"가 동시에 떠 있었다',
  },
  {
    id: 'ready-zero-vs-no-account',
    rule: 'READY(balance=0) ≠ NO_ACCOUNT',
    why: '잔고 0은 정상이다. 실패로 그리지 않는다',
  },
  {
    id: 'env-separation',
    rule: 'LIVE ≠ TESTNET ≠ PAPER',
    why: '색만 다르면 실전 화면과 테스트넷 화면을 헷갈린 채로 주문을 누른다. '
      + '색과 글자 둘 다 달라야 한다. **장부와 자산은 절대 합산하지 않는다**',
  },
  {
    id: 'user-vs-diagnostics',
    rule: '사용자 상태 ≠ 개발자 진단',
    why: '`column paper_accounts.started_at does not exist`가 메인 화면 빨간 '
      + '박스에 그대로 떴었다. 사용자는 읽을 이유가 없고, 읽어도 할 수 있는 일이 없다. '
      + '**원문을 버리지는 않는다** — 접어서 진단으로 옮긴다',
  },
];

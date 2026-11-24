// scripts/lib/research-assumptions.mjs
//
// **연구 가정값의 이름을 한 곳에 둔다.**
//
// 이 목록은 두 검사기가 쓴다:
//
//   · `check-research-isolation.mjs` — 실행 경로가 연구 모듈·가정값을
//     읽는지 본다 (가정값이 실제 주문 크기를 정하는 것을 막는다)
//   · `check-research-kernel.mjs`    — 연구와 실행이 **함께 쓰는 커널**에
//     가정값이 들어오는지 본다 (커널은 양쪽이 믿는 바닥이다)
//
// 두 곳에 같은 배열을 적으면 언젠가 한쪽에만 이름이 추가되고, 그때
// 추가되지 않은 쪽은 **막는 것처럼 보이면서 아무것도 막지 않는다**
// (`CLAUDE.md`: 같은 판단이 두 곳에 있으면 언젠가 갈린다).

/** 연구·시뮬레이션 전용 모듈. 실행이 읽으면 안 된다 */
export const RESEARCH_MODULES = [
  'simModel', 'profileMonteCarlo', 'profileSim', 'monteCarlo', 'edgeSweep',
];

/** 가정값의 이름들 — 잰 값이 아니라 넣은 값이다 */
export const ASSUMPTION_NAMES = [
  { needle: 'edgePp', why: '몬테카를로에서 승률을 임의로 올려 넣는 가정값입니다' },
  { needle: 'assumedWinRate', why: '가정한 승률입니다 — 실제로 잰 값이 아닙니다' },
  { needle: 'assumedEdge', why: '가정한 우위입니다 — 실행이 읽으면 안 됩니다' },
  { needle: 'AssumedEdge', why: '가정 우위 타입입니다 — 실행 경로에 오면 안 됩니다' },
];

/**
 * 실제 돈이 움직이는 경로의 뿌리.
 *
 * `check-research-isolation.mjs`의 `EXECUTION_GLOBS`와 같은 집합을
 * 가리킨다 — 그쪽은 파일을 모으기 위한 glob이고, 이쪽은 **경로가 그
 * 안에 드는지 판정**하기 위한 접두어다. 커널이 이 중 하나라도 읽으면
 * "양쪽이 믿는 바닥"이 아니라 실행 경로의 일부가 된다.
 */
export const EXECUTION_ROOTS = [
  'src/app/api/autotrade/',
  'src/app/api/binance/',
  'src/app/api/gate/',
  'src/app/api/orders/',
  'src/lib/engine/',
  'src/lib/exchanges/',
  'src/lib/risk/',
  'worker/src/',
];

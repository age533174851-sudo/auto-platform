// scripts/check-wiring.mjs
//
// **만들어 놓고 배선을 안 하는 것을 CI가 잡는다.**
//
// 이 저장소에서 가장 자주 난 고장이 이것이다. 실제로 있었던 것들:
//
//   · conviction.ts        판정 넷을 만들고 테스트까지 붙였는데
//                          저장소 전체에서 부르는 곳이 0곳이었다
//   · sleeveGate           전략 계좌를 멈추는 판정인데 아무도 안 불렀다.
//                          그래서 낙폭 정지가 한 번도 안 걸렸다
//   · applyRealized        손익을 적는 함수인데 안 불려서
//                          realized_pnl이 영영 0이었다
//   · reconcileSleeves     장부와 거래소가 어긋난 것을 찾는 판정인데
//                          어긋나도 아무도 안 봤다
//   · dataQuality.ts       이건 반대다 — 안 쓰인다고 내가 잘못 말했다.
//                          .ts만 찾고 .tsx를 빼먹었기 때문이다
//
// 마지막 것이 이 스크립트가 필요한 진짜 이유다. **손으로 세면 틀린다.**
// 정적 import, 동적 import, .ts와 .tsx, 재수출을 전부 봐야 하는데
// 한 번이라도 빠뜨리면 멀쩡한 모듈을 죽었다고 하거나 죽은 모듈을
// 살았다고 한다. 둘 다 나쁘다.
//
// 무엇을 검사하는가
// ─────────────────
// **판정 모듈만 본다.** lib/engine · lib/risk · lib/strategies ·
// lib/markets의 순수 판정 파일이 대상이다. 화면 컴포넌트나 라우트는
// 스스로가 종점이라 '소비자'라는 개념이 없다.
//
// 그리고 **파일 단위로 본다.** 함수 하나하나까지 세면 헬퍼·타입 가드까지
// 걸려서 소음이 된다. 파일이 통째로 안 불리는 것이 실제 고장이다.
//
// 규칙 하나: **새로 만든 파일은 기본으로 통과시키지 않는다.** 배선이
// 아직이면 ALLOW에 사유와 함께 적는다 — 그러면 그 목록 자체가
// "아직 안 붙인 것" 목록이 된다.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

/** 판정 모듈이 사는 곳 */
const WATCH_DIRS = [
  'src/lib/engine', 'src/lib/risk', 'src/lib/strategies', 'src/lib/markets',
  'src/lib/exchanges', 'src/lib/auth', 'src/lib/terminal', 'src/lib/ui', 'src/lib/nav',
];

/** 어디서든 부를 수 있는 곳 — 여기 전부를 소비자로 본다 */
const SEARCH_DIRS = ['src', 'scripts'];

/**
 * 아직 안 붙였지만 그럴 만한 이유가 있는 것.
 *
 * **비워 두는 것이 목표다.** 여기 적는 순간 그건 "언젠가 붙일 것"이라는
 * 약속이고, 약속이 쌓이면 이 검사는 없는 것과 같아진다.
 */
const ALLOW = new Map([
  // ── 이 검사를 처음 켰을 때 이미 끊겨 있던 것들 ──
  //
  // **이 목록은 갚아야 할 빚이다.** 여기 있는 동안 그 판정은
  // "만들어 놓고 안 부르는" 상태이고, 화면에는 아무 영향도 없다.
  // 하나씩 배선하면서 지워 나가야 한다.

  ['src/lib/strategies/wedomDiscipline.ts',
    '웨돔 규율 게이트 — 진입 조건이 아니라 안 하는 규칙. 자동매매 경로에 붙일 자리가 정해지면 배선'],
  ['src/lib/markets/proxyAsset.ts',
    '24시간 거래되지만 기초자산은 아닌 종목(금·원유 ETF 등) 판정. 해외주식 주문 경로에 붙일 것'],

  // ── 이번에 만들었고 아직 화면이 없는 것들 ──
  //
  // 판정만 먼저 만들고 실행기·화면을 뒤에 붙이는 순서를 택했다.
  // 통계 정의가 틀린 채로 대량 판정하면 틀린 기준으로 수백 개를
  // 판정하게 되기 때문이다(#87에서 그 예를 실제로 봤다).

  ['src/lib/strategies/robustness.ts',
    '전략 견고성 등급. 격자 실행기가 붙으면 그때 소비자가 생긴다'],
  ['src/lib/strategies/costAnalysis.ts',
    '비용 전/후 기대값 분리. 위와 같은 실행기에서 함께 쓴다'],
  ['src/lib/markets/quantityInput.ts',
    '수량 단위 변환. 주문판 재배치 PR에서 배선한다'],
]);

const files = [];
for (const dir of WATCH_DIRS) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isFile()) continue;
    if (!name.endsWith('.ts')) continue;          // .tsx는 화면이라 제외
    if (name.endsWith('.test.ts')) continue;      // 테스트 자체는 대상이 아니다
    if (name.endsWith('.d.ts')) continue;
    files.push(p);
  }
}

if (files.length === 0) {
  console.error('\n❌ 검사할 판정 모듈을 하나도 못 찾았습니다 — 디렉터리 구조가 바뀌었다면 이 스크립트도 같이 고쳐야 합니다\n');
  process.exit(1);
}

/** src·scripts 아래 모든 소스를 한 번만 읽는다 */
const sources = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx|mjs|js)$/.test(name)) continue;
    sources.push({ path: p, text: readFileSync(p, 'utf8') });
  }
}
for (const d of SEARCH_DIRS) walk(d);

const orphans = [];
const stale = [];

for (const file of files) {
  const stem = basename(file).replace(/\.ts$/, '');
  // **정적·동적 import를 함께 본다.** 이 저장소는 라우트에서 동적
  // import를 많이 쓴다 — 그것만 빼먹으면 멀쩡한 모듈이 죽은 것으로
  // 보인다(내가 실제로 한 번 그렇게 틀렸다).
  //
  // 따옴표 안에서 이 파일 이름으로 끝나는 경로를 찾는다:
  //   from './foo'  ·  from '@/lib/engine/foo'  ·  import('./foo')
  const re = new RegExp(`['"\`][^'"\`]*/${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);

  let consumers = 0;
  for (const s of sources) {
    if (s.path === file) continue;                     // 자기 자신
    if (s.path === file.replace(/\.ts$/, '.test.ts')) continue;   // 자기 테스트
    if (re.test(s.text)) consumers++;
  }

  const allowed = ALLOW.has(file);
  if (consumers === 0 && !allowed) orphans.push(file);
  if (consumers > 0 && allowed) stale.push(file);
}

let bad = false;

if (orphans.length > 0) {
  console.error('\n❌ 만들어 놓고 부르는 곳이 없는 판정 모듈:');
  for (const f of orphans) console.error(`   · ${f}`);
  console.error('\n   판정을 만들어 놓고 안 부르면, 그 검사는 켜져 있는 것처럼');
  console.error('   보이면서 아무것도 안 합니다. 이 저장소에서 가장 자주 난 고장입니다.');
  console.error('\n   셋 중 하나를 하세요:');
  console.error('     1. 실제로 부르는 곳에 배선한다');
  console.error('     2. 아직이면 scripts/check-wiring.mjs의 ALLOW에 사유와 함께 적는다');
  console.error('     3. 쓸 데가 없으면 지운다');
  bad = true;
}

if (stale.length > 0) {
  console.error('\n⚠ ALLOW에 적혀 있는데 이미 배선된 모듈:');
  for (const f of stale) console.error(`   · ${f} — ${ALLOW.get(f)}`);
  console.error('\n   ALLOW에서 지우세요. 면제 목록이 낡으면 다음에 진짜로 끊긴 것을 덮습니다.');
  bad = true;
}

if (bad) process.exit(1);

console.log(`✅ 판정 모듈 ${files.length}개 · 배선 안 된 것 0개`
  + (ALLOW.size > 0 ? ` (면제 ${ALLOW.size}개)` : ''));

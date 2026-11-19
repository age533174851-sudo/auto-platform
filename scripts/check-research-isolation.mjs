#!/usr/bin/env node
// scripts/check-research-isolation.mjs
//
// **연구 가정이 실행 경로에 새는 것을 막는다.**
//
// `edgePp`는 몬테카를로에서 승률을 임의로 올려 넣는 **가정값**이다.
// 무우위 승률이 33%일 때 `+10%p`를 넣으면 43%라고 치고 돌린다. 결과가
// 좋아지는 건 당연하다 — 그건 전략이 우위를 가졌다는 뜻이 아니라
// **계산기에 유리한 값을 넣은 것**이다.
//
// 지금은 실행 경로가 이 값을 읽지 않는다(확인함). 이 검사는 **앞으로도
// 그렇게 두기 위한 것**이다. 언젠가 누군가 "시뮬과 같은 함수를 쓰면
// 편하겠는데"라고 생각하는 순간, 가정값이 실제 주문 크기를 정하게 된다.
//
// 그리고 연구와 실행은 서로 꺼도 돌아야 한다
// ──────────────────────────────────────────
// 연구는 좋은 전략을 찾는 공장이고, 운용은 검증된 전략을 돌리는 공장이다.
// **연구 코드 한 곳이 깨졌다고 실제 돈 굴리는 엔진이 같이 멈추면 안 된다.**
// 그래서 실행 경로가 연구 모듈을 import 하는 것 자체를 막는다.
import { readFileSync, globSync, readdirSync, existsSync } from 'node:fs';

/** 실제 돈이 움직이는 경로 */
const EXECUTION_GLOBS = [
  'src/app/api/autotrade/**/*.ts',
  'src/app/api/binance/**/*.ts',
  'src/app/api/gate/**/*.ts',
  'src/app/api/orders/**/*.ts',
  'src/lib/engine/**/*.ts',
  'src/lib/exchanges/**/*.ts',
  'src/lib/risk/**/*.ts',
  'worker/src/**/*.ts',
];

// 이름 목록은 `scripts/lib/research-assumptions.mjs` 한 곳에 있다.
// `check-research-kernel.mjs`가 같은 목록으로 **커널**을 본다 — 두 곳에
// 적어 두면 언젠가 한쪽에만 이름이 추가되고, 추가되지 않은 쪽은 막는
// 것처럼 보이면서 아무것도 막지 않는다(`CLAUDE.md`).
import { RESEARCH_MODULES, ASSUMPTION_NAMES } from './lib/research-assumptions.mjs';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };

const files = EXECUTION_GLOBS.flatMap(g => {
  try { return globSync(g); } catch { return []; }
}).map(f => f.replaceAll('\\', '/')).filter(f => !f.endsWith('.test.ts'));

if (files.length === 0) {
  err('실행 경로 파일을 하나도 찾지 못했습니다 — 이 검사가 고장 났습니다');
}

for (const f of files) {
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch { err(`${f}를 읽지 못했습니다`); continue; }

  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    // 주석은 검사하지 않는다 — 왜 안 쓰는지 설명하려면 이름을 적어야 한다.
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;

    for (const m of RESEARCH_MODULES) {
      if (new RegExp(`from\\s+['"][^'"]*${m}['"]`).test(line)
        || new RegExp(`import\\(['"][^'"]*${m}['"]\\)`).test(line)) {
        err(`${f}:${i + 1}\n     실행 경로가 연구 모듈(${m})을 불러옵니다`
          + '\n     연구가 깨지면 실제 매매까지 같이 멈춥니다 — 두 런타임은 서로 독립이어야 합니다'
          + `\n     ${t.slice(0, 110)}`);
      }
    }
    for (const a of ASSUMPTION_NAMES) {
      if (new RegExp(`\\b${a.needle}\\b`).test(line)) {
        err(`${f}:${i + 1}\n     실행 경로에 ${a.needle}가 있습니다 — ${a.why}`
          + '\n     실제 우위는 비용을 뺀 뒤 OOS/워크포워드로 잰 값만 씁니다 (edgeTypes.ts)'
          + `\n     ${t.slice(0, 110)}`);
      }
    }
  });
}

// 반대 방향도 본다: 실제 전략 카드가 가정값을 우위로 그리고 있지 않은가.
{
  const ui = globSync('src/components/**/*.tsx').map(f => f.replaceAll('\\', '/'));
  for (const f of ui) {
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) return;
      // `우위 +N%p`처럼 가정값을 우위로 부르는 라벨을 막는다.
      if (/['"`]\s*우위\s*\+/.test(line)) {
        err(`${f}:${i + 1}\n     가정값을 '우위'라고 부르고 있습니다 — '가정'이라고 적으세요`
          + `\n     ${t.slice(0, 110)}`);
      }
    });
  }
}

// ── 돈을 보여 주는 화면에 연구 도구를 두지 않는다 ──
//
// 지갑은 돈만 보여야 한다: 총자산 → 계좌 → 현물/선물 → 포지션 → 손익 →
// 입출금 → 수수료/펀딩 → 자산곡선 → 전략별 귀속.
//
// 전략 설정·몬테카를로·가정 승률이 그 옆에 있으면 사용자는 **가정으로
// 만든 수익 곡선을 자기 계좌의 미래로 읽는다.** 계산이 맞아도 화면이
// 사용자를 헷갈리게 하면 미완성이다.
const MONEY_SCREENS = [
  'src/components/pages/WalletPage.tsx',
  'src/components/pages/PortfolioPage.tsx',
];
const RESEARCH_PANELS = ['StrategyProfilesPanel', 'MonteCarlo', 'monteCarlo', 'assumedWinRate', 'edgePp'];
for (const f of MONEY_SCREENS) {
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch { continue; }
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) return;
    for (const p of RESEARCH_PANELS) {
      if (new RegExp(`\\b${p}\\b`).test(line)) {
        err(`${f}:${i + 1}\n     돈을 보여 주는 화면에 연구 도구(${p})가 있습니다`
          + '\n     지갑은 자산·계좌·손익·장부·입출금·성과만 담당합니다'
          + `\n     ${t.slice(0, 110)}`);
      }
    }
  });
}

// ── 연구 모듈이 **등록돼 있는가** ──
//
// 위 검사는 `RESEARCH_MODULES` 에 적힌 이름만 막는다. 그래서 **새 연구
// 모듈을 만들고 그 목록에 적지 않으면 아무것도 막지 않는다** — 실행
// 경로가 그것을 import 해도 이 검사는 조용히 통과한다. 목록이 손으로
// 적는 것인 동안 그 구멍은 계속 열려 있다.
//
// `src/lib/research/` 는 연구 전용 디렉터리다. 거기 있는 파일은 **전부**
// 그 목록에 있어야 한다. 이름이 없으면 실패다.
//
// 왜 `check-wiring.mjs` 의 `WATCH_DIRS` 에 넣지 않는가: 연구 모듈은
// **제품 소비자가 0곳인 것이 정상이다**(실행이 읽으면 안 되니까). 그쪽
// 검사에 넣으면 영구 면제 항목이 되고, 면제 목록이 커지면 그 검사가
// 죽는다. 연구 모듈의 보증은 "아무도 안 부른다"가 아니라 **"실행이 못
// 부른다"** 이고, 그것을 보는 곳이 여기다.
const RESEARCH_DIR = 'src/lib/research';
if (existsSync(RESEARCH_DIR)) {
  const names = readdirSync(RESEARCH_DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map(f => f.replace(/\.ts$/, ''))
    .sort();
  // 디렉터리가 있는데 파일이 0개면 **통과가 아니다.** 0개를 보고 초록을
  // 켜는 검사는 막는 것처럼 보이면서 아무것도 막지 않는다.
  if (names.length === 0) {
    err(`${RESEARCH_DIR}/ 에 연구 모듈이 하나도 없습니다 — 디렉터리를 지웠다면 이 규칙도 같이 지우세요`);
  }
  for (const n of names) {
    if (!RESEARCH_MODULES.includes(n)) {
      err(`${RESEARCH_DIR}/${n}.ts 가 RESEARCH_MODULES 에 없습니다`
        + '\n     등록하지 않으면 실행 경로가 이것을 import 해도 이 검사가 통과합니다'
        + '\n     scripts/lib/research-assumptions.mjs 의 RESEARCH_MODULES 에 '
        + `'${n}' 을 추가하세요`);
    }
  }
  if (bad === 0) {
    console.log(`✅ 연구 모듈 ${names.length}개 전부 RESEARCH_MODULES 에 등록돼 있습니다`);
  }
}

if (bad === 0) {
  console.log(`✅ 실행 경로 ${files.length}개 · 연구 모듈 유입 0건 · 가정값 유입 0건 · 돈 화면 오염 0건`);
} else {
  console.error('');
  console.error('   연구는 좋은 전략을 찾는 공장이고, 운용은 검증된 전략을 돌리는 공장입니다.');
  console.error('   둘은 24시간 같이 돌 수 있지만 서로 의존해서는 안 됩니다.');
}
process.exit(bad ? 1 : 0);

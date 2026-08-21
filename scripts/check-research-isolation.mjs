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
import { readFileSync, globSync } from 'node:fs';

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

/** 연구·시뮬레이션 전용. 실행이 읽으면 안 된다 */
const RESEARCH_MODULES = [
  'simModel', 'profileMonteCarlo', 'profileSim', 'monteCarlo', 'edgeSweep',
];

/** 가정값의 이름들 */
const ASSUMPTION_NAMES = [
  { needle: 'edgePp', why: '몬테카를로에서 승률을 임의로 올려 넣는 가정값입니다' },
  { needle: 'assumedWinRate', why: '가정한 승률입니다 — 실제로 잰 값이 아닙니다' },
  { needle: 'assumedEdge', why: '가정한 우위입니다 — 실행이 읽으면 안 됩니다' },
  { needle: 'AssumedEdge', why: '가정 우위 타입입니다 — 실행 경로에 오면 안 됩니다' },
];

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

if (bad === 0) {
  console.log(`✅ 실행 경로 ${files.length}개 · 연구 모듈 유입 0건 · 가정값 유입 0건 · 돈 화면 오염 0건`);
} else {
  console.error('');
  console.error('   연구는 좋은 전략을 찾는 공장이고, 운용은 검증된 전략을 돌리는 공장입니다.');
  console.error('   둘은 24시간 같이 돌 수 있지만 서로 의존해서는 안 됩니다.');
}
process.exit(bad ? 1 : 0);

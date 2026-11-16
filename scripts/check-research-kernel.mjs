#!/usr/bin/env node
// scripts/check-research-kernel.mjs
//
// **연구와 실행이 함께 믿는 바닥을 하나로 두고, 그 바닥이 어느 쪽도
// 끌고 오지 않게 한다.**
//
// 왜 필요한가
// ───────────
// 연구 엔진은 배율을 5·10·25·50으로 바꿔 가며 돌려야 한다. 그런데
// 그 숫자가 `resolveExecutionProfile`을 지나면 실행 계약
// (`EXECUTION_CONTRACT_VERSION` · `OPEN_COMBOS` · 마이그레이션 `080`)이
// 따라 움직이고, 저장된 예약이 `VERSION_MISMATCH`로 막힌다. 연구 때문에
// 운영 계약을 건드리는 것은 뒤집힌 순서다.
//
// 그래서 연구는 실행 계약을 지나지 않는다. **그런데 "지나지 않는다"를
// 우회로 풀면 수수료·수량 규격·청산 거리 계산이 두 벌이 된다** — 그러면
// 백테스트가 통과시킨 수량이 실제로는 거래소에서 거부되고, 연구가 "살아
// 남는다"고 적은 배율이 실행에서는 청산된다. 저장소에서 가장 자주 난
// 고장 그대로다(`CLAUDE.md`: 경로가 둘인데 한쪽만 고침).
//
// 답은 우회가 아니라 **분리**다. 양쪽이 쓰는 순수 계산을
// `src/lib/kernel/`에 두고, 연구도 실행도 **같은 파일**을 컴파일한다.
//
// 이 검사가 세는 것
// ─────────────────
//   ① 커널에 재사용 대상이 실제로 있는가 (수량 규격 · 청산 거리)
//   ② 커널이 실행 경로를 import 하지 않는가 — 하면 바닥이 아니라
//      실행의 일부다
//   ③ 커널이 I/O를 하지 않는가 — DB·거래소를 읽으면 연구가 돌 때마다
//      운영 자원을 쓴다
//   ④ 커널에 연구 가정값이 없는가 — 가정값이 바닥에 있으면 실행이
//      그것을 믿게 된다 (`check-research-isolation.mjs`가 막으려는 것)
//   ⑤ 옛 경로가 **재수출 껍데기**인가 — 구현이 두 벌로 남으면 분리가
//      아니라 복제다
//
// **기존 `check-research-isolation.mjs`는 그대로 둔다.** 그쪽은 "실행이
// 연구를 읽지 않는다"를 보고, 이쪽은 "바닥이 양쪽 어디도 읽지 않는다"를
// 본다. 방향이 다르므로 둘 다 필요하다.
import { readFileSync, existsSync, globSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import {
  ASSUMPTION_NAMES, EXECUTION_ROOTS,
} from './lib/research-assumptions.mjs';

const KERNEL_DIR = 'src/lib/kernel';

/**
 * 커널에 있어야 하는 재사용 대상.
 *
 * 사장님 지시(2026-11-04): "공통 위험 계산·수량 검증·청산 거리 검증 중
 * **재사용할 부분을 먼저 분리해**." 그중 **의존이 이미 깨끗한 둘**을
 * 먼저 옮긴다 — `quantize`는 import가 0개였고,
 * `liquidationDistance`는 `src/lib/safety/`(실행 경로 밖) 하나뿐이었다.
 *
 * 위험 계산(`riskManager.planPosition`)은 아직 여기 없다. `signalGateway`의
 * `StandardSignal`·`BUCKET_RISK`를 끌고 오는데 그건 실행 경로라, 먼저
 * 그 타입을 떼어내야 한다. **못 옮긴 것을 옮긴 것으로 적지 않는다** —
 * 아래 `PENDING`에 남겨 매 회차 보이게 한다.
 */
const REQUIRED = [
  { path: `${KERNEL_DIR}/quantize.ts`, what: '수량·가격 규격 (거래소가 받는 모양)' },
];

/**
 * **이미 실행 경로 밖에 있는 정본.** 옮기지 않는다 — 옮기면 더 나빠진다.
 *
 * 청산가 산출식은 `src/lib/safety/liquidationPrice.ts`에 있고 import가
 * 0개이며, `src/lib/safety/`는 실행 경로 글롭에 들어 있지 않다. 즉
 * **연구가 지금 그대로 쓸 수 있다.** `src/lib/engine/liquidationDistance.ts`는
 * 그 정본을 감싸는 엔진 쪽 래퍼다.
 *
 * 처음에 나는 그 래퍼까지 커널로 옮겼다. 그러자
 * `check-100x-mutations.mjs:171`의 변이 카탈로그가 그 경로를 겨냥하고
 * 있어서 **변이 8건이 적용 불가**가 됐다
 * (`MUT-D15 … 적용되지 않습니다 — 정본이 옮겨갔으면 변이도 따라가야 합니다`).
 * 484건 안전 증명을 흔드는 이동이었고, **얻는 것이 없었다** — 정본은
 * 이미 공유 가능한 자리에 있었다. 그래서 되돌렸다.
 *
 * 여기서는 그 정본이 **계속 깨끗한지만** 센다.
 */
const ALREADY_SHARED = [
  {
    path: 'src/lib/safety/liquidationPrice.ts',
    what: '청산가 산출식 (solveLiquidationPrice)',
    why: '`src/lib/safety/`는 실행 경로가 아니다 — 연구가 그대로 쓸 수 있다',
  },
];

/**
 * 아직 커널에 없는 재사용 대상. **비어 가야 한다.**
 *
 * 못 옮긴 것을 옮긴 것으로 적지 않는다 — 매 회차 ⚠️로 출력한다.
 */
const PENDING = [
  {
    from: 'src/lib/engine/riskManager.ts',
    what: '위험 계산 (planPosition)',
    why: '`signalGateway`의 `StandardSignal`·`StrategyBucket`·`BUCKET_RISK`를 '
      + '읽는데 그건 실행 경로다 — 그 타입을 먼저 떼어내야 옮길 수 있다',
  },
];

/** 옛 경로 → 커널. 껍데기만 남아 있어야 한다 */
const SHIMS = [
  { old: 'src/lib/exchanges/quantize.ts', to: '../kernel/quantize' },
];

/** 커널이 해서는 안 되는 I/O의 이름 */
const IO_NAMES = [
  { needle: 'createClient', why: 'Supabase 클라이언트를 만듭니다' },
  { needle: 'supabase', why: 'DB를 읽습니다' },
  { needle: 'fetch(', why: '네트워크를 호출합니다' },
  { needle: 'process.env', why: '환경에 따라 다른 답을 냅니다 — 바닥은 입력만 보고 답해야 합니다' },
];

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };

// ── ① 재사용 대상이 커널에 있는가 ──
for (const r of REQUIRED) {
  if (!existsSync(r.path)) {
    err(`${r.path}가 없습니다 — ${r.what}를 연구와 실행이 같은 파일로 쓰지 못합니다`
      + '\n     연구가 자기 계산을 따로 들면 백테스트가 통과시킨 수량이 거래소에서 거부됩니다');
  }
}

// ── ①-b 이미 분리된 정본이 계속 깨끗한가 ──
//
// 커널 밖에 있지만 **양쪽이 함께 믿는 바닥**이다. 여기 실행 경로
// import가 생기면 연구가 그것을 쓸 수 없게 되고, 그때 연구는 자기
// 계산을 따로 들기 시작한다 — 그게 막으려는 고장이다.
for (const a of ALREADY_SHARED) {
  if (!existsSync(a.path)) {
    err(`${a.path}가 없습니다 — ${a.what}의 정본이 사라졌습니다`);
    continue;
  }
  const src = readFileSync(a.path, 'utf8');
  const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)]
    .map(m => m[1]);
  for (const spec of specs) {
    let resolved;
    if (spec.startsWith('.')) {
      resolved = normalize(join(dirname(a.path), spec)).replaceAll('\\', '/');
    } else if (spec.startsWith('@/')) {
      resolved = `src/${spec.slice(2)}`;
    } else { continue; }
    const hit = EXECUTION_ROOTS.find(root => resolved.startsWith(root));
    if (hit) {
      err(`${a.path}: 실행 경로를 읽습니다 (\`${spec}\` → ${resolved}, ${hit})`
        + `\n     ${a.why} — 이 import가 생기면 연구가 쓸 수 없게 됩니다`);
    }
  }
}

const kernelFiles = (() => {
  try { return globSync(`${KERNEL_DIR}/**/*.ts`).map(f => f.replaceAll('\\', '/')); }
  catch { return null; }
})();

if (kernelFiles == null) {
  err('커널 파일 목록을 읽지 못했습니다 — 못 읽은 것을 "문제 없음"으로 적지 않습니다');
} else {
  for (const f of kernelFiles) {
    if (f.endsWith('.test.ts')) continue;
    let src;
    try { src = readFileSync(f, 'utf8'); }
    catch { err(`${f}을 읽지 못했습니다`); continue; }

    // ── ② 실행 경로를 끌고 오지 않는가 ──
    //
    // 상대 경로는 **해석해서** 본다. `'../engine/x'`를 글자로만 찾으면
    // `'../../lib/engine/x'` 같은 모양을 놓친다.
    const specs = [
      ...src.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/g),
      ...src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...src.matchAll(/(?:^|\n)\s*export\s[^;]*?from\s*['"]([^'"]+)['"]/g),
    ].map(m => m[1]);

    for (const spec of specs) {
      let resolved;
      if (spec.startsWith('.')) {
        resolved = normalize(join(dirname(f), spec)).replaceAll('\\', '/');
      } else if (spec.startsWith('@/')) {
        resolved = `src/${spec.slice(2)}`;
      } else {
        continue;   // 외부 패키지는 이 검사의 대상이 아니다
      }
      const hit = EXECUTION_ROOTS.find(root => resolved.startsWith(root));
      if (hit) {
        err(`${f}: 실행 경로를 읽습니다 (\`${spec}\` → ${resolved}, ${hit})`
          + '\n     커널은 연구와 실행이 함께 믿는 바닥입니다 — 어느 쪽도 끌고 오면 안 됩니다');
      }
    }

    // ── ③ I/O를 하지 않는가 ──
    for (const io of IO_NAMES) {
      if (src.includes(io.needle)) {
        err(`${f}: \`${io.needle}\`가 있습니다 — ${io.why}`
          + '\n     연구는 같은 입력에 같은 답이 나와야 재현됩니다');
      }
    }

    // ── ④ 연구 가정값이 바닥에 없는가 ──
    for (const a of ASSUMPTION_NAMES) {
      if (src.includes(a.needle)) {
        err(`${f}: \`${a.needle}\`가 있습니다 — ${a.why}`
          + '\n     가정값이 커널에 있으면 실행 경로가 그것을 믿게 됩니다');
      }
    }
  }
}

// ── ⑤ 옛 경로가 껍데기인가 (구현이 두 벌로 남지 않았는가) ──
for (const s of SHIMS) {
  if (!existsSync(s.old)) {
    err(`${s.old}가 없습니다 — 옛 경로를 지우면 수입자 전부가 깨집니다`
      + ' (껍데기로 남겨 두세요)');
    continue;
  }
  const src = readFileSync(s.old, 'utf8');
  if (!new RegExp(`from\\s*['"]${s.to.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}['"]`).test(src)) {
    err(`${s.old}: \`${s.to}\`를 재수출하지 않습니다 — 분리가 아니라 복제입니다`);
  }
  // **본문이 남아 있으면 두 벌이다.** 껍데기에 구현이 섞이면 둘이 갈린다.
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const bodies = (noComments.match(/\bfunction\s+\w+\s*\(|=>\s*\{/g) || []).length;
  if (bodies > 0) {
    err(`${s.old}: 껍데기에 구현이 ${bodies}곳 남아 있습니다 — `
      + '커널과 갈립니다 (전부 커널로 옮기세요)');
  }
}

// ── 아직 못 옮긴 것은 적어 둔다 ──
for (const p of PENDING) {
  if (!existsSync(p.from)) continue;
  console.log(`⚠️  ${p.from} — ${p.what} 아직 커널 밖: ${p.why}`);
}

if (bad === 0) {
  console.log(`✅ 연구/실행 공통 커널 — 커널 ${REQUIRED.length}종 + 이미 분리된 정본 `
    + `${ALREADY_SHARED.length}종 · 실행 경로 import 0 · I/O 0 · 가정값 0 · 옛 경로는 껍데기`);
} else {
  console.error('');
  console.error('   연구가 자기 계산을 따로 들면, 백테스트의 "살아남는다"와');
  console.error('   실행의 "청산됐다"가 달라집니다. 바닥은 한 파일이어야 합니다.');
}
process.exit(bad ? 1 : 0);

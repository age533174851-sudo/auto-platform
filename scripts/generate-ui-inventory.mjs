#!/usr/bin/env node
// scripts/generate-ui-inventory.mjs
//
// `src/lib/ui/inventory.ts` → `docs/ui-inventory.md`
//
// **진실은 registry(코드)에 있고 문서는 자동 생성물이다.**
// 문서를 손으로 고쳐 진실을 관리하지 않는다 — 이 저장소는 그 실패를
// 이미 겪었다(FULL_COMPLETION_STATUS.md).
//
// 사용: npm run gen:ui-inventory
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
export const OUT = join(root, 'docs', 'ui-inventory.md');

/** 진실이 있는 곳. 확장자 없이 적는 이유는 loadInventory의 주석 참조 */
export const INVENTORY_MODULE = 'src/lib/ui/inventory';

/** inventory.ts를 프로젝트 tsc로 컴파일해서 불러온다 — 목록을 복제하지 않는다 */
export async function loadInventory() {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, cpSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'traigo-inv-'));
  // **경로를 확장자 없이 적는다.**
  //
  // `check-wiring.mjs`는 따옴표 안에서 모듈 이름으로 끝나는 경로를 찾아
  // "이 판정 모듈을 쓰는 곳이 있는가"를 본다. `'…/inventory.ts'`로 적으면
  // 그 눈에 안 보이고, 멀쩡히 배선된 registry가 **고아 모듈로 잡힌다.**
  // 예외 목록에 적어 덮는 대신, 실제 배선이 보이게 적는다.
  cpSync(join(root, `${INVENTORY_MODULE}.ts`), join(dir, 'inventory.ts'));
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error(`TypeScript를 찾을 수 없습니다: ${tsc} — 먼저 npm install`);

  // **타입 오류로 여기서 죽지 않는다.**
  //
  // 처음엔 tsc가 non-zero면 그대로 터지게 뒀다. 그랬더니 registry에
  // `migration: 'HALFWAY'` 같은 잘못된 값을 넣었을 때 **검사가 이유를
  // 말하지 못하고 Node 스택만 뱉었다.** CI는 빨갛지만 왜인지 알 수 없고,
  // 검사기가 고장 난 것처럼 보인다.
  //
  // tsc는 타입 오류가 있어도 js를 만든다(이 저장소의 ignoreBuildErrors
  // 정책과 같다). 그러니 컴파일 결과가 나왔으면 그대로 읽고, **값이
  // 이상한 것은 아래 의미 검사가 사람 말로 지적하게 둔다.**
  let tscOut = '';
  try {
    execFileSync(process.execPath, [tsc, 'inventory.ts', '--module', 'commonjs',
      '--target', 'es2019', '--skipLibCheck'], { cwd: dir, stdio: 'pipe' });
  } catch (e) {
    tscOut = [e?.stdout, e?.stderr].map(x => String(x ?? '')).join('\n').trim();
  }
  const outFile = join(dir, 'inventory.js');
  if (!existsSync(outFile)) {
    throw new Error('inventory.ts를 컴파일하지 못했습니다 — 문법 오류입니다.\n'
      + tscOut.split('\n').slice(0, 12).join('\n'));
  }
  const mod = await import(`file://${outFile}`);
  // ES 모듈 네임스페이스는 얼려 있어 속성을 붙일 수 없다. 복사해서 돌려준다.
  // 타입 오류가 있었다면 알려는 준다 — 다만 **판정은 값으로 한다.**
  return { ...mod, __tscWarnings: tscOut || null };
}

const yn = (b) => (b ? '○' : '—');
const list = (a) => (a && a.length ? a.join(' · ') : '—');

export function render(inv) {
  const {
    SCREENS, NAVIGATION, PRIMITIVES, OVERLAYS, FEEDBACK, CONVERGENCE, SEMANTICS, UI_STATES,
  } = inv;
  const L = [];

  L.push('# UI Inventory');
  L.push('');
  L.push('> **자동 생성 파일. 손으로 고치지 마세요.**');
  L.push('> 진실은 `src/lib/ui/inventory.ts`에 있습니다.');
  L.push('> 다시 만들기: `npm run gen:ui-inventory`');
  L.push('>');
  L.push('> 문서를 손으로 고쳐 진실을 관리하면 곧 코드와 갈리고,');
  L.push('> **갈린 것을 아무도 못 봅니다.** CI(`check-ui-inventory.mjs`)가 막습니다.');
  L.push('');

  // ── 요약 ──
  const byMig = (m) => SCREENS.filter(s => s.migration === m).length;
  const byPrim = (st) => PRIMITIVES.filter(p => p.status === st).length;
  L.push('## 요약');
  L.push('');
  L.push('| | 수 |');
  L.push('|---|--:|');
  L.push(`| 화면 | ${SCREENS.length} |`);
  L.push(`| 들여다본 화면 (SURVEYED) | ${SCREENS.filter(s => s.depth === 'SURVEYED').length} |`);
  L.push(`| 존재만 확인 (LISTED_ONLY) | ${SCREENS.filter(s => s.depth === 'LISTED_ONLY').length} |`);
  L.push(`| 이관 완료 / 일부 / PR 대기 / 미이관 | ${byMig('MIGRATED')} / ${byMig('PARTIAL')} / ${byMig('PENDING_PR')} / ${byMig('LEGACY')} |`);
  L.push(`| primitive (있음 / 중복 / 없음 / 옛방식 / 제안) | ${byPrim('EXISTS')} / ${byPrim('DUPLICATED')} / ${byPrim('MISSING')} / ${byPrim('LEGACY')} / ${byPrim('PROPOSED')} |`);
  L.push(`| 네비게이션 정의 위치 | ${NAVIGATION.length} |`);
  L.push(`| 겹쳐 뜨는 층 | ${OVERLAYS.length} |`);
  L.push(`| 피드백 | ${FEEDBACK.length} |`);
  L.push(`| 상태 종류 | ${UI_STATES.length} |`);
  L.push('');
  L.push('`LISTED_ONLY`는 **존재를 확인했지만 상태·액션까지는 아직 안 본 화면**입니다.');
  L.push('확인하지 못한 것을 통과로 적지 않습니다.');
  L.push('');

  // ── 화면 ──
  L.push('## 1. 화면');
  L.push('');
  L.push('| 화면 | 위치 | 목적 | 환경 | 이관 | 깊이 | 대상 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const s of SCREENS) {
    L.push(`| **${s.label}** \`${s.id}\` | \`${s.routeOrSurface}\` | ${s.purpose} `
      + `| ${list(s.environments)} | ${s.migration} | ${s.depth === 'SURVEYED' ? '본 것' : '목록만'} | ${s.audience} |`);
  }
  L.push('');

  L.push('### 화면별 주요 액션 · 상태 · primitive');
  L.push('');
  L.push('| 화면 | 주요 액션 | 그리는 상태 | 쓰는 primitive | 진단 노출 |');
  L.push('|---|---|---|---|---|');
  for (const s of SCREENS) {
    L.push(`| \`${s.id}\` | ${list(s.primaryActions)} | ${list(s.states)} `
      + `| ${list(s.primitives)} | ${s.diagnostics ?? '—'} |`);
  }
  L.push('');

  const noted = SCREENS.filter(s => s.notes.trim());
  if (noted.length) {
    L.push('### 화면 메모');
    L.push('');
    for (const s of noted) L.push(`- **\`${s.id}\`** — ${s.notes}`);
    L.push('');
  }

  // ── 네비게이션 ──
  L.push('## 2. 네비게이션 — 목록이 여러 곳에 있다');
  L.push('');
  L.push('| 이름 | 정의 위치 | 심볼 | 개수 | 메모 |');
  L.push('|---|---|---|--:|---|');
  for (const n of NAVIGATION) {
    L.push(`| ${n.label} | \`${n.file}\` | \`${n.symbol}\` | ${n.count} | ${n.notes} |`);
  }
  L.push('');
  L.push('> 하나만 읽으면 화면을 놓칩니다. 실제로 `MENU`만 읽었을 때');
  L.push('> **지갑 화면이 통째로 빠졌습니다.**');
  L.push('');

  // ── primitive ──
  L.push('## 3. 공통 primitive');
  L.push('');
  for (const st of ['EXISTS', 'DUPLICATED', 'MISSING', 'PROPOSED', 'LEGACY']) {
    const rows = PRIMITIVES.filter(p => p.status === st);
    if (!rows.length) continue;
    const title = {
      EXISTS: '있는 것', DUPLICATED: '여러 벌인 것', MISSING: '없는 것',
      PROPOSED: '제안 (아직 만들지 않음)', LEGACY: '옛 방식 (걷어낼 대상)',
    }[st];
    L.push(`### ${title} (${rows.length})`);
    L.push('');
    L.push('| id | 위치 | 쓰임 | 메모 |');
    L.push('|---|---|---|---|');
    for (const p of rows) {
      L.push(`| \`${p.id}\` | ${p.file ? `\`${p.file}\`` : '—'} | ${p.purpose} | ${p.notes || '—'} |`);
    }
    L.push('');
  }
  L.push('> **없는 컴포넌트를 지금 전부 만들지 않습니다.** 몇 종류가 실제로');
  L.push('> 필요한지 세지 않고 만들면 쓰이지 않는 variant가 생기고,');
  L.push('> 화면은 여전히 인라인으로 만듭니다.');
  L.push('');

  // ── 오버레이 · 피드백 ──
  L.push('## 4. 겹쳐 뜨는 층 (Modal / Sheet / Confirm)');
  L.push('');
  L.push('| id | 위치 | 상태 | 쓰임 | 메모 |');
  L.push('|---|---|---|---|---|');
  for (const o of OVERLAYS) {
    L.push(`| \`${o.id}\` | ${o.file ? `\`${o.file}\`` : '—'} | ${o.status} | ${o.purpose} | ${o.notes || '—'} |`);
  }
  L.push('');
  L.push('## 5. 피드백 (Toast / Notice / Details)');
  L.push('');
  L.push('| id | 위치 | 상태 | 쓰임 | 메모 |');
  L.push('|---|---|---|---|---|');
  for (const f of FEEDBACK) {
    L.push(`| \`${f.id}\` | ${f.file ? `\`${f.file}\`` : '—'} | ${f.status} | ${f.purpose} | ${f.notes || '—'} |`);
  }
  L.push('');

  // ── 의미 ──
  L.push('## 6. 지켜야 할 의미 구분');
  L.push('');
  L.push('**구분이 사라지는 것은 코드가 깨지는 것보다 조용합니다.**');
  L.push('');
  L.push('| 규칙 | 왜 |');
  L.push('|---|---|');
  for (const s of SEMANTICS) L.push(`| **${s.rule}** | ${s.why} |`);
  L.push('');

  // ── CURRENT / TARGET / DECISION ──
  L.push('## 7. 지금 / 목표 / 결정');
  L.push('');
  L.push('**Inventory는 설계안만 적는 문서가 아닙니다.** "지금 무엇이 있는가"와');
  L.push('"무엇으로 통일할까"는 다른 사실이고, 후자는 아직 안 정한 것도 있습니다.');
  L.push('');
  for (const d of ['OPEN', 'DECIDED', 'DONE']) {
    const rows = CONVERGENCE.filter(c => c.decision === d);
    if (!rows.length) continue;
    const title = { OPEN: '아직 안 정함', DECIDED: '정했고 진행 중', DONE: '끝남' }[d];
    L.push(`### ${title} (${rows.length})`);
    L.push('');
    for (const c of rows) {
      L.push(`#### \`${c.id}\``);
      L.push('');
      L.push(`- **지금** — ${c.current}`);
      L.push(`- **목표** — ${c.target}`);
      L.push(`- **왜** — ${c.why}`);
      L.push('');
    }
  }

  // ── 다음 순서 ──
  L.push('## 8. 다음 이관 순서');
  L.push('');
  L.push('| 순서 | 대상 | 왜 이 순서인가 |');
  L.push('|--:|---|---|');
  L.push('| 1 | Wallet (#213) | 이미 만들어져 있다. Inventory 검토 후 조정 |');
  L.push('| 2 | Portfolio / Home | 같은 값(총자산·손익)을 보는 화면끼리 묶는다 |');
  L.push('| 3 | Auto / Strategy | 자동매매 나머지 — 만원 단위 원화 표기가 남아 있다 |');
  L.push('| 4 | Market | 환경과 무관한 화면이라 상태 종류가 적다 |');
  L.push('| 5 | History / Backtest / Alerts | |');
  L.push('| 6 | Settings / Diagnostics / Admin | 사용자 화면과 분리된 것을 마지막에 |');
  L.push('| — | **Trading / Terminal** | **로컬 원화 연습 장부 결정이 먼저다** (7. `trading-local-ledger`) |');
  L.push('');

  return L.join('\n') + '\n';
}

const isMain = process.argv[1] && process.argv[1].endsWith('generate-ui-inventory.mjs');
if (isMain) {
  const inv = await loadInventory();
  writeFileSync(OUT, render(inv));
  console.log(`${OUT} — 화면 ${inv.SCREENS.length}개 · primitive ${inv.PRIMITIVES.length}개`);
}

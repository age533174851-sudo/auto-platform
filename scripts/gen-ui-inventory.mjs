#!/usr/bin/env node
// scripts/gen-ui-inventory.mjs
//
// **화면 목록을 손으로 적지 않는다.**
//
// UI 대공사를 하려면 먼저 "지금 무엇이 있는가"가 있어야 한다. 그런데
// 그걸 문서로 적어 두면 **화면이 바뀔 때마다 어긋나고, 어긋난 것을
// 아무도 못 본다.** 이 저장소는 그 실패를 이미 겪었다 —
// FULL_COMPLETION_STATUS.md가 실제와 갈렸고, 그래서
// `gen-migration-manifest.mjs` 방식(코드에서 굽고 CI가 최신인지 확인)이
// 생겼다. 목록도 같은 방식으로 만든다.
//
// 사용: node scripts/gen-ui-inventory.mjs   → docs/UI_INVENTORY.md
// CI  : scripts/check-ui-inventory.mjs 가 낡았으면 실패시킨다
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
export const OUT = join(root, 'docs', 'UI_INVENTORY.md');

const read = (p) => existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null;

/** 주석을 지운다 — 설명문 속 단어를 코드로 세지 않기 위해 */
export function stripComments(src) {
  const s = String(src ?? '');
  let out = ''; let i = 0;
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { if (s[i] === '\n') out += '\n'; i += 1; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i += 1;
      while (i < s.length) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] ?? ''); i += 2; continue; }
        out += s[i];
        if (s[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

// ── ① 사용자 화면 ──
//
// **화면 목록이 세 곳에 따로 있다.** 이것이 이 Inventory가 가장 먼저
// 찾아낸 것이다:
//
//   src/lib/menuItems.tsx   MENU   30개  — 검색·카테고리 메뉴
//   src/app/page.tsx        BTABS   5개  — 하단 탭
//   src/app/page.tsx        MTABS  53개  — '더보기' 시트
//
// 처음엔 MENU만 읽었고, 그래서 **지갑(wallet) 화면을 통째로 놓쳤다** —
// 지갑은 MENU에 없고 BTABS·MTABS에만 있다. #213에서 이관한 바로 그
// 화면이다. 목록을 손으로 적었으면 같은 자리에서 같은 실수를 했을 것이다.
//
// `check-nav.mjs`는 MENU → case 방향만 본다(메뉴에 있는데 화면이 없는
// 경우). 그 반대(화면은 있는데 어느 목록에도 없는 경우)는 아무도 안 봤다.

/** `{ id:'x', label:'y', ... }` 형태를 배열 하나에서 읽는다 */
function entriesIn(src, arrayName) {
  const re = new RegExp(`const ${arrayName}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`);
  const m = re.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/\{\s*id\s*:\s*'([^']+)'\s*,\s*label\s*:\s*'([^']*)'/g)]
    .map(x => ({ id: x[1], label: x[2] }));
}

export function screensOf() {
  const menu = read('src/lib/menuItems.tsx') ?? '';
  const page = read('src/app/page.tsx') ?? '';

  // 메뉴 한 줄 = 화면 하나. 목적(desc)과 분류(cat)가 거기 있다.
  const fromMenu = [...menu.matchAll(
    /\{\s*id\s*:\s*'([^']+)'\s*,\s*label\s*:\s*'([^']*)'\s*,\s*desc\s*:\s*'([^']*)'\s*,\s*cat\s*:\s*'([^']*)'/g,
  )].map(m => ({ id: m[1], label: m[2], desc: m[3], cat: m[4], via: ['MENU'] }));

  const byId = new Map(fromMenu.map(r => [r.id, r]));
  const addVia = (list, tag, cat) => {
    for (const e of list) {
      const cur = byId.get(e.id);
      if (cur) { if (!cur.via.includes(tag)) cur.via.push(tag); continue; }
      byId.set(e.id, { id: e.id, label: e.label, desc: '', cat, via: [tag] });
    }
  };
  addVia(entriesIn(page, 'BTABS'), 'BTABS', '하단탭 전용');
  addVia(entriesIn(page, 'MTABS'), 'MTABS', '더보기 전용');

  // 그 id를 실제로 그리는 컴포넌트
  const bound = new Map();
  for (const m of page.matchAll(/case\s+'([^']+)'\s*:\s*return\s*<(\w+)/g)) bound.set(m[1], m[2]);

  // **어느 목록에도 없는데 case만 있는 화면.** 도달 경로가 코드 안에만
  // 있다는 뜻이라, 사용자가 못 찾거나 죽은 화면일 수 있다.
  for (const [id] of bound) {
    if (!byId.has(id)) byId.set(id, { id, label: id, desc: '', cat: '목록에 없음', via: [] });
  }

  return [...byId.values()].map(r => ({ ...r, component: bound.get(r.id) ?? null }));
}

/** 컴포넌트 이름 → 실제 파일 */
export function fileOfComponent(name) {
  if (!name) return null;
  const dirs = ['src/components/pages', 'src/components'];
  for (const d of dirs) {
    if (!existsSync(join(root, d))) continue;
    for (const f of readdirSync(join(root, d))) {
      if (!f.endsWith('.tsx')) continue;
      const base = f.replace(/\.tsx$/, '');
      // <AutoPageComp .../> 는 AutoPage.tsx 에서 온다 — 별칭을 감안해 앞부분으로 맞춘다
      if (base === name || name.startsWith(base)) return `${d}/${f}`;
    }
  }
  return null;
}

// ── ② 이관 상태 ──
export function migrationStateOf() {
  const chk = read('scripts/check-display-layer.mjs') ?? '';
  const list = (label) => {
    const re = new RegExp(`const ${label}\\s*=\\s*\\[([\\s\\S]*?)\\];`);
    const m = re.exec(chk);
    if (!m) return [];
    return [...m[1].matchAll(/'([^']+\.tsx)'/g)].map(x => x[1]);
  };
  const partial = [...chk.matchAll(/file:\s*'([^']+)'[\s\S]{0,120}?region:\s*'([^']+)'/g)]
    .map(m => ({ file: m[1], region: m[2] }));
  return {
    migrated: list('MIGRATED'),
    statusScreens: list('STATUS_SCREENS'),
    partial,
  };
}

// ── ③ 화면별 legacy 신호 ──
//
// **숫자가 아니라 방향이 중요하다.** 어느 화면이 아직 자기 방식대로
// 숫자를 적고 있는지, 얼마나 남았는지를 본다.
export function legacySignalsOf(file) {
  const src = read(file);
  if (!src) return null;
  const code = stripComments(src);
  const count = (re) => (code.match(re) || []).length;
  return {
    lines: src.split('\n').length,
    toFixed: count(/\.toFixed\(/g),
    toLocale: count(/\.toLocaleString\(/g),
    unknownText: count(/'확인 불가'|'확인하지 못했습니다'/g),
    privateFmt: count(/const\s+fmt\w*\s*=|function\s+fmt\w*\s*\(/g),
    usesDisplay: /from '@\/lib\/ui\/display'/.test(code),
    usesStatus: /from '@\/lib\/ui\/status'/.test(code),
  };
}

// ── ④ 공통 primitive ──
export function primitivesOf() {
  const files = {
    display: 'src/lib/ui/display.ts',
    status: 'src/lib/ui/status.ts',
    statusView: 'src/components/ui/Status.tsx',
    strategyCard: 'src/lib/ui/strategyCard.ts',
    autoOverview: 'src/lib/ui/autoOverview.ts',
    overlayStack: 'src/lib/nav/overlayStack.ts',
    mobileSheet: 'src/lib/ui/mobileSheet.ts',
    displayScale: 'src/lib/ui/displayScale.ts',
  };
  const out = {};
  for (const [k, f] of Object.entries(files)) {
    const src = read(f);
    out[k] = {
      file: f,
      exists: !!src,
      exports: src ? [...stripComments(src).matchAll(/^export\s+(?:async\s+)?(?:function|const|type|interface)\s+(\w+)/gm)]
        .map(m => m[1]) : [],
    };
  }
  return out;
}

// ── ⑤ 오버레이 ──
export function overlaysOf() {
  const dir = 'src/components';
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir))
    .filter(f => /Modal|Sheet|Confirm|Toast|Dialog/i.test(f) && f.endsWith('.tsx'))
    .map(f => `${dir}/${f}`)
    .sort();
}

// ── ⑥ breakpoint ──
export function breakpointsOf() {
  const seen = new Map();
  const walk = (dir) => {
    for (const f of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = `${dir}/${f.name}`;
      if (f.isDirectory()) { walk(p); continue; }
      if (!/\.(tsx?|css)$/.test(f.name)) continue;
      const src = read(p) ?? '';
      for (const m of src.matchAll(/\((max|min)-width:\s*(\d+)px\)/g)) {
        const key = `${m[1]}-width: ${m[2]}px`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
  };
  walk('src');
  return [...seen.entries()].sort((a, b) => b[1] - a[1]);
}

// ── ⑦ 라우트 ──
export function routesOf() {
  const out = [];
  const walk = (dir) => {
    for (const f of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = `${dir}/${f.name}`;
      if (f.isDirectory()) { walk(p); continue; }
      if (f.name === 'page.tsx') out.push(p.replace(/^src\/app/, '').replace(/\/page\.tsx$/, '') || '/');
    }
  };
  walk('src/app');
  return out.sort();
}

export function build() {
  const screens = screensOf().map(s => {
    const file = fileOfComponent(s.component);
    return { ...s, file, signals: file ? legacySignalsOf(file) : null };
  });
  return {
    screens,
    routes: routesOf(),
    migration: migrationStateOf(),
    primitives: primitivesOf(),
    overlays: overlaysOf(),
    breakpoints: breakpointsOf(),
  };
}

// ── 문서로 굽는다 ──

const pct = (n, d) => d === 0 ? '—' : `${Math.round((n / d) * 100)}%`;

/** 이 화면이 표시 계층으로 얼마나 왔는가 */
export function stageOf(file, mig) {
  if (!file) return { code: 'NO_SCREEN', label: '화면 파일 못 찾음' };
  if (mig.migrated.includes(file)) return { code: 'MIGRATED', label: '이관 완료(파일 전체 잠금)' };
  if (mig.partial.some(p => p.file === file)) return { code: 'PARTIAL', label: '일부 이관(구간 잠금)' };
  return { code: 'LEGACY', label: '미이관' };
}

export function render(b) {
  const L = [];
  const mig = b.migration;

  L.push('# UI Inventory (5B)');
  L.push('');
  L.push('> **이 파일은 손으로 고치지 않는다.** `node scripts/gen-ui-inventory.mjs`가');
  L.push('> 코드에서 굽는다. 낡으면 CI(`scripts/check-ui-inventory.mjs`)가 실패한다.');
  L.push('>');
  L.push('> 문서로만 두면 화면이 바뀔 때마다 어긋나고, **어긋난 것을 아무도 못 본다.**');
  L.push('> 이 저장소는 그 실패를 이미 겪었다(FULL_COMPLETION_STATUS.md).');
  L.push('');

  // ── 요약 ──
  const withFile = b.screens.filter(s => s.file);
  const stages = withFile.map(s => stageOf(s.file, mig).code);
  const nMig = stages.filter(x => x === 'MIGRATED').length;
  const nPart = stages.filter(x => x === 'PARTIAL').length;
  const nLeg = stages.filter(x => x === 'LEGACY').length;
  L.push('## 지금 어디까지 왔나');
  L.push('');
  L.push('| | 수 |');
  L.push('|---|---|');
  L.push(`| 사용자 화면 | ${b.screens.length} |`);
  L.push(`| 화면 파일을 찾은 것 | ${withFile.length} |`);
  L.push(`| 이관 완료 | ${nMig} (${pct(nMig, withFile.length)}) |`);
  L.push(`| 일부 이관 | ${nPart} |`);
  L.push(`| 미이관 | ${nLeg} |`);
  L.push(`| 라우트 | ${b.routes.length} |`);
  L.push('');
  const tot = withFile.reduce((a, s) => ({
    toFixed: a.toFixed + (s.signals?.toFixed ?? 0),
    toLocale: a.toLocale + (s.signals?.toLocale ?? 0),
    unknownText: a.unknownText + (s.signals?.unknownText ?? 0),
    privateFmt: a.privateFmt + (s.signals?.privateFmt ?? 0),
  }), { toFixed: 0, toLocale: 0, unknownText: 0, privateFmt: 0 });
  L.push('화면들이 아직 각자 정하고 있는 것 (화면 파일 기준):');
  L.push('');
  L.push(`- \`toFixed\` **${tot.toFixed}** · \`toLocaleString\` **${tot.toLocale}**`);
  L.push(`- '확인 불가' 직접 표기 **${tot.unknownText}**`);
  L.push(`- 사설 포매터(\`const fmt…\`) **${tot.privateFmt}**`);
  L.push('');

  // ── 화면 목록 ──
  // ── 네비게이션 구멍 ──
  L.push('## 0. 화면 목록이 세 곳에 있다');
  L.push('');
  L.push('| 정의 위치 | 무엇 |');
  L.push('|---|---|');
  L.push('| `src/lib/menuItems.tsx` `MENU` | 검색·카테고리 메뉴 |');
  L.push('| `src/app/page.tsx` `BTABS` | 하단 탭 |');
  L.push('| `src/app/page.tsx` `MTABS` | \'더보기\' 시트 |');
  L.push('');
  const viaCount = {};
  for (const s of b.screens) {
    const k = s.via.length ? s.via.join(' + ') : '(어느 목록에도 없음)';
    viaCount[k] = (viaCount[k] ?? 0) + 1;
  }
  L.push('| 도달 경로 | 화면 수 |');
  L.push('|---|--:|');
  for (const [k, n] of Object.entries(viaCount).sort((a, b2) => b2[1] - a[1])) L.push(`| ${k} | ${n} |`);
  L.push('');
  const orphan = b.screens.filter(s => s.via.length === 0);
  if (orphan.length) {
    L.push('**어느 목록에도 없는데 화면 분기만 있는 것** — 사용자가 찾아갈 길이');
    L.push('코드 안에만 있다. 죽은 화면이거나, 다른 화면이 프로그램으로만 여는 곳이다.');
    L.push('');
    for (const s of orphan) L.push(`- \`${s.id}\` → \`${s.component ?? '—'}\``);
    L.push('');
  }
  const noCase = b.screens.filter(s => s.via.length > 0 && !s.component);
  if (noCase.length) {
    L.push('**목록에는 있는데 그리는 화면이 없는 것** — 누르면 빈 화면이다.');
    L.push('');
    for (const s of noCase) L.push(`- \`${s.id}\` (${s.via.join(' + ')})`);
    L.push('');
  }
  L.push('> `check-nav.mjs`는 `MENU` → `case` 방향만 본다. `BTABS`·`MTABS`와');
  L.push('> 반대 방향(화면은 있는데 목록에 없는 경우)은 아무도 안 보고 있었다.');
  L.push('');

  L.push('## 1. 전체 사용자 화면');
  L.push('');
  L.push('`목적`은 메뉴의 설명문 그대로다 — 여기서 새로 짓지 않는다.');
  L.push('');
  const cats = [...new Set(b.screens.map(s => s.cat))];
  for (const cat of cats) {
    L.push(`### ${cat}`);
    L.push('');
    L.push('| 화면 | 목적 | 경로 | 파일 | 상태 | fx | loc | 확불 | fmt |');
    L.push('|---|---|---|---|---|--:|--:|--:|--:|');
    for (const s of b.screens.filter(x => x.cat === cat)) {
      const st = stageOf(s.file, mig);
      const g = s.signals;
      L.push(`| **${s.label}** \`${s.id}\` | ${s.desc || '—'} | ${s.via.join('+') || '**없음**'} `
        + `| ${s.file ? `\`${s.file.replace('src/components/', '')}\`` : '—'} `
        + `| ${st.label} | ${g?.toFixed ?? '—'} | ${g?.toLocale ?? '—'} | ${g?.unknownText ?? '—'} | ${g?.privateFmt ?? '—'} |`);
    }
    L.push('');
  }
  L.push('`fx`=toFixed · `loc`=toLocaleString · `확불`=\'확인 불가\' 직접 표기 · `fmt`=사설 포매터');
  L.push('');

  // ── 라우트 ──
  L.push('## 2. 라우트');
  L.push('');
  for (const r of b.routes) L.push(`- \`${r}\``);
  L.push('');
  L.push('메인 앱(`/`)이 위 30개 화면을 탭으로 그린다. `/terminal`·`/chart`는');
  L.push('별도 라우트이고, `/admin`·`/developer`는 일반 사용자 UI가 아니다.');
  L.push('');

  // ── primitive ──
  L.push('## 3. 공통 primitive');
  L.push('');
  L.push('| 모듈 | 파일 | 있음 | 내보내는 것 |');
  L.push('|---|---|---|---|');
  for (const [k, v] of Object.entries(b.primitives)) {
    const ex = v.exports.slice(0, 8).join(' · ') + (v.exports.length > 8 ? ` … (${v.exports.length})` : '');
    L.push(`| ${k} | \`${v.file}\` | ${v.exists ? '○' : '**없음**'} | ${ex || '—'} |`);
  }
  L.push('');

  // ── 오버레이 ──
  L.push('## 4. Modal / Sheet / Confirm / Toast');
  L.push('');
  for (const o of b.overlays) L.push(`- \`${o}\``);
  L.push('');
  L.push('겹침 순서는 `src/lib/nav/overlayStack.ts`, 모바일 시트의 키보드·높이는');
  L.push('`src/lib/ui/mobileSheet.ts`가 판정한다.');
  L.push('');

  // ── breakpoint ──
  L.push('## 5. Breakpoint (실제 쓰이는 것)');
  L.push('');
  L.push('| 조건 | 쓰인 곳 |');
  L.push('|---|--:|');
  for (const [k, n] of b.breakpoints) L.push(`| \`${k}\` | ${n} |`);
  L.push('');

  // ── 확정된 규칙 (코드에서 읽어 온다) ──
  L.push('## 6. 확정된 표시 규칙');
  L.push('');
  L.push('아래는 **문장이 아니라 코드에서 읽어 온 것**이다. 여기 적힌 값이');
  L.push('바뀌면 이 문서도 같이 바뀐다.');
  L.push('');
  const disp = read('src/lib/ui/display.ts') ?? '';
  const stat = read('src/lib/ui/status.ts') ?? '';

  L.push('### 환경 (LIVE / TESTNET / PAPER)');
  L.push('');
  if (stat) {
    L.push('| 환경 | 화면 이름 | 의미 | 색조 | 실제 자금 | 주문 전 재확인 |');
    L.push('|---|---|---|---|---|---|');
    for (const m of stat.matchAll(
      /(\w+):\s*\{[\s\S]{0,400}?label:\s*'([^']*)',\s*meaning:\s*'([^']*)',[\s\S]{0,200}?tone:\s*'(\w+)',\s*confirmBeforeOrder:\s*(\w+),\s*realMoney:\s*(\w+)/g)) {
      L.push(`| \`${m[1]}\` | ${m[2]} | ${m[3]} | ${m[4]} | ${m[6] === 'true' ? '○' : '×'} | ${m[5] === 'true' ? '○' : '×'} |`);
    }
  } else {
    L.push('> ⚠ `src/lib/ui/status.ts`가 **아직 main에 없다.** 이 정의는');
    L.push('> PR #213(지갑 + 상태 표현)에 있고, 머지되면 이 표가 자동으로 채워진다.');
    L.push('> **여기에 손으로 옮겨 적지 않는다** — 적는 순간 두 벌이 된다.');
  }
  L.push('');
  L.push('> PAPER는 코드 쪽 이름이고 저장값은 `MOCK`이다. 두 이름이 함께');
  L.push('> 쓰여 왔으므로 **표시할 때만** 한 단어(모의)로 모은다.');
  L.push('');

  L.push('### 상태 (SUCCESS / WARNING / ERROR / UNKNOWN / DISABLED)');
  L.push('');
  const tone = /STATUS_TONE[^{]*\{([\s\S]*?)\}/.exec(stat);
  const lab = /STATUS_LABEL[^{]*\{([\s\S]*?)\}/.exec(stat);
  if (tone && lab) {
    const pick = (blk) => Object.fromEntries([...blk.matchAll(/(\w+):\s*([^,\n]+)/g)]
      .map(m => [m[1], m[2].trim().replace(/,$/, '')]));
    const T = pick(tone[1]); const B = pick(lab[1]);
    L.push('| 상태 | 화면 문구 | 색조 | 기호 |');
    L.push('|---|---|---|---|');
    const MARK = { SUCCESS: '●', WARNING: '▲', ERROR: '✕', UNKNOWN: '?', DISABLED: '−' };
    for (const k of Object.keys(T)) L.push(`| ${k} | ${B[k] ?? '—'} | ${T[k]} | ${MARK[k] ?? ''} |`);
  } else {
    L.push('> ⚠ 위와 같다 — 정의가 아직 main에 없다(PR #213).');
  }
  L.push('');
  L.push('> **막힌 것만 빨갛다.** 못 읽은 것(UNKNOWN)은 회색이다 — 전부');
  L.push('> 빨가면 어느 것도 빨갛지 않은 것과 같다.');
  L.push('> 색만으로 구분하지 않는다. 기호가 먼저다.');
  L.push('');

  L.push('### 계좌 상태 — 셋을 절대 섞지 않는다');
  L.push('');
  L.push('| 코드 | 뜻 | 사용자가 할 일 |');
  L.push('|---|---|---|');
  L.push('| `NO_ACCOUNT` | 계좌가 아직 없다 | 시작하면 만들어진다 |');
  L.push('| `UNREADABLE` | 값을 못 읽었다 | **0도 아니고 없음도 아니다** |');
  L.push('| `READY` (잔고 0) | 읽었고 0이다 | 정상. 충전하면 된다 |');
  L.push('');

  L.push('### 숫자 · 금액 · 수량 · 퍼센트');
  L.push('');
  const dig = /export function digitsFor[\s\S]*?\n\}/.exec(disp);
  if (dig) {
    L.push('자릿수는 **값의 크기가 정한다.** 고정하지 않는다 — 8자리 고정이');
    L.push('잔고 0을 `0.00000000`으로 만들었고, 2자리 고정은 작은 코인 수량을');
    L.push('전부 `0.00`으로 만든다.');
    L.push('');
    L.push('```ts');
    L.push(dig[0].split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'));
    L.push('```');
  } else L.push('_`digitsFor`를 읽지 못했습니다._');
  L.push('');
  L.push('- 모르는 값은 표에서 `—`, 문장에서 `확인 불가` — **0으로 채우지 않는다**');
  L.push('- 음수는 하이픈이 아니라 `−` (하이픈은 빈칸 표시 `—`와 헷갈린다)');
  L.push('- 손익 0은 이겼다고도 졌다고도 하지 않는다 (부호·색 없음)');
  L.push('- 날짜·시간 표기는 **아직 표시 계층에 없다** — 각 화면이 정하고 있다');
  L.push('');

  L.push('### 일반 사용자 UI와 진단/관리자');
  L.push('');
  L.push('| 구분 | 위치 |');
  L.push('|---|---|');
  L.push('| 일반 사용자 | `/` (위 화면 목록) |');
  L.push('| 진단 | 화면 `diagnostics` · `ops` · 각 카드의 접히는 "진단 정보" |');
  L.push('| 관리자 | `/admin` · `/developer` — 화면 목록에 넣지 않는다 |');
  L.push('');
  L.push('> 개발자용 원문(DB·API 오류)은 본문에서 떼어 `Details`로 접는다.');
  L.push('> `splitDiagnostics`가 가른다. **원문을 버리지는 않는다** — 버리면');
  L.push('> 진짜 고장 났을 때 아무도 원인을 못 찾는다.');
  L.push('');

  // ── 이관 잠금 ──
  L.push('## 7. 이관 잠금 상태');
  L.push('');
  L.push('**파일 전체 잠금** (`MIGRATED`)');
  for (const f of mig.migrated) L.push(`- \`${f}\``);
  L.push('');
  L.push('**구간 잠금** (`PARTIAL_MIGRATED`)');
  for (const p of mig.partial) L.push(`- \`${p.file}\` — \`${p.region}\``);
  L.push('');
  L.push('**상태 표현 계약** (`STATUS_SCREENS`)');
  for (const f of mig.statusScreens) L.push(`- \`${f}\``);
  L.push('');

  return L.join('\n') + '\n';
}

const isMain = process.argv[1] && process.argv[1].endsWith('gen-ui-inventory.mjs');
if (isMain) {
  const b = build();
  writeFileSync(OUT, render(b));
  console.log(`${OUT} — 화면 ${b.screens.length}개 · 라우트 ${b.routes.length}개`);
}

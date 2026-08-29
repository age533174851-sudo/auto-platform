#!/usr/bin/env node
// scripts/check-ui-inventory.mjs
//
// **Inventory가 실제와 갈리면 실패시킨다.**
//
// 두 가지를 본다:
//   ① registry 자체가 자기모순이 아닌가 (id 중복 · 빈 칸 · 모르는 값)
//   ② 실제 코드에 있는 화면이 registry에 등록됐는가
//
// ②는 **누락 후보를 알려 줄 뿐 의미를 추측하지 않는다.** 스캐너가
// "이 화면의 목적은 무엇이다"를 지어내면, 틀린 답이 자동으로 갱신되는
// 문서가 된다. 화면을 찾는 것까지가 기계의 몫이고, 그것이 무엇인지는
// 사람이 `inventory.ts`에 적는다.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadInventory, render, OUT } from './generate-ui-inventory.mjs';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };
const warn = (m) => console.log(`⚠ ${m}`);
const read = (p) => existsSync(p) ? readFileSync(p, 'utf8') : null;

const inv = await loadInventory();
const {
  SCREENS, NAVIGATION, PRIMITIVES, OVERLAYS, FEEDBACK, CONVERGENCE, SEMANTICS,
  ENVIRONMENTS, UI_STATES, MIGRATION_STATUSES, PRIMITIVE_STATUSES, UI_STATE_INVENTORY,
} = inv;

// ── ⓪ 타입 오류가 있었다면 먼저 말한다 ──
//
// 판정은 값으로 하지만, 타입이 이미 틀렸다면 그것부터 보여 주는 것이
// 사람에게 빠르다.
if (inv.__tscWarnings) {
  const head = String(inv.__tscWarnings).split('\n').slice(0, 5).join('\n');
  warn(`inventory.ts에 타입 오류가 있습니다 (판정은 아래 값 검사로 계속합니다):\n${head}`);
}

// ── ① registry가 비면 스캐너가 고장 난 것이다 ──
//
// 0개를 "화면이 없다"로 읽으면 이 검사는 영원히 초록이면서 아무것도
// 안 보는 상태가 된다. **못 읽은 것을 통과로 적지 않는다.**
if (!SCREENS?.length) err('화면 registry가 비어 있습니다');
if (!PRIMITIVES?.length) err('primitive registry가 비어 있습니다');
if (!SEMANTICS?.length) err('의미 구분 registry가 비어 있습니다');
if (!NAVIGATION?.length) err('네비게이션 registry가 비어 있습니다 — 화면 목록이 어디에 있는지 아무도 모릅니다');
if (!CONVERGENCE?.length) err('지금/목표/결정 registry가 비어 있습니다');
if (!UI_STATE_INVENTORY?.length) {
  err('화면 상태별 재고가 비어 있습니다 — 상태의 *의미*가 모였다고 '
    + '그것을 *그리는 물건*까지 있는 것은 아닙니다');
}

// ── ② id 중복 ──
const dup = (name, ids) => {
  const d = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (d.length) err(`${name} id가 겹칩니다: ${[...new Set(d)].join(', ')}`);
};
dup('화면', SCREENS.map(s => s.id));
dup('primitive', PRIMITIVES.map(p => p.id));
dup('오버레이', OVERLAYS.map(o => o.id));
dup('피드백', FEEDBACK.map(f => f.id));
dup('네비게이션', NAVIGATION.map(n => n.id));
dup('수렴', CONVERGENCE.map(c => c.id));
dup('의미', SEMANTICS.map(s => s.id));

// ── ③ 필수 칸 · 값 ──
for (const s of SCREENS) {
  for (const k of ['label', 'routeOrSurface', 'purpose']) {
    if (!String(s[k] ?? '').trim()) err(`화면 ${s.id}: ${k}가 비어 있습니다`);
  }
  if (!s.environments?.length) err(`화면 ${s.id}: environments가 비어 있습니다`);
  if (!s.states?.length) err(`화면 ${s.id}: states가 비어 있습니다`);
  for (const e of s.environments ?? []) {
    if (!ENVIRONMENTS.includes(e)) err(`화면 ${s.id}: 모르는 환경 '${e}'`);
  }
  for (const st of s.states ?? []) {
    if (!UI_STATES.includes(st)) err(`화면 ${s.id}: 모르는 상태 '${st}'`);
  }
  if (!MIGRATION_STATUSES.includes(s.migration)) err(`화면 ${s.id}: 모르는 이관 상태 '${s.migration}'`);
  if (!['SURVEYED', 'LISTED_ONLY'].includes(s.depth)) err(`화면 ${s.id}: 모르는 깊이 '${s.depth}'`);
  if (!['USER', 'DIAGNOSTICS', 'ADMIN'].includes(s.audience)) err(`화면 ${s.id}: 모르는 대상 '${s.audience}'`);
}
for (const p of PRIMITIVES) {
  if (!PRIMITIVE_STATUSES.includes(p.status)) err(`primitive ${p.id}: 모르는 상태 '${p.status}'`);
  // **어디로 갈 것인가가 없으면 Inventory는 파일 목록으로 끝난다.**
  if (!String(p.target ?? '').trim()) err(`primitive ${p.id}: target(무엇으로 모을 것인가)이 비어 있습니다`);
}

// ── ③-2 화면 상태별 재고 ──
//
// 상태의 *의미*(status.ts)와 그것을 *그리는 물건*은 다른 문제다.
// 의미가 한 곳에 있어도 그리는 것이 20곳에 흩어져 있으면 화면은 제각각이다.
{
  const seen = new Set();
  for (const u of UI_STATE_INVENTORY ?? []) {
    if (!UI_STATES.includes(u.state)) { err(`상태 재고: 모르는 상태 '${u.state}'`); continue; }
    if (seen.has(u.state)) err(`상태 재고: '${u.state}'가 두 번 있습니다`);
    seen.add(u.state);
    if (!PRIMITIVE_STATUSES.includes(u.status)) err(`상태 재고 ${u.state}: 모르는 상태값 '${u.status}'`);
    if (!u.existing?.length) {
      err(`상태 재고 ${u.state}: 지금 무엇이 그리고 있는지가 비어 있습니다 — `
        + `**안 본 것을 '없음'으로 적지 않습니다**`);
    }
    if (!String(u.targetPrimitive ?? '').trim()) err(`상태 재고 ${u.state}: 목표 primitive가 비어 있습니다`);
    // 공통 물건이 있다고 적었으면 그 이름이 실제 primitive여야 한다.
    // 없는 이름을 적어 두면 다음 사람은 만드는 대신 찾다가 시간을 쓴다.
    if (u.sharedPrimitive && !PRIMITIVES.some(p => p.id === u.sharedPrimitive)) {
      err(`상태 재고 ${u.state}: 공통 물건 '${u.sharedPrimitive}'이 primitive 목록에 없습니다`);
    }
    if (u.sharedPrimitive === null && u.status === 'EXISTS') {
      err(`상태 재고 ${u.state}: 공통 물건이 없다면서 EXISTS입니다`);
    }
  }
  // **일곱 상태를 하나도 빠뜨리지 않는다.** 빠진 상태는 조사조차 안 된 것이다.
  for (const k of UI_STATES) {
    if (!seen.has(k)) err(`상태 재고에 ${k}가 없습니다 — 그 상태는 아무도 세지 않았습니다`);
  }
}

// ── ④ 화면이 참조하는 primitive가 목록에 있는가 ──
{
  const known = new Set(PRIMITIVES.map(p => p.id));
  for (const s of SCREENS) {
    for (const p of s.primitives ?? []) {
      if (!known.has(p)) err(`화면 ${s.id}: 목록에 없는 primitive '${p}'`);
    }
  }
}

// ── ⑤ 의미 구분이 사라지지 않았는가 ──
//
// **구분이 사라지는 것은 코드가 깨지는 것보다 조용하다.**
{
  const need = [
    'unknown-vs-error', 'disabled-vs-error',
    'no-account-vs-unreadable', 'ready-zero-vs-no-account',
    'env-separation', 'user-vs-diagnostics',
  ];
  const have = new Set(SEMANTICS.map(s => s.id));
  for (const n of need) if (!have.has(n)) err(`의미 구분이 빠졌습니다: ${n}`);

  for (const k of ['UNKNOWN', 'ERROR', 'DISABLED']) {
    if (!UI_STATES.includes(k)) err(`상태 종류에 ${k}가 없습니다 — 다른 상태가 이것을 겸하게 됩니다`);
  }
  for (const e of ['LIVE', 'TESTNET', 'PAPER']) {
    if (!ENVIRONMENTS.includes(e)) err(`환경에 ${e}가 없습니다`);
  }
}

// ── ⑥ 아직 안 정한 것을 정한 것처럼 적지 않았는가 ──
for (const c of CONVERGENCE) {
  if (!['DECIDED', 'OPEN', 'DONE'].includes(c.decision)) err(`수렴 ${c.id}: 모르는 결정 '${c.decision}'`);
  for (const k of ['current', 'target', 'why']) {
    if (!String(c[k] ?? '').trim()) err(`수렴 ${c.id}: ${k}가 비어 있습니다`);
  }
  if (c.decision === 'OPEN' && !/미정|아직|\?|①/.test(c.target)) {
    err(`수렴 ${c.id}: OPEN인데 목표가 단정적입니다 — 다음 사람이 결정으로 읽습니다`);
  }
}

// ── ⑥-2 장부가 걸린 항목은 CURRENT만으로 부족하다 ──
//
// 로컬 원화 연습 장부처럼 **"무엇이 정본인가"가 걸린 항목**은
// 지금 상태만 적어 두면 다음 사람이 두 장부를 같은 것으로 취급한다.
// 최상위 규칙(장부와 자산을 절대 합산하지 않는다)이 이 항목에 어떻게
// 적용되는지가 문서에 남아야 한다.
{
  const NEED_LEDGER_META = ['trading-local-ledger', 'terminal-order-path'];
  const byId = new Map(CONVERGENCE.map(c => [c.id, c]));
  for (const id of NEED_LEDGER_META) {
    const c = byId.get(id);
    if (!c) {
      err(`지금/목표/결정에 '${id}'이 없습니다 — 이 의미적 부채는 기록이 사라지면 `
        + `다음 사람이 그냥 통합해 버립니다`);
      continue;
    }
    for (const [k, ko] of [['canonical', 'CANONICAL(정본인가)'], ['isolation', 'ISOLATION(섞지 않을 것)']]) {
      if (!String(c[k] ?? '').trim()) err(`수렴 ${id}: ${ko}가 비어 있습니다`);
    }
  }
  // 로컬 원화 장부가 무엇인지가 문서에서 읽혀야 한다 —
  // '미이관 legacy 화면' 한 줄로는 아무 의미도 전달되지 않는다.
  const t = byId.get('trading-local-ledger');
  if (t) {
    const all = `${t.current} ${t.canonical ?? ''} ${t.isolation ?? ''}`;
    for (const [re, what] of [
      [/원화|KRW/, '통화(원화/KRW)'],
      [/localStorage|로컬|브라우저/, '어디에 저장되는가(브라우저 로컬)'],
      [/paper_|서버 PAPER|정본/, '정본 PAPER와의 관계'],
      [/합산|더한|합치/, '정본 PAPER와 합산 금지'],
    ]) {
      if (!re.test(all)) err(`수렴 trading-local-ledger: ${what}가 적혀 있지 않습니다`);
    }
  }
}

// ── ⑦ 실제 화면과 대조 ──
//
// **의미는 추측하지 않는다.** 실제로 있는 화면을 찾아 registry에
// 등록됐는지만 본다.
{
  const page = read('src/app/page.tsx') ?? '';
  const cases = [...page.matchAll(/case\s+'([^']+)'\s*:\s*return\s*<(\w+)/g)].map(m => m[1]);
  const known = new Set(SCREENS.map(s => s.id));
  const missing = [...new Set(cases)].filter(id => !known.has(id));

  // 아직 등록 안 된 화면이 있는 것 자체는 실패가 아니다 — 57개를 한 번에
  // 다 적지 않았다. 다만 **몇 개가 남았는지 눈에 보여야 한다.**
  if (missing.length) {
    warn(`registry에 아직 없는 화면 ${missing.length}개: ${missing.slice(0, 12).join(', ')}`
      + (missing.length > 12 ? ` … 외 ${missing.length - 12}개` : ''));
    warn('  → 의미(목적·상태·액션)는 사람이 inventory.ts에 적습니다. 기계가 지어내지 않습니다.');
  }

  // 반대는 실패다: registry에 있는데 그릴 화면이 없으면 죽은 항목이다.
  const surfaces = new Set(cases);
  for (const s of SCREENS) {
    if (!s.routeOrSurface.startsWith('tab:')) continue;
    const id = s.routeOrSurface.slice(4);
    if (!surfaces.has(id)) err(`화면 ${s.id}: \`tab:${id}\`를 그리는 분기가 page.tsx에 없습니다`);
  }

  // 네비게이션 정의 위치가 실제로 있는가
  for (const n of NAVIGATION) {
    const src = read(n.file);
    if (!src) { err(`네비게이션 ${n.id}: ${n.file}이 없습니다`); continue; }
    if (!new RegExp(`\\b${n.symbol}\\b`).test(src)) {
      err(`네비게이션 ${n.id}: ${n.file}에 \`${n.symbol}\`이 없습니다 — 이름이 바뀌었습니다`);
    }
  }

  // 파일이 있다고 적힌 primitive는 실제로 있어야 한다
  for (const p of [...PRIMITIVES, ...OVERLAYS, ...FEEDBACK]) {
    if (p.status === 'MISSING' || p.status === 'PROPOSED' || !p.file) continue;
    if (!read(p.file)) {
      // #213처럼 아직 main에 없는 것은 실패가 아니다 — 메모에 적혀 있어야 한다.
      if (/#\d+/.test(p.notes ?? '')) {
        warn(`${p.id}: ${p.file}이 아직 없습니다 (메모: ${p.notes.slice(0, 40)}…)`);
      } else {
        err(`${p.id}: EXISTS라고 적혀 있는데 ${p.file}이 없습니다`);
      }
    }
  }
}

// ── ⑦-2 겹쳐 뜨는 층을 재귀로 찾는다 ──
//
// **처음엔 `src/components` 한 층만 읽었다.**
//
// 그래서 `src/components/terminal/BottomSheet.tsx`를 못 봤고, registry에는
// BottomSheet의 위치가 `src/lib/ui/mobileSheet.ts`(높이·키보드 *판정*)로
// 적혀 있었다. 그리는 컴포넌트와 판정 모듈을 같은 것으로 적어 둔 것이다.
// **Inventory의 목적이 "못 본 것을 없음으로 적지 않는 것"인데, 정작
// 스캐너가 못 보는 곳이 있었다.**
//
// 여기서 하는 일은 후보를 찾아 **등록됐는지 묻는 것까지**다. 파일 이름에
// Modal이 들어갔다고 그것이 무슨 모달인지 기계가 지어내지 않는다.
{
  const ROOT = 'src/components';
  const CANDIDATE = /(Modal|Sheet|Dialog|Confirm|Toast|Popup|Drawer)/i;
  const SKIP_DIR = new Set(['node_modules', '__tests__']);

  const walk = (dir, out = []) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(full, out); continue; }
      if (!/\.(tsx|ts)$/.test(e.name)) continue;
      if (/\.test\.tsx?$/.test(e.name)) continue;
      out.push(full.split('\\').join('/'));
    }
    return out;
  };

  const files = walk(ROOT);
  if (!files.length) {
    // 0개를 "겹치는 층이 없다"로 읽으면 이 검사는 영원히 초록이다.
    err(`${ROOT} 아래에서 파일을 하나도 못 읽었습니다 — 검사기가 고장 난 것입니다`);
  }

  // **경로로만 대조한다.**
  //
  // 처음엔 파일 이름이 registry의 id와 같으면 등록된 것으로 쳤다. 그러면
  // BottomSheet가 `mobileSheet.ts`로 잘못 적혀 있어도 `BottomSheet.tsx`라는
  // 이름만 보고 통과한다 — **찾으려던 바로 그 고장을 못 잡는다.**
  const registeredPaths = new Set(
    [...OVERLAYS, ...FEEDBACK, ...PRIMITIVES].map(x => x.file).filter(Boolean));

  const unregistered = files
    .filter(f => CANDIDATE.test(f.split('/').pop()))
    .filter(f => !registeredPaths.has(f));

  if (unregistered.length) {
    for (const f of unregistered) err(`겹쳐 뜨는 층 후보가 registry에 없습니다: ${f}`);
    console.error('   → 무엇인지는 사람이 `inventory.ts`의 OVERLAYS/FEEDBACK에 적습니다.');
    console.error('     파일 이름만 보고 기계가 의미를 지어내지 않습니다.');
  } else {
    console.log(`· 겹쳐 뜨는 층 재귀 탐색 — ${ROOT}/** 파일 ${files.length}개, 미등록 후보 0`);
  }
}

// ── ⑧ 생성 문서가 최신인가 ──
{
  const want = render(inv);
  const have = read(OUT) ?? '';
  if (have !== want) {
    err('docs/ui-inventory.md가 낡았습니다 — `npm run gen:ui-inventory`를 실행하고 커밋하세요');
  }
}

if (bad === 0) {
  const open = CONVERGENCE.filter(c => c.decision === 'OPEN').length;
  console.log(`✅ UI Inventory 일관 — 화면 ${SCREENS.length} · primitive ${PRIMITIVES.length}`
    + ` · 상태 재고 ${UI_STATE_INVENTORY.length} · 겹치는 층 ${OVERLAYS.length}`
    + ` · 의미 구분 ${SEMANTICS.length} · 아직 안 정한 것 ${open}`);
} else {
  console.error('');
  console.error('   목록이 실제와 갈리면, 그 목록을 보고 내리는 판단이 전부 틀립니다.');
}
process.exit(bad ? 1 : 0);

#!/usr/bin/env node
// scripts/approval-path-mutations.mjs
//
// **안전장치를 통과시키는 코드는, 헐거워졌을 때 알아채야 한다.**
//
// 승인 경로는 분류기가 "위험하다"고 막은 것을 사람이 지목해서 통과시키는
// 자리다. 그 검사가 하나라도 조용히 빠지면, 막혀 있어야 할 것이 지나간다.
// 그리고 그런 종류의 헐거워짐은 **통과하는 검사만 보고는 구별되지 않는다.**
//
// 그래서 검사 한 줄씩 일부러 빼고, 그때 `approval-path-proof.mjs`가
// **빨개지는지** 본다. 안 빨개지면 그 규칙은 아무도 지키지 않는 것이다.
//
// 쓰는 법
//   PROOF_DB_URL=postgresql://... node scripts/approval-path-mutations.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const RUNNER = 'scripts/apply-migrations.mjs';
const PROOF = 'scripts/approval-path-proof.mjs';

const DB = process.env.PROOF_DB_URL || '';
if (!DB) { console.error('PROOF_DB_URL이 필요합니다'); process.exit(1); }
function hostOf(url) {
  const q = /[?&]host=([^&]+)/.exec(url);
  if (q) return decodeURIComponent(q[1]);
  return url.replace(/^[a-z]+:\/\//, '').replace(/^[^@/]*@/, '').replace(/[:/?].*$/, '');
}
const HOST = hostOf(DB);
if (!(HOST.startsWith('/') || ['localhost', '127.0.0.1', '::1', 'db', 'postgres'].includes(HOST))) {
  console.error(`거부: 접속 대상이 로컬이 아닙니다 (${HOST})`);
  process.exit(1);
}

const canonical = readFileSync(RUNNER, 'utf8');
const restore = () => writeFileSync(RUNNER, canonical);

/** 증명이 초록인가. **마지막 통과 문구까지** 본다 — 종료코드만으로는 부족하다. */
function proofGreen() {
  try {
    const out = execFileSync(process.execPath, [PROOF],
      { stdio: 'pipe', encoding: 'utf8', env: { ...process.env, PROOF_DB_URL: DB } });
    return /승인 경로 증명 전부 통과/.test(out);
  } catch { return false; }
}

// ── 무엇을 빼 보는가 ──
//
// 전부 "검사 한 덩어리를 통째로 없앤다". 조건을 살짝 뒤집는 것보다 이쪽이
// 실제로 일어나는 헐거워짐(리팩터링하다 통째로 날림)에 가깝다.
const MUTATIONS = [
  {
    name: '순서 건너뛰기 차단 제거 — 앞이 막혀 있어도 뒤엣것을 먼저 적용한다',
    cut: [
      "  const beforeApproved = plan.pending.slice(0, plan.pending.indexOf(APPROVAL.name));\n"
      + "  const blockedBefore = beforeApproved.filter(n => plan.blocked.some(b => b.name === n));\n"
      + "  if (blockedBefore.length > 0) {", "  if (false) {\n    const blockedBefore = [];"],
  },
  {
    name: 'DESTRUCTIVE 한정 제거 — UNKNOWN도 이름만 보고 통과한다',
    cut: ["  if (entry.risk !== 'DESTRUCTIVE') {", '  if (false) {'],
  },
  {
    name: '막혀 있는지 확인 제거 — 안전한 파일도 승인 경로로 들어온다',
    cut: ['  if (!entry) {', '  if (false && !entry) {'],
  },
  {
    name: '이미 적용됨 확인 제거',
    cut: ['  if (plan.applied.includes(APPROVAL.name)) {', '  if (false) {'],
  },
  {
    name: '목록에 있는 이름인지 확인 제거',
    cut: ['  if (!f) {', '  if (false && !f) {'],
  },
  {
    name: '승인 커밋 일치 확인 제거 — 옛 승인이 새 내용에 계속 유효해진다',
    cut: ['  if (RUNTIME_SHA !== sha) {', '  if (false) {'],
  },
  {
    name: '체크섬 일치 확인 제거',
    cut: ["  if (APPROVAL.checksum != null && APPROVAL.checksum !== sum) {", '  if (false) {'],
  },
  {
    // 하나만 빼면 바로 아래 형식 검사가 대신 막는다(APPROVAL_INVALID로 끝난다).
    // 실험으로 확인했다 — 그래서 둘을 같이 뺀다.
    name: '커밋을 요구하는 검사를 **둘 다** 제거 (있는지 + 형식) — 서로를 가려 주는 짝이다',
    cuts: [
      ['  if (!sha) {', '  if (false) {'],
      ["  if (!/^[0-9a-f]{40}$/.test(sha)) {", '  if (false) {'],
    ],
  },
  {
    // 중복 검사만 빼면 값이 null이 되어 "승인 없음"으로 떨어지고, 그때
    // 「대상 없이 커밋만 왔다」 가드가 대신 막는다. 둘을 같이 빼야 드러난다.
    name: '중복 승인 방어를 **둘 다** 제거 (중복 검사 + 대상 없음 가드)',
    cuts: [
      ['    if (a.many) {', '    if (false) {'],
      ['    if (APPROVE_SHA_ARG.value != null || APPROVE_CHECKSUM_ARG.value != null) {',
       '    if (false) {'],
    ],
  },
  {
    // 앞 판에서는 이 줄을 **루프 뒤**에 넣어서 아무 효과가 없었다(등가). 위험한
    // 것은 "승인 하나가 막힌 것 전부를 자동 목록으로 밀어 넣는" 모양이므로,
    // 루프 **앞**에서 blocked 전체를 섞는다.
    name: '승인 하나로 막힌 것 전부를 autoApply에 섞는다 — 승인 범위가 무너진다',
    cut: ['for (const name of plan.autoApply) {\n  const f = files.find(x => x.name === name);\n  if (!(await applyOne(f)))',
          'if (approved) for (const b of plan.blocked) plan.autoApply.push(b.name);\nfor (const name of plan.autoApply) {\n  const f = files.find(x => x.name === name);\n  if (!(await applyOne(f)))'],
  },
];

let survivors = 0, anchorFails = 0;

console.log('── 정본 기준선 ──');
restore();
if (!proofGreen()) { console.log('  ✗ 정본이 빨갛다 — 아래 결과는 의미가 없다'); process.exit(1); }
console.log('  ✓ 정본 GREEN');

console.log('\n── 뮤테이션 ──');
for (const m of MUTATIONS) {
  // `cuts`가 여럿인 항목은 **서로를 가려 주는 짝**이다 — 하나만 빼면 뒤따르는
  // 검사가 대신 막아서 행동이 안 바뀐다(등가 뮤테이션). 그때는 같이 빼야
  // 규칙이 드러난다.
  const cuts = m.cuts || [m.cut];
  let mutated = canonical, missing = null;
  for (const [oldText, newText] of cuts) {
    if (!mutated.includes(oldText)) { missing = oldText.slice(0, 60); break; }
    mutated = mutated.replace(oldText, newText);
  }
  if (missing !== null) {
    // **적용되지 않은 뮤테이션을 통과로 적지 않는다.**
    console.log(`  ‼ ${m.name}\n      앵커가 낡았습니다: ${JSON.stringify(missing)}`);
    anchorFails += 1;
    continue;
  }
  writeFileSync(RUNNER, mutated);
  const green = proofGreen();
  console.log(green
    ? `  ✗ ${m.name}\n      초록이다 — 이 검사를 지켜보는 것이 없다`
    : `  ✓ ${m.name}\n      RED`);
  if (green) survivors += 1;
  restore();
}

console.log('\n── 주석만 바꾼 대조군 ──');
{
  const ctrl = canonical.replace('// ── 5~7. 적용 · 확인 · 기록 ──',
    '// ── 5~7. 적용 · 확인 · 기록 ── (대조군: 주석만 바꿨다)');
  if (ctrl === canonical) { console.log('  ‼ 대조군 앵커가 낡았습니다'); anchorFails += 1; }
  else {
    writeFileSync(RUNNER, ctrl);
    const green = proofGreen();
    console.log(green
      ? '  ✓ 주석만 바꾼 판은 GREEN — 검사가 글자에 반응하지 않는다'
      : '  ✗ 주석만 바꿨는데 빨갛다 — 검사가 조건이 아니라 글자를 보고 있다');
    if (!green) survivors += 1;
    restore();
  }
}

restore();
console.log('');
if (survivors || anchorFails) {
  console.log(`승인 경로 뮤테이션 실패 — 살아남은 뮤테이션 ${survivors}건 · 낡은 앵커 ${anchorFails}건`);
  process.exit(1);
}
console.log(`뮤테이션 ${MUTATIONS.length}건 전부 RED · 주석 대조군 GREEN`);

#!/usr/bin/env node
// scripts/paper-challenge-wiring-mutations.mjs
//
// **배선 규칙을 하나씩 빼고, 그때 검사가 빨개지는지 본다.**
//
// `087` 쪽은 DB 뮤테이션이 따로 본다. 여기서 보는 것은 **앱 쪽 배선**이고,
// 이 PR의 진짜 위험이 거기 있다: 챌린지를 못 찾았을 때 **기본 계좌로 한 줄
// 내려가면** 사용자가 고른 적 없는 장부로 주문이 나간다. 그 한 줄이 들어와도
// 검사가 초록이면, 검사는 있으나 마나다.
//
// 무엇이 빨개져야 통과인가
// ────────────────────────
// 배선 검사기(`scripts/check-paper-challenge-wiring.mjs`) **또는** 시험
// (`npm test`) 중 하나라도 실패하면 RED다. 둘을 다 보는 이유: 폴백처럼
// **코드의 모양**으로만 잡히는 것과, 판정처럼 **값**으로만 잡히는 것이
// 섞여 있기 때문이다.
//
// 이 스크립트는 파일을 고쳤다가 반드시 되돌린다. DB에 닿지 않는다.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CHECK = 'scripts/check-paper-challenge-wiring.mjs';

const FILES = [
  'src/app/api/paper/order/route.ts',
  'src/app/api/paper/positions/route.ts',
  'src/app/api/paper/challenge/[id]/cancel/route.ts',
  'src/lib/engine/paperChallengeScope.ts',
  'src/lib/engine/paperChallengeApi.ts',
];
const canonical = new Map(FILES.map(f => [f, readFileSync(f, 'utf8')]));
const restore = () => { for (const [f, s] of canonical) writeFileSync(f, s); };

function checkerGreen() {
  try { execFileSync(process.execPath, [CHECK], { stdio: 'pipe' }); return true; }
  catch { return false; }
}
function testsGreen() {
  try { execFileSync('npm', ['test'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

// ── 무엇을 빼 보는가 ──
const MUTATIONS = [
  {
    name: '못 찾은 챌린지를 기본 계좌로 대신 처리한다 — 고른 적 없는 장부로 주문이 나간다',
    file: 'src/lib/engine/paperChallengeScope.ts',
    cut: ['    if (challengeScopeFailed(cs)) {\n'
        + "      return { ok: false, code: cs.code, reason: cs.reason, kind: 'CHALLENGE' };\n"
        + '    }',
          '    if (challengeScopeFailed(cs)) {\n'
        + '      const ps = await resolvePaperScope(sb, userId);\n'
        + "      return { ok: true, accountId: (ps as any).accountId, kind: 'DEFAULT',\n"
        + '        challengeId: null, challengeStatus: null };\n'
        + '    }'],
  },
  {
    name: '상태 관문을 금지 목록으로 바꾼다 — READY에서 주문이 열린다',
    file: 'src/lib/engine/paperChallengeScope.ts',
    cut: ["  if (status === 'RUNNING') return { allowed: true, reason: '진행 중인 챌린지입니다' };\n"
        + "  if (status === 'READY') {",
          "  if (status !== 'CLOSING' && status !== 'CLOSED') {\n"
        + "    return { allowed: true, reason: '진행 중인 챌린지입니다' };\n"
        + '  }\n'
        + "  if (status === 'READY') {"],
  },
  {
    name: '남의 챌린지와 없는 챌린지에 다른 답을 준다 — 존재가 새어 나간다',
    file: 'src/lib/engine/paperChallengeScope.ts',
    cut: ["        ok: false, code: 'NOT_FOUND',\n"
        + "        reason: '챌린지를 찾지 못했습니다 — 기본 계좌로 대신 처리하지 않습니다',",
          "        ok: false, code: 'NOT_FOUND',\n"
        + "        reason: `챌린지 ${cid}는 다른 사용자의 것입니다`,"],
  },
  {
    name: 'challengeId를 아무 문자열이나 받는다 — 값이 그대로 질의에 들어간다',
    file: 'src/lib/engine/paperChallengeScope.ts',
    cut: ['  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) {\n'
        + '    return null;\n'
        + '  }',
          '  // (뮤테이션) 모양을 보지 않는다'],
  },
  {
    name: '체결에 챌린지 계좌를 안 넘긴다 — 미리보기는 챌린지, 체결은 기본 계좌',
    file: 'src/app/api/paper/order/route.ts',
    cut: ['    paperAccountId: challengeAccountId ?? undefined,\n', ''],
  },
  {
    name: '챌린지 경로에서도 getPaperAccount를 부른다 — 아무도 고르지 않은 계좌가 생긴다',
    file: 'src/app/api/paper/order/route.ts',
    cut: ['const acct = challengeAccountId ? null : await getPaperAccount(sb, uid);',
          'const acct = await getPaperAccount(sb, uid);'],
  },
  {
    name: '일일손실을 기본 계좌로 본다 — 남의 장부 손익이 챌린지 주문을 막는다',
    file: 'src/app/api/paper/order/route.ts',
    cut: ['collectPaperDailyLoss({ sb, userId: uid, paperAccountId: challengeAccountId })',
          'collectPaperDailyLoss({ sb, userId: uid })'],
  },
  {
    name: 'signal_id가 장부를 구별하지 않는다 — 같은 분의 두 장부 주문이 서로를 막는다',
    file: 'src/app/api/paper/order/route.ts',
    cut: ['-${ledgerKey}-${market}', '-${market}'],
  },
  {
    name: '주문이 계좌 id를 본문에서 받는다 — 남의 계좌 id를 넣어 볼 수 있다',
    file: 'src/app/api/paper/order/route.ts',
    cut: ["const rawChallengeId = typeof body?.challengeId === 'string' ? body.challengeId.trim() : '';",
          "const rawChallengeId = typeof body?.challengeId === 'string' ? body.challengeId.trim() : '';\n"
        + "  const forcedAccount = typeof body?.paperAccountId === 'string' ? body.paperAccountId : null;"],
  },
  {
    name: '취소가 포지션을 직접 닫는다 — 정산 경로가 둘이 된다',
    file: 'src/app/api/paper/challenge/[id]/cancel/route.ts',
    cut: ['  const view = challengeCancelView(row?.code, row?.close_intent);',
          '  const { closePaperPosition } = await import(\'@/lib/engine/paperStore\');\n'
        + '  const view = challengeCancelView(row?.code, row?.close_intent);'],
  },
  {
    name: '취소가 소유자를 함수에 안 넘긴다 — 남의 챌린지가 취소된다',
    file: 'src/app/api/paper/challenge/[id]/cancel/route.ts',
    cut: ['      p_user: uid,', '      p_user: null,'],
  },
  {
    name: '취소 사건 시각을 요청 본문에서 받는다 — 사용자가 판정 시각을 정한다',
    file: 'src/app/api/paper/challenge/[id]/cancel/route.ts',
    cut: ['      p_event_effective_at: paperEventTimeNow(),',
          '      p_event_effective_at: (await req.json())?.eventEffectiveAt,'],
  },
  {
    name: '조회가 못 찾은 챌린지 대신 기본 계좌를 보여 준다',
    file: 'src/app/api/paper/positions/route.ts',
    cut: ['      accountId = cs.accountId;\n'
        + '      // 챌린지 계좌는 **찾기만 한다.**',
          '      accountId = (await resolvePaperScope(sb, userId) as any).accountId;\n'
        + '      // 챌린지 계좌는 **찾기만 한다.**'],
  },
  {
    name: '인증 없이 청산가를 받는 POST가 다시 생긴다',
    file: 'src/app/api/paper/positions/route.ts',
    cut: ['export async function POST() {\n'
        + '  return NextResponse.json({\n'
        + "    ok: false, error: 'gone',",
          'export async function POST(req: NextRequest) {\n'
        + '  const body = await req.json();\n'
        + '  const exitPrice = Number(body?.exitPrice);\n'
        + '  return NextResponse.json({\n'
        + "    ok: false, error: 'gone',"],
  },
  {
    name: '얼어 있는 다른 사유를 "취소했습니다"로 적는다',
    file: 'src/lib/engine/paperChallengeApi.ts',
    cut: ["    case 'INTENT_FROZEN':\n      return {\n        http: 409, ok: false,",
          "    case 'INTENT_FROZEN':\n      return {\n        http: 200, ok: true,"],
  },
  {
    name: '모르는 취소 결과를 성공으로 적는다',
    file: 'src/lib/engine/paperChallengeApi.ts',
    cut: ['      return {\n        http: 500, ok: false,\n'
        + "        message: `취소 결과를 읽지 못했습니다 (${code || '없음'})",
          '      return {\n        http: 200, ok: true,\n'
        + "        message: `취소 결과를 읽지 못했습니다 (${code || '없음'})"],
  },
  {
    name: '못 읽은 잔고를 0으로 적는다 — "전액을 잃었다"로 보인다',
    file: 'src/lib/engine/paperChallengeApi.ts',
    cut: ['  const bal = maybeNum(balance);', '  const bal = Number(balance) || 0;'],
  },
  {
    name: '화면에 계좌 id를 내보낸다 — challengeId 하나라는 계약이 깨진다',
    file: 'src/lib/engine/paperChallengeApi.ts',
    cut: ['    id: String(row?.id ?? \'\'),',
          '    id: String(row?.id ?? \'\'),\n'
        + '    paperAccountId: String(row?.paper_account_id ?? \'\'),'],
  },
  {
    name: '시작·종료 시각을 요청에서 받는다 — 유효기간을 과거로 적을 수 있다',
    file: 'src/lib/engine/paperChallengeApi.ts',
    cut: ['    params: { initialEquity: initial, targetEquity: target, failureEquity: failure, durationDays: days },',
          '    params: { initialEquity: initial, targetEquity: target, failureEquity: failure, durationDays: days,\n'
        + '      startsAt: body?.startsAt, endsAt: body?.endsAt } as any,'],
  },
];

let survivors = 0, anchorFails = 0;

console.log('── 정본 기준선 ──');
restore();
if (!checkerGreen()) { console.log('  ✗ 정본에서 배선 검사기가 빨갛다'); process.exit(1); }
if (!testsGreen())   { console.log('  ✗ 정본에서 시험이 빨갛다'); process.exit(1); }
console.log('  ✓ 정본 GREEN (검사기 · 시험)');

console.log('\n── 뮤테이션 ──');
for (const m of MUTATIONS) {
  const base = canonical.get(m.file);
  const [oldText, newText] = m.cut;
  if (!base.includes(oldText)) {
    // **적용되지 않은 뮤테이션을 통과로 적지 않는다.**
    console.log(`  ‼ ${m.name}\n      앵커가 낡았습니다: ${JSON.stringify(oldText.slice(0, 70))}`);
    anchorFails += 1;
    continue;
  }
  writeFileSync(m.file, base.replace(oldText, newText));

  let why = null;
  if (!checkerGreen())    why = 'RED (배선 검사기)';
  else if (!testsGreen()) why = 'RED (시험)';

  console.log(why
    ? `  ✓ ${m.name}\n      ${why}`
    : `  ✗ ${m.name}\n      초록이다 — 이 규칙을 지켜보는 것이 없다`);
  if (!why) survivors += 1;
  restore();
}

console.log('\n── 주석만 바꾼 대조군 ──');
{
  const f = 'src/lib/engine/paperChallengeScope.ts';
  const base = canonical.get(f);
  const ctrl = base.replace('// **챌린지 id 하나로 "어느 장부에 적을 것인가"를 정한다.**',
    '// **챌린지 id 하나로 "어느 장부에 적을 것인가"를 정한다.** (대조군)');
  if (ctrl === base) { console.log('  ‼ 대조군 앵커가 낡았습니다'); anchorFails += 1; }
  else {
    writeFileSync(f, ctrl);
    const green = checkerGreen() && testsGreen();
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
  console.log(`챌린지 배선 뮤테이션 실패 — 살아남은 뮤테이션 ${survivors}건 · 낡은 앵커 ${anchorFails}건`);
  process.exit(1);
}
console.log(`뮤테이션 ${MUTATIONS.length}건 전부 RED · 주석 대조군 GREEN`);

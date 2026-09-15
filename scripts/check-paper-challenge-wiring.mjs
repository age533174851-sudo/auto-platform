#!/usr/bin/env node
// scripts/check-paper-challenge-wiring.mjs
//
// **챌린지 배선이 조용히 기본 계좌로 새는 것을 막는다.**
//
// 이 PR이 만든 위험은 하나다: 이제 사용자의 장부가 둘 이상이고, 어느 한
// 자리가 계좌를 안 좁히거나 못 찾았을 때 기본 계좌로 내려가면 **사용자가
// 고른 적 없는 장부로 주문이 나간다.** 시험으로 잡히는 것도 있지만,
// 시험은 "지금 있는 호출부"만 본다. 여기서는 **코드의 모양**을 본다.
//
// 무엇을 보는가
// ─────────────
//   ① 주문·조회 라우트가 `paperAccountId`를 **본문/쿼리에서 받지 않는다**
//   ② 챌린지 경로에서 `getPaperAccount`(기본 계좌를 만드는 함수)를 부르지 않는다
//   ③ 챌린지 해석 실패가 전부 **거부**다 — `|| default` 류 폴백이 없다
//   ④ 사건 시각을 요청에서 읽지 않는다
//   ⑤ 취소 라우트·`087`이 **돈을 만들지 않는다**
//   ⑥ `087`이 계좌 → 챌린지 순으로 잠그고, 사유를 덮지 않고, 같은 전이 키를 쓴다
//   ⑦ 상태 관문이 **허용 목록**이다 (금지 목록이면 상태가 늘 때 조용히 열린다)
//   ⑧ 모의 청산 경로가 **하나뿐**이다
import { readFileSync, readdirSync } from 'node:fs';

const ORDER     = 'src/app/api/paper/order/route.ts';
const POSITIONS = 'src/app/api/paper/positions/route.ts';
const CANCEL    = 'src/app/api/paper/challenge/[id]/cancel/route.ts';
const CREATE    = 'src/app/api/paper/challenge/route.ts';
const SCOPE     = 'src/lib/engine/paperChallengeScope.ts';
const MIG       = 'supabase/migrations/087_paper_challenge_cancel.sql';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };
const read = (p) => {
  try { return readFileSync(p, 'utf8'); }
  catch { err(`${p}를 읽지 못했습니다 — 확인하지 못한 것을 통과로 적지 않습니다`); return ''; }
};
/** 주석을 뺀 본문. 규칙을 주석으로 만족시키지 못하게 한다. */
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');

const order = read(ORDER), positions = read(POSITIONS);
const cancel = read(CANCEL), create = read(CREATE);
const scope = read(SCOPE), mig = read(MIG);

const orderC = code(order), positionsC = code(positions);
const cancelC = code(cancel), createC = code(create), scopeC = code(scope);
const migC = code(mig);

// ── ① 계좌 id는 밖에서 오지 않는다 ──
//
// 받는 순간 "이 계좌가 무엇인지" 아는 곳이 화면이 되고, 남의 계좌 id를 넣어
// 볼 수 있는 통로가 생긴다. 들어오는 것은 `challengeId` 하나다.
for (const [name, src] of [[ORDER, orderC], [POSITIONS, positionsC],
                           [CANCEL, cancelC], [CREATE, createC]]) {
  for (const m of src.matchAll(/body\?\.\s*([A-Za-z_]+)|searchParams\.get\('([^']+)'\)/g)) {
    const key = m[1] || m[2];
    if (/^(paperAccountId|paper_account_id|accountId|account_id|userId|user_id)$/.test(key)) {
      err(`${name}이 요청에서 ${key}를 읽습니다 — 장부는 challengeId로만 정합니다`);
    }
  }
}

// ── ④ 사건 시각은 서버가 만든다 ──
for (const [name, src] of [[ORDER, orderC], [POSITIONS, positionsC],
                           [CANCEL, cancelC], [CREATE, createC]]) {
  if (/(body|searchParams)[^\n]*(event_effective_at|eventEffectiveAt|startsAt|endsAt|starts_at|ends_at)/.test(src)) {
    err(`${name}이 요청에서 시각을 읽습니다 — 사건 시각과 기간은 서버가 정합니다`);
  }
}
if (!/paperEventTimeNow\(\)/.test(createC)) {
  err(`${CREATE}가 서버 사건 시각(paperEventTimeNow)을 쓰지 않습니다`);
}
if (!/paperEventTimeNow\(\)/.test(cancelC)) {
  err(`${CANCEL}가 서버 사건 시각(paperEventTimeNow)을 쓰지 않습니다`);
}

// ── ② 챌린지 경로에서 기본 계좌를 만들지 않는다 ──
//
// `getPaperAccount`는 기본 계좌를 찾고 **없으면 만든다.** 챌린지 경로에서
// 부르면 아무도 고르지 않은 계좌가 생긴다.
for (const [name, src, guard] of [
  [ORDER, orderC, /challengeAccountId\s*\?\s*null\s*:\s*await getPaperAccount\(/],
  [POSITIONS, positionsC, /\}\s*else\s*\{[\s\S]{0,400}?getPaperAccount\(/],
]) {
  if (/getPaperAccount\(/.test(src) && !guard.test(src)) {
    err(`${name}이 챌린지 경로에서도 getPaperAccount를 부를 수 있습니다`
      + ' — 그 함수는 기본 계좌를 만듭니다');
  }
}

// ── ③ 폴백이 없다 ──
//
// "못 찾으면 기본 계좌"는 한 줄이면 되고, 그 한 줄이 이 PR의 전체 위험이다.
for (const [name, src] of [[ORDER, orderC], [POSITIONS, positionsC], [SCOPE, scopeC]]) {
  if (/resolveChallengeScope\([^\n]*\)\s*\|\|/.test(src)
      || /challengeScopeFailed\([^)]*\)\s*\?\s*await\s+(resolvePaperScope|getPaperAccount)/.test(src)
      || /catch\s*\{[^}]*resolvePaperScope\(/.test(src)) {
    err(`${name}에 챌린지 실패 시 기본 계좌로 내려가는 폴백이 있습니다`);
  }
}
// 주문 라우트: 챌린지 해석 실패 세 가지가 전부 거부인가
for (const c of ['CHALLENGE_NOT_FOUND', 'CHALLENGE_UNREADABLE', 'CHALLENGE_NOT_RUNNING']) {
  if (!new RegExp(`counted\\(\\s*sb\\s*,\\s*(?:[^,]*\\?[^,]*:\\s*)?'${c}'`).test(orderC)
      && !new RegExp(`'${c}'`).test(orderC)) {
    err(`${ORDER}가 ${c}로 거부하는 자리가 없습니다`);
  }
}
// 미리보기와 최종 체결이 같은 계좌를 본다
//
// **`openPaperPosition` 쪽을 따로 본다.** 넓게 찾으면 바로 아래 일일손실
// 호출이 같은 글자를 가지고 있어서, 체결 쪽이 빠져도 초록이 된다 —
// 뮤테이션으로 실제로 그렇게 새는 것을 확인했다.
if (!/openPaperPosition\(sb,\s*\{[\s\S]*?paperAccountId:\s*challengeAccountId\s*\?\?\s*undefined/.test(orderC)) {
  err(`${ORDER}가 체결에 챌린지 계좌를 넘기지 않습니다`
    + ' — 미리보기는 챌린지 예산, 체결은 기본 계좌가 됩니다');
}
if (!/collectPaperDailyLoss\(\{[^}]*paperAccountId:\s*challengeAccountId/.test(orderC)) {
  err(`${ORDER}의 일일손실 판정이 같은 장부를 보지 않습니다`);
}
// 조회도 챌린지가 정한 계좌를 그대로 쓴다
if (!/accountId = cs\.accountId;/.test(positionsC)) {
  err(`${POSITIONS}가 챌린지가 정한 계좌를 쓰지 않습니다`
    + ' — 챌린지를 물어봤는데 다른 장부를 보여 줍니다');
}
// 같은 분의 같은 주문이 장부별로 구별되는가
if (!/ledgerKey/.test(orderC) || !/signalId\s*=\s*`[^`]*\$\{ledgerKey\}/.test(orderC)) {
  err(`${ORDER}의 signal_id가 장부를 구별하지 않습니다`
    + ' — 기본 계좌와 챌린지의 같은 주문이 서로를 DUPLICATE로 막습니다');
}

// ── ⑦ 상태 관문은 허용 목록이다 ──
if (!/status === 'RUNNING'/.test(scopeC)) {
  err(`${SCOPE}의 관문이 RUNNING 허용 목록이 아닙니다`);
}
if (/status !== 'CLOSED'|status !== 'CLOSING'|\['CLOSING',\s*'CLOSED'\]/.test(scopeC)) {
  err(`${SCOPE}의 관문이 금지 목록입니다 — 상태가 늘면 조용히 열립니다`);
}
{
  // 모르는 상태에서 allowed:true가 나오는 길이 있으면 안 된다
  const tail = scopeC.slice(scopeC.indexOf('export function challengeOrderGate'));
  const body = tail.slice(0, tail.indexOf('\n}\n') + 3);
  const allowTrue = [...body.matchAll(/allowed:\s*true/g)].length;
  if (allowTrue !== 1) err(`${SCOPE}의 관문에 allowed:true가 ${allowTrue}곳입니다 — 한 곳이어야 합니다`);
}

// ── ⑤ 취소는 돈을 만들지 않는다 ──
for (const forbidden of [
  'paper_settle_close', 'paper_money_apply', 'closePaperPosition',
  'paper_challenge_cashflows', 'paper_challenge_finalize', 'paper_positions',
]) {
  if (cancelC.includes(forbidden)) {
    err(`${CANCEL}가 ${forbidden}를 건드립니다 — 취소는 사유만 얼립니다`);
  }
}
if (/from\('paper_accounts'\)/.test(cancelC) || /\.update\(/.test(cancelC)) {
  err(`${CANCEL}가 계좌·표를 직접 씁니다 — 회계 권위는 085·086에 있습니다`);
}
if (!/rpc\('paper_challenge_cancel'/.test(cancelC)) {
  err(`${CANCEL}가 087의 paper_challenge_cancel을 부르지 않습니다`);
}
if (!/p_user:\s*uid/.test(cancelC)) {
  err(`${CANCEL}가 소유자를 함수에 넘기지 않습니다 — 남의 챌린지가 취소됩니다`);
}

// ── ⑤ 087도 돈을 만들지 않는다 ──
for (const forbidden of [
  'paper_challenge_cashflows', 'paper_money_apply', 'paper_settle_close',
  'UPDATE public.paper_accounts', 'INSERT INTO public.paper_accounts',
  'UPDATE public.paper_positions', 'DELETE FROM',
]) {
  if (migC.includes(forbidden)) {
    err(`${MIG}이 ${forbidden}를 씁니다 — 취소는 돈을 만들지 않습니다`);
  }
}
// ADDITIVE여야 한다
if (/\bDROP\s+(FUNCTION|TABLE|COLUMN|CONSTRAINT)\b/i.test(migC)
    || /\bALTER\s+TABLE\b/i.test(migC)) {
  err(`${MIG}이 ADDITIVE가 아닙니다 — 기존 것을 지우거나 바꿉니다`);
}

// ── ⑥ 잠금 순서 · 사유 동결 · 전이 키 ──
{
  const a = migC.indexOf('paper_accounts a WHERE a.id = v_acct FOR UPDATE');
  const c = migC.indexOf('FROM public.paper_challenges c\n   WHERE c.id = p_challenge AND c.user_id = p_user\n     FOR UPDATE');
  if (a < 0) err(`${MIG}이 계좌를 잠그지 않습니다`);
  if (c < 0) err(`${MIG}이 챌린지를 소유자와 함께 잠그지 않습니다`);
  if (a >= 0 && c >= 0 && a > c) {
    err(`${MIG}의 잠금 순서가 뒤집혔습니다 (챌린지 → 계좌) — 086과 순환 대기가 생깁니다`);
  }
}
if (!/v_ch\.intent IS NOT NULL THEN/.test(migC)) {
  err(`${MIG}이 이미 정해진 사유를 확인하지 않습니다 — 달성·만료를 취소로 덮습니다`);
}
if (!/AND c\.close_intent IS NULL/.test(migC)) {
  err(`${MIG}의 UPDATE에 사유 CAS가 없습니다`);
}
if (!/'INTENT:' \|\| p_challenge::TEXT/.test(migC)) {
  err(`${MIG}이 judge·sweep과 같은 전이 키를 쓰지 않습니다 — CLOSING 전이가 두 줄이 됩니다`);
}
if (!/paper_event_time_guard\(p_event_effective_at\)/.test(migC)) {
  err(`${MIG}이 사건 시각 신선도를 보지 않습니다`);
}
if (!/IF p_event_effective_at IS NULL THEN[\s\S]{0,200}?'22004'/.test(migC)) {
  err(`${MIG}이 사건 시각 없음을 **아무것도 읽기 전에** 거부하지 않습니다`);
}
{
  // **소유자 조건은 세 자리에 전부 있어야 한다** — 첫 조회 · 잠긴 재조회 · CAS.
  //
  // 한 자리만 빼는 뮤테이션은 나머지가 가려 주기 때문에 실행 증명으로는
  // 안 잡힌다(실험으로 확인했다). 그러면 그 한 줄은 다음 사람이 "중복이네"
  // 하고 지우고, 남은 하나까지 빠지는 날 남의 챌린지가 닫힌다.
  const n = [...migC.matchAll(/c\.user_id = p_user/g)].length;
  if (n < 3) {
    err(`${MIG}의 소유자 조건이 ${n}곳뿐입니다 — 첫 조회 · 잠긴 재조회 · CAS 셋 다 필요합니다`);
  }
}

// ── ⑧ 청산가는 **요청이 정하지 않는다** ──
//
// 여기 있던 `POST /api/paper/positions`는 인증 없이 `exitPrice`를 본문에서
// 받아 정산했다. 챌린지 전용 계좌가 생긴 지금 그 값은 곧 **자기 성적표를
// 직접 적는 길**이다 — 유리한 가격에 닫아 REALIZED_PNL을 만들고 목표를
// 달성한다. 그래서 경로를 막는 대신 **없앴고**, 여기서 다시 생기지 않게 한다.
//
// 청산하는 라우트는 있어도 된다(감시·스윕·수동청산). 없어야 하는 것은
// **청산가가 요청에서 오는 것**이다.
{
  const dir = 'src/app/api/paper';
  const routes = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name === 'route.ts') routes.push(p);
    }
  };
  try { walk(dir); } catch { err(`${dir}를 훑지 못했습니다`); }

  let sawCloser = false;
  for (const p of routes) {
    const src = code(readFileSync(p, 'utf8'));
    if (/closePaperPosition\(/.test(src)) sawCloser = true;
    // 요청에서 온 값이 청산가·손익으로 흘러드는가
    if (/(body|searchParams)[^\n]{0,80}(exitPrice|exit_price|realizedPnl|realized_pnl|pnl)/i.test(src)) {
      err(`${p}가 요청에서 청산가·손익을 읽습니다 — 성적표를 사용자가 적게 됩니다`);
    }
    // 청산가를 넘기는 자리는 서버가 만든 값이어야 한다
    for (const m of src.matchAll(/closePaperPosition\(\s*[^,]+,\s*([^,]+),/g)) {
      if (/body|params|req\./.test(m[1])) {
        err(`${p}가 요청에서 온 값으로 청산합니다 (${m[1].trim()})`);
      }
    }
  }
  if (!sawCloser) {
    err('모의 청산을 하는 라우트를 하나도 못 찾았습니다 — 검사가 대상을 잃었습니다');
  }
  // 예전 경로가 되살아나지 않았는가
  const pos = readFileSync(POSITIONS, 'utf8');
  if (/export async function POST\(req/.test(pos)) {
    err(`${POSITIONS}에 요청을 읽는 POST가 다시 생겼습니다 — 청산은 /api/paper/close 하나입니다`);
  }
}

if (bad > 0) {
  console.error(`\n챌린지 배선 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ 챌린지 배선 — 계좌 id 비수신 · 기본 계좌 폴백 없음 · 서버 사건 시각 ·'
  + ' 취소는 사유만 동결 · 계좌→챌린지 잠금 · 허용 목록 관문 · 청산가 비수신');

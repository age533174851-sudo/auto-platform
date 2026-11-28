// scripts/test-paper-money-path.mjs
//
// **부분일치는 돈 경로의 계약을 보증하지 못한다.**
//
// `node --test scripts/test-*.mjs` (ci.yml의 글롭)에 자동으로 걸린다.
//
// 무엇이 실제로 이랬나 (기준 main ed00c1a4, fixture 탐침으로 돌려서 얻은 값)
// ───────────────────────────────────────────────────────────────────
// `scripts/lib/paper-money-path.mjs`는 `check-paper-open-atomic`과
// `check-paper-capacity` **둘이 함께 쓰는 돈 경로 판정 정본**이다. 계약은
// 두 가지다: 잔고를 증감식으로 밀고(읽고 덮어쓰지 않고), 계좌 갱신이 0행이면
// 진입을 되돌린다.
//
// 그 판정이 **본문 전체에 대한 부분일치**였다. 085의 실제
// `paper_money_apply`에는 입력 검증용 `RAISE EXCEPTION`이 **두 개 따로**
// 있다(사건 시각 없음·금액 없음). 그래서 0행 분기의 `RAISE`를 무해한 것으로
// 바꿔도 그 둘이 접속을 채웠다:
//
//   대조 · 원문 그대로                        rc=0  OK
//   대조 ★★ 0행 분기를 통째로 지운다            rc=1  OK
//   IF NOT FOUND THEN RETURN;                rc=0  구멍
//   IF NOT FOUND THEN RAISE WARNING '…';     rc=0  구멍
//   IF NOT FOUND THEN NULL;                  rc=0  구멍
//   SET balance = v_row.balance + p_amount   rc=0  구멍
//
// 앞 세 줄은 **포지션만 남고 수수료가 안 빠진 계좌**를 만든다 — 이 판정이
// 막으려던 바로 그 상태다. 마지막 줄은 **앞서 읽어 둔 값으로 덮어쓰는 것**
// 이고, 같은 계좌에서 동시에 끝난 두 건 중 한쪽 손익이 사라진다.
//
// 네 번째 줄의 기제는 주석이 아니다. 예전 정규식이
// `balance = <무엇이든>.balance ±`를 전부 받았다 — `a.balance`(갱신 대상의
// 별칭)를 받으려던 것인데 plpgsql **변수**도 같이 통과했다.
//
// 두 호출부는 이미 SQL 주석을 걷어내고 넘긴다(그 고장을 겪고 고친 흔적이
// 그쪽 주석에 있다). 그래서 이 시험은 주석이 아니라 **구문 범위**를 본다.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { feeDeductionContract, migrationCorpus, plpgsqlBody } from './lib/paper-money-path.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG = join(ROOT, 'supabase', 'migrations');

/** 호출부와 같은 뜻으로 `--` 주석만 뗀다 (문자열 안은 건드리지 않는다) */
function stripSqlLineComments(src) {
  return String(src).split('\n').map((line) => {
    let out = '';
    let inStr = false;
    for (let i = 0; i < line.length; i += 1) {
      if (inStr) { out += line[i]; if (line[i] === "'") inStr = false; continue; }
      if (line[i] === "'") { inStr = true; out += line[i]; continue; }
      if (line[i] === '-' && line[i + 1] === '-') break;
      out += line[i];
    }
    return out;
  }).join('\n');
}

const corpus = () => stripSqlLineComments(migrationCorpus({ readdirSync, readFileSync }, MIG));

/** 진입 함수 본문 — 실제 전수에서 뽑는다 */
const openBody = () => {
  const r = plpgsqlBody(corpus(), 'public.paper_open_position');
  assert.equal(r.ok, true, `진입 함수를 읽지 못했다: ${r.ok ? '' : r.reason}`);
  return r.body;
};

/** 085 의 돈 함수 본문을 바꿔 넣은 전수 */
const corpusWith = (replace) => {
  const src = corpus();
  const next = replace(src);
  assert.notEqual(next, src, '변이가 적용되지 않았다 — 이 시험은 아무것도 재지 않는다');
  return next;
};

// ── 대조 — 지금 저장소는 계약을 지킨다 ──────────────────────────
test('대조 — 지금 저장소의 수수료 경로는 계약을 지킨다', () => {
  const r = feeDeductionContract({ sql: corpus(), fnBody: openBody() });
  assert.equal(r.ok, true, `지금 트리가 막히면 검사기가 거짓말을 한다: ${r.ok ? '' : r.reason}`);
  assert.equal(r.where, 'delegated');
});

// ── ★ 0행 분기 밖의 RAISE 는 세지 않는다 ───────────────────────
const NOROWS = /IF NOT FOUND THEN\s*\n\s*RAISE EXCEPTION 'paper_money_apply: 계좌를 찾지 못했습니다[^;]*;/;

for (const [how, branch] of [
  ['RETURN', 'IF NOT FOUND THEN\n    RETURN;'],
  ['RAISE WARNING', "IF NOT FOUND THEN\n    RAISE WARNING 'paper_money_apply: 계좌 없음';"],
  ['빈 분기', 'IF NOT FOUND THEN\n    NULL;'],
]) {
  test(`★ 0행 분기를 ${how} 으로 바꾸면 막는다 (다른 RAISE 가 접속을 채우지 않는다)`, () => {
    const sql = corpusWith(s => s.replace(NOROWS, branch));
    const r = feeDeductionContract({ sql, fnBody: openBody() });
    assert.equal(r.ok, false, '포지션만 남고 수수료가 안 빠진 계좌가 된다');
    assert.match(r.reason, /되돌리지 않습니다/);
  });
}

test('대조 — 0행 분기 안의 RAISE EXCEPTION 은 통과한다', () => {
  const sql = corpusWith(s => s.replace(NOROWS,
    "IF NOT FOUND THEN\n    RAISE EXCEPTION 'paper_money_apply: 계좌 없음 — 되돌립니다';"));
  const r = feeDeductionContract({ sql, fnBody: openBody() });
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
});

test('대조 — 0행 분기 안에 중첩 IF 가 있어도 끊어 읽는다', () => {
  const sql = corpusWith(s => s.replace(NOROWS,
    "IF NOT FOUND THEN\n"
    + "    IF p_amount < 0 THEN\n"
    + "      RAISE NOTICE 'negative';\n"
    + "    END IF;\n"
    + "    RAISE EXCEPTION 'paper_money_apply: 계좌 없음';"));
  const r = feeDeductionContract({ sql, fnBody: openBody() });
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
});

test('★ 중첩 IF 안의 RAISE 는 바깥 분기의 되돌림이 아니다', () => {
  // 0행 분기 안에 중첩 분기만 있고 그 안에서만 RAISE 하면, 조건이 거짓일 때
  // 되돌리지 않는다. 그래도 **분기 안**이므로 이 판정은 통과시킨다 —
  // 여기까지 보려면 조건의 의미를 알아야 하고, 그것은 이 정적 판정의
  // 범위 밖이다. 닫았다고 적지 않기 위해 그 사실을 시험으로 남긴다.
  const sql = corpusWith(s => s.replace(NOROWS,
    "IF NOT FOUND THEN\n    IF false THEN\n      RAISE EXCEPTION 'never';\n    END IF;"));
  const r = feeDeductionContract({ sql, fnBody: openBody() });
  assert.equal(r.ok, true,
    '이 방향은 아직 열려 있다 — 분기 조건의 의미는 이 판정의 범위 밖이다');
});

// ── ★ 수식어가 붙은 오른쪽은 갱신 대상의 것이어야 한다 ──────────
test('★ 잔고를 plpgsql 변수로 덮어쓰면 막는다', () => {
  for (const rhs of ['v_row.balance + p_amount', 'v_prev.balance - p_amount']) {
    const sql = corpusWith(s => s.replace('SET balance    = balance + p_amount,',
      `SET balance    = ${rhs},`));
    const r = feeDeductionContract({ sql, fnBody: openBody() });
    assert.equal(r.ok, false, `${rhs} 는 앞서 읽어 둔 값으로 덮어쓰는 것이다`);
    assert.match(r.reason, /증감식으로 밀지 않습니다/);
  }
});

test('대조 — 갱신 대상의 별칭으로 수식한 것은 통과한다', () => {
  const sql = corpusWith(s => s.replace(
    'UPDATE public.paper_accounts\n     SET balance    = balance + p_amount,',
    'UPDATE public.paper_accounts AS a\n     SET balance    = a.balance + p_amount,'));
  const r = feeDeductionContract({ sql, fnBody: openBody() });
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
});

test('대조 — 표 이름으로 수식한 것도 통과한다', () => {
  const sql = corpusWith(s => s.replace('SET balance    = balance + p_amount,',
    'SET balance    = paper_accounts.balance + p_amount,'));
  const r = feeDeductionContract({ sql, fnBody: openBody() });
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
});

test('★ 잔고를 읽어 계산한 값으로 덮어쓰면 막는다', () => {
  const sql = corpusWith(s => s.replace('SET balance    = balance + p_amount,',
    'SET balance    = v_new_balance,'));
  const r = feeDeductionContract({ sql, fnBody: openBody() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /증감식으로 밀지 않습니다/);
});

// ── 넘긴 곳을 못 읽으면 통과시키지 않는가 ──────────────────────
test('★ 돈 함수가 사라지면 통과시키지 않는다', () => {
  const sql = corpusWith(s => s.replace(/CREATE OR REPLACE FUNCTION public\.paper_money_apply/g,
    'CREATE OR REPLACE FUNCTION public.paper_money_gone'));
  const r = feeDeductionContract({ sql, fnBody: openBody() });
  assert.equal(r.ok, false, '넘겼다는 말만 믿으면 받는 쪽이 사라져도 초록이 된다');
  assert.match(r.reason, /확인할 수 없습니다/);
});

test('★ 수수료를 양수로 넘기면 막는다', () => {
  const body = openBody().replace(/-\s*p_entry_fee/g, 'p_entry_fee');
  const r = feeDeductionContract({ sql: corpus(), fnBody: body });
  assert.equal(r.ok, false, '양수로 넘기면 수수료가 잔고에 더해진다');
});

// ── plpgsqlBody — 마지막 정의가 실제로 도는 것이다 ─────────────
test('plpgsqlBody 는 마지막 정의를 읽는다', () => {
  const sql = 'CREATE FUNCTION public.f() RETURNS void AS $$ BEGIN OLD_BODY; END $$;\n'
    + 'CREATE OR REPLACE FUNCTION public.f() RETURNS void AS $$ BEGIN NEW_BODY; END $$;';
  const r = plpgsqlBody(sql, 'public.f');
  assert.equal(r.ok, true);
  assert.match(r.body, /NEW_BODY/);
  assert.doesNotMatch(r.body, /OLD_BODY/);
});

test('plpgsqlBody 는 여는 표식과 같은 표식으로 닫는다', () => {
  const sql = 'CREATE FUNCTION public.f() RETURNS void AS $fn$ BEGIN\n'
    + "  PERFORM 'a $$ b';\nEND $fn$;";
  const r = plpgsqlBody(sql, 'public.f');
  assert.equal(r.ok, true);
  assert.match(r.body, /PERFORM/);
});

test('plpgsqlBody — 없는 함수는 못 읽었다고 한다', () => {
  const r = plpgsqlBody('SELECT 1;', 'public.nope');
  assert.equal(r.ok, false);
  assert.match(r.reason, /찾지 못했습니다/);
});

// ── inline 갈래도 같은 수식어 판정을 쓴다 (Codex 지적) ──────────────
//
// `movesByDelta`만 고치고 `inlineDelta`에 있던 **같은 정규식의 사본**을
// 그대로 뒀다. 그래서 위임 갈래(085 이후)에서는 막히는 것이 **inline
// 갈래(074–084)에서는 계속 통과했다.** 돌려서 얻은 값 — 네 가지 모두
// `ok:true, where:'inline'`:
//
//   balance - p_entry_fee            허용  옳다
//   a.balance - p_entry_fee          허용  옳다 (대상 별칭)
//   v_row.balance - p_entry_fee      허용  ← 구멍
//   v_prev.balance - p_entry_fee     허용  ← 구멍
//
// 이 저장소가 이름 붙여 둔 고장 그대로다 — **"경로가 둘인데 한쪽만 고침".**
// 그래서 수식어 판정을 `qualifierIsTarget` 한 곳에 두고 양쪽이 같은 함수를
// 쓴다.
//
// 074–084 의 진입 함수는 수수료를 **함수 안에서 직접** 뺐다. 그 갈래는
// 지금 전수에는 없지만(085 가 위임 구조로 바꿨다) 판정에 남아 있고,
// 남아 있는 한 같은 계약을 지켜야 한다.
const inlineBody = (rhs, { alias = false, noRows = true } = {}) => `
DECLARE v_row record; v_prev record; p_entry_fee numeric := 1; p_account_id uuid;
BEGIN
  SELECT * INTO v_row FROM public.paper_accounts WHERE id = p_account_id;
  UPDATE public.paper_accounts${alias ? ' AS a' : ''}
     SET balance = ${rhs} WHERE id = p_account_id;
  ${noRows ? "IF NOT FOUND THEN RAISE EXCEPTION 'missing'; END IF;" : 'NULL;'}
END;`;

for (const [how, rhs] of [
  ['v_row.balance', 'v_row.balance - p_entry_fee'],
  ['v_prev.balance', 'v_prev.balance - p_entry_fee'],
]) {
  test(`★ inline 갈래 — ${how} 로 덮어쓰면 막는다`, () => {
    const r = feeDeductionContract({ sql: '', fnBody: inlineBody(rhs) });
    assert.equal(r.ok, false, `${how} 는 앞서 읽어 둔 record 값이다`);
  });
}

test('대조 — inline 갈래의 정당한 세 형태는 통과한다', () => {
  for (const [rhs, opt] of [
    ['balance - p_entry_fee', {}],
    ['a.balance - p_entry_fee', { alias: true }],
    ['paper_accounts.balance - p_entry_fee', {}],
  ]) {
    const r = feeDeductionContract({ sql: '', fnBody: inlineBody(rhs, opt) });
    assert.equal(r.ok, true, `서식만 다른 것이 막히면 거짓 실패다: ${rhs} — ${r.ok ? '' : r.reason}`);
    assert.equal(r.where, 'inline');
  }
});

test('대조 — inline 갈래도 0행 분기를 요구한다', () => {
  const r = feeDeductionContract({
    sql: '', fnBody: inlineBody('balance - p_entry_fee', { noRows: false }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /되돌리지 않습니다/);
});

test('★ inline 갈래도 0행 분기 밖의 RAISE 로는 통과하지 않는다', () => {
  // 입력 검증용 `RAISE EXCEPTION` 이 접속을 채우지 못해야 한다.
  const body = `
DECLARE p_entry_fee numeric := 1; p_account_id uuid;
BEGIN
  IF p_entry_fee IS NULL THEN RAISE EXCEPTION 'fee required'; END IF;
  UPDATE public.paper_accounts
     SET balance = balance - p_entry_fee WHERE id = p_account_id;
  IF NOT FOUND THEN RETURN; END IF;
END;`;
  const r = feeDeductionContract({ sql: '', fnBody: body });
  assert.equal(r.ok, false, '0행 분기가 되돌리지 않으면 통과시키면 안 된다');
  assert.match(r.reason, /되돌리지 않습니다/);
});

test('대조 — 두 갈래가 같은 수식어 판정을 쓴다', () => {
  // 같은 잘못된 수식어가 inline 과 delegated 양쪽에서 막혀야 한다.
  // 한쪽만 막히면 판정이 두 벌이라는 뜻이다.
  const inlineBad = feeDeductionContract({
    sql: '', fnBody: inlineBody('v_row.balance - p_entry_fee') });
  const delegatedBad = feeDeductionContract({
    sql: corpusWith(s => s.replace('SET balance    = balance + p_amount,',
      'SET balance    = v_row.balance + p_amount,')),
    fnBody: openBody(),
  });
  assert.equal(inlineBad.ok, false, 'inline 갈래가 통과시키면 판정이 두 벌이다');
  assert.equal(delegatedBad.ok, false, 'delegated 갈래가 통과시키면 판정이 두 벌이다');
});

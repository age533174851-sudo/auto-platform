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
    assert.match(r.reason, /balance \+ p_amount`로 밀지 않습니다/);
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
  assert.match(r.reason, /balance \+ p_amount`로 밀지 않습니다/);
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

// ── 산술식과 부호 (Codex 지적) ─────────────────────────────────────
//
// 예전 판정은 부호를 `[-+]` 둘 다 받고 **식 뒤를 보지 않았다.** 그래서
// 금액이 맞는지 아무도 확인하지 않았다. 돌려서 얻은 값 — 여섯 가지 모두
// `ok:true` 였다 (balance 100 · p_entry_fee 10 · p_amount = -10):
//
//   inline     balance - p_entry_fee * 0            → 100  수수료 안 빠짐
//   inline     balance - p_entry_fee + p_entry_fee  → 100  차감 상쇄
//   inline     balance - p_entry_fee * 2            →  80  두 배
//   delegated  balance - p_amount                   → 110  **수수료를 더한다**
//   delegated  balance + p_amount * 0               → 100
//   delegated  balance + p_amount * 2               →  80
//
// ★ `delegated`의 부호가 판정적이다. 호출부는
//   `paper_money_apply(…, -p_entry_fee)` 로 **음수를 넘긴다.** 그러므로
//   받는 쪽은 `balance + p_amount` 여야 하고, `balance - p_amount` 는
//   수수료를 **더하는** 방향이다. 부호 하나로 손익이 반대로 움직인다.
//
// 위 숫자는 산술 설명이고 PG 를 돌린 결과가 아니다.
const inlineFee = (rhs, alias = '') => ({
  sql: '',
  fnBody: `DECLARE p_entry_fee numeric := 10; p_account_id uuid;
BEGIN UPDATE public.paper_accounts${alias} SET balance = ${rhs} WHERE id = p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing'; END IF; END;`,
});

const delegatedFee = (rhs, alias = '') => ({
  sql: `CREATE FUNCTION public.paper_money_apply(p_account uuid, p_amount numeric)
  RETURNS void AS $money$
BEGIN
  UPDATE public.paper_accounts${alias} SET balance = ${rhs} WHERE id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing'; END IF;
END $money$ LANGUAGE plpgsql;`,
  fnBody: 'BEGIN PERFORM public.paper_money_apply(p_account_id, -p_entry_fee); END;',
});

for (const [how, rhs] of [
  ['0 배로 상쇄', 'balance - p_entry_fee * 0'],
  ['더해서 상쇄', 'balance - p_entry_fee + p_entry_fee'],
  ['두 배로 뺀다', 'balance - p_entry_fee * 2'],
  ['부호가 반대', 'balance + p_entry_fee'],
  ['다른 금액', 'balance - v_other'],
]) {
  test(`★ inline — ${how} (${rhs}) 를 막는다`, () => {
    const r = feeDeductionContract(inlineFee(rhs));
    assert.equal(r.ok, false, `식 뒤를 보지 않으면 금액이 맞는지 아무도 확인하지 않는다: ${rhs}`);
  });
}

test('★ delegated — balance - p_amount 는 수수료를 더하는 방향이다', () => {
  // 호출부가 음수를 넘기므로 `-` 는 부호가 겹쳐 더하기가 된다.
  const r = feeDeductionContract(delegatedFee('balance - p_amount'));
  assert.equal(r.ok, false, '부호 하나로 손익이 반대로 움직인다');
  assert.match(r.reason, /balance \+ p_amount`로 밀지 않습니다/);
});

for (const [how, rhs] of [
  ['0 배로 상쇄', 'balance + p_amount * 0'],
  ['두 배', 'balance + p_amount * 2'],
  ['다른 금액', 'balance + v_other'],
  ['뒤에 더하기', 'balance + p_amount + 1'],
]) {
  test(`★ delegated — ${how} (${rhs}) 를 막는다`, () => {
    const r = feeDeductionContract(delegatedFee(rhs));
    assert.equal(r.ok, false, `식 뒤를 보지 않으면 금액이 맞는지 아무도 확인하지 않는다: ${rhs}`);
  });
}

test('대조 — 정확한 식과 서식 차이는 통과한다', () => {
  for (const [kind, make, rhs, alias] of [
    ['inline', inlineFee, 'balance - p_entry_fee', ''],
    ['inline', inlineFee, 'a.balance - p_entry_fee', ' AS a'],
    ['inline', inlineFee, 'paper_accounts.balance - p_entry_fee', ''],
    ['inline', inlineFee, '(balance - p_entry_fee)', ''],
    ['inline', inlineFee, 'balance\n       -   p_entry_fee', ''],
    ['delegated', delegatedFee, 'balance + p_amount', ''],
    ['delegated', delegatedFee, 'a.balance + p_amount', ' AS a'],
    ['delegated', delegatedFee, '(balance + p_amount)', ''],
  ]) {
    const r = feeDeductionContract(make(rhs, alias));
    assert.equal(r.ok, true, `${kind} 의 정상 식이 막히면 거짓 실패다: ${rhs} — ${r.ok ? '' : r.reason}`);
  }
});

test('대조 — 지금 저장소의 실제 식은 정확히 허용 모양이다', () => {
  // 085 는 `SET balance = balance + p_amount,` 다. 뒤에 `,` 가 오므로
  // 접미부 금지에 걸리지 않는다. 이 대조가 깨지면 전수가 빨강이 된다.
  const r = feeDeductionContract({ sql: corpus(), fnBody: openBody() });
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.equal(r.where, 'delegated');
});

// ── 괄호 뒤 산술 접미부 (Codex 후속 지적) ──────────────────────────
// ★ 괄호 허용을 **선택적 괄호 한 쌍**(`\(?` … `\)?`)으로 적었더니 그
//   **괄호 자체가 종료 자리를 대신했다.** 닫는 괄호가 뒤 산술기호를 만나면
//   역추적되어 소비되지 않고, 종료 lookahead 의 독립 `)` 선택지가 바로 그
//   괄호에서 통과시킨다. d04cdf6c 에서 돌려서 얻은 값 — 기대충족 2/6:
//
//     inline     (balance - p_entry_fee)                ok=true  옳다
//     inline     (balance - p_entry_fee) * 0            ok=true  구멍
//     inline     (balance - p_entry_fee) + p_entry_fee  ok=true  구멍
//     delegated  (balance + p_amount)                   ok=true  옳다
//     delegated  (balance + p_amount) * 0               ok=true  구멍
//     delegated  (balance + p_amount) - p_amount        ok=true  구멍
//
//   잔고 100 · 수수료 10 이면 첫 식은 0, 차감 상쇄는 100 이 된다. 위 숫자는
//   산술 설명이고 PG 를 돌린 결과가 아니다 — 운영에서 수수료 오차나 사용자
//   손실을 관측했다고 주장하지 않는다.
//
//   직전 b8e107fb 는 괄호를 **아예 받지 않아**(정상 두 꼴까지 거부) 이 구멍이
//   없었다. 그래서 이것은 **괄호 허용과 함께 생긴 새 누락**이고, 앞의 bare 식
//   여섯 건을 다시 센 것이 아니다.
//
//   고친 방향은 괄호를 **짝으로** 받는 것이다. 감싼 갈래가 여는·닫는 괄호를
//   모두 소비하므로 소비되지 않은 괄호가 남지 않고, 종료 자리를 대신할 수
//   없다. 식 본체는 한 곳에만 적고 두 갈래가 같은 문자열을 쓴다.
for (const [how, rhs] of [
  ['0 배로 상쇄', '(balance - p_entry_fee) * 0'],
  ['더해서 상쇄', '(balance - p_entry_fee) + p_entry_fee'],
  ['두 배로 뺀다', '(balance - p_entry_fee) * 2'],
]) {
  test(`★ inline — 괄호 뒤 ${how} (${rhs}) 를 막는다`, () => {
    const r = feeDeductionContract(inlineFee(rhs));
    assert.equal(r.ok, false, `소비되지 않은 괄호가 종료 자리를 대신하면 안 된다: ${rhs}`);
  });
}

for (const [how, rhs] of [
  ['0 배로 상쇄', '(balance + p_amount) * 0'],
  ['차감 상쇄', '(balance + p_amount) - p_amount'],
  ['두 배', '(balance + p_amount) * 2'],
]) {
  test(`★ delegated — 괄호 뒤 ${how} (${rhs}) 를 막는다`, () => {
    const r = feeDeductionContract(delegatedFee(rhs));
    assert.equal(r.ok, false, `소비되지 않은 괄호가 종료 자리를 대신하면 안 된다: ${rhs}`);
  });
}

test('대조 — 괄호 갈래도 같은 수식어 판정을 쓴다', () => {
  // 식 본체가 두 갈래에 들어가면서 수식어 포획군도 둘이 됐다. 한쪽만 읽으면
  // 괄호로 감싼 `v_row.balance` 가 다시 통과한다 — 이 저장소가 이름 붙여 둔
  // "경로가 둘인데 한쪽만 고침" 그대로다.
  for (const [kind, make, rhs, alias, want] of [
    ['inline', inlineFee, '(a.balance - p_entry_fee)', ' AS a', true],
    ['inline', inlineFee, '(v_row.balance - p_entry_fee)', '', false],
    ['inline', inlineFee, '(  balance  -  p_entry_fee  )', '', true],
    ['delegated', delegatedFee, '(a.balance + p_amount)', ' AS a', true],
    ['delegated', delegatedFee, '(v_row.balance + p_amount)', '', false],
  ]) {
    const r = feeDeductionContract(make(rhs, alias));
    assert.equal(r.ok, want, `${kind} — ${rhs}: ${r.ok ? '' : r.reason}`);
  }
});

test('대조 — 둘러싼 구문의 닫는 괄호는 그대로 종료다', () => {
  // 괄호를 짝으로 받게 하면서 `)` 를 종료에서 빼면 CTE 안의 UPDATE 가
  // 거짓으로 막힌다. 두 갈래 모두에서 `)` 는 종료로 남아야 한다.
  const cte = (rhs) => ({
    sql: '',
    fnBody: `DECLARE p_entry_fee numeric := 10; p_account_id uuid;
BEGIN
  WITH upd AS (
    UPDATE public.paper_accounts SET balance = ${rhs} WHERE id = p_account_id RETURNING id
  )
  SELECT 1 FROM upd;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing'; END IF; END;`,
  });
  for (const rhs of ['balance - p_entry_fee', '(balance - p_entry_fee)']) {
    const r = feeDeductionContract(cte(rhs));
    assert.equal(r.ok, true, `CTE 안의 정상 식이 막히면 거짓 실패다: ${rhs} — ${r.ok ? '' : r.reason}`);
  }
});

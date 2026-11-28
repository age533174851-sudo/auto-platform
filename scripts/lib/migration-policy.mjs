// scripts/lib/migration-policy.mjs
//
// **마이그레이션 전수에서 한 표의 접근 경계를 읽는다.**
//
// 왜 전수인가
// ──────────
// 검사기들이 `supabase/migrations/NNN_*.sql`의 **이름을 적어 놓고 그 파일만
// 읽는다.** 마이그레이션은 쌓이는 것이므로 나중 파일이 앞 파일을 되돌린다.
// "083이 닫았다"는 사실만으로 "닫혀 있다"를 적을 수 없다.
//
// 돌려서 얻은 값 — `check-paper-challenge-core.mjs`에 198 한 장을 더하자
// 다섯 가지가 **모두 통과(rc=0)했다**:
//
//   authenticated 에 전체 읽기를 연다        rc=0
//   authenticated 에 쓰기를 연다             rc=0
//   소유자 정책을 지운다                      rc=0
//   RLS 를 끈다                              rc=0
//   cashflows 를 anon 에 연다                rc=0
//
// ★ RLS 정책은 **OR로 합쳐진다.** 소유자 정책이 그대로 있어도 `USING (true)`
//   정책 하나가 더 생기면 격리가 사라진다. "소유자 정책이 있는가"만 보는
//   판정은 그것을 통과시킨다.
//
// 이 파일은 **문자열 위치가 아니라 문장을 끊어** 동사·표·role·USING을 읽는다.
// 줄바꿈·대소문자·여분 공백이 결과를 바꾸지 않아야 서식만 고친 변경이 거짓
// 실패를 내지 않는다.
//
// 중복에 대해 (숨기지 않는다)
// ──────────────────────────
// `src/lib/system/observationAcl.ts`에도 정책을 끊어 읽는 함수가 있다(#828).
// 두 PR이 한 파일을 함께 잡을 수 없어 지금은 파서가 두 곳에 있다. 둘 중
// 하나가 병합되면 **이 파일을 유일한 집으로 삼아 합쳐야 한다** — 같은 판단이
// 두 벌이면 언젠가 갈린다. 그때까지는 이 중복이 선언된 상태다.

/** `--` 주석과 `/* *\/` 블록을 지운다 */
export function stripSqlComments(sql) {
  return String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
}

const norm = (s) => String(s).trim().replace(/\s+/g, ' ');

/**
 * 식별자 한 조각 — 인용(`"a b"`)과 원시(`a_b`)를 모두 받는다.
 *
 * ★ Codex가 #828의 같은 판정에서 찾은 구멍이 여기였다. 표를
 *   `("?[\w$.]+"?)`로 읽으면 `"public"."paper_challenges"`에서 `"public"`만
 *   집어 **`public.public`**이 됐고, 그 이름은 지키는 목록에 없으므로
 *   통과했다. 유효한 SQL이다.
 */
const QID = '(?:"[^"]*"|[\\w$]+)';
/** 수식 이름 — `t` · `s.t` · `"s"."t"` · `s."t"` */
const QNAME = `${QID}(?:\\s*\\.\\s*${QID})*`;

/**
 * 식별자 한 조각을 PostgreSQL 규칙대로 접는다.
 *
 * ★ **인용한 식별자는 대소문자를 보존하고, 인용하지 않은 것만 소문자로
 *   접힌다.** `"SERVICE_ROLE"`은 `service_role`과 **다른 role이다.**
 *
 *   표 이름과 role을 같은 `toLowerCase()`로 묶은 것이 잘못이었다. 표
 *   쪽에서 보수적(놓치지 않는 쪽)이던 선택이 role 쪽에서는 **반대로
 *   통과를 넓혔다.** 측정값 — 고치기 전 `FOR ALL TO "SERVICE_ROLE"`이
 *   service_role 허용으로 통과했다. 격리 PostgreSQL에서 `pg_roles`가
 *   두 role의 `bypassrls`를 별개로 반환한다고 보고됐다.
 */
const ident = (s) => {
  const t = norm(s);
  return /^".*"$/.test(t) ? t.slice(1, -1) : t.toLowerCase();
};

/**
 * 지키는 표를 찾을 때 쓰는 열쇠 — **대소문자를 무시한다.**
 *
 * 인용한 `"PAPER_CHALLENGES"`는 엄밀히 다른 표다. 그래도 같은 표로 본다:
 * 관문은 놓치는 쪽이 아니라 **막는 쪽으로 틀려야 한다.** 이 선택이 낼 수
 * 있는 잘못은 **거짓 차단**뿐이고, 거짓 통과는 아니다.
 */
const guardKey = (s) => String(s).toLowerCase();

/**
 * `keyword` 다음의 괄호 안을 짝을 맞춰 떼어낸다.
 *
 * ★ 정규식으로 `\(([^)]*)\)`처럼 읽으면 `NOT (user_id = auth.uid())`
 *   같은 **중첩 괄호에서 끊긴다.** 식의 일부만 보고 판정하면 안 된다.
 *   홑따옴표 문자열 안의 괄호는 세지 않는다.
 */
function parenAfter(src, keyword) {
  const at = new RegExp(`\\b${keyword}\\b`, 'i').exec(src);
  if (!at) return '';
  const open = src.indexOf('(', at.index + at[0].length);
  if (open === -1) return '';
  let depth = 0, inStr = false;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (inStr) { if (c === "'") inStr = !(src[i + 1] === "'") || (i += 1, true); continue; }
    if (c === "'") { inStr = true; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return norm(src.slice(open + 1, i));
    }
  }
  return '';            // 짝이 맞지 않으면 읽지 못한 것이다 — 빈 값으로 둔다
}

/**
 * 식을 비교할 수 있는 꼴로 모은다.
 *
 * 공백을 접고, **식 전체를 감싼** 여분의 괄호만 벗기고, 소문자로 만든다.
 * `(a) = (b)`처럼 가운데서 끊기는 괄호는 벗기지 않는다.
 */
export function canonicalExpr(raw) {
  let t = norm(raw).toLowerCase();
  for (;;) {
    if (!t.startsWith('(') || !t.endsWith(')')) return t;
    let depth = 0, wraps = true;
    for (let i = 0; i < t.length; i += 1) {
      if (t[i] === '(') depth += 1;
      else if (t[i] === ')') { depth -= 1; if (depth === 0 && i < t.length - 1) { wraps = false; break; } }
    }
    if (!wraps) return t;
    t = norm(t.slice(1, -1));
  }
}

/**
 * 수식 이름을 `schema.table`로 정규화한다.
 *
 * ★ 인용 식별자는 PostgreSQL에서 **대소문자를 보존한다** — 엄밀히는
 *   `"Tbl"`과 `tbl`은 다른 표다. 그래도 소문자로 모아 같은 표로 읽는다.
 *   관문은 놓치는 쪽이 아니라 **막는 쪽으로 틀려야 한다.**
 */
function qualifiedName(raw) {
  const parts = (String(raw ?? '').match(/"[^"]*"|[\w$]+/g) ?? []).map(ident).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.length >= 2
    ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}`
    : `public.${parts[0]}`;
}

/** 쉼표로 이어진 role들 — 인용 표기도 받는다 */
const roleListOf = (s) =>
  (String(s ?? '').match(new RegExp(QID, 'g')) ?? []).map(ident).filter(Boolean);

/**
 * `re`가 걸린 자리부터 다음 `;`까지를 한 조각으로 끊는다.
 *
 * **문장 처음만 보지 않는다.** 정책이 `DO $$ BEGIN … END $$;` 안에 있으면
 * `;`로 끊은 조각은 `DO $$ BEGIN CREATE POLICY …`로 시작한다. 블록 안에
 * 적었다고 권한이 덜 열리는 것은 아니다.
 */
function spansFrom(body, re) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m;
  while ((m = g.exec(body))) {
    const end = body.indexOf(';', m.index);
    out.push(norm(body.slice(m.index, end === -1 ? body.length : end)));
    if (g.lastIndex <= m.index) g.lastIndex = m.index + 1;
  }
  return out;
}

/**
 * `CREATE POLICY`를 끊어 이름·표·명령·role·USING을 읽는다.
 *
 * ★ `TO`는 **`USING`·`WITH CHECK` 앞에 있는 것만** role로 읽는다. 식 안의
 *   `TO`(예: `USING (note = 'TO anon')`)를 role로 읽으면 거짓 실패가 난다.
 * ★ `roles`가 빈 배열이면 "아무 role도 없다"가 아니라 **PUBLIC이다** —
 *   PostgreSQL에서 `TO` 절이 없는 정책은 모든 role에 걸린다.
 */
export function policyStatements(sql) {
  const HEAD = new RegExp(`^CREATE\\s+POLICY\\s+(${QNAME})\\s+ON\\s+(${QNAME})`, 'i');
  return spansFrom(stripSqlComments(sql), /\bCREATE\s+POLICY\b/i).map((raw) => {
    const head = HEAD.exec(raw);
    if (!head) return { name: '', table: '', cmd: 'ALL', roles: [], using: '', withCheck: '', raw };
    const tail = raw.slice(head[0].length);
    const stop = tail.search(/\b(USING|WITH\s+CHECK)\b/i);
    const beforeBody = stop === -1 ? tail : tail.slice(0, stop);
    const to = /\bTO\s+([\s\S]+)$/i.exec(beforeBody);
    const forCmd = /\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(beforeBody);
    const body = stop === -1 ? '' : tail.slice(stop);
    const using = parenAfter(body, 'USING');
    const withCheck = parenAfter(body, 'WITH\\s+CHECK');
    return {
      name: ident(head[1]),
      table: qualifiedName(head[2]),
      // `FOR`를 적지 않은 정책은 PostgreSQL에서 ALL이다
      cmd: forCmd ? forCmd[1].toUpperCase() : 'ALL',
      roles: to ? roleListOf(to[1]) : [],
      using,
      withCheck,
      raw,
    };
  });
}

/** `DROP POLICY [IF EXISTS] <이름> ON <표>` */
export function dropPolicyStatements(sql) {
  return spansFrom(stripSqlComments(sql), /\bDROP\s+POLICY\b/i).map((raw) => {
    const m = new RegExp(
      `^DROP\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?(${QNAME})\\s+ON\\s+(${QNAME})`, 'i').exec(raw);
    return m
      ? { name: ident(m[1]), table: qualifiedName(m[2]), raw }
      : { name: '', table: '', raw };
  });
}

/**
 * `ALTER POLICY [이름] ON [표] …`
 *
 * ★ Codex 가 세 번째로 지적한 것이 이 자리였다. `CREATE POLICY`·
 *   `DROP POLICY`·`ALTER TABLE … RLS` 만 순회했으므로, **이미 있는 정책을
 *   제자리에서 고치는** 다음 두 줄이 보이지 않았다 (측정값: 둘 다 통과):
 *
 *     ALTER POLICY paper_challenges_owner ON public.paper_challenges
 *       USING (true);
 *     ALTER POLICY paper_challenges_owner ON public.paper_challenges
 *       TO PUBLIC USING (true);
 *
 *   경계를 되돌리는 **가장 자연스러운 방법**이 비어 있었던 것이다.
 */
export function alterPolicyStatements(sql) {
  const HEAD = new RegExp(`^ALTER\\s+POLICY\\s+(${QNAME})\\s+ON\\s+(${QNAME})`, 'i');
  return spansFrom(stripSqlComments(sql), /\bALTER\s+POLICY\b/i).map((raw) => {
    const m = HEAD.exec(raw);
    return m
      ? { name: ident(m[1]), table: qualifiedName(m[2]), raw }
      : { name: '', table: '', raw };
  });
}

/** `ALTER TABLE <표> ENABLE|DISABLE ROW LEVEL SECURITY` */
export function rlsToggles(sql) {
  const out = [];
  const re = new RegExp(
    `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${QNAME})\\s+(ENABLE|DISABLE)\\s+ROW\\s+LEVEL\\s+SECURITY`, 'gi');
  let m;
  while ((m = re.exec(stripSqlComments(sql)))) {
    out.push({ table: qualifiedName(m[1]), on: m[2].toUpperCase() === 'ENABLE', raw: norm(m[0]) });
  }
  return out;
}

const no = (code, reason) => ({ ok: false, code, reason });

/**
 * 지키는 표들의 접근 경계가 **전수에서** 유지되는가.
 *
 * `intent.allow`에 적힌 모양 중 **하나와도 맞지 않는** 정책이 있으면 열린
 * 것으로 읽는다. 허용 목록은 검사기가 이미 요구하던 것을 그대로 옮긴
 * 것이어야 한다 — 이 함수가 새 정책을 정하지 않는다.
 *
 * `allow[].using`은 **정확히 허용하는 식의 목록**이다(정규식이 아니다).
 * 부분일치로 보면 `USING (user_id = auth.uid() OR true)`가 통과한다.
 *
 * `files`는 `{ name, sql }`의 배열이고 **마이그레이션 전수**다. 번호 순서로
 * 넘어오는 것을 가정한다.
 */
export function checkTableAccessIntent(files, intent) {
  // 지키는 표는 **대소문자를 무시해서** 찾는다 (`guardKey`의 주석을 보라).
  const guarded = new Set((intent?.tables ?? []).map(t => guardKey(qualifiedName(t))));
  const allow = intent?.allow ?? [];
  if (guarded.size === 0 || allow.length === 0) {
    return no('INTENT_EMPTY', '지킬 표나 허용 모양이 비어 있습니다 — 빈 의도는 전부 통과시킵니다');
  }

  for (const f of files ?? []) {
    const where = f?.name || '(파일 이름 미상)';
    const sql = String(f?.sql ?? '');

    // ① RLS를 끄지 않는가
    for (const t of rlsToggles(sql)) {
      if (guarded.has(guardKey(t.table)) && !t.on) {
        return no('RLS_DISABLED',
          `${where}: ${t.table}의 RLS를 끕니다 — 정책이 남아 있어도 모든 행이 열립니다`);
      }
    }

    // ② 정책이 허용 모양 안에 있는가 (정책은 OR로 합쳐진다)
    for (const p of policyStatements(sql)) {
      if (!guarded.has(guardKey(p.table))) continue;
      const which = p.name || '(이름 미상)';
      if (p.roles.length === 0) {
        return no('POLICY_PUBLIC',
          `${where}: ${p.table}의 정책 ${which}에 TO 절이 없습니다`
          + ' — PostgreSQL에서 TO를 적지 않은 정책은 PUBLIC이고 모든 role에 걸립니다');
      }
      // ★ 식을 **부분일치로 보지 않는다.** `USING (...)` 안에 소유자 비교가
      //   들어 있는지만 보면 의미를 보증하지 못한다. 측정값 (격리
      //   PostgreSQL에서 user1·user2 두 행, `auth.uid() = user1`):
      //
      //     USING (user_id = auth.uid())            읽힌 행 {1}      옳다
      //     USING (user_id = auth.uid() OR true)    읽힌 행 {1, 2}   열렸다
      //     USING (NOT (user_id = auth.uid()))      읽힌 행 {2}      남의 행
      //     USING (user_id = auth.uid() OR 1=1)     읽힌 행 {1, 2}   열렸다
      //
      //   셋 다 유효한 정책이고, 부분일치 판정은 **전부 통과시켰다.**
      //   그래서 허용 목록의 식은 **정확히 그 꼴이어야** 한다. 모르는 꼴은
      //   막는다 — 의미를 증명할 수 없으면 통과가 아니다.
      const fits = allow.some((a) => {
        if (a.cmd !== 'ANY' && a.cmd !== p.cmd) return false;
        if (!p.roles.every(r => a.roles.includes(r))) return false;
        if (!a.using) return true;                       // 식 제약이 없는 규칙
        if (!a.using.map(canonicalExpr).includes(canonicalExpr(p.using))) return false;
        // `FOR SELECT`에 `WITH CHECK`는 PostgreSQL이 거부한다. 읽혔다면
        // 우리가 식을 잘못 끊은 것이므로 통과시키지 않는다.
        return !p.withCheck;
      });
      if (!fits) {
        return no('POLICY_OUTSIDE_INTENT',
          `${where}: ${p.table}의 정책 ${which}이 허용 모양 밖입니다`
          + ` (FOR ${p.cmd} TO ${p.roles.join(', ')}`
          + `${p.using ? ` USING (${p.using.slice(0, 60)})` : ''})`
          + ' — 정책은 OR로 합쳐지므로 이 한 줄이 소유자 격리를 무력화합니다.'
          + ' 식은 허용 목록과 정확히 같아야 합니다 (부분일치는 의미를'
          + ' 보증하지 못합니다)');
      }
    }

    // ③ 이미 있는 정책을 제자리에서 고치지 않는가
    //
    //   **왜 결과 모양을 따져 보지 않고 전부 막는가.** `ALTER POLICY`는
    //   `TO`·`USING`·`WITH CHECK`를 **따로따로** 바꾸고, 바꾸지 않은 절은
    //   그대로 남는다. 그래서 이 문장 하나만 보고는 **결과 정책의 모양을
    //   알 수 없다** — 특히 원래 `cmd`(`FOR ALL`인지 `FOR SELECT`인지)를
    //   모른다.
    //
    //   "허용 목록의 role 합집합 안에 있으면 통과"로 느슨하게 잡으면
    //   이런 줄이 새어 나간다:
    //
    //     ALTER POLICY paper_challenges_service ON …  TO authenticated;
    //
    //   `service` 정책은 `FOR ALL`이므로, 그 한 줄이 **authenticated 에게
    //   쓰기를 준다.** 합집합 판정으로는 막지 못한다.
    //
    //   그래서 지키는 표의 `ALTER POLICY`는 전부 막는다. 일부러 바꿔야
    //   한다면 **지우고 다시 만들면 된다** — 그 꼴은 ②·④가 결과 모양을
    //   실제로 본다. 검사기를 약하게 만들지 않고도 길이 있다.
    for (const a of alterPolicyStatements(sql)) {
      if (!guarded.has(guardKey(a.table))) continue;
      return no('POLICY_ALTERED',
        `${where}: ${a.table}의 정책 ${a.name || '(이름 미상)'}을 ALTER POLICY로 바꿉니다`
        + ' — 바꾸지 않은 절이 그대로 남으므로 이 문장만으로는 결과 모양을 알 수'
        + ' 없습니다. 지우고 같은 파일에서 다시 만들면 결과를 실제로 봅니다');
    }

    // ④ 정책을 지우고 다시 만들지 않는가
    //
    //   083은 `DROP POLICY IF EXISTS` 다음에 같은 이름을 다시 만든다 (다시
    //   돌려도 안전하게). 그 꼴은 통과시키고, **같은 파일에서 다시 만들지
    //   않는 DROP**은 막는다.
    const recreated = new Set(policyStatements(sql).map(p => `${p.table}\u0000${p.name}`));
    for (const d of dropPolicyStatements(sql)) {
      if (!guarded.has(guardKey(d.table))) continue;
      if (!recreated.has(`${d.table}\u0000${d.name}`)) {
        return no('POLICY_DROPPED',
          `${where}: ${d.table}의 정책 ${d.name || '(이름 미상)'}을 지우고 다시 만들지 않습니다`
          + ' — 소유자 격리가 사라집니다');
      }
    }
  }

  return { ok: true, code: 'OK', reason: '' };
}

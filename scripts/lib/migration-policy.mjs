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
const ident = (s) => norm(s).toLowerCase().replace(/^"|"$/g, '');
const qualify = (t) => (t.includes('.') ? t : `public.${t}`);

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
  return spansFrom(stripSqlComments(sql), /\bCREATE\s+POLICY\b/i).map((raw) => {
    const head = /^CREATE\s+POLICY\s+("?[\w$.]+"?)\s+ON\s+("?[\w$.]+"?)/i.exec(raw);
    if (!head) return { name: '', table: '', cmd: 'ALL', roles: [], using: '', raw };
    const tail = raw.slice(head[0].length);
    const stop = tail.search(/\b(USING|WITH\s+CHECK)\b/i);
    const beforeBody = stop === -1 ? tail : tail.slice(0, stop);
    const to = /\bTO\s+([\s\S]+)$/i.exec(beforeBody);
    const forCmd = /\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(beforeBody);
    const using = stop === -1 ? '' : norm(tail.slice(stop));
    return {
      name: ident(head[1]),
      table: qualify(ident(head[2])),
      // `FOR`를 적지 않은 정책은 PostgreSQL에서 ALL이다
      cmd: forCmd ? forCmd[1].toUpperCase() : 'ALL',
      roles: to ? to[1].split(',').map(ident).filter(Boolean) : [],
      using,
      raw,
    };
  });
}

/** `DROP POLICY [IF EXISTS] <이름> ON <표>` */
export function dropPolicyStatements(sql) {
  return spansFrom(stripSqlComments(sql), /\bDROP\s+POLICY\b/i).map((raw) => {
    const m = /^DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?("?[\w$.]+"?)\s+ON\s+("?[\w$.]+"?)/i.exec(raw);
    return m
      ? { name: ident(m[1]), table: qualify(ident(m[2])), raw }
      : { name: '', table: '', raw };
  });
}

/** `ALTER TABLE <표> ENABLE|DISABLE ROW LEVEL SECURITY` */
export function rlsToggles(sql) {
  const out = [];
  const re = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[\w$.]+"?)\s+(ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY/gi;
  let m;
  while ((m = re.exec(stripSqlComments(sql)))) {
    out.push({ table: qualify(ident(m[1])), on: m[2].toUpperCase() === 'ENABLE', raw: norm(m[0]) });
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
 * `files`는 `{ name, sql }`의 배열이고 **마이그레이션 전수**다. 번호 순서로
 * 넘어오는 것을 가정한다.
 */
export function checkTableAccessIntent(files, intent) {
  const guarded = new Set((intent?.tables ?? []).map(t => qualify(String(t).toLowerCase())));
  const allow = intent?.allow ?? [];
  if (guarded.size === 0 || allow.length === 0) {
    return no('INTENT_EMPTY', '지킬 표나 허용 모양이 비어 있습니다 — 빈 의도는 전부 통과시킵니다');
  }

  for (const f of files ?? []) {
    const where = f?.name || '(파일 이름 미상)';
    const sql = String(f?.sql ?? '');

    // ① RLS를 끄지 않는가
    for (const t of rlsToggles(sql)) {
      if (guarded.has(t.table) && !t.on) {
        return no('RLS_DISABLED',
          `${where}: ${t.table}의 RLS를 끕니다 — 정책이 남아 있어도 모든 행이 열립니다`);
      }
    }

    // ② 정책이 허용 모양 안에 있는가 (정책은 OR로 합쳐진다)
    for (const p of policyStatements(sql)) {
      if (!guarded.has(p.table)) continue;
      const which = p.name || '(이름 미상)';
      if (p.roles.length === 0) {
        return no('POLICY_PUBLIC',
          `${where}: ${p.table}의 정책 ${which}에 TO 절이 없습니다`
          + ' — PostgreSQL에서 TO를 적지 않은 정책은 PUBLIC이고 모든 role에 걸립니다');
      }
      const fits = allow.some(a =>
        (a.cmd === 'ANY' || a.cmd === p.cmd)
        && p.roles.every(r => a.roles.includes(r))
        && (!a.using || a.using.test(p.using)));
      if (!fits) {
        return no('POLICY_OUTSIDE_INTENT',
          `${where}: ${p.table}의 정책 ${which}이 허용 모양 밖입니다`
          + ` (FOR ${p.cmd} TO ${p.roles.join(', ')}${p.using ? ` ${p.using.slice(0, 40)}` : ''})`
          + ' — 정책은 OR로 합쳐지므로 이 한 줄이 소유자 격리를 무력화합니다');
      }
    }

    // ③ 정책을 지우고 다시 만들지 않는가
    //
    //   083은 `DROP POLICY IF EXISTS` 다음에 같은 이름을 다시 만든다 (다시
    //   돌려도 안전하게). 그 꼴은 통과시키고, **같은 파일에서 다시 만들지
    //   않는 DROP**은 막는다.
    const recreated = new Set(policyStatements(sql).map(p => `${p.table}\u0000${p.name}`));
    for (const d of dropPolicyStatements(sql)) {
      if (!guarded.has(d.table)) continue;
      if (!recreated.has(`${d.table}\u0000${d.name}`)) {
        return no('POLICY_DROPPED',
          `${where}: ${d.table}의 정책 ${d.name || '(이름 미상)'}을 지우고 다시 만들지 않습니다`
          + ' — 소유자 격리가 사라집니다');
      }
    }
  }

  return { ok: true, code: 'OK', reason: '' };
}

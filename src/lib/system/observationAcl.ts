// src/lib/system/observationAcl.ts
//
// ⑤B-3A-2.3 — **RLS만으로 service-only라고 주장하지 않는다.**
//
// GRANT/REVOKE와 RLS는 **다른 층이다**:
//
//   GRANT/REVOKE   role이 표에 **접근할 수 있는가**
//   RLS            접근 가능한 role이 **어느 줄을** 볼/쓸 수 있는가
//
// Supabase 프로젝트의 legacy default privileges가 새 public table에
// anon/authenticated 권한을 **자동으로 부여할 수 있다.** 그러면 RLS를 켜
// 두었어도 표 자체에는 닿을 수 있고, 정책 한 줄만 잘못 생기면 열린다.
// 095는 그 층을 닫는다.
//
// ★ service_role은 서버 전용이고 RLS를 **우회할 수 있다.** 그래서 이
//   마이그레이션의 보호 경계는 "anon/authenticated의 table privilege를
//   없애고 service_role만 남기는 것"이다. 그 사실을 숨기지 않는다.
//
// 왜 문자열이 아니라 의미로 보는가
// ────────────────────────────────
// 줄바꿈·대소문자·공백이 바뀌었다고 실패하면 검사기가 거짓말을 하기
// 시작하고, 반대로 `includes('REVOKE')`만 보면 **SELECT만 회수해도**
// 통과한다. 그래서 문장을 끊어서 동사·권한·표·role을 각각 읽는다.

/** 반드시 닫혀 있어야 하는 표 */
export const PROTECTED_OBSERVATION_TABLES = [
  'public.exact100x_risk_observations',
  'public.exact100x_exit_escape_observations',
] as const;

/** 표에 **닿을 수 없어야** 하는 role */
export const PUBLIC_ROLES = ['anon', 'authenticated'] as const;

/** 서버 쓰기를 맡는 role */
export const SERVICE_ROLE = 'service_role';

export type AclCode =
  | 'OK'
  /** 지켜야 할 표가 문장에 없다 */
  | 'TABLE_NOT_PROTECTED'
  /** REVOKE가 ALL PRIVILEGES가 아니다 — 남는 권한이 생긴다 */
  | 'REVOKE_NOT_ALL'
  /** anon·authenticated 중 하나가 REVOKE에서 빠졌다 */
  | 'ROLE_NOT_REVOKED'
  /** service_role에 GRANT가 없다 — 서버가 쓰지 못한다 */
  | 'SERVICE_GRANT_MISSING'
  /** anon·authenticated에 다시 GRANT를 열었다 */
  | 'PUBLIC_ROLE_GRANTED'
  /** 데이터를 바꾸거나 구조를 지우는 문장이 있다 */
  | 'DESTRUCTIVE'
  /** ACL과 무관한 문장이 섞였다 */
  | 'NOT_ACL_ONLY'
  /**
   * 지켜야 할 표의 RLS 정책이 service_role 전용이 아니다.
   *
   * ★ `TO` 절을 적지 않은 `CREATE POLICY`는 PostgreSQL에서 **PUBLIC**이다.
   *   낱말로 `anon`을 찾는 판정은 그 정책을 통과시킨다.
   */
  | 'POLICY_NOT_SERVICE_ONLY';

export interface AclVerdict {
  ok: boolean;
  code: AclCode;
  reason: string;
}

export interface AclStatement {
  verb: 'GRANT' | 'REVOKE' | 'OTHER';
  /** 대문자로 정규화한 권한 목록. `ALL`이면 전부 */
  privileges: string[];
  /** `public.foo` 형태로 정규화 */
  tables: string[];
  roles: string[];
  raw: string;
}

export interface PolicyStatement {
  /** 소문자로 정규화한 정책 이름. 읽지 못하면 빈 문자열 */
  name: string;
  /** `public.foo` 형태로 정규화 */
  table: string;
  /**
   * `TO`에 적힌 role 목록.
   *
   * ★ **빈 배열은 "아무 role도 없다"가 아니라 PUBLIC이다.** `TO` 절이
   *   없는 정책은 모든 role에 걸린다. 이 사실을 호출부에 떠넘기지 않도록
   *   `checkObservationExposure`가 빈 배열을 거부한다.
   */
  roles: string[];
  raw: string;
}

/** 마이그레이션 한 장 — 이름을 들고 다녀야 어디서 열렸는지 적을 수 있다 */
export interface MigrationSource {
  name: string;
  sql: string;
}

/** `--` 주석과 `/* *\/` 블록을 지운다 */
function stripSqlComments(sql: string): string {
  return String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

/**
 * 식별자 한 조각 — 인용(`"a b"`)과 원시(`a_b`)를 모두 받는다.
 *
 * ★ Codex가 #828에서 찾은 구멍이 여기였다. `("?[\w$.]+"?)`로 표를 읽으면
 *   `"public"."exact100x_risk_observations"`에서 `"public"`만 집어
 *   **`public.public`**이 됐고, 그 이름은 지키는 목록에 없으므로 통과했다.
 *   GRANT 쪽은 따옴표를 아예 벗기지 않아 역시 어긋났다. 유효한 SQL이다 —
 *   격리 PostgreSQL에서 `pg_policies.roles = {public}`으로 확인됐다.
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
 *   Codex가 두 번째로 지적한 것이 이 자리였다. 표 이름과 role을 같은
 *   `toLowerCase()`로 묶었더니, 표 쪽에서는 보수적(놓치지 않는 쪽)이던
 *   같은 선택이 role 쪽에서는 **반대로 통과를 넓혔다.** 측정값:
 *
 *     role=service_role     정책 허용  GRANT 허용   (옳다)
 *     role="service_role"   정책 허용  GRANT 허용   (옳다)
 *     role="SERVICE_ROLE"   정책 허용  GRANT 허용   ← 구멍
 *     role="Service_Role"   정책 허용  GRANT 허용   ← 구멍
 *     role=authenticated    정책 차단  GRANT 차단
 *
 *   격리 PostgreSQL에서 `pg_roles`가 `service_role`(bypassrls=true)과
 *   `SERVICE_ROLE`(bypassrls=false)을 **별개로** 반환한다고 보고됐다.
 *
 * 그래서 이 함수는 의미 그대로 접고, **표를 지키는 쪽만** 그 위에서
 * 대소문자를 무시한다(`guardKey`). 두 선택을 한 함수에 섞지 않는다.
 */
const foldIdent = (s: string) => {
  const t = norm(s);
  return /^".*"$/.test(t) ? t.slice(1, -1) : t.toLowerCase();
};

/**
 * 지키는 표를 찾을 때 쓰는 열쇠 — **대소문자를 무시한다.**
 *
 * 인용한 `"EXACT100X_RISK_OBSERVATIONS"`는 엄밀히 다른 표다. 그래도 같은
 * 표로 본다: 관문은 놓치는 쪽이 아니라 **막는 쪽으로 틀려야 한다.** 이
 * 선택이 낼 수 있는 잘못은 **거짓 차단**뿐이고, 거짓 통과는 아니다.
 */
const guardKey = (s: string) => s.toLowerCase();

/**
 * 수식 이름을 `schema.table`로 정규화한다.
 *
 * ★ 인용 식별자는 PostgreSQL에서 **대소문자를 보존한다** — 엄밀히는
 *   `"Tbl"`과 `tbl`은 다른 표다. 그래도 여기서는 소문자로 모아 같은 표로
 *   읽는다. 관문은 놓치는 쪽이 아니라 **막는 쪽으로 틀려야 한다.**
 */
function qualifiedName(raw: string): string {
  const parts = (String(raw ?? '').match(/"[^"]*"|[\w$]+/g) ?? [])
    .map(foldIdent).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.length >= 2
    ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}`
    : `public.${parts[0]}`;
}

/** 쉼표로 이어진 수식 이름들 — `"a,b"`처럼 쉼표를 품은 인용 이름도 끊지 않는다 */
const nameList = (s: string) =>
  (String(s ?? '').match(new RegExp(QNAME, 'g')) ?? []).map(qualifiedName).filter(Boolean);

/**
 * 쉼표로 이어진 role들 — **인용한 것은 대소문자를 보존한다.**
 *
 * 허용 목록(`service_role`)과의 비교는 정확해야 한다. 여기서 소문자로
 * 모으면 `"SERVICE_ROLE"`이 허용으로 새어 들어간다.
 */
const roleListOf = (s: string) =>
  (String(s ?? '').match(new RegExp(QID, 'g')) ?? []).map(foldIdent).filter(Boolean);

/**
 * 문장을 끊어 동사·권한·표·role을 읽는다.
 *
 * **줄바꿈·대소문자·여분 공백은 결과를 바꾸지 않는다.** 그래야 서식만
 * 고친 변경이 거짓 실패를 내지 않는다.
 */
export function parseAclStatements(sql: string): AclStatement[] {
  return stripSqlComments(sql).split(';')
    .map(norm)
    .filter(Boolean)
    .map(parseAclSpan);
}

/** `a, b` → `['a','b']` — 소문자·따옴표 제거 */
const roleList = roleListOf;

/**
 * GRANT/REVOKE 한 문장을 읽는다.
 *
 * `parseAclStatements`(문장 단위)와 `grantSpans`(문장 처음이 아닌 자리까지)가
 * **같은 함수를 쓴다.** 같은 판단이 두 벌이 되면 언젠가 갈린다.
 */
function parseAclSpan(raw: string): AclStatement {
  const u = raw.toUpperCase();
  const isGrant = /^GRANT\b/.test(u);
  const isRevoke = /^REVOKE\b/.test(u);
  if (!isGrant && !isRevoke) {
    return { verb: 'OTHER', privileges: [], tables: [], roles: [], raw };
  }
  // GRANT <privs> ON [TABLE] <tables> TO <roles>
  // REVOKE <privs> ON [TABLE] <tables> FROM <roles>
  const m = isGrant
    ? /^GRANT\s+([\s\S]+?)\s+ON\s+(?:TABLE\s+)?([\s\S]+?)\s+TO\s+([\s\S]+)$/i.exec(raw)
    : /^REVOKE\s+([\s\S]+?)\s+ON\s+(?:TABLE\s+)?([\s\S]+?)\s+FROM\s+([\s\S]+)$/i.exec(raw);
  if (!m) return { verb: isGrant ? 'GRANT' : 'REVOKE', privileges: [], tables: [], roles: [], raw };
  const privileges = m[1].toUpperCase()
    .replace(/\bPRIVILEGES\b/g, '').split(',').map(norm).filter(Boolean);
  // 인용 표기(`"public"."t"`)도 같은 이름으로 읽는다
  const tables = nameList(m[2]);
  return { verb: isGrant ? 'GRANT' : 'REVOKE', privileges, tables, roles: roleList(m[3]), raw };
}

/**
 * `re`가 걸린 자리부터 다음 `;`까지를 한 조각으로 끊는다.
 *
 * **왜 문장 처음만 보지 않는가.** 093·094의 정책은 `DO $$ BEGIN … END $$;`
 * 안에 있다. `;`로 끊으면 그 조각은 `DO $$ BEGIN CREATE POLICY …`로 시작하므로
 * "문장이 GRANT/CREATE POLICY로 시작하는가"를 보는 판정은 **그 안을 보지
 * 못한다.** 블록 안에 적었다고 권한이 덜 열리는 것은 아니다.
 */
function spansFrom(body: string, re: RegExp): string[] {
  const out: string[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(body))) {
    const end = body.indexOf(';', m.index);
    out.push(norm(body.slice(m.index, end === -1 ? body.length : end)));
    if (end !== -1) g.lastIndex = Math.max(g.lastIndex, m.index + 1);
  }
  return out;
}

/**
 * `CREATE POLICY`를 끊어 이름·표·role을 읽는다.
 *
 * ★ `TO`는 **`USING`·`WITH CHECK` 앞에 있는 것만** role로 읽는다. 식 안의
 *   `TO`(예: `USING (note = 'TO anon')`)를 role로 읽으면 거짓 실패가 난다.
 */
export function parsePolicyStatements(sql: string): PolicyStatement[] {
  const HEAD = new RegExp(`^CREATE\\s+POLICY\\s+(${QNAME})\\s+ON\\s+(${QNAME})`, 'i');
  return spansFrom(stripSqlComments(sql), /\bCREATE\s+POLICY\b/i).map((raw): PolicyStatement => {
    const head = HEAD.exec(raw);
    if (!head) return { name: '', table: '', roles: [], raw };
    const name = foldIdent(head[1]);
    const table = qualifiedName(head[2]);
    const tail = raw.slice(head[0].length);
    const stop = tail.search(/\b(USING|WITH\s+CHECK)\b/i);
    const to = /\bTO\s+([\s\S]+)$/i.exec(stop === -1 ? tail : tail.slice(0, stop));
    return { name, table, roles: to ? roleList(to[1]) : [], raw };
  });
}

const no = (code: AclCode, reason: string): AclVerdict => ({ ok: false, code, reason });

/**
 * 095가 약속한 것을 실제로 하는가.
 *
 * ★ `REVOKE SELECT`만 있으면 **통과시키지 않는다.** INSERT·UPDATE·
 *   DELETE·TRUNCATE가 남으면 "닫았다"가 거짓이 된다.
 */
export function checkObservationAcl(sql: string): AclVerdict {
  const stmts = parseAclStatements(sql);

  // ① 데이터를 바꾸거나 구조를 지우지 않는가 (replay-safe)
  for (const s of stmts) {
    if (s.verb !== 'OTHER') continue;
    if (/^(DROP|TRUNCATE|DELETE|UPDATE|INSERT|ALTER\s+TABLE\s+\S+\s+DROP)\b/i.test(s.raw)) {
      return no('DESTRUCTIVE', `데이터·구조를 바꾸는 문장이 있습니다: ${s.raw.slice(0, 80)}`);
    }
    return no('NOT_ACL_ONLY', `ACL과 무관한 문장이 있습니다: ${s.raw.slice(0, 80)}`);
  }

  for (const table of PROTECTED_OBSERVATION_TABLES) {
    const touching = stmts.filter(s => s.tables.includes(table));
    if (touching.length === 0) {
      return no('TABLE_NOT_PROTECTED', `${table}에 대한 문장이 없습니다`);
    }

    // ② anon·authenticated가 **전부** 회수됐는가
    for (const role of PUBLIC_ROLES) {
      const revoked = touching.some(s =>
        s.verb === 'REVOKE' && s.roles.includes(role) && s.privileges.includes('ALL'));
      if (!revoked) {
        const partial = touching.find(s => s.verb === 'REVOKE' && s.roles.includes(role));
        if (partial) {
          return no('REVOKE_NOT_ALL',
            `${table}의 ${role} 회수가 ALL이 아닙니다 (${partial.privileges.join(', ') || '권한 미상'})`
            + ' — 남은 권한으로 읽거나 쓸 수 있습니다');
        }
        return no('ROLE_NOT_REVOKED', `${table}에서 ${role} 권한을 회수하지 않습니다`);
      }
    }

    // ③ 회수한 role에 다시 GRANT를 열지 않았는가
    for (const s of touching) {
      if (s.verb !== 'GRANT') continue;
      for (const role of PUBLIC_ROLES) {
        if (s.roles.includes(role)) {
          return no('PUBLIC_ROLE_GRANTED', `${table}에 ${role} 권한을 다시 열었습니다`);
        }
      }
    }

    // ④ 서버는 쓸 수 있는가
    const served = touching.some(s =>
      s.verb === 'GRANT' && s.roles.includes(SERVICE_ROLE) && s.privileges.includes('ALL'));
    if (!served) {
      return no('SERVICE_GRANT_MISSING',
        `${table}에 ${SERVICE_ROLE} 권한이 없습니다 — 서버가 관측을 적지 못합니다`);
    }
  }

  return { ok: true, code: 'OK', reason: '' };
}

/**
 * 마이그레이션 **전수**에서 두 관측 표가 service 경로 밖으로 열리지 않는가.
 *
 * 왜 전수인가
 * ──────────
 * `checkObservationAcl`은 095 한 장이 약속을 지키는지 본다. 그것으로는
 * **096 이후 아무 파일에서나 다시 열 수 있다.** 마이그레이션은 쌓이는
 * 것이므로 나중 파일이 앞 파일을 되돌린다 — 그래서 "095가 닫았다"는
 * 사실만으로 "닫혀 있다"를 적을 수 없다.
 *
 * 두 층을 모두 본다 (둘 중 하나만 닫혀도 열린다고 적지 않는다):
 *
 *   GRANT   service_role 외의 role에 표 권한을 주지 않는가
 *   정책     `CREATE POLICY`가 `TO service_role` 전용인가
 *
 * ★ `TO` 절이 없는 정책은 PUBLIC이다. "service_role 정책이 하나 있고
 *   anon이라는 낱말이 없다"는 판정은 그 정책을 **통과시킨다.** 그래서
 *   여기서는 role 목록이 비어 있는 것을 **모른다가 아니라 열렸다**로 읽는다.
 *
 * 지키는 표가 아닌 것은 건드리지 않는다 — 이 판정은 Exact100X 관측 표
 * 두 개만 본다.
 */
export function checkObservationExposure(files: readonly MigrationSource[]): AclVerdict {
  // 지키는 표는 **대소문자를 무시해서** 찾는다 (`guardKey`의 주석을 보라).
  const guarded = new Set<string>(PROTECTED_OBSERVATION_TABLES.map(guardKey));

  for (const f of files) {
    const where = f?.name || '(파일 이름 미상)';
    const sql = String(f?.sql ?? '');

    // ① RLS 정책이 service_role 전용인가
    for (const p of parsePolicyStatements(sql)) {
      if (!guarded.has(guardKey(p.table))) continue;
      const which = p.name || '(이름 미상)';
      if (p.roles.length === 0) {
        return no('POLICY_NOT_SERVICE_ONLY',
          `${where}: ${p.table}의 정책 ${which}에 TO 절이 없습니다`
          + ' — PostgreSQL에서 TO를 적지 않은 정책은 PUBLIC이고 모든 role에 걸립니다');
      }
      const outside = p.roles.filter(r => r !== SERVICE_ROLE);
      if (outside.length > 0) {
        return no('POLICY_NOT_SERVICE_ONLY',
          `${where}: ${p.table}의 정책 ${which}이 ${outside.join(', ')}에 걸립니다`
          + ' — 이 표는 service 경로 전용입니다');
      }
    }

    // ② GRANT가 표 권한을 다시 주지 않는가 (`DO` 블록 안도 본다)
    for (const raw of spansFrom(stripSqlComments(sql), /\bGRANT\b/i)) {
      const st = parseAclSpan(raw.replace(/^[\s\S]*?(?=GRANT\b)/i, ''));
      if (st.verb !== 'GRANT') continue;
      const touched = st.tables.filter(t => guarded.has(guardKey(t)));
      if (touched.length === 0) continue;
      const outside = st.roles.filter(r => r !== SERVICE_ROLE);
      if (outside.length > 0) {
        return no('PUBLIC_ROLE_GRANTED',
          `${where}: ${touched.join(', ')}에 ${outside.join(', ')} 권한을 열었습니다`
          + ` — ${SERVICE_ROLE}만 닿을 수 있어야 합니다`);
      }
    }
  }

  return { ok: true, code: 'OK', reason: '' };
}

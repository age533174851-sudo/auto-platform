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
  | 'NOT_ACL_ONLY';

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

/** `--` 주석과 `/* *\/` 블록을 지운다 */
function stripSqlComments(sql: string): string {
  return String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

/**
 * 문장을 끊어 동사·권한·표·role을 읽는다.
 *
 * **줄바꿈·대소문자·여분 공백은 결과를 바꾸지 않는다.** 그래야 서식만
 * 고친 변경이 거짓 실패를 내지 않는다.
 */
export function parseAclStatements(sql: string): AclStatement[] {
  const body = stripSqlComments(sql);
  return body.split(';')
    .map(norm)
    .filter(Boolean)
    .map((raw): AclStatement => {
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
      const tables = m[2].split(',').map(t => norm(t).toLowerCase())
        .map(t => (t.includes('.') ? t : `public.${t}`));
      const roles = m[3].split(',').map(r => norm(r).toLowerCase().replace(/^"|"$/g, ''))
        .filter(Boolean);
      return { verb: isGrant ? 'GRANT' : 'REVOKE', privileges, tables, roles, raw };
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

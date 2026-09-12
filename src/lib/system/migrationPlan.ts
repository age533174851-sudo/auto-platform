// src/lib/system/migrationPlan.ts
//
// **"054 했었나?"를 사람이 기억하는 구조를 없앤다.**
//
// 지금까지 마이그레이션은 사람이 Supabase SQL 편집기에 파일을 복사해
// 붙여 넣는 일이었다. 그래서 이런 일이 반복됐다:
//
//   · 054를 안 넣어 워커 버전이 영영 '모름'이었다
//   · 055가 없는 채로 중지 기능이 반쪽으로 돌았다
//   · 056이 없으면 장부 writer가 조용히 TABLE_MISSING만 남긴다
//
// 셋 다 코드는 맞고 DB만 뒤처진 상태였다. **그리고 그걸 알아채는
// 유일한 방법이 사람의 기억이었다.**
//
// 그래서 자동으로 한다 — 다만 아무거나 자동으로 하지는 않는다
// ────────────────────────────────────────────────────────────
// 실제 돈이 들어가는 서비스에서 "머지되면 아무 SQL이나 실행"은 위험하다.
// 표를 지우거나 칸을 없애거나 타입을 강제로 바꾸는 문장은 **되돌릴 수
// 없다.** 그래서 둘로 가른다:
//
//   ADDITIVE     표·칸·인덱스·정책을 **더하는** 것 → 자동 적용
//   DESTRUCTIVE  지우거나 바꾸는 것            → **자동 중단**, 승인 필요
//   UNKNOWN      확실히 안전하다고 말할 수 없는 것 → 자동 중단
//
// 마지막 줄이 중요하다. **모르면 자동으로 하지 않는다** — 이 파일에서
// 판단을 못 한 문장을 '아마 괜찮겠지'로 넘기면, 그 한 번이 데이터를
// 지운다.

export type MigrationRisk = 'ADDITIVE' | 'DESTRUCTIVE' | 'UNKNOWN';

export interface MigrationFile {
  /** 파일 이름 (`056_ledger_events.sql`) */
  name: string;
  /** 앞의 숫자. 없으면 null — 순서를 정할 수 없다 */
  id: number | null;
  sql: string;
}

export interface MigrationClass {
  risk: MigrationRisk;
  /** 왜 그렇게 봤는가 */
  reasons: string[];
  /** 자동으로 적용해도 되는가 */
  autoApply: boolean;
}

/**
 * 되돌릴 수 없는 문장들.
 *
 * **여기 없는 위험을 안전으로 읽지 않는다.** 목록에 없는 낯선 문장은
 * UNKNOWN이고, UNKNOWN은 자동 적용하지 않는다.
 */
const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bDROP\s+TABLE\b/i, why: '표를 지웁니다' },
  { re: /\bDROP\s+DATABASE\b/i, why: '데이터베이스를 지웁니다' },
  { re: /\bDROP\s+SCHEMA\b/i, why: '스키마를 지웁니다' },
  { re: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i, why: '칸을 지웁니다 — 그 안의 값도 같이 사라집니다' },
  { re: /\bALTER\s+TABLE\b[\s\S]*?\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i, why: '칸의 타입을 바꿉니다 — 값이 잘리거나 실패할 수 있습니다' },
  { re: /\bTRUNCATE\b/i, why: '표를 비웁니다' },
  // **조건 없는 DELETE·UPDATE는 전부를 건드린다.** 문장 단위로 보므로
  // 뒤 문장의 WHERE를 이 문장 것으로 착각하지 않는다.
  { re: /\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i, why: '조건 없는 DELETE입니다 — 전부 지웁니다' },
  { re: /\bUPDATE\b[\s\S]*?\bSET\b(?![\s\S]*\bWHERE\b)/i, why: '조건 없는 UPDATE입니다 — 모든 줄의 값을 덮어씁니다' },
  { re: /\bDROP\s+(?:MATERIALIZED\s+)?VIEW\b/i, why: '뷰를 지웁니다' },
  { re: /\bDROP\s+FUNCTION\b/i, why: '함수를 지웁니다' },
];

/**
 * 더하기만 하는 것으로 인정하는 문장들.
 *
 * **`DROP INDEX`는 여기 있다** — 인덱스는 데이터가 아니고, 이 저장소는
 * 실제로 인덱스를 다시 만들기 위해 지운 적이 있다(055). 다만 반드시
 * 같은 파일 안에서 다시 만들어야 한다(아래에서 확인한다).
 */
const ADDITIVE_PATTERNS: RegExp[] = [
  /\bCREATE\s+TABLE\b/i,
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  /\bCREATE\s+EXTENSION\b/i,
  /\bALTER\s+TABLE\b[\s\S]*?\bADD\s+COLUMN\b/i,
  /\bALTER\s+TABLE\b[\s\S]*?\bADD\s+CONSTRAINT\b/i,
  // 제약을 지우는 것은 값을 지우는 것이 아니다. 대개 바로 뒤에서 다시 만든다.
  /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+CONSTRAINT\b/i,
  // SET DEFAULT · SET NOT NULL은 값을 지우지 않는다. 맞지 않으면 트랜잭션이 통째로 되돌아간다.
  // (타입 변경 `ALTER COLUMN ... TYPE`은 위 DESTRUCTIVE에서 먼저 걸린다.)
  /\bALTER\s+TABLE\b[\s\S]*?\bALTER\s+COLUMN\b[\s\S]*?\b(?:SET|DROP)\s+(?:DEFAULT|NOT\s+NULL)\b/i,
  /\bALTER\s+TABLE\b[\s\S]*?\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i,
  /\bCREATE\s+POLICY\b/i,
  /\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/i,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\b/i,
  /\bCOMMENT\s+ON\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bDROP\s+POLICY\b/i,
  /\bDROP\s+TRIGGER\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  // 읽기만 하는 문장은 아무것도 바꾸지 않는다 (021이 확인용 SELECT를 남겼다).
  /^\s*SELECT\b/i,
  // **조건이 붙은 backfill.** 새 칸을 채우는 정상적인 방법이다.
  // 조건 없는 UPDATE는 위 DESTRUCTIVE에서 이미 걸러진 뒤다.
  /\bUPDATE\b[\s\S]*?\bSET\b[\s\S]*?\bWHERE\b/i,
  /\bINSERT\s+INTO\b/i,
];

/** SQL에서 주석과 문자열을 지운다 — 주석 속 단어로 판정하지 않기 위해 */
function stripNoise(sql: string): string {
  return String(sql ?? '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, ' $$ ');
}

// ── SQL을 글자 단위로 읽는다 ──
//
// **정규식 하나를 더 붙이는 것으로는 안 된다.** `stripNoise()`는 `$$ … $$`를
// 통째로 지우는데, 그러면 DO 블록의 몸통이 사라진다. 그 상태에서
// classifyMigration은 `DO`로 시작한다는 이유로 문장을 건너뛰었다. 즉
//
//   DO $$ BEGIN DROP TABLE important; END $$;
//
// 가 "표·칸·인덱스·정책을 더하기만 합니다"로 통과했다. DO는 정의가 아니라
// **마이그레이션이 도는 그 순간 실행되는 코드**다. 안을 봐야 한다.
//
// 그래서 여기서는 주석·문자열·따옴표 식별자·달러 인용을 실제로 구분한다.
// 그래야 두 가지를 동시에 지킬 수 있다:
//   · 주석이나 문자열 안의 `DROP TABLE`을 위험으로 읽지 않는다
//   · 달러 인용 안에 있다는 이유로 진짜 `DROP TABLE`을 놓치지 않는다
//
// `stripNoise()`는 그대로 둔다 — `migrationTargets()`가 쓰는 시야이고,
// 거기서 DO 몸통을 열면 지금까지 대상이 아니던 것이 갑자기 대상이 된다.
// 판정 시야와 대상 시야는 다른 질문에 답한다.

interface SqlPiece {
  /** 원문 그대로 */
  raw: string;
  /** 주석·문자열을 지운 시야. 달러 인용 몸통은 `dollar`에 따로 담는다 */
  code: string;
  /** 이 문장이 달러 인용을 열었다면 그 몸통들 (태그 순서대로) */
  dollars: Array<{ tag: string; body: string }>;
}

interface SqlScan {
  pieces: SqlPiece[];
  /**
   * 끝까지 읽지 못한 것들.
   *
   * **비어 있지 않으면 이 SQL은 판정하지 않는다.** 인용이나 주석이 닫히지
   * 않으면 그 뒤로는 무엇이 코드이고 무엇이 글자인지 알 수 없다. 그런데도
   * 앞쪽에서 `CREATE TABLE`을 봤다는 이유로 "더하기만 합니다"라고 적으면,
   * 못 읽은 것을 통과로 적는 것이다.
   */
  errors: string[];
}

/**
 * 문장 단위로 자른다. `;`는 **주석·문자열·달러 인용 밖에 있을 때만** 구분자다.
 * 달러 인용 안의 `;`로 자르면 DO 블록이 조각나 뜻을 잃는다.
 */
function splitStatements(sql: string): SqlScan {
  const src = String(sql ?? '');
  const out: SqlPiece[] = [];
  const errors: string[] = [];
  let raw = '', code = '';
  let dollars: SqlPiece['dollars'] = [];
  let i = 0;

  const flush = () => {
    if (raw.trim()) out.push({ raw: raw.trim(), code, dollars });
    raw = ''; code = ''; dollars = [];
  };

  while (i < src.length) {
    const two = src.slice(i, i + 2);

    // 줄 주석 — 여기 적힌 DROP TABLE은 설명이지 명령이 아니다
    if (two === '--') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      raw += src.slice(i, stop); code += ' '; i = stop;
      continue;
    }
    // 블록 주석. PostgreSQL은 중첩을 허용한다
    if (two === '/*') {
      let depth = 1; let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src.slice(j, j + 2) === '/*') { depth += 1; j += 2; continue; }
        if (src.slice(j, j + 2) === '*/') { depth -= 1; j += 2; continue; }
        j += 1;
      }
      if (depth > 0) errors.push('블록 주석 /* 가 닫히지 않았습니다');
      raw += src.slice(i, j); code += ' '; i = j;
      continue;
    }
    // 문자열. '' 는 작은따옴표 한 개를 뜻한다
    if (src[i] === "'") {
      let j = i + 1; let closed = false;
      while (j < src.length) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") { j += 2; continue; }
          j += 1; closed = true; break;
        }
        j += 1;
      }
      if (!closed) errors.push("작은따옴표 문자열이 닫히지 않았습니다");
      raw += src.slice(i, j); code += "''"; i = j;
      continue;
    }
    // 따옴표 식별자. "" 는 큰따옴표 한 개
    if (src[i] === '"') {
      let j = i + 1; let closed = false;
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { j += 2; continue; }
          j += 1; closed = true; break;
        }
        j += 1;
      }
      if (!closed) errors.push('큰따옴표 식별자가 닫히지 않았습니다');
      const lit = src.slice(i, j);
      raw += lit; code += lit; i = j;
      continue;
    }
    // 달러 인용 — `$$` 와 `$do$` 같은 태그 인용 둘 다
    const dq = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
    if (dq) {
      const tag = dq[0];
      const bodyStart = i + tag.length;
      const close = src.indexOf(tag, bodyStart);
      if (close < 0) {
        // 닫히지 않은 인용. 여기서부터는 뜻을 알 수 없다
        errors.push(`달러 인용 ${tag} 가 닫히지 않았습니다`);
        raw += src.slice(i); code += ' '; i = src.length;
        continue;
      }
      const body = src.slice(bodyStart, close);
      dollars.push({ tag, body });
      raw += src.slice(i, close + tag.length);
      // 판정 시야에는 자리만 남긴다. 몸통은 dollars로 따로 본다
      code += ' $DOLLAR$ ';
      i = close + tag.length;
      continue;
    }
    if (src[i] === ';') { raw += ';'; code += ' '; i += 1; flush(); continue; }

    raw += src[i]; code += src[i]; i += 1;
  }
  flush();
  return { pieces: out, errors };
}

/** PL/pgSQL 제어 흐름 — 실행 의미가 아니라 뼈대다 */
const CONTROL_FLOW = new RegExp(
  '^(?:<<\\w+>>\\s*)?(?:' + [
    'DECLARE', 'BEGIN', 'END(?:\\s+(?:IF|LOOP|CASE))?', 'IF', 'ELSIF', 'ELSEIF', 'ELSE', 'THEN',
    'CASE', 'WHEN', 'LOOP', 'FOR', 'FOREACH', 'WHILE', 'EXIT', 'CONTINUE', 'RETURN',
    'NULL', 'RAISE', 'PERFORM', 'ASSERT', 'EXCEPTION', 'GET\\s+(?:CURRENT\\s+|STACKED\\s+)?DIAGNOSTICS',
    'COMMENT\\s+ON', 'SET', 'RESET',
  ].join('|') + ')\\b', 'i');

/** `v := expr` 같은 대입 */
const ASSIGNMENT = /^[A-Za-z_][\w.]*\s*(?::=|=[^=])/;

/**
 * DO 블록 안을 본다.
 *
 * **`EXECUTE`를 만나면 거기서 멈춘다.** 문자열을 조립해 실행하는 SQL이
 * 무엇이 될지는 실행해 봐야 안다. `format('%I')`로 감싸 안전해 보여도,
 * 그것을 일반적으로 안전하다고 증명하는 것은 다른 문제다. 지금 이 파일이
 * 안전한 것과 앞으로 올 모든 `EXECUTE`가 안전한 것은 같지 않다.
 */
function classifyDoBody(body: string): { risk: MigrationRisk; reasons: string[] } {
  const danger: string[] = [];
  const unknown: string[] = [];

  const scan = splitStatements(body);
  if (scan.errors.length > 0) {
    return { risk: 'UNKNOWN', reasons: scan.errors.map(e => `DO 블록을 끝까지 읽지 못했습니다 — ${e}`) };
  }

  for (const piece of scan.pieces) {
    const st = piece.code.replace(/\s+/g, ' ').trim();
    if (!st || !/[A-Za-z]/.test(st)) continue;

    // 동적 실행. 무엇이 돌지 정적으로 알 수 없다
    if (/\bEXECUTE\b/i.test(st)) {
      unknown.push('DO 블록 안에서 EXECUTE로 SQL을 조립해 실행합니다');
      continue;
    }

    const hit = DESTRUCTIVE_PATTERNS.filter(d => d.re.test(st));
    if (hit.length > 0) { danger.push(...hit.map(h => `DO 블록 안에서 ${h.why}`)); continue; }
    if (ADDITIVE_PATTERNS.some(re => re.test(st))) continue;
    if (CONTROL_FLOW.test(st) || ASSIGNMENT.test(st)) continue;

    unknown.push(`DO 블록 안에 알아보지 못한 문장이 있습니다: ${st.slice(0, 60)}`);
  }

  if (danger.length) return { risk: 'DESTRUCTIVE', reasons: Array.from(new Set(danger)) };
  if (unknown.length) return { risk: 'UNKNOWN', reasons: Array.from(new Set(unknown)) };
  return { risk: 'ADDITIVE', reasons: [] };
}

/**
 * 이 마이그레이션은 자동으로 적용해도 되는가.
 *
 * **판단하지 못한 것은 UNKNOWN이다.** '아마 괜찮겠지'가 데이터를 지운다.
 */
export function classifyMigration(sql: string): MigrationClass {
  const scan = splitStatements(sql);

  // **끝까지 읽지 못했으면 거기서 끝이다.**
  //
  // 인용이나 주석이 닫히지 않으면 그 뒤로는 무엇이 코드이고 무엇이 글자인지
  // 알 수 없다. 앞쪽에서 `CREATE TABLE`을 이미 봤더라도 통과시키지 않는다 —
  // 그것은 "안전하다"가 아니라 "앞부분만 읽었다"이다.
  if (scan.errors.length > 0) {
    return {
      risk: 'UNKNOWN', autoApply: false,
      reasons: [`SQL을 끝까지 읽지 못했습니다: ${Array.from(new Set(scan.errors)).join(' / ')}`],
    };
  }

  // 문장이 하나라도 있는가. 빈 파일을 '안전'으로 읽지 않는다.
  const statements = scan.pieces.filter(p => /[A-Za-z]/.test(p.code) || p.dollars.length > 0);
  if (statements.length === 0) {
    return { risk: 'UNKNOWN', reasons: ['실행할 문장을 찾지 못했습니다'], autoApply: false };
  }

  // **문장 하나씩 본다.** 파일 전체를 한 덩어리로 보면 뒤 문장의 WHERE가
  // 앞 문장의 DELETE를 안전해 보이게 만든다.
  const danger: string[] = [];
  const unknown: string[] = [];
  for (const piece of statements) {
    const st = piece.code.replace(/\s+/g, ' ').trim();

    // **DO는 건너뛰지 않는다.** 정의가 아니라 지금 실행되는 코드다.
    if (/^DO\b/i.test(st)) {
      if (piece.dollars.length === 0) {
        unknown.push('DO 블록의 몸통을 읽지 못했습니다 (달러 인용이 닫히지 않았을 수 있습니다)');
        continue;
      }
      for (const d of piece.dollars) {
        const inner = classifyDoBody(d.body);
        if (inner.risk === 'DESTRUCTIVE') danger.push(...inner.reasons);
        else if (inner.risk === 'UNKNOWN') unknown.push(...inner.reasons);
      }
      continue;
    }
    if (/^(BEGIN|COMMIT|END|SET)\b/i.test(st)) continue;

    // CREATE FUNCTION의 몸통은 여기서 열지 않는다. 정의할 때 도는 것이
    // 아니라 나중에 불릴 때 도는 것이고, 그 판단은 이 파일의 몫이 아니다.
    const hit = DESTRUCTIVE_PATTERNS.filter(d => d.re.test(st));
    if (hit.length > 0) { danger.push(...hit.map(h => h.why)); continue; }
    if (ADDITIVE_PATTERNS.some(re => re.test(st))) continue;
    unknown.push(st.slice(0, 60));
  }

  if (danger.length > 0) {
    return { risk: 'DESTRUCTIVE', reasons: Array.from(new Set(danger)), autoApply: false };
  }
  if (unknown.length > 0) {
    const uniq = Array.from(new Set(unknown));
    return {
      risk: 'UNKNOWN', autoApply: false,
      reasons: [`알아보지 못한 문장이 ${uniq.length}개 있습니다: ${uniq.slice(0, 3).join(' / ')}`],
    };
  }
  return { risk: 'ADDITIVE', reasons: ['표·칸·인덱스·정책을 더하기만 합니다'], autoApply: true };
}

/** `056_ledger_events.sql` → 56. 숫자로 시작하지 않으면 null */
export function migrationIdOf(name: string): number | null {
  const m = /^(\d{3,})[_-]/.exec(String(name ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export type PlanCode =
  /** 적용할 것이 없다 */
  | 'UP_TO_DATE'
  /** 자동으로 적용할 것이 있다 */
  | 'READY'
  /** 사람 승인이 필요한 것이 있다 */
  | 'NEEDS_APPROVAL'
  /** 적용 상태를 읽지 못했다. **UP_TO_DATE가 아니다** */
  | 'UNKNOWN';

export interface MigrationPlan {
  code: PlanCode;
  required: string[];
  applied: string[];
  pending: string[];
  /** 자동으로 적용할 것 (순서대로) */
  autoApply: string[];
  /** 승인이 필요해 멈춘 것 */
  blocked: Array<{ name: string; risk: MigrationRisk; reasons: string[] }>;
  reason: string;
}

/**
 * 무엇을 적용해야 하는가.
 *
 * **적용 목록을 못 읽었으면 '전부 적용됨'이 아니다.** 그 상태에서
 * 자동 적용을 돌리면 이미 적용된 것을 다시 실행한다.
 */
export function migrationPlanOf(i: {
  files: MigrationFile[];
  /** DB에 기록된 적용 목록. **null이면 못 읽은 것이다** */
  applied: string[] | null;
}): MigrationPlan {
  const files = (Array.isArray(i?.files) ? i.files : [])
    .filter(f => f && typeof f.name === 'string')
    // 번호 순. 번호가 없는 파일은 뒤로 보내되 자동 적용하지 않는다.
    .slice().sort((a, b) => (a.id ?? 1e9) - (b.id ?? 1e9) || a.name.localeCompare(b.name));

  const required = files.map(f => f.name);

  if (i?.applied == null) {
    return {
      code: 'UNKNOWN', required, applied: [], pending: [], autoApply: [], blocked: [],
      reason: '적용 기록을 읽지 못했습니다 — "전부 적용됨"이 아닙니다. 아무것도 실행하지 않습니다',
    };
  }

  const appliedSet = new Set(i.applied.map(s => String(s)));
  const applied = required.filter(n => appliedSet.has(n));
  const pendingFiles = files.filter(f => !appliedSet.has(f.name));
  const pending = pendingFiles.map(f => f.name);

  if (pending.length === 0) {
    return { code: 'UP_TO_DATE', required, applied, pending: [], autoApply: [], blocked: [],
      reason: `마이그레이션 ${required.length}개가 모두 적용돼 있습니다` };
  }

  const autoApply: string[] = [];
  const blocked: MigrationPlan['blocked'] = [];
  for (const f of pendingFiles) {
    if (f.id == null) {
      blocked.push({ name: f.name, risk: 'UNKNOWN',
        reasons: ['번호가 없어 적용 순서를 정할 수 없습니다'] });
      continue;
    }
    const c = classifyMigration(f.sql);
    if (c.autoApply) autoApply.push(f.name);
    else blocked.push({ name: f.name, risk: c.risk, reasons: c.reasons });
  }

  // **막힌 것이 하나라도 있으면 그 앞까지만 적용한다.**
  // 순서를 건너뛰고 뒤엣것을 먼저 적용하면 스키마가 뒤엉킨다.
  const firstBlocked = pending.find(n => blocked.some(b => b.name === n));
  const safeAuto = firstBlocked
    ? autoApply.filter(n => pending.indexOf(n) < pending.indexOf(firstBlocked))
    : autoApply;

  if (blocked.length > 0) {
    return {
      code: 'NEEDS_APPROVAL', required, applied, pending, autoApply: safeAuto, blocked,
      reason: `${blocked.length}개가 자동 적용 대상이 아닙니다 — ${blocked[0].name}: ${blocked[0].reasons[0]}`
        + (safeAuto.length ? ` (그 앞의 ${safeAuto.length}개는 먼저 적용합니다)` : ''),
    };
  }
  return {
    code: 'READY', required, applied, pending, autoApply: safeAuto, blocked: [],
    reason: `${safeAuto.length}개를 자동으로 적용합니다`,
  };
}

// ── 코드가 필요로 하는 마이그레이션이 없으면 들어가지 않는다 ──

export interface EntryGate {
  allowed: boolean;
  code: 'OK' | 'MIGRATION_PENDING' | 'MIGRATION_UNKNOWN';
  reason: string;
}

/**
 * **적용이 안 끝났으면 새 주문을 내지 않는다.**
 *
 * 코드가 새 칸을 쓰는데 DB에 그 칸이 없으면, 쓰기는 조용히 실패하고
 * 매매는 계속된다 — 그게 054에서 실제로 일어난 일이다(워커 버전이
 * 영영 '모름'이었다). 모르면 멈추는 쪽이 맞다.
 */
export function migrationEntryGate(plan: MigrationPlan | null | undefined): EntryGate {
  if (!plan || plan.code === 'UNKNOWN') {
    return { allowed: false, code: 'MIGRATION_UNKNOWN',
      reason: '마이그레이션 적용 상태를 확인하지 못했습니다 — 확인하지 못한 것을 통과로 보지 않습니다' };
  }
  if (plan.pending.length > 0) {
    return {
      allowed: false, code: 'MIGRATION_PENDING',
      reason: `적용되지 않은 마이그레이션이 ${plan.pending.length}개 있습니다 (${plan.pending.slice(0, 3).join(', ')}) — `
        + '코드가 필요로 하는 칸이 DB에 없을 수 있습니다',
    };
  }
  return { allowed: true, code: 'OK', reason: '마이그레이션이 모두 적용돼 있습니다' };
}

// ── 적용한 뒤에 "정말 생겼는가"를 묻는다 ──
//
// psql이 0으로 끝났다는 것은 **문장이 오류를 내지 않았다**는 뜻이지
// 표가 생겼다는 뜻이 아니다. `CREATE TABLE IF NOT EXISTS`는 이미 있어도
// 조용히 통과하고, `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL`은
// 실패를 삼키도록 우리가 직접 써 놓은 관용구다. 그래서 적용 뒤에
// 카탈로그에 대고 다시 묻는다.

export type TargetKind = 'table' | 'index' | 'column' | 'policy' | 'function';

export interface MigrationTarget {
  kind: TargetKind;
  /** 표 이름 (column·policy는 어느 표인지). **function은 표가 없어 스키마를 적는다** */
  table: string;
  /** index·column·policy의 이름. table이면 표 이름과 같다 */
  name: string;
}

/** 스키마 접두사와 따옴표를 벗긴다 — `public."t"` → `t` */
function bareName(s: string): string {
  const last = String(s ?? '').trim().split('.').pop() || '';
  return last.replace(/^"(.*)"$/, '$1').trim();
}

/**
 * 이 마이그레이션이 만들어야 하는 것들.
 *
 * **못 알아본 문장은 목록에 넣지 않는다.** 여기서 지어낸 이름으로
 * 검증하면 있지도 않은 것을 찾다가 멀쩡한 적용을 실패로 적는다.
 */
export function migrationTargets(sql: string): MigrationTarget[] {
  const body = stripNoise(sql);
  const out: MigrationTarget[] = [];
  const seen = new Set<string>();
  const push = (t: MigrationTarget) => {
    const k = `${t.kind}:${t.table}:${t.name}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };

  const ident = `[A-Za-z_"][\\w".$]*`;
  // exec 반복으로 훑는다. matchAll은 es2019 lib에 없어 테스트 컴파일에서 걸린다.
  const scan = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(body)) !== null) {
      fn(m);
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  };

  scan(new RegExp(`\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${ident})`, 'gi'), m => {
    const t = bareName(m[1]);
    if (t) push({ kind: 'table', table: t, name: t });
  });
  scan(new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${ident})\\s+ON\\s+(${ident})`, 'gi'), m => {
    const n = bareName(m[1]); const t = bareName(m[2]);
    if (n && t) push({ kind: 'index', table: t, name: n });
  });
  scan(new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${ident})\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${ident})`, 'gi'), m => {
    const t = bareName(m[1]); const c = bareName(m[2]);
    if (t && c) push({ kind: 'column', table: t, name: c });
  });
  scan(new RegExp(`\\bCREATE\\s+POLICY\\s+(${ident})\\s+ON\\s+(${ident})`, 'gi'), m => {
    const n = bareName(m[1]); const t = bareName(m[2]);
    if (n && t) push({ kind: 'policy', table: t, name: n });
  });

  // **함수도 확인 대상이다.**
  //
  // 072(모의 청산 원자 정산)는 표도 칸도 만들지 않고 함수 셋만 만든다.
  // 그때까지 이 함수는 함수를 몰라서 대상 0개를 돌려줬고, 파이프라인은
  // `확인할 대상 없음 (실행은 성공)`으로 적었다 — **psql이 0으로 끝났다는
  // 것과 함수가 실제로 생겼다는 것은 다른 사실이다.**
  //
  // 이 저장소에서 앞으로 원자성은 대부분 함수로 들어온다. 확인하지 못한
  // 것을 통과로 적는 자리를 여기서 닫는다.
  scan(new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(${ident})`, 'gi'), m => {
    const n = bareName(m[1]);
    if (n) push({ kind: 'function', table: 'public', name: n });
  });
  return out;
}

// ── 채택해도 되는 파일인가 ──
//
// **무엇이 잘못됐나**
// ───────────────────
// 채택(adopt)은 "카탈로그에 대상이 다 있으니 실행하지 않고 적용된 것으로
// 적는다"이다. 그 판단이 **위험도 분류보다 먼저** 돌았다. 그래서 채택된
// 파일은 `blocked`에 들어갈 기회 자체가 없었고, UNKNOWN·DESTRUCTIVE가
// 승인 없이 BASELINE으로 적혔다:
//
//   --check   남음 2 / 승인 필요 2 → NEEDS_APPROVAL (081 UNKNOWN · 082 DESTRUCTIVE)
//   --apply   이미 적용돼 있던 2개를 실행 없이 기록 → UP_TO_DATE
//
// 같은 head인데 위험도 판단이 뒤집혔다. 그 뒤로 runner는 영원히 "적용됨"이라고
// 믿는다 — 실제 스키마가 어떻든.
//
// **이름이 있다는 것은 의미가 같다는 뜻이 아니다**
// ─────────────────────────────────────────────────
// 카탈로그 조회는 이름만 답한다. 표·인덱스·칸·정책은 그래도 "그 이름의 것이
// 있다"가 곧 "그 문장이 만들려던 것이 있다"에 가깝다. **함수는 다르다.**
//
//   082가 만드는 함수 5개 중 4개는 072/074/075부터 있던 이름이다.
//   `paper_open_position`에 `p_paper_account_id`가 붙었는지는 이름으로
//   알 수 없고, 본문이 바뀌었는지는 더더욱 알 수 없다.
//
// 그러므로 **함수를 만드는 마이그레이션은 이름만으로 채택하지 않는다.**
// 채택하지 않으면 그 파일은 실제로 실행되는데, `CREATE OR REPLACE FUNCTION`은
// 여러 번 실행해도 같은 결과라 그게 안전한 쪽이다. 함수를 지우는 파일은
// 어차피 DESTRUCTIVE로 먼저 막힌다.
//
// 확인하지 못한 것은 통과가 아니다 — 그 원칙을 채택에도 적용한다.

export type AdoptionCode =
  /** 채택해도 된다 (카탈로그 확인은 부르는 쪽이 따로 한다) */
  | 'ADOPTABLE'
  /** 자동 적용 대상이 아니다 — 승인이 필요한 것을 채택으로 우회하지 않는다 */
  | 'BLOCKED_RISK'
  /** 함수를 만든다 — 이름만으로는 시그니처도 본문도 확인할 수 없다 */
  | 'FUNCTION_TARGET'
  /** 확인할 대상이 없다 — 무엇이 있는지 물어볼 것이 없으면 증거도 없다 */
  | 'NO_TARGET';

export interface AdoptionVerdict {
  adoptable: boolean;
  code: AdoptionCode;
  reason: string;
  /** 참고용. 위험도 분류 결과를 그대로 싣는다 */
  risk: MigrationRisk;
}

/**
 * 이 파일을 **실행하지 않고** 적용된 것으로 적어도 되는가.
 *
 * **위험도 분류가 여기서 먼저 돈다.** `migrationPlanOf`와 같은
 * `classifyMigration`을 쓰므로 두 곳의 판단이 갈릴 수 없다 — 이 저장소의
 * 단골 고장인 "경로가 둘인데 한쪽만 고침"을 구조로 막는다.
 *
 * 카탈로그에 실제로 있는지는 **묻지 않는다.** 그건 DB가 필요한 일이라
 * 부르는 쪽(`apply-migrations.mjs`)이 한다. 여기서는 "물어볼 자격이
 * 있는가"만 정한다.
 */
export function adoptionVerdictOf(f: { name?: string; id?: number | null; sql?: string }): AdoptionVerdict {
  const sql = typeof f?.sql === 'string' ? f.sql : '';

  // ① 번호가 없으면 자동 적용 대상이 아니다 — 채택도 자동 적용의 한 형태다.
  if (f?.id == null) {
    return {
      adoptable: false, code: 'BLOCKED_RISK', risk: 'UNKNOWN',
      reason: '번호가 없어 자동 적용 대상이 아닙니다 — 채택으로 우회하지 않습니다',
    };
  }

  // ② **위험도 먼저.** DESTRUCTIVE·UNKNOWN은 어떤 경우에도 채택하지 않는다.
  const c = classifyMigration(sql);
  if (!c.autoApply) {
    return {
      adoptable: false, code: 'BLOCKED_RISK', risk: c.risk,
      reason: `${c.risk}라서 승인이 필요합니다 — 대상이 이미 있어도 채택하지 않습니다`
            + (c.reasons[0] ? ` (${c.reasons[0]})` : ''),
    };
  }

  const targets = migrationTargets(sql);

  // ③ 물어볼 것이 없으면 증거도 없다.
  if (targets.length === 0) {
    return {
      adoptable: false, code: 'NO_TARGET', risk: c.risk,
      reason: '확인할 대상을 찾지 못했습니다 — 무엇이 있는지 물어볼 수 없으면 채택하지 않습니다',
    };
  }

  // ④ 함수는 이름만으로 같다고 말할 수 없다.
  if (targets.some(t => t.kind === 'function')) {
    return {
      adoptable: false, code: 'FUNCTION_TARGET', risk: c.risk,
      reason: '함수를 만듭니다 — 같은 이름의 옛 함수가 있어도 시그니처·본문이 같다는 증거가 아닙니다',
    };
  }

  return {
    adoptable: true, code: 'ADOPTABLE', risk: c.risk,
    reason: `대상 ${targets.length}개를 카탈로그에서 확인할 수 있습니다`,
  };
}

/**
 * 채택을 시도해도 되는 파일들.
 *
 * **왜 목록으로 돌려주나 — 가드는 지워질 수 있다**
 * ────────────────────────────────────────────────
 * 처음에는 runner가 `files`를 돌면서 자리마다 `if (!adoptable) continue`로
 * 걸렀다. 그 모양은 **가드 한 줄만 무력화하면 뚫린다** — 돌연변이로
 * `if (false && !a.adoptable)`을 넣었더니 시험도 검사기도 초록이었다.
 * 검사기가 조건이 아니라 `!a.adoptable`이라는 **글자**를 보고 있었다.
 *
 * 그래서 거를 자리를 없앴다. runner는 이 함수가 돌려준 목록만 돈다.
 * 막힌 파일은 애초에 그 목록에 없으므로, 무력화하려면 **목록 자체를
 * 갈아치워야** 하고 그건 숨길 수 없다.
 *
 * 이미 기록된 파일은 후보가 아니다 — 채택은 기록이 없는 파일에만 뜻이 있다.
 */
export function adoptionCandidates(i: {
  files: MigrationFile[];
  /** DB에 기록된 적용 목록. **null이면 못 읽은 것이다 — 아무것도 채택하지 않는다** */
  applied: string[] | null;
}): { adopt: MigrationFile[]; refused: Array<{ name: string; code: AdoptionCode; reason: string }> } {
  const files = Array.isArray(i?.files) ? i.files.filter(f => f && typeof f.name === 'string') : [];

  // **기록을 못 읽었으면 채택하지 않는다.** 무엇이 이미 있는지 모르는 채로
  // "실행 안 해도 된다"를 적는 것은 근거 없는 기록이다.
  if (i?.applied == null) {
    return { adopt: [], refused: files.map(f => ({
      name: f.name, code: 'BLOCKED_RISK' as AdoptionCode,
      reason: '적용 기록을 읽지 못했습니다 — 채택하지 않습니다',
    })) };
  }

  const known = new Set(i.applied.map(s => String(s)));
  const adopt: MigrationFile[] = [];
  const refused: Array<{ name: string; code: AdoptionCode; reason: string }> = [];

  for (const f of files) {
    if (known.has(f.name)) continue;          // 이미 기록돼 있다 — 후보가 아니다
    const v = adoptionVerdictOf(f);
    if (v.adoptable) adopt.push(f);
    else refused.push({ name: f.name, code: v.code, reason: v.reason });
  }
  return { adopt, refused };
}

// ── 적용 기록 한 줄 ──

export interface AppliedRow {
  name: string;
  checksum: string | null;
  success: boolean;
}

export type DriftCode = 'OK' | 'CHECKSUM_CHANGED' | 'FAILED_BEFORE';

export interface Drift {
  name: string;
  code: DriftCode;
  reason: string;
}

/**
 * 이미 적용된 파일이 그 뒤에 바뀌었는가.
 *
 * **바뀌었다고 다시 실행하지 않는다.** 이미 돌아간 SQL을 한 번 더
 * 돌리는 것은 자동화가 할 일이 아니다 — 사람에게 말한다.
 */
export function migrationDrift(i: {
  files: MigrationFile[];
  rows: AppliedRow[];
  checksumOf: (f: MigrationFile) => string;
}): Drift[] {
  const rows = Array.isArray(i?.rows) ? i.rows : [];
  const byName = new Map(rows.map(r => [String(r.name), r]));
  const out: Drift[] = [];
  for (const f of (Array.isArray(i?.files) ? i.files : [])) {
    const row = byName.get(f.name);
    if (!row) continue;
    if (!row.success) {
      out.push({ name: f.name, code: 'FAILED_BEFORE',
        reason: '지난번 적용이 실패한 채로 남아 있습니다 — 원인을 확인해야 합니다' });
      continue;
    }
    const now = i.checksumOf(f);
    if (row.checksum && now && row.checksum !== now) {
      out.push({ name: f.name, code: 'CHECKSUM_CHANGED',
        reason: '적용된 뒤에 파일이 바뀌었습니다 — 지금 DB의 스키마는 이 파일과 다릅니다' });
    }
  }
  return out;
}

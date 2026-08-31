#!/usr/bin/env node
// scripts/check-migration-catalog-types.mjs
//
// **카탈로그의 `name` 값을 모아 `text[]` 리터럴과 직접 비교하지 않는다.**
//
// 무슨 일이 있었나
// ────────────────
// `050_schedule_strategy.sql`의 DO 블록이 옛 `(user_id, symbol)` 유니크를
// 찾으려고 이렇게 적었다:
//
//   array_agg(att.attname ORDER BY att.attname) = ARRAY['symbol', 'user_id']
//
// `pg_attribute.attname`은 `name` 타입이다. 그래서 좌변은 `name[]`이 되고,
// 우변은 원소가 전부 unknown 리터럴이라 기본값인 `text[]`로 굳는다.
// 배열 등호는 `anyarray = anyarray` 하나뿐이고 다형 타입이라 **양변이 같은
// 배열 타입으로 이미 해석돼 있어야 한다.** `name → text`가 암묵 캐스트라
// 스칼라 비교는 통과하지만(`string_agg(att.attname, ', ')`는 멀쩡하다)
// 배열 피연산자에는 그 원소 캐스트가 적용되지 않는다:
//
//   ERROR: operator does not exist: name[] = text[]   (SQLSTATE 42883)
//
// 그래서 이 블록은 **처음부터 한 번도 실행된 적이 없다.** 빈 DB에 처음부터
// 재생하는 모든 곳(Supabase Preview·새 개발 환경·복구용 재구축)이 여기서
// 멈췄고, 050 이후 번호는 읽히지도 않았다.
//
// 왜 테스트로 안 잡혔나
// ─────────────────────
// CI가 SQL을 **한 줄도 실행하지 않기 때문이다.** 문법이 아니라 실행 시점
// 연산자 해석 오류라 파서로는 안 걸리고, PL/pgSQL 본문은 그 `FOR … IN
// SELECT`가 실제로 돌 때 계획된다. 진짜 해법은 빈 DB 재생 CI이고 그건
// 별도 작업이다. 이 검사는 **이번 오류의 정확한 모양**을 고정한다.
//
// 무엇을 보는가
// ─────────────
//   `pg_catalog`의 `name` 타입 칸(attname · relname · conname …)을
//   `array_agg(...)`으로 모은 뒤, 타입을 맞추지 않고 `ARRAY['...']`
//   리터럴과 직접 비교하는 자리.
//
//   `::text`(또는 `::name[]`)로 양변을 맞췄으면 통과한다.
//
// **값도 비밀도 읽지 않는다.** 이 검사가 보는 것은 SQL의 모양뿐이다.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIR = join(ROOT, 'supabase', 'migrations');
let bad = 0;
const fail = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };

/**
 * SQL 주석을 지운다 — 줄 주석, 블록 주석, 그리고 **달러 인용 안쪽까지**.
 *
 * **안 지우면 검사가 제 설명문을 코드로 읽는다.** 이 저장소는 그 고장을
 * 여러 번 겪었고, 이번에 고치는 파일은 하필 "예전에는 이렇게 적었다"는
 * 역사를 `DO $$ … $$` 본문 주석에 남긴다. 달러 인용을 통째로 통과시키면
 * 그 설명이 위반으로 읽히고, 반대로 진짜 위반을 주석 뒤에 숨길 수도 있다.
 */
function stripSql(src) {
  const s = String(src);
  let out = '';
  let i = 0;
  while (i < s.length) {
    // 달러 인용: 태그를 찾아 그 안을 재귀적으로 정리한 뒤 이어 붙인다
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(s.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = s.indexOf(tag, i + tag.length);
      if (end < 0) { out += s.slice(i); break; }
      out += tag + stripSql(s.slice(i + tag.length, end)) + tag;
      i = end + tag.length;
      continue;
    }
    if (s[i] === '-' && s[i + 1] === '-') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (s[i] === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2; continue;
    }
    if (s[i] === "'") {
      out += s[i]; i += 1;
      while (i < s.length && s[i] !== "'") { out += s[i]; i += 1; }
      out += "'"; i += 1; continue;
    }
    out += s[i]; i += 1;
  }
  return out;
}

/**
 * `pg_catalog`에서 타입이 `name`인 칸들.
 *
 * 전부는 아니고 이 저장소가 실제로 훑는 것들이다. 목록을 억지로 넓히면
 * 오탐이 늘고, 오탐이 늘면 규칙이 무시된다.
 */
const NAME_COLUMNS = ['attname', 'relname', 'conname', 'nspname', 'proname', 'indexname', 'typname'];

/** 괄호를 세어 `(`의 짝을 찾는다 */
function matchParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** `array_agg( … )`의 인자를 떼어 낸다 */
function argOf(src, openIdx) {
  const close = matchParen(src, openIdx);
  return close < 0 ? '' : src.slice(openIdx + 1, close);
}

/**
 * 이 `array_agg(...)`를 감싼 서브쿼리 괄호의 짝 뒤를 돌려준다.
 *
 * **여기서 한 번 뚫렸다.** 처음엔 `array_agg(...)`의 닫는 괄호 **바로 뒤**에
 * 비교가 오는 줄 알고 그 자리만 봤다. 그런데 실제 모양은 이렇다:
 *
 *   AND ( SELECT array_agg(att.attname …)
 *           FROM unnest(con.conkey) … ) = ARRAY['symbol','user_id']
 *
 * 사이에 FROM 절이 통째로 들어간다. 그래서 검사가 비교를 못 찾고 조용히
 * 넘어갔고 — **버그를 그대로 되돌려 넣어도 통과했다.** 감싼 괄호를 거슬러
 * 올라가 그 짝 뒤를 봐야 한다.
 */
function afterEnclosing(src, aggStart) {
  let depth = 0;
  for (let i = aggStart - 1; i >= 0; i -= 1) {
    if (src[i] === ')') depth += 1;
    else if (src[i] === '(') {
      if (depth === 0) {
        const close = matchParen(src, i);
        // **닫는 괄호는 빼고 돌려준다.** 포함해서 돌려줬더니 뒤에서 쓰는
        // `^\s*=` 앵커가 그 `)`에 막혀 한 번도 안 맞았다 — 검사가 조용히
        // 아무것도 안 잡았다.
        return close < 0 ? '' : src.slice(close + 1);
      }
      depth -= 1;
    }
  }
  return '';
}

const files = readdirSync(DIR).filter(n => n.endsWith('.sql')).sort();
if (files.length === 0) fail('supabase/migrations에 SQL이 없습니다 — 검사가 대상을 잃었습니다');

let scanned = 0;
for (const name of files) {
  const sql = stripSql(readFileSync(join(DIR, name), 'utf8'));
  const re = /\barray_agg\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const open = m.index + m[0].length - 1;
    const arg = argOf(sql, open);
    if (!arg) continue;
    // **집계되는 식만 본다.** `ORDER BY` 뒤는 결과 타입과 무관하다.
    //
    // 처음엔 인자 전체에서 캐스트를 찾았다. 그랬더니
    //   array_agg(att.attname ORDER BY att.attname::text)
    // 가 통과했다 — 집계식은 캐스트가 없어 결과는 그대로 `name[]`인데,
    // 정렬 쪽 캐스트를 보고 "맞췄다"고 읽은 것이다. **되돌리기 검증에서
    // 이 구멍이 그대로 드러났다.**
    const aggExpr = arg.split(/\bORDER\s+BY\b/i)[0];
    const col = NAME_COLUMNS.find(c => new RegExp(`\\b${c}\\b`).test(aggExpr));
    if (!col) continue;
    scanned += 1;

    // 집계식 안에서 `name`을 벗어났는가. `att.attname::text` 형태를 본다.
    const casted = new RegExp(`\\b${col}\\s*::\\s*(?:text|varchar|character\\s+varying)`, 'i').test(aggExpr);

    // 이 array_agg 결과를 `ARRAY[ … ]` 리터럴과 비교하는가.
    //
    // 두 자리를 본다: array_agg의 닫는 괄호 바로 뒤(직접 비교), 그리고
    // 이것을 감싼 서브쿼리 괄호의 짝 뒤(050의 실제 모양).
    const rightAfter = sql.slice(matchParen(sql, open) + 1);   // array_agg(...) 바로 뒤
    const afterSubquery = afterEnclosing(sql, m.index);          // 감싼 서브쿼리 뒤
    let cmp = null;
    for (const after of [rightAfter, afterSubquery]) {
      const hit = /^\s*(?:=|<>|!=)\s*(ARRAY\s*\[[^\]]*\]\s*(?:::\s*\w+\s*\[\s*\])?)/i.exec(after);
      if (hit) { cmp = hit[1]; break; }
    }
    if (!cmp) continue;                       // 비교가 아니면 이 검사의 대상이 아니다

    // 우변을 `::name[]`으로 올려 맞춘 것도 정당한 해법이다 — 막지 않는다.
    const rhsCast = /::\s*name\s*\[\s*\]/i.test(cmp);

    if (!casted && !rhsCast) {
      fail(`supabase/migrations/${name}: array_agg(${col} …)을 타입을 맞추지 않고 ARRAY[…] 리터럴과 비교합니다`
        + `\n     pg_catalog의 ${col}은 \`name\` 타입이라 좌변은 name[]이고, 원소가 전부`
        + '\n     리터럴인 ARRAY[…]는 text[]로 굳습니다. 배열 등호는 anyarray = anyarray'
        + '\n     하나뿐이라 양변이 같은 배열 타입이어야 하고, name→text 암묵 캐스트는'
        + '\n     배열 피연산자에 적용되지 않습니다:'
        + '\n       ERROR: operator does not exist: name[] = text[]  (SQLSTATE 42883)'
        + `\n     이 문장은 실행되는 순간 항상 실패합니다. \`${col}::text\`로 모으세요.`);
    }
  }
}

if (bad > 0) {
  console.error(`\n마이그레이션 카탈로그 타입 검사 실패 ${bad}건`);
  console.error('빈 DB에 처음부터 재생하는 곳(Supabase Preview·새 개발 환경)이 이 문장에서 멈춥니다.');
  console.error('그리고 그 뒤 번호의 마이그레이션은 읽히지도 않습니다.');
  process.exit(1);
}
console.log(`✅ 마이그레이션 카탈로그 타입 — array_agg로 카탈로그 이름을 모아 비교하는 ${scanned}곳이`);
console.log('   전부 타입을 맞춰서 비교합니다 (name[] = text[] 실행 시점 오류 없음)');

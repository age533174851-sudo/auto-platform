// scripts/lib/reapply-migrations.mjs
//
// **정본으로 되돌린다는 것은 뒤엣것까지 되돌리는 것이다.**
//
// 뮤테이션 검사는 한 마이그레이션을 망가뜨렸다가 정본을 다시 세운다. 그런데
// 그 파일이 정의한 함수를 **뒤 번호가 이미 대체했다면**, 정본을 다시 세우는
// 순간 뒤엣것이 사라진다.
//
// 실제로 그랬다. `085` 뮤테이션 검사가 끝나면서 정본 085를 다시 세웠고,
// 그것이 `086`이 넣은 진입 상태 가드를 **덮어썼다.** 그 뒤에 도는 086 증명은
// 085의 함수를 검사하게 되고, "READY에서 진입이 막힌다"가 OPENED로 나온다.
// 검사 순서가 바뀌었을 뿐인데 계약이 깨진 것처럼 보인다 — 반대로, 계약이
// 실제로 깨졌는데 초록이 나올 수도 있다.
//
// 그래서 되돌릴 때는 그 파일을 덮어쓴 **뒤 번호도 함께** 다시 세운다.
//
// 처음에는 "뒤 번호 전부"였다. 그게 멈췄다 (#636)
// ───────────────────────────────────────────────
// 전부 다시 세우면 **086 이후 모든 마이그레이션이 재적용 가능해야 한다**는
// 요구가 생긴다. 어디에도 적혀 있지 않고, 검사기도 없고, 깨져도 그 자리에서는
// 안 보인다. 2026-11-13에 `099_paper_automation.sql`이 `IF NOT EXISTS` 없이
// 들어왔고, 그날부터 모의 챌린지 뮤테이션 증명 19건이 **한 번도 돌지 않았다.**
// 아무도 몰랐다.
//
// 그 요구는 고칠 수도 없었다 — 이미 적용된 마이그레이션은
// `src/lib/system/migrationLineage.ts`의 `BASE_FILE_CHANGED`가 수정을 막는다.
// 관문이 옳다. 즉 **만족시킬 방법이 없는 요구**였다.
//
// 그런데 099는 애초에 되돌릴 것이 없었다. 085도 086도 087도 정의하지 않는
// 표와 함수를 만들 뿐이다. 다시 세울 이유가 처음부터 없었다.
//
// 재적용의 목적은 "뒤엣것이 **이 파일의 정의를 덮어쓴 것**을 복원하는 것"이다.
// 그러니 덮어쓴 것만 다시 세운다. 2026-11-15 기준으로 실제 대상은 이뿐이다:
//
//     085 → 086 · 088 (paper_open_position · paper_settle_close)
//     086 → 088       (같은 둘)
//     087 → 없음
//
// 대상이 줄면 요구도 줄어든다. 그리고 남은 대상은 **덮어쓰는 파일**이라
// 본질적으로 `CREATE OR REPLACE`다 — 재적용이 원래 안전한 모양이다.
//
// ★ 자동으로 따라온다. 목록을 손으로 적지 않는다.
//   나중에 102가 `paper_open_position`을 다시 정의하면 그 순간부터
//   대상에 들어온다. 사람이 이 주석을 고칠 필요가 없다.
import { readdirSync, readFileSync } from 'node:fs';

/**
 * 이 SQL이 **정의하는** 객체 이름들.
 *
 * 부르기만 하는 것은 세지 않는다 — 099는 `paper_open_position`을 호출하지만
 * 정의하지 않는다. 호출까지 세면 099가 다시 끌려 들어오고, 이 수정이
 * 아무것도 고치지 못한다.
 */
export function definedObjects(sql) {
  const out = new Set();
  const pats = [
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-zA-Z_][\w.]*)/gi,
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+([a-zA-Z_][\w.]*)/gi,
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w.]*)/gi,
  ];
  for (const re of pats) {
    for (const m of String(sql).matchAll(re)) out.add(m[1].replace(/^public\./i, ''));
  }
  return out;
}

/**
 * `name`을 덮어쓰는 뒤 번호 파일만 고른다.
 *
 * @param {string} dir
 * @param {string} name
 * @returns {string[]} 번호 순 경로
 */
export function redefinitionsAfter(dir, name) {
  const base = definedObjects(readFileSync(`${dir}/${name}`, 'utf8'));
  if (base.size === 0) return [];
  return migrationsFrom(dir, name, { includeSelf: false }).filter(p => {
    const later = definedObjects(readFileSync(p, 'utf8'));
    for (const o of later) if (base.has(o)) return true;
    return false;
  });
}

/**
 * `name` 이후(포함)의 번호 마이그레이션 파일 경로를 번호 순으로 돌려준다.
 *
 * @param {string} dir  `supabase/migrations`
 * @param {string} name `085_paper_challenge_accounting.sql`
 * @param {{ includeSelf?: boolean }} [opts] 자기 자신을 뺄 때가 있다
 *        (뮤테이션 본문은 이미 따로 세우기 때문)
 */
export function migrationsFrom(dir, name, { includeSelf = true } = {}) {
  const numbered = readdirSync(dir).filter(n => /^\d{3}_.*\.sql$/.test(n)).sort();
  const at = numbered.indexOf(name);
  if (at < 0) return [];
  return numbered.slice(includeSelf ? at : at + 1).map(n => `${dir}/${n}`);
}

/**
 * `name` **뒤**의 마이그레이션을 순서대로 다시 세운다.
 *
 * **못 세웠으면 어느 파일인지 말한다.**
 *
 * 2026-11-13에 `099_paper_automation.sql`이 들어오면서 main의 모의 챌린지
 * 뮤테이션 증명이 통째로 멈췄다. 그런데 로그에 남은 것은 이 한 줄뿐이었다:
 *
 *     정본을 세우지 못했습니다
 *
 * 어느 파일인지, 왜인지가 없어서 재적용 대상 14개를 손으로 좁혀야 했다.
 * 그 사이 뮤테이션 19건은 하루 넘게 한 번도 검증되지 않았고, 아무도
 * 그 사실을 몰랐다 — 빨간 것은 보였지만 **무엇이 빨간지**는 안 보였다.
 *
 * 그래서 실패한 경로를 호출부에 넘긴다. 판정을 바꾸지는 않는다(여전히
 * false를 돌려준다). 바뀌는 것은 **무엇을 보고 고치면 되는가**뿐이다.
 *
 * @param {string} dir
 * @param {string} name
 * @param {(sql: string) => boolean} install  한 덩어리를 세우는 함수
 * @param {(path: string) => void} [onFail]   못 세운 파일을 알린다
 * @returns {boolean} 전부 세웠는가
 */
export function reapplyAfter(dir, name, install, onFail) {
  // **덮어쓴 것만** 다시 세운다. 상관없는 파일까지 세우면 그 파일들이
  // 전부 재적용 가능해야 한다는 숨은 요구가 생긴다 (#636).
  for (const p of redefinitionsAfter(dir, name)) {
    if (!install(readFileSync(p, 'utf8'))) {
      // **첫 실패에서 멈추고 그 이름을 남긴다.** 뒤엣것을 계속 세워 봐야
      // 이미 어긋난 상태 위에 쌓는 것이고, 로그만 길어진다.
      if (typeof onFail === 'function') onFail(p);
      return false;
    }
  }
  return true;
}

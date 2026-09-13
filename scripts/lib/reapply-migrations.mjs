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
// 그래서 되돌릴 때는 **그 파일과 그 뒤 번호 전부**를 다시 세운다.
import { readdirSync, readFileSync } from 'node:fs';

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
 * @param {string} dir
 * @param {string} name
 * @param {(sql: string) => boolean} install  한 덩어리를 세우는 함수
 * @returns {boolean} 전부 세웠는가
 */
export function reapplyAfter(dir, name, install) {
  for (const p of migrationsFrom(dir, name, { includeSelf: false })) {
    if (!install(readFileSync(p, 'utf8'))) return false;
  }
  return true;
}

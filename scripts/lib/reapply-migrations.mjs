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
  for (const p of migrationsFrom(dir, name, { includeSelf: false })) {
    if (!install(readFileSync(p, 'utf8'))) {
      // **첫 실패에서 멈추고 그 이름을 남긴다.** 뒤엣것을 계속 세워 봐야
      // 이미 어긋난 상태 위에 쌓는 것이고, 로그만 길어진다.
      if (typeof onFail === 'function') onFail(p);
      return false;
    }
  }
  return true;
}

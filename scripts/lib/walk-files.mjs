// scripts/lib/walk-files.mjs
//
// 디렉터리를 직접 걷는다. **발견이 조용히 비는 길을 막기 위한 것이다.**
//
// 왜 공용으로 두는가
// ──────────────────
// 여러 검사기가 `fs.globSync`로 대상을 찾는데, 없는 런타임이나 예외에서
// 빈 배열로 떨어지면 **아무것도 안 훑고 "0개"**를 적는다. 그 자리를 막으려면
// 대체 경로가 필요하고, 그 대체 경로를 검사기마다 따로 쓰면 네 벌이 된다.
// 이 저장소의 상습 고장 ② — "같은 판단이 두 곳에 있으면 언젠가 갈린다" —
// 가 걸리는 자리라 한 곳에 둔다.
//
// 판단은 하지 않는다. 어떤 파일을 남길지는 부르는 쪽이 `keep`으로 정한다.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `dir` 아래의 파일을 `keep(path)`가 참인 것만 모은다.
 *
 * 경로는 항상 `/`로 돌려준다 — 검사기들이 `src/app/api/...` 꼴로 비교한다.
 * 못 읽는 디렉터리·파일은 **건너뛰되 통과로 적지 않는다**: 비어서 돌아오면
 * 부르는 쪽이 "0건을 통과로 적지 않는다"를 판단해야 한다.
 */
export function walkFiles(dir, keep, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = join(dir, name).replaceAll('\\', '/');
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkFiles(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

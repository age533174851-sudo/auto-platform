// scripts/lib/error-dropped-supabase.mjs
//
// **Supabase 호출에서 `error`를 받지 않은 자리를 센다.**
//
// 왜 세는가
// ─────────
// `check-db-columns`의 머리말이 이 병에서 태어났다 — `/api/ledger/sync`가
// 없는 칸을 읽었는데 **조회 오류를 안 받고** `Array.isArray(conns) ? conns : []`
// 로 넘어가서 **연결 0개로 조용히 끝났다.** 그 검사기는 칸 이름을 대조해
// 그 한 건을 잡았지만, `error`를 버리는 모양 자체는 세지 않았다.
//
// 2026-11-20 하루에 같은 병이 세 곳에서 따로 나왔다:
//   · 모의 손절·익절 수정이 포지션 조회 실패를 404('없음')로 답했다 (#718)
//   · hooks.ts 다섯 곳이 조회 실패를 빈 목록으로 돌려주고 **캐시까지
//     덮어썼다** (#719)
//   · ai/keys 가 저장·삭제 실패를 성공으로 답했다 (#720)
//
// 셋 다 사람이 우연히 발견했다. 발견에 의존하는 동안 네 번째가 들어온다.
//
// 왜 전부 실패시키지 않는가
// ─────────────────────────
// 지금 저장소에 이 모양이 수십 곳 있다. 한 번에 다 고치는 것은 별개의 큰
// 작업이고, 그렇다고 검사를 빼면 **다음 한 곳이 조용히 들어온다.**
// 그래서 `tsc` 오류와 같은 방식으로 **개수를 세서 기준보다 늘면 실패**
// 시킨다. 줄이는 것은 언제나 환영이고, 그때는 기준선을 내린다.
//
// 무엇을 세는가 (좁게 고정한다)
// ─────────────────────────────
//   ① 읽기 — `const { data } = await ….from(…)` 처럼 **구조분해에 `error`가
//      없는** 것. `auth.getSession()` 류는 세지 않는다. 거기서 신호는
//      `error`가 아니라 `data.session`이고, 모양이 다르다.
//   ② 쓰기 — `await ….from(…).insert|update|upsert|delete(…)` 를 **결과에
//      아무것도 받지 않고** 문장으로 쓴 것. 실패하면 아무도 모른다.
//
// 정교한 파서가 아니라 **모양 세기**다. 그것만으로 위 셋은 정확히 걸린다.

/** 테이블 접근 체인인가 (`auth.*` 제외) */
const TABLE_CHAIN = /\.from\s*\(/;

/**
 * 한 파일에서 `error`를 버린 자리를 센다.
 *
 * 줄 단위가 아니라 **문장 단위**로 본다 — 이 저장소의 체인은 여러 줄에
 * 걸쳐 있고, 줄로 세면 `.from(`과 구조분해가 다른 줄이라 전부 놓친다.
 */
export function errorDroppedSites(src, where = '') {
  const text = String(src ?? '');
  const out = [];
  // 주석을 지운다 — 주석에 적힌 옛 코드를 세면 고친 자리를 다시 센다.
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  // ① 읽기: `const {` … `}` `= await` … `;`  — 구조분해에 error 가 없는 것
  const readRe = /const\s*\{([^}]*)\}\s*=\s*await\s+([\s\S]*?);/g;
  let m;
  while ((m = readRe.exec(code)) != null) {
    const bind = m[1], expr = m[2];
    if (!TABLE_CHAIN.test(expr)) continue;          // auth.* 등은 세지 않는다
    if (/\berror\b/.test(bind)) continue;           // 받고 있으면 괜찮다
    if (!/\bdata\b|\bcount\b/.test(bind)) continue; // data·count 도 안 받으면 다른 모양이다
    const line = code.slice(0, m.index).split('\n').length;
    out.push({ kind: 'READ', where, line });
  }

  // ② 쓰기: 문장 맨 앞의 `await` … insert/update/upsert/delete … `;`
  const writeRe = /(^|[;{}\n])\s*await\s+([\s\S]*?);/g;
  while ((m = writeRe.exec(code)) != null) {
    const expr = m[2];
    if (!TABLE_CHAIN.test(expr)) continue;
    if (!/\.(insert|update|upsert|delete)\s*\(/.test(expr)) continue;
    // 결과를 쓰는 모양이면 세지 않는다 — `const x = await …` 는 위 정규식에
    // 걸리지 않지만, `return await …` 와 `.then(` 은 결과를 넘긴다.
    if (/^\s*(return|throw)\b/.test(expr)) continue;
    const line = code.slice(0, m.index).split('\n').length;
    out.push({ kind: 'WRITE', where, line });
  }
  return out;
}

/** 판정 자기 점검. **세는 규칙이 틀리면 기준선이 거짓이 된다.** */
export function selfTest() {
  const failed = [];
  const n = (src) => errorDroppedSites(src).length;
  const kinds = (src) => errorDroppedSites(src).map((s) => s.kind).sort().join(',');

  // 읽기 — error 를 버린 것은 센다
  if (n("const { data } = await sb.from('t').select('*');") !== 1) failed.push('읽기 누락을 못 셌다');
  // 읽기 — error 를 받으면 세지 않는다
  if (n("const { data, error } = await sb.from('t').select('*');") !== 0) failed.push('error 를 받는 읽기를 셌다');
  // 읽기 — auth 류는 세지 않는다
  if (n("const { data } = await sb.auth.getSession();") !== 0) failed.push('auth.getSession 을 셌다');
  // 읽기 — 여러 줄 체인도 센다
  if (n("const { data } = await sb\n  .from('t')\n  .select('*')\n  .eq('a', 1);") !== 1) {
    failed.push('여러 줄 체인 읽기를 못 셌다');
  }
  // 쓰기 — 결과를 안 받는 것은 센다
  if (n("await sb.from('t').insert({ a: 1 });") !== 1) failed.push('쓰기 누락을 못 셌다');
  for (const op of ['update', 'upsert', 'delete']) {
    if (n(`await sb.from('t').${op}({ a: 1 });`) !== 1) failed.push(`${op} 누락을 못 셌다`);
  }
  // 쓰기 — 결과를 받으면 세지 않는다
  if (n("const { error } = await sb.from('t').insert({ a: 1 });") !== 0) failed.push('error 를 받는 쓰기를 셌다');
  // 주석에 적힌 옛 코드는 세지 않는다
  if (n("// const { data } = await sb.from('t').select('*');") !== 0) failed.push('주석을 셌다');
  if (n("/* const { data } = await sb.from('t').select('*'); */") !== 0) failed.push('블록 주석을 셌다');
  // 종류를 구분한다
  if (kinds("const { data } = await sb.from('t').select('*');\nawait sb.from('u').insert({});") !== 'READ,WRITE') {
    failed.push('읽기·쓰기 종류를 구분하지 못했다');
  }
  // 빈 입력
  if (n('') !== 0) failed.push('빈 입력을 셌다');
  return { total: 13, failed };
}

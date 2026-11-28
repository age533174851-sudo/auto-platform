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
 * 주석만 공백으로 덮는다 — **문자열·템플릿 안은 건드리지 않고, 길이를
 * 유지한다.**
 *
 * 길이를 유지하므로 줄번호와 칸이 원문과 같다. 문자열 안의 `//`·`/*`는
 * 주석이 아니므로 그대로 둔다.
 *
 * 아직 열려 있는 것 (닫았다고 적지 않는다): 템플릿 안의 `${…}` 는 통째로
 * 문자열로 본다. 그 안에 **진짜 주석**이 있으면 지우지 않는다 — 코드를
 * 지우는 쪽이 아니라 남기는 쪽으로 틀리므로 개수가 줄지는 않는다.
 */
export function stripCommentsKeepingLength(text) {
  const s = String(text ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // 문자열·템플릿 — 그대로 옮긴다
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      i += 1;
      while (i < s.length) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] ?? ''); i += 2; continue; }
        if (s[i] === q) { out += q; i += 1; break; }
        out += s[i];
        i += 1;
      }
      continue;
    }
    // 줄 주석 — 줄바꿈 앞까지 공백으로
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    // 블록 주석 — 줄바꿈은 살리고 나머지는 공백으로
    if (c === '/' && s[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        out += s[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < s.length) { out += '  '; i += 2; }     // 닫는 `*/`
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

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
  //
  // **지우지 않고 공백으로 덮는다.** 예전에는 블록 주석을 `''`로 지웠는데,
  // 그러면 그 안의 줄바꿈까지 사라져서 **뒤에 오는 모든 자리의 줄번호가
  // 앞으로 밀렸다.** 개수는 맞고 가리키는 줄만 틀리는 고장이라
  // 기준선으로는 안 보이고, 그 줄을 열어 본 사람이 주석을 코드로 읽는다.
  //
  // 실측(2026-11-24) `src/lib/risk/killSwitch.ts` — JSDoc이 많은 파일:
  //   보고 198·247·255·265 → 실제 211·285·293·303 (밀린 양 13 → 38로 증가)
  //
  // 길이를 유지하면 줄도 칸도 그대로다.
  // ★ **문자열 안의 `/*`·`//`는 주석이 아니다.**
  //
  //   예전에는 정규식으로 주석을 걷었고 문자열을 몰랐다. 그래서 완전히
  //   정상적인 한 줄이 이 관문의 **개수를 내렸다.** 실측(전체 1403개 파일):
  //
  //     자리 앞에 `const probeTag = '/*';` 를 넣으면 개수가 내려간 파일 39개
  //       src/app/api/autotrade/mode/route.ts           3 → 0
  //       src/app/api/autotrade/daily-ladder/route.ts   1 → 0
  //       src/app/api/autotrade/schedule/route.ts      10 → 9
  //
  //   `'/*'` 가 블록 주석을 열어 **다음 `*/` 까지를 통째로 지웠다.** 이것은
  //   개수 기준 관문이므로 적게 세는 쪽이 치명적이다 — 아무것도 고치지
  //   않고 기준선을 내릴 수 있고, 그 사이에 들어온 새 자리까지 가려진다.
  //   이 판정이 막으려던 "조용히 들어오는 네 번째"가 바로 그것이다.
  //
  //   그래서 한 번 훑으면서 문자열·템플릿 안은 그대로 두고 주석만 공백으로
  //   덮는다. **길이를 유지한다** — 줄도 칸도 그대로여야 한다(위의 줄번호
  //   주석을 보라).
  //
  //   공용 `scripts/lib/strip-comments.mjs`를 쓰지 않는 이유: 그 함수는
  //   블록 주석의 줄바꿈을 지워 **위치가 어긋난다.** 이 판정은 줄번호를
  //   보고하므로 길이 보존이 계약이다. 둘을 합치려면 길이 보존 모드가
  //   먼저 필요하다.
  const code = stripCommentsKeepingLength(text);

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
    // `m.index`는 앞의 `;`·`}`·줄바꿈을 가리킨다 — 그 줄바꿈을 세면 한 줄
    // 앞을 적는다. `await`가 실제로 있는 자리에서 센다.
    const at = m.index + Math.max(0, m[0].indexOf('await'));
    const line = code.slice(0, at).split('\n').length;
    out.push({ kind: 'WRITE', where, line });
  }
  return out;
}

/** 판정 자기 점검. **세는 규칙이 틀리면 기준선이 거짓이 된다.** */
export function selfTest() {
  const failed = [];
  const n = (src) => errorDroppedSites(src).length;
  const lineOf0 = (src) => errorDroppedSites(src).map((x) => x.line);
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

  // ── 문자열 안의 주석 기호 ──
  //
  // **개수 기준 관문에서는 적게 세는 쪽이 치명적이다.** 정상적인 한 줄로
  // 개수를 내릴 수 있으면 아무것도 고치지 않고 기준선을 내릴 수 있다.
  if (n("const s = '/*';\nconst { data } = await sb.from('t').select('*');") !== 1) {
    failed.push("문자열 안의 '/*' 가 뒤의 자리를 지웠다");
  }
  if (n('const s = `/*`;\nawait sb.from(\'t\').insert({});') !== 1) {
    failed.push('템플릿 안의 `/*` 가 뒤의 자리를 지웠다');
  }
  if (n("const u = 'https://x';\nconst { data } = await sb.from('t').select('*');") !== 1) {
    failed.push("문자열 안의 '//' 가 뒤의 자리를 지웠다");
  }
  // 같은 줄에서도 지우지 않는다
  if (n("const u = 'a//b'; const { data } = await sb.from('t').select('*');") !== 1) {
    failed.push('같은 줄 문자열 안의 // 가 뒤의 자리를 지웠다');
  }
  // 반대쪽 — 진짜 주석은 그대로 지운다
  if (n("const s = 'ok'; // const { data } = await sb.from('t').select('*');") !== 0) {
    failed.push('문자열 뒤의 진짜 줄 주석을 코드로 읽었다');
  }
  if (n("const s = 'ok'; /* const { data } = await sb.from('t').select('*'); */") !== 0) {
    failed.push('문자열 뒤의 진짜 블록 주석을 코드로 읽었다');
  }
  // 이스케이프된 따옴표가 문자열을 일찍 닫지 않는다
  if (n("const s = 'a\\'/*b'; const { data } = await sb.from('t').select('*');") !== 1) {
    failed.push('이스케이프된 따옴표에서 문자열이 일찍 닫혔다');
  }
  // 줄번호 — 문자열을 보존해도 밀리지 않는다
  if (String(lineOf0("const s = '/*';\nconst { data } = await sb.from('t').select('*');")) !== '2') {
    failed.push('문자열을 보존하면서 줄번호가 밀렸다');
  }

  // ── 줄번호 ──
  //
  // **세는 것만으로는 부족하다.** 개수가 맞아도 가리키는 줄이 틀리면
  // 그 줄을 열어 본 사람이 **주석을 코드로 읽는다.**
  const lineOf = (src) => errorDroppedSites(src).map((s) => s.line);
  if (String(lineOf("const { data } = await sb.from('t').select('*');")) !== '1') {
    failed.push('첫 줄의 자리를 1로 적지 않았다');
  }
  // 앞에 블록 주석이 있으면 그만큼 밀리면 안 된다
  if (String(lineOf("/**\n * 설명\n * 두 줄\n */\nconst { data } = await sb.from('t').select('*');")) !== '5') {
    failed.push('앞선 블록 주석만큼 줄번호가 밀렸다');
  }
  // 줄 주석도 같다
  if (String(lineOf("// 설명\n// 두 줄\nawait sb.from('t').insert({});")) !== '3') {
    failed.push('앞선 줄 주석만큼 줄번호가 밀렸다');
  }

  return { total: 24, failed };
}

// scripts/lib/workflow-shell.mjs
//
// **워크플로 파일에 적혀 있는 것과 셸이 실행하는 것은 다르다.**
//
// 이 구분이 없으면 관문을 세우는 검사기가 **주석 한 줄에 속는다.**
// 단계를 `#` 로 막아 두면 그 단계는 사라지는데 문자열은 남아 있고,
// raw 텍스트를 보는 검사기는 "있다"고 적는다. 실측된 두 자리:
//
//   #792  `ci.yml` 이 검사기를 부르는지  — 주석·echo·인용·heredoc 넷
//   #325 쪽 아님: `check-audit-readonly` — 운영 DB 읽기전용 증명 검사를
//        주석 처리해도 ✅ 였다 (아래 세 줄 전부)
//
//          if ! printf '%s' "${out}" | grep -q 'READ_ONLY=on'; then
//          if [ "${ACTOR}" != "${OWNER}" ]; then
//          if [ "${CONFIRM}" != "READ-ONLY-AUDIT" ]; then
//
// 그래서 **판정을 한 곳에 둔다.** 같은 질문을 두 검사기가 따로 풀면
// 언젠가 갈린다 — 이 저장소가 "경로가 둘인데 한쪽만 고침"으로 부르는
// 고장이다. 새로 워크플로 텍스트에 단정하는 검사기는 이 모듈을 쓴다.

import { stripYamlComments } from './strip-comments.mjs';

/**
 * `ci.yml` 에서 **셸이 실제로 실행하는 줄만** 뽑는다.
 *
 * 세 번째 검수(#792 코멘트 7199259371)가 또 반례를 냈다. 꼴마다 하나씩
 * 막는 것을 그만두고, "셸이 무엇을 실행하는가"를 한 번 계산한다.
 *
 *   ① `run:` 인 블록의 본문만 본다 — 다른 키의 `|` 블록(`env: HINT: |`)은
 *      명령이 아니다. 그 본문에 `run:` 이라 적어도 명령이 되지 않는다.
 *   ② **heredoc 본문은 자료다.** `cat <<'SH'` 와 그 닫는 줄 사이의 줄은
 *      셸이 실행하지 않는다 (여는 줄 자체는 명령이라 남긴다).
 */
export function shellScriptLines(ciText) {
  return runBlockMap(ciText).filter(l => !l.inHeredoc).map(l => l.text);
}

/**
 * `run:` 블록의 줄마다 **heredoc 본문인지**를 붙여서 돌려준다.
 *
 * 이 질문("이 줄은 셸이 실행하는가, 자료로 넘기는가")에 답하는 자리는
 * 여기 하나뿐이다. 전에는 `shellScriptLines` 와 `heredocBodies` 가 각자
 * `<<TAG` 를 찾았는데, 그러면 **주석 처리된 여는 줄**에서 둘이 갈린다.
 *
 * 실측으로 그 구멍이 났다 (감사 워크플로 :139 · :427):
 *
 *     # cat > "${RUNNER_TEMP}/audit-spot-shape.sql" <<'SQL'
 *
 * 셸은 이것을 **주석으로** 읽는다 — heredoc 은 열리지 않고 그 SQL 파일은
 * 만들어지지 않는다. 그런데 여는 줄을 원문에서 찾으면 본문이 그대로
 * "도는 SQL" 로 잡혀서, 감사가 질의를 하나도 만들지 않는데도 관문이
 * 통과를 적었다. 그래서 **여는 줄은 주석을 걷고** 찾는다.
 *
 * heredoc 안에서는 걷지 않는다 — 거기서 `#` 는 주석이 아니다.
 */
function runBlockMap(ciText) {
  const out = [];
  let delim = null;
  for (const line of runBlockLines(ciText)) {
    if (delim !== null) {
      if (line.text.trim() === delim) { delim = null; out.push({ ...line, inHeredoc: false }); continue; }
      out.push({ ...line, inHeredoc: true, tag: delim });
      continue;
    }
    out.push({ ...line, inHeredoc: false });
    const m = stripYamlComments(line.text).match(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
    if (m) delim = m[2];
  }
  return out;
}

/**
 * `run:` 블록의 본문 줄 — heredoc 본문까지 **그대로** 담아서.
 *
 * `shellScriptLines` 와 `heredocBodies` 가 같은 질문("어느 줄이 run: 블록
 * 안인가")을 각자 풀면 언젠가 갈린다. 그 계산은 여기 한 번만 있다.
 */
function runBlockLines(ciText) {
  const out = [];     // { i, text } — i 는 원본 줄 번호(0부터)
  let block = null;   // { indent, isRun }
  const src = String(ciText ?? '').split('\n');
  for (let i = 0; i < src.length; i += 1) {
    const line = src[i].replace(/\s+$/, '');
    if (block) {
      const indent = line.length - line.replace(/^\s*/, '').length;
      if (line.trim() === '') { if (block.isRun) out.push({ i, text: '' }); continue; }
      if (indent > block.indent) {
        if (block.isRun) out.push({ i, text: line.slice(block.indent + 1) });
        continue;
      }
      block = null;   // 블록이 끝났다 — 이 줄은 아래에서 다시 본다
    }
    const head = line.match(/^(\s*)(?:-\s+)?([A-Za-z_][\w.-]*)\s*:\s*[|>][+-]?\d*\s*$/);
    if (head) { block = { indent: head[1].length, isRun: head[2] === 'run' }; continue; }
    const inline = line.match(/^\s*(?:-\s+)?run\s*:\s*(\S.*)$/);
    if (inline) out.push({ i, text: inline[1].trim() });
  }
  return out;
}

/**
 * heredoc **본문**만 — `shellScriptLines` 가 버리는 쪽.
 *
 * 셸은 이 줄들을 실행하지 않지만 **자료로 그대로 넘긴다.** `psql <<'SQL'`
 * 의 본문이 실제로 돌 SQL 이다. 그래서 SQL 단정은 이쪽에서 봐야 한다 —
 * 워크플로 전체에 `.test()` 를 걸면 `- name:` 단계 제목이나 머리말 주석에
 * 적힌 같은 글자가 그 단정을 만족시킨다. 실측(#792 회차): 감사 워크플로의
 * `BEGIN TRANSACTION READ ONLY` 5개 중 실제 SQL 은 2개뿐이고, 나머지는
 * 주석 1 + 단계 제목 2 였다. 그래서 **실제 SQL 두 줄을 다 지워도**
 * `>= 2` 를 만족해 관문이 통과를 적었다.
 *
 * 닫히지 않은 heredoc 은 본문을 **끝까지** 담는다 — 셸이 그렇게 읽는다.
 * 여기서 버리면 금지 구문(쓰기 SQL)이 그 안에 숨을 수 있다.
 */
export function heredocBodies(yamlText) {
  const out = [];
  let cur = null;
  for (const line of runBlockMap(yamlText)) {
    if (line.inHeredoc) {
      if (!cur || cur.tag !== line.tag) { cur = { tag: line.tag, rows: [], lines: [] }; out.push(cur); }
      cur.rows.push(line.text); cur.lines.push(line.i);
      continue;
    }
    cur = null;
  }
  return out.map(h => ({ tag: h.tag, body: h.rows.join('\n'), lines: h.lines }));
}

/** SQL 주석만 걷는다. `#` 는 건드리지 않는다 — SQL 에서 주석이 아니다. */
export function stripSqlComments(text) {
  return String(text ?? '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * 주석만 걷은 워크플로 전체 — **영역마다 주석 글자가 다르다.**
 *
 * 금지 구문(쓰기 SQL·돈 움직이는 RPC)은 어느 자리에 있어도 잡아야 하므로
 * 자리로 좁히면 안 된다. 그런데 한 가지 규칙으로 걷으면 틀린다. 실측으로
 * 둘 다 당했다:
 *
 *   · `#` 로 걷으면 SQL 의 `sed -E 's#postgres…'` 같은 줄이 잘린다
 *   · YAML 규칙으로 걷으면 heredoc 안의 `--   처음에는 …` 설명 주석이
 *     그대로 남아, **금지 구문이 주석에 적혀 있다는 이유로** 관문이 불평한다
 *     (감사 워크플로 :153 이 실제로 그랬다)
 *
 * 그래서 heredoc 본문은 SQL 규칙으로, 나머지는 YAML/셸 규칙으로 걷는다.
 * 줄 번호는 유지한다 — 자리로 잘라 보는 단정이 줄 구조에 기댄다.
 */
export function stripWorkflowComments(yamlText) {
  const src = String(yamlText ?? '').split('\n');
  const body = new Set();
  for (const h of heredocBodies(yamlText)) for (const i of (h.lines ?? [])) body.add(i);
  const yamlPart = src.map((l, i) => (body.has(i) ? '' : l)).join('\n');
  const sqlPart  = src.map((l, i) => (body.has(i) ? l : '')).join('\n');
  return `${stripYamlComments(yamlPart)}\n${stripSqlComments(sqlPart)}`;
}

/** heredoc 본문 전부를 한 덩어리로. 주석은 걷지 않는다 — 언어마다 다르다. */
export function heredocText(yamlText) {
  return heredocBodies(yamlText).map(h => h.body).join('\n');
}

/**
 * 셸 한 줄을 **명령 토막**으로 나눈다 — 인용 안에서는 나누지 않는다.
 *
 * 이것이 세 번째 반례의 원인이었다. `;`·`|`·`&&` 로 raw 문자열을 나누면
 * `echo "literal; node scripts/check-x.mjs --flag"` 의 둘째 토막이
 * `node …` 로 시작한다. 셸은 그 문장을 **출력만** 하는데 "부른다"로 셌다.
 */
export function shellSegments(line) {
  const segs = [];
  let cur = '', quote = null, esc = false;
  const push = () => { const t = cur.trim(); if (t) segs.push(t); cur = ''; };
  for (const c of String(line ?? '')) {
    if (esc) { cur += c; esc = false; continue; }
    if (c === '\\') { cur += c; esc = true; continue; }
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { cur += c; quote = c; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n') { push(); continue; }
    cur += c;
  }
  push();
  return segs;
}

/**
 * 셸이 실행하는 줄을 **한 덩어리 문자열**로. 주석은 걷혀 있다.
 *
 * 워크플로 전체(`src`)에 `.includes()` 를 걸던 자리를 이것으로 바꾼다.
 */
export function shellText(yamlText) {
  return stripYamlComments(shellScriptLines(yamlText).join('\n'));
}

/**
 * 셸이 **명령 위치에서** 실행하는 토막 전부.
 *
 * 인용 안에 적힌 문장은 들어오지 않는다 — `echo "…"` 로 관문을
 * 통과시킬 수 없다.
 */
export function shellCommands(yamlText) {
  const out = [];
  for (const line of shellText(yamlText).split('\n')) {
    for (const seg of shellSegments(line)) out.push(stripEnvPrefix(seg));
  }
  return out;
}

/**
 * 이 워크플로가 **명령 위치에서** 이 스크립트를 node 로 실행하는가.
 *
 * `shellText` 로는 모자랐다. 그것은 셸 **본문**이지 명령 위치가 아니라서,
 * 유효한 YAML 안의 인용 문자열이 그대로 남는다. 실측된 반례 둘
 * (#792 코멘트 7208374816, 둘 다 YAML 파싱·`bash -n` 통과):
 *
 *     run: echo 'node scripts/check-audit-readonly.mjs'
 *     echo 'node scripts/claude-exec-category.mjs | tee -a "$GITHUB_STEP_SUMMARY"'
 *
 * 셸은 둘 다 **출력만** 한다. 그래서 토막으로 나눠 명령 위치를 본다.
 *
 * **플래그를 견딘다.** `ciInvokes` 는 `^node\s+scripts/<name>` 만 보는데,
 * 이 저장소는 시험 파일을 `node --test scripts/check-x.test.mjs` 로 부른다.
 * 그 꼴을 못 보면 실제로 돌고 있는 것을 "미배선" 으로 적는다 — 측정으로
 * 걸렀다(`scripts/` 에 `check-*.test.mjs` 가 2개 있고 둘 다 그 꼴이다).
 * 그래서 첫 낱말이 `node` 인 토막의 **인자**에서 스크립트를 찾는다.
 */
export function invokesScript(yamlText, scriptPath) {
  const path = String(scriptPath ?? '').replace(/^\.\//, '');
  if (!path) return false;
  for (const cmd of shellCommands(yamlText)) {
    const parts = cmd.split(/\s+/);
    if (parts[0] !== 'node') continue;
    const args = parts.slice(1);
    // **`node` 뒤에 경로가 있다고 그 파일이 도는 것은 아니다.**
    //
    // 실측 반례(#792 코멘트 7209193550, 유효 YAML · `bash -n` 통과 ·
    // 실제로 돌려 보면 `noop` 만 찍힌다):
    //
    //     run: node --eval 'console.log("noop")' scripts/check-audit-readonly.mjs
    //
    // Node 는 `--eval` 의 표현식을 실행하고 뒤의 경로는 **인자**로 넘긴다 —
    // 그 파일은 돌지 않는다. `-e`·`-p`·`--print` 도 같다(`-pe` 처럼 붙여 쓸 수
    // 있다). 그래서 이 꼴이면 파일 호출로 세지 않는다.
    //
    // `--test` 는 반대다 — 뒤의 경로들을 **실제로 돌린다.** 이 저장소가
    // 시험 파일을 그렇게 부르므로 양성으로 남겨야 한다(검사기 95개로 쟀다).
    if (args.some(a => EVAL_OPTION.test(a))) continue;
    // 인용부호가 붙은 인자는 명령이 아니라 자료다 — 벗기지 않고 그대로 본다.
    if (args.some(a => a === path || a === `./${path}`)) return true;
  }
  return false;
}

/**
 * Node 가 **파일 대신 식을 실행하게** 만드는 옵션.
 *
 * `--eval` · `--print` 와 짧은 꼴 `-e` · `-p`(`-pe`·`-ep` 처럼 붙여 쓸 수 있다),
 * 그리고 `--eval=CODE` 처럼 등호로 붙인 꼴까지 본다.
 *
 * Node CLI 를 전부 해석한다고 주장하지 않는다 — 실측된 이 한 종류를 막는다.
 */
const EVAL_OPTION = /^(?:--(?:eval|print)(?:=|$)|-[ep]+$)/;

/**
 * 앞에 붙는 환경변수 지정을 떼어낸다 — **명령 위치를 바꾸지 않는다.**
 *
 * `FOO=1 sed -E …` 는 `sed` 를 부르는 것이다. 이 처리를 빼먹으면
 * 좁히는 쪽으로 틀려 관문이 거짓으로 불평한다 — 내 시험 4번(대조)이
 * 그것을 잡았다. 전에는 `ciInvokes` 안에만 있어서 `shellCommands` 를
 * 쓰는 쪽은 못 받았다. **같은 판단을 두 곳에 두지 않는다.**
 */
export function stripEnvPrefix(cmd) {
  return String(cmd ?? '').replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '');
}

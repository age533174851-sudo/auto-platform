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
  const out = [];
  let block = null;   // { indent, isRun }
  for (const raw of String(ciText ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (block) {
      const indent = line.length - line.replace(/^\s*/, '').length;
      if (line.trim() === '') { if (block.isRun) out.push(''); continue; }
      if (indent > block.indent) {
        if (block.isRun) out.push(line.slice(block.indent + 1));
        continue;
      }
      block = null;   // 블록이 끝났다 — 이 줄은 아래에서 다시 본다
    }
    const head = line.match(/^(\s*)(?:-\s+)?([A-Za-z_][\w.-]*)\s*:\s*[|>][+-]?\d*\s*$/);
    if (head) { block = { indent: head[1].length, isRun: head[2] === 'run' }; continue; }
    const inline = line.match(/^\s*(?:-\s+)?run\s*:\s*(\S.*)$/);
    if (inline) out.push(inline[1].trim());
  }
  return dropHeredocBodies(out);
}

function dropHeredocBodies(lines) {
  const out = [];
  let delim = null;
  for (const line of lines) {
    if (delim !== null) {
      if (line.trim() === delim) delim = null;
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
    if (m) delim = m[2];
  }
  return out;
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

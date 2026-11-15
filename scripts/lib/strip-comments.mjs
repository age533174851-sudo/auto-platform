// scripts/lib/strip-comments.mjs
//
// **검사기가 주석을 계약으로 읽지 않게 한다.**
//
// 이 저장소에서 두 번 겪은 고장이다. `check-ui-shell-contract`를 처음
// 돌렸을 때 `minmax(0, 1fr)`을 전부 `1fr`로 바꿔 놓아도 통과했다 —
// 설명 주석에 그 문구가 적혀 있었기 때문이다. 그 뒤 공용 상수를 안 쓰게
// 되돌려도 또 통과했다. 같은 이유였다. 검사기가 규칙이 아니라 규칙에
// 대한 설명을 보고 초록을 켠 것이다.
//
// 그래서 이 함수를 **한 곳에만** 둔다. 검사기마다 각자 복사해 두면
// 언젠가 한쪽만 고쳐지고, 그때부터 그 검사기는 조용히 아무것도 막지
// 않는다. 새 검사기는 여기서 가져다 쓴다.

/** CSS 주석 제거 */
export function stripCssComments(t) {
  return String(t).replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * JS/TS/TSX 주석 제거.
 *
 * 문자열 안의 `//`(예: `https://`)를 주석으로 읽지 않도록 인용 상태를
 * 따라간다. `{/* ... *\/}` 형태의 JSX 주석도 블록 주석이므로 같이 지워진다.
 */
export function stripJsComments(t) {
  const s = String(t);
  let out = '', i = 0, q = null;
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (q) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === q) q = null;
      out += c; i += 1; continue;
    }
    if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}

/**
 * YAML(과 그 안의 `run:` 셸) 주석 제거.
 *
 * `#`은 줄 맨 앞이거나 **공백 뒤**일 때만 주석이다 — `a#b`는 값이고,
 * 인용부호 안의 `#`도 값이다. 그 구분을 안 하면 `--retry 3 # 이유`의
 * `#` 뒤만 지우려다 `"color: #fff"`까지 잘라 먹는다.
 *
 * **왜 필요한가** — 검사기가 주석 처리된 줄을 "그 단계가 있다"로 읽으면,
 * 그 단계를 주석으로 덮어도 초록이 된다. 2026-11-13에 CI 내려받기
 * 검사기에서 실제로 그랬다(#619).
 */
export function stripYamlComments(t) {
  const out = [];
  for (const line of String(t).split('\n')) {
    let q = null, cut = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) { cut = i; break; }
    }
    out.push(cut < 0 ? line : line.slice(0, cut));
  }
  return out.join('\n');
}

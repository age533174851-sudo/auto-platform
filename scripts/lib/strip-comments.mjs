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
/**
 * JS/TS/TSX 주석 제거.
 *
 * 문자열 안의 `//`(예: `https://`)를 주석으로 읽지 않도록 인용 상태를
 * 따라간다. `{/* ... *\/}` 형태의 JSX 주석도 블록 주석이므로 같이 지워진다.
 *
 * **정규식 리터럴을 알아야 한다.**
 *
 * 처음 판은 몰랐다. 그래서 `/["']+/g` 같은 리터럴을 만나면 그 안의 `"` 를
 * 문자열 시작으로 읽고, 거기서부터 **가짜 문자열 상태**에 빠졌다. 그 상태
 * 에서는 `//` 를 주석으로 보지 않으므로 **주석 본문이 코드로 남는다.**
 *
 * 실측 (main ed00c1a4):
 *
 *   `scripts/ops-runner.mjs:50`  `/["']+/gi` 에서 탈선 → 73·86·175·237·303행
 *   으로 인용 상태가 줄을 넘어 이어지고, 410행부터 끝까지 닫히지 않았다.
 *   그 바람에 106행의 주석 `예전에는 … \`vercelSha: mainSha\`를 넘겼다` 가
 *   코드로 남아, 그 문구를 금지하는 `check-deploy-evidence` 가 **원문에서
 *   거짓 양성**을 냈다. 같은 탈선이 **1611개 중 127개 파일**에서 일어난다.
 *
 * 방향이 중요하다. 탈선 중에는 글자가 **그대로 남으므로**, "있어야 한다"를
 * 보는 검사는 주석에 적힌 문구로 **통과**한다 — 조용히 열리는 쪽이다.
 *
 * **나눗셈을 정규식으로 오인하면 더 나쁘다** — 코드를 먹어 버린다. 그래서
 * `/` 앞의 마지막 의미 있는 글자가 값이 끝난 자리(식별자·숫자·닫는 괄호)면
 * 나눗셈으로 본다. 그 구분을 시험으로 못 박았다
 * (`scripts/test-strip-comments.mjs`).
 */
export function stripJsComments(t) {
  const s = String(t);
  let out = '', i = 0, q = null, prev = '';
  // 템플릿 리터럴의 `${ … }` 안은 **코드**다. 백틱만 세면 안 되는 이유:
  // `${ … \`중첩\` … }` 처럼 안에 또 백틱이 올 수 있어 짝이 어긋나고,
  // 그러면 다시 가짜 문자열 상태에 빠진다. 실측 (ed00c1a4):
  // `scripts/claude-exec-category.mjs` 296~327행이 그렇게 이어져 303행
  // 주석이 코드로 남았다. 프레임마다 중괄호 깊이를 센다.
  const tpl = [];
  const KEYWORD = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|case|do|else|yield|await|new|delete|void|throw)$/;
  /** 이 자리의 `/` 가 정규식 시작인가 — 아니면 나눗셈이다 */
  const regexAllowed = () => {
    if (prev === '') return true;
    if (/[\w$)\]]/.test(prev)) {
      // 값이 끝난 자리 → 나눗셈. 단 `return` 같은 키워드 뒤는 정규식이다.
      return KEYWORD.test(out.replace(/\s+$/, ''));
    }
    return true;
  };
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (q) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (q === '`' && c === '$' && d === '{') {
        tpl.push(0); q = null; out += '${'; prev = '{'; i += 2; continue;
      }
      if (c === q) q = null;
      out += c; i += 1; continue;
    }
    if (tpl.length && (c === '{' || c === '}')) {
      if (c === '{') tpl[tpl.length - 1] += 1;
      else if (tpl[tpl.length - 1] === 0) {
        tpl.pop(); q = '`'; out += c; prev = c; i += 1; continue;
      } else tpl[tpl.length - 1] -= 1;
    }
    if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; prev = c; out += c; i += 1; continue; }
    if (c === '/' && regexAllowed()) {
      // 정규식 리터럴 — 문자 클래스 안의 `/` 는 끝이 아니다
      let j = i + 1, cls = false, closed = false;
      for (; j < s.length; j += 1) {
        const ch = s[j];
        if (ch === '\\') { j += 1; continue; }
        if (ch === '\n') break;            // 한 줄 안에서 닫히지 않으면 정규식이 아니다
        if (cls) { if (ch === ']') cls = false; continue; }
        if (ch === '[') { cls = true; continue; }
        if (ch === '/') { closed = true; break; }
      }
      if (closed) {
        j += 1;
        while (j < s.length && /[a-z]/.test(s[j])) j += 1;   // 플래그
        out += s.slice(i, j); prev = '/'; i = j; continue;
      }
      // 닫히지 않았으면 나눗셈으로 취급한다
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
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

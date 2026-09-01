// scripts/lib/function-body.mjs
//
// **함수 본문을 중괄호 세기로 찾지 않는다.**
//
// 검사기 둘이 거의 같은 `fnBodyAt()`을 각자 갖고 있었다. 둘 다 매개변수
// `)` 뒤 첫 `{…}`를 잡고, 닫는 `}` 다음 글자가 `>` `,` `|` `&`이면 반환
// 타입이라고 **추측해서** 건너뛰었다.
//
// 그 추측은 이런 모양에서 깨진다:
//
//   function f(): { ok: boolean } {
//     REAL_BODY
//   }
//
// 첫 `{ ok: boolean }`의 다음 글자가 실제 본문의 `{`라서 위 네 글자에
// 해당하지 않는다. 그래서 **반환 타입을 함수 본문으로 읽는다.** 지금
// `openPaperPosition`이 멀쩡한 것은 반환 타입이 우연히 `Promise<{…}>`라
// `>`가 뒤에 오기 때문일 뿐이다. 누가 그 타입을 직접 객체로 바꾸는 순간
// 검사기는 타입 블록을 보고 초록을 켠다 — 실제 본문은 보지도 않고.
//
// 규칙을 하나 더 붙이는 방식으로는 끝나지 않는다. 제네릭, 유니온,
// 교차 타입, 주석 속 가짜 선언, 문자열 속 중괄호가 전부 같은 종류의
// 예외를 만든다. 그래서 **TypeScript 자신에게 묻는다.** 이 저장소에는
// 이미 typescript가 devDependency로 있으므로 새로 받을 것이 없다.
//
// 못 읽으면 못 읽었다고 한다
// ──────────────────────────
// 소스가 문법적으로 깨졌거나, 이름이 없거나, 본문 있는 구현이 둘 이상이면
// **빈 문자열을 돌려주지 않고 실패를 돌려준다.** "비슷한 것 중 첫 번째"를
// 고르면 검사기는 엉뚱한 함수를 보고 통과시킨다.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ts = null;
function typescript() {
  if (ts) return ts;
  ts = require('typescript');
  return ts;
}

/**
 * @param {string} source  파일 원문. **stripJs를 먼저 돌리지 말 것** —
 *                         주석·문자열을 지운 소스를 파서에 넣으면 위치가
 *                         어긋난다. 본문을 뽑은 뒤에 지운다.
 * @param {string} name    함수 이름 (`openPaperPosition`). 선언 문자열이 아니다.
 * @returns {{ ok: true, body: string, start: number, end: number }
 *          | { ok: false, reason: string }}
 */
export function functionBody(source, name) {
  const T = typescript();
  const src = String(source ?? '');
  if (!src.trim()) return { ok: false, reason: '소스가 비어 있습니다' };
  if (!name) return { ok: false, reason: '함수 이름이 없습니다' };

  const file = T.createSourceFile(
    'input.ts', src, T.ScriptTarget.Latest, /* setParentNodes */ true, T.ScriptKind.TS);

  // **문법이 깨졌으면 거기서 끝이다.** 반쯤 읽은 트리에서 찾은 본문은
  // 본문이 아니라 추측이다.
  const diags = file.parseDiagnostics ?? [];
  if (diags.length > 0) {
    const first = T.flattenDiagnosticMessageText(diags[0].messageText, ' ');
    return { ok: false, reason: `TypeScript가 소스를 읽지 못했습니다: ${first}` };
  }

  /** @type {import('typescript').FunctionDeclaration[]} */
  const found = [];
  const walk = (node) => {
    if (T.isFunctionDeclaration(node) && node.name && node.name.text === name && node.body) {
      found.push(node);
    }
    T.forEachChild(node, walk);
  };
  walk(file);

  if (found.length === 0) {
    return { ok: false, reason: `본문이 있는 function ${name} 선언을 찾지 못했습니다` };
  }
  if (found.length > 1) {
    // 오버로드 시그니처는 body가 없어 위에서 이미 걸러졌다. 그런데도 둘 이상이면
    // 어느 것을 볼지 우리가 정할 문제가 아니다.
    return { ok: false, reason: `본문이 있는 function ${name} 구현이 ${found.length}개입니다 — 어느 것인지 정할 수 없습니다` };
  }

  const body = found[0].body;
  return { ok: true, body: src.slice(body.pos, body.end).trimStart(), start: body.pos, end: body.end };
}

/**
 * 검사기에서 쓰기 편한 형태. 실패하면 `fail`을 부르고 빈 문자열을 준다.
 * **실패를 조용히 통과로 만들지 않기 위해** fail을 반드시 받는다.
 */
export function functionBodyOrFail(source, name, fail, where) {
  const r = functionBody(source, name);
  if (!r.ok) { fail(`${where}: ${r.reason}`); return ''; }
  return r.body;
}

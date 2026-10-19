// src/test/unreadSelectRatchet.test.ts
//
// **같은 결함을 네 번 연속 고쳤다. 다섯 번째가 들어오지 못하게 막는다.**
//
// 뿌리는 하나다:
//
//     const { data } = await sb.from('…').select('…')…;   // ← error가 없다
//
// 실패한 Supabase select는 **예외를 던지지 않는다.** `{ data: null, error }`를
// 준다. 그래서 `try/catch`에 걸리지 않고, 호출부는 `data ?? null` ·
// `Array.isArray(data) ? data : []` · `if (data) … else …`로 흘러간다.
// 그 순간 **"못 읽었다"가 "없다"·"0건"·"미설정"으로 바뀐다.**
//
// 실제로 그렇게 나간 것들:
//
//   #368  미확정 주문 0건      → 중복 진입 관문이 열렸다
//   #370  "남의 주문입니다"    → 내 것인지 모르는 주문에 취소를 보냈다
//   #371  "그런 테스트가 없다" → 즉시 중지가 닫을 게 없다고 답했다
//   #372  "한도 미설정" · 열린 위험 0 → 좁혀 둔 선이 넓어지고
//                                       전체 위험 한도가 비어 보였다
//
// 넷 다 코드 한 줄의 같은 모양이다. 사람이 매번 알아채기를 기대하는
// 대신, **개수가 늘면 실패하는 래칫**을 둔다. 줄어드는 것은 언제나 좋다.
//
// ★ **이 숫자를 올려서 통과시키지 않는다.**
//   올리는 것은 "이 결함을 하나 더 들였다"는 뜻이다. 막히면 그 자리에서
//   `error`를 받고, 못 읽었을 때 무엇을 할지 적는다.

import { test, eq, assert } from './harness';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

/** 이 경로들에서는 "못 읽음"이 곧 안전 판단이다 */
const DIRS = [
  'src/lib/risk',
  'src/lib/engine',
  'src/lib/smoke',
  'src/lib/exchanges',
  'src/app/api/autotrade',
  'worker/src',
];

/**
 * **현재 개수.** 줄이는 것은 자유, 늘리는 것은 막힌다.
 *
 * 이 숫자를 올리려면 그 줄이 왜 안전한지 PR 본문에 적어야 한다 —
 * 그리고 대개는 적을 수 없을 것이다.
 */
const BASELINE = 52;

/** `data`만(또는 `data: 별칭`만) 꺼내는 구조분해 — `error`가 없다 */
const DROPS_ERROR = /const\s*\{\s*data(\s*:\s*\w+)?\s*\}\s*=\s*await\b/;

export interface UnreadSite { file: string; line: number; text: string }

/**
 * `error`를 버리는 Supabase 조회를 센다.
 *
 * 같은 문장이 여러 줄에 걸치므로 **뒤 3줄까지** 보고 `.from(`·`.rpc(`가
 * 있을 때만 센다 — 수파베이스가 아닌 `await`을 잡지 않기 위해서다.
 */
export function findUnreadSelects(root: string, dirs: string[] = DIRS): UnreadSite[] {
  const out: UnreadSite[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = path.join(dir, name);
      let st: any;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!DROPS_ERROR.test(lines[i])) continue;
        const window = lines.slice(i, i + 4).join('\n');
        if (!window.includes('.from(') && !window.includes('.rpc(')) continue;
        out.push({
          file: p.replace(/\\/g, '/'), line: i + 1, text: lines[i].trim().slice(0, 90),
        });
      }
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return out;
}

export function runUnreadSelectRatchetTests() {
  console.log('[조회 실패를 "없음"으로 읽는 자리 — 늘지 않는가]');

  // ── **저장소 뿌리를 러너가 알려 준다** ──
  //
  // 이 러너는 `src`만 임시 디렉터리로 복사하고 `cwd`를 그쪽으로 옮겨
  // 돈다. 그래서 `__dirname`도 `cwd`도 **사본**을 가리키고, `worker/`는
  // 아예 보이지 않는다. 실제로 두 번 밟았다 — 사본 기준 43건,
  // 소스 기준 52건이라 래칫에 9건의 틈이 생겼고 변이를 못 물었다.
  const root = process.env.TRAIGO_REPO_ROOT;
  if (!root) {
    test('래칫: 저장소 뿌리를 받지 못했다', () => {
      throw new Error('TRAIGO_REPO_ROOT가 없습니다 — 러너가 넘겨야 합니다. '
        + '못 세는 것을 "0건"으로 보지 않습니다');
    });
    return;
  }

  test('★ error를 버리는 조회가 기준선보다 늘지 않았다', () => {
    const sites = findUnreadSelects(root);
    if (sites.length > BASELINE) {
      const extra = sites.slice(0, 60)
        .map((s) => `    ${s.file}:${s.line}  ${s.text}`).join('\n');
      throw new Error(
        `error를 버리는 Supabase 조회가 ${BASELINE} → ${sites.length}로 늘었습니다.\n`
        + '  실패한 select는 예외를 던지지 않습니다 — catch에 안 걸리고\n'
        + '  "못 읽음"이 "없음"·"0건"·"미설정"이 됩니다(#368 · #370 · #371 · #372).\n'
        + '  `const { data, error } = await …`로 받고, 못 읽었을 때 무엇을 할지 적으세요.\n'
        + `  이 숫자를 올려서 통과시키지 마세요.\n${extra}`);
    }
    assert(true);
  });

  // 줄어들면 기준선을 내리라고 알려 준다. 안 내리면 래칫이 느슨해진다.
  test('기준선이 실제보다 느슨하면 알려 준다', () => {
    const n = findUnreadSelects(root).length;
    assert(n >= BASELINE - 12,
      `실제 ${n}건인데 기준선이 ${BASELINE}입니다 — BASELINE을 ${n}으로 내리세요. `
      + '래칫이 느슨하면 다음 하나가 조용히 들어옵니다');
  });

  // ── 탐지기 자체를 시험한다 ──
  //
  // 검사가 틀리면 사람들은 검사를 끈다. 가짜 디렉터리로 양성·음성을 본다.
  test('탐지기: error를 받는 줄은 세지 않는다', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ratchet-'));
    const d = path.join(tmp, 'x'); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'good.ts'),
      "const { data, error } = await sb.from('t').select('*');\n");
    fs.writeFileSync(path.join(d, 'bad.ts'),
      "const { data } = await sb.from('t').select('*');\n");
    fs.writeFileSync(path.join(d, 'alias.ts'),
      "const { data: rows } = await sb\n  .from('t')\n  .select('*');\n");
    // 수파베이스가 아닌 await은 세지 않는다
    fs.writeFileSync(path.join(d, 'other.ts'),
      "const { data } = await axios.get('/x');\n");
    // 시험 파일은 보지 않는다
    fs.writeFileSync(path.join(d, 'skip.test.ts'),
      "const { data } = await sb.from('t').select('*');\n");

    const found = findUnreadSelects(tmp, ['x']).map((s) => path.basename(s.file)).sort();
    eq(found.join(','), 'alias.ts,bad.ts', `잘못 셌습니다: ${found.join(',')}`);
  });
}

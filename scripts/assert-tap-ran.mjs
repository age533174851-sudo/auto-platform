#!/usr/bin/env node
// scripts/assert-tap-ran.mjs
//
// **돌지 않은 시험을 통과로 읽지 않는다.**
//
// Node의 시험 러너는 **전부 건너뛴 묶음에도 종료 코드 0을 준다.** 그래서
// `node --test`의 종료 코드만 보면 "PG 시험 초록"과 "PG 시험 안 돌았음"이
// 구분되지 않는다. `TEN_SLOT_PG_URL`이 없는 러너에서는 늘 후자다.
//
// #544의 워크플로가 그것을 `grep -Eq` 다섯 줄로 막았다. PG 묶음이 둘이
// 되면 그 다섯 줄을 복사해야 하고, 그 순간 **경로가 둘**이 된다 —
// `CLAUDE.md`의 상습 고장 ②. 그래서 판정을 여기 한 곳에 둔다.
//
// 사용: node scripts/assert-tap-ran.mjs <tap 파일> [이름]
//   통과면 한 줄 적고 0, 아니면 이유를 적고 1.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** `# pass 7` 같은 줄에서 숫자만. **없으면 null이다 — 0이 아니다** */
function countOf(text, key) {
  // 줄 전체가 `# <key> <숫자>`여야 한다. 뒤에 군더더기가 붙은 줄을
  // 숫자로 읽으면 변형된 출력이 통과로 새어 들어간다.
  const m = String(text ?? '').split('\n')
    .map(l => l.trim())
    .find(l => new RegExp(`^# ${key} \\d+$`).test(l));
  return m ? Number(m.slice(`# ${key} `.length)) : null;
}

const KEYS = ['tests', 'pass', 'fail', 'skipped', 'cancelled'];

/**
 * TAP 꼬리가 **일이 실제로 돌았고 다 통과했음**을 말하는가.
 *
 * 못 읽은 칸은 null이고, null은 통과가 아니다.
 */
export function verdictOf(tap) {
  const counts = {};
  for (const k of KEYS) counts[k] = countOf(tap, k);

  const missing = KEYS.filter(k => counts[k] == null);
  if (missing.length > 0) {
    return { ok: false, counts,
      reason: `TAP 요약에서 읽지 못한 줄: ${missing.map(k => `# ${k}`).join(', ')}`
        + ' — 못 읽은 것을 0으로 읽지 않습니다' };
  }
  // **순서가 메시지의 정확도를 정한다.** `pass <= 0`을 앞에 두면 전부
  // 건너뛴 묶음이 "통과한 시험이 없습니다"로 보고된다 — 맞는 말이지만
  // 사람이 봐야 할 것은 "건너뛰었다"다. 처음에 그 순서로 썼고 시험이
  // 잡았다(관문끼리 서로 가리는 자리).
  if (counts.tests <= 0) return { ok: false, counts, reason: `tests ${counts.tests} — 하나도 돌지 않았습니다` };
  if (counts.fail !== 0) return { ok: false, counts, reason: `fail ${counts.fail} — 실패가 있습니다` };
  if (counts.cancelled !== 0) return { ok: false, counts, reason: `cancelled ${counts.cancelled} — 취소는 결과가 아닙니다` };
  if (counts.skipped !== 0) {
    return { ok: false, counts,
      reason: `skipped ${counts.skipped} — 건너뛴 시험이 있습니다.`
        + ' 전부 건너뛴 묶음도 종료 코드 0을 주므로, 그것을 통과로 적지 않습니다' };
  }
  if (counts.pass <= 0) return { ok: false, counts, reason: `pass ${counts.pass} — 통과한 시험이 없습니다` };
  return { ok: true, counts,
    reason: `tests ${counts.tests} · pass ${counts.pass} · fail 0 · skipped 0 · cancelled 0` };
}

// ── CLI ──
//
// **이 파일을 직접 돌렸을 때만 CLI다.** 처음에 `argv[1].endsWith(...)`로
// 썼더니 시험 파일 이름(`test-assert-tap-ran.mjs`)도 그 조건에 걸려서
// 시험이 터졌다 — 시험이 잡았다. 경로를 URL로 비교한다.
const runDirectly = (() => {
  try {
    return process.argv[1] != null
      && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;
  } catch { return false; }
})();

if (runDirectly) {
  const [, , file, label = file] = process.argv;
  if (!file) {
    console.error('사용: node scripts/assert-tap-ran.mjs <tap 파일> [이름]');
    process.exit(2);
  }
  let tap = null;
  try { tap = readFileSync(file, 'utf8'); } catch (e) {
    console.error(`❌ ${label}: TAP 파일을 읽지 못했습니다 (${e?.message || e})`);
    process.exit(1);
  }
  const v = verdictOf(tap);
  if (!v.ok) {
    console.error(`❌ ${label}: ${v.reason}`);
    process.exit(1);
  }
  console.log(`✅ ${label}: ${v.reason}`);
}

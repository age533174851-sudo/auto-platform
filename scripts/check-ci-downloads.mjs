#!/usr/bin/env node
// scripts/check-ci-downloads.mjs
//
// **내려받기가 깨진 것을 "검사 실패"처럼 보이게 두지 않는다.**
//
// 2026-11-08, PR #595 의 `verify` 가 빨갛게 떴다. 그 PR 은 모의 계좌
// 수익률을 고치는 변경이었고 워크플로를 한 줄도 건드리지 않았다. 로그
// 마지막 줄은 이것이었다:
//
//     sha256sum: WARNING: 1 computed checksum did NOT match
//     /tmp/actionlint.tgz: FAILED
//     ##[error]Process completed with exit code 1.
//
// 읽는 사람은 "체크섬이 틀렸다 = 누가 바이너리를 바꿔치기했다" 로 읽는다.
// 실제로는 **내려받기가 깨진 것**이었다. 같은 단계가 같은 고정 SHA 로
// 다른 PR 에서는 `OK` 로 통과한다.
//
// 왜 그렇게 보였나 — `curl -sSL` 에는 `--fail` 이 없다:
//
//     $ curl -sSL -o /tmp/x.tgz http://.../503
//     curl 종료코드 = 0                      ← 실패인데 0 이다
//     $ cat /tmp/x.tgz
//     <html><body>503 Service Unavailable</body></html>   ← 오류 본문이 파일이 됐다
//     $ sha256sum -c -
//     /tmp/x.tgz: FAILED                     ← 여기서 처음 터진다
//
// `--fail` 을 붙이면 curl 이 그 자리에서 22 로 죽고 **파일을 만들지 않는다.**
// `--retry` 를 붙이면 한 번 깜빡인 것으로 필수 검사가 빨개지지 않는다.
//
//     curl --fail --retry 3 --retry-all-errors → 종료코드 22 · 파일 없음
//
// **체크섬은 그대로 둔다.** 이 검사기는 막는 것을 없애지 않는다 — 내려받기
// 실패와 바꿔치기를 **구분**해서, 둘 다 실패로 남기되 읽는 사람이 어느
// 쪽인지 알 수 있게 한다(`CLAUDE.md`: 자동화보다 실패 지점 제거가 우선).
//
// ## 무엇을 세고, 무엇은 안 세는가
//
// 이 저장소의 `curl` 은 두 종류다. 섞어서 한 규칙을 걸면 한쪽이 깨진다.
//
//   ① **API 호출** — `-w '%{http_code}'` 로 상태코드를 받아 셸이 직접
//      판정한다. 200 안의 `ok:false` 까지 보려고 **일부러 본문을 받는다.**
//      여기에 `--fail` 을 붙이면 본문이 사라져 판정이 불가능해진다.
//      → 세지 않는다.
//
//   ② **아티팩트 내려받기** — 받아서 체크섬을 재고 실행한다. 오류 본문은
//      아무 쓸모가 없다. → `--fail` 을 요구한다. 체크섬까지 재는
//      자리라면 `--retry` 도 요구한다.
//
// 구분은 `%{http_code}` 를 잡는지로 한다.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WF_DIR = '.github/workflows';
let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };

/** `run:` 블록 하나를 나타낸다. 줄 번호는 파일 기준이다. */
export function runBlocks(src) {
  const lines = String(src ?? '').split('\n');
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:-\s+)?run:\s*\|?-?\s*$/.exec(lines[i]);
    if (m) {
      cur = { indent: m[1].length, start: i + 1, lines: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const line = lines[i];
    if (line.trim() === '') { cur.lines.push(line); continue; }
    const ind = line.length - line.trimStart().length;
    if (ind <= cur.indent) { cur = null; i -= 1; continue; }
    cur.lines.push(line);
  }
  return out.map((b) => ({ start: b.start, text: b.lines.join('\n') }));
}

/**
 * 셸 주석을 걷어낸다.
 *
 * **주석 처리한 `curl` 을 진짜 내려받기로 세면 안 된다.** 변이 시험이
 * 그 자리를 잡았다 — 내려받기 단계를 통째로 주석 처리했는데 검사기가
 * 여전히 "내려받기 1건, 전부 `--fail` 있음"으로 통과시켰다.
 *
 * `#` 은 따옴표 밖에서 단어 처음에 올 때만 주석이다. 따옴표 개수를 세어
 * 그 안쪽은 건드리지 않는다.
 */
export function stripShellComments(text) {
  return String(text ?? '').split('\n').map((line) => {
    let sq = false; let dq = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (c === '\\') { i += 1; continue; }
      if (c === "'" && !dq) { sq = !sq; continue; }
      if (c === '"' && !sq) { dq = !dq; continue; }
      if (c === '#' && !sq && !dq && (i === 0 || /\s/.test(line[i - 1]))) {
        return line.slice(0, i);
      }
    }
    return line;
  }).join('\n');
}

/** 블록 안의 `curl` 호출을 꺼낸다. 줄이 `\` 로 이어지면 이어 붙인다. */
export function curlCalls(blockText) {
  const joined = stripShellComments(blockText).replace(/\\\n\s*/g, ' ');
  return joined.split('\n').filter((l) => /(^|[\s(=$])curl\s/.test(l)).map((l) => l.trim());
}

/** 파일로 받는 호출인가. */
export function writesFile(call) {
  return /\s(-o|--output)\s/.test(call) || /\s-O(\s|$)/.test(call);
}

/** 셸이 상태코드를 직접 보는가 (= API 호출). */
export function judgesStatus(call) {
  return /%\{http_code\}/.test(call);
}

export function hasFail(call) {
  return /\s--fail(-early|-with-body)?(\s|$)/.test(call) || /\s-[a-zA-Z]*f[a-zA-Z]*(\s|$)/.test(call.replace(/--\S+/g, ''));
}

export function hasRetry(call) {
  return /\s--retry(\s|=)/.test(call);
}

/** 이 블록이 받은 것을 체크섬으로 재는가. */
export function verifiesChecksum(blockText) {
  return /sha(256|512)sum\s+(-c|--check)/.test(stripShellComments(blockText));
}

/** 한 워크플로의 지적을 모은다. 검사기와 자기 점검이 같은 함수를 쓴다. */
export function downloadFindings(src) {
  const found = [];
  let downloads = 0;
  for (const b of runBlocks(src)) {
    const checksummed = verifiesChecksum(b.text);
    for (const call of curlCalls(b.text)) {
      if (!writesFile(call)) continue;
      if (judgesStatus(call)) continue;   // ① API 호출 — 본문이 필요하다
      downloads += 1;
      const where = `${b.start}줄 근처`;
      if (!hasFail(call)) {
        found.push(`${where}: 아티팩트를 받는 \`curl\` 에 \`--fail\` 이 없습니다 — `
          + 'HTTP 오류에서도 종료코드 0 이고 오류 본문이 파일이 됩니다 '
          + '(그 다음 단계가 "체크섬 불일치"로 터져서 바꿔치기처럼 보입니다)');
      }
      if (checksummed && !hasRetry(call)) {
        found.push(`${where}: 체크섬까지 재는 내려받기에 \`--retry\` 가 없습니다 — `
          + '한 번 깜빡인 내려받기가 필수 검사를 빨갛게 만듭니다');
      }
    }
  }
  return { found, downloads };
}

const GOOD = `
      - name: x
        run: |
          set -euo pipefail
          curl --fail --silent --show-error --location --retry 3 --retry-all-errors \\
            -o /tmp/a.tgz "$url"
          echo "$SHA  /tmp/a.tgz" | sha256sum -c -
`;
const BAD_NO_FAIL = `
      - name: x
        run: |
          curl -sSL -o /tmp/a.tgz "$url"
          echo "$SHA  /tmp/a.tgz" | sha256sum -c -
`;
const BAD_NO_RETRY = `
      - name: x
        run: |
          curl --fail -sSL -o /tmp/a.tgz "$url"
          echo "$SHA  /tmp/a.tgz" | sha256sum -c -
`;
const API_CALL = `
      - name: x
        run: |
          out=$(curl -sSL -o "$body" -w '%{http_code} %{url_effective}' "$url")
          code=\${out%% *}
          [ "$code" = "200" ] || exit 1
`;

const COMMENTED = `
      - name: x
        run: |
          true # curl --fail -sSL -o /tmp/a.tgz "$url"
          echo hi
`;
const HASH_IN_QUOTES = `
      - name: x
        run: |
          curl --fail --retry 3 -o /tmp/a.tgz "$url#frag"
          echo "$SHA  /tmp/a.tgz" | sha256sum -c -
`;

const CASES = [
  { what: '고친 모양은 통과한다', src: GOOD, want: 0, downloads: 1 },
  { what: '주석 처리한 curl 은 내려받기로 세지 않는다', src: COMMENTED, want: 0, downloads: 0 },
  { what: '따옴표 안의 # 은 주석이 아니다', src: HASH_IN_QUOTES, want: 0, downloads: 1 },
  { what: '`--fail` 이 없으면 잡는다', src: BAD_NO_FAIL, want: 2, downloads: 1 },
  { what: '체크섬을 재는데 `--retry` 가 없으면 잡는다', src: BAD_NO_RETRY, want: 1, downloads: 1 },
  { what: '상태코드를 직접 보는 API 호출은 세지 않는다', src: API_CALL, want: 0, downloads: 0 },
];

export function selfTest() {
  const failed = [];
  for (const c of CASES) {
    const r = downloadFindings(c.src);
    if (r.found.length !== c.want) {
      failed.push(`${c.what} — 기대 ${c.want}건, 실제 ${r.found.length}건`
        + (r.found.length ? ` (${r.found[0]})` : ''));
    }
    if (r.downloads !== c.downloads) {
      failed.push(`${c.what} — 센 내려받기 기대 ${c.downloads}, 실제 ${r.downloads}`);
    }
  }
  return { total: CASES.length * 2, failed };
}

if (process.argv.includes('--self-test')) {
  const r = selfTest();
  for (const f of r.failed) console.error(`❌ 자기 점검 실패 — ${f}`);
  if (r.failed.length === 0) console.log(`✅ 자기 점검 ${r.total}/${r.total}`);
  process.exit(r.failed.length ? 1 : 0);
}

const SELF = selfTest();
for (const f of SELF.failed) err(`판단 자기 점검 실패 — ${f}`);

let files = [];
try {
  files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
} catch (e) {
  err(`${WF_DIR} 를 읽지 못했습니다 — 못 본 것을 "없음"으로 적지 않습니다`);
}

let totalDownloads = 0;
for (const f of files) {
  const src = readFileSync(join(WF_DIR, f), 'utf8');
  const { found, downloads } = downloadFindings(src);
  totalDownloads += downloads;
  for (const m of found) err(`${WF_DIR}/${f} ${m}`);
}

// **내려받기를 하나도 못 찾았으면 이 검사기는 아무것도 막지 않는다.**
// 모양이 바뀌어 안 걸리게 된 것과 정말 없는 것을 구분하지 못하므로
// 실패로 센다 — 조용히 통과하는 검사기가 가장 비싸다.
if (bad === 0 && totalDownloads === 0) {
  err(`${WF_DIR} 에서 아티팩트 내려받기를 한 건도 찾지 못했습니다 — `
    + '모양이 바뀌었는지 확인해야 합니다 (0건을 통과로 적지 않습니다)');
}

if (bad === 0) {
  console.log(`✅ 워크플로 ${files.length}개 · 아티팩트 내려받기 ${totalDownloads}건 — `
    + '전부 `--fail` 로 시끄럽게 실패하고, 체크섬을 재는 것은 `--retry` 가 있습니다 '
    + `(자기 점검 ${SELF.total}/${SELF.total})`);
}
process.exit(bad ? 1 : 0);

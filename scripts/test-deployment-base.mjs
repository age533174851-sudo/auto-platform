// scripts/test-deployment-base.mjs
//
// **배포 확인이 시크릿 없이도 돌아야 한다 — 그리고 한 주소만 믿어야 한다.**
//
// `node --test scripts/test-*.mjs` (ci.yml의 글롭)에 자동으로 걸린다.
//
// 무엇이 실제로 이랬나
// ────────────────────
// `scripts/verify-deployment.mjs`는 주소를 `BASE` 하나에서만 읽고 비면
// 이렇게 끝냈다:
//
//     ::error::확인할 주소가 없습니다 (EXIT_MONITOR_URL)
//            — 배포 상태를 확인하지 못했습니다
//
// 그런데 무인 회차는 `EXIT_MONITOR_URL`을 **일부러 받지 않는다**
// (`CLAUDE.md`의 울타리). 그래서 회차 보고마다 "배포를 확인하지
// 못했습니다"가 남고, 사람이 대신 눌러 봐야 했다 — `CLAUDE.md`가
// 없애라고 적은 바로 그 문장("SHA를 비교해 주세요")이다.
//
// `/api/system/deployment`는 **인증이 없는 경로**다. 실측(2026-11-24):
// 공개 주소로 그냥 GET해서 `verdict MATCHED`와 세 SHA를 다 읽었다.
//
// 그리고 한 번 더 틀렸다
// ──────────────────────
// 고친 직후 실행에서 `MISMATCH`가 났다. 배포는 멀쩡했고, 원인은
// **로컬 `origin/main` 참조가 낡은 것**이었다(그사이 다른 참여자가 #750을
// 머지했다: 로컬 `cc3dc28a` vs 실제 배포 `efd6a935`). 늘 틀릴 수 있는
// 검사는 진짜 빨강과 구별되지 않으므로, 가져오기를 판정 안에 넣었다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * 주석을 떼고 본다.
 *
 * ★ 이 함수가 없으면 이 시험이 **자기 설명에 걸린다.** 실제로 그랬다:
 *   아래 첫 시험이 "포기하는 분기가 돌아왔다"로 실패했는데, 걸린 것은
 *   코드가 아니라 **왜 고쳤는지 적어 둔 주석**이었다. 역사를 적어 두는
 *   것과 그 코드가 남아 있는 것은 다른 일이다.
 */
function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 블록 주석
    .replace(/(^|[^:])\/\/.*$/gm, '$1');  // 한 줄 주석 (URL의 // 는 남긴다)
}

const SCRIPT_RAW = readFileSync('scripts/verify-deployment.mjs', 'utf8');
const SCRIPT = codeOnly(SCRIPT_RAW);
const JUDGE = codeOnly(readFileSync('src/lib/ops/deploymentCheck.ts', 'utf8'));

test('★ 주소가 없다고 확인을 포기하지 않는다', () => {
  assert.ok(
    !/확인할 주소가 없습니다/.test(SCRIPT),
    '시크릿이 없으면 포기하는 분기가 돌아왔다 — 무인 회차는 그 시크릿을 받지 않는다',
  );
  assert.match(SCRIPT, /deploymentBaseFrom\(process\.env\)/,
    '주소는 한 곳(deploymentBaseFrom)에서 정해야 한다');
});

test('고친 이유를 적은 주석이 남아 있다 — 역사를 지우면 또 되돌아간다', () => {
  // 위 시험은 **코드**만 본다. 그래서 설명이 사라져도 통과한다.
  // 그 설명이 이 수정이 왜 있는지의 유일한 기록이다.
  assert.match(SCRIPT_RAW, /EXIT_MONITOR_URL/,
    '왜 시크릿 없이 돌아야 하는지가 파일에서 사라졌다');
  assert.match(SCRIPT_RAW, /인증이 없는 경로/,
    '이 경로가 인증 없이 읽힌다는 근거가 사라졌다');
});

test('★ main SHA를 읽기 전에 가져온다 (낡은 참조로 난 MISMATCH 재발 방지)', () => {
  const fn = /function mainShaFrom\([\s\S]*?\n}/.exec(SCRIPT);
  assert.ok(fn, 'mainShaFrom을 찾지 못했다');
  const body = fn[0];
  assert.match(body, /'fetch'/, '참조를 읽기 전에 git fetch를 해야 한다');
  const fetchAt = body.indexOf("'fetch'");
  const revAt = body.indexOf("'rev-parse'");
  assert.ok(fetchAt >= 0 && revAt >= 0 && fetchAt < revAt,
    'fetch가 rev-parse보다 먼저 와야 한다');
  assert.match(body, /가져오지 못함/,
    '가져오지 못했으면 그 사실이 출처에 적혀야 한다 — 적지 않으면 낡은 MISMATCH를 배포 문제로 읽는다');
});

test('★ 주소 자체는 로그에 넣지 않는다 — 출처만 적는다', () => {
  // 이 파일 머리말의 규칙("주소도 로그에 넣지 않는다")을 지키는지 본다.
  const logs = [...SCRIPT.matchAll(/console\.log\(([^\n]*)\)/g)].map(m => m[1]);
  const leaks = logs.filter(l => /\$\{\s*(BASE|url)\s*\}|\bBASE\b|\burl\b/.test(l));
  assert.deepEqual(leaks, [], `주소가 들어간 로그: ${leaks.join(' | ')}`);
  assert.match(SCRIPT, /주소 출처:/, '출처는 적어야 한다');
});

test('★ 공개 기본 주소의 정본이 하나다', () => {
  // 저장소에는 이미 `NEXT_PUBLIC_APP_URL || '<주소>'` 꼴이 여러 곳에 있다.
  // 판정 쪽이 **다른 주소**를 들고 있으면 같은 질문에 두 정본이 생기고,
  // 어느 배포를 본 것인지가 파일마다 달라진다.
  const m = /export const PUBLIC_APP_BASE = '([^']+)'/.exec(JUDGE);
  assert.ok(m, 'PUBLIC_APP_BASE 선언을 찾지 못했다');
  const base = m[1];
  const others = [
    'src/lib/notify/telegram.ts',
    'src/app/layout.tsx',
  ];
  for (const f of others) {
    const s = readFileSync(f, 'utf8');
    assert.ok(
      s.includes(base),
      `${f}가 다른 공개 주소를 쓰고 있다 — 판정은 ${base}를 본다`,
    );
  }
});

test('판정 쪽은 네 곳을 차례로 보고, 빈 값은 없는 것으로 본다 (소스 확인)', () => {
  assert.match(JUDGE, /'BASE', 'EXIT_MONITOR_URL', 'NEXT_PUBLIC_APP_URL', 'APP_URL'/);
  assert.match(JUDGE, /\.trim\(\)/, '공백만 든 값을 주소로 쓰지 않아야 한다');
  assert.match(JUDGE, /PUBLIC_DEFAULT/, '기본값까지 내려간 사실을 돌려줘야 한다');
});

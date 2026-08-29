#!/usr/bin/env node
// scripts/check-display-layer.mjs
//
// **숫자와 '확인 불가'를 화면이 각자 정하지 못하게 한다.**
//
// 사용자가 스크린샷으로 지적한 것들이 전부 같은 뿌리였다:
//   `0.00000000 USDT` · 반복되는 '확인 불가' · `내 원본 v1 (v1)`
//
// 원인은 하나다 — 같은 판단이 화면마다 복제돼 있었다. 저장소에
// `toFixed(`가 323번, `toLocaleString(`이 112번, 사설 `const fmt =`가
// 15개 넘게 있었다. 자동매매 화면은 만원 단위 원화를, 지갑 화면은 USDT를
// 같은 자리에 적고 있었다.
//
// 여기서 보는 것:
//   ① 표시 계층이 있고, 판단(자릿수·부호·모름)이 그 안에 있는가
//   ② Tone·UNKNOWN_TEXT가 한 곳에만 정의돼 있는가
//   ③ **옮긴 화면**이 다시 사설 포맷으로 돌아가지 않았는가
//
// ③이 전부가 아니라 '옮긴 화면'만인 이유: 90개 화면을 한 번에 옮기지
// 않는다. 옮긴 것부터 잠그고, 목록을 늘려 간다. **잠그지 않으면 다음
// 사람이 바로 옆에 사설 포매터를 하나 더 만든다.**
import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };
const read = (p) => existsSync(p) ? readFileSync(p, 'utf8') : null;
/**
 * 주석을 지운다.
 *
 * **정규식 두 줄로는 안 된다.** 처음엔 그렇게 했다가 조용히 틀렸다:
 * WalletPage 머리말에 `` `portfolio/*` `` 라는 줄 주석이 있는데,
 * 블록 주석 정규식이 그 `/*`를 시작으로 읽고 **59줄을 통째로 삼켰다.**
 * 그 구간의 import도 `toFixed`도 검사에 보이지 않았다 — 통과해도
 * 거짓이고 실패해도 거짓인 상태였다.
 *
 * 그래서 문자열·템플릿·주석 상태를 따라가며 훑는다. 느리지만 정확하다.
 */
function stripComments(src) {
  const s = String(src ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    // 줄 주석 — `//`가 문자열 밖에 있을 때만
    if (c === '/' && d === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      // 줄 번호가 어긋나면 오류 위치가 틀린다 — 개행은 남긴다
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        if (s[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    // 문자열·템플릿은 통째로 남긴다 — 그 안의 `/*`는 주석이 아니다
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c; i += 1;
      while (i < s.length) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] ?? ''); i += 2; continue; }
        out += s[i];
        if (s[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

// ── ① 표시 계층이 판단을 갖고 있는가 ──
const DISPLAY = 'src/lib/ui/display.ts';
{
  const src = read(DISPLAY);
  if (!src) {
    err(`${DISPLAY} — 표시 계층이 없습니다`);
  } else {
    const code = stripComments(src);
    for (const [re, why] of [
      [/export function digitsFor\s*\(/, '자릿수 판단(digitsFor)이 없습니다 — 화면이 다시 고르게 됩니다'],
      [/export function shownValue\s*\(/, '값 판단(shownValue)이 없습니다'],
      [/export function strategyLabel\s*\(/, '전략 이름 판단(strategyLabel)이 없습니다 — `내 원본 v1 (v1)`이 돌아옵니다'],
      [/export type Tone\s*=/, 'Tone 정의가 없습니다'],
      [/export const UNKNOWN_TEXT\s*=/, 'UNKNOWN_TEXT 정의가 없습니다'],
      [/known:\s*false/, '모르는 값을 표시하는 길이 없습니다 — 0으로 적히게 됩니다'],
    ]) if (!re.test(code)) err(`${DISPLAY} — ${why}`);

    // **"0을 0.00000000으로 적지 않는다"는 여기서 보지 않는다.**
    //
    // 처음엔 `a === 0) return 0`을 정규식으로 찾았다. 그런데 그 문장은
    // 수량 분기에도 있어서, **금액 쪽 규칙을 통째로 지워도 검사가
    // 초록이었다.** 통과해도 거짓인 검사다.
    //
    // 이 규칙은 값으로 확인하는 것이 맞다 —
    // `display.test.ts`의 '잔고 0은 0 USDT다'가 잡는다. 금액 분기를
    // 지우면 0이 8자리로 떨어져 그 테스트 하나가 정확히 깨진다.
    // 표시 계층은 저장소를 읽지 않는다 — 값은 넘겨받은 것만 쓴다
    if (/localStorage|sessionStorage/.test(code)) {
      err(`${DISPLAY} — 표시 계층이 브라우저 저장소를 읽습니다`);
    }
  }
}

// ── ② 같은 이름의 판단이 두 곳에 있지 않은가 ──
for (const rel of ['src/lib/ui/strategyCard.ts', 'src/lib/ui/autoOverview.ts']) {
  const src = read(rel);
  if (!src) { err(`${rel} — 파일이 없습니다`); continue; }
  const code = stripComments(src);
  if (/export type Tone\s*=\s*'/.test(code)) {
    err(`${rel} — Tone을 여기서 다시 정의합니다`
      + '\n     예전에 이 파일과 autoOverview.ts의 Tone이 서로 달랐습니다'
      + "\n     (한쪽에만 'live'가 있었습니다). display.ts에서 가져오세요");
  }
  if (/export const UNKNOWN_TEXT\s*=\s*'/.test(code)) {
    err(`${rel} — UNKNOWN_TEXT를 여기서 다시 정의합니다. display.ts에서 가져오세요`);
  }
}

// ── ③ 옮긴 화면은 되돌아가지 않는다 ──
//
// 이 목록은 **늘어나는 목록**이다. 화면을 옮길 때마다 여기 추가한다.
const MIGRATED = [
  'src/components/MockAutoTrade.tsx',
  'src/components/pages/WalletPage.tsx',
];

/**
 * 상태를 말해야 하는 화면.
 *
 * 여기 있는 화면은 색과 문구를 **직접 고르지 않는다.** 지갑 한 화면에만
 * 빨강·노랑 지정이 23곳 있었고, 같은 사건(계좌를 못 읽음)이 화면 위치에
 * 따라 다른 색과 다른 문장으로 나왔다.
 */
const STATUS_SCREENS = [
  'src/components/pages/WalletPage.tsx',
];

/**
 * **일부만 옮긴 화면.**
 *
 * AutoPage는 파일 전체를 옮기지 않았다 — 아직 예전 포맷이 많다. 그런데
 * 그 안의 모의 잔고 카드는 실제로 옮겼고, **그 부분이 되돌아가는 것을
 * 아무도 막지 않고 있었다.** 실제로 이 카드에는 `(paper.realizedPnl ?? 0)
 * >= 0`이 있어서, 손익을 못 읽으면 0으로 읽고 **이익인 것처럼 초록
 * 박스**를 띄우고 있었다. 그 자리가 다시 열리면 안 된다.
 *
 * 파일 전체를 잠그면 나머지 legacy 때문에 CI가 항상 빨갛고, 항상 빨간
 * 검사는 아무도 안 본다. 그래서 **구간만** 잠근다.
 *
 * 구간은 소스의 표식으로 정한다:
 *   {(/* partial-migrated: <NAME> start *(/}  ...  {(/* ... end *(/}
 */
const PARTIAL_MIGRATED = [
  {
    file: 'src/components/pages/AutoPage.tsx',
    region: 'AUTOPAGE-PAPER-CARD',
    what: '모의 잔고 카드',
    /** 이 구간에 반드시 있어야 하는 것 */
    require: [
      [/pnlText\(\s*paper\.realizedPnl/, '실현손익을 pnlText로 그리지 않습니다 — 부호·색이 값에서 나와야 합니다'],
      [/paperMoney\(|moneyText\(/, '금액을 공통 포맷으로 그리지 않습니다'],
      [/qtyText\(/, '수량을 qtyText로 그리지 않습니다'],
    ],
    /** 이 구간에 있으면 안 되는 것 */
    forbid: [
      // **가장 중요한 한 줄.** 못 읽은 손익을 0으로 읽으면 초록이 된다.
      [/\?\?\s*0/, 'UNKNOWN을 0으로 읽습니다 — 손익을 못 읽었는데 이익처럼 초록으로 그리게 됩니다'],
      [/\.toFixed\(/, 'toFixed로 자릿수를 직접 정합니다'],
      [/maximumFractionDigits/, '자릿수를 직접 지정합니다'],
      [/'확인 불가'/, "'확인 불가'를 직접 적습니다 — UNKNOWN_LABEL을 쓰세요"],
      // `x >= 0 ? 초록 : 빨강`은 모름을 이익으로 판정하는 통로다
      [/>=\s*0\s*\?[^\n]*grn/, '값이 0 이상인지로 색을 정합니다 — 모르는 값이 초록이 됩니다'],
    ],
  },
];

for (const rel of MIGRATED) {
  const src = read(rel);
  if (!src) { err(`${rel} — 파일이 없습니다`); continue; }
  const code = stripComments(src);

  if (!/from '@\/lib\/ui\/display'/.test(code)) {
    err(`${rel} — 표시 계층을 쓰지 않습니다`);
    continue;
  }
  // 사설 자릿수 결정.
  //
  // **줄 단위로 본다.** 화면에는 값이 아닌 숫자도 있다 — SVG 경로 좌표가
  // 그렇다. 그런 줄은 바로 위에 이유를 적고 빠져나갈 수 있게 하되,
  // **이유 없이는 못 빠져나간다**: 표식만 있고 설명이 없으면 실패다.
  const rawLines = src.split('\n');
  const exempt = new Set();
  rawLines.forEach((line, i) => {
    const m = /display-layer-exempt:\s*(.*)$/.exec(line);
    if (!m) return;
    if (!String(m[1] || '').trim()) {
      err(`${rel}:${i + 1} — display-layer-exempt에 이유가 없습니다`);
      return;
    }
    // 표식 줄부터 아래 3줄까지 봐 준다 (여러 줄 주석 + 코드 한 줄)
    for (let k = i; k <= i + 3; k += 1) exempt.add(k);
  });

  const codeLines = stripComments(src).split('\n');
  codeLines.forEach((line, i) => {
    if (exempt.has(i)) return;
    if (/\.toFixed\(/.test(line)) {
      err(`${rel}:${i + 1} — toFixed로 자릿수를 직접 정합니다`
        + '\n     자릿수는 값의 크기가 정합니다(display.digitsFor). 고정하면'
        + '\n     잔고 0이 `0.00000000`이 되거나 작은 수량이 `0.00`이 됩니다'
        + '\n     값이 아니라 좌표 같은 것이면 위 줄에 `display-layer-exempt: 이유`를 적으세요');
    }
    if (/maximumFractionDigits/.test(line)) {
      err(`${rel}:${i + 1} — 자릿수를 직접 지정합니다. display.ts를 쓰세요`);
    }
  });
  // 문구를 화면이 다시 적으면 화면마다 갈린다
  const inlineUnknown = (code.match(/'확인 불가'/g) || []).length;
  if (inlineUnknown > 0) {
    err(`${rel} — '확인 불가'를 ${inlineUnknown}곳에서 직접 적습니다`
      + '\n     UNKNOWN_LABEL을 쓰세요 — 문구가 바뀌면 한 곳만 고칩니다');
  }
}

// ── ④ 상태·환경 표현도 한 곳에서 나온다 ──
{
  const rel = 'src/lib/ui/status.ts';
  const src = read(rel);
  if (!src) {
    err(`${rel} — 상태 표현 계층이 없습니다`);
  } else {
    const code = stripComments(src);
    for (const [re, why] of [
      [/export type StatusKind\s*=[\s\S]{0,160}DISABLED/, 'SUCCESS·WARNING·ERROR·UNKNOWN·DISABLED 다섯 상태가 없습니다'],
      [/export function accountStatusOf\s*\(/, '계좌 상태 판정이 없습니다 — 없음·못 읽음·잔고 0이 다시 섞입니다'],
      [/export function unknownSummaryOf\s*\(/, "못 읽은 것을 한 장으로 압축하는 판정이 없습니다"],
      [/export function splitDiagnostics\s*\(/, '개발자용 원문을 본문에서 떼는 판정이 없습니다'],
      [/export const ENV_VIEW/, '환경(LIVE·TESTNET·MOCK) 표현이 없습니다'],
    ]) if (!re.test(code)) err(`${rel} — ${why}`);

    // 못 읽은 것을 빨강으로 그리면, 진짜 막힌 빨강과 구별되지 않는다.
    if (!/UNKNOWN:\s*'muted'/.test(code)) {
      err(`${rel} — 확인 불가를 회색이 아닌 색으로 그립니다`
        + '\n     전부 빨가면 어느 것도 빨갛지 않은 것과 같습니다');
    }
  }
}

for (const rel of STATUS_SCREENS) {
  const src = read(rel);
  if (!src) { err(`${rel} — 파일이 없습니다`); continue; }
  const code = stripComments(src);

  if (!/from '@\/lib\/ui\/status'/.test(code) || !/from '@\/components\/ui\/Status'/.test(code)) {
    err(`${rel} — 공통 상태 표현을 쓰지 않습니다`);
    continue;
  }
  // 서버가 준 원문을 **본문에 그대로 그리는** 자리.
  //
  // `text={x.note}`처럼 SafeNote에 넘기는 것은 정상이다 — 그쪽이 원문을
  // 갈라 준다. 문제는 JSX 자식으로 바로 그리는 `>{x.note}<`다.
  // (처음엔 둘을 구분하지 못해 올바른 코드를 실패로 적었다.)
  if (/[>}]\s*\{\s*\w+\.note\s*\}/.test(code)) {
    err(`${rel} — 서버 note를 본문에 그대로 그립니다`
      + '\n     DB·API 원문이 섞여 있으면 사용자 화면에 샙니다.'
      + '\n     splitDiagnostics로 본문과 진단을 가르세요');
  }
  // 긴 설명 여러 개를 한 줄로 이어 붙이면 사용자는 통째로 건너뛴다
  if (/\.filter\(Boolean\)\.join\(' · '\)/.test(code)) {
    err(`${rel} — 안내 문장 여러 개를 한 줄로 이어 붙입니다`
      + '\n     짧은 요약 + 접는 상세(Details)로 나누세요');
  }
}

// ── ④ 일부만 옮긴 구간도 되돌아가지 못하게 ──
for (const spec of PARTIAL_MIGRATED) {
  const src = read(spec.file);
  if (!src) { err(`${spec.file} — 파일이 없습니다`); continue; }

  // 파일 자체는 표시 계층을 알아야 한다
  if (!/from '@\/lib\/ui\/display'/.test(stripComments(src))) {
    err(`${spec.file} — 표시 계층 import가 사라졌습니다 (${spec.what})`);
    continue;
  }

  // **표식으로 구간을 찾는다.** 표식이 지워지면 잠금이 풀리므로 실패다.
  const startAt = src.indexOf(`partial-migrated: ${spec.region} start`);
  const endAt = src.indexOf(`partial-migrated: ${spec.region} end`);
  if (startAt < 0 || endAt < 0 || endAt <= startAt) {
    err(`${spec.file} — ${spec.region} 구간 표식이 없습니다 (${spec.what})`
      + '\n     표식을 지우면 이 구간의 회귀를 아무도 막지 못합니다'
      + `\n     {/* partial-migrated: ${spec.region} start *` + '/} … end 를 다시 넣으세요');
    continue;
  }
  const region = stripComments(src.slice(startAt, endAt));

  for (const [re, why] of spec.require) {
    if (!re.test(region)) err(`${spec.file} · ${spec.what} — ${why}`);
  }
  for (const [re, why] of spec.forbid) {
    if (re.test(region)) err(`${spec.file} · ${spec.what} — ${why}`);
  }
}

if (bad === 0) {
  console.log(`✅ 표시 계층 유지 — 자릿수·부호·'확인 불가'·전략 이름·상태·환경은 한 곳에서 정한다`
    + ` (옮긴 화면 ${MIGRATED.length}개 · 상태 화면 ${STATUS_SCREENS.length}개`
    + ` · 구간 잠금 ${PARTIAL_MIGRATED.length}개)`);
} else {
  console.error('');
  console.error('   같은 값을 두 화면이 다르게 적으면 사용자는 둘 다 믿지 않습니다.');
}
process.exit(bad ? 1 : 0);

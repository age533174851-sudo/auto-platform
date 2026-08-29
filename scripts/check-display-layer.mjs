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
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

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
];

for (const rel of MIGRATED) {
  const src = read(rel);
  if (!src) { err(`${rel} — 파일이 없습니다`); continue; }
  const code = stripComments(src);

  if (!/from '@\/lib\/ui\/display'/.test(code)) {
    err(`${rel} — 표시 계층을 쓰지 않습니다`);
    continue;
  }
  // 사설 자릿수 결정
  if (/\.toFixed\(/.test(code)) {
    err(`${rel} — toFixed로 자릿수를 직접 정합니다`
      + '\n     자릿수는 값의 크기가 정합니다(display.digitsFor). 고정하면'
      + '\n     잔고 0이 `0.00000000`이 되거나 작은 수량이 `0.00`이 됩니다');
  }
  if (/maximumFractionDigits/.test(code)) {
    err(`${rel} — 자릿수를 직접 지정합니다. display.ts를 쓰세요`);
  }
  // 문구를 화면이 다시 적으면 화면마다 갈린다
  const inlineUnknown = (code.match(/'확인 불가'/g) || []).length;
  if (inlineUnknown > 0) {
    err(`${rel} — '확인 불가'를 ${inlineUnknown}곳에서 직접 적습니다`
      + '\n     UNKNOWN_LABEL을 쓰세요 — 문구가 바뀌면 한 곳만 고칩니다');
  }
}

if (bad === 0) {
  console.log(`✅ 표시 계층 유지 — 자릿수·부호·'확인 불가'·전략 이름은 한 곳에서 정한다 (옮긴 화면 ${MIGRATED.length}개)`);
} else {
  console.error('');
  console.error('   같은 값을 두 화면이 다르게 적으면 사용자는 둘 다 믿지 않습니다.');
}
process.exit(bad ? 1 : 0);

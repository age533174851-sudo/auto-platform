#!/usr/bin/env node
// scripts/check-paper-wiring.mjs
//
// **모의투자 계좌가 조용히 생기고, 지갑 MOCK 탭이 조용히 비어 있었다.**
//
// 두 가지가 같은 뿌리였다.
//
//   ① 읽기가 계좌를 만들었다
//        getPaperAccount()는 줄이 없으면 balance 10,000짜리 줄을 만든다.
//      그 함수를 `/api/paper/account` GET과 **워커가 15분마다 부르는**
//      `/api/wallets/snapshot`이 썼다. 그래서 모의투자를 시작한 적 없는
//      사용자에게도 계좌가 있었고, MOCK 탭을 배선하는 순간 그 10,000이
//      **사용자가 고른 적 없는 총자산**으로 화면에 뜬다.
//
//   ② 지갑의 envs가 ['LIVE','TESTNET']로 고정이었다
//      화면에는 MOCK 탭이 있는데 서버가 그 칸을 만든 적이 없다 —
//      이 저장소의 단골 고장("만들어 놓고 배선을 안 함") 그대로다.
//
// 둘 다 판정기가 아니라 **배선**이라 순수 테스트로는 안 잡힌다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let bad = 0;
const err = (m) => { bad += 1; console.error(`❌ ${m}`); };

function read(rel) {
  try { return readFileSync(join(ROOT, rel), 'utf8'); }
  catch { err(`${rel}을 읽지 못했습니다 — 검사가 대상을 잃었습니다`); return null; }
}

/** 주석을 걷어 낸다 — 설명 주석에 적힌 옛 코드에 속지 않기 위해서다 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 모의 계좌를 읽는 경로 전부. 셋이 같은 답을 내야 한다 */
const READERS = [
  'src/app/api/wallets/overview/route.ts',
  'src/app/api/wallets/snapshot/route.ts',
  'src/app/api/paper/account/route.ts',
];

// ── ① 읽기 경로는 계좌를 만들지 않는다 ──
for (const rel of READERS) {
  const src = read(rel);
  if (!src) continue;
  const code = stripComments(src);
  if (/getPaperAccount\s*\(/.test(code)) {
    err(`${rel} — getPaperAccount()를 부릅니다`
      + '\n     그 함수는 줄이 없으면 10,000 USDT짜리 계좌를 **만듭니다**'
      + '\n     읽기가 계좌를 만들면 "모의투자 시작하기"는 영영 뜨지 않고,'
      + '\n     사용자가 고른 적 없는 종잣돈이 총자산으로 화면에 뜹니다');
  }
}

// ── ② 세 경로가 같은 읽기를 쓴다 ──
//
// **정의가 아니라 호출을 본다.** 예전에 이 검사류가 함수 정의에 걸려
// 통과한 적이 있다 — 그러면 검사는 아무것도 지키지 못한다.
for (const rel of READERS) {
  const src = read(rel);
  if (!src) continue;
  const code = stripComments(src);
  if (!/await\s+readPaperEquity\s*\(/.test(code)) {
    err(`${rel} — readPaperEquity()를 부르지 않습니다`
      + '\n     같은 판단(잔고·포지션·평가손익·총자산)이 경로마다 한 벌씩 생기면'
      + '\n     언젠가 한쪽만 고쳐지고 두 화면이 다른 총자산을 말합니다');
  }
}

// ── ③ 읽기 모듈 자체가 쓰지 않는다 ──
{
  const rel = 'src/lib/portfolio/paperRead.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    for (const op of ['insert', 'upsert', 'update', 'delete']) {
      if (new RegExp(`\\.${op}\\s*\\(`).test(code)) {
        err(`${rel} — .${op}()가 있습니다. **읽기는 쓰지 않습니다**`);
      }
    }
  }
}

// ── ④ 지갑이 MOCK 칸을 실제로 만든다 ──
{
  const rel = 'src/app/api/wallets/overview/route.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/paperEnvWalletOf\s*\(/.test(code)) {
      err(`${rel} — MOCK 환경 칸을 만들지 않습니다`
        + '\n     화면에는 MOCK 탭이 있습니다. 서버가 칸을 안 만들면'
        + '\n     사용자는 눌러도 아무 숫자가 없는 탭을 봅니다');
    }
    if (!/\[\s*\.\.\.w\.envs\s*,/.test(code)) {
      err(`${rel} — MOCK을 envs에 이어 붙이지 않습니다`
        + '\n     이어 붙여야 아래 스냅샷·성과·자산곡선 루프가 MOCK도 덮습니다'
        + '\n     MOCK만 따로 그리면 규칙이 두 벌이 되고 한쪽만 고쳐집니다');
    }
  }
}

// ── ⑤ 시작은 실제로 저장됐을 때만 성공이다 ──
{
  const rel = 'src/app/api/paper/account/route.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/\.upsert\s*\([\s\S]*?\.select\s*\(/.test(code)) {
      err(`${rel} — 시작(reset)이 저장된 줄을 되읽지 않습니다`
        + '\n     PostgREST의 UPDATE는 0줄을 고쳐도 오류가 아닙니다(RLS 포함)'
        + '\n     되읽지 않으면 화면은 시작됐다고 믿고, 이후 숫자가 전부 거짓입니다');
    }
    if (!/started_at/.test(code)) {
      err(`${rel} — 시작 시각을 남기지 않습니다`
        + '\n     started_at이 없으면 사용자가 고른 계좌와 자동으로 생긴'
        + '\n     빈 계좌를 구별할 수 없습니다');
    }
  }
}

// ── ⑥ 화면이 스스로 판정하지 않는다 ──
{
  const rel = 'src/components/pages/WalletPage.tsx';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/paperPanelOf\s*\(/.test(code)) {
      err(`${rel} — paperPanelOf를 쓰지 않습니다`
        + '\n     화면 안에서 "시작 안 함"을 판정하면 테스트할 수 없고,'
        + '\n     **못 읽은 상태에서 시작 버튼이 뜨는 날**이 옵니다');
    }
    if (/canStart\s*:\s*true/.test(code)) {
      err(`${rel} — 시작 가능 여부를 화면에서 손으로 켭니다`
        + '\n     그 판정은 paperPanelOf 한 곳에 있어야 합니다');
    }
  }
}

if (bad === 0) {
  console.log('✅ 모의투자 배선 유지 — 읽기는 계좌를 만들지 않고 · 지갑 MOCK 칸은 서버가 만든다');
} else {
  console.error('');
  console.error('   0은 "없다"이고 실패는 "모른다"입니다.');
  console.error('   고른 적 없는 종잣돈을 총자산이라고 적는 것은 그보다 나쁩니다.');
}
process.exit(bad ? 1 : 0);

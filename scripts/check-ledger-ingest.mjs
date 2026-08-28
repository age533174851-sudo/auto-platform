#!/usr/bin/env node
// scripts/check-ledger-ingest.mjs
//
// **오늘 손익이 영원히 "확인 불가"였던 이유는 판정식이었다.**
//
// 지갑은 `covered_to >= now`를 요구했다. 그런데 수집은 15분마다 돌고,
// `covered_to`는 마지막 수집 시각이다. 지갑이 요청하는 시각은 언제나
// 그보다 뒤다 — 즉 **연결이 정상이고 매 회차 성공해도 조건이 참이 될 수
// 없었다.** 수집기를 아무리 고쳐도 값이 나오지 않는다.
//
// 반대 방향은 더 나쁘다: 수집 증거가 없는데 0을 적는 것.
// 이 검사는 두 방향을 다 본다.
//
// 배선이라 순수 테스트로는 안 잡힌다.
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

// ── ① 브라우저와 무관하게 워커가 주기 실행한다 ──
{
  const rel = 'worker/src/index.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    // **정의가 아니라 호출을 본다.** 정의만 보면 아무도 안 부르는
    // 함수를 "돌고 있다"고 읽는다.
    if (!/await\s+pollLedgerSync\s*\(/.test(code)) {
      err(`${rel} — 워커의 tick에서 원장 수집을 부르지 않습니다`
        + '\n     안 부르면 수수료·펀딩이 안 모이고, 매매손익은 영원히 null입니다'
        + '\n     그리고 브라우저를 열어야만 모이는 구조가 됩니다');
    }
    if (!/LEDGER_SYNC_INTERVAL_MS|LEDGER_SYNC_MS/.test(code)) {
      err(`${rel} — 수집 주기가 상수로 없습니다`);
    }
  }
}

// ── ② 지갑이 "지금까지 덮였는가"를 묻지 않는다 ──
{
  const rel = 'src/app/api/wallets/overview/route.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/ledgerWindowOf\s*\(/.test(code)) {
      err(`${rel} — 덮인 창(ledgerWindowOf)으로 묻지 않습니다`
        + '\n     `covered_to >= now`를 요구하면, 15분 주기 수집기로는'
        + '\n     **어떤 경우에도 참이 될 수 없습니다** — 오늘 손익이 영원히 확인 불가입니다');
    }
    // 합계 구간에 상한이 없으면 자산 변화와 장부가 서로 다른 기간을 본다.
    if (!/\.lte\(\s*'occurred_at'/.test(code)) {
      err(`${rel} — 장부 합계에 상한이 없습니다`
        + '\n     덮였다고 판정한 구간 바깥의 사건이 합계에 들어갑니다'
        + '\n     매매손익 = 자산변화 − 유입 − 수수료 − 펀딩의 네 항이 서로 다른 기간을 가리킵니다');
    }
    // 수집 증거가 없는데 0으로 바꾸는 형태를 막는다.
    if (/ledgerComplete\s*:\s*true/.test(code)) {
      err(`${rel} — 완전성을 손으로 참으로 둡니다`
        + '\n     수집 증거 없이 손익을 확정하면 빠진 수수료가 전부 수익으로 보입니다');
    }
  }
}

// ── ③ 수집 대상은 활성 연결 전부에서 나온다 ──
{
  const rel = 'src/app/api/ledger/sync/route.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/ingestTargetsOf\s*\(/.test(code)) {
      err(`${rel} — 수집 대상을 ingestTargetsOf로 고르지 않습니다`
        + '\n     별도 등록 목록을 두면 새 연결을 만들 때 한 줄을 빼먹고,'
        + '\n     그 연결의 수수료만 조용히 빠집니다');
    }
    if (!/ingestStatePatchOf\s*\(/.test(code)) {
      err(`${rel} — 상태 갱신 규칙을 라우트에서 다시 씁니다`
        + '\n     같은 규칙이 두 벌이 되면 언젠가 한쪽만 고쳐집니다');
    }
    // ── 가장 중요한 것 ──
    //
    // supabase-js는 DB 오류를 **던지지 않는다**. 반환값을 버리면
    // 상태 기록이 실패해도 try/catch에 안 걸리고, 그 회차는 성공으로
    // 보고된다 — **적히지 않은 coverage가 적힌 것처럼 보인다.**
    // upsert 문 하나하나를 보고, **그 문장이 error를 받는지** 확인한다.
    // 정규식 하나로 뭉뚱그리면 다른 문장에 걸려 통과해 버린다.
    const stmts = code.split(/\n\s*\n/).filter(b => /ledger_ingest_state/.test(b) && /\.upsert\(/.test(b));
    if (stmts.length === 0) {
      err(`${rel} — ledger_ingest_state에 쓰는 곳이 없습니다`
        + '\n     상태를 안 적으면 그 연결은 영원히 "한 번도 읽지 않음"입니다');
    }
    for (const b of stmts) {
      if (!/\{\s*error\s*:\s*\w+\s*\}\s*=\s*await/.test(b)) {
        err(`${rel} — ledger_ingest_state upsert의 오류를 받지 않습니다`
          + '\n     supabase-js는 DB 오류를 던지지 않습니다 — { error }로 줍니다'
          + '\n     버리면 DB 실패가 성공으로 기록되고,'
          + '\n     **적히지 않은 coverage가 적힌 것처럼 보입니다**');
        break;
      }
    }
  }
}

// ── ④ 운영 화면에서 수집 상태를 볼 수 있다 ──
{
  const rel = 'src/app/api/system/runtime-health/route.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/ingestHealthOf\s*\(/.test(code)) {
      err(`${rel} — 원장 수집 상태를 내려주지 않습니다`
        + '\n     그러면 "확인 불가"의 원인을 고르는 방법이 Fly 로그를 여는 것뿐입니다');
    }
  }
}

// ── ⑤ 사유에 비밀이 섞이지 않는다 ──
{
  const rel = 'src/lib/ledger/ingestHealth.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/sanitizeReason\s*\(/.test(code)) {
      err(`${rel} — 실패 사유를 거르지 않고 내보냅니다`);
    }
  }
}

// ── ⑥ 실패가 덮인 지점을 전진시키지 않는다 ──
{
  const rel = 'src/lib/ledger/ingestState.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/if\s*\(\s*!i\.readOk\s*\)/.test(code)) {
      err(`${rel} — 읽기 실패를 따로 다루지 않습니다`
        + '\n     실패 회차가 covered_to를 옮기면, 읽지 않은 구간을 읽었다고 말하게 됩니다');
    }
    if (!/failed\s*>\s*0/.test(code)) {
      err(`${rel} — 기록 실패가 있는 회차를 전진시킵니다`);
    }
  }
}

if (bad === 0) {
  console.log('✅ 원장 수집 배선 유지 — 워커가 돌리고 · 덮인 만큼만 말하고 · 실패는 전진시키지 않는다');
} else {
  console.error('');
  console.error('   수집 증거가 없는데 0원을 적는 것이 가장 나쁩니다.');
  console.error('   빠진 수수료는 전부 수익으로 보입니다.');
}
process.exit(bad ? 1 : 0);

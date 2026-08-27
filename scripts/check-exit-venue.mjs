#!/usr/bin/env node
// scripts/check-exit-venue.mjs
//
// **청산 감시가 어느 계좌·어느 거래소인지 모른 채 손절을 옮기고 있었다.**
//
// 두 가지가 같은 뿌리였다.
//
//   ① 계좌를 거래가 아니라 사용자로 골랐다
//        .eq('user_id', uid).eq('is_active', true).limit(1).maybeSingle()
//      바이낸스·Gate를 둘 다 연결해 두면 Gate 포지션의 손절 이동이
//      바이낸스로 나간다. `ladder_daily_trades`에 연결을 적는 칸이
//      아예 없어서 고를 근거가 없었다.
//
//   ② 봉을 언제나 바이낸스에서 가져왔다
//        const host = testnet ? demo-fapi.binance : fapi.binance
//      Gate 계약(BTC_USDT)을 바이낸스에 물으면 400이고, 그 실패는
//      "캔들 조회 실패 — 이번 주기 건너뜀"으로 끝난다. **매 주기 조용히
//      반복되므로 Gate 포지션의 트레일링은 영원히 안 돈다.**
//
// 둘 다 판정기가 아니라 **배선**의 문제라 순수 테스트로 안 잡힌다.
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

// ── ① 봉은 거래소를 보고 가져온다 ──
{
  const rel = 'src/lib/engine/exitMonitor.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/exchange\s*:\s*'binance'\s*\|\s*'gate'/.test(code)) {
      err(`${rel} — highWaterSince가 거래소를 인자로 받지 않습니다`
        + '\n     받지 않으면 Gate 포지션도 바이낸스 봉으로 계산합니다'
        + '\n     그리고 그 실패는 "이번 주기 건너뜀"이라 조용히 반복됩니다');
    }
    if (!/getCandlesGateFutures/.test(code)) {
      err(`${rel} — Gate 봉을 가져오는 경로가 없습니다`
        + '\n     바이낸스 klines 하나만 있으면 Gate 거래의 트레일링은 영원히 안 돕니다');
    }
    // 계좌를 고르는 근거가 사라지지 않게 한다.
    if (!/venueFor/.test(code)) {
      err(`${rel} — 거래별 계좌 선택(venueFor)이 없습니다`
        + '\n     없으면 부르는 쪽이 다시 user_id로 첫 연결을 고르게 됩니다');
    }
    if (!/connection_id/.test(code)) {
      err(`${rel} — 거래의 connection_id를 읽지 않습니다`
        + '\n     읽지 않으면 어느 계좌의 포지션인지 알 방법이 없습니다');
    }
  }
}

// ── ② 계좌는 거래를 보고 고른다 ──
{
  const rel = 'src/lib/engine/tradeVenue.ts';
  const src = read(rel);
  if (src) {
    for (const name of ['AMBIGUOUS', 'GONE', 'SOLE', 'OWNED']) {
      if (!src.includes(name)) {
        err(`${rel}에 ${name}이 없습니다 — 계좌 판정이 사라졌습니다`);
      }
    }
    // 못 고른 것을 첫 줄로 채우면 이 파일이 있는 의미가 없다.
    if (!/actionable:\s*false/.test(src)) {
      err(`${rel} — 손대지 않는 판정이 없습니다`
        + '\n     고르지 못했는데 actionable이면 남의 계좌로 주문이 나갑니다');
    }
  }
}

// ── ③ 라우트가 계좌 선택을 다시 구현하지 않는다 ──
{
  const rel = 'src/app/api/autotrade/exit-monitor/route.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    // **이름이 있는 것과 부르는 것은 다르다.** 처음 판을 이 차이로
    // 놓쳤다 — `const tradeVenueOf: any = null`도 통과했다.
    if (!/tradeVenueOf\s*\(/.test(code)) {
      err(`${rel} — tradeVenueOf를 부르지 않습니다`
        + '\n     계좌 고르는 규칙이 두 벌이 되면 한쪽만 고쳐집니다');
    }
    if (!/venueFor/.test(code)) {
      err(`${rel} — decideExits에 venueFor를 넘기지 않습니다`
        + '\n     안 넘기면 예전 경로(사용자의 활성 연결 첫 줄)로 되돌아갑니다');
    }
  }
}

// ── ④ 진입이 연결을 장부에 남긴다 ──
{
  const rel = 'src/lib/strategies/ladderGate.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/connection_id/.test(code)) {
      err(`${rel} — 진입 장부에 connection_id를 남기지 않습니다`
        + '\n     남기지 않으면 청산 감시가 어느 계좌인지 영영 알 수 없습니다');
    }
  }
}

// ── ⑤ 생명주기가 세 전략 모두에 배선돼 있는가 ──
//
// 판정 함수만 있고 라우트가 안 부르면 아무 일도 일어나지 않는다 —
// 이 저장소에서 반복된 "만들어 놓고 배선을 안 함"이다.
{
  const rel = 'src/app/api/autotrade/exit-monitor/route.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    for (const [re, why] of [
      // **정의가 있는 것과 부르는 것은 다르다.** 이 검사의 첫 판이
      // `async function runLifecycleSweep(`을 호출로 세어 속았다.
      [/await\s+runLifecycleSweep\s*\(/, '생명주기 경로를 부르지 않습니다 — scalp·my-original-v1이 다시 감시 밖으로 나갑니다'],
      [/managedCandidates/, 'live_orders에서 후보를 만들지 않습니다'],
      [/lifecycleDecide/, '생명주기 판정을 쓰지 않습니다'],
      [/moveStopSafely/, '손절 이동을 안전한 순서로 하지 않습니다 (걸고 → 적고 → 치운다)'],
      [/mutationKeyOf/, '같은 자리 중복 실행을 막지 않습니다'],
    ]) {
      if (!re.test(code)) err(`${rel} — ${why}`);
    }
  }
}

// ── ⑥ 손절 이동 순서가 살아 있는가 ──
{
  const rel = 'src/lib/engine/stopMove.ts';
  const src = read(rel);
  if (src) {
    if (!/RECORD_FAILED/.test(src)) {
      err(`${rel} — 장부 기록 실패 판정이 없습니다`
        + '\n     기록에 실패했는데 기존 손절을 취소하면 손절 없는 포지션이 남습니다');
    }
  }
}

// ── ⑦ 커버리지 표를 손으로 true로 적지 않는다 ──
{
  const rel = 'src/lib/engine/exitCoverage.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/lifecyclePolicyOf\s*\(/.test(code)) {
      err(`${rel} — 커버리지를 정책에서 읽지 않습니다`
        + '\n     손으로 적은 true는 구현이 없어도 초록이 됩니다');
    }
  }
}

if (bad === 0) {
  console.log('✅ 청산 감시 배선 유지 — 계좌는 거래로 고르고 · 봉은 그 거래소에서 가져온다');
} else {
  console.error('');
  console.error('   못 여는 것은 불편이고 못 닫는 것은 사고입니다.');
  console.error('   엉뚱한 계좌에 청산을 보내는 것은 그보다 나쁩니다.');
}
process.exit(bad ? 1 : 0);

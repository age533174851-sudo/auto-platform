#!/usr/bin/env node
// scripts/check-order-guards.mjs
//
// **킬 스위치가 일곱 주문 경로 중 둘에서만 돌고 있었다.**
//
// 세어 보기 전까지 아무도 몰랐다. 화면에는 '킬스위치 발동 중'이 떠 있는데
// COIN-M도, 현물도, 주식도, 사다리도, 스캘핑도 주문을 계속 냈다.
// 그리고 하필 자동매매 실행기(AutoTradeEngine)가 부르는
// `/api/exchange/order`에는 그 어떤 보호도 없었다.
//
// 이건 이 저장소에서 가장 자주 나는 고장이다:
// **경로가 여럿인데 한쪽만 고친다.** 고친 쪽을 보고 "됐다"고 믿는다.
//
// 반쯤 걸린 안전장치는 없는 것보다 나쁘다
// ────────────────────────────────────────
// 킬스위치가 없으면 사용자는 직접 포지션을 닫는다. 킬스위치가 절반만
// 걸려 있으면 사용자는 **다 멈춘 줄 알고 화면을 닫는다.** 그동안 나머지
// 경로는 계속 주문을 낸다.
//
// 그래서 이 검사는 "붙였는가"를 CI에서 센다. 새 주문 경로를 만들면
// 여기 목록에 넣어야 하고, 안 넣으면 빌드가 깨진다.

import { readFileSync, existsSync } from 'node:fs';

// **실제 돈이 나갈 수 있는 경로만 넣는다.**
// 조회·모의 라우트를 섞으면 목록이 길어지고, 길어지면 아무도 안 본다.
const ORDER_ROUTES = [
  'src/app/api/binance/futures/order/route.ts',
  'src/app/api/binance/coinm/order/route.ts',
  'src/app/api/binance/spot/order/route.ts',
  'src/app/api/stock/order/route.ts',
  'src/app/api/exchange/order/route.ts',
  'src/app/api/webhook/tradingview/route.ts',
  'src/app/api/autotrade/daily-ladder/route.ts',
  'src/app/api/autotrade/scalp/route.ts',
  'src/app/api/autotrade/my-original-v1/route.ts',
  // 강제 스모크 테스트도 **실제 주문을 낸다.** 테스트넷 전용이라고
  // 목록에서 빼면, 킬스위치가 켜진 계좌에서도 주문이 나간다.
  //
  // 라우트가 아니라 이 파일이다 — 1회차는 사람이(POST), 2회차부터는
  // 워커가(advance) 부르는데 **시작 절차는 여기 하나뿐**이다.
  // 라우트 둘을 각각 검사하면 실제 주문을 내는 곳은 아무도 안 본다.
  'src/lib/smoke/startAttempt.ts',
];

// 각 경로가 반드시 물어봐야 하는 것.
//
// 킬스위치는 **사용자가 누르는 것**이다. "이 계좌를 지금 멈춰라".
// 나머지 관문(liveTradingGate, gateOrder)은 운영자·배포 쪽 판정이라
// 성격이 다르고, 그래서 킬스위치를 대신하지 못한다.
const REQUIRED = [
  {
    key: 'killSwitch',
    label: '킬 스위치',
    // killSwitchGate가 권장이고, isKillSwitchActive 직접 호출도 인정한다.
    // 다만 직접 호출은 readOk를 놓치기 쉬워 아래에서 따로 경고한다.
    test: (src) => /killSwitchGate|isKillSwitchActive/.test(src),
    why: '사용자가 계좌를 멈추려고 누르는 장치입니다. 여기 없으면 눌러도 이 경로는 계속 주문합니다',
  },
];

const errors = [];
const warns = [];

for (const rel of ORDER_ROUTES) {
  if (!existsSync(rel)) {
    errors.push(`${rel}\n     목록에 있는데 파일이 없습니다 — 지웠으면 이 목록에서도 빼세요`);
    continue;
  }
  const src = readFileSync(rel, 'utf8');

  for (const r of REQUIRED) {
    if (!r.test(src)) {
      errors.push(`${rel}\n     ${r.label}가 없습니다 — ${r.why}`);
    }
  }

  // **`try { … } catch {}`로 감싼 킬스위치는 안 건 것과 같다.**
  // 조회가 실패하면 조용히 통과한다. 실제로 그렇게 돼 있었다.
  if (/try\s*\{[^}]*isKillSwitchActive[^}]*\}\s*catch\s*\{\s*\}/s.test(src)) {
    errors.push(`${rel}\n     킬스위치를 빈 catch로 감쌌습니다 —`
      + ' 조회가 실패하면 조용히 통과합니다. killSwitchGate를 쓰세요');
  }

  // readOk를 안 보는 직접 호출.
  if (/isKillSwitchActive/.test(src) && !/readOk/.test(src) && !/killSwitchGate/.test(src)) {
    warns.push(`${rel}\n     isKillSwitchActive를 직접 부르면서 readOk를 안 봅니다 —`
      + ' 조회 실패가 통과로 새어 나갑니다');
  }
}

// 목록에 없는 새 주문 경로를 놓치지 않는다.
//
// 이 검사의 가장 흔한 실패는 "검사는 통과했는데 새 경로가 목록에 없다"이다.
// 그러면 검사가 켜져 있는 것처럼 보이면서 아무것도 안 지킨다.
//
// `node:fs`의 globSync를 정적 import하지 않는다 — 없는 런타임에서는
// 모듈 로드 자체가 깨져서, 안전장치 검사가 통째로 안 돌게 된다.
// **검사가 조용히 사라지는 것이 검사가 못 찾는 것보다 나쁘다.**
let candidates = [];
try {
  const fs = await import('node:fs');
  candidates = typeof fs.globSync === 'function'
    ? fs.globSync('src/app/api/**/order/route.ts')
    : [];
} catch { candidates = []; }

const known = new Set(ORDER_ROUTES);
// 모의 전용 경로는 실주문이 아니다.
const NOT_REAL = new Set([
  'src/app/api/paper/order/route.ts',
  // 실주문 갈래가 501을 돌려준다 (아직 미구현). 구현되면 목록에 넣어야 한다.
  'src/app/api/order/route.ts',
]);
for (const c of candidates) {
  const rel = c.replaceAll('\\', '/');
  if (known.has(rel) || NOT_REAL.has(rel)) continue;
  errors.push(`${rel}\n     새 주문 경로로 보이는데 이 검사의 목록에 없습니다 —`
    + ' 실주문을 낸다면 ORDER_ROUTES에, 아니면 NOT_REAL에 사유와 함께 넣으세요');
}

if (warns.length > 0) {
  console.log('⚠️  주문 경로 경고:');
  for (const w of warns) console.log(`   · ${w}`);
  console.log('');
}

if (errors.length > 0) {
  console.error('❌ 주문 경로에 안전장치가 빠졌습니다:');
  for (const e of errors) console.error(`   · ${e}`);
  console.error('');
  console.error('   반쯤 걸린 안전장치는 없는 것보다 나쁩니다 —');
  console.error('   사용자는 다 멈춘 줄 알고 화면을 닫습니다.');
  process.exit(1);
}

// ── 조회 실패를 0으로 만드는 길 ────────────────────────
//
// **0은 '없다'이고 조회 실패는 '모른다'인데, 화면에서는 둘 다 0.00이다.**
//
// 주문 엔진에서 몇 번이나 고친 패턴이 지갑에 그대로 남아 있었다:
//
//   getPositionsGateFutures(...).catch(() => [])        ← 실패 → 포지션 없음
//   const positions = res?.success ? res.positions : [] ← 실패 → 포지션 없음
//
// 둘 다 미실현손익을 **0**으로 만든다. 포지션이 열려 있는데 손익 0이면
// 사용자는 본전이라고 읽는다. 한 줄만 새로 써도 그대로 돌아오므로
// 배선 검사에 넣는다.
let zeroFiles = [];
try {
  const fs = await import('node:fs');
  zeroFiles = typeof fs.globSync === 'function'
    ? [...fs.globSync('src/lib/markets/**/*.ts'), ...fs.globSync('src/lib/engine/**/*.ts')]
    : [];
} catch { zeroFiles = []; }
const zeroErrors = [];
{
  for (const f of zeroFiles) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const src = readFileSync(f, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // 주석은 검사하지 않는다 — 고친 이력을 설명하려면 옛 코드를
      // 인용해야 하는데, 그것까지 잡으면 설명을 못 쓰게 된다.
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      // 의도적으로 허용한 곳은 같은 줄에 사유를 적는다.
      if (line.includes('조회 실패 아님')) return;
      if (/\.catch\s*\(\s*\(\s*\)\s*=>\s*\[\s*\]\s*\)/.test(line)) {
        zeroErrors.push(`${f.replaceAll('\\', '/')}:${i + 1}\n     `
          + '조회 실패를 빈 배열로 바꿉니다 — 실패는 null이지 "없음"이 아닙니다'
          + ' (허용하려면 같은 줄에 "조회 실패 아님" 사유를 적으세요)');
      }
    });
  }
}
if (zeroErrors.length > 0) {
  console.error('❌ 조회 실패를 0으로 만드는 길이 있습니다:');
  for (const e of zeroErrors) console.error(`   · ${e}`);
  console.error('');
  console.error('   포지션을 못 읽은 것과 포지션이 없는 것은 다릅니다 —');
  console.error('   전자를 후자로 적으면 미실현손익이 0으로 기록됩니다.');
  process.exit(1);
}

// ── 스모크 주문이 **확인된 테스트넷 연결**에만 나가는가 ──
//
// 저장소 전체 규칙은 `is_testnet !== false`를 테스트넷으로 읽는다.
// 읽기·조회에는 맞다 — 빈 값을 실전으로 읽으면 모르는 연결에 진짜
// 주문이 나간다.
//
// 그런데 스모크는 **없던 주문을 새로 만든다.** 테스트넷 호스트로
// 나간다는 것과 그 계좌가 테스트넷임이 확인됐다는 것은 다른 사실이다.
// 그래서 이 경로만 `=== true`를 요구하고, **그 좁힘이 사라지지 않게**
// 여기서 센다.
//
// 그리고 정리되지 않은 노출 위에 새 회차를 열지 않는지도 함께 본다 —
// `preflightVerdict`는 요청한 종목만 보므로 그것만으로는 부족하다.
{
  const F = 'src/lib/smoke/startAttempt.ts';
  const CANON = 'src/lib/smoke/smokePlan.ts';
  const strip = (t) => t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const bad = [];

  const rawA = existsSync(F) ? readFileSync(F, 'utf8') : null;
  if (!rawA) bad.push(`${F}이 없습니다`);
  else {
    const a = strip(rawA);

    // ① 테스트넷 판정을 부르고 **그 결과로 되돌아가는가**
    if (!a.includes('smokeTestnetVerdict(')) {
      bad.push(`${F}: \`smokeTestnetVerdict\`를 부르지 않습니다 — `
        + '스모크 주문은 확인된 테스트넷 연결에만 나가야 합니다');
    } else {
      const m = a.match(/(?:const|let|var)\s+(\w+)\s*=\s*smokeTestnetVerdict\(/);
      if (!m) {
        bad.push(`${F}: 테스트넷 판정 결과를 변수에 받지 않습니다`);
      } else if (!new RegExp(`if\\s*\\(\\s*!\\s*${m[1]}\\.ok\\s*\\)\\s*return`).test(a)) {
        bad.push(`${F}: 테스트넷 판정 결과로 되돌아가지 않습니다 — `
          + '부르기만 하고 버리면 아무것도 막지 않습니다');
      }
      // 날것을 봐야 한다. 정규화된 `creds.testnet`을 넘기면 다시
      // `is_testnet !== false`가 되어 좁힌 의미가 사라진다.
      // `[^)]*`로는 못 본다 — 실제 인자가 `(creds as any).isTestnetRaw`라
      // 중간에 닫는 괄호가 있다. 호출 뒤 한 줄 안에서 찾는다.
      const callAt = a.indexOf('smokeTestnetVerdict(');
      const callArgs = a.slice(callAt, a.indexOf('\n', callAt) + 1 || callAt + 200);
      if (!callArgs.includes('isTestnetRaw')) {
        bad.push(`${F}: 테스트넷 판정에 \`isTestnetRaw\`(날것)를 넘기지 않습니다 — `
          + '정규화된 값을 넘기면 빈 값이 다시 통과합니다');
      }
    }

    // ② 정리되지 않은 노출을 보고 **막는가**
    if (!a.includes('unresolvedExposureBlock(')) {
      bad.push(`${F}: \`unresolvedExposureBlock\`을 부르지 않습니다 — `
        + '보호 없는 노출 위에 새 회차가 열립니다');
    } else {
      if (!/if\s*\(\s*\w+\.blocked\s*\)\s*return/.test(a)) {
        bad.push(`${F}: 노출 차단 결과로 되돌아가지 않습니다`);
      }
      // 조회가 실패했을 때 **막는 쪽**으로 가는가.
      if (!/unresolvedExposureBlock\(\s*\{\s*rows:\s*null/.test(a)) {
        bad.push(`${F}: 장부 조회 실패를 막는 쪽으로 처리하지 않습니다 — `
          + '못 읽은 것은 "없음"이 아닙니다');
      }
      // 주문을 만드는 것보다 **먼저** 와야 한다.
      const bIdx = a.indexOf('unresolvedExposureBlock(');
      for (const sink of ['executeOrder(', "from('smoke_tests').insert("]) {
        const sIdx = a.indexOf(sink);
        if (sIdx >= 0 && sIdx < bIdx) {
          bad.push(`${F}: \`${sink}\`이 노출 차단보다 먼저 옵니다`);
        }
      }
    }
  }

  const rawC = existsSync(CANON) ? readFileSync(CANON, 'utf8') : null;
  if (!rawC) bad.push(`${CANON}이 없습니다`);
  else {
    const c = strip(rawC);
    // `=== true`를 실제로 비교하는가. `!== false`로 되돌리면 좁힘이 없어진다.
    if (!/isTestnetRaw\s*===\s*true/.test(c)) {
      bad.push(`${CANON}: \`isTestnetRaw === true\`를 비교하지 않습니다 — `
        + '`!== false`로 되돌리면 확인되지 않은 연결에도 주문이 나갑니다');
    }
    // 차단 해제는 PASS에만. 다른 상태를 통과로 읽으면 거래소 확인 없이 풀린다.
    if (!/pz\s*===\s*'PASS'/.test(c)) {
      bad.push(`${CANON}: 노출 차단 해제를 \`POSITION_ZERO === 'PASS'\`에 걸지 않습니다 — `
        + '그 값은 settleAttempt가 거래소 재조회로만 적습니다');
    }
  }

  if (bad.length) {
    console.error('❌ 스모크 주문 관문에 구멍이 있습니다:');
    for (const b of bad) console.error(`   · ${b}`);
    process.exit(1);
  }
}

// ── 진입이 확정되지 않은 회차가 노출을 방치하지 않는가 ──
//
// 무엇이 있었나
// ─────────────
// `enteredVerdict`가 `ENTERED_UNPROTECTED`를 주는 경우가 있다 —
// **체결은 됐는데 보호주문을 확인하지 못한 것이다.** 실행기는
// `undoEntry()`로 되돌리려 하지만 그 되돌리기도 실패할 수 있다.
//
// 그때 `startAttempt`가 줄에 `closed_at`을 적고 끝내면, `/settle`은
// `state = 'HOLDING'`인 줄만 고르므로 **아무도 그 노출을 다시 보지
// 않는다.** 거래소에는 보호 없는 포지션이 남는다.
//
// 그래서 세 가지를 못 박는다:
//   ① 줄을 끝내기 전에 포지션을 **다시 읽는가**
//   ② 그 결과로 `POSITION_ZERO`를 적는가 (못 읽으면 PASS가 아니다)
//   ③ 넘겨야 할 때 **줄을 닫지 않는가**
{
  const F = 'src/lib/smoke/startAttempt.ts';
  const raw = existsSync(F) ? readFileSync(F, 'utf8') : null;
  const bad = [];
  if (!raw) bad.push(`${F}이 없습니다`);
  else {
    // 주석을 걷어낸다 — 이 파일은 설명이 길고, 설명이 계약을 대신
    // 증명하면 검사가 아무것도 막지 않는다.
    const src = raw.split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    if (!src.includes('unprotectedExposureVerdict(')) {
      bad.push(`${F}: \`unprotectedExposureVerdict\`를 부르지 않습니다 — `
        + '진입 미확정 회차가 노출을 방치하지 않는지 판정하는 정본입니다');
    }
    // 판정 **뒤에** 포지션을 다시 읽는 호출이 있어야 한다. 실행기 직후의
    // `posAfter`만 믿으면 되돌리기 실패를 못 본다.
    const vIdx = src.indexOf('unprotectedExposureVerdict(');
    const notEnteredIdx = src.indexOf('if (!ev.entered)');
    if (notEnteredIdx >= 0 && vIdx >= 0) {
      const branch = src.slice(notEnteredIdx, vIdx);
      if (!/readOpenPosition\(/.test(branch)) {
        bad.push(`${F}: 진입 미확정 분기에서 포지션을 다시 읽지 않습니다 — `
          + '되돌리기가 실패했는지는 재조회만 말해 줍니다');
      }
    }
    // `POSITION_ZERO`를 판정 결과로 적는가. 상수를 그대로 적으면
    // 못 읽은 것도 PASS가 된다.
    if (!/steps\.POSITION_ZERO\s*=\s*step\(\s*ex\.positionZero/.test(src)) {
      bad.push(`${F}: POSITION_ZERO를 판정 결과(\`ex.positionZero\`)로 적지 않습니다 — `
        + '상수로 적으면 못 읽은 것도 통과가 됩니다');
    }
    // 넘겨야 할 때 줄을 닫지 않는가.
    if (!/ex\.handoff\s*===\s*'SETTLE'/.test(src)) {
      bad.push(`${F}: 정산으로 넘기는 분기가 없습니다 — `
        + '줄을 닫으면 /settle이 HOLDING만 보므로 노출을 다시 보지 않습니다');
    } else {
      // **분기 몸통만 본다.** 고정 길이로 자르면 바로 아래
      // CLOSE_RECORD 분기까지 들어오고, 그쪽 `closed_at`은 정상이다 —
      // 처음 돌렸을 때 그 이유로 잘못 실패했다.
      const hIdx = src.indexOf("ex.handoff === 'SETTLE'");
      const settleBranch = (() => {
        const open = src.indexOf('{', hIdx);
        if (open < 0) return '';
        let depth = 0;
        for (let k = open; k < src.length; k++) {
          if (src[k] === '{') depth += 1;
          else if (src[k] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(open, k + 1);
          }
        }
        return src.slice(open);
      })();
      if (!settleBranch) {
        bad.push(`${F}: 정산 분기의 몸통을 읽지 못했습니다 — 검사기가 고장 난 것입니다`);
      }
      if (/closed_at/.test(settleBranch)) {
        bad.push(`${F}: 정산으로 넘기는 분기가 \`closed_at\`을 적습니다 — `
          + '닫힌 줄은 /settle이 고르지 않습니다');
      }
      if (!/state:\s*'HOLDING'/.test(settleBranch)) {
        bad.push(`${F}: 정산으로 넘기는 분기가 state를 HOLDING으로 두지 않습니다 — `
          + '/settle은 HOLDING인 줄만 고릅니다');
      }
      // **여기서 청산을 직접 보내지 않는다.** 보내는 곳이 둘이면
      // 중복 청산이 된다.
      if (/closeSymbolPosition\(/.test(settleBranch)) {
        bad.push(`${F}: 정산으로 넘기는 분기가 청산을 직접 보냅니다 — `
          + '보내는 곳은 settleAttempt 하나여야 합니다(둘이면 중복 청산)');
      }
    }
  }
  if (bad.length) {
    console.error('❌ 보호 없는 노출이 방치될 길이 있습니다:');
    for (const b of bad) console.error(`   · ${b}`);
    console.error('');
    console.error('   체결은 됐는데 보호주문이 없고, 그 줄이 닫혀 있으면');
    console.error('   아무도 그 포지션을 다시 보지 않습니다.');
    process.exit(1);
  }
}

// ── 기존 보호주문 취소 결과를 **보고** 새것을 거는가 ──
//
// `cancelOpenTPSL`은 기존 TP/SL을 확인하지 못했거나 못 지웠으면
// `success: false`를 돌려준다. 부르는 쪽이 그 값을 안 보고 바로 새
// TP/SL을 POST하면 **같은 포지션에 보호주문이 둘**이 된다 — 옛것이 남은
// 채로 새것이 붙고, 화면에는 `ok: true`가 뜬다.
//
// 이 저장소에서 가장 자주 나는 고장 그 자체다: **만들어 놓고 배선을
// 안 함.** 신호를 만든 쪽만 고치고 부르는 쪽을 안 고치면 그 신호는
// 아무것도 막지 않는다. 그래서 CI에서 센다.
//
// `Cancel All`로 쓸어내는 길은 답이 아니다 — 다른 전략의 보호주문을
// 지운다(CLAUDE.md 절대 규칙).
//
// **목록으로 센다.** `ORDER_ROUTES`와 같은 이유다 — 새로 부르는 곳을
// 만들면 여기 넣어야 하고, 안 넣으면 이 검사가 그 파일을 못 본다.
{
  const CANCEL_FN = 'cancelOpenTPSL(';
  /** 이 신호를 **판정에 써야 하는** 곳 */
  const MUST_HONOR = [
    'src/app/api/binance/futures/tpsl/route.ts',
  ];
  /**
   * 일부러 판정에 쓰지 않는 곳 — **이유가 코드에 적혀 있어야 한다.**
   *
   *   `futuresExec.ts`는 `try/catch`로 삼키며 그 선택을 적어 뒀다:
   *   *"조회 실패 시 건너뛴다 — 남의 주문을 지우는 것보다 중복이 낫다"*.
   *   그 판단을 이 검사가 뒤집지 않는다. 다만 **적어 둔 이유가 사라지면**
   *   예외가 아니라 빠뜨린 것이므로 그때는 빨개진다.
   */
  const DOCUMENTED_SKIP = [
    ['src/lib/exchanges/futuresExec.ts', '남의 주문을 지우는 것보다 중복이 낫다'],
  ];

  /**
   * **Gate 분기 — 계약 단위 일괄 취소가 되돌아오지 않는지 센다.**
   *
   *   예전에는 `futuresCancelProtection`이 Gate에서
   *   `DELETE /price_orders?contract=…`로 그 계약의 조건부 주문을
   *   **전부** 지웠다. 그건 `Cancel All`이고 절대 규칙이 금지한다 —
   *   다른 전략의 보호주문을 지운다.
   *
   *   지금은 **읽고 판단**한다. 그 모양이 유지되는지 센다:
   *     · 일괄 취소를 다시 부르지 않는가
   *     · 기존 주문을 읽는가 (`getPriceOrdersGateFutures`)
   *     · 못 읽음(null)과 '있음'을 각각 거절하는가
   */
  const GATE_FILE = 'src/app/api/binance/futures/tpsl/route.ts';

  const bad = [];
  for (const F of MUST_HONOR) {
    if (!existsSync(F)) { bad.push(`${F}이 없습니다 — 목록이 낡았습니다`); continue; }
    const raw = readFileSync(F, 'utf8');
    // 주석이 계약을 대신 증명하지 못하게 걷어낸다.
    const src = raw.split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (!src.includes(CANCEL_FN)) {
      bad.push(`${F}: \`cancelOpenTPSL\`을 부르지 않습니다 — 목록이 낡았습니다`);
      continue;
    }
    if (!/cancel\w*\s*(\?\.)?\.?\s*success/.test(src)) {
      bad.push(`${F}: \`cancelOpenTPSL\`을 부르고 그 \`success\`를 보지 않습니다 — `
        + '기존 보호주문을 못 지운 채로 새것을 겹쳐 걸 수 있습니다');
    }
  }
  for (const [F, reason] of DOCUMENTED_SKIP) {
    if (!existsSync(F)) { bad.push(`${F}이 없습니다 — 목록이 낡았습니다`); continue; }
    const raw = readFileSync(F, 'utf8');
    if (!raw.includes(CANCEL_FN)) continue;   // 더 안 부르면 예외도 필요 없다
    if (!raw.includes(reason)) {
      bad.push(`${F}: \`cancelOpenTPSL\` 결과를 안 보는데 **적어 둔 이유가 없습니다** `
        + `(찾는 문구: "${reason}") — 예외가 아니라 빠뜨린 것입니다`);
    }
  }
  // ── Gate 분기 ──
  if (!existsSync(GATE_FILE)) {
    bad.push(`${GATE_FILE}이 없습니다 — 목록이 낡았습니다`);
  } else {
    const raw = readFileSync(GATE_FILE, 'utf8');
    const src = raw.split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (/futuresCancelProtection\s*\(/.test(src)) {
      bad.push(`${GATE_FILE}: \`futuresCancelProtection\`을 부릅니다 — Gate에서 그 함수는 `
        + '계약의 조건부 주문을 **전부** 지웁니다(Cancel All). 다른 전략의 보호주문까지 지웁니다');
    }
    if (!src.includes('getPriceOrdersGateFutures(')) {
      bad.push(`${GATE_FILE}: Gate 기존 보호주문을 읽지 않습니다 — `
        + '무엇이 걸려 있는지 모르는 채로 겹쳐 걸 수 있습니다');
    }
    // 못 읽음(null)과 '있음'을 각각 거절하는가.
    if (!/existing\s*==\s*null/.test(src) || !/existing\.length\s*>\s*0/.test(src)) {
      bad.push(`${GATE_FILE}: 기존 보호주문을 읽고도 **거절 분기가 없습니다** — `
        + '못 읽음과 이미 있음을 각각 막아야 합니다');
    }
  }
  if (bad.length) {
    console.error('❌ 보호주문 교체가 취소 결과를 보지 않습니다:');
    for (const b of bad) console.error(`   · ${b}`);
    console.error('');
    console.error('   같은 포지션에 보호주문이 둘이 되고, 화면에는 성공이 뜹니다.');
    process.exit(1);
  }
}

console.log(`✅ 실주문 경로 ${ORDER_ROUTES.length}개 · 안전장치 빠진 것 0개`
  + ' · 조회 실패를 0으로 만드는 길 0개'
  + ' · 진입 미확정 노출 방치 경로 0개'
  + ' · 스모크 주문 관문 구멍 0개'
  + ' · 보호주문 교체가 취소 결과를 무시하는 길 0개 (Binance·Gate 둘 다)'
  + ' · Gate 계약 단위 일괄 취소 0개');

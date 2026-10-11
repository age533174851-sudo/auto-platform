#!/usr/bin/env node
// 대조(reconcile)가 **끝나지 않은 주문을 끝났다고 적지 않는가**를 본다.
//
// 무엇이 고장났었나
// ─────────────────
// 쓰는 쪽이 판정의 `resolved: true`를 "주문이 끝났다"로 읽었다:
//
//   const st = verdict.state === 'FILLED' ? 'FILLED'
//     : verdict.state === 'FAILED' ? 'FAILED'
//     : verdict.state === 'REJECTED' ? 'REJECTED'
//     : 'RECONCILED';                       // ← 나머지 전부
//
// 거래소가 `NEW`를 돌려주면 판정은 `ACKED`(아직 열려 있음)인데도 장부에는
// 종료(`RECONCILED`)가 적혔다. `RECONCILED`는 `RECONCILE_TARGET_STATUSES`에
// 없어 **다시 조회되지 않고**, 계좌 용량 관문의 두 목록에도 없어 **진입
// 잠금을 풀어 준다.** 부분 체결(`PARTIALLY_FILLED`)도 같은 식으로 종료로
// 적혔고, 그 잔량의 체결은 장부에 영원히 들어오지 않았다.
//
// 같은 결함이 바이낸스 경로와 Gate 경로 **둘 다**에 있었다. 그래서 변환을
// `reconcileLedgerStatus` 하나로 모았고, 이 검사기는 그 정본이 계속
// 쓰이는지와 그 결과를 받는 쪽들이 배선된 채로 있는지를 본다.
import { readFileSync, existsSync } from 'node:fs';

const errors = [];
const err = (m) => errors.push(m);

/** 주석은 코드가 아니다. 검사기가 자기 설명문을 규칙으로 읽으면 오탐이 난다 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

const read = (p) => {
  if (!existsSync(p)) { err(`${p}를 찾을 수 없습니다 — 경로가 바뀌었는지 확인해야 합니다`); return null; }
  return stripComments(readFileSync(p, 'utf8'));
};

const CANON = 'src/lib/engine/reconcileLedgerStatus.ts';
const HOLD = 'src/lib/engine/holdingEvidence.ts';
const EXEC = 'src/lib/engine/orderExecutor.ts';
const MON = 'src/app/api/autotrade/exit-monitor/route.ts';
const OPS = 'src/app/api/orders/reconcile/route.ts';

// ── ① 정본이 ACKED·PARTIAL을 비종료로 유지하는가 ──
const canon = read(CANON);
if (canon) {
  for (const st of ['ACKED', 'PARTIAL']) {
    const m = canon.match(new RegExp(`case '${st}':\\s*return \\{([^}]*)\\}`));
    if (!m) err(`${CANON}: '${st}' 분류가 없습니다 — 거래소에 열려 있는 주문의 판정이 사라졌습니다`);
    else if (!/terminal:\s*false/.test(m[1])) {
      err(`${CANON}: '${st}'가 종료(terminal:true)로 분류됐습니다`
        + ' — 거래소에 열려 있는 주문을 끝났다고 적으면 다시 조회되지 않습니다');
    } else if (/status:\s*'RECONCILED'/.test(m[1]) || /status:\s*'FILLED'/.test(m[1])) {
      err(`${CANON}: '${st}'에 종료 장부 상태가 적혀 있습니다`);
    }
  }
  // 끝난 것은 끝났다고 적어야 한다. 반대 방향 고장도 막는다.
  for (const [st, want] of [['FILLED', 'FILLED'], ['FAILED', 'FAILED'],
                            ['REJECTED', 'REJECTED'], ['CANCELED', 'RECONCILED'],
                            ['RECONCILED', 'RECONCILED']]) {
    const m = canon.match(new RegExp(`case '${st}':\\s*return \\{([^}]*)\\}`));
    if (!m) err(`${CANON}: '${st}' 분류가 없습니다`);
    else if (!/terminal:\s*true/.test(m[1]) || !new RegExp(`status:\\s*'${want}'`).test(m[1])) {
      err(`${CANON}: '${st}'가 ${want}·종료로 분류되지 않습니다`);
    }
  }
  // default가 확정을 적으면 모르는 상태가 조용히 끝난 것으로 적힌다.
  const dm = canon.match(/default:\s*return \{([^}]*)\}/);
  if (!dm) err(`${CANON}: default 분기가 없습니다 — 모르는 상태가 분류되지 않습니다`);
  else if (!/terminal:\s*false/.test(dm[1])) {
    err(`${CANON}: default가 종료로 분류됩니다 — 모르는 상태를 끝났다고 적게 됩니다`);
  }
}

// ── ② 실행기가 그 정본만 쓰는가 ──
const exe = read(EXEC);
if (exe) {
  if (!/import \{[\s\S]{0,200}?ledgerStatusOf,[\s\S]{0,200}?\} from '\.\/reconcileLedgerStatus'/.test(exe)
      && !/import \{ ledgerStatusOf \} from '\.\/reconcileLedgerStatus'/.test(exe)) {
    err(`${EXEC}: ledgerStatusOf를 가져오지 않습니다 — 정본이 쓰이지 않습니다`);
  }
  const calls = (exe.match(/ledgerStatusOf\(/g) || []).length;
  if (calls < 2) {
    err(`${EXEC}: ledgerStatusOf 호출이 ${calls}곳입니다 — 바이낸스·Gate 두 경로 모두 써야 합니다`
      + ' (한쪽만 고치면 다른 쪽이 또 열린 주문을 종료로 적습니다)');
  }
  // 호출만 하고 결과를 안 쓰면 배선이 아니다. terminal로 분기해야 한다.
  const gates = (exe.match(/\.terminal\b/g) || []).length;
  if (gates < 2) {
    err(`${EXEC}: 판정 결과의 terminal로 분기하는 자리가 ${gates}곳입니다`
      + ' — 호출해 놓고 결과를 쓰지 않으면 고친 것이 아닙니다');
  }
  // 되돌림 감시: 예전 식이 다시 들어오면 막는다.
  if (/verdict\.state === 'REJECTED' \? 'REJECTED'\s*:\s*'RECONCILED'/.test(exe)
      || /verdict\.state === 'FAILED' \? 'FAILED' : 'RECONCILED'/.test(exe)) {
    err(`${EXEC}: "그 외는 전부 RECONCILED" 식이 다시 들어왔습니다`
      + ' — 열려 있는 주문이 종료로 적힙니다');
  }
  // 비종료로 적는 자리에 reconciled_at을 찍으면 "끝났다"를 적는 것과 같다.
  const openWrites = exe.split(/\} else if \((?:g)?[dD]ecision\) \{/).slice(1);
  if (openWrites.length < 2) {
    err(`${EXEC}: 비종료(거래소에 열려 있음) 분기가 ${openWrites.length}곳입니다 — 두 경로 모두 필요합니다`);
  }
  for (const [i, blk] of openWrites.entries()) {
    const body = blk.slice(0, blk.indexOf('out.stillOpen') + 20);
    if (/reconciled_at/.test(body)) {
      err(`${EXEC}: 비종료 분기 ${i + 1}에 reconciled_at을 찍습니다 — 끝나지 않은 주문에 종료 시각을 적습니다`);
    }
    if (!/out\.stillOpen\+\+/.test(blk.slice(0, 1200))) {
      err(`${EXEC}: 비종료 분기 ${i + 1}이 stillOpen을 세지 않습니다 — 보고에서 사라집니다`);
    }
  }
  if (!/stillOpen: number/.test(exe)) err(`${EXEC}: ReconcileResult에 stillOpen이 없습니다`);
  if (!/stillOpen: 0/.test(exe)) err(`${EXEC}: ReconcileResult 초기화에 stillOpen이 없습니다`);
}

// ── ②-2 멱등 중복 감지 세 경로가 같은 정본을 쓰는가 ──
//
// `executeOrder`가 보내기 전에 같은 키의 주문을 거래소에서 찾는 자리다.
// 찾으면 무조건 `status: 'RECONCILED'`를 적었다 — 열려 있는 주문도,
// 부분 체결 중인 주문도 종료로 적혔고 아무도 다시 조회하지 않았다.
if (exe) {
  if (/status: 'RECONCILED', exchange_order_id/.test(exe)) {
    err(`${EXEC}: 멱등 중복 감지가 찾은 주문을 무조건 RECONCILED로 적습니다`
      + ' — 거래소에 열려 있는 주문이 장부에서 끝납니다');
  }
  if (/ok: true, status: 'RECONCILED'/.test(exe)) {
    err(`${EXEC}: 멱등 중복 결과를 무조건 ok:true로 돌려줍니다`
      + ' — 취소·거절로 끝난 주문을 호출자가 진입으로 기록합니다');
  }
  for (const [fn, who] of [['ledgerStatusOfBinance', '바이낸스'], ['ledgerStatusOfGate', 'Gate']]) {
    if (!new RegExp(`${fn}\\(`).test(exe)) {
      err(`${EXEC}: ${who} 멱등 경로가 ${fn}을 쓰지 않습니다 — 정본이 배선되지 않았습니다`);
    }
  }
  // 종료 시각은 끝난 것에만 찍는다. 두 경로 모두.
  const condReconciled = (exe.match(/\.terminal \? \{ reconciled_at/g) || []).length;
  if (condReconciled < 2) {
    err(`${EXEC}: 멱등 경로에서 reconciled_at을 조건 없이 찍는 자리가 있습니다`
      + ` (조건부 ${condReconciled}곳, 두 경로 필요)`);
  }
  // Gate 어휘를 바이낸스 표에 넣으면 전부 해석 불가가 된다.
  if (/status: 'NEW', orderId: hit\.order/.test(exe)) {
    err(`${EXEC}: Gate 조회 결과에 'NEW'를 지어내 넘깁니다 — Gate 어휘로 판정해야 합니다`);
  }
  // 대조 쓰기도 같은 증거 규칙을 써야 한다 (FILLED + 수량 null 금지).
  if (!/withFillEvidence\(ledgerStatusOf\(verdict\.state\)/.test(exe)) {
    err(`${EXEC}: 대조 쓰기가 체결 증거 규칙을 쓰지 않습니다`
      + ' — status FILLED와 filled_qty null이 함께 적힐 수 있습니다');
  }
}

// ── ②-3 증거 규칙 정본이 살아 있는가 ──
if (canon) {
  const wf = canon.match(/export function withFillEvidence\([\s\S]*?\n\}/);
  if (!wf) err(`${CANON}: withFillEvidence가 없습니다`);
  else {
    if (!/status !== 'FILLED'/.test(wf[0])) {
      err(`${CANON}: withFillEvidence가 FILLED만 검사하지 않습니다`);
    }
    if (!/filledQty != null && filledQty > 0/.test(wf[0])) {
      err(`${CANON}: withFillEvidence가 체결 수량 증거를 보지 않습니다`);
    }
    if (!/status: 'ACKED', terminal: false, needsAttention: true/.test(wf[0])) {
      err(`${CANON}: 증거 없는 FILLED를 비종료 ACKED로 내리지 않습니다`);
    }
  }
  const gate = canon.match(/export function ledgerStatusOfGate\([\s\S]*?\n\}/);
  if (!gate) err(`${CANON}: ledgerStatusOfGate가 없습니다 — Gate 어휘 변환이 사라졌습니다`);
  else {
    if (!/st === 'open'/.test(gate[0])) err(`${CANON}: Gate의 open(열려 있음)을 분류하지 않습니다`);
    if (!/withFillEvidence\(\{ status: 'FILLED', terminal: true \}/.test(gate[0])) {
      err(`${CANON}: Gate filled에 체결 증거 규칙을 적용하지 않습니다`);
    }
    if (/'FAILED'/.test(gate[0])) {
      err(`${CANON}: Gate 종료를 FAILED로 적습니다 — 재시도가 열려 중복 체결의 문이 됩니다`);
    }
  }
  const bin = canon.match(/export function ledgerStatusOfBinance\([\s\S]*?\n\}/);
  if (!bin) err(`${CANON}: ledgerStatusOfBinance가 없습니다`);
  else if (/status: 'UNKNOWN'/.test(bin[0])) {
    err(`${CANON}: 찾은 주문을 UNKNOWN으로 적습니다`
      + ' — 찾았다는 사실은 "닿았는지도 모름"이 아닙니다');
  }
}

// ── ③ 보유 판정 정본이 ACKED를 포함하는가 ──
const hold = read(HOLD);
if (hold) {
  const m = hold.match(/HOLDING_EVIDENCE_STATUSES = \[([^\]]*)\]/);
  if (!m) err(`${HOLD}: HOLDING_EVIDENCE_STATUSES를 찾을 수 없습니다`);
  else {
    for (const need of ['FILLED', 'RECONCILED', 'ACKED']) {
      if (!m[1].includes(`'${need}'`)) {
        err(`${HOLD}: 보유 목록에 ${need}가 없습니다`
          + (need === 'ACKED' ? ' — 부분 체결된 포지션이 보유 판정에서 사라집니다' : ''));
      }
    }
    for (const no of ['INTENT', 'SENT', 'UNKNOWN']) {
      if (m[1].includes(`'${no}'`)) {
        err(`${HOLD}: 보유 목록에 ${no}가 들어왔습니다 — 닿았는지도 모르는 주문이 진입을 영구히 막습니다`);
      }
    }
  }
}

// ── ④ 보유 판정 네 곳이 정본을 쓰는가 ──
// 완주한 거래를 세는 mode는 일부러 제외한다 (열린 주문은 완주가 아니다).
const HOLDERS = [
  'src/app/api/strategies/ledger/route.ts',
  'src/app/api/strategies/spot/route.ts',
  'src/app/api/autotrade/my-original-v1/route.ts',
  'src/app/api/autotrade/daily-ladder/route.ts',
];
for (const p of HOLDERS) {
  const src = read(p);
  if (!src) continue;
  if (/\.in\('status', \['FILLED', 'RECONCILED'\]\)/.test(src)) {
    err(`${p}: 보유 목록을 직접 적었습니다 — ACKED가 빠져 열린 포지션이 사라집니다`
      + ' (HOLDING_EVIDENCE_STATUSES를 쓰십시오)');
  }
  if (!/HOLDING_EVIDENCE_STATUSES/.test(src)) {
    err(`${p}: HOLDING_EVIDENCE_STATUSES를 쓰지 않습니다 — 보유 판정 정본이 배선되지 않았습니다`);
  }
}

// ── ④-2 승급 표본은 증명된 체결만 세는가 ──
const MODE = 'src/app/api/autotrade/mode/route.ts';
const mode = read(MODE);
if (mode) {
  if (/\.in\('status', \['FILLED', 'RECONCILED'\]\)/.test(mode)) {
    err(`${MODE}: 승급 표본에 RECONCILED를 셉니다`
      + ' — 최종 체결 결과를 모르는 주문이 실전 승급의 근거가 됩니다');
  }
  if (!/PROVEN_FILL_STATUSES/.test(mode) || !/isProvenFill/.test(mode)) {
    err(`${MODE}: 증명된 체결 정본(isProvenFill)을 쓰지 않습니다`);
  }
  // 상태만 보고 세면 status FILLED + filled_qty null이 표본이 된다.
  if (!/\.filter\(isProvenFill\)/.test(mode)) {
    err(`${MODE}: 줄 단위로 체결 증거를 확인하지 않습니다 — 상태만 보고 셉니다`);
  }
  if (!/filled_qty/.test(mode)) {
    err(`${MODE}: filled_qty를 읽지 않습니다 — 수량 증거 없이 셉니다`);
  }
  if (/HOLDING_EVIDENCE_STATUSES/.test(mode)) {
    err(`${MODE}: 보유 목록을 승급 표본에 씁니다 — 열려 있는 주문은 완주가 아닙니다`);
  }
}
if (hold) {
  const m = hold.match(/PROVEN_FILL_STATUSES = \[([^\]]*)\]/);
  if (!m) err(`${HOLD}: PROVEN_FILL_STATUSES를 찾을 수 없습니다`);
  else {
    if (!m[1].includes("'FILLED'")) err(`${HOLD}: 증명된 체결 목록에 FILLED가 없습니다`);
    for (const no of ['RECONCILED', 'ACKED', 'UNKNOWN', 'SENT', 'INTENT']) {
      if (m[1].includes(`'${no}'`)) {
        err(`${HOLD}: 증명된 체결 목록에 ${no}가 들어왔습니다 — 체결이 증명되지 않은 상태입니다`);
      }
    }
  }
  const fn = hold.match(/export function isProvenFill\([\s\S]*?\n\}/);
  if (!fn) err(`${HOLD}: isProvenFill이 없습니다`);
  else if (!/qty > 0/.test(fn[0])) {
    err(`${HOLD}: isProvenFill이 체결 수량을 보지 않습니다 — 상태만 보면 수량 없는 체결이 성과가 됩니다`);
  }
}

// ── ⑤ 대조 대상 목록을 직접 적은 자리가 없는가 ──
for (const p of [MON, OPS]) {
  const src = read(p);
  if (!src) continue;
  if (/\.in\('status', \['SENT', ?'UNKNOWN'(, ?'INTENT')?\]\)/.test(src)) {
    err(`${p}: 대조 대상 목록을 직접 적었습니다 — ACKED가 빠져 접수만 된 주문이 보이지 않습니다`);
  }
  if (!/RECONCILE_TARGET_STATUSES/.test(src)) {
    err(`${p}: RECONCILE_TARGET_STATUSES를 쓰지 않습니다 — 목록이 정본과 갈립니다`);
  }
}

// ── ⑤-2 전송 결과 분류의 기본 방향이 "모름"인가 ──
//
// 예전에는 전송 계층 문구에 **걸리면** UNKNOWN이고 안 걸리면 거절이었다.
// 즉 처음 보는 오류 문구가 거절로 읽혀 **재시도가 열렸다** — 거래소에
// 이미 나갔는데 다시 보내면 중복 체결이다. 목록을 늘려도 그 방향은
// 남으므로, 거절로 읽으려면 거절한 모양이 보여야 하도록 뒤집었다.
const FX = 'src/lib/exchanges/futuresExec.ts';
const fx = read(FX);
if (fx) {
  const fn = fx.match(/export function unknownResultVerdict\([\s\S]*?\n\}/);
  if (!fn) err(`${FX}: unknownResultVerdict를 찾을 수 없습니다`);
  else {
    const body = fn[0];
    // 되돌림 감시: 한 줄 정규식 하나로 판정하던 예전 모양.
    if (/return \{\s*unknown: hit/.test(body)) {
      err(`${FX}: 전송 결과 분류가 예전 방향으로 돌아왔습니다`
        + ' — 처음 보는 문구가 거절로 읽혀 재시도가 열립니다');
    }
    // 마지막 분기(처음 보는 문구)는 반드시 모름이어야 한다.
    const last = body.lastIndexOf('return {');
    const tail = body.slice(last);
    if (!/unknown: true/.test(tail)) {
      err(`${FX}: 처음 보는 문구의 기본값이 "모름"이 아닙니다`
        + ' — 그 한 줄이 중복 체결의 문입니다');
    }
    if (!/evidence: 'UNRECOGNIZED'/.test(tail)) {
      err(`${FX}: 기본 분기가 UNRECOGNIZED로 표시되지 않습니다`);
    }
    // 재시도를 여는 근거는 둘뿐이어야 한다.
    const opens = (body.match(/unknown: false/g) || []).length;
    const openEv = (body.match(/evidence: '(REJECTION_SHAPE|NOT_SENT)'/g) || []).length;
    if (opens !== openEv) {
      err(`${FX}: 재시도를 여는 분기(${opens}곳)와 그 근거 표시(${openEv}곳)가 다릅니다`);
    }
  }
  for (const [name, why] of [
    ['NOT_SENT', '전송 전 거부를 가리지 못하면 나간 적 없는 주문이 미확정으로 쌓입니다'],
    ['TRANSPORT', '전송 계층 오류 판정이 사라졌습니다'],
    ['AMBIGUOUS_BINANCE_CODES', '거래소가 "결과 모름"이라고 답한 코드를 거절로 읽습니다'],
    ['AMBIGUOUS_HTTP', '5xx·레이트리밋을 거절로 읽습니다'],
  ]) {
    if (!new RegExp(`const ${name}`).test(fx)) err(`${FX}: ${name}가 없습니다 — ${why}`);
  }
  const codes = fx.match(/AMBIGUOUS_BINANCE_CODES = new Set\(\[([^\]]*)\]/);
  if (codes) {
    for (const need of ['-1001', '-1006', '-1007']) {
      if (!codes[1].includes(need)) {
        err(`${FX}: 바이낸스 ${need}(결과 모름)이 모호 코드 목록에 없습니다`);
      }
    }
  }
  const http = fx.match(/AMBIGUOUS_HTTP = new Set\(\[([^\]]*)\]/);
  if (http) {
    for (const need of ['408', '429']) {
      if (!http[1].includes(need)) err(`${FX}: HTTP ${need}이 모호 상태 목록에 없습니다`);
    }
  }
  if (!/status >= 500/.test(fx)) {
    err(`${FX}: 5xx를 모호로 다루지 않습니다 — 게이트웨이는 접수 뒤에도 죽습니다`);
  }
}

// ── ⑤-3 다른 거래소 경로도 증거 없이 FILLED를 적지 않는가 ──
//
// COIN-M·현물(바이낸스/Gate)은 `success`면 **무조건** `status:'FILLED'`를
// 적었다. 지정가 대기 주문도 체결로 장부에 남았고, 미체결 주문의
// `avgPrice`가 '0'이라 **지정가가 체결가로** 적혔다. Exact100X 경로가
// 아니라고 장부가 거짓이어도 되는 것은 아니다.
const VENUE_WRITERS = [
  ['src/app/api/binance/coinm/order/route.ts', 'COIN-M'],
  ['src/lib/exchanges/spotOrderExecutor.ts', '현물'],
];
for (const [p, who] of VENUE_WRITERS) {
  const src = read(p);
  if (!src) continue;
  if (/status: 'FILLED',\s*\n/.test(src)) {
    err(`${p}: ${who} 경로가 장부에 FILLED를 무조건 적습니다`
      + ' — 체결 증거가 있을 때만 적어야 합니다');
  }
  if (!/ledgerStatusOf(Binance|GateSpot)/.test(src)) {
    err(`${p}: ${who} 경로가 장부 상태 정본을 쓰지 않습니다`);
  }
}
{
  const p = 'src/app/api/binance/coinm/order/route.ts';
  const src = read(p);
  if (src) {
    // 같은 판정이 두 곳에 있으면 언젠가 갈린다. 실제로 갈렸다.
    if (/\/timeout\|ETIMEDOUT/.test(src)) {
      err(`${p}: UNKNOWN 판정 정규식을 복제했습니다 — unknownResultVerdict를 쓰십시오`);
    }
    if (!/unknownResultVerdict/.test(src)) {
      err(`${p}: unknownResultVerdict를 쓰지 않습니다 — 판정이 갈립니다`);
    }
  }
}
{
  const p = 'src/lib/exchanges/binanceCoinFutures.ts';
  const src = read(p);
  if (src) {
    if (/parseFloat\((?:d|existing)\.avgPrice \|\| (?:d|existing)\.price/.test(src)) {
      err(`${p}: 미체결 주문의 지정가를 체결가로 적습니다`
        + " (`avgPrice || price || '0'`) — 0보다 나쁩니다, 그럴듯해 보입니다");
    }
    if (!/function coinMFillOf/.test(src)) {
      err(`${p}: 체결 사실만 읽는 정본(coinMFillOf)이 없습니다`);
    }
  }
}
{
  const p = 'src/lib/exchanges/binance.ts';
  const src = read(p);
  if (src) {
    if (/executedQty \|\| (?:d\.)?origQty/.test(src)) {
      err(`${p}: 요청 수량을 체결 수량으로 적습니다 (\`executedQty || origQty\`)`);
    }
    if (/fills\?\.\[0\]\?\.price \|\| d\.price/.test(src)) {
      err(`${p}: 지정가를 체결가로 적습니다 (\`fills[0].price || d.price\`)`);
    }
    if (!/export function spotFillOf/.test(src)) {
      err(`${p}: 현물 체결 사실 정본(spotFillOf)이 없습니다`);
    } else if (!/num \+= q \* px/.test(src)) {
      err(`${p}: 현물 체결가를 가중평균으로 계산하지 않습니다`
        + ' — 첫 조각 가격은 쪼개 체결된 주문의 단가가 아닙니다');
    }
    if (/message: opts\.testnet \? '주문 체결/.test(src)) {
      err(`${p}: 접수를 '주문 체결'이라고 적습니다 — 지정가 대기 주문도 그 문장을 받습니다`);
    }
  }
}

// ── ⑥ stillOpen이 합산·화면까지 가는가 ──
const mon = read(MON);
if (mon) {
  if (!/out\.stillOpen \+= r\.stillOpen/.test(mon)) {
    err(`${MON}: stillOpen을 합산하지 않습니다 — 세어 놓고 버립니다`);
  }
  if (!/stillOpen: 0/.test(mon)) err(`${MON}: 합산 초기값에 stillOpen이 없습니다`);
}
for (const p of ['src/components/terminal/OrderPane.tsx', 'src/components/AutotradeControl.tsx']) {
  const src = read(p);
  if (!src) continue;
  if (!/stillOpen/.test(src)) {
    err(`${p}: stillOpen을 보여주지 않습니다 — 거래소에 열려 있는 주문이 화면에서 사라집니다`);
  }
  if (!/거래소에 아직 열려 있음/.test(src)) {
    err(`${p}: '거래소에 아직 열려 있음' 문장이 없습니다 — '아직 모름'과 섞이면 뜻이 달라집니다`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(`❌ ${e}`);
  process.exit(1);
}
console.log('✅ 대조 진실성 — 열린 주문을 종료로 적지 않고, 보유·대조·승급 목록이 정본 하나이며,'
  + ' 전송 결과 분류의 기본값이 "모름"입니다');

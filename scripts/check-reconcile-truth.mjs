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
  if (!/import \{ ledgerStatusOf \} from '\.\/reconcileLedgerStatus'/.test(exe)) {
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
console.log('✅ 대조 진실성 — 열린 주문을 종료로 적지 않고, 보유·대조 목록이 정본 하나입니다');

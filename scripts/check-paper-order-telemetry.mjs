#!/usr/bin/env node
// scripts/check-paper-order-telemetry.mjs
//
// **종료 지점 하나가 빠지면 그 자리는 영영 안 보인다.**
//
// 모의 주문이 어디서 막히는지 세기 시작했다. 그런데 라우트에 return이 열 곳
// 있고 그중 하나만 안 세면, **하필 그 하나가 원인일 때** 표에는 아무것도
// 남지 않는다. 그리고 우리는 "기록이 없으니 그 경로는 안 탄 것"이라고 읽는다.
//
// 그래서 사람 눈 대신 여기서 막는다:
//
//   1. `/api/paper/order`의 모든 `NextResponse.json(` 은 `counted(`로 감싼다
//   2. 기록에 **주문 내용을 넣는 인자가 없다** — counted는 코드와 응답만 받는다
//   3. 실패 경로는 기다리고(await) 성공 경로는 기다리지 않는다
//   4. taxonomy의 코드는 전부 판정 모듈에 실재한다 (오타가 조용히 통과하지 않게)
import { readFileSync } from 'node:fs';

const ROUTE = 'src/app/api/paper/order/route.ts';
const MODULE = 'src/lib/engine/paperOrderTelemetry.ts';
let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };

const route = readFileSync(ROUTE, 'utf8');
const mod = readFileSync(MODULE, 'utf8');

// ── 1. 모든 종료 지점이 세어지는가 ──
//
// 주석과 헬퍼 정의(`counted` 안의 것)는 빼고 본다.
const body = route
  .split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
// 응답을 만드는 자리를 전부 찾고, **그 return 문 안에** counted(가 있는지 본다.
// counted(sb, 'CODE', NextResponse.json(...)) 이므로 둘 사이에 인자가 있다.
const returns = [];
for (const m of body.matchAll(/NextResponse\.json\(/g)) {
  const head = body.slice(Math.max(0, m.index - 160), m.index);
  const stmt = head.slice(head.lastIndexOf('return '));   // 같은 return 문만 본다
  returns.push({ index: m.index, counted: /counted\(/.test(stmt) });
}
const uncounted = returns.filter(r => !r.counted);
if (returns.length === 0) err(`${ROUTE}에서 응답을 만드는 자리를 못 찾았습니다 — 검사가 대상을 잃었습니다`);
if (uncounted.length > 0) {
  err(`${ROUTE}에 세지 않는 종료 지점이 ${uncounted.length}곳 있습니다`);
  console.error('   → return await counted(sb, CODE, NextResponse.json(...)) 로 감싸세요.');
}

// ── 2. 기록에 주문 내용을 넘기지 않는가 ──
//
// counted는 (sb, code, response) 셋만 받는다. 심볼·수량·가격·사용자 id가
// 인자로 들어가면 그때부터 이 표는 주문 장부가 된다.
for (const m of body.matchAll(/counted\(([\s\S]{0,120}?)NextResponse\.json/g)) {
  const args = m[1];
  for (const k of ['symbol', 'quantity', 'uid', 'userId', 'price', 'notional', 'margin', 'signalId']) {
    if (new RegExp(`\\b${k}\\b`).test(args)) {
      err(`counted()에 주문 내용을 넘기고 있습니다: ${k}`);
    }
  }
}

// ── 3. 실패는 기다리고 성공은 안 기다리는가 ──
if (!/if \(code === 'OPENED'\) recordAudit\(/.test(route)) {
  err('성공 경로가 기록을 기다리지 않는다는 계약이 보이지 않습니다');
}
if (!/else await recordAuditAsync\(/.test(route)) {
  err('실패 경로가 기록을 끝까지 남긴다는 계약이 보이지 않습니다');
  console.error('   → 서버리스에서 fire-and-forget은 응답과 함께 잘릴 수 있습니다.');
}

// ── 4. 라우트가 쓰는 코드가 판정 모듈에 실재하는가 ──
//
// 오타는 조용히 통과한다 — 타입이 넓어지는 자리가 아니라도, 문자열로 적는
// 순간 검사는 사라진다. 그래서 여기서 대조한다.
const declared = new Set([...mod.matchAll(/\|\s*'([A-Z_]+)'/g)].map(m => m[1]));
const used = [...body.matchAll(/counted\(\s*[^,]+,\s*'([A-Z_]+)'/g)].map(m => m[1]);
for (const c of used) {
  if (!declared.has(c)) err(`라우트가 쓰는 코드가 판정 모듈에 없습니다: ${c}`);
}
if (used.length === 0) err('라우트에서 실제로 쓰는 코드를 하나도 찾지 못했습니다');

if (bad > 0) {
  console.error(`\n모의 주문 관측 배선 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log(`✅ 모의 주문 관측 배선 — 종료 지점 ${returns.length}곳 전부 계수 · 주문 내용 비기록 · 실패 경로 보존 · 코드 ${new Set(used).size}종 실재`);

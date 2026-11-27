// scripts/test-paper-price-source-comments.mjs
//
// **모의 가격 출처 관문이 "적혀 있는 것"에 속지 않는가.**
//
// `check-paper-price-source.mjs` 는 진입·청산·수정이 **같은 함수로 같은
// 시장의 가격**을 쓰는지를 코드의 모양으로 본다. 라우트는 네트워크를 타서
// 단위 시험이 못 돌리고, 두 출처의 값은 대개 비슷해서 숫자로는 구별되지
// 않는다 — 그래서 이 관문이 유일한 증거다.
//
// 그 관문이 주석을 **줄머리만** 뗐다: `//`·`*`·`/*`로 시작하는 줄만
// 버렸으므로 **꼬리 주석에 적힌 글자는 코드로 셌다.** 기계 탐침으로 실제로
// 돌려 확인한 구멍 7개는 전부 TS 구문이 유효하고, 실제 호출은 사라졌는데
// 관문이 ✅ 를 적었다. 먼저 "그 줄을 지우면 막는가" 를 4/4 로 확인해
// 앵커가 필요하다는 것을 보인 뒤 쟀다.
//
// 아래 시험은 그 7개를 그대로 박아 둔다. 하나라도 다시 통과하면 그 자리에
// 구멍이 다시 열린 것이다. 반대쪽도 같이 잠근다 — 문자열 안의 URL은
// 코드로 남아야 하고(금지 토큰 `ticker/price` 가 URL 조각이다), 줄머리
// 주석에 적힌 금지 호출은 호출로 세지 않아야 한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-paper-price-source.mjs');
const ORDER = 'src/app/api/paper/order/route.ts';
const CLOSE = 'src/app/api/paper/close/route.ts';
const MODIFY = 'src/app/api/paper/modify/route.ts';
const SRC = 'src/lib/engine/paperPriceSource.ts';

/**
 * 검사기를 **격리된 작업 폴더**에서 돌린다.
 *
 * 이 검사기가 읽는 것은 `src/` 아래 다섯 파일뿐이다. 저장소를 통째로
 * 복사하지 않고 `src` 만 실제로 복사하고 나머지는 심링크한다. 검사기는
 * 저장소 경로로 부르므로 `./lib/` 를 제대로 집는다. `node --test` 는 파일을
 * 병렬로 돌리니 실제 저장소 파일은 건드리지 않는다.
 */
function runChecker(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'pps-'));
  for (const e of readdirSync(REPO)) {
    if (e === 'src' || e === '.git') continue;
    symlinkSync(join(REPO, e), join(dir, e));
  }
  cpSync(join(REPO, 'src'), join(dir, 'src'), { recursive: true });
  if (mutate) mutate((rel) => join(dir, rel));
  const r = spawnSync('node', [CHECKER], { cwd: dir, encoding: 'utf8' });
  return { rc: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 한 줄을 다른 글로 바꾼다. 못 찾으면 실패한다 — 못 찾은 것을 통과로 적지 않는다. */
function swap(path, from, to) {
  const s = readFileSync(path, 'utf8');
  assert.ok(s.includes(from), `바꿀 줄을 못 찾았습니다: ${from.trim().slice(0, 60)}`);
  writeFileSync(path, s.replace(from, to));
}

const CALL_ORDER = '  const px = await readPaperMarkPrice(market, symbol);';
const CALL_POS = '  const px = await readPaperMarkPrice(pos.market, String(pos.symbol));';
const SPOT_ROW = "  if (market === 'SPOT') return 'BINANCE_SPOT_TICKER';";
const USDM_ROW = "  if (market === 'USDM') return 'BINANCE_USDM_MARK';";
const STUB = '  const px = { ok: true, price: 0 } as any;';

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  const r = runChecker(null);
  assert.equal(r.rc, 0, r.out);
});

test('대조 — 그 줄을 지우면 막는다 (앵커가 필요하긴 한가)', () => {
  for (const [label, rel, line] of [
    ['진입 호출', ORDER, CALL_ORDER],
    ['청산 호출', CLOSE, CALL_POS],
    ['수정 호출', MODIFY, CALL_POS],
    ['출처 표의 현물 줄', SRC, SPOT_ROW],
  ]) {
    const r = runChecker((p) => swap(p(rel), `${line}\n`, ''));
    assert.notEqual(r.rc, 0, `${label}을 지웠는데 통과했습니다`);
  }
});

test('★ 호출을 꼬리 주석으로 옮기면 통과하지 않는다 (진입·청산·수정)', () => {
  for (const [label, rel, line] of [
    ['진입', ORDER, CALL_ORDER],
    ['청산', CLOSE, CALL_POS],
    ['수정', MODIFY, CALL_POS],
  ]) {
    const r = runChecker((p) => swap(p(rel), line, `${STUB} //${line.replace('  const px =', '')}`));
    assert.notEqual(r.rc, 0, `${label}: 꼬리 주석이 호출로 셌습니다`);
    console.log(`    거부 확인 · ${label} 호출을 꼬리 주석으로`);
  }
});

test('★ 출처 표의 현물 줄을 꼬리 주석으로 옮기면 통과하지 않는다', () => {
  const r = runChecker((p) => swap(p(SRC), `${SPOT_ROW}\n${USDM_ROW}`,
    `${USDM_ROW} //${SPOT_ROW.trim()}`));
  assert.notEqual(r.rc, 0, '꼬리 주석이 출처 표로 셌습니다');
});

test('★ select 에서 market 을 빼고 주석에만 남기면 통과하지 않는다', () => {
  const closeSel = "    .select('id, user_id, symbol, status, market').eq('id', positionId).maybeSingle();";
  const r1 = runChecker((p) => swap(p(CLOSE), closeSel,
    "    .select('id, user_id, symbol, status').eq('id', positionId).maybeSingle(); // .select('status, market')"));
  assert.notEqual(r1.rc, 0, '청산: 주석 안의 select 가 조회로 셌습니다');

  const modSel = "    .select('id, user_id, symbol, side, status, entry_price, market')";
  const r2 = runChecker((p) => swap(p(MODIFY), modSel,
    "    .select('id, user_id, symbol, side, status, entry_price') // .select('entry_price, market')"));
  assert.notEqual(r2.rc, 0, '수정: 주석 안의 select 가 조회로 셌습니다');
});

test('★ 모르는 시장 거부를 끄고 조건만 주석에 남기면 통과하지 않는다', () => {
  const r = runChecker((p) => swap(p(ORDER), "  if (market !== 'SPOT' && market !== 'USDM') {",
    "  if (false) { // market !== 'SPOT' && market !== 'USDM'"));
  assert.notEqual(r.rc, 0, '꺼진 거부가 살아 있는 거부로 셌습니다');
});

test('대조 — 문자열 안의 URL은 코드로 남는다 (금지 토큰을 놓치지 않는다)', () => {
  // `ticker/price` 는 URL 조각이다. 주석 제거기가 `//` 를 보고 자르면
  // §① 이 **실제 직접 호출을 놓친다** — 좁히는 쪽으로 틀리는 모양이다.
  const r = runChecker((p) => {
    const f = p(CLOSE);
    const s = readFileSync(f, 'utf8');
    writeFileSync(f, s.replace(CALL_POS,
      "  const u = 'https://fapi.binance.com/fapi/v1/ticker/price';\n" + CALL_POS));
  });
  assert.notEqual(r.rc, 0, 'URL 안의 금지 토큰을 놓쳤습니다');
  assert.match(r.out, /가격 출처를 직접 부릅니다/);
});

test('대조 — 줄머리 주석에 적힌 금지 호출은 호출이 아니다', () => {
  const r = runChecker((p) => {
    const f = p(CLOSE);
    const s = readFileSync(f, 'utf8');
    writeFileSync(f, s.replace(CALL_POS, '  // getPremiumIndex 는 쓰지 않는다\n' + CALL_POS));
  });
  assert.equal(r.rc, 0, r.out);
});

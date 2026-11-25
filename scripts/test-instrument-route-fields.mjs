// scripts/test-instrument-route-fields.mjs
//
// **관문이 데이터가 쓰는 이름을 보고 있는가.**
//
// `node --test scripts/test-*.mjs` (ci.yml의 글롭)에 자동으로 걸린다.
//
// 왜 이 시험이 따로 있나
// ──────────────────────
// `instrumentRoute.detailTargetOf`는 "코인이 아닌 것은 상세를 열지 않는다"는
// 관문이다. 그 관문은 처음부터 있었다. 그런데 `category`·`type`·`kind`
// 셋만 읽었고, 이 저장소의 자산 레코드는 그 이름들을 쓰지 않는다:
//
//     src/data/assets.ts        t: 'stock'
//     WatchlistPage WL_DB       cat: 'stock'
//     assetSearch · /api/search asset_type: 'stock'
//
// 그래서 미국주식 AMD가 `AMDUSDT` 현물 상세로 열렸다. **관문은 통과한
// 것이 아니라 아무것도 보지 못한 것이다.**
//
// 값 쪽에서 찾는다 — 이름은 또 갈릴 수 있다
// ──────────────────────────────────────────
// 이름 목록을 손으로 적어 두고 대조하면, 새 이름이 생길 때 그 목록이
// 먼저 낡는다(그게 방금 난 고장이다). 그래서 이 시험은 **값**으로
// 찾는다 — `'coin'`·`'stock'`·`'etf'` 같은 어휘는 `AssetType`이 정해
// 놓은 닫힌 집합이다. 자산 레코드처럼 보이는 줄에서 그 어휘를 담고 있는
// 필드 이름을 모아, 관문이 그 이름을 읽는지 본다.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROUTE = 'src/lib/markets/instrumentRoute.ts';

/**
 * 종류를 뜻하는 값들. `AssetType`(src/types/index.ts)과 화면들이 쓰는
 * `cat` 어휘를 합친 것이다. 닫힌 집합이라 값으로 찾을 수 있다.
 */
const KIND_VALUES =
  /^(coin|crypto|stock|krstock|jpstock|cnstock|eustock|etf|index|commodity|forex|stock_[a-z]+|crypto_[a-z]+)$/;

/**
 * 종류가 아닌 것으로 **이유를 적어** 뺀 이름들.
 *
 * 값으로 찾는 방식의 대가다 — 종목 이름 자체가 종류 어휘와 겹친다.
 * 아래 넷은 전부 실제로 걸려서, 그 줄을 열어 보고 넣은 것이다.
 *
 * `symbol`·`sym` — **코인베이스의 티커가 `COIN`이다.**
 *         `{ sym: 'COIN', labelEn: 'Coinbase', cat: 'stock' }`
 *         (src/app/api/search/route.ts). 이것을 종류로 읽으면 미국주식
 *         코인베이스가 "코인"이 되어 `COINUSDT` 상세가 열린다 — 고치려던
 *         고장을 이름만 바꿔 다시 만드는 셈이다. 심볼은 정체이고 종류가
 *         아니다.
 *
 * `exchange` — venue 이름이다. `{ symbol: 'XAUUSD', exchange: 'FOREX',
 *         asset_type: 'commodity' }` (SharedUI). 그 줄의 종류는
 *         `asset_type`이 이미 말하고 있다. 거래되는 곳과 무엇인지는 다르다.
 *
 * `id`  — 정체(identity)이고 종류가 아니다. `src/lib/constants.ts`의
 *         장 시간표에 `{ id: 'coin', name: '코인', sym: 'BINANCE:BTCUSDT' }`
 *         같은 줄이 있는데, 그건 자산이 아니라 시장 묶음의 이름이다.
 *         이것을 종류로 읽으면 시간표 한 줄이 상세를 여는 자산이 된다.
 */
const NOT_A_KIND = new Set(['id', 'symbol', 'sym', 'exchange']);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== '.next') walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 관문이 실제로 읽는 이름 목록을 소스에서 꺼낸다 */
function kindFieldsFromSource() {
  const s = readFileSync(ROUTE, 'utf8');
  const m = /export const KIND_FIELDS = \[([^\]]*)\]/s.exec(s);
  assert.ok(m, 'KIND_FIELDS 선언을 찾지 못했다 — 이름이 바뀌었으면 이 시험도 같이 고친다');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
}

/** 자산 레코드처럼 보이는 줄에서 (필드이름 → 어디) 를 모은다 */
function discoveredFields() {
  const found = new Map();
  for (const f of walk('src')) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      // 자산 레코드는 심볼을 들고 있다. 그게 없으면 자산이 아니다.
      if (!/\bsym\s*:|\bsymbol\s*:/.test(line)) return;
      for (const m of line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']*)'/g)) {
        if (!KIND_VALUES.test(m[2].trim().toLowerCase())) continue;
        if (!found.has(m[1])) found.set(m[1], []);
        found.get(m[1]).push(`${f}:${i + 1}`);
      }
    });
  }
  return found;
}

test('★ 자산이 종류를 적는 이름을 관문이 전부 읽는다', () => {
  const reads = kindFieldsFromSource();
  const found = discoveredFields();
  assert.ok(found.size > 0, '자산 레코드를 한 줄도 못 찾았다 — 이 시험이 아무것도 보지 않고 있다');

  const blind = [];
  for (const [field, where] of found) {
    if (NOT_A_KIND.has(field)) continue;
    if (reads.has(field)) continue;
    blind.push(`${field} (${where.length}곳, 예: ${where[0]})`);
  }
  assert.deepEqual(
    blind, [],
    '자산이 이 이름으로 종류를 적는데 instrumentRoute가 읽지 않는다 — '
    + '관문이 그만큼 눈먼 상태다:\n  ' + blind.join('\n  '),
  );
});

test('★ 면제 목록은 종류를 뜻하는 이름을 담지 않는다', () => {
  // 면제는 이 시험을 무력화하는 가장 쉬운 길이다. 그래서 고장을 일으킨
  // 이름들이 면제로 새지 않았는지 반대 방향으로도 본다.
  for (const f of ['cat', 'asset_type', 't', 'category', 'type', 'kind']) {
    assert.ok(!NOT_A_KIND.has(f), `${f}가 면제로 들어갔다 — 관문이 다시 눈먼다`);
  }
});

test('★ 이 시험이 실제로 세 이름을 찾아낸다 (빈 검사 방지)', () => {
  // 위 시험은 "못 찾으면 통과"로 조용히 무력해질 수 있다. 실제 고장을
  // 일으킨 세 이름이 여전히 발견되는지 못으로 박아 둔다.
  const found = discoveredFields();
  for (const f of ['cat', 'asset_type', 't']) {
    assert.ok(found.has(f), `${f}를 못 찾았다 — 탐색이 망가졌다`);
  }
});

test('★ 관문은 코인이라는 증거가 있을 때만 연다 (소스 확인)', () => {
  const s = readFileSync(ROUTE, 'utf8');
  assert.match(
    s, /coinEvidence\(asset\) !== 'COIN'\) return null/,
    '증거가 COIN일 때만 열어야 한다',
  );
  assert.ok(
    !/if \(kind && kind !== 'coin' && kind !== 'crypto'\) return null/.test(s),
    '"코인이 아니라고 적혀 있으면"으로 되돌아갔다 — 안 적힌 주식이 다시 통과한다',
  );
});

test('★ AssetType 전체 중 코인만 열린다', async () => {
  // 어휘가 늘어났는데 관문의 코인 집합도 같이 늘면 조용히 열린다.
  const types = readFileSync('src/types/index.ts', 'utf8');
  const m = /export type AssetType\s*=\s*([^;]+);/.exec(types);
  assert.ok(m, 'AssetType 선언을 찾지 못했다');
  const all = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  assert.ok(all.includes('coin') && all.includes('stock'), `어휘를 잘못 읽었다: ${all}`);

  const route = readFileSync(ROUTE, 'utf8');
  const cm = /const COIN_KINDS = new Set\(\[([^\]]*)\]\)/.exec(route);
  assert.ok(cm, 'COIN_KINDS 선언을 찾지 못했다');
  const coins = new Set([...cm[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
  const extra = all.filter(t => t !== 'coin' && coins.has(t));
  assert.deepEqual(extra, [], `코인이 아닌 종류가 COIN_KINDS에 들어 있다: ${extra}`);
});

// src/lib/products/registry.test.ts
//
// **이 파일이 막는 것은 하나다 — 없는 제품이 화면에 열리는 것.**
//
// 제품을 늘릴 때 가장 쉬운 사고는 표에 한 줄 적어 두고 "나중에 붙이지"
// 하는 것이다. 그 줄이 적히는 순간 `tradableProducts()`가 그것을 돌려주고,
// 화면은 탭을 그린다. 사용자는 **누를 수 있는 것을 되는 것으로 읽는다.**
//
// 그래서 여기서는 **판정 자체**를 고정한다. 지금 안 되는 제품이 지원으로
// 바뀌면 이 시험이 먼저 깨지고, 그때 사람이 근거를 본다.
import { test, eq, assert } from '../../test/harness';
import {
  PRODUCTS, AXES, productCapability, productCapabilities, readProductId,
  productTradability, precisionProven, tradableProducts, lockedProducts,
  lacking, PRODUCT_LABEL, AXIS_LABEL, VERDICT_LABEL,
  type ProductId, type CapabilityAxis, type Verdict,
} from './registry';

const VERDICTS: Verdict[] = ['SUPPORTED', 'BACKEND_GAP', 'DATA_GAP', 'VENUE_GAP'];

export function runProductRegistryTests() {
  console.log('[제품 능력 정본 — 없는 제품을 열지 않는다]');

  // ══════════ 모양 ══════════

  test('8개 제품 × 8개 축이 전부 채워져 있다', () => {
    eq(PRODUCTS.length, 8);
    eq(AXES.length, 8);
    for (const p of PRODUCTS) {
      const caps = productCapabilities(p);
      for (const a of AXES) {
        const c = caps[a];
        assert(c != null, `${p}/${a}가 비었습니다`);
        assert(VERDICTS.includes(c.verdict), `${p}/${a} 판정이 어휘 밖입니다: ${c.verdict}`);
      }
    }
  });

  test('★ 모든 판정에 파일 근거가 붙어 있다', () => {
    for (const p of PRODUCTS) {
      const caps = productCapabilities(p);
      for (const a of AXES) {
        const e = caps[a].evidence;
        assert(typeof e === 'string' && /^(src|supabase|scripts|\.github)\//.test(e),
          `${p}/${a}의 근거가 파일 경로가 아닙니다: ${e}`);
        assert(caps[a].note.length > 0, `${p}/${a}에 설명이 없습니다`);
      }
    }
  });

  test('라벨이 제품·축·판정 전부에 있다', () => {
    for (const p of PRODUCTS) assert(PRODUCT_LABEL[p]?.length > 0, `${p} 라벨 없음`);
    for (const a of AXES) assert(AXIS_LABEL[a]?.length > 0, `${a} 라벨 없음`);
    for (const v of VERDICTS) assert(VERDICT_LABEL[v]?.length > 0, `${v} 라벨 없음`);
  });

  // ══════════ ★ 모르는 것은 막는다 ══════════

  test('★ 모르는 제품은 LOCKED다 — fallback으로 열리지 않는다', () => {
    for (const bad of ['FOREX', 'NFT', '', '   ', 'spot_crypto_v2', null, undefined, 7, {}]) {
      const t = productTradability(bad as any);
      eq(t.state, 'LOCKED', `${JSON.stringify(bad)}가 거래 가능으로 나왔습니다`);
      assert(!t.paper && !t.live, `${JSON.stringify(bad)}에 장부가 붙었습니다`);
    }
  });

  test('★ 모르는 제품의 능력은 지원이 아니다', () => {
    const c = productCapability('FOREX', 'EXECUTION');
    assert(lacking(c), '모르는 제품이 지원으로 나왔습니다');
    eq(c.verdict, 'BACKEND_GAP');
  });

  test('★ 모르는 축도 지원이 아니다 — 오타가 능력을 만들지 않는다', () => {
    const c = productCapability('SPOT_CRYPTO', 'WHATEVER');
    assert(lacking(c), '모르는 축이 지원으로 나왔습니다');
  });

  test('제품 이름은 대소문자·공백을 견딘다 (그 외는 안 받는다)', () => {
    eq(readProductId(' spot_crypto '), 'SPOT_CRYPTO');
    eq(readProductId('SPOT_CRYPTO'), 'SPOT_CRYPTO');
    eq(readProductId('SPOT CRYPTO'), null);
    eq(readProductId('SPOTCRYPTO'), null);
  });

  // ══════════ ★ 지금 실제로 되는 것만 열린다 ══════════

  test('★ 거래 가능한 제품은 코인 현물·코인 무기한·주식 현물 셋뿐이다', () => {
    eq(tradableProducts().sort().join(','), 'PERP_CRYPTO,SPOT_CRYPTO,SPOT_STOCK');
  });

  test('★ 옵션·주식무기한·원자재무기한·온체인·컨버트는 LOCKED다', () => {
    for (const p of ['OPTIONS', 'PERP_STOCK', 'PERP_COMMODITY', 'ONCHAIN', 'CONVERT'] as ProductId[]) {
      const t = productTradability(p);
      eq(t.state, 'LOCKED', `${p}가 열려 있습니다`);
      assert(t.missing.length > 0, `${p}가 LOCKED인데 빠진 축이 없습니다`);
      assert(t.reason.length > 0, `${p}에 잠긴 이유가 없습니다`);
    }
  });

  test('잠긴 제품 목록이 이유와 함께 나온다 — "왜 없는지"를 말할 수 있다', () => {
    const locked = lockedProducts();
    eq(locked.length, 5);
    for (const l of locked) {
      assert(l.reason.length > 0, `${l.product}에 이유가 없습니다`);
      assert(l.missing.length > 0, `${l.product}에 빠진 축이 없습니다`);
    }
  });

  // ══════════ ★ 온체인 mock을 시세 권위로 올리지 않는다 ══════════

  test('★ 온체인 시세는 DATA_GAP이다 — mock을 출처로 인정하지 않는다', () => {
    const c = productCapability('ONCHAIN', 'MARKET_DATA');
    eq(c.verdict, 'DATA_GAP');
    assert(/mock/i.test(c.note), `온체인이 mock이라는 사실이 설명에 없습니다: ${c.note}`);
    assert(/onchain/i.test(c.evidence), `근거가 온체인 라우트가 아닙니다: ${c.evidence}`);
  });

  test('★ 온체인은 실행·보유도 없다 — 분석 화면이 거래 제품이 되지 않는다', () => {
    for (const a of ['EXECUTION', 'HOLDINGS', 'LIVE', 'PAPER'] as CapabilityAxis[]) {
      assert(lacking(productCapability('ONCHAIN', a)), `온체인 ${a}가 지원으로 나왔습니다`);
    }
  });

  // ══════════ ★ 주식은 한 칸으로 뭉개지지 않는다 ══════════

  test('★ 주식 현물은 LIVE는 되고 PAPER는 안 된다 — 두 칸이 다르다', () => {
    const caps = productCapabilities('SPOT_STOCK');
    eq(caps.LIVE.verdict, 'SUPPORTED');
    eq(caps.PAPER.verdict, 'BACKEND_GAP');
    assert(caps.LIVE.verdict !== caps.PAPER.verdict,
      '주식의 실계좌와 모의가 같은 판정입니다 — 하나로 뭉개졌습니다');
  });

  test('★ 주식 모의가 없다는 근거는 모의 시장 정본을 가리킨다', () => {
    const c = productCapability('SPOT_STOCK', 'PAPER');
    assert(/paperPriceSource/.test(c.evidence), `근거가 모의 시장 정본이 아닙니다: ${c.evidence}`);
  });

  // ══════════ ★ 옵션은 체인 없이 지원이 될 수 없다 ══════════

  test('★ 옵션 시세는 DATA_GAP이고 설명이 체인을 말한다', () => {
    const c = productCapability('OPTIONS', 'MARKET_DATA');
    eq(c.verdict, 'DATA_GAP');
    assert(/체인|만기|행사가/.test(c.note), `무엇이 없는지 적혀 있지 않습니다: ${c.note}`);
  });

  test('★ 옵션은 어느 축도 지원이 아니다', () => {
    const caps = productCapabilities('OPTIONS');
    for (const a of AXES) {
      assert(lacking(caps[a]), `옵션 ${a}가 지원으로 나왔습니다`);
    }
  });

  // ══════════ ★ 규격은 따로 말한다 ══════════

  test('★ 거래되는 제품도 규격은 아직 증명되지 않았다', () => {
    for (const p of tradableProducts()) {
      assert(!precisionProven(p),
        `${p}의 거래소 규격이 증명됐다고 적혀 있습니다 — 근거를 확인하세요`);
    }
  });

  test('★ 규격 부족이 거래 가능 여부를 뒤집지는 않는다', () => {
    // 규격을 필수 축에 넣으면 되는 것(모의 현물 거래)까지 LOCKED가 된다.
    // 없는 것을 있다고도, 되는 것을 안 된다고도 적지 않는다.
    eq(productTradability('SPOT_CRYPTO').state, 'TRADABLE');
    eq(productCapability('SPOT_CRYPTO', 'PRECISION').verdict, 'VENUE_GAP');
  });

  test('규격 없음은 VENUE_GAP으로 적는다 (서버 없음과 구별된다)', () => {
    for (const p of PRODUCTS) {
      eq(productCapability(p, 'PRECISION').verdict, 'VENUE_GAP',
        `${p}의 규격 판정이 VENUE_GAP이 아닙니다`);
    }
  });

  // ══════════ 거래 가능 = 필수 축 전부 + 장부 하나 이상 ══════════

  test('★ 거래 가능한 제품은 필수 축이 전부 채워져 있다', () => {
    for (const p of tradableProducts()) {
      const caps = productCapabilities(p);
      for (const a of ['MARKET_DATA', 'EXECUTION', 'ACCOUNT', 'HOLDINGS', 'UI_WIRING'] as CapabilityAxis[]) {
        eq(caps[a].verdict, 'SUPPORTED', `${p}/${a}가 비었는데 거래 가능합니다`);
      }
    }
  });

  test('★ 거래 가능하면 모의든 실계좌든 하나는 된다', () => {
    for (const p of tradableProducts()) {
      const t = productTradability(p);
      assert(t.paper || t.live, `${p}에 주문할 장부가 하나도 없습니다`);
    }
  });

  test('코인 현물은 모의·실계좌 둘 다 된다', () => {
    const t = productTradability('SPOT_CRYPTO');
    assert(t.paper && t.live, '코인 현물의 장부가 하나뿐입니다');
  });
}

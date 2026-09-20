#!/usr/bin/env node
// scripts/check-product-registry.mjs
//
// **제품 능력 정본이 거짓말을 하지 않는지 본다.**
//
// 시험은 표 안의 값끼리만 본다 — 표가 통째로 현실과 어긋나도 통과한다.
// 여기서는 표가 가리키는 **파일이 실제로 있는지**, 근거로 든 줄에 정말 그
// 내용이 있는지, 그리고 화면이 지원 여부를 **손으로 다시 적지 않는지**를
// 본다.
//
// 규칙을 쓸 때 지키는 것
// ──────────────────────
// 낱말이 아니라 **모양**을 본다. 이 저장소에서 규칙이 뮤테이션을 통과시킨
// 적이 여러 번 있는데 전부 "글자가 남아 있어서"였다.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';

const REG = 'src/lib/products/registry.ts';
const CAP = 'src/lib/trading/capability.ts';

let bad = 0;
const fail = (m) => { console.error(`  ✗ ${m}`); bad += 1; };
const read = (p) => {
  if (!existsSync(p)) { fail(`${p}가 없습니다`); return ''; }
  return readFileSync(p, 'utf8');
};
const stripTs = (s) => String(s)
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ');

const src = read(REG);
const code = stripTs(src);

// ══════════════ ① 근거가 실재하는가 ══════════════
//
// 표에 적힌 `파일:줄`이 없는 파일을 가리키면, 그 판정은 아무도 확인할 수
// 없다. 줄 번호까지 적혀 있으면 그 줄이 파일 길이 안에 있는지도 본다 —
// 파일이 짧아졌는데 근거만 남아 있는 상태를 막는다.
{
  const cited = [...code.matchAll(/cap\(\s*'[A-Z_]+'\s*,\s*'([^']+)'/g)].map(m => m[1]);
  if (cited.length === 0) fail(`${REG}: 판정을 하나도 찾지 못했습니다`);
  const seen = new Set();
  for (const ev of cited) {
    if (seen.has(ev)) continue;
    seen.add(ev);
    const [file, lineRaw] = ev.split(':');
    if (!existsSync(file)) {
      fail(`${REG}: 근거 파일이 없습니다 — ${ev}`);
      continue;
    }
    if (lineRaw != null) {
      const n = Number(lineRaw);
      if (!Number.isInteger(n) || n < 1) { fail(`${REG}: 근거 줄이 숫자가 아닙니다 — ${ev}`); continue; }
      const total = readFileSync(file, 'utf8').split('\n').length;
      if (n > total) fail(`${REG}: 근거 줄이 파일 밖입니다 — ${ev} (파일 ${total}줄)`);
    }
  }
  // 레지스트리 자신을 근거로 드는 것은 "모르는 제품" 응답뿐이어야 한다.
  const selfCited = cited.filter(e => e.startsWith(REG));
  if (selfCited.length > 2) {
    fail(`${REG}: 자기 자신을 근거로 든 판정이 ${selfCited.length}건입니다 — 근거가 아닙니다`);
  }
}

// ══════════════ ② 온체인 mock을 시세 권위로 올리지 않는다 ══════════════
//
// `/api/onchain`이 스스로 `source:'mock'`이라고 적는 한, 그 축은 DATA_GAP
// 이어야 한다. 라우트가 진짜 출처로 바뀌면 이 규칙이 먼저 깨지고, 그때
// 사람이 표를 고친다.
{
  const onchain = 'src/app/api/onchain/route.ts';
  const oc = read(onchain);
  const stillMock = /source:\s*'mock'|'binance\+mock'|getOnchainMock/.test(oc);
  const m = code.match(/ONCHAIN:\s*\{([\s\S]*?)\n  \},/);
  if (!m) fail(`${REG}: ONCHAIN 표를 찾지 못했습니다`);
  else {
    const md = m[1].match(/MARKET_DATA:\s*cap\(\s*'([A-Z_]+)'/);
    if (!md) fail(`${REG}: ONCHAIN의 MARKET_DATA 판정을 찾지 못했습니다`);
    else if (stillMock && md[1] === 'SUPPORTED') {
      fail(`${REG}: ${onchain}이 아직 mock인데 온체인 시세를 지원으로 적었습니다`);
    }
    for (const axis of ['EXECUTION', 'LIVE', 'PAPER', 'HOLDINGS']) {
      const a = m[1].match(new RegExp(`${axis}:\\s*cap\\(\\s*'([A-Z_]+)'`));
      if (a && a[1] === 'SUPPORTED') {
        fail(`${REG}: 온체인 ${axis}가 지원으로 적혀 있습니다 — 체결 경로가 없습니다`);
      }
    }
  }
}

// ══════════════ ③ 모의 시장 밖 제품을 PAPER 지원으로 적지 않는다 ══════════════
//
// 모의가 다루는 시장의 정본은 `PAPER_MARKETS`다. 거기 없는 제품이 PAPER
// 지원이면 표와 코드가 갈린 것이다.
{
  const ps = read('src/lib/engine/paperPriceSource.ts');
  const list = (ps.match(/PAPER_MARKETS[^=]*=\s*\[([^\]]*)\]/) || [])[1] || '';
  const hasSpot = /'SPOT'/.test(list);
  const hasUsdm = /'USDM'/.test(list);
  if (!hasSpot || !hasUsdm) {
    fail('paperPriceSource: PAPER_MARKETS가 SPOT·USDM을 담고 있지 않습니다 — 전제가 바뀌었습니다');
  }
  // 코인 현물·코인 무기한 밖의 제품은 PAPER가 지원일 수 없다.
  for (const p of ['SPOT_STOCK', 'PERP_STOCK', 'PERP_COMMODITY', 'OPTIONS', 'ONCHAIN', 'CONVERT']) {
    const m = code.match(new RegExp(`${p}:\\s*\\{([\\s\\S]*?)\\n  \\},`));
    if (!m) { fail(`${REG}: ${p} 표를 찾지 못했습니다`); continue; }
    const a = m[1].match(/PAPER:\s*cap\(\s*'([A-Z_]+)'/);
    if (a && a[1] === 'SUPPORTED') {
      fail(`${REG}: ${p}의 모의가 지원으로 적혀 있는데 PAPER_MARKETS에 없습니다`);
    }
  }
}

// ══════════════ ④ fail-closed가 살아 있는가 ══════════════
{
  if (!/if\s*\(!p\)\s*\{[\s\S]{0,200}BACKEND_GAP/.test(code)) {
    fail(`${REG}: 모르는 제품이 BACKEND_GAP으로 떨어지지 않습니다`);
  }
  if (!/AXES[\s\S]{0,40}includes\(axis\)/.test(code)) {
    fail(`${REG}: 모르는 축을 걸러내지 않습니다`);
  }
  // 모르는 제품이 LOCKED로 끝나는가 — 값의 모양으로 본다.
  if (!/state:\s*'LOCKED'[\s\S]{0,120}모르는 제품/.test(code)) {
    fail(`${REG}: 모르는 제품이 LOCKED로 끝나지 않습니다`);
  }
  // 필수 축이 비어 있으면 잠근다.
  if (!/missing\.length\s*>\s*0[\s\S]{0,120}'LOCKED'/.test(code)) {
    fail(`${REG}: 필수 축이 비어도 잠기지 않습니다`);
  }
  // 장부가 하나도 없으면 잠근다.
  if (!/!paper\s*&&\s*!live[\s\S]{0,120}'LOCKED'/.test(code)) {
    fail(`${REG}: 모의·실계좌가 둘 다 없어도 열립니다`);
  }
}

// ══════════════ ⑤ 규격은 거래 가능 여부와 섞지 않는다 ══════════════
//
// `PRECISION`을 필수 축에 넣으면 되는 것까지 잠기고, 빼고도 "규격 지원"이라
// 적으면 과장이 된다. **따로 말하는 함수**가 있어야 한다.
{
  const req = (code.match(/const REQUIRED[^=]*=\s*\[([^\]]*)\]/) || [])[1] || '';
  if (!req) fail(`${REG}: 필수 축 목록을 찾지 못했습니다`);
  else if (/PRECISION/.test(req)) {
    fail(`${REG}: 규격을 필수 축에 넣었습니다 — 되는 거래까지 잠깁니다`);
  }
  if (!/export function precisionProven/.test(code)) {
    fail(`${REG}: 규격을 따로 말하는 함수가 없습니다`);
  }
}

// ══════════════ ⑥ 화면이 지원 여부를 손으로 다시 적지 않는다 ══════════════
//
// 이 저장소가 이름 붙인 2번 고장이다 — 같은 판단이 두 곳에 있으면 언젠가
// 갈린다. 제품 이름을 쓰는 화면은 반드시 이 정본을 거쳐야 한다.
{
  const walk = (dir) => {
    let out = [];
    let es = [];
    try { es = readdirSync(dir); } catch { return out; }
    for (const e of es) {
      const f = `${dir}/${e}`;
      if (statSync(f).isDirectory()) out = out.concat(walk(f));
      else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(f);
    }
    return out;
  };
  const NAMES = /'(OPTIONS|PERP_STOCK|PERP_COMMODITY|CONVERT|ONCHAIN|SPOT_CRYPTO|PERP_CRYPTO|SPOT_STOCK)'/;
  for (const f of walk('src')) {
    if (f === REG || f.startsWith('src/lib/products/')) continue;
    const c = stripTs(readFileSync(f, 'utf8'));
    if (!NAMES.test(c)) continue;
    if (!/from '.*products\/registry'|products\/registry'/.test(c)) {
      fail(`${f}: 제품 이름을 쓰면서 정본(${REG})을 거치지 않습니다`);
    }
  }
}

// ══════════════ ⑦ 주문 기능 능력표와 책임이 겹치지 않는다 ══════════════
//
// `trading/capability.ts`는 **주문 한 건 안에서** 무엇이 되는지 답한다.
// 제품이 거래되는지는 여기서 답한다. 한쪽이 다른 쪽 어휘를 들고 오면
// 경계가 무너진다.
{
  const capCode = stripTs(read(CAP));
  if (/'OPTIONS'|'CONVERT'|'ONCHAIN'|'PERP_STOCK'|'PERP_COMMODITY'/.test(capCode)) {
    fail(`${CAP}: 주문 기능 능력표가 제품 이름을 들고 있습니다 — 경계가 무너집니다`);
  }
  if (/OrderFeature|PAPER_ORDER_FEATURES|orderCapability/.test(code)) {
    fail(`${REG}: 제품 정본이 주문 기능 어휘를 들고 있습니다 — 경계가 무너집니다`);
  }
}

if (bad > 0) {
  console.error(`\n제품 능력 정본 검사 실패 ${bad}건`);
  process.exit(1);
}
console.log('제품 능력 정본 검사 통과 — 근거 실재 · 온체인 mock 비승격 · fail-closed · 경계 분리');

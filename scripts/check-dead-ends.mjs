#!/usr/bin/env node
// scripts/check-dead-ends.mjs
//
// **만들어 놓고 배선을 안 한 것을 센다.**
//
// 이 저장소가 가장 자주 겪은 고장이다. 최근에만 세 번 났다:
//
//   SYNC_SECRETS       명령·버튼·실행 분기가 다 있는데 큐 목록에만 빠져
//                      영원히 안 돌았다 (#175)
//   migrate.yml        워크플로가 있는데 트리거가 안 맞아 33번 전부
//                      skip됐다 — 마이그레이션 62개가 미적용이었다 (#172)
//   자산 스냅샷 표      048이 표를 만들었는데 채우는 코드가 없어 곡선이
//                      구조적으로 영원히 비어 있었다
//
// 셋 다 **빨간불이 어디에도 안 켜졌다.** 안 도는 코드는 실패하지 않는다.
//
// 무엇을 세나
// ───────────
//   · 아무도 부르지 않는 API 라우트
//   · 어디서도 렌더되지 않는 컴포넌트
//
// 왜 지우지 않고 세나
// ───────────────────
// 지우는 것은 되돌리기 어렵고, 무엇을 살릴지는 사람이 정할 일이다.
// 그래서 타입 에러와 **같은 방식**을 쓴다 — 기준선을 박아 두고
// **늘어나는 것만 막는다.** 그리고 매 실행마다 목록을 찍어서
// 잊히지 않게 한다.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * 지금 끊겨 있는 것들. **줄이는 것이 목표이고, 늘리면 실패한다.**
 *
 * 각 항목에 무엇이 끊겼는지 적는다 — 이름만 적으면 다음 사람이
 * "이건 원래 이런가 보다"로 읽는다.
 */
const KNOWN = {
  'api:orders/preflight':
    '거래 전 점검을 미리 보여주는 API. 판정은 서버 주문 경로 9곳에서 실제로 돌지만, '
    + '사용자가 주문 전에 미리 볼 경로가 없다',
  'api:alpha':
    'RSI·MACD·볼린저를 주는 라우트. 같은 provider 함수를 다른 곳에서도 안 쓴다',
  'api:finnhub':
    '시장/기업 뉴스를 주는 라우트. 같은 provider 함수를 다른 곳에서도 안 쓴다',
  'api:ai/calibration': 'AI 보정. 화면에서 부르는 곳이 없다',
  'api:ai/keys': 'AI 키 관리. 화면에서 부르는 곳이 없다',
  'api:ai/providers/status': 'AI 공급자 상태. 화면에서 부르는 곳이 없다',
  'api:binance/coinm/account': 'COIN-M 계좌 조회. 화면에서 부르는 곳이 없다',
  'api:binance/futures/brackets': '레버리지 구간표. 화면에서 부르는 곳이 없다',
  'api:binance/futures/close-all': '**전량 청산.** 부르는 곳이 없다 — 있는 채로 두면 언젠가 누가 부른다',
  'api:binance/spot/open-orders': '현물 미체결 조회. 화면에서 부르는 곳이 없다',
  'api:calendar/sync': '캘린더 동기화. 화면에서 부르는 곳이 없다',
  'api:paper/positions': '모의 포지션. 화면에서 부르는 곳이 없다',
  'api:cron/reconcile': '대조 크론. **vercel.json의 crons에도 없다** — 아무 일정도 이걸 깨우지 않는다',
  'api:daily-briefing': '일일 브리핑. 화면에서 부르는 곳이 없다',
  'api:derivatives/history': '파생 이력. 화면에서 부르는 곳이 없다',
  'api:eodhd/calendar': 'EODHD 캘린더. 화면에서 부르는 곳이 없다',
  'api:eodhd/logo': 'EODHD 로고. 화면에서 부르는 곳이 없다',
  'api:exchange/connect': '거래소 연결. 화면에서 부르는 곳이 없다 — 연결은 다른 경로로 한다',
  'api:exchange/delete': '거래소 연결 삭제. 화면에서 부르는 곳이 없다',
  'api:exchange/list': '거래소 연결 목록. 화면에서 부르는 곳이 없다',
  'api:exchange/testnet-check': '테스트넷 확인. 화면에서 부르는 곳이 없다',
  'api:fmp/news': 'FMP 뉴스. 화면에서 부르는 곳이 없다',
  'api:fmp/quote': 'FMP 시세. 화면에서 부르는 곳이 없다',
  'api:logs': '로그 조회. 화면에서 부르는 곳이 없다',
  'api:notify/test': '알림 테스트. 화면에서 부르는 곳이 없다',
  'api:signals/live': '실시간 신호. 화면에서 부르는 곳이 없다',
  'api:strategies/list': '전략 목록. 화면에서 부르는 곳이 없다',
  'api:strategies/save': '전략 저장. 화면에서 부르는 곳이 없다',
  'api:translate/status': '번역 상태. 화면에서 부르는 곳이 없다',
  'component:src/components/PreTradeChecklist.tsx':
    '거래 전 점검 화면. **안전 기능인데 어디에도 안 붙어 있다** — '
    + '주문이 막혔을 때 사용자가 어느 항목이 왜 막았는지 볼 수 없다',
  'component:src/components/SmartLogo.tsx':
    'AssetLogo가 같은 일을 하고 그쪽이 쓰인다',
  'component:src/components/SourceBadge.tsx':
    'ui/DataBadge가 같은 일을 하고 그쪽이 쓰인다',
  'component:src/components/pages/ComingSoonPage.tsx':
    '자리표시 화면. 메뉴 어디도 이걸 가리키지 않는다(check-nav 통과)',
};

function walk(dir, out = [], pred) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out, pred);
    else if (pred(name)) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

/**
 * 코드 밖에서 불리는 경로.
 *
 * **"코드가 안 부른다"와 "아무도 안 부른다"는 다르다.** cron·웹훅·
 * 헬스체크는 바깥에서 들어온다. 그걸 죽은 것으로 세면 검사가 틀린
 * 것이 되고, 그러면 사람들이 검사를 끈다.
 *
 * cron은 추측하지 않고 `vercel.json`에서 읽는다 — 선언이 바뀌면
 * 검사도 따라 바뀐다.
 */
function externallyCalled() {
  const out = new Set();
  try {
    const v = JSON.parse(readFileSync('vercel.json', 'utf8'));
    for (const c of (v.crons || [])) {
      const p = String(c.path || '').replace(/^\/api\//, '');
      if (p) out.add(p);
    }
  } catch { /* 없으면 없는 대로 — 다만 아래 KNOWN이 받아 준다 */ }
  return out;
}
const EXTERNAL = externallyCalled();

/**
 * 코드가 안 불러도 정상인 것들. **왜 정상인지를 같이 적는다.**
 *
 * 바깥에서 들어오는 경로다. 여기 새로 넣을 때는 "정말 바깥에서
 * 부르는가"를 먼저 확인한다 — 확인 없이 넣으면 이 목록이
 * 죽은 코드를 숨기는 자리가 된다.
 */
const EXTERNAL_OK = {
  'health': '가동 확인 endpoint. 모니터링이 바깥에서 부른다',
  'health/env': '환경 점검 endpoint. 사람이 직접 연다',
  'health/security': '보안 점검 endpoint. 사람이 직접 연다',
  'telegram/callback': '텔레그램 서버가 부르는 웹훅이다',
  'webhook/secret': '바깥에서 들어오는 웹훅이다',
  'webhook/signal': 'TradingView·외부 신호가 POST하는 웹훅이다',
  'webhook/tradingview': 'TradingView 알림이 POST하는 웹훅이다',
};

/** 저장소 전체에서 이 문자열을 참조하는 파일이 있는가 */
function referenced(pattern, exclude) {
  const roots = ['src', 'worker', 'scripts', '.github'];
  for (const root of roots) {
    const files = walk(root, [], n => /\.(ts|tsx|mjs|js|yml|yaml)$/.test(n));
    for (const f of files) {
      if (exclude && f.startsWith(exclude)) continue;
      let src;
      try { src = readFileSync(f, 'utf8'); } catch { continue; }
      // **주석 속 언급은 호출이 아니다.** daily-ladder에는
      // "`/api/orders/preflight`와 같은 판정 함수를 쓴다"는 설명이
      // 있는데, 그걸 호출로 세면 아무도 안 부르는 라우트가
      // 살아 있는 것으로 잡힌다 — 검사가 정반대로 틀린다.
      if (/\.(ts|tsx|mjs|js)$/.test(f)) {
        src = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
                 .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      }
      if (pattern.test(src)) return true;
    }
  }
  return false;
}

const dead = [];

// ── 아무도 부르지 않는 API 라우트 ──
for (const r of walk('src/app/api', [], n => n === 'route.ts')) {
  const path = r.replace('src/app/api/', '').replace('/route.ts', '');
  const dir = r.replace('/route.ts', '');
  if (EXTERNAL.has(path)) continue;      // vercel.json이 부른다
  if (EXTERNAL_OK[path]) continue;       // 바깥에서 부른다 (사유 기록됨)

  // **동적 구간은 리터럴로 안 잡힌다.** 부르는 쪽은
  // `/api/jobs/${id}`처럼 쓰므로 `[id]`를 통째로 찾으면 언제나 없다.
  // 그래서 `[`가 나오기 전까지의 고정 앞부분으로 본다.
  const stat = path.split('/').reduce((acc, seg) =>
    (acc.done || seg.startsWith('[')) ? { ...acc, done: true } : { parts: [...acc.parts, seg], done: false },
    { parts: [], done: false }).parts.join('/');
  const needle = stat || path;
  // **파일 경로를 호출로 세지 않는다.**
  //
  // `check-entry-gates.mjs`에는 `'src/app/api/orders/preflight/route.ts'`가
  // 면제 목록으로 적혀 있다. 그냥 `/api/orders/preflight`를 찾으면 그
  // 문자열 안에서 걸려서, **아무도 안 부르는 라우트가 살아 있는 것으로
  // 잡힌다** — 검사가 정반대로 틀린다.
  //
  // 호출은 `'/api/...'`나 `` `/api/...` `` 꼴이고, 파일 경로는 앞에
  // `app`처럼 글자가 붙는다. 그래서 앞 글자가 단어문자나 `/`면 뺀다.
  if (!referenced(new RegExp(`(?<![\\w/])/api/${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`), dir)) {
    dead.push({ key: `api:${path}`, what: '아무도 부르지 않는 API 라우트', where: r });
  }
}

// ── 어디서도 렌더되지 않는 컴포넌트 ──
for (const c of walk('src/components', [], n => /\.tsx$/.test(n) && !/\.test\.tsx$/.test(n))) {
  const name = c.split('/').pop().replace('.tsx', '');
  // 정적 import와 dynamic import를 모두 본다 — dynamic을 놓치면
  // 멀쩡히 쓰이는 화면이 전부 죽은 것으로 잡힌다.
  if (!referenced(new RegExp(`(from|import\\()\\s*'[^']*/${name}'`), c)) {
    dead.push({ key: `component:${c}`, what: '어디서도 렌더되지 않는 컴포넌트', where: c });
  }
}

const added = dead.filter(d => !KNOWN[d.key]);
const fixed = Object.keys(KNOWN).filter(k => !dead.some(d => d.key === k));

if (added.length > 0) {
  console.error('❌ 배선이 끊긴 것이 늘었습니다\n');
  for (const d of added) {
    console.error(`  ${d.where}`);
    console.error(`    ${d.what}\n`);
  }
  console.error('안 도는 코드는 실패하지 않습니다 — 빨간불이 어디에도 안 켜집니다.');
  console.error('배선하거나 지우십시오. 남겨 둘 이유가 있으면');
  console.error('scripts/check-dead-ends.mjs의 KNOWN에 무엇이 끊겼는지 적으십시오.');
  process.exit(1);
}

if (fixed.length > 0) {
  console.error('❌ KNOWN에 이제 끊기지 않은 항목이 있습니다 — 목록이 낡으면 진짜를 덮습니다\n');
  for (const k of fixed) console.error(`  ${k}`);
  console.error('\nKNOWN에서 지우십시오. 기준선은 줄어들어야 합니다.');
  process.exit(1);
}

console.log(`✅ 배선이 끊긴 것 ${dead.length}개 — 기준선과 같습니다 (늘지 않았습니다)`);
for (const d of dead) console.log(`   · ${d.where}\n     ${KNOWN[d.key]}`);

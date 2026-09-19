// scripts/check-paper-spot-holdings.mjs
//
// **현물 분할매도 회계의 계약이 코드에 남아 있는지 본다.**
//
// 실행 증명(`scripts/sql/088_..._proof.sql`)과 동시성 검사는 실제 Postgres가
// 있어야 돈다. CI에는 DB가 없으므로, 그 계약이 **글자에서 사라지는 것**만이라도
// 여기서 잡는다. 이 검사기는 회계를 하지 않는다 — 모양만 본다.
//
// 규칙을 쓸 때 지키는 것
// ──────────────────────
// **낱말이 아니라 호출과 조건의 모양을 본다.** 이 저장소에서 규칙이 뮤테이션을
// 통과시킨 적이 세 번 있는데 전부 "글자가 남아 있어서"였다 — 조건을
// `if (false)`로 바꿔도 문자열은 그대로였다.
import { readFileSync, existsSync } from 'node:fs';

const MIG   = 'supabase/migrations/088_paper_spot_holdings.sql';
const STORE = 'src/lib/engine/paperStore.ts';
const DAILY = 'src/lib/risk/dailyLossCheck.ts';
const EXITM = 'src/app/api/paper/exit-monitor/route.ts';
const MARKS = 'src/lib/engine/paperExitMarks.ts';
const SELLR = 'src/app/api/paper/sell/route.ts';
const HOLDR = 'src/app/api/paper/holdings/route.ts';
const SCOPE = 'src/lib/engine/paperHoldingScope.ts';
const AUDIT = '.github/workflows/audit-production-paper-spot-holdings.yml';
const REPLAY = '.github/workflows/supabase-replay.yml';

let bad = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); bad += 1; };
const read = (p) => {
  if (!existsSync(p)) { fail(`${p}가 없습니다`); return ''; }
  return readFileSync(p, 'utf8');
};

// SQL 주석과 문자열을 지운다 — 주석 속 낱말로 통과시키지 않기 위해.
const stripSql = (s) => String(s)
  .replace(/--[^\n]*/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ');
// TS 주석을 지운다.
const stripTs = (s) => String(s)
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ');

const sql = stripSql(read(MIG));
const store = stripTs(read(STORE));
const daily = stripTs(read(DAILY));
const exitm = stripTs(read(EXITM));
const marks = stripTs(read(MARKS));
const sellr = stripTs(read(SELLR));
const holdr = stripTs(read(HOLDR));
const scope = stripTs(read(SCOPE));
const audit = read(AUDIT);      // YAML은 주석을 지우지 않는다 — 트리거가 주석일 수 있다
const replay = read(REPLAY);

// 함수 본문 한 덩어리를 뽑는다.
//
// **달러 인용 태그를 고정하지 않는다.** 이 저장소는 `$$`와 `$fn$`을 섞어 쓴다
// (`086`의 트리거 함수가 `$fn$`이다). `$$`만 찾으면 `$fn$`로 쓴 함수의 본문이
// 통째로 빈 문자열이 되고, **그 함수에 걸린 규칙이 전부 조용히 통과한다** —
// 규칙이 있는데 아무것도 검사하지 않는 상태가 가장 나쁘다.
function body(name) {
  const i = sql.indexOf(`FUNCTION public.${name}(`);
  if (i < 0) return '';
  const m = /\$([A-Za-z_]*)\$/.exec(sql.slice(i));
  if (!m) return '';
  const tag = m[0];
  const j = i + m.index;
  const k = sql.indexOf(tag, j + tag.length);
  return k < 0 ? '' : sql.slice(j, k);
}

// ══════════════ ① 매도 원장의 신원 ══════════════
//
// 뮤테이션: `POSITION_SELL`/`sell_id`를 `POSITION_CLOSE`/`position_id`로 되돌림.
// 그러면 같은 포지션의 두 번째 매도가 멱등키에 걸려 조용히 사라진다.
{
  const sell = body('paper_sell_holding');
  if (!sell) fail('paper_sell_holding을 찾지 못했습니다');

  // 돈을 적는 두 줄이 **매도 사건 id**를 쓰는가. 문자열만 보지 않고
  // `paper_money_apply(...)` 호출 안에서 인자 모양을 본다.
  const applies = sell.match(/paper_money_apply\s*\(([\s\S]{0,320}?)\)/g) || [];
  const sellApplies = applies.filter(a => /'POSITION_SELL'/.test(a));
  if (sellApplies.length !== 2) {
    fail(`매도 원장이 2줄이 아닙니다 (POSITION_SELL 호출 ${sellApplies.length}) — `
       + 'gross와 수수료는 따로 적어야 합니다');
  }
  if (!sellApplies.some(a => /'REALIZED_PNL'/.test(a) && /v_gross/.test(a))) {
    fail('REALIZED_PNL에 gross(v_gross)를 적지 않습니다 — 순액을 적으면 수수료가 두 번 빠집니다');
  }
  if (!sellApplies.some(a => /'TRADING_FEE'/.test(a) && /-\s*v_fee/.test(a))) {
    fail('TRADING_FEE에 -v_fee를 적지 않습니다');
  }
  // **source_event_id가 매도 사건 id여야 한다.** position_id면 멱등키가 겹친다.
  for (const a of sellApplies) {
    if (!/v_sell\s*::\s*TEXT/.test(a)) {
      fail('매도 원장의 source_event_id가 매도 사건 id(v_sell)가 아닙니다 — '
         + 'position_id를 쓰면 두 번째 매도가 ON CONFLICT로 사라집니다');
      break;
    }
  }
  // 새 사건 종류가 허용 목록에 있는가 (없으면 INSERT가 CHECK에 걸린다).
  if (!/CHECK\s*\(source_event_type IN[\s\S]{0,200}'POSITION_SELL'/.test(sql)) {
    fail('원장의 source_event_type 허용 목록에 POSITION_SELL이 없습니다');
  }
}

// ══════════════ ② 과거 진입 수수료는 안 줄어든다 ══════════════
//
// 뮤테이션: `entry_fee`를 남은 상태처럼 깎음 / freeze 트리거에서 뺌.
{
  const sell = body('paper_sell_holding');
  // 매도가 UPDATE 하는 칸에 entry_fee가 있으면 과거 사건을 고치는 것이다.
  const updates = sell.match(/UPDATE public\.paper_positions[\s\S]*?WHERE/g) || [];
  for (const u of updates) {
    if (/\bentry_fee\s*=/.test(u)) {
      fail('매도가 entry_fee를 바꿉니다 — 진입 때 실제로 낸 과거 금액은 줄지 않습니다');
    }
    if (!/remaining_entry_fee_basis\s*=/.test(u)) {
      fail('매도가 remaining_entry_fee_basis를 갱신하지 않습니다 — '
         + '남은 원가 귀속이 줄지 않으면 수수료가 두 번 귀속됩니다');
    }
  }
  if (updates.length === 0) fail('매도가 포지션을 갱신하지 않습니다');

  // freeze 트리거가 불변 칸을 실제로 **비교**하는가. 이름만 적혀 있으면 안 된다.
  const frz = body('paper_positions_freeze_open_cols');
  for (const col of ['entry_fee', 'open_quantity', 'open_notional', 'open_margin', 'fill_price']) {
    const re = new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM\\s+OLD\\.${col}`);
    if (!re.test(frz)) fail(`freeze 트리거가 ${col}의 변경을 비교하지 않습니다`);
  }
  if (!/RAISE EXCEPTION/.test(frz)) fail('freeze 트리거가 거부하지 않습니다');

  // ★ **처음 채우기는 막지 않는다.**
  //
  //   옛 값이 있을 때만 잠가야 한다. `IS DISTINCT FROM`만 보면 이 파일의
  //   backfill이 **자기 트리거에 막혀** 두 번째 적용이 실패한다 — CI 재생이
  //   실제로 그렇게 빨개졌다.
  for (const col of ['entry_fee', 'open_quantity', 'open_notional', 'open_margin']) {
    const re = new RegExp(`OLD\\.${col}\\s+IS NOT NULL\\s+AND\\s+NEW\\.${col}`);
    if (!re.test(frz)) {
      fail(`freeze 트리거가 ${col}의 "처음 채우기"를 허용하지 않습니다 — `
         + 'backfill이 자기 트리거에 막힙니다');
    }
  }

  // ★ **트리거가 backfill보다 먼저 세워져야 한다.**
  //
  //   순서가 반대면 두 번째 적용 때 **옛 트리거 함수**가 살아 있는 채로
  //   backfill이 돌고, 고친 규칙이 적용되지 않는다.
  const iTrg = sql.indexOf('CREATE TRIGGER paper_positions_freeze_open_trg');
  const iBf  = sql.search(/UPDATE public\.paper_positions\s+SET open_quantity\s*=\s*quantity/);
  if (iTrg < 0 || iBf < 0 || iTrg > iBf) {
    fail('freeze 트리거가 backfill보다 뒤에 있습니다 — '
       + '두 번째 적용에서 옛 트리거 함수가 backfill을 막습니다');
  }
  if (!/CREATE TRIGGER paper_positions_freeze_open_trg[\s\S]{0,200}BEFORE UPDATE/.test(sql)) {
    fail('freeze 트리거가 BEFORE UPDATE로 걸려 있지 않습니다 — 만들어 놓고 안 건 것입니다');
  }
}

// ══════════════ ③ legacy 청산은 남은 귀속분을 읽는다 (A1) ══════════════
//
// 뮤테이션: `entry_fee`를 그대로 읽게 되돌림 → 이미 귀속된 몫을 또 뺀다.
{
  // 청산 계산에 넘어가는 값이 남은 귀속분에서 오는가.
  if (!/entryFee:\s*remainingEntryFeeBasis\(/.test(store)) {
    fail(`${STORE}: 청산 계산의 entryFee가 remainingEntryFeeBasis에서 오지 않습니다`);
  }
  // 그 함수가 **칸이 있으면 그 값을 쓰는가** — 항상 entry_fee로 내려가면
  // 고친 의미가 사라진다.
  const fn = store.match(/function remainingEntryFeeBasis[\s\S]*?\n\}/)?.[0] ?? '';
  if (!/remaining_entry_fee_basis/.test(fn)) {
    fail(`${STORE}: remainingEntryFeeBasis가 remaining_entry_fee_basis를 읽지 않습니다`);
  }
  if (!/basis\s*==\s*null/.test(fn) || !/entry_fee/.test(fn)) {
    fail(`${STORE}: 칸이 없을 때만 entry_fee로 내려가는 분기가 없습니다`);
  }
  // 값이 0인 것을 "없음"으로 읽으면 전량 귀속된 줄이 다시 수수료를 뺀다.
  if (/!\s*basis\b/.test(fn) || /basis\s*\|\|/.test(fn)) {
    fail(`${STORE}: 0을 "없음"으로 읽습니다 — 0은 확인된 값입니다`);
  }
  // 못 읽으면 닫지 않는다.
  if (!/Number\.isFinite\(fill\.entryFee\)/.test(store)) {
    fail(`${STORE}: 수수료 귀속분을 못 읽어도 청산을 진행합니다`);
  }
}

// ══════════════ ④ 분할매도는 거래로 세지 않는다 (D1) ══════════════
//
// 뮤테이션: `trade_count + 1`로 매도마다 증가 / 승패에서 누적을 뺌.
{
  const sell = body('paper_sell_holding');
  if (!/trade_count\s*=\s*trade_count\s*\+\s*v_closed/.test(sell)) {
    fail('매도가 trade_count를 닫힌 lot 수(v_closed)만큼 올리지 않습니다 — '
       + '분할 3회와 전량 1회의 거래 수가 달라집니다');
  }
  if (/trade_count\s*=\s*trade_count\s*\+\s*1\b/.test(sell)) {
    fail('매도가 매번 trade_count를 1 올립니다');
  }
  if (!/win_count\s*=\s*win_count\s*\+\s*v_wins/.test(sell)) {
    fail('매도가 win_count를 lot 단위(v_wins)로 올리지 않습니다');
  }
  // 승패는 그 lot의 **누적**으로 본다.
  if (!/SUM\(l\.lot_realized_pnl\)[\s\S]{0,200}INTO v_cum/.test(sell)) {
    fail('매도가 lot 누적 실현손익을 읽지 않습니다');
  }
  if (!/IF v_cum > 0 THEN v_wins/.test(sell)) {
    fail('매도의 승패 판정이 lot 누적(v_cum) 기준이 아닙니다');
  }

  // A2 — legacy 청산의 승패도 앞선 부분매도를 포함한다.
  const close = body('paper_settle_close');
  if (!/SUM\(l\.lot_realized_pnl\)[\s\S]{0,200}INTO v_prior/.test(close)) {
    fail('paper_settle_close가 앞선 부분매도 손익(v_prior)을 읽지 않습니다');
  }
  if (!/WHEN\s*\(v_prior\s*\+\s*p_realized_pnl\)\s*>\s*0/.test(close)) {
    fail('paper_settle_close의 승패가 (v_prior + 이번 조각) 기준이 아닙니다 — '
       + '마지막 조각만 보면 앞에서 잃은 것이 승으로 잡힙니다');
  }
  // 잔고·원장·멱등은 그대로여야 한다.
  if (!/'POSITION_CLOSE'/.test(close)) {
    fail('paper_settle_close의 원장 사건 종류가 바뀌었습니다 — 기존 이력과 갈립니다');
  }
  if (!/total_pnl\s*=\s*total_pnl\s*\+\s*p_realized_pnl/.test(close)) {
    fail('paper_settle_close의 total_pnl 누계가 바뀌었습니다');
  }
}

// ══════════════ ⑤ oversell은 막힌다 ══════════════
//
// 뮤테이션: 보유 초과 검사 제거 / 배분 잔여 검사 제거.
{
  const sell = body('paper_sell_holding');
  if (!/IF v_sold > v_held THEN/.test(sell)) {
    fail('보유보다 많이 파는 것을 막지 않습니다');
  }
  if (!/'INSUFFICIENT_HOLDING'/.test(sell)) {
    fail('보유 초과에 INSUFFICIENT_HOLDING을 돌려주지 않습니다');
  }
  // 100%는 나눗셈을 하지 않아야 등가가 성립한다.
  if (!/IF p_percent = 100 THEN[\s\S]{0,120}v_sold\s*:=\s*v_held/.test(sell)) {
    fail('전량매도가 남은 전부를 그대로 가져가지 않습니다 — '
       + '나눗셈이 끼면 dust가 남습니다');
  }
  // 배분은 내림이어야 넘치지 않는다.
  if (!/paper_floor_at\(v_q\[i\]\s*\*\s*v_sold\s*\/\s*v_held/.test(sell)) {
    fail('lot 배분이 내림(paper_floor_at)이 아닙니다');
  }
  if (!/IF v_residue <> 0 THEN[\s\S]{0,160}RAISE EXCEPTION/.test(sell)) {
    fail('배분 잔여가 남아도 그냥 진행합니다 — 풀리지 않는 dust가 됩니다');
  }
  if (!/IF v_residue < 0 THEN[\s\S]{0,160}RAISE EXCEPTION/.test(sell)) {
    fail('배분이 매도 수량을 넘어도 막지 않습니다');
  }
  if (!/FLOOR\(/.test(body('paper_floor_at'))) {
    fail('paper_floor_at이 내림이 아닙니다 — 반올림이면 배분 합이 넘칠 수 있습니다');
  }
  // 계약이 성립하지 않는 줄이 섞이면 멈춘다.
  if (!/'NOT_SPOT'/.test(sell) || !/pp\.side <> 'LONG' OR pp\.leverage <> 1/.test(sell)) {
    fail('현물·LONG·배율1이 아닌 줄을 걸러내지 않습니다');
  }
}

// ══════════════ ⑥ 금액 계산은 SQL에 있다 ══════════════
//
// 뮤테이션: 라우트가 gross/fee/realized를 계산해 RPC에 넘김.
{
  if (!/rpc\('paper_sell_holding'/.test(sellr)) {
    fail(`${SELLR}: paper_sell_holding을 부르지 않습니다`);
  }
  // RPC 인자에 금액이 들어가면 정본이 JS로 옮겨간 것이다.
  const args = sellr.match(/rpc\('paper_sell_holding',\s*\{([\s\S]*?)\}\)/)?.[1] ?? '';
  for (const forbidden of ['p_gross', 'p_exit_fee', 'p_realized', 'p_sold_quantity', 'p_ratio']) {
    if (new RegExp(`\\b${forbidden}\\b`).test(args)) {
      fail(`${SELLR}: RPC에 ${forbidden}를 넘깁니다 — 금액을 JS가 정하면 안 됩니다`);
    }
  }
  // 청산가는 서버가 읽는다.
  if (!/readPaperMarkPrice\(\s*'SPOT'/.test(sellr)) {
    fail(`${SELLR}: 청산가를 readPaperMarkPrice로 읽지 않습니다`);
  }
  if (/body\??\.\s*(exitPrice|price)\b/.test(sellr)) {
    fail(`${SELLR}: 화면이 보낸 가격을 씁니다`);
  }
  // 계좌는 본문에서 받지 않는다.
  if (/body\??\.\s*(paperAccountId|accountId)\b/.test(sellr)) {
    fail(`${SELLR}: 요청 본문에서 계좌 id를 받습니다 — 남의 장부를 지목할 수 있습니다`);
  }
  // 멱등 식별자를 반드시 넘긴다.
  if (!/p_client_sell_id:\s*clientSellId/.test(sellr)) {
    fail(`${SELLR}: clientSellId를 RPC에 넘기지 않습니다 — 재시도가 두 번 팝니다`);
  }
  if (!/p_event_effective_at:\s*paperEventTimeNow\(\)/.test(sellr)) {
    fail(`${SELLR}: 사건 시각을 서버에서 만들지 않습니다`);
  }
  // 거부를 성공으로 적지 않는다.
  for (const st of ['INSUFFICIENT_HOLDING', 'NO_HOLDING', 'CONFLICT', 'NOT_SPOT', 'UNREADABLE_LOT']) {
    if (!new RegExp(`${st}:\\s*\\{`).test(sellr)) {
      fail(`${SELLR}: ${st}을 거부로 옮기지 않습니다`);
    }
  }
  if (!/status !== 'SOLD' && status !== 'REPLAYED'/.test(sellr)) {
    fail(`${SELLR}: 모르는 결과를 성공으로 흘려보냅니다`);
  }
}

// ══════════════ ⑦ 장부를 못 정하면 기본 계좌로 안 내려간다 ══════════════
//
// 뮤테이션: 실패 시 기본 계좌로 fallback.
{
  if (!/code:\s*unreadable \? 'UNREADABLE' : 'NOT_FOUND'/.test(scope)
      && !/'UNREADABLE'/.test(scope)) {
    fail(`${SCOPE}: 챌린지 해석 실패를 구분하지 않습니다`);
  }
  // 챌린지 분기에서 실패하면 **return** 해야 한다. 아래로 흘러가면
  // 기본 계좌 분기를 만난다.
  const cid = scope.match(/if \(cid\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  if (!/return \{[\s\S]{0,200}ok: false/.test(cid)) {
    fail(`${SCOPE}: 챌린지를 못 풀었는데 거부하지 않습니다 — 기본 계좌로 내려갑니다`);
  }
  if (/resolvePaperScope/.test(cid)) {
    fail(`${SCOPE}: 챌린지 분기 안에서 기본 계좌를 찾습니다 — fallback입니다`);
  }
  // 두 라우트가 이 한 곳을 쓴다.
  for (const [f, src] of [[SELLR, sellr], [HOLDR, holdr]]) {
    if (!/resolveHoldingScope\(/.test(src)) fail(`${f}: resolveHoldingScope를 쓰지 않습니다`);
    if (!/holdingScopeFailed\(/.test(src)) fail(`${f}: 장부 해석 실패를 확인하지 않습니다`);
  }
  // 보유 집계도 한 곳이다.
  if (!/rpc\('paper_holdings'/.test(holdr)) {
    fail(`${HOLDR}: paper_holdings를 부르지 않습니다 — 집계를 라우트가 다시 하면 갈립니다`);
  }
  if (/\.reduce\(/.test(holdr)) {
    fail(`${HOLDR}: 라우트가 직접 합산합니다`);
  }
  // 없는 권위를 만들지 않는다.
  if (/unrealized(?!Pnl:\s*')/i.test(holdr.replace(/unrealizedPnl:\s*'UNAVAILABLE_NO_AUTHORITY'/, ''))) {
    fail(`${HOLDR}: 미실현 손익을 만듭니다 — 정본이 없습니다`);
  }
}

// ══════════════ ⑧ 하루 손실은 부분매도를 센다 ══════════════
//
// 뮤테이션: 예전처럼 closed_at 기준 realized_pnl 직접 합산으로 되돌림.
{
  if (!/rpc\('paper_realized_between'/.test(daily)) {
    fail(`${DAILY}: paper_realized_between을 쓰지 않습니다 — `
       + '부분매도는 줄을 닫지 않아 closed_at 합산에 안 잡힙니다');
  }
  if (/from\('paper_positions'\)[\s\S]{0,200}realized_pnl/.test(daily)) {
    fail(`${DAILY}: 포지션 표에서 realized_pnl을 직접 합산합니다`);
  }
  if (!/if \(error\) throw/.test(daily)) {
    fail(`${DAILY}: 조회 실패를 "오늘 손실 0"으로 읽습니다 — 한도가 통과합니다`);
  }
  // SQL 쪽이 두 출처를 겹치지 않게 더하는가.
  const rb = body('paper_realized_between');
  if (!/paper_sell_events/.test(rb) || !/paper_sell_event_lots/.test(rb)) {
    fail('paper_realized_between이 매도 사건을 세지 않습니다');
  }
  if (!/event_effective_at\s*>=\s*p_from/.test(rb)) {
    fail('paper_realized_between이 매도를 **사건 시각**으로 세지 않습니다 — '
       + '날짜가 마지막 청산일로 옮겨 갑니다');
  }
  if (!/pp\.realized_pnl\s*-\s*COALESCE\(\(SELECT SUM\(l\.lot_realized_pnl\)/.test(rb)) {
    fail('paper_realized_between이 legacy 몫을 빼지 않습니다 — 두 번 셉니다');
  }
}

// ══════════════ ⑨ 감시기의 시장별 가격 권위 (D4) ══════════════
//
// 뮤테이션: 전부 선물 마크가로 되돌림 / 청산가 null을 0으로.
{
  if (/getPremiumIndex/.test(exitm)) {
    fail(`${EXITM}: 선물 마크가를 직접 부릅니다 — 현물이 선물 가격으로 닫힙니다`);
  }
  if (!/readPaperMarkPrice\(/.test(exitm)) {
    fail(`${EXITM}: 시장별 가격 정본(readPaperMarkPrice)을 쓰지 않습니다`);
  }
  if (!/select\(['"][^'"]*\bmarket\b/.test(exitm)) {
    fail(`${EXITM}: market 칸을 읽지 않습니다 — 시장을 모르면 가를 수 없습니다`);
  }
  if (!/exitMarkPairs\(/.test(exitm) || !/exitMarkKey\b/.test(exitm)) {
    fail(`${EXITM}: 지도 키를 paperExitMarks에서 가져오지 않습니다`);
  }
  if (!/exitLiquidationOf\(/.test(exitm)) {
    fail(`${EXITM}: 청산가를 exitLiquidationOf로 읽지 않습니다`);
  }
  if (/liquidationPrice:\s*Number\(/.test(exitm)) {
    fail(`${EXITM}: 청산가를 Number()로 바로 읽습니다 — Number(null)은 0입니다`);
  }
  // 순수 모듈 쪽 계약.
  if (!/m === 'SPOT' \|\| m === 'USDM' \? m : null/.test(marks)) {
    fail(`${MARKS}: 모르는 시장을 null로 돌려주지 않습니다 — USDM으로 흘러갑니다`);
  }
  if (!/if \(v == null \|\| v === ''\) return undefined/.test(marks)) {
    fail(`${MARKS}: 없는 청산가를 undefined로 돌려주지 않습니다`);
  }
  if (!/if \(!market \|\| !symbol\) continue/.test(marks)) {
    fail(`${MARKS}: 시장/심볼을 모르는 줄을 쌍에서 빼지 않습니다`);
  }
  // **키가 시장을 담고 있는가.** `exitMarkKey`를 부르는지만 보면, 그 함수가
  // 심볼만 돌려주도록 바뀌어도 통과한다 — 그러면 같은 심볼의 현물과 선물이
  // 한 칸을 덮어쓰고 나중에 넣은 가격이 둘 다 판정한다. 뮤테이션에서 실제로
  // 새 나간 자리다. 이름이 아니라 **만들어지는 값의 모양**을 본다.
  const keyFn = marks.match(/export function exitMarkKey[\s\S]*?\n\}/)?.[0] ?? '';
  if (!/exitMarketOf\(row\)/.test(keyFn)) {
    fail(`${MARKS}: exitMarkKey가 시장을 키에 넣지 않습니다 — `
       + '같은 심볼의 현물과 선물이 한 칸을 덮어씁니다');
  }
  if (!/\$\{String\(row\?\.symbol/.test(keyFn)) {
    fail(`${MARKS}: exitMarkKey가 심볼을 키에 넣지 않습니다`);
  }
  const pairFn = marks.match(/export function exitMarkPairs[\s\S]*?\n\}/)?.[0] ?? '';
  if (!/\$\{market\}:\$\{symbol\}/.test(pairFn)) {
    fail(`${MARKS}: exitMarkPairs의 키가 시장:심볼 모양이 아닙니다 — `
       + 'exitMarkKey와 갈리면 시세를 받아 놓고 못 찾습니다');
  }
}

// ══════════════ ⑩ 멱등과 잠금 순서 ══════════════
{
  const sell = body('paper_sell_holding');
  if (!/UNIQUE \(paper_account_id, client_sell_id\)/.test(sql)) {
    fail('매도 멱등키가 (계좌, 클라이언트 식별자)가 아닙니다 — '
       + '계좌가 빠지면 남의 계좌와 충돌할 수 있습니다');
  }
  if (!/'REPLAYED'/.test(sell) || !/'CONFLICT'/.test(sell)) {
    fail('재시도(REPLAYED)와 충돌(CONFLICT)을 구분하지 않습니다');
  }
  if (!/request_fingerprint IS DISTINCT FROM v_fp/.test(sell)) {
    fail('같은 식별자로 다른 내용이 와도 그냥 재생합니다');
  }
  // 잠금 순서: 계좌 → 챌린지 → 포지션.
  const iAcct = sell.indexOf('paper_accounts');
  const iChal = sell.indexOf('paper_challenges');
  const iPos  = sell.search(/paper_positions[\s\S]*?FOR UPDATE/);
  if (iAcct < 0 || iChal < 0 || iPos < 0 || !(iAcct < iChal && iChal < iPos)) {
    fail('잠금 순서가 계좌 → 챌린지 → 포지션이 아닙니다 — 기존 경로와 순환이 생깁니다');
  }
  if (!/FROM public\.paper_accounts a[\s\S]{0,200}a\.user_id = p_user[\s\S]{0,80}FOR UPDATE/.test(sell)) {
    fail('계좌를 잠글 때 소유자를 함께 보지 않습니다');
  }
  if (!/paper_challenge_judge\(/.test(sell)) {
    fail('매도가 달성·실패 판정을 부르지 않습니다 — 판정이 두 경로에만 있게 됩니다');
  }
  if (!/paper_event_time_guard\(/.test(sell)) {
    fail('매도가 사건 시각 신선도를 보지 않습니다');
  }
}

// ══════════════ ⑪ 기존 파일을 고치지 않았다 ══════════════
//
// 이미 production에 적용된 마이그레이션을 고치면 replay와 실제 이력이 갈린다.
{
  const m86 = readFileSync('supabase/migrations/086_paper_challenge_finalizer.sql', 'utf8');
  if (/remaining_entry_fee_basis|open_quantity|paper_sell_holding|v_prior/.test(m86)) {
    fail('086 파일이 088의 내용을 담고 있습니다 — 적용된 마이그레이션을 고쳤습니다');
  }
  for (const n of ['083_paper_challenge_core', '084_paper_open_position_ambiguity',
                   '085_paper_challenge_accounting', '087_paper_challenge_cancel']) {
    const s = readFileSync(`supabase/migrations/${n}.sql`, 'utf8');
    if (/paper_sell_holding|remaining_entry_fee_basis|paper_sell_events/.test(s)) {
      fail(`${n}이 088의 내용을 담고 있습니다 — 적용된 마이그레이션을 고쳤습니다`);
    }
  }
  // 새 함수는 088에서 덮는다.
  if (!/CREATE OR REPLACE FUNCTION public\.paper_settle_close\(/.test(sql)) {
    fail('088이 paper_settle_close를 덮지 않습니다 — A2가 적용되지 않습니다');
  }
  if (!/CREATE OR REPLACE FUNCTION public\.paper_open_position\(/.test(sql)) {
    fail('088이 paper_open_position을 덮지 않습니다 — 새 줄에 원 체결 증거가 안 적힙니다');
  }
  if (/\bDROP FUNCTION\b/.test(sql)) {
    fail('088이 함수를 지웁니다 — 이 변경은 더하기만 해야 합니다');
  }
  // 진입이 증거 칸을 실제로 적는가.
  const open = body('paper_open_position');
  if (!/open_quantity, open_notional, open_margin, remaining_entry_fee_basis/.test(open)) {
    fail('paper_open_position이 원 체결 증거 칸을 INSERT하지 않습니다');
  }
}

// ══════════════ ⑫ 운영 감사가 migrate **뒤에** 돈다 ══════════════
//
// 뮤테이션: 트리거를 `push: main`으로 되돌린다 → migrate와 동시에 떠서
// **088이 적용되기 전** 스키마를 읽고 FALSE/UNKNOWN을 적는다. 없는 고장을
// 보고하는 감사가 되고, 그걸 한 번 믿으면 다음부터 아무도 안 본다.
{
  if (!audit) fail(`${AUDIT}가 없습니다 — 활성화 뒤 검증 장치가 없습니다`);

  // 트리거가 workflow_run이고, push가 아니어야 한다.
  const on = audit.match(/\non:\n([\s\S]*?)\nconcurrency:/)?.[1] ?? '';
  if (!/workflow_run:/.test(on) || !/workflows:\s*\[migrate\]/.test(on)) {
    fail(`${AUDIT}: migrate 완료에 걸리지 않았습니다 — 적용 전 스키마를 읽게 됩니다`);
  }
  if (/^\s*push:/m.test(on)) {
    fail(`${AUDIT}: push 트리거가 있습니다 — migrate와 경합합니다`);
  }
  // 성공·main 두 조건을 모두 본다.
  if (!/workflow_run\.conclusion\s*==\s*'success'/.test(audit)) {
    fail(`${AUDIT}: 깨운 실행의 성공 여부를 보지 않습니다`);
  }
  if (!/workflow_run\.head_branch\s*==\s*'main'/.test(audit)) {
    fail(`${AUDIT}: 깨운 실행이 main인지 보지 않습니다`);
  }
  // 특권 경로는 기본 브랜치 코드만 돈다.
  if (!/uses:\s*actions\/checkout@v4[\s\S]{0,120}ref:\s*main/.test(audit)) {
    fail(`${AUDIT}: 체크아웃이 main으로 고정돼 있지 않습니다 — 깨운 커밋의 코드가 secret을 쥡니다`);
  }
  // 감사 대상 커밋 == 활성화 커밋.
  if (!/ACTIVATION_SHA/.test(audit) || !/here.*!=.*ACTIVATION_SHA|ACTIVATION_SHA.*!=.*here/.test(audit)) {
    fail(`${AUDIT}: 활성화 커밋과 감사 커밋이 같은지 확인하지 않습니다`);
  }

  // 읽기 전용 — 선언만이 아니라 **값으로** 확인해야 한다.
  if ((audit.match(/BEGIN TRANSACTION READ ONLY/g) || []).length < 2) {
    fail(`${AUDIT}: 읽기 전용 트랜잭션으로 열지 않는 질의가 있습니다`);
  }
  if ((audit.match(/READ_ONLY=on/g) || []).length < 2) {
    fail(`${AUDIT}: 읽기 전용이었다는 증거를 값으로 확인하지 않습니다`);
  }
  // **돈을 움직이는 RPC를 부르지 않는다.** 카탈로그에서 이름을 문자열로
  // 보는 것은 호출이 아니다 — 호출 모양만 잡는다.
  for (const fn of ['paper_sell_holding', 'paper_settle_close', 'paper_open_position',
                    'paper_money_apply', 'paper_challenge_create']) {
    if (new RegExp(`public\\.${fn}\\s*\\(`).test(audit)) {
      fail(`${AUDIT}: ${fn}을 호출합니다 — 감사는 읽기만 해야 합니다`);
    }
  }
  // 쓰기 문장이 없어야 한다 (SQL 본문 기준).
  if (/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|DROP\s+|ALTER\s+TABLE|TRUNCATE)\b/.test(audit)) {
    fail(`${AUDIT}: 쓰기 문장이 있습니다`);
  }

  // ★ 대조는 **챌린지 전용 계좌만**. 일반 계좌에는 챌린지 원장이 없다.
  if (!/FROM public\.paper_challenges c\s*\n\s*JOIN public\.paper_accounts a ON a\.id = c\.paper_account_id/.test(audit)) {
    fail(`${AUDIT}: 잔고-원장 대조가 챌린지 전용 계좌로 한정돼 있지 않습니다 — `
       + '일반 PAPER 계좌가 전부 FALSE로 잡힙니다');
  }
  if (!/acct_shared_by_challenges/.test(audit)) {
    fail(`${AUDIT}: 챌린지 ↔ 전용 계좌 1:1을 확인하지 않습니다`);
  }

  // ★ backfill 등식은 **아직 처분되지 않은 열린 줄에만** 건다.
  //   거래가 일어나면 정상적으로 달라진다 — 불변식으로 만들면 다음 감사가
  //   멀쩡한 운영을 FALSE로 적는다.
  if (!/NOT EXISTS \(SELECT 1 FROM public\.paper_sell_event_lots l[\s\S]{0,120}WHERE l\.position_id = pp\.id\)/.test(audit)) {
    fail(`${AUDIT}: backfill 등식이 처분 이력이 없는 줄로 한정돼 있지 않습니다`);
  }
  if (!/pp\.status = 'open'/.test(audit)) {
    fail(`${AUDIT}: backfill 등식이 열린 줄로 한정돼 있지 않습니다`);
  }

  // UNKNOWN을 통과로 바꾸지 않는다.
  if (!/if \[ "\$\{u\}" -gt 0 \]; then\s*\n\s*verdict='UNKNOWN'/.test(audit)) {
    fail(`${AUDIT}: UNKNOWN이 있어도 판정을 내립니다`);
  }
  if (!/verdict.*!=.*'MATCH'[\s\S]{0,200}exit 1/.test(audit)) {
    fail(`${AUDIT}: MATCH가 아닌데 성공으로 끝납니다`);
  }
  // 접속 정보를 로그에 흘리지 않는다.
  if (!/sed -E 's#postgres/.test(audit)) {
    fail(`${AUDIT}: psql 출력에서 접속 정보를 가리지 않습니다`);
  }
}

// ══════════════ ⑬ 재생 게이트에 088이 걸려 있다 ══════════════
//
// 만들어 놓고 안 거는 것이 이 저장소의 1번 고장이다. 실제로 088의 증명이
// 재생에 안 걸려 있어서, freeze 결함이 086 단계를 대신 죽였다.
{
  for (const need of ['scripts/sql/088_paper_spot_holdings_proof.sql',
                      'scripts/paper-spot-holdings-concurrency.sh',
                      'scripts/paper-spot-holdings-mutations.mjs']) {
    if (!replay.includes(need)) {
      fail(`${REPLAY}: ${need}이 걸려 있지 않습니다 — 재생이 088을 검사하지 않습니다`);
    }
  }
  // 경로 목록에도 있어야 파일이 바뀔 때 재생이 깨어난다.
  if ((replay.match(/scripts\/paper-spot-holdings-concurrency\.sh/g) || []).length < 3) {
    fail(`${REPLAY}: 088 스크립트가 pull_request·push 경로 목록에 없습니다 — `
       + '그 파일만 고치면 재생이 안 돕니다');
  }
  // 0건을 통과로 적지 않는다.
  if (!/n_ok.*-lt 90/.test(replay)) {
    fail(`${REPLAY}: 088 증명의 확인 건수 하한이 없습니다`);
  }
  if (!/n_red.*-lt 30/.test(replay)) {
    fail(`${REPLAY}: 088 뮤테이션의 RED 하한이 없습니다`);
  }
}

// ══════════════ ⑭ 증명이 존재하고 배선돼 있다 ══════════════
{
  for (const p of ['scripts/sql/088_paper_spot_holdings_proof.sql',
                   'scripts/paper-spot-holdings-concurrency.sh']) {
    if (!existsSync(p)) fail(`${p}가 없습니다 — 실행 증명 없이 회계를 바꿉니다`);
  }
  const proof = readFileSync('scripts/sql/088_paper_spot_holdings_proof.sql', 'utf8');
  if (!/ROLLBACK;\s*$/.test(proof.trim())) {
    fail('증명이 ROLLBACK으로 끝나지 않습니다 — 검사가 DB에 자국을 남깁니다');
  }
  for (const need of ['E1 잔고가 정확히 같다', 'D1 trade_count', 'C1 entry_fee',
                      'DL 오늘 창', 'oversell', '멱등']) {
    if (!proof.includes(need)) fail(`증명에 "${need}" 항목이 없습니다`);
  }
}

if (bad > 0) {
  console.error(`\n현물 분할매도 계약 검사 실패 ${bad}건`);
  process.exit(1);
}
console.log('현물 분할매도 계약 검사 통과');

#!/usr/bin/env node
// scripts/paper-spot-holdings-mutations.mjs
//
// **계약을 하나씩 무력화하고, 그때 검사가 빨개지는지 본다.**
//
// 통과하는 검사만 보고는 "이 규칙을 아무도 안 지켜본다"를 구별할 수 없다.
// 이 저장소에서 규칙이 뮤테이션을 통과시킨 적이 세 번 있고 전부 같은 이유였다
// — **낱말만 찾고 조건의 모양을 안 봤다.**
//
// 무엇이 빨개져야 통과인가
// ────────────────────────
// 계약 검사기(`scripts/check-paper-spot-holdings.mjs`)가 실패하면 RED다.
// `PAPER_DB_URL`(또는 `PG*`)이 있으면 **실행 증명**
// (`scripts/sql/088_..._proof.sql`)도 함께 돌려서, 글자가 아니라 **실제 회계**가
// 깨지는 것까지 본다. 둘 중 하나라도 빨개지면 RED다.
//
// 대조군
// ──────
// 주석 한 줄을 더하는 변경은 **GREEN이어야 한다.** 대조군이 없으면
// "무엇을 해도 빨개지는" 검사기가 만점을 받는다 — 실제로 한 번 그랬다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const MIG   = 'supabase/migrations/088_paper_spot_holdings.sql';
const STORE = 'src/lib/engine/paperStore.ts';
const DAILY = 'src/lib/risk/dailyLossCheck.ts';
const EXITM = 'src/app/api/paper/exit-monitor/route.ts';
const MARKS = 'src/lib/engine/paperExitMarks.ts';
const SELLR = 'src/app/api/paper/sell/route.ts';
const SCOPE = 'src/lib/engine/paperHoldingScope.ts';
const CHECK = 'scripts/check-paper-spot-holdings.mjs';
const AUDIT = '.github/workflows/audit-production-paper-spot-holdings.yml';
const REPLAY = '.github/workflows/supabase-replay.yml';
const PROOF = 'scripts/sql/088_paper_spot_holdings_proof.sql';

const ONLY = process.argv.slice(2).filter(a => !a.startsWith('-'));

// DB가 있으면 실행 증명도 게이트에 넣는다. 없으면 검사기만 본다 —
// **없는 것을 통과로 적지 않는다.** 아래 보고에 어느 게이트가 돌았는지 적는다.
const DB = process.env.PAPER_DB_URL || '';
const PG = process.env.PGHOST && process.env.PGPORT && process.env.PGUSER && process.env.PGDATABASE;
const HAS_DB = Boolean(DB || PG);

function runChecker() {
  const r = spawnSync(process.execPath, [CHECK], { encoding: 'utf8' });
  return r.status === 0;
}

function runProof() {
  if (!HAS_DB) return true;              // 게이트에 없는 것은 통과로 본다
  const args = ['-v', 'ON_ERROR_STOP=1', '-f', PROOF];
  const r = DB
    ? spawnSync('psql', [DB, ...args], { encoding: 'utf8' })
    : spawnSync('psql', args, { encoding: 'utf8' });
  return r.status === 0;
}

// 마이그레이션을 고친 뒤에는 **다시 적용해야** 실행 증명이 그 변경을 본다.
function reapplyMigration() {
  if (!HAS_DB) return true;
  const args = ['-q', '-v', 'ON_ERROR_STOP=1', '-f', MIG];
  const r = DB
    ? spawnSync('psql', [DB, ...args], { encoding: 'utf8' })
    : spawnSync('psql', args, { encoding: 'utf8' });
  // 적용 자체가 실패하는 변이도 RED다 (깨진 SQL을 통과로 적지 않는다).
  return r.status === 0;
}

/** 게이트 전체. 하나라도 빨개지면 RED다. */
function gatesPass(touchedMigration) {
  if (touchedMigration && !reapplyMigration()) return false;
  if (!runChecker()) return false;
  return runProof();
}

const CASES = [
  // ── ① 매도 원장의 신원 ──
  ['MUT-01 매도 원장을 POSITION_CLOSE/position_id로 되돌린다', MIG, 'RED',
   [[`'POSITION_SELL', v_sell::TEXT, p_event_effective_at) THEN
    RAISE EXCEPTION 'paper_sell_holding: 이 매도의 실현손익이 이미 적혀 있습니다 — 되돌립니다';`,
     `'POSITION_CLOSE', v_ids[1]::TEXT, p_event_effective_at) THEN
    RAISE EXCEPTION 'paper_sell_holding: 이 매도의 실현손익이 이미 적혀 있습니다 — 되돌립니다';`]]],

  // ── ② 과거 진입 수수료를 깎는다 ──
  ['MUT-02 historical entry_fee를 남은 값처럼 감소시킨다', MIG, 'RED',
   [['             remaining_entry_fee_basis = pp.remaining_entry_fee_basis - v_es',
     '             remaining_entry_fee_basis = pp.remaining_entry_fee_basis - v_es,\n             entry_fee = pp.entry_fee - v_es']]],

  ['MUT-03 freeze 트리거에서 entry_fee 보호를 뺀다', MIG, 'RED',
   [['  IF (OLD.entry_fee     IS NOT NULL AND NEW.entry_fee     IS DISTINCT FROM OLD.entry_fee)\n  OR (OLD.open_quantity IS NOT NULL AND NEW.open_quantity IS DISTINCT FROM OLD.open_quantity)',
     '  IF (OLD.open_quantity IS NOT NULL AND NEW.open_quantity IS DISTINCT FROM OLD.open_quantity)']]],

  // ── freeze가 자기 backfill을 막는 회귀 ──
  //
  //   이 두 가지가 CI 재생을 실제로 빨갛게 만들었다. 되돌리면 다시 RED여야 한다.
  ['MUT-03b freeze가 "처음 채우기"까지 막는다 (backfill이 자기 트리거에 막힌다)', MIG, 'RED',
   [['  IF (OLD.entry_fee     IS NOT NULL AND NEW.entry_fee     IS DISTINCT FROM OLD.entry_fee)',
     '  IF (NEW.entry_fee IS DISTINCT FROM OLD.entry_fee)']]],

  ['MUT-03c freeze 트리거를 backfill 뒤로 되돌린다', MIG, 'RED',
   [['CREATE TRIGGER paper_positions_freeze_open_trg\n  BEFORE UPDATE ON public.paper_positions\n  FOR EACH ROW\n  EXECUTE FUNCTION public.paper_positions_freeze_open_cols();',
     '-- (트리거 생성을 뒤로 옮겼다)']]],

  // ── ③ legacy 청산이 과거 수수료를 쓴다 (A1 되돌림) ──
  ['MUT-04 legacy 청산이 historical entry_fee를 쓴다', STORE, 'RED',
   [['entryFee: remainingEntryFeeBasis(pos),', 'entryFee: Number(pos.entry_fee),']]],

  ['MUT-05 remainingEntryFeeBasis가 0을 "없음"으로 읽는다', STORE, 'RED',
   [['  if (basis == null) return Number(pos?.entry_fee);', '  if (!basis) return Number(pos?.entry_fee);']]],

  // ── ④ 통계 (D1 / A2) ──
  ['MUT-06 부분매도마다 trade_count를 올린다', MIG, 'RED',
   [['         trade_count  = trade_count + v_closed,', '         trade_count  = trade_count + 1,']]],

  ['MUT-07 최종 승패에서 앞선 부분매도를 뺀다 (A2 되돌림)', MIG, 'RED',
   [['                     + CASE WHEN (v_prior + p_realized_pnl) > 0 THEN 1 ELSE 0 END',
     '                     + CASE WHEN p_realized_pnl > 0 THEN 1 ELSE 0 END']]],

  ['MUT-08 매도의 승패를 조각 단위로 센다', MIG, 'RED',
   [['      IF v_cum > 0 THEN v_wins := v_wins + 1; END IF;',
     '      IF v_lr > 0 THEN v_wins := v_wins + 1; END IF;']]],

  // ── ⑤ oversell ──
  ['MUT-09 보유 초과 매도를 허용한다', MIG, 'RED',
   [[`  IF v_sold > v_held THEN`, `  IF FALSE THEN`]]],

  ['MUT-10 배분 잔여가 남아도 진행한다', MIG, 'RED',
   [['  IF v_residue <> 0 THEN\n    RAISE EXCEPTION \'paper_sell_holding: 배분 잔여가 남았습니다 (%) — 되돌립니다\', v_residue;\n  END IF;',
     '  IF FALSE THEN\n    RAISE EXCEPTION \'paper_sell_holding: 배분 잔여가 남았습니다 (%) — 되돌립니다\', v_residue;\n  END IF;']]],

  ['MUT-11 전량매도가 비례 나눗셈을 탄다 (dust가 남는다)', MIG, 'RED',
   [['    IF p_percent = 100 THEN\n      v_sold := v_held;\n    ELSE\n      v_sold := public.paper_floor_at(v_held * p_percent / 100, v_scale);\n    END IF;',
     '    v_sold := public.paper_floor_at(v_held * p_percent / 100, v_scale);']]],

  ['MUT-12 배분을 내림 대신 반올림으로 바꾼다', MIG, 'RED',
   [['  RETURN FLOOR(p_value * v_f) / v_f;', '  RETURN ROUND(p_value * v_f) / v_f;']]],

  // ── ⑥ money authority가 JS로 ──
  ['MUT-13 라우트가 손익을 계산해 RPC에 넘긴다', SELLR, 'RED',
   [['      p_exit_price: px.price,', '      p_exit_price: px.price,\n      p_gross: 0,']]],

  ['MUT-14 청산가를 화면이 보낸 값으로 쓴다', SELLR, 'RED',
   [["  const px = await readPaperMarkPrice('SPOT', symbol);",
     "  const px = { ok: true, price: Number(body?.exitPrice), source: 'client', market: 'SPOT' } as any;"]]],

  ['MUT-15 요청 본문에서 계좌 id를 받는다', SELLR, 'RED',
   [['  const scope = await resolveHoldingScope(sb, uid, body?.challengeId);',
     '  const scope = { ok: true, accountId: String(body?.paperAccountId || \'\'), challengeId: null } as any;']]],

  // ── ⑦ 장부 fallback ──
  ['MUT-16 챌린지를 못 풀면 기본 계좌로 내려간다', SCOPE, 'RED',
   [[`      return {
        ok: false,
        code: unreadable ? 'UNREADABLE' : 'NOT_FOUND',
        reason: cs.reason,
        status: unreadable ? 503 : 404,
      };`,
     `      const { resolvePaperScope } = await import('./paperScope');
      const fb: any = await resolvePaperScope(sb, userId);
      return { ok: true, accountId: fb.accountId, challengeId: null };`]]],

  // ── ⑧ 하루 손실 ──
  ['MUT-17 하루 손실이 부분매도를 무시한다 (closed_at 합산으로 되돌림)', DAILY, 'RED',
   [[`    const { data, error } = acct == null
      ? { data: null, error: null }
      : await args.sb.rpc('paper_realized_between', {`,
     `    const { data, error } = acct == null
      ? { data: null, error: null }
      : await args.sb.from('paper_positions')
          .select('realized_pnl, closed_at')
          .eq('status', 'closed') as any as { data: any; error: any };
    const _unused = ({} as any) && ({`]]],

  ['MUT-18 하루 손실 조회 실패를 0으로 읽는다', DAILY, 'RED',
   [['    if (error) throw new Error(String((error as any).message ?? error));', '    ']]],

  ['MUT-19 paper_realized_between이 매도를 청산 시각으로 센다', MIG, 'RED',
   [['       AND e.event_effective_at >= p_from\n       AND e.event_effective_at <  p_to',
     '       AND e.recorded_at >= p_from\n       AND e.recorded_at <  p_to']]],

  ['MUT-20 paper_realized_between이 legacy 몫을 두 번 센다', MIG, 'RED',
   [[`             pp.realized_pnl
             - COALESCE((SELECT SUM(l.lot_realized_pnl)
                           FROM public.paper_sell_event_lots l
                          WHERE l.position_id = pp.id), 0)`,
     '             pp.realized_pnl']]],

  // ── ⑨ exit-monitor (D4) ──
  ['MUT-21 감시기가 현물에도 선물 마크가를 쓴다', EXITM, 'RED',
   [[`      const { readPaperMarkPrice, paperPriceFailed } =
        await import('@/lib/engine/paperPriceSource');
      const px = await readPaperMarkPrice(p.market, p.symbol);
      if (paperPriceFailed(px)) return;
      const v = Number(px.price);`,
     `      const { getPremiumIndex } = await import('@/lib/exchanges/binanceFutures');
      const px: any = await getPremiumIndex(p.symbol, false);
      const v = Number(px?.markPrice);`]]],

  ['MUT-22 감시기가 청산가 null을 0으로 읽는다', EXITM, 'RED',
   [['      liquidationPrice: exitLiquidationOf(r),',
     '      liquidationPrice: Number(r.liquidation_price),']]],

  ['MUT-23 모르는 시장을 USDM으로 흘려보낸다', MARKS, 'RED',
   [["  return m === 'SPOT' || m === 'USDM' ? m : null;", "  return m === 'SPOT' ? m : 'USDM';"]]],

  ['MUT-24 지도 키에서 시장을 뺀다 (같은 심볼이 서로 덮는다)', MARKS, 'RED',
   [["  return `${exitMarketOf(row) ?? ''}:${String(row?.symbol ?? '')}`;",
     "  return String(row?.symbol ?? '');"]]],

  // ── ⑩ 멱등 ──
  ['MUT-25 멱등키에서 계좌를 뺀다', MIG, 'RED',
   [['      UNIQUE (paper_account_id, client_sell_id);', '      UNIQUE (client_sell_id);']]],

  ['MUT-26 같은 식별자면 내용이 달라도 재생한다', MIG, 'RED',
   [['    IF v_prev.request_fingerprint IS DISTINCT FROM v_fp THEN', '    IF FALSE THEN']]],

  ['MUT-27 매도가 달성·실패 판정을 안 부른다', MIG, 'RED',
   [[`  PERFORM public.paper_challenge_judge(
    v_challenge, v_account, p_user, p_event_effective_at);

  v_rem := v_held - v_sold;`, '  v_rem := v_held - v_sold;']]],

  ['MUT-28 잠금 순서를 뒤집는다 (포지션을 계좌보다 먼저)', MIG, 'RED',
   [[`  SELECT a.id INTO v_account
    FROM public.paper_accounts a
   WHERE a.id = p_paper_account_id AND a.user_id = p_user
     FOR UPDATE;`,
     `  PERFORM pp.id FROM public.paper_positions pp
    WHERE pp.paper_account_id = p_paper_account_id FOR UPDATE;
  SELECT a.id INTO v_account
    FROM public.paper_accounts a
   WHERE a.id = p_paper_account_id AND a.user_id = p_user
     FOR UPDATE;`]]],

  // ── ⑪ 기존 마이그레이션 보호 ──
  ['MUT-29 088이 함수를 지운다 (더하기만 해야 한다)', MIG, 'RED',
   [['CREATE OR REPLACE FUNCTION public.paper_alloc_scale()',
     'DROP FUNCTION IF EXISTS public.paper_alloc_scale();\nCREATE OR REPLACE FUNCTION public.paper_alloc_scale()']]],

  // ── 운영 감사가 migrate와 경합한다 ──
  //
  //   이것들이 되돌아가면 감사가 **088 적용 전** 스키마를 읽고 없는 고장을
  //   보고한다. 한 번 그러면 다음부터 아무도 그 감사를 안 본다.
  ['MUT-30 감사를 push: main으로 되돌린다 (migrate와 경합)', AUDIT, 'RED',
   [['  workflow_run:\n    workflows: [migrate]\n    types: [completed]',
     '  push:\n    branches: [main]']]],

  ['MUT-31 감사가 깨운 실행의 성공 여부를 안 본다', AUDIT, 'RED',
   [["      github.event.workflow_run.conclusion == 'success' &&\n", '']]],

  ['MUT-32 감사가 main인지 안 본다', AUDIT, 'RED',
   [["      github.event.workflow_run.head_branch == 'main'",
     "      true"]]],

  ['MUT-33 감사 체크아웃을 깨운 커밋으로 바꾼다 (특권 경로)', AUDIT, 'RED',
   [['        with:\n          ref: main', '        with:\n          ref: ${{ github.event.workflow_run.head_sha }}']]],

  ['MUT-34 잔고-원장 대조를 모든 계좌로 넓힌다', AUDIT, 'RED',
   [['(SELECT count(*) FROM public.paper_challenges c\n                 JOIN public.paper_accounts a ON a.id = c.paper_account_id\n                WHERE a.balance IS DISTINCT FROM',
     '(SELECT count(*) FROM public.paper_accounts a\n                WHERE a.balance IS DISTINCT FROM']]],

  ['MUT-35 backfill 등식을 처분된 줄에까지 건다 (거래하면 FALSE가 된다)', AUDIT, 'RED',
   [['                  AND NOT EXISTS (SELECT 1 FROM public.paper_sell_event_lots l\n                                   WHERE l.position_id = pp.id)\n', '']]],

  ['MUT-36 감사가 UNKNOWN을 통과로 읽는다', AUDIT, 'RED',
   [['          if [ "${u}" -gt 0 ]; then\n            verdict=\'UNKNOWN\'', '          if [ "${u}" -gt 99999 ]; then\n            verdict=\'UNKNOWN\'']]],

  ['MUT-37 재생에서 088 증명 단계를 뺀다', REPLAY, 'RED',
   [['            -Xf scripts/sql/088_paper_spot_holdings_proof.sql \\',
     '            -Xf /dev/null \\']]],

  ['MUT-38 재생 088 증명의 건수 하한을 없앤다', REPLAY, 'RED',
   [['          if [ "${n_ok}" -lt 90 ]; then', '          if [ "${n_ok}" -lt 0 ]; then']]],

  // ── 대조군 (GREEN이어야 한다) ──
  ['OK1 마이그레이션에 주석 한 줄 추가', MIG, 'GREEN',
   [['-- 088_paper_spot_holdings.sql', '-- 088_paper_spot_holdings.sql\n-- 대조군']]],
  ['OK2 순수 모듈에 주석 한 줄 추가', MARKS, 'GREEN',
   [['export type MarkMarket', '// 대조군\nexport type MarkMarket']]],
  ['OK3 감사 워크플로에 주석 한 줄 추가', AUDIT, 'GREEN',
   [['name: audit-production-paper-spot-holdings',
     '# 대조군\nname: audit-production-paper-spot-holdings']]],
];

const selected = ONLY.length
  ? CASES.filter(c => ONLY.some(o => c[0].includes(o)))
  : CASES;

console.log(`게이트: 계약 검사기${HAS_DB ? ' + 실행 증명(DB)' : ' 만 (DB 없음 — 실행 증명은 돌지 않았습니다)'}`);
console.log(`총 ${selected.length}건\n`);

let detected = 0, missed = 0, noop = 0, greenOk = 0, greenBad = 0;

for (const [name, file, kind, cuts] of selected) {
  if (!existsSync(file)) { console.log(`  ⚠  ${name} — 파일이 없습니다`); noop += 1; continue; }
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const [from, to] of cuts) {
    if (!after.includes(from)) { after = before; break; }
    after = after.replace(from, to);
  }
  if (after === before) {
    console.log(`  ⚠  ${name} — NOOP · 적용되지 않음 → 판정 불가`);
    noop += 1; continue;
  }

  writeFileSync(file, after);
  let pass;
  try { pass = gatesPass(file === MIG); }
  finally { writeFileSync(file, before); if (file === MIG) reapplyMigration(); }

  if (kind === 'GREEN') {
    if (pass) { console.log(`  ✓  ${name} — PASS (과도 검출 없음)`); greenOk += 1; }
    else { console.log(`  ✗  ${name} — 정상 변경인데 실패했다 (과도 검출)`); greenBad += 1; }
  } else if (!pass) {
    console.log(`  ●  ${name} — RED (검출)`); detected += 1;
  } else {
    console.log(`  ✗  ${name} — GREEN (새 나감)`); missed += 1;
  }
}

console.log(`\n검출 ${detected} / 누락 ${missed} / 판정불가 ${noop}`
  + ` / 대조군 PASS ${greenOk} · 과도검출 ${greenBad}`);
process.exit(missed || greenBad || noop ? 1 : 0);

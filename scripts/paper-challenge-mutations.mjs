#!/usr/bin/env node
// scripts/paper-challenge-mutations.mjs
//
// **검사가 무엇을 지키는지, 망가뜨려 보고 확인한다.**
//
// 왜 필요한가
// ───────────
// 통과하는 검사는 두 가지를 뜻할 수 있다: 규칙이 지켜졌다, 또는 **검사가 그
// 규칙을 안 보고 있다.** 둘은 겉으로 똑같이 초록이다.
//
// 그래서 `085`의 규칙을 하나씩 일부러 깨뜨리고, 그때 실행 증명이 **빨개지는지**
// 본다. 안 빨개지면 그 규칙은 아무도 지키지 않는 것이다.
//
// 이 파일이 실제로 잡은 것
// ────────────────────────
// 처음 돌렸을 때 「진입의 사건 시각 검사 제거」가 초록이었다. 검사를 지워도
// 안쪽 `paper_money_apply`가 같은 `P0001`로 막아서, "들어오자마자 거부했다"와
// "원장까지 가서 거부했다"를 구별하지 못했기 때문이다. 트랜잭션이 통째로
// 되돌아가므로 남은 자취로도 구별할 수 없었다. 그래서 진입 계약에 전용
// SQLSTATE `22004`를 붙였고, 그제야 이 뮤테이션이 빨개졌다.
//
// 등가 뮤테이션
// ─────────────
// 어떤 방어는 둘이 서로를 가려 준다. `판정 재평가 방어`가 그렇다 — 조기 반환과
// CAS 조건 중 하나만 없애면 다른 하나가 막아서 **행동이 바뀌지 않는다.** 그런
// 짝은 `pair`로 묶어 둘을 같이 없애고, 그때 마지막 방어선(`083`의 freeze
// 트리거)이 드러나는지 본다. 하나만 없애도 초록인 것을 "검사 구멍"으로 적으면
// 틀린 보고가 된다.
//
// 어떻게 쓰는가
// ─────────────
//   PAPER_DB_URL=postgresql://... node scripts/paper-challenge-mutations.mjs
//   PGHOST=... PGPORT=... PGUSER=... PGDATABASE=... node scripts/paper-challenge-mutations.mjs
//
// 빈 로컬 DB에서만 돈다. 마이그레이션이 이미 적용된 상태를 전제한다.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MIG = 'supabase/migrations/085_paper_challenge_accounting.sql';
const GATES = [
  'scripts/sql/paper_rpc_runtime_smoke.sql',
  'scripts/sql/085_paper_challenge_accounting_proof.sql',
];
const CONCURRENCY = 'scripts/paper-challenge-concurrency.sh';

// ── 접속 정보 ──
//
// `PAPER_DB_URL`이 있으면 그것을, 없으면 `PG*` 환경변수를 쓴다. 포트·비밀번호를
// 이 파일에 박지 않는다 — 박으면 CLI가 포트를 바꾸는 날 조용히 다른 DB를 본다.
const DB = process.env.PAPER_DB_URL || '';

/**
 * 접속 URL에서 host만 뽑는다. **값은 출력하지 않는다** — 비밀번호가 들어 있다.
 *
 * 유닉스 소켓은 `postgresql://user@/db?host=/tmp/sock` 모양으로 온다. 권한 부분만
 * 보면 host가 빈 문자열이 되고, 그러면 멀쩡한 로컬 접속이 거부된다.
 * 못 읽으면 빈 문자열을 돌려주고, 부르는 쪽이 그것을 거부로 다룬다 —
 * **읽지 못한 것을 로컬로 보지 않는다.**
 */
function hostOf(url) {
  const q = /[?&]host=([^&]+)/.exec(url);
  if (q) return decodeURIComponent(q[1]);
  return url.replace(/^[a-z]+:\/\//, '').replace(/^[^@/]*@/, '').replace(/[:/?].*$/, '');
}

const host = DB ? hostOf(DB) : (process.env.PGHOST || '');

// ── 운영에 닿을 수 있는 환경에서는 시작하지 않는다 ──
//
// 이 검사는 함수를 **일부러 망가뜨린 판으로 바꿔 가며** 돈다. 운영에서 돌면
// 그 사이에 들어온 실제 호출이 망가진 함수를 쓴다.
if (!(host.startsWith('/') || ['localhost', '127.0.0.1', '::1', 'db', 'postgres'].includes(host))) {
  console.error(`거부: 접속 대상이 로컬이 아닙니다 (${host}) — 이 검사는 함수를 망가뜨리므로 로컬 빈 DB에서만 돕니다`);
  process.exit(1);
}
if (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL) {
  console.error('거부: SUPABASE_DB_URL/DATABASE_URL이 설정돼 있습니다 — 운영에 닿을 수 있는 환경입니다');
  process.exit(1);
}

/** 접속 URL이 있으면 첫 인자로 넘긴다. */
const conn = (args) => (DB ? [DB, ...args] : args);

const work = mkdtempSync(join(tmpdir(), 'pcm-'));
const canonical = readFileSync(MIG, 'utf8');

function psqlFile(path, { strict = false } = {}) {
  try {
    execFileSync('psql', conn(['-q', ...(strict ? ['-v', 'ON_ERROR_STOP=1'] : []), '-f', path]),
      { stdio: 'pipe', encoding: 'utf8' });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

/** 정본이든 뮤테이션이든, 이 SQL을 DB에 세운다. */
function install(sql) {
  const p = join(work, 'install.sql');
  writeFileSync(p, sql);
  return psqlFile(p, { strict: true }).ok;
}

/**
 * 실행 증명 전체. 하나라도 어긋나면 false.
 *
 * **종료 코드만 보지 않는다.** psql은 `\echo`까지 못 갔는데도 0으로 끝날 수
 * 있다(NOTICE만 내고 멈춘 경우). 그래서 마지막 통과 문구까지 확인한다 —
 * 확인하지 못한 것을 통과로 적지 않는다.
 */
function gatesPass() {
  for (const g of GATES) {
    let out;
    try {
      out = execFileSync('psql', conn(['-q', '-f', g]),
        { stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      return false;                       // 오류로 끝났다
    }
    if (!/전부 통과/.test(out)) return false;
  }
  try {
    execFileSync('bash', [CONCURRENCY], { stdio: 'pipe', encoding: 'utf8' });
  } catch {
    return false;
  }
  return true;
}

// ══════════════════ 무엇을 깨뜨려 보는가 ══════════════════
//
// `cuts`가 여러 개인 항목은 **서로를 가려 주는 짝**이다. 하나만 없애면 행동이
// 바뀌지 않으므로(등가 뮤테이션) 같이 없앤다.
const MUTATIONS = [
  {
    name: '선점 CAS의 계좌 조건 제거 — 옮겨간 포지션의 돈이 엉뚱한 계좌로 간다',
    cuts: [['     AND COALESCE(pp.paper_account_id, v_account) = v_account\n', '']],
  },
  {
    name: '사용자 advisory 잠금 제거 — 동시 생성이 둘 다 통과한다',
    cuts: [['  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 0));', '']],
  },
  {
    name: '원장 멱등(ON CONFLICT) 제거',
    cuts: [['    ON CONFLICT ON CONSTRAINT paper_challenge_cashflows_idem_key DO NOTHING\n    RETURNING id INTO v_row;',
            '    RETURNING id INTO v_row;']],
  },
  {
    name: '이미 적힌 사건인데 잔고를 또 민다',
    cuts: [['    IF v_row IS NULL THEN\n      RETURN FALSE;\n    END IF;', '']],
  },
  {
    name: '진입의 사건 시각 검사 제거 — 원장까지 가서야 실패한다',
    cuts: [["  IF p_event_effective_at IS NULL THEN\n    RAISE EXCEPTION USING ERRCODE = '22004',\n      MESSAGE = 'paper_open_position: 사건 시각이 없습니다 — 아무것도 만들지 않습니다';\n  END IF;", '']],
  },
  {
    name: '청산의 사건 시각 검사 제거',
    cuts: [["  IF p_event_effective_at IS NULL THEN\n    RAISE EXCEPTION USING ERRCODE = '22004',\n      MESSAGE = 'paper_settle_close: 사건 시각이 없습니다 — 포지션도 닫지 않습니다';\n  END IF;", '']],
  },
  {
    name: '생성의 사건 시각 검사 제거',
    cuts: [["  IF p_event_effective_at IS NULL THEN\n    RAISE EXCEPTION USING ERRCODE = '22004',\n      MESSAGE = 'paper_challenge_create: 사건 시각이 없습니다 — 계좌도 만들지 않습니다';\n  END IF;", '']],
  },
  {
    name: '달성의 ends_at 상한 제거 — 기간 밖 통과가 달성이 된다',
    cuts: [['     AND p_event_at <= v_ch.ends_at THEN', '     THEN']],
  },
  {
    name: '달성의 starts_at 하한 제거',
    cuts: [['     AND p_event_at >= v_ch.starts_at\n', '']],
  },
  {
    name: '판정 재평가 방어를 **둘 다** 제거 (조기 반환 + CAS) — 서로를 가려 주는 짝이다',
    cuts: [
      ["  IF v_ch.close_intent IS NOT NULL OR v_ch.status NOT IN ('READY', 'RUNNING') THEN\n    RETURN NULL;\n  END IF;", ''],
      ['     AND c.close_intent IS NULL;      -- CAS. 남이 먼저 정했으면 그대로 둔다', '     ;'],
    ],
  },
  {
    name: 'legacy paper_deposit의 챌린지 계좌 가드 제거',
    cuts: [["  IF public.paper_is_challenge_account(v_account) THEN\n    RAISE EXCEPTION\n      'paper_deposit: 챌린지 전용 계좌입니다 (%) — 챌린지 잔고는 챌린지 회계 경로로만 움직입니다',\n      v_account;\n  END IF;", '']],
  },
  {
    name: 'legacy paper_apply_entry_fee의 챌린지 계좌 가드 제거',
    cuts: [["  IF public.paper_is_challenge_account(v_account) THEN\n    RAISE EXCEPTION\n      'paper_apply_entry_fee: 챌린지 전용 계좌입니다 (%) — 챌린지 수수료는 paper_open_position이 적습니다',\n      v_account;\n  END IF;", '']],
  },
  {
    name: '진입 경로에서 판정 호출 제거 — 수수료가 실패선을 넘겨도 모른다',
    cuts: [['  PERFORM public.paper_challenge_judge(\n    v_challenge, v_account, p_user_id, p_event_effective_at);', '']],
  },
  {
    name: '청산 경로에서 판정 호출 제거',
    cuts: [['  PERFORM public.paper_challenge_judge(\n    v_challenge, v_account, v_owner, p_event_effective_at);', '']],
  },
  {
    name: '시작금을 원장 없이 계좌에 바로 넣는다 — 첫 순간부터 불변식이 깨진다',
    cuts: [['  VALUES (p_user_id, FALSE, 0, p_initial_equity)', '  VALUES (p_user_id, FALSE, p_initial_equity, p_initial_equity)']],
  },
  {
    name: '진입 수수료를 원장에 안 적고 잔고만 깎는다',
    cuts: [["  IF NOT public.paper_money_apply(\n      v_account, p_user_id, 'TRADING_FEE', -p_entry_fee,\n      'POSITION_OPEN', v_id::TEXT, p_event_effective_at) THEN\n    RAISE EXCEPTION\n      'paper_open_position: 이 포지션의 진입 수수료가 이미 적혀 있습니다 (%) — 되돌립니다', v_id;\n  END IF;",
            '  UPDATE public.paper_accounts a SET balance = a.balance - p_entry_fee WHERE a.id = v_account;']],
  },
  {
    name: '실현손익을 gross가 아니라 순액으로 적는다 — 수수료가 두 번 빠진다',
    cuts: [["    v_account, v_owner, 'REALIZED_PNL', p_gross_pnl,", "    v_account, v_owner, 'REALIZED_PNL', p_realized_pnl,"]],
  },
  {
    name: '청산 수수료를 양수로 적는다 — 원장 합계가 잔고와 갈린다',
    cuts: [["    v_account, v_owner, 'TRADING_FEE', -p_exit_fee,", "    v_account, v_owner, 'TRADING_FEE', p_exit_fee,"]],
  },
  {
    name: '판정을 실현 잔고가 아니라 initial_balance로 한다 — NAV 판정과 같은 부류의 오류',
    cuts: [['  SELECT a.balance INTO v_balance\n    FROM public.paper_accounts a WHERE a.id = p_account;',
            '  SELECT a.initial_balance INTO v_balance\n    FROM public.paper_accounts a WHERE a.id = p_account;']],
  },
];

// ══════════════════ 돌린다 ══════════════════
let anchorFails = 0, survivors = 0;

console.log('── 정본 기준선 ──');
if (!install(canonical)) { console.error('정본을 세우지 못했습니다'); process.exit(1); }
const baseline = gatesPass();
console.log(baseline ? '  ✓ 정본 GREEN' : '  ✗ 정본이 빨갛다 — 아래 결과는 의미가 없다');
if (!baseline) process.exit(1);

console.log('\n── 뮤테이션 ──');
for (const m of MUTATIONS) {
  let sql = canonical, missing = null;
  for (const [old, next] of m.cuts) {
    if (!sql.includes(old)) { missing = old.slice(0, 70); break; }
    sql = sql.replace(old, next);
  }
  if (missing !== null) {
    // **적용되지 않은 뮤테이션을 통과로 적지 않는다.** 앵커가 낡으면 아무것도
    // 깨뜨리지 않은 채 초록이 나오고, 그것을 "규칙이 지켜진다"로 읽게 된다.
    console.log(`  ‼ ${m.name}\n      앵커가 낡았습니다: ${JSON.stringify(missing)}`);
    anchorFails++;
    continue;
  }
  if (!install(sql)) {
    // 함수가 아예 안 세워지는 것도 RED다 — 깨뜨린 것이 드러났다.
    console.log(`  ✓ ${m.name}\n      RED (뮤테이션이 세워지지도 않았다)`);
    install(canonical);
    continue;
  }
  const stillGreen = gatesPass();
  if (stillGreen) { console.log(`  ✗ ${m.name}\n      초록이다 — 이 규칙을 지키는 검사가 없다`); survivors++; }
  else console.log(`  ✓ ${m.name}\n      RED`);
  install(canonical);
}

console.log('\n── 주석만 바꾼 대조군 ──');
const ctrl = canonical.replace('-- ⑧ 판정.', '-- ⑧ 판정 (대조군: 주석만 바꿨다).');
if (ctrl === canonical) { console.log('  ‼ 대조군 앵커가 낡았습니다'); anchorFails++; }
else {
  install(ctrl);
  const ctrlGreen = gatesPass();
  console.log(ctrlGreen
    ? '  ✓ 주석만 바꾼 판은 GREEN — 검사가 글자에 반응하지 않는다'
    : '  ✗ 주석만 바꿨는데 빨갛다 — 검사가 조건이 아니라 글자를 보고 있다');
  if (!ctrlGreen) survivors++;
  install(canonical);
}

install(canonical);
console.log('');
if (anchorFails || survivors) {
  console.log(`뮤테이션 검사 실패 — 살아남은 뮤테이션 ${survivors}건 · 낡은 앵커 ${anchorFails}건`);
  process.exit(1);
}
console.log(`뮤테이션 ${MUTATIONS.length}건 전부 RED · 주석 대조군 GREEN`);

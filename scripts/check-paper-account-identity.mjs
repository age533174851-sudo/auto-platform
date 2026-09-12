#!/usr/bin/env node
// scripts/check-paper-account-identity.mjs
//
// **모의 계좌가 여럿이 될 수 있게 된 뒤에도, 기존 경로가 기본 계좌로 가는가.**
//
// 무엇이 위험한가
// ───────────────
// `paper_accounts`의 기본키가 `user_id`였다. 사용자당 계좌가 하나라는 뜻이고,
// 그 가정 위에 제품 코드가 `eq('user_id', …).maybeSingle()`로 계좌를 읽는다.
//
// 계좌가 여럿이 될 수 있게 되는 순간 그 질의는 **여러 줄을 돌려주고
// `maybeSingle()`이 던진다.** 화면이 통째로 죽는다. 지금은 계좌가 하나뿐이라
// 증상이 안 보이지만, 챌린지 계좌가 처음 생기는 날 전부 터진다.
//
// 그래서 "지금 안 터진다"가 아니라 **"기본 계좌로 좁혀 읽는가"**를 본다.
//
// 시험이 못 보는 것
// ─────────────────
// 시험은 임시 디렉터리에서 `src`만 갖고 돌아서 SQL 파일을 읽을 수 없다.
// DB를 띄우는 통합 시험대도 이 저장소에 없다 — **없는 인프라를 새로 만들지
// 않는다.** SQL 계약(복합 외래키·부분 유니크·정산이 포지션을 따라감)은
// 여기서 본다.
import { readFileSync, existsSync } from 'node:fs';

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

const MIG_ID = 'supabase/migrations/081_paper_account_identity.sql';
const MIG_RPC = 'supabase/migrations/082_paper_rpc_account_id.sql';

// ── 1. 계좌에 정체가 생겼는가 ──
{
  const s = read(MIG_ID);
  if (!s) fail(`${MIG_ID}이 없습니다`);
  else {
    if (!/ADD COLUMN IF NOT EXISTS id UUID/i.test(s)) fail('계좌에 id 칸이 없습니다');
    if (!/ADD COLUMN IF NOT EXISTS is_default BOOLEAN/i.test(s)) {
      fail('계좌에 is_default 칸이 없습니다 — 기본 계좌를 "첫 줄"로 고르면 나중에 모호해집니다');
    }
    // **사용자당 기본 계좌는 최대 하나.** 코드가 실수해도 두 개가 될 수
    // 없어야 한다 — 부분 유니크 인덱스가 그것만 DB에서 막는다.
    // **0개는 이 인덱스가 막지 못한다.** 그쪽은 아래 규칙 2.5/2.6/2.7이 본다.
    if (!/CREATE UNIQUE INDEX[\s\S]*?paper_accounts[\s\S]*?\(user_id\)[\s\S]*?WHERE is_default/i.test(s)) {
      fail('기본 계좌가 둘이 되는 것을 DB가 막지 않습니다 (부분 유니크 인덱스 없음)');
    } else notes.push('기본 계좌 2개 이상 — 부분 유니크 인덱스가 막는다 (0개는 못 막는다)');

    if (!/PRIMARY KEY \(id\)/i.test(s)) fail('기본키가 id로 옮겨지지 않았습니다');

    // 복합 FK가 가리킬 정본
    if (!/UNIQUE \(id, user_id\)/i.test(s)) {
      fail('(id, user_id) 유니크가 없습니다 — 복합 외래키를 걸 수 없습니다');
    }

    // ── 남의 계좌에 붙는 것을 DB가 막는가 ──
    //
    // `paper_account_id` 하나만 두면 계좌 id만 알면 남의 계좌에 포지션을
    // 붙일 수 있다. 서비스 계층 검사 하나에 기대지 않는다.
    if (!/FOREIGN KEY \(paper_account_id, user_id\)[\s\S]*?REFERENCES[\s\S]*?paper_accounts \(id, user_id\)/i.test(s)) {
      fail('포지션의 복합 외래키가 없습니다 — 다른 사용자 계좌에 붙일 수 있습니다');
    } else notes.push('cross-user binding은 복합 외래키가 DB에서 막는다');

    // 기존 데이터 무손실
    if (!/UPDATE public\.paper_accounts SET is_default = TRUE/i.test(s)) {
      fail('기존 계좌를 기본 계좌로 표시하는 backfill이 없습니다');
    }
    if (!/UPDATE public\.paper_positions[\s\S]*?SET paper_account_id/i.test(s)) {
      fail('기존 포지션의 계좌 backfill이 없습니다');
    } else notes.push('기존 계좌·포지션 backfill 있음');
  }
}

// ── 2. RPC가 계좌를 지정받을 수 있는가 ──
{
  const s = read(MIG_RPC);
  if (!s) fail(`${MIG_RPC}이 없습니다`);
  else {
    if (!/p_paper_account_id\s+UUID DEFAULT NULL/i.test(s)) {
      fail('RPC가 계좌를 지정받지 못합니다 (기본값 NULL 인자 없음)');
    }
    // **기본값이 있어야 기존 호출이 안 깨진다.** 인자를 필수로 만들면
    // 인자 수가 적은 기존 호출이 전부 실패한다.
    const defaults = (s.match(/DEFAULT NULL/gi) || []).length;
    if (defaults < 3) fail(`계좌 인자에 기본값이 부족합니다 (${defaults}곳) — 기존 호출이 깨집니다`);
    else notes.push(`계좌 인자는 전부 기본값 NULL (${defaults}곳) — 기존 호출 호환`);

    // 지정 안 하면 기본 계좌로
    if (!/is_default[\s\S]*?ELSE[\s\S]*?p_paper_account_id/i.test(s)) {
      fail('계좌를 지정하지 않았을 때 기본 계좌로 가는 분기가 없습니다');
    }

    // **소유자까지 함께 본다.** 남의 계좌 id를 넣어도 못 찾아야 한다.
    if (!/WHERE a\.user_id = p_user_id[\s\S]*?p_paper_account_id/i.test(s)) {
      fail('RPC가 계좌를 고를 때 소유자를 함께 보지 않습니다');
    } else notes.push('RPC가 소유자까지 함께 보고 계좌를 고른다');

    // 정산은 포지션을 따라간다 — 호출부가 계좌를 다시 말하지 않는다
    if (!/RETURNING user_id, paper_account_id INTO/i.test(s)) {
      fail('정산이 포지션의 계좌를 따라가지 않습니다');
    } else notes.push('정산은 포지션이 든 계좌를 따라간다 (새 인자 없음)');

    // 옛 줄(계좌 없음)은 기본 계좌로
    if (!/paper_default_account_id/.test(s)) {
      fail('계좌를 안 든 옛 포지션의 처리(기본 계좌)가 없습니다');
    }
  }
}

// ── 2.5 기본 계좌가 0개가 되는 경로가 생기지 않았는가 ──
//
// **부분 유니크 인덱스는 "최대 하나"만 보장한다.** 0개는 막지 못한다 —
// 그 사용자의 모든 계좌가 `is_default = false`인 상태를 DB는 정상으로
// 받아들인다.
//
// 지금 0개가 안 생기는 이유는 DB 제약이 아니라 **그렇게 만드는 경로가
// 없기 때문**이다: 계좌를 만드는 두 자리가 모두 기본으로 넣고, `is_default`를
// 낮추거나 계좌를 지우는 제품 코드가 0곳이다.
//
// 그 전제가 깨지는 순간을 여기서 잡는다. 이 검사가 없으면 나중에 누가
// "챌린지 계좌를 기본으로 바꾸는" 기능을 넣으면서 기존 기본을 false로
// 내리고, 그때부터 userId-only 경로가 전부 "계좌 없음"이 된다.
{
  const SRC = ['src/lib/engine/paperStore.ts', 'src/app/api/paper/account/route.ts',
    'src/lib/portfolio/paperRead.ts', 'src/lib/portfolio/paperAccount.ts',
    'src/app/api/paper/order/route.ts', 'src/app/api/paper/run/route.ts'];
  for (const f of SRC) {
    const code = read(f).split('\n')
      .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    if (!code) continue;
    if (/is_default\s*:\s*false/.test(code)) {
      fail(`${f}: 기본 계좌를 false로 내립니다 — 기본 계좌 0개 상태가 생길 수 있습니다.`
        + ' 그 기능이 필요하면 "최소 하나"를 DB 트리거로 함께 강제하세요');
    }
    if (/from\('paper_accounts'\)[\s\S]{0,120}?\.delete\(/.test(code)) {
      fail(`${f}: 모의 계좌를 지웁니다 — 마지막 기본 계좌가 사라질 수 있습니다`);
    }
  }
  notes.push('기본 계좌를 낮추거나 지우는 제품 경로 0곳 (0개 상태가 생기지 않는 실제 이유)');
}

// ── 2.6 계좌를 만드는 자리는 전부 기본으로 만드는가 ──
//
// 새 사용자에게 기본 계좌가 안 생기면 그 사용자는 처음부터 0개다.
{
  const CREATORS = ['src/lib/engine/paperStore.ts', 'src/app/api/paper/account/route.ts'];
  for (const f of CREATORS) {
    const code = read(f);
    if (!code) { fail(`${f}이 없습니다`); continue; }
    const inserts = [...code.matchAll(/from\('paper_accounts'\)[\s\S]{0,200}?\.insert\(([\s\S]{0,200}?)\)/g)];
    if (inserts.length === 0) continue;
    for (const m of inserts) {
      if (!/is_default:\s*true/.test(m[1]) && !/is_default: true/.test(code.slice(m.index - 300, m.index + 300))) {
        fail(`${f}: 계좌를 만들면서 기본으로 표시하지 않습니다 — 새 사용자가 기본 계좌 0개로 시작합니다`);
      }
    }
  }
  notes.push('계좌를 만드는 자리는 전부 기본으로 만든다');
}

// ── 2.7 기본 계좌가 0개일 때 fail-closed인가 ──
//
// 0개를 완전히 막을 수 없다면, **그때 무엇을 하는가**가 계약이다.
// 임의 계좌를 고르면 남의 돈이 아니라 자기 돈인데도 **고른 적 없는 장부**로
// 주문이 나간다.
{
  const rpc = read(MIG_RPC);
  if (!/IF v_account IS NULL THEN[\s\S]{0,200}?NO_ACCOUNT/i.test(rpc)) {
    fail('진입 RPC가 기본 계좌 없음에서 NO_ACCOUNT로 멈추지 않습니다');
  }
  const raises = (rpc.match(/RAISE EXCEPTION '[a-z_]+: 계좌를 찾지 못했습니다'/g) || []).length;
  if (raises < 2) fail(`수수료·입금 RPC가 계좌 없음에서 멈추지 않습니다 (${raises}곳)`);

  // 읽는 쪽도 임의 계좌로 넘어가지 않아야 한다.
  for (const [f, needle] of [
    ['src/lib/engine/paperCapacity.ts', 'known: false'],
    ['src/lib/portfolio/paperRead.ts', 'account = (data ?? null)'],
  ]) {
    if (!read(f).includes(needle)) {
      fail(`${f}: 기본 계좌가 없을 때 멈추는 자리를 찾지 못했습니다`);
    }
  }
  notes.push('기본 계좌 0개 → 전 경로 fail-closed (임의 계좌 선택 없음)');
}

// ── 3. 제품 코드가 기본 계좌로 좁혀 읽는가 ──
//
// **여기가 이 검사기의 핵심이다.** 위의 SQL이 다 맞아도, 읽는 쪽이
// `user_id`만으로 고르면 계좌가 둘이 되는 날 터진다.
{
  const SITES = [
    'src/lib/engine/paperStore.ts',
    'src/lib/engine/paperCapacity.ts',
    'src/lib/portfolio/paperRead.ts',
    'src/lib/risk/lossStreakCheck.ts',
    'src/app/api/portfolio/allocation/route.ts',
  ];
  for (const f of SITES) {
    const s = read(f);
    if (!s) { fail(`${f}이 없습니다`); continue; }
    // `paper_accounts`를 읽는 줄마다 기본 계좌로 좁혔는가.
    const lines = s.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("from('paper_accounts')")) continue;
      const near = lines.slice(i, i + 4).join(' ');
      if (!near.includes("eq('user_id'")) continue;      // 계좌 id로 읽는 것은 대상이 아니다
      if (near.includes('.update(') || near.includes('.insert(')) continue; // 쓰기는 아래에서
      if (!near.includes("eq('is_default', true)")) {
        fail(`${f}:${i + 1} 계좌를 user_id만으로 읽습니다`
          + ' — 계좌가 둘이 되는 날 maybeSingle()이 던집니다');
      }
    }
  }
  if (fails.length === 0) notes.push(`기본 계좌로 좁혀 읽는 자리 ${SITES.length}곳 확인`);
}

// ── 4. 없어진 유니크에 기대지 않는가 ──
//
// `onConflict: 'user_id'`는 user_id가 유니크할 때만 동작한다. 기본키를
// 옮기면서 그 제약이 사라졌고, 남은 것은 **부분** 유니크 인덱스라
// PostgREST가 지목할 수 없다. 그대로 두면 모의투자 시작이 실패한다.
{
  // **주석은 보지 않는다.** 왜 그 방식을 그만뒀는지 적어 둔 문장까지
  // 위반으로 읽으면, 설명을 남길수록 검사가 실패한다.
  const s = read('src/app/api/paper/account/route.ts')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  if (s.includes("onConflict: 'user_id'")) {
    fail("src/app/api/paper/account/route.ts: onConflict: 'user_id'가 남아 있습니다"
      + ' — user_id 유니크 제약은 더 이상 없습니다');
  } else notes.push('사라진 user_id 유니크에 기대는 upsert 없음');
}

// ── 5. 계좌 지정이 실제로 배선됐는가 ──
{
  const s = read('src/lib/engine/paperStore.ts');
  if (!/paperAccountId\?: string/.test(s)) fail('openPaperPosition이 계좌를 받지 않습니다');
  if (!/p_paper_account_id: args\.paperAccountId \?\? null/.test(s)) {
    fail('받은 계좌를 RPC로 넘기지 않습니다 — 만들어 놓고 배선을 안 한 상태입니다');
  } else notes.push('openPaperPosition → RPC 계좌 전달 배선됨');
}

console.log('모의 계좌 정체 확인');
for (const n of notes) console.log(`  · ${n}`);
if (fails.length === 0) {
  console.log('통과 — 계좌가 여럿이 되어도 기존 경로는 기본 계좌로 간다');
  process.exit(0);
}
for (const f of fails) console.log(`::error::${f}`);
console.log(`실패 ${fails.length}건`);
process.exit(1);

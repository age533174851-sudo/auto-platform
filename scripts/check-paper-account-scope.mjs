#!/usr/bin/env node
// scripts/check-paper-account-scope.mjs
//
// **모의 포지션을 읽는 자리는 계좌로 좁힌다.**
//
// 무엇이 있었나
// ─────────────
// `081`이 모의 계좌를 사용자당 여러 개가 될 수 있게 바꿨다. 그때 **계좌
// 표**를 읽는 다섯 곳은 `is_default`로 좁혔는데, `paper_positions`를 읽는
// 자리는 **한 곳도 안 좁혔다** — 전부 `user_id`만 봤다(17곳).
//
// 계좌가 하나인 동안은 증상이 없다. 전용 계좌(챌린지 등)가 처음 생기는 날
// 가용 증거금·총자산·위험 판정이 섞이고, REVERSE가 남의 계좌 포지션을 닫는다.
//
// 시험이 잡지 못하는 것
// ─────────────────────
// 시험은 **부르는 함수**의 동작을 본다. 새 화면이나 새 라우트가 포지션을
// 직접 읽으면서 계좌를 안 좁히면 시험은 아무 말도 안 한다 — 그 코드를 부르는
// 시험이 없기 때문이다. 그건 배선이고 배선은 여기서 본다.
//
// 무엇을 허용하는가
// ─────────────────
//   ① `paper_account_id`로 좁힌 질의            — 정상
//   ② 포지션 id 한 줄을 집는 질의                — 그 줄이 자기 계좌를 들고 있다
//   ③ 아래 ALLOW에 적힌 자리                     — 이유를 함께 적는다
//
// ③은 지금 하나뿐이다: **청산 감시(exit-monitor)는 전 계좌를 본다.** 손절·
// 청산가 감시를 기본 계좌로 좁히면 전용 계좌 포지션의 손절을 아무도 안 본다.
// 그 경로는 계좌를 합산하지 않고 포지션 id로 닫으므로(082가 그 포지션의
// 계좌를 따라간다) 오염 위험이 없다. **안전망은 넓어야 한다.**

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

let bad = 0;
const err = (m) => { console.error(`::error::${m}`); bad += 1; };
const notes = [];

// ── 전 계좌를 보는 것이 맞는 자리 ──
//
// 파일 하나를 통째로 면제하지 않는다. **왜 넓어야 하는지**를 함께 적고,
// 그 이유가 코드 주석에도 남아 있는지 확인한다.
const ALLOW = [
  {
    file: 'src/app/api/paper/exit-monitor/route.ts',
    why: '손절·청산가 집행 안전망 — 기본 계좌로 좁히면 전용 계좌 포지션의 손절을 아무도 안 본다',
    // 이 의도가 코드에 적혀 있어야 한다. 없으면 다음 사람이 "빠뜨린 것"으로 읽고 좁힌다.
    marker: '여기는 계좌로 좁히지 않는다',
  },
];

const FILES = (() => {
  try {
    const out = execSync(
      "grep -rln \"from('paper_positions')\" src worker --include=*.ts --include=*.tsx",
      { encoding: 'utf8' },
    );
    return out.split('\n').map(s => s.trim()).filter(Boolean)
      .filter(f => !f.includes('.test.'));
  } catch {
    return [];
  }
})();

if (FILES.length === 0) {
  err('paper_positions를 읽는 파일을 하나도 찾지 못했습니다 — 이 검사가 무엇을 지키는지 다시 봐야 합니다');
}

let scoped = 0, byId = 0, allowed = 0;

for (const file of FILES) {
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  const allow = ALLOW.find(a => a.file === file);
  if (allow) {
    // 면제는 **이유가 코드에 남아 있을 때만** 유효하다.
    if (!src.includes(allow.marker)) {
      err(`${file}: 전 계좌 조회 면제인데 그 이유가 코드에 없습니다 `
        + `— "${allow.marker}" 주석이 사라졌습니다. 면제를 유지하려면 이유를 적으세요`);
    } else {
      allowed += 1;
      notes.push(`전 계좌 조회 1곳 (허용): ${file} — ${allow.why}`);
    }
    continue;
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes("from('paper_positions')")) continue;

    // 질의 한 덩어리. 체이닝이 여러 줄에 걸친다.
    const chunk = lines.slice(i, i + 10).join(' ');

    // ② 포지션 id 한 줄을 집는 질의 — 그 줄이 자기 계좌를 들고 있다.
    //    `.eq('id', …)`가 있으면 계좌가 모호하지 않다.
    if (/\.eq\(\s*'id'\s*,/.test(chunk)) { byId += 1; continue; }

    // ① 계좌로 좁혔는가.
    if (/\.eq\(\s*'paper_account_id'\s*,/.test(chunk)) { scoped += 1; continue; }

    err(`${file}:${i + 1}: paper_positions를 계좌로 좁히지 않고 읽습니다 `
      + `— 전용 계좌(챌린지 등)가 생기면 남의 장부가 섞입니다. `
      + `paper_account_id로 좁히거나, 포지션 id로 한 줄을 집거나, `
      + `전 계좌가 맞다면 이 검사기의 ALLOW에 이유와 함께 등록하세요`);
  }
}

// ── REVERSE 청산은 계좌를 반드시 받는다 ──
//
// `user_id`와 `symbol`만 보고 닫으면 기본 계좌 신호가 전용 계좌 포지션을
// 닫는다. 이 저장소의 절대 규칙 — symbol만 보고 주문 소유권을 판단하지 않는다.
{
  const F = 'src/lib/engine/paperStore.ts';
  const src = existsSync(F) ? readFileSync(F, 'utf8') : '';
  if (!src) {
    err(`${F}을 읽지 못했습니다`);
  } else {
    const m = src.match(/export async function closeOpposingPositions\(([\s\S]*?)\)\s*:/);
    if (!m) {
      err(`${F}에서 closeOpposingPositions를 찾지 못했습니다`);
    } else {
      const args = m[1];
      if (!/paperAccountId\s*:\s*string/.test(args)) {
        err('closeOpposingPositions가 계좌를 받지 않습니다 — 기본 계좌 신호가 전용 계좌 포지션을 닫습니다');
      } else if (/paperAccountId\s*:\s*string\s*=/.test(args) || /paperAccountId\?\s*:/.test(args)) {
        // 기본값이나 선택 인자로 두면 부르는 쪽이 안 넘겨도 컴파일이 통과하고,
        // 그 순간 예전 동작으로 조용히 돌아간다.
        err('closeOpposingPositions의 계좌 인자가 선택/기본값입니다 — 필수여야 합니다');
      } else {
        notes.push('REVERSE 청산이 계좌를 필수로 받는다');
      }
    }
  }
}

// ── 미리보기와 최종 판정이 같은 범위를 보는가 ──
//
// `082`의 `paper_open_position`은 잠금 안에서 `user_id AND paper_account_id`로
// 예산을 센다. 미리보기(`readPaperCapacity`)가 사용자 전체를 세면 두 곳이
// 다른 예산을 본다 — "경로가 둘인데 한쪽만 고침"이다.
{
  const TS = 'src/lib/engine/paperCapacity.ts';
  const SQL = 'supabase/migrations/082_paper_rpc_account_id.sql';
  const ts = existsSync(TS) ? readFileSync(TS, 'utf8') : '';
  const sql = existsSync(SQL) ? readFileSync(SQL, 'utf8') : '';
  if (!ts || !sql) {
    err('미리보기/최종 판정 파일을 읽지 못했습니다');
  } else {
    const tsScoped = /from\('paper_positions'\)[\s\S]{0,240}?\.eq\(\s*'paper_account_id'/.test(ts);
    const sqlScoped = /paper_positions[\s\S]{0,400}?paper_account_id\s*=\s*v_account/.test(sql)
      || /WHERE\s+user_id\s*=\s*p_user_id\s+AND\s+paper_account_id/i.test(sql);
    if (!tsScoped) err(`${TS}: 미리보기가 계좌로 좁히지 않습니다 — SQL 최종 판정과 다른 예산을 봅니다`);
    if (!sqlScoped) err(`${SQL}: 최종 용량 판정이 계좌로 좁히지 않습니다`);
    if (tsScoped && sqlScoped) notes.push('미리보기와 최종 판정이 같은 계좌 범위를 본다');
  }
}

if (bad === 0) {
  console.log('모의 포지션 계좌 범위 확인');
  for (const n of notes) console.log(`  · ${n}`);
  console.log(`통과 — 계좌로 좁힘 ${scoped}곳 · 포지션 id 지정 ${byId}곳 · 전 계좌 허용 ${allowed}곳`);
}
process.exit(bad ? 1 : 0);

#!/usr/bin/env node
// scripts/check-audit-readonly.mjs
//
// **운영 감사 워크플로가 읽기만 하는가.**
//
// 이 검사가 필요한 이유: 감사 SQL은 운영 DB에 붙는다. 한 줄이 쓰기로
// 바뀌어도 로컬 시험은 아무것도 말해 주지 않는다 — 그 SQL은 시험에서
// 돌지 않기 때문이다. 그래서 **소스에서** 막는다.
//
// 네 가지를 본다:
//   ① `BEGIN TRANSACTION READ ONLY`로 열고 `READ_ONLY=on`을 **값으로**
//      확인한다 (빠지면 실행이 실패해야 한다)
//   ② 쓰기 구문이 없다
//   ③ 비밀·식별 칸을 선택하지 않는다 (키·시크릿·토큰·user_id)
//   ④ 수동 실행 문이 열렸다면 소유자 확인과 확인 문구가 **둘 다** 있다

import { readFileSync } from 'node:fs';

const F = '.github/workflows/audit-production-exact100x-testnet-readiness.yml';
const errors = [];
const err = (m) => errors.push(m);

let src = null;
try { src = readFileSync(F, 'utf8'); }
catch { err(`${F}을(를) 읽지 못했습니다`); }

if (src) {
  // SQL 블록만 떼어 온다 — YAML 주석·요약 문구를 쓰기 구문으로 오인하지 않게.
  const begin = src.indexOf("cat > /tmp/audit.sql <<'SQL'");
  const end = src.indexOf('\n          SQL', begin < 0 ? 0 : begin);
  const sql = begin >= 0 && end > begin ? src.slice(begin, end) : null;
  if (sql == null) err(`${F}: 감사 SQL 블록을 찾지 못했습니다 — 앵커가 바뀌었습니다`);

  if (sql) {
    // SQL 주석(`--`)을 걷어낸 본문. 주석의 단어로 통과·실패하지 않게.
    const body = sql.split('\n')
      .map(l => l.replace(/--.*$/, ''))
      .join('\n');

    // ── ① 읽기 전용으로 열고 증명한다 ──
    if (!/BEGIN\s+TRANSACTION\s+READ\s+ONLY/i.test(body)) {
      err('BEGIN TRANSACTION READ ONLY가 없습니다 — 쓰기를 Postgres가 막아 주지 않습니다');
    }
    if (!/current_setting\('transaction_read_only'\)/.test(body)) {
      err("transaction_read_only를 값으로 확인하지 않습니다 — 선언만으로는 증거가 아닙니다");
    }
    // 그 증거를 **실제로 검사**하는지도 본다 (워크플로 쉘 쪽).
    if (!src.includes("grep -q 'READ_ONLY=on'")) {
      err('READ_ONLY=on을 확인하는 단계가 없습니다 — 증명을 찍고 보지 않으면 증명이 아닙니다');
    }

    // ── ② 쓰기 구문이 없다 ──
    const writes = [
      /\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w/i, /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i, /\bDROP\s+/i, /\bALTER\s+/i, /\bCREATE\s+(TABLE|INDEX|VIEW|SCHEMA|FUNCTION)/i,
      /\bGRANT\b/i, /\bREVOKE\b/i, /\bCOPY\b[\s\S]{0,80}\bFROM\b/i,
      /\bSELECT\b[\s\S]{0,200}\bINTO\b/i, /\bREFRESH\s+MATERIALIZED\b/i,
      /\bSET\s+TRANSACTION\s+READ\s+WRITE\b/i, /\bCALL\b/i, /\bDO\s+\$\$/i,
    ];
    for (const re of writes) {
      const m = re.exec(body);
      if (m) err(`감사 SQL에 쓰기로 읽히는 구문이 있습니다: ${JSON.stringify(m[0].slice(0, 40))}`);
    }

    // ── ③ 비밀·식별 칸을 선택하지 않는다 ──
    //
    //   `count(*) FILTER (WHERE coalesce(api_key,'') <> '')`처럼 **존재
    //   여부**만 세는 것은 허용이다. 값을 고르는 모양만 잡는다.
    for (const col of ['api_key', 'api_secret_enc', 'encrypted_secret',
      'api_passphrase_enc', 'encrypted_passphrase', 'api_key_encrypted',
      'access_token', 'refresh_token']) {
      // SELECT 목록에 알몸으로 나오거나 ->> 로 뽑는 모양
      const bare = new RegExp(`(SELECT|,)\\s*(\\w+\\.)?${col}\\s*(,|\\n|AS\\s)`, 'i');
      if (bare.test(body)) err(`감사 SQL이 비밀 칸을 선택합니다: ${col}`);
      if (new RegExp(`->>\\s*'${col}'`).test(body)) {
        err(`감사 SQL이 비밀 칸을 뽑습니다: ${col}`);
      }
      // 길이도 읽지 않는다 — 길이는 값에 대한 정보다
      if (new RegExp(`length\\s*\\(\\s*(\\w+\\.)?${col}`, 'i').test(body)) {
        err(`감사 SQL이 비밀 칸의 길이를 읽습니다: ${col}`);
      }
    }
    for (const col of ['user_id', 'client_order_id', 'exchange_order_id', 'strategy_account_id']) {
      const bare = new RegExp(`(SELECT|,)\\s*(\\w+\\.)?${col}\\s*(,|\\n|AS\\s)`, 'i');
      if (bare.test(body)) err(`감사 SQL이 식별 칸의 값을 선택합니다: ${col} (존재 여부만 적으세요)`);
      if (new RegExp(`->>\\s*'${col}'\\s*(AS|,|\\n)`, 'i').test(body)) {
        err(`감사 SQL이 식별 칸의 값을 뽑습니다: ${col} (존재 여부만 적으세요)`);
      }
    }
    // 자유 문자열 원문을 찍지 않는다 — 무엇이 들어 있을지 모른다.
    if (/->>\s*'last_result'\s*(AS|,|\n)/.test(body)
        || /(SELECT|,)\s*(\w+\.)?last_result\s*(,|\n|AS\s)/i.test(body)) {
      err('감사 SQL이 last_result 원문을 선택합니다 — 비었는지만 세세요');
    }
    if (/(SELECT|,)\s*(\w+\.)?error_message\s*(,|\n|AS\s)/i.test(body)) {
      err('감사 SQL이 error_message 원문을 선택합니다');
    }
  }

  // ── ④ 수동 실행 문을 열었다면 두 겹이 다 있어야 한다 ──
  if (/^\s*workflow_dispatch:/m.test(src)) {
    if (!/github\.actor/.test(src) || !/github\.repository_owner/.test(src)) {
      err('수동 실행을 열었는데 소유자 확인이 없습니다');
    }
    // **문구가 파일 어딘가에 있는 것으로는 부족하다.** 설명문·주석에
    //   남아 있어도 비교가 다른 값을 보면 관문은 열린 것이다. 그래서
    //   비교하는 줄 자체를 확인한다 (HX26이 정확히 이렇게 새 나갔다).
    if (!/\[\s*"\$\{CONFIRM\}"\s*!=\s*"READ-ONLY-AUDIT"\s*\]/.test(src)) {
      err('확인 문구를 READ-ONLY-AUDIT와 비교하지 않습니다'
        + ' — 파일에 문구가 적혀 있는 것과 그것으로 막는 것은 다릅니다');
    }
    if (!/inputs\.confirm/.test(src)) {
      err('확인 문구 입력(inputs.confirm)을 받지 않습니다');
    }
    // 소유자 비교도 같은 방식으로 **비교하는 줄**을 본다.
    if (!/\[\s*"\$\{ACTOR\}"\s*!=\s*"\$\{OWNER\}"\s*\]/.test(src)) {
      err('실행자를 저장소 소유자와 비교하지 않습니다');
    }
    // 관문이 DB 접속 단계보다 **앞에** 있어야 한다.
    const gate = src.indexOf('수동 실행 관문');
    const db = src.indexOf('DB 접속 정보 확인');
    if (gate < 0) err('수동 실행 관문 단계를 찾지 못했습니다');
    else if (db >= 0 && gate > db) {
      err('수동 실행 관문이 DB 접속 단계보다 뒤에 있습니다');
    }
    if (!/if:\s*github\.event_name == 'workflow_dispatch'/.test(src)) {
      err('수동 실행 관문이 workflow_dispatch에만 걸려 있지 않습니다');
    }
  }

  // ── 접속 문자열을 찍지 않는다 ──
  //
  //   여기서도 "문구가 있는가"가 아니라 **치환이 실제로 일어나는가**를
  //   본다. psql 오류 메시지에는 접속 URL이 섞여 나오고, 그것을 그대로
  //   로그에 흘리면 비밀이 로그에 남는다.
  if (!/scrubbed="\$\{scrubbed\/\/"\$\{_u\}"\//.test(src)) {
    err('접속 문자열 치환이 없습니다 — psql 오류 메시지에 URL이 섞여 나옵니다');
  }
  if (!/sed -E/.test(src) || !/postgres\(ql\)\?:/.test(src)) {
    err('postgres:// 형태를 지우는 sed 단계가 없습니다');
  }
  // 가린 것을 출력하는가 — 원본(out)을 그대로 찍으면 가림이 무의미하다.
  if (/printf '%s\\n' "\$\{out\}"/.test(src)) {
    err('가리지 않은 원본(out)을 출력합니다');
  }
}

if (errors.length) {
  console.error('❌ 운영 감사 읽기 전용 계약 위반\n');
  for (const e of errors) console.error(`  · ${e}`);
  console.error(`\n${errors.length}건`);
  process.exit(1);
}
console.log('✅ 운영 감사 — READ ONLY 선언·증명 · 쓰기 구문 0 · 비밀·식별 칸 미선택 · 수동 실행 2중 관문');

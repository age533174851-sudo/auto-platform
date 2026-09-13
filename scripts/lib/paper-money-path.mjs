// scripts/lib/paper-money-path.mjs
//
// **수수료가 잔고에서 빠지는 방식을 판정하는 단 하나의 자리.**
//
// 왜 공용으로 두는가
// ──────────────────
// `check-paper-open-atomic.mjs`와 `check-paper-capacity.mjs`가 둘 다 같은
// 계약을 본다: 진입 수수료가 **증감식으로** 빠지고, 계좌 갱신이 실패하면
// 진입이 **되돌아간다.** 같은 판단을 두 파일에 적으면 언젠가 한쪽만 고쳐지고,
// 그때 한 검사기는 초록 다른 검사기는 빨강이 된다.
//
// 무엇이 계약이고 무엇이 아닌가
// ─────────────────────────────
// 계약은 이 둘이다:
//
//   ① 잔고를 **읽고 고쳐 쓰지 않는다.** `balance = balance ± delta`로 민다.
//      읽어서 계산해 덮어쓰면, 같은 계좌에서 동시에 두 건이 끝날 때 한쪽
//      손익이 사라진다.
//   ② 계좌 갱신이 **한 줄도 안 바뀌면 진입을 되돌린다.** 포지션만 남고
//      수수료가 안 빠진 계좌는 되돌릴 방법도, 알아챌 방법도 없다.
//
// 계약이 **아닌** 것: 그 일이 어느 함수 안에서 일어나는가.
//
// `074`부터 `084`까지는 `paper_open_position` 안에 차감식이 직접 있었고, 두
// 검사기는 그 글자를 찾았다. `085`는 챌린지 원장 때문에 **돈이 움직이는 자리를
// 하나로 모았다** — 원장 한 줄과 잔고 변경을 같이 해야 해서, 따로 부를 수 있는
// 구조 자체를 없앤 것이다. 계약은 그대로인데 글자가 달라졌고, 두 검사기는
// 그 **개선을 회귀로 신고했다.**
//
// 그래서 여기서는 두 모양을 다 받는다. 다만 넘긴 쪽은 **더 엄하게** 본다:
// 위임받은 함수 안에서 ①과 ②가 실제로 지켜지는지 확인하고, 넘기는 값이
// 음수인지까지 본다. 느슨해진 것이 아니라 검사 지점이 옮겨간 것이다.

/**
 * plpgsql 함수 본문을 뽑는다.
 *
 * `$$` 또는 `$이름$`로 감싼 몸통을 찾는다. 여는 표식과 **같은** 표식으로
 * 닫는 곳까지가 본문이다 — `$$`로 일괄 검색하면 `$fn$`으로 감싼 함수에서
 * 엉뚱한 곳을 끝으로 잡는다.
 *
 * @param {string} sql  주석을 걷어낸 SQL
 * @param {string} name `public.paper_money_apply` 같은 이름
 * @returns {{ ok: true, body: string } | { ok: false, reason: string }}
 */
export function plpgsqlBody(sql, name) {
  const src = String(sql ?? '');
  const decl = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i');
  const m = decl.exec(src);
  if (!m) return { ok: false, reason: `${name} 정의를 찾지 못했습니다` };

  // 선언 뒤 첫 달러 인용 표식이 본문의 시작이다.
  const tag = /\$([A-Za-z_]\w*)?\$/.exec(src.slice(m.index));
  if (!tag) return { ok: false, reason: `${name}의 본문 표식($$)을 찾지 못했습니다` };

  const openAt = m.index + tag.index + tag[0].length;
  const closeAt = src.indexOf(tag[0], openAt);
  if (closeAt < 0) return { ok: false, reason: `${name}의 본문이 닫히지 않았습니다` };

  return { ok: true, body: src.slice(openAt, closeAt) };
}

/** 계좌 갱신이 0행일 때 되돌리는가. `GET DIAGNOSTICS`와 `NOT FOUND` 둘 다 받는다. */
function abortsOnNoRows(body) {
  const checks = /GET\s+DIAGNOSTICS[\s\S]{0,120}ROW_COUNT/i.test(body)
              || /IF\s+NOT\s+FOUND\s+THEN/i.test(body);
  return checks && /RAISE\s+EXCEPTION/i.test(body);
}

/** 잔고를 증감식으로 미는가 (읽고 고쳐 쓰지 않는가). */
function movesByDelta(body, column = 'balance') {
  // `balance = balance ± x` / `balance = a.balance ± x` 둘 다 받는다.
  const re = new RegExp(
    `${column}\\s*=\\s*(?:[A-Za-z_]\\w*\\.)?${column}\\s*[-+]`, 'i');
  return re.test(body);
}

/**
 * 진입 수수료가 계약대로 빠지는가.
 *
 * @param {object} i
 * @param {string} i.sql      주석을 걷어낸 마이그레이션 전체
 * @param {string} i.fnBody   `paper_open_position` 본문
 * @param {string} i.feeParam 수수료 매개변수 이름 (`p_entry_fee`)
 * @returns {{ ok: true, where: 'inline'|'delegated', note: string }
 *          | { ok: false, reason: string }}
 */
export function feeDeductionContract({ sql, fnBody, feeParam = 'p_entry_fee' }) {
  const body = String(fnBody ?? '');

  // ── ① 함수 안에서 직접 빼는 모양 (074–084) ──
  const inlineDelta = new RegExp(
    `balance\\s*=\\s*(?:[A-Za-z_]\\w*\\.)?balance\\s*-\\s*${feeParam}\\b`, 'i').test(body);
  if (inlineDelta) {
    if (!abortsOnNoRows(body)) {
      return {
        ok: false,
        reason: '진입 함수가 수수료를 직접 빼는데, 계좌 갱신이 0행일 때 되돌리지 않습니다'
          + ' — 포지션만 남고 수수료가 안 빠진 계좌가 됩니다'
          + ' (GET DIAGNOSTICS ... ROW_COUNT 또는 IF NOT FOUND + RAISE EXCEPTION)',
      };
    }
    return { ok: true, where: 'inline', note: '진입 함수가 수수료를 직접 차감식으로 뺀다' };
  }

  // ── ② 돈이 움직이는 자리 하나에 넘기는 모양 (085 이후) ──
  //
  // 넘기는 것 자체는 계약 위반이 아니다. 다만 **음수로** 넘겨야 하고,
  // 받는 함수 안에서 ①②가 지켜져야 한다.
  const MONEY = 'public.paper_money_apply';
  const call = new RegExp(
    `paper_money_apply\\s*\\([^;]*?-\\s*${feeParam}\\b`, 'is').test(body);
  if (!call) {
    return {
      ok: false,
      reason: `진입 함수가 수수료를 빼지 않습니다`
        + ` — 직접 \`balance = balance - ${feeParam}\`로 빼거나,`
        + ` \`${MONEY}\`에 \`-${feeParam}\`을 넘겨야 합니다.`
        + ' 양수로 넘기면 수수료가 잔고에 더해집니다',
    };
  }

  const money = plpgsqlBody(sql, MONEY);
  if (!money.ok) {
    // **못 읽은 것을 통과로 적지 않는다.** 넘겼다는 말만 믿으면, 받는 쪽이
    // 사라져도 초록이 된다.
    return {
      ok: false,
      reason: `진입 함수가 ${MONEY}에 수수료를 넘기는데 그 함수를 확인할 수 없습니다`
        + ` (${money.reason}) — 넘긴 곳을 못 읽으면 계약이 지켜지는지 알 수 없습니다`,
    };
  }
  if (!movesByDelta(money.body)) {
    return {
      ok: false,
      reason: `${MONEY}이 잔고를 증감식으로 밀지 않습니다`
        + ' — 읽어서 덮어쓰면 같은 계좌에서 동시에 끝난 두 건 중 한쪽 손익이 사라집니다',
    };
  }
  if (!abortsOnNoRows(money.body)) {
    return {
      ok: false,
      reason: `${MONEY}이 계좌를 못 찾았을 때 되돌리지 않습니다`
        + ' — 포지션만 남고 수수료가 안 빠진 계좌가 됩니다',
    };
  }
  return {
    ok: true,
    where: 'delegated',
    note: `수수료가 ${MONEY} 하나를 지나고, 그 함수가 증감식·실패 되돌림을 지킨다`,
  };
}

// src/lib/engine/checkOverride.ts
//
// **막힌 항목을 사용자가 "네"로 통과시킬 수 있는가** — 그 판정만 한다.
//
// 왜 만드는가
// ───────────
// 지금은 점검이 막으면 빨간 글씨만 뜨고 끝이다. 사용자가 할 수 있는 일이
// 없다. 그런데 막는 항목의 상당수는 **확인을 못 한 것**이지 문제가 확인된
// 것이 아니다 — 청산가를 못 읽었다, 상태 대조가 안 됐다 같은 것들이다.
// 그런 것까지 영구히 막으면 사용자는 이 앱을 끄고 거래소 앱을 연다.
// 그러면 안전장치가 하나도 안 걸린 채로 주문이 나간다. **막아서 앱을 떠나게
// 만드는 것은 안전이 아니다.**
//
// 그래서 "허용하시겠습니까 → 네/아니요"를 둔다. 대신 세 가지를 지킨다.
//
// 1. **한 번에 한 주문.** 무시한 상태가 저장되지 않는다. 토글로 만들면
//    한 번 켜고 잊어버리고, 그때부터 점검은 없는 것과 같다.
// 2. **항목을 하나하나 지목한다.** `force: true` 같은 통짜 우회를 두지
//    않는다. 물어본 사이에 **다른** 항목이 새로 막으면 그건 그대로 막혀야
//    한다 — 그러라고 항목을 세는 것이다.
// 3. **못 넘기는 항목이 있다.** 아래 NEVER가 그것이다.
//
// 무엇은 물어볼 수도 없는가
// ─────────────────────────
// 손실 한도(오늘·이번 주)와 연패 잠금이다. 이 셋의 존재 이유가 **"계속하고
// 싶은 바로 그 순간에 멈추는 것"**이다. 한 번 눌러 넘길 수 있으면 넘길
// 사람은 정확히 그 순간에 넘긴다. 그러면 그 안전장치는 있는 게 아니다.
//
// 사용자가 직접 적었던 요구이기도 하다 — "하루 최대 손실 제한 / 전략이
// 일정 기준 이하로 무너지면 자동 중지". 자동 중지가 한 번 눌러 풀리면
// 자동 중지가 아니다. 이 셋은 설정에서 한도를 바꾸는 방법으로만 푼다.

export interface BlockerLike {
  id: string;
  label?: string | null;
  status?: string | null;
  detail?: string | null;
  blocks?: boolean;
}

/**
 * 물어봐도 넘길 수 없는 항목.
 *
 * 여기 있는 것들은 "확인을 못 했다"가 아니라 **확인한 결과 멈춰야 한다**는
 * 뜻이고, 멈추는 것 자체가 목적이다.
 */
export const NEVER_OVERRIDABLE: readonly string[] = [
  'DAILY_LOSS_LIMIT',
  'WEEKLY_LOSS_LIMIT',
  'LOSS_STREAK',
];

/** 왜 못 넘기는지. 회색 버튼만 두면 사용자는 화면이 고장 났다고 생각한다. */
export const NEVER_REASON: Record<string, string> = {
  DAILY_LOSS_LIMIT: '오늘 손실 한도는 눌러서 넘길 수 없습니다. 넘길 수 있으면 한도가 아닙니다 — 한도 자체를 바꾸려면 설정에서 바꾸세요.',
  WEEKLY_LOSS_LIMIT: '이번 주 손실 한도는 눌러서 넘길 수 없습니다. 설정에서 한도를 바꾸는 방법으로만 풉니다.',
  LOSS_STREAK: '연패 잠금은 눌러서 넘길 수 없습니다. 연달아 잃은 뒤가 정확히 넘기고 싶어지는 순간이라, 그때 풀리면 잠금이 아닙니다.',
};

/**
 * 넘길 수 있는가.
 *
 * **상태를 같이 본다.** 위 NEVER 목록의 근거는 "확인한 결과 멈춰야 한다"는
 * 것이다 — 한도에 **걸렸을 때** 멈추는 게 목적이다. 그런데 예전에는 id만
 * 보고 잘랐다. 그래서 손실 한도를 **읽지 못한 경우**(status:'unknown')도
 * '한도에 걸렸다'와 똑같이 다뤄졌다.
 *
 * 그게 왜 나쁜가: `canAsk`는 못 넘기는 항목이 하나라도 있으면 false다.
 * 즉 손실 한도 표 하나를 못 읽으면 **다른 다섯 항목까지 통째로** 확인창이
 * 안 뜬다. 사용자에게는 "네/아니요가 안 나온다"로만 보이고, 이유는
 * 어디에도 안 적힌다. 실제로 그 상태가 났다.
 *
 * 그래서 NEVER 항목은 **'fail'일 때만** 못 넘기는 것으로 한다.
 * 'unknown'이면 물어볼 수 있게 하되, 문구에서 모른다는 사실을 크게 적는다.
 * 상태가 아예 없으면(값을 못 받았으면) 보수적으로 못 넘긴다 —
 * 모르는 것을 유리하게 읽지 않는다.
 */
export function canOverride(
  id: string | null | undefined,
  status?: string | null,
): boolean {
  const s = String(id || '');
  if (!s) return false;
  if (!NEVER_OVERRIDABLE.includes(s)) return true;
  return String(status || '') === 'unknown';
}

export interface OverrideOutcome {
  /** 사용자가 "네"를 눌러서 실제로 넘어간 항목 */
  waived: BlockerLike[];
  /** 여전히 막는 항목. 하나라도 있으면 주문은 나가지 않는다 */
  remaining: BlockerLike[];
  /** 넘겨달라고 했지만 넘길 수 없는 항목 */
  refused: BlockerLike[];
}

/**
 * 막힌 항목 목록에 사용자의 "네"를 적용한다.
 *
 * 순수 함수다. 네트워크도 DB도 안 탄다.
 *
 * @param blockers 이번에 실제로 막은 항목들
 * @param requested 사용자가 "네"를 누른 항목의 id 목록
 */
export function applyOverrides(
  blockers: BlockerLike[] | null | undefined,
  requested: string[] | null | undefined,
): OverrideOutcome {
  const list = Array.isArray(blockers) ? blockers.filter(Boolean) : [];
  // 요청 목록이 배열이 아니면 **아무것도 넘기지 않는다.** 이상한 값이
  // 왔을 때 통째로 통과시키는 쪽으로 기울면 그게 우회 경로가 된다.
  const asked = new Set(
    (Array.isArray(requested) ? requested : []).map(v => String(v || '')).filter(Boolean));

  const waived: BlockerLike[] = [];
  const remaining: BlockerLike[] = [];
  const refused: BlockerLike[] = [];

  for (const b of list) {
    const id = String(b?.id || '');
    if (!id || !asked.has(id)) { remaining.push(b); continue; }
    // **상태까지 같은 규칙으로 본다.** 화면(overridePrompt)이 물어본 것을
    // 서버(여기)가 거부하면 "네를 눌렀는데 왜 안 되지"가 된다. 두 곳이
    // 같은 함수를 같은 인자로 부르게 둔다.
    if (!canOverride(id, b?.status)) {
      // 넘겨달라고 했지만 안 된다. **막는 쪽에도 넣는다** — refused에만
      // 넣고 remaining에서 빼면 주문이 나간다.
      refused.push(b);
      remaining.push(b);
      continue;
    }
    waived.push(b);
  }

  return { waived, remaining, refused };
}

/**
 * 넘긴 항목을 안전 기록에 남길 줄로 바꾼다.
 *
 * 차단과 **같은 표**에 다른 status로 남긴다. 안 남기면 "안전장치가 한 번도
 * 발동 안 했다"와 "발동했는데 사용자가 매번 넘겼다"가 화면에서 똑같아
 * 보인다. 뒤쪽이 훨씬 위험한 상태인데 더 안전해 보이면 안 된다.
 */
export function waiveEventsFrom(
  waived: BlockerLike[] | null | undefined,
  ctx: { market?: string | null; symbol?: string | null } = {},
): Array<{ kind: string; label: string | null; status: string; market: string | null; symbol: string | null; reason: string | null }> {
  const list = Array.isArray(waived) ? waived.filter(Boolean) : [];
  const market = ctx.market ? String(ctx.market) : null;
  const symbol = ctx.symbol ? String(ctx.symbol) : null;
  return list.filter(b => b && b.id).map(b => ({
    kind: String(b.id),
    label: b.label ? String(b.label) : null,
    // 'blocked'가 아니라 'waived'다. 발동했지만 사용자가 통과시켰다는 뜻.
    status: 'waived',
    market, symbol,
    reason: `사용자가 확인하고 진행했습니다 (원래 상태: ${b.status || 'unknown'})`
      + (b.detail ? ` — ${b.detail}` : ''),
  }));
}

/**
 * 확인창에 띄울 문구.
 *
 * 화면과 서버가 같은 문구를 쓰라고 여기 둔다. 확인창이 "정말 진행할까요?"만
 * 묻고 무엇을 넘기는지 안 적으면, 누른 사람은 자기가 무엇을 껐는지 모른다.
 */
export function overridePrompt(
  blockers: BlockerLike[] | null | undefined,
  opts: { realMoney?: boolean } = {},
): {
  askable: BlockerLike[]; blocked: BlockerLike[]; text: string; canAsk: boolean;
  /** 확인창을 못 띄우는 이유. **canAsk가 false인데 이 값이 비면 안 된다** */
  whyNoAsk: string;
} {
  const list = Array.isArray(blockers) ? blockers.filter(Boolean) : [];
  const askable = list.filter(b => canOverride(b?.id, b?.status));
  const blocked = list.filter(b => !canOverride(b?.id, b?.status));

  const lines: string[] = [];

  if (askable.length > 0) {
    lines.push(`아래 ${askable.length}개 점검이 이 주문을 막고 있습니다.`);
    lines.push('');
    for (const b of askable) {
      const mark = String(b?.status) === 'unknown' ? '?' : '✕';
      lines.push(`${mark} ${b?.label || b?.id}`);
      if (b?.detail) lines.push(`   ${b.detail}`);
    }
    lines.push('');
    // '?'와 '✕'는 뜻이 다르다. 섞어서 "문제가 있습니다"로 뭉뚱그리면
    // 확인을 못 한 것과 확인해서 틀린 것이 같은 무게로 읽힌다.
    if (askable.some(b => String(b?.status) === 'unknown')) {
      lines.push('? 는 확인하지 못한 항목입니다 — 문제가 있다는 뜻이 아니라 모른다는 뜻입니다.');
    }
    if (askable.some(b => String(b?.status) === 'fail')) {
      lines.push('✕ 는 확인해 보니 조건에 맞지 않는 항목입니다.');
    }
    // 손실 한도를 '못 읽어서' 물어보는 경우는 따로 크게 적는다. 다른
    // 항목과 같은 무게로 지나가면, 한도를 넘긴 채로 넘기는 일이 생긴다.
    const unknownLimits = askable.filter(
      b => NEVER_OVERRIDABLE.includes(String(b?.id)) && String(b?.status) === 'unknown');
    if (unknownLimits.length > 0) {
      lines.push('');
      lines.push(`⚠ ${unknownLimits.map(b => b?.label || b?.id).join(' · ')}를 읽지 못했습니다.`);
      lines.push('   한도를 넘겼는지 아닌지 **모르는 상태**입니다 — 넘겼을 수도 있습니다.');
    }
    lines.push('');
    lines.push(opts.realMoney
      ? '실제 자금이 사용됩니다. 이 주문 한 건만 통과시킵니다.'
      : '이 주문 한 건만 통과시킵니다. 설정은 바뀌지 않습니다.');
  }

  if (blocked.length > 0) {
    if (lines.length) lines.push('');
    lines.push('넘길 수 없는 항목:');
    for (const b of blocked) {
      lines.push(`· ${b?.label || b?.id}`);
      const why = NEVER_REASON[String(b?.id)];
      if (why) lines.push(`   ${why}`);
    }
  }

  // 넘길 수 없는 항목이 하나라도 있으면 물어볼 이유가 없다 — "네"를
  // 눌러도 어차피 막힌다. 물어놓고 안 되는 것이 제일 나쁘다.
  const canAsk = askable.length > 0 && blocked.length === 0;

  // **왜 안 물어보는지를 반드시 만든다.**
  //
  // 예전에는 canAsk가 false면 화면이 그냥 아무것도 안 했다. 사용자에게는
  // "네/아니요가 안 나온다"로만 보이고, 이유는 어디에도 없었다. 실제로
  // 손실 한도 두 개를 못 읽어서 나머지 네 항목까지 확인창이 통째로 안 뜬
  // 일이 있었고, 그게 화면만 봐서는 고장과 구분되지 않았다.
  let whyNoAsk = '';
  if (!canAsk) {
    if (list.length === 0) whyNoAsk = '막은 항목을 받지 못했습니다.';
    else if (blocked.length > 0) {
      whyNoAsk = `${blocked.map(b => b?.label || b?.id).join(' · ')}는 눌러서 넘길 수 없어, `
        + '나머지 항목도 확인창으로 통과시킬 수 없습니다.';
    } else whyNoAsk = '넘길 수 있는 항목이 없습니다.';
  }

  return { askable, blocked, text: lines.join('\n'), canAsk, whyNoAsk };
}

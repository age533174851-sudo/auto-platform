// src/lib/execution/contractDiff.ts
//
// **실행 계약이 "바뀌었는가"와 "늘었는가"를 가른다.**
//
// 무엇이 문제였나
// ───────────────
// 계약 지문은 프로필 × 프리셋 **전 조합**을 한 문자열로 이어 붙인 값이고,
// 검사기는 그 문자열이 base와 다르면 `EXECUTION_CONTRACT_VERSION`을
// 올리라고 요구한다. 지키려는 성질은 분명하다 —
// **같은 예약이 다른 의미로 실행되면 안 된다.**
//
// 그런데 그 요구가 **새 프로필을 더하는 것**에도 똑같이 걸린다. 그리고
// 버전을 올리는 순간, 옛 버전으로 저장된 **기존 예약이 전부
// `VERSION_MISMATCH`**가 된다 — 09:00 강제 진입을 포함해서다.
//
// 즉 지금 구조에서는 "프로필 하나를 더한다"가 "운영 중인 모든 예약을
// 멈춘다"와 같은 값을 치른다. 그래서 아무도 프로필을 더하지 않거나,
// 더하면서 운영을 깨뜨린다.
//
// 무엇을 바꾸는가
// ───────────────
// 지문을 **줄 단위로** 본다. 줄 하나는 조합 하나(`프로필|프리셋`)다.
//
//   바뀐 줄    기존 조합의 실행값이 달라졌다  → **버전을 올려야 한다**
//   사라진 줄  기존 조합이 없어졌다          → **버전을 올려야 한다**
//   늘어난 줄  새 조합이 생겼을 뿐이다        → 올리지 않아도 된다
//
// **관문을 지운 것이 아니다.** 저장된 예약은 자기가 고른 프로필 id를
// 가리키고, 그 조합의 줄이 그대로면 의미도 그대로다. 새 조합이 생긴 것은
// 그 예약이 읽는 어떤 값도 바꾸지 않는다. 바뀜과 사라짐은 **그대로 막는다.**
//
// 칸 목록(`#fields`)도 줄 하나다 — 이름이 바뀌면 그것은 '바뀐 줄'이고,
// 모든 조합의 투영이 달라지므로 버전을 올려야 한다.
//
// 왜 스크립트가 아니라 여기 있는가
// ────────────────────────────────
// 이 판단은 검사기 안에만 있으면 시험을 붙일 수 없고, 시험이 없는 관문은
// 조용히 느슨해진다. 저장소 규칙대로 **판단은 한 곳에 두고 검사기가
// 그 파일을 컴파일해서 쓴다**(`gen-migration-manifest.mjs`의 `loadPlan()`).

/** `[조합 키, 그 조합의 실행값 문자열]` */
export type ContractRow = [string, string];

export interface ContractRowDiff {
  /** 새로 생긴 조합 */
  added: string[];
  /** 없어진 조합 */
  removed: string[];
  /** 양쪽에 있는데 값이 다른 조합 */
  changed: string[];
}

function toMap(rows: ContractRow[] | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows ?? []) {
    if (!Array.isArray(r) || r.length < 2) continue;
    m.set(String(r[0]), String(r[1]));
  }
  return m;
}

export function diffContractRows(
  base: ContractRow[] | null | undefined,
  head: ContractRow[] | null | undefined,
): ContractRowDiff {
  const b = toMap(base), h = toMap(head);
  const added: string[] = [], removed: string[] = [], changed: string[] = [];
  for (const [k, v] of h) {
    if (!b.has(k)) added.push(k);
    else if (b.get(k) !== v) changed.push(k);
  }
  for (const k of b.keys()) if (!h.has(k)) removed.push(k);
  added.sort(); removed.sort(); changed.sort();
  return { added, removed, changed };
}

export type ContractBumpCode =
  /** 달라진 줄이 없다 */
  | 'OK_UNCHANGED'
  /** 늘어나기만 했다 — 저장된 예약의 의미는 그대로다 */
  | 'OK_ADDED_ONLY'
  /** 바뀌거나 사라졌고, 버전도 올랐다 */
  | 'OK_BUMPED'
  /** 바뀌거나 사라졌는데 버전이 그대로다 */
  | 'NEEDS_BUMP'
  /** 버전이 내려갔다 — 저장된 예약이 전부 어긋난다 */
  | 'VERSION_WENT_DOWN';

export interface ContractBumpVerdict {
  ok: boolean;
  code: ContractBumpCode;
  diff: ContractRowDiff;
  message: string;
}

const list = (xs: string[], n = 6) =>
  xs.slice(0, n).join(', ') + (xs.length > n ? ` 외 ${xs.length - n}개` : '');

export function contractBumpVerdict(i: {
  base: ContractRow[] | null | undefined;
  head: ContractRow[] | null | undefined;
  baseVersion: unknown;
  headVersion: unknown;
}): ContractBumpVerdict {
  const diff = diffContractRows(i.base, i.head);
  const bv = Number(i.baseVersion), hv = Number(i.headVersion);

  if (!Number.isInteger(hv)) {
    return { ok: false, code: 'NEEDS_BUMP', diff,
      message: `EXECUTION_CONTRACT_VERSION이 정수가 아닙니다 (${String(i.headVersion)})` };
  }
  // **내려가는 것은 언제나 사고다.** 달라진 줄이 없어도 막는다.
  if (Number.isInteger(bv) && hv < bv) {
    return { ok: false, code: 'VERSION_WENT_DOWN', diff,
      message: `EXECUTION_CONTRACT_VERSION이 내려갔습니다 (${bv} → ${hv})`
        + ' — 저장된 예약이 모두 VERSION_MISMATCH가 됩니다' };
  }

  const broke = diff.changed.length > 0 || diff.removed.length > 0;
  if (broke) {
    const what = [
      diff.changed.length ? `바뀐 조합 ${diff.changed.length}개 (${list(diff.changed)})` : '',
      diff.removed.length ? `없어진 조합 ${diff.removed.length}개 (${list(diff.removed)})` : '',
    ].filter(Boolean).join(' · ');
    if (Number.isInteger(bv) && hv > bv) {
      return { ok: true, code: 'OK_BUMPED', diff,
        message: `실행 계약이 바뀌었고 버전도 올랐습니다 (${bv} → ${hv}) — ${what}` };
    }
    return { ok: false, code: 'NEEDS_BUMP', diff,
      message: `실행 계약이 바뀌었는데 EXECUTION_CONTRACT_VERSION이 그대로입니다 (${hv})`
        + ` — 같은 예약이 다른 의미로 실행됩니다. ${what}` };
  }

  if (diff.added.length > 0) {
    return { ok: true, code: 'OK_ADDED_ONLY', diff,
      message: `새 조합 ${diff.added.length}개가 생겼습니다 (${list(diff.added)})`
        + ' — 기존 조합의 실행값은 그대로라 버전을 올리지 않습니다'
        + ' (올리면 저장된 예약이 전부 VERSION_MISMATCH가 됩니다)' };
  }

  return { ok: true, code: 'OK_UNCHANGED', diff, message: '실행 계약이 그대로입니다' };
}

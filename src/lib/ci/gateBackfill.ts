// src/lib/ci/gateBackfill.ts
//
// **필수 체크가 "빨갛다"가 아니라 "아예 없다"로 막히는 자리.**
//
// `auto-merge-gate`는 main ruleset의 필수 검사다. 그런데 그 체크는 아무도
// 그 PR을 판정해서 만드는 것이 아니라, `auto-merge` 워크플로의 job이 그
// 커밋 위에서 돌았다는 **부산물**로 생긴다. 그래서 run이 줄에서 밀리면
// 체크가 통째로 안 생기고, PR은 이유 없이 영원히 막힌다.
//
// 실측 (2026-11-19, PR #641 · HEAD `db9daa57`):
//
//   09:42:07  pull_request_target  cancelled  시작한 잡 0개
//   09:42:11  pull_request_target  cancelled  시작한 잡 0개
//
// 둘 다 `auto-merge-db9daa57` 한 그룹이고, 그룹이 통째로 비었다.
// 같은 자국이 2026-11-13 PR #576 `cfe3efcb`에도 남아 있다.
//
// **30분 안전망은 이걸 못 고친다.** `schedule` 실행의 `head_sha`는 main이라
// 그 실행이 만드는 체크는 main에 붙는다 — PR head에는 영영 안 붙는다.
// 실측: run 44487616985, `head_sha=ebf5e62f`(그때의 main).
//
// 그래서 **체크의 존재를 run의 운에 맡기지 않는다.** 러너가 PR head를
// 직접 보고, 없으면 적는다. 그러면 어느 트리거로 돌든 — 30분 안전망
// 포함 — 빈 게이트가 다음 회차에 메워진다.
//
// 판정만 여기 둔다. 실제 호출은 `scripts/auto-merge.mjs`가 한다.

export type GateBackfillCode = 'PRESENT' | 'MISSING' | 'UNREADABLE';

export interface GateBackfillVerdict {
  code: GateBackfillCode;
  /** 체크를 새로 적어야 하는가 */
  publish: boolean;
  reason: string;
}

/**
 * 이 커밋에 게이트 체크가 있는가.
 *
 * **못 읽은 것을 "없음"으로 적지 않는다.** 목록을 못 읽었는데 없다고 치고
 * 새로 적으면, 실제로는 돌고 있거나 빨간 체크 위에 초록을 덮을 수 있다.
 * 그건 이 저장소에서 가장 비싼 종류의 실수다 — 막혀 있어야 할 것이 지나간다.
 *
 * 상태는 보지 않고 **이름만** 본다. pending이든 failure든 이미 있는 것은
 * 그 run이 책임진다 — 여기서 손대면 남의 판정을 덮는다.
 */
export function gateBackfillVerdict(i: {
  selfName: string;
  /** 그 커밋의 체크 목록. **null이면 못 읽은 것이다** */
  checkRuns: Array<{ name?: string | null }> | null;
}): GateBackfillVerdict {
  const selfName = String(i?.selfName ?? '');
  if (!selfName) {
    return { code: 'UNREADABLE', publish: false,
      reason: '게이트 이름이 비어 있습니다 — 무엇을 찾아야 할지 모르면 적지 않습니다' };
  }
  if (i?.checkRuns == null) {
    return { code: 'UNREADABLE', publish: false,
      reason: `체크 목록을 읽지 못했습니다 — 없다는 뜻이 아닙니다 (${selfName})` };
  }
  const has = i.checkRuns.some(c => String(c?.name ?? '') === selfName);
  if (has) {
    return { code: 'PRESENT', publish: false,
      reason: `${selfName}이 이미 있습니다 — 그 run이 책임집니다` };
  }
  return { code: 'MISSING', publish: true,
    reason: `${selfName}이 이 커밋에 없습니다 — run이 줄에서 밀려 체크가 생기지 않았습니다` };
}

/**
 * 메운 체크에 적을 말.
 *
 * **메웠다는 사실을 숨기지 않는다.** 그냥 초록만 찍으면 다음 사람이
 * "정상적으로 돌았다"로 읽는다. 어느 run이 메웠는지까지 남긴다.
 */
export function gateBackfillOutput(i: { runUrl?: string | null }): {
  title: string; summary: string;
} {
  const url = (i?.runUrl ?? '').trim();
  return {
    title: '안전망이 채운 게이트',
    summary: [
      '이 체크는 **안전망이 채웠습니다.**',
      '',
      '원래 이 커밋 위에서 돌았어야 할 `auto-merge` run이 같은 head SHA의',
      '다른 신호에 밀려 줄에서 사라졌습니다 (시작한 잡 0개 · cancelled).',
      '그러면 필수 체크가 **빨갛지 않고 아예 없어서** PR이 이유 없이 막힙니다.',
      '',
      '판정 자체는 바뀌지 않았습니다 — `verify`를 비롯한 다른 필수 검사는',
      '그대로이고, 자동 머지는 여전히 라벨이 붙은 PR만 봅니다.',
      url ? `\n메운 run: ${url}` : '',
    ].join('\n'),
  };
}

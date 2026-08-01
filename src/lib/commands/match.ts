// src/lib/commands/match.ts
//
// 질의 → 커맨드 순위.
//
// 순위가 왜 중요한가
// ──────────────────
// 초성 검색을 넣으면 한 글자 질의('ㅁ')가 수십 개에 맞는다. 목록에 다
// 나오는 건 상관없다 — 문제는 **첫 줄**이다. 사용자는 Ctrl+K를 누르고
// 바로 Enter를 치는 습관이 든다. 첫 줄이 엉뚱하면 그 습관이 사고가 된다.
//
// 그래서 점수는 "얼마나 정확히, 얼마나 앞에서 맞았나"로만 정한다.
// 사용 빈도 같은 학습은 넣지 않았다 — 같은 입력이 어제와 다른 결과를
// 내면 손이 기억한 순서가 매번 틀린다.

import type { Command, CommandHit, MatchField } from './types';
import { indexOfMatch, hasChoseongJamo } from './hangul';

/**
 * 필드별 기본 점수.
 *
 * label > 초성 > kw > desc 순서다. desc를 낮게 두는 이유: 설명은 길어서
 * 아무 질의나 걸린다. 설명에서 맞은 것이 라벨에서 맞은 것보다 위로 오면
 * 목록이 뒤집힌 것처럼 보인다.
 */
const FIELD_BASE: Record<MatchField, number> = {
  label: 1000,
  choseong: 700,
  kw: 400,
  desc: 150,
};

/** 완전 일치 가산 */
const EXACT_BONUS = 500;
/** 처음부터 맞았을 때 가산 */
const PREFIX_BONUS = 200;

/**
 * 맞은 위치가 뒤일수록 깎는다. 위치당 1점.
 *
 * 필드 간 순서를 뒤집지 않을 만큼만 깎는다 — 위치 때문에 label 매치가
 * kw 매치 밑으로 내려가면 안 된다. label(1000)과 kw(400) 사이가 600이라
 * 라벨 길이가 600자를 넘지 않는 한 순서는 유지된다.
 */
function positionPenalty(at: number): number {
  return at;
}

/** 질의 정규화. 앞뒤 공백만 버린다 — 안쪽 공백은 의미가 있다 */
export function normalizeQuery(q: string): string {
  return String(q ?? '').trim();
}

/**
 * 커맨드 하나에 점수를 매긴다. 안 맞으면 null.
 *
 * 여러 필드에서 맞으면 **가장 높은 점수 하나만** 쓴다. 더하면 설명이 긴
 * 항목이 유리해진다 — 검색 품질과 아무 상관 없는 이유로.
 */
export function scoreCommand(cmd: Command, query: string): CommandHit | null {
  const q = normalizeQuery(query);
  if (!q) return null;

  let best: CommandHit | null = null;
  const take = (score: number, field: MatchField, range: CommandHit['range']) => {
    if (!best || score > best.score) best = { command: cmd, score, field, range };
  };

  // 초성 낱자가 섞인 질의인가.
  //
  // 이 한 줄이 순위의 핵심이다. `indexOfMatch`는 초성 낱자를 음절의 초성과
  // 비교하므로 'ㅈㄷ'도 '자동매매'의 **라벨에서** 맞는다. 그래서 초성열을
  // 따로 만들어 비교하는 경로가 필요 없다 — 라벨 경로가 이미 포함한다.
  //
  // 다만 그걸 그냥 두면 'ㅈㄷ'와 '자동'이 **같은 점수**를 받는다. 정확히
  // 친 사람이 초성만 친 사람과 같은 대우를 받으면 순위가 뒤섞인다.
  // 그래서 맞은 자리는 같아도 **계층을 낮춰** 기록한다.
  const usesCho = hasChoseongJamo(q);
  const qLen = [...q].length;

  // 1) 라벨 매칭 — 초성이든 완성 음절이든 여기서 같이 처리된다
  const atLabel = indexOfMatch(q, cmd.label);
  if (atLabel >= 0) {
    const field: MatchField = usesCho ? 'choseong' : 'label';
    const exact = [...cmd.label].length === qLen;
    take(
      FIELD_BASE[field]
        // 초성으로 라벨 전체를 덮은 것('ㅈㄷㅁㅁ' → '자동매매')도 강한
        // 신호다. 계층은 낮지만 완전 일치 가산은 준다.
        + (exact ? EXACT_BONUS : 0)
        + (atLabel === 0 ? PREFIX_BONUS : 0)
        - positionPenalty(atLabel),
      field,
      { start: atLabel, end: atLabel + qLen },
    );
  }

  // 2) 추가 검색어 — 여기도 초성이 통한다 ('ㅂ' → kw의 '봇')
  if (cmd.kw) {
    const atKw = indexOfMatch(q, cmd.kw);
    if (atKw >= 0) {
      take(FIELD_BASE.kw + (atKw === 0 ? PREFIX_BONUS : 0) - positionPenalty(atKw), 'kw', null);
    }
  }

  // 4) 설명 — 마지막 그물
  if (cmd.desc) {
    const atDesc = indexOfMatch(q, cmd.desc);
    if (atDesc >= 0) take(FIELD_BASE.desc - positionPenalty(atDesc), 'desc', null);
  }

  return best;
}

export interface SearchOptions {
  /** 관리자 전용 커맨드를 포함할지 */
  isAdmin?: boolean;
  /** 최대 결과 수. 0이나 음수면 제한 없음 */
  limit?: number;
}

/**
 * 질의에 맞는 커맨드를 점수 순으로.
 *
 * 빈 질의는 **빈 배열이 아니라** 원래 순서 그대로 돌려준다. 팔레트를 열면
 * 처음에는 전체 목록이 보여야 한다 — 뭘 칠 수 있는지 모르는 사용자가
 * 빈 화면을 보면 거기서 닫는다.
 */
export function searchCommands(
  all: Command[],
  query: string,
  opts: SearchOptions = {},
): CommandHit[] {
  const visible = all.filter(c => !c.adminOnly || opts.isAdmin);
  const q = normalizeQuery(query);
  const limit = opts.limit ?? 0;

  const cut = (rows: CommandHit[]) => (limit > 0 ? rows.slice(0, limit) : rows);

  if (!q) {
    return cut(visible.map(c => ({ command: c, score: 0, field: 'label' as MatchField, range: null })));
  }

  const hits: CommandHit[] = [];
  for (const c of visible) {
    const h = scoreCommand(c, q);
    if (h) hits.push(h);
  }

  // 점수 같으면 원래 순서를 지킨다. Array.sort는 안정 정렬이지만(ES2019+)
  // 그걸 믿고 두면 나중에 정렬을 바꿀 때 조용히 순서가 흔들린다.
  const order = new Map(visible.map((c, i) => [c.id, i]));
  hits.sort((a, b) =>
    b.score - a.score
    || (order.get(a.command.id) ?? 0) - (order.get(b.command.id) ?? 0));

  return cut(hits);
}

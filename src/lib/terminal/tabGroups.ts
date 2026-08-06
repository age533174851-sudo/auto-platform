// src/lib/terminal/tabGroups.ts
//
// **탭이 열여덟 개다.**
//
// 무엇이 문제였나
// ───────────────
// 하단 독의 탭 줄이 가로 스크롤이다. 폰에서는 `포지션 / 데모 / 미체결 /
// 자산 / 자금배분 / 안전장...` 까지 보이고 나머지 열두 개는 화면 밖에
// 있다. 끝이 잘려 보이니 **스크롤이 되는 줄인지도 모른다.**
//
// 그리고 그 열여덟 개는 무게가 전혀 다르다. '포지션'은 거래 중 계속
// 봐야 하는 것이고 '로그인 진단'은 일 년에 한 번 볼까 말까다. 같은
// 크기로 같은 줄에 두면 매번 눈이 열여덟 개를 훑는다.
//
// 무엇을 하는가
// ─────────────
// 자주 쓰는 것만 앞줄에 두고 나머지는 '더보기'로 접는다.
// **지우지 않는다** — 접을 뿐이다. 기능을 없애는 것과 첫 화면에서
// 치우는 것은 다르다.
//
// 규칙 하나: **지금 보고 있는 탭은 언제나 앞줄에 있다.**
// '더보기'에서 고른 탭이 접히면, 사용자는 자기가 어디 있는지 모른 채로
// 화면을 보게 된다. 그건 축약이 아니라 길을 잃게 하는 것이다.

/** 거래 중 계속 봐야 하는 것. 순서도 이 순서다 */
export const PRIMARY_TABS = ['포지션', '미체결', '자산'] as const;

/**
 * '데모'는 앞줄에 두지 않는다.
 *
 * 모의 자동매매 실행기라 포지션·미체결과 같은 층이 아니다. 같은 줄에
 * 두면 "지금 도는 것이 데모인가"가 헷갈린다 — 실제로 그 혼동이 있었다.
 */
export interface SplitOptions {
  /** 좁은 화면인가. 넓으면 접지 않는다 */
  compact?: boolean;
  /** 지금 고른 탭 */
  active?: string | null;
  /** 앞줄에 둘 개수. 기본은 PRIMARY_TABS */
  primary?: readonly string[];
}

export interface TabSplit {
  /** 앞줄에 그릴 것 */
  primary: string[];
  /** '더보기' 안에 접을 것 */
  more: string[];
  /** 지금 고른 탭이 '더보기' 쪽인가 */
  activeInMore: boolean;
  /** '더보기' 버튼에 적을 말 */
  moreLabel: string;
}

/**
 * 탭을 앞줄과 '더보기'로 나눈다.
 *
 * 순수 함수다 — 화면 안에 적으면 모바일과 PC가 다른 규칙을 쓰게 되고,
 * 그러면 "폰에서는 있는데 PC에는 없는 탭"이 생긴다.
 */
export function splitTabs(all: readonly string[] | null | undefined, opts: SplitOptions = {}): TabSplit {
  const list = (Array.isArray(all) ? all : []).filter(t => typeof t === 'string' && t);
  const active = String(opts.active ?? '');

  // 넓은 화면에서는 접지 않는다. 자리가 있는데 숨기면 클릭이 한 번 는다.
  if (!opts.compact) {
    return { primary: [...list], more: [], activeInMore: false, moreLabel: '더보기' };
  }

  const wanted = opts.primary ?? PRIMARY_TABS;
  const primary = list.filter(t => wanted.includes(t as any));
  // 앞줄 순서는 **wanted의 순서**다. 원본 배열 순서를 따르면 화면마다
  // 순서가 달라진다.
  primary.sort((a, b) => wanted.indexOf(a as any) - wanted.indexOf(b as any));

  const more = list.filter(t => !wanted.includes(t as any));

  // **지금 보고 있는 탭은 언제나 앞줄에 있다.**
  const activeInMore = !!active && more.includes(active);
  if (activeInMore) primary.push(active);

  return {
    primary,
    more,
    activeInMore,
    // 더보기 안에 있는 것을 고른 상태면 버튼에 그 이름을 적는다 —
    // '더보기'만 적으면 어디에 있는지 알 수 없다.
    moreLabel: more.length === 0 ? '더보기' : `더보기 ${more.length}`,
  };
}

/**
 * '더보기' 목록을 묶어서 보여줄 때의 갈래.
 *
 * 열두 개를 한 줄로 늘어놓으면 그것대로 못 읽는다. 성격이 같은 것끼리
 * 묶으면 "안전 관련은 여기"가 눈에 들어온다.
 */
export const TAB_GROUPS: Array<{ title: string; tabs: readonly string[] }> = [
  { title: '자금', tabs: ['자금배분', '현물·선물'] },
  { title: '안전', tabs: ['안전장치', '손절이동', '시간예약', '상태대조'] },
  { title: '전략', tabs: ['전략', '전략장부', '현물전략', '방송자', '방송장부', '데모'] },
  { title: '계정·진단', tabs: ['설정', '증권사', '상태', '로그인'] },
];

/** '더보기' 목록을 갈래로 나눈다. 어디에도 안 속한 것은 '그 밖에'로 */
export function groupMoreTabs(more: readonly string[] | null | undefined):
  Array<{ title: string; tabs: string[] }> {
  const list = (Array.isArray(more) ? more : []).slice();
  const out: Array<{ title: string; tabs: string[] }> = [];
  const used = new Set<string>();

  for (const g of TAB_GROUPS) {
    const tabs = list.filter(t => g.tabs.includes(t));
    if (tabs.length === 0) continue;
    tabs.forEach(t => used.add(t));
    out.push({ title: g.title, tabs });
  }

  // **빠뜨리지 않는다.** 새 탭이 생겼는데 갈래에 안 넣으면 '더보기'에서
  // 사라진다 — 기능이 있는데 갈 방법이 없는 상태가 된다.
  const rest = list.filter(t => !used.has(t));
  if (rest.length > 0) out.push({ title: '그 밖에', tabs: rest });
  return out;
}

// src/lib/terminal/tabGroups.test.ts
//
// 막으려는 것:
//  1. 탭 열여덟 개가 가로 스크롤 한 줄에 들어가, 끝이 잘려 보이니
//     **스크롤이 되는 줄인지도 모르는 것**
//  2. '더보기'에서 고른 탭이 접혀서, 사용자가 자기가 어디 있는지
//     모른 채로 화면을 보게 되는 것
//  3. 새 탭이 생겼는데 갈래에 안 들어가 '더보기'에서 사라지는 것 —
//     기능이 있는데 갈 방법이 없는 상태
//  4. 폰과 PC가 다른 규칙을 써서 "폰에는 있는데 PC에는 없는 탭"이 생기는 것
import { test, assert, eq } from '../../test/harness';
import { splitTabs, groupMoreTabs, PRIMARY_TABS, TAB_GROUPS } from './tabGroups';

const ALL = ['포지션', '데모', '미체결', '자산', '자금배분', '안전장치', '손절이동',
  '시간예약', '설정', '증권사', '상태', '방송자', '로그인', '전략장부', '방송장부',
  '현물전략', '현물·선물', '상태대조', '전략'];

export function runTabGroupsTests() {
  console.log('[탭 축약 — 자주 쓰는 것만 앞줄에]');

  test('좁은 화면에서는 포지션·미체결·자산만 앞줄이다', () => {
    const r = splitTabs(ALL, { compact: true, active: '포지션' });
    eq(r.primary.join(','), '포지션,미체결,자산');
    eq(r.more.length, ALL.length - 3);
  });

  test('앞줄 순서는 원본 배열이 아니라 정해진 순서다', () => {
    // 원본에서는 데모가 미체결보다 앞이다. 화면마다 순서가 달라지면 안 된다.
    const r = splitTabs(['자산', '미체결', '포지션'], { compact: true });
    eq(r.primary.join(','), '포지션,미체결,자산');
  });

  test('넓은 화면에서는 접지 않는다', () => {
    // 자리가 있는데 숨기면 클릭이 한 번 는다.
    const r = splitTabs(ALL, { compact: false });
    eq(r.primary.length, ALL.length);
    eq(r.more.length, 0);
  });

  test('데모는 앞줄에 없다', () => {
    // 모의 자동매매 실행기라 포지션·미체결과 같은 층이 아니다.
    assert(!PRIMARY_TABS.includes('데모' as any));
    eq(splitTabs(ALL, { compact: true }).more.includes('데모'), true);
  });

  console.log('[탭 축약 — 지금 보고 있는 탭은 언제나 앞줄에]');

  test('더보기에서 고른 탭이 앞줄로 올라온다', () => {
    // 접히면 사용자는 자기가 어디 있는지 모른 채로 화면을 본다.
    const r = splitTabs(ALL, { compact: true, active: '안전장치' });
    assert(r.primary.includes('안전장치'), r.primary.join(','));
    eq(r.activeInMore, true);
    eq(r.primary[r.primary.length - 1], '안전장치', '고른 탭이 끝에 붙는다');
  });

  test('앞줄 탭을 고르면 아무것도 안 바뀐다', () => {
    const r = splitTabs(ALL, { compact: true, active: '미체결' });
    eq(r.primary.join(','), '포지션,미체결,자산');
    eq(r.activeInMore, false);
  });

  test('고른 탭이 없어도 터지지 않는다', () => {
    eq(splitTabs(ALL, { compact: true }).activeInMore, false);
    eq(splitTabs(ALL, { compact: true, active: null }).primary.length, 3);
    eq(splitTabs(ALL, { compact: true, active: '없는탭' }).activeInMore, false);
  });

  test('더보기 버튼에 개수를 적는다', () => {
    // '더보기'만 적으면 몇 개가 접혀 있는지 알 수 없다.
    const r = splitTabs(ALL, { compact: true });
    assert(r.moreLabel.includes(String(ALL.length - 3)), r.moreLabel);
    eq(splitTabs(['포지션'], { compact: true }).moreLabel, '더보기');
  });

  console.log('[탭 축약 — 더보기 안의 갈래]');

  test('성격이 같은 것끼리 묶는다', () => {
    const r = splitTabs(ALL, { compact: true });
    const groups = groupMoreTabs(r.more);
    const titles = groups.map(g => g.title);
    assert(titles.includes('안전'), titles.join(','));
    assert(titles.includes('전략'), titles.join(','));
    const safety = groups.find(g => g.title === '안전')!;
    assert(safety.tabs.includes('상태대조'), safety.tabs.join(','));
  });

  test('빠뜨리지 않는다 — 갈래에 없는 탭도 나온다', () => {
    // 새 탭이 생겼는데 갈래에 안 넣으면 '더보기'에서 사라진다.
    // 기능이 있는데 갈 방법이 없는 상태가 된다.
    const groups = groupMoreTabs(['안전장치', '새로생긴탭']);
    const all = groups.flatMap(g => g.tabs);
    assert(all.includes('새로생긴탭'), all.join(','));
    assert(groups.some(g => g.title === '그 밖에'), groups.map(g => g.title).join(','));
  });

  test('접힌 탭이 하나도 안 사라진다', () => {
    const r = splitTabs(ALL, { compact: true, active: '포지션' });
    const shown = new Set([...r.primary, ...groupMoreTabs(r.more).flatMap(g => g.tabs)]);
    for (const t of ALL) assert(shown.has(t), `${t}가 어디에도 없다`);
  });

  test('갈래 정의에 중복이 없다', () => {
    const seen = new Set<string>();
    for (const g of TAB_GROUPS) {
      for (const t of g.tabs) {
        assert(!seen.has(t), `${t}가 두 갈래에 있다`);
        seen.add(t);
      }
    }
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(splitTabs(null, { compact: true }).primary.length, 0);
    eq(splitTabs([], { compact: true }).more.length, 0);
    eq(groupMoreTabs(null).length, 0);
    eq(groupMoreTabs([]).length, 0);
  });
}

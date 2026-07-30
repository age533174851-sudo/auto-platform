// src/lib/commands/commands.test.ts
//
// 초성 매칭과 순위를 못 박는다.
//
// 여기서 틀리면 화면은 정상으로 보인다 — 목록이 나오니까. 결과가 몇 개
// 빠졌거나 첫 줄이 엉뚱한 것은 눈으로 알 수 없다. 특히 첫 줄이 중요하다:
// 사용자는 Ctrl+K → 타이핑 → Enter를 손이 기억하게 된다.

import { test, eq, assert } from '../../test/harness';
import {
  choseongOf, choseongOfText, isChoseongJamo, isSyllable,
  charMatches, indexOfMatch, startsWithMatch, hasChoseongJamo, CHOSEONG,
} from './hangul';
import { scoreCommand, searchCommands, normalizeQuery } from './match';
import {
  menuToCommands, symbolsToCommands, buildCommands, needsConfirm,
  EXTRA_COMMANDS, type MenuLike,
} from './registry';
import type { Command } from './types';

// 실제 MENU에서 가져온 모양 (아이콘·색은 뺐다 — 레지스트리가 안 쓴다)
const MENU_FIXTURE: MenuLike[] = [
  { id: 'trading',  label: '매매하기',   desc: '차트·호가·주문 통합 화면', cat: '거래',     kw: '롱숏 매수매도 주문', href: '/terminal' },
  { id: 'calendar', label: '경제캘린더', desc: 'FOMC·CPI 등 일정',       cat: '투자정보', kw: 'fomc cpi 일정' },
  { id: 'auto',     label: '자동매매',   desc: 'AI가 대신 자동 거래',     cat: '자동화',   kw: '봇 자동 bot' },
  { id: 'news',     label: '뉴스',       desc: '최신 코인·주식 뉴스',     cat: '투자정보', kw: 'news' },
  { id: 'analysis', label: 'AI 분석',    desc: 'AI 시장 분석 허브',       cat: '투자정보', kw: 'ai 분석' },
  { id: 'market',   label: '시장 보기',  desc: '실시간 코인·주식 시세',   cat: '투자정보', kw: '시세 가격' },
  { id: 'risk_settings', label: '리스크 관리', desc: '손실 한도·킬스위치', cat: '자동화', kw: '킬스위치 한도' },
];

const ALL = buildCommands(MENU_FIXTURE);

/** 질의로 나온 라벨 목록 */
function labels(q: string, isAdmin = false): string[] {
  return searchCommands(ALL, q, { isAdmin }).map(h => h.command.label);
}
/** 첫 줄 라벨 */
function first(q: string, isAdmin = false): string | null {
  return labels(q, isAdmin)[0] ?? null;
}

export function runCommandTests() {
  console.log('[커맨드 — 한글 초성 분해]');

  test('초성 19자가 순서대로 있다', () => {
    eq(CHOSEONG.length, 19);
    eq(CHOSEONG[0], 'ㄱ');
    eq(CHOSEONG[18], 'ㅎ');
  });

  test('음절에서 초성을 뽑는다', () => {
    eq(choseongOf('가'), 'ㄱ');
    eq(choseongOf('경'), 'ㄱ');
    eq(choseongOf('제'), 'ㅈ');
    eq(choseongOf('캘'), 'ㅋ');
    eq(choseongOf('힣'), 'ㅎ');
  });

  test('종성이 있어도 초성만 본다', () => {
    eq(choseongOf('값'), 'ㄱ');
    eq(choseongOf('닭'), 'ㄷ');
  });

  test('쌍자음 초성도 정확히 — 호환 자모 블록에 겹받침이 끼어 있어 산술로는 틀린다', () => {
    eq(choseongOf('까'), 'ㄲ');
    eq(choseongOf('따'), 'ㄸ');
    eq(choseongOf('빠'), 'ㅃ');
    eq(choseongOf('싸'), 'ㅆ');
    eq(choseongOf('짜'), 'ㅉ');
  });

  test('한글이 아니면 null', () => {
    eq(choseongOf('A'), null);
    eq(choseongOf('1'), null);
    eq(choseongOf(' '), null);
    eq(choseongOf('ㄱ'), null);   // 낱자는 음절이 아니다
    eq(choseongOf(''), null);
  });

  test('완성형 음절 판정', () => {
    eq(isSyllable('가'), true);
    eq(isSyllable('힣'), true);
    eq(isSyllable('ㄱ'), false);
    eq(isSyllable('A'), false);
  });

  test('초성 낱자만 초성으로 인정한다 — 모음은 아니다', () => {
    eq(isChoseongJamo('ㄱ'), true);
    eq(isChoseongJamo('ㅎ'), true);
    eq(isChoseongJamo('ㅏ'), false, '모음이 초성으로 잡히면 안 된다');
    eq(isChoseongJamo('ㅑ'), false);
    eq(isChoseongJamo('ㄳ'), false, '겹받침은 초성이 아니다');
    eq(isChoseongJamo('A'), false);
  });

  test('문자열의 초성 열 — 한글 아닌 문자는 그대로 남는다', () => {
    eq(choseongOfText('경제캘린더'), 'ㄱㅈㅋㄹㄷ');
    eq(choseongOfText('자동매매'), 'ㅈㄷㅁㅁ');
    eq(choseongOfText('AI 분석'), 'AI ㅂㅅ');
    eq(choseongOfText('BTC'), 'BTC');
    eq(choseongOfText(''), '');
  });

  console.log('[커맨드 — 글자 비교]');

  test('초성 낱자는 음절의 초성과 맞는다', () => {
    eq(charMatches('ㄱ', '경'), true);
    eq(charMatches('ㅋ', '캘'), true);
    eq(charMatches('ㄱ', '제'), false);
  });

  test('ㄱ은 ㄲ에 맞지 않는다 — 느슨하게 하면 순위가 무의미해진다', () => {
    eq(charMatches('ㄱ', '까'), false);
    eq(charMatches('ㄲ', '까'), true);
    eq(charMatches('ㄲ', '가'), false);
  });

  test('영문은 대소문자를 무시한다', () => {
    eq(charMatches('a', 'A'), true);
    eq(charMatches('B', 'b'), true);
  });

  test('완성 음절 질의는 그대로 비교한다', () => {
    eq(charMatches('경', '경'), true);
    eq(charMatches('경', '강'), false);
  });

  console.log('[커맨드 — 연속 매칭]');

  test('순수 초성 질의가 라벨 초성열에 맞는다', () => {
    eq(indexOfMatch('ㄱㅈㅋ', choseongOfText('경제캘린더')), 0);
    eq(indexOfMatch('ㅈㄷ', choseongOfText('자동매매')), 0);
  });

  test('중간에서 시작하는 초성도 찾는다', () => {
    // '경제캘린더' → 'ㄱㅈㅋㄹㄷ' 에서 'ㅋㄹㄷ'는 2번째부터
    eq(indexOfMatch('ㅋㄹㄷ', choseongOfText('경제캘린더')), 2);
  });

  test('건너뛰기는 허용하지 않는다 — 허용하면 결과가 목록 전체가 된다', () => {
    // 'ㄱㅋ'는 'ㄱㅈㅋㄹㄷ'에서 연속이 아니다
    eq(indexOfMatch('ㄱㅋ', choseongOfText('경제캘린더')), -1);
  });

  test('초성과 완성 음절을 섞은 질의도 된다', () => {
    eq(indexOfMatch('경ㅋ', '경제캘린더'), -1, '경 다음은 제다');
    eq(indexOfMatch('경제ㅋ', '경제캘린더'), 0);
    eq(indexOfMatch('자동ㅁ', '자동매매'), 0);
  });

  test('질의가 대상보다 길면 -1', () => {
    eq(indexOfMatch('경제캘린더입니다', '경제캘린더'), -1);
  });

  test('빈 질의는 -1 — 0(맨 앞에서 맞음)과 구분한다', () => {
    eq(indexOfMatch('', '경제캘린더'), -1);
  });

  test('시작 여부', () => {
    eq(startsWithMatch('ㄱㅈ', choseongOfText('경제캘린더')), true);
    eq(startsWithMatch('ㅋ', choseongOfText('경제캘린더')), false);
  });

  test('초성 낱자 포함 여부 — 초성 경로를 탈지 정한다', () => {
    eq(hasChoseongJamo('ㄱㅈㅋ'), true);
    eq(hasChoseongJamo('경ㅋ'), true);
    eq(hasChoseongJamo('경제'), false);
    eq(hasChoseongJamo('BTC'), false);
    eq(hasChoseongJamo('ㅏㅑ'), false, '모음만 있으면 초성 경로가 아니다');
  });

  console.log('[커맨드 — 초성으로 실제 검색]');

  test('ㄱㅈㅋ → 경제캘린더', () => {
    eq(first('ㄱㅈㅋ'), '경제캘린더');
  });

  test('ㅈㄷㅁㅁ → 자동매매', () => {
    eq(first('ㅈㄷㅁㅁ'), '자동매매');
  });

  test('ㅁㅁ → 매매하기가 첫 줄 (자동매매보다 앞에서 맞았다)', () => {
    const got = labels('ㅁㅁ');
    assert(got.includes('매매하기'), '매매하기가 있어야 한다');
    assert(got.includes('자동매매'), '자동매매도 나와야 한다');
    eq(got[0], '매매하기', '앞에서 맞은 쪽이 위여야 한다');
  });

  test('ㅋㅅ → 리스크 관리 (kw의 \'킬스위치\'가 초성으로 잡힌다)', () => {
    // 라벨에 '킬스위치'라는 말이 없는데도 찾힌다 — kw에 있기 때문이다.
    // 초성이 라벨에만 통하면 kw는 한글 사용자에게 무용지물이 된다.
    eq(first('ㅋㅅ'), '리스크 관리');
  });

  test('모음만 치면 결과가 없다 — 던지지 않는다', () => {
    eq(labels('ㅏㅏ').length, 0);
  });

  console.log('[커맨드 — 순위]');

  test('완전 일치가 부분 일치를 이긴다', () => {
    eq(first('뉴스'), '뉴스');
  });

  test('라벨 매치가 설명 매치를 이긴다', () => {
    // '뉴스'는 '뉴스'의 라벨이고 '시장 보기'의 설명에는 없지만,
    // '코인'은 여러 설명에만 있다 → 라벨 매치가 있는 질의로 확인
    const hit = scoreCommand(
      { id: 'x', label: '아무거나', desc: '뉴스가 설명에 있다', cat: 'c', danger: 'safe', action: { kind: 'tab', value: 'x' } },
      '뉴스');
    const labelHit = scoreCommand(
      { id: 'y', label: '뉴스', cat: 'c', danger: 'safe', action: { kind: 'tab', value: 'y' } },
      '뉴스');
    assert(!!hit && !!labelHit, '둘 다 맞아야 한다');
    assert(labelHit!.score > hit!.score, '라벨이 설명보다 높아야 한다');
    eq(labelHit!.field, 'label');
    eq(hit!.field, 'desc');
  });

  test('라벨 매치가 초성 매치를 이긴다', () => {
    const byLabel = scoreCommand(
      { id: 'a', label: '자동매매', cat: 'c', danger: 'safe', action: { kind: 'tab', value: 'a' } }, '자동');
    const byCho = scoreCommand(
      { id: 'b', label: '자동매매', cat: 'c', danger: 'safe', action: { kind: 'tab', value: 'b' } }, 'ㅈㄷ');
    assert(byLabel!.score > byCho!.score, '정확히 친 쪽이 위여야 한다');
    eq(byLabel!.field, 'label');
    eq(byCho!.field, 'choseong');
  });

  test('앞에서 맞은 것이 뒤에서 맞은 것을 이긴다', () => {
    const front = scoreCommand(
      { id: 'a', label: '분석 허브', cat: 'c', danger: 'safe', action: { kind: 'tab', value: 'a' } }, '분석');
    const back = scoreCommand(
      { id: 'b', label: 'AI 분석', cat: 'c', danger: 'safe', action: { kind: 'tab', value: 'b' } }, '분석');
    assert(front!.score > back!.score, '앞에서 맞은 쪽이 위여야 한다');
  });

  test('kw로도 찾힌다 — 라벨에 없는 말', () => {
    const got = labels('fomc');
    eq(got[0], '경제캘린더');
  });

  test('kw 매치가 라벨 매치보다 아래다', () => {
    // 'bot'은 자동매매의 kw에만 있다
    const hit = scoreCommand(
      { id: 'a', label: '자동매매', kw: '봇 자동 bot', cat: 'c', danger: 'safe', action: { kind: 'tab', value: 'a' } },
      'bot');
    eq(hit!.field, 'kw');
  });

  test('강조 구간은 라벨에서 맞은 자리다', () => {
    const h = scoreCommand(
      { id: 'a', label: 'AI 분석', cat: 'c', danger: 'safe', action: { kind: 'tab', value: 'a' } }, '분석');
    eq(h!.range!.start, 3);
    eq(h!.range!.end, 5);
  });

  test('초성 강조 구간도 라벨 글자 위치와 맞는다', () => {
    // 'ㅋㄹㄷ' → '경제캘린더'의 2~5번째 글자
    const h = scoreCommand(
      { id: 'a', label: '경제캘린더', cat: 'c', danger: 'safe', action: { kind: 'tab', value: 'a' } }, 'ㅋㄹㄷ');
    eq(h!.field, 'choseong');
    eq(h!.range!.start, 2);
    eq(h!.range!.end, 5);
  });

  test('점수가 같으면 원래 순서를 지킨다', () => {
    const rows: Command[] = ['가', '나', '다'].map((l, i) => ({
      id: `c${i}`, label: `${l}항목`, cat: 'c', danger: 'safe' as const,
      action: { kind: 'tab' as const, value: `c${i}` },
    }));
    // '항목'은 셋 다 같은 위치에서 맞는다
    eq(searchCommands(rows, '항목').map(h => h.command.id).join(','), 'c0,c1,c2');
  });

  console.log('[커맨드 — 목록과 필터]');

  test('빈 질의는 전체 목록을 원래 순서로 — 빈 화면을 보면 거기서 닫는다', () => {
    const all = searchCommands(ALL, '');
    eq(all.length, ALL.filter(c => !c.adminOnly).length);
    eq(all[0].command.label, '매매하기');
  });

  test('공백만 쳐도 전체 목록', () => {
    eq(searchCommands(ALL, '   ').length, ALL.filter(c => !c.adminOnly).length);
    eq(normalizeQuery('  ㄱㅈ  '), 'ㄱㅈ');
  });

  test('관리자 전용은 일반 사용자에게 안 보인다', () => {
    assert(!labels('관리자').includes('관리자'), '일반 사용자에게 보였다');
    assert(labels('관리자', true).includes('관리자'), '관리자에게는 보여야 한다');
  });

  test('관리자 전용은 빈 질의 목록에서도 빠진다', () => {
    const plain = searchCommands(ALL, '').map(h => h.command.id);
    assert(!plain.includes('admin.home'), '빈 목록에 관리자 항목이 섞였다');
  });

  test('limit으로 자른다', () => {
    eq(searchCommands(ALL, '', { limit: 3 }).length, 3);
  });

  console.log('[커맨드 — 레지스트리]');

  test('메뉴 항목은 전부 safe다 — 위험 커맨드가 자동 생성되면 안 된다', () => {
    for (const c of menuToCommands(MENU_FIXTURE)) {
      eq(c.danger, 'safe', `${c.label}이 safe가 아니다`);
    }
  });

  test('href가 있으면 별도 라우트로, 없으면 탭 전환으로', () => {
    const cmds = menuToCommands(MENU_FIXTURE);
    const trading = cmds.find(c => c.id === 'menu.trading')!;
    const calendar = cmds.find(c => c.id === 'menu.calendar')!;
    eq(trading.action.kind, 'href');
    eq(trading.action.value, '/terminal');
    eq(calendar.action.kind, 'tab');
    eq(calendar.action.value, 'calendar');
  });

  test('메뉴 id가 커맨드 id에 그대로 남는다 — 어디서 왔는지 알 수 있게', () => {
    eq(menuToCommands(MENU_FIXTURE)[0].id, 'menu.trading');
  });

  test('reducing은 확인을 거치지 않는다 — 급할 때 확인창이 뜨면 그게 손실이다', () => {
    const kill: Command = {
      id: 'x.kill', label: '킬스위치', cat: '안전',
      danger: 'reducing', action: { kind: 'invoke', value: 'x.kill' },
    };
    eq(needsConfirm(kill), false);
  });

  test('guarded는 확인한다 — 되돌릴 수 없는 것은 한 번 더 묻는다', () => {
    const close: Command = {
      id: 'x.closeAll', label: '전량 청산', cat: '거래',
      danger: 'guarded', action: { kind: 'invoke', value: 'x.closeAll' },
    };
    eq(needsConfirm(close), true);
  });

  test('safe는 확인하지 않는다', () => {
    eq(needsConfirm(EXTRA_COMMANDS.find(c => c.id === 'theme.toggle')!), false);
  });

  test('지금 실려 있는 커맨드는 전부 safe다 — 위험 동작이 아직 배선되지 않았다', () => {
    // 킬스위치는 connectionId가 필요해 팔레트에서 바로 발동시킬 수 없다.
    // 그래서 '화면을 연다'로만 넣었고, 그것은 safe다. 실제 주문·청산을
    // 배선할 때 이 테스트가 먼저 실패해서 '확인 단계도 같이 붙여라'라고
    // 알려주는 것이 목적이다.
    for (const c of EXTRA_COMMANDS) {
      eq(c.danger, 'safe', `${c.label}이 safe가 아니다 — 확인 흐름을 배선했는가?`);
    }
  });

  test('safe가 아닌 커맨드는 invoke로만 만든다 — tab·href는 화면 이동이라 위험할 수 없다', () => {
    for (const c of [...EXTRA_COMMANDS, ...menuToCommands(MENU_FIXTURE)]) {
      if (c.danger !== 'safe') {
        eq(c.action.kind, 'invoke', `${c.label}: 이동인데 위험 등급이 붙었다`);
      }
    }
  });

  const SYMS = [
    { id: 'bitcoin',  sym: 'BTC/USDT', nameKr: '비트코인' },
    { id: 'ethereum', sym: 'ETH/USDT', nameKr: '이더리움' },
    { id: '005930',   sym: '005930',   nameKr: '삼성전자' },
    { id: 'AAPL',     sym: 'AAPL',     nameKr: '애플', name: 'Apple' },
  ];

  test('종목은 따로 만든다 — 300개를 메뉴에 섞으면 메뉴가 묻힌다', () => {
    const syms = symbolsToCommands(SYMS);
    eq(syms.length, 4);
    eq(syms[0].action.kind, 'symbol');
    eq(syms[0].danger, 'safe');
    // buildCommands에는 종목이 섞이지 않는다
    assert(!buildCommands(MENU_FIXTURE).some(c => c.id.startsWith('symbol.')), '종목이 섞였다');
  });

  test('기호가 아니라 id로 넘긴다 — BTC/USDT의 슬래시를 뒤에서 쪼개지 않는다', () => {
    eq(symbolsToCommands(SYMS)[0].action.value, 'bitcoin');
  });

  test('종목은 영문 부분일치로 찾힌다', () => {
    const syms = symbolsToCommands(SYMS);
    eq(searchCommands(syms, 'btc').map(h => h.command.label).join(','), 'BTC/USDT');
    eq(searchCommands(syms, 'usdt').length, 2);
  });

  test('한글 이름으로 찾힌다 — 한국 사용자는 AAPL보다 애플을 먼저 친다', () => {
    const syms = symbolsToCommands(SYMS);
    eq(searchCommands(syms, '애플').map(h => h.command.label).join(','), 'AAPL');
    eq(searchCommands(syms, '비트').map(h => h.command.label).join(','), 'BTC/USDT');
  });

  test('한글 이름 초성으로도 찾힌다 — 초성이 가장 필요한 쪽이 국내 주식이다', () => {
    const syms = symbolsToCommands(SYMS);
    eq(searchCommands(syms, 'ㅅㅅㅈㅈ').map(h => h.command.label).join(','), '005930');
    eq(searchCommands(syms, 'ㅂㅌㅋㅇ').map(h => h.command.label).join(','), 'BTC/USDT');
  });

  test('커맨드 id가 중복되지 않는다 — 중복이면 순위 정렬이 흔들린다', () => {
    const ids = buildCommands(MENU_FIXTURE).map(c => c.id);
    eq(new Set(ids).size, ids.length, `중복: ${ids.join(',')}`);
  });

  test('모든 커맨드에 danger와 action이 있다', () => {
    for (const c of buildCommands(MENU_FIXTURE)) {
      assert(!!c.danger, `${c.label}에 danger가 없다`);
      assert(!!c.action?.kind, `${c.label}에 action이 없다`);
      assert(!!c.cat, `${c.label}에 cat이 없다`);
    }
  });
}

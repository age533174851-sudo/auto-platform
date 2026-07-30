// src/lib/commands/registry.ts
//
// 커맨드 목록을 만든다.
//
// 왜 메뉴를 다시 적지 않는가
// ──────────────────────────
// lib/menuItems.tsx의 MENU가 이미 31개 항목에 검색 키워드(kw)까지 들고
// 있다. 여기서 목록을 새로 적으면 메뉴를 하나 추가할 때 두 곳을 고쳐야
// 하고, 언젠가 한 곳만 고친다. 그래서 MENU를 **받아서 변환**한다.
//
// 왜 MENU를 직접 import하지 않는가
// ────────────────────────────────
// menuItems.tsx는 lucide-react 아이콘을 import한다. 이 파일이 그걸 끌어오면
// 테스트 러너에서 못 돈다 — 러너는 src만 임시 디렉터리로 복사해 node로
// 실행하므로 node_modules가 없다. 그래서 아이콘이 없는 **평범한 데이터**만
// 받는 모양으로 둔다. 아이콘은 화면 컴포넌트가 알아서 붙인다.

import type { Command, CommandDanger } from './types';

/** MENU에서 필요한 필드만. 아이콘·색은 화면이 쓰고 여기는 모른다 */
export interface MenuLike {
  id: string;
  label: string;
  desc?: string;
  cat: string;
  kw?: string;
  href?: string;
}

/**
 * 메뉴 항목을 커맨드로.
 *
 * 메뉴는 전부 `safe`다 — 화면을 바꾸는 것뿐이고 주문을 내지 않는다.
 * 주문·청산 같은 것은 아래 EXTRA_COMMANDS에 손으로 적는다. 위험한 커맨드가
 * 목록 변환으로 **자동 생성되면** 새 메뉴 하나가 조용히 위험 커맨드가 된다.
 */
export function menuToCommands(menu: MenuLike[]): Command[] {
  return menu.map(m => ({
    id: `menu.${m.id}`,
    label: m.label,
    desc: m.desc,
    cat: m.cat,
    kw: m.kw,
    danger: 'safe' as CommandDanger,
    action: m.href
      ? { kind: 'href' as const, value: m.href }
      : { kind: 'tab' as const, value: m.id },
  }));
}

/**
 * 메뉴에 없는 커맨드.
 *
 * 여기 있는 것들이 팔레트의 실제 값어치다 — 메뉴를 열어 찾을 수 없는 동작.
 */
export const EXTRA_COMMANDS: Command[] = [
  // ── 팔레트·도움말 ──
  //
  // 팔레트 자체도 커맨드다. 그래야 `mod+k` 바인딩이 다른 단축키와 똑같은
  // 경로를 타고, 위험 등급 검사도 같은 곳에서 받는다. 특별 취급하는 키를
  // 하나 만들면 그 하나만 다른 규칙으로 자란다.
  {
    id: 'palette.open', label: '빠른 명령', desc: '이동·실행·검색 (초성 지원)',
    cat: '표시', kw: 'palette command 명령 검색 팔레트',
    danger: 'safe', action: { kind: 'invoke', value: 'palette.open' },
  },
  {
    id: 'help.keys', label: '단축키 도움말', desc: '지금 쓸 수 있는 단축키 목록',
    cat: '표시', kw: 'help shortcut 단축키 도움말 키보드',
    danger: 'safe', action: { kind: 'invoke', value: 'help.keys' },
  },

  // ── 화면·표시 ──
  {
    id: 'theme.toggle', label: '테마 전환', desc: '밝음 ↔ 어두움',
    cat: '표시', kw: 'theme dark light 다크 라이트 밝기',
    danger: 'safe', action: { kind: 'invoke', value: 'theme.toggle' },
  },
  {
    id: 'theme.auto', label: '테마 자동', desc: '시각에 맞춰 전환 (07~19시 밝음)',
    cat: '표시', kw: 'theme auto 자동',
    danger: 'safe', action: { kind: 'invoke', value: 'theme.auto' },
  },
  {
    id: 'nav.terminal', label: 'Pro 터미널', desc: '차트·호가·주문 통합 화면',
    cat: '거래', kw: 'terminal pro 프로 터미널',
    danger: 'safe', action: { kind: 'href', value: '/terminal' },
  },

  // ── 안전 ──
  //
  // 킬스위치는 여기 없다. MENU의 `risk_settings`('리스크 관리', kw '킬스위치
  // 한도')가 이미 그 화면으로 가는 항목이고, 여기에 또 적으면 목록에 같은
  // 것이 두 줄로 나온다. 실제로 그렇게 만들어 놨다가 'ㅋㅅ' 검색 결과에
  // '리스크 관리'가 두 번 뜨는 것을 보고 지웠다 — 이 파일 맨 위에 적어 둔
  // "메뉴를 다시 적지 않는다"를 내가 어긴 것이었다.
  //
  // 팔레트에서 킬스위치를 **바로 발동**시키지 않은 이유:
  // `/api/risk/kill-switch/trigger`는 connectionId를 요구한다. 어느 연결을
  // 끊을지 팔레트는 모른다. 그런데도 `reducing`(= 즉시 실행)을 달면 배지는
  // "즉시 실행"인데 실제로는 화면만 열린다. 급할 때 그 배지를 믿고 Enter를
  // 친 사람은 자동매매가 멈춘 줄 알고 손을 뗀다 — 이 코드베이스가 계속
  // 없애 온 종류의 거짓말이다.
  //
  // guarded/reducing 계층은 types.ts와 테스트에 이미 있다. 실제 주문·청산
  // 동작을 배선할 때 그 자리에서 쓴다.

  // ── 관리자 ──
  {
    id: 'admin.home', label: '관리자', desc: '사용자·시스템 관리',
    cat: '관리', kw: 'admin 관리자',
    danger: 'safe', adminOnly: true, action: { kind: 'href', value: '/admin' },
  },
  {
    id: 'admin.ai', label: 'AI 사용량·비용', desc: '공급자별 요금·응답시간',
    cat: '관리', kw: 'ai cost 비용 요금 사용량 토큰',
    danger: 'safe', adminOnly: true, action: { kind: 'tab', value: 'ai_usage' },
  },
];

/** 종목에서 검색에 쓰는 필드만 */
export interface SymbolLike {
  id: string;
  /** 화면에 보이는 기호 — 'BTC/USDT', 'AAPL' */
  sym: string;
  /** 한글 이름. 이게 있어야 'ㅅㅅㅈㅈ' → 삼성전자가 된다 */
  nameKr?: string;
  name?: string;
}

/**
 * 종목을 커맨드로.
 *
 * 목록이 300개를 넘으므로 커맨드 배열에 통째로 섞지 않는다 — 팔레트를 열
 * 때마다 300개를 매칭하면 입력이 늦고, 메뉴 커맨드가 종목에 묻힌다.
 * 화면이 종목 결과를 **따로 묶어** 보여주고, 이 함수는 그 재료만 만든다.
 *
 * 한글 이름을 kw에 넣는 이유: 한국 사용자는 'AAPL'보다 '애플'을 먼저 친다.
 * 기호만 검색 대상으로 두면 초성 검색이 코인에만 통하고 국내 주식에는
 * 통하지 않는다 — 정작 초성이 가장 필요한 쪽이 빠진다.
 */
export function symbolsToCommands(items: SymbolLike[]): Command[] {
  return items.map(it => ({
    id: `symbol.${it.id}`,
    label: it.sym,
    desc: it.nameKr || it.name,
    cat: '종목',
    kw: [it.nameKr, it.name, it.id].filter(Boolean).join(' '),
    danger: 'safe' as CommandDanger,
    // 기호가 아니라 id로 넘긴다. 'BTC/USDT'처럼 기호에 슬래시가 섞이면
    // 뒤에서 다시 쪼개야 하고, 그 규칙이 또 하나의 추측이 된다.
    action: { kind: 'symbol' as const, value: it.id },
  }));
}

/** 메뉴 + 추가 커맨드 */
export function buildCommands(menu: MenuLike[]): Command[] {
  return [...menuToCommands(menu), ...EXTRA_COMMANDS];
}

/** 확인 단계를 거쳐야 하는가 */
export function needsConfirm(cmd: Command): boolean {
  return cmd.danger === 'guarded';
}

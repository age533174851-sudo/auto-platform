// src/lib/commands/types.ts
//
// 커맨드의 모양. 여기에는 import가 없다 — 미들웨어든 테스트든 어디서든
// 끌어올 수 있어야 한다.

/**
 * 이 커맨드가 위험한가, 그리고 **어느 방향으로** 위험한가.
 *
 * 방향을 구분하는 것이 이 타입의 존재 이유다.
 *
 *  - `safe`     : 화면 이동·검색·테마. 즉시 실행한다
 *  - `guarded`  : 주문·설정 변경처럼 **위험을 늘리는** 것. 확인을 한 단계 둔다
 *  - `reducing` : 킬스위치·전량 청산처럼 **위험을 줄이는** 것. 즉시 실행한다
 *
 * `reducing`을 따로 두지 않고 "위험한 건 다 확인"으로 묶으면, 정작 급할 때
 * 킬스위치 앞에 확인창이 뜬다. 그 0.5초가 이 앱에서 가장 비싼 0.5초다.
 * 반대로 매수를 즉시 실행하면 오타 한 번이 포지션이 된다.
 *
 * 등급을 키 핸들러가 아니라 커맨드 자체에 두는 이유: 앞으로 이 커맨드를
 * 부르는 창구가 여럿(팔레트·단축키·플로팅 버튼)이 되는데, 창구마다 확인
 * 여부를 판단하면 그중 하나는 반드시 빼먹는다.
 */
export type CommandDanger = 'safe' | 'guarded' | 'reducing';

/**
 * 무엇을 할지 **선언**만 한다. 실제 함수는 앱이 연결한다.
 *
 * 이렇게 나눠야 레지스트리가 순수해진다 — setTab이나 router를 알면 이
 * 파일은 테스트할 수 없고, 그러면 매칭 규칙도 같이 테스트를 못 한다.
 */
export type CommandAction =
  /** 앱 내부 탭 전환 (?tab=<value>) */
  | { kind: 'tab'; value: string }
  /** 별도 라우트로 이동 (/terminal 등) */
  | { kind: 'href'; value: string }
  /** 종목 선택 */
  | { kind: 'symbol'; value: string }
  /** 앱이 등록한 이름 있는 동작 (테마 전환·킬스위치 등) */
  | { kind: 'invoke'; value: string };

export interface Command {
  id: string;
  label: string;
  desc?: string;
  /** 목록에서 묶어 보여줄 분류 */
  cat: string;
  /** 추가 검색어. 라벨에 없는 말로도 찾게 한다 ('fomc cpi 일정') */
  kw?: string;
  danger: CommandDanger;
  action: CommandAction;
  /** 관리자에게만 보인다. 메뉴를 숨기는 것이 잠금은 아니지만, 보일 필요도 없다 */
  adminOnly?: boolean;
}

/** 어느 필드에서 맞았는가 — 순위와 화면 강조에 쓴다 */
export type MatchField = 'label' | 'choseong' | 'kw' | 'desc';

export interface CommandHit {
  command: Command;
  score: number;
  field: MatchField;
  /** label에서 맞은 구간 (강조 표시용). label이 아니면 null */
  range: { start: number; end: number } | null;
}

// src/lib/ui/paperRunnerMode.ts
//
// **PAPER 실행 컴포넌트가 어느 컨트롤을 보여 주는가.**
//
// 같은 컴포넌트를 두 화면이 쓴다:
//
//   터미널 하단 독    시작/정지 · 주기(1·5·15분) · 수동 2버튼 · 기록
//   모의투자 탭       **수동 2버튼 · 기록만**
//
// 모의투자 탭에서 주기 타이머를 숨기는 것은 취향이 아니다. 브라우저
// 타이머는 **창을 닫으면 멈춘다.** 그걸 "자동매매가 돌고 있다"로 읽게 두면
// 가장 비싼 착각이 생긴다. 서버 기반 반복은 별도 단계이고, 그때까지 이
// 화면은 **사람이 누른 만큼만** 돈다.
//
// 판정을 컴포넌트 안의 `&&` 더미로 두지 않고 여기 모아 둔 이유: 조건이
// 네 군데(스위치·주기·접기·수동버튼)에 흩어지면 한쪽만 고치는 날이 온다.

export interface PaperRunnerModeInput {
  /** 모의투자 탭 — 수동 2버튼만. 주기 타이머를 만들지도, 보여 주지도 않는다 */
  manualOnly?: boolean;
  /** 좁은 화면(터미널 독)에서 접어 둔다 */
  dense?: boolean;
  /** 접힌 것을 사용자가 펼쳤는가 */
  more?: boolean;
}

export interface PaperRunnerControls {
  /** 시작/정지 스위치 */
  showSwitch: boolean;
  /** 주기 선택(1·5·15분) */
  showIntervals: boolean;
  /** '지금 한 번' · '미리보기' */
  showManualButtons: boolean;
  /** 상세(버튼·주기·안내문) */
  showDetail: boolean;
  /** 접기/펼치기 토글(⋯) */
  showCollapseToggle: boolean;
}

export function paperRunnerControls(input: PaperRunnerModeInput = {}): PaperRunnerControls {
  if (input.manualOnly) {
    // **접지 않는다.** 두 버튼이 이 화면의 본체다.
    return {
      showSwitch: false,
      showIntervals: false,
      showManualButtons: true,
      showDetail: true,
      showCollapseToggle: false,
    };
  }
  const showDetail = !input.dense || !!input.more;
  return {
    showSwitch: true,
    showIntervals: showDetail,
    showManualButtons: showDetail,
    showDetail,
    showCollapseToggle: !!input.dense,
  };
}

/**
 * 주기 사이클을 시작해도 되는가.
 *
 * **수동 전용이면 켜져 있어도 안 된다** — 스위치를 숨기는 것만으로는
 * 모자란다. 상태가 어떻게 들어와도 타이머가 생기지 않아야 한다.
 */
export function mayStartTimer(input: { manualOnly?: boolean; on: boolean }): boolean {
  if (input.manualOnly) return false;
  return !!input.on;
}

/** 수동 전용 화면에 적는 안내. 문장을 화면마다 새로 짓지 않는다. */
export const MANUAL_ONLY_NOTE =
  '누를 때마다 한 사이클만 돕니다 — 청산 점검 → 손실 한도 → 진입. '
  + '가상 자금이고 거래소로 아무것도 나가지 않습니다. '
  + '자동 반복은 아직 없습니다(서버 기반으로 별도 단계).';

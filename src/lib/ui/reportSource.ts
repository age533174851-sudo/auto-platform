// src/lib/ui/reportSource.ts
//
// **지어낸 손익을 내 기록처럼 그리지 않는다.**
//
// `/api/intel?action=tax`는 실제 체결 장부를 읽지 않고 연도로 씨앗을 만든
// 숫자(`source: 'mock'`)를 돌려준다. 그 숫자가 "손익 · 세금 리포트"라는
// 제목 아래 고지 없이 그려지면 사용자는 자기 손익과 세금 추정으로 읽는다.
//
// 판정은 여기 한 곳에 둔다. 출처를 못 읽은 것도 실제 기록으로 보지 않는다 —
// **확인하지 못한 것은 통과가 아니다.**

/** 고지가 필요하면 문구를, 출처가 실제 장부로 적혀 있으면 null을 돌려준다. */
export function taxReportSourceNotice(source: unknown): string | null {
  if (source === 'mock') {
    return '모의 데이터 — 실제 거래 기록이 아닙니다. 아래 손익·수수료·세금은 예시 숫자입니다.';
  }
  if (typeof source !== 'string' || !source.trim()) {
    return '데이터 출처를 확인하지 못했습니다 — 실제 거래 기록으로 보지 마세요.';
  }
  return null;
}

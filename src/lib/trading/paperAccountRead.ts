// src/lib/trading/paperAccountRead.ts
//
// `/api/paper/account` 한 번 읽은 결과 → 화면 상태(계좌·포지션·오류).
//
// **못 읽었으면 포지션도 모른다.** 예전 훅은 실패하면 계좌만 null로 두고
// 포지션 목록은 직전 성공 값을 그대로 들고 있었다. 하단 독은 포지션이
// 0건일 때만 오류를 보여 주므로, 한 번 읽은 뒤 조회가 실패하면 **이미
// 청산됐을 수도 있는 옛 포지션이 오류 표시 없이 현재처럼** 남았다.
// 로그아웃(인증 없음)도 같았다 — 앞 사용자의 포지션이 남았다.
//
// 확인하지 못한 것은 비운다. 비우면 화면은 0건 칸에 오류 문구를 그린다.

export interface PaperAccountReadState<A = any> {
  acct: A | null;
  positions: any[];
  err: string;
}

export type PaperAccountReadInput =
  | { kind: 'DISABLED' }
  | { kind: 'RESPONSE'; httpOk: boolean; body: any; failText: string }
  | { kind: 'THROWN'; message: string };

export function paperAccountReadOf(input: PaperAccountReadInput): PaperAccountReadState {
  if (input.kind === 'DISABLED') return { acct: null, positions: [], err: '' };
  if (input.kind === 'THROWN') {
    return { acct: null, positions: [], err: `모의 계좌를 읽지 못했습니다 (${input.message})` };
  }
  const j = input.body;
  if (!input.httpOk || !j?.ok) {
    // 조회 실패를 잔고 0으로 그리지 않는다. 0은 '돈이 없다'이고
    // 실패는 '모른다'인데, 화면에서는 둘이 똑같이 보인다.
    return { acct: null, positions: [], err: input.failText };
  }
  return {
    acct: j.account ?? null,
    positions: Array.isArray(j.positions) ? j.positions : [],
    err: '',
  };
}

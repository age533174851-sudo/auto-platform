// src/lib/trading/tpslEdit.ts
//
// **열린 모의 포지션의 손절·익절 수정 — 입력을 어떻게 읽는가.**
//
// 실제로 나던 일
// ──────────────
// 모의 포지션 카드(`terminal/BottomDock.tsx`)는 칸 값을 `Number(slIn)`으로
// 바꿔 그대로 보냈다. `65,000`처럼 쉼표를 넣으면 NaN이 되고,
// **`JSON.stringify`는 NaN을 null로 적는다.** `/api/paper/modify`에서
// null은 '지우기'다 — 걸려 있던 손절이 사라지고 화면에는 "저장했습니다"가
// 떴다. 손절을 옮기려던 사람이 손절 없는 포지션을 들고 있게 된다.
//
// 서버 쪽도 같은 종류의 구멍이 있었다: 0·음수·문자는 조용히 '그대로'로
// 읽혀서, 같이 온 다른 칸만 저장되고 "저장했습니다"가 나갔다.
//
// 규칙 — 화면과 서버가 같은 파일을 쓴다
// ─────────────────────────────────────
//   · 값이 없다(화면의 빈 칸 / 본문에 키 없음)  → 그대로 둔다
//   · 본문의 null·''                           → 지운다 (서버만. 화면은 만들지 않는다)
//   · 양의 유한수                               → 그 값으로
//   · **그 밖의 모든 것**                       → **거부한다.** 무시하지 않는다

/** 화면 입력 한 칸 → 본문에 실을 값 */
type ClientField =
  | { kind: 'KEEP' }
  | { kind: 'SET'; price: number }
  | { kind: 'INVALID'; raw: string };

function clientFieldOf(raw: string | null | undefined): ClientField {
  const s = String(raw ?? '').trim();
  if (s === '') return { kind: 'KEEP' };
  const n = Number(s);
  // `Number('1e999')`는 Infinity다. JSON에서 그것도 null이 된다.
  if (Number.isFinite(n) && n > 0) return { kind: 'SET', price: n };
  return { kind: 'INVALID', raw: s };
}

export interface TpslEditBody {
  positionId: string;
  stopLoss?: number;
  takeProfit?: number;
}

/**
 * 한 모양으로 둔다 — 이 저장소의 tsc 설정(strict 꺼짐)은 `ok: true/false`
 * 리터럴로 합집합을 좁히지 못한다. `ok`가 false면 `body`는 null이다.
 */
export interface TpslEditBodyResult {
  ok: boolean;
  body: TpslEditBody | null;
  /** 보내지 않은 이유. 보냈으면 빈 문자열 */
  message: string;
}

/**
 * 화면의 두 칸에서 `/api/paper/modify` 본문을 만든다.
 *
 * **한 칸이라도 못 읽으면 아무것도 보내지 않는다.** 익절만 저장하고
 * "저장했습니다"를 띄우면 사용자는 손절도 걸렸다고 읽는다.
 */
export function tpslEditBody(
  positionId: string, slRaw: string | null | undefined, tpRaw: string | null | undefined,
): TpslEditBodyResult {
  const sl = clientFieldOf(slRaw);
  const tp = clientFieldOf(tpRaw);
  for (const [label, f] of [['손절', sl], ['익절', tp]] as const) {
    if (f.kind === 'INVALID') {
      return {
        ok: false, body: null,
        message: `${label} 값 "${f.raw}"을 가격으로 읽지 못했습니다 — 저장하지 않았습니다 `
          + '(0보다 큰 숫자만, 쉼표 없이)',
      };
    }
  }
  if (sl.kind === 'KEEP' && tp.kind === 'KEEP') {
    return { ok: false, body: null, message: '손절 또는 익절 값을 입력하세요' };
  }
  const body: TpslEditBody = { positionId };
  if (sl.kind === 'SET') body.stopLoss = sl.price;
  if (tp.kind === 'SET') body.takeProfit = tp.price;
  return { ok: true, body, message: '' };
}

/** 서버가 본문의 한 칸을 읽은 결과 */
export type TpslEditValue =
  | { kind: 'KEEP' }
  | { kind: 'CLEAR' }
  | { kind: 'SET'; price: number }
  | { kind: 'INVALID' };

/**
 * `/api/paper/modify` 본문의 `stopLoss`·`takeProfit` 한 칸을 읽는다.
 *
 * 키가 없으면 그대로, null·''이면 지우기다 — **둘은 다르다.**
 * 그 밖에 양의 유한수가 아닌 것은 `INVALID`이고, 라우트는 400으로 거절한다.
 */
export function readTpslEditValue(v: unknown): TpslEditValue {
  if (v === undefined) return { kind: 'KEEP' };
  if (v === null || v === '') return { kind: 'CLEAR' };
  // `Number(true) === 1` · `Number([]) === 0` — 숫자·문자 말고는 받지 않는다.
  if (typeof v !== 'number' && typeof v !== 'string') return { kind: 'INVALID' };
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? { kind: 'SET', price: n } : { kind: 'INVALID' };
}

// src/lib/safety/auditStore.ts
//
// **감사 로그를 실제로 남긴다.**
//
// logAudit(safety/index)은 메모리 배열에 쌓는다. Vercel 서버리스에서는
// 인스턴스마다 따로고 콜드 스타트마다 사라지므로, **사고가 나서 원인을
// 찾을 때쯤이면 그 기록은 이미 없다.**
//
// 그리고 화면의 감사 로그가 비어 있으면 "아무 일도 없었다"로 읽힌다 —
// 확인한 적 없는 사실이다.
//
// 두 갈래가 있다
// ──────────────
//   recordAudit          저가치 telemetry. 불 지르고 잊는다.
//   recordCriticalAudit  **반드시 남아야 하는 기록.** insert가 끝날
//                        때까지 기다리고, 실패를 영수증으로 돌려준다.
//
// 왜 갈랐나
// ─────────
// 서버리스 함수는 **응답을 돌려주는 순간 얼어붙거나 끝난다.** await하지
// 않은 DB 왕복은 그 자리에서 잘린다. 실거래 주문(LIVE_ORDER)·Kill
// Switch·긴급 정지처럼 "누가 언제 왜"를 나중에 반드시 묻게 되는 기록이
// 하필 그렇게 사라진다 — 그리고 **사라졌다는 사실조차 남지 않는다.**
//
// 그래서 중요한 기록은 기다린다. 대신 세 가지를 지킨다.
//
// 세 가지 규칙
// ────────────
//  1. **호출부를 절대 실패시키지 않는다.** 감사 기록이 안 됐다고 주문이
//     실패하면, 기록하려다 사고를 만드는 것이다. 던지지 않는다.
//
//  2. **다시 보내지 않는다.** 감사 실패에 재시도를 붙이면 주문이 두 번
//     나갈 수 있다. 감사는 주문의 결과를 바꾸지 않는다 —
//     `auditFollowUp()`이 그것을 코드로 못 박는다.
//
//  3. **실패를 성공처럼 적지 않는다.** 삼키되 숨기지 않는다. 영수증을
//     응답에 실어 화면이 "기록됨"으로 그리지 못하게 한다.
//
//  4. **시크릿을 남기지 않는다.** detail에 요청 본문을 통째로 넣으면
//     API 키와 웹훅 시크릿이 평문으로 들어가고, 이 표는 요청보다 오래 남는다.

import { redactSecrets } from '../security/webhookAuth';

export interface AuditWrite {
  userId?: string | null;
  action: string;
  resource?: string | null;
  result?: 'success' | 'blocked' | 'failed';
  detail?: Record<string, any> | null;
  connectionId?: string | null;
}

/** 감사 기록이 실제로 남았는가 */
export type AuditCode =
  | 'RECORDED'       // DB에 들어갔다
  | 'NO_DB'          // Supabase 연결이 없었다 — 기록할 곳이 없었다
  | 'INSERT_FAILED'  // insert가 오류를 돌려줬다 (표 없음·권한·제약)
  | 'THREW';         // 클라이언트가 던졌다 (네트워크·타임아웃)

export interface AuditReceipt {
  /** **true는 DB에 실제로 들어간 경우뿐이다.** */
  recorded: boolean;
  code: AuditCode;
  message: string;
}

const RECEIPT_MESSAGE: Record<AuditCode, string> = {
  RECORDED:      '감사 기록됨',
  NO_DB:         '감사 기록 안 됨 — 데이터베이스 연결이 없습니다',
  INSERT_FAILED: '감사 기록 실패 — audit_events insert 오류',
  THREW:         '감사 기록 실패 — audit_events 호출이 실패했습니다',
};

/**
 * 영수증을 만든다. **순수 함수** — 테스트가 붙는 자리다.
 *
 * `error`가 있으면 실패다. supabase-js는 표가 없거나 권한이 없어도
 * 던지지 않고 `{ error }`로 돌려준다 — 그래서 `await`만 하고 `error`를
 * 안 보면 **실패가 성공처럼 지나간다.**
 */
export function auditReceipt(i: { hasDb: boolean; error?: any; threw?: any }): AuditReceipt {
  const mk = (code: AuditCode, extra?: string): AuditReceipt => ({
    recorded: code === 'RECORDED',
    code,
    message: extra ? `${RECEIPT_MESSAGE[code]}: ${extra}` : RECEIPT_MESSAGE[code],
  });
  if (!i.hasDb) return mk('NO_DB');
  if (i.threw)  return mk('THREW', shortReason(i.threw));
  if (i.error)  return mk('INSERT_FAILED', shortReason(i.error));
  return mk('RECORDED');
}

/** 오류 문구를 짧게. 값이 통째로 들어오는 자리라 길이를 자른다. */
function shortReason(e: any): string {
  const m = typeof e === 'string' ? e : (e?.message ?? e?.details ?? e?.code ?? '');
  return String(m || 'unknown').slice(0, 200);
}

/**
 * 감사 기록 다음에 무엇을 하는가.
 *
 * **아무것도 안 한다.** 이 함수는 값을 계산하지 않는다 — 규칙을
 * 코드로 못 박는 자리다. 누군가 "감사 실패면 다시 보내자"를 넣으면
 * 여기가 바뀌어야 하고, 테스트가 먼저 깨진다.
 *
 * 재시도가 붙으면 주문이 두 번 나간다. **기록하려다 돈을 잃는다.**
 */
export function auditFollowUp(_r: AuditReceipt): { retryOrder: false; failRequest: false } {
  return { retryOrder: false, failRequest: false };
}

/** 응답에 실을 감사 영수증. 화면이 "기록됨"을 추측하지 못하게 한다. */
export function auditResponseField(r: AuditReceipt): { recorded: boolean; code: AuditCode; message: string } {
  return { recorded: r.recorded, code: r.code, message: r.message };
}

/** 표에 넣을 한 줄. 두 갈래가 같은 모양을 쓰도록 한 곳에 둔다. */
export function auditRow(ev: AuditWrite): Record<string, any> {
  return {
    user_id: ev.userId ?? null,
    action: String(ev.action || 'UNKNOWN'),
    resource: String(ev.resource ?? ''),
    result: ev.result ?? 'success',
    detail: safeDetail(ev.detail),
    connection_id: ev.connectionId ?? null,
  };
}

/** 같은 인스턴스 안에서 바로 읽히도록 메모리에도 남긴다. 실패는 무시한다. */
function mirrorToMemory(ev: AuditWrite): void {
  try {
    // 순환 import를 피하려고 동적으로 부른다.
    import('./index').then(m => {
      try {
        m.logAudit({
          userId: String(ev.userId ?? 'unknown'),
          action: ev.action,
          resource: String(ev.resource ?? ''),
          detail: safeDetail(ev.detail),
          result: ev.result ?? 'success',
        } as any);
      } catch { /* 메모리 기록 실패는 무시한다 */ }
    }).catch(() => {});
  } catch { /* 무시 */ }
}

/**
 * 저가치 telemetry 한 줄.
 *
 * **await하지 않아도 된다.** 호출부는 부르고 그냥 지나가면 된다 —
 * 실패해도 조용히 삼킨다. 사라져도 사고가 되지 않는 기록에만 쓴다
 * (공지 생성·점검 모드 토글 같은 것).
 *
 * **실거래·자금·권한이 걸린 기록에는 쓰지 않는다.** 그건
 * `recordCriticalAudit`이다.
 */
export function recordAudit(sb: any, ev: AuditWrite): void {
  mirrorToMemory(ev);
  if (!sb) return;
  try {
    void (sb as any).from('audit_events').insert(auditRow(ev)).then(
      () => {},
      // **표가 없어도 조용히 넘어간다.** 마이그레이션 전에 이 호출이
      // 주문을 실패시키면 안 된다.
      () => {},
    );
  } catch { /* 무시 */ }
}

/**
 * **반드시 남아야 하는 감사 기록.**
 *
 * insert가 끝날 때까지 기다린다. 응답을 돌려주기 전에 `await`해야
 * 서버리스가 얼어붙기 전에 DB에 들어간다.
 *
 * 던지지 않는다 — 어떤 실패도 영수증으로 돌아온다. 호출부는 그 영수증을
 * 응답에 실어 주기만 하면 된다. **주문의 성패를 바꾸지 않는다.**
 */
export async function recordCriticalAudit(sb: any, ev: AuditWrite): Promise<AuditReceipt> {
  mirrorToMemory(ev);
  if (!sb) return auditReceipt({ hasDb: false });
  try {
    const res: any = await (sb as any).from('audit_events').insert(auditRow(ev));
    return auditReceipt({ hasDb: true, error: res?.error ?? null });
  } catch (e: any) {
    return auditReceipt({ hasDb: true, threw: e ?? new Error('unknown') });
  }
}

/**
 * detail에서 시크릿을 걸러 낸다.
 *
 * redactSecrets는 웹훅용으로 만들었지만 거르는 열쇠 목록이 같다 —
 * secret·code·token·password·apiKey·passphrase. 두 벌 두면 한쪽만
 * 고쳐지고, 그때 새 키 이름이 한쪽에만 추가된다.
 */
function safeDetail(d: Record<string, any> | null | undefined): Record<string, any> {
  if (!d) return {};
  // 문자열을 넘긴 호출부가 있었다. redactSecrets는 객체를 받으므로
  // 그대로 넘기면 걸러지지 않은 채 들어가거나 던진다.
  if (typeof d !== 'object') return { note: String(d).slice(0, 500) };
  try { return redactSecrets(d); } catch { return {}; }
}

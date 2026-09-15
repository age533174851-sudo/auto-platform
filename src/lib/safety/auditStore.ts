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
// 세 가지 규칙
// ────────────
//  1. **호출부를 절대 실패시키지 않는다.** 감사 기록이 안 됐다고 주문이
//     실패하면, 기록하려다 사고를 만드는 것이다. 던지지 않고 삼킨다.
//
//  2. **기다리지 않는다.** 주문 경로에 DB 왕복을 하나 더 넣으면 그만큼
//     체결이 늦는다. 불 지르고 잊는다(fire-and-forget).
//
//  3. **시크릿을 남기지 않는다.** detail에 요청 본문을 통째로 넣으면
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

/**
 * 감사 기록 한 줄.
 *
 * **await하지 않아도 된다.** 호출부는 부르고 그냥 지나가면 된다 —
 * 실패해도 조용히 삼킨다.
 */
export function recordAudit(sb: any, ev: AuditWrite): void {
  void recordAuditAsync(sb, ev);
}

/**
 * 같은 기록을 **끝까지 기다릴 수 있는** 판.
 *
 * 왜 필요한가: 서버리스에서 응답을 돌려주면 그 요청의 실행이 곧 정리된다.
 * 불 지르고 잊은 insert는 **완료 전에 잘릴 수 있고**, 그러면 기록은 있다고
 * 믿는데 표는 비어 있다 — 이 저장소가 제일 싫어하는 모양이다.
 *
 * 그래서 **기다려도 되는 자리**(이미 실패해서 돌아가는 응답)는 이걸 쓴다.
 * 성공 경로는 그대로 `recordAudit`을 써서 체결을 늦추지 않는다.
 *
 * **절대 던지지 않는다.** 기록이 안 됐다고 주문 결과가 달라지면 안 된다.
 */
export async function recordAuditAsync(sb: any, ev: AuditWrite): Promise<void> {
  // 메모리 쪽도 그대로 남긴다. 같은 인스턴스 안에서는 즉시 읽히므로
  // 화면이 방금 한 일을 바로 보여 줄 수 있다.
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

  if (!sb) return;
  try {
    await (sb as any).from('audit_events').insert({
      user_id: ev.userId ?? null,
      action: String(ev.action || 'UNKNOWN'),
      resource: String(ev.resource ?? ''),
      result: ev.result ?? 'success',
      detail: safeDetail(ev.detail),
      connection_id: ev.connectionId ?? null,
    }).then(
      () => {},
      // **표가 없어도 조용히 넘어간다.** 마이그레이션 전에 이 호출이
      // 주문을 실패시키면 안 된다.
      () => {},
    );
  } catch { /* 무시 */ }
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
  try { return redactSecrets(d); } catch { return {}; }
}

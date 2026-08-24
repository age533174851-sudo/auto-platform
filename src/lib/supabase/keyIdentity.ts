// src/lib/supabase/keyIdentity.ts
//
// **키가 같은 것인지, 같은 역할인지를 값 없이 말한다.**
//
// 어디까지 왔나
// ─────────────
// Production 실측으로 두 가설이 부정됐다:
//
//   URL 불일치     saw.server.projectRef == saw.public.projectRef
//                  == sgbysrvvxlluzffmgcho · sameProject = true
//   쓰기 실패      워커 verdict = RECORDED (쓰고 다시 읽어 대조까지 성공)
//                  그리고 워커가 **웹과 같은 질의**를 던지면 자기 줄이
//                  최신으로 나온다 — DB는 정상이다
//
// 그런데 웹은 여전히 8/20의 줄을 최신이라고 한다. 같은 프로젝트, 같은
// 표, 같은 질의 모양인데 **가시성이 다르다.**
//
// 남은 차이는 **무슨 자격으로 붙는가**다. RLS는 역할에 따라 같은 질의를
// 다른 결과로 만든다 — 그리고 SELECT를 막을 때는 오류가 아니라 **0줄**,
// 오래된 줄만 보이게 만들 수도 있다. 그래서 두 쪽 키의 **역할**을
// 비교해야 한다.
//
// 값은 절대 내보내지 않는다
// ─────────────────────────
// 나가는 것은 넷뿐이다:
//   present      있는가
//   kind         어떤 형식인가 (jwt / sb_secret / sb_publishable / unknown)
//   role · ref   JWT면 payload에서 읽은 것 — **서명도 원문도 아니다**
//   fingerprint  sha256 앞 6자
//
// JWT payload는 base64로 누구나 열 수 있는 공개 부분이다. 비밀은
// 서명이고, 서명은 읽지도 내보내지도 않는다. **원문은 어디에도 남기지
// 않는다.**
import { fingerprintOf } from '../system/fingerprint';

export type KeyKind = 'missing' | 'jwt' | 'sb_secret' | 'sb_publishable' | 'unknown';

export interface KeyIdentity {
  present: boolean;
  kind: KeyKind;
  /** JWT payload의 role. 새 형식 키는 형식으로 추론한다. 모르면 null */
  role: string | null;
  /** JWT payload의 ref (= Supabase project ref). 모르면 null */
  ref: string | null;
  /** sha256 앞 6자. **값이 아니다** */
  fingerprint: string | null;
  /** 사람이 읽을 한 줄 */
  note: string;
}

/** base64url → utf8. 실패하면 null. **던지지 않는다** */
function decodeSegment(seg: string): any {
  try {
    const b64 = String(seg).replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch { return null; }
}

/**
 * 키의 신원. **순수 함수** — 테스트가 붙는 자리다.
 *
 * 어떤 입력에도 던지지 않고, 어떤 경우에도 원문을 돌려주지 않는다.
 */
export function keyIdentityOf(raw: string | null | undefined): KeyIdentity {
  const key = String(raw ?? '').trim();
  if (!key) {
    return { present: false, kind: 'missing', role: null, ref: null, fingerprint: null,
      note: '키가 없습니다' };
  }
  const fingerprint = fingerprintOf(key);

  // ── 새 형식 (JWT가 아니다) ──
  if (key.startsWith('sb_secret_')) {
    return { present: true, kind: 'sb_secret', role: 'service_role', ref: null, fingerprint,
      note: '새 형식 secret 키입니다 — RLS를 우회합니다' };
  }
  if (key.startsWith('sb_publishable_')) {
    return { present: true, kind: 'sb_publishable', role: 'anon', ref: null, fingerprint,
      // **이 키로는 RLS가 그대로 걸린다.** 서버에 넣으면 조용히 0줄이 된다.
      note: '새 형식 publishable 키입니다 — **RLS가 그대로 적용됩니다.** 서버용 자리에 있으면 조회가 조용히 0줄이 될 수 있습니다' };
  }

  // ── 레거시 JWT ──
  const parts = key.split('.');
  if (parts.length === 3) {
    const payload = decodeSegment(parts[1]);
    if (payload && typeof payload === 'object') {
      const role = typeof payload.role === 'string' ? payload.role : null;
      const ref = typeof payload.ref === 'string' ? payload.ref : null;
      const note = role === 'service_role'
        ? 'service_role JWT입니다 — RLS를 우회합니다'
        : role === 'anon'
          ? 'anon JWT입니다 — **RLS가 그대로 적용됩니다.** 서버용 자리에 있으면 조회가 조용히 0줄이 될 수 있습니다'
          : `JWT인데 role이 ${role ? `'${role}'` : '없습니다'} — 확인이 필요합니다`;
      return { present: true, kind: 'jwt', role, ref, fingerprint, note };
    }
    return { present: true, kind: 'jwt', role: null, ref: null, fingerprint,
      note: 'JWT 모양인데 payload를 읽지 못했습니다 — 잘렸을 수 있습니다' };
  }

  return { present: true, kind: 'unknown', role: null, ref: null, fingerprint,
    note: '아는 형식이 아닙니다 — 잘렸거나 다른 값일 수 있습니다' };
}

/**
 * 두 쪽 키를 비교한다. **모르면 모른다고 한다.**
 *
 * 같은 키인지(지문)와 같은 역할인지(role)는 다른 질문이다. 서로 다른
 * 키여도 둘 다 service_role일 수 있고, 그때는 가시성이 같아야 한다.
 */
export interface KeyComparison {
  /** 같은 키인가. 한쪽이라도 없으면 null */
  sameKey: boolean | null;
  /** 같은 역할인가. 한쪽이라도 모르면 null */
  sameRole: boolean | null;
  /** 양쪽 다 RLS를 우회하는가. 모르면 null */
  bothBypassRls: boolean | null;
  note: string;
}

const BYPASS = new Set(['service_role']);

export function compareKeys(a: KeyIdentity, b: KeyIdentity): KeyComparison {
  if (!a.present || !b.present) {
    return { sameKey: null, sameRole: null, bothBypassRls: null,
      note: '한쪽 키를 모릅니다 — 같다고도 다르다고도 할 수 없습니다' };
  }
  const sameKey = a.fingerprint != null && b.fingerprint != null
    ? a.fingerprint === b.fingerprint : null;
  const sameRole = a.role && b.role ? a.role === b.role : null;
  const bothBypassRls = a.role && b.role ? (BYPASS.has(a.role) && BYPASS.has(b.role)) : null;

  let note: string;
  if (bothBypassRls === false) {
    const weak = [a, b].filter(x => x.role && !BYPASS.has(x.role)).map(x => x.role).join(' · ');
    note = `한쪽이 RLS를 우회하지 못하는 역할입니다 (${weak}) — 같은 질의가 다른 결과를 냅니다`;
  } else if (sameKey === true) {
    note = '같은 키입니다';
  } else if (sameKey === false && sameRole === true) {
    note = '서로 다른 키지만 역할은 같습니다';
  } else {
    note = '역할을 확인하지 못했습니다 — 다르다는 뜻이 아닙니다';
  }
  return { sameKey, sameRole, bothBypassRls, note };
}

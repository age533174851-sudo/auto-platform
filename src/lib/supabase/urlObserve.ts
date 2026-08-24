// src/lib/supabase/urlObserve.ts
//
// **보기만 한다. 아무것도 바꾸지 않는다.**
//
// 왜 따로 있나
// ────────────
// 지금 Production에서 이런 모순이 관측된다:
//
//   Fly 워커   `[heartbeat] ok ... verdict=RECORDED` 1분마다
//              project=sgbysrvvxlluzffmgcho · target=1351b7
//              그리고 **웹과 같은 질의(order last_seen desc limit 1)를
//              워커가 던지면 자기 줄이 최신으로 나온다** — DB는 정상이다
//   웹         같은 순간 마지막 기록이 8/20 14:18에 고정돼 있다
//
// 질의 모양이 같은데 결과가 다르면 남는 것은 **어디에 붙는가**다.
// 그런데 `getSupabaseAdmin()`은 `NEXT_PUBLIC_SUPABASE_URL`만 보고,
// 화면에 뜨는 지문은 `SUPABASE_URL || NEXT_PUBLIC_SUPABASE_URL`로 따로
// 계산한다 — 둘이 다르면 **지문은 A를 말하고 읽기는 B에서 일어난다.**
//
// 이 파일은 그 두 이름이 각각 무엇을 가리키는지 **말하기만 한다.**
//
// 하지 않는 것
// ────────────
//   · 접속 대상을 고르지 않는다 (`getSupabaseAdmin()`은 그대로다)
//   · 불일치를 이유로 무엇도 막지 않는다 (fail-closed 없음)
//   · DB에 쓰지 않는다 · 읽지도 않는다 (환경변수만 본다)
//   · **값을 내보내지 않는다** — 있는지(boolean) · project ref · 지문 6자뿐
//
// project ref가 비밀이 아닌 이유: `https://<ref>.supabase.co`는 브라우저
// 번들의 `NEXT_PUBLIC_SUPABASE_URL`에 이미 들어 있다. 비밀은 키다.
//
// 이 관측으로 값을 보고 나서, 그때 접속 대상을 통일할지(그리고 불일치를
// 막을지) 정한다. **진단하려고 운영 동작을 바꾸지 않는다.**
import { fingerprintOf } from '../system/fingerprint';

/** 한 이름이 무엇을 가리켰나. **값은 없다** */
export interface UrlSighting {
  /** 환경변수가 설정돼 있는가 */
  present: boolean;
  /** `https://<ref>.supabase.co`의 `<ref>`. 모르면 null — 지어내지 않는다 */
  projectRef: string | null;
  /** sha256 앞 6자. 값이 아니다 */
  fingerprint: string | null;
}

export interface UrlObservation {
  saw: {
    /** 서버 전용 이름 — 워커가 쓰는 것과 같은 이름이다 */
    server: UrlSighting;
    /** 브라우저에도 나가는 이름 — **main의 admin client가 실제로 쓰는 것** */
    public: UrlSighting;
  };
  /**
   * 둘이 같은 Supabase 프로젝트인가.
   *
   * **모르면 null이다.** 한쪽이라도 판단할 근거가 없으면 "같다"고 적지 않는다.
   */
  sameProject: boolean | null;
  /** 사람이 읽을 한 줄 */
  note: string;
}

/** 공백·줄바꿈·끝슬래시를 턴다 */
function normalize(raw: string | null | undefined): string {
  return String(raw ?? '').trim().replace(/\/+$/, '');
}

/** `https://abcdefgh.supabase.co` → `abcdefgh` */
export function projectRefOf(url: string | null | undefined): string | null {
  const u = normalize(url);
  if (!u) return null;
  try {
    const host = new URL(u).hostname;
    const m = /^([a-z0-9-]+)\.supabase\.(co|in|net)$/i.exec(host);
    return m ? m[1] : null;
  } catch { return null; }
}

function sight(raw: string | null | undefined): UrlSighting {
  const u = normalize(raw);
  if (!u) return { present: false, projectRef: null, fingerprint: null };
  return { present: true, projectRef: projectRefOf(u), fingerprint: fingerprintOf(u) };
}

/**
 * 두 이름이 같은 곳을 가리키는가.
 *
 * 순서가 중요하다 — **확실한 것부터** 본다:
 *   1. 둘 중 하나라도 없으면 비교할 수 없다 → null
 *   2. 정규화한 문자열이 같으면 확실히 같다 → true
 *   3. project ref를 둘 다 알면 그것으로 판단한다
 *   4. 지문이 다르면 **다른 것은 확실하다** → false
 *   5. 그 밖(지문만 같고 ref를 모름)은 **모른다** → null
 *
 * 5번을 true로 적지 않는 이유: 6자 해시가 같다는 것은 같은 값일
 * **가능성이 높다**는 뜻이지 확인된 사실이 아니다.
 */
export function sameProjectOf(serverRaw: string | null | undefined, publicRaw: string | null | undefined): boolean | null {
  const a = normalize(serverRaw);
  const b = normalize(publicRaw);
  if (!a || !b) return null;
  if (a === b) return true;
  const ra = projectRefOf(a); const rb = projectRefOf(b);
  if (ra && rb) return ra === rb;
  const fa = fingerprintOf(a); const fb = fingerprintOf(b);
  if (fa && fb && fa !== fb) return false;
  return null;
}

/**
 * 두 이름을 관측한다. **순수 함수** — 테스트가 붙는 자리다.
 *
 * 이 함수는 무엇도 고르지 않고 무엇도 막지 않는다.
 */
export function observeSupabaseUrls(env: {
  SUPABASE_URL?: string | null;
  NEXT_PUBLIC_SUPABASE_URL?: string | null;
}): UrlObservation {
  const server = sight(env.SUPABASE_URL);
  const pub = sight(env.NEXT_PUBLIC_SUPABASE_URL);
  const same = sameProjectOf(env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL);

  let note: string;
  if (!server.present && !pub.present) {
    note = '두 이름 모두 없습니다';
  } else if (!server.present) {
    note = 'SUPABASE_URL이 없습니다 — 화면의 지문은 NEXT_PUBLIC_SUPABASE_URL에서 옵니다';
  } else if (!pub.present) {
    note = 'NEXT_PUBLIC_SUPABASE_URL이 없습니다 — admin client는 이 이름을 씁니다';
  } else if (same === false) {
    note = '두 이름이 서로 다른 프로젝트를 가리킵니다 — 화면의 지문과 실제로 읽는 곳이 다를 수 있습니다'
      + ' (이 응답은 그 사실을 알릴 뿐, 아무 동작도 바꾸지 않습니다)';
  } else if (same === true) {
    note = '두 이름이 같은 곳을 가리킵니다';
  } else {
    note = '같은 곳인지 확인하지 못했습니다 — project ref를 읽을 수 없는 주소입니다 (다르다는 뜻이 아닙니다)';
  }

  return { saw: { server, public: pub }, sameProject: same, note };
}

/** 지금 프로세스의 환경을 관측한다 */
export function observeServerSupabaseUrls(): UrlObservation {
  return observeSupabaseUrls({
    SUPABASE_URL: process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
}

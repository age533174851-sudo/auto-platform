// src/lib/auth/oauthProviders.ts
//
// **이 소셜 로그인, 실제로 켜져 있는가.**
//
// 무슨 일이 났나
// ──────────────
// 구글 버튼을 누르면 이런 페이지가 떴다:
//
//   {"code":400,"error_code":"validation_failed",
//    "msg":"Unsupported provider: provider is not enabled"}
//
// 앱이 아니라 Supabase가 그린 날것의 JSON이다. 사용자는 앱을 벗어났고,
// 돌아올 길은 뒤로가기뿐이고, 무엇을 해야 하는지는 아무 데도 없다.
//
// 왜 앱이 못 잡았나
// ─────────────────
// `signInWithOAuth`는 기본적으로 **브라우저를 즉시 그 주소로 보낸다.**
// 그러니 400은 다음 페이지에서 일어나고, 앱에는 돌려줄 오류가 없다.
// 함수는 성공한 것처럼 반환하고 끝난다.
//
// 그래서 **보내기 전에** 묻는다. Supabase는 `/auth/v1/settings`에
// 어떤 제공자가 켜져 있는지 공개한다. 꺼져 있으면 앱 안에서 말한다.
//
// 못 물어봤으면 막지 않는다
// ─────────────────────────
// 설정 조회가 실패한 것은 '꺼져 있다'가 아니다. 그때는 그냥 보낸다 —
// 최악이라도 지금과 같고, 확인 못 한 것을 이유로 되는 기능을 막지 않는다.

export type OAuthProvider = 'google' | 'kakao';

export interface ProviderState {
  /** true=켜짐, false=꺼짐, null=확인하지 못함 */
  enabled: boolean | null;
  reason: string;
}

/**
 * `/auth/v1/settings` 응답에서 이 제공자의 상태를 읽는다.
 *
 * 순수 함수다. 네트워크는 부르는 쪽이 한다.
 *
 * 응답 모양(GoTrue):
 *   { "external": { "google": true, "kakao": false, ... }, ... }
 */
export function readProviderState(
  settings: any,
  provider: OAuthProvider,
): ProviderState {
  if (!settings || typeof settings !== 'object') {
    return { enabled: null, reason: '로그인 설정을 읽지 못했습니다' };
  }
  const ext = (settings as any).external;
  if (!ext || typeof ext !== 'object') {
    // 모양이 바뀌었을 수 있다. **꺼졌다고 단정하지 않는다** — 그러면
    // 멀쩡한 구글 로그인이 앱에서 사라진다.
    return { enabled: null, reason: '로그인 설정에 제공자 목록이 없습니다' };
  }
  const v = ext[provider];
  if (typeof v !== 'boolean') {
    return { enabled: null, reason: `설정에 ${provider} 항목이 없습니다` };
  }
  return {
    enabled: v,
    reason: v ? '' : `${label(provider)} 로그인이 꺼져 있습니다`,
  };
}

export function label(p: OAuthProvider): string {
  return p === 'google' ? '구글' : '카카오';
}

/**
 * 목적격 조사. '구글'은 받침이 있어 **을**, '카카오'는 없어 **를**이다.
 *
 * 이름을 문자열 조합으로 만들면서 조사를 하나로 박으면 반드시 한쪽이
 * 틀린다. 실제로 화면에 "구글를 켜고"가 떴다.
 */
export function objectParticle(word: string): string {
  const last = String(word || '').trim().slice(-1);
  const code = last.charCodeAt(0);
  // 한글 음절이 아니면 판단하지 않는다 — 영문·숫자에 조사를 붙이는 규칙은
  // 발음에 달려 있어서 글자만으로는 못 정한다.
  if (!(code >= 0xac00 && code <= 0xd7a3)) return '을(를)';
  // (코드 - 0xAC00) % 28 === 0 이면 받침이 없다
  return (code - 0xac00) % 28 === 0 ? '를' : '을';
}

/**
 * 꺼져 있을 때 사용자에게 보여줄 문구.
 *
 * "provider is not enabled"를 그대로 띄우면 사용자는 자기가 뭘 잘못한
 * 줄 안다. 이건 **앱 주인이 대시보드에서 켜야 하는 것**이고, 그 사실을
 * 적어야 한다. 그리고 지금 당장 로그인할 다른 길도 같이 알려준다.
 */
export function disabledMessage(p: OAuthProvider): string {
  return `${label(p)} 로그인이 아직 켜져 있지 않습니다. 지금은 이메일로 로그인하세요.`;
}

/**
 * 관리자에게만 보여줄 조치 안내.
 *
 * `disabledMessage`와 나눠 둔 이유: 일반 사용자에게 'Supabase 대시보드'는
 * 할 수 있는 일이 아니다. 자기가 뭘 잘못 눌렀나 싶게 만들 뿐이고,
 * 남의 앱 내부 구성을 그대로 보여주는 것이기도 하다.
 */
export function adminFixHint(p: OAuthProvider): string {
  const name = label(p);
  return `Supabase 대시보드 → Authentication → Providers → ${name}${objectParticle(name)} 켜고 `
    + 'OAuth 클라이언트 ID·시크릿을 넣으세요.';
}

/**
 * 지금 보내도 되는가.
 *
 * @returns go=true면 보낸다. false면 message를 앱 안에서 띄운다.
 */
export function decideOAuthGo(state: ProviderState, p: OAuthProvider): { go: boolean; message: string } {
  // 확인 못 했으면 보낸다. 확인 실패를 차단으로 바꾸지 않는다.
  if (state.enabled === null) return { go: true, message: '' };
  if (state.enabled) return { go: true, message: '' };
  return { go: false, message: disabledMessage(p) };
}

/**
 * 로그인 화면이 뜰 때 미리 물어본다 — 꺼진 버튼을 **누르게 두지 않기 위해서**.
 *
 * 누른 뒤에 안내하는 것보다 낫다. 누를 수 있는 버튼은 '된다'는 약속이고,
 * 눌러 봐야 아는 것은 그 약속을 매번 깨는 것이다.
 *
 * 못 물어봤으면 **아무것도 끄지 않는다.** 설정 조회가 한 번 실패했다고
 * 멀쩡한 구글 로그인이 회색이 되면, 그게 더 자주 일어나는 사고다.
 */
export async function fetchProviderStates(
  supabaseUrl: string,
  anonKey: string,
  providers: OAuthProvider[] = ['google', 'kakao'],
): Promise<Record<string, ProviderState>> {
  const unknown: Record<string, ProviderState> = {};
  for (const p of providers) unknown[p] = { enabled: null, reason: '확인하지 못했습니다' };
  if (!supabaseUrl) return unknown;
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/settings`, {
      headers: anonKey ? { apikey: anonKey } : undefined,
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return unknown;
    const settings = await r.json();
    const out: Record<string, ProviderState> = {};
    for (const p of providers) out[p] = readProviderState(settings, p);
    return out;
  } catch { return unknown; }
}

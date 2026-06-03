// src/lib/notifications.ts
// 알림 권한 관리 + 로컬 알림 + (선택) 푸시 구독
//
// 정책:
// - 로컬 알림 (Notification API): 앱이 열려있을 때 즉시 표시
// - 푸시 알림 (Web Push): 서버에서 VAPID로 전송 — 백그라운드에서도 동작
//   (VAPID 키 미설정 시 푸시는 비활성, 로컬 알림만 사용)

export type NotifPermission = 'default' | 'granted' | 'denied' | 'unsupported';

const PREF_KEY = 'tg_notif_pref_v1';   // 사용자가 켠 알림 종류

export interface NotifPrefs {
  priceAlerts:   boolean;   // 가격 알림
  newsImpact:    boolean;   // 영향도 높은 뉴스
  autoTrade:     boolean;   // 자동매매 체결/정지
  riskGuard:     boolean;   // 리스크 한도 도달
}

const DEFAULT_PREFS: NotifPrefs = {
  priceAlerts: true,
  newsImpact:  true,
  autoTrade:   true,
  riskGuard:   true,
};

export function getNotifPrefs(): NotifPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(PREF_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch { return DEFAULT_PREFS; }
}

export function setNotifPref(key: keyof NotifPrefs, value: boolean): NotifPrefs {
  const cur = getNotifPrefs();
  const next = { ...cur, [key]: value };
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(PREF_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

// ── 권한 상태 ────────────────────────────────────────────────
export function getPermission(): NotifPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as NotifPermission;
}

// ── 권한 요청 ────────────────────────────────────────────────
export async function requestPermission(): Promise<NotifPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied')  return 'denied';
  try {
    const result = await Notification.requestPermission();
    return result as NotifPermission;
  } catch {
    return 'denied';
  }
}

// ── 로컬 알림 발송 (권한 + 사용자 설정 확인) ──────────────
export function notify(
  category: keyof NotifPrefs,
  title: string,
  options?: { body?: string; tag?: string; url?: string; critical?: boolean },
): boolean {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;

  // 사용자가 해당 카테고리 알림을 껐으면 스킵
  const prefs = getNotifPrefs();
  if (!prefs[category]) return false;

  try {
    const notif = new Notification(title, {
      body:  options?.body || '',
      icon:  '/icon-192.png',
      badge: '/icon-192.png',
      tag:   options?.tag,
      requireInteraction: options?.critical || false,
    });
    if (options?.url) {
      notif.onclick = () => {
        window.focus();
        if (options.url && options.url !== window.location.pathname) {
          window.location.href = options.url;
        }
        notif.close();
      };
    }
    return true;
  } catch {
    return false;
  }
}

// ── 푸시 구독 (VAPID 공개키 필요) ───────────────────────────
// 서버에 VAPID 키가 설정돼야 동작. 미설정 시 false 반환.
export async function subscribePush(): Promise<{ ok: boolean; reason?: string }> {
  if (typeof window === 'undefined') return { ok: false, reason: 'no_window' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (Notification.permission !== 'granted') {
    return { ok: false, reason: 'no_permission' };
  }

  try {
    // VAPID 공개키 가져오기
    const keyRes = await fetch('/api/push/vapid-public-key').catch(() => null);
    if (!keyRes || !keyRes.ok) return { ok: false, reason: 'vapid_not_configured' };
    const { publicKey } = await keyRes.json();
    if (!publicKey) return { ok: false, reason: 'vapid_not_configured' };

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });

    // 서버에 구독 정보 전송
    const r = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
    if (!r.ok) return { ok: false, reason: 'subscribe_failed' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'unknown' };
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// src/lib/notify/center.ts
// 통합 알림 시스템 — 하단 토스트(일시) + 우상단 알림센터(최근 50개 영속).
// 모든 주문(모의/테스트넷/실전)과 자동매매 이벤트가 notify() 하나로 흐른다.

export type NotifyKind =
  | 'success' | 'error' | 'pending' | 'info' | 'warning'
  | 'buy' | 'sell' | 'tp' | 'sl' | 'bot' | 'kill';

export interface NotifyItem {
  id: string;
  kind: NotifyKind;
  title: string;
  detail?: string;
  at: number;        // epoch ms (체결 시각, 밀리초까지 보존)
}

const KEY = 'tg_notifications_v1';
const MAX = 50;

type ToastCb  = (item: NotifyItem) => void;
type CenterCb = () => void;
const toastSubs  = new Set<ToastCb>();
const centerSubs = new Set<CenterCb>();

export function subscribeToasts(cb: ToastCb): () => void { toastSubs.add(cb); return () => toastSubs.delete(cb); }
export function subscribeCenter(cb: CenterCb): () => void { centerSubs.add(cb); return () => centerSubs.delete(cb); }

export function loadNotifications(): NotifyItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function persist(items: NotifyItem[]) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX))); } catch {}
}

export function clearNotifications() {
  persist([]);
  centerSubs.forEach(cb => { try { cb(); } catch {} });
}

// 진동 패턴 (모바일) — 성공 1회, 실패 2회, 킬스위치 길게
function vibrate(kind: NotifyKind) {
  if (typeof navigator === 'undefined' || !navigator.vibrate) return;
  try {
    if (kind === 'kill')                         navigator.vibrate(300);
    else if (kind === 'error')                   navigator.vibrate([30, 60, 30]);
    else if (kind === 'success' || kind === 'tp')navigator.vibrate(50);
  } catch {}
}

export interface NotifyOpts { persist?: boolean; toast?: boolean; buzz?: boolean }

export function notify(kind: NotifyKind, title: string, detail?: string, opts: NotifyOpts = {}): NotifyItem {
  const { persist: doPersist = true, toast = true, buzz = true } = opts;
  const item: NotifyItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind, title, detail, at: Date.now(),
  };
  if (doPersist && kind !== 'pending') {   // 처리중은 센터에 안 쌓음 (일시 토스트만)
    const next = [item, ...loadNotifications()].slice(0, MAX);
    persist(next);
    centerSubs.forEach(cb => { try { cb(); } catch {} });
  }
  if (toast) toastSubs.forEach(cb => { try { cb(item); } catch {} });
  if (buzz)  vibrate(kind);
  return item;
}

// 편의 래퍼
export const notifySuccess = (t: string, d?: string) => notify('success', t, d);
export const notifyError   = (t: string, d?: string) => notify('error', t, d);
export const notifyPending = (t: string, d?: string) => notify('pending', t, d, { persist: false });
export const notifyInfo    = (t: string, d?: string) => notify('info', t, d);

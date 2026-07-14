// src/lib/confirm/dialog.ts
// 네이티브 confirm() 대체 — Promise 기반 전역 확인 모달.
// 사용: if (!(await confirmDialog('삭제할까요?'))) return;
export interface ConfirmOpts {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;   // 빨강 강조 (삭제/초기화 등)
}

interface PendingReq extends ConfirmOpts {
  id: number;
  message: string;
  resolve: (ok: boolean) => void;
}

type Listener = (req: PendingReq | null) => void;

let listener: Listener | null = null;
let seq = 0;

export function _subscribeConfirm(cb: Listener) {
  listener = cb;
  return () => { if (listener === cb) listener = null; };
}

export function confirmDialog(message: string, opts: ConfirmOpts = {}): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  // 호스트가 마운트되지 않았으면 네이티브로 폴백 (안전장치)
  if (!listener) return Promise.resolve(window.confirm(message));
  return new Promise<boolean>((resolve) => {
    listener!({ id: ++seq, message, resolve, ...opts });
  });
}

// src/lib/ui/opsView.ts
//
// **화면이 판단하지 않게 한다.**
//
// 운영 명령의 결과는 서버가 이미 판정해서 준다(READY · SELF_HEALED ·
// BOOTSTRAP_REQUIRED · BLOCKED). 화면이 그걸 다시 계산하면 기준이 두
// 곳에 생기고, 언젠가 서버는 BLOCKED인데 화면은 초록인 상태가 온다 —
// 이 저장소에서 가장 자주 고친 고장이 정확히 그것이다.
//
// 이 파일은 **색과 문장만** 고른다.

export type OpsVerdictLike = 'READY' | 'SELF_HEALED' | 'BOOTSTRAP_REQUIRED' | 'BLOCKED';

export interface VerdictView {
  glyph: string;
  tone: 'ok' | 'warn' | 'bad' | 'info';
  title: string;
  /** 사용자가 지금 무엇을 알아야 하는가 */
  note: string;
}

export function verdictView(v: OpsVerdictLike | string | null | undefined): VerdictView {
  switch (v) {
    case 'READY':
      return { glyph: '✓', tone: 'ok', title: '정상',
        note: '확인한 항목이 전부 정상입니다' };
    case 'SELF_HEALED':
      return { glyph: '↻', tone: 'info', title: '자동 복구됨',
        // **사람이 한 일이 아니다.** 그걸 분명히 적는다.
        note: '문제가 있었지만 시스템이 스스로 고쳤습니다 — 하실 일은 없습니다' };
    case 'BOOTSTRAP_REQUIRED':
      return { glyph: '🔑', tone: 'warn', title: '권한 연결 필요',
        note: '최초 한 번만 필요한 연결입니다. 연결한 뒤에는 다시 요청하지 않습니다' };
    case 'BLOCKED':
      return { glyph: '⛔', tone: 'bad', title: '막힘',
        note: '자동으로 처리하지 못한 것이 있습니다' };
    default:
      // **모르는 값을 초록으로 그리지 않는다.**
      return { glyph: '?', tone: 'bad', title: '확인 못 함',
        note: '결과를 읽지 못했습니다 — 정상이라는 뜻이 아닙니다' };
  }
}

export interface StepView {
  glyph: string;
  tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted';
  label: string;
  detail: string;
}

export function stepView(s: {
  label?: string; state?: string; detail?: string; did?: string[]; blockedReason?: string | null;
} | null | undefined): StepView {
  const label = String(s?.label ?? '');
  const detail = String(s?.detail ?? '');
  switch (s?.state) {
    case 'PASS': return { glyph: '✓', tone: 'ok', label, detail };
    case 'SELF_HEALED': return {
      glyph: '↻', tone: 'info', label,
      detail: detail + (s?.did?.length ? ` (${s.did.join(' · ')})` : ''),
    };
    case 'BLOCKED': return {
      glyph: '⛔', tone: 'bad', label,
      // 자동으로 못 한 이유를 함께 보여 준다. **무엇을 눌러라가 아니라
      // 왜 못 했는가다.**
      detail: s?.blockedReason ? `${detail} — ${s.blockedReason}` : detail,
    };
    case 'SKIPPED': return { glyph: '·', tone: 'muted', label, detail: detail || '이 명령에서는 보지 않았습니다' };
    default: return {
      glyph: '?', tone: 'bad', label,
      detail: detail || '확인하지 못했습니다 — 정상이라는 뜻이 아닙니다',
    };
  }
}

/**
 * 요청이 어떻게 끝났는가.
 *
 * **접수와 실행은 다르다.** 큐에 적힌 것을 '실행됨'으로 그리지 않는다.
 */
export function requestView(r: {
  status?: string; command?: string; error?: string | null; result?: any;
} | null | undefined): { glyph: string; tone: 'ok' | 'warn' | 'bad' | 'info'; text: string } {
  const cmd = String(r?.command ?? '명령');
  switch (r?.status) {
    case 'PENDING': return { glyph: '…', tone: 'info', text: `${cmd} — 실행기가 집어 가기를 기다리는 중입니다` };
    case 'CLAIMED': return { glyph: '▶', tone: 'info', text: `${cmd} — 실행 중입니다` };
    case 'DONE': return { glyph: '✓', tone: 'ok', text: `${cmd} — ${r?.result?.summary || '끝났습니다'}` };
    case 'FAILED': return { glyph: '✗', tone: 'bad', text: `${cmd} — ${r?.error || '실패했습니다'}` };
    case 'EXPIRED': return { glyph: '⌛', tone: 'warn', text: `${cmd} — ${r?.error || '너무 오래돼 실행하지 않았습니다'}` };
    default: return { glyph: '?', tone: 'bad', text: `${cmd} — 상태를 읽지 못했습니다` };
  }
}

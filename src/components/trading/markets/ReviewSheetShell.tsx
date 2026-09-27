'use client';
// src/components/trading/markets/ReviewSheetShell.tsx
//
// **확인 창의 껍데기 — 표현 · 포커스 · 바닥 줄만.**
//
// 무엇을 공유하고 무엇을 공유하지 않나
// ────────────────────────────────────
// 주문 확인(Phase 2C)과 청산 확인(Phase 2D)은 **보이는 모양과 키보드
// 규칙이 같다.** 그 둘을 따로 짜면 한쪽만 고쳐지고, 눈으로는 똑같아
// 보이는데 한 창에서만 포커스가 새는 상태가 된다.
//
// 그래서 여기 모으는 것은 셋뿐이다:
//
//     dialog 의미(role · aria-modal · 이름)
//     포커스 들이기 · 가두기 · 되돌리기
//     본문 스크롤 + 바닥 줄 고정
//
// **절대 공유하지 않는 것**
// ─────────────────────────
// 상태 기계 · 확인 판정 · 부수효과. 진입은 "무엇을 얼마나 살 것인가"이고
// 청산은 "이미 가진 것 하나를 닫는다"다. 정체성도 다르다
// (`{market,symbol,side}` 대 `positionId`). 하나의 reducer로 합치면 둘 중
// 하나의 안전조건이 다른 쪽 이름에 가려진다.
//
// 배경 `inert`는 **여기서 하지 않는다** — 무엇을 덮는지는 화면마다 다르다
// (거래 화면은 껍데기 통, 포지션 화면은 본문). 각 화면이 `useInert`로
// 자기 배경을 정한다.
import React from 'react';
import { C, FS } from '@/components/terminal/theme';

export interface ReviewSheetShellProps {
  /** 닫혀 있으면 아무것도 그리지 않는다 (숨기는 것이 아니라 없다) */
  open: boolean;
  testid: string;
  title: string;
  /** 스크린리더가 읽을 이름. 무엇에 대한 확인인지가 들어간다 */
  label: string;
  /** `data-*` 표 — 실기가 이 창이 무엇을 다루는지 확인한다 */
  dataAttrs?: Record<string, string>;
  /** 본문 (스크롤한다) */
  children: React.ReactNode;
  /** 스크롤 밖에 고정되는 한 줄. 서버 재계산 같은 단서가 여기 온다 */
  note?: React.ReactNode;
  /** 바닥 버튼 줄 */
  footer: React.ReactNode;
  /** 왜 확인할 수 없는지. 회색 버튼만 두지 않는다 */
  blockedReason?: string | null;
  /**
   * 안쪽 조각들의 표 이름.
   *
   * 기본은 `${testid}-body`처럼 파생하지만, **이미 실기·검사기가 보고 있는
   * 이름이 있으면 그것을 그대로 쓴다** — 공용 껍데기로 옮겼다는 이유로
   * 증거의 이름이 바뀌면 그 증거가 끊긴다.
   */
  ids?: { backdrop?: string; body?: string; note?: string; footer?: string; blocked?: string };
}

export function ReviewSheetShell(p: ReviewSheetShellProps) {
  const sheetRef = React.useRef<HTMLDivElement | null>(null);
  const returnTo = React.useRef<HTMLElement | null>(null);

  // ── ★ 포커스를 안으로 들이고, 닫으면 제자리로 돌려놓는다 ──
  //
  //   배경이 `inert`라 Tab은 뒤로 넘어가지 않는다. 그런데 **열리는 순간의
  //   포커스**는 아직 뒤 버튼에 있다 — 그대로 두면 포커스가 inert 안에
  //   갇혀 사라지고, 키보드 사용자는 창을 조작할 수 없다.
  React.useEffect(() => {
    if (!p.open) return;
    returnTo.current = (document.activeElement as HTMLElement) || null;
    // ★ **맨 앞 버튼(= 취소)에 둔다.** 확인이 아니다.
    //
    //   확인 창은 되돌릴 수 없는 동작 앞에 있다. 열자마자 확인 버튼에
    //   포커스가 가 있으면 Enter 한 번에 주문이 나가거나 포지션이 닫힌다 —
    //   창을 끼워 넣은 이유가 사라진다. 그래서 바닥 줄의 첫 버튼(돌아가기)
    //   에 둔다. 확인하려면 Tab을 한 번 더 눌러야 한다.
    const first = sheetRef.current?.querySelector<HTMLElement>('button:not([disabled])');
    (first || sheetRef.current)?.focus();
    return () => {
      const back = returnTo.current;
      returnTo.current = null;
      // 되돌릴 때 배경은 이미 inert가 풀린 뒤여야 한다 — 다음 프레임에.
      if (back && document.contains(back)) {
        requestAnimationFrame(() => { try { back.focus(); } catch { /* 사라졌다 */ } });
      }
    };
  }, [p.open]);

  // Tab이 끝에서 넘어가지 않게 감싼다. `inert`가 이미 막지만, 이 창이 다른
  // 자리에 놓이더라도 포커스가 새 나가지 않게 여기서도 잠근다.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const box = sheetRef.current;
    if (!box) return;
    const f = [...box.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (f.length === 0) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    const cur = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (cur === first || !box.contains(cur))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (cur === last || !box.contains(cur))) { e.preventDefault(); first.focus(); }
  };

  if (!p.open) return null;
  const id = {
    backdrop: p.ids?.backdrop ?? `${p.testid}-backdrop`,
    body: p.ids?.body ?? `${p.testid}-body`,
    note: p.ids?.note ?? `${p.testid}-note`,
    footer: p.ids?.footer ?? `${p.testid}-footer`,
    blocked: p.ids?.blocked ?? `${p.testid}-blocked-reason`,
  };

  return (
    <div data-testid={id.backdrop}
      // 뒤를 눌러서 닫지 않는다 — 보내는 중에 잘못 닫히면 결과를 잃는다.
      style={{
        position: 'absolute', inset: 0, zIndex: 40,
        background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end',
      }}>
      <div data-testid={p.testid}
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={p.label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        {...(p.dataAttrs || {})}
        style={{
          width: '100%', maxHeight: '86%', minHeight: 0,
          display: 'flex', flexDirection: 'column',
          background: C.panel, borderTop: `1px solid ${C.hair}`,
          borderRadius: '12px 12px 0 0',
        }}>
        <div style={{
          padding: '10px 14px 6px', fontSize: FS.lead, fontWeight: 800, color: C.text,
        }}>{p.title}</div>

        {/* 본문만 스크롤한다 */}
        <div data-testid={id.body} style={{
          flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain',
          padding: '0 14px',
        }}>{p.children}</div>

        {/* ★ 단서는 **스크롤 밖**이다. 본문 안에 두면 좁은 기기에서 접혀
            보이지 않고, 그러면 화면 숫자가 약속으로 읽힌다. */}
        {p.note ? (
          <div data-testid={id.note} style={{
            flexShrink: 0, padding: '6px 14px 0', background: C.panel,
            fontSize: FS.micro, color: C.faint, lineHeight: 1.45,
          }}>{p.note}</div>
        ) : null}

        {/* 바닥 줄은 붙어 있다 — 내용이 길어도 확인 버튼이 사라지지 않는다 */}
        <div data-testid={id.footer} style={{
          position: 'sticky', bottom: 0, flexShrink: 0,
          display: 'flex', gap: 8, padding: '8px 14px 14px',
          background: C.panel, borderTop: `1px solid ${C.hair}`,
        }}>{p.footer}</div>

        {p.blockedReason ? (
          <div data-testid={id.blocked} style={{
            padding: '0 14px 12px', fontSize: FS.micro, color: C.warn, lineHeight: 1.4,
          }}>{p.blockedReason}</div>
        ) : null}
      </div>
    </div>
  );
}

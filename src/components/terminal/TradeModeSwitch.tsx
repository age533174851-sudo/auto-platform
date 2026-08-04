'use client';
// src/components/terminal/TradeModeSwitch.tsx
//
// 모의 / 테스트넷 / 실전.
//
// 이 화면에서 가장 중요한 한 줄이다
// ─────────────────────────────────
// 나머지는 전부 "무엇을 얼마나"를 정하는 것이고, 이 줄만 "**진짜 돈인가**"를
// 정한다. 그래서 접거나 메뉴에 넣지 않고 주문판 바로 위에 둔다.
//
// 색만으로 구분하지 않는다. 실전은 글자와 테두리와 배경이 전부 바뀌고,
// 아래에 한 줄 설명이 따라 붙는다 — 색약인 사람이나 밝은 화면에서
// 색만 보고 판단하게 두면 안 되는 정보다.
import React, { useState } from 'react';
import { C, FS, chip } from './theme';
import { A } from '@/lib/theme/colors';
import { useTerminal } from './TerminalContext';
import { TRADE_MODES, MODE_INFO, switchWarning, type TradeMode } from '@/lib/markets/tradeMode';

export function TradeModeSwitch({ compact }: { compact?: boolean }) {
  const { tradeMode, setTradeMode, modeResolution, connections } = useTerminal();
  const [busy, setBusy] = useState(false);

  const pick = async (m: TradeMode) => {
    if (m === tradeMode || busy) return;

    // 실전으로 넘어가는 것만 확인을 받는다. 되돌아오는 방향은 안전하다.
    const warn = switchWarning(tradeMode, m);
    if (warn) {
      setBusy(true);
      try {
        const { confirmDialog } = await import('@/lib/confirm/dialog');
        if (!(await confirmDialog(warn, { danger: true }))) return;
      } finally { setBusy(false); }
    }
    setTradeMode(m);
  };

  const info = MODE_INFO[tradeMode];
  const live = tradeMode === 'LIVE';

  return (
    <div>
      <div style={{
        display: 'flex', gap: 4, background: C.raised, padding: 3, borderRadius: 8,
        border: live ? `1px solid ${A(C.down, '77')}` : `1px solid transparent`,
      }}>
        {TRADE_MODES.map(m => {
          const on = tradeMode === m;
          const isLive = m === 'LIVE';
          return (
            <button key={m} onClick={() => pick(m)} style={{
              flex: 1, minHeight: compact ? 30 : 34, borderRadius: 6, cursor: 'pointer',
              border: 'none',
              background: on ? (isLive ? C.down : C.accent) : 'transparent',
              color: on ? '#fff' : (isLive ? C.down : C.dim),
              fontSize: compact ? FS.micro : FS.small,
              fontWeight: on ? 800 : 600,
              letterSpacing: '-0.01em',
            }}>
              {MODE_INFO[m].short}
            </button>
          );
        })}
      </div>

      {/* 설명 한 줄. 색이 아니라 글자로 말한다.
          좁은 화면에서는 짧은 쪽을 쓴다 — 두 줄로 접히면 그 36px이 그대로
          포지션 칸에서 빠진다.

          **실전에서는 좁아도 남긴다.** 모의·테스트넷에서만 뺀다:
          그때는 눌린 칩에 '모의'·'테스트넷'이라고 **글자로** 적혀 있어서
          색에만 기대는 것이 아니다. 반면 실전은 한 번 더 말해야 하고,
          그 한 줄을 아끼려다 잘못 누르게 두는 것은 자리 절약이 아니다. */}
      {(!compact || live) && (
        <div style={{
          marginTop: 4, fontSize: FS.micro, lineHeight: 1.45,
          color: live ? C.down : C.faint,
          fontWeight: live ? 700 : 400,
          whiteSpace: compact ? 'nowrap' : undefined,
          overflow: compact ? 'hidden' : undefined,
          textOverflow: compact ? 'ellipsis' : undefined,
        }}>
          {compact ? info.descShort : info.desc}
        </div>
      )}

      {/* 쓸 연결이 없으면 그 사실과 이유. 주문 버튼까지 가서 실패하게 두지 않는다 */}
      {!modeResolution.ok && (
        <div style={{
          marginTop: 6, padding: '7px 9px', borderRadius: 7,
          background: C.warnBg, color: C.warn, fontSize: FS.micro, lineHeight: 1.5,
        }}>
          {modeResolution.reason}
          {connections.length === 0 && (
            <div style={{ color: C.dim, marginTop: 3 }}>
              모의투자는 연결 없이 바로 쓸 수 있습니다.
            </div>
          )}
        </div>
      )}

      {/* 연결이 바뀌었다면 그 사실.

          **compact에서는 적지 않는다 — 바로 밑 주문판의 AccountLine이
          같은 문장을 이미 적는다.** 두 번 적으면 세 줄이 두 번이라
          여섯 줄이고, 좁은 화면에서 그만큼 주문 버튼이 아래로 밀린다.
          실제로 [숏 진입]이 칸 밖으로 밀려 나갔다.

          같은 말을 반복해서 안전해지지 않는다. AccountLine 쪽에 두는
          이유는 거기가 **어느 계좌인지 바로 위에 적혀 있는 자리**라
          "이 계좌로 나갑니다"가 무엇을 가리키는지 알 수 있어서다.

          `!ok`(쓸 연결 없음)는 위에 그대로 남는다. 그건 주문판이 아예
          안 뜰 수도 있는 상황이라 여기서 말해야 한다. */}
      {!compact && modeResolution.ok && modeResolution.reason && (
        <div style={{ marginTop: 5, color: C.warn, fontSize: FS.micro, lineHeight: 1.5 }}>
          {modeResolution.reason}
        </div>
      )}
    </div>
  );
}

/** 헤더에 붙이는 아주 작은 표시 — 지금 어느 모드인지만 */
export function TradeModeChip() {
  const { tradeMode } = useTerminal();
  const info = MODE_INFO[tradeMode];
  return (
    <span style={info.realMoney ? chip(C.down, C.downBg) : chip(C.dim)}>
      {info.short}
    </span>
  );
}

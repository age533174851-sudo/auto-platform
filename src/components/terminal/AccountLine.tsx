'use client';
// src/components/terminal/AccountLine.tsx
//
// 지금 주문이 나갈 계좌를 보여주고 **바꾼다.**
//
// 왜 파일을 따로 두는가
// ─────────────────────
// 선물·현물·COIN-M 세 주문판이 전부 이 줄을 쓴다. OrderPane 안에 두면
// 현물 폼이 OrderPane을 import하고 OrderPane이 현물 폼을 import하는
// 순환이 된다. 그리고 셋이 각자 자기 계좌 줄을 그리기 시작하면, 언젠가
// 한 폼만 다른 계좌를 가리키게 된다 — 이 화면에서 가장 비싼 종류의 어긋남이다.
import React, { memo, useMemo, useState } from 'react';
import { A } from '@/lib/theme/colors';
import { C, FS, ghostBtn } from './theme';
import { useTerminal } from './TerminalContext';
import { connectionsFor } from '@/lib/markets/tradeMode';

/**
 * 지금 주문이 나갈 계좌 한 줄.
 *
 * 왜 필요한가
 * ───────────
 * 이 화면에서 되돌릴 수 없는 질문은 둘이다: **진짜 돈인가**, 그리고
 * **어느 계좌인가.** 앞은 모드 전환줄이 답하는데 뒤는 아무도 답하지 않았다.
 *
 * 테스트넷 연결과 실전 연결을 같이 등록해 두는 것이 정상이고(키가 아예
 * 다르다), 같은 환경에 연결이 둘 이상일 수도 있다. 그때 '테스트넷'이라는
 * 글자만으로는 **어느 키**로 나가는지 알 수 없다.
 *
 * 모의는 거래소를 안 부르므로 계좌가 없다. 그 사실을 그대로 적는다 —
 * 빈 줄로 두면 '못 읽었다'로 읽힌다.
 *
 * 왜 **바꿀 수 있어야** 하는가
 * ────────────────────────────
 * 계좌를 두 개 이상 등록하는 것이 정상이다(거래소별로, 환경별로). 그런데
 * 보여주기만 하면 사용자는 어느 계좌인지 알면서 **바꿀 방법이 없다.**
 * 다른 계좌로 주문하려면 화면을 나가 연결 관리로 갔다가 돌아와야 한다.
 *
 * 그리고 안 보여주는 것보다 나쁜 경우가 있다: 목록의 첫 번째가 말없이
 * 골라진 상태. 화면에는 계좌가 적혀 있으니 사용자는 자기가 고른 것이라고
 * 읽는다. 고르는 곳이 여기 있어야 그 글자가 **선택**이 된다.
 *
 * 목록은 `connectionsFor`가 만든다 — 모드 판정(resolveTradeMode)이 쓰는
 * 것과 **같은 함수**다. 여기서 따로 거르면 화면이 고를 수 있는 계좌와
 * 실제로 쓰이는 계좌가 갈린다.
 */
export const AccountLine = memo(function AccountLine() {
  const { connections, tradeMode, modeResolution, connId, setConnId, navigateApp } = useTerminal();
  const [open, setOpen] = useState(false);

  // 이 모드에서 쓸 수 있는 계좌. 테스트넷 탭에 실전 키가 섞이면 안 된다.
  const usable = useMemo(
    () => connectionsFor(tradeMode, connections as any[]),
    [tradeMode, connections]);

  const label = (c: any) => c?.nickname || c?.label || c?.exchange || '연결';
  const masked = (c: any) => c?.apiKeyMasked || c?.api_key_masked || '';

  const box = (color: string, bg: string, text: string, sub?: string, onClick?: () => void) => {
    const inner = (
      <>
        <span style={{ color, fontWeight: 800, whiteSpace: 'nowrap' }}>{text}</span>
        {sub && <span style={{ color: C.dim, minWidth: 0, wordBreak: 'break-all' }}>{sub}</span>}
        {onClick && (
          <span style={{ color: C.faint, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            {open ? '닫기' : '바꾸기'}
          </span>
        )}
      </>
    );
    const style: React.CSSProperties = {
      display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap',
      width: '100%', textAlign: 'left',
      padding: '5px 8px', borderRadius: 7, background: bg,
      border: `1px solid ${A(color, '40')}`, fontSize: FS.micro, lineHeight: 1.4,
    };
    if (!onClick) return <div style={style}>{inner}</div>;
    // 44px 규칙에서 빼는 자리다. 이 줄은 정보 표시가 주 목적이고,
    // 잘못 눌러도 계좌 목록이 열릴 뿐 되돌릴 수 없는 일이 없다.
    return (
      <button type="button" className="switch" onClick={onClick}
        style={{ ...style, minHeight: 0, cursor: 'pointer' }}>
        {inner}
      </button>
    );
  };

  if (tradeMode === 'PAPER') {
    return box(C.accent, C.accentBg, '모의 계좌', '거래소로 나가지 않습니다');
  }

  const goConnect = navigateApp ? () => navigateApp('accounts') : null;

  if (!modeResolution.ok) {
    // 쓸 연결이 없다. 주문 버튼까지 가서 실패하게 두지 않는다.
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {box(C.warn, C.warnBg, '계좌 없음', modeResolution.reason)}
        {goConnect && (
          <button type="button" onClick={goConnect}
            style={{ ...ghostBtn(), minHeight: 28, fontSize: FS.micro }}>
            연결 관리로 가기
          </button>
        )}
      </div>
    );
  }

  const conn: any = connections.find((c: any) => c.id === modeResolution.connId);
  if (!conn) {
    // 판정은 됐는데 목록에서 못 찾았다. **조용히 넘기지 않는다** —
    // 어느 계좌인지 모르는 채로 주문이 나가는 상태다.
    return box(C.warn, C.warnBg, '계좌 확인 불가', '연결 정보를 읽지 못했습니다');
  }

  const live = modeResolution.realMoney;
  const tone = live ? C.down : C.up;
  const key = masked(conn);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {box(
        tone, live ? C.downBg : C.upBg,
        live ? '실전 계좌' : '테스트넷 계좌',
        `${label(conn)}${key ? ` · ${key}` : ''}`,
        () => setOpen(v => !v),
      )}

      {/* 고른 연결이 이 모드에 안 맞아 다른 것이 쓰이는 경우.
          resolveTradeMode가 이유를 남기는데 지금까지 아무도 안 보여줬다 —
          그러면 사용자는 자기가 고른 계좌로 주문이 나간다고 믿는다. */}
      {modeResolution.reason && (
        <div style={{
          padding: '5px 8px', borderRadius: 7, background: C.warnBg,
          color: C.warn, fontSize: FS.micro, lineHeight: 1.45,
        }}>{modeResolution.reason}</div>
      )}

      {open && (
        <div style={{
          border: `1px solid ${C.hair2}`, borderRadius: 8,
          background: C.panel, overflow: 'hidden',
        }}>
          {usable.map((c: any) => {
            const on = c.id === modeResolution.connId;
            return (
              <button key={c.id} type="button" className="switch"
                onClick={() => { setConnId(c.id); setOpen(false); }}
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 6, width: '100%',
                  textAlign: 'left', padding: '7px 9px', minHeight: 0,
                  background: on ? C.active : 'transparent', border: 'none',
                  borderBottom: `1px solid ${C.hair}`, cursor: 'pointer',
                  fontSize: FS.micro, lineHeight: 1.4,
                }}>
                <span style={{ color: on ? tone : C.text, fontWeight: on ? 800 : 600 }}>
                  {label(c)}
                </span>
                <span style={{ color: C.dim, minWidth: 0, wordBreak: 'break-all' }}>
                  {masked(c)}
                </span>
                {on && <span style={{ color: tone, marginLeft: 'auto', fontWeight: 800 }}>지금 이 계좌</span>}
              </button>
            );
          })}
          {usable.length <= 1 && (
            <div style={{ padding: '7px 9px', color: C.faint, fontSize: FS.micro, lineHeight: 1.5 }}>
              {/* 하나뿐인 것과 못 읽은 것은 다르다. 하나뿐이라고 적는다 */}
              {live ? '실전' : '테스트넷'}으로 쓸 수 있는 계좌가 이것 하나입니다.
            </div>
          )}
          {goConnect && (
            <button type="button" onClick={goConnect} style={{
              width: '100%', padding: '7px 9px', minHeight: 0, textAlign: 'left',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: C.accent, fontSize: FS.micro, fontWeight: 700,
            }} className="switch">
              + 연결 추가 · 관리
            </button>
          )}
        </div>
      )}
    </div>
  );
});

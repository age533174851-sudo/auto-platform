'use client';
// src/components/terminal/PreferencesPanel.tsx
//
// **화면 기본값 설정.**
//
// 여기 있는 스위치는 전부 실제로 무언가를 바꾼다
// ───────────────────────────────────────────────
// 거래소 설정 화면을 그대로 베끼지 않았다. 헤지 모드·자산 모드·TWAP·
// Chase는 이 앱에 그 기능 자체가 없다 — 스위치만 두면 눌러도 아무 일도
// 안 하고, 그러면 이 화면 전체를 못 믿게 된다. 어느 것이 진짜인지
// 구분할 방법이 없기 때문이다.
//
// 그래서 각 항목 아래에 **어디에 적용되는지**를 적는다. 그게 없으면
// 사용자는 바꾼 뒤에 무엇이 달라졌는지 찾아다녀야 한다.
import React, { memo, useState } from 'react';
import { C, FS, NUM } from './theme';
import {
  loadPrefs, savePrefs, moveButton, toggleButton,
  POSITION_BUTTONS, BUTTON_LABEL, CONFIRM_KINDS, CONFIRM_LABEL,
  type Preferences, type PositionButton, type ConfirmKind,
} from '@/lib/ui/preferences';

export const PreferencesPanel = memo(function PreferencesPanel() {
  const [p, setP] = useState<Preferences>(() => loadPrefs());
  const [tab, setTab] = useState<'TRADE' | 'LAYOUT' | 'CONFIRM'>('TRADE');
  const [note, setNote] = useState('');

  const put = (patch: Partial<Preferences>) => {
    const next = { ...p, ...patch };
    setP(next); savePrefs(next); setNote('');
  };

  const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div style={{ padding: '10px 0', borderBottom: `1px solid ${C.hair}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
        <span style={{ color: C.text, fontSize: FS.small, fontWeight: 700 }}>{label}</span>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>{children}</div>
      </div>
      {/* **어디에 적용되는지**를 적는다. 없으면 바꾼 뒤 무엇이 달라졌는지
          찾아다녀야 한다. */}
      {hint && (
        <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 4, lineHeight: 1.6 }}>{hint}</div>
      )}
    </div>
  );

  const Seg = ({ on, onClick, children, danger }: any) => (
    <button onClick={onClick} style={{
      minHeight: 30, padding: '0 12px', borderRadius: 7, cursor: 'pointer',
      background: on ? (danger ? C.down : C.accent) : C.panel,
      color: on ? '#fff' : danger ? C.down : C.dim,
      border: `1px solid ${on ? 'transparent' : C.hair}`,
      fontSize: FS.micro, fontWeight: 700,
    }}>{children}</button>
  );

  return (
    <div style={{ padding: '10px 11px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4, marginBottom: 10 }}>
        {([['TRADE', '주문 기본값'], ['LAYOUT', '화면'], ['CONFIRM', '확인창']] as const).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            minHeight: 30, borderRadius: 7, cursor: 'pointer',
            background: tab === t ? C.raised : 'transparent',
            color: tab === t ? C.text : C.dim,
            border: `1px solid ${tab === t ? C.hair2 : C.hair}`,
            fontSize: FS.micro, fontWeight: 700,
          }}>{label}</button>
        ))}
      </div>

      {note && (
        <div style={{
          padding: '7px 9px', borderRadius: 7, marginBottom: 8,
          background: C.downBg, color: C.down, fontSize: FS.micro, lineHeight: 1.5,
        }}>{note}</div>
      )}

      {tab === 'TRADE' && (
        <>
          <Row label="TP/SL 트리거 기준"
            hint={p.trigger === 'MARK'
              ? 'Mark(지수 기반) — 순간적인 꼬리에 덜 걸립니다. 포지션 카드의 TP/SL 판이 이 값으로 시작합니다.'
              : 'Last(최종 체결가) — 얇은 호가에서는 한 틱 꼬리에도 발동할 수 있습니다.'}>
            <Seg on={p.trigger === 'MARK'} onClick={() => put({ trigger: 'MARK' })}>Mark</Seg>
            <Seg on={p.trigger === 'LAST'} onClick={() => put({ trigger: 'LAST' })}>Last</Seg>
          </Row>

          <Row label="주문 수량 단위"
            hint="선물 주문 화면의 수량 칸이 이 단위로 시작합니다. 언제든 칸 옆에서 바꿀 수 있습니다.">
            <Seg on={p.unit === 'BASE'} onClick={() => put({ unit: 'BASE' })}>코인</Seg>
            <Seg on={p.unit === 'QUOTE'} onClick={() => put({ unit: 'QUOTE' })}>USDT</Seg>
          </Row>

          <Row label="기본 배율"
            hint="새로 여는 주문 화면의 배율입니다. 이미 열린 포지션에는 영향이 없습니다.">
            <input value={String(p.leverage)} inputMode="numeric"
              onChange={e => {
                const raw = e.target.value.replace(/[^0-9]/g, '');
                if (raw === '') return;
                const n = Math.min(125, Math.max(1, Number(raw)));
                put({ leverage: n });
              }}
              style={{
                width: 64, textAlign: 'center', background: C.panel,
                border: `1px solid ${C.hair}`, borderRadius: 7, minHeight: 30,
                color: p.leverage >= 50 ? C.warn : C.text, ...NUM,
                fontSize: FS.micro, fontWeight: 800, outline: 'none',
              }}/>
          </Row>

          <Row label="모의 마진 모드"
            hint="모의 주문에만 적용됩니다. 실계좌는 거래소에 설정된 값을 읽어 옵니다 — 여기서 바꿀 수 없습니다.">
            <Seg on={p.paperMargin === 'ISOLATED'} onClick={() => put({ paperMargin: 'ISOLATED' })}>격리</Seg>
            <Seg danger on={p.paperMargin === 'CROSSED'} onClick={() => put({ paperMargin: 'CROSSED' })}>교차</Seg>
          </Row>
        </>
      )}

      {tab === 'LAYOUT' && (
        <>
          <Row label="포지션 카드"
            hint={p.density === 'DETAILED'
              ? '자세히 — 증거금·명목가·체결가까지 봅니다.'
              : '간단히 — 손익과 청산가만 봅니다. 포지션이 많을 때 한 화면에 더 들어갑니다.'}>
            <Seg on={p.density === 'DETAILED'} onClick={() => put({ density: 'DETAILED' })}>자세히</Seg>
            <Seg on={p.density === 'BRIEF'} onClick={() => put({ density: 'BRIEF' })}>간단히</Seg>
          </Row>

          <div style={{ padding: '10px 0' }}>
            <div style={{ color: C.text, fontSize: FS.small, fontWeight: 700 }}>포지션 카드 버튼</div>
            <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 4, marginBottom: 8, lineHeight: 1.6 }}>
              위에 있는 것부터 왼쪽에 놓입니다. 최대 4개, <b>최소 1개</b>는 켜져 있어야 합니다 —
              다 끄면 포지션 카드에서 청산조차 할 수 없습니다.
            </div>

            {p.positionButtons.map((b, i) => (
              <div key={b} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 0', borderBottom: `1px solid ${C.hair}`,
              }}>
                <span style={{ color: C.faint, fontSize: FS.micro, width: 16, ...NUM }}>{i + 1}</span>
                <span style={{ flex: 1, color: C.text, fontSize: FS.micro, fontWeight: 700 }}>
                  {BUTTON_LABEL[b]}
                </span>
                <button onClick={() => put({ positionButtons: moveButton(p.positionButtons, i, i - 1) })}
                  disabled={i === 0} aria-label="위로"
                  style={arrowBtn(i === 0)}>▲</button>
                <button onClick={() => put({ positionButtons: moveButton(p.positionButtons, i, i + 1) })}
                  disabled={i === p.positionButtons.length - 1} aria-label="아래로"
                  style={arrowBtn(i === p.positionButtons.length - 1)}>▼</button>
                <button onClick={() => {
                  const r = toggleButton(p.positionButtons, b);
                  if (r.reason) { setNote(r.reason); return; }
                  put({ positionButtons: r.list });
                }} style={{
                  minHeight: 26, padding: '0 10px', borderRadius: 6, cursor: 'pointer',
                  background: C.accentBg, color: C.accent, border: `1px solid ${C.accent}`,
                  fontSize: FS.micro, fontWeight: 700,
                }}>켜짐</button>
              </div>
            ))}

            {/* 꺼져 있는 것들 */}
            {POSITION_BUTTONS.filter(b => !p.positionButtons.includes(b)).map(b => (
              <div key={b} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 0', borderBottom: `1px solid ${C.hair}`, opacity: .6,
              }}>
                <span style={{ width: 16 }}/>
                <span style={{ flex: 1, color: C.dim, fontSize: FS.micro, fontWeight: 700 }}>
                  {BUTTON_LABEL[b]}
                </span>
                <button onClick={() => {
                  const r = toggleButton(p.positionButtons, b);
                  if (r.reason) { setNote(r.reason); return; }
                  put({ positionButtons: r.list });
                }} style={{
                  minHeight: 26, padding: '0 10px', borderRadius: 6, cursor: 'pointer',
                  background: 'transparent', color: C.dim, border: `1px solid ${C.hair}`,
                  fontSize: FS.micro, fontWeight: 700,
                }}>꺼짐</button>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'CONFIRM' && (
        <>
          <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 10, lineHeight: 1.6 }}>
            주문을 내기 전에 확인창을 띄울 유형을 고릅니다.
          </div>

          {CONFIRM_KINDS.map(k => {
            const on = p.confirmKinds.includes(k);
            return (
              <div key={k} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '9px 0', borderBottom: `1px solid ${C.hair}`,
              }}>
                <span style={{ flex: 1, color: C.text, fontSize: FS.micro, fontWeight: 700 }}>
                  {CONFIRM_LABEL[k]}
                </span>
                <button onClick={() => put({
                  confirmKinds: on
                    ? p.confirmKinds.filter(x => x !== k)
                    : [...p.confirmKinds, k as ConfirmKind],
                })} style={{
                  minHeight: 28, padding: '0 12px', borderRadius: 7, cursor: 'pointer',
                  background: on ? C.accentBg : 'transparent',
                  color: on ? C.accent : C.dim,
                  border: `1px solid ${on ? C.accent : C.hair}`,
                  fontSize: FS.micro, fontWeight: 700,
                }}>{on ? '묻기' : '안 묻기'}</button>
              </div>
            );
          })}

          {/* **이 줄이 이 탭의 핵심이다.**
              진짜 돈이 나가는 것을 설정 하나로 끌 수 있으면, 그건 설정이
              아니라 안전장치 제거다. */}
          <div style={{
            marginTop: 10, padding: '9px 10px', borderRadius: 8,
            background: C.downBg, color: C.down, fontSize: FS.micro, lineHeight: 1.6,
          }}>
            <b>실전 주문은 이 설정과 무관하게 항상 묻습니다.</b><br/>
            여기서 끌 수 있는 것은 모의·테스트넷뿐입니다.
          </div>
        </>
      )}
    </div>
  );
});

function arrowBtn(off: boolean): React.CSSProperties {
  return {
    width: 28, minHeight: 26, borderRadius: 6,
    cursor: off ? 'default' : 'pointer',
    background: 'transparent', border: `1px solid ${C.hair}`,
    color: off ? C.faint : C.dim, fontSize: FS.micro, opacity: off ? .4 : 1,
  };
}

'use client';
// src/components/pages/WalletPage.tsx
//
// **바이낸스의 Assets처럼 지갑을 따로 본다.**
//
// 홈에 계좌 정보를 다 몰아넣으면 홈이 관리자 화면이 된다. 그래서 지갑을
// 독립된 화면으로 뺀다 — 홈은 그대로 두고, 하단에서 바로 들어온다.
//
// 이 화면의 규칙 셋
// ─────────────────
//   1. **환경을 절대 섞지 않는다.** 실전·테스트넷·모의는 더할 수 없다
//   2. **입금은 수익이 아니다.** 자산이 는 것과 번 것은 다르다
//   3. **못 읽은 것을 0으로 그리지 않는다.** 0은 '없다'이고 실패는 '모른다'다
//
// 판정은 전부 `lib/portfolio/wallet`에 있다. 화면 안에서 합산 규칙을
// 정하면 "왜 이 숫자가 나왔지"를 테스트할 수 없다.
import React, { useState } from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import { Card } from './SharedUI';
import {
  WALLET_TABS, tabOf, ENV_LABEL, ENV_NOTE,
  amountOf, totalEquityOf, totalAcrossEnvs, bucketsForTab,
  equityChangeOf, todayPnlLabel,
  type WalletEnv, type WalletTabId, type Bucket,
} from '@/lib/portfolio/wallet';

const ENVS: WalletEnv[] = ['LIVE', 'TESTNET', 'MOCK'];

export default function WalletPage() {
  const [env, setEnv] = useState<WalletEnv>('LIVE');
  const [tab, setTab] = useState<WalletTabId>('overview');

  // ── 아직 아무것도 안 읽는다 ──
  //
  // 거래소 조회를 붙이기 전이다. **그렇다고 0을 그리지 않는다** — 0은
  // '없다'이고 지금은 '모른다'다. 잔고 0을 본 사용자는 자기 돈이
  // 사라졌다고 믿는다.
  //
  // 이 화면이 지금 정직하게 할 수 있는 일은 "아직 안 붙였다"고 말하는
  // 것뿐이고, 그게 그럴듯한 숫자를 그리는 것보다 낫다.
  const buckets: Bucket[] = ENVS.flatMap(e => ([
    { id: `${e}-futures`, label: '선물', env: e, kind: 'futures' as const, amount: amountOf(null, 'LOADING') },
    { id: `${e}-spot`, label: '현물', env: e, kind: 'spot' as const, amount: amountOf(null, 'LOADING') },
    { id: `${e}-strategy`, label: '전략계좌', env: e, kind: 'strategy' as const, amount: amountOf(null, 'LOADING') },
    { id: `${e}-longterm`, label: '장기투자', env: e, kind: 'longterm' as const, amount: amountOf(null, 'LOADING') },
  ]));

  const total = totalEquityOf(env, buckets);
  const change = equityChangeOf(null, {});
  const pnl = todayPnlLabel(change);
  const cross = totalAcrossEnvs();
  // 이 탭에서 보여 줄 칸. **총자산은 탭과 무관하게 전부 더한다** —
  // 선물 탭에 있다고 총자산이 선물만 세면, 탭을 옮길 때마다 총자산이
  // 달라져서 어느 것이 진짜인지 알 수 없다.
  const shown = bucketsForTab(tab, total.buckets);

  const envColor = (e: WalletEnv) => e === 'LIVE' ? T.red : e === 'TESTNET' ? T.ylw : T.muted;

  return (
    <div>
      {/* ── 환경 전환 ──
          여기가 이 화면에서 가장 중요한 줄이다. 실전 화면에 모의 총자산이
          섞여 있던 것이 이 화면을 만든 이유다. */}
      <div style={{ display: 'flex', gap: 5, marginBottom: 10 }}>
        {ENVS.map(e => {
          const on = env === e;
          const c = envColor(e);
          return (
            <button key={e} onClick={() => setEnv(e)} style={{
              flex: 1, minHeight: 38, borderRadius: 10, cursor: 'pointer',
              background: on ? A(c, '18') : 'transparent',
              color: on ? c : T.muted,
              border: `1px solid ${on ? A(c, '45') : T.border}`,
              fontSize: 11.5, fontWeight: 800,
            }}>{ENV_LABEL[e]}</button>
          );
        })}
      </div>

      <div style={{ color: envColor(env), fontSize: 9.5, marginBottom: 12, lineHeight: 1.55 }}>
        {ENV_NOTE[env]}
      </div>

      {/* ── 총자산 ── */}
      <Card style={{ padding: '16px', marginBottom: 10 }}>
        <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>
          총 평가자산 · {ENV_LABEL[env]}
        </div>
        <div style={{
          color: total.total == null ? T.muted : T.txt,
          fontSize: total.total == null ? 16 : 26, fontWeight: 900,
          fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums',
        }}>
          {total.total == null ? '확인 불가' : total.total.toLocaleString('ko-KR')}
        </div>
        {total.note && (
          <div style={{ color: T.ylw, fontSize: 9.5, marginTop: 6, lineHeight: 1.55 }}>
            {total.note}
          </div>
        )}

        <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 10, paddingTop: 10 }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>오늘 손익</div>
          <div style={{
            color: pnl.headline === '확인 불가' ? T.muted : T.txt,
            fontSize: 15, fontWeight: 800, fontFamily: 'Inter,monospace',
          }}>{pnl.headline}</div>
          {pnl.caution && (
            <div style={{ color: T.ylw, fontSize: 9.5, marginTop: 4, lineHeight: 1.55 }}>
              {pnl.caution}
            </div>
          )}
        </div>
      </Card>

      {/* **환경을 합칠 수 없다는 사실을 화면에 남긴다.**
          이 줄이 없으면 "왜 전체 합계가 없지"를 사용자가 혼자 추측한다. */}
      <div style={{
        background: T.alt, borderRadius: 10, padding: '8px 10px', marginBottom: 10,
        color: T.muted, fontSize: 9.5, lineHeight: 1.6,
      }}>
        {cross.reason}
      </div>

      {/* ── 탭 ── */}
      <div style={{ display: 'flex', gap: 5, marginBottom: 10, overflowX: 'auto' }}>
        {WALLET_TABS.map(t => {
          const on = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(tabOf(t.id))} style={{
              flexShrink: 0, minHeight: 34, padding: '6px 11px', borderRadius: 9,
              cursor: 'pointer',
              background: on ? T.acg : 'transparent',
              color: on ? T.acl : T.muted,
              border: `1px solid ${on ? T.acl : T.border}`,
              fontSize: 11, fontWeight: 700,
            }}>{t.label}</button>
          );
        })}
      </div>

      <div style={{ color: T.muted, fontSize: 9.5, marginBottom: 10, lineHeight: 1.55 }}>
        {WALLET_TABS.find(t => t.id === tab)?.desc}
      </div>

      {/* ── 칸별 잔고 ──
          **탭을 누르면 목록이 바뀌어야 한다.** 처음 붙일 때 설명 줄만
          바꾸고 목록은 그대로였는데, 눌러도 아무것도 안 변하는 탭은
          사용자에게 화면이 고장 난 것으로 보인다. */}
      <Card style={{ padding: '12px 14px', marginBottom: 10 }}>
        {shown.length === 0 && (
          <div style={{ color: T.muted, fontSize: 10.5, padding: '6px 0', lineHeight: 1.6 }}>
            이 환경에 <b style={{ color: T.txt }}>{WALLET_TABS.find(t => t.id === tab)?.label}</b> 계좌가 없습니다 —
            잔고가 0이라는 뜻이 아니라 <b style={{ color: T.ylw }}>연결된 계좌가 없다</b>는 뜻입니다.
          </div>
        )}
        {shown.map(b => (
          <div key={b.id} style={{
            display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 0',
            borderBottom: `1px solid ${T.border}`,
          }}>
            <span style={{ color: T.sub, fontSize: 11, flex: 1 }}>{b.label}</span>
            <span style={{
              color: b.amount.value == null ? T.muted : T.txt,
              fontSize: 11.5, fontWeight: 800,
              fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums',
            }}>{b.amount.text}</span>
          </div>
        ))}
        <div style={{ color: T.muted, fontSize: 9.5, marginTop: 8, lineHeight: 1.6 }}>
          거래소 조회를 아직 붙이지 않았습니다. <b style={{ color: T.ylw }}>0으로 그리지 않는 이유</b>는
          0이 &lsquo;없다&rsquo;이고 지금은 &lsquo;모른다&rsquo;이기 때문입니다 —
          잔고 0을 본 사용자는 자기 돈이 사라졌다고 믿습니다.
        </div>
      </Card>

      {/* ── 빠른 액션 ──
          **없는 기능을 있는 것처럼 두지 않는다.** 출금은 구현되지 않았고,
          누르면 아무 일도 안 일어나는 버튼은 있는 것보다 나쁘다. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
        {['입금', '출금', '이체', '거래'].map(label => (
          <button key={label} disabled style={{
            minHeight: 40, borderRadius: 10, cursor: 'default',
            background: 'transparent', color: T.muted,
            border: `1px solid ${T.border}`, fontSize: 10.5, fontWeight: 700, opacity: 0.5,
          }}>{label}</button>
        ))}
      </div>
      <div style={{ color: T.muted, fontSize: 9, marginTop: 6, lineHeight: 1.55 }}>
        입금·출금·이체는 아직 구현되지 않았습니다 — 눌러도 아무 일이 없는 버튼을
        만드는 것보다 잠가 두는 쪽이 낫습니다.
      </div>
    </div>
  );
}

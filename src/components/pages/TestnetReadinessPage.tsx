'use client';
// src/components/pages/TestnetReadinessPage.tsx
//
// **테스트넷을 켜 놓고 자도 되는가.**
//
// 첫날의 목표는 수익률이 아니다. 주문 생명주기 무결성이다:
//
//   signal → risk → intent → submit → accepted → fill
//   → position → protection → close → reconcile → ledger
//
// 이 사슬이 한 번이라도 끊기면 끊긴 자리에 포지션이나 돈이 남고,
// 자는 동안에는 그걸 알 수 없다.
//
// 그래서 이 화면은 **시작 버튼에 관문을 붙인다.** 하나라도 막혀 있거나
// 확인되지 않으면 시작할 수 없다.
//
// 이 화면이 초록으로 거짓말하지 않게
// ──────────────────────────────────
// 판정은 전부 `engine/testnetReadiness`가 하고, 그 판정은 **`true`가
// 아니면 통과로 치지 않는다.** 아직 안 만든 것을 `undefined`로 넘기면
// UNKNOWN이 되고, UNKNOWN은 통과가 아니다.
//
// 여기서 값을 낙관적으로 채워 넣으면 이 관문은 그 순간 무력해진다.
import React, { useState, useEffect, useCallback } from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import { Card } from './SharedUI';
import {
  readinessVerdict, testnetPnlOf, DAY_ONE_STRATEGIES, DAY_ONE_NOTE,
  type ReadinessInput, type ReadyStatus,
} from '@/lib/engine/testnetReadiness';

const TONE: Record<ReadyStatus, string> = {
  PASS: T.grn, BLOCK: T.red, UNKNOWN: T.ylw, NOT_APPLICABLE: T.muted,
};
const MARK: Record<ReadyStatus, string> = {
  PASS: '✓', BLOCK: '✕', UNKNOWN: '?', NOT_APPLICABLE: '—',
};
const LABEL: Record<ReadyStatus, string> = {
  PASS: '통과', BLOCK: '막힘', UNKNOWN: '확인 불가', NOT_APPLICABLE: '해당 없음',
};

export default function TestnetReadinessPage() {
  const [input, setInput] = useState<ReadinessInput>({ nowMs: Date.now() });
  const [loading, setLoading] = useState(true);

  const probe = useCallback(async () => {
    setLoading(true);
    const next: ReadinessInput = { nowMs: Date.now() };

    // ── 연결 ──
    //
    // 주문·자동매매가 쓰는 것과 **같은 registry**를 읽는다. 여기서
    // 따로 목록을 만들면 이 화면만 초록이고 실제 주문은 다른 계좌로 간다.
    try {
      const [{ loadExchangeConnectionsResult }, wa] = await Promise.all([
        import('@/lib/supabase/hooks'),
        import('@/lib/portfolio/walletAccounts'),
      ]);
      const r = await loadExchangeConnectionsResult();
      if (r.ok) {
        const testnet = wa.accountsFromConnections(r.connections)
          .filter(a => a.env === 'TESTNET' && a.queryable);
        if (testnet.length > 0) {
          next.connectionId = testnet[0].connectionId;
          next.isTestnet = true;
        }
      }
    } catch { /* 못 읽으면 UNKNOWN으로 남는다 */ }

    // ── 나머지는 아직 확인할 수단이 없다 ──
    //
    // **여기서 true를 채워 넣지 않는다.** 그러면 이 화면이 초록으로
    // 거짓말하고, 그게 이 관문을 만든 이유를 정면으로 배신한다.
    //
    // 각 항목은 실제로 확인하는 코드가 붙을 때 채운다:
    //   marketDataFresh       시세 훅의 상태를 읽어서
    //   balanceRead           /api/wallets 응답에서
    //   unresolvedOrders      대조 evidence 표에서
    //   positionModeKnown     거래소 조회에서
    //   intendedLeverage      예약/전략 설정에서
    //   venueLeverage         설정 후 재조회에서
    //   venueMaxLeverage      거래소 risk tier 조회에서
    //   riskPolicyFromServer  서버 RiskPolicy가 생기면
    //   workerIndependent     Worker가 생기면
    //   idempotencyWired      주문 경로에 열쇠 계층이 붙으면
    //   protectiveStopConfirmed  손절 재조회가 붙으면
    //   unifiedLedger         장부가 하나로 합쳐지면

    setInput(next);
    setLoading(false);
  }, []);

  useEffect(() => { probe(); }, [probe]);

  const v = readinessVerdict(input);
  // 충전을 못 읽었으므로 손익도 내지 않는다.
  const pnl = testnetPnlOf(null, null, null);

  return (
    <div>
      {/* ── 판정 ── */}
      <Card style={{
        padding: '16px', marginBottom: 12,
        borderLeft: `3px solid ${v.ready ? T.grn : T.red}`,
      }}>
        <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>
          테스트넷 자동매매 준비 상태
        </div>
        <div style={{
          color: v.ready ? T.grn : T.red, fontSize: 17, fontWeight: 900, lineHeight: 1.4,
        }}>
          {loading ? '확인 중…' : v.ready ? 'READY' : 'BLOCKED'}
        </div>
        <div style={{ color: T.sub, fontSize: 11.5, marginTop: 5, lineHeight: 1.6 }}>
          {v.headline}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <span style={{ color: T.grn, fontSize: 10.5, fontWeight: 800 }}>통과 {v.passed.length}</span>
          <span style={{ color: T.red, fontSize: 10.5, fontWeight: 800 }}>막힘 {v.blocked.length}</span>
          <span style={{ color: T.ylw, fontSize: 10.5, fontWeight: 800 }}>확인 불가 {v.unknown.length}</span>
        </div>

        {/* **하나라도 막혀 있으면 시작 버튼이 안 눌린다.**
            이 관문의 전부가 이 한 줄이다. */}
        <button disabled={!v.ready} style={{
          width: '100%', minHeight: 44, marginTop: 12, borderRadius: 11,
          background: v.ready ? T.grn : 'transparent',
          color: v.ready ? '#fff' : T.muted,
          border: `1px solid ${v.ready ? T.grn : T.border}`,
          fontSize: 13, fontWeight: 900,
          cursor: v.ready ? 'pointer' : 'not-allowed',
          opacity: v.ready ? 1 : 0.5,
        }}>
          {v.ready ? '테스트넷 자동매매 시작' : '시작할 수 없습니다'}
        </button>

        <button onClick={probe} style={{
          width: '100%', minHeight: 34, marginTop: 6, borderRadius: 9,
          background: 'transparent', color: T.acl,
          border: `1px solid ${T.acl}`, fontSize: 11, fontWeight: 700, cursor: 'pointer',
        }}>다시 확인</button>
      </Card>

      {/* ── 항목별 ── */}
      <Card style={{ padding: '12px 14px', marginBottom: 12 }}>
        {v.checks.map(c => (
          <div key={c.id} style={{
            padding: '9px 0', borderBottom: `1px solid ${T.border}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
              <span style={{
                color: TONE[c.status], fontSize: 12, fontWeight: 900,
                minWidth: 14, textAlign: 'center',
              }}>{MARK[c.status]}</span>
              <span style={{ color: T.txt, fontSize: 12, fontWeight: 700, flex: 1, minWidth: 0 }}>
                {c.label}
              </span>
              <span style={{ color: TONE[c.status], fontSize: 10, fontWeight: 800 }}>
                {LABEL[c.status]}
              </span>
            </div>
            <div style={{ color: T.muted, fontSize: 10, marginTop: 3, marginLeft: 21, lineHeight: 1.55 }}>
              {c.detail}
            </div>
            {/* **무엇이 있어야 통과하는지 적는다.** 이게 없으면
                "막혔다"만 알고 무엇을 해야 하는지는 모른다. */}
            {c.needed && (
              <div style={{ color: TONE[c.status], fontSize: 9.5, marginTop: 3, marginLeft: 21, lineHeight: 1.6 }}>
                → {c.needed}
              </div>
            )}
          </div>
        ))}
      </Card>

      {/* ── 첫날 전략 ── */}
      <Card style={{ padding: '12px 14px', marginBottom: 12 }}>
        <div style={{ color: T.txt, fontSize: 12, fontWeight: 800, marginBottom: 6 }}>
          첫날에 켤 전략 {DAY_ONE_STRATEGIES.length}개
        </div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 7 }}>
          {DAY_ONE_STRATEGIES.map(s => (
            <span key={s} style={{
              padding: '3px 8px', borderRadius: 6, background: T.alt,
              color: T.sub, fontSize: 9.5, fontWeight: 700,
            }}>{s}</span>
          ))}
        </div>
        <div style={{ color: T.muted, fontSize: 9.5, lineHeight: 1.65 }}>{DAY_ONE_NOTE}</div>
      </Card>

      {/* ── 충전은 수익이 아니다 ── */}
      <Card style={{ padding: '12px 14px' }}>
        <div style={{ color: T.txt, fontSize: 12, fontWeight: 800, marginBottom: 6 }}>
          전략 순손익
        </div>
        <div style={{ color: T.muted, fontSize: 16, fontWeight: 900, fontFamily: 'Inter,monospace' }}>
          {pnl.strategyPnl == null ? '확인 불가' : pnl.strategyPnl.toLocaleString('ko-KR')}
        </div>
        <div style={{ color: T.muted, fontSize: 9.5, marginTop: 5, lineHeight: 1.65 }}>
          {pnl.note}
        </div>
        <div style={{ color: T.ylw, fontSize: 9.5, marginTop: 6, lineHeight: 1.65 }}>
          <b>테스트넷 충전은 수익이 아닙니다.</b> 세 번 파산하고 세 번 충전하면
          마지막 잔고가 처음보다 많을 수 있는데, 그걸 수익으로 읽으면 100배 전략이
          살아남은 것처럼 보입니다 — 실제로는 세 번 터진 것입니다.
        </div>
      </Card>
    </div>
  );
}

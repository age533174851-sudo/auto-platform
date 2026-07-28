'use client';
import { A } from '@/lib/theme/colors';
// src/components/terminal/WalletTree.tsx
//
// 통합 자산 트리.
//
//   통합 자산
//   ├─ 현물 지갑        ← 코인별 보유·비중
//   └─ 선물 지갑        ← 가용 증거금·포지션 증거금·미실현손익
//
// 화면에서 지켜야 하는 것
// ───────────────────────
// 두 지갑을 **시각적으로도** 갈라 놓는다. 총자산 한 줄만 크게 띄우고
// 그 아래에 목록을 이어 붙이면, 사용자는 총자산으로 선물 주문을 낼 수
// 있다고 읽는다. 실제로는 이체를 해야 한다.
//
// 그래서 '선물에서 지금 쓸 수 있는 증거금'을 총자산과 **같은 크기로**
// 나란히 둔다. 둘이 다르다는 사실이 한눈에 보여야 한다.
import React, { memo, useCallback, useEffect, useState } from 'react';
import { C, FS, NUM, fmtPrice, pnlColor } from './theme';
import { useTerminal } from './TerminalContext';
import type { WalletTree as Tree } from '@/lib/markets/wallets';

export const WalletTreePanel = memo(function WalletTreePanel({ dense }: { dense?: boolean }) {
  const { auth, connId } = useTerminal();
  const [tree, setTree] = useState<Tree | null>(null);
  const [alloc, setAlloc] = useState<{ asset: string; valueUsd: number; pct: number }[]>([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!auth || !connId) { setErr('로그인·거래소 연결이 필요합니다'); return; }
    try {
      const r = await fetch(`/api/wallets?connectionId=${connId}`, { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setErr(j?.message || j?.error || `조회 실패 (${r.status})`); return; }
      setErr(''); setTree(j.tree); setAlloc(j.allocation || []);
    } catch (e: any) {
      setErr(`자산 조회 실패 — 잔고 0이 아니라 확인 불가입니다 (${e?.message || e})`);
    }
  }, [auth, connId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  if (err) {
    return (
      <div style={{ padding: 14 }}>
        <div style={{
          padding: '10px 12px', borderRadius: 8, background: C.warnBg,
          color: C.warn, fontSize: FS.small, lineHeight: 1.55,
        }}>{err}</div>
      </div>
    );
  }
  if (!tree) {
    return <div style={{ padding: 24, textAlign: 'center', color: C.faint, fontSize: FS.small }}>
      자산을 받아오는 중
    </div>;
  }

  const pad = dense ? 10 : 14;

  return (
    <div style={{ padding: pad, maxWidth: 620 }}>
      {/* ── 총자산 vs 선물 가용 증거금 ── */}
      {/* 둘을 같은 크기로 나란히 둔다. 총자산만 크게 띄우면
          그 금액으로 주문할 수 있다고 읽힌다. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <BigStat
          label="통합 자산"
          value={tree.totalUsd == null ? null : `$${fmtPrice(tree.totalUsd)}`}
          hint={tree.totalUsd == null ? '한쪽 지갑을 몰라 합계를 낼 수 없습니다' : undefined}
        />
        <BigStat
          label="선물에서 지금 쓸 수 있는 증거금"
          value={tree.futuresUsableMargin == null ? null : `$${fmtPrice(tree.futuresUsableMargin)}`}
          hint={tree.futuresUsableMargin == null
            ? '선물 지갑을 확인하지 못했습니다'
            : '현물 잔고는 포함되지 않습니다'}
          accent
        />
      </div>

      {/* ── 현물 지갑 ── */}
      <Branch
        title="현물 지갑"
        ok={tree.spot.ok}
        error={tree.spot.error}
        right={tree.spotValueUsd == null ? '확인 불가' : `$${fmtPrice(tree.spotValueUsd)}`}
      >
        {tree.spot.ok && tree.spot.assets.length === 0 && (
          <Leaf k="보유 자산 없음" v=""/>
        )}
        {tree.spot.assets.map(a => {
          const pct = alloc.find(x => x.asset === a.asset)?.pct;
          return (
            <Leaf key={a.asset}
              k={a.asset}
              sub={a.locked > 0 ? `미체결 ${fmtPrice(a.locked, 6)}` : undefined}
              v={a.valueUsd == null ? '가치 미상' : `$${fmtPrice(a.valueUsd)}`}
              v2={`${fmtPrice(a.free + a.locked, 6)}`}
              pct={pct}
              warn={a.valueUsd == null}
            />
          );
        })}
        {tree.spotUnpriced.length > 0 && (
          // 조용히 빼면 총자산이 왜 적은지 알 수 없다
          <div style={{ padding: '6px 12px', color: C.warn, fontSize: FS.micro, lineHeight: 1.5 }}>
            가격을 구하지 못해 합계에서 제외됨: {tree.spotUnpriced.join(', ')}
          </div>
        )}
      </Branch>

      {/* ── 선물 지갑 ── */}
      <Branch
        title="선물 지갑"
        ok={tree.futures.ok}
        error={tree.futures.error}
        right={tree.futuresEquity == null ? '확인 불가' : `$${fmtPrice(tree.futuresEquity)}`}
      >
        <Leaf k="사용 가능 증거금" v={`$${fmtPrice(tree.futures.availableMargin)}`}/>
        <Leaf k="포지션 증거금" v={`$${fmtPrice(tree.futures.positionMargin)}`}/>
        <Leaf k="미실현손익"
          v={`${tree.futures.unrealizedPnl >= 0 ? '+' : ''}$${fmtPrice(tree.futures.unrealizedPnl)}`}
          color={pnlColor(tree.futures.unrealizedPnl)}/>
      </Branch>

      {/* 이 문장이 이 화면의 결론이다 */}
      <div style={{
        marginTop: 12, padding: '10px 12px', borderRadius: 8,
        background: C.raised, color: C.dim, fontSize: FS.micro, lineHeight: 1.6,
      }}>
        현물 잔고는 선물 증거금이 아닙니다. 선물에서 쓰려면 거래소에서 이체해야 합니다.
        {tree.needsTransferUsd > 0 && (
          <span style={{ color: C.text }}>
            {' '}현재 현물 지갑에 <b style={NUM}>{fmtPrice(tree.needsTransferUsd)} USDT</b>가 있습니다.
          </span>
        )}
      </div>
    </div>
  );
});

function BigStat({ label, value, hint, accent }: {
  label: string; value: string | null; hint?: string; accent?: boolean;
}) {
  return (
    <div style={{
      flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: 10,
      background: C.raised,
      border: `1px solid ${accent ? A(C.accent,'44') : C.hair}`,
    }}>
      <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 3 }}>{label}</div>
      <div style={{
        ...NUM, fontSize: 18, fontWeight: 700,
        color: value == null ? C.warn : accent ? C.accent : C.text,
      }}>{value ?? '확인 불가'}</div>
      {hint && (
        <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 3, lineHeight: 1.4 }}>{hint}</div>
      )}
    </div>
  );
}

function Branch({ title, ok, error, right, children }: {
  title: string; ok: boolean; error?: string; right: string; children: React.ReactNode;
}) {
  return (
    <div style={{
      border: `1px solid ${C.hair}`, borderRadius: 10,
      marginBottom: 8, overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '9px 12px', background: C.raised,
        borderBottom: ok ? `1px solid ${C.hair}` : 'none',
      }}>
        <span style={{ color: C.text, fontSize: FS.body, fontWeight: 700 }}>{title}</span>
        <span style={{ ...NUM, color: ok ? C.text : C.warn, fontSize: FS.body, fontWeight: 600 }}>
          {right}
        </span>
      </div>
      {ok ? children : (
        <div style={{ padding: '10px 12px', color: C.warn, fontSize: FS.micro, lineHeight: 1.5 }}>
          {error || '조회하지 못했습니다'} — 잔고 0이 아니라 확인 불가입니다.
        </div>
      )}
    </div>
  );
}

function Leaf({ k, sub, v, v2, pct, color, warn }: {
  k: string; sub?: string; v: string; v2?: string;
  pct?: number; color?: string; warn?: boolean;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '7px 12px', borderBottom: `1px solid ${C.hair}`,
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ color: C.text, fontSize: FS.small, fontWeight: 600 }}>{k}</div>
        {sub && <div style={{ color: C.faint, fontSize: FS.micro }}>{sub}</div>}
      </div>

      {pct != null && (
        <div style={{ width: 54, flexShrink: 0 }}>
          <div style={{ height: 3, borderRadius: 2, background: C.hair, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: C.accent }}/>
          </div>
          <div style={{ ...NUM, color: C.faint, fontSize: FS.micro, textAlign: 'right', marginTop: 2 }}>
            {pct.toFixed(1)}%
          </div>
        </div>
      )}

      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ ...NUM, color: color ?? (warn ? C.warn : C.text), fontSize: FS.small, fontWeight: 600 }}>
          {v}
        </div>
        {v2 && <div style={{ ...NUM, color: C.faint, fontSize: FS.micro }}>{v2}</div>}
      </div>
    </div>
  );
}

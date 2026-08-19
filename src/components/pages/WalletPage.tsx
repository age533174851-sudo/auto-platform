'use client';
// src/components/pages/WalletPage.tsx
//
// **바이낸스의 Assets처럼 지갑을 따로 본다.**
//
// 홈에 계좌 정보를 다 몰아넣으면 홈이 관리자 화면이 된다. 그래서 지갑을
// 독립된 화면으로 뺀다 — 홈은 그대로 두고, 하단에서 바로 들어온다.
//
// 이 화면의 규칙 넷
// ─────────────────
//   1. **환경을 절대 섞지 않는다.** 실전·테스트넷·모의는 더할 수 없다
//   2. **입금은 수익이 아니다.** 자산이 는 것과 번 것은 다르다
//   3. **못 읽은 것을 0으로 그리지 않는다.** 0은 '없다'이고 실패는 '모른다'다
//   4. **없는 과거를 그리지 않는다.** 지금 잔고로 곡선을 역산하면
//      입출금이 빠져서, 넣은 날이 번 날로 그려진다
//
// 판정은 전부 `lib/portfolio/*`에 있다. 화면 안에서 합산·비율 규칙을
// 정하면 "왜 이 숫자가 나왔지"를 테스트할 수 없다.
//
// 화면 순서는 바이낸스 Assets를 따른다
// ────────────────────────────────────
//   총자산 → 오늘 손익 → 그래프 → 빠른 액션 → 자산 배분 → 보유자산
//
// 매일 보는 것이 위다. 진단에 가까운 것일수록 아래로 내린다.
import React, { useEffect, useState } from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import { Card } from './SharedUI';
// 지갑 숫자는 **USD 기준**이다. 라벨만 바꾸는 통화 전환을 막는다.
import { moneyView, currencyAvailable } from '@/lib/portfolio/walletMoney';
import {
  WALLET_TABS, tabOf, ENV_LABEL, ENV_NOTE,
  amountOf, totalEquityOf, totalAcrossEnvs, bucketsForTab,
  equityChangeOf, todayPnlLabel,
  type WalletEnv, type WalletTabId, type Bucket,
} from '@/lib/portfolio/wallet';
import {
  RANGES, rangeOf, curveOf, dailyRowsOf, type RangeId,
} from '@/lib/portfolio/equityCurve';
import {
  cellOf, futuresRowsOf, syncTextOf, spotRowsOf,
  strategyTotalOf, allocationOf, accountsForEnv, accountsNoteOf,
  type AccountOption, type SpotAsset, type StrategyAccount, type LongtermHolding,
} from '@/lib/portfolio/walletDetail';

const ENVS: WalletEnv[] = ['LIVE', 'TESTNET', 'MOCK'];
const CURRENCIES = ['USDT', 'USD', 'KRW'] as const;
type Currency = typeof CURRENCIES[number];

/** 아직 아무것도 못 읽었다는 뜻의 칸 */
const pending = () => cellOf(null, 'SYNCING');

export default function WalletPage() {
  const [env, setEnv] = useState<WalletEnv>('LIVE');
  const [tab, setTab] = useState<WalletTabId>('overview');
  const [range, setRange] = useState<RangeId>('30D');
  const [cur, setCur] = useState<Currency>('USDT');
  const [account, setAccount] = useState('');

  // ── 실제 잔고를 읽는다 ──
  //
  // 예전에는 여기서 모든 버킷을 `amountOf(null, 'LOADING')`으로 채우고
  // 계좌 목록도 빈 배열이었다. 주석에는 "아직 거래소를 안 붙였다"고
  // 정직하게 적혀 있었지만, **붙일 것은 이미 있었다** — `/api/wallets`가
  // Gate·Binance 현물·선물을 읽을 수 있다. 돈을 못 읽은 게 아니라
  // 화면이 안 물어본 것이다.
  //
  // 합치는 규칙(환경을 섞지 않는다 · 부분 합계를 총자산이라 하지 않는다)은
  // 서버가 갖는다. 화면에 두면 화면마다 따로 구현되고 언젠가 하나가 어긴다.
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const auth = typeof window !== 'undefined' ? (localStorage.getItem('sb_access_token') || '') : '';

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/wallets/overview', {
          headers: auth ? { Authorization: `Bearer ${auth}` } : undefined,
        });
        const j = await r.json();
        if (!alive) return;
        if (j?.ok) { setData(j); setErr(''); }
        // **못 읽은 것을 "계좌 없음"으로 그리지 않는다.**
        else setErr(String(j?.message || j?.error || '지갑을 읽지 못했습니다'));
      } catch (e: any) {
        if (alive) setErr(`지갑을 읽지 못했습니다 (${e?.message || e})`);
      }
    })();
    return () => { alive = false; };
  }, [auth]);

  // 서버가 준 버킷을 그대로 쓴다. 아직 안 읽었으면 '조회 중'이고,
  // 읽기에 실패했으면 '확인 불가'다 — 둘 다 0이 아니다.
  const buckets: Bucket[] = Array.isArray(data?.buckets) && data.buckets.length > 0
    ? data.buckets
    : ENVS.flatMap(e => ([
      { id: `${e}-futures`, label: '선물', env: e, kind: 'futures' as const, amount: amountOf(null, err ? 'FAILED' : 'LOADING') },
      { id: `${e}-spot`, label: '현물', env: e, kind: 'spot' as const, amount: amountOf(null, err ? 'FAILED' : 'LOADING') },
      { id: `${e}-strategy`, label: '전략계좌', env: e, kind: 'strategy' as const, amount: amountOf(null, 'NOT_APPLICABLE') },
      { id: `${e}-longterm`, label: '장기투자', env: e, kind: 'longterm' as const, amount: amountOf(null, 'NOT_APPLICABLE') },
    ]));

  // **총자산은 서버가 만든 canonical 값이다.**
  //
  // 버킷을 화면에서 다시 더하면 화면마다 다른 총자산이 생긴다. 서버가
  // 준 값이 있으면 그것을 쓰고, 없을 때만(로딩·실패) 버킷 합계를 쓴다.
  const envTotal: any = (Array.isArray(data?.envs) ? data.envs : []).find((e: any) => e?.env === env)?.total ?? null;
  const total = totalEquityOf(env, buckets);
  const change = equityChangeOf(null, {});
  const pnl = todayPnlLabel(change);
  const cross = totalAcrossEnvs();
  // 환율 공급원이 아직 없다. **null은 '1:1'이 아니라 '모른다'이다** —
  // 그래서 KRW 버튼이 잠긴다. 환율을 붙이면 여기에만 넣으면 된다.
  const fxRate = null;
  const shown = bucketsForTab(tab, total.buckets);
  // **총자산은 USD 기준 한 값이고, 통화 전환은 환율이 있을 때만 한다.**
  const totalUsd: number | null = envTotal?.value ?? total.total ?? null;
  const totalMoney = moneyView(totalUsd, cur as any, fxRate);
  const envNote: string = (Array.isArray(data?.envs) ? data.envs : [])
    .find((e: any) => e?.env === env)?.note ?? '';

  // ── 그래프 ──
  //
  // 찍어 둔 시점(account_equity_snapshots)이 아직 없다. 그래서 곡선도
  // 없다 — **그게 정직한 상태다.** 오늘 표를 만들어도 어제 값은 생기지 않는다.
  // 자산 곡선은 찍어 둔 시점(account_equity_snapshots)에서만 나온다.
  // **지금 잔고로 과거를 역산하지 않는다** — 오늘 표를 만들어도 어제
  // 값은 생기지 않는다. 서버가 지갑을 읽을 때마다 찍어 두므로
  // 두 번째 방문부터 곡선이 생긴다.
  const snapshots: any[] = [];
  // 이 환경의 성과. **없으면 만들지 않는다.**
  const perf: any = data?.performance?.[env] ?? null;
  const curve = curveOf(snapshots, range, Date.now(), env);
  const daily = dailyRowsOf(snapshots);

  // ── 자산 배분 ──
  const alloc = allocationOf([
    { label: '현물', cell: pending() },
    { label: '선물', cell: pending() },
    { label: '장기투자', cell: pending() },
    { label: '현금', cell: pending() },
  ]);

  // ── 계좌 ──
  // **서버가 준 계좌 목록.** 빈 배열을 직접 넣던 자리다.
  const allAccounts: AccountOption[] = Array.isArray(data?.accounts)
    ? data.accounts.map((a: any) => ({
      id: String(a.id),
      label: a.label || a.exchangeId || a.id,
      // **모르는 환경을 LIVE로 승격하지 않는다.**
      //
      // 서버는 `is_testnet`을 못 읽으면 `env: null`을 정직하게 보낸다.
      // 그걸 여기서 'LIVE'로 바꾸면, 정체를 모르는 연결이 **실계좌
      // 합계**에 들어간다 — 이 저장소가 계속 지켜 온 "모르면 LIVE라고
      // 하지 않는다"와 정면으로 충돌한다. null은 null로 둔다.
      env: a.env ?? null,
      exchange: a.exchangeId ?? '',
    })) as any
    : [];
  const accounts = accountsForEnv(env, allAccounts);
  const accountsNote = accountsNoteOf(accounts);
  // 환경을 못 읽은 연결. **어느 환경 합계에도 넣지 않고 따로 알린다** —
  // 안 보여주면 사용자는 그 계좌가 사라진 줄 안다.
  const unknownEnvAccounts = allAccounts.filter((a: any) => a?.env == null);

  // ── 탭별 자료 ──
  const futuresAccounts: Array<{ name: string; rows: ReturnType<typeof futuresRowsOf>; sync: string }> = [];
  const spot: SpotAsset[] = spotRowsOf([]);
  const strategies: StrategyAccount[] = [];
  const stratTotal = strategyTotalOf(strategies);
  const longterm: LongtermHolding[] = [];

  const envColor = (e: WalletEnv) => e === 'LIVE' ? T.red : e === 'TESTNET' ? T.ylw : T.muted;
  const muted: React.CSSProperties = { color: T.muted, fontSize: 9.5, lineHeight: 1.6 };
  const numFont: React.CSSProperties = { fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums' };

  /** 못 읽은 값은 회색 + 사유. 여기서 0을 그리면 안 된다 */
  const cellText = (c: { value: number | null; text: string }) =>
    c.value == null ? c.text : c.value.toLocaleString('ko-KR');

  const sectionTitle = (s: string) => (
    <div style={{ color: T.txt, fontSize: 12, fontWeight: 800, marginBottom: 8 }}>{s}</div>
  );

  /** 아직 안 붙인 목록 자리 — 왜 비었는지까지 적는다 */
  const emptyBox = (what: string, why: string) => (
    <div style={{ ...muted, padding: '10px 0' }}>
      <b style={{ color: T.txt }}>{what}</b>
      <div style={{ marginTop: 3 }}>{why}</div>
    </div>
  );

  return (
    <div>
      {/* ── 못 읽었으면 그렇게 말한다 ──
          0을 그리거나 "계좌 없음"으로 그리면 사용자는 돈이 사라졌거나
          연결이 풀린 줄 안다. 조회 실패는 그 둘과 다른 사실이다. */}
      {err && (
        <div style={{
          background: A(T.ylw, '12'), border: `1px solid ${A(T.ylw, '35')}`,
          borderRadius: 10, padding: '9px 11px', marginBottom: 8,
          color: T.ylw, fontSize: 11, lineHeight: 1.6, overflowWrap: 'anywhere',
        }}>
          {err} — <b>잔고가 0이라는 뜻이 아닙니다.</b>
        </div>
      )}

      {/* ── 이 환경에서 얼마나 벌었나 ──
          **잔고 증가는 수익이 아니다.** 입금해서 늘어난 것을 수익으로
          적으면 사용자는 자기 성과를 몇 배 좋게 읽는다. 그래서
          자산 증가 · 매매 손익 · 순입출금을 나눠서 적는다. */}
      {perf && (
        <div style={{
          background: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
          padding: 11, marginBottom: 8, minWidth: 0,
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, fontWeight: 800, color: T.txt }}>{env} 성과</span>
            {perf.elapsedText && perf.startedAt && (
              <span style={{ fontSize: 10, color: T.muted }}>운용 {perf.elapsedText}</span>
            )}
          </div>
          {perf.code === 'NO_SNAPSHOTS' || perf.code === 'ONE_SNAPSHOT' ? (
            <div style={{ ...muted, marginTop: 5, lineHeight: 1.6 }}>{perf.note}</div>
          ) : (
            <div style={{ marginTop: 6, display: 'grid', gap: 3 }}>
              {[
                ['시작 자산', perf.startEquity],
                ['현재 자산', perf.currentEquity],
                ['자산 증가', perf.equityChange],
                ['순입출금', perf.cashFlow?.net],
                ['매매 손익', perf.tradingPnl],
                ['최고 자산', perf.peakEquity],
                ['최대 낙폭(%)', perf.maxDrawdownPct],
              ].map(([label, v]: any) => (
                <div key={label} style={{ display: 'flex', gap: 8, fontSize: 10.5, lineHeight: 1.6 }}>
                  <span style={{ color: T.muted, minWidth: 78, flexShrink: 0 }}>{label}</span>
                  {/* **못 읽은 것을 0으로 그리지 않는다.** */}
                  <span style={{ color: v == null ? T.muted : T.txt, fontWeight: v == null ? 600 : 800 }}>
                    {v == null ? '확인하지 못했습니다' : Number(v).toLocaleString('ko-KR')}
                  </span>
                </div>
              ))}
              {perf.tradingReturnPct != null && (
                <div style={{ display: 'flex', gap: 8, fontSize: 10.5, lineHeight: 1.6 }}>
                  <span style={{ color: T.muted, minWidth: 78, flexShrink: 0 }}>매매 수익률</span>
                  <span style={{ color: perf.tradingReturnPct >= 0 ? T.grn : T.red, fontWeight: 800 }}>
                    {perf.tradingReturnPct >= 0 ? '+' : ''}{perf.tradingReturnPct}%
                  </span>
                </div>
              )}
              {perf.note && <div style={{ ...muted, marginTop: 3 }}>{perf.note}</div>}
            </div>
          )}
        </div>
      )}

      {/* ── 환경 전환 ──
          여기가 이 화면에서 가장 중요한 줄이다. 실전 화면에 모의 총자산이
          섞여 있던 것이 이 화면을 만든 이유다. */}
      <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
        {ENVS.map(e => {
          const on = env === e;
          const c = envColor(e);
          return (
            <button key={e} onClick={() => { setEnv(e); setAccount(''); }} style={{
              flex: 1, minHeight: 38, borderRadius: 10, cursor: 'pointer',
              background: on ? A(c, '18') : 'transparent',
              color: on ? c : T.muted,
              border: `1px solid ${on ? A(c, '45') : T.border}`,
              fontSize: 11.5, fontWeight: 800,
            }}>{ENV_LABEL[e]}</button>
          );
        })}
      </div>

      <div style={{ color: envColor(env), fontSize: 9.5, marginBottom: 10, lineHeight: 1.55 }}>
        {ENV_NOTE[env]}
      </div>

      {/* ── 계좌 선택 ──
          **다른 환경 계좌는 목록에 두지 않는다.** 보이면 고를 수 있다고
          읽히고, 고르는 순간 실전 화면에 테스트넷 잔고가 뜬다. */}
      <div style={{ display: 'flex', gap: 5, marginBottom: 10, overflowX: 'auto', alignItems: 'center' }}>
        <button onClick={() => setAccount('')} style={{
          flexShrink: 0, minHeight: 30, padding: '5px 10px', borderRadius: 8, cursor: 'pointer',
          background: account === '' ? T.acg : 'transparent',
          color: account === '' ? T.acl : T.muted,
          border: `1px solid ${account === '' ? T.acl : T.border}`, fontSize: 10, fontWeight: 700,
        }}>전체 계좌</button>
        {accounts.map(a => (
          <button key={a.key} onClick={() => setAccount(a.key)} style={{
            flexShrink: 0, minHeight: 30, padding: '5px 10px', borderRadius: 8, cursor: 'pointer',
            background: account === a.key ? T.acg : 'transparent',
            color: account === a.key ? T.acl : T.muted,
            border: `1px solid ${account === a.key ? T.acl : T.border}`, fontSize: 10, fontWeight: 700,
          }}>{a.label}</button>
        ))}
      </div>
      {accountsNote && <div style={{ ...muted, color: T.ylw, marginBottom: 10 }}>{accountsNote}</div>}

      {/* ── 1. 총자산 + 2. 오늘 손익 ── */}
      <Card style={{ padding: '16px', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ color: T.muted, fontSize: 10 }}>총 평가자산 · {ENV_LABEL[env]}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
            {/* **환율이 없으면 그 통화는 잠근다.**
                예전에는 숫자를 그대로 두고 라벨만 바꿨다 — 5,000 USDT가
                버튼 한 번에 ₩5,000으로 보일 수 있었다. */}
            {CURRENCIES.map(c => {
              const on = currencyAvailable(c as any, fxRate);
              return (
                <button key={c} onClick={() => on && setCur(c)} disabled={!on}
                  title={on ? '' : '환율을 읽지 못해 이 통화로 볼 수 없습니다'}
                  style={{
                    minHeight: 22, padding: '2px 7px', borderRadius: 6,
                    cursor: on ? 'pointer' : 'not-allowed', opacity: on ? 1 : 0.45,
                    background: cur === c ? T.acg : 'transparent',
                    color: cur === c ? T.acl : T.muted,
                    border: `1px solid ${cur === c ? T.acl : T.border}`, fontSize: 9, fontWeight: 700,
                  }}>{c}</button>
              );
            })}
          </div>
        </div>
        {/* **서버가 만든 canonical 총자산을 그대로 쓴다.**
            = 현물 전체 평가액 + 선물 순자산. 화면에서 다시 더하지 않는다 —
            그러면 홈과 지갑이 서로 다른 총자산을 보인다. */}
        <div style={{
          color: totalUsd == null ? T.muted : T.txt,
          fontSize: totalUsd == null ? 16 : 26, fontWeight: 900, ...numFont,
        }}>
          {totalUsd == null ? '확인 불가' : totalMoney.text}
        </div>
        {(total.note || envNote || totalUsd != null) && (
          <div style={{ ...muted, color: T.ylw, marginTop: 6, overflowWrap: 'anywhere' }}>
            {[envNote, total.note, totalUsd != null ? totalMoney.reason : ''].filter(Boolean).join(' · ')}
          </div>
        )}

        <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 10, paddingTop: 10 }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>오늘 손익</div>
          <div style={{
            color: pnl.headline === '확인 불가' ? T.muted : T.txt,
            fontSize: 15, fontWeight: 800, ...numFont,
          }}>{pnl.headline}</div>
          {pnl.caution && (
            <div style={{ ...muted, color: T.ylw, marginTop: 4 }}>{pnl.caution}</div>
          )}
        </div>
      </Card>

      {/* **환경을 합칠 수 없다는 사실을 화면에 남긴다.**
          이 줄이 없으면 "왜 전체 합계가 없지"를 사용자가 혼자 추측한다. */}
      <div style={{
        background: T.alt, borderRadius: 10, padding: '8px 10px', marginBottom: 10, ...muted,
      }}>{cross.reason}</div>

      {/* ── 3. 자산 그래프 ──
          **지금 잔고로 과거를 역산하지 않는다.** 입출금이 빠지면 100만원을
          넣은 날이 100만원 번 날로 그려지고, 그 그림은 틀렸는데 매끄럽다. */}
      <Card style={{ padding: '14px 16px', marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 10, overflowX: 'auto' }}>
          {RANGES.map(r => {
            const on = range === r.id;
            return (
              <button key={r.id} onClick={() => setRange(rangeOf(r.id))} style={{
                flexShrink: 0, minHeight: 28, padding: '4px 9px', borderRadius: 7, cursor: 'pointer',
                background: on ? T.acg : 'transparent',
                color: on ? T.acl : T.muted,
                border: `1px solid ${on ? T.acl : T.border}`, fontSize: 10, fontWeight: 700,
              }}>{r.label}</button>
            );
          })}
        </div>

        {curve.hasData ? (
          <svg viewBox="0 0 300 90" preserveAspectRatio="none" style={{ width: '100%', height: 90 }}>
            {/* 구간마다 따로 그린다 — 구멍을 이으면 그 동안 자산이
                매끄럽게 변한 것처럼 보인다. */}
            {curve.segments.map((seg, i) => {
              const lo = curve.min as number, hi = curve.max as number;
              const span = hi - lo || 1;
              const t0 = seg.points[0].atMs;
              const t1 = seg.points[seg.points.length - 1].atMs;
              const tspan = t1 - t0 || 1;
              const d = seg.points.map((p, j) => {
                const x = ((p.atMs - t0) / tspan) * 300;
                const y = 90 - ((p.equity - lo) / span) * 80 - 5;
                return `${j === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
              }).join(' ');
              return <path key={i} d={d} fill="none" stroke={T.acl} strokeWidth={2} />;
            })}
          </svg>
        ) : (
          <div style={{
            height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: T.alt, borderRadius: 8, padding: '10px 14px',
          }}>
            <div style={{ ...muted, textAlign: 'center' }}>{curve.note}</div>
          </div>
        )}
        {curve.hasData && curve.note && (
          <div style={{ ...muted, color: T.ylw, marginTop: 6 }}>{curve.note}</div>
        )}
      </Card>

      {/* ── 4. 빠른 액션 ──
          **없는 기능을 있는 것처럼 두지 않는다.** 누르면 아무 일도
          안 일어나는 버튼은 있는 것보다 나쁘다. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, marginBottom: 6 }}>
        {['입금', '출금', '이체', '거래'].map(label => (
          <button key={label} disabled style={{
            minHeight: 40, borderRadius: 10, cursor: 'default',
            background: 'transparent', color: T.muted,
            border: `1px solid ${T.border}`, fontSize: 10.5, fontWeight: 700, opacity: 0.5,
          }}>{label}</button>
        ))}
      </div>
      <div style={{ ...muted, marginBottom: 10 }}>
        입금·출금·이체는 아직 구현되지 않았습니다 — 눌러도 아무 일이 없는 버튼을
        만드는 것보다 잠가 두는 쪽이 낫습니다.
      </div>

      {/* ── 5. 자산 배분 ──
          **한 조각이라도 못 읽으면 비율을 안 낸다.** 분모가 작아져서
          나머지가 실제보다 커 보이고, 그 그림에는 틀렸다는 표시가 없다. */}
      <Card style={{ padding: '14px 16px', marginBottom: 10 }}>
        {sectionTitle('자산 배분')}
        {alloc.slices.map(s => (
          <div key={s.label} style={{ marginBottom: 7 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ color: T.sub, fontSize: 11, flex: 1 }}>{s.label}</span>
              <span style={{
                color: s.pct == null ? T.muted : T.txt, fontSize: 11, fontWeight: 800, ...numFont,
              }}>{s.pct == null ? '—' : `${s.pct.toFixed(1)}%`}</span>
            </div>
            <div style={{ height: 4, background: T.alt, borderRadius: 2, marginTop: 3, overflow: 'hidden' }}>
              {s.pct != null && (
                <div style={{ width: `${Math.min(100, s.pct)}%`, height: '100%', background: T.acl }} />
              )}
            </div>
          </div>
        ))}
        {alloc.note && <div style={{ ...muted, color: T.ylw, marginTop: 6 }}>{alloc.note}</div>}
      </Card>

      {/* ── 6. 보유자산 (탭) ── */}
      <div style={{ display: 'flex', gap: 5, marginBottom: 8, overflowX: 'auto' }}>
        {WALLET_TABS.map(t => {
          const on = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(tabOf(t.id))} style={{
              flexShrink: 0, minHeight: 34, padding: '6px 11px', borderRadius: 9, cursor: 'pointer',
              background: on ? T.acg : 'transparent',
              color: on ? T.acl : T.muted,
              border: `1px solid ${on ? T.acl : T.border}`, fontSize: 11, fontWeight: 700,
            }}>{t.label}</button>
          );
        })}
      </div>
      <div style={{ ...muted, marginBottom: 10 }}>
        {WALLET_TABS.find(t => t.id === tab)?.desc}
      </div>

      {/* 개요 — 칸별 잔고 */}
      {tab === 'overview' && (
        <Card style={{ padding: '12px 14px', marginBottom: 10 }}>
          {shown.map(b => (
            <div key={b.id} style={{
              display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 0',
              borderBottom: `1px solid ${T.border}`,
            }}>
              <span style={{ color: T.sub, fontSize: 11, flex: 1 }}>{b.label}</span>
              <span style={{
                color: b.amount.value == null ? T.muted : T.txt,
                fontSize: 11.5, fontWeight: 800, ...numFont,
              }}>{b.amount.text}</span>
            </div>
          ))}
          <div style={{ ...muted, marginTop: 8 }}>
            거래소 조회를 아직 붙이지 않았습니다. <b style={{ color: T.ylw }}>0으로 그리지 않는 이유</b>는
            0이 &lsquo;없다&rsquo;이고 지금은 &lsquo;모른다&rsquo;이기 때문입니다 —
            잔고 0을 본 사용자는 자기 돈이 사라졌다고 믿습니다.
          </div>
        </Card>
      )}

      {/* 선물 — 거래소별 한 장씩 */}
      {tab === 'futures' && (
        <Card style={{ padding: '14px 16px', marginBottom: 10 }}>
          {futuresAccounts.length === 0
            ? emptyBox('연결된 선물 계좌가 없습니다',
                '잔고가 0이라는 뜻이 아니라 이 환경에 연결된 계좌가 없다는 뜻입니다. '
                + '거래소를 연결하면 지갑잔고·주문가능·사용증거금·유지증거금·미실현/실현손익·'
                + '증거금비율을 거래소별로 나눠 보여 줍니다.')
            : futuresAccounts.map(a => (
              <div key={a.name} style={{ marginBottom: 12 }}>
                {sectionTitle(a.name)}
                {a.rows.map(r => (
                  <div key={r.label} style={{
                    display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 0',
                    borderBottom: `1px solid ${T.border}`,
                  }}>
                    <span style={{ color: T.sub, fontSize: 10.5, flex: 1 }}>{r.label}</span>
                    <span style={{
                      color: r.cell.value == null ? T.muted : T.txt,
                      fontSize: 11, fontWeight: 800, ...numFont,
                    }}>{cellText(r.cell)}</span>
                  </div>
                ))}
                <div style={{ ...muted, marginTop: 5 }}>{a.sync}</div>
              </div>
            ))}
        </Card>
      )}

      {/* 현물 — 코인별 */}
      {tab === 'spot' && (
        <Card style={{ padding: '14px 16px', marginBottom: 10 }}>
          {spot.length === 0
            ? emptyBox('보유 중인 현물이 없습니다',
                '조회를 아직 붙이지 않았습니다 — 잔고가 0이라는 뜻이 아닙니다. '
                + '붙이면 코인별 수량·주문가능·잠김·평가액·24시간 변동률을 보여 줍니다.')
            : spot.map(a => (
              <div key={a.symbol} style={{
                display: 'flex', alignItems: 'baseline', gap: 8, padding: '8px 0',
                borderBottom: `1px solid ${T.border}`,
              }}>
                <span style={{ color: T.txt, fontSize: 11.5, fontWeight: 800, minWidth: 52 }}>{a.symbol}</span>
                <span style={{ color: T.muted, fontSize: 10, flex: 1, ...numFont }}>
                  {cellText(a.quantity)}
                </span>
                <span style={{
                  color: a.valuation.value == null ? T.muted : T.txt,
                  fontSize: 11, fontWeight: 800, ...numFont,
                }}>{cellText(a.valuation)}</span>
              </div>
            ))}
        </Card>
      )}

      {/* 전략계좌 — TRAIGO가 바이낸스보다 더 보여 주는 부분 */}
      {tab === 'strategy' && (
        <Card style={{ padding: '14px 16px', marginBottom: 10 }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>총 전략 자산</div>
          <div style={{
            color: stratTotal.total == null ? T.muted : T.txt,
            fontSize: 18, fontWeight: 900, marginBottom: 8, ...numFont,
          }}>
            {stratTotal.total == null ? '확인 불가' : stratTotal.total.toLocaleString('ko-KR')}
          </div>
          {stratTotal.note && <div style={{ ...muted, color: T.ylw, marginBottom: 8 }}>{stratTotal.note}</div>}

          {strategies.length === 0
            ? emptyBox('전략계좌가 없습니다',
                '전략별 배정 자금·현재 자산·실현/미실현손익·수수료·펀딩·수익률·MDD·'
                + '보유 포지션을 여기서 나눠 봅니다. 배정 자금을 계산하는 곳이 아직 없어 '
                + '전략별 자금이 전부 "—"입니다 — 0으로 적으면 "돈을 안 맡겼다"로 읽히고, '
                + '그건 "아직 계산 안 됨"과 다릅니다.')
            : strategies.map(s => (
              <div key={s.strategyName} style={{
                background: T.alt, borderRadius: 8, padding: '9px 11px', marginBottom: 6,
              }}>
                <div style={{ color: T.txt, fontSize: 11.5, fontWeight: 800, marginBottom: 3 }}>
                  {s.strategyName}
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 9.5, color: T.muted }}>
                  <span>자산 <b style={{ color: T.txt }}>{cellText(s.currentEquity)}</b></span>
                  <span>수익률 <b style={{ color: T.txt }}>{cellText(s.returnPct)}</b></span>
                  <span>MDD <b style={{ color: T.txt }}>{cellText(s.mddPct)}</b></span>
                </div>
              </div>
            ))}
        </Card>
      )}

      {/* 장기투자 — 주식·ETF */}
      {tab === 'longterm' && (
        <Card style={{ padding: '14px 16px', marginBottom: 10 }}>
          {longterm.length === 0
            ? emptyBox('장기투자 보유 종목이 없습니다',
                '주식·ETF 계좌를 연결하면 종목별 수량·평단·평가액·미실현손익·배당·비중을 '
                + '여기서 봅니다. 코인과 같은 화면에 섞지 않는 이유는 세금·거래시간·'
                + '결제주기가 전부 다르기 때문입니다.')
            : longterm.map(h => (
              <div key={h.symbol} style={{
                display: 'flex', alignItems: 'baseline', gap: 8, padding: '8px 0',
                borderBottom: `1px solid ${T.border}`,
              }}>
                <span style={{ color: T.txt, fontSize: 11.5, fontWeight: 800, minWidth: 60 }}>{h.symbol}</span>
                <span style={{ color: T.muted, fontSize: 10, flex: 1, ...numFont }}>{cellText(h.quantity)}</span>
                <span style={{
                  color: h.marketValue.value == null ? T.muted : T.txt,
                  fontSize: 11, fontWeight: 800, ...numFont,
                }}>{cellText(h.marketValue)}</span>
              </div>
            ))}
        </Card>
      )}

      {/* ── 일별 손익 ──
          **자산 차이를 손익이라고 적지 않는다.** 어제보다 100만원 늘었어도
          그게 입금이면 번 것은 0원이다. */}
      <Card style={{ padding: '14px 16px', marginBottom: 10 }}>
        {sectionTitle('일별 손익')}
        {daily.length === 0
          ? emptyBox('아직 기록된 날이 없습니다',
              '날짜별 손익은 그때그때 찍어 둔 자산 시점에서 나옵니다. '
              + '지금 잔고로 과거를 되돌려 만들지 않습니다 — 입출금이 빠지면 '
              + '돈을 넣은 날이 번 날로 기록됩니다.')
          : daily.slice(0, 30).map(d => (
            <div key={d.day} style={{
              display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 0',
              borderBottom: `1px solid ${T.border}`,
            }}>
              <span style={{ color: T.sub, fontSize: 10.5, flex: 1 }}>{d.day}</span>
              <span style={{
                color: d.pnl == null ? T.muted : d.pnl >= 0 ? T.grn : T.red,
                fontSize: 11, fontWeight: 800, ...numFont,
              }}>
                {d.pnl == null ? '확인 불가' : `${d.pnl >= 0 ? '+' : ''}${d.pnl.toLocaleString('ko-KR')}`}
              </span>
              {d.hadFlow && <span style={{ color: T.ylw, fontSize: 9 }}>입출금</span>}
            </div>
          ))}
      </Card>
    </div>
  );
}

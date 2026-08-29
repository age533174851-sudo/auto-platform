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
import { walletTruthOf, envNoteOf, otherEnvNote } from '@/lib/portfolio/walletTruthView';
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
// **토큰을 한 번 복사해 두지 않는다.** 갱신·복귀·포커스를 따라간다.
import { watchAuthToken } from '@/lib/auth/authToken';
// **환율이 없으면 통화를 바꾸지 않는다.** 폴백 상수를 쓰지 않는다.
import { fxFreshness } from '@/lib/portfolio/fxRate';
// 자산 기록이 오래됐으면 화면이 그렇게 말한다.
import { snapshotFreshness } from '@/lib/portfolio/snapshotBucket';
// **모의투자 탭의 판정은 화면이 아니라 여기 있다.** 못 읽은 것을
// '시작 안 함'으로 적으면 시작 버튼이 뜨고, 누르면 장부가 초기화된다.
import { paperPanelOf, seedOptionsOf } from '@/lib/portfolio/paperPanel';
import { PAPER_SEED_CHOICES, validateSeed } from '@/lib/portfolio/paperAccount';
// **숫자·상태·환경 표현을 이 화면이 다시 정하지 않는다.**
//
// 이 파일 하나에 '확인 불가' 계열 문구가 15곳, 빨강·노랑 색 지정이
// 23곳 있었다. 전부 그 자리에서 따로 고른 것이라, 같은 사건이 화면
// 위치에 따라 다른 색과 다른 문장으로 나왔다.
import { moneyText, pnlText, pctText, shownValue, UNKNOWN_TEXT, UNKNOWN_LABEL } from '@/lib/ui/display';
import { accountStatusOf, unknownSummaryOf, splitDiagnostics, envView, type StatusKind } from '@/lib/ui/status';
import { StatusCard, Details, EnvBadge, SafeNote, toneColor } from '@/components/ui/Status';

const ENVS: WalletEnv[] = ['LIVE', 'TESTNET', 'MOCK'];
const CURRENCIES = ['USDT', 'USD', 'KRW'] as const;
type Currency = typeof CURRENCIES[number];

/**
 * **`Number(null)`은 0이다.**
 *
 * 그래서 `Number(x) || 0`으로 읽으면 못 읽은 값이 "0개"로 화면에 적힌다.
 * 0은 "없다"이고 못 읽은 것은 "모른다"다 — 지갑에서 그 둘을 섞으면
 * 사용자는 자산이 사라졌다고 읽는다.
 */
const numOrNull = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

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
  // **판정은 화면이 하지 않는다.** walletTruthOf가 '없음'과 '확인 못 함'을
  // 가르고, 화면은 그 결과를 그리기만 한다.
  //
  // 예전에는 여기서 `String(j?.message || j?.error)`를 그대로 err에 넣었다.
  // 그래서 화면에 `auth_required`라는 **서버 내부 코드**가 그대로 떴고,
  // 동시에 아래쪽에서는 "이 환경에 연결된 계좌가 없습니다"라고 단정했다.
  // 인증이 안 돼 아무것도 못 읽은 상태에서 그 둘은 서로 모순이다.
  const [truth, setTruth] = useState<any>(null);

  // ── 토큰은 canonical 세션에서 온다 ──
  //
  // 예전에는 `localStorage.getItem('sb_access_token')`을 **한 번** 읽어
  // 문자열로 들고 있었다. Supabase의 access token은 기본 1시간짜리라,
  // 라이브러리가 뒤에서 갱신해도 이미 복사해 둔 문자열은 안 바뀐다.
  // 그래서 한 시간 뒤부터 모든 요청이 401이고, 사용자에게는
  // **"가만히 있었는데 로그아웃됐다"** 로 보인다.
  //
  // `watchAuthToken`은 갱신·복귀·포커스를 전부 보고, **확인하지 못한
  // 것을 로그아웃으로 바꾸지 않는다**(지하철에서 끊긴 것과 로그아웃은
  // 다르다). 그래서 이 값은 **세 가지**다 — 'Bearer …' / '' / null.
  // null은 아직 확인 전이고, 그때 요청하면 401이 뜬다.
  const [auth, setAuth] = useState<string | null>(null);
  useEffect(() => watchAuthToken(setAuth), []);

  // 모의투자를 시작한 뒤 같은 화면을 다시 읽는다. **화면이 값을 지어내
  // 그리지 않는다** — 서버가 다시 말해 준 것만 그린다.
  const [reload, setReload] = useState(0);
  // 시작 요청이 도는 중인가 · 실패했으면 그 이유
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState('');
  const [seedInput, setSeedInput] = useState('');
  // 시작 흐름은 두 단계다: [모의투자 시작하기] → 초기자금 선택 → [계좌 만들기]
  const [seedOpen, setSeedOpen] = useState(false);
  // **진단은 접어 둔다.** DB 오류 원문은 사용자가 할 수 있는 일이 없다.
  const [detailOpen, setDetailOpen] = useState(false);

  // ── 환율 ──
  //
  // 서버가 값 검증(범위)까지 하고 준다. **못 읽으면 null이고, null은
  // '1:1'이 아니라 '모른다'이다** — 그때 KRW 버튼이 잠긴다.
  const [fx, setFx] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/fx/usd');
        const j = await r.json();
        if (alive) setFx(j?.fx ?? null);
      } catch { /* 못 읽었으면 null 그대로 — 숫자를 지어내지 않는다 */ }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    // 아직 토큰을 확인하기 전이다. **여기서 요청하면 401이 뜨고 화면이
    // "계좌 없음"을 그린다** — 로그인은 멀쩡한데.
    if (auth == null) return;
    let alive = true;
    (async () => {
      let status: number | null = null;
      let body: any = null;
      let networkError: string | null = null;
      try {
        const r = await fetch('/api/wallets/overview', {
          headers: auth ? { Authorization: auth } : undefined,
        });
        status = r.status;
        body = await r.json().catch(() => null);
      } catch (e: any) {
        networkError = String(e?.message || e);
      }
      if (!alive) return;
      const t = walletTruthOf({
        status, body, networkError,
        // 계좌 수는 **서버가 준 목록에서만** 센다. 화면이 따로 세면
        // 두 숫자가 갈리고, 실제로 못 읽은 화면이 "8개"라고 말한 적이 있다.
        connections: Array.isArray(body?.accounts) ? body.accounts.length : null,
      });
      setTruth(t);
      setData(t.code === 'OK' || t.code === 'NO_ACCOUNT' ? body : null);
    })();
    return () => { alive = false; };
  }, [auth, reload]);

  // 화면 곳곳이 쓰던 이름. 사람이 읽을 문장만 들어간다.
  const err = truth && truth.code !== 'OK' ? String(truth.message ?? '') : '';

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

  // ── 계좌 선택이 실제로 숫자를 바꾼다 ──
  //
  // 예전에는 `account` 상태만 바뀌고 합계는 환경 전체 그대로였다.
  // Gate를 눌러도 Binance를 눌러도 같은 숫자가 보였고, 사용자는 계좌별
  // 잔고를 보고 있다고 믿었다. 이제 서버가 계좌별 합계를 주므로
  // **고른 계좌의 값**을 쓴다.
  const selectedAccount: any = account && account !== 'ALL'
    ? (Array.isArray(data?.accounts) ? data.accounts : []).find((a: any) => String(a?.id) === String(account)) ?? null
    : null;

  // **총자산은 서버가 만든 canonical 값이다.**
  //
  // 버킷을 화면에서 다시 더하면 화면마다 다른 총자산이 생긴다. 서버가
  // 준 값이 있으면 그것을 쓰고, 없을 때만(로딩·실패) 버킷 합계를 쓴다.
  const envTotal: any = selectedAccount
    ? (selectedAccount.total ?? null)
    : ((Array.isArray(data?.envs) ? data.envs : []).find((e: any) => e?.env === env)?.total ?? null);
  const total = totalEquityOf(env, buckets);
  const envRow: any = (Array.isArray(data?.envs) ? data.envs : []).find((e: any) => e?.env === env) ?? null;
  // **오늘 손익** — 아는 것만 넣고 모르는 것은 모른다고 둔다.
  //
  // 예전에는 `equityChangeOf(null, {})`였다. 아무 자료도 안 넣었으니
  // 화면에 계산 근거가 하나도 없었다. 지금 서버가 주는 것(자산 곡선 ·
  // 미실현손익)은 넣고, 아직 통합 장부가 없어 모르는 것(입출금 ·
  // 수수료 · 펀딩)은 null로 둔다 — 그러면 `equityChangeOf`가
  // "무엇을 몰라서 확정 못 했는지"를 그대로 말해 준다.
  const todayDelta = (() => {
    const list = Array.isArray(data?.snapshotSeries?.[env]) ? data.snapshotSeries[env] : [];
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const today = list.filter((r: any) => Number(r?.takenAt) >= dayStart.getTime()
      && r?.totalEquity != null);
    if (today.length < 2) return null;   // 기준점이 없으면 만들지 않는다
    return Number(today[today.length - 1].totalEquity) - Number(today[0].totalEquity);
  })();
  // ── 서버가 장부까지 보고 판정한 값 ──
  //
  // 예전 주석에 "아직 통합 장부가 없어 모르는 것(입출금·수수료·펀딩)은
  // null로 둔다"고 적혀 있었다. **이제 있다** — 062가 거래소 원장을
  // 모으고, 서버가 그 기간이 완전한지까지 판정해서 내려준다.
  //
  // **화면이 다시 계산하지 않는다.** 계산하면 기준이 두 곳에 생기고,
  // 언젠가 서버는 "모른다"인데 화면은 숫자를 그리게 된다. 그래서 여기서는
  // 서버가 만든 판정(tradingPnl)을 그대로 보여 준다.
  const ledgerEnv: any = data?.ledger?.[env] ?? null;
  const tradingPnl: any = ledgerEnv?.tradingPnl ?? null;
  const change = equityChangeOf(todayDelta, {
    unrealizedPnl: (selectedAccount?.unrealizedPnl ?? envRow?.unrealizedPnl)?.value ?? null,
  });
  const pnl = todayPnlLabel(change);
  const cross = totalAcrossEnvs();
  // ── 환율 ──
  //
  // 예전에는 `const fxRate = null`이 박혀 있었고 주석은 정직했다 —
  // "공급원이 아직 없다. null은 '1:1'이 아니라 '모른다'이다."
  // **이제 공급원이 있다**(`/api/fx/usd`). 못 읽으면 여전히 null이고
  // KRW 버튼이 잠긴다 — `src/lib/currency.ts`처럼 1375로 채우지 않는다.
  // 못 바꾸는 것은 불편이고, 잘못 바꾼 숫자는 사고다.
  const fxRate = fx;
  // 이 환율을 지금 쓸 수 있는가. **없으면 통화를 바꾸지 않는다.**
  const fxNote = fxFreshness(fxRate, Date.now());

  // ── 모의투자 ──
  //
  // **판정은 화면이 하지 않는다.** `paperPanelOf`가 네 가지로 답한다:
  // 조회 중 · 못 읽음 · 시작 안 함 · 돌고 있음. 그중 **시작 버튼은
  // '시작 안 함'에서만** 나온다 — 못 읽었는데 버튼을 내주면, 누르는
  // 순간 읽지 못했을 뿐 살아 있던 장부가 초기화된다.
  const paperPanel = paperPanelOf({ paper: (data as any)?.paper ?? null, loaded: truth != null });
  // 시작 금액은 USDT 장부다. **원화는 환율이 있을 때만 병기한다.**
  const seedOptions = seedOptionsOf(
    Array.isArray((data as any)?.paper?.seedChoices)
      ? (data as any).paper.seedChoices : PAPER_SEED_CHOICES,
    fxRate);

  async function startPaper(seed: number) {
    if (starting) return;
    // **읽지 못한 상태에서는 시작하지 않는다.**
    if (!paperPanel.canStart) return;
    const v = validateSeed(seed);
    if (v.code !== 'OK' || v.value == null) { setStartErr(v.reason); return; }
    setStarting(true); setStartErr('');
    try {
      const r = await fetch('/api/paper/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify({ action: 'reset', seed: v.value }),
      });
      const j = await r.json().catch(() => null);
      // **성공을 지어내지 않는다.** 서버가 ok라고 한 것만 성공이다.
      if (!r.ok || !j?.ok) {
        setStartErr(String(j?.message || `모의투자를 시작하지 못했습니다 (HTTP ${r.status})`));
      } else {
        setSeedInput('');
        setReload(n => n + 1);
      }
    } catch (e: any) {
      setStartErr(`시작 요청이 실패했습니다 — ${String(e?.message || e)}`);
    } finally {
      setStarting(false);
    }
  }

  const shown = bucketsForTab(tab, total.buckets);
  // **총자산은 USD 기준 한 값이고, 통화 전환은 환율이 있을 때만 한다.**
  const totalUsd: number | null = envTotal?.value ?? total.total ?? null;
  const totalMoney = moneyView(totalUsd, cur as any, fxRate);
  // **"없음"과 "확인 못 함"을 화면이 섞지 않는다.**
  //
  // 예전에는 서버가 준 note를 그대로 썼다. 그런데 인증 실패로 아무것도
  // 못 읽었을 때도 그 note가 "이 환경에 연결된 계좌가 없습니다"였다 —
  // 화면은 그 문장과 `auth_required`를 **동시에** 보여 줬다.
  const envConnections: number | null = truth?.canStateAccounts
    ? (Array.isArray(data?.accounts)
      ? data.accounts.filter((a: any) => String(a?.env ?? '') === env).length : null)
    : null;
  // **MOCK은 거래소 연결로 판단하지 않는다.**
  //
  // `envNoteOf`는 이 환경의 **거래소 계좌 수**를 보고 "연결된 계좌가
  // 없습니다"를 적는다. 모의는 거래소 연결이 없는 것이 정상이라, 시작한
  // 계좌가 멀쩡히 있어도 그 문장이 떴다 — 게다가 그 위에는 0.00000000이
  // 같이 있었다. 모의의 안내는 모의 판정에서 나온다.
  const envNote: string = env === 'MOCK'
    ? (paperPanel.code === 'ACTIVE' ? '' : paperPanel.note)
    : selectedAccount
    ? (selectedAccount.note ?? '')
    : envNoteOf({
      truth: truth ?? { canStateAccounts: false, message: '지갑을 읽는 중입니다' } as any,
      env, envConnections,
      serverNote: (Array.isArray(data?.envs) ? data.envs : []).find((e: any) => e?.env === env)?.note ?? '',
    });

  // "다른 환경의 계좌 N개는 합산에서 제외" — **못 읽었으면 숫자를 만들지 않는다.**
  const otherEnvLine = otherEnvNote({
    truth: truth ?? { canStateAccounts: false } as any,
    accountEnvs: Array.isArray(data?.accounts) ? data.accounts.map((a: any) => a?.env ?? null) : null,
    currentEnv: env,
  });

  // ── 그래프 ──
  //
  // 찍어 둔 시점(account_equity_snapshots)이 아직 없다. 그래서 곡선도
  // 없다 — **그게 정직한 상태다.** 오늘 표를 만들어도 어제 값은 생기지 않는다.
  // 자산 곡선은 찍어 둔 시점(account_equity_snapshots)에서만 나온다.
  // **지금 잔고로 과거를 역산하지 않는다** — 오늘 표를 만들어도 어제
  // 값은 생기지 않는다. 서버가 지갑을 읽을 때마다 찍어 두므로
  // 두 번째 방문부터 곡선이 생긴다.
  // **서버가 준 원본으로 그린다.** 예전에는 여기에 `[]`가 박혀 있어
  // 곡선이 구조적으로 영원히 비어 있었다 — 데이터가 없어서가 아니라
  // 배선이 없어서였다. 없는 구간은 지어내지 않는다(찍힌 시점만).
  const snapshots: any[] = Array.isArray(data?.snapshotSeries?.[env])
    ? data.snapshotSeries[env]
    : [];
  // 이 환경의 성과. **없으면 만들지 않는다.**
  const perf: any = data?.performance?.[env] ?? null;
  // 서버가 이미 판정해서 준다. **화면이 다시 계산하지 않는다** —
  // 기준이 두 곳에 생기면 언젠가 갈린다.
  const snapNote: any = (Array.isArray(data?.snapshots) ? data.snapshots : [])
    .find((n: any) => n?.env === env) ?? null;
  const curve = curveOf(snapshots, range, Date.now(), env);
  const daily = dailyRowsOf(snapshots);

  // ── 자산 배분 ──
  //
  // 예전에는 네 조각을 전부 `pending()`으로 넣었다. 그러면 배분은
  // 구조적으로 영원히 "조회 중"이다 — 서버가 값을 이미 주고 있었는데도.
  //
  // **없는 계좌를 조각으로 넣지 않는다.** 장기투자 계좌를 연결한 적이
  // 없으면 그건 "못 읽은 조각"이 아니라 **없는 조각**이다. 그걸 null로
  // 넣으면 `allocationOf`가 (맞게) 비율을 거부해서, 실제로 다 읽은
  // 현물·선물 배분까지 영영 안 나온다.
  //
  // 그래서 이 환경에 실제로 존재하는 버킷만 조각으로 만든다. 그중 하나라도
  // 못 읽었으면 그때는 비율을 내지 않는다 — 그건 맞는 거부다.
  const alloc = allocationOf(
    total.buckets
      .filter((b: Bucket) => b.amount.readiness !== 'NOT_APPLICABLE')
      .map((b: Bucket) => ({
        label: b.label,
        cell: cellOf(b.amount.value, b.amount.value == null
          ? (b.amount.readiness === 'LOADING' ? 'SYNCING' : 'FAILED') : 'OK'),
      })),
  );

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
  // ── 선물 계좌 상세 — 서버가 준 값으로 ──
  //
  // 예전에는 `[]`가 박혀 있어 이 탭이 영원히 비어 있었다.
  const accountList: any[] = Array.isArray(data?.accounts) ? data.accounts : [];
  const shownAccounts = selectedAccount ? [selectedAccount]
    : accountList.filter((a: any) => a?.env === env);
  const futuresAccounts = shownAccounts
    .filter((a: any) => a?.futuresDetail)
    .map((a: any) => ({
      name: a.label || a.exchangeId || a.id,
      rows: futuresRowsOf({
        walletBalance: cellOf(a.futuresDetail.walletBalance, a.futuresDetail.walletBalance == null ? 'FAILED' : 'OK'),
        availableBalance: cellOf(a.futuresDetail.availableMargin, a.futuresDetail.availableMargin == null ? 'FAILED' : 'OK'),
        usedMargin: cellOf(a.futuresDetail.positionMargin, a.futuresDetail.positionMargin == null ? 'FAILED' : 'OK'),
        // **못 읽은 것은 0이 아니다.** 포지션 조회가 실패하면 미실현손익은 모른다.
        unrealizedPnl: cellOf(a.futuresDetail.unrealizedPnl,
          a.futuresDetail.positionsOk === false || a.futuresDetail.unrealizedPnl == null ? 'FAILED' : 'OK'),
      } as any),
      sync: a.partial ? '일부 항목을 읽지 못했습니다' : '',
    }));

  // ── 현물 자산 — 서버가 준 값으로 ──
  const spot: SpotAsset[] = spotRowsOf(shownAccounts.flatMap((a: any) =>
    (Array.isArray(a?.spotAssets) ? a.spotAssets : []).map((x: any) => ({
      symbol: String(x?.asset ?? ''),
      // **`Number(x) || 0`을 쓰지 않는다.** `Number(null)`은 0이고,
      // 그러면 "못 읽었다"가 "0개 있다"로 화면에 적힌다. 이 저장소가
      // 반복해서 잡아 온 고장이 정확히 그 모양이다 — 0 ≠ 없음.
      quantity: (() => {
        const f = numOrNull(x?.free); const l = numOrNull(x?.locked);
        return f == null || l == null ? cellOf(null, 'FAILED') : cellOf(f + l);
      })(),
      available: cellOf(numOrNull(x?.free), numOrNull(x?.free) == null ? 'FAILED' : 'OK'),
      locked: cellOf(numOrNull(x?.locked), numOrNull(x?.locked) == null ? 'FAILED' : 'OK'),
      // **가격을 못 매겼으면 0이 아니라 확인 불가다.**
      valuation: cellOf(x?.valueUsd ?? null, x?.valueUsd == null ? 'FAILED' : 'OK'),
      // 24시간 변동률은 이 경로가 안 주는 값이다. **0이 아니라 '안 줌'이다**
      change24hPct: cellOf(null, 'UNSUPPORTED'),
    })) as SpotAsset[]));

  // ── 전략계좌 — 서버가 준 값으로 ──
  //
  // 예전에는 `const strategies = []`가 박혀 있었고 주석은 "전략별 귀속
  // 장부가 붙어야 실제 값이 생긴다"였다. **그 장부는 041이 이미 만들어
  // 뒀다**(`strategy_accounts`) — 만들어 놓고 배선을 안 한 것이다.
  //
  // **못 읽은 것을 '전략 없음'으로 그리지 않는다.** 서버가 null을 주면
  // 그건 조회 실패이고, 빈 배열과 다르다.
  const strategiesRaw: any[] | null = Array.isArray(data?.strategies) ? data.strategies : null;
  const strategiesUnreadable = data != null && strategiesRaw == null;
  // **환경을 모르는 전략계좌는 어느 환경에도 넣지 않는다.** 따로 알린다 —
  // 안 보여주면 사용자는 그 전략이 사라진 줄 안다.
  const strategies: StrategyAccount[] = (strategiesRaw ?? [])
    .filter((x: any) => x?.env === env) as StrategyAccount[];
  const strategiesNoEnv = (strategiesRaw ?? []).filter((x: any) => x?.env == null);
  const stratTotal = strategyTotalOf(strategies);
  // 장기투자(주식·ETF)는 연결할 계좌 종류 자체가 아직 없다. **0을 그리지
  // 않는다** — 아래 빈 상자가 왜 비었는지까지 적는다.
  const longterm: LongtermHolding[] = [];

  // 색을 여기서 고르지 않는다 — 어느 색인지의 **판단**은 status.ts에 있고
  // 화면은 그 의미를 색으로 옮기기만 한다.
  const envColor = (e: WalletEnv) => toneColor(envView(e as any).tone);
  const muted: React.CSSProperties = { color: T.muted, fontSize: 9.5, lineHeight: 1.6 };
  const numFont: React.CSSProperties = { fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums' };

  /**
   * 표 한 칸.
   *
   * **못 읽었으면 '—'만 적는다.** 예전에는 칸마다 사유를 적었고, 그래서
   * 한 화면에 '확인 불가'가 열다섯 번 나왔다. 그렇게 되면 사용자는 어느
   * 것이 진짜 문제인지 고를 수 없다 — 사유는 아래 상태 카드가 한 번만
   * 말한다. 0을 그리지 않는 규칙은 그대로다.
   */
  const cellText = (c: { value: number | null; text: string }) =>
    c.value == null ? UNKNOWN_TEXT : c.value.toLocaleString('ko-KR');

  /** 모의 줄 한 칸. 값이 없으면 0이 아니라 빈 자리다 */
  const paperCell = (r: { usd: number | null; readiness: string }) =>
    r.readiness === 'OK' ? moneyView(r.usd, cur as any, fxRate).text
      : r.readiness === 'LOADING' ? '조회 중…' : UNKNOWN_TEXT;

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
          {/* 문구는 walletTruthOf가 만든다 — 서버 코드가 여기까지 오지 않는다.
              "0이 아니다"는 이미 그 문장 안에 들어 있다. */}
          {err}
          {truth?.needsLogin && (
            <div style={{ marginTop: 4, color: T.sub }}>
              다시 로그인하면 잔고를 읽습니다. 로그인 전까지는 계좌 수도 잔고도 알 수 없습니다.
            </div>
          )}
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
            <SafeNote text={perf.note} style={{ marginTop: 5 }} />
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
                  {/* **못 읽은 것을 0으로 그리지 않는다.** 다만 칸마다
                      사유를 적지도 않는다 — 아래 카드가 한 번만 말한다. */}
                  <span style={{ color: v == null ? T.muted : T.txt, fontWeight: v == null ? 600 : 800 }}>
                    {shownValue(v, 'money').text}
                  </span>
                </div>
              ))}
              {/* 못 읽은 항목을 **한 장으로 압축한다.** 여섯 줄에 여섯 번
                  '확인하지 못했습니다'를 적으면 그 단어가 배경이 된다. */}
              {(() => {
                const u = unknownSummaryOf([
                  { label: '시작 자산', known: perf.startEquity != null },
                  { label: '현재 자산', known: perf.currentEquity != null },
                  { label: '자산 증가', known: perf.equityChange != null },
                  { label: '순입출금', known: perf.cashFlow?.net != null },
                  { label: '매매 손익', known: perf.tradingPnl != null },
                  { label: '최고 자산', known: perf.peakEquity != null },
                  { label: '최대 낙폭(%)', known: perf.maxDrawdownPct != null },
                ]);
                if (!u.any) return null;
                return (
                  <div style={{ marginTop: 8 }}>
                    <StatusCard kind={u.kind} headline={u.headline!} detail={u.detail!} compact />
                  </div>
                );
              })()}
              {perf.tradingReturnPct != null && (
                <div style={{ display: 'flex', gap: 8, fontSize: 10.5, lineHeight: 1.6 }}>
                  <span style={{ color: T.muted, minWidth: 78, flexShrink: 0 }}>매매 수익률</span>
                  <span style={{ color: perf.tradingReturnPct >= 0 ? T.grn : T.red, fontWeight: 800 }}>
                    {perf.tradingReturnPct >= 0 ? '+' : ''}{perf.tradingReturnPct}%
                  </span>
                </div>
              )}
              <SafeNote text={perf.note} style={{ marginTop: 3 }} />
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

      {/* **환경은 색과 글자 둘 다 달라야 한다.** 색만 다르면 실전 화면과
          테스트넷 화면을 헷갈린 채로 주문을 누른다. */}
      <div style={{ marginBottom: 10 }}>
        <EnvBadge env={env as any} withMeaning />
      </div>

      {/* ── 모의투자 ──
          이 탭은 오래 **만들어 놓고 배선이 없던** 자리다. 서버의 envs가
          ['LIVE','TESTNET'] 고정이라, 눌러도 아무 숫자가 없었다. */}
      {env === 'MOCK' && (
        <Card style={{ padding: 14, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <span style={{ color: T.txt, fontSize: 12, fontWeight: 800 }}>{paperPanel.headline}</span>
            <span style={{ marginLeft: 'auto', ...muted }}>장부 통화 USDT</span>
          </div>

          {paperPanel.code === 'NOT_STARTED' ? (
            <>
              {/* **'계좌 없음'과 '못 읽음'과 '잔고 0'은 서로 다른 문장이다.**
                  예전에는 이 자리에 서버 note를 그대로 적었고, 그 위에
                  0.00000000이 같이 떠 있었다. */}
              <div style={{ marginBottom: 10 }}>
                {(() => {
                  const st = accountStatusOf({ code: 'NO_ACCOUNT', envLabel: '모의' });
                  const d = splitDiagnostics(paperPanel.note, st.detail ?? '');
                  return <StatusCard kind={st.kind} headline={st.headline}
                    detail={d.body} diagnostics={d.diagnostics} compact />;
                })()}
              </div>

              {/* ── 1단계: 시작하기 ──
                  누르기 전에는 금액을 보여 주지 않는다. 계좌가 없는데
                  숫자가 먼저 보이면 그게 잔고로 읽힌다. */}
              {!seedOpen ? (
                <button onClick={() => { setSeedOpen(true); setStartErr(''); }} style={{
                  width: '100%', minHeight: 44, borderRadius: 10, cursor: 'pointer',
                  background: T.acg, color: T.acl,
                  border: `1px solid ${T.acl}`, fontSize: 12, fontWeight: 800,
                }}>모의투자 시작하기</button>
              ) : (
              <>
              <div style={{ color: T.txt, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>
                초기자금
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                {seedOptions.map(o => (
                  <button key={o.usd} disabled={starting} onClick={() => startPaper(o.usd)} style={{
                    flex: '1 1 30%', minWidth: 96, minHeight: 52, borderRadius: 10,
                    cursor: starting ? 'not-allowed' : 'pointer', opacity: starting ? 0.5 : 1,
                    background: 'transparent', color: T.txt,
                    border: `1px solid ${T.border}`, padding: '6px 8px', textAlign: 'left',
                  }}>
                    <div style={{ fontSize: 11.5, fontWeight: 800, ...numFont }}>{o.usdText}</div>
                    {/* **환율이 없으면 원화를 적지 않는다.** 달러 숫자에 ₩만
                        붙이면 몇 배 틀린 값이 된다 — 이 저장소에 그 기록이 있다. */}
                    <div style={{ ...muted, marginTop: 2 }}>
                      {o.krwText ?? '원화 환산 불가'}
                    </div>
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                <input value={seedInput} onChange={e => setSeedInput(e.target.value)}
                  inputMode="decimal" placeholder="직접 입력 (USDT)"
                  style={{
                    flex: 1, minHeight: 34, borderRadius: 8, padding: '0 10px',
                    background: 'transparent', color: T.txt,
                    border: `1px solid ${T.border}`, fontSize: 11, ...numFont,
                  }} />
                <button disabled={starting || seedInput.trim() === ''}
                  onClick={() => startPaper(Number(seedInput))}
                  style={{
                    minHeight: 34, padding: '0 14px', borderRadius: 8,
                    cursor: starting || seedInput.trim() === '' ? 'not-allowed' : 'pointer',
                    opacity: starting || seedInput.trim() === '' ? 0.5 : 1,
                    background: T.acg, color: T.acl,
                    border: `1px solid ${T.acl}`, fontSize: 11, fontWeight: 800,
                  }}>{starting ? '만드는 중…' : '계좌 만들기'}</button>
              </div>
              <div style={muted}>
                최소 100 · 최대 10,000,000 USDT. 모의 자산은 실전·테스트넷과 절대 합산하지 않습니다.
              </div>
              </>
              )}
            </>
          ) : (
            <>
              {/* 총자산 · 현금 · 포지션 증거금 · 실현/미실현 · 오늘 손익.
                  **못 구한 값은 0이 아니라 '확인 불가'다.** */}
              {paperPanel.rows.map(r => {
                const signed = r.readiness === 'OK' && r.usd != null
                  && (r.key === 'unrealized' || r.key === 'realized' || r.key === 'today');
                const c = !signed ? T.txt : (r.usd as number) > 0 ? T.grn : (r.usd as number) < 0 ? T.red : T.txt;
                return (
                  <div key={r.key} style={{
                    display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 0',
                    borderBottom: `1px solid ${T.border}`,
                  }}>
                    <span style={{ color: T.muted, fontSize: 10.5, minWidth: 84 }}>{r.label}</span>
                    <span style={{
                      marginLeft: 'auto', textAlign: 'right',
                      color: r.readiness === 'OK' ? c : T.muted,
                      fontSize: 12, fontWeight: 800, ...numFont,
                    }}>{paperCell(r)}</span>
                  </div>
                );
              })}
              {paperPanel.rows.some(r => r.readiness !== 'OK') && (
                <div style={{ ...muted, marginTop: 8 }}>
                  {paperPanel.rows.find(r => r.readiness !== 'OK')?.hint}
                </div>
              )}
              {paperPanel.code === 'UNREADABLE' && (
                <div style={{ marginTop: 8 }}>
                  {(() => {
                    const st = accountStatusOf({ code: 'UNREADABLE', envLabel: '모의' });
                    // 서버가 준 원문에 DB·API 문장이 섞여 있으면 본문에서 뗀다.
                    const d = splitDiagnostics(paperPanel.note, st.detail ?? '');
                    return <StatusCard kind={st.kind} headline={st.headline}
                      detail={d.body === st.detail ? st.detail : `${st.detail}\n${d.body}`}
                      diagnostics={d.diagnostics} compact />;
                  })()}
                </div>
              )}
            </>
          )}

          {startErr && (
            <div style={{ ...muted, color: T.red, marginTop: 8 }}>{startErr}</div>
          )}

          {/* ── 자세히 ──
              **DB 오류 원문은 여기에만 있다.** 지갑 메인에
              `column paper_accounts.started_at does not exist`가 그대로
              뜬 적이 있다 — 사용자는 그 문장으로 할 수 있는 일이 없고,
              자기 돈에 무슨 일이 났다고 읽는다. */}
          {paperPanel.detail && (
            <div style={{ marginTop: 8 }}>
              <button onClick={() => setDetailOpen(v => !v)} style={{
                background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                color: T.muted, fontSize: 9.5, textDecoration: 'underline',
              }}>{detailOpen ? '자세히 닫기' : '자세히'}</button>
              {detailOpen && (
                <div style={{ ...muted, marginTop: 4, wordBreak: 'break-all' }}>
                  {paperPanel.detail}
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* ── 아래는 "계좌가 있다"가 확인된 뒤에만 그린다 ──
          모의 계좌가 없는데 총자산 칸을 그리면, 빈 합계가 0으로 보인다.
          실제로 `0.00000000 USDT`와 "계좌가 없습니다"가 같은 화면에 있었다. */}
      {!(env === 'MOCK' && paperPanel.code !== 'ACTIVE') && (<>
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
      {/* **못 읽었으면 계좌 수를 말하지 않는다.**
          예전에는 인증이 안 된 상태에서도 "다른 환경의 계좌 8개"라는
          숫자가 떴다 — 아무것도 못 읽었는데 어디선가 만들어 낸 값이다.
          이제 같은 목록(서버가 준 accounts)에서만 센다. */}
      {truth?.canStateAccounts && accountsNote && (
        <div style={{ ...muted, color: T.ylw, marginBottom: 10 }}>{accountsNote}</div>
      )}
      {otherEnvLine && (
        <div style={{ ...muted, marginBottom: 10 }}>{otherEnvLine}</div>
      )}

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
        {/* **오래된 환율로 바꾼 값도 바꾼 값이다** — 다만 사용자가 그
            사실을 알아야 한다. 막지는 않고 말한다. */}
        {cur === 'KRW' && fxNote.stale && (
          <div style={{ ...muted, color: T.ylw, marginBottom: 4 }}>{fxNote.reason}</div>
        )}
        {/* **서버가 만든 canonical 총자산을 그대로 쓴다.**
            = 현물 전체 평가액 + 선물 순자산. 화면에서 다시 더하지 않는다 —
            그러면 홈과 지갑이 서로 다른 총자산을 보인다. */}
        <div style={{
          color: totalUsd == null ? T.muted : T.txt,
          fontSize: totalUsd == null ? 16 : 26, fontWeight: 900, ...numFont,
        }}>
          {totalUsd == null ? UNKNOWN_LABEL : totalMoney.text}
        </div>
        {/* **세 문장을 ' · '로 이어 붙이지 않는다.**
            예전에는 환경 안내 + 총자산 사유 + 환산 근거가 한 줄로 붙어
            노란 긴 문장이 됐다. 사용자는 그걸 통째로 건너뛴다.
            지금은 **왜 못 냈는지 한 줄**만 보이고 나머지는 접힌다. */}
        {(() => {
          const rest = [total.note, totalUsd != null ? totalMoney.reason : '']
            .filter(Boolean).join('\n');
          if (totalUsd == null) {
            const d = splitDiagnostics(total.note || envNote, '값을 읽지 못해 총자산을 내지 않았습니다.');
            return (
              <div style={{ marginTop: 8 }}>
                <StatusCard kind="UNKNOWN" headline="총자산을 내지 않았습니다"
                  detail={`${d.body}\n0이라는 뜻이 아닙니다 — 값을 읽지 못했습니다.`}
                  diagnostics={d.diagnostics} compact />
              </div>
            );
          }
          if (!rest && !envNote) return null;
          return <Details summary="이 값의 근거">{[envNote, rest].filter(Boolean).join('\n')}</Details>;
        })()}

        <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 10, paddingTop: 10 }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>오늘 손익</div>
          <div style={{
            color: pnl.headline === UNKNOWN_LABEL ? T.muted : T.txt,
            fontSize: 15, fontWeight: 800, ...numFont,
          }}>{pnl.headline}</div>
          {pnl.caution && (
            <div style={{ ...muted, color: T.ylw, marginTop: 4 }}>{pnl.caution}</div>
          )}

          {/* ── 그중 매매로 번 것 ── */}
          {/*
            **잔고가 변한 것과 번 것은 다르다.** 테스트넷 일일 충전이
            들어오면 자산은 늘지만 번 것은 아니다. 네 항(자산변화 ·
            외부유입 · 수수료 · 펀딩)을 전부 알 때만 숫자가 나온다.
          */}
          {tradingPnl && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${T.border}` }}>
              <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>그중 매매로 번 것</div>
              {tradingPnl.value == null ? (
                <>
                  <div style={{ color: T.muted, fontSize: 13, fontWeight: 700 }}>확인 불가</div>
                  <div style={{ ...muted, marginTop: 3 }}>
                    {/* 무엇을 몰라서 확정 못 했는지 그대로 적는다 */}
                    {tradingPnl.reason || ledgerEnv?.reason || '장부가 이 기간을 다 덮지 못했습니다'}
                  </div>
                </>
              ) : (
                <>
                  <div style={{
                    color: tradingPnl.value >= 0 ? T.grn : T.red,
                    fontSize: 15, fontWeight: 800, ...numFont,
                  }}>
                    {tradingPnl.value >= 0 ? '+' : ''}
                    {moneyText(tradingPnl.value, 'USDT').text}
                  </div>
                  {ledgerEnv?.totals && (
                    <div style={{ ...muted, marginTop: 3 }}>
                      {/* 무엇을 빼고 남은 값인지 보여 준다 */}
                      {/* **못 읽은 값을 0으로 적지 않는다.** `?? 0`이 여기
                          있었다 — 외부유입을 못 읽으면 "유입 0"이 되고,
                          그러면 그 돈이 전부 매매 손익으로 읽힌다. */}
                      외부유입 {shownValue(ledgerEnv.totals.externalFlow, 'money').text}
                      {' · '}수수료 {shownValue(ledgerEnv.totals.fees, 'money').text}
                      {' · '}펀딩 {shownValue(ledgerEnv.totals.funding, 'money').text}
                      {Number(ledgerEnv.totals.testnetCredit ?? 0) !== 0 && (
                        <> {' · '}<span style={{ color: T.ylw }}>
                          테스트넷 충전 {shownValue(ledgerEnv.totals.testnetCredit, 'money').text} (수익 아님)
                        </span></>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
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
                // display-layer-exempt: SVG 경로 좌표다. 사용자가 읽는 값이 아니라
                // 픽셀 위치이므로 표시 규칙(자릿수·부호·모름)이 적용되지 않는다.
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
            <SafeNote text={curve.note} style={{ textAlign: 'center' }} />
          </div>
        )}
        {curve.hasData && curve.note && (
          <SafeNote text={curve.note} tone="warn" style={{ marginTop: 6 }} />
        )}
        {/* **곡선이 조용히 멈추는 것을 막는다.**

            자산을 찍는 일이 이 화면(GET)에서 워커로 옮겨 갔다. 좋은
            바꿈이지만 새 실패 모드가 하나 생긴다 — **워커가 멈추면
            곡선도 멈추는데, 마지막 점은 지금 자산인 척한다.**
            그래서 오래됐으면 오래됐다고 적는다. */}
        {snapNote?.stale && (
          <div style={{
            ...muted, color: T.ylw, marginTop: 6, background: T.alt,
            borderRadius: 6, padding: '7px 9px',
          }}>{snapNote.reason}</div>
        )}
      </Card>

      </>)}

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
              }}>{pctText(s.pct).text}</span>
            </div>
            <div style={{ height: 4, background: T.alt, borderRadius: 2, marginTop: 3, overflow: 'hidden' }}>
              {s.pct != null && (
                <div style={{ width: `${Math.min(100, s.pct)}%`, height: '100%', background: T.acl }} />
              )}
            </div>
          </div>
        ))}
        <SafeNote text={alloc.note} tone="warn" style={{ marginTop: 6 }} />
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
            {stratTotal.total == null ? UNKNOWN_LABEL : stratTotal.total.toLocaleString('ko-KR')}
          </div>
          <SafeNote text={stratTotal.note} tone="warn" style={{ marginBottom: 8 }} />

          {/* **못 읽은 것을 '전략 없음'으로 적지 않는다.** 빈 목록이면
              사용자는 배정한 돈이 사라진 줄 안다. */}
          {strategiesUnreadable && (
            <div style={{ ...muted, color: T.ylw, marginBottom: 8 }}>
              전략계좌를 읽지 못했습니다{data?.strategiesError ? ` (${data.strategiesError})` : ''} —
              전략이 없다는 뜻이 아닙니다
            </div>
          )}
          {/* 환경을 못 읽은 연결에 붙은 전략계좌. **어느 환경 합계에도
              넣지 않고 따로 알린다** — 안 보여주면 사라진 줄 안다. */}
          {strategiesNoEnv.length > 0 && (
            <div style={{ ...muted, color: T.ylw, marginBottom: 8 }}>
              전략계좌 {strategiesNoEnv.length}개는 거래소 연결이 없거나 환경(실전/테스트넷)을
              확인하지 못해 어느 환경에도 넣지 않았습니다 — 모르는 것을 실전으로 올리지 않습니다
            </div>
          )}
          {strategies.length === 0
            ? emptyBox(strategiesUnreadable ? '전략계좌를 확인하지 못했습니다'
                : `${ENV_LABEL[env]}에 전략계좌가 없습니다`,
                '전략별 배정 자금·현재 자산·실현/미실현손익·수수료·수익률·MDD·'
                + '보유 포지션을 여기서 나눠 봅니다. 자산은 배정 + 실현손익 + 미실현손익 − 수수료로 '
                + '내고, 네 항 중 하나라도 못 읽으면 "—"입니다 — 빠진 항이 있으면 '
                + '그만큼이 전부 손익으로 보입니다.')
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
                  <span>보유 <b style={{ color: T.txt }}>{cellText(s.activePositions)}</b></span>
                  {(s as any).stage && <span>단계 <b style={{ color: T.txt }}>{(s as any).stage}</b></span>}
                </div>
                {/* **멈춰 있는 전략을 조용히 두지 않는다.** 낙폭·한도로
                    자동으로 섰든 사람이 세웠든, 화면에 보여야 한다. */}
                {(s as any).halted && (
                  <div style={{ ...muted, color: T.ylw, marginTop: 3 }}>
                    이 전략은 멈춰 있습니다 — 신규 진입이 나가지 않습니다
                  </div>
                )}
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
                {d.pnl == null ? UNKNOWN_TEXT : pnlText(d.pnl, '').text}
              </span>
              {d.hadFlow && <span style={{ color: T.ylw, fontSize: 9 }}>입출금</span>}
            </div>
          ))}
      </Card>
    </div>
  );
}

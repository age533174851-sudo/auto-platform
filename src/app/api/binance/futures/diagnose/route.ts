// /api/binance/futures/diagnose
// 테스트넷 진단 — 실계좌 가기 전 시스템 검증 체크리스트
// POST { connectionId }
// API연결/잔고조회/시장가정보/레버리지/현재가 등 항목별 성공여부

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { binanceTestnetDiagnoseGate } from '@/lib/engine/testnetReadiness';
import {
  positionModeVerdict, isolationVerdict, withdrawalEvidence,
  overallDiagnoseVerdict, statusToOk, type DiagnoseStatus,
} from '@/lib/engine/testnetDiagnoseVerdict';
import { overrideOf } from '@/lib/strategies/profilePreset';
import { testFuturesConnection, getFuturesBalance, getFuturesPositions, getFuturesTicker, getSymbolFilters } from '@/lib/exchanges/binanceFutures';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ★ `ok` 한 칸으로는 "확인했고 틀리다"와 "확인하지 못했다"를 가를 수
//   없다. 둘은 다음 할 일이 완전히 다르다. 그래서 `status`를 더한다.
//   `ok`는 옛 화면을 위해 남기고 **`status === 'PASS'`에서만 참**이다.
interface Check {
  name: string; ok: boolean; detail: string; ms: number;
  status?: DiagnoseStatus; code?: string;
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { connectionId } = body;
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn, error } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (error || !conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });

  // 호출 전에 검사한다. 이 진단은 Binance TESTNET 전용이고,
  // LIVE 연결의 키로 단 한 번도 거래소에 요청하지 않는다.
  const ciphertext = conn.api_secret_enc || conn.encrypted_secret || '';
  const gate = binanceTestnetDiagnoseGate({
    exchange: conn.exchange_id,
    testnet: conn.is_testnet,
    active: conn.is_active,
    hasWithdrawal: conn.has_withdrawal,
    keyPresent: !!String(conn.api_key ?? '').trim(),
    secretCipherPresent: !!String(ciphertext).trim(),
  });
  if (!gate.ok) {
    return NextResponse.json({ error: gate.code, message: gate.reason }, { status: 409 });
  }

  let secret = '';
  try { secret = decryptSecret(String(ciphertext)); } catch {}
  if (!secret) {
    return NextResponse.json({
      error: 'CREDENTIALS_UNUSABLE',
      message: 'API 시크릿 복호화에 실패했습니다 — 거래소에 요청하지 않았습니다',
    }, { status: 409 });
  }
  const apiKey = String(conn.api_key);
  const testnet = true; // TESTNET 외에는 위 게이트에서 거부했다.

  const checks: Check[] = [];
  const run = async (name: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      checks.push({ name, ...r, ms: Date.now() - t0, status: r.ok ? 'PASS' : 'FAIL' });
    }
    catch (e: any) {
      // **던진 것은 답을 못 받은 것이다.** 거래소가 거절한 것(FAIL)과
      // 구별한다 — 전자는 다시 물어봐야 하고 후자는 설정을 고쳐야 한다.
      checks.push({ name, ok: false, detail: e?.message || '오류',
        ms: Date.now() - t0, status: 'UNKNOWN', code: 'PROBE_THREW' });
    }
  };

  // 1. API 연결과 선물 거래 가능 여부를 분리한다.
  // 계좌 조회 성공이 canTrade=true의 증거는 아니다.
  let exchangeCanTrade = false;
  await run('API 연결', async () => {
    const r = await testFuturesConnection(apiKey, secret, testnet);
    exchangeCanTrade = r.success === true && r.canTrade === true;
    return { ok: r.success, detail: r.success ? 'TESTNET 계정 인증 성공' : r.message };
  });
  checks.push({
    name: '선물 거래 권한',
    ok: exchangeCanTrade && conn.perm_trading === true,
    detail: exchangeCanTrade && conn.perm_trading === true
      ? '거래소와 저장된 거래 권한이 일치합니다 (실제 주문은 내지 않았습니다)'
      : '선물 거래 권한을 확인하지 못했습니다 — 진단 성공을 거래 가능으로 읽지 않습니다',
    ms: 0,
    status: exchangeCanTrade && conn.perm_trading === true ? 'PASS' : 'FAIL',
    code: 'TRADE_PERMISSION',
  });
  // 2. 잔고 조회
  await run('잔고 조회', async () => {
    const r = await getFuturesBalance(apiKey, secret, testnet);
    return { ok: r.success, detail: r.message };
  });
  // 3. 포지션 조회
  await run('포지션 조회', async () => {
    const r = await getFuturesPositions(apiKey, secret, testnet);
    return { ok: r.success, detail: r.message };
  });
  // 4. 현재가 조회
  await run('현재가 조회 (BTCUSDT)', async () => {
    const p = await getFuturesTicker('BTCUSDT', testnet);
    return { ok: p !== null && p > 0, detail: p ? `BTC $${Math.round(p).toLocaleString()}` : '실패' };
  });
  // 5. 심볼 규칙 (LOT_SIZE) 조회
  await run('주문 규칙 조회 (LOT_SIZE)', async () => {
    const f = await getSymbolFilters('BTCUSDT', testnet);
    return {
      ok: !!f,
      detail: f
        ? `지정가 step ${f.limitQty?.stepSize ?? '없음'} · 시장가 step ${f.marketQty?.stepSize ?? '없음'}`
          + ` · 최소금액 ${f.minNotional ?? '없음'}`
        : '실패',
    };
  });

  // ── 6~8. **주문 계열 엔드포인트를 따로 본다** ──
  //
  // 왜 필요한가: 화면에 잔고가 멀쩡히 떠 있는데 주문만 -2015로 막히는
  // 일이 있었다. 키 설정에는 Enable Futures까지 켜져 있었다. 위 1~5번은
  // 전부 통과하므로 진단이 'ready'라고 말하는데, 실제로는 주문이 안 된다.
  //
  // 주문을 실제로 내 보지는 않는다 — 진단이 부작용을 만들면 진단을 못
  // 돌린다. 대신 **주문 계열 조회**를 찔러 본다. 인증 계층은 같으므로,
  // 여기가 막히면 주문도 막힌다.
  const { diagnoseFutures, futuresOrderTypes, FUTURES_HOSTS } =
    await import('@/lib/exchanges/binanceFutures');
  const deep = await diagnoseFutures(apiKey, secret, testnet, 'BTCUSDT');

  // ── **이 환경이 어떤 주문 유형을 받는다고 스스로 말하는가** ──
  //
  // 데모가 STOP_MARKET을 거절하는 것을 지금까지는 주문을 실제로 내 봐야
  // 알 수 있었고, 시도마다 진입·청산 수수료가 나갔다(잔고가 4,997 →
  // 4,960으로 줄었다).
  //
  // exchangeInfo는 키도 서명도 필요 없는 공개 조회이고 심볼별 orderTypes를
  // 알려준다. 미리 물어보면 주문 전에 알 수 있다.
  //
  // 이 값을 판단에 그대로 쓰지는 않는다 — 목록에 적어 두고도 거절하는
  // 경우가 있다. **사실을 보여주는** 용도다.
  let stopSupport: any = null;
  try {
    const here = await futuresOrderTypes(testnet ? FUTURES_HOSTS.demo : FUTURES_HOSTS.live, 'BTCUSDT');
    const hasStop = here.ok && here.orderTypes.includes('STOP_MARKET');
    checks.push({
      name: '조건부 주문 지원 (STOP_MARKET)',
      ok: hasStop,
      // 목록을 못 받은 것은 "지원 안 함"이 아니다.
      status: here.ok ? (hasStop ? 'PASS' : 'FAIL') : 'UNKNOWN',
      code: here.ok ? (hasStop ? 'STOP_SUPPORTED' : 'STOP_UNSUPPORTED') : 'STOP_UNKNOWN',
      detail: here.ok
        ? (hasStop
            ? `받습니다 · ${here.orderTypes.length}종`
            : `목록에 없습니다 — 손절을 거래소에 걸 수 없습니다. 지원: ${here.detail}`)
        : `확인하지 못했습니다 (${here.detail})`,
      ms: 0,
    });
    stopSupport = { host: testnet ? FUTURES_HOSTS.demo : FUTURES_HOSTS.live, ...here, hasStop };
  } catch { /* 못 물어봤으면 항목만 빠진다 */ }
  for (const c of deep.checks) {
    // 위에서 이미 본 항목은 건너뛴다
    if (c.path === '/fapi/v1/time' || c.path === '/fapi/v2/balance') continue;
    checks.push({ name: c.name, ok: c.ok, detail: c.detail, ms: 0,
      status: c.ok ? 'PASS' : 'FAIL', code: `PROBE:${c.path}` });
  }

  // ══════════ 9~11. Exact100X 실측 전제 — 읽기만 한다 ══════════
  //
  // 왜 1~8번으로 부족한가: 1~8번이 전부 통과해도 **계좌가 양방향이거나
  // 교차 마진이거나 배율이 100이 아니면** Exact100X는 의도대로 돌지
  // 않는다. 그리고 그 셋은 주문을 내 보기 전에 알 수 있다.
  //
  // ★ **설정을 바꾸지 않는다.** 모드·배율·마진 타입의 변경 API를 부르지
  //   않는다. 진단이 설정을 고쳐 놓으면 "진단했더니 통과"가 진단이 만든
  //   결과가 되고, 사람은 원래 상태를 영영 못 본다.

  // ── 9. 포지션 모드 ──
  {
    const { getFuturesPositionMode } = await import('@/lib/exchanges/binanceFutures');
    const t0 = Date.now();
    const m = await getFuturesPositionMode(apiKey, secret, testnet)
      .catch((e: any) => ({ mode: null as null, error: e?.message || String(e) }));
    const v = positionModeVerdict(m);
    checks.push({
      name: '포지션 모드 (단방향)', ok: statusToOk(v.status), detail: v.reason,
      ms: Date.now() - t0, status: v.status, code: `POSITION_MODE:${v.code}`,
    });
  }

  // ── 10. 격리 · 배율 ──
  //
  //   요구 배율을 여기에 적지 않는다. 실행 프로필(`EXACT_100X`의
  //   `MAX_LEV_100X`)이 정본이고 그 값을 읽어 넘긴다 — 숫자를 두 곳에
  //   두면 표에 적힌 값과 검사하는 값이 갈린다.
  {
    const expectedLeverage = overrideOf('MAX_LEV_100X', 'EXACT_100X').leverage;
    const t0 = Date.now();
    const { getFuturesSymbolSettings } = await import('@/lib/exchanges/binanceFutures');
    const st = await getFuturesSymbolSettings(apiKey, secret, testnet, 'BTCUSDT')
      .catch(() => ({ ok: false, marginType: null, leverage: null,
        positionAmt: null, error: '설정 조회가 실패했습니다' }));
    const v = isolationVerdict({
      read: st.ok === true,
      marginType: st.marginType,
      leverage: st.leverage,
      // 정본에서 못 읽으면 `undefined`가 넘어가고, 판정은 그것을
      // UNKNOWN으로 떨어뜨린다 — 0으로 메워 "일치"를 만들지 않는다.
      expectedLeverage: expectedLeverage as number,
    });
    checks.push({
      name: '격리 마진 · 요구 배율 (BTCUSDT)',
      ok: statusToOk(v.status),
      detail: v.reason + (st.error ? ` (${st.error})` : ''),
      ms: Date.now() - t0, status: v.status, code: `ISOLATION:${v.code}`,
    });
  }

  // ── 11. 출금 권한의 증거 수준 ──
  //
  //   값이 아니라 **증거 수준**을 적는다. TESTNET 등록 경로는 출금
  //   권한을 거래소에 묻지 않고 상수 false로 적는다. 그 false를 초록으로
  //   보여 주면 확인한 적 없는 것을 확인했다고 적는 셈이다.
  //   저장 로직과 스키마는 이번 변경에서 건드리지 않는다.
  {
    const v = withdrawalEvidence({
      testnet, declaredHasWithdrawal: conn.has_withdrawal,
    });
    checks.push({
      name: '출금 비허용 (확인 수준)', ok: statusToOk(v.status), detail: v.reason,
      ms: 0, status: v.status, code: `WITHDRAWAL:${v.code}`,
    });
  }

  // ── 전체 판정 — **모르는 것이 있으면 READY가 아니다** ──
  //
  //   예전 응답의 `verdict`는 `successRate === 100 ? 'ready' : …`였다.
  //   그 식에서는 "확인하지 못함"이 분모만 늘려서 FAIL과 구별되지
  //   않았다. 다음 할 일이 전혀 다른 둘을 같은 칸에 적던 것이다.
  const readiness = overallDiagnoseVerdict(checks);

  const passed = checks.filter(c => c.ok).length;
  const total = checks.length;
  const successRate = total > 0 ? Math.round((passed / total) * 100) : 0;

  // ── 무엇이 원인인지 읽어 준다 ──
  //
  // 표만 주면 사용자가 다시 해석해야 한다. 패턴은 정해져 있다.
  // **모르는 패턴이면 모른다고 한다.**
  const at = (p: string) => deep.checks.find(c => c.path === p)?.ok === true;
  const timeOk = at('/fapi/v1/time');
  const readOk = at('/fapi/v2/balance');
  const oneOk = at('/fapi/v1/order');
  const listOk = at('/fapi/v1/openOrders') || at('/fapi/v1/allOrders');

  let cause: string;
  if (!timeOk) {
    cause = '거래소에 아예 닿지 못했습니다 — 네트워크나 호스트 문제이고 키와 무관합니다.';
  } else if (!readOk && !oneOk && !listOk) {
    cause = '서명이 필요한 요청이 전부 막혔습니다 — 키·환경(테스트넷/실전)·IP 중 하나입니다. '
      + '권한만 문제였다면 잔고는 읽혔을 것입니다.';
  } else if (readOk && !oneOk && listOk) {
    cause = '잔고와 주문 목록은 읽히는데 단건 주문 조회만 막혔습니다 — 키도 환경도 IP도 정상입니다. '
      + '이 엔드포인트가 이 환경(데모)에서 동작하지 않는 것이고, 앱은 목록 조회로 우회해 중복을 확인합니다.';
  } else if (readOk && !listOk) {
    cause = '잔고는 읽히는데 주문 계열 조회가 막혔습니다 — 선물 거래 권한을 확인하세요.';
  } else if (readOk && oneOk && listOk) {
    cause = '주문 계열까지 전부 정상입니다. 주문이 막힌다면 원인은 인증이 아닙니다.';
  } else {
    cause = '흔치 않은 조합입니다 — 위 표를 그대로 보고하세요.';
  }

  return NextResponse.json({
    testnet, checks, passed, total, successRate,
    // 옛 칸은 **그대로 둔다** — 화면이 이것을 읽고 있고, 이 변경의
    // 목적은 판정을 더 정확히 적는 것이지 화면을 깨는 것이 아니다.
    verdict: successRate === 100 ? 'ready' : successRate >= 60 ? 'partial' : 'failed',
    // ★ 새 정본. READY는 **FAIL 0 · UNKNOWN 0**일 때만 나온다.
    readiness,
    // 기계가 읽는 항목별 코드. 문구가 바뀌어도 이것은 안 바뀐다.
    itemCodes: checks.map(c => ({ name: c.name, status: c.status ?? 'UNKNOWN', code: c.code ?? null })),
    // TESTNET 호스트만 공개한다. API 키 일부라도 응답에 싣지 않는다.
    host: deep.host,
    stopSupport,
    cause,
    at: Date.now(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

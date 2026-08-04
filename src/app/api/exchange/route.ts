// /api/exchange — 거래소 연결 관리
// POST actions: connect / test / delete / toggle-auto / toggle-paper
// GET  actions: list / balances
//
// 보안:
// - api_secret은 AES-GCM 암호화 후 DB 저장
// - 응답에서 암호화된 필드는 제거
// - RLS + service_role
// - 출금 권한 있는 키는 등록 거부
import { NextRequest, NextResponse } from 'next/server';
import { encryptSecret, decryptSecret, maskKey } from '@/lib/exchanges/crypto';
import { testExchange, getExchangeBalances } from '@/lib/exchanges/router';
import { EXCHANGE_META } from '@/lib/exchanges/types';
import type { ExchangeId, ConnectPayload } from '@/lib/exchanges/types';
import { getSupabaseAdmin, resolveUserId, serviceRoleKeyRole } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MEM_STORE: any[] = [];   // supabase 미설정 시 fallback

/** 응답 직전 암호화 필드 제거 + 표준 형식으로 정규화 */
function safeConn(row: any) {
  if (!row) return row;
  const { encrypted_secret, encrypted_passphrase, api_secret_enc, api_passphrase_enc, api_key, ...safe } = row;
  // 클라이언트가 기대하는 필드명으로 매핑
  return {
    id:                row.id,
    exchange:          row.exchange_id ?? row.exchange,
    nickname:          row.label ?? row.nickname ?? '',
    apiKeyMasked:      row.api_key_masked ?? '****',
    hasPassphrase:     !!row.api_passphrase_enc,
    permissions: {
      read:       !!row.perm_read,
      trading:    !!row.perm_trading,
      withdrawal: !!row.has_withdrawal,
    },
    status:             row.is_active === false ? 'error' : 'active',
    lastTestAt:         row.last_tested_at ?? null,
    lastTestResult:     row.test_status ?? null,
    autoTradingEnabled: !!row.auto_trading_enabled,
    isPaper:            row.is_paper !== false,    // 기본 true

    // **이 프로젝트 전체의 규칙: `is_testnet === false`일 때만 실전이다.**
    // 모르는 값을 실전으로 읽으면 설정이 덜 된 계정이 곧바로 실계좌가 된다.
    isTestnet:          row.is_testnet !== false,

    // 스네이크 케이스 그대로도 내보낸다.
    //
    // 이게 빠져 있어서 화면의 모드 분류가 통째로 죽어 있었다:
    // `lib/markets/tradeMode.ts`의 isLiveConnection·connectionsFor는
    // `is_testnet`·`has_withdrawal`을 보는데 응답에 그 이름이 없었다.
    // 결과가 조용해서 더 나빴다 —
    //   · 모든 연결이 '테스트넷'으로 분류돼 **실전 탭에는 언제나
    //     "실전 연결이 없습니다"**가 떴다 (실전 매매가 아예 막혀 있었다)
    //   · 반대로 **실전 키가 테스트넷 탭에서 선택 가능**했다. 화면에는
    //     '테스트넷 계좌'라고 적힌 채로 주문은 실계좌로 나간다
    //   · 출금 권한 키를 목록에서 빼는 필터(`!c.has_withdrawal`)도
    //     아무것도 거르지 않고 있었다
    is_testnet:         row.is_testnet !== false,
    has_withdrawal:     !!row.has_withdrawal,

    // ── exchange_id·label도 스네이크 케이스로 내보낸다 ──
    //
    // **이게 빠져서 매매 화면에 원시 UUID가 떴다:**
    //
    //   "고른 연결이 이 모드에 맞지 않아 테스트넷 연결 cd7fd4be(으)로 주문합니다"
    //
    // 이 문장은 **앱이 다른 계좌로 바꿔서 주문한다**는 뜻이다. 어느 계좌인지
    // 모르면 확인할 방법이 없는데, 정작 식별자가 식별을 못 했다.
    //
    // 원인은 위쪽 매핑이다 — exchange_id를 `exchange`로, label을 `nickname`으로
    // 이름을 바꿔 내보내고 있었다. tradeMode의 labelOf는 `exchange_id`·`label`을
    // 보므로 둘 다 undefined였고, 그래서 마지막 가지(id 앞자리)로 떨어졌다.
    // is_testnet·has_withdrawal이 같은 이유로 빠져 있던 것을 이미 한 번 고쳤는데,
    // 그때 이 둘은 같이 넣지 않았다.
    exchange_id:        row.exchange_id ?? row.exchange ?? null,
    label:              row.label ?? row.nickname ?? null,

    createdAt:          row.created_at ?? null,
  };
}

async function getConn(id: string | null, userId: string, sb: any) {
  if (!id) return null;
  if (sb) {
    const { data } = await (sb.from('exchange_connections') as any).select('*').eq('id', id).eq('user_id', userId).single();
    return data ?? null;
  }
  return MEM_STORE.find(r => r.id === id && r.user_id === userId) ?? null;
}

// ── POST ─────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const { action } = body;

  const uid = await resolveUserId(
    req.headers.get('authorization'),
    req.headers.get('x-user-id'),
    req.headers.get('x-dev-token')
  );
  if (!uid) return NextResponse.json({ error: '인증 필요' }, { status: 401 });

  const sb = getSupabaseAdmin();

  // ── CONNECT ───────────────────────────────────────────────
  if (action === 'connect') {
    const { exchange, apiKey, apiSecret, passphrase, nickname, isTestnet } = body as ConnectPayload & { action: string; isTestnet?: boolean };
    if (!exchange || !apiKey || !apiSecret) {
      return NextResponse.json({ error: 'exchange, apiKey, apiSecret 필수' }, { status: 400 });
    }
    if (!EXCHANGE_META[exchange as ExchangeId]) {
      return NextResponse.json({ error: '지원하지 않는 거래소' }, { status: 400 });
    }

    // ── 어느 환경의 키인가를 **판별한다** ─────────────────────
    //
    // 테스트넷 키와 실전 키는 물리적으로 다른 키다. 같은 키로 양쪽을 쓸 수
    // 없다. 즉 이건 사용자가 고르는 '모드'가 아니라 **그 키의 성질**이다.
    //
    // 그런데 지금까지는 사람에게 물었고, 사람은 틀렸다:
    //   · Gate에는 선택지조차 없어서 전부 실전으로 저장 → 테스트넷 키가 401
    //   · 바이낸스는 실전으로 등록했는데 키는 테스트넷 → 연결 테스트는 실패,
    //     테스트넷 진단은 5/5 통과라는 이상한 상태
    // 둘 다 원인이 같다. **묻지 않으면 틀릴 수 없다.**
    //
    // 그래서 고른 쪽을 먼저 시도하고, 실패하면 반대쪽도 시도한다. 반대쪽이
    // 통하면 그쪽이 정답이고 그 사실을 응답에 적는다 — 조용히 바꾸지 않는다.
    // 사용자가 '실전'이라고 믿는 연결이 테스트넷이 되는 것은 그 반대만큼
    // 나쁘다.
    const canDetect = ['binance', 'gate'].includes(String(exchange));
    const first = isTestnet !== false;
    let usedTestnet = first;
    let testResult;
    let switched = false;
    try {
      testResult = await testExchange(exchange as ExchangeId, apiKey, apiSecret, passphrase, first);
      if (!testResult.success && canDetect) {
        const alt = await testExchange(exchange as ExchangeId, apiKey, apiSecret, passphrase, !first);
        if (alt.success) { testResult = alt; usedTestnet = !first; switched = true; }
      }
    } catch (e) {
      return NextResponse.json({
        error: e instanceof Error ? e.message : '검증 실패',
      }, { status: 400 });
    }

    if (!testResult.success) {
      return NextResponse.json({
        error: `연결 테스트 실패: ${testResult.message}`
          + (canDetect ? ' (테스트넷·실전 양쪽 모두 시도했습니다)' : ''),
      }, { status: 400 });
    }

    // 출금 권한 거부 (안전)
    if (testResult.permissions?.withdrawal) {
      return NextResponse.json({
        error: '출금 권한이 있는 API 키는 등록할 수 없습니다.\n거래소에서 출금 권한을 제거한 후 다시 시도하세요.',
        code:  'WITHDRAWAL_PERMISSION_DENIED',
      }, { status: 403 });
    }

    let encSecret: string, encPass: string | null = null;
    try {
      encSecret = encryptSecret(apiSecret);
      if (passphrase) encPass = encryptSecret(passphrase);
    } catch (e) {
      return NextResponse.json({
        error: e instanceof Error ? e.message : '암호화 실패',
      }, { status: 500 });
    }

    const meta = EXCHANGE_META[exchange as ExchangeId];
    const record = {
      user_id:             uid,
      exchange_id:         exchange,
      exchange:            exchange,                       // 옛 컬럼 호환 (not-null 대비)
      label:               nickname ?? meta.nameKr,
      nickname:            nickname ?? meta.nameKr,        // 옛 컬럼 호환
      api_key:             apiKey,                         // 평문 보관 (key는 시크릿이 아니라 식별자)
      api_key_encrypted:   apiKey,                         // 옛 컬럼 호환
      api_key_masked:      maskKey(apiKey),
      api_secret_enc:      encSecret,                      // 암호화
      encrypted_secret:    encSecret,                      // 옛 컬럼 호환
      api_passphrase_enc:  encPass,                        // 암호화 (선택)
      encrypted_passphrase: encPass,                       // 옛 컬럼 호환
      has_withdrawal:      !!testResult.permissions?.withdrawal,
      perm_read:           !!testResult.permissions?.read,
      permission_read:     !!testResult.permissions?.read, // 옛 컬럼 호환
      perm_trading:        !!testResult.permissions?.trading,
      is_active:           true,
      auto_trading_enabled: false,
      is_paper:            true,                           // 기본 모의
      // 사용자가 고른 값이 아니라 **실제로 통한 쪽**을 저장한다.
      is_testnet:          usedTestnet,
      last_tested_at:      new Date().toISOString(),
      test_status:         testResult.message,
    };

    if (sb) {
      // insert 시도 → 없는 컬럼/제약 에러나면 자동 보정 후 재시도
      let rec: any = { ...record };
      let lastErr = '';
      for (let attempt = 0; attempt < 6; attempt++) {
        const { data, error } = await (sb
          .from('exchange_connections') as any)
          .upsert(rec, { onConflict: 'user_id,exchange_id' })
          .select()
          .single();
        if (!error) {
          return NextResponse.json({
            success: true,
            connection: safeConn(data),
            testResult: { success: true, message: testResult.message, latencyMs: testResult.latencyMs },
          });
        }
        lastErr = error.message || '';
        // "Could not find the 'X' column" → 그 컬럼 제거 후 재시도
        const m = lastErr.match(/find the '([^']+)' column/);
        if (m && rec[m[1]] !== undefined) { delete rec[m[1]]; continue; }
        // ON CONFLICT 제약 없음 → onConflict 없이 일반 insert로
        if (/ON CONFLICT/i.test(lastErr)) {
          const { data: d2, error: e2 } = await (sb.from('exchange_connections') as any).insert(rec).select().single();
          if (!e2) return NextResponse.json({
            success: true, connection: safeConn(d2),
            testResult: { success: true, message: testResult.message },
            // 고른 것과 실제가 달랐으면 **그 사실을 말한다.** 조용히 바꾸면
            // 사용자가 '실전'이라고 믿는 연결이 테스트넷이 되고, 그 반대도 된다.
            detected: { isTestnet: usedTestnet, switched,
              message: switched
                ? `입력한 키는 ${usedTestnet ? '테스트넷' : '실전'} 키였습니다 — ${usedTestnet ? '테스트넷' : '실전'}으로 등록했습니다.`
                : null },
          });
          lastErr = e2.message || lastErr;
          break;
        }
        break;
      }
      // RLS 위반 = admin 클라이언트가 service_role이 아님 (보통 SERVICE_ROLE_KEY에 anon 키를 넣음)
      if (/row-level security|row level security/i.test(lastErr)) {
        const role = serviceRoleKeyRole();
        const hint = role === 'anon'
          ? 'SUPABASE_SERVICE_ROLE_KEY에 anon/publishable 키가 들어가 있습니다. Supabase→Settings→API의 service_role(secret) 키로 교체 후 재배포하세요.'
          : role === 'missing'
          ? 'SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다.'
          : role === 'service_role'
          ? 'service_role 키는 맞지만 RLS에 막혔습니다. exchange_connections_rls.sql 정책을 실행하세요.'
          : 'SUPABASE_SERVICE_ROLE_KEY가 JWT 형식이 아닙니다 — 키가 잘렸거나 공백/줄바꿈이 섞였을 수 있습니다. 신형 키라면 sb_secret_... 인지, 구형이면 service_role JWT 전체를 다시 복사하세요.';
        return NextResponse.json({ error: `RLS 정책에 막힘: ${hint}`, code: 'RLS_DENIED', keyRole: role }, { status: 500 });
      }
      return NextResponse.json({ error: lastErr || '저장 실패' }, { status: 500 });
    }

    const saved = { ...record, id: 'mem-' + Date.now(), created_at: new Date().toISOString() };
    MEM_STORE.push(saved);
    return NextResponse.json({
      success: true,
      connection: safeConn(saved),
      testResult: { success: true, message: testResult.message, latencyMs: testResult.latencyMs },
    });
  }

  // ── TEST ──────────────────────────────────────────────────
  if (action === 'test') {
    const { connectionId } = body;
    const conn = await getConn(connectionId, uid, sb);
    if (!conn) return NextResponse.json({ error: '연결을 찾을 수 없습니다' }, { status: 404 });

    let secret: string, pass: string | undefined;
    try {
      secret = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '');
      pass   = conn.api_passphrase_enc ? decryptSecret(conn.api_passphrase_enc) : undefined;
    } catch (e) {
      return NextResponse.json({
        success: false,
        message: e instanceof Error ? e.message : 'decrypt_failed',
      });
    }

    const apiKey = conn.api_key ?? '';
    if (!apiKey) {
      return NextResponse.json({
        success: false,
        message: 'API 키가 저장돼있지 않습니다. 다시 연결해주세요',
      });
    }

    let result;
    try {
      // **이 연결의 환경으로 물어본다.**
      //
      // 마지막 인자를 안 넘기고 있었다. isTestnet은 optional이라 undefined면
      // falsy — 즉 '연결 테스트' 버튼은 연결이 테스트넷이든 아니든 **언제나
      // 실전 호스트**에 물어봤다. 테스트넷 키로 실전에 물으면 서명이 안
      // 맞아 401이 오고, 화면에는 "키가 틀렸거나 / 반대쪽 키이거나 / IP
      // 제한"이라고 뜬다. 셋 다 아닌데도.
      //
      // 등록(connect)은 이 값을 제대로 넘기고 있었다. 그래서 **등록은
      // 되는데 연결 테스트만 실패하는** 상태가 만들어졌다 — 사용자가
      // 원인을 찾을 수 없는 조합이다.
      //
      // `!== false`는 이 프로젝트 공통 규칙이다(모르는 값은 테스트넷).
      result = await testExchange(
        conn.exchange_id ?? conn.exchange, apiKey, secret, pass,
        conn.is_testnet !== false,
      );
    } catch (e) {
      result = { success: false, message: e instanceof Error ? e.message : '테스트 실패' };
    }

    if (sb) {
      await (sb.from('exchange_connections') as any).update({
        is_active:       result.success,
        last_tested_at:  new Date().toISOString(),
        test_status:     result.message,
        perm_read:       !!result.permissions?.read,
        perm_trading:    !!result.permissions?.trading,
      }).eq('id', connectionId).eq('user_id', uid);
    }

    return NextResponse.json({
      success: result.success,
      message: result.message,
      latencyMs: result.latencyMs,
    });
  }

  // ── DELETE ────────────────────────────────────────────────
  if (action === 'delete') {
    const { connectionId } = body;
    if (sb) {
      await (sb.from('exchange_connections') as any).delete().eq('id', connectionId).eq('user_id', uid);
    } else {
      const idx = MEM_STORE.findIndex(r => r.id === connectionId);
      if (idx >= 0) MEM_STORE.splice(idx, 1);
    }
    return NextResponse.json({ success: true });
  }

  // ── TOGGLE AUTO ────────────────────────────────────────────
  // 자동매매 활성화는 안전 게이트
  if (action === 'toggle-auto') {
    const { connectionId, enabled } = body;
    const conn = await getConn(connectionId, uid, sb);
    if (!conn) return NextResponse.json({ error: '연결을 찾을 수 없습니다' }, { status: 404 });

    if (enabled === true) {
      // 출금 권한 키는 모든 모드에서 거부 (안전)
      if (conn.has_withdrawal === true) {
        return NextResponse.json({ error: '출금 권한이 있는 API 키는 자동매매에 사용할 수 없습니다.\n출금 권한 없는 키로 재연결하세요.' }, { status: 403 });
      }
      const isTestnet = conn.is_testnet === true;
      const isMock = !isTestnet && conn.is_paper === true;   // 순수 내부 모의
      // 디버깅용 — 권한 응답 상태를 로그로 (Vercel Function Logs에서 확인)
      console.log('[toggle-auto] mode=%s testnet=%s paper=%s perm_trading=%s perm_read=%s has_withdrawal=%s',
        isMock ? 'MOCK' : isTestnet ? 'TESTNET' : 'LIVE', conn.is_testnet, conn.is_paper, conn.perm_trading, conn.perm_read, conn.has_withdrawal);

      if (isMock) {
        // MOCK: 실제 거래소 거래 권한 검사하지 않음 (로컬 자동매매만)
      } else if (isTestnet) {
        // TESTNET: 선물 테스트넷 연결이 이미 검증됨 → 거래 가능으로 간주
        // (과거 버전에서 perm_trading이 false로 저장됐어도 테스트넷은 허용 — 가짜 자금)
      } else {
        // LIVE: 실거래 권한 필수
        if (!conn.perm_trading) {
          return NextResponse.json({ error: '실전(LIVE) 자동매매에는 거래(trading) 권한이 필요합니다.\nBinance에서 Futures 거래 권한을 활성화한 뒤 재연결하세요.' }, { status: 403 });
        }
      }
    }

    if (sb) {
      await (sb.from('exchange_connections') as any)
        .update({ auto_trading_enabled: !!enabled })
        .eq('id', connectionId).eq('user_id', uid);
    } else {
      const r = MEM_STORE.find(x => x.id === connectionId);
      if (r) r.auto_trading_enabled = !!enabled;
    }
    return NextResponse.json({ success: true, enabled: !!enabled });
  }

  // ── TOGGLE PAPER ───────────────────────────────────────────
  if (action === 'toggle-paper') {
    const { connectionId, isPaper } = body;
    if (sb) {
      await (sb.from('exchange_connections') as any)
        .update({ is_paper: !!isPaper })
        .eq('id', connectionId).eq('user_id', uid);
    } else {
      const r = MEM_STORE.find(x => x.id === connectionId);
      if (r) r.is_paper = !!isPaper;
    }
    return NextResponse.json({ success: true, isPaper: !!isPaper });
  }

  // 이미 등록한 연결의 테스트넷 여부를 바꾼다.
  //
  // 왜 필요한가: 실전으로 등록해 놓고 실제로는 테스트넷 키인 경우가 흔하다
  // (연결 테스트는 실패하는데 테스트넷 진단은 통과하는 상태). 지금까지는
  // **지우고 다시 만드는 수밖에 없었다** — 키를 다시 붙여넣어야 하고, 그
  // 과정에서 실전 키를 잘못 넣을 위험이 새로 생긴다.
  //
  // 자동매매는 **끈다.** 어느 계좌를 향하는지가 바뀌었는데 켜진 채로 두면,
  // 다음 신호가 사용자가 확인하지 않은 계좌로 나간다.
  if (action === 'set-testnet') {
    const { connectionId, isTestnet } = body;
    if (!connectionId) return NextResponse.json({ error: 'missing_params' }, { status: 400 });
    const next = isTestnet === true;
    if (sb) {
      // 컬럼 이름은 `auto_trading_enabled`다. 한동안 `auto_trading`으로
      // 잘못 적어서 이 요청이 통째로 실패했다 — 덕분에 환경도 안 바뀌었다.
      // 그게 오히려 맞는 결과였다: 자동매매를 못 끄는데 환경만 바뀌면,
      // 다음 신호가 사용자가 확인하지 않은 계좌로 나간다. 그래서 지금도
      // **한 번의 update로 묶어 둔다** — 둘 중 하나만 되는 상태를 만들지 않는다.
      const { error } = await (sb.from('exchange_connections') as any)
        .update({ is_testnet: next, auto_trading_enabled: false })
        .eq('id', connectionId).eq('user_id', uid);
      if (error) {
        return NextResponse.json({
          error: `환경을 바꾸지 못했습니다: ${error.message}`,
          // 무엇이 안 바뀌었는지 분명히 한다. '실패했다'만 적으면 사용자는
          // 반쯤 바뀌었을까 봐 확인할 방법을 찾게 된다.
          message: '아무것도 바뀌지 않았습니다 — 연결은 그대로입니다.',
        }, { status: 500 });
      }
    } else {
      const r = MEM_STORE.find(x => x.id === connectionId);
      if (!r) return NextResponse.json({ error: '연결을 찾을 수 없습니다' }, { status: 404 });
      r.is_testnet = next;
      (r as any).auto_trading_enabled = false;
    }
    return NextResponse.json({
      success: true, isTestnet: next,
      message: next
        ? '테스트넷으로 바꿨습니다. 자동매매는 꺼졌습니다 — 연결 테스트로 확인한 뒤 다시 켜세요.'
        : '⚠️ 실전으로 바꿨습니다. 이제 실제 자금이 사용됩니다. 자동매매는 꺼졌습니다 — 연결 테스트로 확인한 뒤 다시 켜세요.',
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

// ── GET ──────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') ?? 'list';

  const uid = await resolveUserId(
    req.headers.get('authorization'),
    req.headers.get('x-user-id'),
    req.headers.get('x-dev-token')
  );
  if (!uid) return NextResponse.json({ connections: [] });

  const sb = getSupabaseAdmin();

  if (action === 'list') {
    if (sb) {
      const { data, error } = await sb
        .from('exchange_connections')
        // is_testnet이 빠져 있었다 — 그래서 위 safeConn이 무엇을 어떻게
        // 매핑하든 결과가 늘 '테스트넷'이었다. 없는 칸은 조회하지 않으면
        // 기본값이 아니라 **모른다**가 되고, 여기서는 그게 사고였다.
        .select('id, exchange_id, label, api_key_masked, has_withdrawal, perm_read, perm_trading, is_active, auto_trading_enabled, is_paper, is_testnet, last_tested_at, test_status, api_passphrase_enc, created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false });
      if (error) return NextResponse.json({ error: error.message, connections: [] }, { status: 500 });
      return NextResponse.json({
        connections: (data ?? []).map(safeConn),
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({
      connections: MEM_STORE.filter(r => r.user_id === uid).map(safeConn),
    });
  }

  if (action === 'balances') {
    const connectionId = searchParams.get('id');
    const conn = await getConn(connectionId, uid, sb);
    if (!conn) return NextResponse.json({ error: '연결을 찾을 수 없습니다', balances: [] }, { status: 404 });

    let secret: string, pass: string | undefined;
    try {
      secret = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '');
      pass   = conn.api_passphrase_enc ? decryptSecret(conn.api_passphrase_enc) : undefined;
    } catch (e) {
      return NextResponse.json({
        error: e instanceof Error ? e.message : 'decrypt_failed',
        balances: [],
      }, { status: 500 });
    }

    const apiKey = conn.api_key ?? '';
    if (!apiKey) {
      return NextResponse.json({
        error: 'API 키가 저장돼있지 않습니다. 다시 연결해주세요',
        balances: [],
      }, { status: 400 });
    }

    let balances;
    try {
      balances = await getExchangeBalances(conn.exchange_id ?? conn.exchange, apiKey, secret, pass, conn.is_testnet === true);
    } catch (e) {
      return NextResponse.json({
        error: e instanceof Error ? e.message : '잔고 조회 실패',
        balances: [],
      }, { status: 500 });
    }

    return NextResponse.json({
      balances: balances.slice(0, 30),
      updatedAt: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

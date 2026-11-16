// src/app/api/venue/protective-order-support/route.ts
//
// **이 거래소·환경·심볼이 지금 손절(조건부 주문)을 받는가.**
//
// 왜 새 경로인가
// ──────────────
// 답은 이미 `/api/binance/futures/diagnose`가 계산하고 있었다. 그런데
// 그 경로는
//   · **거래소 연결** 화면에서만 부를 수 있고
//   · 사용자가 진단 버튼을 **직접 눌러야** 하고
//   · `showBinanceTestnetDiagnosis()`가 `binance && isTestnet === true`로
//     막아서 **실계좌에서는 아예 볼 수 없었다**
//
// 자동매매는 사람이 버튼을 누르는 동안 도는 것이 아니다. 최상위 규칙:
// 자동화할 수 있는 절차를 사람에게 넘기지 않는다.
//
// ★ 키를 쓰지 않는다
// ──────────────────
// `exchangeInfo`는 **공개 조회다** — API 키도 서명도 필요 없다. 이
// 경로는 사용자의 거래소 자격증명을 읽지도, 복호화하지도, 거래소에
// 보내지도 않는다. 읽는 것은 "이 사용자가 어느 거래소·환경을 쓰는가"
// 뿐이다(exchange_id · is_testnet).
//
// ★ 주문을 내지 않는다
// ────────────────────
// 조회만 한다. 그래서 수수료가 0이다. 지금까지는 이 사실을 알려면
// 진짜 주문을 내야 했고, 시도마다 진입·청산 수수료가 나갔다.
//
// ★ 아무것도 막지 않는다
// ──────────────────────
// 매매 정책을 바꾸지 않는다. 주문 경로에 관문을 더하지 않는다. 거래소가
// 목록에 적어 두고도 거절하는 경우가 있어서, 이 값만 보고 막으면 멀쩡한
// 진입을 막는다. **사실을 화면에 적을 뿐이다.**

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import {
  supportVerdict, summarize, type VenueProbe, type SupportVerdict,
} from '@/lib/ui/protectiveOrderSupport';

export const dynamic = 'force-dynamic';

/** 심볼을 안 주면 이것을 본다. 어느 심볼을 봤는지 응답에 반드시 적는다. */
const DEFAULT_SYMBOL = 'BTCUSDT';
/** 한 번에 물어볼 심볼 수 상한. 공개 조회라도 무한정 두드리지 않는다. */
const MAX_SYMBOLS = 8;
/** 거래소 주문 유형 목록은 자주 바뀌지 않는다. 같은 답을 반복해 묻지 않는다. */
const CACHE_MS = 5 * 60_000;

type CacheRow = { at: number; probe: VenueProbe };
const cache = new Map<string, CacheRow>();

/**
 * 공개 목록 조회로 물어볼 수 있는 거래소.
 *
 * **여기 없는 거래소는 '지원 안 함'이 아니라 '모름'이다.** 물어볼 길이
 * 없는 것과 물어봤더니 안 된다는 것은 다른 사실이고, 다음에 할 일도 다르다.
 */
const PROBEABLE = new Set(['binance']);

async function probe(exchange: string, testnet: boolean | null, symbol: string): Promise<VenueProbe> {
  const key = `${exchange}|${testnet}|${symbol}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.probe;

  if (!PROBEABLE.has(exchange)) {
    return {
      exchange, testnet, symbol, ok: false, unprobeable: true,
      detail: '이 거래소에는 주문 유형을 미리 알려주는 공개 조회가 없습니다',
    };
  }

  // 환경을 모르면 어느 호스트에 물어야 할지도 모른다. 찍지 않는다.
  if (testnet !== true && testnet !== false) {
    return {
      exchange, testnet, symbol, ok: false,
      detail: '이 연결이 테스트넷인지 실계좌인지 확인하지 못했습니다',
    };
  }

  try {
    const { futuresOrderTypes, FUTURES_HOSTS } = await import('@/lib/exchanges/binanceFutures');
    const host = testnet ? FUTURES_HOSTS.demo : FUTURES_HOSTS.live;
    const r = await futuresOrderTypes(host, symbol);
    const p: VenueProbe = {
      exchange, testnet, symbol,
      ok: r.ok, orderTypes: r.orderTypes, detail: r.detail,
    };
    cache.set(key, { at: Date.now(), probe: p });
    return p;
  } catch (e: any) {
    // 던진 것을 '지원 안 함'으로 적지 않는다. 캐시에도 넣지 않는다.
    return { exchange, testnet, symbol, ok: false, detail: String(e?.message || e) };
  }
}

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const raw = (req.nextUrl.searchParams.get('symbols') || '').trim();
  const symbols = raw
    ? Array.from(new Set(raw.split(',').map(x => x.trim().toUpperCase().replace('/', '')).filter(Boolean))).slice(0, MAX_SYMBOLS)
    : [DEFAULT_SYMBOL];

  // **키 컬럼을 고르지 않는다.** exchange_id와 is_testnet만 읽는다.
  const { data, error } = await sb
    .from('exchange_connections')
    .select('exchange_id, is_testnet')
    .eq('user_id', uid);

  if (error) {
    // 못 읽은 것을 "연결 없음"으로 적지 않는다.
    return NextResponse.json({
      ok: false, error: 'connections_unreadable',
      message: '거래소 연결 목록을 읽지 못했습니다 — 연결이 없다는 뜻이 아닙니다',
      venues: null, summary: null, symbols,
    }, { status: 200 });
  }

  // 선물 조건부 주문이 의미 있는 거래소만 본다. 현물 전용은 질문 자체가 다르다.
  const pairs = new Map<string, { exchange: string; testnet: boolean | null }>();
  for (const c of (data || [])) {
    const ex = String((c as any).exchange_id || '').toLowerCase();
    if (!ex || ex === 'kis') continue;
    const tn = (c as any).is_testnet;
    const testnet = tn === true ? true : tn === false ? false : null;
    pairs.set(`${ex}|${testnet}`, { exchange: ex, testnet });
  }

  const verdicts: SupportVerdict[] = [];
  const venues: Array<SupportVerdict & { exchange: string; testnet: boolean | null; symbol: string }> = [];
  for (const { exchange, testnet } of pairs.values()) {
    for (const symbol of symbols) {
      const p = await probe(exchange, testnet, symbol);
      const v = supportVerdict(p);
      verdicts.push(v);
      venues.push({ ...v, exchange, testnet, symbol });
    }
  }

  return NextResponse.json({
    ok: true,
    // 어느 심볼을 봤는지 반드시 적는다 — 안 적으면 거래소 전체에 대한
    // 답처럼 읽힌다.
    symbols,
    venues,
    summary: summarize(verdicts),
    note: '공개 조회입니다 — API 키를 쓰지 않고 주문도 내지 않습니다. 거래소가 목록에 적어 두고도 거절하는 경우가 있어, 이 값으로 주문을 막지는 않습니다',
  });
}

// src/lib/markets/instrumentRoute.ts
//
// **이 자산의 시세를 어디서 읽는가 — 못 정하면 상세를 열지 않는다.**
//
// 목록에는 코인·미국주식·지수·원자재·환율이 섞여 있다. 그런데 우리가
// 봉과 실시간 값을 실제로 읽을 수 있는 것은 바이낸스 **현물/선물**뿐이다
// (`fetchVenueBars` · `streamEndpoints`).
//
// 상세 화면을 아무 자산에나 열면 어떻게 되나: 차트가 비고, 가격이 `—`이고,
// 그 화면은 "이 자산은 거래가 없다"처럼 보인다. 오류는 나지 않는다.
//
// 그래서 **출처가 정해지는 것만** 새 상세로 보낸다. 나머지는 예전 창을
// 그대로 쓴다 — 없는 시세를 지어내느니 그게 낫다.

export interface DetailTarget {
  /** 거래소가 아는 심볼. `BTC` → `BTCUSDT` */
  symbol: string;
  market: 'SPOT' | 'USDM';
  name?: string;
}

/**
 * 결제통화로 쓰이는 이름들. **기초자산 이름이기도 하다** — 그게 함정이다.
 */
const QUOTES = ['USDT', 'USDC', 'BUSD', 'BTC', 'ETH'] as const;

/**
 * 이미 완성된 거래쌍인가.
 *
 * ★ 왜 `endsWith`만으로는 안 되는가
 * ─────────────────────────────────
 * 처음에는 `/USDT$|USDC$|BUSD$|BTC$|ETH$/`로 판정했다. 그런데 `BTC`와
 * `ETH`는 **결제통화이면서 동시에 기초자산 이름**이다. 그래서 목록의
 * `BTC` 한 종목이 "이미 완성된 쌍"으로 읽혔고, `BTCUSDT`가 아니라 `BTC`가
 * 그대로 나갔다.
 *
 *     BTC  → BTC     ← 거래소에 없는 심볼
 *     ETH  → ETH     ← 같은 문제
 *
 * 함수 주석에 적힌 계약(`BTC` → `BTCUSDT`)과 정면으로 어긋났고, 오류는
 * 나지 않는다. 그 심볼이 차트·호가·봉 조회로 그대로 흘러가서 **"거래가
 * 없는 종목"처럼 보인다.**
 *
 * 그래서 결제통화로 끝나는 것만으로는 부족하고, **그 앞에 기초자산이
 * 실제로 남아 있어야** 완성된 쌍이다.
 *
 *     ETHBTC  → 완성 (BTC 앞에 ETH가 있다)
 *     BTC     → 미완성 (BTC 앞에 아무것도 없다)
 */
export function isCompletePair(raw: string): boolean {
  const s = String(raw || '');
  return QUOTES.some(q => s.length > q.length && s.endsWith(q));
}

/**
 * 자산 레코드가 **종류를 적어 두는 이름들.** 실측해서 모았다.
 *
 * ★ 왜 목록이 이렇게 긴가 — 이름이 갈려 있어서 실제로 샜다
 * ────────────────────────────────────────────────────────
 * 예전에는 `category`·`type`·`kind` 셋만 읽었다. 그런데 이 저장소의
 * 자산 레코드가 실제로 쓰는 이름은 그 셋이 아니었다:
 *
 *     src/data/assets.ts        t: AssetType          ('coin' | 'stock' | …)
 *     WatchlistPage WL_DB       cat: 'stock'
 *     assetSearch · /api/search asset_type: 'stock'
 *
 * 그래서 미국주식 AMD 한 줄이 종류가 **안 적힌 것**으로 읽혔고, 아래
 * 규칙이 USDT를 붙여 `AMDUSDT` · 현물 상세를 열었다. 바이낸스에 없는
 * 심볼이라 시세·등락률·봉이 전부 실패하고, 봉 조회는 상류의 HTTP 400을
 * 그대로 안고 돌아왔다. 화면에는 **매수·매도 버튼이 그대로 있었다.**
 *
 * 즉 관문은 있었는데 **데이터가 쓰지 않는 이름을 보고 있었다.** 그래서
 * 이름 하나를 더하는 대신 **쓰이는 이름 전부**를 읽고, 모르면 통과시키지
 * 않는 쪽으로 바꿨다(`coinEvidence`).
 *
 * `id`는 일부러 넣지 않았다 — 그건 **정체(identity)이고 종류가 아니다.**
 * `constants.ts`의 장 시간표에 `{ id: 'coin', name: '코인' }` 같은 줄이
 * 있는데, 그건 자산이 아니라 시장 묶음의 이름이다.
 */
export const KIND_FIELDS = [
  'category', 'type', 'kind',
  'cat', 'asset_type', 'assetType', 't',
  'productType', 'assetClass',
] as const;

/** 이 값들만 "코인"이다. 나머지는 전부 코인이 아니다. */
const COIN_KINDS = new Set(['coin', 'crypto']);

export type CoinEvidence = 'COIN' | 'NOT_COIN' | 'UNKNOWN';

/**
 * 이 레코드가 코인이라는 **증거가 있는가.**
 *
 * 세 가지로만 답한다. `UNKNOWN`을 코인으로 적지 않는 것이 이 함수의
 * 전부다 — 예전 규칙은 "코인이 아니라고 적혀 있지 않으면 코인"이었고,
 * 그게 주식을 거래쌍으로 만들었다.
 *
 * 한 레코드에 종류가 여러 이름으로 적혀 있을 수 있다. 관심목록은
 * `{...WL_DB행, ...시세행}`으로 합쳐지므로 `cat`과 `t`가 함께 온다.
 * **하나라도 코인이 아니라고 말하면 코인이 아니다** — 먼저 찾은 것이
 * 이기게 하면 필드 순서가 판단을 바꾼다.
 */
export function coinEvidence(asset: any): CoinEvidence {
  if (!asset || typeof asset !== 'object') return 'UNKNOWN';
  let sawCoin = false;
  for (const f of KIND_FIELDS) {
    const v = (asset as any)[f];
    // 문자열이 아니면 종류가 아니다. `t`는 번역 함수 이름으로도 흔히
    // 쓰이는데, 함수를 String()으로 바꾸면 소스 글자가 나온다.
    if (typeof v !== 'string') continue;
    const k = v.trim().toLowerCase();
    if (!k) continue;
    if (!COIN_KINDS.has(k)) return 'NOT_COIN';
    sawCoin = true;
  }
  return sawCoin ? 'COIN' : 'UNKNOWN';
}

/**
 * 목록의 자산 하나를 상세 대상으로 바꾼다. **못 바꾸면 null.**
 *
 * 지금은 코인만이다. 주식은 `/api/stocks`가 따로 있고 봉 출처가 아직
 * 이어지지 않았다 — 이어지면 여기서 분기를 늘린다. 한 곳에서만 늘린다.
 */
export function detailTargetOf(asset: any): DetailTarget | null {
  if (!asset || typeof asset !== 'object') return null;

  // **양끝 공백을 떼고 읽는다.** 떼지 않으면 `'   '`가 빈 값이 아니라고
  // 읽혀 `'   USDT'`라는 심볼이 만들어진다 — 거래소에 없는 이름이고,
  // 조회는 조용히 빈 결과를 준다.
  const raw = String(asset.symbol ?? asset.id ?? '').trim().toUpperCase().replace('/', '');
  if (!raw) return null;

  // ★ **코인이라는 증거가 있을 때만 연다.**
  //
  // `UNKNOWN`은 통과가 아니다. 못 열면 바깥이 예전 `AssetDetailModal`로
  // 보내므로 사용자는 길을 잃지 않는다 — 없는 시세를 지어내는 쪽이 나쁘다.
  if (coinEvidence(asset) !== 'COIN') return null;

  // 이미 거래쌍이면 그대로, 아니면 USDT를 붙인다. 이 규칙은 거래소가
  // 정한 것이고 여기서 통화를 지어내지 않는다 — USDT 쌍이 없으면 그건
  // 아래 시세 조회가 실패로 말한다.
  const symbol = isCompletePair(raw) ? raw : `${raw}USDT`;

  return {
    symbol,
    // 목록에서 들어오는 길은 **현물**이다. 선물 상세는 거래 탭이 따로 연다.
    market: 'SPOT',
    name: typeof asset.name === 'string' && asset.name ? asset.name : undefined,
  };
}

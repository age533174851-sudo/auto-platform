// src/lib/research/barProvenance.ts
//
// **연구에 쓴 봉이 어디서 왔는지를 값으로 남긴다.**
//
// 왜 이것이 먼저인가
// ──────────────────
// #563 의 비교 실험은 "같은 시세·같은 비용에서 A~F 를 견준다"가 전제다.
// 그런데 지금 저장소에는 **시세 입력의 출처를 적는 자리가 없다.** 찾아봤다:
// `sha256`·입력 해시를 쓰는 코드는 전부 운영/마이그레이션 스크립트이고
// `src/lib/backtest/**` 와 시세 경로에는 0건이다.
//
// 그래서 지금은 성적표를 나중에 감사할 수 없다. 숫자가 좋아도 **그 숫자가
// 어떤 봉으로 나온 것인지 되짚을 방법이 없다.**
//
// 그리고 더 나쁜 쪽이 있다: #587 의 fixture 는 **합성**이다. 합성으로 낸
// 수를 `REAL`·`MEASURED` 로 적으면 그건 거짓 성적이다. 그 구분을 문서가
// 아니라 **코드가** 들고 있어야 한다.
//
// 이 파일이 하지 않는 것
// ──────────────────────
// **네트워크를 타지 않는다. 파일도 읽지 않는다.** 순수 함수뿐이다.
// 해시 함수도 받아서 쓴다(`Hasher`) — `node:crypto` 를 `src/lib` 안으로
// 끌고 오면 웹 번들이 그것을 따라오게 되고, 시험도 그 구현에 묶인다.
//
// **실행 경로는 이 파일을 import 하지 않는다.** `RESEARCH_MODULES` 에
// 등록해서 `check-research-isolation.mjs` 가 그것을 막는다 — 연구가
// 깨졌다고 실제 매매가 멈추면 안 된다.

/** 이 봉이 무엇인가. **기본값이 REAL 이 될 수 없다** */
export type DataKind = 'REAL' | 'SYNTHETIC' | 'NO_DATA';

/**
 * 데이터를 못 받은 이유. **경계 있는 코드만 담는다.**
 *
 * 응답 본문이나 URL 을 적지 않는다 — 거기에 키·토큰이 섞여 들어올 수
 * 있고, 이 기록은 요청보다 오래 남는다(`040_audit_events.sql` 과 같은 이유).
 */
export const NO_DATA_CODES = ['NETWORK_BLOCKED', 'HTTP_ERROR', 'EMPTY', 'NOT_ATTEMPTED'] as const;
export type NoDataCode = typeof NO_DATA_CODES[number];

export interface BarProvenance {
  kind: DataKind;
  /** 짧은 출처 이름(`binance-fapi` 등). **URL·키가 아니다** */
  source: string;
  symbol: string;
  interval: string;
  /** 언제 받았는가. **모르면 null — 지금 시각으로 메우지 않는다** */
  fetchedAtIso: string | null;
  /** 몇 줄인가. **모르면 null. 0 과 모름은 다른 사실이다** */
  rowCount: number | null;
  /** 내용 지문. **모르면 null** */
  digest: string | null;
  /** NO_DATA 일 때만 들어간다 */
  noDataCode: NoDataCode | null;
}

/** 해시 구현을 밖에서 받는다 — 이 파일은 `node:crypto` 를 모른다 */
export type Hasher = (text: string) => string;

export interface BarLike {
  openTime?: any; open?: any; high?: any; low?: any; close?: any; volume?: any;
}

/**
 * 숫자로 읽을 수 있는 값만 숫자로 읽는다.
 *
 * **처음 쓴 판은 `Number(v)` 한 줄이었고, 시험 J 가 그것을 잡았다.**
 * `Number(null)` 은 `0` 이고 `Number('')` 도 `0` 이다. 그래서 `openTime:
 * null` 인 봉이 **0번째 밀리초의 봉**으로 조용히 읽혔다 — 모르는 것을
 * 0 으로 적는 것, 이 저장소가 금지하는 바로 그 일이다.
 * `Number(true)` 는 1, `Number([])` 는 0, `Number([5])` 는 5 다.
 *
 * 그래서 **숫자와 문자열만** 받는다. 나머지 타입은 `null` 이다.
 */
function fin(v: any): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * 봉 묶음의 지문.
 *
 * **못 알아본 줄이 하나라도 있으면 `null` 이다.** 쓰레기를 해시하면
 * 지문은 생기는데 그 지문이 무엇을 가리키는지 아무도 모른다 — 있는 것처럼
 * 보이면서 아무것도 증명하지 않는 쪽이다.
 *
 * 정규화해서 직렬화한다: 필드 순서를 코드가 정하고, 숫자는 그대로 쓴다.
 * 그래야 같은 봉이 같은 지문을 낸다(재현성이 비교의 전제다).
 */
export function barsDigest(bars: readonly BarLike[] | null | undefined, hash: Hasher): string | null {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const rows: string[] = [];
  for (const b of bars) {
    const t = fin(b?.openTime), o = fin(b?.open), h = fin(b?.high);
    const l = fin(b?.low), c = fin(b?.close), v = fin(b?.volume);
    if (t == null || o == null || h == null || l == null || c == null || v == null) return null;
    rows.push(`${t},${o},${h},${l},${c},${v}`);
  }
  try { return hash(rows.join('\n')) || null; } catch { return null; }
}

function text(v: any): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 출처 기록 한 줄을 만든다.
 *
 * **`kind` 를 못 읽으면 `NO_DATA` 다.** 기본값을 `REAL` 로 두면 호출부가
 * 한 칸 빠뜨린 순간 합성·미확인 데이터가 실측으로 적힌다. 모르는 것을
 * 통과로 적지 않는다.
 */
export function provenanceOf(i: {
  kind?: any; source?: any; symbol?: any; interval?: any;
  fetchedAtIso?: any; bars?: readonly BarLike[] | null; rowCount?: any;
  digest?: any; noDataCode?: any;
}, hash?: Hasher): BarProvenance {
  const kind: DataKind = i?.kind === 'REAL' ? 'REAL'
    : i?.kind === 'SYNTHETIC' ? 'SYNTHETIC'
    : 'NO_DATA';

  const iso = text(i?.fetchedAtIso);
  const fetchedAtIso = iso && Number.isFinite(Date.parse(iso)) ? iso : null;

  const bars = Array.isArray(i?.bars) ? i.bars : null;
  const counted = fin(i?.rowCount);
  const rowCount = bars ? bars.length
    : counted != null && counted >= 0 ? Math.floor(counted)
    : null;

  const given = text(i?.digest);
  const digest = given ? given
    : bars && hash ? barsDigest(bars, hash)
    : null;

  const code = text(i?.noDataCode) as NoDataCode;
  const noDataCode = kind === 'NO_DATA'
    && (NO_DATA_CODES as readonly string[]).includes(code) ? code : null;

  return {
    kind, source: text(i?.source), symbol: text(i?.symbol), interval: text(i?.interval),
    fetchedAtIso, rowCount: kind === 'NO_DATA' ? null : rowCount, digest, noDataCode,
  };
}

export type MeasuredBlock =
  'OK' | 'SYNTHETIC' | 'NO_DATA' | 'NO_SOURCE' | 'NO_TIME' | 'NO_DIGEST'
  | 'ROWS_UNKNOWN' | 'EMPTY';

/**
 * 이 출처로 **실측(`MEASURED`)이라고 적어도 되는가.**
 *
 * 다섯 가지가 모두 있어야 한다: 실제 데이터 · 출처 이름 · 받은 시각 ·
 * 지문 · 1줄 이상. 하나라도 없으면 그 성적표는 "쟀다"가 아니라
 * "이렇게 나왔다고 한다" 다.
 *
 * **합성은 어떤 경우에도 통과하지 않는다.** 나머지 칸이 전부 채워져
 * 있어도 그렇다 — 합성 데이터로 낸 수를 실측으로 적는 것이 이 함수가
 * 막으려는 단 하나의 일이다.
 */
export function canClaimMeasured(p: BarProvenance | null | undefined):
  { ok: boolean; code: MeasuredBlock; reason: string } {
  if (!p) return { ok: false, code: 'NO_DATA', reason: '출처 기록이 없습니다 — 실측으로 적지 않습니다' };
  if (p.kind === 'SYNTHETIC') {
    return { ok: false, code: 'SYNTHETIC',
      reason: '합성 데이터입니다 — 계약 회귀에는 쓰지만 실측 성적으로 적지 않습니다' };
  }
  if (p.kind !== 'REAL') {
    return { ok: false, code: 'NO_DATA',
      reason: `데이터를 받지 못했습니다${p.noDataCode ? ` (${p.noDataCode})` : ''} — 0 이나 합성으로 메우지 않습니다` };
  }
  if (!p.source) return { ok: false, code: 'NO_SOURCE', reason: '출처 이름이 없습니다' };
  if (!p.fetchedAtIso) return { ok: false, code: 'NO_TIME', reason: '받은 시각이 없습니다' };
  if (!p.digest) return { ok: false, code: 'NO_DIGEST', reason: '내용 지문이 없습니다 — 나중에 같은 입력인지 되짚을 수 없습니다' };
  if (p.rowCount == null) {
    return { ok: false, code: 'ROWS_UNKNOWN',
      reason: '줄 수를 모릅니다 — 모름을 0 으로도, 충분함으로도 읽지 않습니다' };
  }
  if (p.rowCount <= 0) return { ok: false, code: 'EMPTY', reason: '봉이 0줄입니다' };
  return { ok: true, code: 'OK', reason: `실측 ${p.rowCount}줄 · ${p.source} · ${p.symbol} ${p.interval}` };
}

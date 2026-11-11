// src/lib/research/barProvenance.test.ts
//
// 이 파일이 막는 것: **합성으로 낸 수를 실측이라고 적는 것.**
//
// #563 의 지시가 그 말을 직접 합니다 — "연구 가격 데이터를 합성했을 경우
// `REAL` 또는 `MEASURED` 로 표시하지 마세요." 문서로만 두면 언젠가 한 칸이
// 비어서 통과한다. 그래서 값으로 못 박는다.

import { test, eq, assert } from '../../test/harness';
import {
  provenanceOf, canClaimMeasured, barsDigest, NO_DATA_CODES,
} from './barProvenance';
import { createHash } from 'crypto';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

const BARS = [
  { openTime: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 },
  { openTime: 2, open: 11, high: 13, low: 10, close: 12, volume: 120 },
];

const REAL = {
  kind: 'REAL', source: 'binance-fapi', symbol: 'BTCUSDT', interval: '1h',
  fetchedAtIso: '2026-11-11T06:00:00.000Z', bars: BARS,
};

export function runBarProvenanceTests(): void {

test('A. 실측 다섯 칸이 모두 차면 통과한다', () => {
  const p = provenanceOf(REAL, sha);
  eq(p.kind, 'REAL');
  eq(p.rowCount, 2);
  assert(!!p.digest, '지문이 없다');
  const v = canClaimMeasured(p);
  eq(v.ok, true, v.reason);
  eq(v.code, 'OK');
});

test('★ B. 합성은 어떤 경우에도 실측이 아니다', () => {
  // 나머지 칸을 전부 채워도 통과하지 않는다 — 이 함수의 단 하나의 일이다.
  const p = provenanceOf({ ...REAL, kind: 'SYNTHETIC' }, sha);
  eq(p.kind, 'SYNTHETIC');
  assert(!!p.digest && !!p.fetchedAtIso && p.rowCount === 2, '칸은 다 차 있어야 한다');
  const v = canClaimMeasured(p);
  eq(v.ok, false, '합성이 실측으로 통과했다');
  eq(v.code, 'SYNTHETIC');
});

test('★ C. kind 를 못 읽으면 NO_DATA 다 — REAL 이 기본값이 아니다', () => {
  for (const bad of [undefined, null, '', 'real', 'Real', 'MEASURED', 1, {}] as any[]) {
    const p = provenanceOf({ ...REAL, kind: bad }, sha);
    eq(p.kind, 'NO_DATA', `${String(bad)}를 ${p.kind} 로 읽었다`);
    eq(canClaimMeasured(p).ok, false);
  }
});

test('D. NO_DATA 는 줄 수를 0 으로 적지 않는다 — 모름이다', () => {
  const p = provenanceOf({ kind: 'NO_DATA', source: 'binance-fapi', noDataCode: 'NETWORK_BLOCKED' }, sha);
  eq(p.rowCount, null, '못 받은 것을 0줄로 적었다');
  eq(p.noDataCode, 'NETWORK_BLOCKED');
  const v = canClaimMeasured(p);
  eq(v.ok, false);
  assert(v.reason.includes('NETWORK_BLOCKED'), v.reason);
});

test('E. NO_DATA 사유는 화이트리스트 밖이면 담지 않는다', () => {
  for (const bad of ['HTTP 403 {"key":"sk-live"}', 'boom', '', null] as any[]) {
    const p = provenanceOf({ kind: 'NO_DATA', noDataCode: bad }, sha);
    eq(p.noDataCode, null, `${String(bad)}가 기록에 들어갔다`);
  }
  for (const good of NO_DATA_CODES) {
    eq(provenanceOf({ kind: 'NO_DATA', noDataCode: good }, sha).noDataCode, good);
  }
  // REAL 인데 사유 코드를 넘기면 담지 않는다 — 모순된 기록을 만들지 않는다.
  eq(provenanceOf({ ...REAL, noDataCode: 'EMPTY' }, sha).noDataCode, null);
});

test('★ F. 지문이 없으면 실측을 주장할 수 없다', () => {
  const p = provenanceOf({ ...REAL, bars: null, rowCount: 2 }, sha);
  eq(p.digest, null);
  eq(canClaimMeasured(p).code, 'NO_DIGEST');
});

test('G. 0줄과 모름을 구분한다', () => {
  const unknown = provenanceOf({ ...REAL, bars: null, rowCount: undefined, digest: 'd' }, sha);
  eq(unknown.rowCount, null);
  eq(canClaimMeasured(unknown).code, 'ROWS_UNKNOWN');
  const empty = provenanceOf({ ...REAL, bars: null, rowCount: 0, digest: 'd' }, sha);
  eq(empty.rowCount, 0);
  eq(canClaimMeasured(empty).code, 'EMPTY');
});

test('H. 출처 이름·받은 시각이 없으면 실측이 아니다', () => {
  eq(canClaimMeasured(provenanceOf({ ...REAL, source: '  ' }, sha)).code, 'NO_SOURCE');
  eq(canClaimMeasured(provenanceOf({ ...REAL, fetchedAtIso: '어제' }, sha)).code, 'NO_TIME');
  eq(canClaimMeasured(provenanceOf({ ...REAL, fetchedAtIso: '' }, sha)).code, 'NO_TIME');
});

test('★ I. 지문은 내용이 바뀌면 바뀌고, 같으면 같다', () => {
  const a = barsDigest(BARS, sha);
  const b = barsDigest(BARS.map(x => ({ ...x })), sha);
  eq(a, b, '같은 봉이 다른 지문을 냈다 — 재현성이 비교의 전제다');
  const moved = barsDigest([BARS[0], { ...BARS[1], close: 12.0001 }], sha);
  assert(moved !== a, '종가가 바뀌었는데 지문이 같다');
  const swapped = barsDigest([BARS[1], BARS[0]], sha);
  assert(swapped !== a, '순서가 바뀌었는데 지문이 같다');
});

test('★ J. 못 알아본 줄이 있으면 지문을 만들지 않는다', () => {
  // 쓰레기를 해시하면 지문은 생기는데 무엇을 가리키는지 아무도 모른다.
  for (const broken of [
    [{ ...BARS[0], close: undefined }],
    [{ ...BARS[0], volume: 'NaN' }],
    [{ ...BARS[0], openTime: null }],
    [BARS[0], { open: 1 }],
    // `Number(null)` — 0, `Number('')` — 0, `Number(true)` — 1, `Number([])` — 0.
    // 이 네 가지가 제 첫 판을 통과했다(`openTime: null` 이 0번째 밀리초가 됐다).
    [{ ...BARS[0], low: '' }],
    [{ ...BARS[0], high: true }],
    [{ ...BARS[0], open: [] }],
    [{ ...BARS[0], close: [5] }],
  ] as any[]) {
    eq(barsDigest(broken, sha), null, '쓰레기로 지문을 만들었다');
  }
  eq(barsDigest([], sha), null);
  eq(barsDigest(null, sha), null);
});

test('K. 해시가 던져도 터지지 않는다 — 지문만 없다', () => {
  const boom = () => { throw new Error('no crypto'); };
  eq(barsDigest(BARS, boom), null);
  eq(canClaimMeasured(provenanceOf(REAL, boom)).code, 'NO_DIGEST');
});

}

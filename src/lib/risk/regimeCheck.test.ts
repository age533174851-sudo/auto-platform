// src/lib/risk/regimeCheck.test.ts
//
// `collectRegime`은 진입 경로 다섯 곳이 부른다 (TradingView 웹훅 ·
// `/api/paper/run` · `/api/regime` · 일일 사다리 · 스캘프). 시험이 0건이었다.
//
// `src/lib/risk`의 시험 0건 모듈 다섯 중 세 번째다
// (#605 `collectLimits`, #606 `dailyLossCheck`에 이어).
//
// 막으려는 것 — 전부 이 파일이 자기 머리말에 적어 둔 약속이다
// ─────────────────────────────────────────────────────────
//  1. **필터가 켜져 있는데 시세를 못 받고도 진입을 여는 것.**
//     `judgeRegime(null, …)`은 `blockEntries: mode !== 'off'`다 —
//     켜져 있으면 막아야 한다. 확인하지 못한 것은 통과가 아니다
//  2. **부르는 쪽이 이미 실패해서 넘긴 `null`을 무시하고 다시 받아오는 것.**
//     `closes`를 넘겼으면(그 값이 `null`이어도) 여기서 받지 않는다 —
//     다시 받아 성공하면 부르는 쪽의 실패가 **가려진다**
//  3. 설정 오타를 조용히 삼키는 것 — 알 수 없는 값이면 필터를 켜지 않고
//     그 사실을 `note`에 적는다. 켜 둔 줄 알고 도는 상태가 가장 위험하다
//  4. 꺼져 있을 때 '모름'을 '정상'으로 적는 것
//
// `fetchDailyCloses`는 여기서 다루지 않는다 — 왜
// ───────────────────────────────────────────────
// 그 함수는 전역 `fetch`를 쓴다. 처음에는 `globalThis.fetch`를 바꿔 끼워
// 시험했는데, 하네스가 async 시험을 `Promise.all`로 **동시에** 돌리기
// 때문에 그 스텁이 **다른 시험으로 샜다** — 실측으로 저장소의 기존 시험
// 두 건이 깨졌다(`강제 진입이 승인된 100배 계획까지 간다`,
// `남은 차단은 신호가 아니라 위험 거부다`). 같은 이유로 두 스텁이 서로의
// 복원을 덮어 제 시험도 거짓 실패를 냈다.
//
// 전역을 만지는 시험은 이 하네스에서 안전하지 않다. 그래서 네트워크를
// 건드리지 않는 자리만 고정하고, `fetchDailyCloses`는 **덮지 못한 자리로
// 적어 둔다.** 통과로 적지 않는다.
import { test, eq, assert } from '../../test/harness';
import { collectRegime } from './regimeCheck';

const envWith = (mode?: string) => (key: string) =>
  (key === 'REGIME_FILTER' ? mode : undefined);

export function runRegimeCollectTests() {
  console.log('[국면 수집 — 시세를 못 받았는데 진입을 열지 않는다]');

  test('★★ 필터가 켜져 있고 시세를 못 받으면 진입을 막는다', async () => {
    for (const mode of ['any', 'trend_only', 'range_only']) {
      const f = await collectRegime({
        symbol: 'BTCUSDT', side: 'LONG', closes: null, env: envWith(mode),
      });
      eq(f.mode, mode, `${mode}: 모드를 다르게 읽었다`);
      eq(f.enabled, true, `${mode}: 켜져 있는데 enabled가 false다`);
      eq(f.verdict.status, 'unknown', `${mode}: 모름이 아니다`);
      eq(f.verdict.blockEntries, true,
        `${mode}: 시세를 못 받았는데 진입을 열었다 — 확인하지 못한 것은 통과가 아니다`);
    }
  });

  test('★★ 빈 배열도 "데이터 없음"으로 통과시키지 않는다', async () => {
    const f = await collectRegime({
      symbol: 'BTCUSDT', side: 'SHORT', closes: [], env: envWith('any'),
    });
    eq(f.verdict.status, 'unknown', '빈 배열로 국면을 판정했다');
    eq(f.verdict.blockEntries, true, '봉이 0개인데 진입을 열었다');
  });

  test('★ 필터가 꺼져 있으면 막지 않지만 모름이라고 말한다', async () => {
    const f = await collectRegime({
      symbol: 'BTCUSDT', side: 'LONG', closes: null, env: envWith(undefined),
    });
    eq(f.mode, 'off');
    eq(f.enabled, false, '꺼져 있는데 체크리스트에 항목을 넣는다');
    eq(f.verdict.status, 'unknown', '꺼져 있어도 모름은 모름이다 — ok로 적지 않는다');
    eq(f.verdict.blockEntries, false, '꺼져 있는데 막았다');
  });

  test('★★ 설정 오타를 조용히 삼키지 않는다', async () => {
    for (const typo of ['trendonly', 'ON', 'true', 'range']) {
      const f = await collectRegime({
        symbol: 'BTCUSDT', side: 'LONG', closes: null, env: envWith(typo),
      });
      eq(f.mode, 'off', `'${typo}'로 필터를 켰다`);
      eq(f.enabled, false, `'${typo}': enabled가 true다`);
      assert(f.note.length > 0,
        `'${typo}': 오타를 조용히 삼켰다 — 켜 둔 줄 알고 도는 상태가 된다`);
      // `readRegimeFilter`는 값을 소문자로 내린 뒤 적는다. 대소문자로 비교하면
      // 'ON' 같은 입력에서 거짓 실패가 난다 (처음에 그렇게 썼다).
      assert(f.note.includes(typo.toLowerCase()),
        `'${typo}': note에 무엇이 잘못됐는지 안 적혔다: ${f.note}`);
      assert(/trend_only/.test(f.note), `'${typo}': note에 가능한 값이 안 적혔다`);
    }
  });

  test('★ 올바른 값에는 note를 남기지 않는다 — 늘 경고하는 검사는 안 읽힌다', async () => {
    for (const mode of ['off', 'any', 'trend_only', 'range_only']) {
      const f = await collectRegime({
        symbol: 'BTCUSDT', side: 'LONG', closes: null, env: envWith(mode),
      });
      eq(f.mode, mode);
      eq(f.note, '', `${mode}: 정상 값인데 note를 남겼다`);
    }
  });

  test('★ 방향을 그대로 판정에 넘긴다', async () => {
    const up = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
    const long = await collectRegime({
      symbol: 'BTCUSDT', side: 'LONG', closes: up, env: envWith('trend_only'),
    });
    const short = await collectRegime({
      symbol: 'BTCUSDT', side: 'SHORT', closes: up, env: envWith('trend_only'),
    });
    // 같은 봉·같은 모드인데 방향만 다르다. 판정이 방향을 보지 않으면 같아진다.
    assert(long.verdict.status !== 'unknown', '상승 봉 60개로도 판정하지 못했다');
    assert(
      long.verdict.status !== short.verdict.status
      || long.verdict.reason !== short.verdict.reason,
      'LONG과 SHORT 판정이 완전히 같다 — 방향이 판정에 안 들어갔다',
    );
  });
}

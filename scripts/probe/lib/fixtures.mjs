// 프로브가 쓰는 서버 응답 fixture. **한 곳에만 둔다.**
//
// 왜 공유하나
// ───────────
// 예약 줄 하나로는 첫 줄이 ARMED가 되지 않는다. `autotradeHealth()`가
// 보는 전역 관문(자동 실행 열쇠·크론 열쇠·실전 잠금·연결 목적지·실행
// 기록)이 응답에 같이 있어야 한다. 그걸 모르는 fixture는 조용히 BLOCKED를
// 받고, 프로브를 쓰는 사람은 화면이 고장 난 줄 안다.
//
// 실제로 두 번 그랬다 — cockpit 프로브의 fixture를 고친 뒤에도 interaction
// 프로브의 fixture는 옛날 그대로여서, 관문 판정을 붙인 순간 2건이 FAIL로
// 돌아섰다. 화면은 맞고 fixture가 틀렸다.
//
// 같은 판단을 두 파일이 각자 들고 있으면 언젠가 갈린다. 그래서 여기 하나만
// 둔다.

/** 전역 관문이 전부 통과한 서버 응답. 이걸 안 펼치면 ARMED가 될 수 없다. */
export function healthyEnv() {
  return {
    adminSecretSet: true, cronSecretSet: true, liveUnlocked: true,
    liveGate: { env: 'production', reason: '' },
    marginColumnPresent: true, openTradeCount: 0, cronUtcHour: 23,
    runs: [{ status: 'ok', detail: '평가 완료', started_at: new Date().toISOString() }],
    exitRuns: [{ status: 'ok', detail: '감시 완료', started_at: new Date().toISOString() }],
    connections: [
      { id: 'c-1', is_testnet: true, exchange_id: 'binance', label: '테스트넷' },
      { id: 'c-live', is_testnet: false, exchange_id: 'binance', label: '실전' },
    ],
  };
}

/**
 * 예약 한 줄.
 *
 * `connection_id`가 없으면 '거래소 연결'이 bad가 되어 BLOCKED가 맞다.
 * 실전(`LIVE*`) 줄은 `connection_id: 'c-live'`로 넘겨야 한다 — 테스트넷
 * 연결에 물리면 '연결 목적지'가 막는 것이 옳다.
 */
export function scheduleRow(o = {}) {
  return {
    id: `s-${o.symbol || 'BTCUSDT'}`, symbol: 'BTCUSDT', enabled: true, mode: 'TESTNET',
    connection_id: 'c-1', interval_min: 60,
    last_run_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    connectionState: 'OK', strategyRunnable: true, strategyName: '계단식',
    runtime: { state: 'WATCHING', reason: '정상 평가 중' }, state: 'ACTIVE',
    ...o,
  };
}

/** 관문이 통과한 정상 응답 본문 */
export function okBody(schedules) {
  return { ok: true, ...healthyEnv(), schedules };
}

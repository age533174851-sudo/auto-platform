// src/lib/trading/chartLoadState.test.ts
//
// 실측에서 잡힌 세 결함을 여기서 고정한다:
//   ① 갱신 실패가 정상 캔들을 지웠다
//   ② 성공하는 갱신도 30초마다 전체 오버레이로 덮었다
//   ③ 간격 전환 실패 뒤 이전 간격 봉이 남으면 안 된다
import { test, eq, assert } from '../../test/harness';
import {
  phaseOnStart, phaseOnSuccess, phaseOnFailure, shouldClearBarsOnFailure,
  showsBlockingOverlay, isStale, staleNotice, barsMatchRequest, requestKeyOf,
} from './chartLoadState';

export function runChartLoadStateTests() {
  // ── ★ ① 갱신 실패가 봉을 지우지 않는다 ──
  test('★ 갱신이 실패해도 그려 둔 봉을 지우지 않는다 — 이것이 "차트 증발"이었다', () => {
    eq(shouldClearBarsOnFailure({ isSwitch: false }), false);
    eq(phaseOnFailure({ isSwitch: false, hasBars: true }), 'STALE');
    // 그리고 낡았다고 말한다
    assert(isStale('STALE'), 'STALE이 낡음으로 읽히지 않습니다');
    assert(/갱신 실패/.test(staleNotice('STALE') || ''), '낡음 사유가 없습니다');
  });

  test('갱신 실패인데 보여줄 것도 없으면 오류다', () => {
    eq(phaseOnFailure({ isSwitch: false, hasBars: false }), 'ERROR');
  });

  // ── ★ ② 보여줄 것이 있으면 덮지 않는다 ──
  test('★ 갱신 중에는 전체 오버레이를 띄우지 않는다 — 30초마다 깜빡이던 원인', () => {
    eq(phaseOnStart({ isSwitch: false, hasBars: true }), 'REFRESHING');
    eq(showsBlockingOverlay('REFRESHING'), false);
    eq(showsBlockingOverlay('STALE'), false);
    eq(showsBlockingOverlay('READY'), false);
  });

  test('★ 최초 로딩과 보여줄 것이 없을 때만 덮는다', () => {
    eq(showsBlockingOverlay('FIRST_LOAD'), true);
    eq(showsBlockingOverlay('ERROR'), true);
  });

  test('처음에는 그려 둔 것이 없으므로 최초 로딩이다', () => {
    eq(phaseOnStart({ isSwitch: false, hasBars: false }), 'FIRST_LOAD');
  });

  // ── ★ ③ 전환은 갱신과 다르다 ──
  test('★ 간격을 바꾸면 이전 간격 봉을 지운다 — 남겨 두면 다른 간격을 현재로 읽는다', () => {
    eq(phaseOnStart({ isSwitch: true, hasBars: true }), 'FIRST_LOAD');
    eq(phaseOnFailure({ isSwitch: true, hasBars: true }), 'ERROR');
    eq(shouldClearBarsOnFailure({ isSwitch: true }), true);
  });

  test('★ 전환 실패를 낡음으로 적지 않는다 — 낡은 것이 아니라 다른 간격이다', () => {
    assert(phaseOnFailure({ isSwitch: true, hasBars: true }) !== 'STALE',
      '전환 실패가 낡음으로 처리됐습니다');
  });

  test('성공하면 언제나 READY다', () => {
    eq(phaseOnSuccess(), 'READY');
    eq(showsBlockingOverlay(phaseOnSuccess()), false);
    eq(staleNotice(phaseOnSuccess()), null);
  });

  // ── 봉이 어느 요청의 것인가 ──
  test('★ 봉에 붙은 요청 키가 지금 화면과 다르면 그 봉은 이 화면의 값이 아니다', () => {
    const a = requestKeyOf('BTCUSDT', '1m', 'USDM');
    const b = requestKeyOf('BTCUSDT', '1h', 'USDM');
    assert(a !== b, '간격이 달라도 같은 키입니다');
    eq(barsMatchRequest(a, a), true);
    eq(barsMatchRequest(a, b), false);
    eq(barsMatchRequest(null, a), false);
  });

  test('종목·시장이 달라도 다른 키다', () => {
    const base = requestKeyOf('BTCUSDT', '1m', 'USDM');
    assert(requestKeyOf('ETHUSDT', '1m', 'USDM') !== base, '종목이 키에 없습니다');
    assert(requestKeyOf('BTCUSDT', '1m', 'SPOT') !== base, '시장이 키에 없습니다');
  });

  test('봉을 지어내는 함수가 없다', async () => {
    const mod: any = await import('./chartLoadState');
    const bad = Object.keys(mod).filter(k => /synth|fake|fill|generate|fallback/i.test(k));
    eq(bad.join(','), '');
  });
}

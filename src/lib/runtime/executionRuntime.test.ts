// src/lib/runtime/executionRuntime.test.ts
//
// **화면을 켜 둬야 돈이 되는 구조**를 값으로 잡는다.
//
// 전수조사에서 나온 것: 실제 주문 경로가 둘이었고, 그중 하나는
// 전략빌더 → localStorage → 브라우저 60초 타이머 → 실주문이었다.
// 탭을 닫으면 진입한 포지션을 아무도 청산하지 않는다.

import { test, eq, assert } from '../../test/harness';
import { runtimeOf, researchIndependence } from './executionRuntime';

export function runExecutionRuntimeTests() {
  console.log('[실행 위치 — 화면을 켜 둬야 도는 구조를 잡는다]');

  test('서버 예약이 있으면 브라우저를 닫아도 돈다', () => {
    const v = runtimeOf({ hasServerSchedule: true, inBrowserEngine: false, mode: 'LIVE' });
    eq(v.home, 'SERVER');
    eq(v.survivesBrowserClose, true);
    eq(v.mayPlaceRealOrders, true);
  });

  test('**브라우저 전용 전략은 실제 돈 주문을 내지 않는다**', () => {
    // 탭이 닫히면 멈추는 것에 실제 자금을 걸면, 진입은 됐는데 청산은
    // 아무도 안 하는 상태가 된다.
    const v = runtimeOf({ hasServerSchedule: false, inBrowserEngine: true, mode: 'LIVE' });
    eq(v.home, 'BROWSER_ONLY');
    eq(v.mayPlaceRealOrders, false);
    assert(/아무도 청산하지 않습니다/.test(v.reason), v.reason);
  });

  test('모의·테스트넷은 브라우저에서 계속 돌 수 있다', () => {
    const v = runtimeOf({ hasServerSchedule: false, inBrowserEngine: true, mode: 'TESTNET' });
    eq(v.home, 'BROWSER_ONLY');
    eq(v.survivesBrowserClose, false);
    // 연구·연습이므로 막지 않는다. 다만 탭을 닫으면 멈춘다고 말한다.
    assert(/탭을 닫으면 멈춥니다/.test(v.reason), v.reason);
  });

  test('**예약을 못 읽은 것을 "서버에서 돈다"로 치지 않는다**', () => {
    // 서버로 치면 사용자는 탭을 닫고, 그 순간 아무것도 안 돌게 된다.
    const v = runtimeOf({ hasServerSchedule: null, inBrowserEngine: true, mode: 'LIVE' });
    eq(v.home, 'UNKNOWN');
    eq(v.survivesBrowserClose, false);
    eq(v.mayPlaceRealOrders, false);
  });

  test('아무도 안 돌리는 전략은 그렇게 말한다', () => {
    const v = runtimeOf({ hasServerSchedule: false, inBrowserEngine: false, mode: 'TESTNET' });
    assert(/아무도 이 전략을 돌리지 않습니다/.test(v.reason), v.reason);
  });

  // ── 연구와 운용의 독립 ──

  test('둘 다 서버에 있고 연구를 안 읽으면 독립이다', () => {
    const c = researchIndependence({
      serverPathAlive: true, strategiesFromBrowserStore: false, executionReadsResearch: false,
    });
    eq(c.independent, true);
  });

  test('**실행 전략이 브라우저 저장소에서 오면 독립이 아니다**', () => {
    const c = researchIndependence({
      serverPathAlive: true, strategiesFromBrowserStore: true, executionReadsResearch: false,
    });
    eq(c.independent, false);
    assert(/브라우저 저장소/.test(c.couplings[0]), c.couplings[0]);
  });

  test('실행이 연구 모듈을 읽으면 독립이 아니다', () => {
    const c = researchIndependence({
      serverPathAlive: true, strategiesFromBrowserStore: false, executionReadsResearch: true,
    });
    eq(c.independent, false);
    assert(/연구가 깨지면 매매도 멈춥니다/.test(c.couplings[0]), c.couplings[0]);
  });

  test('서버 경로가 죽어 있으면 "화면을 켜 둬야 돈다"고 말한다', () => {
    const c = researchIndependence({
      serverPathAlive: false, strategiesFromBrowserStore: false, executionReadsResearch: false,
    });
    eq(c.independent, false);
    assert(c.couplings.some(x => /화면을 켜 둬야/.test(x)), c.couplings.join(' | '));
  });

  test('**모르는 것을 독립으로 치지 않는다**', () => {
    const c = researchIndependence({
      serverPathAlive: null, strategiesFromBrowserStore: false, executionReadsResearch: false,
    });
    eq(c.independent, false);
  });
}

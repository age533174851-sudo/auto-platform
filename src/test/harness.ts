// src/test/harness.ts
// 외부 프레임워크 없는 초경량 테스트 하네스 (Node에서 바로 실행 가능).
// 금융 코어(PnL·레버리지·수수료·백테스트)를 검증하기 위한 최소 도구.

let passed = 0;
let failed = 0;
const failures: string[] = [];

/**
 * 아직 끝나지 않은 비동기 테스트.
 *
 * 이게 없으면 async 테스트가 **실패해도 통과로 집계된다.** fn()이
 * 프라미스를 돌려주는데 try/catch는 이미 빠져나간 뒤라 예외를 못 잡고,
 * 카운터는 그 자리에서 passed++를 한다. 테스트가 거짓말을 하는 것이라
 * 없느니만 못하다.
 */
const pending: Promise<void>[] = [];

export function test(name: string, fn: () => void | Promise<void>) {
  const ok = () => { passed++; console.log(`  ✓ ${name}`); };
  const no = (e: any) => {
    failed++;
    failures.push(`${name}: ${e?.message || e}`);
    console.log(`  ✗ ${name} — ${e?.message || e}`);
  };
  try {
    const r = fn() as any;
    if (r && typeof r.then === 'function') {
      pending.push(r.then(ok, no));
      return;
    }
    ok();
  } catch (e: any) { no(e); }
}

/** 비동기 테스트가 다 끝날 때까지 기다린다. 집계 전에 반드시 부른다 */
export async function flushAsync(): Promise<void> {
  while (pending.length) {
    const batch = pending.splice(0, pending.length);
    await Promise.all(batch);
  }
}

export function assert(cond: boolean, msg = '조건 실패') {
  if (!cond) throw new Error(msg);
}

export function eq(actual: any, expected: any, msg?: string) {
  if (actual !== expected) throw new Error(msg || `기대 ${expected}, 실제 ${actual}`);
}

// 부동소수 근사 비교 (tol 이내)
export function close(actual: number, expected: number, tol = 1e-6, msg?: string) {
  if (Math.abs(actual - expected) > tol) throw new Error(msg || `기대 ≈${expected}, 실제 ${actual} (오차 ${Math.abs(actual - expected)})`);
}

export function gt(actual: number, bound: number, msg?: string) {
  if (!(actual > bound)) throw new Error(msg || `${actual} > ${bound} 실패`);
}
export function lt(actual: number, bound: number, msg?: string) {
  if (!(actual < bound)) throw new Error(msg || `${actual} < ${bound} 실패`);
}

export function summary(): { passed: number; failed: number; failures: string[] } {
  return { passed, failed, failures };
}

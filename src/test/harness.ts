// src/test/harness.ts
// 외부 프레임워크 없는 초경량 테스트 하네스 (Node에서 바로 실행 가능).
// 금융 코어(PnL·레버리지·수수료·백테스트)를 검증하기 위한 최소 도구.

let passed = 0;
let failed = 0;
const failures: string[] = [];

export function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    failures.push(`${name}: ${e?.message || e}`);
    console.log(`  ✗ ${name} — ${e?.message || e}`);
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

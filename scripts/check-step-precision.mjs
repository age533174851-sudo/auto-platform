#!/usr/bin/env node
// scripts/check-step-precision.mjs
//
// **수량·가격 격자 계산은 한 곳에서만 한다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// `Math.round(-Math.log10(step))`으로 소수 자리수를 구하는 코드가
// **아홉 곳**에 복제돼 있었다. 그 식은 10의 거듭제곱이 아닌 단위에서
// 틀린다:
//
//   0.005 → 2자리 → (0.105).toFixed(2) = '0.10'   한 칸 깎인다
//   0.25  → 1자리 → (2.25).toFixed(1)  = '2.3'    단위 정수배가 아니다
//   0.5   → 0자리 → (1.5).toFixed(0)   = '2'      요청보다 많이 주문한다
//   5e-7  → 6자리 → 1.0000005가 1로 잘린다
//
// 단위의 정수배가 아닌 값은 거래소가 거부한다. 거부된 보호주문은
// **걸리지 않은 보호주문**이고, 포지션은 무방비로 남는다.
//
// 아홉 곳 중 한 곳만 고치는 것이 이 저장소의 상습 고장이다
// (`경로가 둘인데 한쪽만 고침`). 그래서 **복제 자체를 막는다.**
//
// 소스를 읽기만 한다. 거래소·DB·주문 없음.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CANON = 'src/lib/exchanges/quantize.ts';
const errors = [];
const err = (m) => errors.push(m);

/** 주석을 벗긴 소스 */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
};

const files = [];
for (const root of ['src', 'worker']) {
  try { walk(root, files); } catch { /* worker가 없으면 건너뛴다 */ }
}

// ── ① 자리수를 다시 계산하는 복제가 없다 ──
//
//   정본과 시험은 예외다. 시험은 **정본이 맞는지** 확인하려고 그 식을
//   적을 수 있다.
for (const f of files) {
  if (f.replace(/\\/g, '/') === CANON) continue;
  if (/\.test\.(ts|tsx)$/.test(f)) continue;
  const c = code(readFileSync(f, 'utf8'));
  if (/Math\.round\s*\(\s*-\s*Math\.log10/.test(c)) {
    err(`${f}: 자리수를 -log10으로 다시 계산합니다`
      + ` — 10의 거듭제곱이 아닌 단위에서 틀립니다. '${CANON}'의 decimalsOf를 쓰세요`);
  }
  // `Math.log10(step)`을 자리수로 쓰는 다른 모양도 막는다.
  if (/toFixed\s*\(\s*[^)]*Math\.log10/.test(c)) {
    err(`${f}: toFixed 자리수를 log10으로 만듭니다 — decimalsOf를 쓰세요`);
  }
}

// ── ② 정본이 지수 표기를 -log10으로 되돌리지 않았다 ──
{
  const src = readFileSync(CANON, 'utf8');
  const c = code(src);
  const body = (() => {
    const at = c.indexOf('export function decimalsOf');
    if (at < 0) return null;
    const m = /\n\}(?:\n|$)/.exec(c.slice(at));
    return m ? c.slice(at, at + m.index + m[0].length) : c.slice(at);
  })();
  if (body == null) err(`${CANON}: decimalsOf를 찾지 못했습니다`);
  else {
    if (/Math\.log10/.test(body)) {
      err(`${CANON}: decimalsOf가 다시 log10을 씁니다`
        + ' — 5e-7은 7자리가 필요한데 round(6.30)=6을 줍니다');
    }
    if (!/toLowerCase\(\)\.split\('e'\)|split\(['"]e['"]\)/.test(body)) {
      err(`${CANON}: decimalsOf가 지수 표기를 가수·지수로 쪼개지 않습니다`);
    }
  }
  // floorToStep·roundToTick이 정본의 decimalsOf를 쓰는가
  for (const fn of ['floorToStep', 'roundToTick']) {
    const at = c.indexOf(`export function ${fn}`);
    if (at < 0) { err(`${CANON}: ${fn}을 찾지 못했습니다`); continue; }
    const m = /\n\}(?:\n|$)/.exec(c.slice(at));
    const b = m ? c.slice(at, at + m.index + m[0].length) : c.slice(at);
    if (!/decimalsOf\s*\(/.test(b)) {
      err(`${CANON}: ${fn}이 decimalsOf를 쓰지 않습니다`);
    }
  }
}

// ── ③ 정본을 실제로 불러 본다 ──
//
//   "그렇게 적혀 있다"가 아니라 "그렇게 답한다"를 본다. 정본은
//   의존이 없으므로 단독으로 컴파일해서 부를 수 있다.
{
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'traigo-step-'));
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  const dest = join(dir, CANON);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(CANON, 'utf8'));
  const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) err(`TypeScript가 없습니다 — 먼저 npm ci`);
  else {
    writeFileSync(join(dir, 'tsconfig.probe.json'), JSON.stringify({
      compilerOptions: { module: 'commonjs', target: 'es2019', skipLibCheck: true },
      files: [CANON],
    }));
    let mod = null;
    try {
      execFileSync(process.execPath, [tsc, '-p', 'tsconfig.probe.json'],
        { cwd: dir, stdio: 'pipe', timeout: 180_000 });
      mod = await import(`file://${join(dir, CANON.replace(/\.ts$/, '.js'))}`);
    } catch (e) {
      err(`${CANON}이 단독으로 컴파일되지 않습니다 — 의존이 생겼습니다`
        + `\n${String(e.stdout || e.message).trim().slice(0, 300)}`);
    }
    if (mod) {
      const { decimalsOf, floorToStep, roundToTick } = mod;
      // 자리수
      for (const [step, want] of [[0.001, 3], [0.005, 3], [0.0025, 4], [0.25, 2],
        [0.5, 1], [1, 0], [5e-7, 7], [2.5e-7, 8], [1e-8, 8]]) {
        const got = decimalsOf(step);
        if (got !== want) err(`decimalsOf(${step}) = ${got}, 기대 ${want}`);
      }
      // 수량: 요청량을 넘지 않고 단위의 정수배다
      for (const [qty, step] of [[0.1065, 0.005], [1.5, 0.5], [2.25, 0.25],
        [7.5, 0.5], [0.75, 0.25], [1.0000005, 5e-7]]) {
        const got = floorToStep(qty, step);
        if (got > qty + 1e-12) {
          err(`floorToStep(${qty}, ${step}) = ${got} — 요청량을 넘겼습니다`);
        }
        const u = got / step;
        if (Math.abs(u - Math.round(u)) > 1e-6) {
          err(`floorToStep(${qty}, ${step}) = ${got} — 단위의 정수배가 아닙니다`);
        }
      }
      // 가격: 단위의 정수배이고 반 칸보다 멀리 가지 않는다
      for (const [price, tick] of [[100.25, 0.25], [100.5, 0.5], [100.05, 0.05],
        [27123.42, 0.5], [3.47, 0.05]]) {
        const got = roundToTick(price, tick);
        const u = got / tick;
        if (Math.abs(u - Math.round(u)) > 1e-6) {
          err(`roundToTick(${price}, ${tick}) = ${got} — 호가 단위의 정수배가 아닙니다`);
        }
        if (Math.abs(got - price) > tick / 2 + 1e-12) {
          err(`roundToTick(${price}, ${tick}) = ${got} — 반 칸보다 멀리 움직였습니다`);
        }
      }
    }
  }
}

if (errors.length) {
  console.error('❌ 격자 계산 계약 위반\n');
  for (const e of errors) console.error(`  · ${e}`);
  console.error(`\n${errors.length}건`);
  process.exit(1);
}
console.log('✅ 격자 계산 — 정본 한 곳 · 복제 0 · 지수 표기 포함 자리수 정확 · 정수배 보장');

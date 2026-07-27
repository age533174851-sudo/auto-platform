#!/usr/bin/env node
// 런타임 ReferenceError 사전 탐지
// tsc의 TS2304(Cannot find name) 중 "값 위치"에서 쓰인 것만 골라낸다.
// 타입 위치(useState<X>, as X, : X)는 컴파일 시 소거되므로 제외.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let out = '';
try {
  out = execSync('npx tsc --noEmit 2>&1 || true', { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });
} catch (e) { out = e.stdout || ''; }

const TYPE_CTX = [
  /useState<\s*NAME/, /useRef<\s*NAME/, /useMemo<\s*NAME/,
  /:\s*NAME\b/, /\bas\s+(\[)?NAME\b/, /<NAME>/,
  /Record<[^>]*\bNAME\b/, /Array<\s*NAME/, /Partial<\s*NAME/,
  /\bNAME\[\]/, /extends\s+NAME\b/, /interface\s+NAME\b/, /type\s+NAME\b/,
  /:\s*\([^)]*\bNAME\b/,        // : (NAME & {...})[]  형태의 타입 어노테이션
  /&\s*NAME\b/, /\bNAME\s*&/,   // 교차 타입
  /\|\s*NAME\b/, /\bNAME\s*\|/, // 유니온 타입
];

const hits = [];
for (const line of out.split('\n')) {
  const m = line.match(/^(.+?)\((\d+),\d+\):\s*error TS2304:.*Cannot find name '([^']+)'/);
  if (!m) continue;
  const [, file, lineNo, name] = m;
  let src = '';
  try { src = readFileSync(file, 'utf8').split('\n')[Number(lineNo) - 1] || ''; } catch { continue; }

  const isTypeOnly = TYPE_CTX.some(re =>
    new RegExp(re.source.replace(/NAME/g, name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).test(src)
  );
  if (!isTypeOnly) hits.push({ file, lineNo, name, src: src.trim().slice(0, 100) });
}

if (hits.length === 0) {
  console.log('✅ 런타임 미정의 식별자 없음');
  process.exit(0);
}
console.log(`🔴 런타임 크래시 위험 ${hits.length}건:\n`);
for (const h of hits) {
  console.log(`  ${h.file}:${h.lineNo} → '${h.name}'`);
  console.log(`     ${h.src}\n`);
}
process.exit(1);

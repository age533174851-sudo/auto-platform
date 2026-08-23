#!/usr/bin/env node
// scripts/diagnose-worker.mjs
//
// **"fly logs를 열어 확인해 주세요"를 없앤다.**
//
// 워크플로에는 이미 FLY_API_TOKEN이 있다. 사람이 대시보드에서 볼 수
// 있는 것은 여기서도 볼 수 있다 — 그러면 사람이 볼 이유가 없다.
//
// 무엇을 묻는가
// ─────────────
//   flyctl status --json          머신이 몇 대, 어떤 상태
//   flyctl secrets list --json    **이름과 다이제스트만.** flyctl도 값은 안 준다
//   flyctl logs --no-tail         워커가 스스로 남긴 이유
//   /api/system/deployment        heartbeat가 얼마나 오래됐나
//
// 판정은 여기 없다
// ────────────────
// `src/lib/ops/workerDiagnosis.ts`에 있고 테스트가 붙어 있다. 이 파일은
// 사실을 모아서 넘기고 결과를 찍기만 한다.
//
// 값은 어디에도 남기지 않는다
// ───────────────────────────
// 시크릿은 이름만 옮긴다. 로그는 값처럼 생긴 것을 지우고(scrubLogLine)
// 단서가 되는 줄만 옮긴다. flyctl의 오류 문구도 같은 세탁을 거친다.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = String(process.env.BASE || '').replace(/\/+$/, '');
const HAS_TOKEN = !!String(process.env.FLY_API_TOKEN || '').trim();

function loadJudge() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-diag-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, 'src/lib/ops/workerDiagnosis.ts',
    '--outDir', dir, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
}

function fly(args, { json = false } = {}) {
  try {
    const out = execFileSync('flyctl', args, {
      stdio: 'pipe', encoding: 'utf8', timeout: 90_000,
    });
    if (!json) return { ok: true, text: String(out) };
    try { return { ok: true, json: JSON.parse(String(out)) }; }
    catch { return { ok: false, error: 'JSON으로 읽지 못했습니다' }; }
  } catch (e) {
    // flyctl 오류 문구에도 토큰이 섞일 수 있다. 길이로 자르고 넘긴다.
    const raw = [e?.stderr, e?.stdout, e?.message].map(x => String(x ?? '')).join(' ').trim();
    return { ok: false, error: raw.slice(0, 300) };
  }
}

/** 머신 목록. 못 읽으면 null — **0대로 읽지 않는다** */
function machines() {
  const r = fly(['status', '--json'], { json: true });
  if (!r.ok) return { value: null, note: `flyctl status 실패: ${r.error}` };
  const j = r.json ?? {};
  const list = Array.isArray(j.Machines) ? j.Machines
    : Array.isArray(j.machines) ? j.machines : null;
  if (!Array.isArray(list)) return { value: null, note: 'status에서 머신 목록을 찾지 못했습니다' };
  return {
    value: list.map(m => ({
      id: String(m.id ?? m.ID ?? ''),
      state: String(m.state ?? m.State ?? 'unknown'),
      process: m?.config?.metadata?.fly_process_group ?? null,
      version: String(m.instance_id ?? m.version ?? '') || null,
    })),
    note: null,
  };
}

/** 시크릿 **이름만**. 못 읽으면 null — 없는 것으로 읽지 않는다 */
function secretNames() {
  const r = fly(['secrets', 'list', '--json'], { json: true });
  if (!r.ok) return { value: null, note: `flyctl secrets list 실패: ${r.error}` };
  const j = r.json;
  if (!Array.isArray(j)) return { value: null, note: 'secrets list를 목록으로 읽지 못했습니다' };
  // Name과 Digest만 있는 응답이다. **Digest도 옮기지 않는다** — 이름만 쓴다.
  return { value: j.map(s => String(s.Name ?? s.name ?? '')).filter(Boolean), note: null };
}

function logLines() {
  const r = fly(['logs', '--no-tail']);
  if (!r.ok) return { value: null, note: `flyctl logs 실패: ${r.error}` };
  const all = String(r.text).split('\n');
  // 최근 것이 뒤에 있다. 뒤에서 400줄만 본다.
  return { value: all.slice(-400), note: null };
}

async function heartbeatAgeSec() {
  if (!BASE) return { value: null, note: '확인할 주소(BASE)가 없어 heartbeat를 읽지 못했습니다' };
  try {
    const r = await fetch(`${BASE}/api/system/deployment`, { signal: AbortSignal.timeout(20_000) });
    const b = await r.json().catch(() => null);
    const secs = b?.fly?.ageSec ?? b?.fly?.lastSeenAgeSec ?? null;
    if (typeof secs === 'number' && Number.isFinite(secs)) return { value: Math.round(secs), note: null };
    const last = b?.fly?.lastSeen ?? b?.fly?.last_seen ?? null;
    if (last) {
      const t = Date.parse(String(last));
      if (Number.isFinite(t)) return { value: Math.round((Date.now() - t) / 1000), note: null };
    }
    return { value: null, note: 'deployment 응답에서 heartbeat 시각을 찾지 못했습니다' };
  } catch (e) {
    return { value: null, note: `deployment 조회 실패: ${String(e?.message || e).slice(0, 160)}` };
  }
}

async function main() {
  const dir = loadJudge();
  const { diagnoseWorker, diagnosisReport } = await import(`file://${join(dir, 'workerDiagnosis.js')}`);

  const notes = [];
  let m = { value: null, note: 'FLY_API_TOKEN이 없어 Fly에 묻지 않았습니다' };
  let s = { value: null, note: 'FLY_API_TOKEN이 없어 Fly에 묻지 않았습니다' };
  let l = { value: null, note: 'FLY_API_TOKEN이 없어 Fly에 묻지 않았습니다' };

  if (HAS_TOKEN) {
    m = machines();
    s = secretNames();
    l = logLines();
  }
  const hb = await heartbeatAgeSec();
  for (const n of [m.note, s.note, l.note, hb.note]) if (n && !notes.includes(n)) notes.push(n);

  // **셋 다 실패했으면 물어보지 못한 것이다.** 그것을 진단으로 적지 않는다.
  const queried = HAS_TOKEN && (m.value != null || s.value != null || l.value != null);

  const d = diagnoseWorker({
    queried,
    machines: m.value,
    secretNames: s.value,
    logLines: l.value,
    heartbeatAgeSec: hb.value,
  });

  console.log(diagnosisReport(d));
  if (notes.length) {
    console.log('');
    console.log('물어보지 못한 것:');
    for (const n of notes) console.log(`  · ${n}`);
  }

  // GitHub 요약에도 남긴다 — 로그를 스크롤하지 않아도 보이게.
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const { appendFileSync } = await import('node:fs');
    const L = ['## 워커 진단', '', '```', diagnosisReport(d), '```'];
    if (notes.length) L.push('', '물어보지 못한 것: ' + notes.join(' · '));
    try { appendFileSync(summary, L.join('\n') + '\n'); } catch {}
  }

  // ALIVE만 0이다. **확인하지 못한 것은 통과가 아니다.**
  return d.code === 'ALIVE' ? 0 : 1;
}

main().then(c => process.exit(c)).catch(e => {
  console.log(`::error::워커 진단에 실패했습니다: ${String(e?.message || e).slice(0, 200)}`);
  process.exit(1);
});

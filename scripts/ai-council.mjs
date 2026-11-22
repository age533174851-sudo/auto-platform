#!/usr/bin/env node
// scripts/ai-council.mjs
//
// **GPT · Claude · Gemini가 같은 diff를 읽고 2라운드 토론한 뒤, 결론을
// PR 코멘트로 남긴다.** 사람이 복사·붙여넣기 하지 않는다.
//
// 왜 이 파일이 필요한가
// ────────────────────
// 세 도구를 각자 돌리면 **같은 파일을 동시에 고쳐 서로를 덮는다.** 실제로
// 2026-11-21에 그 일이 났다 — Codex가 12:33에 `orders/reconcile/route.ts`의
// 한 자리를 패치로 올리고, Claude가 12:46에 같은 변경을 PR로 올렸다. 둘이
// 같은 자리를 고친 것을 나중에야 알았다. 그래서 **의견을 먼저 한곳에
// 모은다.** 코드를 고치는 것은 그 뒤다.
//
// ★ 이 파일은 **코드를 고치지 않는다.** 읽고, 묻고, 코멘트를 적는다.
//   머지·배포·주문은 하지 않는다 — 할 수단이 여기에 없다.
//
// ── 비용과 루프를 막는 상수 ──
//
//   토론은 **2라운드에서 끝난다.** 상수이고 인자로 못 바꾼다. 3라운드를
//   허용하면 "조금만 더"가 반복되고, 그 비용은 사람이 보지 않는 곳에서
//   늘어난다. 2라운드면 독립 검토와 상호 반박이 한 번씩 돌아간다 —
//   그 이상은 같은 말이 길어진다.
import { readFileSync, existsSync } from 'node:fs';

/** 토론 라운드 수. **상수다.** 인자·환경변수로 바꿀 수 없다 */
export const MAX_ROUNDS = 2;
/** 한 번에 읽을 변경 파일 수 상한 */
export const MAX_FILES = 40;
/** 모델에 넘길 diff 바이트 상한. 넘으면 잘라내고 **잘랐다고 적는다** */
export const MAX_DIFF_BYTES = 60_000;
/** 모델 한 번 호출의 출력 상한 */
export const MAX_OUTPUT_TOKENS = 1_600;

// ── 세 자리의 역할 ──
//
//   같은 질문을 셋에게 하면 세 번 같은 답이 온다. 보는 각도를 갈라야
//   토론이 된다.
export const SEATS = [
  {
    id: 'gpt',
    label: 'GPT (OpenAI)',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'AI_COUNCIL_OPENAI_MODEL',
    role: '기획 · UI/UX · 사용자 동선과 기능 누락',
    brief:
      '이 변경이 **사용자가 실제로 다니는 길**에서 무엇을 바꾸는가. '
      + '화면에 붙지 않은 기능, 막다른 길(안내는 있는데 누를 것이 없는 자리), '
      + '빠진 상태 표시(오류·지연·조회 중·확인된 0·실제 0)를 본다.',
  },
  {
    id: 'claude',
    label: 'Claude (Anthropic)',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'AI_COUNCIL_ANTHROPIC_MODEL',
    role: '코드 품질 · TypeScript/Next.js · 엣지 케이스와 회귀',
    brief:
      '이 변경이 **깨뜨릴 수 있는 것**을 본다. 경계값, null과 빈 배열의 구분, '
      + '같은 판단이 두 곳에 생기지 않았는지, 시험이 그 판단을 실제로 '
      + '겨냥하는지(고장내면 빨개지는지)를 본다.',
  },
  {
    id: 'gemini',
    label: 'Gemini (Google)',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'AI_COUNCIL_GEMINI_MODEL',
    role: '아키텍처 · 자동매매 리스크 · 보안과 데이터 무결성',
    brief:
      '이 변경이 **돈과 권한**에 닿는지를 본다. 주문·청산 경로, 모드 격리'
      + '(MOCK/TESTNET/LIVE를 섞지 않는가), 소유권 검사, 자격증명이 응답이나 '
      + '로그에 새는 자리, 조회 실패를 0으로 적는 자리를 본다.',
  },
];

// ── 저장소가 토론에 들고 가는 규칙 ──
//
//   이것을 프롬프트에 넣지 않으면 세 모델이 **일반적인 조언**을 한다.
//   이 저장소가 반복해서 다친 자리를 알려 줘야 그 자리를 본다.
export const HOUSE_RULES = [
  '조회 실패를 0이나 "없음"으로 적지 않는다. 확인하지 못한 것은 UNKNOWN이다.',
  'MOCK / TESTNET / LIVE 의 장부와 자산을 절대 합산하지 않는다.',
  'symbol만 보고 주문 소유권을 판단하지 않는다. Cancel All 금지.',
  '실제 거래소 증거 없이 ENTERED · CLOSED · PROTECTED · PASS 를 적지 않는다.',
  '검사기가 막으면 검사기가 옳다. 통과시키려고 관문을 지우지 않는다.',
  '만들어 놓고 배선하지 않는 판정 모듈을 만들지 않는다.',
  '같은 판단이 두 곳에 있으면 언젠가 갈린다 — 한 곳에 두고 시험을 붙인다.',
  '키·시크릿 값은 로그·응답·커밋 어디에도 남기지 않는다.',
];

/** 키가 **있는지만** 본다. 값은 읽지도, 길이도 적지 않는다 */
export function seatAvailability(env = process.env) {
  return SEATS.map((s) => ({
    id: s.id,
    label: s.label,
    role: s.role,
    present: typeof env[s.keyEnv] === 'string' && env[s.keyEnv].trim().length > 0,
    keyEnv: s.keyEnv,
  }));
}

/**
 * diff를 모델에 넘길 크기로 줄인다.
 *
 * ★ **자른 것을 자르지 않은 것처럼 보내지 않는다.** 잘라냈다는 사실과
 *   몇 개를 뺐는지를 본문에 적는다. 그러지 않으면 모델이 "이 파일은
 *   안 바뀌었다"고 읽고, 그 판단이 보고서에 올라간다.
 */
export function packDiff(files, opts = {}) {
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : MAX_FILES;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : MAX_DIFF_BYTES;
  const list = Array.isArray(files) ? files : [];

  // 작은 파일부터 넣으면 큰 파일 하나가 전부를 밀어낸다. 반대로 큰 것부터
  // 넣으면 작은 파일이 통째로 빠진다. **변경량 순**으로 넣고, 넘치면 그
  // 파일의 patch만 생략하고 이름은 남긴다 — 이름이 남아야 모델이
  // "못 봤다"고 말할 수 있다.
  const sorted = [...list].sort(
    (a, b) => (Number(b.changes) || 0) - (Number(a.changes) || 0));

  const kept = [];
  const omitted = [];
  let bytes = 0;
  for (const f of sorted) {
    const name = String(f?.filename ?? '');
    if (!name) continue;
    if (kept.length >= maxFiles) { omitted.push({ filename: name, why: '파일 수 상한' }); continue; }
    const patch = typeof f?.patch === 'string' ? f.patch : '';
    if (!patch) { omitted.push({ filename: name, why: 'patch 없음 (바이너리이거나 너무 큼)' }); continue; }
    if (bytes + patch.length > maxBytes) { omitted.push({ filename: name, why: 'diff 크기 상한' }); continue; }
    kept.push({ filename: name, patch });
    bytes += patch.length;
  }

  const body = kept.map((f) => `--- ${f.filename}\n${f.patch}`).join('\n\n');
  const note = omitted.length === 0
    ? ''
    : `\n\n[잘라냄] 아래 ${omitted.length}개 파일의 diff는 넣지 못했습니다 — `
      + '이 파일에 대해서는 "확인하지 못했다"고 적으세요:\n'
      + omitted.map((o) => `  · ${o.filename} (${o.why})`).join('\n');

  return { body: body + note, kept: kept.length, omitted, bytes };
}

/**
 * 모델 출력에서 **키처럼 보이는 것**을 지운다.
 *
 * 모델이 프롬프트의 일부를 되풀이할 수 있고, 저장소 규칙은 시크릿을
 * 어디에도 남기지 않는 것이다. 코멘트로 올리기 전에 한 겹 더 막는다 —
 * 막을 자리가 하나뿐이면 그 하나가 뚫릴 때 전부 뚫린다.
 */
export function redact(text) {
  let out = String(text ?? '');
  for (const s of SEATS) {
    const v = process.env[s.keyEnv];
    if (typeof v === 'string' && v.trim().length >= 8) {
      out = out.split(v.trim()).join('[REDACTED]');
    }
  }
  return out
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})/g, '[REDACTED]')
    .replace(/\b(AIza[A-Za-z0-9_-]{10,})/g, '[REDACTED]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, '[REDACTED]')
    .replace(/\b(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, '[REDACTED]');
}

function roundOnePrompt(seat, ctx) {
  return [
    `당신의 자리: ${seat.label} — ${seat.role}`,
    '',
    seat.brief,
    '',
    '## 이 저장소가 반복해서 다친 자리 (여기부터 본다)',
    ...HOUSE_RULES.map((r) => `- ${r}`),
    '',
    `## 대상: ${ctx.title}`,
    ctx.description ? `\n${ctx.description}\n` : '',
    '## 변경 diff',
    '```diff',
    ctx.diff,
    '```',
    '',
    '## 답하는 방법',
    '- 당신의 역할에 해당하는 것만 적는다. 남의 자리를 대신 보지 않는다.',
    '- **코드 줄이나 파일 경로를 인용한다.** 인용 없는 지적은 적지 않는다.',
    '- 확인하지 못한 것은 "확인하지 못했다"고 적는다. 추측을 지적으로 적지 않는다.',
    '- 10줄 이내로 끊는다. 길면 읽히지 않는다.',
  ].join('\n');
}

function roundTwoPrompt(seat, ctx, firstRound) {
  const others = firstRound.filter((r) => r.id !== seat.id);
  return [
    `당신의 자리: ${seat.label} — ${seat.role}`,
    '',
    '1라운드에서 다른 자리가 낸 의견입니다. 읽고 **동의 / 반박 / 둘 다 놓친 것**을 적으세요.',
    '',
    ...others.map((o) => `### ${o.label}\n${o.text}`),
    '',
    `## 대상: ${ctx.title}`,
    '## 변경 diff',
    '```diff',
    ctx.diff,
    '```',
    '',
    '## 답하는 방법',
    '- **동의하는 것**: 한 줄씩. 왜 동의하는지 근거를 코드로.',
    '- **반박**: 그 지적이 왜 틀렸는지. 반박에도 코드 인용이 필요하다.',
    '- **둘 다 놓친 것**: 당신 자리에서만 보이는 것.',
    '- 1라운드에서 한 말을 반복하지 않는다.',
    '- 10줄 이내.',
  ].join('\n');
}

// ── 세 공급자 호출 ──
//
//   모델 ID는 플랫폼마다 바뀐다. 기본값을 두되 **환경변수로 덮을 수 있게**
//   한다. 거절당하면 그 사실과 어느 환경변수를 바꾸면 되는지 적는다 —
//   "실패"만 적으면 사람이 무엇을 할지 모른다.
const DEFAULT_MODELS = {
  gpt: 'gpt-4o',
  claude: 'claude-sonnet-4-20250514',
  gemini: 'gemini-1.5-pro',
};

async function callOpenAI(prompt, model, key, fetchImpl) {
  const r = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`OpenAI ${r.status} — ${j?.error?.message || '응답을 읽지 못했습니다'}`);
  const t = j?.choices?.[0]?.message?.content;
  if (typeof t !== 'string' || !t.trim()) throw new Error('OpenAI 응답에 본문이 없습니다');
  return t;
}

async function callAnthropic(prompt, model, key, fetchImpl) {
  const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model, max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Anthropic ${r.status} — ${j?.error?.message || '응답을 읽지 못했습니다'}`);
  const t = Array.isArray(j?.content) ? j.content.map((c) => c?.text || '').join('') : '';
  if (!t.trim()) throw new Error('Anthropic 응답에 본문이 없습니다');
  return t;
}

async function callGemini(prompt, model, key, fetchImpl) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Gemini ${r.status} — ${j?.error?.message || '응답을 읽지 못했습니다'}`);
  const t = j?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('') || '';
  if (!t.trim()) throw new Error('Gemini 응답에 본문이 없습니다');
  return t;
}

const CALLERS = { gpt: callOpenAI, claude: callAnthropic, gemini: callGemini };

/**
 * 한 자리에게 한 번 묻는다. **실패해도 던지지 않는다** — 한 자리가
 * 죽으면 나머지 둘의 의견까지 사라지는 것이 더 나쁘다. 실패는 그 자리의
 * 결과에 `error`로 남고 보고서에 그대로 적힌다.
 */
async function ask(seat, prompt, deps) {
  const env = deps.env ?? process.env;
  const key = env[seat.keyEnv];
  const model = env[seat.modelEnv] || DEFAULT_MODELS[seat.id];
  try {
    const text = await CALLERS[seat.id](prompt, model, key, deps.fetchImpl ?? fetch);
    return { id: seat.id, label: seat.label, model, text: redact(text) };
  } catch (e) {
    return {
      id: seat.id, label: seat.label, model,
      error: `${e?.message || e} (모델 ID를 바꾸려면 ${seat.modelEnv} 를 설정하세요)`,
    };
  }
}

/**
 * 토론을 돌린다. 라운드는 **MAX_ROUNDS에서 끝난다** — 인자로 늘릴 수 없다.
 */
export async function runCouncil(ctx, deps = {}) {
  const env = deps.env ?? process.env;
  const seats = SEATS.filter((s) => {
    const v = env[s.keyEnv];
    return typeof v === 'string' && v.trim().length > 0;
  });

  if (seats.length === 0) {
    return {
      rounds: [], seats: [], skipped: SEATS.map((s) => s.keyEnv),
      error: 'API 키가 하나도 없습니다 — '
        + SEATS.map((s) => s.keyEnv).join(' · ')
        + ' 중 최소 하나를 저장소 Secrets에 등록하세요',
    };
  }

  const rounds = [];
  const r1 = await Promise.all(seats.map((s) => ask(s, roundOnePrompt(s, ctx), deps)));
  rounds.push({ n: 1, name: '독립 검토', results: r1 });

  // ★ 2라운드는 **1라운드에서 본문을 받은 자리가 둘 이상**일 때만 돈다.
  //   혼자 남은 자리에게 "다른 의견에 반박하라"고 묻는 것은 돈만 쓴다.
  const spoke = r1.filter((r) => typeof r.text === 'string');
  if (MAX_ROUNDS >= 2 && spoke.length >= 2) {
    const r2 = await Promise.all(
      seats
        .filter((s) => spoke.some((r) => r.id === s.id))
        .map((s) => ask(s, roundTwoPrompt(s, ctx, spoke), deps)));
    rounds.push({ n: 2, name: '상호 반박·보완', results: r2 });
  }

  return {
    rounds,
    seats: seats.map((s) => s.id),
    skipped: SEATS.filter((s) => !seats.includes(s)).map((s) => s.keyEnv),
  };
}

/**
 * 보고서를 만든다. **순수 함수다** — 네트워크도 파일도 보지 않으므로
 * 시험이 그대로 부를 수 있다.
 *
 * ★ 합의를 **모델에게 다시 묻지 않는다.** 그러면 호출이 한 번 더 늘고,
 *   무엇보다 "셋이 합의했다"를 네 번째 모델이 적는 셈이 된다. 라운드
 *   내용을 그대로 싣고, 무엇이 갈렸는지는 사람이 본다.
 */
export function buildReport(council, ctx) {
  const L = [];
  L.push('## 🤖 AI 합의체 — GPT · Claude · Gemini');
  L.push('');
  L.push(`대상: **${ctx.title}**  ·  기준 SHA: \`${ctx.sha || '미확인'}\``);
  if (ctx.pack) {
    L.push('');
    L.push(`diff: 파일 ${ctx.pack.kept}개 · ${ctx.pack.bytes.toLocaleString()}바이트`
      + (ctx.pack.omitted.length ? ` · **잘라낸 파일 ${ctx.pack.omitted.length}개**` : ''));
  }

  if (council.error) {
    L.push('', `❌ ${council.error}`, '');
    return L.join('\n');
  }

  if (council.skipped.length) {
    L.push('', `ℹ️ 키가 없어 빠진 자리: ${council.skipped.join(' · ')}`
      + ' — 등록된 자리만으로 돌렸습니다.');
  }

  for (const round of council.rounds) {
    L.push('', `### ${round.n}라운드 — ${round.name}`);
    for (const r of round.results) {
      L.push('', `<details><summary><b>${r.label}</b> · <code>${r.model}</code></summary>`, '');
      L.push(r.error ? `⚠️ 호출 실패: ${r.error}` : r.text);
      L.push('', '</details>');
    }
  }

  const failed = council.rounds.flatMap((r) => r.results).filter((r) => r.error);
  L.push('', '---', '');
  L.push(`토론은 **${council.rounds.length}라운드**에서 끝났습니다 — 상한 ${MAX_ROUNDS}라운드는 `
    + '코드에 상수로 박혀 있어 늘릴 수 없습니다.');
  if (failed.length) {
    L.push('', `⚠️ 호출 실패 ${failed.length}건이 있습니다. 그 자리의 의견은 **없는 것이지 "문제 없음"이 아닙니다.**`);
  }
  if (ctx.pack?.omitted?.length) {
    L.push('', '⚠️ 잘라낸 파일이 있습니다. 그 파일에 대한 판단은 이 보고서에 없습니다.');
  }
  L.push('', '이 보고서는 **의견입니다.** 머지·배포·주문을 하지 않았고, 할 수단도 없습니다.');
  L.push('', '_Generated by `scripts/ai-council.mjs`_');
  return L.join('\n');
}

// ── CLI ──

function parseArgs(argv) {
  const a = { dryRun: false, pr: null, fixture: null };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--pr') a.pr = argv[i += 1];
    else if (x === '--fixture') a.fixture = argv[i += 1];
  }
  return a;
}

/** `--dry-run`용 고정 입력. 네트워크도 키도 쓰지 않는다 */
export const DRY_RUN_FIXTURE = {
  title: '(dry-run) 미확정 주문 조회 실패를 0건으로 적지 않는다',
  sha: '0000000000000000000000000000000000000000',
  description: 'dry-run 고정 입력입니다. 실제 PR이 아닙니다.',
  files: [{
    filename: 'src/app/api/orders/reconcile/route.ts',
    changes: 6,
    patch: '@@\n-    const list = Array.isArray(pending) ? pending : [];\n'
      + '+    if (pendingError || !Array.isArray(pending)) {\n'
      + "+      return NextResponse.json({ ok: false, error: 'pending_orders_unreadable' }, { status: 503 });\n"
      + '+    }\n',
  }],
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const avail = seatAvailability();

  console.log('AI 합의체 — 자리 상태 (키 값은 적지 않습니다)');
  for (const s of avail) {
    console.log(`  ${s.present ? '●' : '○'} ${s.label} — ${s.role}` + (s.present ? '' : ` (${s.keyEnv} 없음)`));
  }
  console.log(`  라운드 상한: ${MAX_ROUNDS} (상수)`);

  let files = [];
  let ctx = {};

  if (args.dryRun) {
    const f = DRY_RUN_FIXTURE;
    files = f.files;
    ctx = { title: f.title, sha: f.sha, description: f.description };
  } else if (args.fixture) {
    if (!existsSync(args.fixture)) {
      console.error(`❌ fixture 파일이 없습니다: ${args.fixture}`);
      process.exit(1);
    }
    const f = JSON.parse(readFileSync(args.fixture, 'utf8'));
    files = Array.isArray(f.files) ? f.files : [];
    ctx = { title: f.title || '(제목 없음)', sha: f.sha || '', description: f.description || '' };
  } else {
    // 실제 PR은 워크플로가 파일을 내려 fixture로 넘긴다. 이 스크립트가
    // GitHub 토큰을 직접 들고 다니지 않게 하려는 것이다 — 들고 다니면
    // 여기서 쓸 수 있는 권한이 늘어난다.
    console.error('❌ --pr 만으로는 돌지 않습니다. 워크플로가 만든 --fixture 를 주거나 --dry-run 을 쓰세요.');
    process.exit(1);
  }

  const pack = packDiff(files);
  ctx.diff = pack.body;
  ctx.pack = pack;

  if (args.dryRun) {
    // dry-run은 **모델을 부르지 않는다.** 흐름과 보고서 모양만 확인한다.
    const fake = {
      rounds: [{
        n: 1, name: '독립 검토',
        results: avail.filter((s) => s.present).map((s) => ({
          id: s.id, label: s.label, model: '(dry-run)', text: '(dry-run — 모델을 부르지 않았습니다)',
        })),
      }],
      seats: avail.filter((s) => s.present).map((s) => s.id),
      skipped: avail.filter((s) => !s.present).map((s) => s.keyEnv),
    };
    if (fake.seats.length === 0) {
      fake.rounds = [];
      fake.error = 'API 키가 하나도 없습니다 — '
        + SEATS.map((s) => s.keyEnv).join(' · ')
        + ' 중 최소 하나를 저장소 Secrets에 등록하세요';
    }
    console.log('\n' + buildReport(fake, ctx));
    console.log('\n✅ dry-run — 모델 호출 0건 · 네트워크 0건');
    return;
  }

  const council = await runCouncil(ctx);
  const report = buildReport(council, ctx);
  console.log('\n' + report);

  // 워크플로가 이 파일을 읽어 코멘트로 올린다. 스크립트가 직접 올리지
  // 않는 이유도 권한이다 — 여기서 올리려면 쓰기 토큰이 필요해진다.
  const out = process.env.AI_COUNCIL_OUTPUT;
  if (out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, report, 'utf8');
    console.log(`\n보고서를 ${out} 에 적었습니다`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`❌ ${e?.message || e}`); process.exit(1); });
}

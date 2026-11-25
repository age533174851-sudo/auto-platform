#!/usr/bin/env node
// Offline acceptance probe for #771. Runs the actual council script; no API calls,
// real credentials, production edits, or replacement scheduling logic.
// Usage: node scripts/probes/ai-council-schedule-retry.mjs [council-source-path]
// Exit 1 means the source still violates the retry contract, not a provider outage.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { councilOutcome } from '../lib/council-outcome.mjs';

const sourcePath = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL('../ai-issue-council.mjs', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const importLine = /^import\s+\{\s*councilOutcome\s*\}\s+from\s+["']\.\/lib\/council-outcome\.mjs["'];?$/m;
assert.match(source, importLine, 'Probe loader must be reviewed if script imports change');
// Only the module boundary is injected. All production branches and main() run.
const executable = source.replace(importLine, '/* councilOutcome injected by offline probe */');
const head = 'ed00c1a4fbd7b2a64ab00413d6dda88936b4ed05';
const task = 'AUTO-ed00c1a';
const comment = (provider, round, run = 'previous-run', sha = head.slice(0, 7)) => ({
  user: { login: 'fixture-bot' },
  body: `[${round} | AGENT: ${provider}]\n- 작업: \`${task}\` · 기준: \`main@${sha}\` · 모델: \`fixture\`${run === null ? '' : ` · 실행ID: \`${run}\``}\n\nFixture opinion.`,
});
const round = (providers, id = 'previous-run', sha) => [
  ...providers.map(p => comment(p, 'R1', id, sha)),
  ...providers.map(p => comment(p, 'R2', id, sha)),
];
const active = ['GEMINI', 'ANTHROPIC'];
const cases = [
  { name: 'Claude-only previous round retries Gemini at the same HEAD',
    comments: round(['ANTHROPIC']), expect: 'run' },
  { name: 'All active providers completed R1/R2 in one run: skip',
    comments: round(active), expect: 'skip' },
  { name: 'Different run IDs cannot be combined into a completed round',
    comments: [...round(['GEMINI'], 'run-a'), ...round(['ANTHROPIC'], 'run-b')], expect: 'run' },
  { name: 'Missing run ID is insufficient completion evidence',
    comments: round(active, null), expect: 'run' },
  { name: 'R2 without the same providers R1 must retry',
    comments: active.map(p => comment(p, 'R2')), expect: 'run' },
  { name: 'New HEAD must run even after a complete previous round',
    comments: round(active, 'previous-run', 'aaaaaaa'), expect: 'run' },
  { name: 'A newly enabled provider must join the next round',
    comments: round(active), providers: [...active, 'OPENAI'], expect: 'run' },
  { name: 'Manual dispatch still runs after a complete round',
    comments: round(active), event: 'workflow_dispatch', expect: 'run' },
  { name: 'No configured providers must report configuration failure',
    comments: round(active), providers: [], expect: 'configuration-error' },
];

async function observe(spec) {
  const configured = spec.providers ?? active;
  const posted = [];
  const calls = { GEMINI: 0, OPENAI: 0, ANTHROPIC: 0 };
  const logs = [];
  const exits = [];
  const unexpected = [];
  const env = {
    EVENT_NAME: spec.event ?? 'schedule', GITHUB_REPOSITORY: 'fixture/repo',
    ISSUE_NUMBER: '724', BASE_BRANCH: 'main', GITHUB_TOKEN: 'fixture-github-only',
    ANTHROPIC_MODEL: 'fixture-claude', GEMINI_MODEL: 'fixture-gemini',
  };
  for (const id of configured) env[`${id}_API_KEY`] = `fixture-${id}-only`;
  const response = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
  const fetch = async (address, options = {}) => {
    const url = new URL(address);
    const method = options.method ?? 'GET';
    if (url.origin === 'https://api.github.com') {
      const base = '/repos/fixture/repo';
      if (url.pathname === `${base}/branches/main` && method === 'GET') {
        return response({ commit: { sha: head } });
      }
      if (url.pathname === `${base}/issues/724` && method === 'GET') {
        return response({ body: 'Offline council fixture', comments: spec.comments.length });
      }
      if (url.pathname === `${base}/issues/724/comments`) {
        if (method === 'POST') {
          const body = JSON.parse(options.body).body;
          posted.push({ body, user: { login: 'fixture-bot' } });
          return response({ id: posted.length, body });
        }
        if (method === 'GET') {
          return response(url.searchParams.has('since') ? posted : spec.comments);
        }
      }
      if (url.pathname === `${base}/pulls` && method === 'GET') return response([]);
    }
    if (url.origin === 'https://generativelanguage.googleapis.com') {
      if (url.pathname === '/v1beta/models' && method === 'GET') {
        return response({ models: [{ name: 'models/fixture-gemini', supportedGenerationMethods: ['generateContent'] }] });
      }
      if (url.pathname.endsWith(':generateContent') && method === 'POST') {
        calls.GEMINI++;
        return response({ candidates: [{ content: { parts: [{ text: 'Offline Gemini fixture opinion' }] } }] });
      }
    }
    if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages' && method === 'POST') {
      calls.ANTHROPIC++;
      return response({ content: [{ type: 'text', text: 'Offline Claude fixture opinion' }] });
    }
    if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/chat/completions' && method === 'POST') {
      calls.OPENAI++;
      return response({ choices: [{ message: { content: 'Offline OpenAI fixture opinion' } }] });
    }
    // No real fetch is imported or reachable through this injected boundary.
    unexpected.push(`${method} ${url.origin}${url.pathname}`);
    throw new Error(`Unexpected offline request: ${unexpected.at(-1)}`);
  };
  const context = vm.createContext({
    fetch, councilOutcome, URL,
    AbortSignal: { timeout: () => undefined },
    setTimeout: callback => { callback(); return 0; },
    process: { env, exit: code => { exits.push(code); } },
    console: { log: (...v) => logs.push(v.join(' ')), error: (...v) => logs.push(v.join(' ')) },
  });
  const completion = new vm.Script(executable, { filename: sourcePath }).runInContext(context, { timeout: 2000 });
  assert.equal(typeof completion?.then, 'function', 'Actual main() promise must execute');
  await completion;
  assert.deepEqual(unexpected, [], 'Fixture drift must not look like an expected script failure');
  const skipped = logs.some(v => v.startsWith('[skip]'));
  const ranEveryProvider = configured.length > 0 && configured.every(id => calls[id] >= 2);
  const pass = spec.expect === 'skip'
    ? skipped && posted.length === 0 && Object.values(calls).every(n => n === 0) && exits.length === 0
    : spec.expect === 'configuration-error'
      ? !skipped && exits.includes(1) && posted.length === 0 && logs.some(v => v.includes('등록된 AI API 키가 없습니다'))
      : !skipped && ranEveryProvider && posted.length === configured.length * 2 && exits.length === 0;
  return { name: spec.name, expected: spec.expect, pass, skipped, calls, posted: posted.length, exits };
}

const results = [];
for (const spec of cases) results.push(await observe(spec));
const failed = results.filter(r => !r.pass).length;
console.log(JSON.stringify({
  sourcePath, sourceSha256: createHash('sha256').update(source).digest('hex'),
  mode: 'OFFLINE_FIXTURES_ONLY', networkRequests: 0,
  passed: results.length - failed, failed, results,
}, null, 2));
process.exitCode = failed ? 1 : 0;

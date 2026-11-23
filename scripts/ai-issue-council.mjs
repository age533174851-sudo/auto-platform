#!/usr/bin/env node
const GITHUB_API = "https://api.github.com";

const EVENT_NAME = (process.env.EVENT_NAME || "workflow_dispatch").trim();
const REPO = (process.env.GITHUB_REPOSITORY || "age533174851-sudo/auto-platform").trim();
const ISSUE_NUMBER = Number(process.env.ISSUE_NUMBER || "724");
const BASE_BRANCH = (process.env.BASE_BRANCH || "main").trim();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();
const ANTHROPIC_MODEL = (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514").trim();

const SECRET_VALUES = [GITHUB_TOKEN, GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY]
  .filter((v) => v && v.length >= 8);

for (const s of SECRET_VALUES) console.log(`::add-mask::${s}`);

function redact(text) {
  let safe = String(text || "");
  for (const s of SECRET_VALUES) safe = safe.split(s).join("[REDACTED]");
  return safe
    .replace(/\bAIza[0-9A-Za-z\-_]{20,}\b/g, "[REDACTED_KEY]")
    .replace(/\bsk-(?:proj-|ant-)?[0-9A-Za-z\-_]{16,}\b/g, "[REDACTED_KEY]")
    .replace(/\bgh[pousr]_[0-9A-Za-z]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bgithub_pat_[0-9A-Za-z_]{20,}\b/g, "[REDACTED_TOKEN]");
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${redact(text).slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const ghHeaders = () => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "traigo-ai-council",
  "Content-Type": "application/json",
});

async function getLatestComments(owner, repo, total, limit = 12) {
  if (!total) return [];
  const lastPage = Math.max(1, Math.ceil(total / 100));
  let list = await fetchJson(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/comments?per_page=100&page=${lastPage}`,
    { headers: ghHeaders() },
  );
  if (list.length < limit && lastPage > 1) {
    const prev = await fetchJson(
      `${GITHUB_API}/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/comments?per_page=100&page=${lastPage - 1}`,
      { headers: ghHeaders() },
    );
    list = [...prev, ...list];
  }
  return list.slice(-limit);
}

async function postComment(owner, repo, body) {
  return fetchJson(`${GITHUB_API}/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/comments`, {
    method: "POST",
    headers: ghHeaders(),
    body: JSON.stringify({ body: redact(body) }),
  });
}

async function callGemini(system, user) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const data = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
    }),
  });
  return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n").trim();
}

async function callOpenAI(system, user) {
  const data = await fetchJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function callAnthropic(system, user) {
  const data = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  return (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

const PROVIDERS = [
  { id: "GEMINI", key: GEMINI_API_KEY, model: GEMINI_MODEL, call: callGemini },
  { id: "OPENAI", key: OPENAI_API_KEY, model: OPENAI_MODEL, call: callOpenAI },
  { id: "ANTHROPIC", key: ANTHROPIC_API_KEY, model: ANTHROPIC_MODEL, call: callAnthropic },
];

async function main() {
  const [owner, repo] = REPO.split("/");
  const startedAt = new Date(Date.now() - 60_000).toISOString();

  const branch = await fetchJson(`${GITHUB_API}/repos/${owner}/${repo}/branches/${BASE_BRANCH}`, { headers: ghHeaders() });
  const shortSha = (branch?.commit?.sha || "unknown").slice(0, 7);
  const taskId = (process.env.TASK_ID || "").trim() || `AUTO-${shortSha}`;
  const runId = `${taskId}-${Date.now().toString(36)}`;

  const issue = await fetchJson(`${GITHUB_API}/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}`, { headers: ghHeaders() });
  const recent = await getLatestComments(owner, repo, issue?.comments || 0, 12);

  const last = recent[recent.length - 1];
  if (
    EVENT_NAME === "schedule" &&
    last &&
    (last.body || "").includes("[R2 | AGENT:") &&
    (last.body || "").includes(`${BASE_BRANCH}@${shortSha}`)
  ) {
    console.log("[skip] 새 댓글이나 새 커밋이 없어 이번 매시 30분 실행을 건너뜁니다.");
    return;
  }

  const prs = await fetchJson(`${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&per_page=50`, { headers: ghHeaders() });
  const context = [
    `저장소: ${REPO} · 기준 커밋: ${BASE_BRANCH}@${shortSha} · 작업 번호: ${taskId}`,
    `\n### 이슈 #${ISSUE_NUMBER} 본문\n${redact(issue?.body || "").slice(0, 3500)}`,
    `\n### 최근 댓글\n${recent.map((c) => `[@${c.user?.login}] ${redact(c.body || "").slice(0, 600)}`).join("\n---\n") || "(없음)"}`,
    `\n### 열린 PR (${prs.length}건)\n${prs.map((p) => `- #${p.number} (${p.head?.ref}): ${p.title}`).join("\n") || "- 없음"}`,
  ].join("\n");

  const system = "너는 TRAIGO 개발팀의 시니어 엔지니어다. 한국어로 간결하고 구체적인 근거·반론·다음 실행안을 작성하라. 비밀값 출력, main 직접 푸시, 배포, 실거래 호출은 절대 금지한다.";

  const active = PROVIDERS.filter((p) => p.key.trim());
  const skipped = PROVIDERS.filter((p) => !p.key.trim()).map((p) => `- ${p.id}: API 키 미등록`);
  if (active.length === 0) throw new Error("등록된 AI API 키가 없습니다.");

  for (const p of active) {
    try {
      const out = await p.call(system, `작업 ${taskId}에 대한 1라운드(R1) 제안 및 점검 의견을 작성하라.\n\n${context}`);
      if (!out) continue;
      await postComment(owner, repo, `[R1 | AGENT: ${p.id}]\n- 작업: \`${taskId}\` · 기준: \`${BASE_BRANCH}@${shortSha}\` · 모델: \`${p.model}\` · 실행ID: \`${runId}\`\n\n${out}`);
    } catch (e) {
      skipped.push(`- ${p.id} R1 오류: ${redact(e.message)}`);
    }
  }

  const fresh = await fetchJson(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/comments?per_page=100&since=${encodeURIComponent(startedAt)}`,
    { headers: ghHeaders() },
  );
  const r1List = fresh
    .map((c) => redact(c.body || ""))
    .filter((b) => b.includes("[R1 | AGENT:") && (b.includes(runId) || b.includes(`\`${taskId}\``)));

  for (const p of active) {
    const peers = r1List.filter((b) => !b.startsWith(`[R1 | AGENT: ${p.id}]`));
    const own = r1List.filter((b) => b.startsWith(`[R1 | AGENT: ${p.id}]`));
    const target = peers.length > 0
      ? peers.join("\n\n---\n\n")
      : `(다른 AI 댓글이 없어 아래 본인 R1 제안을 스스로 반박·검증하라)\n\n${own.join("\n\n")}`;
    if (!target.trim()) continue;

    try {
      const out = await p.call(system, `작업 ${taskId} (${BASE_BRANCH}@${shortSha}) 2라운드(R2) 반론·보완 의견을 작성하라.\n\n${target}`);
      if (!out) continue;
      const note = skipped.length ? `\n\n#### 미참여/오류 기록\n${skipped.join("\n")}` : "";
      await postComment(owner, repo, `[R2 | AGENT: ${p.id}]\n- 작업: \`${taskId}\` · 기준: \`${BASE_BRANCH}@${shortSha}\` · 모델: \`${p.model}\` · 실행ID: \`${runId}\`\n\n${out}${note}`);
    } catch (e) {
      console.log(`[error] ${p.id} R2 실패: ${redact(e.message)}`);
    }
  }
}

main().catch((e) => {
  console.error(redact(e?.stack || e?.message || e));
  process.exit(1);
});

#!/usr/bin/env node
import { councilOutcome } from "./lib/council-outcome.mjs";
const GITHUB_API = "https://api.github.com";

const EVENT_NAME = (process.env.EVENT_NAME || "workflow_dispatch").trim();
const REPO = (process.env.GITHUB_REPOSITORY || "age533174851-sudo/auto-platform").trim();
const ISSUE_NUMBER = Number(process.env.ISSUE_NUMBER || "724");
const BASE_BRANCH = (process.env.BASE_BRANCH || "main").trim();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const rawGeminiModel = (process.env.GEMINI_MODEL || "").trim();
let geminiModel =
  !rawGeminiModel || rawGeminiModel === "gemini-2.5-flash"
    ? "gemini-3.8-flash"
    : rawGeminiModel;
let cachedGeminiModels = null;

const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();

const rawAnthropicModel = (process.env.ANTHROPIC_MODEL || "").trim();
let anthropicModel =
  rawAnthropicModel === "claude-sonnet-4-20250514" ? "" : rawAnthropicModel;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function getAllOpenPrs(owner, repo, maxPages = 5) {
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await fetchJson(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`,
      { headers: ghHeaders() },
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function postComment(owner, repo, body) {
  return fetchJson(`${GITHUB_API}/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/comments`, {
    method: "POST",
    headers: ghHeaders(),
    body: JSON.stringify({ body: redact(body) }),
  });
}

function rankGeminiModel(id) {
  if (/^gemini-3.*flash/i.test(id) && !/lite/i.test(id)) return 1;
  if (/^gemini-3.*flash-lite/i.test(id)) return 2;
  if (/^gemini-3.*pro/i.test(id)) return 3;
  if (/^gemini-2\.5-flash$/i.test(id)) return 4;
  if (/^gemini-2\.5-flash-lite/i.test(id)) return 5;
  if (/^gemini-2\.5-pro/i.test(id)) return 6;
  if (/flash/i.test(id)) return 7;
  return 8;
}

async function listGeminiModels() {
  if (Array.isArray(cachedGeminiModels) && cachedGeminiModels.length > 0) {
    return cachedGeminiModels;
  }
  const list = await fetchJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100", {
    headers: { "x-goog-api-key": GEMINI_API_KEY },
  });
  const names = (list?.models || [])
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => String(m.name || "").replace(/^models\//, ""))
    .filter((id) => /^gemini-/i.test(id) && !/embedding|imagen|veo|tts|audio|image|robotics|computer-use|live/i.test(id));

  names.sort((a, b) => rankGeminiModel(a) - rankGeminiModel(b) || b.localeCompare(a));
  cachedGeminiModels = names;
  return names;
}

async function requestGemini(model, system, user) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
    }),
  });
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n").trim();
  if (!text) console.log(`[warn] GEMINI(${model}) 빈 응답 (finishReason=${data?.candidates?.[0]?.finishReason || "unknown"})`);
  return text;
}

async function callGemini(system, user) {
  const tried = new Set();
  let lastErr = null;

  const attempt = async (model) => {
    tried.add(model);
    return await requestGemini(model, system, user);
  };

  try {
    return await attempt(geminiModel);
  } catch (e) {
    lastErr = e;
    const msg = String(e.message || "");
    const is404 = msg.includes("HTTP 404");
    const isTransient =
      msg.includes("HTTP 503") ||
      msg.includes("HTTP 502") ||
      msg.includes("HTTP 504") ||
      msg.includes("HTTP 429");

    if (!is404 && !isTransient) throw e;

    if (isTransient) {
      console.log(`[info] GEMINI(${geminiModel}) 일시 혼잡 — 2초 후 1회 재시도`);
      await sleep(2000);
      try {
        return await requestGemini(geminiModel, system, user);
      } catch (retryErr) {
        lastErr = retryErr;
        console.log(`[warn] GEMINI(${geminiModel}) 재시도 실패 — 예비 모델 우회 시도`);
      }
    }

    const models = await listGeminiModels().catch(() => []);
    const candidates = models.filter((id) => !tried.has(id)).slice(0, 4);
    for (const fallback of candidates) {
      try {
        console.log(`[info] GEMINI 예비 모델 시도: ${fallback}`);
        const res = await attempt(fallback);
        geminiModel = fallback;
        console.log(`[info] GEMINI 우회 성공 — 현재 모델 전환: ${fallback}`);
        return res;
      } catch (fbErr) {
        lastErr = fbErr;
        console.log(`[warn] GEMINI 예비 모델(${fallback}) 실패: ${redact(fbErr.message).slice(0, 140)}`);
      }
    }
    throw lastErr;
  }
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
  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  if (!text) console.log(`[warn] OPENAI 빈 응답 (finish_reason=${data?.choices?.[0]?.finish_reason || "unknown"})`);
  return text;
}

async function resolveAnthropicModel() {
  const list = await fetchJson("https://api.anthropic.com/v1/models?limit=20", {
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
  });
  const ids = (list?.data || []).map((m) => m.id).filter(Boolean);
  const picked =
    ids.find((id) => /sonnet/i.test(id)) ||
    ids.find((id) => /claude/i.test(id)) ||
    ids[0];
  if (!picked) throw new Error("Anthropic 사용 가능한 모델을 찾지 못했습니다.");
  console.log(`[info] Anthropic 모델 자동 선택: ${picked}`);
  anthropicModel = picked;
  return picked;
}

async function requestAnthropic(model, system, user) {
  const data = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 5000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const text = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!text) {
    const types = (data?.content || []).map((b) => b.type).join(",") || "none";
    console.log(`[warn] ANTHROPIC 빈 응답 (stop_reason=${data?.stop_reason || "unknown"}, blocks=${types})`);
  } else if (data?.stop_reason === "max_tokens") {
    console.log("[warn] ANTHROPIC 응답이 max_tokens(5000)에 도달해 절단되었습니다.");
  }
  return text;
}

async function callAnthropic(system, user) {
  if (!anthropicModel) await resolveAnthropicModel();
  try {
    return await requestAnthropic(anthropicModel, system, user);
  } catch (e) {
    if (String(e.message).includes("HTTP 404")) {
      await resolveAnthropicModel();
      return await requestAnthropic(anthropicModel, system, user);
    }
    throw e;
  }
}

const PROVIDERS = [
  { id: "GEMINI", key: GEMINI_API_KEY, get model() { return geminiModel; }, call: callGemini },
  { id: "OPENAI", key: OPENAI_API_KEY, get model() { return OPENAI_MODEL; }, call: callOpenAI },
  { id: "ANTHROPIC", key: ANTHROPIC_API_KEY, get model() { return anthropicModel || "auto"; }, call: callAnthropic },
];

const COUNCIL_SYSTEM_PROMPT = [
  "너는 TRAIGO(age533174851-sudo/auto-platform)의 7개 AI 동등 협업자 중 하나다.",
  "규칙(docs/AI_COLLABORATION_RULES.md):",
  "1. 특정 AI를 총괄·최종 결정자·지시자로 취급하지 말고 동등하게 분석·설계·오류 수정·테스트·교차 검증에 참여하라.",
  "2. 의견 충돌은 추측이 아니라 실제 코드·테스트·로그·PR 상태를 근거로 비교하고, 합의되지 않은 부분은 검증 근거와 함께 기록하라.",
  "3. 연결되지 않았거나 실제 댓글이 없는 AI와 소통했다고 허위 보고하지 마라.",
  "4. 열린 PR과 동일 파일 충돌·중복 구현을 피하고, 선행 PR 충돌(#343 -> #347 -> #384 등)을 무시한 병합을 제안하지 마라.",
  "5. 비밀값 출력, main 직접 푸시, 운영 배포, 실거래 주문, 운영 DB 변경, 추가 결제는 별도 승인 범위이므로 절대 실행·지시하지 마라.",
  "6. 한국어로 작성하되 각 항목은 핵심 위주 3~5줄 이내로 간결하게 정리하고, 반드시 아래 5개 항목을 끝까지 완결하라:",
  "   - 실제 수행한 작업",
  "   - 확인된 문제와 해결 방안",
  "   - 다른 AI와의 의견 차이",
  "   - 변경 파일과 테스트 (없으면 '없음 — 검토 회차'와 확인한 커밋/PR 근거 명시)",
  "   - 다음에 수행할 작업",
].join("\n");

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

  const prs = await getAllOpenPrs(owner, repo, 5);
  const prScopeNote = prs.length >= 500 ? "조회 상한 500건 도달" : "전체 조회 완료";
  const prLines = prs.map(
    (p) => `- #${p.number} (${p.head?.ref}): ${String(p.title || "").slice(0, 100)}`,
  );

  const context = [
    `저장소: ${REPO} · 기준 커밋: ${BASE_BRANCH}@${shortSha} · 작업 번호: ${taskId}`,
    `\n### 이슈 #${ISSUE_NUMBER} 본문\n${redact(issue?.body || "").slice(0, 3500)}`,
    `\n### 최근 댓글\n${recent.map((c) => `[@${c.user?.login}] ${redact(c.body || "").slice(0, 600)}`).join("\n---\n") || "(없음)"}`,
    `\n### 열린 PR (총 ${prs.length}건 · ${prScopeNote})\n${prLines.join("\n") || "- 없음"}`,
  ].join("\n");

  const active = PROVIDERS.filter((p) => p.key.trim());
  const keyless = PROVIDERS.filter((p) => !p.key.trim()).map((p) => p.id);
  const skipped = PROVIDERS.filter((p) => !p.key.trim()).map((p) => `- ${p.id}: API 키 미등록`);
  if (active.length === 0) throw new Error("등록된 AI API 키가 없습니다.");

  let posted = 0;
  const r1Errors = [];
  const r2Errors = [];
  const r1PostedBodies = [];

  for (const p of active) {
    try {
      const out = await p.call(
        COUNCIL_SYSTEM_PROMPT,
        `작업 ${taskId}에 대한 1라운드(R1) 분석·점검 의견을 5개 필수 공유 항목 형식에 맞춰 작성하라.\n\n${context}`,
      );
      if (!out) continue;
      const body = `[R1 | AGENT: ${p.id}]\n- 작업: \`${taskId}\` · 기준: \`${BASE_BRANCH}@${shortSha}\` · 모델: \`${p.model}\` · 실행ID: \`${runId}\`\n\n${out}`;
      await postComment(owner, repo, body);
      r1PostedBodies.push(redact(body));
      posted += 1;
    } catch (e) {
      const msg = redact(e.message);
      r1Errors.push(msg);
      skipped.push(`- ${p.id} R1 오류: ${msg}`);
      console.error(`[error] ${p.id} R1 실패: ${msg}`);
    }
  }

  const fresh = await fetchJson(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/comments?per_page=100&since=${encodeURIComponent(startedAt)}`,
    { headers: ghHeaders() },
  );
  const fetchedR1 = fresh
    .map((c) => redact(c.body || ""))
    .filter((b) => b.includes("[R1 | AGENT:") && (b.includes(runId) || b.includes(`\`${taskId}\``)));
  const r1List = fetchedR1.length > 0 ? fetchedR1 : r1PostedBodies;

  if (r1List.length === 0) {
    console.log("[info] R1 댓글이 없어 R2를 건너뜁니다.");
  }

  for (const p of active) {
    if (r1List.length === 0) break;
    const peers = r1List.filter((b) => !b.startsWith(`[R1 | AGENT: ${p.id}]`));
    const own = r1List.filter((b) => b.startsWith(`[R1 | AGENT: ${p.id}]`));
    const target = peers.length > 0
      ? peers.join("\n\n---\n\n")
      : own.length > 0
        ? `(다른 AI 댓글이 없어 아래 본인 R1 제안을 스스로 반박·검증하라)\n\n${own.join("\n\n")}`
        : "";
    if (!target.trim()) continue;

    try {
      const out = await p.call(
        COUNCIL_SYSTEM_PROMPT,
        `작업 ${taskId} (${BASE_BRANCH}@${shortSha}) 2라운드(R2) 교차 검증·반론·보완 의견을 5개 필수 공유 항목 형식에 맞춰 작성하라. 실제로 기록된 R1 댓글만 인용하고 미참여 AI와 소통했다고 적지 마라.\n\n${target}`,
      );
      if (!out) continue;
      const note = skipped.length ? `\n\n#### 미참여/오류 기록\n${skipped.join("\n")}` : "";
      await postComment(owner, repo, `[R2 | AGENT: ${p.id}]\n- 작업: \`${taskId}\` · 기준: \`${BASE_BRANCH}@${shortSha}\` · 모델: \`${p.model}\` · 실행ID: \`${runId}\`\n\n${out}${note}`);
      posted += 1;
    } catch (e) {
      const msg = redact(e.message);
      r2Errors.push(msg);
      console.error(`[error] ${p.id} R2 실패: ${msg}`);
    }
  }

  return councilOutcome({ posted, r1Errors, r2Errors, keyless });
}

main()
  .then((outcome) => {
    if (!outcome) return;
    console.log(`[council] ${outcome.summary}`);
    if (!outcome.ok) {
      console.error(`[council] 실패로 끝냅니다 — ${outcome.summary}`);
      process.exit(outcome.exitCode);
    }
  })
  .catch((e) => {
    console.error(redact(e?.stack || e?.message || e));
    process.exit(1);
  });

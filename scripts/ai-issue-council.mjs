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

const rawGeminiModel = (process.env.GEMINI_MODEL || "").trim();
const GEMINI_MODEL =
  !rawGeminiModel || rawGeminiModel === "gemini-2.5-flash"
    ? "gemini-3.8-flash"
    : rawGeminiModel;

const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();

const rawAnthropicModel = (process.env.ANTHROPIC_MODEL || "").trim();
let anthropicModel =
  rawAnthropicModel === "claude-sonnet-4-20250514" ? "" : rawAnthropicModel;

const SECRET_VALUES = [GITHUB_TOKEN, GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY]
  .filter((v) => v && v.length >= 8);

for (const s of SECRET_VALUES) console.log(`::add-mask::${s}`);  function redact(text) { let safe = String(text \vert{}\vert{} ""); for (const s of SECRET_VALUES) safe = safe.split(s).join("[REDACTED]"); return safe .replace(/\bAIza[0-9A-Za-z\-_]{20,}\b/g, "[REDACTED_KEY]") .replace(/\bsk-(?:proj-\vert{}ant-)?[0-9A-Za-z\-_]{16,}\b/g, "[REDACTED_KEY]") .replace(/\bgh[pousr]_[0-9A-Za-z]{20,}\b/g, "[REDACTED_TOKEN]") .replace(/\bgithub_pat_[0-9A-Za-z_]{20,}\b/g, "[REDACTED_TOKEN]"); }  async function fetchJson(url, options = {}) { const res = await fetch(url, { ...options, signal: AbortSignal.timeout(60_000) }); const text = await res.text(); if (!res.ok) throw new Error(`HTTP ${res.status}: ${redact(text).slice(0, 300)}`); return text ? JSON.parse(text) : null; }  const ghHeaders = () => ({ Accept: "application/vnd.github+json", Authorization: `Bearer ${GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "traigo-ai-council",
  "Content-Type": "application/json",
});

async function getLatestComments(owner, repo, total, limit = 12) {
  if (!total) return [];
  const lastPage = Math.max(1, Math.ceil(total / 100));
  let list = await fetchJson(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/comments?per_page=10

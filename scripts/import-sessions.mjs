#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "../src/config.mjs";

const SOURCES = new Set(["claude-code", "codex", "generic"]);
const MAX_SUMMARY_LENGTH = 1_400;

function usage() {
  console.error("Usage: import-sessions --source <claude-code|codex|generic> --input <file-or-directory> [--input <...>] [--project <name>] [--commit] [--limit <n>] [--bridge <path>]");
  process.exit(1);
}

function argumentsFrom(argv) {
  const result = { inputs: [], commit: false, limit: 100, bridge: config.bridgePath };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--source") result.source = argv[++index];
    else if (value === "--input") result.inputs.push(argv[++index]);
    else if (value === "--project") result.project = argv[++index];
    else if (value === "--bridge") result.bridge = argv[++index];
    else if (value === "--limit") result.limit = Number(argv[++index]);
    else if (value === "--commit") result.commit = true;
    else if (value === "--dry-run") result.commit = false;
    else usage();
  }
  if (!SOURCES.has(result.source) || !result.inputs.length || !Number.isInteger(result.limit) || result.limit < 1 || result.limit > 5_000) usage();
  return result;
}

async function jsonlFiles(input) {
  const path = resolve(input);
  const details = await stat(path);
  if (details.isFile()) return [path];
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
    }
  }
  await walk(path);
  return files.sort();
}

function textFrom(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return textFrom(value.content);
  return "";
}

function sanitize(value) {
  return String(value ?? "")
    .replace(/sk-[\w-]{12,}|AKIA\w{16}|gh[pousr]_[\w-]{12,}|xox[baprs]-[\w-]{10,}|Bearer\s+[\w.=-]{12,}/gi, "[redacted-secret]")
    .replace(/(?:api[_-]?key|secret|token|password|authorization)\s*[:=]\s*[^\s,;]{6,}/gi, "$1=[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/\+?\d[\d ()-]{8,}\d/g, "[redacted-phone]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUMMARY_LENGTH);
}

function projectFrom(cwd, fallback) {
  const cleaned = String(cwd ?? "").replace(/\\/g, "/").replace(/\/$/, "");
  const candidate = cleaned ? basename(cleaned) : fallback;
  return sanitize(candidate).replace(/[^\p{L}\p{N}_.-]+/gu, "-").slice(0, 120) || fallback;
}

function parseRows(content) {
  return content.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function candidateFromClaude(rows, path, projectOverride) {
  const messages = rows.filter((row) => row.type === "assistant" && row.message?.role === "assistant");
  const last = messages.at(-1);
  const project = projectOverride ?? projectFrom(rows.find((row) => row.cwd)?.cwd, "claude-code");
  const session = String(rows.find((row) => row.sessionId)?.sessionId ?? basename(path, ".jsonl")).slice(-12);
  const summary = sanitize(textFrom(last?.message?.content));
  return summary ? { project, agent: "claude-code", title: `Claude Code session ${session}`, summary, source_file: path } : null;
}

function candidateFromCodex(rows, path, projectOverride) {
  const messages = rows.filter((row) => row.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "assistant");
  const last = messages.at(-1);
  const cwd = rows.find((row) => row.type === "session_meta")?.payload?.cwd;
  const project = projectOverride ?? projectFrom(cwd, "codex");
  const session = String(rows.find((row) => row.type === "session_meta")?.payload?.id ?? basename(path, ".jsonl")).slice(-12);
  const summary = sanitize(textFrom(last?.payload?.content));
  return summary ? { project, agent: "codex", title: `Codex session ${session}`, summary, source_file: path } : null;
}

function candidatesFromGeneric(rows, path, projectOverride) {
  return rows.map((row, index) => {
    const summary = sanitize(row.summary ?? row.content ?? row.text);
    if (!summary) return null;
    const project = projectOverride ?? projectFrom(row.project ?? row.cwd, "imported-memory");
    const agent = ["codex", "claude-code", "other"].includes(row.agent) ? row.agent : "other";
    return {
      project,
      agent,
      title: sanitize(row.title ?? `Imported session ${basename(path, ".jsonl")}#${index + 1}`).slice(0, 240),
      summary,
      source_file: path,
    };
  }).filter(Boolean);
}

async function candidatesForFile(source, path, project) {
  const rows = parseRows(await readFile(path, "utf8"));
  if (source === "claude-code") return [candidateFromClaude(rows, path, project)].filter(Boolean);
  if (source === "codex") return [candidateFromCodex(rows, path, project)].filter(Boolean);
  return candidatesFromGeneric(rows, path, project);
}

function record(candidate, bridge) {
  const execution = spawnSync(bridge, [
    "record", "--project", candidate.project, "--type", "session", "--title", candidate.title,
    "--summary", candidate.summary, "--agent", candidate.agent, "--validation", "Imported locally via You're Always on My Mind.",
  ], { encoding: "utf8" });
  if (execution.status !== 0) throw new Error(String(execution.stderr || execution.stdout || "Bridge import failed").trim());
  return JSON.parse(execution.stdout.trim());
}

const options = argumentsFrom(process.argv.slice(2));
const files = (await Promise.all(options.inputs.map(jsonlFiles))).flat().slice(0, options.limit);
const candidates = (await Promise.all(files.map((path) => candidatesForFile(options.source, path, options.project)))).flat().slice(0, options.limit);
const records = options.commit ? candidates.map((candidate) => ({ ...candidate, result: record(candidate, options.bridge) })) : candidates;
console.log(JSON.stringify({ source: options.source, mode: options.commit ? "committed" : "dry-run", files_scanned: files.length, candidates: records.length, records }, null, 2));

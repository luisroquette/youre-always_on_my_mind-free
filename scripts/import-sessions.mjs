#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "../src/config.mjs";

const SOURCES = new Set(["claude-code", "codex", "cursor", "replit", "generic"]);
const MAX_SUMMARY_LENGTH = 1_400;

function usage() {
  console.error("Usage: import-sessions --source <claude-code|codex|cursor|replit|generic> --input <file-or-directory> [--input <...>] [--project <name>] [--commit] [--limit <n>] [--bridge <path>]");
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

function supportedExtensions(source) {
  if (source === "cursor") return new Set([".md", ".markdown"]);
  if (source === "replit") return new Set([".json", ".jsonl"]);
  return new Set([".jsonl"]);
}

async function sourceFiles(input, source) {
  const path = resolve(input);
  const details = await stat(path);
  if (details.isFile()) return [path];
  const extensions = supportedExtensions(source);
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) files.push(child);
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
  const trimmed = content.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {}
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

function frontMatterValue(content, key) {
  const match = content.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function candidateFromCursor(content, path, projectOverride) {
  const sections = [...content.matchAll(/^(?:#{1,6}[ \t]*)?(User|You|Assistant|Cursor|Agent)\s*:?[ \t]*$/gim)];
  const assistantSections = sections.filter((section) => /^(assistant|cursor|agent)$/i.test(section[1]));
  const last = assistantSections.at(-1);
  const next = last ? sections.find((section) => section.index > last.index) : null;
  const summary = sanitize(last ? content.slice(last.index + last[0].length, next?.index).trim() : "");
  const projectSource = frontMatterValue(content, "project") ?? frontMatterValue(content, "workspace") ?? frontMatterValue(content, "cwd");
  const project = projectOverride ?? projectFrom(projectSource, "cursor");
  const session = basename(path, extname(path)).slice(-80);
  return summary ? { project, agent: "other", title: `Cursor session ${session}`, summary, source_file: path } : null;
}

function valuesFrom(value) {
  if (Array.isArray(value)) return value.flatMap(valuesFrom);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(valuesFrom)];
}

function replitProject(rows, fallback) {
  const values = valuesFrom(rows);
  const named = values.find((row) => typeof row.cwd === "string" || typeof row.replSlug === "string" || typeof row.project?.name === "string" || typeof row.repl?.slug === "string");
  return projectFrom(named?.cwd ?? named?.replSlug ?? named?.project?.name ?? named?.repl?.slug, fallback);
}

function candidateFromReplit(rows, path, projectOverride) {
  const values = valuesFrom(rows);
  const messages = values.filter((row) => /^(assistant|agent)$/i.test(String(row.role ?? row.message?.role ?? row.payload?.role ?? "")));
  const lastMessage = messages.at(-1);
  const checkpoints = values.filter((row) => /checkpoint/i.test(String(row.type ?? row.kind ?? "")) && (row.description || row.summary || row.title));
  const lastCheckpoint = checkpoints.at(-1);
  const summary = sanitize(
    textFrom(lastMessage?.content ?? lastMessage?.message?.content ?? lastMessage?.payload?.content)
    || lastMessage?.text
    || lastCheckpoint?.description
    || lastCheckpoint?.summary
    || lastCheckpoint?.title,
  );
  const project = projectOverride ?? replitProject(rows, "replit");
  const session = String(values.find((row) => row.sessionId || row.conversationId || row.id)?.sessionId ?? values.find((row) => row.conversationId)?.conversationId ?? basename(path, extname(path))).slice(-80);
  return summary ? { project, agent: "other", title: `Replit session ${session}`, summary, source_file: path } : null;
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
  const content = await readFile(path, "utf8");
  if (source === "cursor") return [candidateFromCursor(content, path, project)].filter(Boolean);
  const rows = parseRows(content);
  if (source === "claude-code") return [candidateFromClaude(rows, path, project)].filter(Boolean);
  if (source === "codex") return [candidateFromCodex(rows, path, project)].filter(Boolean);
  if (source === "replit") return [candidateFromReplit(rows, path, project)].filter(Boolean);
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
const files = (await Promise.all(options.inputs.map((input) => sourceFiles(input, options.source)))).flat().slice(0, options.limit);
const candidates = (await Promise.all(files.map((path) => candidatesForFile(options.source, path, options.project)))).flat().slice(0, options.limit);
const records = options.commit ? candidates.map((candidate) => ({ ...candidate, result: record(candidate, options.bridge) })) : candidates;
console.log(JSON.stringify({ source: options.source, mode: options.commit ? "committed" : "dry-run", files_scanned: files.length, candidates: records.length, records }, null, 2));

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { QUALITY_METADATA, scoreMemory } from "./memory-quality.mjs";

const memoryRoot = join(homedir(), ".claude-mem");
const databasePath = join(memoryRoot, "claude-mem.db");
const feedbackPath = join(memoryRoot, "gateway-feedback.jsonl");

function fail(message, code = 64) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function sqliteJson(sql) {
  const output = execFileSync("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 10000", databasePath, sql], {
    encoding: "utf8",
    maxBuffer: 12_000_000,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function agentSql(alias = "o") {
  return `CASE WHEN ${alias}.agent_type = 'codex' THEN 'codex' WHEN ${alias}.agent_type = 'claude-code' THEN 'claude' ELSE 'legacy' END`;
}

function secretPatterns() {
  return [
    /\bsk-[A-Za-z0-9_-]{12,}\b/g,
    /\bAKIA[A-Z0-9]{16}\b/g,
    /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\b(api[_-]?key|secret|token|password|authorization|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
    /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,
    /(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?\d{4,5}[-.\s]?\d{4}\b/g,
  ];
}

function redact(value, maximum = 6_000) {
  let text = String(value ?? "").replaceAll("\u0000", "").trim();
  let redactions = 0;
  for (const pattern of secretPatterns()) {
    text = text.replace(pattern, () => {
      redactions += 1;
      return "[DADO SENSÍVEL OCULTO]";
    });
  }
  if (text.length > maximum) text = `${text.slice(0, maximum).trimEnd()}…`;
  return { text, redactions };
}

function jsonList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => typeof item === "string" ? item : JSON.stringify(item));
    if (parsed && typeof parsed === "object") return Object.entries(parsed).map(([key, item]) => `${key}: ${item}`);
  } catch {
    // Historical rows may contain plain text instead of JSON.
  }
  return [String(value)];
}

function sensitivePath(value) {
  const path = String(value).toLowerCase().replaceAll("\\", "/");
  return /(^|\/)\.env($|[./])|(^|\/)(\.claude|\.codex|\.config)(\/|$)|(^|\/)(credentials?|secrets?|tokens?)([._/-]|$)|(^|\/)auth\.(json|ya?ml|toml)$|private[_-]?key/.test(path);
}

function safeList(value, { paths = false, limit = 20, maximum = 800 } = {}) {
  let redactions = 0;
  const records = [];
  for (const item of jsonList(value)) {
    if (paths && sensitivePath(item)) {
      redactions += 1;
      continue;
    }
    const safe = redact(item, maximum);
    redactions += safe.redactions;
    if (safe.text && !records.includes(safe.text)) records.push(safe.text);
    if (records.length >= limit) break;
  }
  return { records, redactions };
}

function feedbackMap() {
  const feedback = new Map();
  if (!existsSync(feedbackPath)) return feedback;
  for (const line of readFileSync(feedbackPath, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (!Number.isInteger(event.observation_id) || !["useful", "incorrect", "obsolete"].includes(event.label)) continue;
      const counts = feedback.get(event.observation_id) ?? { useful: 0, incorrect: 0, obsolete: 0 };
      counts[event.label] += 1;
      feedback.set(event.observation_id, counts);
    } catch {
      // Ignore incomplete append-only log lines.
    }
  }
  return feedback;
}

function qualityStats(project, ids) {
  if (!ids.length) return new Map();
  const rows = sqliteJson(`
WITH project_memories AS (
  SELECT id, created_at_epoch, content_hash, relevance_count,
         length(coalesce(title, '')) AS title_length,
         length(coalesce(narrative, text, '')) AS summary_length,
         length(coalesce(subtitle, '')) AS decision_length,
         CASE WHEN json_valid(facts) THEN json_array_length(facts) ELSE (facts IS NOT NULL AND trim(facts) <> '') END AS facts_count,
         CASE WHEN json_valid(concepts) THEN json_array_length(concepts) ELSE (concepts IS NOT NULL AND trim(concepts) <> '') END AS concepts_count,
         (CASE WHEN json_valid(files_read) THEN json_array_length(files_read) ELSE 0 END
           + CASE WHEN json_valid(files_modified) THEN json_array_length(files_modified) ELSE 0 END) AS files_count,
         CASE WHEN trim(coalesce(title, '')) = '' THEN 1
           ELSE count(*) OVER (PARTITION BY lower(trim(title))) END AS title_duplicate_count,
         CASE WHEN trim(coalesce(content_hash, '')) = '' THEN 1
           ELSE count(*) OVER (PARTITION BY content_hash) END AS content_duplicate_count
  FROM observations
  WHERE project = ${sqlQuote(project)}
)
SELECT *
FROM project_memories
WHERE id IN (${ids.join(",")});
  `);
  return new Map(rows.map((row) => [row.id, row]));
}

function searchTerms(value) {
  return [...String(value ?? "").normalize("NFKC").matchAll(/[\p{L}\p{N}_-]+/gu)]
    .map(([term]) => term)
    .filter((term) => term.length >= 2)
    .slice(0, 12);
}

function browse() {
  const project = option("--project");
  const query = option("--query");
  const type = option("--type", "all");
  const agent = option("--agent", "all");
  const limit = Number(option("--limit", "25"));
  const offset = Number(option("--offset", "0"));
  if (!project) fail("Project is required.");
  if (!["all", "claude", "codex", "legacy"].includes(agent) || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    fail("Invalid project-memory filters.");
  }
  if (type !== "all" && !/^[\p{L}\p{N}_-]{1,80}$/u.test(type)) fail("Invalid memory type.");
  const projectClause = `o.project = ${sqlQuote(project)}`;
  const typeClause = type === "all" ? "" : `AND o.type = ${sqlQuote(type)}`;
  const agentClause = agent === "all" ? "" : `AND ${agentSql()} = ${sqlQuote(agent)}`;
  const terms = searchTerms(query);
  const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
  const from = terms.length
    ? "FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid"
    : "FROM observations o";
  const searchClause = terms.length ? `AND observations_fts MATCH ${sqlQuote(ftsQuery)}` : "";
  const order = terms.length ? "bm25(observations_fts), o.created_at_epoch DESC" : "o.created_at_epoch DESC";
  const rawRecords = sqliteJson(`
SELECT o.id, o.project, o.type, coalesce(o.title, '') AS title, coalesce(o.subtitle, '') AS subtitle,
       o.created_at, o.created_at_epoch, ${agentSql()} AS agent, coalesce(o.generated_by_model, '') AS generated_by_model,
       length(coalesce(o.text, '')) + length(coalesce(o.narrative, '')) + length(coalesce(o.facts, '')) AS content_bytes,
       substr(coalesce(nullif(o.subtitle, ''), nullif(o.text, ''), o.narrative, ''), 1, 700) AS preview
${from}
WHERE ${projectClause} ${typeClause} ${agentClause} ${searchClause}
ORDER BY ${order}
LIMIT ${limit} OFFSET ${offset};
  `);
  const feedback = feedbackMap();
  const scores = qualityStats(project, rawRecords.map(({ id }) => id));
  const records = rawRecords.map((record) => {
    const title = redact(record.title, 300);
    const subtitle = redact(record.subtitle, 500);
    const preview = redact(record.preview, 500);
    const model = redact(record.generated_by_model, 200);
    return {
      ...record,
      title: title.text,
      subtitle: subtitle.text,
      preview: preview.text,
      generated_by_model: model.text,
      quality: scoreMemory({ ...scores.get(record.id), feedback: feedback.get(record.id) }),
      redacted: title.redactions + subtitle.redactions + preview.redactions + model.redactions > 0,
    };
  });
  const [{ total = 0 } = {}] = sqliteJson(`
SELECT count(*) AS total
${from}
WHERE ${projectClause} ${typeClause} ${agentClause} ${searchClause};
  `);
  const types = sqliteJson(`SELECT type, count(*) AS count FROM observations WHERE project = ${sqlQuote(project)} GROUP BY type ORDER BY count DESC, type;`);
  const agents = sqliteJson(`SELECT ${agentSql()} AS agent, count(*) AS count FROM observations o WHERE o.project = ${sqlQuote(project)} GROUP BY agent ORDER BY count DESC;`);
  return {
    project,
    query,
    filters: { type, agent },
    total,
    returned: records.length,
    limit,
    offset,
    has_more: offset + records.length < total,
    facets: { types, agents },
    quality_metadata: QUALITY_METADATA,
    records,
  };
}

function inspect() {
  const id = Number(option("--id"));
  const project = option("--project");
  if (!Number.isInteger(id) || id < 1) fail("A positive observation ID is required.");
  const projectClause = project ? `AND project = ${sqlQuote(project)}` : "";
  const [record] = sqliteJson(`
SELECT id, project, type, title, subtitle, text, facts, narrative, concepts, files_read, files_modified,
       created_at, created_at_epoch, agent_type, generated_by_model, relevance_count, content_hash
FROM observations
WHERE id = ${id} ${projectClause}
LIMIT 1;
  `);
  if (!record) fail("Memory observation not found.", 66);
  const title = redact(record.title, 400);
  const decision = redact(record.subtitle, 2_000);
  const summary = redact(record.narrative || record.text, 6_000);
  const facts = safeList(record.facts, { limit: 16, maximum: 1_000 });
  const concepts = safeList(record.concepts, { limit: 20, maximum: 300 });
  const filesRead = safeList(record.files_read, { paths: true, limit: 30, maximum: 400 });
  const filesModified = safeList(record.files_modified, { paths: true, limit: 30, maximum: 400 });
  const redactionCount = title.redactions + decision.redactions + summary.redactions + facts.redactions + concepts.redactions + filesRead.redactions + filesModified.redactions;
  const feedback = feedbackMap().get(record.id) ?? { useful: 0, incorrect: 0, obsolete: 0 };
  const score = scoreMemory({
    ...qualityStats(record.project, [record.id]).get(record.id),
    feedback,
  });
  return {
    id: record.id,
    project: record.project,
    type: record.type,
    title: title.text,
    decision: decision.text,
    summary: summary.text,
    facts: facts.records,
    concepts: concepts.records,
    files_read: filesRead.records,
    files_modified: filesModified.records,
    created_at: record.created_at,
    agent: record.agent_type === "codex" ? "codex" : record.agent_type === "claude-code" ? "claude" : "legacy",
    generated_by_model: redact(record.generated_by_model, 200).text,
    relevance_count: Number(record.relevance_count ?? 0),
    feedback,
    quality: score,
    quality_metadata: QUALITY_METADATA,
    content_available: Boolean(summary.text || decision.text || facts.records.length || concepts.records.length || filesRead.records.length || filesModified.records.length),
    redacted: redactionCount > 0,
    redaction_count: redactionCount,
  };
}

const command = process.argv[2];
if (command === "browse") process.stdout.write(`${JSON.stringify(browse())}\n`);
else if (command === "inspect") process.stdout.write(`${JSON.stringify(inspect())}\n`);
else fail("Usage: project-memory.mjs {browse|inspect} [options]");

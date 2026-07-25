import { appendFile, mkdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildAutomaticClusters, buildSemanticRelations } from "../semantic-relations.mjs";
import { config } from "./config.mjs";

const execFileAsync = promisify(execFile);
const BRIDGE_PATH = config.bridgePath;
const FEEDBACK_PATH = config.feedbackPath;
const CHARACTER_LIMIT = 20_000;
let relationsCache;
let relationsCacheExpiresAt = 0;

function toolResult(payload, isError = false) {
  const text = JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text: text.length > CHARACTER_LIMIT ? `${text.slice(0, CHARACTER_LIMIT)}\n[truncated]` : text }], ...(isError ? { isError: true } : {}) };
}

async function bridge(args) {
  let lastError;
  const maximumAttempts = args[0] === "cleanup-delete" ? 1 : 3;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const isSemantic = args[0] === "semantic" || args[0] === "cleanup-candidates";
      const isHealth = args[0] === "health";
      const isLocalEmbedding = args[0] === "semantic-search";
      const { stdout } = await execFileAsync(BRIDGE_PATH, args, {
        maxBuffer: isSemantic ? 16_000_000 : CHARACTER_LIMIT * 4,
        timeout: isHealth ? 45_000 : isSemantic ? 25_000 : isLocalEmbedding ? 60_000 : 12_000,
      });
      return JSON.parse(stdout.trim());
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  const detail = String(lastError?.stderr ?? lastError?.message ?? "Unknown bridge failure").trim().split("\n").filter(Boolean).at(-1);
  throw new Error(`Memory gateway could not complete the request: ${detail}`);
}

async function semanticRelations() {
  if (relationsCache && Date.now() < relationsCacheExpiresAt) return relationsCache;
  const [payload, rawProjects] = await Promise.all([bridge(["semantic", "120"]), bridge(["projects", "80"])]);
  const projects = rawProjects.map((project) => ({
    ...project,
    claude_observations: (project.claude_observations ?? 0) + (project.other_observations ?? 0),
    codex_observations: project.codex_observations ?? 0,
  }));
  relationsCache = buildSemanticRelations(payload, projects.map(({ project }) => project));
  relationsCache.clusters = buildAutomaticClusters(relationsCache, projects);
  relationsCacheExpiresAt = Date.now() + 60_000;
  return relationsCache;
}

function containsSensitiveData(value) {
  return /(^|[^\w])\.env(\s|$)|sk-[\w-]{16,}|AKIA[\w]{16}|gh[pousr]_[\w]{16,}|xox[baprs]-[\w-]{10,}|Bearer\s+[\w.=-]{12,}|(api[_-]?key|secret|token|password|authorization|private[_-]?key)\s*[:=]\s*\S+/i.test(value);
}

async function feedbackByObservation() {
  try {
    const lines = (await readFile(FEEDBACK_PATH, "utf8")).split("\n").filter(Boolean);
    const feedback = new Map();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (!Number.isInteger(event.observation_id) || !["useful", "incorrect", "obsolete"].includes(event.label)) continue;
        const summary = feedback.get(event.observation_id) ?? { useful: 0, incorrect: 0, obsolete: 0 };
        summary[event.label] += 1;
        feedback.set(event.observation_id, summary);
      } catch { /* Ignore a malformed append-only log line. */ }
    }
    return feedback;
  } catch (error) {
    if (error && error.code === "ENOENT") return new Map();
    throw error;
  }
}

async function rankRecords(records, includeObsolete) {
  const feedback = await feedbackByObservation();
  return records
    .map((record, sourceIndex) => {
      const summary = feedback.get(record.id) ?? { useful: 0, incorrect: 0, obsolete: 0 };
      return { ...record, feedback: summary, feedback_score: (summary.useful * 2) - (summary.incorrect * 3) - (summary.obsolete * 10), sourceIndex };
    })
    .filter((record) => includeObsolete || record.feedback.obsolete === 0)
    .sort((left, right) => right.feedback_score - left.feedback_score || left.sourceIndex - right.sourceIndex)
    .map(({ sourceIndex, ...record }) => record);
}

const server = new McpServer({ name: "youre-always-on-my-mind", version: "0.1.0" });

server.registerTool("search_memory", {
  title: "Search Shared Memory",
  description: "Search local persistent-memory metadata before asking for context already discovered by another agent.",
  inputSchema: { query: z.string().min(2).max(200), project: z.string().min(1).max(120).optional(), limit: z.number().int().min(1).max(50).default(10), include_obsolete: z.boolean().default(false) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, project, limit, include_obsolete }) => {
  try {
    const records = await bridge(project ? ["search", query, "--project", project, "--limit", String(limit)] : ["search", query, String(limit)]);
    const ranked = await rankRecords(records, include_obsolete);
    return toolResult({ count: ranked.slice(0, limit).length, records: ranked.slice(0, limit), ...(project ? { project } : {}), include_obsolete });
  } catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("semantic_search_memory", {
  title: "Search Shared Memory by Meaning",
  description: "Search multilingual local memory by semantic meaning using a cached local model. Queries and memory content never leave the machine.",
  inputSchema: {
    query: z.string().min(2).max(800),
    project: z.string().min(1).max(120).optional(),
    type: z.string().min(1).max(80).default("all"),
    agent: z.enum(["all", "claude", "codex", "legacy"]).default("all"),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).max(100_000).default(0),
    minimum_score: z.number().min(-1).max(1).default(0.12),
    include_obsolete: z.boolean().default(false),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, project, type, agent, limit, offset, minimum_score, include_obsolete }) => {
  if (!/^(all|[\p{L}\p{N}_-]{1,80})$/u.test(type)) return toolResult({ error: "Invalid memory type filter." }, true);
  const args = [
    "semantic-search", "--query", query, "--type", type, "--agent", agent,
    "--limit", String(limit), "--offset", String(offset), "--minimum-score", String(minimum_score),
  ];
  if (project) args.push("--project", project);
  if (include_obsolete) args.push("--include-obsolete");
  try { return toolResult(await bridge(args)); }
  catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_embedding_health", {
  title: "Check Local Semantic Index Health",
  description: "Report local model cache, index coverage, dimensions, size, privacy, and offline readiness without loading the model.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try { return toolResult(await bridge(["embedding-health"])); }
  catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_alerts", {
  title: "Inspect Configurable Memory Alerts",
  description: "List explainable local project alerts for saturation, stale activity, and concrete inconsistency signals.",
  inputSchema: {
    project: z.string().min(1).max(120).optional(),
    kind: z.enum(["all", "saturation", "stale", "inconsistent"]).default("all"),
    severity: z.enum(["all", "critical", "warning"]).default("all"),
    limit: z.number().int().min(1).max(200).default(50),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ project, kind, severity, limit }) => {
  try {
    const payload = await bridge(project ? ["alerts", "--project", project] : ["alerts"]);
    const records = payload.alerts
      .filter((alert) => kind === "all" || alert.kind === kind)
      .filter((alert) => severity === "all" || alert.severity === severity)
      .slice(0, limit);
    return toolResult({ ...payload, alerts: records, returned: records.length });
  } catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_alert_configure", {
  title: "Configure Local Memory Alerts",
  description: "Update local alert thresholds and muted projects, or restore safe defaults. No external notification service is used.",
  inputSchema: {
    reset: z.boolean().default(false),
    enabled: z.boolean().optional(),
    saturation_enabled: z.boolean().optional(),
    saturation_threshold: z.number().int().min(40).max(100).optional(),
    saturation_minimum_observations: z.number().int().min(1).max(100_000).optional(),
    stale_enabled: z.boolean().optional(),
    stale_days: z.number().int().min(7).max(3_650).optional(),
    stale_minimum_observations: z.number().int().min(1).max(100_000).optional(),
    inconsistent_enabled: z.boolean().optional(),
    duplicate_threshold: z.number().int().min(1).max(10_000).optional(),
    incorrect_feedback_threshold: z.number().int().min(1).max(10_000).optional(),
    missing_title_threshold: z.number().int().min(1).max(10_000).optional(),
    muted_projects: z.array(z.string().min(1).max(120)).max(100).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  try {
    if (input.reset) return toolResult(await bridge(["alert-config-reset"]));
    const current = (await bridge(["alert-config-get"])).config;
    const config = {
      ...current,
      enabled: input.enabled ?? current.enabled,
      saturation: {
        ...current.saturation,
        enabled: input.saturation_enabled ?? current.saturation.enabled,
        threshold: input.saturation_threshold ?? current.saturation.threshold,
        minimum_observations: input.saturation_minimum_observations ?? current.saturation.minimum_observations,
      },
      stale: {
        ...current.stale,
        enabled: input.stale_enabled ?? current.stale.enabled,
        days: input.stale_days ?? current.stale.days,
        minimum_observations: input.stale_minimum_observations ?? current.stale.minimum_observations,
      },
      inconsistent: {
        ...current.inconsistent,
        enabled: input.inconsistent_enabled ?? current.inconsistent.enabled,
        duplicate_threshold: input.duplicate_threshold ?? current.inconsistent.duplicate_threshold,
        incorrect_feedback_threshold: input.incorrect_feedback_threshold ?? current.inconsistent.incorrect_feedback_threshold,
        missing_title_threshold: input.missing_title_threshold ?? current.inconsistent.missing_title_threshold,
      },
      muted_projects: input.muted_projects ?? current.muted_projects,
    };
    return toolResult(await bridge(["alert-config-set", "--json", JSON.stringify(config)]));
  } catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("record_memory", {
  title: "Record Shared Memory",
  description: "Record a concise, non-sensitive task outcome. Rejects likely secrets and duplicate project/title entries within 24 hours. Use dry_run before uncertain writes.",
  inputSchema: {
    title: z.string().min(4).max(240), summary: z.string().max(2_000).default(""), project: z.string().min(1).max(120).optional(),
    type: z.enum(["discovery", "feature", "bugfix", "refactor", "change", "decision", "session"]).default("change"),
    decision: z.string().max(1_000).optional(), files: z.array(z.string().min(1).max(300)).max(50).default([]), validation: z.string().max(1_000).optional(),
    agent: z.enum(["codex", "claude-code", "other"]).default("codex"), dry_run: z.boolean().default(false), force: z.boolean().default(false),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  if ([input.title, input.summary, input.decision ?? "", input.files.join(","), input.validation ?? ""].some(containsSensitiveData)) {
    return toolResult({ error: "Refusing to record possible secret, credential, token, or .env reference." }, true);
  }
  const args = ["record", "--title", input.title, "--summary", input.summary, "--type", input.type, "--agent", input.agent];
  if (input.project) args.push("--project", input.project);
  if (input.decision) args.push("--decision", input.decision);
  if (input.files.length) args.push("--files", input.files.join(","));
  if (input.validation) args.push("--validation", input.validation);
  if (input.dry_run) args.push("--dry-run");
  if (input.force) args.push("--force");
  try { return toolResult(await bridge(args)); }
  catch (error) { return toolResult({ error: error.message, hint: "Use dry_run to preview or force only for a deliberate correction." }, true); }
});

server.registerTool("memory_health", {
  title: "Check Shared Memory Health",
  description: "Verify SQLite integrity, bridge schema compatibility, FTS readiness, and feedback-log location. Use full=true for a complete SQLite integrity check.",
  inputSchema: { full: z.boolean().default(false) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ full }) => {
  try { return toolResult({ ...(await bridge(full ? ["health", "--full"] : ["health"])), feedback_log: FEEDBACK_PATH }); }
  catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_relations", {
  title: "Inspect Shared Memory Relations",
  description: "List explainable local semantic relations between projects using shared files, topics, and decisions. No external model or API is used.",
  inputSchema: {
    project: z.string().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(30).default(10),
    minimum_score: z.number().min(0).max(1).default(0),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ project, limit, minimum_score }) => {
  try {
    const graph = await semanticRelations();
    const records = graph.relations
      .filter((relation) => !project || relation.source === project || relation.target === project)
      .filter((relation) => relation.score >= minimum_score)
      .slice(0, limit);
    return toolResult({
      count: records.length,
      records,
      metadata: graph.metadata,
      ...(project ? { project, metrics: graph.project_metrics[project] ?? { connections: 0, semantic_strength: 0 } } : {}),
    });
  } catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_clusters", {
  title: "Inspect Automatic Memory Clusters",
  description: "Group projects locally by product community, inferred client, dominant technology, or Claude/Codex agent composition.",
  inputSchema: {
    axis: z.enum(["product", "client", "technology", "agent"]).default("product"),
    project: z.string().min(1).max(120).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ axis, project }) => {
  try {
    const graph = await semanticRelations();
    const records = graph.clusters.axes[axis]
      .filter((cluster) => !project || cluster.projects.includes(project));
    return toolResult({
      axis,
      count: records.length,
      records,
      metadata: graph.clusters.metadata,
      ...(project ? { project, membership: graph.clusters.project_memberships[project]?.[axis] ?? null } : {}),
    });
  } catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_timeline", {
  title: "Inspect Memory Timeline",
  description: "Aggregate local historical growth, project saturation, concentration, and Claude/Codex participation without exposing memory contents.",
  inputSchema: {
    range: z.enum(["30", "90", "180", "365", "all"]).default("90"),
    bucket: z.enum(["auto", "day", "week", "month"]).default("auto"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ range, bucket }) => {
  try { return toolResult(await bridge(["timeline", range, bucket])); }
  catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_project_browse", {
  title: "Browse Project Memories",
  description: "List, search, filter, and paginate sanitized individual memories inside one project. Secret-like content and sensitive paths are redacted locally.",
  inputSchema: {
    project: z.string().min(1).max(120),
    query: z.string().max(200).default(""),
    type: z.string().min(1).max(80).default("all"),
    agent: z.enum(["all", "claude", "codex", "legacy"]).default("all"),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).max(100_000).default(0),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ project, query, type, agent, limit, offset }) => {
  if (type !== "all" && !/^[\p{L}\p{N}_-]{1,80}$/u.test(type)) return toolResult({ error: "Invalid memory type filter." }, true);
  try {
    const args = [
      "project-memories", "--project", project, "--type", type, "--agent", agent,
      "--limit", String(limit), "--offset", String(offset),
    ];
    if (query) args.push("--query", query);
    return toolResult(await bridge(args));
  } catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_observation_detail", {
  title: "Inspect Individual Project Memory",
  description: "Open one sanitized memory in explicit project scope, including content, feedback, redaction status, and its explainable quality score.",
  inputSchema: {
    project: z.string().min(1).max(120),
    observation_id: z.number().int().positive(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ project, observation_id }) => {
  try { return toolResult(await bridge(["inspect-memory", "--id", String(observation_id), "--project", project])); }
  catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_quality_score", {
  title: "Inspect Memory Quality Score",
  description: "Calculate a local explainable 0-100 score for relevance, redundancy, age, utility, overall quality, and deletion risk. Deletion risk 100 means dangerous to delete.",
  inputSchema: {
    project: z.string().min(1).max(120),
    observation_id: z.number().int().positive(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ project, observation_id }) => {
  try {
    const record = await bridge(["inspect-memory", "--id", String(observation_id), "--project", project]);
    return toolResult({
      id: record.id,
      project: record.project,
      title: record.title,
      quality: record.quality,
      quality_metadata: record.quality_metadata,
    });
  } catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_cleanup_candidates", {
  title: "Inspect Safe Cleanup Candidates",
  description: "List local duplicate or explicitly obsolete memory candidates. Similar-title records are marked for manual review and are never deleted automatically.",
  inputSchema: {
    project: z.string().min(1).max(120).optional(),
    kind: z.enum(["all", "duplicate", "obsolete"]).default("all"),
    limit: z.number().int().min(1).max(500).default(250),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ project, kind, limit }) => {
  try {
    const args = ["cleanup-candidates", "--kind", kind, "--limit", String(limit)];
    if (project) args.push("--project", project);
    return toolResult(await bridge(args));
  } catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_cleanup_preview", {
  title: "Preview Memory Cleanup Impact",
  description: "Validate selected cleanup candidates and return the pruning simulation, project impact, recoverability policy, exact confirmation phrase, and a one-time snapshot token. Does not delete anything.",
  inputSchema: { observation_ids: z.array(z.number().int().positive()).min(1).max(500) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ observation_ids }) => {
  try {
    const ids = [...new Set(observation_ids)].sort((left, right) => left - right);
    return toolResult(await bridge(["cleanup-preview", "--ids", ids.join(",")]));
  } catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_cleanup_simulate", {
  title: "Simulate Memory Pruning",
  description: "Read-only pruning simulation. Estimates selected content, internally reusable space, immediate file reduction, potential reduction after compaction, quarantine footprint, and project impact without changing the database.",
  inputSchema: { observation_ids: z.array(z.number().int().positive()).min(1).max(500) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ observation_ids }) => {
  try {
    const ids = [...new Set(observation_ids)].sort((left, right) => left - right);
    return toolResult(await bridge(["cleanup-simulate", "--ids", ids.join(",")]));
  } catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_cleanup_execute", {
  title: "Execute Confirmed Memory Cleanup",
  description: "Permanently delete the exact candidate snapshot after explicit phrase confirmation. Creates a restricted SQLite quarantine of every selected row and an append-only audit event before reporting success.",
  inputSchema: {
    observation_ids: z.array(z.number().int().positive()).min(1).max(500),
    confirmation_token: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation_phrase: z.string().min(9).max(32),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ observation_ids, confirmation_token, confirmation_phrase }) => {
  const ids = [...new Set(observation_ids)].sort((left, right) => left - right);
  if (confirmation_phrase !== `EXCLUIR ${ids.length}`) {
    return toolResult({ error: `Confirmation phrase must be exactly "EXCLUIR ${ids.length}".` }, true);
  }
  try {
    const result = await bridge([
      "cleanup-delete", "--ids", ids.join(","), "--confirm-token", confirmation_token, "--phrase", confirmation_phrase,
    ]);
    relationsCache = undefined;
    relationsCacheExpiresAt = 0;
    return toolResult(result);
  } catch (error) { return toolResult({ error: error.message }, true); }
});

server.registerTool("memory_feedback", {
  title: "Record Memory Feedback",
  description: "Audit useful, incorrect, or obsolete feedback without modifying the original claude-mem observation.",
  inputSchema: { observation_id: z.number().int().positive(), label: z.enum(["useful", "incorrect", "obsolete"]), note: z.string().max(1_000).optional(), agent: z.enum(["codex", "claude-code", "other"]).default("codex") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ observation_id, label, note = "", agent }) => {
  if (containsSensitiveData(note)) return toolResult({ error: "Refusing feedback containing possible sensitive data." }, true);
  try {
    await mkdir(config.dataDirectory, { recursive: true });
    const event = { observation_id, label, note, agent, created_at: new Date().toISOString() };
    await appendFile(FEEDBACK_PATH, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    return toolResult({ recorded: true, ...event });
  } catch (error) { return toolResult({ error: `Could not append feedback: ${error.message}` }, true); }
});

await server.connect(new StdioServerTransport());

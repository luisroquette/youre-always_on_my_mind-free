#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const memoryRoot = join(homedir(), ".claude-mem");
const databasePath = join(memoryRoot, "claude-mem.db");
const feedbackPath = join(memoryRoot, "gateway-feedback.jsonl");
const backupRoot = join(memoryRoot, "backups");
const auditPath = join(memoryRoot, "gateway-cleanup-audit.jsonl");

function fail(message, code = 64) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function sqliteJson(sql) {
  const output = execFileSync("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 10000", databasePath, sql], {
    encoding: "utf8",
    maxBuffer: 24_000_000,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function parseIds(value) {
  const values = String(value ?? "").split(",").filter(Boolean);
  if (!values.length || values.length > 500 || values.some((value) => !/^[1-9][0-9]*$/.test(value))) {
    fail("Cleanup requires between 1 and 500 positive observation IDs.");
  }
  return [...new Set(values.map(Number))].sort((a, b) => a - b);
}

function readObsoleteIds() {
  if (!existsSync(feedbackPath)) return new Set();
  const obsolete = new Set();
  for (const line of readFileSync(feedbackPath, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.label === "obsolete" && Number.isInteger(event.observation_id)) obsolete.add(event.observation_id);
    } catch {
      // Ignore incomplete append-only log lines.
    }
  }
  return obsolete;
}

function duplicateCandidates() {
  return sqliteJson(`
WITH base AS (
  SELECT
    id, memory_session_id, project, type, coalesce(title, '') AS title,
    created_at, created_at_epoch, agent_type, coalesce(content_hash, '') AS content_hash,
    lower(trim(coalesce(title, ''))) AS normalized_title,
    lower(trim(coalesce(text, '') || '|' || coalesce(narrative, ''))) AS normalized_body,
    length(CAST(coalesce(text, '') AS BLOB)) + length(CAST(coalesce(title, '') AS BLOB)) +
      length(CAST(coalesce(subtitle, '') AS BLOB)) + length(CAST(coalesce(facts, '') AS BLOB)) +
      length(CAST(coalesce(narrative, '') AS BLOB)) + length(CAST(coalesce(concepts, '') AS BLOB)) +
      length(CAST(coalesce(files_read, '') AS BLOB)) + length(CAST(coalesce(files_modified, '') AS BLOB)) +
      length(CAST(coalesce(metadata, '') AS BLOB)) AS estimated_bytes,
    length(CAST(coalesce(title, '') || coalesce(subtitle, '') || coalesce(narrative, '') ||
      coalesce(text, '') || coalesce(facts, '') || coalesce(concepts, '') AS BLOB)) AS searchable_bytes
  FROM observations
),
signals AS (
  SELECT *, 'hash:' || project || ':' || content_hash AS duplicate_key, 3 AS priority, 'Conteúdo idêntico' AS reason
  FROM base WHERE content_hash <> ''
  UNION ALL
  SELECT *, 'body:' || project || ':' || normalized_body, 2, 'Texto idêntico'
  FROM base WHERE normalized_body <> '|'
  UNION ALL
  SELECT *, 'title:' || project || ':' || normalized_title, 1, 'Título repetido'
  FROM base WHERE normalized_title <> ''
),
ranked AS (
  SELECT *,
    row_number() OVER (PARTITION BY duplicate_key ORDER BY created_at_epoch DESC, id DESC) AS duplicate_rank,
    count(*) OVER (PARTITION BY duplicate_key) AS duplicate_count,
    first_value(id) OVER (PARTITION BY duplicate_key ORDER BY created_at_epoch DESC, id DESC) AS keep_id
  FROM signals
),
candidates AS (
  SELECT *,
    row_number() OVER (PARTITION BY id ORDER BY priority DESC, duplicate_count DESC, keep_id DESC) AS signal_rank
  FROM ranked
  WHERE duplicate_count > 1 AND duplicate_rank > 1
)
SELECT id, memory_session_id, project, type, title, created_at, created_at_epoch, agent_type,
       estimated_bytes, searchable_bytes, keep_id, reason,
       CASE WHEN priority >= 2 THEN 'exact' ELSE 'review' END AS confidence
FROM candidates
WHERE signal_rank = 1
ORDER BY priority DESC, created_at_epoch ASC, id ASC;
`);
}

function obsoleteCandidates(ids, existingIds) {
  const missing = [...ids].filter((id) => !existingIds.has(id));
  if (!missing.length) return [];
  return sqliteJson(`
SELECT id, memory_session_id, project, type, coalesce(title, '') AS title, created_at, created_at_epoch, agent_type,
       length(CAST(coalesce(text, '') AS BLOB)) + length(CAST(coalesce(title, '') AS BLOB)) +
         length(CAST(coalesce(subtitle, '') AS BLOB)) + length(CAST(coalesce(facts, '') AS BLOB)) +
         length(CAST(coalesce(narrative, '') AS BLOB)) + length(CAST(coalesce(concepts, '') AS BLOB)) +
         length(CAST(coalesce(files_read, '') AS BLOB)) + length(CAST(coalesce(files_modified, '') AS BLOB)) +
         length(CAST(coalesce(metadata, '') AS BLOB)) AS estimated_bytes,
       length(CAST(coalesce(title, '') || coalesce(subtitle, '') || coalesce(narrative, '') ||
         coalesce(text, '') || coalesce(facts, '') || coalesce(concepts, '') AS BLOB)) AS searchable_bytes,
       NULL AS keep_id, 'Marcada como obsoleta' AS reason, 'confirmed' AS confidence
FROM observations
WHERE id IN (${missing.join(",")});
`);
}

function allCandidates() {
  const obsoleteIds = readObsoleteIds();
  const duplicates = duplicateCandidates();
  const byId = new Map(duplicates.map((record) => [record.id, {
    ...record,
    kind: obsoleteIds.has(record.id) ? "duplicate_obsolete" : "duplicate",
    recommended: record.confidence === "exact" || obsoleteIds.has(record.id),
  }]));
  for (const record of obsoleteCandidates(obsoleteIds, new Set(byId.keys()))) {
    byId.set(record.id, { ...record, kind: "obsolete", recommended: true });
  }
  return [...byId.values()].sort((left, right) =>
    Number(right.recommended) - Number(left.recommended)
    || left.created_at_epoch - right.created_at_epoch
    || left.id - right.id
  );
}

function candidateSummary(records) {
  const projects = new Set(records.map(({ project }) => project));
  return {
    total: records.length,
    recommended: records.filter(({ recommended }) => recommended).length,
    exact_duplicates: records.filter(({ confidence }) => confidence === "exact").length,
    possible_duplicates: records.filter(({ confidence }) => confidence === "review").length,
    obsolete: records.filter(({ kind }) => kind.includes("obsolete")).length,
    projects: projects.size,
    estimated_bytes: records.reduce((sum, record) => sum + Number(record.estimated_bytes ?? 0), 0),
  };
}

function snapshot(records) {
  return records
    .map(({ id, project, title, created_at_epoch, kind, confidence, keep_id }) => ({ id, project, title, created_at_epoch, kind, confidence, keep_id }))
    .sort((left, right) => left.id - right.id);
}

function confirmationToken(records) {
  return createHash("sha256").update(JSON.stringify(snapshot(records))).digest("hex");
}

function selectedCandidates(ids) {
  const candidates = new Map(allCandidates().map((record) => [record.id, record]));
  const selected = ids.map((id) => candidates.get(id)).filter(Boolean);
  if (selected.length !== ids.length) {
    const missing = ids.filter((id) => !candidates.has(id));
    fail(`Cleanup refused: IDs are no longer eligible candidates: ${missing.join(",")}`, 67);
  }
  return selected;
}

function databaseStorageProfile() {
  const database = statSync(databasePath);
  const [pageSize, pageCount, freePages, autoVacuum] = execFileSync(
    "sqlite3",
    ["-readonly", "-cmd", ".timeout 10000", databasePath, "PRAGMA page_size; PRAGMA page_count; PRAGMA freelist_count; PRAGMA auto_vacuum;"],
    { encoding: "utf8" },
  ).trim().split("\n").map(Number);
  const indexNames = sqliteJson("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'observations';")
    .map(({ name }) => sqlQuote(name));
  const ftsNames = sqliteJson("SELECT name FROM sqlite_master WHERE name GLOB 'observations_fts_*';")
    .map(({ name }) => sqlQuote(name));
  const storageNames = [sqlQuote("observations"), ...indexNames, ...ftsNames];
  const [allocation = {}] = sqliteJson(`
SELECT
  sum(CASE WHEN name = 'observations' THEN pgsize ELSE 0 END) AS observation_table_bytes,
  sum(CASE WHEN name IN (${indexNames.join(",") || "''"}) THEN pgsize ELSE 0 END) AS observation_index_bytes,
  sum(CASE WHEN name IN (${ftsNames.join(",") || "''"}) THEN pgsize ELSE 0 END) AS observation_fts_bytes
FROM dbstat
WHERE name IN (${storageNames.join(",")});
  `);
  const [source = {}] = sqliteJson(`
SELECT count(*) AS observations,
  sum(length(CAST(coalesce(text, '') AS BLOB)) + length(CAST(coalesce(title, '') AS BLOB)) +
    length(CAST(coalesce(subtitle, '') AS BLOB)) + length(CAST(coalesce(facts, '') AS BLOB)) +
    length(CAST(coalesce(narrative, '') AS BLOB)) + length(CAST(coalesce(concepts, '') AS BLOB)) +
    length(CAST(coalesce(files_read, '') AS BLOB)) + length(CAST(coalesce(files_modified, '') AS BLOB)) +
    length(CAST(coalesce(metadata, '') AS BLOB))) AS logical_bytes,
  sum(length(CAST(coalesce(title, '') || coalesce(subtitle, '') || coalesce(narrative, '') ||
    coalesce(text, '') || coalesce(facts, '') || coalesce(concepts, '') AS BLOB))) AS searchable_bytes
FROM observations;
  `);
  return {
    database_bytes: database.size,
    page_size: pageSize,
    page_count: pageCount,
    free_pages: freePages,
    current_reusable_bytes: pageSize * freePages,
    auto_vacuum: autoVacuum,
    observations: Number(source.observations ?? 0),
    logical_bytes: Number(source.logical_bytes ?? 0),
    searchable_bytes: Number(source.searchable_bytes ?? 0),
    observation_table_bytes: Number(allocation.observation_table_bytes ?? 0),
    observation_index_bytes: Number(allocation.observation_index_bytes ?? 0),
    observation_fts_bytes: Number(allocation.observation_fts_bytes ?? 0),
  };
}

function simulateRecords(records) {
  const storage = databaseStorageProfile();
  const selectedLogical = records.reduce((sum, record) => sum + Number(record.estimated_bytes ?? 0), 0);
  const selectedSearchable = records.reduce((sum, record) => sum + Number(record.searchable_bytes ?? 0), 0);
  const tableEstimate = storage.logical_bytes
    ? storage.observation_table_bytes * selectedLogical / storage.logical_bytes
    : selectedLogical;
  const indexEstimate = storage.observations
    ? storage.observation_index_bytes * records.length / storage.observations
    : 0;
  const ftsEstimate = storage.searchable_bytes
    ? storage.observation_fts_bytes * selectedSearchable / storage.searchable_bytes
    : 0;
  const compactableEstimate = Math.min(
    storage.database_bytes,
    Math.max(selectedLogical, Math.round(tableEstimate + indexEstimate + ftsEstimate)),
  );
  const compactableLow = Math.min(compactableEstimate, selectedLogical);
  const compactableHigh = Math.min(storage.database_bytes, Math.max(compactableEstimate, Math.round(compactableEstimate * 1.25)));
  const quarantineEstimate = Math.max(storage.page_size * 3, Math.round(selectedLogical * 1.15));
  return {
    method: "proportional-dbstat-v1",
    confidence: "estimate",
    selected_content_bytes: selectedLogical,
    internally_reusable_estimated_bytes: compactableEstimate,
    internally_reusable_range_bytes: { low: compactableLow, high: compactableHigh },
    immediate_file_reduction_bytes: 0,
    compacted_file_reduction_estimated_bytes: compactableEstimate,
    database_bytes_before: storage.database_bytes,
    database_bytes_after_delete_estimated: storage.database_bytes,
    database_bytes_after_compaction_estimated: Math.max(0, storage.database_bytes - compactableEstimate),
    database_share_percent: storage.database_bytes ? Number((compactableEstimate / storage.database_bytes * 100).toFixed(4)) : 0,
    current_reusable_bytes: storage.current_reusable_bytes,
    quarantine_estimated_bytes: quarantineEstimate,
    net_disk_change_before_compaction_bytes: quarantineEstimate,
    net_disk_change_after_compaction_bytes: quarantineEstimate - compactableEstimate,
    compaction_required_for_file_shrink: true,
    auto_vacuum_mode: storage.auto_vacuum,
    explanation: [
      "A exclusão comum mantém o tamanho físico do arquivo SQLite.",
      "O espaço removido pode ser reutilizado internamente pelo banco.",
      "A redução física estimada exige compactação posterior e exclusiva.",
      "A quarentena preserva os registros e ocupa espaço adicional até ser removida manualmente.",
    ],
  };
}

function simulation(records) {
  const projects = [...new Set(records.map(({ project }) => project))].sort();
  const projectCounts = sqliteJson(`
SELECT project, count(*) AS observations_before
FROM observations
WHERE project IN (${projects.map((project) => `'${project.replaceAll("'", "''")}'`).join(",")})
GROUP BY project;
`);
  const removedByProject = new Map();
  const bytesByProject = new Map();
  for (const record of records) removedByProject.set(record.project, (removedByProject.get(record.project) ?? 0) + 1);
  for (const record of records) bytesByProject.set(record.project, (bytesByProject.get(record.project) ?? 0) + Number(record.estimated_bytes ?? 0));
  const impact = projectCounts.map(({ project, observations_before }) => ({
    project,
    observations_before,
    removed: removedByProject.get(project) ?? 0,
    observations_after: observations_before - (removedByProject.get(project) ?? 0),
    selected_content_bytes: bytesByProject.get(project) ?? 0,
    removed_percent: Number(((removedByProject.get(project) ?? 0) / observations_before * 100).toFixed(2)),
  }));
  return {
    simulation: true,
    selected_count: records.length,
    estimated_bytes: records.reduce((sum, record) => sum + Number(record.estimated_bytes ?? 0), 0),
    affected_projects: projects.length,
    affected_sessions: new Set(records.map(({ memory_session_id }) => memory_session_id)).size,
    project_impact: impact,
    storage: simulateRecords(records),
    read_only: true,
    database_changed: false,
  };
}

function simulate(ids) {
  return simulation(selectedCandidates(ids));
}

function preview(ids) {
  const records = selectedCandidates(ids);
  return {
    ...simulation(records),
    preview: true,
    confirmation_phrase: `EXCLUIR ${records.length}`,
    confirmation_token: confirmationToken(records),
    recoverable: true,
    backup_policy: "Quarentena SQLite completa dos registros selecionados antes da exclusão",
    records,
  };
}

function timestampSlug() {
  return new Date().toISOString().replaceAll(/[-:.]/g, "").replace("Z", "Z");
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function execute(ids, suppliedToken, phrase) {
  const current = preview(ids);
  if (!/^[a-f0-9]{64}$/.test(suppliedToken ?? "") || suppliedToken !== current.confirmation_token) {
    fail("Cleanup refused: stale or invalid confirmation token. Generate a new preview.", 68);
  }
  if (phrase !== current.confirmation_phrase) {
    fail(`Cleanup refused: confirmation phrase must be exactly "${current.confirmation_phrase}".`, 68);
  }
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backupPath = join(backupRoot, `gateway-cleanup-quarantine-${timestampSlug()}.db`);
  const archiveSql = `
ATTACH DATABASE ${sqlQuote(backupPath)} AS quarantine;
CREATE TABLE quarantine.observations AS SELECT * FROM main.observations WHERE id IN (${ids.join(",")});
CREATE TABLE quarantine.cleanup_manifest (created_at TEXT, source_database TEXT, observation_count INTEGER, confirmation_token TEXT);
INSERT INTO quarantine.cleanup_manifest VALUES (${sqlQuote(new Date().toISOString())}, ${sqlQuote(databasePath)}, ${ids.length}, ${sqlQuote(suppliedToken)});
SELECT count(*) FROM quarantine.observations;
DETACH DATABASE quarantine;
`;
  const archived = Number(execFileSync("sqlite3", ["-bail", "-cmd", ".timeout 15000", databasePath, archiveSql], {
    encoding: "utf8",
    maxBuffer: 1_000_000,
  }).trim().split("\n").filter(Boolean).at(-1));
  if (archived !== ids.length) fail(`Cleanup refused: quarantine contains ${archived} of ${ids.length} selected rows.`, 69);
  chmodSync(backupPath, 0o600);
  const fresh = preview(ids);
  if (fresh.confirmation_token !== suppliedToken) {
    fail(`Cleanup refused: candidate snapshot changed while backing up. Backup retained at ${backupPath}.`, 68);
  }
  const auditBase = {
    created_at: new Date().toISOString(),
    ids,
    projects: fresh.project_impact.map(({ project, removed }) => ({ project, removed })),
    estimated_bytes: fresh.estimated_bytes,
    backup_path: backupPath,
    confirmation_token_prefix: suppliedToken.slice(0, 12),
  };
  appendFileSync(auditPath, `${JSON.stringify({ event: "cleanup_prepare", ...auditBase })}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(auditPath, 0o600);
  const idList = ids.join(",");
  const guardedRows = fresh.records.map((record) =>
    `(id = ${record.id} AND project = ${sqlQuote(record.project)} AND coalesce(title, '') = ${sqlQuote(record.title)} AND created_at_epoch = ${record.created_at_epoch})`
  ).join(" OR ");
  const sql = `
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
CREATE TEMP TABLE cleanup_guard (matched INTEGER CHECK (matched = ${ids.length}));
INSERT INTO cleanup_guard SELECT count(*) FROM observations WHERE ${guardedRows};
DELETE FROM observations WHERE id IN (${idList});
SELECT changes();
COMMIT;
`;
  const output = execFileSync("sqlite3", ["-bail", "-cmd", ".timeout 15000", databasePath, sql], { encoding: "utf8" }).trim();
  const deleted = Number(output.split("\n").filter(Boolean).at(-1));
  if (deleted !== ids.length) {
    fail(`Cleanup transaction deleted ${deleted} of ${ids.length} rows. Backup retained at ${backupPath}.`, 69);
  }
  let audit_status = "complete";
  try {
    appendFileSync(auditPath, `${JSON.stringify({ event: "cleanup_delete", ...auditBase, completed_at: new Date().toISOString(), deleted })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    audit_status = "prepared_only";
  }
  const database = statSync(databasePath);
  const [pageSize, freePages] = execFileSync("sqlite3", ["-readonly", databasePath, "PRAGMA page_size; PRAGMA freelist_count;"], { encoding: "utf8" })
    .trim().split("\n").map(Number);
  return {
    deleted,
    backup_path: backupPath,
    audit_path: auditPath,
    audit_status,
    estimated_bytes: current.estimated_bytes,
    reusable_bytes: pageSize * freePages,
    database_bytes: database.size,
    recoverable: true,
  };
}

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const command = process.argv[2];
if (command === "candidates") {
  const project = option("--project");
  const kind = option("--kind", "all");
  const limit = Number(option("--limit", "250"));
  if (!["all", "duplicate", "obsolete"].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 500) fail("Invalid cleanup candidate filters.");
  let records = allCandidates();
  if (project) records = records.filter((record) => record.project === project);
  if (kind === "duplicate") records = records.filter((record) => record.kind.includes("duplicate"));
  if (kind === "obsolete") records = records.filter((record) => record.kind.includes("obsolete"));
  const totalSummary = candidateSummary(records);
  process.stdout.write(`${JSON.stringify({ summary: totalSummary, records: records.slice(0, limit), returned: Math.min(records.length, limit) })}\n`);
} else if (command === "preview") {
  process.stdout.write(`${JSON.stringify(preview(parseIds(option("--ids"))))}\n`);
} else if (command === "simulate") {
  process.stdout.write(`${JSON.stringify(simulate(parseIds(option("--ids"))))}\n`);
} else if (command === "execute") {
  const result = execute(parseIds(option("--ids")), option("--confirm-token"), option("--phrase"));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  fail("Usage: cleanup.mjs {candidates|simulate|preview|execute} [options]");
}

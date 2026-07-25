#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

export const MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const MODEL_DTYPE = "q8";
export const MODEL_MAX_LENGTH = 128;
export const INDEX_VERSION = 2;
const memoryRoot = join(homedir(), ".claude-mem");
const sourcePath = join(memoryRoot, "claude-mem.db");
const indexPath = join(memoryRoot, "gateway-embeddings.db");
const lockPath = join(memoryRoot, "gateway-embeddings.lock");
const cacheRoot = join(homedir(), ".cache", "memory-gateway-mcp", "transformers");
const markerPath = join(cacheRoot, "offline-model.json");
const gatewayRoot = join(homedir(), ".codex", "memory-gateway-mcp");
const EMPTY_FEEDBACK = { useful: 0, incorrect: 0, obsolete: 0 };

function fail(message, code = 64) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function agentLabel(value) {
  return value === "codex" ? "codex" : value === "claude-code" ? "claude" : "legacy";
}

function sqlPlaceholders(values) {
  return values.map(() => "?").join(",");
}

function normalizeText(value, maximum = 3_200) {
  return String(value ?? "").replaceAll("\u0000", " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function embeddingDocument(row) {
  const sections = [
    row.title ? `Título: ${row.title}` : "",
    row.subtitle ? `Decisão: ${row.subtitle}` : "",
    row.narrative ? `Resumo: ${row.narrative}` : "",
    row.text ? `Contexto: ${row.text}` : "",
    row.facts ? `Fatos: ${row.facts}` : "",
    row.concepts ? `Conceitos: ${row.concepts}` : "",
  ].filter(Boolean);
  return normalizeText(sections.join("\n"));
}

function sourceFingerprint(row) {
  return createHash("sha256")
    .update([row.project, row.type, row.title, row.subtitle, row.narrative, row.text, row.facts, row.concepts].map((value) => String(value ?? "")).join("\u001f"))
    .digest("hex");
}

function sourceRows(database, project = "") {
  const sql = `
SELECT id, project, type, title, subtitle, narrative, text, facts, concepts, created_at, created_at_epoch, agent_type
FROM observations
${project ? "WHERE project = ?" : ""}
ORDER BY id;
  `;
  return database.prepare(sql).all(...(project ? [project] : []));
}

function initializeIndex(database) {
  database.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS embeddings (
  observation_id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  agent TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  source_fingerprint TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_project ON embeddings(project);
CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(type);
CREATE INDEX IF NOT EXISTS idx_embeddings_agent ON embeddings(agent);
  `);
}

function setMetadata(database, key, value) {
  database.prepare(`
INSERT INTO metadata(key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `).run(key, String(value));
}

function metadataObject(database) {
  return Object.fromEntries(database.prepare("SELECT key, value FROM metadata;").all().map(({ key, value }) => [key, value]));
}

function floatBuffer(values) {
  const vector = values instanceof Float32Array ? values : Float32Array.from(values);
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function vectorFromBlob(blob) {
  return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / Float32Array.BYTES_PER_ELEMENT));
}

export function dotProduct(left, right) {
  let score = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) score += left[index] * right[index];
  return score;
}

function modelFiles(directory) {
  if (!existsSync(directory)) return [];
  const records = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else records.push(path);
    }
  };
  walk(directory);
  return records;
}

function marker() {
  if (!existsSync(markerPath)) return null;
  try {
    const value = JSON.parse(readFileSync(markerPath, "utf8"));
    return value.model_id === MODEL_ID && value.dtype === MODEL_DTYPE
      ? { ...value, max_length: MODEL_MAX_LENGTH }
      : null;
  } catch {
    return null;
  }
}

function writeModelMarker(dimensions = 384) {
  const files = modelFiles(cacheRoot);
  const model = files.filter((path) => path.endsWith(".onnx")).sort((left, right) => statSync(right).size - statSync(left).size)[0];
  if (!model) throw new Error("Downloaded ONNX model file was not found in the local cache.");
  const fingerprint = createHash("sha256").update(readFileSync(model)).digest("hex");
  const value = {
    model_id: MODEL_ID,
    dtype: MODEL_DTYPE,
    max_length: MODEL_MAX_LENGTH,
    dimensions,
    model_file: model.slice(cacheRoot.length + 1),
    model_bytes: statSync(model).size,
    model_sha256: fingerprint,
    cached_at: new Date().toISOString(),
    offline_only_after_cache: true,
  };
  writeFileSync(markerPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(markerPath, 0o600);
  return value;
}

async function transformersModule() {
  const require = createRequire(join(gatewayRoot, "package.json"));
  const entry = require.resolve("@huggingface/transformers");
  return import(pathToFileURL(entry).href);
}

export async function localEmbedder({ allowDownload = false, progress = false } = {}) {
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  process.env.HF_HUB_DISABLE_TELEMETRY = "1";
  process.env.DO_NOT_TRACK = "1";
  const { env, pipeline } = await transformersModule();
  env.cacheDir = cacheRoot;
  env.useFSCache = true;
  env.allowLocalModels = true;
  env.allowRemoteModels = allowDownload;
  env.logLevel = "error";
  const progressBuckets = new Map();
  const extractor = await pipeline("feature-extraction", MODEL_ID, {
    dtype: MODEL_DTYPE,
    progress_callback: progress ? (event) => {
      if (event.status === "progress" && Number.isFinite(event.progress)) {
        const bucket = Math.min(100, Math.floor(event.progress / 10) * 10);
        if (progressBuckets.get(event.file) !== bucket) {
          progressBuckets.set(event.file, bucket);
          process.stderr.write(`Modelo local: ${event.file} ${bucket}%\n`);
        }
      } else if (event.status === "done") {
        process.stderr.write(`Modelo local: ${event.file} pronto\n`);
      }
    } : undefined,
  });
  return {
    async embed(texts) {
      const values = Array.isArray(texts) ? texts : [texts];
      const output = await extractor(values, {
        pooling: "mean",
        normalize: true,
        truncation: true,
        max_length: MODEL_MAX_LENGTH,
      });
      const dimensions = output.dims.at(-1);
      const vectors = [];
      for (let row = 0; row < values.length; row += 1) {
        vectors.push(Float32Array.from(output.data.subarray(row * dimensions, (row + 1) * dimensions)));
      }
      return vectors;
    },
    async dispose() {
      await extractor.dispose();
    },
  };
}

async function withIndexLock(callback) {
  mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(lockPath, "utf8").trim());
      let running = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          running = true;
        } catch {
          running = false;
        }
      }
      if (running || attempt > 0) throw new Error("A local embedding index job is already running.");
      unlinkSync(lockPath);
    }
  }
  try {
    return await callback();
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
}

export async function buildEmbeddingIndex({
  sourceDatabasePath = sourcePath,
  embeddingDatabasePath = indexPath,
  embedTexts,
  model = { model_id: MODEL_ID, dtype: MODEL_DTYPE, model_sha256: "test-model" },
  project = "",
  limit = 0,
  batchSize = 16,
  rebuild = false,
  onProgress = () => {},
} = {}) {
  if (!existsSync(sourceDatabasePath)) throw new Error(`Claude memory database not found: ${sourceDatabasePath}`);
  const source = new DatabaseSync(sourceDatabasePath, { readOnly: true });
  const target = new DatabaseSync(embeddingDatabasePath);
  initializeIndex(target);
  try {
    const existingMetadata = metadataObject(target);
    const [{ count: existingCount }] = target.prepare("SELECT count(*) AS count FROM embeddings;").all();
    const modelChanged = Number(existingCount) > 0 && (
      Number(existingMetadata.index_version ?? 0) !== INDEX_VERSION
      || existingMetadata.model_id !== (model.model_id ?? MODEL_ID)
      || existingMetadata.model_dtype !== (model.dtype ?? MODEL_DTYPE)
      || existingMetadata.model_sha256 !== (model.model_sha256 ?? "unknown")
      || Number(existingMetadata.model_max_length ?? 0) !== MODEL_MAX_LENGTH
    );
    if (modelChanged || (rebuild && !project)) target.exec("DELETE FROM embeddings;");
    const rows = sourceRows(source, project);
    const indexed = new Map(target.prepare(`
SELECT observation_id, source_fingerprint
FROM embeddings
${project ? "WHERE project = ?" : ""};
    `).all(...(project ? [project] : [])).map(({ observation_id, source_fingerprint }) => [Number(observation_id), source_fingerprint]));
    const sourceIds = new Set(rows.map(({ id }) => Number(id)));
    const pending = [];
    let unchanged = 0;
    for (const row of rows) {
      const fingerprint = sourceFingerprint(row);
      if (!rebuild && !modelChanged && indexed.get(Number(row.id)) === fingerprint) {
        unchanged += 1;
        continue;
      }
      pending.push({ row, fingerprint, document: embeddingDocument(row) || `${row.project} ${row.type}` });
      if (limit && pending.length >= limit) break;
    }

    const insert = target.prepare(`
INSERT INTO embeddings(observation_id, project, type, agent, created_at_epoch, source_fingerprint, dimensions, vector)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(observation_id) DO UPDATE SET
  project = excluded.project,
  type = excluded.type,
  agent = excluded.agent,
  created_at_epoch = excluded.created_at_epoch,
  source_fingerprint = excluded.source_fingerprint,
  dimensions = excluded.dimensions,
  vector = excluded.vector;
    `);
    let indexedCount = 0;
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const vectors = await embedTexts(batch.map(({ document }) => document));
      target.exec("BEGIN IMMEDIATE;");
      try {
        for (let index = 0; index < batch.length; index += 1) {
          const { row, fingerprint } = batch[index];
          const vector = vectors[index];
          insert.run(
            Number(row.id), row.project, row.type, agentLabel(row.agent_type), Number(row.created_at_epoch),
            fingerprint, vector.length, floatBuffer(vector),
          );
          indexedCount += 1;
        }
        target.exec("COMMIT;");
      } catch (error) {
        target.exec("ROLLBACK;");
        throw error;
      }
      onProgress({ indexed: indexedCount, pending: pending.length, unchanged });
    }

    let removed = 0;
    if (!limit) {
      const stale = target.prepare(`
SELECT observation_id FROM embeddings ${project ? "WHERE project = ?" : ""};
      `).all(...(project ? [project] : [])).filter(({ observation_id }) => !sourceIds.has(Number(observation_id)));
      const remove = target.prepare("DELETE FROM embeddings WHERE observation_id = ?;");
      target.exec("BEGIN IMMEDIATE;");
      try {
        for (const { observation_id } of stale) removed += Number(remove.run(observation_id).changes);
        target.exec("COMMIT;");
      } catch (error) {
        target.exec("ROLLBACK;");
        throw error;
      }
    }

    const [{ count: totalIndexed }] = target.prepare("SELECT count(*) AS count FROM embeddings;").all();
    const [{ dimensions = 0 } = {}] = target.prepare("SELECT dimensions FROM embeddings LIMIT 1;").all();
    setMetadata(target, "index_version", INDEX_VERSION);
    setMetadata(target, "model_id", model.model_id ?? MODEL_ID);
    setMetadata(target, "model_dtype", model.dtype ?? MODEL_DTYPE);
    setMetadata(target, "model_sha256", model.model_sha256 ?? "unknown");
    setMetadata(target, "model_max_length", MODEL_MAX_LENGTH);
    setMetadata(target, "dimensions", dimensions);
    setMetadata(target, "updated_at", new Date().toISOString());
    setMetadata(target, "privacy", "local-only; vectors contain no raw observation text");
    chmodSync(embeddingDatabasePath, 0o600);
    return {
      indexed: indexedCount,
      unchanged,
      removed,
      total_indexed: Number(totalIndexed),
      source_total: rows.length,
      pending_before: pending.length,
      complete: !limit || pending.length < limit,
      rebuilt_for_model_change: modelChanged,
      project: project || null,
      dimensions: Number(dimensions),
      model_id: model.model_id ?? MODEL_ID,
      local_only: true,
      raw_text_stored: false,
      index_path: embeddingDatabasePath,
    };
  } finally {
    source.close();
    target.close();
  }
}

function redact(value, maximum = 700) {
  let text = String(value ?? "").replaceAll("\u0000", "").trim();
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{12,}\b/g, /\bAKIA[A-Z0-9]{16}\b/g, /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    /\b(api[_-]?key|secret|token|password|authorization|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/g,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
    /(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?\d{4,5}[-.\s]?\d{4}\b/g,
    /\/Users\/[^/\s]+/g,
  ];
  let redactions = 0;
  for (const pattern of patterns) text = text.replace(pattern, () => { redactions += 1; return "[DADO SENSÍVEL OCULTO]"; });
  if (text.length > maximum) text = `${text.slice(0, maximum).trimEnd()}…`;
  return { text, redactions };
}

function feedbackMap() {
  const path = join(memoryRoot, "gateway-feedback.jsonl");
  const feedback = new Map();
  if (!existsSync(path)) return feedback;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (!Number.isInteger(event.observation_id) || !["useful", "incorrect", "obsolete"].includes(event.label)) continue;
      const counts = feedback.get(event.observation_id) ?? { ...EMPTY_FEEDBACK };
      counts[event.label] += 1;
      feedback.set(event.observation_id, counts);
    } catch {
      // Append-only feedback may end with an incomplete line.
    }
  }
  return feedback;
}

function lexicalMatches(source, query) {
  const available = source.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'observations_fts';").get().count;
  if (!available) return new Map();
  const terms = [...new Set(normalizeText(query, 800).toLocaleLowerCase("pt-BR").match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])].slice(0, 8);
  const matches = new Map();
  const search = source.prepare("SELECT rowid AS id FROM observations_fts WHERE observations_fts MATCH ? LIMIT 10000;");
  for (const term of terms) {
    const expression = `"${term.replaceAll('"', '""')}"*`;
    for (const { id } of search.all(expression)) matches.set(Number(id), (matches.get(Number(id)) ?? 0) + 1);
  }
  return matches;
}

export async function searchEmbeddingIndex({
  sourceDatabasePath = sourcePath,
  embeddingDatabasePath = indexPath,
  embedQuery,
  query,
  project = "",
  type = "all",
  agent = "all",
  limit = 20,
  offset = 0,
  minimumScore = 0.12,
  includeObsolete = false,
} = {}) {
  if (!existsSync(embeddingDatabasePath)) throw new Error("Local embedding index is missing. Run embedding-index first.");
  const target = new DatabaseSync(embeddingDatabasePath, { readOnly: true });
  const source = new DatabaseSync(sourceDatabasePath, { readOnly: true });
  try {
    const [queryVector] = await embedQuery([normalizeText(query, 800)]);
    const clauses = [];
    const parameters = [];
    if (project) { clauses.push("project = ?"); parameters.push(project); }
    if (type !== "all") { clauses.push("type = ?"); parameters.push(type); }
    if (agent !== "all") { clauses.push("agent = ?"); parameters.push(agent); }
    const rows = target.prepare(`
SELECT observation_id, project, type, agent, created_at_epoch, dimensions, vector
FROM embeddings
${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""};
    `).all(...parameters);
    const feedback = feedbackMap();
    const lexical = lexicalMatches(source, query);
    const matches = rows
      .map((row) => {
        const score = dotProduct(queryVector, vectorFromBlob(row.vector));
        const signals = feedback.get(Number(row.observation_id)) ?? { ...EMPTY_FEEDBACK };
        const lexicalBonus = Math.min(0.30, (lexical.get(Number(row.observation_id)) ?? 0) * 0.15);
        return {
          ...row,
          score,
          feedback: signals,
          lexicalBonus,
          rankingScore: score + lexicalBonus + signals.useful * 0.015 - signals.incorrect * 0.03 - signals.obsolete * 0.2,
        };
      })
      .filter(({ score }) => Number.isFinite(score) && score >= minimumScore)
      .filter(({ feedback: signals }) => includeObsolete || signals.obsolete === 0)
      .sort((left, right) => right.rankingScore - left.rankingScore || right.created_at_epoch - left.created_at_epoch);
    const ranked = matches.slice(offset, offset + limit);
    const ids = ranked.map(({ observation_id }) => Number(observation_id));
    const details = ids.length ? source.prepare(`
SELECT id, project, type, title, subtitle, narrative, text, created_at, created_at_epoch, agent_type, generated_by_model
FROM observations
WHERE id IN (${sqlPlaceholders(ids)});
    `).all(...ids) : [];
    const detailMap = new Map(details.map((record) => [Number(record.id), record]));
    const records = ranked.map((rank) => {
      const record = detailMap.get(Number(rank.observation_id));
      const title = redact(record?.title, 300);
      const preview = redact(record?.subtitle || record?.narrative || record?.text, 500);
      return {
        id: Number(rank.observation_id),
        project: rank.project,
        type: rank.type,
        title: title.text,
        preview: preview.text,
        created_at: record?.created_at,
        agent: rank.agent,
        semantic_score: Number(rank.score.toFixed(4)),
        semantic_percent: Math.round(Math.max(0, rank.score) * 100),
        lexical_bonus: Number(rank.lexicalBonus.toFixed(2)),
        feedback: rank.feedback,
        redacted: title.redactions + preview.redactions > 0,
      };
    });
    const metadata = metadataObject(target);
    const facetParameters = project ? [project] : [];
    const facetWhere = project ? "WHERE project = ?" : "";
    const types = source.prepare(`
SELECT type, count(*) AS count FROM observations ${facetWhere}
GROUP BY type ORDER BY count DESC, type;
    `).all(...facetParameters);
    const agents = source.prepare(`
SELECT CASE WHEN agent_type = 'codex' THEN 'codex' WHEN agent_type = 'claude-code' THEN 'claude' ELSE 'legacy' END AS agent,
       count(*) AS count
FROM observations ${facetWhere}
GROUP BY agent ORDER BY count DESC, agent;
    `).all(...facetParameters);
    return {
      query_mode: "semantic-local-hybrid",
      ranking_signals: ["embedding-cosine", "exact-local-terms", "memory-feedback"],
      query_not_stored: true,
      external_requests: 0,
      local_only: true,
      model_id: metadata.model_id ?? MODEL_ID,
      index_updated_at: metadata.updated_at ?? null,
      total: matches.length,
      returned: records.length,
      limit,
      offset,
      has_more: offset + records.length < matches.length,
      minimum_score: minimumScore,
      include_obsolete: includeObsolete,
      facets: { types, agents },
      records,
    };
  } finally {
    target.close();
    source.close();
  }
}

export function embeddingHealth({
  sourceDatabasePath = sourcePath,
  embeddingDatabasePath = indexPath,
} = {}) {
  const model = marker();
  if (!existsSync(sourceDatabasePath)) return { ok: false, error: "source database missing", local_only: true };
  const source = new DatabaseSync(sourceDatabasePath, { readOnly: true });
  const [{ total: sourceTotal }] = source.prepare("SELECT count(*) AS total FROM observations;").all();
  source.close();
  if (!existsSync(embeddingDatabasePath)) {
    return {
      ok: false,
      model_cached: Boolean(model),
      index_ready: false,
      indexed: 0,
      source_total: Number(sourceTotal),
      coverage_percent: 0,
      local_only: true,
      external_requests_per_search: 0,
    };
  }
  const index = new DatabaseSync(embeddingDatabasePath, { readOnly: true });
  const [{ total: indexed }] = index.prepare("SELECT count(*) AS total FROM embeddings;").all();
  const metadata = metadataObject(index);
  index.close();
  const coverage = sourceTotal ? Number((Number(indexed) / Number(sourceTotal) * 100).toFixed(2)) : 100;
  const modelCompatible = Boolean(model)
    && Number(metadata.index_version ?? 0) === INDEX_VERSION
    && metadata.model_id === model.model_id
    && metadata.model_dtype === model.dtype
    && metadata.model_sha256 === model.model_sha256
    && Number(metadata.model_max_length ?? 0) === MODEL_MAX_LENGTH;
  return {
    ok: modelCompatible && Number(indexed) > 0,
    model_cached: Boolean(model),
    offline_ready: Boolean(model),
    index_ready: Number(indexed) > 0,
    model_compatible: modelCompatible,
    indexed: Number(indexed),
    source_total: Number(sourceTotal),
    coverage_percent: coverage,
    dimensions: Number(metadata.dimensions ?? model?.dimensions ?? 0),
    model_id: metadata.model_id ?? model?.model_id ?? MODEL_ID,
    model_dtype: metadata.model_dtype ?? model?.dtype ?? MODEL_DTYPE,
    model_max_length: Number(metadata.model_max_length ?? model?.max_length ?? 0),
    index_version: Number(metadata.index_version ?? 0),
    index_updated_at: metadata.updated_at ?? null,
    index_bytes: statSync(embeddingDatabasePath).size,
    model_bytes: Number(model?.model_bytes ?? 0),
    model_sha256: model?.model_sha256 ?? null,
    local_only: true,
    raw_text_stored: false,
    external_requests_per_search: 0,
  };
}

async function runDownload() {
  const runtime = await localEmbedder({ allowDownload: true, progress: true });
  try {
    const [sample] = await runtime.embed(["memória local e busca semântica"]);
    const model = writeModelMarker(sample.length);
    return { downloaded: true, offline_ready: true, local_only: true, external_content_sent: false, ...model };
  } finally {
    await runtime.dispose();
  }
}

async function runIndex() {
  const allowDownload = hasFlag("--download");
  const existingMarker = marker();
  if (!existingMarker && !allowDownload) throw new Error("Local model cache is missing. Re-run once with --download.");
  const limit = Number(option("--limit", "0"));
  const batchSize = Number(option("--batch-size", "16"));
  if (!Number.isInteger(limit) || limit < 0 || limit > 1_000_000) throw new Error("Limit must be an integer from 0 to 1000000.");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128) throw new Error("Batch size must be an integer from 1 to 128.");
  const runtime = await localEmbedder({ allowDownload, progress: allowDownload });
  try {
    const [sample] = await runtime.embed(["índice local"]);
    const model = existingMarker ?? writeModelMarker(sample.length);
    return await withIndexLock(() => buildEmbeddingIndex({
      embedTexts: (texts) => runtime.embed(texts),
      model,
      project: option("--project"),
      limit,
      batchSize,
      rebuild: hasFlag("--rebuild"),
      onProgress: ({ indexed, pending }) => {
        if (indexed === pending || indexed % Math.max(100, batchSize) === 0) {
          process.stderr.write(`Embeddings locais: ${indexed}/${pending}\n`);
        }
      },
    }));
  } finally {
    process.stderr.write("\n");
    await runtime.dispose();
  }
}

async function runSearch() {
  const query = option("--query") || process.argv[3] || "";
  if (query.trim().length < 2) throw new Error("Semantic search requires at least two characters.");
  if (!marker()) throw new Error("Local model is not cached. Run embedding-download once.");
  const health = embeddingHealth();
  if (!health.index_ready) throw new Error("Local embedding index is missing. Run embedding-index first.");
  if (!health.model_compatible) throw new Error("Local embedding model changed. Rebuild the index with embedding-index.");
  const limit = Number(option("--limit", "20"));
  const offset = Number(option("--offset", "0"));
  const minimumScore = Number(option("--minimum-score", "0.12"));
  const type = option("--type", "all");
  const agent = option("--agent", "all");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Limit must be an integer from 1 to 100.");
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new Error("Offset must be an integer from 0 to 100000.");
  if (!Number.isFinite(minimumScore) || minimumScore < -1 || minimumScore > 1) throw new Error("Minimum score must be from -1 to 1.");
  if (!["all", "codex", "claude", "legacy"].includes(agent)) throw new Error("Invalid agent filter.");
  if (!/^(all|[\p{L}\p{N}_-]{1,80})$/u.test(type)) throw new Error("Invalid memory type filter.");
  const runtime = await localEmbedder({ allowDownload: false });
  try {
    return await searchEmbeddingIndex({
      embedQuery: (texts) => runtime.embed(texts),
      query,
      project: option("--project"),
      type,
      agent,
      limit,
      offset,
      minimumScore,
      includeObsolete: hasFlag("--include-obsolete"),
    });
  } finally {
    await runtime.dispose();
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "download") return runDownload();
  if (command === "index") return runIndex();
  if (command === "search") return runSearch();
  if (command === "health") return embeddingHealth();
  throw new Error("Usage: embeddings.mjs {download|index|search|health} [options]");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}

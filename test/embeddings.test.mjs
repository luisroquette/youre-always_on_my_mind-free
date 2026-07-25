import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildEmbeddingIndex,
  embeddingHealth,
  searchEmbeddingIndex,
} from "./fixtures/claude-mem-bridge/embeddings.mjs";

const directory = mkdtempSync(join(tmpdir(), "memory-embeddings-"));
const sourcePath = join(directory, "source.db");
const indexPath = join(directory, "index.db");

function vector(text) {
  const value = String(text).toLocaleLowerCase("pt-BR");
  if (/auth|cron|credencia|agendad/.test(value)) return Float32Array.from([1, 0, 0]);
  if (/deploy|publica|produção/.test(value)) return Float32Array.from([0, 1, 0]);
  return Float32Array.from([0, 0, 1]);
}

try {
  const database = new DatabaseSync(sourcePath);
  database.exec(`
CREATE TABLE observations (
  id INTEGER PRIMARY KEY, project TEXT, type TEXT, title TEXT, subtitle TEXT,
  narrative TEXT, text TEXT, facts TEXT, concepts TEXT, created_at TEXT,
  created_at_epoch INTEGER, agent_type TEXT, generated_by_model TEXT
);
  `);
  const insert = database.prepare(`
INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
  `);
  insert.run(1, "alpha", "bugfix", "Cron authentication repaired", "Header credentials fixed", "", "", "", "cron,auth", "2026-07-20", 1, "codex", "");
  insert.run(2, "alpha", "change", "Production deployment", "Published successfully", "", "", "", "deploy", "2026-07-21", 2, "claude-code", "");
  insert.run(3, "beta", "discovery", "Visual language", "Biological network", "", "", "", "design", "2026-07-22", 3, "other", "");
  database.close();

  const embedTexts = async (texts) => texts.map(vector);
  const first = await buildEmbeddingIndex({
    sourceDatabasePath: sourcePath,
    embeddingDatabasePath: indexPath,
    embedTexts,
  });
  assert.equal(first.indexed, 3);
  assert.equal(first.raw_text_stored, false);
  assert.equal(first.dimensions, 3);

  const rawIndex = readFileSync(indexPath).toString("utf8");
  assert.doesNotMatch(rawIndex, /Cron authentication repaired|Header credentials fixed|Production deployment/);

  const second = await buildEmbeddingIndex({
    sourceDatabasePath: sourcePath,
    embeddingDatabasePath: indexPath,
    embedTexts,
  });
  assert.equal(second.indexed, 0);
  assert.equal(second.unchanged, 3);

  const result = await searchEmbeddingIndex({
    sourceDatabasePath: sourcePath,
    embeddingDatabasePath: indexPath,
    embedQuery: embedTexts,
    query: "credenciais de tarefa agendada",
    project: "alpha",
    minimumScore: 0.5,
  });
  assert.equal(result.records[0].id, 1);
  assert.equal(result.query_not_stored, true);
  assert.equal(result.external_requests, 0);
  assert.equal(result.facets.types.length, 2);

  const changed = new DatabaseSync(sourcePath);
  changed.prepare("DELETE FROM observations WHERE id = 3;").run();
  changed.prepare("UPDATE observations SET subtitle = ? WHERE id = 2;").run("Production publication completed");
  changed.close();
  const third = await buildEmbeddingIndex({
    sourceDatabasePath: sourcePath,
    embeddingDatabasePath: indexPath,
    embedTexts,
  });
  assert.equal(third.indexed, 1);
  assert.equal(third.removed, 1);
  assert.equal(third.total_indexed, 2);

  const migrated = await buildEmbeddingIndex({
    sourceDatabasePath: sourcePath,
    embeddingDatabasePath: indexPath,
    embedTexts,
    model: { model_id: "local-test-v2", dtype: "q8", model_sha256: "test-model-v2" },
  });
  assert.equal(migrated.rebuilt_for_model_change, true);
  assert.equal(migrated.indexed, 2);

  const health = embeddingHealth({ sourceDatabasePath: sourcePath, embeddingDatabasePath: indexPath });
  assert.equal(health.coverage_percent, 100);
  assert.equal(health.raw_text_stored, false);
  process.stdout.write("Local embedding index, privacy, incremental update, deletion, and semantic ranking tests passed.\n");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

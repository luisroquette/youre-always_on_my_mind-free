import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryHome = mkdtempSync(join(tmpdir(), "memory-cleanup-test-"));
const memoryRoot = join(temporaryHome, ".claude-mem");
const databasePath = join(memoryRoot, "claude-mem.db");
const helperPath = join(process.cwd(), "test", "fixtures", "claude-mem-bridge", "cleanup.mjs");
mkdirSync(memoryRoot, { recursive: true });

execFileSync("sqlite3", [databasePath, `
CREATE TABLE observations (
  id INTEGER PRIMARY KEY, memory_session_id TEXT NOT NULL, project TEXT NOT NULL, text TEXT, type TEXT NOT NULL,
  title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT, files_read TEXT, files_modified TEXT,
  prompt_number INTEGER, discovery_tokens INTEGER DEFAULT 0, created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL,
  content_hash TEXT, generated_by_model TEXT, relevance_count INTEGER DEFAULT 0, merged_into_project TEXT,
  agent_type TEXT, agent_id TEXT, metadata TEXT, synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT,
  sync_rev TEXT NOT NULL DEFAULT '1'
);
INSERT INTO observations (id,memory_session_id,project,text,type,title,narrative,created_at,created_at_epoch,content_hash,agent_type,metadata)
VALUES
  (1,'s1','alpha','same body','change','Repeated outcome','same body','2026-01-01T00:00:00Z',1767225600000,'same-hash','claude-code','{}'),
  (2,'s2','alpha','same body','change','Repeated outcome','same body','2026-02-01T00:00:00Z',1769904000000,'same-hash','codex','{}'),
  (3,'s3','beta','obsolete body','change','Old decision','obsolete body','2026-01-15T00:00:00Z',1768435200000,'unique-hash','claude-code','{}');
`]);
writeFileSync(join(memoryRoot, "gateway-feedback.jsonl"), '{"observation_id":3,"label":"obsolete"}\n', { mode: 0o600 });

function helper(args) {
  return JSON.parse(execFileSync(process.execPath, [helperPath, ...args], {
    env: { ...process.env, HOME: temporaryHome },
    encoding: "utf8",
  }));
}

const candidates = helper(["candidates", "--limit", "20"]);
assert.equal(candidates.summary.total, 2);
assert.equal(candidates.summary.recommended, 2);
assert.deepEqual(candidates.records.map(({ id }) => id).sort((a, b) => a - b), [1, 3]);
assert.equal(candidates.records.find(({ id }) => id === 1).confidence, "exact");
assert.equal(candidates.records.find(({ id }) => id === 3).kind, "obsolete");

const simulation = helper(["simulate", "--ids", "1,3"]);
assert.equal(simulation.simulation, true);
assert.equal(simulation.read_only, true);
assert.equal(simulation.database_changed, false);
assert.equal(simulation.storage.immediate_file_reduction_bytes, 0);
assert.ok(simulation.storage.selected_content_bytes > 0);
assert.ok(simulation.storage.internally_reusable_estimated_bytes >= simulation.storage.selected_content_bytes);
assert.ok(simulation.storage.quarantine_estimated_bytes > 0);
assert.equal(simulation.storage.method, "proportional-dbstat-v1");
assert.equal(Number(execFileSync("sqlite3", [databasePath, "SELECT count(*) FROM observations;"], { encoding: "utf8" }).trim()), 3);

const preview = helper(["preview", "--ids", "1,3"]);
assert.equal(preview.selected_count, 2);
assert.equal(preview.confirmation_phrase, "EXCLUIR 2");
assert.equal(preview.recoverable, true);
assert.deepEqual(preview.storage, simulation.storage);

const refused = spawnSync(process.execPath, [
  helperPath, "execute", "--ids", "1,3", "--confirm-token", preview.confirmation_token, "--phrase", "EXCLUIR 1",
], { env: { ...process.env, HOME: temporaryHome }, encoding: "utf8" });
assert.notEqual(refused.status, 0);
assert.equal(Number(execFileSync("sqlite3", [databasePath, "SELECT count(*) FROM observations;"], { encoding: "utf8" }).trim()), 3);

const result = helper([
  "execute", "--ids", "1,3", "--confirm-token", preview.confirmation_token, "--phrase", preview.confirmation_phrase,
]);
assert.equal(result.deleted, 2);
assert.equal(result.recoverable, true);
assert.equal(Number(execFileSync("sqlite3", [databasePath, "SELECT count(*) FROM observations;"], { encoding: "utf8" }).trim()), 1);
assert.equal(Number(execFileSync("sqlite3", [result.backup_path, "SELECT count(*) FROM observations;"], { encoding: "utf8" }).trim()), 2);
assert.match(readFileSync(result.audit_path, "utf8"), /"cleanup_delete"/);

process.stdout.write("Safe cleanup candidate, preview, confirmation, backup, delete, and audit tests passed.\n");

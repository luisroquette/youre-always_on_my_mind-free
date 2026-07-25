import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryHome = mkdtempSync(join(tmpdir(), "project-memory-test-"));
const memoryRoot = join(temporaryHome, ".claude-mem");
const databasePath = join(memoryRoot, "claude-mem.db");
const helperPath = join(process.cwd(), "test", "fixtures", "claude-mem-bridge", "project-memory.mjs");
mkdirSync(memoryRoot, { recursive: true });

execFileSync("sqlite3", [databasePath, `
CREATE TABLE observations (
  id INTEGER PRIMARY KEY, project TEXT, type TEXT, title TEXT, subtitle TEXT, text TEXT, facts TEXT, narrative TEXT,
  concepts TEXT, files_read TEXT, files_modified TEXT, created_at TEXT, created_at_epoch INTEGER, agent_type TEXT,
  generated_by_model TEXT, relevance_count INTEGER, content_hash TEXT
);
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title, subtitle, narrative, text, facts, concepts, content='observations', content_rowid='id'
);
INSERT INTO observations VALUES
  (1,'alpha','decision','Authentication deployment','Use safe headers','api_key=supersecretvalue123, owner@example.com and +55 11 99999-1234',
   '["Token: token=secretvalue123456","CPF 123.456.789-10","Headers validated"]','Authentication deployed safely','["authentication","security"]',
   '["src/auth.js",".config/private.json"]','["src/app.js",".env"]','2026-01-01T00:00:00Z',1767225600000,'claude-code','model-a',2,'hash-a'),
  (2,'alpha','feature','Dashboard search','Add project search','Search implemented','["Project scoped"]','Fast project search',
   '["search"]','[]','["dashboard.js"]','2026-01-02T00:00:00Z',1767312000000,'codex','model-b',1,'hash-b'),
  (3,'beta','change','Other project','No overlap','Other content','[]','Other','[]','[]','[]','2026-01-03T00:00:00Z',1767398400000,NULL,'',0,'hash-c');
INSERT INTO observations_fts(rowid,title,subtitle,narrative,text,facts,concepts)
SELECT id,title,subtitle,narrative,text,facts,concepts FROM observations;
`]);
writeFileSync(join(memoryRoot, "gateway-feedback.jsonl"), '{"observation_id":1,"label":"useful"}\n', { mode: 0o600 });

function helper(args) {
  return JSON.parse(execFileSync(process.execPath, [helperPath, ...args], {
    env: { ...process.env, HOME: temporaryHome },
    encoding: "utf8",
  }));
}

const browse = helper(["browse", "--project", "alpha", "--limit", "25"]);
assert.equal(browse.total, 2);
assert.equal(browse.records.length, 2);
assert.deepEqual(new Set(browse.records.map(({ agent }) => agent)), new Set(["claude", "codex"]));
assert.equal(browse.quality_metadata.version, "quality-v1");
assert.ok(browse.records.every(({ quality }) => Number.isInteger(quality.overall)));

const search = helper(["browse", "--project", "alpha", "--query", "authentication", "--limit", "25"]);
assert.equal(search.total, 1);
assert.equal(search.records[0].id, 1);

const detail = helper(["inspect", "--id", "1", "--project", "alpha"]);
assert.equal(detail.feedback.useful, 1);
assert.equal(detail.redacted, true);
assert.doesNotMatch(JSON.stringify(detail), /supersecretvalue|owner@example\.com|secretvalue123456|99999-1234|123\.456\.789-10/);
assert.deepEqual(detail.files_modified, ["src/app.js"]);
assert.deepEqual(detail.files_read, ["src/auth.js"]);
assert.equal(detail.quality.version, "quality-v1");
assert.equal(detail.quality_metadata.semantics.exclusion_risk, "Maior significa mais perigoso apagar.");

const wrongProject = spawnSync(process.execPath, [helperPath, "inspect", "--id", "1", "--project", "beta"], {
  env: { ...process.env, HOME: temporaryHome },
  encoding: "utf8",
});
assert.notEqual(wrongProject.status, 0);

process.stdout.write("Project memory browse, search, scope, inspection, and redaction tests passed.\n");

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryHome = mkdtempSync(join(tmpdir(), "memory-timeline-test-"));
const memoryRoot = join(temporaryHome, ".claude-mem");
const databasePath = join(memoryRoot, "claude-mem.db");
const helperPath = join(process.cwd(), "test", "fixtures", "claude-mem-bridge", "timeline.mjs");
mkdirSync(memoryRoot, { recursive: true });

execFileSync("sqlite3", [databasePath, `
CREATE TABLE observations (
  id INTEGER PRIMARY KEY, project TEXT, agent_type TEXT, created_at_epoch INTEGER,
  text TEXT, title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT,
  files_read TEXT, files_modified TEXT, metadata TEXT
);
INSERT INTO observations VALUES
  (1,'alpha','claude-code',1767225600000,'a','A','','','','','[]','[]','{}'),
  (2,'alpha','claude-code',1767225600000,'b','B','','','','','[]','[]','{}'),
  (3,'alpha','codex',1767312000000,'c','C','','','','','[]','[]','{}'),
  (4,'beta','codex',1768435200000,'d','D','','','','','[]','[]','{}'),
  (5,'beta','claude-code',1768435200000,'e','E','','','','','[]','[]','{}');
`]);

const timeline = JSON.parse(execFileSync(process.execPath, [helperPath, "all", "auto"], {
  env: { ...process.env, HOME: temporaryHome },
  encoding: "utf8",
}));

assert.equal(timeline.metadata.bucket, "day");
assert.equal(timeline.metadata.start, "2026-01-01");
assert.equal(timeline.metadata.end, "2026-01-15");
assert.equal(timeline.summary.current_memories, 5);
assert.equal(timeline.summary.growth_memories, 5);
assert.equal(timeline.summary.current_codex_share_pct, 40);
assert.equal(timeline.summary.current_claude_share_pct, 60);
assert.equal(timeline.summary.current_legacy_share_pct, 0);
assert.equal(timeline.summary.active_projects, 2);
assert.equal(timeline.points.length, 15);
assert.equal(timeline.points[0].added_memories, 2);
assert.equal(timeline.points.at(-1).added_memories, 2);
assert.equal(timeline.events.length, 3);
assert.ok(timeline.summary.estimated_content_growth_bytes > 0);

process.stdout.write("Historical growth, saturation, and Claude/Codex timeline tests passed.\n");

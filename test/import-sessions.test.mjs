import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "always-on-my-mind-import-"));
const claude = join(directory, "claude.jsonl");
const codex = join(directory, "codex.jsonl");
const cursor = join(directory, "cursor.md");
const replit = join(directory, "replit.json");
const replitCheckpoint = join(directory, "replit-checkpoint.jsonl");
const generic = join(directory, "generic.jsonl");

await writeFile(claude, [
  JSON.stringify({ type: "user", cwd: "/work/alpha", sessionId: "claude-session-123456", message: { role: "user", content: "Implement local storage" } }),
  JSON.stringify({ type: "assistant", cwd: "/work/alpha", sessionId: "claude-session-123456", message: { role: "assistant", content: [{ type: "text", text: "Implemented local storage. token=secretvalue123456 and owner@example.com were redacted." }] } }),
].join("\n"));
await writeFile(codex, [
  JSON.stringify({ type: "session_meta", payload: { id: "codex-session-654321", cwd: "/work/beta" } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Validated the MCP integration." }] } }),
].join("\n"));
await writeFile(cursor, `---\nproject: /work/cursor-app\n---\n\n## User\nAdd local import support.\n\n## Cursor\nAdded the Cursor importer. token=cursorsecret123456 and cursor@example.com were redacted.\n`);
await writeFile(replit, JSON.stringify({
  replSlug: "replit-app",
  conversationId: "replit-session-987654",
  messages: [{ role: "user", content: "Add a dashboard" }, { role: "assistant", content: [{ type: "text", text: "Created the dashboard checkpoint. api_key=replitsecret123456." }] }],
}));
await writeFile(replitCheckpoint, JSON.stringify({ repl: { slug: "replit-checkpoint-app" }, type: "checkpoint", description: "Validated the deployment checkpoint." }));
await writeFile(generic, JSON.stringify({ project: "gamma", agent: "other", title: "External session", summary: "Imported through the generic JSONL adapter." }));

function run(source, input) {
  return JSON.parse(execFileSync("node", ["scripts/import-sessions.mjs", "--source", source, "--input", input, "--dry-run"], { encoding: "utf8" }));
}

const claudeResult = run("claude-code", claude);
assert.equal(claudeResult.candidates, 1);
assert.equal(claudeResult.records[0].project, "alpha");
assert.equal(claudeResult.records[0].agent, "claude-code");
assert.match(claudeResult.records[0].summary, /\[redacted\]/);
assert.doesNotMatch(JSON.stringify(claudeResult), /secretvalue|example\.com/);

const codexResult = run("codex", codex);
assert.equal(codexResult.records[0].project, "beta");
assert.equal(codexResult.records[0].agent, "codex");
assert.match(codexResult.records[0].summary, /Validated the MCP integration/);

const cursorResult = run("cursor", cursor);
assert.equal(cursorResult.records[0].project, "cursor-app");
assert.match(cursorResult.records[0].summary, /\[redacted\]/);
assert.doesNotMatch(JSON.stringify(cursorResult), /cursorsecret|cursor@example\.com/);

const replitResult = run("replit", replit);
assert.equal(replitResult.records[0].project, "replit-app");
assert.match(replitResult.records[0].summary, /Created the dashboard checkpoint/);
assert.doesNotMatch(JSON.stringify(replitResult), /replitsecret/);

const replitCheckpointResult = run("replit", replitCheckpoint);
assert.equal(replitCheckpointResult.records[0].project, "replit-checkpoint-app");
assert.match(replitCheckpointResult.records[0].summary, /Validated the deployment checkpoint/);

const genericResult = run("generic", generic);
assert.equal(genericResult.records[0].project, "gamma");
assert.equal(genericResult.records[0].agent, "other");

process.stdout.write("Claude Code, Codex, Cursor, Replit, generic importer, and redaction tests passed.\n");

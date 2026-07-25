import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "always-on-my-mind-import-"));
const claude = join(directory, "claude.jsonl");
const codex = join(directory, "codex.jsonl");
const generic = join(directory, "generic.jsonl");

await writeFile(claude, [
  JSON.stringify({ type: "user", cwd: "/work/alpha", sessionId: "claude-session-123456", message: { role: "user", content: "Implement local storage" } }),
  JSON.stringify({ type: "assistant", cwd: "/work/alpha", sessionId: "claude-session-123456", message: { role: "assistant", content: [{ type: "text", text: "Implemented local storage. token=secretvalue123456 and owner@example.com were redacted." }] } }),
].join("\n"));
await writeFile(codex, [
  JSON.stringify({ type: "session_meta", payload: { id: "codex-session-654321", cwd: "/work/beta" } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Validated the MCP integration." }] } }),
].join("\n"));
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

const genericResult = run("generic", generic);
assert.equal(genericResult.records[0].project, "gamma");
assert.equal(genericResult.records[0].agent, "other");

process.stdout.write("Claude Code, Codex, generic importer, and redaction tests passed.\n");

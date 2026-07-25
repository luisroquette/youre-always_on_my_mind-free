import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "always-on-my-mind-setup-"));
const configPath = join(directory, "mcp.json");
const dryRun = JSON.parse(execFileSync("node", ["scripts/setup.mjs", "--config", configPath, "--bridge", "src/index.js", "--dry-run"], { encoding: "utf8" }));
assert.equal(dryRun.mode, "dry-run");
assert.equal(dryRun.configuration.mcpServers["youre-always-on-my-mind"].command, process.execPath);
const configured = JSON.parse(execFileSync("node", ["scripts/setup.mjs", "--config", configPath, "--bridge", "src/index.js", "--yes"], { encoding: "utf8" }));
assert.equal(configured.configured, true);
const saved = JSON.parse(await readFile(configPath, "utf8"));
assert.deepEqual(saved.mcpServers["youre-always-on-my-mind"].args, [join(process.cwd(), "src/index.js")]);
process.stdout.write("One-command local MCP setup tests passed.\n");

#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { config } from "../src/config.mjs";

const checks = [
  ["Node.js 22+", Number(process.versions.node.split(".")[0]) >= 22, process.version],
  ["SQLite CLI", spawnSync("sqlite3", ["--version"], { encoding: "utf8" }).status === 0, "required by compatible SQLite bridges"],
  ["Memory bridge", existsSync(config.bridgePath), config.bridgePath],
];

let failed = false;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
  failed ||= !ok;
}

if (failed) {
  console.error("\nConfigure YOURE_ALWAYS_ON_MY_MIND_BRIDGE_PATH to a compatible local bridge. See docs/ADAPTERS.md.");
  process.exitCode = 1;
}

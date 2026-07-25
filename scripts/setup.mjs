#!/usr/bin/env node

import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { config } from "../src/config.mjs";

function usage() {
  console.error("Usage: setup [--config <path>] [--bridge <path>] [--dry-run] [--yes] [--force]");
  process.exit(1);
}

function optionsFrom(argv) {
  const options = { configPath: resolve(".mcp.json"), bridgePath: config.bridgePath, dryRun: false, yes: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config") options.configPath = resolve(argv[++index] ?? usage());
    else if (value === "--bridge") options.bridgePath = resolve(argv[++index] ?? usage());
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--yes") options.yes = true;
    else if (value === "--force") options.force = true;
    else usage();
  }
  return options;
}

async function readable(path) {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}

async function configAt(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return {}; }
}

function nextConfig(existing, bridgePath) {
  return {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      "youre-always-on-my-mind": {
        command: process.execPath,
        args: [bridgePath],
      },
    },
  };
}

const options = optionsFrom(process.argv.slice(2));
const bridgeExists = await readable(options.bridgePath);
if (!bridgeExists) {
  console.error(`Memory bridge not found: ${options.bridgePath}`);
  console.error("Set --bridge to a compatible local bridge, then run setup again.");
  process.exit(1);
}
const existing = await configAt(options.configPath);
const hasServer = Boolean(existing.mcpServers?.["youre-always-on-my-mind"]);
if (hasServer && !options.force) {
  console.error(`Configuration already exists in ${options.configPath}. Use --force to replace only this server entry.`);
  process.exit(1);
}
if (!options.yes && !options.dryRun && stdin.isTTY) {
  const prompt = createInterface({ input: stdin, output: stdout });
  const answer = await prompt.question(`Add local MCP configuration to ${options.configPath}? [y/N] `);
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim())) process.exit(0);
}
const result = nextConfig(existing, resolve("src/index.js"));
if (options.dryRun) {
  console.log(JSON.stringify({ mode: "dry-run", config_path: options.configPath, bridge_path: options.bridgePath, configuration: result }, null, 2));
  process.exit(0);
}
await writeFile(options.configPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ configured: true, config_path: options.configPath, next: "Run npm run doctor, then open your MCP client." }, null, 2));

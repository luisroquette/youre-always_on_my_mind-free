#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const DEFAULT_REPO = "luisroquette/youre-always_on_my_mind-free";
const PACKAGE = "youre_always_on_my_mind";

function usage() {
  console.error("Usage: adoption [--repo owner/name] [--offline]");
  process.exit(1);
}

function optionsFrom(argv) {
  const options = { repo: DEFAULT_REPO, offline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repo") options.repo = argv[++index] ?? usage();
    else if (value === "--offline") options.offline = true;
    else usage();
  }
  return options;
}

async function json(url) {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "youre-always-on-my-mind" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

const options = optionsFrom(process.argv.slice(2));
const doctor = spawnSync(process.execPath, ["scripts/doctor.mjs"], { encoding: "utf8" });
const result = { local_only: false, repository: options.repo, doctor: { ok: doctor.status === 0, errors: doctor.status === 0 ? 0 : 1 } };
if (options.offline) {
  result.local_only = true;
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
try {
  const [repo, npm] = await Promise.all([
    json(`https://api.github.com/repos/${options.repo}`),
    json(`https://api.npmjs.org/downloads/point/last-month/${PACKAGE}`).catch(() => null),
  ]);
  result.github = { stars: repo.stargazers_count, open_issues: repo.open_issues_count, forks: repo.forks_count };
  result.npm = npm ? { downloads_last_month: npm.downloads } : { available: false };
} catch (error) {
  result.community_metrics_error = error instanceof Error ? error.message : String(error);
}
console.log(JSON.stringify(result, null, 2));

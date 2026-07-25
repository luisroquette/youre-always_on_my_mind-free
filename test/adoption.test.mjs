import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const result = JSON.parse(execFileSync("node", ["scripts/adoption.mjs", "--offline", "--repo", "example/project"], { encoding: "utf8" }));
assert.equal(result.local_only, true);
assert.equal(result.repository, "example/project");
assert.equal(typeof result.doctor.ok, "boolean");
process.stdout.write("Local-only adoption metrics tests passed.\n");

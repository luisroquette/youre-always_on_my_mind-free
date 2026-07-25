import assert from "node:assert/strict";
import { QUALITY_METADATA, scoreMemory } from "./fixtures/claude-mem-bridge/memory-quality.mjs";

const now = Date.parse("2026-07-24T12:00:00Z");
const strong = scoreMemory({
  created_at_epoch: now - 7 * 86_400_000,
  relevance_count: 4,
  content_hash: "unique",
  title_duplicate_count: 1,
  content_duplicate_count: 1,
  title_length: 24,
  summary_length: 400,
  decision_length: 120,
  facts_count: 4,
  concepts_count: 3,
  files_count: 5,
  feedback: { useful: 2, incorrect: 0, obsolete: 0 },
}, now);

const disposable = scoreMemory({
  created_at_epoch: now - 900 * 86_400_000,
  relevance_count: 0,
  content_hash: "duplicated",
  title_duplicate_count: 5,
  content_duplicate_count: 4,
  title_length: 12,
  summary_length: 30,
  decision_length: 0,
  facts_count: 0,
  concepts_count: 0,
  files_count: 0,
  feedback: { useful: 0, incorrect: 1, obsolete: 2 },
}, now);

assert.ok(strong.overall > disposable.overall);
assert.ok(strong.exclusion_risk > disposable.exclusion_risk);
assert.ok(strong.relevance > disposable.relevance);
assert.ok(strong.utility > disposable.utility);
assert.ok(strong.redundancy < disposable.redundancy);
assert.ok(strong.age < disposable.age);
assert.equal(disposable.exclusion_risk_label, "baixo");
assert.equal(strong.version, "quality-v1");
assert.equal(Object.values(QUALITY_METADATA.quality_weights).reduce((sum, value) => sum + value, 0), 1);
for (const value of ["overall", "relevance", "redundancy", "age", "utility", "exclusion_risk", "confidence"]) {
  assert.ok(strong[value] >= 0 && strong[value] <= 100, `${value} outside scale`);
  assert.ok(disposable[value] >= 0 && disposable[value] <= 100, `${value} outside scale`);
}

process.stdout.write("Explainable memory quality score tests passed.\n");

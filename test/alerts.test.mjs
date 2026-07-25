import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_ALERT_CONFIG,
  evaluateAlerts,
  loadAlertConfig,
  saveAlertConfig,
  validateAlertConfig,
} from "./fixtures/claude-mem-bridge/alerts.mjs";

const directory = mkdtempSync(join(tmpdir(), "memory-alerts-"));
const databasePath = join(directory, "memory.db");
const feedbackPath = join(directory, "feedback.jsonl");
const configPath = join(directory, "alerts.json");

try {
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, created_at TEXT);");
  const insert = database.prepare("INSERT INTO observations(id, project, title, created_at) VALUES (?, ?, ?, ?);");
  for (let id = 1; id <= 100; id += 1) insert.run(id, "dense", `Memory ${id}`, "2026-07-20T12:00:00Z");
  insert.run(101, "stale", "Old decision", "2026-01-01T12:00:00Z");
  insert.run(102, "stale", "Old follow-up", "2026-01-02T12:00:00Z");
  insert.run(103, "conflicted", "Repeated", "2026-07-20T12:00:00Z");
  insert.run(104, "conflicted", "Repeated", "2026-07-20T12:00:00Z");
  insert.run(105, "conflicted", "Repeated", "2026-07-20T12:00:00Z");
  insert.run(106, "conflicted", "Repeated", "2026-07-20T12:00:00Z");
  insert.run(107, "conflicted", "", "2026-07-20T12:00:00Z");
  database.close();
  writeFileSync(feedbackPath, [
    JSON.stringify({ observation_id: 103, label: "useful" }),
    JSON.stringify({ observation_id: 103, label: "incorrect" }),
  ].join("\n"));

  const result = evaluateAlerts({
    databasePath,
    feedbackLogPath: feedbackPath,
    config: DEFAULT_ALERT_CONFIG,
    now: new Date("2026-07-24T12:00:00Z"),
  });
  assert.ok(result.alerts.some(({ project, kind }) => project === "dense" && kind === "saturation"));
  assert.ok(result.alerts.some(({ project, kind }) => project === "stale" && kind === "stale"));
  const inconsistent = result.alerts.find(({ project, kind }) => project === "conflicted" && kind === "inconsistent");
  assert.equal(inconsistent.severity, "critical");
  assert.equal(inconsistent.evidence.conflicting_feedback, 1);

  const muted = evaluateAlerts({
    databasePath,
    feedbackLogPath: feedbackPath,
    config: { ...DEFAULT_ALERT_CONFIG, muted_projects: ["conflicted"] },
    now: new Date("2026-07-24T12:00:00Z"),
  });
  assert.ok(!muted.alerts.some(({ project }) => project === "conflicted"));

  const saved = saveAlertConfig({
    ...DEFAULT_ALERT_CONFIG,
    saturation: { enabled: true, threshold: 91, minimum_observations: 10 },
    muted_projects: ["stale", "stale", "", 42],
  }, configPath);
  assert.equal(saved.saturation.threshold, 91);
  assert.deepEqual(saved.muted_projects, ["stale"]);
  assert.equal(loadAlertConfig(configPath).saturation.threshold, 91);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).version, 1);
  assert.equal(validateAlertConfig({ stale: { days: -2 } }).stale.days, 90);
  process.stdout.write("Configurable saturation, stale, inconsistency, persistence, and project mute alert tests passed.\n");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

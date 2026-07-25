#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const memoryRoot = join(homedir(), ".claude-mem");
const sourcePath = join(memoryRoot, "claude-mem.db");
const feedbackPath = join(memoryRoot, "gateway-feedback.jsonl");
const configPath = join(memoryRoot, "gateway-alert-config.json");

export const DEFAULT_ALERT_CONFIG = Object.freeze({
  version: 1,
  enabled: true,
  saturation: { enabled: true, threshold: 78, minimum_observations: 5 },
  stale: { enabled: true, days: 90, minimum_observations: 2 },
  inconsistent: {
    enabled: true,
    duplicate_threshold: 3,
    incorrect_feedback_threshold: 1,
    missing_title_threshold: 1,
  },
  muted_projects: [],
});

function boolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function integer(value, fallback, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

export function validateAlertConfig(input = {}) {
  const muted = Array.isArray(input.muted_projects)
    ? [...new Set(input.muted_projects.filter((project) => typeof project === "string" && project.trim() && project.length <= 120).map((project) => project.trim()))].slice(0, 100)
    : [];
  return {
    version: 1,
    enabled: boolean(input.enabled, DEFAULT_ALERT_CONFIG.enabled),
    saturation: {
      enabled: boolean(input.saturation?.enabled, DEFAULT_ALERT_CONFIG.saturation.enabled),
      threshold: integer(input.saturation?.threshold, DEFAULT_ALERT_CONFIG.saturation.threshold, 40, 100),
      minimum_observations: integer(input.saturation?.minimum_observations, DEFAULT_ALERT_CONFIG.saturation.minimum_observations, 1, 100_000),
    },
    stale: {
      enabled: boolean(input.stale?.enabled, DEFAULT_ALERT_CONFIG.stale.enabled),
      days: integer(input.stale?.days, DEFAULT_ALERT_CONFIG.stale.days, 7, 3_650),
      minimum_observations: integer(input.stale?.minimum_observations, DEFAULT_ALERT_CONFIG.stale.minimum_observations, 1, 100_000),
    },
    inconsistent: {
      enabled: boolean(input.inconsistent?.enabled, DEFAULT_ALERT_CONFIG.inconsistent.enabled),
      duplicate_threshold: integer(input.inconsistent?.duplicate_threshold, DEFAULT_ALERT_CONFIG.inconsistent.duplicate_threshold, 1, 10_000),
      incorrect_feedback_threshold: integer(input.inconsistent?.incorrect_feedback_threshold, DEFAULT_ALERT_CONFIG.inconsistent.incorrect_feedback_threshold, 1, 10_000),
      missing_title_threshold: integer(input.inconsistent?.missing_title_threshold, DEFAULT_ALERT_CONFIG.inconsistent.missing_title_threshold, 1, 10_000),
    },
    muted_projects: muted.sort((left, right) => left.localeCompare(right)),
  };
}

export function loadAlertConfig(path = configPath) {
  if (!existsSync(path)) return validateAlertConfig(DEFAULT_ALERT_CONFIG);
  try {
    return validateAlertConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return validateAlertConfig(DEFAULT_ALERT_CONFIG);
  }
}

export function saveAlertConfig(input, path = configPath) {
  const config = validateAlertConfig(input);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return config;
}

function feedbackByObservation(path) {
  const records = new Map();
  if (!existsSync(path)) return records;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (!Number.isInteger(event.observation_id) || !["useful", "incorrect", "obsolete"].includes(event.label)) continue;
      const summary = records.get(event.observation_id) ?? { useful: 0, incorrect: 0, obsolete: 0 };
      summary[event.label] += 1;
      records.set(event.observation_id, summary);
    } catch {
      // Ignore an incomplete append-only line.
    }
  }
  return records;
}

function alertId(kind, project) {
  return createHash("sha256").update(`${kind}\u001f${project}`).digest("hex").slice(0, 16);
}

function ageDays(value, now) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, Math.floor((now.getTime() - timestamp) / 86_400_000)) : 99_999;
}

export function evaluateAlerts({
  databasePath = sourcePath,
  feedbackLogPath = feedbackPath,
  config = loadAlertConfig(),
  now = new Date(),
  project = "",
} = {}) {
  if (!existsSync(databasePath)) throw new Error(`Claude memory database not found: ${databasePath}`);
  const settings = validateAlertConfig(config);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const projects = database.prepare(`
SELECT project, count(*) AS observations, max(created_at) AS last_activity,
       sum(CASE WHEN title IS NULL OR trim(title) = '' THEN 1 ELSE 0 END) AS missing_titles
FROM observations
WHERE project IS NOT NULL AND trim(project) <> ''
${project ? "AND project = ?" : ""}
GROUP BY project ORDER BY observations DESC, project;
    `).all(...(project ? [project] : []));
    const duplicateRows = database.prepare(`
SELECT project, sum(copies - 1) AS duplicate_excess
FROM (
  SELECT project, lower(trim(title)) AS normalized_title, count(*) AS copies
  FROM observations
  WHERE title IS NOT NULL AND trim(title) <> ''
  ${project ? "AND project = ?" : ""}
  GROUP BY project, normalized_title
  HAVING copies > 1
)
GROUP BY project;
    `).all(...(project ? [project] : []));
    const duplicateMap = new Map(duplicateRows.map(({ project: name, duplicate_excess }) => [name, Number(duplicate_excess)]));
    const feedback = feedbackByObservation(feedbackLogPath);
    const feedbackProjects = new Map();
    if (feedback.size) {
      const ids = [...feedback.keys()];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = ids.slice(offset, offset + 500);
        const placeholders = batch.map(() => "?").join(",");
        for (const row of database.prepare(`SELECT id, project FROM observations WHERE id IN (${placeholders});`).all(...batch)) {
          const signals = feedback.get(Number(row.id));
          const summary = feedbackProjects.get(row.project) ?? { incorrect: 0, conflicting: 0 };
          summary.incorrect += signals.incorrect;
          if (signals.useful > 0 && (signals.incorrect > 0 || signals.obsolete > 0)) summary.conflicting += 1;
          feedbackProjects.set(row.project, summary);
        }
      }
    }
    const maximum = Math.max(1, ...projects.map(({ observations }) => Number(observations)));
    const muted = new Set(settings.muted_projects);
    const alerts = [];
    for (const row of projects) {
      const name = row.project;
      const observations = Number(row.observations);
      const days = ageDays(row.last_activity, now);
      const volumeScore = Math.log1p(observations) / Math.log1p(maximum);
      const saturationScore = Math.round(Math.min(100, volumeScore * 88 + Math.min(days / 365, 1) * 12));
      const duplicateExcess = duplicateMap.get(name) ?? 0;
      const feedbackSignals = feedbackProjects.get(name) ?? { incorrect: 0, conflicting: 0 };
      const missingTitles = Number(row.missing_titles);
      if (!settings.enabled || muted.has(name)) continue;
      if (settings.saturation.enabled && observations >= settings.saturation.minimum_observations && saturationScore >= settings.saturation.threshold) {
        alerts.push({
          id: alertId("saturation", name),
          kind: "saturation",
          severity: saturationScore >= Math.min(100, settings.saturation.threshold + 12) ? "critical" : "warning",
          project: name,
          title: "Memória saturada",
          message: `${observations.toLocaleString("pt-BR")} memórias e pressão de ${saturationScore}%.`,
          value: saturationScore,
          threshold: settings.saturation.threshold,
          evidence: { observations, age_days: days, saturation_score: saturationScore },
        });
      }
      if (settings.stale.enabled && observations >= settings.stale.minimum_observations && days >= settings.stale.days) {
        alerts.push({
          id: alertId("stale", name),
          kind: "stale",
          severity: days >= settings.stale.days * 2 ? "critical" : "warning",
          project: name,
          title: "Memória desatualizada",
          message: `Sem atividade há ${days} dias.`,
          value: days,
          threshold: settings.stale.days,
          evidence: { observations, age_days: days, last_activity: row.last_activity },
        });
      }
      const inconsistent = duplicateExcess >= settings.inconsistent.duplicate_threshold
        || feedbackSignals.incorrect >= settings.inconsistent.incorrect_feedback_threshold
        || missingTitles >= settings.inconsistent.missing_title_threshold
        || feedbackSignals.conflicting > 0;
      if (settings.inconsistent.enabled && inconsistent) {
        const reasons = [];
        if (duplicateExcess >= settings.inconsistent.duplicate_threshold) reasons.push(`${duplicateExcess} títulos repetidos`);
        if (feedbackSignals.incorrect >= settings.inconsistent.incorrect_feedback_threshold) reasons.push(`${feedbackSignals.incorrect} feedbacks incorretos`);
        if (feedbackSignals.conflicting) reasons.push(`${feedbackSignals.conflicting} conflitos de feedback`);
        if (missingTitles >= settings.inconsistent.missing_title_threshold) reasons.push(`${missingTitles} títulos ausentes`);
        alerts.push({
          id: alertId("inconsistent", name),
          kind: "inconsistent",
          severity: feedbackSignals.incorrect > 0 || feedbackSignals.conflicting > 0
            || duplicateExcess >= settings.inconsistent.duplicate_threshold * 10 ? "critical" : "warning",
          project: name,
          title: "Memória inconsistente",
          message: `${reasons.join(" · ")}.`,
          value: duplicateExcess + feedbackSignals.incorrect + feedbackSignals.conflicting + missingTitles,
          threshold: 1,
          evidence: {
            repeated_title_excess: duplicateExcess,
            incorrect_feedback: feedbackSignals.incorrect,
            conflicting_feedback: feedbackSignals.conflicting,
            missing_titles: missingTitles,
          },
        });
      }
    }
    const order = { critical: 0, warning: 1 };
    alerts.sort((left, right) => order[left.severity] - order[right.severity] || right.value - left.value || left.project.localeCompare(right.project));
    const byKind = { saturation: 0, stale: 0, inconsistent: 0 };
    for (const alert of alerts) byKind[alert.kind] += 1;
    return {
      enabled: settings.enabled,
      summary: {
        total: alerts.length,
        critical: alerts.filter(({ severity }) => severity === "critical").length,
        warning: alerts.filter(({ severity }) => severity === "warning").length,
        by_kind: byKind,
        evaluated_projects: projects.length,
        muted_projects: settings.muted_projects.length,
      },
      alerts,
      config: settings,
      metadata: {
        version: "alerts-v1",
        generated_at: now.toISOString(),
        local_only: true,
        rules: ["saturation-score", "days-since-activity", "repeated-titles-feedback-missing-title"],
      },
    };
  } finally {
    database.close();
  }
}

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function main() {
  const command = process.argv[2];
  if (command === "list") return evaluateAlerts({ project: option("--project") });
  if (command === "config-get") return { config: loadAlertConfig(), path: configPath };
  if (command === "config-set") {
    const value = option("--json");
    if (!value) throw new Error("Alert configuration JSON is required.");
    const config = saveAlertConfig(JSON.parse(value));
    return { saved: true, config, path: configPath, alerts: evaluateAlerts({ config }).summary };
  }
  if (command === "config-reset") {
    const config = saveAlertConfig(DEFAULT_ALERT_CONFIG);
    return { saved: true, reset: true, config, path: configPath, alerts: evaluateAlerts({ config }).summary };
  }
  throw new Error("Usage: alerts.mjs {list|config-get|config-set --json <json>|config-reset} [--project <name>]");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(main())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

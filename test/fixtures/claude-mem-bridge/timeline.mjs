#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const databasePath = join(homedir(), ".claude-mem", "claude-mem.db");
const validRanges = new Set(["30", "90", "180", "365", "all"]);
const validBuckets = new Set(["auto", "day", "week", "month"]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

function sqliteJson(sql) {
  const output = execFileSync("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 10000", databasePath, sql], {
    encoding: "utf8",
    maxBuffer: 12_000_000,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function utcDay(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function startOfBucket(date, bucket) {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (bucket === "week") result.setUTCDate(result.getUTCDate() - ((result.getUTCDay() + 6) % 7));
  if (bucket === "month") result.setUTCDate(1);
  return result;
}

function nextBucket(date, bucket) {
  const result = new Date(date);
  if (bucket === "day") result.setUTCDate(result.getUTCDate() + 1);
  if (bucket === "week") result.setUTCDate(result.getUTCDate() + 7);
  if (bucket === "month") result.setUTCMonth(result.getUTCMonth() + 1, 1);
  return result;
}

function chooseBucket(requested, spanDays) {
  if (requested !== "auto") return requested;
  if (spanDays <= 45) return "day";
  if (spanDays <= 240) return "week";
  return "month";
}

function agentShares(counts) {
  const total = counts.claude + counts.codex + counts.legacy;
  const share = (value) => total ? Math.round((value / total) * 10_000) / 100 : 0;
  return { codex_share_pct: share(counts.codex), claude_share_pct: share(counts.claude), legacy_share_pct: share(counts.legacy) };
}

function saturationSnapshot(projects, atEpoch) {
  const records = [...projects.values()];
  const maximum = Math.max(1, ...records.map(({ observations }) => observations));
  let saturated = 0;
  for (const project of records) {
    const volumeScore = Math.log1p(project.observations) / Math.log1p(maximum);
    const ageDays = Math.max(0, (atEpoch - project.last_activity_epoch) / 86_400_000);
    const score = Math.min(100, volumeScore * 88 + Math.min(ageDays / 365, 1) * 12);
    if (score >= 78) saturated += 1;
  }
  const ordered = records.map(({ observations }) => observations).sort((left, right) => right - left);
  const total = ordered.reduce((sum, count) => sum + count, 0);
  const concentration = total ? ordered.slice(0, 3).reduce((sum, count) => sum + count, 0) / total * 100 : 0;
  return {
    saturated_projects: saturated,
    concentration_pct: Math.round(concentration * 10) / 10,
    active_projects: records.length,
  };
}

function applyRecord(state, record) {
  const project = state.projects.get(record.project) ?? { observations: 0, last_activity_epoch: 0 };
  project.observations += record.observations;
  project.last_activity_epoch = Math.max(project.last_activity_epoch, Date.parse(`${record.day}T23:59:59.999Z`));
  state.projects.set(record.project, project);
  state.memories += record.observations;
  state.bytes += record.estimated_bytes;
  state.agents[record.agent] += record.observations;
}

const range = process.argv[2] ?? "90";
const requestedBucket = process.argv[3] ?? "auto";
if (!validRanges.has(range) || !validBuckets.has(requestedBucket)) fail("Usage: timeline.mjs <30|90|180|365|all> <auto|day|week|month>");

const rows = sqliteJson(`
SELECT
  date(created_at_epoch / 1000, 'unixepoch') AS day,
  project,
  CASE WHEN agent_type = 'codex' THEN 'codex' WHEN agent_type = 'claude-code' THEN 'claude' ELSE 'legacy' END AS agent,
  count(*) AS observations,
  sum(
    length(coalesce(text, '')) + length(coalesce(title, '')) + length(coalesce(subtitle, '')) +
    length(coalesce(facts, '')) + length(coalesce(narrative, '')) + length(coalesce(concepts, '')) +
    length(coalesce(files_read, '')) + length(coalesce(files_modified, '')) + length(coalesce(metadata, ''))
  ) AS estimated_bytes
FROM observations
WHERE created_at_epoch > 0 AND project IS NOT NULL AND project <> ''
GROUP BY day, project, agent
ORDER BY day, project, agent;
`).map((record) => ({
  ...record,
  observations: Number(record.observations),
  estimated_bytes: Number(record.estimated_bytes ?? 0),
  epoch: Date.parse(`${record.day}T00:00:00.000Z`),
}));

if (!rows.length) {
  process.stdout.write(`${JSON.stringify({ metadata: { range, bucket: "day", start: null, end: null }, summary: {}, points: [], events: [] })}\n`);
  process.exit(0);
}

const earliest = utcDay(rows[0].day);
const latest = utcDay(rows.at(-1).day);
const rangeStart = range === "all"
  ? earliest
  : new Date(latest.getTime() - (Number(range) - 1) * 86_400_000);
const spanDays = Math.max(1, Math.round((latest - rangeStart) / 86_400_000) + 1);
const bucket = chooseBucket(requestedBucket, spanDays);
const displayStart = startOfBucket(rangeStart, bucket);
const displayEnd = new Date(latest.getTime() + 86_400_000 - 1);
const state = { memories: 0, bytes: 0, agents: { claude: 0, codex: 0, legacy: 0 }, projects: new Map() };
let rowIndex = 0;

while (rowIndex < rows.length && rows[rowIndex].epoch < rangeStart.getTime()) {
  applyRecord(state, rows[rowIndex]);
  rowIndex += 1;
}

const baseline = {
  memories: state.memories,
  ...agentShares(state.agents),
  ...saturationSnapshot(state.projects, rangeStart.getTime() - 1),
};
const points = [];
let cursor = displayStart;
while (cursor <= displayEnd) {
  const next = nextBucket(cursor, bucket);
  const bucketEnd = Math.min(next.getTime() - 1, displayEnd.getTime());
  const additions = { memories: 0, bytes: 0, agents: { claude: 0, codex: 0, legacy: 0 } };
  while (rowIndex < rows.length && rows[rowIndex].epoch <= bucketEnd) {
    const record = rows[rowIndex];
    applyRecord(state, record);
    if (record.epoch >= rangeStart.getTime()) {
      additions.memories += record.observations;
      additions.bytes += record.estimated_bytes;
      additions.agents[record.agent] += record.observations;
    }
    rowIndex += 1;
  }
  const saturation = saturationSnapshot(state.projects, bucketEnd);
  points.push({
    date: isoDay(cursor < rangeStart ? rangeStart : cursor),
    end_date: isoDay(new Date(bucketEnd)),
    added_memories: additions.memories,
    added_bytes: additions.bytes,
    cumulative_memories: state.memories,
    claude_added: additions.agents.claude,
    codex_added: additions.agents.codex,
    legacy_added: additions.agents.legacy,
    claude_cumulative: state.agents.claude,
    codex_cumulative: state.agents.codex,
    legacy_cumulative: state.agents.legacy,
    ...agentShares(state.agents),
    ...saturation,
  });
  cursor = next;
}

const current = points.at(-1);
const growth = current.cumulative_memories - baseline.memories;
const largestGrowth = points.reduce((best, point) => point.added_memories > best.added_memories ? point : best, points[0]);
const saturationPeak = points.reduce((best, point) => point.saturated_projects > best.saturated_projects ? point : best, points[0]);
let mixShift = points[0];
let mixShiftDelta = Math.abs(points[0].codex_share_pct - baseline.codex_share_pct);
for (let index = 1; index < points.length; index += 1) {
  const delta = Math.abs(points[index].codex_share_pct - points[index - 1].codex_share_pct);
  if (delta > mixShiftDelta) {
    mixShift = points[index];
    mixShiftDelta = delta;
  }
}

const events = [
  { type: "growth", date: largestGrowth.date, value: largestGrowth.added_memories, label: "Maior expansão", detail: `${largestGrowth.added_memories} novas memórias no período` },
  { type: "saturation", date: saturationPeak.date, value: saturationPeak.saturated_projects, label: "Pico de saturação", detail: `${saturationPeak.saturated_projects} projetos saturados` },
  { type: "agent", date: mixShift.date, value: Math.round(mixShiftDelta * 10) / 10, label: "Maior mudança de agente", detail: `${Math.round(mixShiftDelta * 10) / 10} pontos percentuais` },
];

process.stdout.write(`${JSON.stringify({
  metadata: {
    range,
    bucket,
    start: isoDay(rangeStart),
    end: isoDay(latest),
    generated_at: new Date().toISOString(),
    source: "local-observation-aggregates",
  },
  summary: {
    baseline_memories: baseline.memories,
    current_memories: current.cumulative_memories,
    growth_memories: growth,
    growth_pct: baseline.memories ? Math.round((growth / baseline.memories) * 10_000) / 100 : 100,
    estimated_content_growth_bytes: points.reduce((sum, point) => sum + point.added_bytes, 0),
    current_saturated_projects: current.saturated_projects,
    saturation_delta: current.saturated_projects - baseline.saturated_projects,
    current_concentration_pct: current.concentration_pct,
    concentration_delta: Math.round((current.concentration_pct - baseline.concentration_pct) * 10) / 10,
    current_codex_share_pct: current.codex_share_pct,
    codex_share_delta: Math.round((current.codex_share_pct - baseline.codex_share_pct) * 10) / 10,
    current_claude_share_pct: current.claude_share_pct,
    current_legacy_share_pct: current.legacy_share_pct,
    active_projects: current.active_projects,
  },
  points,
  events,
})}\n`);

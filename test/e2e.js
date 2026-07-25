import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "index.js");
if (!process.env.YOURE_ALWAYS_ON_MY_MIND_BRIDGE_PATH) {
  process.stdout.write("MCP E2E skipped: set YOURE_ALWAYS_ON_MY_MIND_BRIDGE_PATH to run against a local claude-mem-compatible bridge.\n");
  process.exit(0);
}
const client = new Client({ name: "memory-gateway-e2e", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "memory_alert_configure", "memory_alerts", "memory_cleanup_candidates", "memory_cleanup_execute", "memory_cleanup_preview",
    "memory_cleanup_simulate", "memory_clusters", "memory_embedding_health", "memory_feedback", "memory_health", "memory_observation_detail",
    "memory_project_browse", "memory_quality_score", "memory_relations", "memory_timeline", "record_memory", "search_memory", "semantic_search_memory",
  ]);

  const search = await client.callTool({ name: "search_memory", arguments: { query: "Claude memory bridge hardened", limit: 3 } });
  assert.equal(search.isError, undefined);
  const searchPayload = JSON.parse(search.content[0].text);
  assert.equal(searchPayload.records.find((record) => record.id === 20788)?.feedback.useful, 1);

  const preview = await client.callTool({ name: "record_memory", arguments: {
    title: "MCP gateway dry-run validation", summary: "No observation must be written.", project: "luisroquette", dry_run: true, agent: "codex",
  } });
  assert.match(preview.content[0].text, /"dry_run": 1/);

  const health = await client.callTool({ name: "memory_health", arguments: { full: false } });
  assert.match(health.content[0].text, /"ok": true/);
  const embeddingHealth = await client.callTool({ name: "memory_embedding_health", arguments: {} });
  assert.match(embeddingHealth.content[0].text, /"local_only": true/);
  const semanticSearch = await client.callTool({
    name: "semantic_search_memory",
    arguments: { query: "memória semântica local", project: "memory-gateway-mcp", limit: 3 },
  });
  assert.equal(semanticSearch.isError, undefined);
  const semanticSearchPayload = JSON.parse(semanticSearch.content[0].text);
  assert.equal(semanticSearchPayload.local_only, true);
  assert.equal(semanticSearchPayload.external_requests, 0);
  const alerts = await client.callTool({ name: "memory_alerts", arguments: { limit: 5 } });
  assert.equal(alerts.isError, undefined);
  const alertsPayload = JSON.parse(alerts.content[0].text);
  assert.ok(alertsPayload.summary.total > 0);
  assert.equal(alertsPayload.metadata.local_only, true);
  const alertConfig = await client.callTool({
    name: "memory_alert_configure",
    arguments: { stale_days: 90, saturation_threshold: 78, muted_projects: [] },
  });
  assert.equal(alertConfig.isError, undefined);
  assert.match(alertConfig.content[0].text, /"saved": true/);

  const relations = await client.callTool({ name: "memory_relations", arguments: { limit: 3 } });
  assert.equal(relations.isError, undefined);
  const relationPayload = JSON.parse(relations.content[0].text);
  assert.ok(relationPayload.count > 0);
  assert.ok(relationPayload.records[0].evidence);

  const clusters = await client.callTool({ name: "memory_clusters", arguments: { axis: "technology" } });
  assert.equal(clusters.isError, undefined);
  const clusterPayload = JSON.parse(clusters.content[0].text);
  assert.ok(clusterPayload.count > 0);
  assert.equal(clusterPayload.metadata.method, "weighted-louvain-facets-v1");

  const timeline = await client.callTool({ name: "memory_timeline", arguments: { range: "90", bucket: "auto" } });
  assert.equal(timeline.isError, undefined);
  const timelinePayload = JSON.parse(timeline.content[0].text);
  assert.ok(timelinePayload.points.length > 2);
  assert.ok(timelinePayload.summary.growth_memories > 0);
  assert.equal(timelinePayload.metadata.source, "local-observation-aggregates");

  const projectMemories = await client.callTool({
    name: "memory_project_browse", arguments: { project: "memory-gateway-mcp", limit: 3 },
  });
  assert.equal(projectMemories.isError, undefined);
  const projectMemoryPayload = JSON.parse(projectMemories.content[0].text);
  assert.ok(projectMemoryPayload.total > 0);
  const memoryDetail = await client.callTool({
    name: "memory_observation_detail",
    arguments: { project: "memory-gateway-mcp", observation_id: projectMemoryPayload.records[0].id },
  });
  assert.equal(memoryDetail.isError, undefined);
  const memoryDetailPayload = JSON.parse(memoryDetail.content[0].text);
  assert.equal(memoryDetailPayload.project, "memory-gateway-mcp");
  assert.equal(typeof memoryDetailPayload.redacted, "boolean");
  assert.equal(memoryDetailPayload.quality.version, "quality-v1");
  const quality = await client.callTool({
    name: "memory_quality_score",
    arguments: { project: "memory-gateway-mcp", observation_id: projectMemoryPayload.records[0].id },
  });
  assert.equal(quality.isError, undefined);
  const qualityPayload = JSON.parse(quality.content[0].text);
  assert.equal(qualityPayload.quality_metadata.version, "quality-v1");
  assert.ok(qualityPayload.quality.exclusion_risk >= 0 && qualityPayload.quality.exclusion_risk <= 100);

  const cleanupCandidates = await client.callTool({ name: "memory_cleanup_candidates", arguments: { limit: 3 } });
  assert.equal(cleanupCandidates.isError, undefined);
  const cleanupPayload = JSON.parse(cleanupCandidates.content[0].text);
  assert.ok(cleanupPayload.summary.total >= cleanupPayload.returned);
  if (cleanupPayload.records.length) {
    const cleanupSimulation = await client.callTool({
      name: "memory_cleanup_simulate",
      arguments: { observation_ids: [cleanupPayload.records[0].id] },
    });
    assert.equal(cleanupSimulation.isError, undefined);
    const simulationPayload = JSON.parse(cleanupSimulation.content[0].text);
    assert.equal(simulationPayload.database_changed, false);
    assert.equal(simulationPayload.storage.immediate_file_reduction_bytes, 0);
    assert.ok(simulationPayload.storage.compacted_file_reduction_estimated_bytes > 0);
    const cleanupPreview = await client.callTool({
      name: "memory_cleanup_preview",
      arguments: { observation_ids: [cleanupPayload.records[0].id] },
    });
    assert.equal(cleanupPreview.isError, undefined);
    assert.match(cleanupPreview.content[0].text, /"recoverable": true/);
  }

  if (process.env.MEMORY_GATEWAY_WRITE_E2E === "1") {
    const feedback = await client.callTool({ name: "memory_feedback", arguments: {
      observation_id: 20788, label: "useful", note: "Validated through the local MCP gateway.", agent: "codex",
    } });
    assert.match(feedback.content[0].text, /"recorded": true/);
  }
  process.stdout.write("MCP search, record preview, and health E2E passed.\n");
} finally {
  await client.close();
}

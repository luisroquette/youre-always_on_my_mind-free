import assert from "node:assert/strict";
import { buildAutomaticClusters, buildSemanticRelations } from "../semantic-relations.mjs";

const payload = {
  sampled_per_project: 20,
  project_files: [
    { project: "alpha", file: "src/auth.ts" },
    { project: "beta", file: "src/auth.ts" },
    { project: "alpha", file: ".claude/settings.json" },
    { project: "beta", file: ".claude/settings.json" },
    { project: "alpha", file: ".env.local" },
    { project: "beta", file: ".env.local" },
    { project: "gamma", file: "src/invoice-engine.ts" },
  ],
  observations: [
    { project: "alpha", type: "decision", title: "Supabase cron authentication", subtitle: "Use signed header validation for cron jobs", concepts: '["Supabase","cron"]' },
    { project: "beta", type: "change", title: "Cron authentication hardened", subtitle: "Signed header validation prevents unauthorized cron calls", concepts: '["Supabase","authentication"]' },
    { project: "gamma", type: "feature", title: "Stripe invoice reconciliation", subtitle: "Billing events update invoice balances", concepts: '["Stripe","billing"]' },
  ],
};

const graph = buildSemanticRelations(payload, ["alpha", "beta", "gamma"]);
const alphaBeta = graph.relations.find(({ source, target }) => source === "alpha" && target === "beta");

assert.ok(alphaBeta, "expected a real alpha-beta semantic relation");
assert.equal(alphaBeta.confidence, "extracted");
assert.ok(alphaBeta.evidence.files.includes("src/auth.ts"));
assert.equal(alphaBeta.evidence.files.some((file) => file.includes(".claude") || file.includes(".env")), false);
assert.ok(alphaBeta.evidence.topics.some((topic) => ["supabase", "cron", "authentication"].includes(topic)));
assert.ok(alphaBeta.evidence.decisions.includes("header"));
assert.equal(graph.relations.some(({ source, target }) => [source, target].includes("gamma")), false);
assert.equal(graph.metadata.connected_projects, 2);
assert.equal(graph.project_metrics.alpha.connections, 1);

const clusters = buildAutomaticClusters(graph, [
  { project: "alpha", observations: 12, codex_observations: 10, claude_observations: 2 },
  { project: "beta", observations: 9, codex_observations: 2, claude_observations: 7 },
  { project: "gamma", observations: 4, codex_observations: 2, claude_observations: 2 },
]);
const alphaProduct = clusters.axes.product.find(({ projects }) => projects.includes("alpha"));
const supabaseCluster = clusters.axes.technology.find(({ label }) => label === "Supabase");

assert.ok(alphaProduct.projects.includes("beta"));
assert.ok(supabaseCluster.projects.includes("alpha") && supabaseCluster.projects.includes("beta"));
assert.equal(clusters.axes.agent.find(({ label }) => label === "Codex").projects.includes("alpha"), true);
assert.equal(clusters.axes.agent.find(({ label }) => label === "Claude").projects.includes("beta"), true);
assert.equal(clusters.metadata.method, "weighted-louvain-facets-v1");
assert.ok(clusters.project_memberships.gamma.product);

process.stdout.write("Semantic relation and automatic cluster tests passed.\n");

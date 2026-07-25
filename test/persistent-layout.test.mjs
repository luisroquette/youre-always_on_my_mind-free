import assert from "node:assert/strict";
import {
  LAYOUT_STORAGE_KEY,
  LAYOUT_VERSION,
  baseLayoutCandidate,
  clusterLayoutCandidate,
  resolvePersistentLayout,
} from "../dashboard/persistent-layout.js";

function memoryStorage(initial = {}) {
  const records = new Map(Object.entries(initial));
  return {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    records,
  };
}

const projects = [
  { id: "alpha", radius: 1.4, signature: "base" },
  { id: "beta", radius: 0.8, signature: "base" },
  { id: "gamma", radius: 0.5, signature: "base" },
];
const storage = memoryStorage();
const first = resolvePersistentLayout(projects, { storage });
const second = resolvePersistentLayout([...projects].reverse(), { storage });
assert.deepEqual(Object.fromEntries(second.positions), Object.fromEntries(first.positions));
assert.equal(second.metadata.reused, projects.length);
assert.equal(second.metadata.created, 0);
assert.equal(second.metadata.persisted, true);
assert.equal(second.metadata.version, LAYOUT_VERSION);

const beforeGrowth = Object.fromEntries(second.positions);
const grown = resolvePersistentLayout([...projects, { id: "delta", radius: 0.7, signature: "base" }], { storage });
for (const project of projects) assert.deepEqual(grown.positions.get(project.id), beforeGrowth[project.id]);
assert.equal(grown.metadata.created, 1);

const crowdedItems = Array.from({ length: 32 }, (_, index) => ({
  id: `project-${String(index).padStart(2, "0")}`,
  radius: index % 7 === 0 ? 1.4 : 0.55,
  signature: "base",
}));
const crowded = resolvePersistentLayout(crowdedItems, { storage: memoryStorage() });
for (let left = 0; left < crowdedItems.length; left += 1) {
  for (let right = left + 1; right < crowdedItems.length; right += 1) {
    const a = crowded.positions.get(crowdedItems[left].id);
    const b = crowded.positions.get(crowdedItems[right].id);
    const projected = Math.hypot(a.x - b.x, a.y - b.y);
    assert.ok(projected > crowdedItems[left].radius + crowdedItems[right].radius, `${crowdedItems[left].id} overlaps ${crowdedItems[right].id}`);
  }
}

const base = baseLayoutCandidate("alpha");
assert.deepEqual(base, baseLayoutCandidate("alpha"));
assert.notDeepEqual(base, baseLayoutCandidate("beta"));
const cluster = clusterLayoutCandidate("alpha", "product-one", "product");
assert.deepEqual(cluster, clusterLayoutCandidate("alpha", "product-one", "product"));
assert.notDeepEqual(cluster, clusterLayoutCandidate("alpha", "product-two", "product"));

const corrupted = memoryStorage({ [LAYOUT_STORAGE_KEY]: "{invalid" });
const recovered = resolvePersistentLayout(projects, { storage: corrupted });
assert.equal(recovered.positions.size, projects.length);
assert.equal(JSON.parse(corrupted.records.get(LAYOUT_STORAGE_KEY)).version, LAYOUT_VERSION);

process.stdout.write("Persistent deterministic 3D project layout tests passed.\n");

const STOPWORDS = new Set([
  "a", "ao", "aos", "as", "com", "como", "da", "das", "de", "do", "dos", "e", "em", "entre", "foi", "mais", "na", "nas", "no", "nos", "o", "os", "ou", "para", "pela", "pelo", "por", "que", "sem", "uma", "um",
  "and", "are", "for", "from", "has", "into", "its", "not", "the", "this", "to", "was", "were", "with",
  "adicionado", "adicionada", "ajuste", "arquivo", "arquivos", "atualizado", "atualizada", "concluido", "concluida", "corrigido", "corrigida", "criado", "criada", "erros", "implementado", "implementada", "melhoria", "projeto", "sistema", "teste", "testes",
  "added", "after", "call", "change", "changed", "complete", "completed", "configuration", "create", "created", "decisions", "default", "deployed", "details", "error", "errors", "exists", "feature", "file", "files", "fix", "fixed", "found", "function", "gotcha", "how", "implementation", "independent", "it", "key", "line", "memory", "only", "overview", "pattern", "problem", "project", "read", "solution", "summary", "system", "technical", "test", "tests", "testing", "trade", "trade-off", "tube", "type", "update", "updated", "use", "what", "why", "works", "working", "you",
]);

const GENERIC_FILES = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "readme.md", "license", "license.md", ".gitignore", "tsconfig.json", "jsconfig.json",
  "eslint.config.js", "eslint.config.mjs", ".eslintrc", ".eslintrc.json",
  "components.json", "vercel.json", ".vercel", "next.config.js", "next.config.mjs", "next.config.ts",
]);

const CLUSTER_COLORS = ["#4fdbff", "#9b8cff", "#ff5fca", "#ffbd5c", "#69e5b5", "#ff7d7d", "#6fa8ff", "#d58cff", "#8dd9c0", "#f29d62"];
const GENERIC_PROJECT_TOKENS = new Set(["agent", "autoblog", "claude", "lead", "memory", "nextjs", "site", "survey", "template"]);
const TECHNOLOGIES = [
  { label: "Graphify", markers: ["graphify", "knowledge graph", "community detection"] },
  { label: "Memory Gateway / MCP", markers: ["memory gateway", "memory-gateway", "mycelium", "mcp"] },
  { label: "Instagram / Reels", markers: ["instagram", "reels", "reel", "ig-post"] },
  { label: "Supabase", markers: ["supabase", "_shared", "edge function"] },
  { label: "Next.js", markers: ["nextjs", "next.js", "next.config", "app/"] },
  { label: "Bitrix24", markers: ["bitrix24", "bitrix"] },
  { label: "Vercel", markers: ["vercel"] },
  { label: "WhatsApp", markers: ["whatsapp"] },
  { label: "Telegram", markers: ["telegram"] },
  { label: "React", markers: ["react", ".tsx"] },
  { label: "TypeScript", markers: ["typescript", ".ts"] },
  { label: "Node.js", markers: ["node.js", "nodejs"] },
  { label: "Python", markers: ["python", ".py"] },
];

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase("pt-BR");
}

function safeTokens(value) {
  return normalizedText(value)
    .split(/[^\p{Letter}\p{Number}+#.-]+/u)
    .map((token) => token.replace(/^[._-]+|[._-]+$/g, ""))
    .filter((token) => {
      const parts = token.split(/[._-]+/).filter(Boolean);
      return token.length >= 3
        && token.length <= 38
        && !STOPWORDS.has(token)
        && !parts.every((part) => part.length < 3 || STOPWORDS.has(part))
        && !/^(sk|ghp|gho|xox)[-_]/.test(token)
        && !/^\d+$/.test(token);
    });
}

function addWeighted(target, tokens, weight) {
  for (const token of tokens) target.set(token, (target.get(token) ?? 0) + weight);
}

function normalizeFile(value) {
  const clean = String(value ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").toLocaleLowerCase("pt-BR");
  if (!clean) return null;
  if (
    clean.includes("node_modules/")
    || clean.includes("graphify-out/")
    || clean.startsWith(".claude/")
    || clean.startsWith(".codex/")
    || clean.startsWith(".config/")
    || clean.includes("/.claude/")
    || clean.includes("/.codex/")
    || clean.includes("/.config/")
    || /(^|\/)(auth|credentials?|secrets?|private-key)\.json$/.test(clean)
  ) return null;
  const parts = clean.split("/").filter(Boolean);
  const basename = parts.at(-1);
  if (
    !basename
    || GENERIC_FILES.has(basename)
    || basename.startsWith(".env")
    || /^(index|layout|page|route|types?|utils?|config|constants?)\.[a-z0-9]+$/.test(basename)
  ) return null;
  return parts.slice(-2).join("/");
}

function projectFrequency(profiles, channel) {
  const counts = new Map();
  for (const profile of profiles.values()) {
    for (const key of profile[channel].keys()) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function cosine(left, right, documentFrequency, projectCount) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  const contributions = [];
  const weighted = (key, value) => {
    const frequency = documentFrequency.get(key) ?? 1;
    if (frequency > Math.max(2, Math.floor(projectCount * .72))) return 0;
    const idf = Math.log((1 + projectCount) / (1 + frequency)) + 1;
    return value * idf;
  };
  for (const [key, value] of left) {
    const score = weighted(key, value);
    leftMagnitude += score * score;
    if (!right.has(key)) continue;
    const paired = weighted(key, right.get(key));
    const contribution = score * paired;
    dot += contribution;
    contributions.push({ key, contribution });
  }
  for (const [key, value] of right) {
    const score = weighted(key, value);
    rightMagnitude += score * score;
  }
  const score = leftMagnitude && rightMagnitude ? dot / Math.sqrt(leftMagnitude * rightMagnitude) : 0;
  return {
    score: Number(Math.min(1, score).toFixed(4)),
    evidence: contributions.sort((a, b) => b.contribution - a.contribution).slice(0, 4).map(({ key }) => key),
  };
}

function fileEvidence(left, right, documentFrequency, projectCount) {
  const shared = [...left.keys()]
    .filter((file) => right.has(file))
    .map((file) => ({
      file,
      specificity: Math.log((1 + projectCount) / (1 + (documentFrequency.get(file) ?? 1))) / Math.log(1 + projectCount),
    }))
    .filter(({ specificity }) => specificity >= .12)
    .sort((a, b) => b.specificity - a.specificity || a.file.localeCompare(b.file));
  const totalSpecificity = shared.reduce((sum, { specificity }) => sum + specificity, 0);
  return {
    score: Number((1 - Math.exp(-totalSpecificity / 1.2)).toFixed(4)),
    evidence: shared.slice(0, 4).map(({ file }) => file),
  };
}

function makeProfile(project) {
  return { project, files: new Map(), topics: new Map(), decisions: new Map() };
}

function topWeighted(entries, limit = 16) {
  return [...entries.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, weight]) => ({ term, weight: Number(weight.toFixed(3)) }));
}

export function buildSemanticRelations(payload, projectNames, options = {}) {
  const maxNeighbors = options.maxNeighbors ?? 4;
  const minimumScore = options.minimumScore ?? .065;
  const profiles = new Map(projectNames.map((project) => [project, makeProfile(project)]));

  for (const row of payload.project_files ?? []) {
    if (!profiles.has(row.project)) continue;
    const file = normalizeFile(row.file);
    if (file) profiles.get(row.project).files.set(file, 1);
  }

  for (const observation of payload.observations ?? []) {
    const profile = profiles.get(observation.project);
    if (!profile) continue;
    addWeighted(profile.topics, safeTokens(observation.title), 1.15);
    for (const concept of parseJsonArray(observation.concepts)) addWeighted(profile.topics, safeTokens(concept), 2.4);
    if (observation.subtitle) addWeighted(profile.decisions, safeTokens(observation.subtitle), 1);
    if (observation.type === "decision") addWeighted(profile.decisions, safeTokens(observation.title), 1.5);
  }

  const fileFrequency = projectFrequency(profiles, "files");
  const topicFrequency = projectFrequency(profiles, "topics");
  const decisionFrequency = projectFrequency(profiles, "decisions");
  const projectCount = profiles.size;
  const candidates = [];
  const profileList = [...profiles.values()];

  for (let leftIndex = 0; leftIndex < profileList.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < profileList.length; rightIndex += 1) {
      const left = profileList[leftIndex];
      const right = profileList[rightIndex];
      const files = fileEvidence(left.files, right.files, fileFrequency, projectCount);
      const topics = cosine(left.topics, right.topics, topicFrequency, projectCount);
      const decisions = cosine(left.decisions, right.decisions, decisionFrequency, projectCount);
      const score = Number(Math.min(1, files.score * .5 + topics.score * .32 + decisions.score * .18).toFixed(4));
      const hasEvidence = files.evidence.length > 0 || topics.score >= .12 || decisions.score >= .16;
      if (!hasEvidence || score < minimumScore) continue;
      const breakdown = { files: files.score, topics: topics.score, decisions: decisions.score };
      const dominant = Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0][0];
      candidates.push({
        source: left.project,
        target: right.project,
        score,
        dominant,
        confidence: files.evidence.length ? "extracted" : "inferred",
        breakdown,
        evidence: { files: files.evidence, topics: topics.evidence, decisions: decisions.evidence },
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const degree = new Map(projectNames.map((project) => [project, 0]));
  const relations = [];
  for (const relation of candidates) {
    if (degree.get(relation.source) >= maxNeighbors || degree.get(relation.target) >= maxNeighbors) continue;
    relations.push(relation);
    degree.set(relation.source, degree.get(relation.source) + 1);
    degree.set(relation.target, degree.get(relation.target) + 1);
  }

  const projectMetrics = Object.fromEntries(projectNames.map((project) => {
    const connected = relations.filter((relation) => relation.source === project || relation.target === project);
    return [project, {
      connections: connected.length,
      semantic_strength: Number(connected.reduce((sum, relation) => sum + relation.score, 0).toFixed(4)),
    }];
  }));
  const projectSignals = Object.fromEntries(profileList.map((profile) => [profile.project, {
    topics: topWeighted(profile.topics),
    files: [...profile.files.keys()].slice(0, 120),
  }]));

  return {
    relations,
    project_metrics: projectMetrics,
    project_signals: projectSignals,
    metadata: {
      method: "local-deterministic-tfidf-v1",
      sampled_per_project: payload.sampled_per_project ?? null,
      observations_analyzed: payload.observations?.length ?? 0,
      file_references_analyzed: payload.project_files?.length ?? 0,
      relation_count: relations.length,
      connected_projects: Object.values(projectMetrics).filter(({ connections }) => connections > 0).length,
    },
  };
}

function titleCase(value) {
  return String(value).split(/[\s_-]+/).filter(Boolean).map((part) => `${part[0].toLocaleUpperCase("pt-BR")}${part.slice(1)}`).join(" ");
}

function slug(value) {
  return normalizedText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function relationMap(relations) {
  return new Map(relations.map((relation) => [[relation.source, relation.target].sort().join("\u0000"), relation.score]));
}

function clusterCohesion(projects, scores) {
  if (projects.length <= 1) return 0;
  let total = 0;
  let pairs = 0;
  for (let left = 0; left < projects.length; left += 1) {
    for (let right = left + 1; right < projects.length; right += 1) {
      total += scores.get([projects[left], projects[right]].sort().join("\u0000")) ?? 0;
      pairs += 1;
    }
  }
  return Number((total / pairs).toFixed(4));
}

function weightedCommunities(projectNames, relations, resolution = 1.35) {
  const adjacency = new Map(projectNames.map((project) => [project, new Map()]));
  for (const relation of relations) {
    adjacency.get(relation.source)?.set(relation.target, relation.score);
    adjacency.get(relation.target)?.set(relation.source, relation.score);
  }
  const degrees = new Map(projectNames.map((project) => [
    project,
    [...adjacency.get(project).values()].reduce((sum, weight) => sum + weight, 0),
  ]));
  const totalWeight = [...degrees.values()].reduce((sum, degree) => sum + degree, 0);
  const community = new Map(projectNames.map((project) => [project, project]));
  const totals = new Map(projectNames.map((project) => [project, degrees.get(project)]));
  if (!totalWeight) return community;

  for (let iteration = 0; iteration < 24; iteration += 1) {
    let moved = false;
    const ordered = [...projectNames].sort((a, b) => degrees.get(b) - degrees.get(a) || a.localeCompare(b));
    for (const project of ordered) {
      const degree = degrees.get(project);
      if (!degree) continue;
      const current = community.get(project);
      const neighborWeights = new Map();
      for (const [neighbor, weight] of adjacency.get(project)) {
        const neighborCommunity = community.get(neighbor);
        neighborWeights.set(neighborCommunity, (neighborWeights.get(neighborCommunity) ?? 0) + weight);
      }
      totals.set(current, (totals.get(current) ?? 0) - degree);
      let best = current;
      let bestGain = (neighborWeights.get(current) ?? 0) - resolution * degree * (totals.get(current) ?? 0) / totalWeight;
      for (const [candidate, internalWeight] of neighborWeights) {
        const gain = internalWeight - resolution * degree * (totals.get(candidate) ?? 0) / totalWeight;
        if (gain > bestGain + 1e-9 || (Math.abs(gain - bestGain) <= 1e-9 && candidate.localeCompare(best) < 0)) {
          best = candidate;
          bestGain = gain;
        }
      }
      totals.set(best, (totals.get(best) ?? 0) + degree);
      community.set(project, best);
      moved ||= best !== current;
    }
    if (!moved) break;
  }
  return community;
}

function productLabel(projects, graph) {
  if (projects.length === 1) return projects[0];
  const tokenCounts = new Map();
  const tokenOrder = [];
  for (const project of projects) {
    const seen = new Set();
    for (const token of normalizedText(project).split(/[^a-z0-9]+/).filter(Boolean)) {
      if (/^v?\d/.test(token) || GENERIC_PROJECT_TOKENS.has(token) || seen.has(token)) continue;
      seen.add(token);
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
      if (!tokenOrder.includes(token)) tokenOrder.push(token);
    }
  }
  const threshold = Math.max(2, Math.ceil(projects.length * .55));
  const common = tokenOrder.filter((token) => tokenCounts.get(token) >= threshold).slice(0, 2);
  if (common.length) return titleCase(common.join(" "));
  const memberSet = new Set(projects);
  const topicScores = new Map();
  for (const relation of graph.relations) {
    if (!memberSet.has(relation.source) || !memberSet.has(relation.target)) continue;
    for (const term of [...relation.evidence.topics, ...relation.evidence.decisions]) {
      topicScores.set(term, (topicScores.get(term) ?? 0) + relation.score);
    }
  }
  const topics = topWeighted(topicScores, 4).map(({ term }) => term);
  const topicSet = new Set(topics);
  if (topicSet.has("instagram") || topicSet.has("ig-post") || topicSet.has("ig-sentinel") || topicSet.has("sentinel")) return "Instagram Publishing";
  return topics.length ? titleCase(topics.slice(0, 2).join(" ")) : "Comunidade inferida";
}

function stableClusterColor(axis, label) {
  let hash = 2166136261;
  for (const character of `${axis}:${label}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return CLUSTER_COLORS[(hash >>> 0) % CLUSTER_COLORS.length];
}

function projectFamilyKey(project) {
  const suffixes = new Set(["all", "claude", "for", "nextjs", "parceiros", "relatorios", "site", "survey", "template"]);
  const tokens = normalizedText(project)
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !suffixes.has(token) && !/^v?\d/.test(token));
  return tokens.slice(0, 2).join("-");
}

function clientAssignment(project, allProjects) {
  const normalized = normalizedText(project);
  if (normalized.includes("coesa")) return { label: "Coesa", confidence: "inferred", evidence: ["nome do projeto"] };
  if (normalized.includes("gauss")) return { label: "Gauss", confidence: "inferred", evidence: ["nome do projeto"] };
  const prefix = normalized.split(/[^a-z0-9]+/).find(Boolean);
  const repeated = prefix && !GENERIC_PROJECT_TOKENS.has(prefix) && !["social", "acquisition", "ig"].includes(prefix)
    ? allProjects.filter((candidate) => normalizedText(candidate).split(/[^a-z0-9]+/).includes(prefix)).length
    : 0;
  if (repeated >= 2) return { label: titleCase(prefix), confidence: "inferred", evidence: [`namespace ${prefix}`] };
  return { label: "Não identificado", confidence: "ambiguous", evidence: [] };
}

function technologyAssignment(project, graph) {
  const signals = graph.project_signals[project] ?? { topics: [], files: [] };
  const topicText = signals.topics.map(({ term }) => term).join(" ");
  const fileText = signals.files.join(" ");
  const projectText = normalizedText(project);
  const ranked = TECHNOLOGIES.map((technology, priority) => {
    const evidence = [];
    let score = 0;
    for (const marker of technology.markers) {
      const normalizedMarker = normalizedText(marker);
      if (projectText.includes(normalizedMarker)) { score += 4; evidence.push(marker); }
      if (topicText.includes(normalizedMarker)) { score += 2; evidence.push(marker); }
      if (fileText.includes(normalizedMarker)) { score += 1; evidence.push(marker); }
    }
    return { ...technology, priority, score, evidence: [...new Set(evidence)].slice(0, 4) };
  }).sort((a, b) => b.score - a.score || a.priority - b.priority);
  const best = ranked[0];
  return best?.score > 0
    ? { label: best.label, confidence: "inferred", evidence: best.evidence }
    : { label: "Sem tecnologia dominante", confidence: "ambiguous", evidence: [] };
}

function agentAssignment(project) {
  const claude = project.claude_observations ?? 0;
  const codex = project.codex_observations ?? 0;
  const total = claude + codex;
  if (!total) return { label: "Legado / agente não identificado", confidence: "ambiguous", evidence: [] };
  const ratio = codex / total;
  if (ratio >= .7) return { label: "Codex", confidence: "extracted", evidence: [`${Math.round(ratio * 100)}% Codex`] };
  if (ratio <= .3) return { label: "Claude", confidence: "extracted", evidence: [`${Math.round((1 - ratio) * 100)}% Claude`] };
  return { label: "Híbrido Claude + Codex", confidence: "extracted", evidence: [`${Math.round((1 - ratio) * 100)}% / ${Math.round(ratio * 100)}%`] };
}

function facetClusters(axis, assignments, projectDetails, relations) {
  const grouped = new Map();
  for (const project of projectDetails) {
    const assignment = assignments.get(project.project);
    const list = grouped.get(assignment.label) ?? [];
    list.push({ project: project.project, assignment });
    grouped.set(assignment.label, list);
  }
  const scores = relationMap(relations);
  return [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([label, members]) => {
      const projects = members.map(({ project }) => project).sort();
      const confidences = members.map(({ assignment }) => assignment.confidence);
      return {
        id: `${axis}-${slug(label)}`,
        axis,
        label,
        color: stableClusterColor(axis, label),
        projects,
        size: projects.length,
        observations: projectDetails.filter((project) => projects.includes(project.project)).reduce((sum, project) => sum + (project.observations ?? 0), 0),
        cohesion: clusterCohesion(projects, scores),
        confidence: confidences.includes("ambiguous") ? "ambiguous" : confidences.includes("inferred") ? "inferred" : "extracted",
        evidence: [...new Set(members.flatMap(({ assignment }) => assignment.evidence))].slice(0, 5),
      };
    });
}

export function buildAutomaticClusters(graph, projectDetails) {
  const projectNames = projectDetails.map(({ project }) => project);
  const productAssignments = new Map();
  const familyGroups = new Map();
  for (const project of projectNames) {
    const key = projectFamilyKey(project);
    const members = familyGroups.get(key) ?? [];
    members.push(project);
    familyGroups.set(key, members);
  }
  for (const [key, projects] of familyGroups) {
    if (!key || projects.length < 2) continue;
    const label = titleCase(key);
    for (const project of projects) {
      productAssignments.set(project, { label, confidence: "extracted", evidence: [`família nominal ${key}`] });
    }
  }

  const remaining = projectNames.filter((project) => !productAssignments.has(project));
  const remainingRelations = graph.relations.filter((relation) => remaining.includes(relation.source) && remaining.includes(relation.target));
  const community = weightedCommunities(remaining, remainingRelations);
  const communityGroups = new Map();
  for (const project of remaining) {
    const key = community.get(project);
    const members = communityGroups.get(key) ?? [];
    members.push(project);
    communityGroups.set(key, members);
  }
  const scores = relationMap(graph.relations);
  const unresolved = [];
  for (const projects of communityGroups.values()) {
    const cohesion = clusterCohesion(projects, scores);
    if (projects.length >= 2 && cohesion >= .16) {
      const label = productLabel(projects, graph);
      for (const project of projects) {
        productAssignments.set(project, { label, confidence: "inferred", evidence: ["comunidade semântica ponderada"] });
      }
    } else {
      unresolved.push(...projects);
    }
  }
  for (const project of unresolved) {
    productAssignments.set(project, { label: "Sem produto identificado", confidence: "ambiguous", evidence: [] });
  }
  const clientAssignments = new Map(projectNames.map((project) => [project, clientAssignment(project, projectNames)]));
  const technologyAssignments = new Map(projectNames.map((project) => [project, technologyAssignment(project, graph)]));
  const agentAssignments = new Map(projectDetails.map((project) => [project.project, agentAssignment(project)]));
  const assignmentByAxis = {
    product: productAssignments,
    client: clientAssignments,
    technology: technologyAssignments,
    agent: agentAssignments,
  };
  const axes = Object.fromEntries(Object.entries(assignmentByAxis).map(([axis, assignments]) => [
    axis,
    facetClusters(axis, assignments, projectDetails, graph.relations),
  ]));
  const projectMemberships = Object.fromEntries(projectNames.map((project) => [
    project,
    Object.fromEntries(Object.entries(axes).map(([axis, clusters]) => [
      axis,
      clusters.find((cluster) => cluster.projects.includes(project))?.id ?? null,
    ])),
  ]));
  return {
    axes,
    project_memberships: projectMemberships,
    metadata: {
      method: "weighted-louvain-facets-v1",
      cluster_counts: Object.fromEntries(Object.entries(axes).map(([axis, clusters]) => [axis, clusters.length])),
      ambiguous_clients: axes.client.find(({ label }) => label === "Não identificado")?.size ?? 0,
    },
  };
}

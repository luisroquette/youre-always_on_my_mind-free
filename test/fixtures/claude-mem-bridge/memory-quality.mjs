const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)));
const present = (value) => Number(value ?? 0) > 0;

export const QUALITY_METADATA = Object.freeze({
  version: "quality-v1",
  scale: "0-100",
  quality_weights: Object.freeze({
    relevance: 0.30,
    utility: 0.30,
    uniqueness: 0.25,
    freshness: 0.15,
  }),
  semantics: Object.freeze({
    relevance: "Maior é melhor: sinais de consulta, feedback e conteúdo decisório.",
    redundancy: "Maior é pior: repetição exata ou provável dentro do projeto.",
    age: "Maior significa mais antiga; não implica baixa qualidade isoladamente.",
    utility: "Maior é melhor: conteúdo acionável, estruturado e reutilizável.",
    exclusion_risk: "Maior significa mais perigoso apagar.",
    overall: "Maior significa melhor qualidade estimada.",
  }),
});

function labelFor(score) {
  if (score >= 75) return "excelente";
  if (score >= 55) return "sólida";
  if (score >= 35) return "revisar";
  return "fraca";
}

function riskLabel(score) {
  if (score >= 70) return "alto";
  if (score >= 40) return "médio";
  return "baixo";
}

export function scoreMemory(input, nowEpoch = Date.now()) {
  const feedback = {
    useful: Number(input.feedback?.useful ?? 0),
    incorrect: Number(input.feedback?.incorrect ?? 0),
    obsolete: Number(input.feedback?.obsolete ?? 0),
  };
  const relevanceCount = Math.max(0, Number(input.relevance_count ?? 0));
  const titleDuplicates = Math.max(1, Number(input.title_duplicate_count ?? 1));
  const hashDuplicates = Math.max(1, Number(input.content_duplicate_count ?? 1));
  const createdEpoch = Number(input.created_at_epoch ?? Date.parse(input.created_at ?? ""));
  const normalizedEpoch = createdEpoch > 0 && createdEpoch < 10_000_000_000 ? createdEpoch * 1_000 : createdEpoch;
  const ageDays = Number.isFinite(normalizedEpoch)
    ? Math.max(0, Math.floor((nowEpoch - normalizedEpoch) / 86_400_000))
    : 0;

  const age = clamp(100 * (1 - Math.exp(-ageDays / 365)));
  const relevance = clamp(
    20
    + Math.min(36, Math.log1p(relevanceCount) * 18)
    + Math.min(24, feedback.useful * 12)
    + (present(input.decision_length) ? 10 : 0)
    + (present(input.facts_count) ? 6 : 0)
    + (present(input.files_count) ? 4 : 0)
    - (feedback.incorrect * 22)
    - (feedback.obsolete * 28)
  );
  const utility = clamp(
    (present(input.title_length) ? 8 : 0)
    + (present(input.summary_length) ? 18 : 0)
    + (present(input.decision_length) ? 22 : 0)
    + Math.min(20, Number(input.facts_count ?? 0) * 5)
    + Math.min(12, Number(input.concepts_count ?? 0) * 3)
    + Math.min(20, Number(input.files_count ?? 0) * 4)
    + Math.min(16, feedback.useful * 8)
    - (feedback.incorrect * 24)
    - (feedback.obsolete * 30)
  );

  let redundancy = 0;
  if (hashDuplicates > 1) redundancy = Math.min(100, 86 + (hashDuplicates - 2) * 4);
  else if (titleDuplicates > 1) redundancy = Math.min(82, 38 + Math.log2(titleDuplicates) * 14);
  redundancy = clamp(redundancy);

  const uniqueness = 100 - redundancy;
  const freshness = 100 - age;
  const overall = clamp(
    relevance * QUALITY_METADATA.quality_weights.relevance
    + utility * QUALITY_METADATA.quality_weights.utility
    + uniqueness * QUALITY_METADATA.quality_weights.uniqueness
    + freshness * QUALITY_METADATA.quality_weights.freshness
  );
  const exclusionRisk = clamp(
    relevance * 0.35
    + utility * 0.30
    + uniqueness * 0.20
    + freshness * 0.15
    - feedback.incorrect * 12
    - feedback.obsolete * 24
  );
  const confidence = clamp(
    46
    + (relevanceCount > 0 ? 14 : 0)
    + (feedback.useful + feedback.incorrect + feedback.obsolete > 0 ? 18 : 0)
    + (input.content_hash ? 12 : 0)
    + (present(input.summary_length) || present(input.decision_length) ? 10 : 0)
  );

  const evidence = [
    hashDuplicates > 1
      ? `${hashDuplicates} conteúdos idênticos no projeto`
      : titleDuplicates > 1
        ? `${titleDuplicates} títulos iguais no projeto`
        : "sem duplicata detectada no projeto",
    `${ageDays} dia${ageDays === 1 ? "" : "s"} desde a criação`,
    relevanceCount > 0 ? `${relevanceCount} reutilização${relevanceCount === 1 ? "" : "ões"} registrada${relevanceCount === 1 ? "" : "s"}` : "sem reutilização registrada",
    feedback.useful + feedback.incorrect + feedback.obsolete > 0
      ? `feedback: ${feedback.useful} útil, ${feedback.incorrect} incorreto, ${feedback.obsolete} obsoleto`
      : "sem feedback explícito",
  ];

  return {
    overall,
    label: labelFor(overall),
    relevance,
    redundancy,
    age,
    age_days: ageDays,
    utility,
    exclusion_risk: exclusionRisk,
    exclusion_risk_label: riskLabel(exclusionRisk),
    confidence,
    evidence,
    version: QUALITY_METADATA.version,
  };
}

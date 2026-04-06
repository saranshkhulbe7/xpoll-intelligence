import neo4j from "neo4j-driver";
import { config } from "../config";
import { neo4jDriver } from "../db/neo4j";
import { qdrantClient } from "../db/qdrant";
import { openaiClient } from "../openai";
import type { RelationPolarity, SubjectKind } from "../types";
import { acceptsConservativeVectorMatch, inspectConservativeVectorMatch } from "./conceptResolver";
import { buildQueryStorageContract } from "./queryPromptContext";
import { textToVector } from "../utils/embedding";
import { lexicalOverlapRatio, meaningfulTokens } from "../utils/conceptQuality";
import { normalizeText } from "../utils/text";

export type QueryIntentType =
  | "user_summary"
  | "user_concept_summary"
  | "concept_cohort_summary"
  | "user_entity_sentiment"
  | "compare_users_on_concept";

export type QueryRelationFamily = "support" | "preference" | "sentiment" | "uncertainty";
export type QuerySubjectMatchType = "exact" | "alias" | "vector" | "graph_fallback";

export type QueryIntent = {
  supported: boolean;
  intentType: QueryIntentType;
  userRefs: string[];
  conceptRefs: string[];
  cohorts: QueryCohort[];
  relationFamilies: QueryRelationFamily[];
  polarityFilter?: RelationPolarity;
  resultLimit: number;
  needsEvidence: boolean;
  unsupportedReason?: string;
};

export type ParseQueryIntentOptions = {
  skillGuidance?: string;
};

export type QueryCohort = {
  label: string;
  locationRefs: string[];
  genderRefs: string[];
};

export type SubjectSearchHit = {
  canonicalId: string;
  label: string;
  kind: SubjectKind;
  aliases: string[];
  matchType: QuerySubjectMatchType;
  matchScore: number;
  matchedQuery: string;
};

export type ResolvedQueryUser = {
  externalAccountId: string;
  username: string | null;
  googleEmail: string | null;
  emailAuthEmail: string | null;
  twitterUsername: string | null;
  twitterName: string | null;
  matchedRef: string;
  matchScore: number;
};

export type EvidenceSnippet = {
  kind: "first" | "latest";
  voteId: string;
  pollTitle: string | null;
  selectedOption: string | null;
  respondedAt: string | null;
  seenAt: string | null;
  sourcePath: string | null;
  voteType: string | null;
};

export type RetrievedAssertion = {
  assertionSignature: string;
  user: {
    externalAccountId: string;
    username: string | null;
  };
  relationLabel: string;
  relationFamily: string;
  polarity: RelationPolarity;
  target: {
    canonicalId: string;
    label: string;
    kind: SubjectKind;
  };
  aboutTopic: {
    canonicalId: string;
    label: string;
  } | null;
  exactNowIntensity: number;
  confidence: number;
  lastSeenAt: string | null;
  firstSeenVoteId: string | null;
  lastSeenVoteId: string | null;
  evidenceCount: number;
  latestSelectedOption: string | null;
  latestPollTitle: string | null;
  latestVoteType: string | null;
  latestSourcePath: string | null;
  matchedConcept: SubjectSearchHit | null;
  evidence: EvidenceSnippet[];
};

export type QueryResultCluster = {
  queryRef: string | null;
  matchedConcept: SubjectSearchHit | null;
  cohort: QueryCohort | null;
  metrics: QueryClusterMetrics | null;
  assertions: RetrievedAssertion[];
};

export type QueryClusterMetrics = {
  totalUsers: number;
  matchedUsers: number;
  positiveUsers: number;
  negativeUsers: number;
  neutralUsers: number;
  positivePct: number;
  negativePct: number;
  neutralPct: number;
  averageIntensity: number | null;
};

export type VectorSubjectCandidateInspection = SubjectSearchHit & {
  accepted: boolean;
  rejectionReason: "score_below_threshold" | "lexical_overlap_below_threshold" | null;
  threshold: number;
  semanticCoverage: number;
  lexicalOverlap: number;
};

export type GraphConceptCandidate = {
  canonicalId: string;
  label: string;
  kind: SubjectKind;
  topicCanonicalId: string | null;
  assertionCount: number;
  lexicalOverlap: number;
  semanticCoverage: number;
  accepted: boolean;
};

export type ConceptResolutionRootCause =
  | "missing_from_registry"
  | "different_label_or_alias_gap"
  | "vector_too_conservative"
  | "no_candidate_anywhere";

export type ConceptResolutionInspection = {
  query: string;
  normalizedQuery: string;
  allowedKinds: SubjectKind[];
  exactHits: SubjectSearchHit[];
  aliasHits: SubjectSearchHit[];
  vectorAcceptedHits: SubjectSearchHit[];
  vectorCandidates: VectorSubjectCandidateInspection[];
  graphCandidates: GraphConceptCandidate[];
  graphFallbackHits: SubjectSearchHit[];
  rootCause: ConceptResolutionRootCause | null;
};

export type GroundedQueryAnswer = {
  question: string;
  intent: QueryIntent;
  matchedUsers: ResolvedQueryUser[];
  cohorts: QueryCohort[];
  matchedConcepts: Array<{
    query: string;
    hits: SubjectSearchHit[];
  }>;
  clusters: QueryResultCluster[];
  warnings: string[];
  answerText: string;
};

type IntentModelResponse = {
  supported?: boolean;
  intentType?: string;
  userRefs?: string[];
  conceptRefs?: string[];
  cohorts?: Array<{
    label?: string;
    locationRefs?: string[];
    genderRefs?: string[];
  }>;
  relationFamilies?: string[];
  polarityFilter?: string | null;
  resultLimit?: number;
  needsEvidence?: boolean;
  unsupportedReason?: string;
};

type Neo4jRecordLike = {
  get(key: string): unknown;
};

type Neo4jReadTxLike = {
  run(query: string, params?: Record<string, unknown>): Promise<{
    records: Neo4jRecordLike[];
  }>;
};

export type Neo4jReadSessionLike = {
  executeRead<T>(work: (tx: Neo4jReadTxLike) => Promise<T>): Promise<T>;
  close?: () => Promise<void>;
};

const REALTIME_MODEL_PATTERN = /realtime/i;
const QUERY_RELATION_FAMILIES: QueryRelationFamily[] = ["support", "preference", "sentiment", "uncertainty"];
const DEFAULT_RESULT_LIMIT = 5;
const MAX_RESULT_LIMIT = 10;
const DEFAULT_SUBJECT_KINDS: SubjectKind[] = ["topic", "position", "entity"];

const QUERY_INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    supported: { type: "boolean" },
    intentType: { type: "string" },
    userRefs: {
      type: "array",
      items: { type: "string" },
    },
    conceptRefs: {
      type: "array",
      items: { type: "string" },
    },
    cohorts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          locationRefs: {
            type: "array",
            items: { type: "string" },
          },
          genderRefs: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["label", "locationRefs", "genderRefs"],
      },
    },
    relationFamilies: {
      type: "array",
      items: { type: "string" },
    },
    polarityFilter: {
      type: ["string", "null"],
    },
    resultLimit: { type: "number" },
    needsEvidence: { type: "boolean" },
    unsupportedReason: {
      type: ["string", "null"],
    },
  },
  required: [
    "supported",
    "intentType",
    "userRefs",
    "conceptRefs",
    "cohorts",
    "relationFamilies",
    "polarityFilter",
    "resultLimit",
    "needsEvidence",
    "unsupportedReason",
  ],
} as const;

function extractJsonObject(input: string): string {
  const trimmed = input.trim();

  if (trimmed.startsWith("```")) {
    const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeFenceMatch?.[1]) {
      return codeFenceMatch[1].trim();
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Model response did not include a JSON object.");
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

function clampResultLimit(value: unknown, fallback = DEFAULT_RESULT_LIMIT): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.floor(numeric)));
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

const QUERY_TOKEN_SYNONYMS: Record<string, string[]> = {
  renewable: ["renewables", "clean", "green"],
  renewables: ["renewable", "clean", "green"],
  clean: ["renewable", "renewables", "green"],
  green: ["renewable", "renewables", "clean"],
  energy: ["power"],
  power: ["energy"],
};

function semanticCoverage(query: string, candidate: string): number {
  const queryTokens = Array.from(new Set(meaningfulTokens(query)));
  const candidateTokens = new Set(meaningfulTokens(candidate));

  if (queryTokens.length === 0 || candidateTokens.size === 0) {
    return 0;
  }

  let matchedQueryTokens = 0;
  for (const queryToken of queryTokens) {
    const variants = [queryToken, ...(QUERY_TOKEN_SYNONYMS[queryToken] ?? [])];
    if (variants.some((variant) => candidateTokens.has(variant))) {
      matchedQueryTokens += 1;
    }
  }

  return matchedQueryTokens / queryTokens.length;
}

function labelMatchesQueryExactly(label: string, query: string): boolean {
  return normalizeText(label) === normalizeText(query);
}

function normalizeCohorts(value: unknown): QueryCohort[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const label = typeof record.label === "string" && record.label.trim().length > 0
        ? record.label.trim()
        : dedupeStrings([
          ...toStringArray(record.locationRefs),
          ...toStringArray(record.genderRefs),
        ]).join(" ");

      const locationRefs = dedupeStrings(toStringArray(record.locationRefs));
      const genderRefs = dedupeStrings(toStringArray(record.genderRefs));

      if (!label || (locationRefs.length === 0 && genderRefs.length === 0)) {
        return null;
      }

      return {
        label,
        locationRefs,
        genderRefs,
      };
    })
    .filter((entry): entry is QueryCohort => Boolean(entry));
}

function normalizeRelationFamilies(values: unknown): QueryRelationFamily[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return dedupeStrings(values.map(String).map((value) => normalizeText(value))).filter((value): value is QueryRelationFamily =>
    QUERY_RELATION_FAMILIES.includes(value as QueryRelationFamily),
  );
}

function normalizeIntentType(value: unknown): QueryIntentType | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  switch (normalized) {
    case "user_summary":
    case "user_concept_summary":
    case "concept_cohort_summary":
    case "user_entity_sentiment":
    case "compare_users_on_concept":
      return normalized;
    default:
      return null;
  }
}

function normalizePolarityFilter(value: unknown): RelationPolarity | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeText(value);
  if (normalized === "positive" || normalized === "negative" || normalized === "neutral") {
    return normalized;
  }

  return undefined;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function toNumber(value: unknown): number {
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }

  return typeof value === "number" ? value : Number(value ?? 0);
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sanitizeCohortPhrase(value: string): string {
  return value.trim().replace(/\s+users?$/i, "").trim();
}

function heuristicIntentFallback(question: string, limit: number): QueryIntent {
  const normalizedQuestion = question.trim();
  const percentageMatch = normalizedQuestion.match(/^what percentage of\s+(.+?)\s+are\s+(positive|negative|neutral)\s+toward\s+(.+?)(?:\?|$)/i);
  if (percentageMatch) {
    const cohortPhrase = sanitizeCohortPhrase(percentageMatch[1] ?? "cohort");
    const isGenderOnly = /^(male|female|nonbinary)$/i.test(cohortPhrase);
    return {
      supported: true,
      intentType: "concept_cohort_summary",
      userRefs: [],
      conceptRefs: [percentageMatch[3] ?? ""].filter(Boolean),
      cohorts: [{
        label: percentageMatch[1] ?? "cohort",
        locationRefs: isGenderOnly ? [] : [cohortPhrase].filter(Boolean),
        genderRefs: isGenderOnly ? [cohortPhrase] : [],
      }],
      relationFamilies: ["sentiment"],
      polarityFilter: normalizePolarityFilter(percentageMatch[2]),
      resultLimit: clampResultLimit(limit),
      needsEvidence: true,
    };
  }

  const compareCohortsMatch = normalizedQuestion.match(/^compare\s+(.+?)\s+users?\s+on\s+(.+?)(?:\?|$)/i);
  if (compareCohortsMatch) {
    const rawCohorts = (compareCohortsMatch[1] ?? "")
      .split(/\s*,\s*|\s+and\s+/i)
      .map((value) => sanitizeCohortPhrase(value))
      .filter(Boolean);

    if (rawCohorts.length >= 2) {
      return {
        supported: true,
        intentType: "concept_cohort_summary",
        userRefs: [],
        conceptRefs: [compareCohortsMatch[2] ?? ""].filter(Boolean),
      cohorts: rawCohorts.map((value) => ({
        label: `${value} users`,
        locationRefs: /^(male|female|nonbinary)$/i.test(value) ? [] : [value],
        genderRefs: /^(male|female|nonbinary)$/i.test(value) ? [value] : [],
      })),
        relationFamilies: [],
        resultLimit: clampResultLimit(limit),
        needsEvidence: true,
      };
    }
  }

  const compareMatch = normalizedQuestion.match(/^compare\s+(.+?)\s+and\s+(.+?)\s+on\s+(.+?)(?:\?|$)/i);
  if (compareMatch) {
    return {
      supported: true,
      intentType: "compare_users_on_concept",
      userRefs: [compareMatch[1] ?? "", compareMatch[2] ?? ""].filter(Boolean),
      conceptRefs: [compareMatch[3] ?? ""].filter(Boolean),
      cohorts: [],
      relationFamilies: [],
      resultLimit: clampResultLimit(limit),
      needsEvidence: true,
    };
  }

  const strongestViewsMatch = normalizedQuestion.match(/^what are\s+(.+?)'?s\s+strongest\s+current\s+views(?:\?|$)/i);
  if (strongestViewsMatch) {
    return {
      supported: true,
      intentType: "user_summary",
      userRefs: [strongestViewsMatch[1] ?? ""].filter(Boolean),
      conceptRefs: [],
      cohorts: [],
      relationFamilies: [],
      resultLimit: clampResultLimit(limit),
      needsEvidence: true,
    };
  }

  const howFeelMatch = normalizedQuestion.match(/^how does\s+(.+?)\s+feel about\s+(.+?)(?:\?|$)/i);
  if (howFeelMatch) {
    return {
      supported: true,
      intentType: "user_entity_sentiment",
      userRefs: [howFeelMatch[1] ?? ""].filter(Boolean),
      conceptRefs: [howFeelMatch[2] ?? ""].filter(Boolean),
      cohorts: [],
      relationFamilies: ["sentiment"],
      resultLimit: clampResultLimit(limit),
      needsEvidence: true,
    };
  }

  const whoTowardMatch = normalizedQuestion.match(/^who is\s+(positive|negative)\s+toward\s+(.+?)(?:\?|$)/i);
  if (whoTowardMatch) {
    return {
      supported: true,
      intentType: "concept_cohort_summary",
      userRefs: [],
      conceptRefs: [whoTowardMatch[2] ?? ""].filter(Boolean),
      cohorts: [],
      relationFamilies: ["sentiment"],
      polarityFilter: normalizePolarityFilter(whoTowardMatch[1]),
      resultLimit: clampResultLimit(limit),
      needsEvidence: true,
    };
  }

  const usersInLocationMatch = normalizedQuestion.match(/^what do users?\s+in\s+(.+?)\s+think about\s+(.+?)(?:\?|$)/i);
  if (usersInLocationMatch) {
    const locationPhrase = sanitizeCohortPhrase(usersInLocationMatch[1] ?? "");
    return {
      supported: true,
      intentType: "concept_cohort_summary",
      userRefs: [],
      conceptRefs: [usersInLocationMatch[2] ?? ""].filter(Boolean),
      cohorts: [{
        label: `${locationPhrase} users`,
        locationRefs: [locationPhrase].filter(Boolean),
        genderRefs: [],
      }],
      relationFamilies: [],
      resultLimit: clampResultLimit(limit),
      needsEvidence: true,
    };
  }

  const userConceptMatch = normalizedQuestion.match(/^what does\s+(.+?)\s+think about\s+(.+?)(?:\?|$)/i);
  if (userConceptMatch) {
    return {
      supported: true,
      intentType: "user_concept_summary",
      userRefs: [userConceptMatch[1] ?? ""].filter(Boolean),
      conceptRefs: [userConceptMatch[2] ?? ""].filter(Boolean),
      cohorts: [],
      relationFamilies: [],
      resultLimit: clampResultLimit(limit),
      needsEvidence: true,
    };
  }

  return {
    supported: false,
    intentType: "user_summary",
    userRefs: [],
    conceptRefs: [],
    cohorts: [],
    relationFamilies: [],
    resultLimit: clampResultLimit(limit),
    needsEvidence: true,
    unsupportedReason:
      "This question is outside the Phase 1 terminal Graph RAG scope. Try asking about a known user, topic, position, or entity.",
  };
}

export async function parseQueryIntent(
  question: string,
  limit = DEFAULT_RESULT_LIMIT,
  options?: ParseQueryIntentOptions,
): Promise<QueryIntent> {
  const usesRealtimeModel = REALTIME_MODEL_PATTERN.test(config.openai.model);
  const storageContract = buildQueryStorageContract(2500);

  try {
    const response = await openaiClient.responses.create({
      model: config.openai.model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "You classify Graph RAG terminal questions for a semantic graph of users, assertions, topics, positions, and entities.",
                "Return JSON only.",
                "Support only these intent types: user_summary, user_concept_summary, concept_cohort_summary, user_entity_sentiment, compare_users_on_concept.",
                "Set supported=false when the question asks for causality, prediction, policy design, hidden motivations, or anything outside retrieved graph evidence.",
                "user_summary = strongest current assertions for one user.",
                "user_concept_summary = one user's assertions about one concept or issue area.",
                "concept_cohort_summary = what one or more cohorts think about one concept or entity, including cohort comparisons and percentage questions.",
                "user_entity_sentiment = one user's sentiment toward a person or organization.",
                "compare_users_on_concept = compare two named users on one concept.",
                "Extract userRefs exactly as named in the question when present.",
                "Extract conceptRefs as compact phrases that can be used to search the subject registry.",
                "Use cohorts to represent location or gender groups. Each cohort must have a label plus locationRefs and genderRefs arrays.",
                "locationRefs are raw place phrases like India, Texas, Mumbai, USA, or California. Do not try to classify them into city/state/country yourself.",
                "genderRefs are gender phrases like male, female, or nonbinary.",
                "For questions like 'What do users in India think about immigration?' create one cohort for India users.",
                "For questions like 'Compare male and female users on healthcare' create two cohorts, one for male and one for female.",
                "For questions like 'Compare India, USA, and UK users on healthcare' create one cohort per location.",
                "Use relationFamilies only from: support, preference, sentiment, uncertainty.",
                "Use polarityFilter only from: positive, negative, neutral, or null.",
                "Keep resultLimit small and practical for a terminal response.",
                "Set needsEvidence=true unless the question explicitly asks for a terse answer only.",
                storageContract,
                options?.skillGuidance ? `Use this reasoning guidance while classifying the query:\n${options.skillGuidance}` : "",
              ].join(" "),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: question,
            },
          ],
        },
      ],
      ...(usesRealtimeModel
        ? {}
        : {
            text: {
              format: {
                type: "json_schema",
                name: "query_intent",
                strict: true,
                schema: QUERY_INTENT_SCHEMA,
              },
            },
          }),
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error("Query intent model response did not include output_text.");
    }

    const parsed = JSON.parse(usesRealtimeModel ? extractJsonObject(outputText) : outputText) as IntentModelResponse;
    const intentType = normalizeIntentType(parsed.intentType);
    const supported = Boolean(parsed.supported && intentType);

    return {
      supported,
      intentType: intentType ?? "user_summary",
      userRefs: dedupeStrings(toStringArray(parsed.userRefs)),
      conceptRefs: dedupeStrings(toStringArray(parsed.conceptRefs)),
      cohorts: normalizeCohorts(parsed.cohorts),
      relationFamilies: normalizeRelationFamilies(parsed.relationFamilies),
      polarityFilter: normalizePolarityFilter(parsed.polarityFilter),
      resultLimit: clampResultLimit(parsed.resultLimit, limit),
      needsEvidence: parsed.needsEvidence !== false,
      unsupportedReason:
        supported
          ? undefined
          : (typeof parsed.unsupportedReason === "string" && parsed.unsupportedReason.trim().length > 0
              ? parsed.unsupportedReason.trim()
      : "This question is not reliably supported by the current graph query capabilities."),
    };
  } catch {
    return heuristicIntentFallback(question, limit);
  }
}

function kindAllowed(kind: SubjectKind, allowedKinds: SubjectKind[]): boolean {
  return allowedKinds.includes(kind);
}

function subjectHitFromPayload(args: {
  payload: Record<string, unknown>;
  matchedQuery: string;
  matchType: QuerySubjectMatchType;
  matchScore: number;
}): SubjectSearchHit | null {
  const kind = typeof args.payload.subjectKind === "string" ? (args.payload.subjectKind as SubjectKind) : null;
  if (!kind) {
    return null;
  }

  return {
    canonicalId: String(args.payload.canonicalId ?? ""),
    label: String(args.payload.canonicalLabel ?? ""),
    kind,
    aliases: toStringArray(args.payload.aliases),
    matchType: args.matchType,
    matchScore: args.matchScore,
    matchedQuery: args.matchedQuery,
  };
}

type RegistrySearchMode = Exclude<QuerySubjectMatchType, "graph_fallback">;

export async function searchRegistrySubjectsByModeReadOnly(args: {
  query: string;
  mode: RegistrySearchMode;
  limit?: number;
  allowedKinds?: SubjectKind[];
}): Promise<SubjectSearchHit[]> {
  const limit = clampResultLimit(args.limit, 3);
  const allowedKinds = args.allowedKinds && args.allowedKinds.length > 0 ? args.allowedKinds : DEFAULT_SUBJECT_KINDS;
  const normalizedQuery = normalizeText(args.query);

  if (!normalizedQuery) {
    return [];
  }

  try {
    const hits = new Map<string, SubjectSearchHit>();

    if (args.mode === "exact") {
      const exactHits = await qdrantClient.scroll(config.qdrant.registryCollectionName, {
        limit: Math.max(10, limit * 2),
        with_payload: true,
        with_vector: false,
        filter: {
          must: [
            { key: "entryKind", match: { value: "subject" } },
            { key: "normalizedLabel", match: { value: normalizedQuery } },
          ],
        },
      });

      for (const point of exactHits.points) {
        const hit = point.payload ? subjectHitFromPayload({
          payload: point.payload as Record<string, unknown>,
          matchedQuery: args.query,
          matchType: "exact",
          matchScore: 1,
        }) : null;
        if (hit && kindAllowed(hit.kind, allowedKinds)) {
          hits.set(hit.canonicalId, hit);
        }
      }
    }

    if (args.mode === "alias") {
      const aliasHits = await qdrantClient.scroll(config.qdrant.registryCollectionName, {
        limit: Math.max(10, limit * 3),
        with_payload: true,
        with_vector: false,
        filter: {
          must: [{ key: "entryKind", match: { value: "subject" } }],
          should: [{ key: "aliasesNormalized", match: { value: normalizedQuery } }],
        },
      });

      for (const point of aliasHits.points) {
        const hit = point.payload ? subjectHitFromPayload({
          payload: point.payload as Record<string, unknown>,
          matchedQuery: args.query,
          matchType: "alias",
          matchScore: 1,
        }) : null;
        if (hit && kindAllowed(hit.kind, allowedKinds) && !hits.has(hit.canonicalId)) {
          hits.set(hit.canonicalId, hit);
        }
      }
    }

    if (args.mode === "vector") {
      const vector = await textToVector(args.query);
      const vectorHits = await qdrantClient.search(config.qdrant.registryCollectionName, {
        vector,
        limit: Math.max(10, limit * 4),
        with_payload: true,
        filter: {
          must: [{ key: "entryKind", match: { value: "subject" } }],
        },
      });

      for (const point of vectorHits) {
        const payload = point.payload as Record<string, unknown> | undefined;
        if (!payload) {
          continue;
        }

        const hit = subjectHitFromPayload({
          payload,
          matchedQuery: args.query,
          matchType: "vector",
          matchScore: Number(point.score ?? 0),
        });
        if (!hit || !kindAllowed(hit.kind, allowedKinds) || hits.has(hit.canonicalId)) {
          continue;
        }

        if (
          acceptsConservativeVectorMatch({
            kind: hit.kind,
            score: hit.matchScore,
            inputLabel: args.query,
            candidateLabel: hit.label,
            inputAliases: [],
            candidateAliases: hit.aliases,
          })
        ) {
          hits.set(hit.canonicalId, hit);
        }
      }
    }

    return Array.from(hits.values()).slice(0, limit);
  } catch {
    return [];
  }
}

export async function inspectVectorRegistryCandidatesReadOnly(args: {
  query: string;
  limit?: number;
  allowedKinds?: SubjectKind[];
}): Promise<VectorSubjectCandidateInspection[]> {
  const limit = clampResultLimit(args.limit, 3);
  const allowedKinds = args.allowedKinds && args.allowedKinds.length > 0 ? args.allowedKinds : DEFAULT_SUBJECT_KINDS;
  const normalizedQuery = normalizeText(args.query);

  if (!normalizedQuery) {
    return [];
  }

  try {
    const vector = await textToVector(args.query);
    const vectorHits = await qdrantClient.search(config.qdrant.registryCollectionName, {
      vector,
      limit: Math.max(10, limit * 4),
      with_payload: true,
      filter: {
        must: [{ key: "entryKind", match: { value: "subject" } }],
      },
    });

    const candidates = new Map<string, VectorSubjectCandidateInspection>();
    for (const point of vectorHits) {
      const payload = point.payload as Record<string, unknown> | undefined;
      if (!payload) {
        continue;
      }

      const hit = subjectHitFromPayload({
        payload,
        matchedQuery: args.query,
        matchType: "vector",
        matchScore: Number(point.score ?? 0),
      });
      if (!hit || !kindAllowed(hit.kind, allowedKinds) || candidates.has(hit.canonicalId)) {
        continue;
      }

      const inspection = inspectConservativeVectorMatch({
        kind: hit.kind,
        score: hit.matchScore,
        inputLabel: args.query,
        candidateLabel: hit.label,
        inputAliases: [],
        candidateAliases: hit.aliases,
      });

      candidates.set(hit.canonicalId, {
        ...hit,
        accepted: inspection.accepted,
        rejectionReason: inspection.rejectionReason,
        threshold: inspection.threshold,
        semanticCoverage: semanticCoverage(args.query, hit.label),
        lexicalOverlap: lexicalOverlapRatio(args.query, hit.label),
      });
    }

    return Array.from(candidates.values()).sort((left, right) =>
      right.matchScore - left.matchScore
      || right.semanticCoverage - left.semanticCoverage
      || right.lexicalOverlap - left.lexicalOverlap,
    );
  } catch {
    return [];
  }
}

function graphCandidateMatchScore(candidate: GraphConceptCandidate): number {
  return Number((candidate.semanticCoverage + (candidate.lexicalOverlap * 0.1)).toFixed(4));
}

function graphKindRank(kind: SubjectKind): number {
  switch (kind) {
    case "topic":
      return 3;
    case "position":
      return 2;
    case "entity":
      return 1;
    case "ideology":
      return 0;
  }
}

export async function searchGraphConceptCandidatesReadOnly(args: {
  session: Neo4jReadSessionLike;
  query: string;
  limit?: number;
  allowedKinds?: SubjectKind[];
}): Promise<GraphConceptCandidate[]> {
  const limit = clampResultLimit(args.limit, 3);
  const allowedKinds = args.allowedKinds && args.allowedKinds.length > 0 ? args.allowedKinds : DEFAULT_SUBJECT_KINDS;
  const queryNeedles = dedupeStrings(
    meaningfulTokens(args.query).flatMap((token) => [token, ...(QUERY_TOKEN_SYNONYMS[token] ?? [])]),
  );

  if (queryNeedles.length === 0) {
    return [];
  }

  const rows = await args.session.executeRead(async (tx) => {
    const result = await tx.run(
      `
      MATCH (s:Subject)
      WHERE s.kind IN $allowedKinds
        AND any(needle IN $queryNeedles WHERE toLower(coalesce(s.label, "")) CONTAINS needle)
      OPTIONAL MATCH (aTarget:Assertion)-[:TARGETS]->(s)
      WITH s, count(DISTINCT aTarget) AS targetAssertionCount
      OPTIONAL MATCH (aTopic:Assertion)-[:ABOUT]->(s)
      RETURN s.canonicalId AS canonicalId,
             s.label AS label,
             s.kind AS kind,
             s.topicCanonicalId AS topicCanonicalId,
             targetAssertionCount + count(DISTINCT aTopic) AS assertionCount
      LIMIT $candidateLimit
      `,
      {
        allowedKinds,
        queryNeedles,
        candidateLimit: neo4j.int(Math.max(20, limit * 12)),
      },
    );

    return result.records.map((record) => ({
      canonicalId: String(record.get("canonicalId") ?? ""),
      label: String(record.get("label") ?? ""),
      kind: String(record.get("kind") ?? "topic") as SubjectKind,
      topicCanonicalId: toOptionalString(record.get("topicCanonicalId")),
      assertionCount: toNumber(record.get("assertionCount")),
    }));
  });

  return rows
    .map((row) => {
      const candidate: GraphConceptCandidate = {
        canonicalId: row.canonicalId,
        label: row.label,
        kind: row.kind,
        topicCanonicalId: row.topicCanonicalId,
        assertionCount: row.assertionCount,
        lexicalOverlap: lexicalOverlapRatio(args.query, row.label),
        semanticCoverage: semanticCoverage(args.query, row.label),
        accepted: false,
      };

      candidate.accepted = labelMatchesQueryExactly(row.label, args.query)
        || candidate.semanticCoverage >= 0.75
        || candidate.lexicalOverlap >= 0.65;

      return candidate;
    })
    .sort((left, right) =>
      Number(right.accepted) - Number(left.accepted)
      || right.semanticCoverage - left.semanticCoverage
      || right.lexicalOverlap - left.lexicalOverlap
      || right.assertionCount - left.assertionCount
      || graphKindRank(right.kind) - graphKindRank(left.kind),
    );
}

export async function searchGraphFallbackSubjectsReadOnly(args: {
  session: Neo4jReadSessionLike;
  query: string;
  limit?: number;
  allowedKinds?: SubjectKind[];
}): Promise<SubjectSearchHit[]> {
  const limit = clampResultLimit(args.limit, 3);
  const candidates = await searchGraphConceptCandidatesReadOnly(args);

  return candidates
    .filter((candidate) => candidate.accepted)
    .slice(0, limit)
    .map((candidate) => ({
      canonicalId: candidate.canonicalId,
      label: candidate.label,
      kind: candidate.kind,
      aliases: [],
      matchType: "graph_fallback",
      matchScore: graphCandidateMatchScore(candidate),
      matchedQuery: args.query,
    }));
}

export async function searchRegistrySubjectsReadOnly(args: {
  query: string;
  limit?: number;
  allowedKinds?: SubjectKind[];
}): Promise<SubjectSearchHit[]> {
  const exactHits = await searchRegistrySubjectsByModeReadOnly({
    ...args,
    mode: "exact",
  });
  if (exactHits.length > 0) {
    return exactHits;
  }

  const aliasHits = await searchRegistrySubjectsByModeReadOnly({
    ...args,
    mode: "alias",
  });
  if (aliasHits.length > 0) {
    return aliasHits;
  }

  return searchRegistrySubjectsByModeReadOnly({
    ...args,
    mode: "vector",
  });
}

function classifyConceptResolutionRootCause(inspection: {
  query: string;
  exactHits: SubjectSearchHit[];
  aliasHits: SubjectSearchHit[];
  vectorAcceptedHits: SubjectSearchHit[];
  vectorCandidates: VectorSubjectCandidateInspection[];
  graphCandidates: GraphConceptCandidate[];
}): ConceptResolutionRootCause | null {
  const exactHit = inspection.exactHits[0] ?? null;
  const aliasHit = inspection.aliasHits[0] ?? null;
  const vectorAcceptedHit = inspection.vectorAcceptedHits[0] ?? null;
  const graphHit = inspection.graphCandidates.find((candidate) => candidate.accepted) ?? null;
  const vectorTooConservativeCandidate = inspection.vectorCandidates.find((candidate) =>
    !candidate.accepted
    && candidate.rejectionReason === "lexical_overlap_below_threshold"
    && candidate.semanticCoverage >= 0.75,
  );

  if (exactHit && labelMatchesQueryExactly(exactHit.label, inspection.query)) {
    return null;
  }

  if (aliasHit && (labelMatchesQueryExactly(aliasHit.label, inspection.query) || aliasHit.aliases.some((alias) => labelMatchesQueryExactly(alias, inspection.query)))) {
    return null;
  }

  if (vectorAcceptedHit && labelMatchesQueryExactly(vectorAcceptedHit.label, inspection.query)) {
    return null;
  }

  if (vectorAcceptedHit) {
    return "different_label_or_alias_gap";
  }

  if (vectorTooConservativeCandidate) {
    return "vector_too_conservative";
  }

  if (aliasHit || graphHit) {
    if (graphHit && labelMatchesQueryExactly(graphHit.label, inspection.query)) {
      return "missing_from_registry";
    }

    return "different_label_or_alias_gap";
  }

  return "no_candidate_anywhere";
}

export async function inspectConceptResolutionReadOnly(args: {
  session: Neo4jReadSessionLike;
  query: string;
  limit?: number;
  allowedKinds?: SubjectKind[];
}): Promise<ConceptResolutionInspection> {
  const allowedKinds = args.allowedKinds && args.allowedKinds.length > 0 ? args.allowedKinds : DEFAULT_SUBJECT_KINDS;
  const exactHits = await searchRegistrySubjectsByModeReadOnly({
    query: args.query,
    mode: "exact",
    limit: args.limit,
    allowedKinds,
  });
  const aliasHits = await searchRegistrySubjectsByModeReadOnly({
    query: args.query,
    mode: "alias",
    limit: args.limit,
    allowedKinds,
  });
  const vectorAcceptedHits = await searchRegistrySubjectsByModeReadOnly({
    query: args.query,
    mode: "vector",
    limit: args.limit,
    allowedKinds,
  });
  const vectorCandidates = await inspectVectorRegistryCandidatesReadOnly({
    query: args.query,
    limit: args.limit,
    allowedKinds,
  });
  const graphCandidates = await searchGraphConceptCandidatesReadOnly({
    session: args.session,
    query: args.query,
    limit: args.limit,
    allowedKinds,
  });
  const graphFallbackHits = graphCandidates
    .filter((candidate) => candidate.accepted)
    .slice(0, clampResultLimit(args.limit, 3))
    .map((candidate) => ({
      canonicalId: candidate.canonicalId,
      label: candidate.label,
      kind: candidate.kind,
      aliases: [],
      matchType: "graph_fallback" as const,
      matchScore: graphCandidateMatchScore(candidate),
      matchedQuery: args.query,
    }));

  return {
    query: args.query,
    normalizedQuery: normalizeText(args.query),
    allowedKinds,
    exactHits,
    aliasHits,
    vectorAcceptedHits,
    vectorCandidates,
    graphCandidates,
    graphFallbackHits,
    rootCause: classifyConceptResolutionRootCause({
      query: args.query,
      exactHits,
      aliasHits,
      vectorAcceptedHits,
      vectorCandidates,
      graphCandidates,
    }),
  };
}

export async function inspectConceptResolution(args: {
  query: string;
  limit?: number;
  allowedKinds?: SubjectKind[];
}): Promise<ConceptResolutionInspection> {
  const session = neo4jDriver.session({ database: config.neo4j.database });

  try {
    return await inspectConceptResolutionReadOnly({
      session,
      query: args.query,
      limit: args.limit,
      allowedKinds: args.allowedKinds,
    });
  } finally {
    await session.close();
  }
}

function normalizedUserTokens(user: {
  externalAccountId: string;
  username: string | null;
  googleEmail: string | null;
  emailAuthEmail: string | null;
  twitterUsername: string | null;
  twitterName: string | null;
}): string[] {
  const emailLocals = [user.googleEmail, user.emailAuthEmail]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.split("@")[0] ?? value);

  return dedupeStrings([
    user.externalAccountId,
    user.username ?? "",
    user.twitterUsername ?? "",
    user.twitterName ?? "",
    ...emailLocals,
  ]).map((value) => normalizeText(value));
}

function scoreUserMatch(ref: string, user: {
  externalAccountId: string;
  username: string | null;
  googleEmail: string | null;
  emailAuthEmail: string | null;
  twitterUsername: string | null;
  twitterName: string | null;
}): number {
  const normalizedRef = normalizeText(ref);
  if (!normalizedRef) {
    return 0;
  }

  const tokens = normalizedUserTokens(user);
  if (tokens.some((token) => token === normalizedRef)) {
    return 1;
  }

  if (tokens.some((token) => token.includes(normalizedRef) || normalizedRef.includes(token))) {
    return 0.8;
  }

  const refParts = normalizedRef.split(" ").filter(Boolean);
  if (refParts.length > 1 && tokens.some((token) => refParts.every((part) => token.includes(part)))) {
    return 0.7;
  }

  return 0;
}

export async function resolveQueryUsersReadOnly(args: {
  session: Neo4jReadSessionLike;
  userRefs: string[];
}): Promise<ResolvedQueryUser[]> {
  if (args.userRefs.length === 0) {
    return [];
  }

  const users = await args.session.executeRead(async (tx) => {
    const result = await tx.run(
      `
      MATCH (u:User)
      RETURN u.externalAccountId AS externalAccountId,
             u.username AS username,
             u.googleEmail AS googleEmail,
             u.emailAuthEmail AS emailAuthEmail,
             u.twitterUsername AS twitterUsername,
             u.twitterName AS twitterName
      `,
    );

    return result.records.map((record) => ({
      externalAccountId: String(record.get("externalAccountId") ?? ""),
      username: toOptionalString(record.get("username")),
      googleEmail: toOptionalString(record.get("googleEmail")),
      emailAuthEmail: toOptionalString(record.get("emailAuthEmail")),
      twitterUsername: toOptionalString(record.get("twitterUsername")),
      twitterName: toOptionalString(record.get("twitterName")),
    }));
  });

  const resolved = new Map<string, ResolvedQueryUser>();

  for (const ref of args.userRefs) {
    let bestMatch: (typeof users)[number] | null = null;
    let bestScore = 0;

    for (const user of users) {
      const score = scoreUserMatch(ref, user);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = user;
      }
    }

    if (!bestMatch || bestScore <= 0) {
      continue;
    }

    const existing = resolved.get(bestMatch.externalAccountId);
    if (!existing || bestScore > existing.matchScore) {
      resolved.set(bestMatch.externalAccountId, {
        ...bestMatch,
        matchedRef: ref,
        matchScore: bestScore,
      });
    }
  }

  return Array.from(resolved.values());
}

function normalizeCohortParams(cohort: QueryCohort | null | undefined): {
  locationRefs: string[];
  locationRefsLower: string[];
  genderRefs: string[];
  genderRefsLower: string[];
} {
  const locationRefs = dedupeStrings((cohort?.locationRefs ?? []).map(normalizeText).filter(Boolean));
  const genderRefs = dedupeStrings((cohort?.genderRefs ?? []).map(normalizeText).filter(Boolean));

  return {
    locationRefs,
    locationRefsLower: dedupeStrings((cohort?.locationRefs ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean)),
    genderRefs,
    genderRefsLower: dedupeStrings((cohort?.genderRefs ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean)),
  };
}

const COHORT_FILTER_CYPHER = `
  AND (
    size($cohortLocationRefs) = 0 OR
    EXISTS {
      MATCH (u)-[:IN_COUNTRY]->(country:Country)
      WHERE country.normalizedName IN $cohortLocationRefs
    } OR
    EXISTS {
      MATCH (u)-[:IN_STATE]->(state:State)
      WHERE state.normalizedName IN $cohortLocationRefs
    } OR
    EXISTS {
      MATCH (u)-[:IN_CITY]->(city:City)
      WHERE city.normalizedName IN $cohortLocationRefs
    } OR
    toLower(coalesce(u.country, "")) IN $cohortLocationRefsLower OR
    toLower(coalesce(u.state, "")) IN $cohortLocationRefsLower OR
    toLower(coalesce(u.city, "")) IN $cohortLocationRefsLower
  )
  AND (
    size($cohortGenderRefs) = 0 OR
    EXISTS {
      MATCH (u)-[:HAS_GENDER]->(gender:Gender)
      WHERE gender.normalizedName IN $cohortGenderRefs
    } OR
    toLower(coalesce(u.gender, "")) IN $cohortGenderRefsLower
  )
`;

export async function countCohortUsersReadOnly(args: {
  session: Neo4jReadSessionLike;
  cohort: QueryCohort | null;
  userIds?: string[];
}): Promise<number> {
  const cohortParams = normalizeCohortParams(args.cohort);

  return args.session.executeRead(async (tx) => {
    const result = await tx.run(
      `
      MATCH (u:User)
      WHERE (size($userIds) = 0 OR u.externalAccountId IN $userIds)
      ${COHORT_FILTER_CYPHER}
      RETURN count(DISTINCT u) AS totalUsers
      `,
      {
        userIds: args.userIds ?? [],
        cohortLocationRefs: cohortParams.locationRefs,
        cohortLocationRefsLower: cohortParams.locationRefsLower,
        cohortGenderRefs: cohortParams.genderRefs,
        cohortGenderRefsLower: cohortParams.genderRefsLower,
      },
    );

    return toNumber(result.records[0]?.get("totalUsers"));
  });
}

export async function fetchClusterMetricsReadOnly(args: {
  session: Neo4jReadSessionLike;
  candidate: SubjectSearchHit | null;
  cohort: QueryCohort | null;
  userIds: string[];
  relationFamilies: QueryRelationFamily[];
  polarityFilter?: RelationPolarity;
}): Promise<QueryClusterMetrics> {
  const totalUsers = await countCohortUsersReadOnly({
    session: args.session,
    cohort: args.cohort,
    userIds: args.userIds,
  });

  if (totalUsers === 0) {
    return {
      totalUsers: 0,
      matchedUsers: 0,
      positiveUsers: 0,
      negativeUsers: 0,
      neutralUsers: 0,
      positivePct: 0,
      negativePct: 0,
      neutralPct: 0,
      averageIntensity: null,
    };
  }

  const cohortParams = normalizeCohortParams(args.cohort);
  const nowIso = new Date().toISOString();

  return args.session.executeRead(async (tx) => {
    const result = await tx.run(
      `
      WITH datetime($nowIso) AS now,
           log(2.0) / ($halfLifeDays * 86400.0) AS lambda,
           $suppression AS suppression
      MATCH (u:User)-[:MADE_ASSERTION]->(a:Assertion)-[:TARGETS]->(target:Subject)
      OPTIONAL MATCH (a)-[:ABOUT]->(topic:Topic)
      OPTIONAL MATCH (opp:Assertion {assertionGroupKey: a.assertionGroupKey})
      WITH u, a, target, topic, [candidate IN collect(opp) WHERE candidate IS NOT NULL AND candidate.polarity <> a.polarity][0] AS opp,
           now, lambda, suppression
      WHERE (size($userIds) = 0 OR u.externalAccountId IN $userIds)
        AND (size($relationFamilies) = 0 OR a.relationFamily IN $relationFamilies)
        AND ($polarityFilter IS NULL OR a.polarity = $polarityFilter)
        AND (
          $candidateId IS NULL OR
          ($candidateKind = "topic" AND (topic.canonicalId = $candidateId OR target.topicCanonicalId = $candidateId)) OR
          ($candidateKind <> "topic" AND target.canonicalId = $candidateId)
        )
        ${COHORT_FILTER_CYPHER}
      WITH u, a, opp, suppression,
           CASE
             WHEN a.lastIntensityDecayAt IS NULL THEN coalesce(a.intensityMass, 0.0)
             ELSE coalesce(a.intensityMass, 0.0) * exp(-lambda * duration.between(datetime(a.lastIntensityDecayAt), now).seconds)
           END AS ownMassNow,
           CASE
             WHEN opp IS NULL OR opp.lastIntensityDecayAt IS NULL THEN coalesce(opp.intensityMass, 0.0)
             ELSE coalesce(opp.intensityMass, 0.0) * exp(-lambda * duration.between(datetime(opp.lastIntensityDecayAt), now).seconds)
           END AS oppositeMassNow
      WITH u, a,
           1 - exp(
             -CASE
               WHEN ownMassNow - suppression * oppositeMassNow < 0.0 THEN 0.0
               ELSE ownMassNow - suppression * oppositeMassNow
             END
           ) AS exactNowIntensity
      ORDER BY u.externalAccountId, exactNowIntensity DESC, coalesce(a.confidence, 0.0) DESC, coalesce(a.lastSeenAt, "") DESC
      WITH u, collect({polarity: a.polarity, intensity: exactNowIntensity})[0] AS strongest
      RETURN count(DISTINCT u) AS matchedUsers,
             count(DISTINCT CASE WHEN strongest.polarity = 'positive' THEN u END) AS positiveUsers,
             count(DISTINCT CASE WHEN strongest.polarity = 'negative' THEN u END) AS negativeUsers,
             count(DISTINCT CASE WHEN strongest.polarity = 'neutral' THEN u END) AS neutralUsers,
             avg(strongest.intensity) AS averageIntensity
      `,
      {
        nowIso,
        halfLifeDays: config.intensity.halfLifeDays,
        suppression: config.intensity.oppositeSuppression,
        userIds: args.userIds,
        relationFamilies: args.relationFamilies,
        polarityFilter: args.polarityFilter ?? null,
        candidateId: args.candidate?.canonicalId ?? null,
        candidateKind: args.candidate?.kind ?? null,
        cohortLocationRefs: cohortParams.locationRefs,
        cohortLocationRefsLower: cohortParams.locationRefsLower,
        cohortGenderRefs: cohortParams.genderRefs,
        cohortGenderRefsLower: cohortParams.genderRefsLower,
      },
    );

    const matchedUsers = toNumber(result.records[0]?.get("matchedUsers"));
    const positiveUsers = toNumber(result.records[0]?.get("positiveUsers"));
    const negativeUsers = toNumber(result.records[0]?.get("negativeUsers"));
    const neutralUsers = toNumber(result.records[0]?.get("neutralUsers"));
    const averageIntensityRaw = result.records[0]?.get("averageIntensity");
    const averageIntensity = averageIntensityRaw === null || averageIntensityRaw === undefined
      ? null
      : toNumber(averageIntensityRaw);

    return {
      totalUsers,
      matchedUsers,
      positiveUsers,
      negativeUsers,
      neutralUsers,
      positivePct: totalUsers > 0 ? (positiveUsers / totalUsers) * 100 : 0,
      negativePct: totalUsers > 0 ? (negativeUsers / totalUsers) * 100 : 0,
      neutralPct: totalUsers > 0 ? (neutralUsers / totalUsers) * 100 : 0,
      averageIntensity,
    };
  });
}

export async function fetchAssertionsReadOnly(args: {
  session: Neo4jReadSessionLike;
  candidate: SubjectSearchHit | null;
  cohort?: QueryCohort | null;
  userIds: string[];
  relationFamilies: QueryRelationFamily[];
  polarityFilter?: RelationPolarity;
  limit: number;
}): Promise<RetrievedAssertion[]> {
  const nowIso = new Date().toISOString();
  const resultLimit = clampResultLimit(args.limit);
  const cohortParams = normalizeCohortParams(args.cohort);

  return args.session.executeRead(async (tx) => {
    const result = await tx.run(
      `
      WITH datetime($nowIso) AS now,
           log(2.0) / ($halfLifeDays * 86400.0) AS lambda,
           $suppression AS suppression
      MATCH (u:User)-[:MADE_ASSERTION]->(a:Assertion)-[:TARGETS]->(target:Subject)
      OPTIONAL MATCH (a)-[:ABOUT]->(topic:Topic)
      OPTIONAL MATCH (opp:Assertion {assertionGroupKey: a.assertionGroupKey})
      WITH u, a, target, topic, [candidate IN collect(opp) WHERE candidate IS NOT NULL AND candidate.polarity <> a.polarity][0] AS opp,
           now, lambda, suppression
      WHERE (size($userIds) = 0 OR u.externalAccountId IN $userIds)
        AND (size($relationFamilies) = 0 OR a.relationFamily IN $relationFamilies)
        AND ($polarityFilter IS NULL OR a.polarity = $polarityFilter)
        AND (
          $candidateId IS NULL OR
          ($candidateKind = "topic" AND (topic.canonicalId = $candidateId OR target.topicCanonicalId = $candidateId)) OR
          ($candidateKind <> "topic" AND target.canonicalId = $candidateId)
        )
        ${COHORT_FILTER_CYPHER}
      WITH u, a, target, topic, opp, suppression,
           CASE
             WHEN a.lastIntensityDecayAt IS NULL THEN coalesce(a.intensityMass, 0.0)
             ELSE coalesce(a.intensityMass, 0.0) * exp(-lambda * duration.between(datetime(a.lastIntensityDecayAt), now).seconds)
           END AS ownMassNow,
           CASE
             WHEN opp IS NULL OR opp.lastIntensityDecayAt IS NULL THEN coalesce(opp.intensityMass, 0.0)
             ELSE coalesce(opp.intensityMass, 0.0) * exp(-lambda * duration.between(datetime(opp.lastIntensityDecayAt), now).seconds)
           END AS oppositeMassNow
      WITH u, a, target, topic, suppression,
           1 - exp(
             -CASE
               WHEN ownMassNow - suppression * oppositeMassNow < 0.0 THEN 0.0
               ELSE ownMassNow - suppression * oppositeMassNow
             END
           ) AS exactNowIntensity
      RETURN u.externalAccountId AS externalAccountId,
             u.username AS username,
             a.assertionSignature AS assertionSignature,
             a.relationLabel AS relationLabel,
             a.relationFamily AS relationFamily,
             a.polarity AS polarity,
             target.canonicalId AS targetCanonicalId,
             target.label AS targetLabel,
             target.kind AS targetKind,
             topic.canonicalId AS topicCanonicalId,
             topic.label AS topicLabel,
             exactNowIntensity AS exactNowIntensity,
             coalesce(a.confidence, 0.0) AS confidence,
             a.lastSeenAt AS lastSeenAt,
             a.firstSeenVoteId AS firstSeenVoteId,
             a.lastSeenVoteId AS lastSeenVoteId,
             coalesce(a.evidenceCount, 0) AS evidenceCount,
             a.latestSelectedOption AS latestSelectedOption,
             a.latestPollTitle AS latestPollTitle,
             a.latestVoteType AS latestVoteType,
             a.latestSourcePath AS latestSourcePath
      ORDER BY exactNowIntensity DESC, confidence DESC, coalesce(a.lastSeenAt, "") DESC
      LIMIT $limit
      `,
      {
        nowIso,
        halfLifeDays: config.intensity.halfLifeDays,
        suppression: config.intensity.oppositeSuppression,
        userIds: args.userIds,
        relationFamilies: args.relationFamilies,
        polarityFilter: args.polarityFilter ?? null,
        candidateId: args.candidate?.canonicalId ?? null,
        candidateKind: args.candidate?.kind ?? null,
        cohortLocationRefs: cohortParams.locationRefs,
        cohortLocationRefsLower: cohortParams.locationRefsLower,
        cohortGenderRefs: cohortParams.genderRefs,
        cohortGenderRefsLower: cohortParams.genderRefsLower,
        limit: neo4j.int(resultLimit),
      },
    );

    return result.records.map((record) => ({
      assertionSignature: String(record.get("assertionSignature") ?? ""),
      user: {
        externalAccountId: String(record.get("externalAccountId") ?? ""),
        username: toOptionalString(record.get("username")),
      },
      relationLabel: String(record.get("relationLabel") ?? ""),
      relationFamily: String(record.get("relationFamily") ?? ""),
      polarity: (String(record.get("polarity") ?? "neutral") as RelationPolarity),
      target: {
        canonicalId: String(record.get("targetCanonicalId") ?? ""),
        label: String(record.get("targetLabel") ?? ""),
        kind: (String(record.get("targetKind") ?? "topic") as SubjectKind),
      },
      aboutTopic: record.get("topicCanonicalId")
        ? {
            canonicalId: String(record.get("topicCanonicalId") ?? ""),
            label: String(record.get("topicLabel") ?? ""),
          }
        : null,
      exactNowIntensity: toNumber(record.get("exactNowIntensity")),
      confidence: toNumber(record.get("confidence")),
      lastSeenAt: toOptionalString(record.get("lastSeenAt")),
      firstSeenVoteId: toOptionalString(record.get("firstSeenVoteId")),
      lastSeenVoteId: toOptionalString(record.get("lastSeenVoteId")),
      evidenceCount: toNumber(record.get("evidenceCount")),
      latestSelectedOption: toOptionalString(record.get("latestSelectedOption")),
      latestPollTitle: toOptionalString(record.get("latestPollTitle")),
      latestVoteType: toOptionalString(record.get("latestVoteType")),
      latestSourcePath: toOptionalString(record.get("latestSourcePath")),
      matchedConcept: args.candidate,
      evidence: [],
    }));
  });
}

async function fetchEvidencePayloadByVoteId(voteId: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await qdrantClient.scroll(config.qdrant.progressCollectionName, {
      limit: 20,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [{ key: "voteId", match: { value: voteId } }],
      },
    });

    if (result.points.length === 0) {
      return null;
    }

    const sorted = result.points
      .map((point) => point.payload as Record<string, unknown> | undefined)
      .filter((payload): payload is Record<string, unknown> => Boolean(payload))
      .sort((left, right) => {
        const leftFinal = left.finalStatus === "done" ? 1 : 0;
        const rightFinal = right.finalStatus === "done" ? 1 : 0;
        if (leftFinal !== rightFinal) {
          return rightFinal - leftFinal;
        }

        const leftUpdated = Date.parse(String(left.lastUpdatedAt ?? ""));
        const rightUpdated = Date.parse(String(right.lastUpdatedAt ?? ""));
        return rightUpdated - leftUpdated;
      });

    return sorted[0] ?? null;
  } catch {
    return null;
  }
}

function buildEvidenceSnippet(args: {
  kind: "first" | "latest";
  voteId: string;
  payload: Record<string, unknown> | null;
  assertion: RetrievedAssertion;
}): EvidenceSnippet {
  const rawEvidence = args.payload?.rawEvidence as Record<string, unknown> | undefined;
  const voteTimestamps = rawEvidence?.voteTimestamps as Record<string, unknown> | undefined;
  const poll = rawEvidence?.poll as Record<string, unknown> | undefined;

  return {
    kind: args.kind,
    voteId: args.voteId,
    pollTitle:
      (typeof poll?.title === "string" ? poll.title : undefined)
      ?? args.assertion.latestPollTitle,
    selectedOption:
      (typeof rawEvidence?.selectedOption === "string" ? rawEvidence.selectedOption : undefined)
      ?? args.assertion.latestSelectedOption,
    respondedAt: typeof voteTimestamps?.respondedAt === "string" ? voteTimestamps.respondedAt : null,
    seenAt: typeof voteTimestamps?.seenAt === "string" ? voteTimestamps.seenAt : null,
    sourcePath: typeof args.payload?.sourcePath === "string" ? args.payload.sourcePath : args.assertion.latestSourcePath,
    voteType:
      (typeof rawEvidence?.voteType === "string" ? rawEvidence.voteType : undefined)
      ?? args.assertion.latestVoteType,
  };
}

export async function attachEvidenceSnippets(
  clusters: QueryResultCluster[],
): Promise<QueryResultCluster[]> {
  const uniqueVoteIds = dedupeStrings(
    clusters.flatMap((cluster) =>
      cluster.assertions.flatMap((assertion) =>
        dedupeStrings([assertion.firstSeenVoteId ?? "", assertion.lastSeenVoteId ?? ""]).filter(Boolean),
      ),
    ),
  );

  const payloadEntries = await Promise.all(
    uniqueVoteIds.map(async (voteId) => [voteId, await fetchEvidencePayloadByVoteId(voteId)] as const),
  );
  const payloadByVoteId = new Map(payloadEntries);

  return clusters.map((cluster) => ({
    ...cluster,
    assertions: cluster.assertions.map((assertion) => {
      const firstVoteId = assertion.firstSeenVoteId;
      const lastVoteId = assertion.lastSeenVoteId;
      const snippets: EvidenceSnippet[] = [];

      if (firstVoteId) {
        snippets.push(buildEvidenceSnippet({
          kind: "first",
          voteId: firstVoteId,
          payload: payloadByVoteId.get(firstVoteId) ?? null,
          assertion,
        }));
      }

      if (lastVoteId && lastVoteId !== firstVoteId) {
        snippets.push(buildEvidenceSnippet({
          kind: "latest",
          voteId: lastVoteId,
          payload: payloadByVoteId.get(lastVoteId) ?? null,
          assertion,
        }));
      }

      return {
        ...assertion,
        evidence: snippets,
      };
    }),
  }));
}

function buildUnsupportedAnswer(question: string, intent: QueryIntent): GroundedQueryAnswer {
  return {
    question,
    intent,
    matchedUsers: [],
    cohorts: intent.cohorts,
    matchedConcepts: [],
    clusters: [],
    warnings: [],
    answerText: intent.unsupportedReason
      ?? "This question is not reliably supported by the current Phase 1 terminal Graph RAG flow.",
  };
}

function formatAssertionLine(assertion: RetrievedAssertion): string {
  const topicPart = assertion.aboutTopic ? ` about ${assertion.aboutTopic.label}` : "";
  return `- ${assertion.user.username ?? assertion.user.externalAccountId} ${assertion.relationLabel} ${assertion.target.label}${topicPart} (intensity ${assertion.exactNowIntensity.toFixed(2)}, confidence ${assertion.confidence.toFixed(2)})`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildClusterLabel(cluster: QueryResultCluster): string {
  const labelParts = [cluster.cohort?.label, cluster.matchedConcept?.label].filter(Boolean);
  return labelParts.length > 0 ? labelParts.join(" | ") : "the retrieved result set";
}

function formatMatchTypeLabel(matchType: QuerySubjectMatchType): string {
  if (matchType === "graph_fallback") {
    return "graph fallback";
  }

  return matchType;
}

function isConceptResolutionBlocked(answer: GroundedQueryAnswer): boolean {
  return answer.intent.conceptRefs.length > 0
    && answer.matchedConcepts.length > 0
    && answer.matchedConcepts.every((concept) => concept.hits.length === 0);
}

function buildVerboseReport(answer: GroundedQueryAnswer): string[] {
  const clusterCount = answer.clusters.length;
  const assertionCount = answer.clusters.reduce((sum, cluster) => sum + cluster.assertions.length, 0);
  const evidenceCount = answer.clusters.reduce(
    (sum, cluster) => sum + cluster.assertions.filter((assertion) => assertion.evidence.length > 0).length,
    0,
  );

  if (clusterCount === 0) {
    if (isConceptResolutionBlocked(answer)) {
      return [
        "- Retrieval coverage: No concept cluster was resolved, so graph assertions and cohort metrics were not retrieved for this query.",
        "- Main blocker: The requested concept could not be matched to a known subject through registry lookup or graph fallback search.",
        answer.warnings.length > 0
          ? `- Caveats: ${answer.warnings.join(" ")}`
          : "- Caveats: No additional warnings were raised, but concept resolution failed before evidence-backed retrieval could begin.",
      ];
    }

    return [
      "- Retrieval coverage: No concept clusters or assertion-backed results were retrieved for this query.",
      answer.warnings.length > 0
        ? `- Caveats: ${answer.warnings.join(" ")}`
        : "- Caveats: No additional warnings were raised, but the graph did not surface enough linked evidence to answer confidently.",
    ];
  }

  const report: string[] = [
    `- Retrieval coverage: The query matched ${pluralize(clusterCount, "concept cluster")}, produced ${pluralize(assertionCount, "assertion")}, and attached evidence to ${pluralize(evidenceCount, "assertion")}.`,
  ];

  const firstCluster = answer.clusters[0];
  if (firstCluster?.matchedConcept) {
    const conceptPrefix = firstCluster.cohort ? `${firstCluster.cohort.label} -> ` : "";
    report.push(
      `- Main match: The leading cluster is ${conceptPrefix}${firstCluster.matchedConcept.label}, classified as ${firstCluster.matchedConcept.kind} via ${formatMatchTypeLabel(firstCluster.matchedConcept.matchType)} matching.`,
    );
  }

  const metricClusters = answer.clusters.filter((cluster) => cluster.metrics);
  if (metricClusters.length > 0) {
    for (const cluster of metricClusters.slice(0, 2)) {
      const metrics = cluster.metrics!;
      report.push(
        `- Cohort readout: For ${buildClusterLabel(cluster)}, ${metrics.matchedUsers} of ${metrics.totalUsers} users matched the current filter. The distribution is ${metrics.positivePct.toFixed(1)}% positive, ${metrics.negativePct.toFixed(1)}% negative, and ${metrics.neutralPct.toFixed(1)}% neutral${metrics.averageIntensity === null ? "." : `, with an average current intensity of ${metrics.averageIntensity.toFixed(2)}.`}`,
      );
    }
  } else if (assertionCount > 0) {
    const topAssertion = answer.clusters
      .flatMap((cluster) => cluster.assertions)
      .sort((left, right) => right.exactNowIntensity - left.exactNowIntensity)[0];
    if (topAssertion) {
      report.push(
        `- Strongest signal: The highest-intensity retrieved stance is ${topAssertion.user.username ?? topAssertion.user.externalAccountId} ${topAssertion.relationLabel} ${topAssertion.target.label}${topAssertion.aboutTopic ? ` about ${topAssertion.aboutTopic.label}` : ""}, with intensity ${topAssertion.exactNowIntensity.toFixed(2)} and confidence ${topAssertion.confidence.toFixed(2)}.`,
      );
    }
  }

  if (answer.warnings.length > 0) {
    report.push(`- Caveats: ${answer.warnings.join(" ")}`);
  } else {
    report.push("- Caveats: No retrieval warnings were raised for this answer.");
  }

  return report;
}

export function renderDeterministicAnswer(answer: GroundedQueryAnswer): string {
  if (!answer.intent.supported) {
    return answer.answerText;
  }

  if (answer.clusters.length === 0) {
    const conceptResolutionBlocked = isConceptResolutionBlocked(answer);
    const lines = [conceptResolutionBlocked
      ? "The query could not be answered because the concept did not resolve to a known subject in the registry or graph fallback search."
      : (answer.warnings.includes("The user and concept matched separately, but no assertion links them in the current graph.")
          ? "The user and concept matched, but no connecting assertions were found in the current graph."
          : "No strong matching assertions were found for that query.")];

    if (conceptResolutionBlocked && answer.intent.cohorts.length > 0) {
      lines.push("Graph metrics and cohort comparison were skipped because concept resolution failed before graph retrieval.");
    }

    if (answer.warnings.length > 0) {
      lines.push("", "Warnings:");
      for (const warning of answer.warnings) {
        lines.push(`- ${warning}`);
      }
    }

    lines.push("", "Verbose Report:");
    lines.push(...buildVerboseReport(answer));

    return lines.join("\n");
  }

  const lines: string[] = [];

  for (const cluster of answer.clusters) {
    if (cluster.cohort) {
      lines.push(`Cohort: ${cluster.cohort.label}`);
    }

    if (cluster.matchedConcept) {
      lines.push(
        `Concept cluster: ${cluster.matchedConcept.label} (${cluster.matchedConcept.kind}, ${formatMatchTypeLabel(cluster.matchedConcept.matchType)})`,
      );
    }

    if (cluster.metrics) {
      lines.push(
        `  Metrics: total ${cluster.metrics.totalUsers}, matched ${cluster.metrics.matchedUsers}, positive ${cluster.metrics.positivePct.toFixed(1)}%, negative ${cluster.metrics.negativePct.toFixed(1)}%, neutral ${cluster.metrics.neutralPct.toFixed(1)}%${cluster.metrics.averageIntensity === null ? "" : `, avg intensity ${cluster.metrics.averageIntensity.toFixed(2)}`}`,
      );
    }

    for (const assertion of cluster.assertions) {
      lines.push(formatAssertionLine(assertion));
      for (const snippet of assertion.evidence) {
        lines.push(
          `  ${snippet.kind === "first" ? "First" : "Latest"} evidence: ${snippet.voteId} | ${snippet.pollTitle ?? "Unknown poll"} | ${snippet.selectedOption ?? "Unknown option"}${snippet.respondedAt ? ` | ${snippet.respondedAt}` : ""}`,
        );
      }
    }

    lines.push("");
  }

  if (answer.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of answer.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push("", "Verbose Report:");
  lines.push(...buildVerboseReport(answer));

  return lines.join("\n").trim();
}

async function synthesizeGroundedAnswer(answer: GroundedQueryAnswer): Promise<string> {
  const usesRealtimeModel = REALTIME_MODEL_PATTERN.test(config.openai.model);
  const storageContract = buildQueryStorageContract(2000);

  const response = await openaiClient.responses.create({
    model: config.openai.model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "You answer terminal Graph RAG queries from a retrieved assertion payload.",
              "Stay strictly within the retrieved evidence.",
              "Do not invent facts, hidden motivations, or unified concepts that are not explicitly retrieved.",
              "If multiple nearby concept clusters are present, mention that they are related but not fully unified in the current graph.",
              "If a user and concept matched but no linking assertions were retrieved, say that explicitly.",
              "Keep the answer concise and terminal-friendly.",
              "After the short answer, include a compact evidence section with bullet points.",
              "Always end with a 'Verbose Report' section of 3-6 bullets.",
              "Each bullet in 'Verbose Report' must be a full sentence that explains retrieval coverage, the most relevant cluster or cohort metrics, notable retrieved signals, and any warnings or caveats.",
              "Do not use a 'Summary' heading.",
              storageContract,
            ].join(" "),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(
              {
                question: answer.question,
                intent: answer.intent,
                matchedUsers: answer.matchedUsers,
                matchedConcepts: answer.matchedConcepts,
                clusters: answer.clusters,
                warnings: answer.warnings,
              },
              null,
              2,
            ),
          },
        ],
      },
    ],
    ...(usesRealtimeModel ? {} : { max_output_tokens: 700 }),
  });

  const outputText = response.output_text?.trim();
  if (!outputText) {
    throw new Error("Query answer synthesis did not return output_text.");
  }

  return outputText;
}

function allowedKindsForIntent(intent: QueryIntent): SubjectKind[] {
  if (intent.intentType === "user_entity_sentiment") {
    return ["entity"];
  }

  return DEFAULT_SUBJECT_KINDS;
}

export async function runTerminalGraphQuery(args: {
  question: string;
  limit?: number;
}): Promise<GroundedQueryAnswer> {
  const limit = clampResultLimit(args.limit);
  const intent = await parseQueryIntent(args.question, limit);
  if (!intent.supported) {
    return buildUnsupportedAnswer(args.question, intent);
  }

  const session = neo4jDriver.session({ database: config.neo4j.database });

  try {
    const matchedUsers = await resolveQueryUsersReadOnly({
      session,
      userRefs: intent.userRefs,
    });

    const matchedConcepts = await Promise.all(
      intent.conceptRefs.map(async (query) => ({
        query,
        hits: await (async () => {
          const allowedKinds = allowedKindsForIntent(intent);
          const exactHits = await searchRegistrySubjectsByModeReadOnly({
            query,
            mode: "exact",
            limit: 3,
            allowedKinds,
          });
          if (exactHits.length > 0) {
            return exactHits;
          }

          const aliasHits = await searchRegistrySubjectsByModeReadOnly({
            query,
            mode: "alias",
            limit: 3,
            allowedKinds,
          });
          if (aliasHits.length > 0) {
            return aliasHits;
          }

          const vectorHits = await searchRegistrySubjectsByModeReadOnly({
            query,
            mode: "vector",
            limit: 3,
            allowedKinds,
          });
          if (vectorHits.length > 0) {
            return vectorHits;
          }

          return searchGraphFallbackSubjectsReadOnly({
            session,
            query,
            limit: 3,
            allowedKinds,
          });
        })(),
      })),
    );

    const warnings = buildWarnings({
      intent,
      matchedUsers,
      matchedConcepts,
    });
    const conceptResolutionBlocked = intent.conceptRefs.length > 0
      && matchedConcepts.length > 0
      && matchedConcepts.every((concept) => concept.hits.length === 0);

    if (
      ["user_summary", "user_concept_summary", "user_entity_sentiment", "compare_users_on_concept"].includes(intent.intentType)
      && matchedUsers.length === 0
    ) {
      return {
        question: args.question,
        intent,
        matchedUsers,
        cohorts: intent.cohorts,
        matchedConcepts,
        clusters: [],
        warnings,
        answerText: renderDeterministicAnswer({
          question: args.question,
          intent,
          matchedUsers,
          cohorts: intent.cohorts,
          matchedConcepts,
          clusters: [],
          warnings,
          answerText: "",
        }),
      };
    }

    if (conceptResolutionBlocked) {
      return {
        question: args.question,
        intent,
        matchedUsers,
        cohorts: intent.cohorts,
        matchedConcepts,
        clusters: [],
        warnings,
        answerText: renderDeterministicAnswer({
          question: args.question,
          intent,
          matchedUsers,
          cohorts: intent.cohorts,
          matchedConcepts,
          clusters: [],
          warnings,
          answerText: "",
        }),
      };
    }

    const userIds = matchedUsers.map((user) => user.externalAccountId);
    const clusters: QueryResultCluster[] = [];

    if (intent.intentType === "user_summary") {
      const assertions = await fetchAssertionsReadOnly({
        session,
        candidate: null,
        cohort: null,
        userIds,
        relationFamilies: intent.relationFamilies,
        polarityFilter: intent.polarityFilter,
        limit: intent.resultLimit,
      });
      clusters.push({
        queryRef: null,
        matchedConcept: null,
        cohort: null,
        metrics: null,
        assertions,
      });
    } else {
      const activeCohorts = intent.cohorts.length > 0 ? intent.cohorts : [null];

      for (const concept of matchedConcepts) {
        for (const hit of concept.hits) {
          for (const cohort of activeCohorts) {
            const assertions = await fetchAssertionsReadOnly({
              session,
              candidate: hit,
              cohort,
              userIds: intent.intentType === "concept_cohort_summary" ? [] : userIds,
              relationFamilies: intent.relationFamilies,
              polarityFilter: intent.polarityFilter,
              limit: intent.resultLimit,
            });

            const metrics = await fetchClusterMetricsReadOnly({
              session,
              candidate: hit,
              cohort,
              userIds: intent.intentType === "concept_cohort_summary" ? [] : userIds,
              relationFamilies: intent.relationFamilies,
              polarityFilter: intent.polarityFilter,
            });

            if (assertions.length > 0 || metrics.totalUsers > 0) {
              clusters.push({
                queryRef: concept.query,
                matchedConcept: hit,
                cohort,
                metrics,
                assertions,
              });
            }
          }
        }
      }
    }

    const clustersWithEvidence = intent.needsEvidence && clusters.some((cluster) => cluster.assertions.length > 0)
      ? await attachEvidenceSnippets(clusters)
      : clusters;
    const postWarnings = buildWarnings({
      intent,
      matchedUsers,
      matchedConcepts,
      clusters: clustersWithEvidence,
    });
    const baseAnswer: GroundedQueryAnswer = {
      question: args.question,
      intent,
      matchedUsers,
      cohorts: intent.cohorts,
      matchedConcepts,
      clusters: clustersWithEvidence,
      warnings: Array.from(new Set([...warnings, ...postWarnings])),
      answerText: "",
    };

    try {
      const answerText = await synthesizeGroundedAnswer(baseAnswer);
      return {
        ...baseAnswer,
        answerText,
      };
    } catch {
      return {
        ...baseAnswer,
        answerText: renderDeterministicAnswer(baseAnswer),
      };
    }
  } finally {
    await session.close();
  }
}

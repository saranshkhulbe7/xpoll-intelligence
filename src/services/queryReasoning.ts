import neo4j from "neo4j-driver";
import { config } from "../config";
import { neo4jDriver } from "../db/neo4j";
import { openaiClient } from "../openai";
import type { RelationPolarity } from "../types";
import {
  attachEvidenceSnippets,
  fetchAssertionsReadOnly,
  fetchClusterMetricsReadOnly,
  parseQueryIntent,
  renderDeterministicAnswer,
  resolveQueryUsersReadOnly,
  searchGraphFallbackSubjectsReadOnly,
  searchRegistrySubjectsByModeReadOnly,
  type GroundedQueryAnswer,
  type Neo4jReadSessionLike,
  type QueryClusterMetrics,
  type QueryCohort,
  type QueryIntent,
  type QueryIntentType,
  type QueryRelationFamily,
  type QueryResultCluster,
  type ResolvedQueryUser,
  type SubjectSearchHit,
} from "./queryRag";
import { buildQueryStorageContract } from "./queryPromptContext";
import { buildQuerySkillGuidance, routeQueryReasoningSkills, type QuerySkillName } from "./querySkillPrompts";

export type ReasoningAction =
  | "classify_question"
  | "resolve_users"
  | "resolve_cohorts"
  | "search_registry_exact"
  | "search_registry_alias"
  | "search_registry_vector"
  | "search_graph_fallback"
  | "query_graph_assertions"
  | "query_graph_metrics"
  | "fetch_qdrant_evidence"
  | "reflect_on_gaps"
  | "revise_plan"
  | "finalize_answer"
  | "return_unsupported";

export type ReasoningPhase = "planning" | "retrieval" | "reflection" | "answer";

export type ReasoningBudget = {
  maxSteps: number;
  maxLlmCalls: number;
  maxGraphQueries: number;
  maxVectorQueries: number;
  maxEvidenceFetchRounds: number;
};

export type ReasoningBudgetUsed = {
  steps: number;
  llmCalls: number;
  graphQueries: number;
  vectorQueries: number;
  evidenceFetchRounds: number;
};

export type ReasoningBudgetSnapshot = {
  remainingSteps: number;
  remainingLlmCalls: number;
  remainingGraphQueries: number;
  remainingVectorQueries: number;
  remainingEvidenceFetchRounds: number;
};

export type ReasoningStep = {
  stepNumber: number;
  phase: ReasoningPhase;
  technique: string;
  reason: string;
  action: ReasoningAction;
  actionArgs: Record<string, unknown>;
  observationSummary: string;
  observationData: Record<string, unknown> | string | null;
  nextStepNeeded: boolean;
  isRevision?: boolean;
  revisesStep?: number;
  branchId?: string;
  confidence?: number | null;
  budgetSnapshot: ReasoningBudgetSnapshot;
  promptPreview?: string | null;
};

export type QueryTraceOptions = {
  enabled?: boolean;
  json?: boolean;
  showPrompts?: boolean;
  onStep?: (step: ReasoningStep) => void;
};

export type ReasoningDrivenQueryAnswer = GroundedQueryAnswer & {
  reasoningTrace: ReasoningStep[];
  budgetUsed: ReasoningBudgetUsed;
  finalConfidence: number;
  terminationReason: string;
};

type SearchMode = "exact" | "alias" | "vector" | "graph_fallback";
type ReflectionGapType = "exact_miss" | "alias_miss" | "metrics_reflection";

type ReflectionModelResponse = {
  technique?: string;
  reason?: string;
  recommendedAction?: string;
  actionArgs?: Record<string, unknown>;
  confidence?: number;
  unsupportedReason?: string | null;
};

type ConceptResolutionState = {
  query: string;
  attempts: SearchMode[];
  hitsByMode: Partial<Record<SearchMode, SubjectSearchHit[]>>;
  latestMode: SearchMode | null;
  reflectedExactMiss: boolean;
  reflectedAliasMiss: boolean;
};

type ReasoningState = {
  question: string;
  limit: number;
  trace: ReasoningStep[];
  budget: ReasoningBudget;
  used: ReasoningBudgetUsed;
  intent: QueryIntent | null;
  matchedUsers: ResolvedQueryUser[];
  usersResolved: boolean;
  conceptStates: Map<string, ConceptResolutionState>;
  clusters: QueryResultCluster[];
  cohortsResolved: boolean;
  metricsLoaded: boolean;
  assertionsLoaded: boolean;
  evidenceAttached: boolean;
  secondOrderReflectionDone: boolean;
  answerText: string;
  warnings: string[];
  terminationReason: string | null;
  finalConfidence: number;
  nextActionHint: ReasoningAction | null;
  nextActionArgsHint: Record<string, unknown> | null;
  unsupportedReason: string | null;
};

const REALTIME_MODEL_PATTERN = /realtime/i;
const DEFAULT_BUDGET: ReasoningBudget = {
  maxSteps: 12,
  maxLlmCalls: 5,
  maxGraphQueries: 5,
  maxVectorQueries: 5,
  maxEvidenceFetchRounds: 3,
};

const REASONING_ACTIONS: ReasoningAction[] = [
  "classify_question",
  "resolve_users",
  "resolve_cohorts",
  "search_registry_exact",
  "search_registry_alias",
  "search_registry_vector",
  "search_graph_fallback",
  "query_graph_assertions",
  "query_graph_metrics",
  "fetch_qdrant_evidence",
  "reflect_on_gaps",
  "revise_plan",
  "finalize_answer",
  "return_unsupported",
];
const TERMINAL_ACTIONS = new Set<ReasoningAction>(["finalize_answer", "return_unsupported"]);
const GAP_ACTION_POLICY: Record<ReflectionGapType, readonly ReasoningAction[]> = {
  exact_miss: ["search_registry_alias", "search_registry_vector", "finalize_answer", "return_unsupported"],
  alias_miss: ["search_registry_vector", "finalize_answer", "return_unsupported"],
  metrics_reflection: ["finalize_answer", "revise_plan"],
};

const ZERO_LINK_WARNING = "The user and concept matched separately, but no assertion links them in the current graph.";
const REFLECTION_ACTION_ARGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: ["string", "null"],
    },
    note: {
      type: ["string", "null"],
    },
  },
  required: ["query", "note"],
} as const;

const REFLECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    technique: { type: "string" },
    reason: { type: "string" },
    recommendedAction: { type: "string" },
    actionArgs: REFLECTION_ACTION_ARGS_SCHEMA,
    confidence: { type: "number" },
    unsupportedReason: {
      type: ["string", "null"],
    },
  },
  required: ["technique", "reason", "recommendedAction", "actionArgs", "confidence", "unsupportedReason"],
} as const;

function createBudgetSnapshot(state: ReasoningState): ReasoningBudgetSnapshot {
  return {
    remainingSteps: Math.max(0, state.budget.maxSteps - state.used.steps),
    remainingLlmCalls: Math.max(0, state.budget.maxLlmCalls - state.used.llmCalls),
    remainingGraphQueries: Math.max(0, state.budget.maxGraphQueries - state.used.graphQueries),
    remainingVectorQueries: Math.max(0, state.budget.maxVectorQueries - state.used.vectorQueries),
    remainingEvidenceFetchRounds: Math.max(0, state.budget.maxEvidenceFetchRounds - state.used.evidenceFetchRounds),
  };
}

function addWarning(state: ReasoningState, warning: string): void {
  if (!warning.trim()) {
    return;
  }

  state.warnings = Array.from(new Set([...state.warnings, warning]));
}

function parseJsonObject(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("```")) {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return fenced[1].trim();
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Model response did not include a JSON object.");
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function isTerminalAction(action: ReasoningAction): boolean {
  return TERMINAL_ACTIONS.has(action);
}

function getReflectionGapType(value: unknown): ReflectionGapType | null {
  if (value === "exact_miss" || value === "alias_miss" || value === "metrics_reflection") {
    return value;
  }

  return null;
}

function matchedConceptsFromState(state: ReasoningState): Array<{ query: string; hits: SubjectSearchHit[] }> {
  return Array.from(state.conceptStates.values()).map((concept) => {
    const hits = concept.latestMode ? concept.hitsByMode[concept.latestMode] ?? [] : [];
    return {
      query: concept.query,
      hits,
    };
  });
}

function selectedHitsForConcept(conceptState: ConceptResolutionState): SubjectSearchHit[] {
  if (conceptState.latestMode) {
    return conceptState.hitsByMode[conceptState.latestMode] ?? [];
  }

  return [];
}

function countRetrievedAssertions(clusters: QueryResultCluster[]): number {
  return clusters.reduce((sum, cluster) => sum + cluster.assertions.length, 0);
}

function countEvidenceBearingAssertions(clusters: QueryResultCluster[]): number {
  return clusters.reduce(
    (sum, cluster) => sum + cluster.assertions.filter((assertion) => assertion.evidence.length > 0).length,
    0,
  );
}

function buildClusterKey(args: {
  queryRef: string | null;
  matchedConcept: SubjectSearchHit | null;
  cohort: QueryCohort | null;
}): string {
  return [
    args.queryRef ?? "",
    args.matchedConcept?.canonicalId ?? "",
    args.cohort?.label ?? "",
  ].join("::");
}

function hasAnyClusterMetrics(clusters: QueryResultCluster[]): boolean {
  return clusters.some((cluster) => (cluster.metrics?.totalUsers ?? 0) > 0);
}

function allConceptLookupsExhausted(state: ReasoningState): boolean {
  if ((state.intent?.conceptRefs.length ?? 0) === 0) {
    return false;
  }

  return Array.from(state.conceptStates.values()).every((conceptState) =>
    conceptState.attempts.includes("exact")
    && conceptState.reflectedExactMiss
    && conceptState.attempts.includes("alias")
    && conceptState.attempts.includes("vector")
    && conceptState.attempts.includes("graph_fallback"),
  );
}

function hasCompleteCohortPayload(state: ReasoningState): boolean {
  if (!requiresMetrics(state.intent) || !state.metricsLoaded || !state.assertionsLoaded) {
    return false;
  }

  const requestedCohorts = state.intent?.cohorts ?? [];
  const metricsClusters = state.clusters.filter((cluster) => (cluster.metrics?.totalUsers ?? 0) > 0);
  if (metricsClusters.length === 0) {
    return false;
  }

  if (requestedCohorts.length > 0) {
    const seenCohorts = new Set(metricsClusters.map((cluster) => cluster.cohort?.label ?? ""));
    if (requestedCohorts.some((cohort) => !seenCohorts.has(cohort.label))) {
      return false;
    }
  }

  if (countRetrievedAssertions(state.clusters) > 0 && state.intent?.needsEvidence && !state.evidenceAttached) {
    return false;
  }

  return true;
}

function normalizeReflectionActionArgs(actionArgs: Record<string, unknown> | undefined): Record<string, unknown> {
  const query = typeof actionArgs?.query === "string" && actionArgs.query.trim().length > 0 ? actionArgs.query.trim() : undefined;
  const note = typeof actionArgs?.note === "string" && actionArgs.note.trim().length > 0 ? actionArgs.note.trim() : undefined;
  return {
    ...(query ? { query } : {}),
    ...(note ? { note } : {}),
  };
}

function withReflectionNote(actionArgs: Record<string, unknown>, note: string): Record<string, unknown> {
  const existingNote = typeof actionArgs.note === "string" && actionArgs.note.trim().length > 0
    ? actionArgs.note.trim()
    : null;

  return {
    ...actionArgs,
    note: existingNote ? `${existingNote}; ${note}` : note,
  };
}

function defaultActionForGap(gapType: ReflectionGapType, query?: string): {
  action: ReasoningAction;
  actionArgs: Record<string, unknown>;
} {
  if (gapType === "exact_miss") {
    return {
      action: "search_registry_alias",
      actionArgs: {
        ...(query ? { query } : {}),
        note: "normalized_after_exact_miss",
      },
    };
  }

  if (gapType === "alias_miss") {
    return {
      action: "search_registry_vector",
      actionArgs: {
        ...(query ? { query } : {}),
        note: "normalized_after_alias_miss",
      },
    };
  }

  return {
    action: "finalize_answer",
    actionArgs: {
      note: "normalized_after_metrics_reflection",
    },
  };
}

function summarizeReflectionState(state: ReasoningState): Record<string, unknown> {
  const clusters = state.clusters.map((cluster) => ({
    queryRef: cluster.queryRef,
    concept: cluster.matchedConcept?.label ?? null,
    conceptCanonicalId: cluster.matchedConcept?.canonicalId ?? null,
    cohort: cluster.cohort?.label ?? null,
    assertionCount: cluster.assertions.length,
    evidenceCount: cluster.assertions.filter((assertion) => assertion.evidence.length > 0).length,
    metrics: cluster.metrics
      ? {
          totalUsers: cluster.metrics.totalUsers,
          matchedUsers: cluster.metrics.matchedUsers,
          positivePct: cluster.metrics.positivePct,
          negativePct: cluster.metrics.negativePct,
          neutralPct: cluster.metrics.neutralPct,
          averageIntensity: cluster.metrics.averageIntensity,
        }
      : null,
  }));

  return {
    metricsLoaded: state.metricsLoaded,
    assertionsLoaded: state.assertionsLoaded,
    evidenceAttached: state.evidenceAttached,
    clusterCount: state.clusters.length,
    assertionCount: countRetrievedAssertions(state.clusters),
    evidenceCount: countEvidenceBearingAssertions(state.clusters),
    clusters,
  };
}

function normalizeReflectionRecommendation(args: {
  state: ReasoningState;
  step: ReturnType<typeof chooseNextAction>;
  reflection: ReflectionModelResponse;
  recommendedAction: ReasoningAction | null;
}): {
  recommendedAction: ReasoningAction | null;
  actionArgs: Record<string, unknown>;
  normalizationWarning: string | null;
  rawRecommendedAction: string | null;
} {
  const rawRecommendedAction = typeof args.reflection.recommendedAction === "string"
    ? args.reflection.recommendedAction
    : null;
  const gapType = getReflectionGapType(args.step.actionArgs.gapType);
  const query = typeof args.step.actionArgs.query === "string" ? args.step.actionArgs.query : undefined;
  const actionArgs = normalizeReflectionActionArgs(args.reflection.actionArgs);

  if (!gapType) {
    return {
      recommendedAction: args.recommendedAction,
      actionArgs,
      normalizationWarning: null,
      rawRecommendedAction,
    };
  }

  if (args.recommendedAction && GAP_ACTION_POLICY[gapType].includes(args.recommendedAction)) {
    const normalizedArgs = query && (args.recommendedAction === "search_registry_alias" || args.recommendedAction === "search_registry_vector")
      ? { query, ...actionArgs }
      : actionArgs;
    return {
      recommendedAction: args.recommendedAction,
      actionArgs: normalizedArgs,
      normalizationWarning: null,
      rawRecommendedAction,
    };
  }

  const fallback = defaultActionForGap(gapType, query);
  return {
    recommendedAction: fallback.action,
    actionArgs: withReflectionNote(
      {
        ...(fallback.actionArgs.query ? { query: fallback.actionArgs.query } : {}),
        ...actionArgs,
      },
      `normalized_invalid_${gapType}`,
    ),
    normalizationWarning: `Reflection recommended ${rawRecommendedAction ?? "no next action"}, but the controller normalized it to ${fallback.action} for ${gapType}.`,
    rawRecommendedAction,
  };
}

function buildFinalizeReason(state: ReasoningState): string {
  const matchedConcepts = matchedConceptsFromState(state);
  const assertionCount = countRetrievedAssertions(state.clusters);
  const evidenceCount = countEvidenceBearingAssertions(state.clusters);

  if (state.intent?.conceptRefs.length && allConceptLookupsExhausted(state) && matchedConcepts.every((concept) => concept.hits.length === 0)) {
    return "Concept lookup is exhausted and no matching concept was found in the registry or graph fallback search.";
  }

  if (
    state.intent?.userRefs.length
    && state.intent.conceptRefs.length > 0
    && state.matchedUsers.length > 0
    && matchedConcepts.some((concept) => concept.hits.length > 0)
    && assertionCount === 0
  ) {
    return "The user and concept matched, but the graph contains no connecting assertions.";
  }

  if (assertionCount === 0 && hasAnyClusterMetrics(state.clusters)) {
    return "Metrics were gathered, but no representative assertions were retrieved.";
  }

  if (assertionCount === 0) {
    return "Graph retrieval finished without matching assertions.";
  }

  if (assertionCount > 0 && evidenceCount === 0) {
    return "Assertions were retrieved, but no raw evidence snippets were attached.";
  }

  if (hasCompleteCohortPayload(state)) {
    return "Metrics, representative assertions, and evidence are available to finalize the comparison.";
  }

  return "Enough retrieved evidence is available to finalize the answer.";
}

function buildDeterministicReflectionFallback(args: {
  state: ReasoningState;
  step: ReturnType<typeof chooseNextAction>;
  error: unknown;
}): ReflectionModelResponse & { warning: string } {
  const query = typeof args.step.actionArgs.query === "string" ? args.step.actionArgs.query : undefined;
  const gapType = typeof args.step.actionArgs.gapType === "string" ? args.step.actionArgs.gapType : undefined;
  const errorMessage = args.error instanceof Error ? args.error.message : String(args.error);

  if (gapType === "exact_miss" && query) {
    return {
      technique: "sequential-thinking",
      reason: "The reflection step failed, so the agent is falling back to the deterministic exact-to-alias escalation rule.",
      recommendedAction: "search_registry_alias",
      actionArgs: { query, note: "deterministic_fallback_after_exact_miss" },
      confidence: 0.55,
      unsupportedReason: null,
      warning: `Reflection step failed (${errorMessage}); used deterministic fallback to alias search.`,
    };
  }

  if (gapType === "alias_miss" && query) {
    return {
      technique: "sequential-thinking",
      reason: "The reflection step failed, so the agent is falling back to the deterministic alias-to-vector escalation rule.",
      recommendedAction: "search_registry_vector",
      actionArgs: { query, note: "deterministic_fallback_after_alias_miss" },
      confidence: 0.55,
      unsupportedReason: null,
      warning: `Reflection step failed (${errorMessage}); used deterministic fallback to vector search.`,
    };
  }

  return {
    technique: "sequential-thinking",
    reason: "The reflection step failed, so the agent is finalizing with the best retrieved data instead of crashing.",
    recommendedAction: "finalize_answer",
    actionArgs: { note: "deterministic_finalize_after_reflection_failure" },
    confidence: 0.5,
    unsupportedReason: null,
    warning: `Reflection step failed (${errorMessage}); finalized with the best retrieved data instead.`,
  };
}

function allowedKindsForIntent(intent: QueryIntent): SubjectSearchHit["kind"][] {
  if (intent.intentType === "user_entity_sentiment") {
    return ["entity"];
  }

  return ["topic", "position", "entity"];
}

function requiresMetrics(intent: QueryIntent | null): boolean {
  return intent?.intentType === "concept_cohort_summary";
}

function normalizeBudget(overrides?: Partial<ReasoningBudget>): ReasoningBudget {
  return {
    maxSteps: Math.max(1, Math.floor(overrides?.maxSteps ?? DEFAULT_BUDGET.maxSteps)),
    maxLlmCalls: Math.max(1, Math.floor(overrides?.maxLlmCalls ?? DEFAULT_BUDGET.maxLlmCalls)),
    maxGraphQueries: Math.max(1, Math.floor(overrides?.maxGraphQueries ?? DEFAULT_BUDGET.maxGraphQueries)),
    maxVectorQueries: Math.max(1, Math.floor(overrides?.maxVectorQueries ?? DEFAULT_BUDGET.maxVectorQueries)),
    maxEvidenceFetchRounds: Math.max(1, Math.floor(overrides?.maxEvidenceFetchRounds ?? DEFAULT_BUDGET.maxEvidenceFetchRounds)),
  };
}

function initializeState(args: {
  question: string;
  limit: number;
  budget?: Partial<ReasoningBudget>;
}): ReasoningState {
  return {
    question: args.question,
    limit: args.limit,
    trace: [],
    budget: normalizeBudget(args.budget),
    used: {
      steps: 0,
      llmCalls: 0,
      graphQueries: 0,
      vectorQueries: 0,
      evidenceFetchRounds: 0,
    },
    intent: null,
    matchedUsers: [],
    usersResolved: false,
    conceptStates: new Map<string, ConceptResolutionState>(),
    clusters: [],
    cohortsResolved: false,
    metricsLoaded: false,
    assertionsLoaded: false,
    evidenceAttached: false,
    secondOrderReflectionDone: false,
    answerText: "",
    warnings: [],
    terminationReason: null,
    finalConfidence: 0,
    nextActionHint: null,
    nextActionArgsHint: null,
    unsupportedReason: null,
  };
}

function summariseMatchedUsers(users: ResolvedQueryUser[]): string {
  if (users.length === 0) {
    return "No graph users matched.";
  }

  return `Matched ${users.length} user(s): ${users.map((user) => user.username ?? user.externalAccountId).join(", ")}.`;
}

function summariseConceptHits(query: string, mode: SearchMode, hits: SubjectSearchHit[]): string {
  const modeLabel = mode === "graph_fallback" ? "graph fallback" : mode;
  if (hits.length === 0) {
    return `No ${modeLabel} concept hits for "${query}".`;
  }

  return `Found ${hits.length} ${modeLabel} concept hit(s) for "${query}": ${hits.map((hit) => hit.label).join(", ")}.`;
}

function buildWarnings(args: {
  intent: QueryIntent;
  matchedUsers: ResolvedQueryUser[];
  matchedConcepts: Array<{ query: string; hits: SubjectSearchHit[] }>;
  clusters?: QueryResultCluster[];
}): string[] {
  const warnings: string[] = [];

  if (
    ["user_summary", "user_concept_summary", "user_entity_sentiment", "compare_users_on_concept"].includes(args.intent.intentType)
    && args.intent.userRefs.length > 0
    && args.matchedUsers.length === 0
  ) {
    warnings.push(`No graph user matched: ${args.intent.userRefs.join(", ")}.`);
  }

  if (args.intent.intentType === "compare_users_on_concept" && args.matchedUsers.length < 2) {
    warnings.push("The current graph query needs two matched users for a comparison.");
  }

  if (
    args.intent.userRefs.length > 0
    && args.intent.conceptRefs.length > 0
    && args.matchedUsers.length > 0
    && args.matchedConcepts.some((concept) => concept.hits.length > 0)
    && (args.clusters?.length ?? 0) === 0
  ) {
    warnings.push(ZERO_LINK_WARNING);
  }

  for (const concept of args.matchedConcepts) {
    if (concept.hits.length === 0) {
      warnings.push(`No concept match was found for: ${concept.query}.`);
    } else if (concept.hits.length > 1) {
      warnings.push(
        `The graph returned multiple related concept clusters for "${concept.query}"; the answer keeps them separate instead of merging them.`,
      );
    }
  }

  if (args.intent.cohorts.length > 0 && args.clusters) {
    for (const cohort of args.intent.cohorts) {
      const cohortClusters = args.clusters.filter((cluster) => cluster.cohort?.label === cohort.label);
      if (cohortClusters.length > 0 && cohortClusters.every((cluster) => (cluster.metrics?.totalUsers ?? 0) === 0)) {
        warnings.push(`No users matched cohort: ${cohort.label}.`);
      }
    }
  }

  return warnings;
}

function clusterHasEvidence(cluster: QueryResultCluster): boolean {
  return cluster.assertions.some((assertion) => assertion.evidence.length > 0);
}

function computeFinalConfidence(state: ReasoningState, clusters: QueryResultCluster[]): number {
  let confidence = state.intent?.supported ? 0.3 : 0.12;

  if (state.intent?.userRefs.length) {
    confidence += state.matchedUsers.length > 0 ? 0.08 : -0.18;
  }

  const matchedConcepts = matchedConceptsFromState(state);
  if (state.intent?.conceptRefs.length) {
    if (matchedConcepts.every((concept) => concept.hits.length === 0)) {
      confidence -= 0.18;
    } else if (matchedConcepts.some((concept) => concept.hits.length > 1)) {
      confidence -= 0.04;
    } else {
      confidence += 0.08;
    }
  }

  const assertionCount = countRetrievedAssertions(clusters);
  const evidenceCount = countEvidenceBearingAssertions(clusters);
  const hasMetrics = hasAnyClusterMetrics(clusters);

  if (clusters.length > 0) {
    confidence += hasMetrics ? 0.08 : 0.05;
  }

  if (assertionCount > 0) {
    confidence += 0.18;
  } else if (hasMetrics) {
    confidence += 0.08;
  } else {
    confidence -= 0.12;
  }

  if (evidenceCount > 0 || clusters.some(clusterHasEvidence)) {
    confidence += 0.1;
  } else if (assertionCount > 0) {
    confidence -= 0.05;
  }

  if (state.terminationReason === "budget_exhausted") {
    confidence -= 0.12;
  }

  if (state.warnings.length > 0) {
    confidence -= Math.min(0.2, state.warnings.length * 0.04);
  }

  if (
    state.intent?.userRefs.length
    && state.intent?.conceptRefs.length
    && state.matchedUsers.length > 0
    && matchedConcepts.some((concept) => concept.hits.length > 0)
    && assertionCount === 0
  ) {
    confidence = Math.min(confidence, 0.3);
  }

  if (matchedConcepts.length > 0 && matchedConcepts.every((concept) => concept.hits.length === 0)) {
    confidence = Math.min(confidence, 0.25);
  }

  return clampConfidence(confidence);
}

function buildBaseAnswer(args: {
  state: ReasoningState;
  clusters: QueryResultCluster[];
  warnings: string[];
}): GroundedQueryAnswer {
  return {
    question: args.state.question,
    intent: args.state.intent ?? {
      supported: false,
      intentType: "user_summary",
      userRefs: [],
      conceptRefs: [],
      cohorts: [],
      relationFamilies: [],
      resultLimit: args.state.limit,
      needsEvidence: true,
      unsupportedReason: args.state.unsupportedReason ?? "Unsupported query.",
    },
    matchedUsers: args.state.matchedUsers,
    cohorts: args.state.intent?.cohorts ?? [],
    matchedConcepts: matchedConceptsFromState(args.state),
    clusters: args.clusters,
    warnings: args.warnings,
    answerText: args.state.answerText,
  };
}

async function synthesizeReasoningDrivenAnswer(args: {
  answer: GroundedQueryAnswer;
  state: ReasoningState;
  promptPreviewSink?: { value: string | null };
}): Promise<string> {
  const usesRealtimeModel = REALTIME_MODEL_PATTERN.test(config.openai.model);
  const storageContract = buildQueryStorageContract(2000);
  const systemText = [
    "You answer terminal Graph RAG queries from a retrieved assertion payload.",
    "Stay strictly within the retrieved evidence.",
    "Do not invent facts, hidden motivations, or unified concepts that are not explicitly retrieved.",
    "If multiple nearby concept clusters are present, mention that they are related but not fully unified in the current graph.",
    "If a user and concept matched but no linking assertions were retrieved, say that explicitly.",
    "If the answer is partial because of budget or retrieval limitations, say that explicitly.",
    "Keep the answer concise and terminal-friendly.",
    "After the short answer, include a compact evidence section with bullet points.",
    "Always end with a 'Verbose Report' section of 3-6 bullets.",
    "Each bullet in 'Verbose Report' must be a full sentence that explains retrieval coverage, the most relevant cluster or cohort metrics, notable retrieved signals, and any warnings or caveats.",
    "Do not use a 'Summary' heading.",
    storageContract,
  ].join(" ");

  const userPayload = JSON.stringify(
    {
      question: args.answer.question,
      intent: args.answer.intent,
      matchedUsers: args.answer.matchedUsers,
      matchedConcepts: args.answer.matchedConcepts,
      clusters: args.answer.clusters,
      warnings: args.answer.warnings,
      terminationReason: args.state.terminationReason,
      finalConfidence: args.state.finalConfidence,
    },
    null,
    2,
  );

  if (args.promptPreviewSink) {
    args.promptPreviewSink.value = `SYSTEM\n${systemText}\n\nUSER\n${userPayload}`.slice(0, 2000);
  }

  const response = await openaiClient.responses.create({
    model: config.openai.model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemText }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userPayload }],
      },
    ],
    ...(usesRealtimeModel ? {} : { max_output_tokens: 700 }),
  });

  const outputText = response.output_text?.trim();
  if (!outputText) {
    throw new Error("Reasoning answer synthesis did not return output_text.");
  }

  return outputText;
}

async function reflectOnGaps(args: {
  state: ReasoningState;
  gapContext: Record<string, unknown>;
  promptPreviewSink?: { value: string | null };
}): Promise<ReflectionModelResponse> {
  const usesRealtimeModel = REALTIME_MODEL_PATTERN.test(config.openai.model);
  const techniques = routeQueryReasoningSkills({
    question: args.state.question,
    intentType: args.state.intent?.intentType ?? null,
    hasCohorts: (args.state.intent?.cohorts.length ?? 0) > 0,
    multipleConceptClusters: matchedConceptsFromState(args.state).some((concept) => concept.hits.length > 1),
    isGapReflection: true,
  });
  const skillGuidance = await buildQuerySkillGuidance({ techniques });
  const storageContract = buildQueryStorageContract(2500);
  const systemText = [
    "You are the reflection phase of a bounded Graph RAG reasoning agent.",
    "Use the supplied skill modules to decide the most justified next action.",
    "Return JSON only.",
    "You may recommend only one of these actions:",
    REASONING_ACTIONS.join(", "),
    "Prefer conservative retrieval escalation: exact -> alias -> vector.",
    "Do not invent unsupported capabilities.",
    "Use second-order-thinking when comparing cohorts or when fragmented concepts risk an overconfident answer.",
    "For metrics_reflection, recommend finalize_answer or revise_plan instead of repeating retrieval that already happened.",
    storageContract,
    skillGuidance,
  ].join("\n\n");

  const userPayload = JSON.stringify(
    {
      question: args.state.question,
      intent: args.state.intent,
      matchedUsers: args.state.matchedUsers,
      matchedConcepts: matchedConceptsFromState(args.state),
      retrievalState: summarizeReflectionState(args.state),
      warnings: args.state.warnings,
      budget: createBudgetSnapshot(args.state),
      gapContext: args.gapContext,
    },
    null,
    2,
  );

  if (args.promptPreviewSink) {
    args.promptPreviewSink.value = `SYSTEM\n${systemText}\n\nUSER\n${userPayload}`.slice(0, 3000);
  }

  const response = await openaiClient.responses.create({
    model: config.openai.model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemText }] },
      { role: "user", content: [{ type: "input_text", text: userPayload }] },
    ],
    ...(usesRealtimeModel
      ? {}
      : {
          text: {
            format: {
              type: "json_schema",
              name: "query_gap_reflection",
              strict: true,
              schema: REFLECTION_SCHEMA,
            },
          },
        }),
  });

  const outputText = response.output_text?.trim();
  if (!outputText) {
    throw new Error("Reflection step did not return output_text.");
  }

  return JSON.parse(usesRealtimeModel ? parseJsonObject(outputText) : outputText) as ReflectionModelResponse;
}

function pushTraceStep(args: {
  state: ReasoningState;
  phase: ReasoningPhase;
  technique: string;
  reason: string;
  action: ReasoningAction;
  actionArgs?: Record<string, unknown>;
  observationSummary: string;
  observationData?: Record<string, unknown> | string | null;
  nextStepNeeded: boolean;
  isRevision?: boolean;
  revisesStep?: number;
  branchId?: string;
  confidence?: number | null;
  promptPreview?: string | null;
  traceOptions?: QueryTraceOptions;
}): void {
  args.state.used.steps += 1;
  const step: ReasoningStep = {
    stepNumber: args.state.trace.length + 1,
    phase: args.phase,
    technique: args.technique,
    reason: args.reason,
    action: args.action,
    actionArgs: args.actionArgs ?? {},
    observationSummary: args.observationSummary,
    observationData: args.observationData ?? null,
    nextStepNeeded: args.nextStepNeeded,
    isRevision: args.isRevision,
    revisesStep: args.revisesStep,
    branchId: args.branchId,
    confidence: args.confidence ?? null,
    budgetSnapshot: createBudgetSnapshot(args.state),
    promptPreview: args.promptPreview ?? null,
  };

  args.state.trace.push(step);
  args.traceOptions?.onStep?.(step);
}

function nextUnresolvedConcept(state: ReasoningState): ConceptResolutionState | null {
  for (const conceptState of state.conceptStates.values()) {
    const latestHits = selectedHitsForConcept(conceptState);
    if (latestHits.length > 0) {
      continue;
    }

    if (!conceptState.attempts.includes("exact")) {
      return conceptState;
    }

    if (!conceptState.reflectedExactMiss) {
      return conceptState;
    }

    if (!conceptState.attempts.includes("alias")) {
      return conceptState;
    }

    if (!conceptState.attempts.includes("vector")) {
      return conceptState;
    }

    if (!conceptState.attempts.includes("graph_fallback")) {
      return conceptState;
    }
  }

  return null;
}

function chooseNextAction(state: ReasoningState): {
  phase: ReasoningPhase;
  technique: string;
  reason: string;
  action: ReasoningAction;
  actionArgs: Record<string, unknown>;
  isRevision?: boolean;
  revisesStep?: number;
} {
  if (state.nextActionHint) {
    const action = state.nextActionHint;
    const actionArgs = state.nextActionArgsHint ?? {};
    state.nextActionHint = null;
    state.nextActionArgsHint = null;
    return {
      phase: action === "finalize_answer" || action === "return_unsupported" ? "answer" : "reflection",
      technique: action === "finalize_answer" ? "sequential-thinking" : "thought-based-reasoning/ReAct",
      reason: "Applying the next action selected during the previous reflection step.",
      action,
      actionArgs,
      isRevision: true,
      revisesStep: state.trace[state.trace.length - 1]?.stepNumber,
    };
  }

  if (!state.intent) {
    return {
      phase: "planning",
      technique: "sequential-thinking",
      reason: "Need to classify the query intent before choosing retrieval steps.",
      action: "classify_question",
      actionArgs: {},
    };
  }

  if (!state.intent.supported) {
    return {
      phase: "answer",
      technique: "sequential-thinking",
      reason: "The classified query is outside current graph-retrieval capabilities.",
      action: "return_unsupported",
      actionArgs: {},
    };
  }

  if (state.intent.userRefs.length > 0 && !state.usersResolved) {
    return {
      phase: "retrieval",
      technique: "sequential-thinking",
      reason: "Need to resolve named users to graph identities before retrieval.",
      action: "resolve_users",
      actionArgs: {
        userRefs: state.intent.userRefs,
      },
    };
  }

  if (
    state.intent.userRefs.length > 0
    && state.usersResolved
    && state.matchedUsers.length === 0
  ) {
    return {
      phase: "answer",
      technique: "sequential-thinking",
      reason: "No named users matched the graph, so the agent should answer with that limitation instead of re-querying.",
      action: "finalize_answer",
      actionArgs: {},
    };
  }

  if (state.intent.cohorts.length > 0 && !state.cohortsResolved) {
    return {
      phase: "planning",
      technique: "sequential-thinking",
      reason: "Need to normalize cohort filters before graph retrieval.",
      action: "resolve_cohorts",
      actionArgs: {
        cohorts: state.intent.cohorts,
      },
    };
  }

  const unresolvedConcept = nextUnresolvedConcept(state);
  if (unresolvedConcept) {
    if (!unresolvedConcept.attempts.includes("exact")) {
      return {
        phase: "retrieval",
        technique: "sequential-thinking",
        reason: "Concept lookup should start with the most conservative exact search.",
        action: "search_registry_exact",
        actionArgs: { query: unresolvedConcept.query },
      };
    }

    if (!unresolvedConcept.reflectedExactMiss) {
      return {
        phase: "reflection",
        technique: "thought-based-reasoning/ReAct",
        reason: "The exact concept search failed, so the agent should reflect before escalating retrieval.",
        action: "reflect_on_gaps",
        actionArgs: { query: unresolvedConcept.query, gapType: "exact_miss" },
      };
    }

    if (!unresolvedConcept.attempts.includes("alias")) {
      return {
        phase: "retrieval",
        technique: "thought-based-reasoning/ReAct",
        reason: "After an exact miss, the next conservative step is alias lookup.",
        action: "search_registry_alias",
        actionArgs: { query: unresolvedConcept.query },
        isRevision: true,
        revisesStep: state.trace.findLast((step) =>
          step.action === "search_registry_exact" && String(step.actionArgs.query ?? "") === unresolvedConcept.query,
        )?.stepNumber,
      };
    }

    if (!unresolvedConcept.attempts.includes("vector")) {
      return {
        phase: "retrieval",
        technique: "thought-based-reasoning/ReAct",
        reason: "A vector search is justified after exact and alias lookups fail.",
        action: "search_registry_vector",
        actionArgs: { query: unresolvedConcept.query },
        isRevision: true,
        revisesStep: state.trace.findLast((step) =>
          step.action === "search_registry_alias" && String(step.actionArgs.query ?? "") === unresolvedConcept.query,
        )?.stepNumber,
      };
    }

    if (!unresolvedConcept.attempts.includes("graph_fallback")) {
      return {
        phase: "retrieval",
        technique: "second-order-thinking",
        reason: "Registry lookup is exhausted, so the agent should search graph concepts directly before giving up.",
        action: "search_graph_fallback",
        actionArgs: { query: unresolvedConcept.query },
        isRevision: true,
        revisesStep: state.trace.findLast((step) =>
          step.action === "search_registry_vector" && String(step.actionArgs.query ?? "") === unresolvedConcept.query,
        )?.stepNumber,
      };
    }
  }

  if (
    (state.intent?.conceptRefs.length ?? 0) > 0
    && allConceptLookupsExhausted(state)
    && matchedConceptsFromState(state).every((concept) => concept.hits.length === 0)
  ) {
    return {
      phase: "answer",
      technique: "sequential-thinking",
      reason: "Concept lookup has been exhausted, so the agent should finalize with a limitation instead of querying the graph blindly.",
      action: "finalize_answer",
      actionArgs: {},
      isRevision: true,
      revisesStep: state.trace.findLast((traceStep) =>
        ["search_registry_exact", "search_registry_alias", "search_registry_vector", "search_graph_fallback", "reflect_on_gaps"].includes(traceStep.action),
      )?.stepNumber,
    };
  }

  if (requiresMetrics(state.intent) && !state.metricsLoaded) {
    return {
      phase: "retrieval",
      technique: "second-order-thinking",
      reason: "Cohort questions need metrics before representative assertions so the answer stays proportionate.",
      action: "query_graph_metrics",
      actionArgs: {},
    };
  }

  if (!state.assertionsLoaded) {
    return {
      phase: "retrieval",
      technique: requiresMetrics(state.intent) ? "thought-based-reasoning/ReAct" : "sequential-thinking",
      reason: "Need graph assertions to support the answer with concrete evidence.",
      action: "query_graph_assertions",
      actionArgs: {},
    };
  }

  if (countRetrievedAssertions(state.clusters) === 0) {
    return {
      phase: "answer",
      technique: "sequential-thinking",
      reason: buildFinalizeReason(state),
      action: "finalize_answer",
      actionArgs: {},
      isRevision: true,
      revisesStep: state.trace.findLast((traceStep) => traceStep.action === "query_graph_assertions")?.stepNumber,
    };
  }

  if (
    state.intent.needsEvidence
    && !state.evidenceAttached
    && countRetrievedAssertions(state.clusters) > 0
    && state.used.evidenceFetchRounds < state.budget.maxEvidenceFetchRounds
  ) {
    return {
      phase: "retrieval",
      technique: "thought-based-reasoning/ReAct",
      reason: "Attach Qdrant evidence now that candidate assertions are available.",
      action: "fetch_qdrant_evidence",
      actionArgs: {},
    };
  }

  if (
    requiresMetrics(state.intent)
    && !state.secondOrderReflectionDone
    && hasCompleteCohortPayload(state)
    && state.used.llmCalls < state.budget.maxLlmCalls
  ) {
    return {
      phase: "reflection",
      technique: "second-order-thinking",
      reason: "Before answering a metrics or cohort query, reflect on fragmentation and unintended overstatement.",
      action: "reflect_on_gaps",
      actionArgs: { gapType: "metrics_reflection" },
    };
  }

  return {
    phase: "answer",
    technique: "sequential-thinking",
    reason: buildFinalizeReason(state),
    action: "finalize_answer",
    actionArgs: {},
  };
}

function budgetExhaustedForAction(state: ReasoningState, action: ReasoningAction): string | null {
  if (!isTerminalAction(action) && state.used.steps >= state.budget.maxSteps) {
    return "step budget exhausted";
  }

  if (
    ["classify_question", "reflect_on_gaps"].includes(action)
    && state.used.llmCalls >= state.budget.maxLlmCalls
  ) {
    return "LLM budget exhausted";
  }

  if (
    ["resolve_users", "search_graph_fallback", "query_graph_assertions", "query_graph_metrics"].includes(action)
    && state.used.graphQueries >= state.budget.maxGraphQueries
  ) {
    return "graph query budget exhausted";
  }

  if (action === "search_registry_vector" && state.used.vectorQueries >= state.budget.maxVectorQueries) {
    return "vector query budget exhausted";
  }

  if (action === "fetch_qdrant_evidence" && state.used.evidenceFetchRounds >= state.budget.maxEvidenceFetchRounds) {
    return "evidence fetch budget exhausted";
  }

  return null;
}

async function executeAction(args: {
  state: ReasoningState;
  session: Neo4jReadSessionLike;
  step: ReturnType<typeof chooseNextAction>;
  traceOptions?: QueryTraceOptions;
}): Promise<void> {
  const { state, session, step } = args;
  const promptPreviewSink = args.traceOptions?.showPrompts ? { value: null as string | null } : undefined;

  switch (step.action) {
    case "classify_question": {
      state.used.llmCalls += 1;
      const skillGuidance = await buildQuerySkillGuidance({
        techniques: routeQueryReasoningSkills({ question: state.question }),
        maxChars: 7000,
      });
      const storageContract = buildQueryStorageContract(1800);
      if (promptPreviewSink) {
        promptPreviewSink.value = `INTENT CLASSIFIER\nQuestion: ${state.question}\n\nStorage contract:\n${storageContract}\n\nSkill guidance:\n${skillGuidance}`.slice(0, 2500);
      }

      const intent = await parseQueryIntent(state.question, state.limit, {
        skillGuidance,
      });
      state.intent = intent;
      state.conceptStates = new Map(
        intent.conceptRefs.map((query) => [
          query,
          {
            query,
            attempts: [],
            hitsByMode: {},
            latestMode: null,
            reflectedExactMiss: false,
            reflectedAliasMiss: false,
          } satisfies ConceptResolutionState,
        ]),
      );
      if (!intent.supported) {
        state.unsupportedReason = intent.unsupportedReason ?? "Unsupported query.";
      }

      pushTraceStep({
        state,
        phase: step.phase,
        technique: step.technique,
        reason: step.reason,
        action: step.action,
        actionArgs: step.actionArgs,
        observationSummary: intent.supported
          ? `Classified query as ${intent.intentType}.`
          : "Classifier marked the question as unsupported.",
        observationData: {
          supported: intent.supported,
          intentType: intent.intentType,
          userRefs: intent.userRefs,
          conceptRefs: intent.conceptRefs,
          cohorts: intent.cohorts,
          relationFamilies: intent.relationFamilies,
          polarityFilter: intent.polarityFilter ?? null,
        },
        nextStepNeeded: true,
        confidence: intent.supported ? 0.75 : 0.95,
        promptPreview: promptPreviewSink?.value ?? null,
        traceOptions: args.traceOptions,
      });
      return;
    }

    case "return_unsupported": {
      state.terminationReason = "unsupported";
      state.answerText = state.unsupportedReason
        ?? state.intent?.unsupportedReason
        ?? "This question is not reliably supported by the current graph query capabilities.";
      pushTraceStep({
        state,
        phase: step.phase,
        technique: step.technique,
        reason: step.reason,
        action: step.action,
        actionArgs: step.actionArgs,
        observationSummary: "Stopped because the query asks for unsupported causal or hidden-motivation reasoning.",
        observationData: { unsupportedReason: state.answerText },
        nextStepNeeded: false,
        confidence: 0.98,
        traceOptions: args.traceOptions,
      });
      return;
    }

    case "resolve_users": {
      state.used.graphQueries += 1;
      state.matchedUsers = await resolveQueryUsersReadOnly({
        session,
        userRefs: state.intent?.userRefs ?? [],
      });
      state.usersResolved = true;
      pushTraceStep({
        state,
        phase: step.phase,
        technique: step.technique,
        reason: step.reason,
        action: step.action,
        actionArgs: step.actionArgs,
        observationSummary: summariseMatchedUsers(state.matchedUsers),
        observationData: {
          matchedUsers: state.matchedUsers,
        },
        nextStepNeeded: true,
        confidence: state.matchedUsers.length > 0 ? 0.9 : 0.35,
        traceOptions: args.traceOptions,
      });
      return;
    }

    case "resolve_cohorts": {
      state.cohortsResolved = true;
      pushTraceStep({
        state,
        phase: step.phase,
        technique: step.technique,
        reason: step.reason,
        action: step.action,
        actionArgs: step.actionArgs,
        observationSummary: `Resolved ${state.intent?.cohorts.length ?? 0} cohort filter(s).`,
        observationData: { cohorts: state.intent?.cohorts ?? [] },
        nextStepNeeded: true,
        confidence: 0.85,
        traceOptions: args.traceOptions,
      });
      return;
    }

    case "search_registry_exact":
    case "search_registry_alias":
    case "search_registry_vector":
    case "search_graph_fallback": {
      const mode = step.action === "search_graph_fallback"
        ? "graph_fallback"
        : step.action.replace("search_registry_", "") as SearchMode;
      const query = String(step.actionArgs.query ?? "");
      const conceptState = state.conceptStates.get(query);
      if (!conceptState) {
        pushTraceStep({
          state,
          phase: step.phase,
          technique: step.technique,
          reason: step.reason,
          action: step.action,
          actionArgs: step.actionArgs,
          observationSummary: `No concept state was available for "${query}".`,
          observationData: { query },
          nextStepNeeded: true,
          confidence: 0.2,
          isRevision: step.isRevision,
          revisesStep: step.revisesStep,
          traceOptions: args.traceOptions,
        });
        return;
      }

      if (mode === "vector") {
        state.used.vectorQueries += 1;
      }
      if (mode === "graph_fallback") {
        state.used.graphQueries += 1;
      }

      const allowedKinds = allowedKindsForIntent(state.intent ?? {
        supported: true,
        intentType: "user_concept_summary",
        userRefs: [],
        conceptRefs: [],
        cohorts: [],
        relationFamilies: [],
        resultLimit: state.limit,
        needsEvidence: true,
      });
      const hits = mode === "graph_fallback"
        ? await searchGraphFallbackSubjectsReadOnly({
            session,
            query,
            limit: 3,
            allowedKinds,
          })
        : await searchRegistrySubjectsByModeReadOnly({
            query,
            mode,
            limit: 3,
            allowedKinds,
          });

      conceptState.attempts.push(mode);
      conceptState.hitsByMode[mode] = hits;
      conceptState.latestMode = mode;
      if (mode === "alias" && hits.length === 0) {
        conceptState.reflectedAliasMiss = true;
      }
      if (mode === "graph_fallback" && hits.length === 0) {
        addWarning(state, `Graph fallback also found no matching concept candidate for "${query}".`);
      }

      pushTraceStep({
        state,
        phase: step.phase,
        technique: step.technique,
        reason: step.reason,
        action: step.action,
        actionArgs: step.actionArgs,
        observationSummary: summariseConceptHits(query, mode, hits),
        observationData: {
          query,
          mode,
          hits,
        },
        nextStepNeeded: true,
        isRevision: step.isRevision,
        revisesStep: step.revisesStep,
        confidence: hits.length > 0 ? 0.8 : 0.4,
        traceOptions: args.traceOptions,
      });
      return;
    }

    case "reflect_on_gaps": {
      state.used.llmCalls += 1;
      let reflection: ReflectionModelResponse;
      let fallbackWarning: string | null = null;
      let fallbackError: string | null = null;

      try {
        reflection = await reflectOnGaps({
          state,
          gapContext: {
            ...step.actionArgs,
            matchedConcepts: matchedConceptsFromState(state),
          },
          promptPreviewSink,
        });
      } catch (error) {
        const fallback = buildDeterministicReflectionFallback({
          state,
          step,
          error,
        });
        reflection = fallback;
        fallbackWarning = fallback.warning;
        fallbackError = error instanceof Error ? error.message : String(error);
        addWarning(state, fallback.warning);
      }

      const recommendedAction = REASONING_ACTIONS.includes((reflection.recommendedAction ?? "") as ReasoningAction)
        ? (reflection.recommendedAction as ReasoningAction)
        : null;
      const normalizedRecommendation = normalizeReflectionRecommendation({
        state,
        step,
        reflection,
        recommendedAction,
      });

      if (step.actionArgs.gapType === "exact_miss") {
        const query = String(step.actionArgs.query ?? "");
        const conceptState = state.conceptStates.get(query);
        if (conceptState) {
          conceptState.reflectedExactMiss = true;
        }
      }

      if (step.actionArgs.gapType === "alias_miss") {
        const query = String(step.actionArgs.query ?? "");
        const conceptState = state.conceptStates.get(query);
        if (conceptState) {
          conceptState.reflectedAliasMiss = true;
        }
      }

      if (step.actionArgs.gapType === "metrics_reflection") {
        state.secondOrderReflectionDone = true;
      }

      if (normalizedRecommendation.normalizationWarning) {
        addWarning(state, normalizedRecommendation.normalizationWarning);
      }

      if (normalizedRecommendation.recommendedAction) {
        state.nextActionHint = normalizedRecommendation.recommendedAction;
        state.nextActionArgsHint = normalizedRecommendation.actionArgs;
      }

      if (reflection.unsupportedReason) {
        state.unsupportedReason = reflection.unsupportedReason;
      }

      pushTraceStep({
        state,
        phase: step.phase,
        technique: reflection.technique?.trim() || step.technique,
        reason: reflection.reason?.trim() || step.reason,
        action: step.action,
        actionArgs: step.actionArgs,
        observationSummary: fallbackWarning
          ? `Reflection failed; using deterministic fallback to ${normalizedRecommendation.recommendedAction ?? "finalize_answer"}.`
          : normalizedRecommendation.normalizationWarning
            ? `Reflection recommended ${normalizedRecommendation.rawRecommendedAction ?? "no next action"}, but the controller normalized it to ${normalizedRecommendation.recommendedAction ?? "finalize_answer"}.`
            : (normalizedRecommendation.recommendedAction
                ? `Reflection recommends next action: ${normalizedRecommendation.recommendedAction}.`
                : "Reflection completed without changing the current plan."),
        observationData: {
          rawRecommendedAction: normalizedRecommendation.rawRecommendedAction,
          recommendedAction: normalizedRecommendation.recommendedAction,
          actionArgs: normalizedRecommendation.actionArgs,
          unsupportedReason: reflection.unsupportedReason ?? null,
          normalizationWarning: normalizedRecommendation.normalizationWarning,
          fallbackWarning,
          fallbackError,
        },
        nextStepNeeded: true,
        confidence: clampConfidence(Number(reflection.confidence ?? 0.55)),
        promptPreview: promptPreviewSink?.value ?? null,
        traceOptions: args.traceOptions,
      });
      return;
    }

    case "revise_plan": {
      pushTraceStep({
        state,
        phase: step.phase,
        technique: step.technique,
        reason: step.reason,
        action: step.action,
        actionArgs: step.actionArgs,
        observationSummary: "Marked the reasoning path as revised before continuing.",
        observationData: step.actionArgs,
        nextStepNeeded: true,
        isRevision: true,
        revisesStep: step.revisesStep,
        confidence: 0.7,
        traceOptions: args.traceOptions,
      });
      return;
    }

    case "query_graph_metrics": {
      state.used.graphQueries += 1;
      const userIds = state.intent?.intentType === "concept_cohort_summary" ? [] : state.matchedUsers.map((user) => user.externalAccountId);
      const activeCohorts = state.intent && state.intent.cohorts.length > 0 ? state.intent.cohorts : [null];
      const matchedConcepts = matchedConceptsFromState(state);
      const clusters: QueryResultCluster[] = [];

      for (const concept of matchedConcepts) {
        for (const hit of concept.hits) {
          for (const cohort of activeCohorts) {
            const metrics = await fetchClusterMetricsReadOnly({
              session,
              candidate: hit,
              cohort,
              userIds,
              relationFamilies: state.intent?.relationFamilies ?? [],
              polarityFilter: state.intent?.polarityFilter,
            });

            if (metrics.totalUsers > 0) {
              clusters.push({
                queryRef: concept.query,
                matchedConcept: hit,
                cohort,
                metrics,
                assertions: [],
              });
            }
          }
        }
      }

      state.metricsLoaded = true;
      state.clusters = clusters;
      state.finalConfidence = computeFinalConfidence(state, clusters);
      state.warnings = Array.from(new Set([
        ...state.warnings,
        ...buildWarnings({
          intent: state.intent!,
          matchedUsers: state.matchedUsers,
          matchedConcepts,
          clusters,
        }),
      ]));
      state.nextActionHint = null;
      state.nextActionArgsHint = null;
      state.answerText = "";
      pushTraceStep({
        state,
        phase: step.phase,
        technique: step.technique,
        reason: step.reason,
        action: step.action,
        actionArgs: step.actionArgs,
        observationSummary: clusters.length > 0
          ? `Computed metrics for ${clusters.length} cluster/cohort combination(s).`
          : "No metrics-bearing clusters were found.",
        observationData: {
          clusters: clusters.map((cluster) => ({
            queryRef: cluster.queryRef,
            concept: cluster.matchedConcept?.label ?? null,
            cohort: cluster.cohort?.label ?? null,
            metrics: cluster.metrics,
          })),
        },
        nextStepNeeded: true,
        confidence: clusters.length > 0 ? 0.82 : 0.35,
        traceOptions: args.traceOptions,
      });
      return;
    }

    case "query_graph_assertions": {
      state.used.graphQueries += 1;
      const userIds = state.intent?.intentType === "concept_cohort_summary" ? [] : state.matchedUsers.map((user) => user.externalAccountId);
      const activeCohorts = state.intent && state.intent.cohorts.length > 0 ? state.intent.cohorts : [null];
      const matchedConcepts = matchedConceptsFromState(state);
      const clusterMap = new Map<string, QueryResultCluster>();

      if (state.intent?.intentType === "user_summary") {
        const assertions = await fetchAssertionsReadOnly({
          session,
          candidate: null,
          cohort: null,
          userIds,
          relationFamilies: state.intent.relationFamilies,
          polarityFilter: state.intent.polarityFilter,
          limit: state.intent.resultLimit,
        });

        clusterMap.set(buildClusterKey({
          queryRef: null,
          matchedConcept: null,
          cohort: null,
        }), {
          queryRef: null,
          matchedConcept: null,
          cohort: null,
          metrics: null,
          assertions,
        });
      } else {
        for (const cluster of state.clusters) {
          clusterMap.set(buildClusterKey(cluster), {
            ...cluster,
            assertions: [...cluster.assertions],
          });
        }

        for (const concept of matchedConcepts) {
          for (const hit of concept.hits) {
            for (const cohort of activeCohorts) {
              const clusterKey = buildClusterKey({
                queryRef: concept.query,
                matchedConcept: hit,
                cohort,
              });
              const existingCluster = clusterMap.get(clusterKey);
              const assertions = await fetchAssertionsReadOnly({
                session,
                candidate: hit,
                cohort,
                userIds,
                relationFamilies: state.intent?.relationFamilies ?? [],
                polarityFilter: state.intent?.polarityFilter,
                limit: state.intent?.resultLimit ?? state.limit,
              });

              let metrics: QueryClusterMetrics | null = existingCluster?.metrics ?? null;
              if (requiresMetrics(state.intent) && !metrics) {
                metrics = await fetchClusterMetricsReadOnly({
                  session,
                  candidate: hit,
                  cohort,
                  userIds,
                  relationFamilies: state.intent?.relationFamilies ?? [],
                  polarityFilter: state.intent?.polarityFilter,
                });
              }

              if (assertions.length > 0 || (metrics?.totalUsers ?? 0) > 0) {
                clusterMap.set(clusterKey, {
                  queryRef: concept.query,
                  matchedConcept: hit,
                  cohort,
                  metrics,
                  assertions,
                });
              } else if (existingCluster) {
                clusterMap.set(clusterKey, {
                  ...existingCluster,
                  assertions,
                });
              }
            }
          }
        }
      }

      const clusters = Array.from(clusterMap.values());
      state.assertionsLoaded = true;
      state.warnings = Array.from(new Set([
        ...state.warnings,
        ...buildWarnings({
          intent: state.intent!,
          matchedUsers: state.matchedUsers,
          matchedConcepts,
          clusters,
        }),
      ]));

      state.answerText = "";
      state.finalConfidence = computeFinalConfidence(state, clusters);
      state.nextActionHint = null;
      state.nextActionArgsHint = null;
      state.answerText = "";
      state.clusters = clusters;

      pushTraceStep({
        state,
        phase: step.phase,
        technique: step.technique,
        reason: step.reason,
        action: step.action,
        actionArgs: step.actionArgs,
        observationSummary: clusters.length > 0
          ? `Retrieved ${clusters.reduce((sum, cluster) => sum + cluster.assertions.length, 0)} assertion(s) across ${clusters.length} cluster(s).`
          : "No matching assertions were found in the graph.",
        observationData: {
          clusterCount: clusters.length,
          clusters: clusters.map((cluster) => ({
            queryRef: cluster.queryRef,
            concept: cluster.matchedConcept?.label ?? null,
            cohort: cluster.cohort?.label ?? null,
            assertionCount: cluster.assertions.length,
          })),
        },
        nextStepNeeded: true,
        confidence: clusters.length > 0 ? 0.86 : 0.3,
        traceOptions: args.traceOptions,
      });
      return;
    }

    case "fetch_qdrant_evidence": {
      state.used.evidenceFetchRounds += 1;
      const withEvidence = await attachEvidenceSnippets(state.clusters);
      state.clusters = withEvidence;
      state.evidenceAttached = true;
      state.finalConfidence = computeFinalConfidence(state, withEvidence);

      pushTraceStep({
        state,
        phase: step.phase,
        technique: step.technique,
        reason: step.reason,
        action: step.action,
        actionArgs: step.actionArgs,
        observationSummary: `Attached evidence snippets to ${withEvidence.reduce((sum, cluster) => sum + cluster.assertions.length, 0)} assertion(s).`,
        observationData: {
          evidenceBearingAssertions: withEvidence.flatMap((cluster) =>
            cluster.assertions
              .filter((assertion) => assertion.evidence.length > 0)
              .map((assertion) => ({
                assertionSignature: assertion.assertionSignature,
                evidenceCount: assertion.evidence.length,
              })),
          ),
        },
        nextStepNeeded: true,
        confidence: 0.88,
        traceOptions: args.traceOptions,
      });
      return;
    }

    case "finalize_answer": {
      const clusters = state.clusters;
      const matchedConcepts = matchedConceptsFromState(state);
      const conceptResolutionBlocked = Boolean(state.intent?.conceptRefs.length)
        && matchedConcepts.length > 0
        && matchedConcepts.every((concept) => concept.hits.length === 0);
      const warnings = buildWarnings({
        intent: state.intent!,
        matchedUsers: state.matchedUsers,
        matchedConcepts,
        clusters,
      });
      state.warnings = Array.from(new Set([...state.warnings, ...warnings]));
      state.finalConfidence = computeFinalConfidence(state, clusters);
      state.terminationReason = state.terminationReason ?? "completed";

      const baseAnswer = buildBaseAnswer({
        state,
        clusters,
        warnings: state.warnings,
      });

      if (conceptResolutionBlocked) {
        state.answerText = renderDeterministicAnswer(baseAnswer);
      } else if (state.used.llmCalls < state.budget.maxLlmCalls) {
        state.used.llmCalls += 1;
        try {
          state.answerText = await synthesizeReasoningDrivenAnswer({
            answer: baseAnswer,
            state,
            promptPreviewSink,
          });
        } catch {
          state.answerText = renderDeterministicAnswer(baseAnswer);
        }
      } else {
        addWarning(state, "Final answer used deterministic rendering because the LLM budget was exhausted.");
        state.answerText = renderDeterministicAnswer(baseAnswer);
      }

      pushTraceStep({
        state,
        phase: step.phase,
        technique: step.technique,
        reason: step.reason,
        action: step.action,
        actionArgs: step.actionArgs,
        observationSummary: "Final answer composed from the gathered graph and evidence payloads.",
        observationData: {
          terminationReason: state.terminationReason,
          finalConfidence: state.finalConfidence,
          warningCount: state.warnings.length,
        },
        nextStepNeeded: false,
        confidence: state.finalConfidence,
        promptPreview: promptPreviewSink?.value ?? null,
        traceOptions: args.traceOptions,
      });
      return;
    }
  }
}

function buildBudgetExhaustedAnswer(state: ReasoningState): void {
  state.terminationReason = "budget_exhausted";
  addWarning(state, "Retrieval stopped because the configured reasoning budget was exhausted.");
  state.answerText = renderDeterministicAnswer(buildBaseAnswer({
    state,
    clusters: state.clusters,
    warnings: state.warnings,
  }));
}

export async function runReasoningDrivenTerminalGraphQuery(args: {
  question: string;
  limit?: number;
  budget?: Partial<ReasoningBudget>;
  trace?: QueryTraceOptions;
}): Promise<ReasoningDrivenQueryAnswer> {
  const limit = Math.max(1, Math.min(10, Math.floor(args.limit ?? 5)));
  const state = initializeState({
    question: args.question,
    limit,
    budget: args.budget,
  });
  const session = neo4jDriver.session({ database: config.neo4j.database });

  try {
    while (!state.terminationReason) {
      const nextStep = chooseNextAction(state);
      const budgetFailure = budgetExhaustedForAction(state, nextStep.action);
      if (budgetFailure) {
        state.terminationReason = "budget_exhausted";
        pushTraceStep({
          state,
          phase: "reflection",
          technique: "sequential-thinking",
          reason: "A remaining-budget check runs before each action so the agent stops safely.",
          action: "revise_plan",
          actionArgs: { blockedAction: nextStep.action, budgetFailure },
          observationSummary: `Stopped before ${nextStep.action}: ${budgetFailure}.`,
          observationData: { blockedAction: nextStep.action, budgetFailure },
          nextStepNeeded: false,
          confidence: 0.95,
          traceOptions: args.trace,
        });
        break;
      }

      try {
        await executeAction({
          state,
          session,
          step: nextStep,
          traceOptions: args.trace,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addWarning(state, `Reasoning step ${nextStep.action} failed; finalizing with the best retrieved data so far.`);
        pushTraceStep({
          state,
          phase: "reflection",
          technique: "sequential-thinking",
          reason: "Unexpected step failures should degrade gracefully to a limitation answer instead of crashing the CLI.",
          action: "revise_plan",
          actionArgs: { failedAction: nextStep.action },
          observationSummary: `${nextStep.action} failed; finalizing with the best retrieved data so far.`,
          observationData: { failedAction: nextStep.action, error: errorMessage },
          nextStepNeeded: true,
          confidence: 0.4,
          traceOptions: args.trace,
        });

        if (!state.intent && nextStep.action === "classify_question") {
          state.terminationReason = "unsupported";
          state.unsupportedReason = "The query agent could not classify this question reliably.";
          state.answerText = state.unsupportedReason;
          break;
        }

        state.nextActionHint = "finalize_answer";
        state.nextActionArgsHint = { note: `fallback_after_${nextStep.action}` };
      }
    }

    if (state.terminationReason === "budget_exhausted" && !state.answerText) {
      buildBudgetExhaustedAnswer(state);
    }

    const clusters = state.clusters;
    state.finalConfidence = computeFinalConfidence(state, clusters);
    const warnings = buildWarnings({
      intent: state.intent ?? {
        supported: false,
        intentType: "user_summary",
        userRefs: [],
        conceptRefs: [],
        cohorts: [],
        relationFamilies: [],
        resultLimit: limit,
        needsEvidence: true,
        unsupportedReason: state.unsupportedReason ?? "Unsupported query.",
      },
      matchedUsers: state.matchedUsers,
      matchedConcepts: matchedConceptsFromState(state),
      clusters,
    });
    state.warnings = Array.from(new Set([...state.warnings, ...warnings]));

    const answer = buildBaseAnswer({
      state,
      clusters,
      warnings: state.warnings,
    });

    return {
      ...answer,
      reasoningTrace: state.trace,
      budgetUsed: state.used,
      finalConfidence: state.finalConfidence,
      terminationReason: state.terminationReason ?? "completed",
    };
  } finally {
    await session.close();
  }
}

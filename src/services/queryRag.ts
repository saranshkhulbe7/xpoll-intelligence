import neo4j from "neo4j-driver";
import { config } from "../config";
import { neo4jDriver } from "../db/neo4j";
import { qdrantClient } from "../db/qdrant";
import { openaiClient } from "../openai";
import type { RelationPolarity, SubjectKind } from "../types";
import { acceptsConservativeVectorMatch } from "./conceptResolver";
import { textToVector } from "../utils/embedding";
import { normalizeText } from "../utils/text";

export type QueryIntentType =
  | "user_summary"
  | "user_concept_summary"
  | "concept_cohort_summary"
  | "user_entity_sentiment"
  | "compare_users_on_concept";

export type QueryRelationFamily = "support" | "preference" | "sentiment" | "uncertainty";
export type QuerySubjectMatchType = "exact" | "alias" | "vector";

export type QueryIntent = {
  supported: boolean;
  intentType: QueryIntentType;
  userRefs: string[];
  conceptRefs: string[];
  relationFamilies: QueryRelationFamily[];
  polarityFilter?: RelationPolarity;
  resultLimit: number;
  needsEvidence: boolean;
  unsupportedReason?: string;
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
  assertions: RetrievedAssertion[];
};

export type GroundedQueryAnswer = {
  question: string;
  intent: QueryIntent;
  matchedUsers: ResolvedQueryUser[];
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

function heuristicIntentFallback(question: string, limit: number): QueryIntent {
  const normalizedQuestion = question.trim();
  const compareMatch = normalizedQuestion.match(/^compare\s+(.+?)\s+and\s+(.+?)\s+on\s+(.+?)(?:\?|$)/i);
  if (compareMatch) {
    return {
      supported: true,
      intentType: "compare_users_on_concept",
      userRefs: [compareMatch[1] ?? "", compareMatch[2] ?? ""].filter(Boolean),
      conceptRefs: [compareMatch[3] ?? ""].filter(Boolean),
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
      relationFamilies: ["sentiment"],
      polarityFilter: normalizePolarityFilter(whoTowardMatch[1]),
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
    relationFamilies: [],
    resultLimit: clampResultLimit(limit),
    needsEvidence: true,
    unsupportedReason:
      "This question is outside the Phase 1 terminal Graph RAG scope. Try asking about a known user, topic, position, or entity.",
  };
}

export async function parseQueryIntent(question: string, limit = DEFAULT_RESULT_LIMIT): Promise<QueryIntent> {
  const usesRealtimeModel = REALTIME_MODEL_PATTERN.test(config.openai.model);

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
                "concept_cohort_summary = who holds a stance on a concept or entity.",
                "user_entity_sentiment = one user's sentiment toward a person or organization.",
                "compare_users_on_concept = compare two named users on one concept.",
                "Extract userRefs exactly as named in the question when present.",
                "Extract conceptRefs as compact phrases that can be used to search the subject registry.",
                "Use relationFamilies only from: support, preference, sentiment, uncertainty.",
                "Use polarityFilter only from: positive, negative, neutral, or null.",
                "Keep resultLimit small and practical for a terminal response.",
                "Set needsEvidence=true unless the question explicitly asks for a terse answer only.",
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

export async function searchRegistrySubjectsReadOnly(args: {
  query: string;
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

    if (hits.size < limit) {
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

    if (hits.size === 0) {
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

export async function fetchAssertionsReadOnly(args: {
  session: Neo4jReadSessionLike;
  candidate: SubjectSearchHit | null;
  userIds: string[];
  relationFamilies: QueryRelationFamily[];
  polarityFilter?: RelationPolarity;
  limit: number;
}): Promise<RetrievedAssertion[]> {
  const nowIso = new Date().toISOString();
  const resultLimit = clampResultLimit(args.limit);

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

export function renderDeterministicAnswer(answer: GroundedQueryAnswer): string {
  if (!answer.intent.supported) {
    return answer.answerText;
  }

  if (answer.clusters.length === 0) {
    const lines = [
      "No strong matching assertions were found for that query.",
    ];
    if (answer.warnings.length > 0) {
      lines.push("", "Warnings:");
      for (const warning of answer.warnings) {
        lines.push(`- ${warning}`);
      }
    }
    return lines.join("\n");
  }

  const lines: string[] = [];

  for (const cluster of answer.clusters) {
    if (cluster.matchedConcept) {
      lines.push(
        `Concept cluster: ${cluster.matchedConcept.label} (${cluster.matchedConcept.kind}, ${cluster.matchedConcept.matchType})`,
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

  return lines.join("\n").trim();
}

async function synthesizeGroundedAnswer(answer: GroundedQueryAnswer): Promise<string> {
  const usesRealtimeModel = REALTIME_MODEL_PATTERN.test(config.openai.model);

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
              "Keep the answer concise and terminal-friendly.",
              "After the short answer, include a compact evidence section with bullet points.",
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

function buildWarnings(args: {
  intent: QueryIntent;
  matchedUsers: ResolvedQueryUser[];
  matchedConcepts: Array<{ query: string; hits: SubjectSearchHit[] }>;
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

  for (const concept of args.matchedConcepts) {
    if (concept.hits.length === 0) {
      warnings.push(`No subject-registry concept matched: ${concept.query}.`);
    } else if (concept.hits.length > 1) {
      warnings.push(
        `The graph returned multiple related concept clusters for "${concept.query}"; the answer keeps them separate instead of merging them.`,
      );
    }
  }

  return warnings;
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
        hits: await searchRegistrySubjectsReadOnly({
          query,
          limit: 3,
          allowedKinds: allowedKindsForIntent(intent),
        }),
      })),
    );

    const warnings = buildWarnings({
      intent,
      matchedUsers,
      matchedConcepts,
    });

    if (
      ["user_summary", "user_concept_summary", "user_entity_sentiment", "compare_users_on_concept"].includes(intent.intentType)
      && matchedUsers.length === 0
    ) {
      return {
        question: args.question,
        intent,
        matchedUsers,
        matchedConcepts,
        clusters: [],
        warnings,
        answerText: renderDeterministicAnswer({
          question: args.question,
          intent,
          matchedUsers,
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
        userIds,
        relationFamilies: intent.relationFamilies,
        polarityFilter: intent.polarityFilter,
        limit: intent.resultLimit,
      });
      clusters.push({
        queryRef: null,
        matchedConcept: null,
        assertions,
      });
    } else {
      for (const concept of matchedConcepts) {
        for (const hit of concept.hits) {
          const assertions = await fetchAssertionsReadOnly({
            session,
            candidate: hit,
            userIds: intent.intentType === "concept_cohort_summary" ? [] : userIds,
            relationFamilies: intent.relationFamilies,
            polarityFilter: intent.polarityFilter,
            limit: intent.resultLimit,
          });

          if (assertions.length > 0) {
            clusters.push({
              queryRef: concept.query,
              matchedConcept: hit,
              assertions,
            });
          }
        }
      }
    }

    const clustersWithEvidence = intent.needsEvidence ? await attachEvidenceSnippets(clusters) : clusters;
    const baseAnswer: GroundedQueryAnswer = {
      question: args.question,
      intent,
      matchedUsers,
      matchedConcepts,
      clusters: clustersWithEvidence,
      warnings,
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

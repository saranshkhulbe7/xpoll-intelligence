import { createHash } from "node:crypto";
import { config } from "../config";
import { qdrantClient } from "../db/qdrant";
import type {
  InferredSemantics,
  IntensityBand,
  PollSemanticTemplate,
  RawVote,
  RelationPolarity,
  ResolvedAssertion,
  ResolvedSubject,
  SubjectKind,
} from "../types";
import { hasHighLexicalOverlap, hasNameLikeOverlap } from "../utils/conceptQuality";
import { intensityBandToContribution } from "../utils/intensity";
import { textToVector } from "../utils/embedding";
import { normalizeText, slugify } from "../utils/text";

type SubjectResolverInput = { kind: SubjectKind; label: string; topicCanonicalId?: string; aliases?: string[] };
type RegistryResolution = { resolvedSubjects: ResolvedSubject[]; resolvedAssertions: ResolvedAssertion[] };
type CanonicalRelationFamily = "support" | "preference" | "sentiment" | "uncertainty";
type CanonicalRelationSpec = {
  relationId: string;
  relationLabel: string;
  relationFamily: CanonicalRelationFamily;
  polarity: RelationPolarity;
};

const VECTOR_THRESHOLD_BY_KIND: Record<SubjectKind, number> = {
  topic: 0.97,
  position: 0.97,
  entity: 0.95,
  ideology: 0.97,
};

function compact<T>(values: Array<T | null | undefined | false>): T[] {
  return values.filter(Boolean) as T[];
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function clampConfidence(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.75;
  }
  return Math.max(0, Math.min(1, value));
}

function registryCollectionName(): string {
  return config.qdrant.registryCollectionName;
}

function vectorThresholdForKind(kind: SubjectKind): number {
  return Math.max(config.qdrant.matchThreshold, VECTOR_THRESHOLD_BY_KIND[kind]);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export type ConservativeVectorMatchInspection = {
  accepted: boolean;
  rejectionReason: "score_below_threshold" | "lexical_overlap_below_threshold" | null;
  lexicalOverlap: number;
  threshold: number;
};

export function inspectConservativeVectorMatch(args: {
  kind: SubjectKind;
  score: number;
  inputLabel: string;
  inputAliases?: string[];
  candidateLabel: string;
  candidateAliases?: string[];
}): ConservativeVectorMatchInspection {
  const threshold = vectorThresholdForKind(args.kind);
  if (args.score < threshold) {
    return {
      accepted: false,
      rejectionReason: "score_below_threshold",
      lexicalOverlap: 0,
      threshold,
    };
  }

  const inputValues = dedupeStrings([args.inputLabel, ...(args.inputAliases ?? [])]);
  const candidateValues = dedupeStrings([args.candidateLabel, ...(args.candidateAliases ?? [])]);

  if (args.kind === "entity") {
    const accepted = inputValues.some((inputValue) =>
      candidateValues.some((candidateValue) => hasNameLikeOverlap(inputValue, candidateValue)),
    );
    return {
      accepted,
      rejectionReason: accepted ? null : "lexical_overlap_below_threshold",
      lexicalOverlap: accepted ? 1 : 0,
      threshold,
    };
  }

  let lexicalOverlap = 0;
  const accepted = inputValues.some((inputValue) =>
    candidateValues.some((candidateValue) => {
      const overlap = hasHighLexicalOverlap(inputValue, candidateValue, 0.5);
      if (overlap) {
        lexicalOverlap = Math.max(lexicalOverlap, 0.5);
      }
      return overlap;
    }),
  );

  return {
    accepted,
    rejectionReason: accepted ? null : "lexical_overlap_below_threshold",
    lexicalOverlap,
    threshold,
  };
}

export function acceptsConservativeVectorMatch(args: {
  kind: SubjectKind;
  score: number;
  inputLabel: string;
  inputAliases?: string[];
  candidateLabel: string;
  candidateAliases?: string[];
}): boolean {
  return inspectConservativeVectorMatch(args).accepted;
}

export function buildQdrantRegistryPointId(canonicalId: string): string {
  const hex = createHash("sha256").update(canonicalId).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  const normalized = hex.join("");
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20, 32),
  ].join("-");
}

export function buildAssertionSignature(args: {
  userId: string;
  relationId: string;
  targetSubjectId: string;
  aboutTopicId?: string | null;
}): string {
  const signatureSource = [args.userId, args.relationId, args.targetSubjectId, args.aboutTopicId ?? ""].join("::");
  return `assertion_${createHash("sha256").update(signatureSource).digest("hex").slice(0, 32)}`;
}

export function buildAssertionGroupKey(args: {
  userId: string;
  relationFamily: string;
  targetSubjectId: string;
  aboutTopicId?: string | null;
}): string {
  const groupSource = [args.userId, args.relationFamily, args.targetSubjectId, args.aboutTopicId ?? ""].join("::");
  return `assertion_group_${createHash("sha256").update(groupSource).digest("hex").slice(0, 32)}`;
}

function buildSubjectCanonicalId(args: SubjectResolverInput): string {
  const topicPart = args.kind === "position" && args.topicCanonicalId ? `${slugify(args.topicCanonicalId)}__` : "";
  return `subject:${args.kind}:${topicPart}${slugify(args.label)}`;
}

function normalizeRelationFamily(value: string): { family: CanonicalRelationFamily; polarity?: RelationPolarity } | null {
  const normalized = normalizeText(value);

  if (/^(support|supports|supportive|back|backs|favor|favors|favours|agreement|agree|agrees)$/.test(normalized)) {
    return { family: "support" };
  }

  if (/^(opposition|oppose|opposes|against|anti|reject|rejects|rejection)$/.test(normalized)) {
    return { family: "support", polarity: "negative" };
  }

  if (/^(preference|prefer|prefers|choice|chooses)$/.test(normalized)) {
    return { family: "preference" };
  }

  if (/^(sentiment|view|views|opinion|opinions|feeling|feelings|assessment)$/.test(normalized)) {
    return { family: "sentiment" };
  }

  if (/^(uncertainty|uncertain|unsure|mixed|ambivalent|ambivalence|neutral)$/.test(normalized)) {
    return { family: "uncertainty", polarity: "neutral" };
  }

  return null;
}

export function canonicalizeRelation(args: {
  relationFamily: string;
  polarity: RelationPolarity;
}): CanonicalRelationSpec | null {
  const normalized = normalizeRelationFamily(args.relationFamily);
  if (!normalized) {
    return null;
  }

  const family = normalized.family;
  const polarity = normalized.polarity ?? args.polarity;

  if (family === "support") {
    if (polarity === "positive") {
      return {
        relationId: "relation:support:positive:supports",
        relationLabel: "supports",
        relationFamily: "support",
        polarity: "positive",
      };
    }

    return {
      relationId: "relation:support:negative:opposes",
      relationLabel: "opposes",
      relationFamily: "support",
      polarity: "negative",
    };
  }

  if (family === "preference") {
    if (polarity === "negative") {
      return {
        relationId: "relation:support:negative:opposes",
        relationLabel: "opposes",
        relationFamily: "support",
        polarity: "negative",
      };
    }

    if (polarity === "neutral") {
      return {
        relationId: "relation:uncertainty:neutral:uncertain_about",
        relationLabel: "uncertain about",
        relationFamily: "uncertainty",
        polarity: "neutral",
      };
    }

    return {
      relationId: "relation:preference:positive:prefers",
      relationLabel: "prefers",
      relationFamily: "preference",
      polarity: "positive",
    };
  }

  if (family === "sentiment") {
    if (polarity === "positive") {
      return {
        relationId: "relation:sentiment:positive:positive_toward",
        relationLabel: "positive toward",
        relationFamily: "sentiment",
        polarity: "positive",
      };
    }

    if (polarity === "negative") {
      return {
        relationId: "relation:sentiment:negative:negative_toward",
        relationLabel: "negative toward",
        relationFamily: "sentiment",
        polarity: "negative",
      };
    }
  }

  return {
    relationId: "relation:uncertainty:neutral:uncertain_about",
    relationLabel: "uncertain about",
    relationFamily: "uncertainty",
    polarity: "neutral",
  };
}

async function resolveSubject(input: SubjectResolverInput): Promise<ResolvedSubject> {
  const normalizedLabel = normalizeText(input.label);
  const normalizedAliases = dedupeStrings(input.aliases ?? []).map((alias) => normalizeText(alias));
  const canonicalId = buildSubjectCanonicalId(input);
  const exactMust = compact([
    { key: "entryKind", match: { value: "subject" } },
    { key: "subjectKind", match: { value: input.kind } },
    { key: "normalizedLabel", match: { value: normalizedLabel } },
    input.topicCanonicalId ? { key: "topicCanonicalId", match: { value: input.topicCanonicalId } } : null,
  ]);

  const exactHits = await qdrantClient.scroll(registryCollectionName(), {
    limit: 1,
    filter: { must: exactMust },
    with_payload: true,
    with_vector: false,
  });

  if (exactHits.points.length > 0) {
    const point = exactHits.points[0];

      return {
        entryKind: "subject",
        canonicalId: String(point.payload?.canonicalId ?? canonicalId),
        label: String(point.payload?.canonicalLabel ?? input.label),
        kind: input.kind,
        topicCanonicalId: typeof point.payload?.topicCanonicalId === "string" ? point.payload.topicCanonicalId : undefined,
        aliases: Array.isArray(point.payload?.aliases) ? point.payload.aliases.map(String) : undefined,
        matchType: "exact",
        matchScore: 1,
      };
  }

  if (normalizedAliases.length > 0) {
    const aliasHits = await qdrantClient.scroll(registryCollectionName(), {
      limit: 1,
      filter: {
        must: compact([
          { key: "entryKind", match: { value: "subject" } },
          { key: "subjectKind", match: { value: input.kind } },
          input.topicCanonicalId ? { key: "topicCanonicalId", match: { value: input.topicCanonicalId } } : null,
        ]),
        should: normalizedAliases.map((alias) => ({ key: "aliasesNormalized", match: { value: alias } })),
      },
      with_payload: true,
      with_vector: false,
    });

    if (aliasHits.points.length > 0) {
      const point = aliasHits.points[0];

      return {
        entryKind: "subject",
        canonicalId: String(point.payload?.canonicalId ?? canonicalId),
        label: String(point.payload?.canonicalLabel ?? input.label),
        kind: input.kind,
        topicCanonicalId: typeof point.payload?.topicCanonicalId === "string" ? point.payload.topicCanonicalId : undefined,
        aliases: Array.isArray(point.payload?.aliases) ? point.payload.aliases.map(String) : undefined,
        matchType: "exact",
        matchScore: 1,
      };
    }
  }

  const vectorInput = input.topicCanonicalId
    ? `${input.kind} ${input.label} ${input.topicCanonicalId}`
    : `${input.kind} ${input.label}`;
  const vector = await textToVector(vectorInput);
  const vectorMust = compact([
    { key: "entryKind", match: { value: "subject" } },
    { key: "subjectKind", match: { value: input.kind } },
    input.topicCanonicalId ? { key: "topicCanonicalId", match: { value: input.topicCanonicalId } } : null,
  ]);
  const vectorHits = await qdrantClient.search(registryCollectionName(), {
    vector,
    limit: 3,
    with_payload: true,
    filter: { must: vectorMust },
  });

  const acceptedVectorHit = vectorHits.find((point) =>
    acceptsConservativeVectorMatch({
      kind: input.kind,
      score: Number(point.score),
      inputLabel: input.label,
      inputAliases: input.aliases,
      candidateLabel: String(point.payload?.canonicalLabel ?? input.label),
      candidateAliases: toStringArray(point.payload?.aliases),
    }),
  );

  if (acceptedVectorHit) {
    const point = acceptedVectorHit;

    return {
      entryKind: "subject",
      canonicalId: String(point.payload?.canonicalId ?? canonicalId),
      label: String(point.payload?.canonicalLabel ?? input.label),
      kind: input.kind,
      topicCanonicalId: typeof point.payload?.topicCanonicalId === "string" ? point.payload.topicCanonicalId : undefined,
      aliases: Array.isArray(point.payload?.aliases) ? point.payload.aliases.map(String) : undefined,
      matchType: "vector",
      matchScore: Number(point.score),
    };
  }

  const aliases = dedupeStrings([input.label, ...(input.aliases ?? [])]);
  await qdrantClient.upsert(registryCollectionName(), {
    wait: true,
    points: [
      {
        id: buildQdrantRegistryPointId(canonicalId),
        vector,
        payload: {
          entryKind: "subject",
          canonicalId,
          subjectKind: input.kind,
          canonicalLabel: input.label,
          normalizedLabel,
          ...(input.topicCanonicalId ? { topicCanonicalId: input.topicCanonicalId } : {}),
          aliases,
          aliasesNormalized: aliases.map((alias) => normalizeText(alias)),
          exampleVotes: [],
        },
      },
    ],
  });

    return {
      entryKind: "subject",
      canonicalId,
      label: input.label,
      kind: input.kind,
      topicCanonicalId: input.topicCanonicalId,
      aliases,
      matchType: "created",
    };
}

function buildSubjectLookupKey(kind: SubjectKind, label: string, topicCanonicalId?: string): string {
  return [kind, normalizeText(label), topicCanonicalId ?? ""].join("::");
}

function normalizeIntensityBand(value: unknown): IntensityBand {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "weak" || normalized === "medium" || normalized === "strong") {
    return normalized;
  }

  return "medium";
}

function normalizeBaseIntensityContribution(value: unknown, band: IntensityBand): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  return intensityBandToContribution(band);
}

export async function resolveSemanticRegistry(args: {
  vote: RawVote;
  semantics: InferredSemantics;
  pollTemplate?: PollSemanticTemplate;
}): Promise<RegistryResolution> {
  const subjectCache = new Map<string, ResolvedSubject>();
  const resolvedAssertions: ResolvedAssertion[] = [];

  for (const assertion of args.semantics.assertions) {
    const relation = canonicalizeRelation({
      relationFamily: assertion.relationFamily,
      polarity: assertion.polarity,
    });
    if (!relation) {
      continue;
    }

    const aboutTopic =
      assertion.aboutTopicLabel
        ? subjectCache.get(buildSubjectLookupKey("topic", assertion.aboutTopicLabel)) ??
          (await resolveSubject({
            kind: "topic",
            label: assertion.aboutTopicLabel,
            aliases:
              args.pollTemplate && normalizeText(args.pollTemplate.canonicalTopic.label) === normalizeText(assertion.aboutTopicLabel)
                ? args.pollTemplate.canonicalTopic.aliases
                : undefined,
          }))
        : null;

    if (aboutTopic) {
      subjectCache.set(buildSubjectLookupKey("topic", aboutTopic.label), aboutTopic);
    }

    const targetTopicCanonicalId = assertion.targetKind === "position" ? aboutTopic?.canonicalId : undefined;
    const targetKey = buildSubjectLookupKey(assertion.targetKind, assertion.targetLabel, targetTopicCanonicalId);
    const target =
      subjectCache.get(targetKey) ??
      (await resolveSubject({
        kind: assertion.targetKind,
        label: assertion.targetLabel,
        topicCanonicalId: targetTopicCanonicalId,
        aliases: args.pollTemplate?.options.find(
          (option) => option.canonicalTargetLabel === assertion.targetLabel && option.targetKind === assertion.targetKind,
        )?.aliases,
      }));
    subjectCache.set(targetKey, target);

    resolvedAssertions.push({
      assertionSignature: buildAssertionSignature({
        userId: args.vote.voter.externalAccountId,
        relationId: relation.relationId,
        targetSubjectId: target.canonicalId,
        aboutTopicId: aboutTopic?.canonicalId ?? null,
      }),
      relationId: relation.relationId,
      relationLabel: relation.relationLabel,
      relationFamily: relation.relationFamily,
      polarity: relation.polarity,
      target,
      aboutTopic,
      assertionGroupKey: buildAssertionGroupKey({
        userId: args.vote.voter.externalAccountId,
        relationFamily: relation.relationFamily,
        targetSubjectId: target.canonicalId,
        aboutTopicId: aboutTopic?.canonicalId ?? null,
      }),
      intensityBand: normalizeIntensityBand(assertion.intensityBand),
      baseIntensityContribution: normalizeBaseIntensityContribution(
        assertion.baseIntensityContribution,
        normalizeIntensityBand(assertion.intensityBand),
      ),
      confidence: clampConfidence(assertion.confidence),
      notes: dedupeStrings(assertion.notes),
    });
  }

  const dedupedAssertions = Array.from(
    resolvedAssertions.reduce<Map<string, ResolvedAssertion>>((map, assertion) => {
      if (!map.has(assertion.assertionSignature)) {
        map.set(assertion.assertionSignature, assertion);
      }
      return map;
    }, new Map()),
  ).map((entry) => entry[1]);

  return {
    resolvedSubjects: Array.from(subjectCache.values()),
    resolvedAssertions: dedupedAssertions,
  };
}

export async function ensureResolvedRegistryEntry(entry: ResolvedSubject | null | undefined): Promise<void> {
  if (!entry) {
    return;
  }

  const vector = await textToVector(
    entry.topicCanonicalId ? `${entry.kind} ${entry.label} ${entry.topicCanonicalId}` : `${entry.kind} ${entry.label}`,
  );
  await qdrantClient.upsert(registryCollectionName(), {
    wait: true,
    points: [
      {
        id: buildQdrantRegistryPointId(entry.canonicalId),
        vector,
        payload: {
          entryKind: "subject",
          canonicalId: entry.canonicalId,
          subjectKind: entry.kind,
          canonicalLabel: entry.label,
          normalizedLabel: normalizeText(entry.label),
          ...(entry.topicCanonicalId ? { topicCanonicalId: entry.topicCanonicalId } : {}),
          aliases: dedupeStrings([entry.label, ...(entry.aliases ?? [])]),
          aliasesNormalized: dedupeStrings([entry.label, ...(entry.aliases ?? [])]).map((alias) => normalizeText(alias)),
          exampleVotes: [],
        },
      },
    ],
  });
}

export async function ensureResolvedRegistryEntries(args: { subjects?: ResolvedSubject[] }): Promise<void> {
  for (const subject of args.subjects ?? []) {
    await ensureResolvedRegistryEntry(subject);
  }
}

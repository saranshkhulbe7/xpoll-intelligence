import { createHash } from "node:crypto";
import { config } from "../config";
import { qdrantClient } from "../db/qdrant";
import type {
  ImportStage,
  PollSemanticTemplate,
  ProcessingStatus,
  RawVote,
  RawEvidenceSnapshot,
  ResolvedAssertion,
  ResolvedSubject,
  ResolvedVoteArtifact,
  VoteSourceDescriptor,
} from "../types";
import { buildArtifactFingerprint } from "./importStateMachine";

const PROGRESS_VECTOR = [0];

function nowIso(): string {
  return new Date().toISOString();
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function serializeRecord(record: ResolvedVoteArtifact): ResolvedVoteArtifact {
  return JSON.parse(JSON.stringify(record)) as ResolvedVoteArtifact;
}

function serializeReplayData(record: ResolvedVoteArtifact): string {
  return JSON.stringify({
    resolvedSubjects: record.resolvedSubjects ?? [],
    resolvedAssertions: record.resolvedAssertions ?? [],
  });
}

function deserializeRecord(value: unknown): ResolvedVoteArtifact | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;

  return {
    processingKey: String(record.processingKey ?? ""),
    sourceRunKey: String(record.sourceRunKey ?? ""),
    sourcePath: String(record.sourcePath ?? ""),
    sourceIndex: Number(record.sourceIndex ?? 0),
    voteId: String(record.voteId ?? ""),
    pollKey: toOptionalString(record.pollKey),
    pollFingerprint: toOptionalString(record.pollFingerprint),
    artifactFingerprint: toOptionalString(record.artifactFingerprint),
    rawEvidence: (record.rawEvidence as RawEvidenceSnapshot | undefined) ?? undefined,
    pollTemplate: (record.pollTemplate as PollSemanticTemplate | undefined) ?? undefined,
    semantics: (record.semantics as ResolvedVoteArtifact["semantics"]) ?? undefined,
    resolvedSubjects: Array.isArray(record.resolvedSubjects)
      ? (record.resolvedSubjects as ResolvedSubject[])
      : undefined,
    resolvedAssertions: Array.isArray(record.resolvedAssertions)
      ? (record.resolvedAssertions as ResolvedAssertion[])
      : undefined,
    qdrantStatus: (record.qdrantStatus as ResolvedVoteArtifact["qdrantStatus"]) ?? "pending",
    neo4jStatus: (record.neo4jStatus as ResolvedVoteArtifact["neo4jStatus"]) ?? "pending",
    finalStatus: (record.finalStatus as ResolvedVoteArtifact["finalStatus"]) ?? "pending",
    processingStatus: (record.processingStatus as ProcessingStatus | undefined) ?? undefined,
    attemptCount: Number(record.attemptCount ?? 0),
    startedAt: toOptionalString(record.startedAt),
    qdrantCompletedAt: toOptionalString(record.qdrantCompletedAt),
    neo4jCompletedAt: toOptionalString(record.neo4jCompletedAt),
    completedAt: toOptionalString(record.completedAt),
    lastErrorStage: (record.lastErrorStage as ImportStage | undefined) ?? undefined,
    lastErrorMessage: toOptionalString(record.lastErrorMessage),
    lastUpdatedAt: String(record.lastUpdatedAt ?? nowIso()),
  };
}

export function buildQdrantProgressPointId(processingKey: string): string {
  const hex = createHash("sha256").update(processingKey).digest("hex").slice(0, 32).split("");
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

export function buildProcessingKey(sourceRunKey: string, voteId: string): string {
  return `${sourceRunKey}::${voteId}`;
}

export function createPendingArtifact(args: {
  source: VoteSourceDescriptor;
  sourceIndex: number;
  voteId: string;
  attemptCount: number;
}): ResolvedVoteArtifact {
  const timestamp = nowIso();

  return {
    processingKey: buildProcessingKey(args.source.sourceRunKey, args.voteId),
    sourceRunKey: args.source.sourceRunKey,
    sourcePath: args.source.sourcePath,
    sourceIndex: args.sourceIndex,
    voteId: args.voteId,
    qdrantStatus: "pending",
    neo4jStatus: "pending",
    finalStatus: "pending",
    attemptCount: args.attemptCount,
    startedAt: timestamp,
    lastUpdatedAt: timestamp,
  };
}

export function attachResolvedData(
  record: ResolvedVoteArtifact,
  args: {
    rawEvidence?: RawEvidenceSnapshot;
    pollTemplate?: PollSemanticTemplate;
    semantics: ResolvedVoteArtifact["semantics"];
    resolvedSubjects: ResolvedSubject[];
    resolvedAssertions: ResolvedAssertion[];
  },
): ResolvedVoteArtifact {
  const nextRecord: ResolvedVoteArtifact = {
    ...record,
    rawEvidence: args.rawEvidence ?? record.rawEvidence,
    pollKey: args.pollTemplate?.pollKey ?? record.pollKey,
    pollFingerprint: args.pollTemplate?.pollFingerprint ?? record.pollFingerprint,
    pollTemplate: args.pollTemplate ?? record.pollTemplate,
    semantics: args.semantics,
    resolvedSubjects: args.resolvedSubjects,
    resolvedAssertions: args.resolvedAssertions,
    lastErrorStage: undefined,
    lastErrorMessage: undefined,
    lastUpdatedAt: nowIso(),
  };

  nextRecord.artifactFingerprint = buildArtifactFingerprint({
    processingKey: nextRecord.processingKey,
      sourceRunKey: nextRecord.sourceRunKey,
      sourcePath: nextRecord.sourcePath,
      sourceIndex: nextRecord.sourceIndex,
      voteId: nextRecord.voteId,
      pollKey: nextRecord.pollKey,
      pollFingerprint: nextRecord.pollFingerprint,
      rawEvidence: nextRecord.rawEvidence,
      pollTemplate: nextRecord.pollTemplate,
      semantics: nextRecord.semantics,
      resolvedSubjects: nextRecord.resolvedSubjects ?? [],
      resolvedAssertions: nextRecord.resolvedAssertions ?? [],
  });

  return nextRecord;
}

export function attachRawEvidence(
  record: ResolvedVoteArtifact,
  rawEvidence: RawEvidenceSnapshot,
): ResolvedVoteArtifact {
  const nextRecord: ResolvedVoteArtifact = {
    ...record,
    rawEvidence,
  };

  if (nextRecord.semantics && Array.isArray(nextRecord.resolvedSubjects) && Array.isArray(nextRecord.resolvedAssertions)) {
    nextRecord.artifactFingerprint = buildArtifactFingerprint({
      processingKey: nextRecord.processingKey,
      sourceRunKey: nextRecord.sourceRunKey,
      sourcePath: nextRecord.sourcePath,
      sourceIndex: nextRecord.sourceIndex,
      voteId: nextRecord.voteId,
      pollKey: nextRecord.pollKey,
      pollFingerprint: nextRecord.pollFingerprint,
      rawEvidence: nextRecord.rawEvidence,
      pollTemplate: nextRecord.pollTemplate,
      semantics: nextRecord.semantics,
      resolvedSubjects: nextRecord.resolvedSubjects,
      resolvedAssertions: nextRecord.resolvedAssertions,
    });
  }

  return nextRecord;
}

export function markQdrantDone(record: ResolvedVoteArtifact): ResolvedVoteArtifact {
  const timestamp = nowIso();

  return {
    ...record,
    qdrantStatus: "done",
    processingStatus: undefined,
    qdrantCompletedAt: timestamp,
    lastErrorStage: undefined,
    lastErrorMessage: undefined,
    lastUpdatedAt: timestamp,
  };
}

export function markNeo4jDone(record: ResolvedVoteArtifact): ResolvedVoteArtifact {
  const timestamp = nowIso();

  return {
    ...record,
    neo4jStatus: "done",
    processingStatus: undefined,
    neo4jCompletedAt: timestamp,
    lastErrorStage: undefined,
    lastErrorMessage: undefined,
    lastUpdatedAt: timestamp,
  };
}

export function markCompleted(record: ResolvedVoteArtifact): ResolvedVoteArtifact {
  const timestamp = nowIso();

  return {
    ...record,
    finalStatus: "done",
    processingStatus: "completed",
    completedAt: record.completedAt ?? timestamp,
    lastErrorStage: undefined,
    lastErrorMessage: undefined,
    lastUpdatedAt: timestamp,
  };
}

export function markRetryableFailure(
  record: ResolvedVoteArtifact,
  stage: ImportStage,
  error: unknown,
): ResolvedVoteArtifact {
  return {
    ...record,
    processingStatus: "failed_retryable",
    finalStatus: record.finalStatus === "done" ? "done" : "failed",
    lastErrorStage: stage,
    lastErrorMessage: error instanceof Error ? error.message : String(error),
    lastUpdatedAt: nowIso(),
  };
}

export function markSkippedTerminal(record: ResolvedVoteArtifact, reason: string): ResolvedVoteArtifact {
  const timestamp = nowIso();

  return {
    ...record,
    qdrantStatus: "done",
    neo4jStatus: "done",
    finalStatus: "done",
    processingStatus: "skipped_terminal",
    completedAt: timestamp,
    lastErrorStage: "validation",
    lastErrorMessage: reason,
    lastUpdatedAt: timestamp,
  };
}

export function markConflict(record: ResolvedVoteArtifact, reason: string): ResolvedVoteArtifact {
  return {
    ...record,
    processingStatus: "conflict",
    finalStatus: "failed",
    lastErrorStage: "reconcile",
    lastErrorMessage: reason,
    lastUpdatedAt: nowIso(),
  };
}

export async function getQdrantImportState(processingKey: string): Promise<ResolvedVoteArtifact | null> {
  const points = await qdrantClient.retrieve(config.qdrant.progressCollectionName, {
    ids: [buildQdrantProgressPointId(processingKey)],
    with_payload: true,
    with_vector: false,
  });

  const point = points[0];
  if (!point?.payload) {
    return null;
  }

  const record = deserializeRecord(point.payload);
  return record;
}

export async function findQdrantPollTemplate(args: {
  pollKey: string;
  pollFingerprint: string;
}): Promise<PollSemanticTemplate | null> {
  const points = await qdrantClient.scroll(config.qdrant.progressCollectionName, {
    limit: 1,
    with_payload: true,
    with_vector: false,
    filter: {
      must: [
        { key: "pollKey", match: { value: args.pollKey } },
        { key: "pollFingerprint", match: { value: args.pollFingerprint } },
      ],
    },
  });

  const point = points.points[0];
  if (!point?.payload) {
    return null;
  }

  const record = deserializeRecord(point.payload);
  return record?.pollTemplate ?? null;
}

export async function upsertQdrantImportState(record: ResolvedVoteArtifact): Promise<void> {
  await qdrantClient.upsert(config.qdrant.progressCollectionName, {
    wait: true,
    points: [
      {
        id: buildQdrantProgressPointId(record.processingKey),
        vector: PROGRESS_VECTOR,
        payload: serializeRecord(record),
      },
    ],
  });
}

export async function finalizeQdrantRecord(record: ResolvedVoteArtifact): Promise<ResolvedVoteArtifact> {
  const completedRecord = markCompleted(record);
  await upsertQdrantImportState(completedRecord);
  return completedRecord;
}

export function buildRetryableFailureRecord(args: {
  source: VoteSourceDescriptor;
  vote: RawVote;
  sourceIndex: number;
  attemptCount: number;
  stage: ImportStage;
  error: unknown;
  previous?: ResolvedVoteArtifact | null;
}): ResolvedVoteArtifact {
  const baseRecord =
    args.previous ??
    createPendingArtifact({
      source: args.source,
      sourceIndex: args.sourceIndex,
      voteId: args.vote.voteId,
      attemptCount: args.attemptCount,
    });

  return markRetryableFailure(baseRecord, args.stage, args.error);
}

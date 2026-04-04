import { createHash } from "node:crypto";
import type { ResolvedVoteArtifact } from "../types";

export type ResumeDecision =
  | { kind: "skip_completed" }
  | { kind: "skip_terminal" }
  | { kind: "mark_conflict"; reason: string }
  | { kind: "process_fresh" }
  | { kind: "write_neo4j"; artifact: ResolvedVoteArtifact }
  | { kind: "replay_qdrant"; artifact: ResolvedVoteArtifact };

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = sortKeys((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }

  return value;
}

function isReplayableArtifact(artifact: ResolvedVoteArtifact | null | undefined): artifact is ResolvedVoteArtifact {
  return Boolean(
    artifact &&
      Array.isArray(artifact.resolvedSubjects) &&
      Array.isArray(artifact.resolvedAssertions),
  );
}

export function buildArtifactFingerprint(artifact: Pick<
  ResolvedVoteArtifact,
  | "processingKey"
  | "sourceRunKey"
  | "sourcePath"
  | "sourceIndex"
  | "voteId"
  | "pollKey"
  | "pollFingerprint"
  | "rawEvidence"
  | "pollTemplate"
  | "semantics"
  | "resolvedSubjects"
  | "resolvedAssertions"
>): string {
  const stablePayload = JSON.stringify(
    sortKeys({
      processingKey: artifact.processingKey,
      sourceRunKey: artifact.sourceRunKey,
      sourcePath: artifact.sourcePath,
      sourceIndex: artifact.sourceIndex,
      voteId: artifact.voteId,
      pollKey: artifact.pollKey ?? null,
      pollFingerprint: artifact.pollFingerprint ?? null,
      rawEvidence: artifact.rawEvidence ?? null,
      pollTemplate: artifact.pollTemplate ?? null,
      semantics: artifact.semantics ?? null,
      resolvedSubjects: artifact.resolvedSubjects ?? [],
      resolvedAssertions: artifact.resolvedAssertions ?? [],
    }),
  );

  return createHash("sha256").update(stablePayload).digest("hex");
}

export function getHighestAttemptCount(records: Array<ResolvedVoteArtifact | null>): number {
  return records.reduce((highest, record) => {
    return Math.max(highest, record?.attemptCount ?? 0);
  }, 0);
}

export function chooseResumeDecision(qdrantRecord: ResolvedVoteArtifact | null): ResumeDecision {
  if (qdrantRecord?.processingStatus === "conflict") {
    return { kind: "mark_conflict", reason: "A prior run already marked this vote as conflicted." };
  }

  if (qdrantRecord?.processingStatus === "skipped_terminal") {
    return { kind: "skip_terminal" };
  }

  const qdrantCompleted =
    qdrantRecord?.qdrantStatus === "done" &&
    qdrantRecord.finalStatus === "done" &&
    qdrantRecord.processingStatus === "completed";

  if (qdrantCompleted) {
    return { kind: "skip_completed" };
  }

  const qdrantDone = qdrantRecord?.qdrantStatus === "done";

  if (qdrantDone) {
    if (!isReplayableArtifact(qdrantRecord)) {
      return {
        kind: "mark_conflict",
        reason: "Qdrant marked the vote as processed, but no replayable artifact was stored.",
      };
    }

    return {
      kind: "write_neo4j",
      artifact: qdrantRecord,
    };
  }

  if (isReplayableArtifact(qdrantRecord)) {
    return {
      kind: "replay_qdrant",
      artifact: qdrantRecord,
    };
  }

  return { kind: "process_fresh" };
}

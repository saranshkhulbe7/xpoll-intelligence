import type { ImportStage, RawEvidenceSnapshot, RawVote, ResolvedVoteArtifact, VoteSourceDescriptor } from "../types";
import {
  buildPollFingerprint,
  buildPollKey,
  buildPollTemplateContext,
  getSelectedOption,
} from "./contextBuilder";
import { ensureResolvedRegistryEntries, resolveSemanticRegistry } from "./conceptResolver";
import { writeVoteToGraph } from "./graphWriter";
import {
  attachResolvedData,
  attachRawEvidence,
  buildProcessingKey,
  buildRetryableFailureRecord,
  createPendingArtifact,
  finalizeQdrantRecord,
  findQdrantPollTemplate,
  getQdrantImportState,
  markConflict,
  markQdrantDone,
  markSkippedTerminal,
  markRetryableFailure,
  upsertQdrantImportState,
} from "./importLedger";
import { chooseResumeDecision, getHighestAttemptCount } from "./importStateMachine";
import { inferPollSemanticTemplate, materializeVoteSemantics } from "./semanticInference";
import {
  logGraphPlan,
  logLlmInput,
  logLlmOutput,
  logQdrantPlan,
  logResumeDecision,
  logVoteCompletion,
  logVoteRawInput,
} from "./voteDebug";

export type ProcessVoteResult =
  | { outcome: "completed"; record: ResolvedVoteArtifact; message: string }
  | { outcome: "skipped"; record: ResolvedVoteArtifact; message: string }
  | { outcome: "noop"; message: string }
  | { outcome: "retryable_failure"; record: ResolvedVoteArtifact; message: string }
  | { outcome: "conflict"; record: ResolvedVoteArtifact; message: string };

export type ProcessVoteDependencies = {
  buildPollFingerprint: typeof buildPollFingerprint;
  buildPollKey: typeof buildPollKey;
  buildPollTemplateContext: typeof buildPollTemplateContext;
  getSelectedOption: typeof getSelectedOption;
  ensureResolvedRegistryEntries: typeof ensureResolvedRegistryEntries;
  resolveSemanticRegistry: typeof resolveSemanticRegistry;
  writeVoteToGraph: typeof writeVoteToGraph;
  attachResolvedData: typeof attachResolvedData;
  attachRawEvidence: typeof attachRawEvidence;
  buildProcessingKey: typeof buildProcessingKey;
  buildRetryableFailureRecord: typeof buildRetryableFailureRecord;
  createPendingArtifact: typeof createPendingArtifact;
  finalizeQdrantRecord: typeof finalizeQdrantRecord;
  findQdrantPollTemplate: typeof findQdrantPollTemplate;
  getQdrantImportState: typeof getQdrantImportState;
  markConflict: typeof markConflict;
  markQdrantDone: typeof markQdrantDone;
  markSkippedTerminal: typeof markSkippedTerminal;
  markRetryableFailure: typeof markRetryableFailure;
  upsertQdrantImportState: typeof upsertQdrantImportState;
  chooseResumeDecision: typeof chooseResumeDecision;
  getHighestAttemptCount: typeof getHighestAttemptCount;
  inferPollSemanticTemplate: typeof inferPollSemanticTemplate;
  materializeVoteSemantics: typeof materializeVoteSemantics;
  logPersistenceError: (processingKey: string, error: unknown) => void;
};

export const defaultProcessVoteDependencies: ProcessVoteDependencies = {
  buildPollFingerprint,
  buildPollKey,
  buildPollTemplateContext,
  getSelectedOption,
  ensureResolvedRegistryEntries,
  resolveSemanticRegistry,
  writeVoteToGraph,
  attachResolvedData,
  attachRawEvidence,
  buildProcessingKey,
  buildRetryableFailureRecord,
  createPendingArtifact,
  finalizeQdrantRecord,
  findQdrantPollTemplate,
  getQdrantImportState,
  markConflict,
  markQdrantDone,
  markSkippedTerminal,
  markRetryableFailure,
  upsertQdrantImportState,
  chooseResumeDecision,
  getHighestAttemptCount,
  inferPollSemanticTemplate,
  materializeVoteSemantics,
  logPersistenceError: (processingKey, error) => {
    console.error(`Failed to persist ${processingKey} to Qdrant:`, error);
  },
};

const IMPORT_STAGES: ImportStage[] = [
  "openai",
  "qdrant_concepts",
  "qdrant_progress",
  "neo4j",
  "finalize_qdrant",
  "finalize_neo4j",
  "reconcile",
  "validation",
];

function coerceImportStage(value: unknown, fallback: ImportStage): ImportStage {
  return typeof value === "string" && IMPORT_STAGES.includes(value as ImportStage)
    ? (value as ImportStage)
    : fallback;
}

function buildRawEvidenceSnapshot(vote: RawVote, selectedOption: string | null): RawEvidenceSnapshot {
  return {
    voteId: vote.voteId,
    voteType: vote.type,
    selectedOption,
    voteTimestamps: vote.timestamps
      ? {
          seenAt: vote.timestamps.seenAt ?? null,
          respondedAt: vote.timestamps.respondedAt ?? null,
        }
      : undefined,
    poll: {
      pollId: vote.poll.pollId,
      title: vote.poll.title,
      description: vote.poll.description ?? null,
      createdAt: vote.poll.createdAt ?? null,
      options: vote.poll.options.map((option) => ({
        text: option.text,
        isSelected: option.isSelected,
      })),
    },
    trial: vote.trial ?? undefined,
    campaign: vote.campaign ?? undefined,
    inkdBlog: vote.inkdBlog ?? undefined,
    rawVote: vote,
  };
}

async function persistBestEffort(
  dependencies: ProcessVoteDependencies,
  record: ResolvedVoteArtifact,
): Promise<void> {
  try {
    await dependencies.upsertQdrantImportState(record);
  } catch (error) {
    dependencies.logPersistenceError(record.processingKey, error);
  }
}

async function ensureQdrantReplay(
  dependencies: ProcessVoteDependencies,
  record: ResolvedVoteArtifact,
): Promise<ResolvedVoteArtifact> {
  await dependencies.ensureResolvedRegistryEntries({
    subjects: record.resolvedSubjects,
  });

  const qdrantRecord = dependencies.markQdrantDone(record);
  await dependencies.upsertQdrantImportState(qdrantRecord);
  return qdrantRecord;
}

async function finalizeRecord(
  dependencies: ProcessVoteDependencies,
  record: ResolvedVoteArtifact,
): Promise<ResolvedVoteArtifact> {
  if (record.finalStatus === "done") {
    return record;
  }

  return dependencies.finalizeQdrantRecord(record);
}

async function persistNeo4jAndFinalize(
  dependencies: ProcessVoteDependencies,
  args: {
    vote: RawVote;
    record: ResolvedVoteArtifact;
  },
): Promise<ResolvedVoteArtifact> {
  const graphWrite = await dependencies.writeVoteToGraph({
    vote: args.vote,
    artifact: args.record,
  });

  return finalizeRecord(dependencies, graphWrite.record);
}

async function loadPollTemplate(
  dependencies: ProcessVoteDependencies,
  args: {
    vote: RawVote;
    record: ResolvedVoteArtifact;
    selectedOption: string;
  },
): Promise<NonNullable<ResolvedVoteArtifact["pollTemplate"]>> {
  const pollKey = dependencies.buildPollKey(args.vote);
  const pollFingerprint = dependencies.buildPollFingerprint(args.vote);
  const existingTemplate =
    args.record.pollTemplate &&
    args.record.pollTemplate.pollKey === pollKey &&
    args.record.pollTemplate.pollFingerprint === pollFingerprint
      ? args.record.pollTemplate
      : null;

  if (existingTemplate) {
    return existingTemplate;
  }

  const persistedTemplate = await dependencies.findQdrantPollTemplate({
    pollKey,
    pollFingerprint,
  });

  if (persistedTemplate) {
    return persistedTemplate;
  }

  const context = dependencies.buildPollTemplateContext(args.vote);
  logLlmInput({
    vote: args.vote,
    selectedOption: args.selectedOption,
    context,
  });

  return dependencies.inferPollSemanticTemplate(args.vote, context);
}

export async function processVote(args: {
  source: VoteSourceDescriptor;
  sourceIndex: number;
  vote: RawVote;
}, dependencies: ProcessVoteDependencies = defaultProcessVoteDependencies): Promise<ProcessVoteResult> {
  const { source, sourceIndex, vote } = args;
  const processingKey = dependencies.buildProcessingKey(source.sourceRunKey, vote.voteId);
  logVoteRawInput({
    vote,
    processingKey,
    sourcePath: source.sourcePath,
    sourceIndex,
  });

  let qdrantState: ResolvedVoteArtifact | null = null;

  try {
    qdrantState = await dependencies.getQdrantImportState(processingKey);
  } catch (error) {
    const failedRecord = dependencies.buildRetryableFailureRecord({
      source,
      vote,
      sourceIndex,
      attemptCount: 1,
      stage: "reconcile",
      error,
    });
    await persistBestEffort(dependencies, failedRecord);
    return {
      outcome: "retryable_failure",
      record: failedRecord,
      message: `Failed to load Qdrant progress for ${vote.voteId}: ${failedRecord.lastErrorMessage}`,
    };
  }

  const decision = dependencies.chooseResumeDecision(qdrantState);
  logResumeDecision({
    voteId: vote.voteId,
    processingKey,
    decision: decision.kind,
    qdrantState,
    reason: "reason" in decision ? decision.reason : undefined,
  });

  const attemptCount = dependencies.getHighestAttemptCount([qdrantState]) + 1;
  const currentRecord =
    qdrantState ??
    dependencies.createPendingArtifact({
      source,
      sourceIndex,
      voteId: vote.voteId,
      attemptCount,
    });
  const selectedOption = dependencies.getSelectedOption(vote);
  const recordWithRawEvidence = dependencies.attachRawEvidence(
    currentRecord,
    buildRawEvidenceSnapshot(vote, selectedOption),
  );

  if (decision.kind === "skip_completed") {
    logVoteCompletion({
      voteId: vote.voteId,
      record: recordWithRawEvidence,
      outcome: "noop",
    });
    return {
      outcome: "noop",
      message: `Skipping ${vote.voteId} because Qdrant already marked it completed.`,
    };
  }

  if (decision.kind === "skip_terminal") {
    logVoteCompletion({
      voteId: vote.voteId,
      record: recordWithRawEvidence,
      outcome: "noop",
    });
    return {
      outcome: "noop",
      message: `Skipping ${vote.voteId} because it was previously marked terminal.`,
    };
  }

  if (decision.kind === "mark_conflict") {
    const conflictRecord = dependencies.markConflict(recordWithRawEvidence, decision.reason);
    await persistBestEffort(dependencies, conflictRecord);
    logVoteCompletion({
      voteId: vote.voteId,
      record: conflictRecord,
      outcome: "conflict",
    });
    return {
      outcome: "conflict",
      record: conflictRecord,
      message: `Marked ${vote.voteId} as conflict: ${decision.reason}`,
    };
  }

  if (decision.kind === "write_neo4j") {
    const recordForNeo4j = dependencies.attachRawEvidence(
      decision.artifact,
      buildRawEvidenceSnapshot(vote, selectedOption),
    );

    try {
      logGraphPlan({
        vote,
        record: recordForNeo4j,
      });
      const finalizedRecord = await persistNeo4jAndFinalize(dependencies, {
        vote,
        record: recordForNeo4j,
      });
      logVoteCompletion({
        voteId: vote.voteId,
        record: finalizedRecord,
        outcome: "completed",
      });

      return {
        outcome: "completed",
        record: finalizedRecord,
        message: `Resumed Neo4j write for ${vote.voteId}.`,
      };
    } catch (error) {
      const stage = coerceImportStage(
        typeof error === "object" && error && "stage" in error ? error.stage : undefined,
        "neo4j",
      );
      const partialRecord =
        typeof error === "object" && error && "record" in error
          ? (error.record as ResolvedVoteArtifact)
          : recordForNeo4j;
      const failureError = typeof error === "object" && error && "error" in error ? error.error : error;
      const failedRecord = dependencies.markRetryableFailure(partialRecord, stage, failureError);
      await persistBestEffort(dependencies, failedRecord);
      logVoteCompletion({
        voteId: vote.voteId,
        record: failedRecord,
        outcome: "retryable_failure",
      });
      return {
        outcome: "retryable_failure",
        record: failedRecord,
        message: `Neo4j write failed for ${vote.voteId}: ${failedRecord.lastErrorMessage}`,
      };
    }
  }

  if (decision.kind === "replay_qdrant") {
    let replayedRecord = dependencies.attachRawEvidence(
      decision.artifact,
      buildRawEvidenceSnapshot(vote, selectedOption),
    );

    try {
      replayedRecord = await ensureQdrantReplay(dependencies, replayedRecord);
      logQdrantPlan({
        voteId: vote.voteId,
        record: replayedRecord,
      });
    } catch (error) {
      const failedRecord = dependencies.markRetryableFailure(replayedRecord, "qdrant_concepts", error);
      await persistBestEffort(dependencies, failedRecord);
      logVoteCompletion({
        voteId: vote.voteId,
        record: failedRecord,
        outcome: "retryable_failure",
      });
      return {
        outcome: "retryable_failure",
        record: failedRecord,
        message: `Qdrant replay failed for ${vote.voteId}: ${failedRecord.lastErrorMessage}`,
      };
    }

    try {
      if (replayedRecord.neo4jStatus !== "done") {
        logGraphPlan({
          vote,
          record: replayedRecord,
        });
        replayedRecord = await persistNeo4jAndFinalize(dependencies, {
          vote,
          record: replayedRecord,
        });
      } else {
        replayedRecord = await finalizeRecord(dependencies, replayedRecord);
      }

      logVoteCompletion({
        voteId: vote.voteId,
        record: replayedRecord,
        outcome: "completed",
      });

      return {
        outcome: "completed",
        record: replayedRecord,
        message: `Replayed Qdrant state for ${vote.voteId}.`,
      };
    } catch (error) {
      const stage = coerceImportStage(
        typeof error === "object" && error && "stage" in error ? error.stage : undefined,
        replayedRecord.neo4jStatus === "done" ? "finalize_qdrant" : "neo4j",
      );
      const partialRecord =
        typeof error === "object" && error && "record" in error
          ? (error.record as ResolvedVoteArtifact)
          : replayedRecord;
      const failureError = typeof error === "object" && error && "error" in error ? error.error : error;
      const failedRecord = dependencies.markRetryableFailure(partialRecord, stage, failureError);
      await persistBestEffort(dependencies, failedRecord);
      logVoteCompletion({
        voteId: vote.voteId,
        record: failedRecord,
        outcome: "retryable_failure",
      });

      return {
        outcome: "retryable_failure",
        record: failedRecord,
        message: `Replay follow-up failed for ${vote.voteId}: ${failedRecord.lastErrorMessage}`,
      };
    }
  }

  if (!selectedOption) {
    const skippedRecord = dependencies.markSkippedTerminal(recordWithRawEvidence, "No selected option was found.");
    await persistBestEffort(dependencies, skippedRecord);
    logVoteCompletion({
      voteId: vote.voteId,
      record: skippedRecord,
      outcome: "skipped",
    });
    return {
      outcome: "skipped",
      record: skippedRecord,
      message: `Skipped ${vote.voteId} because no selected option was found.`,
    };
  }

  let record = recordWithRawEvidence;
  let pollTemplate: NonNullable<ResolvedVoteArtifact["pollTemplate"]>;

  try {
    pollTemplate = await loadPollTemplate(dependencies, {
      vote,
      record,
      selectedOption,
    });
  } catch (error) {
    const failedRecord = dependencies.buildRetryableFailureRecord({
      source,
      vote,
      sourceIndex,
      attemptCount,
      stage: "openai",
      error,
      previous: record,
    });
    await persistBestEffort(dependencies, failedRecord);
    logVoteCompletion({
      voteId: vote.voteId,
      record: failedRecord,
      outcome: "retryable_failure",
    });
    return {
      outcome: "retryable_failure",
      record: failedRecord,
      message: `Poll template generation failed for ${vote.voteId}: ${failedRecord.lastErrorMessage}`,
    };
  }

  let semantics: ResolvedVoteArtifact["semantics"];
  try {
    semantics = dependencies.materializeVoteSemantics({
      vote,
      selectedOption,
      template: pollTemplate,
    });
    logLlmOutput({
      voteId: vote.voteId,
      semantics,
      pollTemplate,
    });
  } catch (error) {
    const failedRecord = dependencies.buildRetryableFailureRecord({
      source,
      vote,
      sourceIndex,
      attemptCount,
      stage: "validation",
      error,
      previous: record,
    });
    await persistBestEffort(dependencies, failedRecord);
    logVoteCompletion({
      voteId: vote.voteId,
      record: failedRecord,
      outcome: "retryable_failure",
    });
    return {
      outcome: "retryable_failure",
      record: failedRecord,
      message: `Poll template mapping failed for ${vote.voteId}: ${failedRecord.lastErrorMessage}`,
    };
  }

  try {
    const { resolvedSubjects, resolvedAssertions } = await dependencies.resolveSemanticRegistry({
      vote,
      semantics,
      pollTemplate,
    });
    record = dependencies.attachResolvedData(record, {
      rawEvidence: record.rawEvidence,
      pollTemplate,
      semantics,
      resolvedSubjects,
      resolvedAssertions,
    });
    logQdrantPlan({
      voteId: vote.voteId,
      record,
    });
  } catch (error) {
    const failedRecord = dependencies.markRetryableFailure(record, "qdrant_concepts", error);
    await persistBestEffort(dependencies, failedRecord);
    logVoteCompletion({
      voteId: vote.voteId,
      record: failedRecord,
      outcome: "retryable_failure",
    });
    return {
      outcome: "retryable_failure",
      record: failedRecord,
      message: `Concept resolution failed for ${vote.voteId}: ${failedRecord.lastErrorMessage}`,
    };
  }

  try {
    record = dependencies.markQdrantDone(record);
    await dependencies.upsertQdrantImportState(record);
  } catch (error) {
    const failedRecord = dependencies.markRetryableFailure(record, "qdrant_progress", error);
    await persistBestEffort(dependencies, failedRecord);
    logVoteCompletion({
      voteId: vote.voteId,
      record: failedRecord,
      outcome: "retryable_failure",
    });
    return {
      outcome: "retryable_failure",
      record: failedRecord,
      message: `Qdrant progress persistence failed for ${vote.voteId}: ${failedRecord.lastErrorMessage}`,
    };
  }

  try {
    logGraphPlan({
      vote,
      record,
    });
    record = await persistNeo4jAndFinalize(dependencies, {
      vote,
      record,
    });
    logVoteCompletion({
      voteId: vote.voteId,
      record,
      outcome: "completed",
    });

    return {
      outcome: "completed",
      record,
      message: `Processed ${vote.voteId}.`,
    };
  } catch (error) {
    const stage = coerceImportStage(
      typeof error === "object" && error && "stage" in error ? error.stage : undefined,
      "neo4j",
    );
    const partialRecord =
      typeof error === "object" && error && "record" in error ? (error.record as ResolvedVoteArtifact) : record;
    const failureError = typeof error === "object" && error && "error" in error ? error.error : error;
    const failedRecord = dependencies.markRetryableFailure(partialRecord, stage, failureError);
    await persistBestEffort(dependencies, failedRecord);
    logVoteCompletion({
      voteId: vote.voteId,
      record: failedRecord,
      outcome: "retryable_failure",
    });

    return {
      outcome: "retryable_failure",
      record: failedRecord,
      message: `Neo4j write failed for ${vote.voteId}: ${failedRecord.lastErrorMessage}`,
    };
  }
}

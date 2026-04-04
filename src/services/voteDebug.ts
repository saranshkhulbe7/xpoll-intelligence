import type {
  PollSemanticTemplate,
  RawVote,
  ResolvedAssertion,
  ResolvedSubject,
  ResolvedVoteArtifact,
} from "../types";
import { getSelectedOption } from "./contextBuilder";

type ResumeDecisionDebug =
  | "skip_completed"
  | "skip_terminal"
  | "mark_conflict"
  | "process_fresh"
  | "write_neo4j"
  | "replay_qdrant";

function nowIso(): string {
  return new Date().toISOString();
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function logDebugEnvelope(voteId: string, stage: string, payload: unknown): void {
  console.log(serialize({
    timestamp: nowIso(),
    type: "vote_debug",
    voteId,
    stage,
    payload,
  }));
}

function buildRegistryAction(entry: ResolvedSubject): {
  canonicalId: string;
  label: string;
  entryKind: "subject";
  kind: string;
  matchType: string;
  matchScore?: number;
  qdrantAction: string;
} {
  const qdrantAction =
    entry.matchType === "exact"
      ? "reuse the exact existing Qdrant subject"
      : entry.matchType === "vector"
        ? "reuse the closest existing Qdrant subject from vector search"
        : "create a new Qdrant subject";

  return {
    canonicalId: entry.canonicalId,
    label: entry.label,
    entryKind: "subject",
    kind: entry.kind,
    matchType: entry.matchType,
    matchScore: entry.matchScore,
    qdrantAction,
  };
}

export function logVoteRawInput(args: {
  vote: RawVote;
  processingKey: string;
  sourcePath: string;
  sourceIndex: number;
}): void {
  logDebugEnvelope(args.vote.voteId, "raw_vote", {
    processingKey: args.processingKey,
    sourcePath: args.sourcePath,
    sourceIndex: args.sourceIndex,
    rawVote: args.vote,
  });
}

export function logResumeDecision(args: {
  voteId: string;
  processingKey: string;
  decision: ResumeDecisionDebug;
  qdrantState: ResolvedVoteArtifact | null;
  reason?: string;
}): void {
  logDebugEnvelope(args.voteId, "resume_decision", {
    processingKey: args.processingKey,
    decision: args.decision,
    reason: args.reason ?? null,
    qdrantState: args.qdrantState
      ? {
          processingStatus: args.qdrantState.processingStatus ?? null,
          qdrantStatus: args.qdrantState.qdrantStatus,
          neo4jStatus: args.qdrantState.neo4jStatus,
          finalStatus: args.qdrantState.finalStatus,
          attemptCount: args.qdrantState.attemptCount,
        }
      : null,
  });
}

export function logLlmInput(args: {
  vote: RawVote;
  selectedOption: string | null;
  context: string;
}): void {
  logDebugEnvelope(args.vote.voteId, "llm_input", {
    selectedOption: args.selectedOption,
    context: args.context,
  });
}

export function logLlmOutput(args: {
  voteId: string;
  semantics: ResolvedVoteArtifact["semantics"];
  pollTemplate?: PollSemanticTemplate;
}): void {
  logDebugEnvelope(args.voteId, "llm_output", {
    pollTemplate: args.pollTemplate ?? null,
    semantics: args.semantics,
  });
}

export function logQdrantPlan(args: {
  voteId: string;
  record: ResolvedVoteArtifact;
}): void {
  logDebugEnvelope(args.voteId, "qdrant_plan", {
    registry: {
      subjects: (args.record.resolvedSubjects ?? []).map(buildRegistryAction),
    },
    assertions: (args.record.resolvedAssertions ?? []).map((assertion) => ({
      assertionSignature: assertion.assertionSignature,
      relationId: assertion.relationId,
      relationLabel: assertion.relationLabel,
      relationFamily: assertion.relationFamily,
      polarity: assertion.polarity,
      targetSubjectId: assertion.target.canonicalId,
      aboutTopicId: assertion.aboutTopic?.canonicalId ?? null,
    })),
    progressLedger: {
      processingKey: args.record.processingKey,
      qdrantStatus: args.record.qdrantStatus,
      neo4jStatus: args.record.neo4jStatus,
      finalStatus: args.record.finalStatus,
      attemptCount: args.record.attemptCount,
      artifactFingerprint: args.record.artifactFingerprint ?? null,
    },
    rawEvidence: args.record.rawEvidence ?? null,
  });
}

function describeSubject(subject: ResolvedSubject | null | undefined): { canonicalId: string; label: string; kind: string } | null {
  if (!subject) {
    return null;
  }

  return {
    canonicalId: subject.canonicalId,
    label: subject.label,
    kind: subject.kind,
  };
}

function describeAssertion(assertion: ResolvedAssertion): unknown {
  return {
    assertionSignature: assertion.assertionSignature,
    relation: {
      relationId: assertion.relationId,
      relationLabel: assertion.relationLabel,
      relationFamily: assertion.relationFamily,
      polarity: assertion.polarity,
    },
    target: describeSubject(assertion.target),
    aboutTopic: describeSubject(assertion.aboutTopic),
    confidence: assertion.confidence,
    notes: assertion.notes,
  };
}

export function logGraphPlan(args: {
  vote: RawVote;
  record: ResolvedVoteArtifact;
}): void {
  const selectedOption = args.record.rawEvidence?.selectedOption ?? getSelectedOption(args.vote);

  logDebugEnvelope(args.vote.voteId, "neo4j_plan", {
    semanticLayer: {
      user: {
        externalAccountId: args.vote.voter.externalAccountId,
        username: args.vote.voter.username ?? null,
      },
      subjects: (args.record.resolvedSubjects ?? []).map((subject) => describeSubject(subject)),
      assertions: (args.record.resolvedAssertions ?? []).map(describeAssertion),
    },
    assertionMetadata: {
      evidenceSummary: {
        voteId: args.vote.voteId,
        voteType: args.vote.type,
        selectedOption,
        pollId: args.vote.poll.pollId,
        pollTitle: args.vote.poll.title,
        sourcePath: args.record.sourcePath,
      },
      rawEvidenceStoredIn: "Qdrant progress metadata",
    },
    relationships: [
      ...(args.record.resolvedAssertions ?? []).flatMap((assertion) => [
        { from: "User", type: "MADE_ASSERTION", to: "Assertion", assertionSignature: assertion.assertionSignature },
        { from: "Assertion", type: "TARGETS", to: assertion.target.kind, assertionSignature: assertion.assertionSignature },
        ...(assertion.aboutTopic
          ? [{ from: "Assertion", type: "ABOUT", to: "Topic", assertionSignature: assertion.assertionSignature }]
          : []),
      ]),
    ],
  });
}

export function logVoteCompletion(args: {
  voteId: string;
  record: ResolvedVoteArtifact;
  outcome: string;
}): void {
  logDebugEnvelope(args.voteId, "vote_completion", {
    outcome: args.outcome,
    qdrantStatus: args.record.qdrantStatus,
    neo4jStatus: args.record.neo4jStatus,
    finalStatus: args.record.finalStatus,
    processingStatus: args.record.processingStatus ?? null,
    attemptCount: args.record.attemptCount,
  });
}

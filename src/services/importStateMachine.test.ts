import { describe, expect, test } from "bun:test";
import type {
  InferredSemantics,
  ResolvedAssertion,
  ResolvedSubject,
  ResolvedVoteArtifact,
} from "../types";
import { buildArtifactFingerprint, chooseResumeDecision } from "./importStateMachine";

function makeSemantics(): InferredSemantics {
  return {
    assertions: [
      {
        relationFamily: "support",
        polarity: "positive",
        targetLabel: "restrict visa access",
        targetKind: "position",
        aboutTopicLabel: "immigration policy",
        confidence: 0.82,
        notes: ["derived from poll text"],
      },
    ],
    notes: ["derived from poll text"],
  };
}

function makeResolvedSubjects(): ResolvedSubject[] {
  return [
    {
      entryKind: "subject",
      canonicalId: "subject:topic:immigration_policy",
      label: "immigration policy",
      kind: "topic",
      matchType: "created",
    },
    {
      entryKind: "subject",
      canonicalId: "subject:position:subject_topic_immigration_policy__restrict_visa_access",
      label: "restrict visa access",
      kind: "position",
      topicCanonicalId: "subject:topic:immigration_policy",
      matchType: "created",
    },
  ];
}

function makeResolvedAssertions(): ResolvedAssertion[] {
  const [topic, position] = makeResolvedSubjects();

  return [
    {
      assertionSignature: "assertion_support",
      relationId: "relation:support:positive:supports",
      relationLabel: "supports",
      relationFamily: "support",
      polarity: "positive",
      target: position,
      aboutTopic: topic,
      assertionGroupKey: "assertion_group_support",
      intensityBand: "medium",
      baseIntensityContribution: 0.6,
      confidence: 0.82,
      notes: ["derived from poll text"],
    },
  ];
}

function makeReplayableRecord(overrides: Partial<ResolvedVoteArtifact> = {}): ResolvedVoteArtifact {
  const base: ResolvedVoteArtifact = {
    processingKey: "votes_test::vote-1",
    sourceRunKey: "votes_test",
    sourcePath: "/tmp/votes.json",
    sourceIndex: 0,
    voteId: "vote-1",
    semantics: makeSemantics(),
    resolvedSubjects: makeResolvedSubjects(),
    resolvedAssertions: makeResolvedAssertions(),
    qdrantStatus: "pending",
    neo4jStatus: "pending",
    finalStatus: "pending",
    attemptCount: 1,
    startedAt: "2026-04-04T00:00:00.000Z",
    lastUpdatedAt: "2026-04-04T00:00:00.000Z",
  };

  const record = { ...base, ...overrides };
  record.artifactFingerprint = buildArtifactFingerprint({
    processingKey: record.processingKey,
    sourceRunKey: record.sourceRunKey,
    sourcePath: record.sourcePath,
    sourceIndex: record.sourceIndex,
    voteId: record.voteId,
    pollKey: record.pollKey,
    pollFingerprint: record.pollFingerprint,
    rawEvidence: record.rawEvidence,
    pollTemplate: record.pollTemplate,
    semantics: record.semantics,
    resolvedSubjects: record.resolvedSubjects ?? [],
    resolvedAssertions: record.resolvedAssertions ?? [],
  });

  return record;
}

describe("chooseResumeDecision", () => {
  test("skips votes already completed in qdrant", () => {
    const completed = makeReplayableRecord({
      qdrantStatus: "done",
      neo4jStatus: "done",
      finalStatus: "done",
      processingStatus: "completed",
      completedAt: "2026-04-04T01:00:00.000Z",
    });

    expect(chooseResumeDecision(completed).kind).toBe("skip_completed");
  });

  test("replays neo4j when qdrant finished first", () => {
    const qdrantDone = makeReplayableRecord({
      qdrantStatus: "done",
      neo4jStatus: "pending",
      finalStatus: "pending",
    });

    const decision = chooseResumeDecision(qdrantDone);
    expect(decision.kind).toBe("write_neo4j");
  });

  test("marks conflicts when qdrant says done but the artifact cannot be replayed", () => {
    const broken: ResolvedVoteArtifact = {
      processingKey: "votes_test::vote-2",
      sourceRunKey: "votes_test",
      sourcePath: "/tmp/votes.json",
      sourceIndex: 1,
      voteId: "vote-2",
      qdrantStatus: "done",
      neo4jStatus: "pending",
      finalStatus: "pending",
      processingStatus: "failed_retryable",
      attemptCount: 1,
      lastUpdatedAt: "2026-04-04T00:00:00.000Z",
    };

    expect(chooseResumeDecision(broken).kind).toBe("mark_conflict");
  });

  test("never retries terminally skipped votes", () => {
    const skipped = makeReplayableRecord({
      qdrantStatus: "done",
      neo4jStatus: "done",
      finalStatus: "done",
      processingStatus: "skipped_terminal",
    });

    expect(chooseResumeDecision(skipped).kind).toBe("skip_terminal");
  });

  test("replays qdrant when a replayable artifact exists but qdrant never finished", () => {
    const pending = makeReplayableRecord({
      qdrantStatus: "pending",
      neo4jStatus: "pending",
      finalStatus: "pending",
      processingStatus: "failed_retryable",
    });

    expect(chooseResumeDecision(pending).kind).toBe("replay_qdrant");
  });

  test("falls back to fresh processing when no replayable artifact exists", () => {
    const partial: ResolvedVoteArtifact = {
      processingKey: "votes_test::vote-3",
      sourceRunKey: "votes_test",
      sourcePath: "/tmp/votes.json",
      sourceIndex: 2,
      voteId: "vote-3",
      qdrantStatus: "failed",
      neo4jStatus: "pending",
      finalStatus: "failed",
      processingStatus: "failed_retryable",
      attemptCount: 2,
      lastUpdatedAt: "2026-04-04T02:00:00.000Z",
      lastErrorStage: "openai",
      lastErrorMessage: "timeout",
    };

    expect(chooseResumeDecision(partial).kind).toBe("process_fresh");
  });
});

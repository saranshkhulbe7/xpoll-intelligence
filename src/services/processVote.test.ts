import { describe, expect, mock, test } from "bun:test";
import type { PollSemanticTemplate, RawVote, ResolvedVoteArtifact, VoteSourceDescriptor } from "../types";
import { buildArtifactFingerprint } from "./importStateMachine";
import { defaultProcessVoteDependencies, processVote } from "./importProcessor";

function createVote(): RawVote {
  return {
    voteId: "vote-1",
    type: "standalone_poll",
    voter: {
      externalAccountId: "user-1",
    },
    poll: {
      pollId: "poll-1",
      title: "Question 1",
      options: [{ text: "Yes", isSelected: true }],
    },
  };
}

function createSource(): VoteSourceDescriptor {
  return {
    sourcePath: "/tmp/votes.json",
    sourceRunKey: "votes_test",
    fileSize: 1024,
    fileMtimeMs: 1000,
  };
}

function createCompletedState(): ResolvedVoteArtifact {
  const record: ResolvedVoteArtifact = {
    processingKey: "votes_test::vote-1",
    sourceRunKey: "votes_test",
    sourcePath: "/tmp/votes.json",
    sourceIndex: 0,
    voteId: "vote-1",
    semantics: {
      assertions: [
        {
          relationFamily: "support",
          polarity: "positive",
          targetLabel: "restrict visa access",
          targetKind: "position",
          aboutTopicLabel: "immigration policy",
          confidence: 0.84,
          notes: ["derived from poll text"],
        },
      ],
      notes: ["derived from poll text"],
    },
    resolvedSubjects: [
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
    ],
    resolvedAssertions: [
      {
        assertionSignature: "assertion_support",
        relationId: "relation:support:positive:supports",
        relationLabel: "supports",
        relationFamily: "support",
        polarity: "positive",
        target: {
          entryKind: "subject",
          canonicalId: "subject:position:subject_topic_immigration_policy__restrict_visa_access",
          label: "restrict visa access",
          kind: "position",
          topicCanonicalId: "subject:topic:immigration_policy",
          matchType: "created",
        },
        aboutTopic: {
          entryKind: "subject",
          canonicalId: "subject:topic:immigration_policy",
          label: "immigration policy",
          kind: "topic",
          matchType: "created",
        },
        confidence: 0.84,
        notes: ["derived from poll text"],
      },
    ],
    qdrantStatus: "done",
    neo4jStatus: "done",
    finalStatus: "done",
    processingStatus: "completed",
    attemptCount: 1,
    startedAt: "2026-04-04T00:00:00.000Z",
    completedAt: "2026-04-04T01:00:00.000Z",
    lastUpdatedAt: "2026-04-04T01:00:00.000Z",
  };

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

describe("processVote", () => {
  test("skips already-completed votes without calling the graph writer again", async () => {
    const completedState = createCompletedState();
    const writeVoteToGraph = mock(async () => {
      throw new Error("writeVoteToGraph should not run for completed votes");
    });

    const result = await processVote(
      {
        source: createSource(),
        sourceIndex: 0,
        vote: createVote(),
      },
      {
        ...defaultProcessVoteDependencies,
        getQdrantImportState: async () => completedState,
        writeVoteToGraph,
      },
    );

    expect(result.outcome).toBe("noop");
    expect(writeVoteToGraph).not.toHaveBeenCalled();
  });

  test("stores a raw evidence snapshot in the Qdrant progress record for fresh votes", async () => {
    const qdrantWrites: ResolvedVoteArtifact[] = [];
    const pollTemplate: PollSemanticTemplate = {
      pollKey: "poll:poll-2",
      pollFingerprint: "poll-fingerprint-2",
      canonicalTopic: {
        label: "healthcare policy",
        aliases: ["healthcare"],
      },
      options: [
        {
          optionText: "Create a public healthcare plan",
          canonicalTargetLabel: "public healthcare plan",
          targetKind: "position",
          relationFamily: "support",
          polarity: "positive",
          aliases: ["national public healthcare plan"],
          notes: ["selected option supports a public plan"],
        },
        {
          optionText: "Keep the current mixed system",
          canonicalTargetLabel: "current mixed healthcare system",
          targetKind: "position",
          relationFamily: "preference",
          polarity: "positive",
          aliases: ["mixed system"],
          notes: ["selected option favors the mixed system"],
        },
      ],
      notes: ["healthcare policy benchmark"],
    };
    const resolvedTopic = {
      entryKind: "subject" as const,
      canonicalId: "subject:topic:healthcare_policy",
      label: "healthcare policy",
      kind: "topic" as const,
      matchType: "created" as const,
    };
    const resolvedPosition = {
      entryKind: "subject" as const,
      canonicalId: "subject:position:subject_topic_healthcare_policy__public_healthcare_plan",
      label: "public healthcare plan",
      kind: "position" as const,
      topicCanonicalId: "subject:topic:healthcare_policy",
      matchType: "created" as const,
    };
    const resolvedAssertions = [
      {
        assertionSignature: "assertion_healthcare_support",
        relationId: "relation:support:positive:supports",
        relationLabel: "supports",
        relationFamily: "support",
        polarity: "positive" as const,
        target: resolvedPosition,
        aboutTopic: resolvedTopic,
        confidence: 0.95,
        notes: ["selected option supports a public plan"],
      },
    ];

    const result = await processVote(
      {
        source: createSource(),
        sourceIndex: 0,
        vote: {
          ...createVote(),
          poll: {
            pollId: "poll-2",
            title: "Question 2",
            description: "Healthcare policy poll",
            options: [
              { text: "Create a public healthcare plan", isSelected: true },
              { text: "Keep the current mixed system", isSelected: false },
            ],
          },
        },
      },
      {
        ...defaultProcessVoteDependencies,
        getQdrantImportState: async () => null,
        findQdrantPollTemplate: async () => pollTemplate,
        resolveSemanticRegistry: async () => ({
          resolvedSubjects: [resolvedTopic, resolvedPosition],
          resolvedAssertions,
        }),
        upsertQdrantImportState: async (record) => {
          qdrantWrites.push(record);
        },
        writeVoteToGraph: async ({ artifact }) => ({
          alreadyProcessed: false,
          record: {
            ...artifact,
            neo4jStatus: "done",
          },
        }),
        finalizeQdrantRecord: async (record) => ({
          ...record,
          finalStatus: "done",
          processingStatus: "completed",
          completedAt: "2026-04-04T01:00:00.000Z",
        }),
      },
    );

    expect(result.outcome).toBe("completed");
    expect(qdrantWrites).toHaveLength(1);
    expect(qdrantWrites[0]?.rawEvidence).toEqual({
      voteId: "vote-1",
      voteType: "standalone_poll",
      selectedOption: "Create a public healthcare plan",
      voteTimestamps: undefined,
      poll: {
        pollId: "poll-2",
        title: "Question 2",
        description: "Healthcare policy poll",
        createdAt: null,
        options: [
          { text: "Create a public healthcare plan", isSelected: true },
          { text: "Keep the current mixed system", isSelected: false },
        ],
      },
      trial: undefined,
      campaign: undefined,
      inkdBlog: undefined,
      rawVote: {
        voteId: "vote-1",
        type: "standalone_poll",
        voter: {
          externalAccountId: "user-1",
        },
        poll: {
          pollId: "poll-2",
          title: "Question 2",
          description: "Healthcare policy poll",
          options: [
            { text: "Create a public healthcare plan", isSelected: true },
            { text: "Keep the current mixed system", isSelected: false },
          ],
        },
      },
    });
    expect(qdrantWrites[0]?.pollTemplate).toEqual(pollTemplate);
  });
});

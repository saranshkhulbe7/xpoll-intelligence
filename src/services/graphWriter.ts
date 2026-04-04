import { createHash } from "node:crypto";
import { neo4jDriver } from "../db/neo4j";
import { config } from "../config";
import type { RawVote, ResolvedSubject, ResolvedVoteArtifact, SubjectKind } from "../types";
import { getSelectedOption } from "./contextBuilder";
import { markNeo4jDone } from "./importLedger";

function subjectLabel(kind: SubjectKind): string {
  switch (kind) {
    case "topic":
      return "Topic";
    case "position":
      return "Position";
    case "entity":
      return "Entity";
    case "ideology":
      return "Ideology";
  }
}

function buildSupportKey(processingKey: string): string {
  return `support_${createHash("sha256").update(processingKey).digest("hex").slice(0, 32)}`;
}

async function ensureSubjectNode(tx: any, subject: ResolvedSubject): Promise<void> {
  const label = subjectLabel(subject.kind);

  await tx.run(
    `
    MERGE (s:Subject:${label} {canonicalId: $canonicalId})
    SET s.label = $label,
        s.kind = $kind,
        s.topicCanonicalId = $topicCanonicalId
    `,
    {
      canonicalId: subject.canonicalId,
      label: subject.label,
      kind: subject.kind,
      topicCanonicalId: subject.topicCanonicalId ?? null,
    },
  );
}

function getAssertionEvidenceTimestamp(vote: RawVote): string {
  return vote.timestamps?.respondedAt ?? vote.timestamps?.seenAt ?? new Date().toISOString();
}

export async function writeVoteToGraph(args: {
  vote: RawVote;
  artifact: ResolvedVoteArtifact;
}): Promise<{ alreadyProcessed: boolean; record: ResolvedVoteArtifact }> {
  const { vote, artifact } = args;
  const selectedOption = artifact.rawEvidence?.selectedOption ?? getSelectedOption(vote);
  const evidenceTimestamp = artifact.rawEvidence?.voteTimestamps?.respondedAt
    ?? artifact.rawEvidence?.voteTimestamps?.seenAt
    ?? getAssertionEvidenceTimestamp(vote);
  const supportKey = buildSupportKey(artifact.processingKey);
  const session = neo4jDriver.session({ database: config.neo4j.database });

  try {
    return await session.executeWrite(async (tx) => {
      let allAssertionsAlreadyApplied = true;

      await tx.run(
        `
        MERGE (u:User {externalAccountId: $externalAccountId})
        SET u.username = $username,
            u.twitterUsername = $twitterUsername,
            u.twitterName = $twitterName,
            u.googleEmail = $googleEmail,
            u.emailAuthEmail = $emailAuthEmail,
            u.gender = $gender,
            u.dob = $dob,
            u.civicScore = $civicScore,
            u.level = $level,
            u.city = $city,
            u.state = $state,
            u.country = $country
        `,
        {
          externalAccountId: vote.voter.externalAccountId,
          username: vote.voter.username ?? null,
          twitterUsername: vote.voter.twitterUsername ?? null,
          twitterName: vote.voter.twitterName ?? null,
          googleEmail: vote.voter.googleEmail ?? null,
          emailAuthEmail: vote.voter.emailAuthEmail ?? null,
          gender: vote.voter.gender ?? null,
          dob: vote.voter.dob ?? null,
          civicScore: vote.voter.civicScore ?? null,
          level: vote.voter.level ?? null,
          city: vote.voter.location?.city ?? null,
          state: vote.voter.location?.state ?? null,
          country: vote.voter.location?.country ?? null,
        },
      );

      for (const subject of artifact.resolvedSubjects ?? []) {
        await ensureSubjectNode(tx, subject);
      }

      for (const assertion of artifact.resolvedAssertions ?? []) {
        await ensureSubjectNode(tx, assertion.target);
        if (assertion.aboutTopic) {
          await ensureSubjectNode(tx, assertion.aboutTopic);
        }

        const mergeResult = await tx.run(
          `
          MATCH (u:User {externalAccountId: $externalAccountId})
          MATCH (target:Subject {canonicalId: $targetSubjectId})
          MERGE (a:Assertion {assertionSignature: $assertionSignature})
          ON CREATE SET a.assertionId = $assertionSignature,
                        a.createdAt = $now,
                        a.evidenceCount = 0,
                        a.appliedSupportKeys = []
          SET a.relationId = $relationId,
              a.relationLabel = $relationLabel,
              a.relationFamily = $relationFamily,
              a.polarity = $polarity,
              a.confidence = $confidence
          MERGE (u)-[:MADE_ASSERTION]->(a)
          MERGE (a)-[:TARGETS]->(target)
          RETURN coalesce(a.appliedSupportKeys, []) AS appliedSupportKeys
          `,
          {
            externalAccountId: vote.voter.externalAccountId,
            targetSubjectId: assertion.target.canonicalId,
            assertionSignature: assertion.assertionSignature,
            relationId: assertion.relationId,
            relationLabel: assertion.relationLabel,
            relationFamily: assertion.relationFamily,
            polarity: assertion.polarity,
            confidence: assertion.confidence,
            now: new Date().toISOString(),
          },
        );

        const appliedSupportKeys = mergeResult.records[0]?.get("appliedSupportKeys");
        const alreadyApplied = Array.isArray(appliedSupportKeys)
          ? appliedSupportKeys.map(String).includes(supportKey)
          : false;

        if (!alreadyApplied) {
          allAssertionsAlreadyApplied = false;
          await tx.run(
            `
            MATCH (a:Assertion {assertionSignature: $assertionSignature})
            SET a.appliedSupportKeys = coalesce(a.appliedSupportKeys, []) + $supportKey,
                a.evidenceCount = coalesce(a.evidenceCount, 0) + 1,
                a.firstSeenVoteId = coalesce(a.firstSeenVoteId, $voteId),
                a.firstSeenAt = coalesce(a.firstSeenAt, $evidenceTimestamp),
                a.lastSeenVoteId = $voteId,
                a.lastSeenAt = $evidenceTimestamp,
                a.latestSelectedOption = $selectedOption,
                a.latestPollId = $pollId,
                a.latestPollTitle = $pollTitle,
                a.latestVoteType = $voteType,
                a.latestSourcePath = $sourcePath,
                a.lastUpdatedAt = $now
            `,
            {
              assertionSignature: assertion.assertionSignature,
              supportKey,
              voteId: vote.voteId,
              evidenceTimestamp,
              selectedOption: selectedOption ?? null,
              pollId: vote.poll.pollId,
              pollTitle: vote.poll.title,
              voteType: vote.type,
              sourcePath: artifact.sourcePath,
              now: new Date().toISOString(),
            },
          );
        }

        if (assertion.aboutTopic) {
          await tx.run(
            `
            MATCH (a:Assertion {assertionSignature: $assertionSignature})
            MATCH (topic:Subject {canonicalId: $topicCanonicalId})
            MERGE (a)-[:ABOUT]->(topic)
            `,
            {
              assertionSignature: assertion.assertionSignature,
              topicCanonicalId: assertion.aboutTopic.canonicalId,
            },
          );
        }
      }

      return {
        alreadyProcessed: allAssertionsAlreadyApplied,
        record: markNeo4jDone(artifact),
      };
    });
  } finally {
    await session.close();
  }
}

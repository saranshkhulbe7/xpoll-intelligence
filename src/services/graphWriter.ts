import { createHash } from "node:crypto";
import { neo4jDriver } from "../db/neo4j";
import { config } from "../config";
import type { RawVote, RelationPolarity, ResolvedSubject, ResolvedVoteArtifact, SubjectKind } from "../types";
import { getSelectedOption } from "./contextBuilder";
import { markNeo4jDone } from "./importLedger";
import { intensityBandToContribution, updateIntensityState } from "../utils/intensity";

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

function buildFallbackAssertionGroupKey(args: {
  userId: string;
  relationFamily: string;
  targetSubjectId: string;
  aboutTopicId?: string | null;
}): string {
  const groupSource = [args.userId, args.relationFamily, args.targetSubjectId, args.aboutTopicId ?? ""].join("::");
  return `assertion_group_${createHash("sha256").update(groupSource).digest("hex").slice(0, 32)}`;
}

function oppositePolarity(polarity: RelationPolarity): RelationPolarity | null {
  if (polarity === "positive") {
    return "negative";
  }

  if (polarity === "negative") {
    return "positive";
  }

  return null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

        const now = new Date().toISOString();
        const intensityBand = assertion.intensityBand ?? "medium";
        const baseIntensityContribution =
          typeof assertion.baseIntensityContribution === "number" && Number.isFinite(assertion.baseIntensityContribution)
            ? assertion.baseIntensityContribution
            : intensityBandToContribution(intensityBand);
        const assertionGroupKey =
          assertion.assertionGroupKey ??
          buildFallbackAssertionGroupKey({
            userId: vote.voter.externalAccountId,
            relationFamily: assertion.relationFamily,
            targetSubjectId: assertion.target.canonicalId,
            aboutTopicId: assertion.aboutTopic?.canonicalId ?? null,
          });

        const mergeResult = await tx.run(
          `
          MATCH (u:User {externalAccountId: $externalAccountId})
          MATCH (target:Subject {canonicalId: $targetSubjectId})
          MERGE (a:Assertion {assertionSignature: $assertionSignature})
          ON CREATE SET a.assertionId = $assertionSignature,
                        a.createdAt = $now,
                        a.evidenceCount = 0,
                        a.appliedSupportKeys = [],
                        a.intensityMass = 0,
                        a.currentIntensity = 0
          SET a.relationId = $relationId,
              a.relationLabel = $relationLabel,
              a.relationFamily = $relationFamily,
              a.polarity = $polarity,
              a.confidence = $confidence,
              a.assertionGroupKey = $assertionGroupKey,
              a.intensityBand = $intensityBand,
              a.baseIntensityContribution = $baseIntensityContribution
          MERGE (u)-[:MADE_ASSERTION]->(a)
          MERGE (a)-[:TARGETS]->(target)
          RETURN coalesce(a.appliedSupportKeys, []) AS appliedSupportKeys,
                 coalesce(a.intensityMass, 0) AS intensityMass,
                 a.lastIntensityDecayAt AS lastIntensityDecayAt
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
            assertionGroupKey,
            intensityBand,
            baseIntensityContribution,
            now,
          },
        );

        const appliedSupportKeys = toStringArray(mergeResult.records[0]?.get("appliedSupportKeys"));
        const alreadyApplied = appliedSupportKeys.includes(supportKey);

        if (!alreadyApplied) {
          allAssertionsAlreadyApplied = false;
          const ownMass = toNumber(mergeResult.records[0]?.get("intensityMass"));
          const ownLastDecayAt = toOptionalString(mergeResult.records[0]?.get("lastIntensityDecayAt"));
          const oppositeAssertionPolarity = oppositePolarity(assertion.polarity);
          let oppositeAssertionSignature: string | null = null;
          let oppositeMass = 0;
          let oppositeLastDecayAt: string | null = null;

          if (oppositeAssertionPolarity) {
            const oppositeResult = await tx.run(
              `
              MATCH (opposite:Assertion {
                assertionGroupKey: $assertionGroupKey,
                polarity: $oppositePolarity
              })
              RETURN opposite.assertionSignature AS assertionSignature,
                     coalesce(opposite.intensityMass, 0) AS intensityMass,
                     opposite.lastIntensityDecayAt AS lastIntensityDecayAt
              LIMIT 1
              `,
              {
                assertionGroupKey,
                oppositePolarity: oppositeAssertionPolarity,
              },
            );

            oppositeAssertionSignature = toOptionalString(oppositeResult.records[0]?.get("assertionSignature"));
            oppositeMass = toNumber(oppositeResult.records[0]?.get("intensityMass"));
            oppositeLastDecayAt = toOptionalString(oppositeResult.records[0]?.get("lastIntensityDecayAt"));
          }

          const nextIntensityState = updateIntensityState({
            ownMass,
            ownLastDecayAt,
            oppositeMass,
            oppositeLastDecayAt,
            eventAt: evidenceTimestamp,
            baseContribution: baseIntensityContribution,
            halfLifeDays: config.intensity.halfLifeDays,
            suppressionFactor: config.intensity.oppositeSuppression,
          });

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
                a.currentIntensity = $currentIntensity,
                a.intensityMass = $intensityMass,
                a.lastIntensityDecayAt = $evidenceTimestamp,
                a.lastIntensityUpdatedAt = $now,
                a.intensityBand = $intensityBand,
                a.baseIntensityContribution = $baseIntensityContribution,
                a.assertionGroupKey = $assertionGroupKey,
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
              currentIntensity: nextIntensityState.ownIntensity,
              intensityMass: nextIntensityState.ownMass,
              intensityBand,
              baseIntensityContribution,
              assertionGroupKey,
              now,
            },
          );

          if (oppositeAssertionSignature) {
            await tx.run(
              `
              MATCH (opposite:Assertion {assertionSignature: $assertionSignature})
              SET opposite.currentIntensity = $currentIntensity,
                  opposite.intensityMass = $intensityMass,
                  opposite.lastIntensityDecayAt = $evidenceTimestamp,
                  opposite.lastIntensityUpdatedAt = $now,
                  opposite.lastUpdatedAt = $now
              `,
              {
                assertionSignature: oppositeAssertionSignature,
                currentIntensity: nextIntensityState.oppositeIntensity,
                intensityMass: nextIntensityState.oppositeMass,
                evidenceTimestamp,
                now,
              },
            );
          }
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

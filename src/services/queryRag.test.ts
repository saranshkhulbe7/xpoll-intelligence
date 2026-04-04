import { afterEach, describe, expect, test } from "bun:test";
import { qdrantClient } from "../db/qdrant";
import { openaiClient } from "../openai";
import type { Neo4jReadSessionLike, SubjectSearchHit } from "./queryRag";
import {
  attachEvidenceSnippets,
  fetchAssertionsReadOnly,
  parseQueryIntent,
  resolveQueryUsersReadOnly,
  searchRegistrySubjectsReadOnly,
} from "./queryRag";

const originalCreate = openaiClient.responses.create.bind(openaiClient.responses);
const originalScroll = qdrantClient.scroll.bind(qdrantClient);
const originalSearch = qdrantClient.search.bind(qdrantClient);

afterEach(() => {
  openaiClient.responses.create = originalCreate;
  qdrantClient.scroll = originalScroll;
  qdrantClient.search = originalSearch;
});

function createRecord(payload: Record<string, unknown>) {
  return {
    get(key: string) {
      return payload[key];
    },
  };
}

describe("parseQueryIntent", () => {
  test("maps a free-text strongest-views question to user_summary", async () => {
    openaiClient.responses.create = (async () => ({
      output_text: JSON.stringify({
        supported: true,
        intentType: "user_summary",
        userRefs: ["Maya Sen"],
        conceptRefs: [],
        relationFamilies: [],
        polarityFilter: null,
        resultLimit: 4,
        needsEvidence: true,
        unsupportedReason: null,
      }),
    })) as unknown as typeof openaiClient.responses.create;

    const intent = await parseQueryIntent("What are Maya Sen's strongest current views?", 5);

    expect(intent.supported).toBe(true);
    expect(intent.intentType).toBe("user_summary");
    expect(intent.userRefs).toEqual(["Maya Sen"]);
    expect(intent.resultLimit).toBe(4);
  });

  test("maps an entity question to user_entity_sentiment", async () => {
    openaiClient.responses.create = (async () => ({
      output_text: JSON.stringify({
        supported: true,
        intentType: "user_entity_sentiment",
        userRefs: ["Maya Sen"],
        conceptRefs: ["Joe Biden"],
        relationFamilies: ["sentiment"],
        polarityFilter: "negative",
        resultLimit: 3,
        needsEvidence: true,
        unsupportedReason: null,
      }),
    })) as unknown as typeof openaiClient.responses.create;

    const intent = await parseQueryIntent("How does Maya Sen feel about Joe Biden?", 5);

    expect(intent.intentType).toBe("user_entity_sentiment");
    expect(intent.conceptRefs).toEqual(["Joe Biden"]);
    expect(intent.relationFamilies).toEqual(["sentiment"]);
    expect(intent.polarityFilter).toBe("negative");
  });

  test("returns unsupported when the parser says the question is out of scope", async () => {
    openaiClient.responses.create = (async () => ({
      output_text: JSON.stringify({
        supported: false,
        intentType: "user_summary",
        userRefs: [],
        conceptRefs: [],
        relationFamilies: [],
        polarityFilter: null,
        resultLimit: 5,
        needsEvidence: true,
        unsupportedReason: "This asks for causal explanation rather than graph retrieval.",
      }),
    })) as unknown as typeof openaiClient.responses.create;

    const intent = await parseQueryIntent("Why did Maya change her mind on immigration?", 5);

    expect(intent.supported).toBe(false);
    expect(intent.unsupportedReason).toContain("causal explanation");
  });
});

describe("searchRegistrySubjectsReadOnly", () => {
  test("uses alias matching before vector fallback and never mutates the registry", async () => {
    qdrantClient.scroll = (async (_collectionName: string, params: any) => {
      const normalizedLabel = params?.filter?.must?.find((entry: any) => entry.key === "normalizedLabel")?.match?.value;
      if (normalizedLabel) {
        return { points: [] };
      }

      const aliasValue = params?.filter?.should?.[0]?.match?.value;
      if (aliasValue === "joe biden") {
        return {
          points: [
            {
              payload: {
                canonicalId: "subject:entity:joe_biden",
                canonicalLabel: "Joe Biden",
                subjectKind: "entity",
                aliases: ["President Joe Biden"],
              },
            },
          ],
        };
      }

      return { points: [] };
    }) as unknown as typeof qdrantClient.scroll;

    qdrantClient.search = (async () => {
      throw new Error("Vector search should not run when alias matching succeeds.");
    }) as unknown as typeof qdrantClient.search;

    const hits = await searchRegistrySubjectsReadOnly({
      query: "Joe Biden",
      allowedKinds: ["entity"],
      limit: 3,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      canonicalId: "subject:entity:joe_biden",
      label: "Joe Biden",
      kind: "entity",
      matchType: "alias",
    });
  });
});

describe("resolveQueryUsersReadOnly", () => {
  test("matches human-readable names against normalized usernames", async () => {
    const session: Neo4jReadSessionLike = {
      executeRead: async (work) =>
        work({
          run: async () => ({
            records: [
              createRecord({
                externalAccountId: "intensity-user-001",
                username: "maya.sen",
                googleEmail: "mayasen@intensity.local",
                emailAuthEmail: "mayasen@intensity.local",
                twitterUsername: null,
                twitterName: null,
              }),
            ],
          }),
        }),
    };

    const users = await resolveQueryUsersReadOnly({
      session,
      userRefs: ["Maya Sen"],
    });

    expect(users).toHaveLength(1);
    expect(users[0]?.externalAccountId).toBe("intensity-user-001");
    expect(users[0]?.matchedRef).toBe("Maya Sen");
  });
});

describe("fetchAssertionsReadOnly", () => {
  test("parses a Neo4j assertion row and preserves the matched concept", async () => {
    const matchedConcept: SubjectSearchHit = {
      canonicalId: "subject:entity:joe_biden",
      label: "Joe Biden",
      kind: "entity",
      aliases: ["President Joe Biden"],
      matchType: "exact",
      matchScore: 1,
      matchedQuery: "Joe Biden",
    };

    const session: Neo4jReadSessionLike = {
      executeRead: async (work) =>
        work({
          run: async () => ({
            records: [
              createRecord({
                externalAccountId: "intensity-user-001",
                username: "maya.sen",
                assertionSignature: "assertion-1",
                relationLabel: "negative toward",
                relationFamily: "sentiment",
                polarity: "negative",
                targetCanonicalId: "subject:entity:joe_biden",
                targetLabel: "Joe Biden",
                targetKind: "entity",
                topicCanonicalId: "subject:topic:u_s_climate_leadership_and_policy_direction",
                topicLabel: "U.S. climate leadership and policy direction",
                exactNowIntensity: 0.45,
                confidence: 0.95,
                lastSeenAt: "2026-07-01T13:03:00.000Z",
                firstSeenVoteId: "vote-1",
                lastSeenVoteId: "vote-1",
                evidenceCount: 1,
                latestSelectedOption: "He has made some progress, but not nearly enough",
                latestPollTitle: "Has Joe Biden moved U.S. climate policy in the right direction?",
                latestVoteType: "trial_poll",
                latestSourcePath: "/tmp/votes.json",
              }),
            ],
          }),
        }),
    };

    const assertions = await fetchAssertionsReadOnly({
      session,
      candidate: matchedConcept,
      userIds: ["intensity-user-001"],
      relationFamilies: ["sentiment"],
      polarityFilter: "negative",
      limit: 5,
    });

    expect(assertions).toHaveLength(1);
    expect(assertions[0]?.matchedConcept?.canonicalId).toBe("subject:entity:joe_biden");
    expect(assertions[0]?.exactNowIntensity).toBeCloseTo(0.45);
    expect(assertions[0]?.aboutTopic?.label).toBe("U.S. climate leadership and policy direction");
  });
});

describe("attachEvidenceSnippets", () => {
  test("attaches first and latest evidence without duplicating a single-vote assertion", async () => {
    qdrantClient.scroll = (async (_collectionName: string, params: any) => {
      const voteId = params?.filter?.must?.[0]?.match?.value;
      if (voteId === "vote-1") {
        return {
          points: [
            {
              payload: {
                voteId: "vote-1",
                finalStatus: "done",
                lastUpdatedAt: "2026-04-05T00:00:00.000Z",
                sourcePath: "/tmp/votes.json",
                rawEvidence: {
                  voteId: "vote-1",
                  voteType: "standalone_poll",
                  selectedOption: "Definitely offer a path to citizenship after background checks",
                  voteTimestamps: {
                    respondedAt: "2026-01-03T10:02:00.000Z",
                    seenAt: "2026-01-03T10:00:00.000Z",
                  },
                  poll: {
                    title: "Should undocumented immigrants who pass background checks get a path to citizenship?",
                  },
                },
              },
            },
          ],
        };
      }

      if (voteId === "vote-3") {
        return {
          points: [
            {
              payload: {
                voteId: "vote-3",
                finalStatus: "done",
                lastUpdatedAt: "2026-09-20T09:05:00.000Z",
                sourcePath: "/tmp/votes.json",
                rawEvidence: {
                  voteId: "vote-3",
                  voteType: "standalone_poll",
                  selectedOption: "Absolutely reject any pathway and prioritize deportation",
                  voteTimestamps: {
                    respondedAt: "2026-09-20T09:04:00.000Z",
                    seenAt: "2026-09-20T09:00:00.000Z",
                  },
                  poll: {
                    title: "Should undocumented immigrants who pass background checks get a path to citizenship?",
                  },
                },
              },
            },
          ],
        };
      }

      return { points: [] };
    }) as unknown as typeof qdrantClient.scroll;

    const clusters = await attachEvidenceSnippets([
      {
        queryRef: "immigration",
        matchedConcept: null,
        assertions: [
          {
            assertionSignature: "assertion-1",
            user: { externalAccountId: "u-1", username: "maya.sen" },
            relationLabel: "supports",
            relationFamily: "support",
            polarity: "positive",
            target: {
              canonicalId: "subject:position:pathway",
              label: "pathway to citizenship after background checks",
              kind: "position",
            },
            aboutTopic: {
              canonicalId: "subject:topic:immigration",
              label: "legal status for undocumented immigrants",
            },
            exactNowIntensity: 0.5,
            confidence: 0.95,
            lastSeenAt: "2026-09-20T09:04:00.000Z",
            firstSeenVoteId: "vote-1",
            lastSeenVoteId: "vote-3",
            evidenceCount: 2,
            latestSelectedOption: "Absolutely reject any pathway and prioritize deportation",
            latestPollTitle: "Should undocumented immigrants who pass background checks get a path to citizenship?",
            latestVoteType: "standalone_poll",
            latestSourcePath: "/tmp/votes.json",
            matchedConcept: null,
            evidence: [],
          },
        ],
      },
    ]);

    expect(clusters[0]?.assertions[0]?.evidence).toHaveLength(2);
    expect(clusters[0]?.assertions[0]?.evidence[0]).toMatchObject({
      kind: "first",
      voteId: "vote-1",
    });
    expect(clusters[0]?.assertions[0]?.evidence[1]).toMatchObject({
      kind: "latest",
      voteId: "vote-3",
    });
  });

  test("falls back to assertion metadata when Qdrant evidence lookup fails", async () => {
    qdrantClient.scroll = (async () => {
      throw new Error("Bad Request");
    }) as unknown as typeof qdrantClient.scroll;

    const clusters = await attachEvidenceSnippets([
      {
        queryRef: null,
        matchedConcept: null,
        assertions: [
          {
            assertionSignature: "assertion-2",
            user: { externalAccountId: "u-2", username: "maya.sen" },
            relationLabel: "negative toward",
            relationFamily: "sentiment",
            polarity: "negative",
            target: {
              canonicalId: "subject:entity:joe_biden",
              label: "Joe Biden",
              kind: "entity",
            },
            aboutTopic: {
              canonicalId: "subject:topic:climate",
              label: "U.S. climate leadership and policy direction",
            },
            exactNowIntensity: 0.45,
            confidence: 0.95,
            lastSeenAt: "2026-07-01T13:03:00.000Z",
            firstSeenVoteId: "vote-5",
            lastSeenVoteId: "vote-5",
            evidenceCount: 1,
            latestSelectedOption: "He has made some progress, but not nearly enough",
            latestPollTitle: "Has Joe Biden moved U.S. climate policy in the right direction?",
            latestVoteType: "trial_poll",
            latestSourcePath: "/tmp/votes.json",
            matchedConcept: null,
            evidence: [],
          },
        ],
      },
    ]);

    expect(clusters[0]?.assertions[0]?.evidence).toHaveLength(1);
    expect(clusters[0]?.assertions[0]?.evidence[0]).toMatchObject({
      kind: "first",
      voteId: "vote-5",
      pollTitle: "Has Joe Biden moved U.S. climate policy in the right direction?",
      selectedOption: "He has made some progress, but not nearly enough",
      sourcePath: "/tmp/votes.json",
    });
  });
});

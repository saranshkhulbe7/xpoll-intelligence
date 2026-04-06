import { afterEach, describe, expect, test } from "bun:test";
import { qdrantClient } from "../db/qdrant";
import { openaiClient } from "../openai";
import type { Neo4jReadSessionLike, SubjectSearchHit } from "./queryRag";
import {
  attachEvidenceSnippets,
  fetchAssertionsReadOnly,
  fetchClusterMetricsReadOnly,
  inspectConceptResolutionReadOnly,
  parseQueryIntent,
  renderDeterministicAnswer,
  resolveQueryUsersReadOnly,
  searchRegistrySubjectsReadOnly,
} from "./queryRag";

const originalCreate = openaiClient.responses.create.bind(openaiClient.responses);
const originalEmbeddingCreate = openaiClient.embeddings.create.bind(openaiClient.embeddings);
const originalScroll = qdrantClient.scroll.bind(qdrantClient);
const originalSearch = qdrantClient.search.bind(qdrantClient);

afterEach(() => {
  openaiClient.responses.create = originalCreate;
  openaiClient.embeddings.create = originalEmbeddingCreate;
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

function createGraphCandidateSession(rows: Record<string, unknown>[]): Neo4jReadSessionLike {
  return {
    executeRead: async (work) =>
      work({
        run: async () => ({
          records: rows.map(createRecord),
        }),
      }),
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
        cohorts: [],
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
    expect(intent.cohorts).toEqual([]);
    expect(intent.resultLimit).toBe(4);
  });

  test("maps an entity question to user_entity_sentiment", async () => {
    openaiClient.responses.create = (async () => ({
      output_text: JSON.stringify({
        supported: true,
        intentType: "user_entity_sentiment",
        userRefs: ["Maya Sen"],
        conceptRefs: ["Joe Biden"],
        cohorts: [],
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

  test("maps a cohort comparison question to concept_cohort_summary with cohorts", async () => {
    openaiClient.responses.create = (async () => ({
      output_text: JSON.stringify({
        supported: true,
        intentType: "concept_cohort_summary",
        userRefs: [],
        conceptRefs: ["healthcare coverage policy"],
        cohorts: [
          { label: "male users", locationRefs: [], genderRefs: ["male"] },
          { label: "female users", locationRefs: [], genderRefs: ["female"] },
        ],
        relationFamilies: [],
        polarityFilter: null,
        resultLimit: 5,
        needsEvidence: true,
        unsupportedReason: null,
      }),
    })) as unknown as typeof openaiClient.responses.create;

    const intent = await parseQueryIntent("Compare male and female users on healthcare coverage policy", 5);

    expect(intent.intentType).toBe("concept_cohort_summary");
    expect(intent.cohorts).toEqual([
      { label: "male users", locationRefs: [], genderRefs: ["male"] },
      { label: "female users", locationRefs: [], genderRefs: ["female"] },
    ]);
  });

  test("returns unsupported when the parser says the question is out of scope", async () => {
    openaiClient.responses.create = (async () => ({
      output_text: JSON.stringify({
        supported: false,
        intentType: "user_summary",
        userRefs: [],
        conceptRefs: [],
        cohorts: [],
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

describe("renderDeterministicAnswer", () => {
  test("appends a verbose report at the end of assertion-backed results", () => {
    const text = renderDeterministicAnswer({
      question: "Who is negative toward Joe Biden?",
      intent: {
        supported: true,
        intentType: "concept_cohort_summary",
        userRefs: [],
        conceptRefs: ["Joe Biden"],
        cohorts: [],
        relationFamilies: ["sentiment"],
        polarityFilter: "negative",
        resultLimit: 5,
        needsEvidence: true,
      },
      matchedUsers: [],
      cohorts: [],
      matchedConcepts: [
        {
          query: "Joe Biden",
          hits: [
            {
              canonicalId: "subject:entity:joe_biden",
              label: "Joe Biden",
              kind: "entity",
              aliases: ["Joe Biden"],
              matchType: "exact",
              matchScore: 1,
              matchedQuery: "Joe Biden",
            },
          ],
        },
      ],
      clusters: [
        {
          queryRef: "Joe Biden",
          matchedConcept: {
            canonicalId: "subject:entity:joe_biden",
            label: "Joe Biden",
            kind: "entity",
            aliases: ["Joe Biden"],
            matchType: "exact",
            matchScore: 1,
            matchedQuery: "Joe Biden",
          },
          cohort: null,
          metrics: {
            totalUsers: 20,
            matchedUsers: 6,
            positiveUsers: 0,
            negativeUsers: 6,
            neutralUsers: 0,
            positivePct: 0,
            negativePct: 30,
            neutralPct: 0,
            averageIntensity: 0.57,
          },
          assertions: [
            {
              assertionSignature: "assertion-1",
              relationLabel: "negative toward",
              relationFamily: "sentiment",
              polarity: "negative",
              user: {
                externalAccountId: "bench-user-001",
                username: "priyank.sharma",
              },
              target: {
                canonicalId: "subject:entity:joe_biden",
                label: "Joe Biden",
                kind: "entity",
              },
              aboutTopic: {
                canonicalId: "subject:topic:border_leadership",
                label: "immigration and border-management leadership",
              },
              exactNowIntensity: 0.57,
              confidence: 0.95,
              lastSeenAt: "2026-01-19T11:15:00.000Z",
              firstSeenVoteId: "bench-vote-067",
              lastSeenVoteId: "bench-vote-067",
              evidenceCount: 1,
              latestSelectedOption: "No, the border response has failed",
              latestPollTitle: "Has Joe Biden handled the southern border effectively?",
              latestVoteType: "standalone_poll",
              latestSourcePath: "/tmp/political-benchmark-100.json",
              matchedConcept: {
                canonicalId: "subject:entity:joe_biden",
                label: "Joe Biden",
                kind: "entity",
                aliases: ["Joe Biden"],
                matchType: "exact",
                matchScore: 1,
                matchedQuery: "Joe Biden",
              },
              evidence: [
                {
                  kind: "first",
                  voteId: "bench-vote-067",
                  pollTitle: "Has Joe Biden handled the southern border effectively?",
                  selectedOption: "No, the border response has failed",
                  respondedAt: "2026-01-19T11:15:00.000Z",
                  seenAt: "2026-01-19T11:13:00.000Z",
                  voteType: "standalone_poll",
                  sourcePath: "/tmp/political-benchmark-100.json",
                },
              ],
            },
          ],
        },
      ],
      warnings: [],
      answerText: "",
    });

    expect(text).toContain("Verbose Report:");
    expect(text).toContain("Retrieval coverage: The query matched 1 concept cluster, produced 1 assertion, and attached evidence to 1 assertion.");
    expect(text).toContain("Main match: The leading cluster is Joe Biden, classified as entity via exact matching.");
    expect(text).toContain("Cohort readout: For Joe Biden, 6 of 20 users matched the current filter. The distribution is 0.0% positive, 30.0% negative, and 0.0% neutral, with an average current intensity of 0.57.");
    expect(text.trim().endsWith("Caveats: No retrieval warnings were raised for this answer.")).toBe(true);
  });

  test("explains concept-resolution failures without implying graph evidence was retrieved", () => {
    const text = renderDeterministicAnswer({
      question: "what are people view on renewable energy, gender wise",
      intent: {
        supported: true,
        intentType: "concept_cohort_summary",
        userRefs: [],
        conceptRefs: ["renewable energy"],
        cohorts: [
          { label: "female", locationRefs: [], genderRefs: ["female"] },
          { label: "male", locationRefs: [], genderRefs: ["male"] },
        ],
        relationFamilies: ["support", "sentiment", "preference", "uncertainty"],
        polarityFilter: undefined,
        resultLimit: 5,
        needsEvidence: true,
      },
      matchedUsers: [],
      cohorts: [
        { label: "female", locationRefs: [], genderRefs: ["female"] },
        { label: "male", locationRefs: [], genderRefs: ["male"] },
      ],
      matchedConcepts: [
        {
          query: "renewable energy",
          hits: [],
        },
      ],
      clusters: [],
      warnings: [
        'No concept match was found for: renewable energy.',
        'Graph fallback also found no matching concept candidate for "renewable energy".',
      ],
      answerText: "",
    });

    expect(text).toContain("The query could not be answered because the concept did not resolve to a known subject");
    expect(text).toContain("Graph metrics and cohort comparison were skipped because concept resolution failed before graph retrieval.");
    expect(text).toContain("Verbose Report:");
    expect(text).not.toContain("matchedUsers: []");
  });
});

describe("inspectConceptResolutionReadOnly", () => {
  test("classifies an exact graph-only candidate as missing_from_registry", async () => {
    qdrantClient.scroll = (async () => ({ points: [] })) as unknown as typeof qdrantClient.scroll;
    qdrantClient.search = (async () => []) as unknown as typeof qdrantClient.search;

    const inspection = await inspectConceptResolutionReadOnly({
      session: createGraphCandidateSession([
        {
          canonicalId: "subject:topic:renewable_energy",
          label: "renewable energy",
          kind: "topic",
          topicCanonicalId: null,
          assertionCount: 4,
        },
      ]),
      query: "renewable energy",
      limit: 3,
    });

    expect(inspection.rootCause).toBe("missing_from_registry");
    expect(inspection.graphFallbackHits[0]?.canonicalId).toBe("subject:topic:renewable_energy");
  });

  test("classifies a graph candidate under a different label as different_label_or_alias_gap", async () => {
    qdrantClient.scroll = (async () => ({ points: [] })) as unknown as typeof qdrantClient.scroll;
    qdrantClient.search = (async () => []) as unknown as typeof qdrantClient.search;

    const inspection = await inspectConceptResolutionReadOnly({
      session: createGraphCandidateSession([
        {
          canonicalId: "subject:topic:government_spending_on_clean_energy",
          label: "government spending on clean energy",
          kind: "topic",
          topicCanonicalId: null,
          assertionCount: 6,
        },
      ]),
      query: "renewable energy",
      limit: 3,
    });

    expect(inspection.rootCause).toBe("different_label_or_alias_gap");
    expect(inspection.graphFallbackHits[0]?.label).toBe("government spending on clean energy");
  });

  test("classifies semantically strong but lexically rejected vector candidates as vector_too_conservative", async () => {
    openaiClient.embeddings.create = (async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    })) as unknown as typeof openaiClient.embeddings.create;
    qdrantClient.scroll = (async () => ({ points: [] })) as unknown as typeof qdrantClient.scroll;
    qdrantClient.search = (async () => [
      {
        score: 0.99,
        payload: {
          canonicalId: "subject:topic:government_spending_on_clean_energy",
          canonicalLabel: "clean power transition",
          subjectKind: "topic",
          aliases: ["green power shift"],
        },
      },
    ]) as unknown as typeof qdrantClient.search;

    const inspection = await inspectConceptResolutionReadOnly({
      session: createGraphCandidateSession([]),
      query: "renewable energy",
      limit: 3,
    });

    expect(inspection.rootCause).toBe("vector_too_conservative");
    expect(inspection.vectorCandidates[0]?.rejectionReason).toBe("lexical_overlap_below_threshold");
  });

  test("classifies empty registry and graph results as no_candidate_anywhere", async () => {
    openaiClient.embeddings.create = (async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    })) as unknown as typeof openaiClient.embeddings.create;
    qdrantClient.scroll = (async () => ({ points: [] })) as unknown as typeof qdrantClient.scroll;
    qdrantClient.search = (async () => []) as unknown as typeof qdrantClient.search;

    const inspection = await inspectConceptResolutionReadOnly({
      session: createGraphCandidateSession([]),
      query: "renewable energy",
      limit: 3,
    });

    expect(inspection.rootCause).toBe("no_candidate_anywhere");
    expect(inspection.graphFallbackHits).toHaveLength(0);
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
      cohort: null,
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

describe("fetchClusterMetricsReadOnly", () => {
  test("computes cohort metrics from Neo4j query rows", async () => {
    let callCount = 0;
    const session: Neo4jReadSessionLike = {
      executeRead: async (work) =>
        work({
          run: async () => {
            callCount += 1;
            if (callCount === 1) {
              return {
                records: [createRecord({ totalUsers: 10 })],
              };
            }

            return {
              records: [
                createRecord({
                  matchedUsers: 6,
                  positiveUsers: 4,
                  negativeUsers: 1,
                  neutralUsers: 1,
                  averageIntensity: 0.58,
                }),
              ],
            };
          },
        }),
    };

    const metrics = await fetchClusterMetricsReadOnly({
      session,
      candidate: null,
      cohort: {
        label: "India users",
        locationRefs: ["India"],
        genderRefs: [],
      },
      userIds: [],
      relationFamilies: [],
      polarityFilter: undefined,
    });

    expect(metrics).toMatchObject({
      totalUsers: 10,
      matchedUsers: 6,
      positiveUsers: 4,
      negativeUsers: 1,
      neutralUsers: 1,
    });
    expect(metrics.positivePct).toBeCloseTo(40);
    expect(metrics.averageIntensity).toBeCloseTo(0.58);
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
        cohort: {
          label: "India users",
          locationRefs: ["India"],
          genderRefs: [],
        },
        metrics: null,
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
        cohort: null,
        metrics: null,
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

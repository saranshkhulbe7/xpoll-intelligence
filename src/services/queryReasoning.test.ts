import { afterEach, describe, expect, test } from "bun:test";
import { neo4jDriver } from "../db/neo4j";
import { qdrantClient } from "../db/qdrant";
import { openaiClient } from "../openai";
import { runReasoningDrivenTerminalGraphQuery } from "./queryReasoning";

const originalCreate = openaiClient.responses.create.bind(openaiClient.responses);
const originalEmbeddingCreate = openaiClient.embeddings.create.bind(openaiClient.embeddings);
const originalScroll = qdrantClient.scroll.bind(qdrantClient);
const originalSearch = qdrantClient.search.bind(qdrantClient);
const originalSession = neo4jDriver.session.bind(neo4jDriver);

afterEach(() => {
  openaiClient.responses.create = originalCreate;
  openaiClient.embeddings.create = originalEmbeddingCreate;
  qdrantClient.scroll = originalScroll;
  qdrantClient.search = originalSearch;
  (neo4jDriver as unknown as { session: typeof neo4jDriver.session }).session = originalSession;
});

function createRecord(payload: Record<string, unknown>) {
  return {
    get(key: string) {
      return payload[key];
    },
  };
}

function installReadSessionMock(args: {
  users?: Record<string, unknown>[];
  assertions?: Record<string, unknown>[];
  metrics?: Record<string, unknown>[];
  graphCandidates?: Record<string, unknown>[];
  totalUsers?: number;
}) {
  (neo4jDriver as unknown as { session: typeof neo4jDriver.session }).session = (() => ({
    executeRead: async (work: (tx: { run: (query: string) => Promise<{ records: ReturnType<typeof createRecord>[] }> }) => Promise<unknown>) =>
      work({
        run: async (query: string) => {
          if (
            query.includes("MATCH (u:User)")
            && !query.includes("MADE_ASSERTION")
            && query.includes("RETURN u.externalAccountId AS externalAccountId")
          ) {
            return {
              records: (args.users ?? []).map(createRecord),
            };
          }

          if (query.includes("MADE_ASSERTION") && query.includes("RETURN u.externalAccountId AS externalAccountId")) {
            return {
              records: (args.assertions ?? []).map(createRecord),
            };
          }

          if (query.includes("RETURN count(DISTINCT u) AS matchedUsers")) {
            return {
              records: (args.metrics ?? []).map(createRecord),
            };
          }

          if (query.includes("MATCH (s:Subject)") && query.includes("RETURN s.canonicalId AS canonicalId")) {
            return {
              records: (args.graphCandidates ?? []).map(createRecord),
            };
          }

          if (query.includes("RETURN count(DISTINCT u) AS totalUsers")) {
            return {
              records: [createRecord({ totalUsers: args.totalUsers ?? 5 })],
            };
          }

          return { records: [] };
        },
      }),
    close: async () => undefined,
  })) as typeof neo4jDriver.session;
}

describe("runReasoningDrivenTerminalGraphQuery", () => {
  test("builds a visible reasoning trace for an exact user/entity query", async () => {
    let llmCall = 0;
    openaiClient.responses.create = (async () => {
      llmCall += 1;
      if (llmCall === 1) {
        return {
          output_text: JSON.stringify({
            supported: true,
            intentType: "user_entity_sentiment",
            userRefs: ["Maya Sen"],
            conceptRefs: ["Joe Biden"],
            cohorts: [],
            relationFamilies: ["sentiment"],
            polarityFilter: null,
            resultLimit: 5,
            needsEvidence: true,
            unsupportedReason: null,
          }),
        };
      }

      return {
        output_text: "Short answer\n- Maya Sen is negative toward Joe Biden on climate policy.\n\nEvidence\n- bench-vote-005 | Has Joe Biden moved U.S. climate policy in the right direction?",
      };
    }) as unknown as typeof openaiClient.responses.create;

    qdrantClient.scroll = (async (_collectionName: string, params: any) => {
      const normalizedLabel = params?.filter?.must?.find((entry: any) => entry.key === "normalizedLabel")?.match?.value;
      const voteId = params?.filter?.must?.find((entry: any) => entry.key === "voteId")?.match?.value;

      if (normalizedLabel === "joe biden") {
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

      if (voteId === "bench-vote-005") {
        return {
          points: [
            {
              payload: {
                voteId: "bench-vote-005",
                finalStatus: "done",
                lastUpdatedAt: "2026-04-06T10:35:35.070Z",
                sourcePath: "/tmp/political-benchmark-100.json",
                rawEvidence: {
                  voteId: "bench-vote-005",
                  voteType: "standalone_poll",
                  selectedOption: "He has made some progress but not enough",
                  voteTimestamps: {
                    respondedAt: "2026-01-16T14:13:00.000Z",
                    seenAt: "2026-01-16T14:11:00.000Z",
                  },
                  poll: {
                    title: "Has Joe Biden moved U.S. climate policy in the right direction?",
                  },
                },
              },
            },
          ],
        };
      }

      return { points: [] };
    }) as unknown as typeof qdrantClient.scroll;

    qdrantClient.search = (async () => []) as unknown as typeof qdrantClient.search;

    installReadSessionMock({
      users: [
        {
          externalAccountId: "bench-user-001",
          username: "maya.sen",
          googleEmail: "mayasen@benchmark.local",
          emailAuthEmail: "mayasen@benchmark.local",
          twitterUsername: null,
          twitterName: null,
        },
      ],
      assertions: [
        {
          externalAccountId: "bench-user-001",
          username: "maya.sen",
          assertionSignature: "assertion-1",
          relationLabel: "negative toward",
          relationFamily: "sentiment",
          polarity: "negative",
          targetCanonicalId: "subject:entity:joe_biden",
          targetLabel: "Joe Biden",
          targetKind: "entity",
          topicCanonicalId: "subject:topic:biden_climate_policy_direction",
          topicLabel: "Biden climate policy direction",
          exactNowIntensity: 0.57,
          confidence: 0.95,
          lastSeenAt: "2026-01-16T14:13:00.000Z",
          firstSeenVoteId: "bench-vote-005",
          lastSeenVoteId: "bench-vote-005",
          evidenceCount: 1,
          latestSelectedOption: "He has made some progress but not enough",
          latestPollTitle: "Has Joe Biden moved U.S. climate policy in the right direction?",
          latestVoteType: "standalone_poll",
          latestSourcePath: "/tmp/political-benchmark-100.json",
        },
      ],
    });

    const answer = await runReasoningDrivenTerminalGraphQuery({
      question: "How does Maya Sen feel about Joe Biden?",
    });

    expect(answer.terminationReason).toBe("completed");
    expect(answer.reasoningTrace.map((step) => step.action)).toEqual([
      "classify_question",
      "resolve_users",
      "search_registry_exact",
      "query_graph_assertions",
      "fetch_qdrant_evidence",
      "finalize_answer",
    ]);
    expect(answer.reasoningTrace[0]?.budgetSnapshot.remainingSteps).toBe(11);
    expect(answer.matchedUsers[0]?.externalAccountId).toBe("bench-user-001");
    expect(answer.clusters[0]?.assertions[0]?.evidence).toHaveLength(1);
  });

  test("finalizes zero-link user/entity queries without fetching evidence and with low confidence", async () => {
    let llmCall = 0;
    openaiClient.responses.create = (async () => {
      llmCall += 1;
      if (llmCall === 1) {
        return {
          output_text: JSON.stringify({
            supported: true,
            intentType: "user_entity_sentiment",
            userRefs: ["Maya Sen"],
            conceptRefs: ["Joe Biden"],
            cohorts: [],
            relationFamilies: ["sentiment"],
            polarityFilter: null,
            resultLimit: 5,
            needsEvidence: true,
            unsupportedReason: null,
          }),
        };
      }

      return {
        output_text: "Short answer\n- The current graph does not link Maya Sen to Joe Biden.\n\nEvidence\n- No connecting assertion was retrieved.",
      };
    }) as unknown as typeof openaiClient.responses.create;

    qdrantClient.scroll = (async (_collectionName: string, params: any) => {
      const normalizedLabel = params?.filter?.must?.find((entry: any) => entry.key === "normalizedLabel")?.match?.value;
      if (normalizedLabel === "joe biden") {
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

    qdrantClient.search = (async () => []) as unknown as typeof qdrantClient.search;

    installReadSessionMock({
      users: [
        {
          externalAccountId: "bench-user-001",
          username: "maya.sen",
          googleEmail: "mayasen@benchmark.local",
          emailAuthEmail: "mayasen@benchmark.local",
          twitterUsername: null,
          twitterName: null,
        },
      ],
      assertions: [],
    });

    const answer = await runReasoningDrivenTerminalGraphQuery({
      question: "How does Maya Sen feel about Joe Biden?",
    });

    expect(answer.reasoningTrace.map((step) => step.action)).toEqual([
      "classify_question",
      "resolve_users",
      "search_registry_exact",
      "query_graph_assertions",
      "finalize_answer",
    ]);
    expect(answer.warnings).toContain("The user and concept matched separately, but no assertion links them in the current graph.");
    expect(answer.finalConfidence).toBeLessThanOrEqual(0.3);
  });

  test("reflects and escalates retrieval when exact and alias concept lookup fail", async () => {
    let llmCall = 0;
    openaiClient.responses.create = (async () => {
      llmCall += 1;
      if (llmCall === 1) {
        return {
          output_text: JSON.stringify({
            supported: true,
            intentType: "user_concept_summary",
            userRefs: ["Ethan Clark"],
            conceptRefs: ["immigration"],
            cohorts: [],
            relationFamilies: [],
            polarityFilter: null,
            resultLimit: 5,
            needsEvidence: true,
            unsupportedReason: null,
          }),
        };
      }

      if (llmCall === 2) {
        return {
          output_text: JSON.stringify({
            technique: "thought-based-reasoning/ReAct",
            reason: "Exact search missed a broad concept, so alias lookup is the next conservative escalation.",
            recommendedAction: "search_registry_alias",
            actionArgs: { query: "immigration" },
            confidence: 0.71,
            unsupportedReason: null,
          }),
        };
      }

      if (llmCall === 3) {
        return {
          output_text: JSON.stringify({
            technique: "thought-based-reasoning/ReAct",
            reason: "Alias search also missed, so vector retrieval is now justified.",
            recommendedAction: "search_registry_vector",
            actionArgs: { query: "immigration" },
            confidence: 0.78,
            unsupportedReason: null,
          }),
        };
      }

      return {
        output_text: "Short answer\n- Ethan Clark appears restrictive on related immigration concept clusters.\n\nEvidence\n- bench-vote-002 | Should undocumented immigrants who pass background checks get a path to citizenship?",
      };
    }) as unknown as typeof openaiClient.responses.create;

    openaiClient.embeddings.create = (async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    })) as unknown as typeof openaiClient.embeddings.create;

    qdrantClient.scroll = (async (_collectionName: string, params: any) => {
      const normalizedLabel = params?.filter?.must?.find((entry: any) => entry.key === "normalizedLabel")?.match?.value;
      const aliasValue = params?.filter?.should?.[0]?.match?.value;
      const voteId = params?.filter?.must?.find((entry: any) => entry.key === "voteId")?.match?.value;

      if (normalizedLabel === "immigration" || aliasValue === "immigration") {
        return { points: [] };
      }

      if (voteId === "bench-vote-002") {
        return {
          points: [
            {
              payload: {
                voteId: "bench-vote-002",
                finalStatus: "done",
                lastUpdatedAt: "2026-04-06T10:27:07.549Z",
                sourcePath: "/tmp/political-benchmark-100.json",
                rawEvidence: {
                  voteId: "bench-vote-002",
                  voteType: "standalone_poll",
                  selectedOption: "Reject any pathway and prioritize deportation",
                  voteTimestamps: {
                    respondedAt: "2026-01-03T11:02:00.000Z",
                    seenAt: "2026-01-03T11:00:00.000Z",
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

    qdrantClient.search = (async () => [
      {
        score: 0.99,
        payload: {
          canonicalId: "subject:topic:legal_status_for_undocumented_immigrants",
          canonicalLabel: "legal status for undocumented immigrants",
          subjectKind: "topic",
          aliases: ["immigration legal status", "path to citizenship"],
        },
      },
    ]) as unknown as typeof qdrantClient.search;

    installReadSessionMock({
      users: [
        {
          externalAccountId: "bench-user-006",
          username: "ethan.clark",
          googleEmail: "ethanclark@benchmark.local",
          emailAuthEmail: "ethanclark@benchmark.local",
          twitterUsername: null,
          twitterName: null,
        },
      ],
      assertions: [
        {
          externalAccountId: "bench-user-006",
          username: "ethan.clark",
          assertionSignature: "assertion-2",
          relationLabel: "opposes",
          relationFamily: "support",
          polarity: "negative",
          targetCanonicalId: "subject:position:pathway",
          targetLabel: "pathway to citizenship for undocumented immigrants",
          targetKind: "position",
          topicCanonicalId: "subject:topic:legal_status_for_undocumented_immigrants",
          topicLabel: "legal status for undocumented immigrants",
          exactNowIntensity: 0.57,
          confidence: 0.95,
          lastSeenAt: "2026-01-03T11:02:00.000Z",
          firstSeenVoteId: "bench-vote-002",
          lastSeenVoteId: "bench-vote-002",
          evidenceCount: 1,
          latestSelectedOption: "Reject any pathway and prioritize deportation",
          latestPollTitle: "Should undocumented immigrants who pass background checks get a path to citizenship?",
          latestVoteType: "standalone_poll",
          latestSourcePath: "/tmp/political-benchmark-100.json",
        },
      ],
    });

    const answer = await runReasoningDrivenTerminalGraphQuery({
      question: "What does Ethan Clark think about immigration?",
    });

    expect(answer.reasoningTrace.map((step) => step.action)).toContain("reflect_on_gaps");
    expect(answer.reasoningTrace.map((step) => step.action)).toContain("search_registry_alias");
    expect(answer.reasoningTrace.map((step) => step.action)).toContain("search_registry_vector");
    expect(answer.reasoningTrace.find((step) => step.action === "search_registry_vector")?.isRevision).toBe(true);
    expect(answer.clusters[0]?.matchedConcept?.canonicalId).toBe("subject:topic:legal_status_for_undocumented_immigrants");
  });

  test("finalizes broad no-hit concept queries after graph fallback miss without alias-loop warnings", async () => {
    let llmCall = 0;
    openaiClient.responses.create = (async () => {
      llmCall += 1;
      if (llmCall === 1) {
        return {
          output_text: JSON.stringify({
            supported: true,
            intentType: "user_concept_summary",
            userRefs: ["Ethan Clark"],
            conceptRefs: ["immigration"],
            cohorts: [],
            relationFamilies: ["support", "preference", "sentiment", "uncertainty"],
            polarityFilter: null,
            resultLimit: 5,
            needsEvidence: true,
            unsupportedReason: null,
          }),
        };
      }

      if (llmCall === 2) {
        return {
          output_text: JSON.stringify({
            technique: "thought-based-reasoning/ReAct",
            reason: "Exact search missed, so alias lookup is the next conservative step.",
            recommendedAction: "search_registry_alias",
            actionArgs: { query: "immigration" },
            confidence: 0.74,
            unsupportedReason: null,
          }),
        };
      }

      throw new Error(`Unexpected extra LLM call ${llmCall}`);
    }) as unknown as typeof openaiClient.responses.create;

    openaiClient.embeddings.create = (async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    })) as unknown as typeof openaiClient.embeddings.create;

    qdrantClient.scroll = (async () => ({ points: [] })) as unknown as typeof qdrantClient.scroll;
    qdrantClient.search = (async () => []) as unknown as typeof qdrantClient.search;

    installReadSessionMock({
      users: [
        {
          externalAccountId: "bench-user-006",
          username: "ethan.clark",
          googleEmail: "ethanclark@benchmark.local",
          emailAuthEmail: "ethanclark@benchmark.local",
          twitterUsername: null,
          twitterName: null,
        },
      ],
      assertions: [],
    });

    const answer = await runReasoningDrivenTerminalGraphQuery({
      question: "What does Ethan Clark think about immigration?",
    });

    expect(answer.terminationReason).toBe("completed");
    expect(answer.reasoningTrace.map((step) => step.action)).toEqual([
      "classify_question",
      "resolve_users",
      "search_registry_exact",
      "reflect_on_gaps",
      "search_registry_alias",
      "search_registry_vector",
      "search_graph_fallback",
      "finalize_answer",
    ]);
    expect(answer.reasoningTrace.filter((step) => step.action === "search_registry_alias")).toHaveLength(1);
    expect(answer.warnings).toContain("No concept match was found for: immigration.");
    expect(answer.warnings).toContain('Graph fallback also found no matching concept candidate for "immigration".');
    expect(answer.warnings.some((warning) => warning.includes("normalized it to search_registry_vector"))).toBe(false);
    expect(answer.finalConfidence).toBeLessThanOrEqual(0.25);
    expect(answer.answerText).toContain("concept did not resolve to a known subject");
    expect(llmCall).toBe(2);
  });

  test("recovers renewable-energy cohort queries through graph fallback and returns a gender comparison", async () => {
    let llmCall = 0;
    openaiClient.responses.create = (async () => {
      llmCall += 1;
      if (llmCall === 1) {
        return {
          output_text: JSON.stringify({
            supported: true,
            intentType: "concept_cohort_summary",
            userRefs: [],
            conceptRefs: ["renewable energy"],
            cohorts: [
              { label: "female", locationRefs: [], genderRefs: ["female"] },
              { label: "male", locationRefs: [], genderRefs: ["male"] },
            ],
            relationFamilies: ["support", "sentiment", "preference", "uncertainty"],
            polarityFilter: null,
            resultLimit: 5,
            needsEvidence: true,
            unsupportedReason: null,
          }),
        };
      }

      if (llmCall === 2) {
        return {
          output_text: JSON.stringify({
            technique: "thought-based-reasoning/ReAct",
            reason: "Exact search missed, so alias lookup is the next conservative step.",
            recommendedAction: "search_registry_alias",
            actionArgs: { query: "renewable energy" },
            confidence: 0.74,
            unsupportedReason: null,
          }),
        };
      }

      if (llmCall === 3) {
        return {
          output_text: JSON.stringify({
            technique: "second-order-thinking",
            reason: "Metrics, assertions, and evidence are already loaded, so the comparison is ready to finalize.",
            recommendedAction: "finalize_answer",
            actionArgs: { note: "finalize_after_graph_fallback" },
            confidence: 0.77,
            unsupportedReason: null,
          }),
        };
      }

      return {
        output_text: "Short answer\n- Female and male cohorts both have assertion-backed signals on the recovered clean-energy topic.\n\nEvidence\n- The topic resolved through graph fallback and both cohorts have retrieved metrics.",
      };
    }) as unknown as typeof openaiClient.responses.create;

    openaiClient.embeddings.create = (async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    })) as unknown as typeof openaiClient.embeddings.create;

    qdrantClient.scroll = (async (_collectionName: string, params: any) => {
      const normalizedLabel = params?.filter?.must?.find((entry: any) => entry.key === "normalizedLabel")?.match?.value;
      const aliasValue = params?.filter?.should?.[0]?.match?.value;
      const voteId = params?.filter?.must?.find((entry: any) => entry.key === "voteId")?.match?.value;

      if (normalizedLabel === "renewable energy" || aliasValue === "renewable energy") {
        return { points: [] };
      }

      if (voteId === "bench-vote-018") {
        return {
          points: [
            {
              payload: {
                voteId: "bench-vote-018",
                finalStatus: "done",
                sourcePath: "/tmp/political-benchmark-100.json",
                rawEvidence: {
                  voteId: "bench-vote-018",
                  voteType: "standalone_poll",
                  selectedOption: "Balance renewables with existing energy sources",
                  voteTimestamps: {
                    respondedAt: "2026-01-06T12:05:00.000Z",
                    seenAt: "2026-01-06T12:03:00.000Z",
                  },
                  poll: {
                    title: "Should government invest heavily in renewable energy even if bills rise in the short term?",
                  },
                },
              },
            },
          ],
        };
      }

      return { points: [] };
    }) as unknown as typeof qdrantClient.scroll;

    qdrantClient.search = (async () => []) as unknown as typeof qdrantClient.search;

    installReadSessionMock({
      graphCandidates: [
        {
          canonicalId: "subject:topic:government_spending_on_clean_energy",
          label: "government spending on clean energy",
          kind: "topic",
          topicCanonicalId: null,
          assertionCount: 6,
        },
      ],
      metrics: [
        {
          matchedUsers: 3,
          positiveUsers: 2,
          negativeUsers: 1,
          neutralUsers: 0,
          averageIntensity: 0.62,
        },
      ],
      assertions: [
        {
          externalAccountId: "bench-user-015",
          username: "emma.collins",
          assertionSignature: "assertion-714",
          relationLabel: "is uncertain about",
          relationFamily: "uncertainty",
          polarity: "neutral",
          targetCanonicalId: "subject:position:balanced_transition",
          targetLabel: "balanced transition between renewables and existing energy sources",
          targetKind: "position",
          topicCanonicalId: "subject:topic:government_spending_on_clean_energy",
          topicLabel: "government spending on clean energy",
          exactNowIntensity: 0.54,
          confidence: 0.95,
          lastSeenAt: "2026-01-06T12:05:00.000Z",
          firstSeenVoteId: "bench-vote-018",
          lastSeenVoteId: "bench-vote-018",
          evidenceCount: 1,
          latestSelectedOption: "Balance renewables with existing energy sources",
          latestPollTitle: "Should government invest heavily in renewable energy even if bills rise in the short term?",
          latestVoteType: "standalone_poll",
          latestSourcePath: "/tmp/political-benchmark-100.json",
        },
      ],
      totalUsers: 5,
    });

    const answer = await runReasoningDrivenTerminalGraphQuery({
      question: "what are people view on renewable energy, gender wise",
    });

    expect(answer.terminationReason).toBe("completed");
    expect(answer.reasoningTrace.map((step) => step.action)).toEqual([
      "classify_question",
      "resolve_cohorts",
      "search_registry_exact",
      "reflect_on_gaps",
      "search_registry_alias",
      "search_registry_vector",
      "search_graph_fallback",
      "query_graph_metrics",
      "query_graph_assertions",
      "fetch_qdrant_evidence",
      "reflect_on_gaps",
      "finalize_answer",
    ]);
    expect(answer.clusters).toHaveLength(2);
    expect(answer.clusters.every((cluster) => cluster.matchedConcept?.matchType === "graph_fallback")).toBe(true);
    expect(answer.clusters.every((cluster) => cluster.metrics?.matchedUsers === 3)).toBe(true);
    expect(answer.warnings.some((warning) => warning.includes("No concept match"))).toBe(false);
    expect(answer.warnings.some((warning) => warning.includes("normalized it to search_registry_vector"))).toBe(false);
  });

  test("finalizes exact cohort comparisons after metrics, assertions, and evidence without repeating metrics", async () => {
    let llmCall = 0;
    openaiClient.responses.create = (async () => {
      llmCall += 1;
      if (llmCall === 1) {
        return {
          output_text: JSON.stringify({
            supported: true,
            intentType: "concept_cohort_summary",
            userRefs: [],
            conceptRefs: ["government spending on clean energy"],
            cohorts: [
              { label: "male users", locationRefs: [], genderRefs: ["male"] },
              { label: "female users", locationRefs: [], genderRefs: ["female"] },
            ],
            relationFamilies: ["support", "preference", "sentiment", "uncertainty"],
            polarityFilter: null,
            resultLimit: 5,
            needsEvidence: true,
            unsupportedReason: null,
          }),
        };
      }

      if (llmCall === 2) {
        return {
          output_text: JSON.stringify({
            technique: "second-order-thinking",
            reason: "The comparison should recompute metrics before answering.",
            recommendedAction: "query_graph_metrics",
            actionArgs: { note: "repeat_metrics" },
            confidence: 0.63,
            unsupportedReason: null,
          }),
        };
      }

      return {
        output_text: "Short answer\n- Male and female cohorts both have assertion-backed evidence for this topic, and the comparison is ready to answer.\n\nEvidence\n- Metrics and representative assertions were retrieved.",
      };
    }) as unknown as typeof openaiClient.responses.create;

    qdrantClient.scroll = (async (_collectionName: string, params: any) => {
      const normalizedLabel = params?.filter?.must?.find((entry: any) => entry.key === "normalizedLabel")?.match?.value;
      const voteId = params?.filter?.must?.find((entry: any) => entry.key === "voteId")?.match?.value;

      if (normalizedLabel === "government spending on clean energy") {
        return {
          points: [
            {
              payload: {
                canonicalId: "subject:topic:government_spending_on_clean_energy",
                canonicalLabel: "government spending on clean energy",
                subjectKind: "topic",
                aliases: ["public investment in renewables"],
              },
            },
          ],
        };
      }

      if (voteId === "bench-vote-018") {
        return {
          points: [
            {
              payload: {
                voteId: "bench-vote-018",
                finalStatus: "done",
                sourcePath: "/tmp/political-benchmark-100.json",
                rawEvidence: {
                  voteId: "bench-vote-018",
                  voteType: "standalone_poll",
                  selectedOption: "Balance renewables with existing energy sources",
                  voteTimestamps: {
                    respondedAt: "2026-01-06T12:05:00.000Z",
                    seenAt: "2026-01-06T12:03:00.000Z",
                  },
                  poll: {
                    title: "Should government invest heavily in renewable energy even if bills rise in the short term?",
                  },
                },
              },
            },
          ],
        };
      }

      return { points: [] };
    }) as unknown as typeof qdrantClient.scroll;

    qdrantClient.search = (async () => []) as unknown as typeof qdrantClient.search;

    installReadSessionMock({
      metrics: [
        {
          matchedUsers: 3,
          positiveUsers: 2,
          negativeUsers: 1,
          neutralUsers: 0,
          averageIntensity: 0.62,
        },
      ],
      assertions: [
        {
          externalAccountId: "bench-user-015",
          username: "emma.collins",
          assertionSignature: "assertion-714",
          relationLabel: "is uncertain about",
          relationFamily: "uncertainty",
          polarity: "neutral",
          targetCanonicalId: "subject:position:balanced_transition",
          targetLabel: "balanced transition between renewables and existing energy sources",
          targetKind: "position",
          topicCanonicalId: "subject:topic:government_spending_on_clean_energy",
          topicLabel: "government spending on clean energy",
          exactNowIntensity: 0.54,
          confidence: 0.95,
          lastSeenAt: "2026-01-06T12:05:00.000Z",
          firstSeenVoteId: "bench-vote-018",
          lastSeenVoteId: "bench-vote-018",
          evidenceCount: 1,
          latestSelectedOption: "Balance renewables with existing energy sources",
          latestPollTitle: "Should government invest heavily in renewable energy even if bills rise in the short term?",
          latestVoteType: "standalone_poll",
          latestSourcePath: "/tmp/political-benchmark-100.json",
        },
      ],
    });

    const answer = await runReasoningDrivenTerminalGraphQuery({
      question: "Compare male and female users on government spending on clean energy",
    });

    expect(answer.terminationReason).toBe("completed");
    expect(answer.reasoningTrace.map((step) => step.action)).toEqual([
      "classify_question",
      "resolve_cohorts",
      "search_registry_exact",
      "query_graph_metrics",
      "query_graph_assertions",
      "fetch_qdrant_evidence",
      "reflect_on_gaps",
      "finalize_answer",
    ]);
    expect(answer.reasoningTrace.filter((step) => step.action === "query_graph_metrics")).toHaveLength(1);
    expect(answer.clusters.every((cluster) => cluster.metrics !== null)).toBe(true);
    expect(answer.reasoningTrace.find((step) => step.action === "reflect_on_gaps")?.observationData).toEqual(
      expect.objectContaining({
        recommendedAction: "finalize_answer",
      }),
    );
  });

  test("falls back deterministically when reflection fails during cohort reasoning", async () => {
    let llmCall = 0;
    openaiClient.responses.create = (async () => {
      llmCall += 1;
      if (llmCall === 1) {
        return {
          output_text: JSON.stringify({
            supported: true,
            intentType: "concept_cohort_summary",
            userRefs: [],
            conceptRefs: ["healthcare coverage policy"],
            cohorts: [
              { label: "male users", locationRefs: [], genderRefs: ["male"] },
              { label: "female users", locationRefs: [], genderRefs: ["female"] },
            ],
            relationFamilies: ["support", "preference", "sentiment", "uncertainty"],
            polarityFilter: null,
            resultLimit: 5,
            needsEvidence: true,
            unsupportedReason: null,
          }),
        };
      }

      if (llmCall === 2) {
        throw new Error("400 Invalid schema for response_format 'query_gap_reflection'");
      }

      return {
        output_text: "Short answer\n- The healthcare concept matched and cohort metrics were computed, but no representative assertions were retrieved.\n\nEvidence\n- Reflection fallback was used.",
      };
    }) as unknown as typeof openaiClient.responses.create;

    qdrantClient.scroll = (async (_collectionName: string, params: any) => {
      const normalizedLabel = params?.filter?.must?.find((entry: any) => entry.key === "normalizedLabel")?.match?.value;
      const aliasValue = params?.filter?.should?.[0]?.match?.value;

      if (normalizedLabel === "healthcare coverage policy") {
        return { points: [] };
      }

      if (aliasValue === "healthcare coverage policy") {
        return {
          points: [
            {
              payload: {
                canonicalId: "subject:topic:healthcare_coverage_policy",
                canonicalLabel: "healthcare coverage policy",
                subjectKind: "topic",
                aliases: ["healthcare system design"],
              },
            },
          ],
        };
      }

      return { points: [] };
    }) as unknown as typeof qdrantClient.scroll;

    qdrantClient.search = (async () => []) as unknown as typeof qdrantClient.search;

    installReadSessionMock({
      metrics: [
        {
          matchedUsers: 3,
          positiveUsers: 2,
          negativeUsers: 1,
          neutralUsers: 0,
          averageIntensity: 0.62,
        },
      ],
      assertions: [],
    });

    const answer = await runReasoningDrivenTerminalGraphQuery({
      question: "Compare male and female users on healthcare coverage policy",
    });

    expect(answer.terminationReason).toBe("completed");
    expect(answer.reasoningTrace.map((step) => step.action)).toContain("reflect_on_gaps");
    expect(answer.reasoningTrace.map((step) => step.action)).toContain("search_registry_alias");
    expect(answer.reasoningTrace.map((step) => step.action)).not.toContain("search_registry_vector");
    expect(answer.warnings.some((warning) => warning.includes("Reflection step failed"))).toBe(true);
    expect(answer.clusters[0]?.metrics?.matchedUsers).toBe(3);
  });
});

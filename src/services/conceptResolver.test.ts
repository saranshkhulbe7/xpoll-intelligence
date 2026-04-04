import { afterEach, describe, expect, test } from "bun:test";
import { qdrantClient } from "../db/qdrant";
import type { InferredSemantics, PollSemanticTemplate, RawVote } from "../types";
import {
  acceptsConservativeVectorMatch,
  buildQdrantRegistryPointId,
  canonicalizeRelation,
  resolveSemanticRegistry,
} from "./conceptResolver";

const originalScroll = qdrantClient.scroll.bind(qdrantClient);
const originalSearch = qdrantClient.search.bind(qdrantClient);
const originalUpsert = qdrantClient.upsert.bind(qdrantClient);

afterEach(() => {
  qdrantClient.scroll = originalScroll;
  qdrantClient.search = originalSearch;
  qdrantClient.upsert = originalUpsert;
});

describe("buildQdrantRegistryPointId", () => {
  test("builds a deterministic UUID-shaped point id from the logical registry id", () => {
    const first = buildQdrantRegistryPointId("subject:position:jobs-and-workforce");
    const second = buildQdrantRegistryPointId("subject:position:jobs-and-workforce");
    const third = buildQdrantRegistryPointId("subject:topic:healthcare-policy");

    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("canonicalizeRelation", () => {
  test("maps support phrasing to supports", () => {
    expect(canonicalizeRelation({ relationFamily: "support", polarity: "positive" })).toEqual({
      relationId: "relation:support:positive:supports",
      relationLabel: "supports",
      relationFamily: "support",
      polarity: "positive",
    });
  });

  test("maps opposition phrasing to opposes", () => {
    expect(canonicalizeRelation({ relationFamily: "opposition", polarity: "negative" })).toEqual({
      relationId: "relation:support:negative:opposes",
      relationLabel: "opposes",
      relationFamily: "support",
      polarity: "negative",
    });
  });

  test("maps neutral sentiment to uncertain about", () => {
    expect(canonicalizeRelation({ relationFamily: "sentiment", polarity: "neutral" })).toEqual({
      relationId: "relation:uncertainty:neutral:uncertain_about",
      relationLabel: "uncertain about",
      relationFamily: "uncertainty",
      polarity: "neutral",
    });
  });
});

describe("acceptsConservativeVectorMatch", () => {
  test("accepts close topic matches with meaningful lexical overlap", () => {
    expect(
      acceptsConservativeVectorMatch({
        kind: "topic",
        score: 0.98,
        inputLabel: "legal status for undocumented immigrants",
        candidateLabel: "legal status of undocumented immigrants",
      }),
    ).toBe(true);
  });

  test("rejects vector-only topic matches without enough lexical overlap", () => {
    expect(
      acceptsConservativeVectorMatch({
        kind: "topic",
        score: 0.99,
        inputLabel: "legal status for undocumented immigrants",
        candidateLabel: "renewable energy transition policy",
      }),
    ).toBe(false);
  });
});

describe("resolveSemanticRegistry", () => {
  test("reuses an existing subject through alias matching before vector search", async () => {
    const vote: RawVote = {
      voteId: "vote-1",
      type: "standalone_poll",
      voter: {
        externalAccountId: "user-1",
      },
      poll: {
        pollId: "poll-1",
        title: "Did Bernie Sanders push the healthcare debate in a helpful direction?",
        options: [{ text: "Yes", isSelected: true }],
      },
    };

    const semantics: InferredSemantics = {
      assertions: [
        {
          relationFamily: "sentiment",
          polarity: "positive",
          targetKind: "entity",
          targetLabel: "Senator Bernard Sanders",
          confidence: 0.95,
          notes: ["entity sentiment"],
        },
      ],
      notes: [],
    };

    const pollTemplate: PollSemanticTemplate = {
      pollKey: "poll:poll-1",
      pollFingerprint: "poll-fingerprint-1",
      canonicalTopic: {
        label: "healthcare debate",
        aliases: ["healthcare reform debate"],
      },
      options: [
        {
          optionText: "Yes",
          canonicalTargetLabel: "Senator Bernard Sanders",
          targetKind: "entity",
          relationFamily: "sentiment",
          polarity: "positive",
          intensityBand: "strong",
          aliases: ["Bernie Sanders"],
          notes: [],
        },
      ],
      notes: [],
    };

    qdrantClient.scroll = (async (_collectionName: string, params: any) => {
      const aliasKey = params?.filter?.should?.[0]?.key;
      if (aliasKey === "aliasesNormalized") {
        return {
          points: [
            {
              id: "subject-point-1",
              payload: {
                canonicalId: "subject:entity:bernie_sanders",
                canonicalLabel: "Bernie Sanders",
                aliases: ["Senator Bernie Sanders"],
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
    qdrantClient.upsert = (async () => {
      throw new Error("Registry upsert should not run when alias matching succeeds.");
    }) as unknown as typeof qdrantClient.upsert;

    const result = await resolveSemanticRegistry({
      vote,
      semantics,
      pollTemplate,
    });

    expect(result.resolvedAssertions).toHaveLength(1);
    expect(result.resolvedAssertions[0]?.target.canonicalId).toBe("subject:entity:bernie_sanders");
    expect(result.resolvedAssertions[0]?.target.matchType).toBe("exact");
  });
});

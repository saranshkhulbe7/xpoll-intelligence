import { describe, expect, test } from "bun:test";
import { buildQdrantRegistryPointId, canonicalizeRelation } from "./conceptResolver";

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

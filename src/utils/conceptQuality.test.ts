import { describe, expect, test } from "bun:test";
import { filterEntityAliases, isValidEntityAlias } from "./conceptQuality";

describe("entity alias hygiene", () => {
  test("rejects stance-like aliases for entity concepts", () => {
    expect(isValidEntityAlias("strong progress", "Joe Biden")).toBe(false);
    expect(isValidEntityAlias("positive leadership", "Joe Biden")).toBe(false);
    expect(isValidEntityAlias("Has Joe Biden", "Joe Biden")).toBe(false);
  });

  test("keeps only entity-like aliases with name overlap", () => {
    expect(
      filterEntityAliases("Joe Biden", [
        "Joe Biden",
        "President Joe Biden",
        "strong progress",
        "positive leadership",
        "Has Joe Biden",
      ]),
    ).toEqual(["Joe Biden", "President Joe Biden"]);
  });
});

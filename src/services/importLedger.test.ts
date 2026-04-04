import { describe, expect, test } from "bun:test";
import { buildQdrantProgressPointId } from "./importLedger";

describe("buildQdrantProgressPointId", () => {
  test("builds a deterministic UUID-shaped point id from the processing key", () => {
    const first = buildQdrantProgressPointId("votes_test::vote-1");
    const second = buildQdrantProgressPointId("votes_test::vote-1");
    const third = buildQdrantProgressPointId("votes_test::vote-2");

    expect(first).toBe(second);
    expect(third).not.toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

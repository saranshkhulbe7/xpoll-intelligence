import { describe, expect, test } from "bun:test";
import { buildResetSummary } from "./resetShared";

describe("buildResetSummary", () => {
  test("marks a partial reset when only one store completed", () => {
    const summary = buildResetSummary({
      neo4j: {
        status: "completed",
        database: "neo4j",
        nodesDeleted: 42,
      },
      qdrant: {
        status: "failed",
        url: "https://example.qdrant.io",
        conceptCollection: {
          name: "semantic_registry_v2",
          deleteStatus: "deleted",
          recreated: true,
        },
        progressCollection: {
          name: "import_progress",
          deleteStatus: "deleted",
          recreated: false,
        },
        error: "timeout",
      },
    });

    expect(summary.success).toBe(false);
    expect(summary.partialReset).toBe(true);
    expect(summary.neo4j.status).toBe("completed");
    expect(summary.qdrant.status).toBe("failed");
  });

  test("marks a successful reset when both stores completed", () => {
    const summary = buildResetSummary({
      neo4j: {
        status: "completed",
        database: "neo4j",
        nodesDeleted: 12,
      },
      qdrant: {
        status: "completed",
        url: "https://example.qdrant.io",
        conceptCollection: {
          name: "semantic_registry_v2",
          deleteStatus: "missing",
          recreated: true,
        },
        progressCollection: {
          name: "import_progress",
          deleteStatus: "deleted",
          recreated: true,
        },
      },
    });

    expect(summary.success).toBe(true);
    expect(summary.partialReset).toBe(false);
  });
});

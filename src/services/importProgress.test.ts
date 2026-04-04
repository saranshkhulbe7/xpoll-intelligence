import { describe, expect, test } from "bun:test";
import { buildImportSummary, buildVoteProgressLog, createImportRunMetrics, recordVoteOutcome } from "./importProgress";

describe("importProgress", () => {
  test("builds exact per-vote progress from total count", () => {
    let metrics = createImportRunMetrics(4);
    metrics = recordVoteOutcome(metrics, "completed");
    metrics = recordVoteOutcome(metrics, "noop");

    expect(
      buildVoteProgressLog({
        voteId: "vote-2",
        outcome: "noop",
        metrics,
      }),
    ).toEqual({
      voteId: "vote-2",
      outcome: "noop",
      progress: {
        processedVotes: 2,
        totalVotes: 4,
        percentage: "50.00%",
      },
    });
  });

  test("summarizes mixed outcomes correctly", () => {
    let metrics = createImportRunMetrics(5);
    metrics = recordVoteOutcome(metrics, "completed");
    metrics = recordVoteOutcome(metrics, "skipped");
    metrics = recordVoteOutcome(metrics, "retryable_failure");
    metrics = recordVoteOutcome(metrics, "conflict");
    metrics = recordVoteOutcome(metrics, "unexpected_failure");

    expect(buildImportSummary(metrics)).toEqual({
      totalVotes: 5,
      handledCount: 5,
      processedCount: 1,
      skippedCount: 1,
      retryableFailureCount: 2,
      conflictCount: 1,
    });
  });
});

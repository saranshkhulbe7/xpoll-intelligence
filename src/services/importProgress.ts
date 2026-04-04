import type { ProcessVoteResult } from "./importProcessor";

export type VoteProgressOutcome = ProcessVoteResult["outcome"] | "unexpected_failure";

export type ImportRunMetrics = {
  totalVotes: number;
  handledCount: number;
  processedCount: number;
  skippedCount: number;
  retryableFailureCount: number;
  conflictCount: number;
};

function formatPercentage(handledCount: number, totalVotes: number): string {
  if (totalVotes === 0) {
    return "100.00%";
  }

  return `${((handledCount / totalVotes) * 100).toFixed(2)}%`;
}

export function createImportRunMetrics(totalVotes: number): ImportRunMetrics {
  return {
    totalVotes,
    handledCount: 0,
    processedCount: 0,
    skippedCount: 0,
    retryableFailureCount: 0,
    conflictCount: 0,
  };
}

export function recordVoteOutcome(
  metrics: ImportRunMetrics,
  outcome: VoteProgressOutcome,
): ImportRunMetrics {
  const nextMetrics: ImportRunMetrics = {
    ...metrics,
    handledCount: metrics.handledCount + 1,
  };

  if (outcome === "completed") {
    nextMetrics.processedCount += 1;
    return nextMetrics;
  }

  if (outcome === "skipped" || outcome === "noop") {
    nextMetrics.skippedCount += 1;
    return nextMetrics;
  }

  if (outcome === "conflict") {
    nextMetrics.conflictCount += 1;
    return nextMetrics;
  }

  nextMetrics.retryableFailureCount += 1;
  return nextMetrics;
}

export function buildVoteProgressLog(args: {
  voteId: string;
  outcome: VoteProgressOutcome;
  metrics: ImportRunMetrics;
}): {
  voteId: string;
  outcome: VoteProgressOutcome;
  progress: {
    processedVotes: number;
    totalVotes: number;
    percentage: string;
  };
} {
  return {
    voteId: args.voteId,
    outcome: args.outcome,
    progress: {
      processedVotes: args.metrics.handledCount,
      totalVotes: args.metrics.totalVotes,
      percentage: formatPercentage(args.metrics.handledCount, args.metrics.totalVotes),
    },
  };
}

export function buildImportSummary(metrics: ImportRunMetrics): ImportRunMetrics {
  return { ...metrics };
}

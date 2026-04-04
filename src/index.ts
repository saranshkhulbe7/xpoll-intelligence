import { basename } from "node:path";
import { config } from "./config";
import { ensureQdrantCollection, ensureQdrantProgressCollection } from "./db/qdrant";
import { closeNeo4j, verifyNeo4jConnection } from "./db/neo4j";
import { countVotes, iterateVotes, resolveVoteInput } from "./services/loadVotes";
import { buildImportSummary, buildVoteProgressLog, createImportRunMetrics, recordVoteOutcome } from "./services/importProgress";
import { processVote } from "./services/importProcessor";
import { validateDatasetModePath } from "./utils/datasetMode";

const STARTUP_NETWORK_TIMEOUT_MS = 20_000;

function logInfo(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function logError(message: string, error?: unknown): void {
  if (error === undefined) {
    console.error(`[${new Date().toISOString()}] ${message}`);
    return;
  }

  console.error(`[${new Date().toISOString()}] ${message}`, error);
}

async function withTimeout<T>(label: string, timeoutMs: number, action: () => Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      action(),
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function runStartupStep<T>(label: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  logInfo(`${label}...`);

  try {
    const result = await action();
    logInfo(`${label} completed in ${Date.now() - startedAt}ms.`);
    return result;
  } catch (error) {
    logError(`${label} failed after ${Date.now() - startedAt}ms.`, error);
    throw error;
  }
}

process.on("beforeExit", (code) => {
  logInfo(`Process beforeExit fired with code ${code}.`);
});

process.on("exit", (code) => {
  console.log(`[${new Date().toISOString()}] Process exit fired with code ${code}.`);
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled promise rejection.", reason);
  process.exitCode = 1;
});

process.on("uncaughtException", (error) => {
  logError("Uncaught exception.", error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  logInfo("Starting resumable Bun vote graph importer.");
  logInfo(`Neo4j target: ${config.neo4j.uri} (database: ${config.neo4j.database}).`);
  logInfo(`Qdrant target: ${config.qdrant.url}.`);
  logInfo(`Dataset mode: ${config.datasetMode}.`);
  logInfo(`Vote input path: ${config.votesJsonPath}.`);
  logInfo(
    config.processTillFirstNVotes === null
      ? "Vote processing cap: all votes."
      : `Vote processing cap: first ${config.processTillFirstNVotes} vote(s).`,
  );

  await runStartupStep(
    `Verifying Neo4j connectivity with ${STARTUP_NETWORK_TIMEOUT_MS}ms timeout`,
    () => withTimeout("Neo4j connectivity verification", STARTUP_NETWORK_TIMEOUT_MS, verifyNeo4jConnection),
  );

  await runStartupStep(
    `Ensuring Qdrant semantic registry collection with ${STARTUP_NETWORK_TIMEOUT_MS}ms timeout`,
    () => withTimeout("Qdrant semantic registry collection check", STARTUP_NETWORK_TIMEOUT_MS, ensureQdrantCollection),
  );
  await runStartupStep(
    `Ensuring Qdrant progress collection with ${STARTUP_NETWORK_TIMEOUT_MS}ms timeout`,
    () => withTimeout("Qdrant progress collection check", STARTUP_NETWORK_TIMEOUT_MS, ensureQdrantProgressCollection),
  );

  const voteInput = await runStartupStep(
    `Resolving vote input at ${config.votesJsonPath}`,
    () => resolveVoteInput(config.votesJsonPath),
  );
  await runStartupStep(`Validating dataset mode guardrails for ${voteInput.resolvedPath}`, async () => {
    validateDatasetModePath({
      datasetMode: config.datasetMode,
      resolvedPath: voteInput.resolvedPath,
    });
  });
  logInfo(
    voteInput.inputKind === "directory"
      ? `Streaming votes from directory ${voteInput.resolvedPath}`
      : `Streaming votes from file ${voteInput.resolvedPath}`,
  );
  logInfo(`Resolved ${voteInput.sources.length} vote source file(s).`);
  logInfo(
    config.processTillFirstNVotes === null
      ? "Counting votes across all source files before processing."
      : `Counting up to the first ${config.processTillFirstNVotes} vote(s) before processing.`,
  );

  let totalVotes = 0;
  for (const [sourceNumber, source] of voteInput.sources.entries()) {
    const remainingVotes =
      config.processTillFirstNVotes === null
        ? undefined
        : config.processTillFirstNVotes - totalVotes;

    if (remainingVotes !== undefined && remainingVotes <= 0) {
      break;
    }

    const fileName = basename(source.sourcePath);
    const sourceTotal = await runStartupStep(
      `Counting votes in source ${sourceNumber + 1}/${voteInput.sources.length} (${fileName})`,
      () => countVotes(source, remainingVotes),
    );
    totalVotes += sourceTotal;
    logInfo(`Running vote count is ${totalVotes} after ${fileName}.`);
  }

  logInfo(
    config.processTillFirstNVotes === null
      ? `Detected ${totalVotes} votes across ${voteInput.sources.length} input file(s).`
      : `Prepared to process ${totalVotes} vote(s) in this capped run.`,
  );

  let metrics = createImportRunMetrics(totalVotes);

  outer: for (const [sourceNumber, source] of voteInput.sources.entries()) {
    if (metrics.handledCount >= totalVotes) {
      break;
    }

    logInfo(
      `Processing source ${sourceNumber + 1}/${voteInput.sources.length}: ${basename(source.sourcePath)}`,
    );

    for await (const item of iterateVotes(source)) {
      if (metrics.handledCount >= totalVotes) {
        logInfo(`Reached configured vote processing cap of ${totalVotes}. Stopping early.`);
        break outer;
      }

      let result;
      try {
        result = await processVote({
          source,
          sourceIndex: item.sourceIndex,
          vote: item.vote,
        });
      } catch (error) {
        metrics = recordVoteOutcome(metrics, "unexpected_failure");
        logError(`Unexpected failure while processing ${item.vote.voteId}.`, error);
        console.log(JSON.stringify(buildVoteProgressLog({
          voteId: item.vote.voteId,
          outcome: "unexpected_failure",
          metrics,
        }), null, 2));
        continue;
      }

      metrics = recordVoteOutcome(metrics, result.outcome);

      if (result.outcome === "completed") {
        logInfo(result.message);
      } else if (result.outcome === "skipped" || result.outcome === "noop") {
        logInfo(result.message);
      } else if (result.outcome === "conflict") {
        logError(result.message);
      } else {
        logError(result.message);
      }

      console.log(JSON.stringify(buildVoteProgressLog({
        voteId: item.vote.voteId,
        outcome: result.outcome,
        metrics,
      }), null, 2));

      if (metrics.handledCount >= totalVotes) {
        logInfo(`Reached configured vote processing cap of ${totalVotes}. Stopping early.`);
        break outer;
      }
    }
  }

  logInfo("Import run completed. Final summary follows.");
  console.log(JSON.stringify(buildImportSummary(metrics), null, 2));

  if (metrics.retryableFailureCount > 0 || metrics.conflictCount > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    logError("Fatal error while processing votes.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    logInfo("Closing Neo4j driver.");
    await closeNeo4j();
    logInfo("Neo4j driver closed.");
  });

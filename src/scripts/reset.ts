import { config } from "../config";
import { clearNeo4jDatabase, closeNeo4j, verifyNeo4jConnection } from "../db/neo4j";
import {
  deleteQdrantCollectionIfExists,
  ensureQdrantCollection,
  ensureQdrantProgressCollection,
  verifyQdrantConnection,
} from "../db/qdrant";
import {
  buildResetSummary,
  type Neo4jResetSummary,
  type QdrantCollectionResetSummary,
  type QdrantResetSummary,
} from "./resetShared";

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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runStep<T>(label: string, action: () => Promise<T>): Promise<T> {
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

async function resetNeo4j(): Promise<Neo4jResetSummary> {
  try {
    await runStep("Verifying Neo4j connectivity", verifyNeo4jConnection);
    const nodesDeleted = await runStep("Clearing Neo4j database", clearNeo4jDatabase);

    return {
      status: "completed",
      database: config.neo4j.database,
      nodesDeleted,
    };
  } catch (error) {
    return {
      status: "failed",
      database: config.neo4j.database,
      error: toErrorMessage(error),
    };
  }
}

async function resetQdrant(): Promise<QdrantResetSummary> {
  const conceptCollection: QdrantCollectionResetSummary = {
    name: config.qdrant.registryCollectionName,
    recreated: false,
  };
  const progressCollection: QdrantCollectionResetSummary = {
    name: config.qdrant.progressCollectionName,
    recreated: false,
  };

  try {
    await runStep("Verifying Qdrant connectivity", verifyQdrantConnection);

    conceptCollection.deleteStatus = await runStep(
      `Deleting Qdrant collection ${conceptCollection.name} if it exists`,
      () => deleteQdrantCollectionIfExists(conceptCollection.name),
    );
    progressCollection.deleteStatus = await runStep(
      `Deleting Qdrant collection ${progressCollection.name} if it exists`,
      () => deleteQdrantCollectionIfExists(progressCollection.name),
    );

    await runStep(`Recreating Qdrant collection ${conceptCollection.name}`, ensureQdrantCollection);
    conceptCollection.recreated = true;

    await runStep(`Recreating Qdrant collection ${progressCollection.name}`, ensureQdrantProgressCollection);
    progressCollection.recreated = true;

    return {
      status: "completed",
      url: config.qdrant.url,
      conceptCollection,
      progressCollection,
    };
  } catch (error) {
    return {
      status: "failed",
      url: config.qdrant.url,
      conceptCollection,
      progressCollection,
      error: toErrorMessage(error),
    };
  }
}

export async function runReset(): Promise<void> {
  logInfo("Starting project data reset for Neo4j and Qdrant.");
  logInfo(`Target Neo4j database: ${config.neo4j.database} at ${config.neo4j.uri}.`);
  logInfo(
    `Target Qdrant collections: ${config.qdrant.registryCollectionName}, ${config.qdrant.progressCollectionName} at ${config.qdrant.url}.`,
  );

  const neo4j = await resetNeo4j();
  const qdrant = await resetQdrant();
  const summary = buildResetSummary({ neo4j, qdrant });

  if (summary.success) {
    logInfo("Project reset completed successfully.");
  } else if (summary.partialReset) {
    logError("Project reset completed partially. Review the summary below.");
  } else {
    logError("Project reset failed. Review the summary below.");
  }

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.success) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  runReset()
    .catch((error) => {
      logError("Fatal error while running project reset.", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      logInfo("Closing Neo4j driver.");
      await closeNeo4j();
      logInfo("Neo4j driver closed.");
    });
}

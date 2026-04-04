import type { QdrantCollectionDeleteStatus } from "../db/qdrant";

export type ResetStoreStatus = "completed" | "failed";

export type Neo4jResetSummary = {
  status: ResetStoreStatus;
  database: string;
  nodesDeleted?: number;
  error?: string;
};

export type QdrantCollectionResetSummary = {
  name: string;
  deleteStatus?: QdrantCollectionDeleteStatus;
  recreated: boolean;
};

export type QdrantResetSummary = {
  status: ResetStoreStatus;
  url: string;
  conceptCollection: QdrantCollectionResetSummary;
  progressCollection: QdrantCollectionResetSummary;
  error?: string;
};

export type ResetSummary = {
  success: boolean;
  partialReset: boolean;
  neo4j: Neo4jResetSummary;
  qdrant: QdrantResetSummary;
};

export function buildResetSummary(args: {
  neo4j: Neo4jResetSummary;
  qdrant: QdrantResetSummary;
}): ResetSummary {
  const completedCount = [args.neo4j.status, args.qdrant.status].filter((status) => status === "completed").length;

  return {
    success: completedCount === 2,
    partialReset: completedCount === 1,
    neo4j: args.neo4j,
    qdrant: args.qdrant,
  };
}

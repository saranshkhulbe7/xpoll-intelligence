import dotenv from "dotenv";
import { parseDatasetMode } from "./utils/datasetMode";
import { parseProcessTillFirstNVotes } from "./utils/processLimit";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  openai: {
    apiKey: requireEnv("OPENAI_API_KEY"),
    model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    embeddingDimensions: Number(process.env.OPENAI_EMBEDDING_DIMENSIONS ?? "1536"),
  },
  neo4j: {
    uri: requireEnv("NEO4J_URI"),
    username: requireEnv("NEO4J_USERNAME"),
    password: requireEnv("NEO4J_PASSWORD"),
    database: requireEnv("NEO4J_DATABASE"),
  },
  qdrant: {
    url: requireEnv("QDRANT_URL"),
    apiKey: requireEnv("QDRANT_API_KEY"),
    registryCollectionName: process.env.QDRANT_REGISTRY_COLLECTION ?? "semantic_registry_v2",
    progressCollectionName: process.env.QDRANT_PROGRESS_COLLECTION ?? "import_progress",
    matchThreshold: Number(process.env.QDRANT_MATCH_SCORE_THRESHOLD ?? "0.92"),
  },
  intensity: {
    halfLifeDays: Number(process.env.INTENSITY_HALF_LIFE_DAYS ?? "180"),
    oppositeSuppression: Number(process.env.INTENSITY_OPPOSITE_SUPPRESSION ?? "0.70"),
  },
  datasetMode: parseDatasetMode(requireEnv("DATASET_MODE")),
  votesJsonPath: requireEnv("VOTES_JSON_PATH"),
  processTillFirstNVotes: parseProcessTillFirstNVotes(process.env.PROCESS_TILL_FIRST_N_VOTES),
};

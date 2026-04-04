import { config } from "../config";
import { openaiClient } from "../openai";

/**
 * Uses OpenAI embeddings so concept resolution is backed by the same provider
 * as semantic inference instead of the old local hash-based placeholder.
 */
const embeddingCache = new Map<string, Promise<number[]>>();

export async function textToVector(input: string): Promise<number[]> {
  const cacheKey = input.trim();
  const cached = embeddingCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const response = await openaiClient.embeddings.create({
      model: config.openai.embeddingModel,
      input: cacheKey,
      dimensions: config.openai.embeddingDimensions,
      encoding_format: "float",
    });

    const vector = response.data[0]?.embedding;
    if (!vector) {
      throw new Error(`OpenAI embeddings response did not include a vector for input: ${cacheKey}`);
    }

    return vector;
  })();

  embeddingCache.set(cacheKey, promise);

  try {
    return await promise;
  } catch (error) {
    embeddingCache.delete(cacheKey);
    throw error;
  }
}

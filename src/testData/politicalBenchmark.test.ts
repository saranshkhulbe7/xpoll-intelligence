import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RawVote } from "../types";
import {
  POLITICAL_BENCHMARK_DATA_FILE,
  POLITICAL_BENCHMARK_EXPECTED_FILE,
  buildPoliticalBenchmarkBundle,
  type PoliticalBenchmarkManifest,
} from "./politicalBenchmark";

async function readJson<T>(fileName: string): Promise<T> {
  const filePath = resolve(process.cwd(), "db", "test-data", fileName);
  const contents = await readFile(filePath, "utf8");
  return JSON.parse(contents) as T;
}

describe("political benchmark bundle", () => {
  test("builds the expected dataset shape and schema mix", () => {
    const bundle = buildPoliticalBenchmarkBundle();
    const voteIds = new Set(bundle.votes.map((vote) => vote.voteId));
    const userIds = new Set(bundle.votes.map((vote) => vote.voter.externalAccountId));
    const pollIds = new Set(bundle.votes.map((vote) => vote.poll.pollId));
    const pollTypeCounts = bundle.votes.reduce<Record<string, number>>((counts, vote) => {
      counts[vote.type] = (counts[vote.type] ?? 0) + 1;
      return counts;
    }, {});

    expect(bundle.votes).toHaveLength(100);
    expect(bundle.manifest.voteExpectations).toHaveLength(100);
    expect(voteIds.size).toBe(100);
    expect(userIds.size).toBe(20);
    expect(pollIds.size).toBe(20);
    expect(bundle.votes.every((vote) => vote.poll.options.filter((option) => option.isSelected).length === 1)).toBeTrue();
    expect(pollTypeCounts).toEqual({
      standalone_poll: 60,
      trial_poll: 25,
      campaign_poll: 15,
    });
    expect(bundle.manifest.aggregateExpectations.expectedPollTypeCounts).toEqual({
      standalone_poll: 12,
      trial_poll: 5,
      campaign_poll: 3,
      inkd_poll: 0,
    });
  });

  test("writes committed benchmark JSON files that match the deterministic generator output", async () => {
    const bundle = buildPoliticalBenchmarkBundle();
    const committedVotes = await readJson<RawVote[]>(POLITICAL_BENCHMARK_DATA_FILE);
    const committedManifest = await readJson<PoliticalBenchmarkManifest>(POLITICAL_BENCHMARK_EXPECTED_FILE);

    expect(committedVotes).toEqual(bundle.votes);
    expect(committedManifest).toEqual(bundle.manifest);
  });

  test("expects only semantic graph relationships and no evidence-node relationships", () => {
    const bundle = buildPoliticalBenchmarkBundle();

    for (const expectation of bundle.manifest.voteExpectations) {
      expect(expectation.expectedGraphRelationships.every((relationship) => !relationship.type.includes("EVIDENCE"))).toBeTrue();
      expect(expectation.expectedGraphRelationships.every((relationship) => relationship.type !== "SUPPORTED_BY")).toBeTrue();
      expect(expectation.expectedGraphRelationships.every((relationship) => !String(relationship.to).startsWith("Evidence"))).toBeTrue();
    }
  });
});

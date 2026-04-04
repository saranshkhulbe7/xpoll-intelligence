import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { countVotes, getVoteSourceDescriptor, iterateVotes, resolveVoteInput } from "./loadVotes";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function createTempVotesFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xpoll-import-"));
  tempDirs.push(directory);
  const filePath = join(directory, "votes.json");
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

async function createTempVotesDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xpoll-import-dir-"));
  tempDirs.push(directory);

  await Promise.all(
    Object.entries(files).map(async ([fileName, contents]) => {
      await writeFile(join(directory, fileName), contents, "utf8");
    }),
  );

  return directory;
}

describe("iterateVotes", () => {
  test("streams votes from a JSON array without loading the entire file in the API surface", async () => {
    const filePath = await createTempVotesFile(
      JSON.stringify([
        {
          voteId: "vote-1",
          type: "standalone_poll",
          voter: { externalAccountId: "user-1" },
          poll: {
            pollId: "poll-1",
            title: "Question 1",
            options: [{ text: "Yes", isSelected: true }],
          },
        },
        {
          voteId: "vote-2",
          type: "standalone_poll",
          voter: { externalAccountId: "user-2" },
          poll: {
            pollId: "poll-2",
            title: "Question 2",
            options: [{ text: "No", isSelected: true }],
          },
        },
      ]),
    );

    const seen: string[] = [];
    for await (const item of iterateVotes(filePath)) {
      seen.push(`${item.sourceIndex}:${item.vote.voteId}`);
    }

    expect(seen).toEqual(["0:vote-1", "1:vote-2"]);
  });
});

describe("resolveVoteInput", () => {
  test("discovers split files in natural numeric order for directory inputs", async () => {
    const directory = await createTempVotesDirectory({
      "split_10.json": "[]",
      "split_2.json": "[]",
      "split_1.json": "[]",
      "notes.txt": "ignored",
    });

    const input = await resolveVoteInput(directory);

    expect(input.inputKind).toBe("directory");
    expect(input.sources.map((source) => basename(source.sourcePath))).toEqual([
      "split_1.json",
      "split_2.json",
      "split_10.json",
    ]);
  });

  test("changes only the modified split file sourceRunKey when one file changes", async () => {
    const directory = await createTempVotesDirectory({
      "split_1.json": "[]",
      "split_2.json": "[]",
    });

    const first = await resolveVoteInput(directory);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(directory, "split_2.json"), "[{}]", "utf8");

    const second = await resolveVoteInput(directory);
    const firstKeys = new Map(first.sources.map((source) => [basename(source.sourcePath), source.sourceRunKey]));
    const secondKeys = new Map(second.sources.map((source) => [basename(source.sourcePath), source.sourceRunKey]));

    expect(firstKeys.get("split_1.json")).toBe(secondKeys.get("split_1.json"));
    expect(firstKeys.get("split_2.json")).not.toBe(secondKeys.get("split_2.json"));
  });

  test("fails fast for missing vote input paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xpoll-import-missing-"));
    tempDirs.push(directory);
    const missingPath = join(directory, "missing.json");

    await expect(resolveVoteInput(missingPath)).rejects.toThrow("Vote input path not found");
  });
});

describe("getVoteSourceDescriptor", () => {
  test("changes the sourceRunKey when file stats change", async () => {
    const filePath = await createTempVotesFile("[]");
    const first = await getVoteSourceDescriptor(filePath);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(filePath, "[{}]", "utf8");

    const second = await getVoteSourceDescriptor(filePath);

    expect(first.sourcePath).toBe(second.sourcePath);
    expect(first.sourceRunKey).not.toBe(second.sourceRunKey);
  });
});

describe("countVotes", () => {
  test("counts the exact number of votes via a dedicated streaming pass", async () => {
    const filePath = await createTempVotesFile(
      JSON.stringify([
        {
          voteId: "vote-1",
          type: "standalone_poll",
          voter: { externalAccountId: "user-1" },
          poll: {
            pollId: "poll-1",
            title: "Question 1",
            options: [{ text: "Yes", isSelected: true }],
          },
        },
        {
          voteId: "vote-2",
          type: "standalone_poll",
          voter: { externalAccountId: "user-2" },
          poll: {
            pollId: "poll-2",
            title: "Question 2",
            options: [{ text: "No", isSelected: true }],
          },
        },
        {
          voteId: "vote-3",
          type: "standalone_poll",
          voter: { externalAccountId: "user-3" },
          poll: {
            pollId: "poll-3",
            title: "Question 3",
            options: [{ text: "Maybe", isSelected: true }],
          },
        },
      ]),
    );

    expect(await countVotes(filePath)).toBe(3);
  });

  test("stops counting early when a max vote cap is provided", async () => {
    const filePath = await createTempVotesFile(
      JSON.stringify([
        {
          voteId: "vote-1",
          type: "standalone_poll",
          voter: { externalAccountId: "user-1" },
          poll: {
            pollId: "poll-1",
            title: "Question 1",
            options: [{ text: "Yes", isSelected: true }],
          },
        },
        {
          voteId: "vote-2",
          type: "standalone_poll",
          voter: { externalAccountId: "user-2" },
          poll: {
            pollId: "poll-2",
            title: "Question 2",
            options: [{ text: "No", isSelected: true }],
          },
        },
        {
          voteId: "vote-3",
          type: "standalone_poll",
          voter: { externalAccountId: "user-3" },
          poll: {
            pollId: "poll-3",
            title: "Question 3",
            options: [{ text: "Maybe", isSelected: true }],
          },
        },
      ]),
    );

    expect(await countVotes(filePath, 2)).toBe(2);
  });

  test("counts the exact number of votes across a directory of split files", async () => {
    const directory = await createTempVotesDirectory({
      "split_2.json": JSON.stringify([
        {
          voteId: "vote-3",
          type: "standalone_poll",
          voter: { externalAccountId: "user-3" },
          poll: {
            pollId: "poll-3",
            title: "Question 3",
            options: [{ text: "Maybe", isSelected: true }],
          },
        },
      ]),
      "split_1.json": JSON.stringify([
        {
          voteId: "vote-1",
          type: "standalone_poll",
          voter: { externalAccountId: "user-1" },
          poll: {
            pollId: "poll-1",
            title: "Question 1",
            options: [{ text: "Yes", isSelected: true }],
          },
        },
        {
          voteId: "vote-2",
          type: "standalone_poll",
          voter: { externalAccountId: "user-2" },
          poll: {
            pollId: "poll-2",
            title: "Question 2",
            options: [{ text: "No", isSelected: true }],
          },
        },
      ]),
    });

    const input = await resolveVoteInput(directory);
    expect(await countVotes(input)).toBe(3);
  });

  test("respects the vote cap across a directory of split files", async () => {
    const directory = await createTempVotesDirectory({
      "split_1.json": JSON.stringify([
        {
          voteId: "vote-1",
          type: "standalone_poll",
          voter: { externalAccountId: "user-1" },
          poll: {
            pollId: "poll-1",
            title: "Question 1",
            options: [{ text: "Yes", isSelected: true }],
          },
        },
        {
          voteId: "vote-2",
          type: "standalone_poll",
          voter: { externalAccountId: "user-2" },
          poll: {
            pollId: "poll-2",
            title: "Question 2",
            options: [{ text: "No", isSelected: true }],
          },
        },
      ]),
      "split_2.json": JSON.stringify([
        {
          voteId: "vote-3",
          type: "standalone_poll",
          voter: { externalAccountId: "user-3" },
          poll: {
            pollId: "poll-3",
            title: "Question 3",
            options: [{ text: "Maybe", isSelected: true }],
          },
        },
      ]),
    });

    const input = await resolveVoteInput(directory);
    expect(await countVotes(input, 2)).toBe(2);
  });

  test("streams split files sequentially while resetting sourceIndex per file", async () => {
    const directory = await createTempVotesDirectory({
      "split_2.json": JSON.stringify([
        {
          voteId: "vote-3",
          type: "standalone_poll",
          voter: { externalAccountId: "user-3" },
          poll: {
            pollId: "poll-3",
            title: "Question 3",
            options: [{ text: "Maybe", isSelected: true }],
          },
        },
      ]),
      "split_1.json": JSON.stringify([
        {
          voteId: "vote-1",
          type: "standalone_poll",
          voter: { externalAccountId: "user-1" },
          poll: {
            pollId: "poll-1",
            title: "Question 1",
            options: [{ text: "Yes", isSelected: true }],
          },
        },
        {
          voteId: "vote-2",
          type: "standalone_poll",
          voter: { externalAccountId: "user-2" },
          poll: {
            pollId: "poll-2",
            title: "Question 2",
            options: [{ text: "No", isSelected: true }],
          },
        },
      ]),
    });

    const input = await resolveVoteInput(directory);
    const seen: string[] = [];

    for (const source of input.sources) {
      for await (const item of iterateVotes(source)) {
        seen.push(`${basename(source.sourcePath)}:${item.sourceIndex}:${item.vote.voteId}`);
      }
    }

    expect(seen).toEqual([
      "split_1.json:0:vote-1",
      "split_1.json:1:vote-2",
      "split_2.json:0:vote-3",
    ]);
  });
});

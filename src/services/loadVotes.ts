import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RawVote, VoteInputDescriptor, VoteIterationItem, VoteSourceDescriptor } from "../types";

function findJsonObjectBoundary(input: string): number | null {
  let started = false;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (!started) {
      if (/\s/.test(char) || char === ",") {
        continue;
      }

      if (char !== "{") {
        throw new Error(`Vote JSON entries must be objects. Found ${JSON.stringify(char)}.`);
      }

      started = true;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return null;
}

function trimArrayPrefix(buffer: string): string {
  return buffer.replace(/^[\s,]*/, "");
}

function parseVoteBuffer(buffer: string): { vote: RawVote; rest: string } | null {
  const trimmed = trimArrayPrefix(buffer);

  if (trimmed.length === 0 || trimmed.startsWith("]")) {
    return null;
  }

  const endIndex = findJsonObjectBoundary(trimmed);
  if (endIndex === null) {
    return null;
  }

  const rawVote = trimmed.slice(0, endIndex);
  const vote = JSON.parse(rawVote) as RawVote;
  const rest = trimmed.slice(endIndex);

  return { vote, rest };
}

function parseSplitFileIndex(fileName: string): number | null {
  const match = fileName.match(/^split_(\d+)\.json$/i);
  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function compareVoteFileNames(left: string, right: string): number {
  const leftIndex = parseSplitFileIndex(left);
  const rightIndex = parseSplitFileIndex(right);

  if (leftIndex !== null && rightIndex !== null) {
    return leftIndex - rightIndex || left.localeCompare(right);
  }

  return left.localeCompare(right);
}

async function buildVoteSourceDescriptor(filePath: string): Promise<VoteSourceDescriptor> {
  const sourcePath = await realpath(filePath);
  const fileStats = await stat(sourcePath);
  const hash = createHash("sha256")
    .update(`${sourcePath}:${fileStats.size}:${fileStats.mtimeMs}`)
    .digest("hex")
    .slice(0, 24);

  return {
    sourcePath,
    sourceRunKey: `votes_${hash}`,
    fileSize: fileStats.size,
    fileMtimeMs: fileStats.mtimeMs,
  };
}

function isVoteInputDescriptor(value: unknown): value is VoteInputDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    "inputKind" in value &&
    "sources" in value &&
    Array.isArray((value as VoteInputDescriptor).sources)
  );
}

function isVoteSourceDescriptor(value: unknown): value is VoteSourceDescriptor {
  return typeof value === "object" && value !== null && "sourcePath" in value && "sourceRunKey" in value;
}

export async function resolveVoteInput(inputPath: string): Promise<VoteInputDescriptor> {
  if (!existsSync(inputPath)) {
    throw new Error(`Vote input path not found: ${inputPath}`);
  }

  const resolvedPath = await realpath(inputPath);
  const inputStats = await stat(resolvedPath);

  if (inputStats.isDirectory()) {
    const entries = await readdir(resolvedPath, { withFileTypes: true });
    const fileNames = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => entry.name)
      .sort(compareVoteFileNames);

    if (fileNames.length === 0) {
      throw new Error(`No vote JSON files were found in directory: ${resolvedPath}`);
    }

    const sources = await Promise.all(
      fileNames.map(async (fileName) => buildVoteSourceDescriptor(join(resolvedPath, fileName))),
    );

    return {
      inputPath,
      resolvedPath,
      inputKind: "directory",
      sources,
    };
  }

  if (!inputStats.isFile()) {
    throw new Error(`Vote input path must be a file or directory: ${inputPath}`);
  }

  return {
    inputPath,
    resolvedPath,
    inputKind: "file",
    sources: [await buildVoteSourceDescriptor(resolvedPath)],
  };
}

/**
 * Resolves the input file into a stable source descriptor used by checkpoint records.
 */
export async function getVoteSourceDescriptor(filePath: string): Promise<VoteSourceDescriptor> {
  const input = await resolveVoteInput(filePath);

  if (input.inputKind !== "file") {
    throw new Error(`Expected a vote JSON file but received a directory: ${input.resolvedPath}`);
  }

  return input.sources[0];
}

async function resolveSingleVoteFile(input: string | VoteSourceDescriptor): Promise<string> {
  if (isVoteSourceDescriptor(input)) {
    return input.sourcePath;
  }

  const resolvedInput = await resolveVoteInput(input);

  if (resolvedInput.inputKind !== "file") {
    throw new Error(`iterateVotes expects a JSON file path, not a directory: ${resolvedInput.resolvedPath}`);
  }

  return resolvedInput.sources[0].sourcePath;
}

/**
 * Streams the raw vote array from a JSON file so resume logic can re-scan large files
 * without loading everything into memory.
 */
export async function* iterateVotes(input: string | VoteSourceDescriptor): AsyncGenerator<VoteIterationItem> {
  const filePath = await resolveSingleVoteFile(input);

  if (!existsSync(filePath)) {
    throw new Error(`Vote JSON file not found: ${filePath}`);
  }

  const stream = createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  });

  let buffer = "";
  let sourceIndex = 0;
  let arrayStarted = false;
  let arrayEnded = false;

  for await (const chunk of stream) {
    buffer += chunk;

    if (!arrayStarted) {
      const firstNonWhitespace = buffer.search(/\S/);

      if (firstNonWhitespace === -1) {
        buffer = "";
        continue;
      }

      if (buffer[firstNonWhitespace] !== "[") {
        throw new Error("Vote JSON must be a top-level array.");
      }

      buffer = buffer.slice(firstNonWhitespace + 1);
      arrayStarted = true;
    }

    while (true) {
      const trimmed = trimArrayPrefix(buffer);
      if (trimmed.length === 0) {
        buffer = "";
        break;
      }

      if (trimmed.startsWith("]")) {
        arrayEnded = true;
        buffer = trimmed.slice(1);
        break;
      }

      const parsed = parseVoteBuffer(trimmed);
      if (!parsed) {
        buffer = trimmed;
        break;
      }

      yield {
        sourceIndex,
        vote: parsed.vote,
      };

      sourceIndex += 1;
      buffer = parsed.rest;
    }

    if (arrayEnded) {
      break;
    }
  }

  if (!arrayStarted) {
    throw new Error("Vote JSON must be a top-level array.");
  }

  const remaining = trimArrayPrefix(buffer);
  if (!arrayEnded && remaining !== "]") {
    throw new Error("Vote JSON ended before the array was fully parsed.");
  }
}

/**
 * Counts votes by streaming the file once. This powers progress logging without
 * loading the whole dataset into memory.
 */
export async function countVotes(
  input: string | VoteSourceDescriptor | VoteInputDescriptor,
  maxVotes?: number,
): Promise<number> {
  if (maxVotes !== undefined && maxVotes <= 0) {
    return 0;
  }

  if (isVoteInputDescriptor(input)) {
    let total = 0;

    for (const source of input.sources) {
      const remainingVotes = maxVotes === undefined ? undefined : maxVotes - total;
      if (remainingVotes !== undefined && remainingVotes <= 0) {
        break;
      }

      total += await countVotes(source, remainingVotes);
    }

    return total;
  }

  let total = 0;

  if (isVoteSourceDescriptor(input)) {
    for await (const _item of iterateVotes(input)) {
      total += 1;

      if (maxVotes !== undefined && total >= maxVotes) {
        break;
      }
    }

    return total;
  }

  const resolvedInput = await resolveVoteInput(input);

  for (const source of resolvedInput.sources) {
    const remainingVotes = maxVotes === undefined ? undefined : maxVotes - total;
    if (remainingVotes !== undefined && remainingVotes <= 0) {
      break;
    }

    total += await countVotes(source, remainingVotes);
  }

  return total;
}

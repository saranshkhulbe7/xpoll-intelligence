import { closeNeo4j, verifyNeo4jConnection } from "../db/neo4j";
import { verifyQdrantConnection } from "../db/qdrant";
import { runTerminalGraphQuery } from "../services/queryRag";

export type QueryCliArgs = {
  ask: string;
  limit: number;
  json: boolean;
};

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }

  return parsed;
}

export function parseQueryCliArgs(argv: string[]): QueryCliArgs {
  let ask = "";
  let limit = 5;
  let json = false;
  const knownFlags = new Set(["--ask", "--limit", "--json"]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--ask") {
      const questionParts: string[] = [];
      let cursor = index + 1;

      while (cursor < argv.length && !knownFlags.has(argv[cursor] ?? "")) {
        questionParts.push(argv[cursor] ?? "");
        cursor += 1;
      }

      const value = questionParts.join(" ").trim();
      if (!value) {
        throw new Error("--ask requires a question string.");
      }

      ask = value;
      index = cursor - 1;
      continue;
    }

    if (arg === "--limit") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--limit requires a numeric value.");
      }

      limit = parsePositiveInteger(value, "--limit");
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!ask.trim()) {
    throw new Error('Missing required --ask "<question>" argument.');
  }

  return {
    ask: ask.trim(),
    limit,
    json,
  };
}

async function main(): Promise<void> {
  const args = parseQueryCliArgs(process.argv.slice(2));
  const startupWarnings: string[] = [];

  await verifyNeo4jConnection();
  try {
    await verifyQdrantConnection();
  } catch {
    startupWarnings.push(
      "Qdrant verification failed. The query will continue with graph-first retrieval, but concept expansion and raw evidence may be limited.",
    );
  }

  const answer = await runTerminalGraphQuery({
    question: args.ask,
    limit: args.limit,
  });

  if (startupWarnings.length > 0) {
    answer.warnings = [...startupWarnings, ...answer.warnings];
    if (!args.json) {
      answer.answerText = [answer.answerText, "Warnings:", ...answer.warnings.map((warning) => `- ${warning}`)]
        .filter(Boolean)
        .join("\n");
    }
  }

  if (args.json) {
    console.log(JSON.stringify(answer, null, 2));
    return;
  }

  console.log(answer.answerText);
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeNeo4j();
    });
}
